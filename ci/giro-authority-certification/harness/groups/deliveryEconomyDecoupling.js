'use strict';
// DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139) certification.
//
// THE INVARIANT under test (product correction of the migration-138 UAT):
//   A. a trip that has ALREADY departed may outlive the close of the economic service
//      (service CLOSED + trip ACTIVE is valid and recoverable);
//   B. a NEW trip can never become ACTIVE for a service that is not 'open' (start_rider_trip_v2, unchanged).
//   Economy depends on delivery-confirmed / money-confirmed / amount-still-owed, never on the driver.
//
// Every scenario calls the REAL close_service_session_v3 (ledger-138 body, + 139 on the POST template), the REAL
// start_rider_trip_v2 (ledger-138 body), the REAL rider_collect_and_complete_stop / close_rider_trip (ledger-135
// bodies) and the REAL economic writers (_ledger_write_payment / order_post_payment_v1, ledger-126 bodies, on the
// live table shapes -- fixture/real_ledger_v1.sql, md5-checked against staging) on real PostgreSQL 17 with real
// concurrent connections. Interleavings are forced, not simulated: one transaction is held open while the other is
// started, and the harness proves WHICH lock the waiting transaction is stuck on by reading pg_locks.
// Nothing here touches staging or production.
const crypto = require('crypto');
const rt = require('../pgRuntime');
const { section, assert, call, fixture } = require('../lib');
const { seedActors } = require('../realLedger');

const META = JSON.stringify({});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const hex64 = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const PAY = (over = {}) => ({ method: 'efectivo', mode: 'full', client_request_id: `req_${crypto.randomUUID()}`,
  by_sid_hash: hex64('sid-op'), request_hash: hex64(crypto.randomUUID()), ...over });

// ── plumbing ─────────────────────────────────────────────────────────────────────────────
async function openDb(env, cloneFn, label) {
  const db = await cloneFn(label);
  const su = await rt.connect(env.cl, db, { name: `ded-su-${label}` });
  const svc = await rt.connect(env.cl, db, { role: 'service_role', name: `ded-svc-${label}` });
  await env.addSingleActiveIndex(su); // production invariant the fixture omits: one open|closing service
  const extra = [];
  return {
    db, su, svc, fx: fixture(su),
    async client(name, role = 'service_role') {
      const c = await rt.connect(env.cl, db, { role, name });
      extra.push(c);
      return c;
    },
    async close() { for (const c of [...extra, svc, su]) await c.end().catch(() => {}); },
  };
}

// DED_P_PRE=1 (a reviewer's mutation switch, like DED_FWD in the runner) swaps the writer of the post-close COLLECTION (pc-*)
// and CAJA (caja-1/2) scenarios back to the ledger-126 body (the writer as it is live today, i.e. WITHOUT the 139
// off-service edit) on the otherwise POST-139 database: those scenarios must then FAIL -- proving they discriminate the
// edit instead of passing for any writer.
const forcePre = (label) => process.env.DED_P_PRE === '1' && /^(pc-|caja-[12]$)/.test(label);
async function world(env, { pre = false, label, date = '2026-09-19' }) {
  const c = await openDb(env, pre ? env.clonePre : env.clone, label);
  await seedActors(c.su);
  if (forcePre(label)) {
    const { extractStatement } = require('../realLedger');
    await c.su.query('SET ROLE postgres');
    await c.su.query(extractStatement(rt.readRepo('migrations/2026-09-11_economic_writer_hardening_v1_migration_126.sql'), 'order_post_payment_v1'));
    await c.su.query('RESET ROLE');
  }
  const s = await c.fx.day(date);                       // an OPEN service
  // Production invariant the fixture omits: the lifecycle pointer names the open service (order_post_payment_v1 reads it
  // to resolve the RECEIPT service; close_service_session_v3 requires it).
  await c.su.query('UPDATE public.service_session_state SET current_session_id = $1 WHERE singleton', [s]);
  const mk = (o = {}) => c.fx.order(c.svc, { session: s, ...o });
  return { c, s, scope: [s], mk };
}

// What close_service_session_v3 needs before it will even consider closing (pointer + closeout + active attempt).
async function seedCloseable(c, s) {
  const corr = crypto.randomUUID();
  await c.su.query('UPDATE public.service_session_state SET current_session_id = $1 WHERE singleton', [s]);
  await c.su.query('INSERT INTO public.service_closeouts (service_session_id, closeout_correlation_id) VALUES ($1, $2)', [s, corr]);
  await c.su.query("INSERT INTO public.service_closeout_attempts (service_session_id, closeout_correlation_id, status) VALUES ($1, $2, 'active')", [s, corr]);
  return corr;
}

const closeV3 = (client, s, corr) => call(client, 'close_service_session_v3', [s, corr, 'operator_primary', 'operator_finalizar_v3']);
const startV2 = (client, anchor, actor, scope) => call(client, 'start_rider_trip_v2', [anchor.order_uid, actor, 1, scope]);
const riderStop = (client, orderId, method, idem, actor = 'rider') => call(client, 'rider_collect_and_complete_stop',
  [orderId, method, actor, 1, 'iphash', META, idem]);
const closeTrip = (client, trigger = null) => call(client, 'close_rider_trip', [trigger]);
const opConfirm = (client, orderId, payment = null, actor = 'operator_primary', sv = 1) =>
  call(client, 'operator_confirm_delivery_v1', [orderId, actor, sv, payment == null ? null : JSON.stringify(payment)]);

// The REAL economy readers (pendingExposures / economicSnapshot, unchanged JS) fed with the REAL ledger rows of the
// ephemeral database: to_jsonb() yields exactly the JSON types PostgREST returns (numbers, ISO instants), so this is the
// production reader over production-shaped rows, not a hand-written fixture.
async function economyReaders(c, extraTables = {}) {
  const path = require('path');
  const root = path.join(__dirname, '..', '..', '..', '..');
  const { createPendingExposures } = require(path.join(root, 'src/economy/pendingExposures'));
  const { createEconomicSnapshot } = require(path.join(root, 'src/economy/economicSnapshot'));
  const { createMemorySelect } = require(path.join(root, 'tests/fixtures/postgrestMemorySelect'));
  const rows = async (t) => (await c.su.query(`SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) AS r FROM public.${t} x`)).rows[0].r;
  const select = createMemorySelect({
    ordenes: await rows('ordenes'), storico: [], order_financial_events: await rows('order_financial_events'), // language-guard: allow-legacy storico is the real archive table key the memory select needs (empty here), not new vocabulary
    order_obligations: await rows('order_obligations'), service_sessions: await rows('service_sessions'), table_sessions: [], ...extraTables,
  });
  const now = new Date();
  return {
    select, now, root,
    pending: () => createPendingExposures({ select })({ workspaceId: 'ws-harness', now }),
    snapshot: () => createEconomicSnapshot({ select })({ preset: 'personalizado', from: new Date(now.getTime() - 3 * 86400000).toISOString(), to: new Date(now.getTime() + 3 * 86400000).toISOString(), now }),
  };
}

// A NEW open service (the pointer names it), as the next opening would.
async function openService(c, date) {
  const id = await c.fx.day(date);
  await c.su.query('UPDATE public.service_session_state SET current_session_id = $1 WHERE singleton', [id]);
  return id;
}
const cashPayDirect = (c, wsId, o, actor = 'operator_backup', method = 'efectivo') => c.query('SELECT public.order_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) AS r',
  [wsId, actor, hex64('sid-b'), o.order_uid, method, 'full', null, `cash_${crypto.randomUUID()}`, hex64(crypto.randomUUID()), '{}', false]).then((x) => x.rows[0].r);

// The standalone Cash V1 writer exactly as cashService.pay calls it (POST /api/cash/v1/checks/:orderUid/payments ->
// cashDao.postPayment): the server-side actor, a client request id + its hash, source = servicio_dashboard. Throws the
// RPC's typed message (e.g. ORDER_PAYMENT_ALREADY_SETTLED) exactly like PostgREST would surface it.
const wsOf = async (c) => (await c.su.query('SELECT id FROM public.workspaces ORDER BY name LIMIT 1')).rows[0].id;
const cashPay = (client, wsId, o, x = {}) => {
  const reqId = x.reqId || `cash_${crypto.randomUUID()}`;
  return client.query('SELECT public.order_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) AS r',
    [wsId, x.actor || 'operator_backup', hex64('sid-b'), o.order_uid, x.method || 'efectivo', x.mode || 'full', x.amount ?? null,
      reqId, x.hash || hex64(`${o.order_uid}|${x.method || 'efectivo'}|${x.mode || 'full'}|${x.amount ?? ''}|${reqId}`),
      JSON.stringify({ source: 'servicio_dashboard' }), x.confirm === true]).then((r) => r.rows[0].r);
};
const cashPayOrThrow = (client, wsId, o, x) => cashPay(client, wsId, o, x).catch((e) => ({ threw: e.message }));

// The identity of an order as the delivery sees it (everything the payment must NOT change).
const orderIdentity = async (c, id) => (await c.su.query('SELECT estado, service_session_id, totale, tipo_consegna, order_uid FROM public.ordenes WHERE id = $1', [id])).rows[0]; // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, selected verbatim, not new vocabulary

// A row-content fingerprint of every base table of the public + trip_authority schemas: which tables did a call write to?
async function fingerprint(c) {
  const tabs = (await c.su.query(`SELECT table_schema, table_name FROM information_schema.tables
     WHERE table_type = 'BASE TABLE' AND table_schema IN ('public', 'trip_authority') ORDER BY 1, 2`)).rows;
  const out = {};
  for (const t of tabs) {
    const r = await c.su.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t.table_schema}.${t.table_name} x`);
    out[`${t.table_schema}.${t.table_name}`] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}
const changedTables = (a, b) => Object.keys(b).filter((k) => a[k] !== b[k]).sort();

// The economic truth of ONE order, read straight from the ledger tables (never from a projection).
async function ledger(c, orderId) {
  const r = await c.su.query(`
    SELECT o.order_uid, o.estado, o.service_session_id AS svc, o.cobrado, o.ya_pagado, o.metodo_pago,
           public.order_canonical_obligation_v1(o.order_uid) AS obligation,
           COALESCE((SELECT sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END)
                       FROM public.order_financial_events e
                      WHERE e.order_id = o.id AND e.type IN ('payment','payment_imported','refund')), 0) AS paid,
           (SELECT count(*)::int FROM public.order_financial_events e WHERE e.order_id = o.id) AS events,
           (SELECT count(*)::int FROM public.order_financial_events e WHERE e.order_id = o.id AND e.type = 'payment') AS payment_events,
           (SELECT count(*)::int FROM public.payment_allocations a WHERE a.order_uid = o.order_uid) AS allocations
      FROM public.ordenes o WHERE o.id = $1`, [orderId]);
  const row = r.rows[0];
  const ev = (await c.su.query(`SELECT type, amount::numeric AS amount, payment_method, by_actor, by_role, service_session_id AS obligation_svc,
        event_service_session_id AS receipt_svc, payment_transaction_id, meta FROM public.order_financial_events WHERE order_id = $1 ORDER BY created_at`, [orderId])).rows;
  const tx = (await c.su.query(`SELECT t.kind, t.amount::numeric AS amount, t.payment_method, t.by_actor, t.by_role, t.service_session_id AS receipt_svc, t.mode, t.meta
        FROM public.payment_transactions t JOIN public.payment_allocations a ON a.payment_transaction_id = t.id WHERE a.order_uid = $1`, [row.order_uid])).rows;
  return { ...row, obligation: Number(row.obligation), paid: Number(row.paid), unpaid: Number(row.obligation) - Number(row.paid), ev, tx };
}

async function snap(c, s) {
  const r = await c.su.query(`
    SELECT (SELECT status FROM public.service_sessions WHERE id = $1) AS svc,
           (SELECT count(*)::int FROM trip_authority.trips WHERE status = 'ACTIVE' AND service_session_id = $1) AS active_trips,
           (SELECT count(*)::int FROM trip_authority.trips) AS trips,
           (SELECT current_session_id FROM public.service_session_state WHERE singleton) AS pointer,
           (SELECT count(*)::int FROM public.service_sessions) AS services`, [s]);
  return r.rows[0];
}
const tripStatus = async (c) => (await c.su.query('SELECT trip_id, status, service_session_id, rider_actor, dispatched_by FROM trip_authority.trips ORDER BY seq')).rows;
const orderEstado = async (c, id) => (await c.su.query('SELECT estado FROM public.ordenes WHERE id = $1', [id])).rows[0].estado;
const logsFor = async (c, id) => (await c.su.query('SELECT estado_from, estado_to, event_type, actor_type, actor_id, origin, metadata FROM public.orden_estado_logs WHERE orden_id = $1 ORDER BY created_at', [id])).rows;

async function advisoryKey(admin, name) {
  return String((await admin.query('SELECT (hashtext($1)::bigint & 4294967295)::bigint AS k', [name])).rows[0].k);
}

// Blocks until the connection named `app` is waiting on a lock; reports WHICH one (pg_locks).
async function lockWait(su, app, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query(`
      SELECT a.pid, a.wait_event_type, a.wait_event,
             (SELECT l.locktype FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted LIMIT 1) AS waiting_locktype,
             (SELECT l.objid::bigint::text FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted AND l.locktype = 'advisory' LIMIT 1) AS waiting_advisory,
             COALESCE((SELECT array_agg(l.objid::bigint::text) FROM pg_locks l WHERE l.pid = a.pid AND l.granted AND l.locktype = 'advisory'), ARRAY[]::text[]) AS held_advisory
        FROM pg_stat_activity a WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'`, [app]);
    if (r.rows.length) return r.rows[0];
    await delay(20);
  }
  return null;
}
async function heldAdvisory(su, app) {
  const r = await su.query(`SELECT COALESCE(array_agg(l.objid::bigint::text), ARRAY[]::text[]) AS held
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE a.application_name = $1 AND l.locktype = 'advisory' AND l.granted`, [app]);
  return r.rows[0].held;
}

// ── forced interleavings (the SAME code drives the PRE and the POST template) ─────────────
// CLOSE FIRST: T1 = the close is executed and HELD OPEN; T2 = a dispatch that resolved its scope [S] earlier starts now.
async function raceCloseFirst(w, anchor, corr) {
  const t1 = await w.c.client('ded-closer');
  const t2 = await w.c.client('ded-dispatcher');
  await t1.query('BEGIN');
  const closeRes = await closeV3(t1, w.s, corr);
  const closerHeld = await heldAdvisory(w.c.su, 'ded-closer');
  const startP = startV2(t2, anchor, 'rider', w.scope).catch((e) => ({ threw: e.code || e.message }));
  const wait = await lockWait(w.c.su, 'ded-dispatcher');
  await t1.query('COMMIT');
  const startRes = await startP;
  return { closeRes, startRes, wait, closerHeld };
}
// TRIP FIRST: T1 = the dispatch is executed and HELD OPEN; T2 = the close starts now.
async function raceTripFirst(w, anchor, corr) {
  const t1 = await w.c.client('ded-dispatcher');
  const t2 = await w.c.client('ded-closer');
  await t1.query('BEGIN');
  const startRes = await startV2(t1, anchor, 'operator_primary', w.scope);
  const closeP = closeV3(t2, w.s, corr).catch((e) => ({ threw: e.code || e.message }));
  const wait = await lockWait(w.c.su, 'ded-closer');
  await t1.query('COMMIT');
  const closeRes = await closeP;
  return { startRes, closeRes, wait };
}

// A delivery order LISTO in service S, dispatched (trip ACTIVE, order EN_ENTREGA) by the given actor.
async function dispatched(w, { totale = 12.5, actor = 'operator_primary', id } = {}) {
  const o = await w.mk({ estado: 'LISTO', totale, id, zona: 'Q1' });
  const st = await startV2(w.c.svc, o, actor, w.scope);
  return { o, st };
}

async function run(env) {
  const KEY_L0 = await advisoryKey(env.admin, 'LA_DIECI_DRIVER_STATO');
  const KEY_LC = await advisoryKey(env.admin, 'service_session_lifecycle');
  assert('setup: the two advisory keys are distinct', KEY_L0 !== KEY_LC, { KEY_L0, KEY_LC });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('R0 CONTRAST -- PRE-139 (migration 138): the OLD rule refuses a close while a trip is ACTIVE');
  {
    const w = await world(env, { pre: true, label: 'pre-caseb' });
    const { o, st } = await dispatched(w);
    assert('pre: the trip departs (operator dispatch)', st.ok === true && st.code === 'OK', st);
    const corr = await seedCloseable(w.c, w.s);
    const r = await closeV3(w.c.svc, w.s, corr);
    assert('pre-139: close_service_session_v3 is REFUSED with V3_CLOSE_ACTIVE_RIDER_TRIP (this is the rule 139 corrects)', r.ok === false && r.code === 'V3_CLOSE_ACTIVE_RIDER_TRIP', r);
    assert('pre-139: the service stays open', (await snap(w.c, w.s)).svc === 'open');
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('R1 CASE A -- CLOSE takes the lock first: the service closes, the dispatch waits then gets SERVICE_NOT_OPEN, 0 new trips');
  {
    const w = await world(env, { label: 'casea' });
    const anchor = await w.mk({ estado: 'LISTO', totale: 9, zona: 'Q1' });
    const corr = await seedCloseable(w.c, w.s);
    const r = await raceCloseFirst(w, anchor, corr);
    assert('A: the close succeeds (V3_CLOSED)', r.closeRes.ok === true && r.closeRes.code === 'V3_CLOSED', r.closeRes);
    assert('A: while the close was held open, the dispatch was stuck on the DISPATCH lock L0 (advisory), not on a row lock',
      !!r.wait && r.wait.waiting_locktype === 'advisory' && r.wait.waiting_advisory === KEY_L0, r.wait);
    assert('A: the close held BOTH the lifecycle lock and L0 (lifecycle -> L0)', r.closerHeld.includes(KEY_LC) && r.closerHeld.includes(KEY_L0), r.closerHeld);
    assert('A: after the release the dispatch is refused with SERVICE_NOT_OPEN (service closed), no trip created',
      r.startRes.ok === false && r.startRes.code === 'SERVICE_NOT_OPEN' && r.startRes.status === 'closed', r.startRes);
    const s = await snap(w.c, w.s);
    assert('A: final state: service CLOSED, 0 trips, the order is untouched (LISTO)', s.svc === 'closed' && s.trips === 0 && (await orderEstado(w.c, anchor.id)) === 'LISTO', s);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('R2 CASE B -- the DISPATCH takes the lock first: the close WAITS then PROCEEDS: service CLOSED + trip ACTIVE (now valid)');
  let caseB;
  {
    const w = await world(env, { label: 'caseb' });
    const anchor = await w.mk({ estado: 'LISTO', totale: 12.5, zona: 'Q1', id: '#B0001' });
    const corr = await seedCloseable(w.c, w.s);
    const r = await raceTripFirst(w, anchor, corr);
    assert('B: the dispatch departs (trip ACTIVE, order EN_ENTREGA)', r.startRes.ok === true && r.startRes.code === 'OK', r.startRes);
    assert('B: while the dispatch was held open, the close was stuck on the DISPATCH lock L0 after taking the lifecycle lock',
      !!r.wait && r.wait.waiting_locktype === 'advisory' && r.wait.waiting_advisory === KEY_L0 && r.wait.held_advisory.includes(KEY_LC), r.wait);
    assert('B: after the release the close SUCCEEDS (V3_CLOSED) -- it is no longer refused because a trip is ACTIVE',
      r.closeRes.ok === true && r.closeRes.code === 'V3_CLOSED', r.closeRes);
    const s = await snap(w.c, w.s);
    assert('B: final state: service CLOSED + trip ACTIVE (a valid state now), pointer cleared, no new service', s.svc === 'closed' && s.active_trips === 1 && s.pointer === null && s.services === 1, s);
    assert('B: the order is still EN_ENTREGA (the close never touches it) and belongs to the CLOSED service', (await orderEstado(w.c, anchor.id)) === 'EN_ENTREGA'
      && (await ledger(w.c, anchor.id)).svc === w.s);
    caseB = { w, anchor };
  }
  {
    // The rider completes AFTER the close: Entregado + Efectivo, then the trip closes. No deadlock, no orphan.
    const { w, anchor } = caseB;
    const l0 = await ledger(w.c, anchor.id);
    assert('B: before the rider acts the debt is the full obligation (12.50) -- a pending of the CLOSED service', l0.obligation === 12.5 && l0.paid === 0 && l0.unpaid === 12.5 && l0.events === 0, l0);
    const rs = await riderStop(w.c.svc, anchor.id, 'efectivo', 'rider_delivery_B0001');
    assert('B: the rider completes the stop after the close: OK, payment recorded', rs.ok === true && rs.code === 'OK' && !!rs.payment && Number(rs.payment.amount) === 12.5, rs);
    const l1 = await ledger(w.c, anchor.id);
    assert('B: order RETIRADO, exactly ONE payment event of 12.50, unpaid = 0, obligation covered', l1.estado === 'RETIRADO' && l1.events === 1 && l1.payment_events === 1 && l1.paid === 12.5 && l1.unpaid === 0, l1);
    assert('B: the event is attributed to the ORIGINAL (closed) service, by the rider, and is an off-service receipt (no event service)',
      l1.ev[0].obligation_svc === w.s && l1.ev[0].by_actor === 'rider' && l1.ev[0].by_role === 'rider' && l1.ev[0].receipt_svc === null && l1.svc === w.s, l1.ev);
    const ct = await closeTrip(w.c.svc, anchor.id);
    assert('B: close_rider_trip succeeds after the last stop', ct.ok === true && ct.code === 'OK', ct);
    const s = await snap(w.c, w.s);
    assert('B: final: trip CLOSED, service still CLOSED (never reopened), 0 open pointer, exactly 1 service row', s.svc === 'closed' && s.active_trips === 0 && s.pointer === null && s.services === 1, s);
    const again = await riderStop(w.c.svc, anchor.id, 'efectivo', 'rider_delivery_B0001');
    assert('B: an honest retry after the trip closed is a typed refusal (NO_ACTIVE_TRIP), never a second payment', again.ok === false && again.code === 'NO_ACTIVE_TRIP' && (await ledger(w.c, anchor.id)).events === 1, again);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('R3 RESIDUAL SCOPE -- the departed trip of a CLOSED service stays readable through the unchanged projection');
  {
    const w = await world(env, { label: 'residual' });
    const svcClient = w.c.svc;
    const none = await call(svcClient, 'trip_residual_scope_v1', []);
    assert('R3: with no ACTIVE trip the residual scope is empty (ok:true, [])', none.ok === true && Array.isArray(none.service_session_ids) && none.service_session_ids.length === 0, none);
    const { o, st } = await dispatched(w, { id: '#R0001' });
    assert('R3: trip departed', st.ok === true, st);
    const open = await call(svcClient, 'trip_residual_scope_v1', []);
    assert('R3: while the service is OPEN the residual scope names it (attribution only)', JSON.stringify(open.service_session_ids) === JSON.stringify([w.s]), open);
    const corr = await seedCloseable(w.c, w.s);
    const cl = await closeV3(svcClient, w.s, corr);
    assert('R3: the service closes with the trip ACTIVE', cl.ok === true && cl.code === 'V3_CLOSED', cl);
    const res = await call(svcClient, 'trip_residual_scope_v1', []);
    assert('R3: the residual scope still names the CLOSED service (the departed trip is operational residue)', JSON.stringify(res.service_session_ids) === JSON.stringify([w.s]), res);
    const proj = await svcClient.query('SELECT public.trip_projection_v1($1::uuid[]) AS r', [res.service_session_ids]);
    assert('R3: trip_projection_v1 (UNCHANGED) answers ACTIVE for a scope that contains the CLOSED service, with the frozen member',
      proj.rows[0].r.ok === true && proj.rows[0].r.active === true && proj.rows[0].r.members.length === 1 && proj.rows[0].r.members[0].order_uid === o.order_uid, proj.rows[0].r);
    // A NEW open service (next day) with its own scope: the projection over ONLY the new scope does not see the old trip.
    const s2 = await w.c.fx.day('2026-09-20');
    const onlyNew = await svcClient.query('SELECT public.trip_projection_v1($1::uuid[]) AS r', [[s2]]);
    assert('R3: over the operational scope alone (the NEW service) the old trip is invisible -- which is exactly why the reader must union the residual scope',
      onlyNew.rows[0].r.ok === true && onlyNew.rows[0].r.active === false, onlyNew.rows[0].r);
    const union = await svcClient.query('SELECT public.trip_projection_v1($1::uuid[]) AS r', [[s2, ...res.service_session_ids]]);
    assert('R3: over operational ∪ residual the trip is visible again, and NO closed-service order beyond the trip is added by the projection',
      union.rows[0].r.active === true && union.rows[0].r.members.length === 1, union.rows[0].r);
    const emptyScope = await svcClient.query('SELECT public.trip_projection_v1($1::uuid[]) AS r', [[]]);
    assert('R3: an EMPTY scope stays fail-closed (SCOPE_UNAVAILABLE): the reader must never call it without at least one id', emptyScope.rows[0].r.ok === false && emptyScope.rows[0].r.code === 'SCOPE_UNAVAILABLE', emptyScope.rows[0].r);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('R4 RESIDUAL SCOPE -- ONLY ACTIVE trips: a CLOSED trip / an old trip never enters the scope (kills the "no ACTIVE filter" mutant)');
  {
    const w = await world(env, { label: 'residual-active-only' });
    const svc = w.c.svc;
    const scopeOf = async () => (await call(svc, 'trip_residual_scope_v1', [])).service_session_ids;
    const { o } = await dispatched(w, { id: '#R0100' });
    assert('R4: an ACTIVE trip names its service', JSON.stringify(await scopeOf()) === JSON.stringify([w.s]), await scopeOf());
    const rs = await riderStop(svc, o.id, 'efectivo', 'rider_delivery_R0100');
    const ct = await closeTrip(svc, o.id);
    assert('R4: the stop is completed and the trip is CLOSED', rs.ok === true && ct.ok === true && ct.code === 'OK', { rs, ct });
    const n = (await w.c.su.query("SELECT count(*)::int AS n FROM trip_authority.trips WHERE status <> 'ACTIVE'")).rows[0].n;
    assert('R4: precondition of the test: a non-ACTIVE trip really exists in the table', n === 1, n);
    assert('R4: a CLOSED trip does NOT enter the residual scope (service still open)', (await scopeOf()).length === 0, await scopeOf());
    const corr = await seedCloseable(w.c, w.s);
    const cl = await closeV3(svc, w.s, corr);
    assert('R4: the service closes', cl.ok === true, cl);
    assert('R4: CLOSED service + CLOSED trip: the residual scope is EMPTY -- a closed service is never named just because it once had a trip', (await scopeOf()).length === 0, await scopeOf());
    // a NEW service with its own ACTIVE trip: the scope is exactly that service, never the old one
    const s2 = await openService(w.c, '2026-09-20');
    const o2 = await w.c.fx.order(svc, { session: s2, estado: 'LISTO', totale: 9, id: '#R0101', zona: 'Q1' });
    const st2 = await startV2(svc, o2, 'operator_primary', [s2]);
    assert('R4: the new service departs a trip', st2.ok === true, st2);
    assert('R4: the residual scope names ONLY the service of the ACTIVE trip (not the old closed service that had a closed trip)', JSON.stringify(await scopeOf()) === JSON.stringify([s2]), await scopeOf());
    await riderStop(svc, o2.id, 'efectivo', 'rider_delivery_R0101');
    await closeTrip(svc, o2.id);
    assert('R4: once that trip is CLOSED as well, the scope is empty again', (await scopeOf()).length === 0, await scopeOf());
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('O1 OPERATOR -- delivery ONLY: RETIRADO, unpaid unchanged, recorded as the operator, the trip is NOT touched');
  {
    const w = await world(env, { label: 'op-only' });
    const { o } = await dispatched(w, { id: '#O0001', totale: 12.5 });
    const cfgBefore = (await w.c.su.query("SELECT valore FROM public.config WHERE chiave = 'DRIVER_STATO'")).rows[0].valore;
    const dlBefore = (await w.c.su.query('SELECT count(*)::int AS n FROM public.delivery_logs')).rows[0].n;
    const svcBefore = (await w.c.su.query('SELECT to_jsonb(s) AS r FROM public.service_sessions s WHERE id = $1', [w.s])).rows[0].r;
    const r = await opConfirm(w.c.svc, o.id);
    assert('O1: the operator confirms the delivery (ok / OK, no payment)', r.ok === true && r.code === 'OK' && r.payment === null, r);
    const l = await ledger(w.c, o.id);
    assert('O1: order RETIRADO with the obligation UNCHANGED and UNPAID (no ledger event, no transaction)', l.estado === 'RETIRADO' && l.obligation === 12.5 && l.paid === 0 && l.unpaid === 12.5 && l.events === 0 && l.tx.length === 0 && l.cobrado !== true, l);
    const logs = await logsFor(w.c, o.id);
    assert('O1: audit says WHO recorded it: actor_type operator / actor_id operator_primary / origin operator_delivery_confirmation -- never the rider',
      logs.length === 1 && logs[0].actor_type === 'operator' && logs[0].actor_id === 'operator_primary' && logs[0].origin === 'operator_delivery_confirmation'
      && logs[0].estado_from === 'EN_ENTREGA' && logs[0].estado_to === 'RETIRADO' && logs[0].metadata.payment_recorded === false, logs);
    const trips = await tripStatus(w.c);
    assert('O1: the trip is untouched: still ACTIVE (Driver volvió is NOT implied by a delivery confirmation)', trips.length === 1 && trips[0].status === 'ACTIVE', trips);
    assert('O1: DRIVER_STATO, delivery_logs and the service row are byte-identical (the confirmation never touches a trip or a service)',
      (await w.c.su.query("SELECT valore FROM public.config WHERE chiave = 'DRIVER_STATO'")).rows[0].valore === cfgBefore
      && (await w.c.su.query('SELECT count(*)::int AS n FROM public.delivery_logs')).rows[0].n === dlBefore
      && JSON.stringify((await w.c.su.query('SELECT to_jsonb(s) AS r FROM public.service_sessions s WHERE id = $1', [w.s])).rows[0].r) === JSON.stringify(svcBefore));
    const again = await opConfirm(w.c.svc, o.id);
    assert('O1: a second confirmation (double click / stale page) is IDEMPOTENT: no second log row, no state change', again.ok === true && again.code === 'IDEMPOTENT' && (await logsFor(w.c, o.id)).length === 1, again);
    const rr = await riderStop(w.c.svc, o.id, '', 'rider_delivery_O0001');
    assert('O1: the rider later presses Entregado (no money): IDEMPOTENT, no second state, still 0 events', rr.ok === true && rr.code === 'IDEMPOTENT' && (await ledger(w.c, o.id)).events === 0, rr);
    const ct = await closeTrip(w.c.svc, o.id);
    assert('O1: the trip is closable afterwards by the canonical close (all members terminal): no regression of the trip', ct.ok === true && ct.code === 'OK', ct);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('O2 OPERATOR -- delivery + PAYMENT through the canonical Cash V1 writer (efectivo / tarjeta / bizum), recorded as the operator');
  {
    const w = await world(env, { label: 'op-pay' });
    for (const [method, id, total] of [['efectivo', '#O0002', 12.5], ['tarjeta', '#O0003', 18], ['bizum', '#O0004', 7.25]]) {
      const o = await w.mk({ estado: 'LISTO', totale: total, id, zona: 'Q1' });
      // one trip at a time (single-rider invariant): the previous trip is closed before the next departure
      const st = await startV2(w.c.svc, o, 'operator_primary', w.scope);
      assert(`O2/${method}: trip departed`, st.ok === true, st);
      const pay = PAY({ method });
      const r = await opConfirm(w.c.svc, id, pay);
      assert(`O2/${method}: delivery + payment confirmed in ONE call`, r.ok === true && r.code === 'OK' && r.payment && r.payment.ok === true && r.payment.idempotent === false, r);
      const l = await ledger(w.c, id);
      assert(`O2/${method}: RETIRADO, exactly ONE payment event and ONE transaction of ${total}, method ${method}, unpaid 0`,
        l.estado === 'RETIRADO' && l.events === 1 && l.payment_events === 1 && l.tx.length === 1 && l.allocations === 1 && l.paid === total && l.unpaid === 0
        && l.ev[0].payment_method === method && Number(l.tx[0].amount) === total && l.tx[0].payment_method === method, l);
      assert(`O2/${method}: the payment is recorded AS THE OPERATOR (event + transaction), never as the rider, with the server-forced source`,
        l.ev[0].by_actor === 'operator_primary' && l.ev[0].by_role === 'operator' && l.tx[0].by_actor === 'operator_primary' && l.tx[0].by_role === 'operator'
        && l.ev[0].meta.mode === 'full' && l.ev[0].payment_transaction_id !== null, l.ev);
      assert(`O2/${method}: attributed to the order's service (open now, so also the receipt service); flags mirrored by the canonical writer`,
        l.ev[0].obligation_svc === w.s && l.ev[0].receipt_svc === w.s && l.cobrado === true && l.ya_pagado === true && l.metodo_pago === method, l);
      const lg = await logsFor(w.c, id);
      assert(`O2/${method}: audit row says operator, payment_recorded true`, lg.length === 1 && lg[0].actor_type === 'operator' && lg[0].metadata.payment_recorded === true, lg);
      const ct = await closeTrip(w.c.svc, id);
      assert(`O2/${method}: the trip closes afterwards (operational, separate)`, ct.ok === true, ct);
    }
    // The owner (role admin) may confirm too.
    const oo = await w.mk({ estado: 'LISTO', totale: 10, id: '#O0005', zona: 'Q1' });
    await startV2(w.c.svc, oo, 'operator_primary', w.scope);
    const ro = await opConfirm(w.c.svc, '#O0005', PAY(), 'owner');
    const lo = await ledger(w.c, '#O0005');
    assert('O2: the owner (admin) may confirm delivery + payment; recorded as owner/admin', ro.ok === true && lo.ev[0].by_actor === 'owner' && lo.ev[0].by_role === 'admin' && lo.tx[0].by_role === 'admin', { ro, ev: lo.ev, tx: lo.tx });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('O3 OPERATOR -- partial payment (canonical custom_amount rules) and the retry / refusal semantics');
  {
    const w = await world(env, { label: 'op-partial' });
    const o = await w.mk({ estado: 'LISTO', totale: 20, id: '#O0010', zona: 'Q1' });
    await startV2(w.c.svc, o, 'operator_primary', w.scope);
    const r = await opConfirm(w.c.svc, o.id, PAY({ mode: 'custom_amount', amount: '8.00' }));
    const l = await ledger(w.c, o.id);
    assert('O3: delivered + partial payment 8.00 of 20.00: RETIRADO, unpaid 12.00 stays a normal pending (partially_paid), one event', r.ok === true && l.estado === 'RETIRADO' && l.paid === 8 && l.unpaid === 12 && l.events === 1, { r, l });
    const over = await opConfirm(w.c.svc, o.id, PAY({ mode: 'custom_amount', amount: '15.00' }));
    assert('O3: paying MORE than what is still owed on the (already delivered) order is refused by the canonical writer, nothing written', over.ok === false && over.code === 'PAYMENT_REFUSED' && over.payment_code === 'ORDER_PAYMENT_AMOUNT_INVALID' && (await ledger(w.c, o.id)).events === 1, over);
    const rest = await opConfirm(w.c.svc, o.id, PAY({ mode: 'full' }));
    const l2 = await ledger(w.c, o.id);
    assert('O3: a later confirmation with the remaining full amount settles it (replay of the delivery, +1 payment of 12.00, total exactly the obligation)', rest.ok === true && rest.code === 'IDEMPOTENT' && l2.paid === 20 && l2.unpaid === 0 && l2.events === 2, { rest, l2 });
    assert('O3: the delivery was audited exactly ONCE (the replay writes no second log row)', (await logsFor(w.c, o.id)).length === 1);
    const settled = await opConfirm(w.c.svc, o.id, PAY());
    assert('O3: once fully settled, another attempt is IDEMPOTENT (ORDER_PAYMENT_ALREADY_SETTLED tolerated): no third event', settled.ok === true && settled.code === 'IDEMPOTENT' && settled.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && (await ledger(w.c, o.id)).events === 2, settled);
    // an honest retry of the SAME request (double click, network retry) replays without a second event
    const o2 = await w.mk({ estado: 'LISTO', totale: 11, id: '#O0011', zona: 'Q1' });
    await closeTrip(w.c.svc, o.id);
    await startV2(w.c.svc, o2, 'operator_primary', w.scope);
    const pay = PAY({ client_request_id: 'req_same_retry_0001' });
    const a = await opConfirm(w.c.svc, o2.id, pay);
    const b = await opConfirm(w.c.svc, o2.id, pay);
    assert('O3: the SAME request twice (double click): first OK, second IDEMPOTENT replay, exactly ONE payment event and ONE transaction',
      a.ok === true && a.code === 'OK' && b.ok === true && b.code === 'IDEMPOTENT' && b.payment && b.payment.idempotent === true
      && (await ledger(w.c, o2.id)).events === 1 && (await ledger(w.c, o2.id)).tx.length === 1, { a, b });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('O4 OPERATOR -- refusals are typed and leave NOTHING behind (money-first, atomic)');
  {
    const w = await world(env, { label: 'op-refuse' });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#O0020', zona: 'Q1' });
    // language-guard: allow-legacy RITIRO is the existing tipo_consegna enum value (a pickup order), not new vocabulary
    const pickup = await w.mk({ estado: 'LISTO', totale: 8, id: '#O0021', delivery: 'RITIRO' });
    const cocina = await w.mk({ estado: 'EN_COCINA', totale: 8, id: '#O0022', zona: 'Q1' });
    const dispatchedOrder = await startV2(w.c.svc, o, 'operator_primary', w.scope);
    assert('O4: setup: trip departed', dispatchedOrder.ok === true, dispatchedOrder);
    const cases = [
      ['unknown order', () => opConfirm(w.c.svc, '#NOPE', null), 'NOT_FOUND'],
      ['not a delivery order (pickup)', () => opConfirm(w.c.svc, pickup.id, null), 'ORDER_NOT_ELIGIBLE'],
      ['order not EN_ENTREGA (still in the kitchen)', () => opConfirm(w.c.svc, cocina.id, null), 'INVALID_STATE'],
      ['a rider may NOT use the operator confirmation', () => opConfirm(w.c.svc, o.id, null, 'rider'), 'AUTH_FORBIDDEN_ROLE'],
      ['stale session_version', () => opConfirm(w.c.svc, o.id, null, 'operator_primary', 7), 'AUTH_SESSION_STALE'],
      ['unknown actor', () => opConfirm(w.c.svc, o.id, null, 'nobody'), 'AUTH_ACTOR_NOT_FOUND'],
      ['blank order id', () => opConfirm(w.c.svc, ' ', null), 'INVALID_INPUT'],
      ['invalid method', () => opConfirm(w.c.svc, o.id, PAY({ method: 'paypal' })), 'AUTH_METHOD_INVALID'],
      ['custom_amount without an amount', () => opConfirm(w.c.svc, o.id, PAY({ mode: 'custom_amount' })), 'INVALID_INPUT'],
      ['unknown mode', () => opConfirm(w.c.svc, o.id, PAY({ mode: 'equal_split' })), 'INVALID_INPUT'],
      ['a malformed sid hash is refused by the canonical writer (PAYMENT_REFUSED) and the delivery is NOT confirmed', () => opConfirm(w.c.svc, o.id, PAY({ by_sid_hash: 'not-a-hash' })), 'PAYMENT_REFUSED'],
    ];
    for (const [name, fn, code] of cases) {
      const r = await fn();
      assert(`O4: ${name} -> ${code}`, r.ok === false && r.code === code, r);
    }
    const l = await ledger(w.c, o.id);
    assert('O4: after every refusal the order is STILL EN_ENTREGA, unpaid, with no event, no transaction, no audit row (atomic)', l.estado === 'EN_ENTREGA' && l.events === 0 && l.tx.length === 0 && (await logsFor(w.c, o.id)).length === 0, l);
    await w.c.su.query("UPDATE public.auth_actors SET active = false WHERE actor = 'operator_backup'");
    assert('O4: an inactive actor -> AUTH_INITIATOR_INACTIVE', (await opConfirm(w.c.svc, o.id, null, 'operator_backup')).code === 'AUTH_INITIATOR_INACTIVE');
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('O5 OPERATOR (B2) -- the service was CLOSED and NO service is open: delivery + payment are recorded, off-service, nothing is reopened');
  {
    const w = await world(env, { label: 'op-closed' });
    const { o } = await dispatched(w, { id: '#O0030', totale: 12.5 });
    const corr = await seedCloseable(w.c, w.s);
    const cl = await closeV3(w.c.svc, w.s, corr);
    assert('O5: "Finalizar con pendientes": the service closes with the delivery EN_ENTREGA + unpaid and the trip ACTIVE', cl.ok === true, cl);
    const before = await ledger(w.c, o.id);
    assert('O5: the closed service keeps the pending: delivery unconfirmed + 12.50 unpaid', before.estado === 'EN_ENTREGA' && before.unpaid === 12.5, before);
    const req = PAY();
    const r = await opConfirm(w.c.svc, o.id, req);
    const l = await ledger(w.c, o.id);
    const sn = await snap(w.c, w.s);
    assert('O5/A: with NO open service the operator "Entregado y cobrado" (Efectivo) SUCCEEDS: OK, ONE payment recorded', r.ok === true && r.code === 'OK' && !!r.payment && Number(r.payment.amount) === 12.5, r);
    assert('O5/A: order RETIRADO, exactly ONE payment event and ONE transaction, obligation covered (unpaid 0)', l.estado === 'RETIRADO' && l.events === 1 && l.payment_events === 1 && l.tx.length === 1 && l.paid === 12.5 && l.unpaid === 0, l);
    assert('O5/A: attribution -- the sale/obligation stay on the ORIGINAL (closed) service; event_service_session_id is NULL = "no receiving service" (nothing invented)',
      l.svc === w.s && l.ev[0].obligation_svc === w.s && l.ev[0].receipt_svc === null, l.ev);
    assert('O5/A: recorded AS THE OPERATOR (event + transaction), never as the rider; server-forced source', l.ev[0].by_actor === 'operator_primary' && l.ev[0].by_role === 'operator' && l.tx[0].by_actor === 'operator_primary'
      && l.ev[0].meta && l.ev[0].meta.source === 'order' && l.tx[0].meta.source === 'operator_delivery_confirmation', { ev: l.ev, tx: l.tx });
    assert('O5/A: BOTH receipt columns are NULL -- payment_transactions.service_session_id AND order_financial_events.event_service_session_id (no service received this money; the SAME fact) -- while the obligation service is the order\'s; the writer-decided flag only marks the row, it does not carry the meaning',
      l.tx[0].receipt_svc === null && l.ev[0].receipt_svc === null && l.ev[0].obligation_svc === w.s && l.tx[0].meta.off_service_receipt === true, { tx: l.tx, ev: l.ev });
    assert('O5/A: service A is still CLOSED, never reopened, no new service, no pointer', sn.svc === 'closed' && sn.pointer === null && sn.services === 1, sn);
    assert('O5/A: the trip is untouched (still ACTIVE: a payment is not the driver\'s return)', sn.active_trips === 1, sn);
    const logs = await logsFor(w.c, o.id);
    assert('O5/A: audit row says operator, payment_recorded true', logs.length === 1 && logs[0].actor_id === 'operator_primary' && logs[0].metadata.payment_recorded === true, logs);
    const replay = await opConfirm(w.c.svc, o.id, req);
    const l2 = await ledger(w.c, o.id);
    assert('O5/B: the SAME request id replayed -> IDEMPOTENT, still ONE payment (event + transaction)', replay.ok === true && replay.code === 'IDEMPOTENT' && l2.events === 1 && l2.tx.length === 1, { replay, l2 });
    const again = await opConfirm(w.c.svc, o.id, PAY());
    const l3 = await ledger(w.c, o.id);
    assert('O5/C: a NEW request id after it is already settled -> no second payment (ALREADY_SETTLED tolerated, IDEMPOTENT)', again.ok === true && again.code === 'IDEMPOTENT' && again.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && l3.events === 1 && l3.tx.length === 1 && l3.paid === 12.5, { again, l3 });
    await w.c.close();
  }

  section('O6 OPERATOR (B2) -- delivery-only first, the money later: the historical pending is settled off-service; partial payments follow Cash V1; a refused payment confirms nothing');
  {
    // delivery only (historical pending), then the operator settles it with no service open
    const w = await world(env, { label: 'op-closed-2' });
    const { o } = await dispatched(w, { id: '#O0040', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const only = await opConfirm(w.c.svc, o.id, null);
    const h = await ledger(w.c, o.id);
    assert('O6: delivery only: RETIRADO with 12.50 still owed (a HISTORICAL pending)', only.ok === true && h.estado === 'RETIRADO' && h.unpaid === 12.5 && h.events === 0, { only, h });
    const settle = await opConfirm(w.c.svc, o.id, PAY({ method: 'tarjeta' }));
    const s1 = await ledger(w.c, o.id);
    assert('O6: settled later with NO service open: the payment is recorded (the delivery was already confirmed -> IDEMPOTENT), pending back to 0, ONE event, off-service, on the original service',
      settle.ok === true && settle.code === 'IDEMPOTENT' && !!settle.payment && s1.events === 1 && s1.unpaid === 0 && s1.ev[0].receipt_svc === null && s1.ev[0].obligation_svc === w.s && s1.ev[0].payment_method === 'tarjeta', { settle, s1 });
    assert('O6: no second audit row for the delivery', (await logsFor(w.c, o.id)).length === 1);
    await w.c.close();
  }
  {
    // partial / custom amount: Cash V1 rules unchanged (bounded by what is still owed), off-service
    const w = await world(env, { label: 'op-closed-3' });
    const { o } = await dispatched(w, { id: '#O0041', totale: 20 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const p1 = await opConfirm(w.c.svc, o.id, PAY({ mode: 'custom_amount', amount: '5.00' }));
    const a = await ledger(w.c, o.id);
    assert('O6/F: partial 5.00 of 20.00 off-service: delivered, unpaid 15.00 stays a pending (partially_paid), one event', p1.ok === true && a.estado === 'RETIRADO' && a.events === 1 && a.paid === 5 && a.unpaid === 15 && a.ev[0].receipt_svc === null, { p1, a });
    const over = await opConfirm(w.c.svc, o.id, PAY({ mode: 'custom_amount', amount: '99.00' }));
    const b = await ledger(w.c, o.id);
    assert('O6/F: more than what is still owed is refused by the canonical writer (unchanged rule), nothing written', over.ok === false && over.code === 'PAYMENT_REFUSED' && over.payment_code === 'ORDER_PAYMENT_AMOUNT_INVALID' && b.events === 1 && b.paid === 5, { over, b });
    const rest = await opConfirm(w.c.svc, o.id, PAY());
    const c = await ledger(w.c, o.id);
    assert('O6/F: the remaining full amount settles it: total EXACTLY the obligation, never over-collected', rest.ok === true && c.events === 2 && c.paid === 20 && c.unpaid === 0, { rest, c });
    await w.c.close();
  }
  {
    // G: a refused payment on "Entregado y cobrado" must NOT commit the delivery (still EN_ENTREGA, nothing written)
    const w = await world(env, { label: 'op-closed-4' });
    const { o } = await dispatched(w, { id: '#O0042', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const bad = await opConfirm(w.c.svc, o.id, PAY({ mode: 'custom_amount', amount: '99.00' }));
    const l = await ledger(w.c, o.id);
    assert('O6/G: "Entregado y cobrado" with a REFUSED payment (off-service): PAYMENT_REFUSED, the order is STILL EN_ENTREGA, no event, no transaction, no audit row',
      bad.ok === false && bad.code === 'PAYMENT_REFUSED' && l.estado === 'EN_ENTREGA' && l.events === 0 && l.tx.length === 0 && (await logsFor(w.c, o.id)).length === 0, { bad, l });
    await w.c.close();
  }

  section('O7 (B2) STALE PAGES with the service CLOSED and no service open: operator vs rider, both directions -- at most ONE payment');
  {
    const w = await world(env, { label: 'op-closed-5' });
    const { o } = await dispatched(w, { id: '#O0050', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const op = await opConfirm(w.c.svc, o.id, PAY());
    const riderStale = await riderStop(w.c.svc, o.id, 'efectivo', 'rider_delivery_O0050');
    const l = await ledger(w.c, o.id);
    assert('O7/D: the operator paid off-service; the rider\'s STALE Entregado + Efectivo is refused (AUTH_BASIS_EXISTS): exactly ONE payment', op.ok === true && riderStale.ok === false && riderStale.code === 'PAYMENT_REFUSED' && riderStale.payment_code === 'AUTH_BASIS_EXISTS' && l.events === 1 && l.tx.length === 1 && l.unpaid === 0, { riderStale, l });
    await w.c.close();
  }
  {
    const w = await world(env, { label: 'op-closed-6' });
    const { o } = await dispatched(w, { id: '#O0051', totale: 9.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const rider = await riderStop(w.c.svc, o.id, 'tarjeta', 'rider_delivery_O0051');
    const opStale = await opConfirm(w.c.svc, o.id, PAY());
    const l = await ledger(w.c, o.id);
    assert('O7/E: the rider paid off-service; the operator\'s STALE delivery + payment is IDEMPOTENT (already settled tolerated): exactly ONE payment, the RIDER\'s',
      rider.ok === true && opStale.ok === true && opStale.code === 'IDEMPOTENT' && opStale.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && l.events === 1 && l.tx.length === 0 && l.ev[0].by_actor === 'rider', { opStale, l });
    await w.c.close();
  }

  section('O8 (B2) A CLOSED + B OPEN: the behaviour with a service open is preserved (receipt in B, sale in A, no double count); the standalone Cash V1 writer follows the same rule');
  {
    const w = await world(env, { label: 'op-closed-7' });
    const { o } = await dispatched(w, { id: '#O0060', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const B = await openService(w.c, '2026-09-20');
    const ob = await w.c.fx.order(w.c.svc, { session: B, estado: 'LISTO', totale: 10, id: '#O0061', zona: 'Q1' });
    const r = await opConfirm(w.c.svc, o.id, PAY());
    const l = await ledger(w.c, o.id);
    assert('O8: with B open the operator payment records the receipt in B (Cash V1 contract UNCHANGED): sale/obligation stay in A, ONE event, ONE tx (receipt service B), unpaid 0',
      r.ok === true && l.svc === w.s && l.ev.length === 1 && l.ev[0].obligation_svc === w.s && l.ev[0].receipt_svc === B && l.tx.length === 1 && l.tx[0].receipt_svc === B && !('off_service_receipt' in l.tx[0].meta) && l.unpaid === 0, { r, l });
    const lb = await ledger(w.c, ob.id);
    const sums = (await w.c.su.query(`SELECT
       (SELECT coalesce(sum(amount),0)::numeric FROM public.order_financial_events WHERE type='payment' AND service_session_id = $1) AS a_obl,
       (SELECT coalesce(sum(amount),0)::numeric FROM public.order_financial_events WHERE type='payment' AND service_session_id = $2) AS b_obl,
       (SELECT coalesce(sum(amount),0)::numeric FROM public.order_financial_events WHERE type='payment' AND event_service_session_id = $2) AS b_receipt`, [w.s, B])).rows[0];
    assert('O8: no double counting: the sale money is booked ONCE on A (12.5), NOTHING on B\'s obligation side, and the receipt side is B (12.5); B\'s own order untouched',
      Number(sums.a_obl) === 12.5 && Number(sums.b_obl) === 0 && Number(sums.b_receipt) === 12.5 && lb.events === 0 && lb.unpaid === 10, { sums, lb });
    await w.c.close();
  }
  {
    // the standalone Cash V1 writer (order_post_payment_v1 called directly) on a historical pending, NO service open
    const w = await world(env, { label: 'op-closed-8' });
    const { o } = await dispatched(w, { id: '#O0070', totale: 14 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    await opConfirm(w.c.svc, o.id, null);
    const wsId = (await w.c.su.query('SELECT id FROM public.workspaces ORDER BY name LIMIT 1')).rows[0].id;
    const r = await cashPayDirect(w.c.svc, wsId, o);
    const l = await ledger(w.c, o.id);
    assert('O8: the standalone Cash V1 writer settles a historical pending with NO service open: off-service receipt (event_service_session_id NULL), sale on A, ONE event/tx, unpaid 0',
      r.ok === true && r.idempotent === false && r.serviceSessionId === null && l.events === 1 && l.tx.length === 1 && l.ev[0].receipt_svc === null && l.tx[0].receipt_svc === null && l.ev[0].obligation_svc === w.s && l.tx[0].meta.off_service_receipt === true && l.unpaid === 0, { r, l });
    const again = await cashPayDirect(w.c.svc, wsId, o).catch((e) => ({ threw: e.message }));
    assert('O8: a second standalone payment on the settled order is refused (ORDER_PAYMENT_ALREADY_SETTLED): no overpayment', again.threw === 'ORDER_PAYMENT_ALREADY_SETTLED' && (await ledger(w.c, o.id)).events === 1, again);
    await w.c.close();
  }

  section('T1 (B3) the operator confirms the LAST stop: the trip stays ACTIVE (never auto-closed), is closable through the canonical close_rider_trip, and a new dispatch works after that');
  {
    const w = await world(env, { label: 'trip-closable' });
    const { o } = await dispatched(w, { id: '#T0100', totale: 12.5 });
    const o2 = await w.mk({ estado: 'LISTO', totale: 9, id: '#T0101', zona: 'Q1' });
    const early = await closeTrip(w.c.svc, null);
    assert('T1/F: the driver "returns" BEFORE the last delivery: EARLY_CLOSE (the backend is the authority)', early.ok === false && early.code === 'EARLY_CLOSE', early);
    assert('T1/G: ...and nothing was transformed: the order is STILL EN_ENTREGA (no automatic EN_ENTREGA -> RETIRADO)', (await orderEstado(w.c, o.id)) === 'EN_ENTREGA');
    const del = await opConfirm(w.c.svc, o.id, null);
    assert('T1/B: the operator confirms the last stop: RETIRADO', del.ok === true && (await orderEstado(w.c, o.id)) === 'RETIRADO', del);
    const trips = await tripStatus(w.c);
    assert('T1/B: the trip is STILL ACTIVE (delivery is not the driver\'s return): never auto-closed', trips.length === 1 && trips[0].status === 'ACTIVE', trips);
    const blocked = await startV2(w.c.svc, o2, 'operator_primary', w.scope);
    assert('T1/C: while the trip is ACTIVE every new dispatch is refused (ACTIVE_TRIP_CONFLICT) -- which is why the trip MUST stay closable from the Delivery surface with 0 EN_ENTREGA rows left', blocked.ok === false && blocked.code === 'ACTIVE_TRIP_CONFLICT', blocked);
    const ct = await closeTrip(w.c.svc, null);
    assert('T1/D: "Driver volvió" = close_rider_trip (no trigger order needed): OK, trip CLOSED', ct.ok === true && ct.code === 'OK' && (await tripStatus(w.c))[0].status === 'CLOSED', ct);
    const l = await ledger(w.c, o.id);
    assert('T1: closing the trip wrote NOTHING economic (Driver volvió is not a payment): 0 events, still 12.50 owed', l.events === 0 && l.unpaid === 12.5, l);
    const ok = await startV2(w.c.svc, o2, 'operator_primary', w.scope);
    assert('T1/E: a new dispatch after the trip is CLOSED works normally', ok.ok === true && ok.code === 'OK', ok);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('D1 NO DOUBLE PAYMENT / NO DOUBLE DELIVERY -- operator vs rider on the same order, both directions');
  {
    const w = await world(env, { label: 'dup' });
    // operator paid, rider (stale page) retries Entregado + Efectivo
    const a = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#D0001', zona: 'Q1' });
    await startV2(w.c.svc, a, 'operator_primary', w.scope);
    const opFirst = await opConfirm(w.c.svc, a.id, PAY());
    const riderStale = await riderStop(w.c.svc, a.id, 'efectivo', 'rider_delivery_D0001');
    const la = await ledger(w.c, a.id);
    assert('D1: operator-paid, then the rider retries Entregado + Efectivo: typed PAYMENT_REFUSED (AUTH_BASIS_EXISTS), exactly ONE payment event / transaction, obligation covered once',
      opFirst.ok === true && riderStale.ok === false && riderStale.code === 'PAYMENT_REFUSED' && riderStale.payment_code === 'AUTH_BASIS_EXISTS'
      && la.events === 1 && la.tx.length === 1 && la.paid === 12.5 && la.unpaid === 0 && la.estado === 'RETIRADO', { riderStale, la });
    const riderNoMoney = await riderStop(w.c.svc, a.id, '', 'rider_delivery_D0001b');
    assert('D1: the same stale rider page pressing Entregado without money is an IDEMPOTENT no-op (no second state, no second log)', riderNoMoney.ok === true && riderNoMoney.code === 'IDEMPOTENT' && (await logsFor(w.c, a.id)).length === 1, riderNoMoney);
    await closeTrip(w.c.svc, a.id);

    // rider paid, operator (stale page) retries delivery + payment
    const b = await w.mk({ estado: 'LISTO', totale: 9.5, id: '#D0002', zona: 'Q1' });
    await startV2(w.c.svc, b, 'rider', w.scope);
    const riderFirst = await riderStop(w.c.svc, b.id, 'tarjeta', 'rider_delivery_D0002');
    const opStale = await opConfirm(w.c.svc, b.id, PAY({ method: 'efectivo' }));
    const lb = await ledger(w.c, b.id);
    assert('D1: rider-paid, then the operator retries delivery + payment: IDEMPOTENT (already settled tolerated), exactly ONE event, still the RIDER\'s tarjeta payment, no operator audit row',
      riderFirst.ok === true && opStale.ok === true && opStale.code === 'IDEMPOTENT' && opStale.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED'
      && lb.events === 1 && lb.tx.length === 0 && lb.ev[0].by_actor === 'rider' && lb.ev[0].payment_method === 'tarjeta' && (await logsFor(w.c, b.id)).length === 0, { opStale, lb });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('D2 FORCED INTERLEAVING -- operator and rider act on the same order at the same instant (both take L0 first, so they serialize)');
  for (const first of ['operator', 'rider']) {
    const w = await world(env, { label: `dup-race-${first}` });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#D0010', zona: 'Q1' });
    await startV2(w.c.svc, o, 'operator_primary', w.scope);
    const t1 = await w.c.client('ded-t1');
    const t2 = await w.c.client('ded-t2');
    await t1.query('BEGIN');
    const r1 = first === 'operator' ? await opConfirm(t1, o.id, PAY()) : await riderStop(t1, o.id, 'efectivo', 'rider_delivery_D0010');
    const p2 = (first === 'operator' ? riderStop(t2, o.id, 'efectivo', 'rider_delivery_D0010') : opConfirm(t2, o.id, PAY())).catch((e) => ({ threw: e.code || e.message }));
    const wait = await lockWait(w.c.su, 'ded-t2');
    await t1.query('COMMIT');
    const r2 = await p2;
    const l = await ledger(w.c, o.id);
    assert(`D2/${first}-first: the second caller was stuck on L0 (advisory) while the first was in flight`, !!wait && wait.waiting_locktype === 'advisory' && wait.waiting_advisory === KEY_L0, wait);
    assert(`D2/${first}-first: the first succeeds; the second is refused/IDEMPOTENT -- exactly ONE payment event, order RETIRADO once, obligation covered once`,
      r1.ok === true && !r2.threw && l.estado === 'RETIRADO' && l.events === 1 && l.paid === 12.5 && l.unpaid === 0 && (r2.ok === true ? r2.code === 'IDEMPOTENT' : r2.code === 'PAYMENT_REFUSED'), { r1, r2, l });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('H1 (B1) END TO END on the REAL ledger rows + the REAL readers: a CLOSED service\'s EN_ENTREGA credit is visible in Economía, survives the delivery confirmation and DISAPPEARS when it is paid');
  {
    const w = await world(env, { label: 'hist-pending' });
    const { o } = await dispatched(w, { id: '#H0001', totale: 12.5 });
    // (live) the service is OPEN: the unpaid EN_ENTREGA is a LIVE exposure, NOT a historical pendency
    let rd = await economyReaders(w.c);
    let p = await rd.pending(); let sn = await rd.snapshot();
    assert('H1/A: OPEN service + EN_ENTREGA + unpaid 12.50: NOT a pendency; it is the live "Por cobrar aún abierto"', p.totals.porCobrar === 0 && sn.obligation.currentServiceUnpaid === 12.5 && sn.obligation.unpaid === 12.5, { p: p.totals, s: sn.obligation });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    rd = await economyReaders(w.c); p = await rd.pending(); sn = await rd.snapshot();
    assert('H1/B: the service is CLOSED, the delivery still EN_ENTREGA, 12.50 unpaid: HISTORICAL pending 12.50, flagged "Entrega sin confirmar", attributed to the closed service; no longer counted as live',
      p.totals.porCobrar === 12.5 && p.porCobrar.length === 1 && p.porCobrar[0].deliveryState === 'SIN_CONFIRMAR' && p.porCobrar[0].serviceSessionId === w.s && sn.obligation.currentServiceUnpaid === 0 && sn.obligation.unpaid === 12.5, { p: p.porCobrar, s: sn.obligation });
    assert('H1/F: every euro in exactly ONE bucket: live + historical == the window-wide unpaid', Math.round((sn.obligation.currentServiceUnpaid + p.totals.porCobrar) * 100) / 100 === sn.obligation.unpaid, { live: sn.obligation.currentServiceUnpaid, hist: p.totals.porCobrar, unpaid: sn.obligation.unpaid });
    await opConfirm(w.c.svc, o.id, null);
    rd = await economyReaders(w.c); p = await rd.pending();
    assert('H1/C: after "Solo entregado" (RETIRADO, still unpaid) the historical pending continues: 12.50, now flagged ENTREGADO (only the money is open) and collectable', p.totals.porCobrar === 12.5 && p.porCobrar[0].deliveryState === 'ENTREGADO' && JSON.stringify([...p.porCobrar[0].allowedActions]) === '["COLLECT"]', p.porCobrar);
    const pay = await opConfirm(w.c.svc, o.id, PAY());
    rd = await economyReaders(w.c); p = await rd.pending(); sn = await rd.snapshot();
    assert('H1/D: the operator records the payment with NO service open: the historical pending DISAPPEARS (0), the sale stays on the closed service, nothing double counted', pay.ok === true && p.totals.porCobrar === 0 && p.counts.porCobrar === 0 && sn.obligation.unpaid === 0 && sn.obligation.currentServiceUnpaid === 0, { pay, p: p.totals, s: sn.obligation });
    await w.c.close();
  }
  {
    // E: paid while still EN_ENTREGA, the delivery confirmation arrives later: pending 0 all the way
    const w = await world(env, { label: 'hist-pending-2' });
    const { o } = await dispatched(w, { id: '#H0002', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const pay = await opConfirm(w.c.svc, o.id, PAY());        // delivery + payment in one go (still off-service)
    let rd = await economyReaders(w.c);
    assert('H1/E: paid off-service, delivery confirmed in the same call: pending 0', pay.ok === true && (await rd.pending()).totals.porCobrar === 0);
    const w2 = await world(env, { label: 'hist-pending-3' });
    const { o: o2 } = await dispatched(w2, { id: '#H0003', totale: 12.5 });
    await closeV3(w2.c.svc, w2.s, await seedCloseable(w2.c, w2.s));
    const rider = await riderStop(w2.c.svc, o2.id, 'efectivo', 'rider_delivery_H0003');   // the RIDER collects while the order is EN_ENTREGA
    const late = await opConfirm(w2.c.svc, o2.id, null);                                   // the operator confirms the delivery AFTER
    rd = await economyReaders(w2.c);
    assert('H1/E: paid by the rider first, the operator\'s delivery confirmation arrives later (IDEMPOTENT): pending stays 0', rider.ok === true && late.ok === true && (await rd.pending()).totals.porCobrar === 0);
    await w.c.close(); await w2.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // POST-CLOSE OPERATOR COLLECTION (Economía → Pendientes → "Registrar cobro"). The surface calls the EXISTING Cash V1
  // payment (POST /api/cash/v1/checks/:orderUid/payments -> cashService.pay -> order_post_payment_v1, ledger-126 body
  // + the 139 off-service edit). These scenarios drive THAT writer exactly as cashDao.postPayment does (server-side
  // actor, request id + hash, source servicio_dashboard) on real PostgreSQL, and read the result back through the REAL
  // Pendientes / snapshot readers. Nothing here uses the operator delivery RPC: this is the standalone collection of an
  // order whose delivery is ALREADY confirmed.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('P1 (product rule) CLOSED service + RETIRADO + unpaid 12.50 -> it IS in Pendientes with the COLLECT action; EN_ENTREGA stays "Entrega sin confirmar" with none');
  {
    const w = await world(env, { label: 'pc-1' });
    const a = await dispatched(w, { id: '#P0001', totale: 12.5 });
    const inTransit = await w.c.fx.order(w.c.svc, { session: w.s, estado: 'EN_ENTREGA', totale: 9.5, id: '#P0002', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    await opConfirm(w.c.svc, a.o.id, null);                                     // "Solo entregado": delivered, money still owed
    const rd = await economyReaders(w.c);
    const p = await rd.pending();
    const ia = p.porCobrar.find((i) => i.orderUid === a.o.order_uid);
    const ib = p.porCobrar.find((i) => i.orderUid === inTransit.order_uid);
    assert('P1/1: the delivered + unpaid order of the CLOSED service is a historical pending of 12.50 attributed to that service',
      !!ia && ia.amount === 12.5 && ia.serviceSessionId === w.s && ia.direction === 'POR_COBRAR', p.porCobrar);
    assert('P1/1: the backend names the action: allowedActions == [COLLECT], delivery fact ENTREGADO (only the money is open)',
      JSON.stringify([...ia.allowedActions]) === '["COLLECT"]' && ia.deliveryState === 'ENTREGADO', ia);
    assert('P1/9: the EN_ENTREGA sibling stays visible as "Entrega sin confirmar" (SIN_CONFIRMAR) and offers NO collection (a plain "Registrar cobro" would fake the delivery)',
      !!ib && ib.deliveryState === 'SIN_CONFIRMAR' && ib.allowedActions.length === 0 && ib.amount === 9.5, ib);
    assert('P1: the reader wrote nothing (order still RETIRADO / EN_ENTREGA, no event, no transaction)',
      (await orderEstado(w.c, a.o.id)) === 'RETIRADO' && (await orderEstado(w.c, inTransit.id)) === 'EN_ENTREGA' && (await ledger(w.c, a.o.id)).events === 0);
    await w.c.close();
  }

  section('P2 (test 2/7/10) Efectivo, service CLOSED and NO service open: ONE payment, the pendency disappears, and NOTHING else in the database moves');
  {
    const w = await world(env, { label: 'pc-2' });
    const a = await dispatched(w, { id: '#P0010', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    await opConfirm(w.c.svc, a.o.id, null);
    const wsId = await wsOf(w.c);
    const beforeSnap = await snap(w.c, w.s);
    const before = await fingerprint(w.c);
    const beforeOrder = await orderIdentity(w.c, a.o.id);
    const r = await cashPay(w.c.svc, wsId, a.o, { method: 'efectivo' });
    const after = await fingerprint(w.c);
    const afterOrder = await orderIdentity(w.c, a.o.id);
    const l = await ledger(w.c, a.o.id);
    const sn = await snap(w.c, w.s);
    assert('P2/2: the payment is recorded: ok, not a replay, NO receiving service (off-service), amount = what was owed', r.ok === true && r.idempotent === false && r.serviceSessionId === null && Number(r.amount) === 12.5 && Number(r.unpaid) === 0, r);
    assert('P2/2: exactly ONE event, ONE transaction, ONE allocation; the obligation is covered', l.events === 1 && l.payment_events === 1 && l.tx.length === 1 && l.allocations === 1 && l.paid === 12.5 && l.unpaid === 0, l);
    assert('P2/2: method efectivo on the event and the transaction; recorded as the OPERATOR (server-side actor), never as the rider', l.ev[0].payment_method === 'efectivo' && l.tx[0].payment_method === 'efectivo'
      && l.ev[0].by_actor === 'operator_backup' && l.ev[0].by_role === 'operator' && l.tx[0].by_actor === 'operator_backup' && l.tx[0].by_role === 'operator', { ev: l.ev, tx: l.tx });
    assert('P2/7: attribution -- the sale and the obligation STAY on the original (closed) service (order_financial_events.service_session_id = A); BOTH receipt columns are NULL (payment_transactions.service_session_id AND event_service_session_id: the same fact, no service received the money); the transaction is only MARKED off_service_receipt',
      l.svc === w.s && l.ev[0].obligation_svc === w.s && l.ev[0].receipt_svc === null && l.tx[0].receipt_svc === null && l.tx[0].meta.off_service_receipt === true, l);
    assert('P2/7: the service is still CLOSED, NEVER reopened, no pointer, no new service; the trip is NOT closed (a payment is not the driver\'s return)',
      beforeSnap.svc === 'closed' && sn.svc === 'closed' && sn.pointer === null && sn.services === 1 && sn.active_trips === 1 && sn.trips === beforeSnap.trips, { beforeSnap, sn });
    assert('P2/10: the delivery is NOT touched: estado, service, total, delivery type and identity of the order are identical (only the payment mirror columns may move)', JSON.stringify(beforeOrder) === JSON.stringify(afterOrder), { beforeOrder, afterOrder });
    const changed = changedTables(before, after);
    assert('P2/10: the payment wrote to EXACTLY the payment tables + the order\'s payment mirror -- nothing in service_sessions, closeouts, obligations, trips, logs, the pointer',
      JSON.stringify(changed) === JSON.stringify(['public.order_financial_events', 'public.ordenes', 'public.payment_allocations', 'public.payment_transactions'].sort()), changed);
    assert('P2/10: (explicit) the closed service row, its closeout rows, the sale (obligations) and the trip rows are byte-identical',
      ['public.service_sessions', 'public.service_closeouts', 'public.service_closeout_attempts', 'public.order_obligations', 'trip_authority.trips', 'public.service_session_state', 'public.orden_estado_logs']
        .every((t) => before[t] === after[t]), changed);
    const rd = await economyReaders(w.c); const p = await rd.pending(); const s2 = await rd.snapshot();
    assert('P2/2 + P2/10: the historical pendency DISAPPEARS (0) and nothing is double counted', p.totals.porCobrar === 0 && p.counts.porCobrar === 0 && s2.obligation.unpaid === 0 && s2.obligation.currentServiceUnpaid === 0 && s2.receipts.byMethod.efectivo === 12.5 && s2.counts.payments === 1, { p: p.totals, s: s2.obligation, r: s2.receipts });
    await w.c.close();
  }

  section('P3 (test 3) Tarjeta and Bizum: the method is exactly what the operator chose, on the event, the transaction and the order mirror');
  {
    const w = await world(env, { label: 'pc-3' });
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 20, id: '#P0020', zona: 'Q1' });
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 30, id: '#P0021', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const wsId = await wsOf(w.c);
    const r1 = await cashPay(w.c.svc, wsId, o1, { method: 'tarjeta' });
    const r2 = await cashPay(w.c.svc, wsId, o2, { method: 'bizum' });
    const l1 = await ledger(w.c, o1.id); const l2 = await ledger(w.c, o2.id);
    assert('P3/3: Tarjeta -> the event, the transaction and the mirror say tarjeta; ONE payment; off-service', r1.ok === true && l1.events === 1 && l1.ev[0].payment_method === 'tarjeta' && l1.tx[0].payment_method === 'tarjeta' && l1.metodo_pago === 'tarjeta' && l1.ev[0].receipt_svc === null && l1.unpaid === 0, l1);
    assert('P3/3: Bizum -> the event, the transaction and the mirror say bizum; ONE payment; off-service', r2.ok === true && l2.events === 1 && l2.ev[0].payment_method === 'bizum' && l2.tx[0].payment_method === 'bizum' && l2.metodo_pago === 'bizum' && l2.ev[0].receipt_svc === null && l2.unpaid === 0, l2);
    const bad = await cashPayOrThrow(w.c.svc, wsId, await w.mk({ estado: 'RETIRADO', totale: 5, id: '#P0022', zona: 'Q1' }), { method: 'paypal' });
    assert('P3: an unknown method is refused by the writer (ORDER_PAYMENT_INVALID), nothing written', bad.threw === 'ORDER_PAYMENT_INVALID', bad);
    await w.c.close();
  }

  section('P4 (test 4) double click / replay: AT MOST ONE payment -- same request id (sequential AND concurrent), a second tablet, a new request after settled');
  {
    const w = await world(env, { label: 'pc-4' });
    const o = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#P0030', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const wsId = await wsOf(w.c);
    const reqId = `cash_${crypto.randomUUID()}`;
    const r1 = await cashPay(w.c.svc, wsId, o, { reqId });
    const r2 = await cashPay(w.c.svc, wsId, o, { reqId });
    const l = await ledger(w.c, o.id);
    assert('P4/4: the SAME request id replayed (double click / retry) -> idempotent, the SAME transaction, ONE payment', r1.idempotent === false && r2.idempotent === true && r2.transactionId === r1.transactionId && l.events === 1 && l.tx.length === 1, { r1, r2, l });
    const conflict = await cashPayOrThrow(w.c.svc, wsId, o, { reqId, hash: hex64('a different request body') });
    assert('P4/4: the same request id with a DIFFERENT body is refused (ORDER_PAYMENT_IDEMPOTENCY_CONFLICT), nothing written', conflict.threw === 'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT' && (await ledger(w.c, o.id)).events === 1, conflict);
    const again = await cashPayOrThrow(w.c.svc, wsId, o, {});
    assert('P4/4: a NEW request after it is settled -> ORDER_PAYMENT_ALREADY_SETTLED (no overpayment), still ONE payment', again.threw === 'ORDER_PAYMENT_ALREADY_SETTLED' && (await ledger(w.c, o.id)).events === 1 && (await ledger(w.c, o.id)).paid === 12.5, again);

    // two REAL concurrent connections, the same request id: the workspace lock serializes them -> one payment, one replay
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#P0031', zona: 'Q1' });
    const c1 = await w.c.client('pc4-a'); const c2 = await w.c.client('pc4-b');
    const same = `cash_${crypto.randomUUID()}`;
    const race = await Promise.all([cashPayOrThrow(c1, wsId, o2, { reqId: same }), cashPayOrThrow(c2, wsId, o2, { reqId: same })]);
    const l2 = await ledger(w.c, o2.id);
    assert('P4/4: two concurrent clicks with the SAME request id -> exactly one payment row, one is a replay, no error', l2.events === 1 && l2.tx.length === 1 && race.every((x) => x.ok === true) && race.filter((x) => x.idempotent === true).length === 1, { race, l2 });
    // two tablets, two DIFFERENT request ids, both "pay the full amount"
    const o3 = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#P0032', zona: 'Q1' });
    const race2 = await Promise.all([cashPayOrThrow(c1, wsId, o3, { actor: 'operator_primary' }), cashPayOrThrow(c2, wsId, o3, { actor: 'operator_backup' })]);
    const l3 = await ledger(w.c, o3.id);
    assert('P4/4: two tablets paying the full amount at the same instant (different request ids) -> exactly ONE payment; the other is refused ORDER_PAYMENT_ALREADY_SETTLED; never over-collected',
      l3.events === 1 && l3.paid === 12.5 && race2.filter((x) => x.ok === true).length === 1 && race2.filter((x) => x.threw === 'ORDER_PAYMENT_ALREADY_SETTLED').length === 1, { race2, l3 });
    await w.c.close();
  }

  section('P5/P6 (test 5/6) stale pages: the rider already paid -> the operator creates no second payment; the operator paid -> the stale rider creates none');
  {
    // 5: the rider collected from a stale/late page while the order was still EN_ENTREGA of the CLOSED service
    const w = await world(env, { label: 'pc-5' });
    const a = await dispatched(w, { id: '#P0040', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const wsId = await wsOf(w.c);
    const rider = await riderStop(w.c.svc, a.o.id, 'efectivo', 'rider_delivery_P0040');
    const op = await cashPayOrThrow(w.c.svc, wsId, a.o, {});
    const l = await ledger(w.c, a.o.id);
    assert('P5/5: the rider paid (RETIRADO, settled); the operator\'s "Registrar cobro" is refused ORDER_PAYMENT_ALREADY_SETTLED: exactly ONE payment, the RIDER\'s',
      rider.ok === true && op.threw === 'ORDER_PAYMENT_ALREADY_SETTLED' && l.events === 1 && l.ev[0].by_actor === 'rider' && l.unpaid === 0 && l.estado === 'RETIRADO', { rider, op, l });
    const rd = await economyReaders(w.c);
    assert('P5/5: and the pendency is gone from Pendientes', (await rd.pending()).totals.porCobrar === 0);
    await w.c.close();
  }
  {
    // 6a: delivered (operator), then the operator collects; the RIDER's stale page presses Entregado + Efectivo afterwards
    const w = await world(env, { label: 'pc-6' });
    const a = await dispatched(w, { id: '#P0050', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    await opConfirm(w.c.svc, a.o.id, null);
    const wsId = await wsOf(w.c);
    const op = await cashPay(w.c.svc, wsId, a.o, {});
    const riderStale = await riderStop(w.c.svc, a.o.id, 'efectivo', 'rider_delivery_P0050');
    const l = await ledger(w.c, a.o.id);
    assert('P6/6a: the operator collected; the rider\'s STALE Entregado + Efectivo does NOT create a second payment (refused / no-op)', op.ok === true && !(riderStale.ok === true && riderStale.payment) && l.events === 1 && l.tx.length === 1 && l.paid === 12.5 && l.unpaid === 0, { riderStale, l });
    await w.c.close();
  }
  {
    // 6b: the operator collects with the order still EN_ENTREGA (the Cash V1 API is estado-agnostic); the rider's stale Entregado + Efectivo follows
    const w = await world(env, { label: 'pc-6b' });
    const a = await dispatched(w, { id: '#P0051', totale: 12.5 });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const wsId = await wsOf(w.c);
    const op = await cashPay(w.c.svc, wsId, a.o, {});
    const riderStale = await riderStop(w.c.svc, a.o.id, 'efectivo', 'rider_delivery_P0051');
    const l = await ledger(w.c, a.o.id);
    assert('P6/6b: operator paid first (order still EN_ENTREGA), the rider\'s stale Entregado + Efectivo is refused (AUTH_BASIS_EXISTS): exactly ONE payment', op.ok === true && riderStale.ok === false && riderStale.code === 'PAYMENT_REFUSED' && riderStale.payment_code === 'AUTH_BASIS_EXISTS' && l.events === 1 && l.tx.length === 1, { riderStale, l });
    await w.c.close();
  }

  section('P8 (test 8) original service A CLOSED, service B OPEN: the sale and the obligation stay on A, the receipt follows the Cash V1 contract (receiving service = B), no double counting');
  {
    const w = await world(env, { label: 'pc-8' });
    const g = await w.mk({ estado: 'RETIRADO', totale: 12.5, id: '#P0060', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const B = await openService(w.c, '2026-09-20');
    const h = await w.c.fx.order(w.c.svc, { session: B, estado: 'LISTO', totale: 10, id: '#P0061', zona: 'Q1' });
    const wsId = await wsOf(w.c);
    const before = await fingerprint(w.c);
    const r = await cashPay(w.c.svc, wsId, g, { method: 'tarjeta' });
    const after = await fingerprint(w.c);
    const l = await ledger(w.c, g.id);
    const lh = await ledger(w.c, h.id);
    assert('P8/8: with B open the receipt is recorded in B (the Cash V1 contract is unchanged), ONE event/tx, no off_service marker; the sale/obligation stay on A', r.ok === true && r.serviceSessionId === B && l.svc === w.s && l.ev.length === 1 && l.ev[0].obligation_svc === w.s && l.ev[0].receipt_svc === B && l.tx.length === 1 && l.tx[0].receipt_svc === B && !('off_service_receipt' in l.tx[0].meta) && l.unpaid === 0, { r, l });
    const sums = (await w.c.su.query(`SELECT
       (SELECT coalesce(sum(amount),0)::numeric FROM public.order_financial_events WHERE type='payment' AND service_session_id = $1) AS a_obl,
       (SELECT coalesce(sum(amount),0)::numeric FROM public.order_financial_events WHERE type='payment' AND service_session_id = $2) AS b_obl,
       (SELECT coalesce(sum(amount),0)::numeric FROM public.order_financial_events WHERE type='payment' AND event_service_session_id = $2) AS b_receipt`, [w.s, B])).rows[0];
    assert('P8/8: no double counting: the money is booked ONCE on A\'s obligation side (12.5), NOTHING on B\'s obligation side, ONCE on the receipt side (B); B\'s own order untouched (unpaid 10)', Number(sums.a_obl) === 12.5 && Number(sums.b_obl) === 0 && Number(sums.b_receipt) === 12.5 && lh.events === 0 && lh.unpaid === 10, { sums, lh });
    assert('P8/8: A stays CLOSED and B stays OPEN with the pointer on B: no service was reopened / closed / created by the payment',
      (await snap(w.c, w.s)).svc === 'closed' && (await snap(w.c, B)).svc === 'open' && (await snap(w.c, B)).pointer === B && (await snap(w.c, B)).services === 2 && changedTables(before, after).indexOf('public.service_sessions') < 0 && changedTables(before, after).indexOf('public.service_session_state') < 0, changedTables(before, after));
    const rd = await economyReaders(w.c); const p = await rd.pending(); const s2 = await rd.snapshot();
    assert('P8/8: Pendientes has no trace of it (paid); B\'s live order is NOT a historical pendency; the window-wide unpaid is exactly B\'s 10 and it is "live", never both buckets',
      p.totals.porCobrar === 0 && s2.obligation.unpaid === 10 && s2.obligation.currentServiceUnpaid === 10 && s2.receipts.byMethod.tarjeta === 12.5 && s2.counts.payments === 1, { p: p.totals, s: s2.obligation, r: s2.receipts });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // CAJA / CASH COUNT regression: migration 139 edits order_post_payment_v1 GLOBALLY, so an OFF-SERVICE receipt
  // (event_service_session_id NULL, sale on the closed service) must not be lost, counted twice, booked as a sale of the
  // wrong service, or turned into cash of the original service's window. Real writer rows -> the REAL readers
  // (economicSnapshot, cashCountService, closeoutReconciliation), unchanged JS.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const path = require('path');
  const repoRoot = path.join(__dirname, '..', '..', '..', '..');
  const { resolveEconomicWindow } = require(path.join(repoRoot, 'src/economy/economicWindow'));
  const { createEconomicSnapshot } = require(path.join(repoRoot, 'src/economy/economicSnapshot'));
  const { createCashCountService } = require(path.join(repoRoot, 'src/economy/cashCountService'));
  const { createCloseoutReconciliation } = require(path.join(repoRoot, 'src/economy/closeoutReconciliation'));
  const bizDate = resolveEconomicWindow({ preset: 'hoy', now: new Date() }).businessDate;   // today's business day (04:00 Madrid cut)
  const cajaKit = (c, wsId, counts) => ({
    read: async () => {
      const rd = await economyReaders(c, { cash_counts: counts });
      const snapFor = createEconomicSnapshot({ select: rd.select });
      const now = new Date();
      return {
        rd, now,
        day: () => snapFor({ preset: 'hoy', businessDate: bizDate, now }),
        service: (id) => snapFor({ preset: 'servicio', serviceSessionId: id, now }),
        count: (cash, id) => createCashCountService({
          select: rd.select, snapshot: snapFor, getCurrentService: async () => null,
          insert: async (t, row) => { const r = { id: `cc-${counts.length + 1}`, created_at: new Date().toISOString(), ...row }; counts.push(r); return [r]; },
        }).create({ context: { actor: 'operator_primary', role: 'operator', workspaceId: wsId }, preset: 'hoy', businessDate: bizDate, countedCash: cash, clientRequestId: id, now: new Date() }),
        recon: (serviceId) => createCloseoutReconciliation({ select: rd.select, snapshot: snapFor }).build({ serviceSessionId: serviceId, now }),
      };
    },
  });
  const sumBy = (rows) => rows.reduce((s, r) => Math.round((s + Number(r.amount)) * 100) / 100, 0);

  section('C1 CAJA/CASH COUNT -- Efectivo + Tarjeta + Bizum collected OFF-SERVICE after the close: counted ONCE in the day, absent from the closed service\'s own window, a cash count taken earlier goes STALE (never a fabricated variance)');
  {
    const w = await world(env, { label: 'caja-1', date: bizDate });
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#C0001', zona: 'Q1' });
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 20, id: '#C0002', zona: 'Q1' });
    const o3 = await w.mk({ estado: 'RETIRADO', totale: 30, id: '#C0003', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const wsId = await wsOf(w.c);
    const counts = []; const kit = cajaKit(w.c, wsId, counts);
    let k = await kit.read();
    await k.count(0, 'cc_before_collections_0001');            // the operator counted the drawer at Finalizar: 0 recorded, 0 counted
    let rc = await k.recon(w.s);
    assert('C1/pre: before any collection the day count is CURRENT with variance 0 (the baseline the later assertions move away from)', rc.cashCountStatus === 'current' && rc.variance === 0 && rc.reconciliation.cashReceipts === 0, { s: rc.cashCountStatus, v: rc.variance });
    await delay(20);
    await cashPay(w.c.svc, wsId, o1, { method: 'efectivo' });
    await cashPay(w.c.svc, wsId, o2, { method: 'tarjeta' });
    await cashPay(w.c.svc, wsId, o3, { method: 'bizum' });
    k = await kit.read();
    const day = await k.day();
    const evs = (await w.c.su.query(`SELECT id, amount::numeric AS amount, payment_method, service_session_id AS obl_svc, event_service_session_id AS rcpt_svc,
        event_economic_period_kind AS kind FROM public.order_financial_events WHERE type = 'payment' ORDER BY created_at`)).rows;
    if (process.env.PROBE) console.log('PROBE events', JSON.stringify(evs), '\nPROBE day.receipts', JSON.stringify(day.receipts), JSON.stringify(day.economicBreakdown), '\nPROBE day.windowCrossing', JSON.stringify(day.windowCrossing));
    assert('C1/a NOT LOST + COUNTED ONCE: the business-day snapshot has all three receipts, by the method the operator chose, once each',
      day.receipts.byMethod.efectivo === 10 && day.receipts.byMethod.tarjeta === 20 && day.receipts.byMethod.bizum === 30 && day.receipts.collected === 60 && day.counts.payments === 3
      && day.drillDown.receipts.length === 3 && new Set(day.drillDown.receipts.map((r) => r.eventId)).size === 3, { r: day.receipts, n: day.counts });
    assert('C1/a the ledger and the report agree to the cent: sum of payment events == receipts.collected == 60', sumBy(evs) === 60 && day.receipts.collected === 60, { evs });
    assert('C1/b NOT A SALE OF ANOTHER SERVICE: every receipt event keeps the ORDER\'S service (A) on the obligation side and NO receiving service; the receipt rows in the report point at A, never at a new service',
      evs.every((e) => e.obl_svc === w.s && e.rcpt_svc === null) && day.drillDown.receipts.every((r) => r.serviceSessionId === w.s) && (await snap(w.c, w.s)).services === 1, evs);
    const svcA = await k.service(w.s);
    if (process.env.PROBE) console.log('PROBE svcA.window', JSON.stringify(svcA.window), '\nPROBE svcA.receipts', JSON.stringify(svcA.receipts), '\nPROBE svcA.crossing', JSON.stringify(svcA.windowCrossing), '\nPROBE svcA.obligation', JSON.stringify(svcA.obligation));
    assert('C1/c NOT CASH OF THE ORIGINAL SERVICE: A\'s own window (opened..closed) does NOT contain money received after it closed: 0 receipts there, and the late receipts are NAMED by the window-crossing block (obligation inside the window, receipt after) rather than hidden',
      svcA.receipts.collected === 0 && svcA.receipts.byMethod.efectivo === 0 && svcA.counts.payments === 0
      && svcA.windowCrossing.obligationInsideWindowReceiptAfter.length === 3 && svcA.obligation.unpaid === 0, { r: svcA.receipts, x: svcA.windowCrossing.obligationInsideWindowReceiptAfter });
    rc = await k.recon(w.s);
    if (process.env.PROBE) console.log('PROBE recon', JSON.stringify({ st: rc.cashCountStatus, why: rc.cashCountStaleReason, v: rc.variance, svc: rc.service.byMethod, day: rc.reconciliation.byMethod, cash: rc.reconciliation.cashReceipts, rel: rc.scopeRelation.kind }));
    assert('C1/d CASH-COUNT: the drawer count taken BEFORE the collections is STALE (recorded_cash_receipts_changed) -- it produces NO variance (never a fabricated -10 shortfall or +10 surplus); the day\'s cash is 10 (Efectivo only: card/Bizum are not drawer cash)',
      rc.cashCountStatus === 'stale' && rc.cashCountStaleReason === 'recorded_cash_receipts_changed' && rc.variance === null && rc.cashCount === null && rc.reconciliation.cashReceipts === 10, { st: rc.cashCountStatus, why: rc.cashCountStaleReason, v: rc.variance, cash: rc.reconciliation.cashReceipts });
    assert('C1/d the day scope reports the three receipts once (10 / 20 / 30); the SERVICE scope of the closed service reports none of them (its own window); the two scopes are never added',
      rc.reconciliation.byMethod.efectivo === 10 && rc.reconciliation.byMethod.tarjeta === 20 && rc.reconciliation.byMethod.bizum === 30 && rc.reconciliation.collected === 60 && rc.service.collected === 0 && rc.service.byMethod.efectivo === 0, { day: rc.reconciliation.byMethod, svc: rc.service.byMethod });
    const era = (await w.c.su.query(`SELECT bool_and(e.event_economic_period_kind = public.classify_economic_period_v1(e.created_at)) AS receipt_by_receiving_instant,
        bool_and(e.obligation_economic_period_kind IS NOT DISTINCT FROM public.classify_economic_period_v1(o.created_at)) AS obligation_by_sale_instant
        FROM public.order_financial_events e JOIN public.ordenes o ON o.id = e.order_id WHERE e.type = 'payment'`)).rows[0];
    assert('C1/f ERA (reporting only): the receipt era is stamped from the RECEIVING instant and the sale era from the SALE instant -- independently; an off-service receipt never inherits or rewrites the sale\'s era, and the breakdown books the 60 once',
      era.receipt_by_receiving_instant === true && era.obligation_by_sale_instant === true
      && Math.round(Object.values(day.economicBreakdown.receipts).reduce((sum, v) => sum + v, 0) * 100) / 100 === 60, { era, b: day.economicBreakdown });
    await k.count(10, 'cc_after_collections_0002');            // a NEW physical count after the money came in
    k = await kit.read(); rc = await k.recon(w.s);
    assert('C1/e a count taken AFTER the collections is CURRENT and reconciles: counted 10 vs recorded 10 -> variance 0', rc.cashCountStatus === 'current' && rc.variance === 0 && rc.cashCount && rc.cashCount.recordedCashReceiptsNow === 10, { st: rc.cashCountStatus, v: rc.variance });
    await w.c.close();
  }

  section('C2 CAJA/CASH COUNT -- Tarjeta / Bizum collected off-service do NOT disturb a drawer count (they are not drawer cash)');
  {
    const w = await world(env, { label: 'caja-2', date: bizDate });
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 20, id: '#C0011', zona: 'Q1' });
    const o2 = await w.mk({ estado: 'RETIRADO', totale: 30, id: '#C0012', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const wsId = await wsOf(w.c);
    const counts = []; const kit = cajaKit(w.c, wsId, counts);
    let k = await kit.read();
    await k.count(0, 'cc_before_cards_0001');
    await delay(20);
    await cashPay(w.c.svc, wsId, o1, { method: 'tarjeta' });
    await cashPay(w.c.svc, wsId, o2, { method: 'bizum' });
    k = await kit.read(); const rc = await k.recon(w.s); const day = await k.day();
    assert('C2: the day shows the card and Bizum receipts (20 / 30) and ZERO cash; the earlier drawer count is still CURRENT with variance 0 (no cash moved)',
      day.receipts.byMethod.tarjeta === 20 && day.receipts.byMethod.bizum === 30 && day.receipts.byMethod.efectivo === 0 && rc.cashCountStatus === 'current' && rc.variance === 0, { day: day.receipts.byMethod, st: rc.cashCountStatus, v: rc.variance });
    await w.c.close();
  }

  section('C3 CAJA/CASH COUNT -- A CLOSED + B OPEN: a receipt taken while B is open (for A\'s order) is counted ONCE in the day; the SALE stays A\'s. (Documented Cash V1 semantics, UNCHANGED by 139: service-scoped views select by the ORDER\'s service.)');
  {
    const w = await world(env, { label: 'caja-3', date: bizDate });
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#C0021', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const B = await openService(w.c, bizDate);
    const wsId = await wsOf(w.c);
    const counts = []; const kit = cajaKit(w.c, wsId, counts);
    await cashPay(w.c.svc, wsId, o1, { method: 'efectivo' });
    const k = await kit.read(); const day = await k.day(); const svcB = await k.service(B); const svcA = await k.service(w.s);
    const evs = (await w.c.su.query(`SELECT service_session_id AS obl_svc, event_service_session_id AS rcpt_svc FROM public.order_financial_events WHERE type = 'payment'`)).rows;
    if (process.env.PROBE) console.log('PROBE C3', JSON.stringify({ evs, day: day.receipts.byMethod, B: svcB.receipts.byMethod, A: svcA.receipts.byMethod, dayBreak: day.economicBreakdown }));
    assert('C3/a the receipt is booked ONCE: sale/obligation side A, receiving service B; the business-day view counts the 10 Efectivo once', evs.length === 1 && evs[0].obl_svc === w.s && evs[0].rcpt_svc === B && day.receipts.byMethod.efectivo === 10 && day.counts.payments === 1, { evs, r: day.receipts });
    assert('C3/b DECLARED SEMANTICS (pre-139, byte-identical with 139): the receipt is in NO service-scoped view -- not A\'s (its window ended before), not B\'s (B\'s scope selects by the ORDER\'s service = A) -- only in the time-window (business-day) view. Never counted twice; pinned so that any change is a conscious decision',
      svcA.receipts.byMethod.efectivo === 0 && svcB.receipts.byMethod.efectivo === 0 && day.receipts.byMethod.efectivo === 10, { A: svcA.receipts.byMethod, B: svcB.receipts.byMethod, day: day.receipts.byMethod });
    await w.c.close();
  }
  {
    // The SAME scenario on the PRE-139 template (the writer as it is live on staging today): identical rows, identical readers.
    const w = await world(env, { pre: true, label: 'caja-3-pre', date: bizDate });
    const o1 = await w.mk({ estado: 'RETIRADO', totale: 10, id: '#C0031', zona: 'Q1' });
    await closeV3(w.c.svc, w.s, await seedCloseable(w.c, w.s));
    const B = await openService(w.c, bizDate);
    const wsId = await wsOf(w.c);
    await cashPay(w.c.svc, wsId, o1, { method: 'efectivo' });
    const k = await cajaKit(w.c, wsId, []).read(); const day = await k.day(); const svcB = await k.service(B); const svcA = await k.service(w.s);
    const evs = (await w.c.su.query(`SELECT service_session_id AS obl_svc, event_service_session_id AS rcpt_svc FROM public.order_financial_events WHERE type = 'payment'`)).rows;
    assert('C3/pre: on the PRE-139 writer (staging today) the same A-closed/B-open payment yields the SAME rows and the SAME report shape as C3/a-b: 139 changes nothing when a service is open',
      evs.length === 1 && evs[0].obl_svc === w.s && evs[0].rcpt_svc === B && svcA.receipts.byMethod.efectivo === 0 && svcB.receipts.byMethod.efectivo === 0 && day.receipts.byMethod.efectivo === 10, { evs, day: day.receipts.byMethod });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('L1 LOCK ANALYSIS -- the operator confirmation takes L0 FIRST (before any row lock)');
  {
    const w = await world(env, { label: 'lock' });
    const o0 = await w.mk({ estado: 'LISTO', totale: 5, id: '#L0000', zona: 'Q1' });
    await startV2(w.c.svc, o0, 'operator_primary', w.scope);
    const holder = await w.c.client('ded-l0-holder');
    const waiter = await w.c.client('ded-op-waiter');
    await holder.query('BEGIN');
    await holder.query("SELECT pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'))");
    const p = opConfirm(waiter, o0.id, null).catch((e) => ({ threw: e.code || e.message }));
    const wait = await lockWait(w.c.su, 'ded-op-waiter');
    const rowLocks = (await w.c.su.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE a.application_name = 'ded-op-waiter' AND l.locktype IN ('relation','tuple','transactionid') AND l.mode IN ('RowExclusiveLock','RowShareLock') AND l.granted AND l.relation IS NOT NULL
        AND l.relation IN ('public.ordenes'::regclass, 'public.order_financial_events'::regclass, 'public.auth_actors'::regclass)`)).rows[0].n;
    assert('L1: with L0 held by someone else, the operator confirmation waits on the DISPATCH lock (advisory)', !!wait && wait.waiting_locktype === 'advisory' && wait.waiting_advisory === KEY_L0, wait);
    assert('L1: ...and has taken NO lock on ordenes / order_financial_events / auth_actors yet (L0 is genuinely its first statement)', rowLocks === 0, rowLocks);
    await holder.query('COMMIT');
    const done = await p;
    assert('L1: once L0 is free it completes', done.ok === true && done.code === 'OK', done);

    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // The lock order of the standalone Cash V1 writer (order_post_payment_v1) is: workspaces -> auth_actors ->
  // order_entities FOR UPDATE -> ordenes FOR UPDATE. This helper models exactly that pair of row locks: T_cash takes
  // the order_entities lock, the OTHER call is started (and reaches whatever it needs), then T_cash asks for the
  // ordenes lock. It is deterministic: no timing luck.
  async function cashLockModel(w, o, other) {
    const tx = await w.c.client('ded-cash-model');
    const oc = await w.c.client('ded-other');
    await tx.query('BEGIN');
    await tx.query('SELECT 1 FROM public.order_entities WHERE order_uid = $1 FOR UPDATE', [o.order_uid]);
    const p = other(oc).catch((e) => ({ threw: e.code || e.message }));
    const wait = await lockWait(w.c.su, 'ded-other');
    let cashErr = null;
    try { await tx.query('SELECT 1 FROM public.ordenes WHERE order_uid = $1 FOR UPDATE', [o.order_uid]); } catch (e) { cashErr = e.code || e.message; }
    await tx.query(cashErr ? 'ROLLBACK' : 'COMMIT');
    const res = await p;
    return { wait, cashErr, res };
  }

  section('L2 PRE-EXISTING (NOT introduced by 139): a standalone Cash V1 payment and the RIDER stop can deadlock on the same order');
  {
    // Reproduced on the PRE-139 template, where the operator RPC does not even exist. Cause: rider_collect_and_complete_stop
    // updates the order row TWICE in one transaction (ya_pagado/cobrado, then RETIRADO); the second UPDATE re-fires the
    // ordenes.order_uid foreign-key check (the old tuple was created by the same transaction) = FOR KEY SHARE on
    // order_entities, which the Cash writer already holds FOR UPDATE while it waits for the ordenes row the rider holds.
    const w = await world(env, { pre: true, label: 'pre-existing-deadlock' });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#P0001', zona: 'Q1' });
    await startV2(w.c.svc, o, 'operator_primary', w.scope);
    const r = await cashLockModel(w, o, (c) => riderStop(c, o.id, 'efectivo', 'rider_delivery_P0001'));
    assert('L2: PRE-139, rider stop vs the Cash V1 lock order: a genuine PostgreSQL deadlock (40P01) is detected -- present BEFORE this migration, in code 139 does not touch',
      r.cashErr === '40P01' || (r.res && r.res.threw === '40P01'), r);
    const l = await ledger(w.c, o.id);
    assert('L2: whichever side was the victim, nothing was double-written: at most ONE payment event and the order is consistent', l.events <= 1 && l.paid <= l.obligation, l);
    // honest retry: the SAME rider request (same idempotency key) converges to exactly ONE payment, whoever was the victim
    const retry = await riderStop(w.c.svc, o.id, 'efectivo', 'rider_delivery_P0001');
    const lr = await ledger(w.c, o.id);
    assert('L2: the honest retry CONVERGES: RETIRADO, exactly ONE payment, obligation covered once, no data lost', retry.ok === true && lr.estado === 'RETIRADO' && lr.events === 1 && lr.paid === lr.obligation && lr.unpaid === 0, { retry, lr });
    await w.c.close();
  }
  {
    // 139 EDITS order_post_payment_v1 (B2), so the exposure must be re-proven on the POST-139 template: the lock order of the
    // writer is UNCHANGED (workspaces -> auth_actors -> order_entities -> ordenes), the deadlock is exactly the same
    // pre-existing one, and nothing in 139 makes it more reachable.
    const w = await world(env, { label: 'post139-deadlock' });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#P0011', zona: 'Q1' });
    await startV2(w.c.svc, o, 'operator_primary', w.scope);
    const r = await cashLockModel(w, o, (c) => riderStop(c, o.id, 'efectivo', 'rider_delivery_P0011'));
    assert('L2b: POST-139 (edited Cash V1 writer): the SAME pre-existing rider-stop vs Cash V1 deadlock (40P01) is still detected -- unchanged, not introduced by 139',
      r.cashErr === '40P01' || (r.res && r.res.threw === '40P01'), r);
    const l = await ledger(w.c, o.id);
    assert('L2b: nothing double-written', l.events <= 1 && l.paid <= l.obligation, l);
    const retry = await riderStop(w.c.svc, o.id, 'efectivo', 'rider_delivery_P0011');
    const lr = await ledger(w.c, o.id);
    assert('L2b: the honest retry converges: ONE payment, obligation covered once', retry.ok === true && lr.estado === 'RETIRADO' && lr.events === 1 && lr.unpaid === 0, { retry, lr });
    await w.c.close();
  }

  section('L3 THE OPERATOR CONFIRMATION DOES NOT HAVE THAT CYCLE -- same forced interleaving, POST-139: no deadlock');
  {
    const w = await world(env, { label: 'op-no-cycle' });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#P0002', zona: 'Q1' });
    await startV2(w.c.svc, o, 'operator_primary', w.scope);
    const r = await cashLockModel(w, o, (c) => opConfirm(c, o.id, PAY()));
    assert('L3: the operator confirmation waits on the order_entities row (the writer takes it BEFORE ordenes, exactly like Cash V1), so there is no cycle',
      !!r.wait && r.cashErr === null && r.res && r.res.ok === true && r.res.code === 'OK', r);
    const l = await ledger(w.c, o.id);
    assert('L3: the confirmation completed: RETIRADO, ONE payment, obligation covered', l.estado === 'RETIRADO' && l.events === 1 && l.unpaid === 0, l);
    await w.c.close();
  }

  section('L4 PAIRWISE RANDOMIZED STRESS -- the operator confirmation vs a standalone Cash V1 payment, vs a rider stop: 0 deadlock, 0 double payment');
  {
    const w = await world(env, { label: 'pairwise' });
    const wsId = (await w.c.su.query('SELECT id FROM public.workspaces ORDER BY name LIMIT 1')).rows[0].id;
    const cs = await Promise.all([0, 1].map((k) => w.c.client(`ded-pair-${k}`)));
    const cashPay = (c, o) => c.query('SELECT public.order_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) AS r',
      [wsId, 'operator_backup', hex64('sid-b'), o.order_uid, 'tarjeta', 'full', null, `cash_${crypto.randomUUID()}`, hex64(crypto.randomUUID()), '{}', false]).then((x) => x.rows[0].r);
    const pairs = {
      'operator RPC vs standalone Cash V1': [(c, o) => opConfirm(c, o.id, PAY()), cashPay],
      'operator RPC vs rider stop': [(c, o) => opConfirm(c, o.id, PAY()), (c, o) => riderStop(c, o.id, 'efectivo', `rider_delivery_${o.id.slice(1)}`)],
    };
    const N = 16;
    for (const [name, [fa, fb]] of Object.entries(pairs)) {
      let deadlocks = 0; let violations = 0; let anomalies = 0;
      for (let i = 0; i < N; i++) {
        const id = `#Q${name.length}${String(i).padStart(3, '0')}`;
        const o = await w.mk({ estado: 'LISTO', totale: 10 + i, id, zona: 'Q1' });
        await closeTrip(w.c.svc, null).catch(() => {});      // the previous trip must be closed before a new departure
        const st = await startV2(w.c.svc, o, 'operator_primary', w.scope);
        if (!st.ok) { anomalies++; continue; }
        const fns = [() => fa(cs[0], o), () => fb(cs[1], o)];
        if (Math.random() < 0.5) fns.reverse();
        const out = await Promise.all(fns.map((f) => delay(rnd(6)).then(f).catch((e) => ({ threw: e.code || e.message }))));
        if (out.some((x) => x && x.threw === '40P01')) deadlocks++;
        const l = await ledger(w.c, id);
        if (l.events > 1 || l.paid > l.obligation || l.payment_events > 1) violations++;
      }
      assert(`L4: ${name}: ${N} randomized races: 0 deadlock`, deadlocks === 0, { deadlocks });
      assert(`L4: ${name}: 0 over-payment, never more than ONE payment event per order`, violations === 0, { violations });
      assert(`L4: ${name}: every departure of the stress set succeeded (the harness itself is sound)`, anomalies === 0, { anomalies });
    }
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('LR LOST RACE -- the order changes under the operator confirmation: the whole transaction rolls back');
  {
    const w = await world(env, { label: 'lostrace' });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#X0001', zona: 'Q1' });
    await startV2(w.c.svc, o, 'operator_primary', w.scope);
    const t1 = await w.c.client('ded-x1');
    const t2 = await w.c.client('ded-x2');
    await t1.query('BEGIN');
    await t1.query("UPDATE public.ordenes SET estado = 'CANCELADO' WHERE id = '#X0001'");
    const p = opConfirm(t2, o.id, null).catch((e) => ({ threw: e.code, msg: e.message }));
    const wait = await lockWait(w.c.su, 'ded-x2');
    await t1.query('COMMIT');
    const r = await p;
    assert('LR: the confirmation was stuck on the order row, then finds it CANCELADO and aborts with the typed lost-race error (40001), never a silent success',
      !!wait && r.threw === '40001' && /OPERATOR_DELIVERY_LOST_RACE/.test(r.msg || ''), { wait, r });
    assert('LR: nothing was written: no audit row, no event, order stays CANCELADO', (await logsFor(w.c, o.id)).length === 0 && (await ledger(w.c, o.id)).events === 0 && (await orderEstado(w.c, o.id)) === 'CANCELADO');
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  section('S1 STRESS -- randomized concurrent close / dispatch / operator confirm: never a deadlock, never a NEW trip on a closed service');
  {
    let deadlocks = 0; let newTripOnClosed = 0; let inconsistent = 0; let closedThenTrip = 0; let both = 0;
    const N = 12;
    for (let i = 0; i < N; i++) {
      const w = await world(env, { label: `stress-${i}`, date: `2026-10-${String(1 + i).padStart(2, '0')}` });
      const a = await w.mk({ estado: 'LISTO', totale: 11, zona: 'Q1' });
      const corr = await seedCloseable(w.c, w.s);
      const cs = await Promise.all([0, 1, 2].map((k) => w.c.client(`ded-s1-${i}-${k}`)));
      const tasks = {
        close: () => closeV3(cs[0], w.s, corr),
        start: () => startV2(cs[1], a, 'rider', w.scope),
        confirm: () => opConfirm(cs[2], a.id, null),
      };
      const names = Object.keys(tasks).sort(() => Math.random() - 0.5);
      const res = {};
      await Promise.all(names.map((n) => delay(rnd(8)).then(tasks[n]).then((r) => { res[n] = r; }).catch((e) => { res[n] = { threw: e.code || e.message }; })));
      if (Object.values(res).some((x) => x && x.threw === '40P01')) deadlocks++;
      const s = await snap(w.c, w.s);
      const trips = await tripStatus(w.c);
      if (trips.length > 1 || (trips.length === 1 && trips[0].service_session_id !== w.s)) inconsistent++;
      if (res.start && res.start.code === 'SERVICE_NOT_OPEN' && trips.length !== 0) newTripOnClosed++;
      if (res.start && res.start.ok === true && trips.length !== 1) inconsistent++;
      if (s.svc === 'closed' && res.close && res.close.ok !== true) inconsistent++;
      // the ONLY way to end with a trip on a closed service is that the dispatch won L0 first: then it must have succeeded
      if (s.svc === 'closed' && trips.length === 1 && !(res.start && res.start.ok === true)) closedThenTrip++;
      if (res.close && res.close.ok === true && res.start && res.start.ok === true) both++;
      await w.c.close();
    }
    assert(`S1: ${N} randomized races: 0 deadlock`, deadlocks === 0, { deadlocks });
    assert('S1: 0 inconsistent trip states (at most one trip, attributed to the service it departed from, iff the dispatch succeeded)', inconsistent === 0, { inconsistent });
    assert('S1: 0 trips exist after the dispatch was answered SERVICE_NOT_OPEN (no NEW trip on a closed service)', newTripOnClosed === 0, { newTripOnClosed });
    assert('S1: 0 trips on a closed service that the dispatch did not create itself', closedThenTrip === 0, { closedThenTrip });
    assert('S1: (info) races where the dispatch won L0 and the close still succeeded afterwards are allowed and were reached or not', both >= 0, { both });
  }
}

// The plumbing is shared with the B2 receipt-contract group (b2OffServiceReceipt.js): one definition of "a world", "a
// dispatched order", "the ledger of an order", "the standalone Cash V1 call", so the two groups can never disagree.
module.exports = {
  run,
  helpers: { delay, hex64, PAY, world, seedCloseable, closeV3, startV2, opConfirm, riderStop, closeTrip, economyReaders, openService, wsOf,
    cashPay, cashPayOrThrow, cashPayDirect, orderIdentity, fingerprint, changedTables, ledger, snap, tripStatus, orderEstado, logsFor, dispatched },
};
