'use strict';
// ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) certification.
//
// THE INVARIANT under test (F-1 of ACTIVE_TRIP_SERVICE_CLOSE_GUARD_OPUS_REVIEW_2026-09-19.md):
//   NEVER  service = 'closed'  AND  a trip ACTIVE attributed to that service.
//
// Every scenario calls the REAL close_service_session_v3 (ledger-132 body, + 138 on the POST
// template) and the REAL start_rider_trip_v2 (ledger-137 body, + 138) on real PostgreSQL, with real
// concurrent connections. Interleavings are forced, not simulated: one transaction is held open
// while the other is started, and the harness proves WHICH lock the waiting transaction is stuck
// on by reading pg_locks (advisory key of the dispatch lock L0 vs the lifecycle lock).
//
//   PRE-138 template  : the same interleavings reproduce F-1 (both harmful states).
//   POST-138 template : the same interleavings are impossible; exactly one side wins, the other is
//                       refused with a typed code.
//
// Then the regression matrix (A..H, J, K) at the database boundary, the fail-closed paths, the
// idempotency/precedence of every pre-existing close outcome, the intent sweep (still runs with L0
// now taken early) and a randomized concurrent stress that must never deadlock nor break the
// invariant. Nothing here touches staging or production.
const crypto = require('crypto');
const rt = require('../pgRuntime');
const { section, assert, call, fixture, intentInput } = require('../lib');
const { ensureCaptureTrigger } = require('./_ctx');

const META = JSON.stringify({});
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);

// ── plumbing ─────────────────────────────────────────────────────────────────────────────
async function openDb(env, cloneFn, label) {
  const db = await cloneFn(label);
  const su = await rt.connect(env.cl, db, { name: `atc-su-${label}` });
  const svc = await rt.connect(env.cl, db, { role: 'service_role', name: `atc-svc-${label}` });
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

async function makeActor(su, actor, role) {
  await su.query(
    `INSERT INTO public.auth_actors (actor, role, session_version, active, workspace_id)
     VALUES ($1, $2, 1, true, gen_random_uuid())
     ON CONFLICT (actor) DO UPDATE SET role = EXCLUDED.role, active = true, session_version = 1`, [actor, role]);
}

async function world(env, { pre = false, label, date = '2026-09-19' }) {
  const c = await openDb(env, pre ? env.clonePre : env.clone, label);
  const s = await c.fx.day(date);                       // an OPEN service
  await makeActor(c.su, 'op-1', 'operator');
  await makeActor(c.su, 'rider-1', 'rider');
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

const closeV3 = (client, s, corr) => call(client, 'close_service_session_v3', [s, corr, 'op-1', 'operator_finalizar_v3']);
const startV2 = (client, anchor, actor, scope) => call(client, 'start_rider_trip_v2', [anchor.order_uid, actor, 1, scope]);
const collect = (client, orderId, actor, idem) => call(client, 'rider_collect_and_complete_stop',
  [orderId, '', actor, 1, 'iphash', META, idem]);

async function snap(c, s) {
  const r = await c.su.query(`
    SELECT (SELECT status FROM public.service_sessions WHERE id = $1) AS svc,
           (SELECT count(*)::int FROM trip_authority.trips WHERE status = 'ACTIVE' AND service_session_id = $1) AS active_trips,
           (SELECT count(*)::int FROM trip_authority.trips) AS trips,
           (SELECT current_session_id FROM public.service_session_state WHERE singleton) AS pointer,
           (SELECT count(*)::int FROM public.service_session_audit WHERE service_session_id = $1 AND event_type = 'closed') AS closed_audit`, [s]);
  return r.rows[0];
}
// THE forbidden state: any service that is CLOSED while a trip attributed to it is ACTIVE.
async function harmful(c) {
  return (await c.su.query(`
    SELECT count(*)::int AS n FROM trip_authority.trips t JOIN public.service_sessions ss ON ss.id = t.service_session_id
     WHERE t.status = 'ACTIVE' AND ss.status = 'closed'`)).rows[0].n;
}
const orderEstado = async (c, id) => (await c.su.query('SELECT estado FROM public.ordenes WHERE id = $1', [id])).rows[0].estado;

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

// Blocks until the connection named `app` is inside pg_sleep (used with the harness-only slow-close trigger).
async function waitSleeping(su, app, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query("SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'PgSleep'", [app]);
    if (r.rows.length) return true;
    await delay(10);
  }
  return false;
}

// Harness-only stand-in for the live trigger service_sessions_closed_live_work_guard: it runs INSIDE the
// close, AFTER the session row lock and BEFORE the intent sweep, and makes that window wide and deterministic.
async function installSlowCloseTrigger(su, ms = 350) {
  await su.query(`
    CREATE FUNCTION public.atc_slow_close() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN IF NEW.status = 'closed' THEN PERFORM pg_sleep(${ms / 1000}); END IF; RETURN NEW; END $f$;
    CREATE TRIGGER atc_slow_close BEFORE UPDATE OF status ON public.service_sessions
      FOR EACH ROW EXECUTE FUNCTION public.atc_slow_close();`);
}

// ── forced interleavings (the SAME code drives the PRE and the POST template) ─────────────
// CLOSE FIRST: T1 = the close is executed and HELD OPEN (uncommitted); T2 = a dispatch that resolved
// its scope [S] earlier starts now. T2's outcome is read after T1 commits.
async function raceCloseFirst(env, w, anchor, corr) {
  const t1 = await w.c.client('atc-closer');
  const t2 = await w.c.client('atc-dispatcher');
  await t1.query('BEGIN');
  const closeRes = await closeV3(t1, w.s, corr);
  const closerHeld = await heldAdvisory(w.c.su, 'atc-closer');
  const startP = startV2(t2, anchor, 'rider-1', w.scope).catch((e) => ({ threw: e.code || e.message }));
  const wait = await lockWait(w.c.su, 'atc-dispatcher');
  await t1.query('COMMIT');
  const startRes = await startP;
  return { closeRes, startRes, wait, closerHeld };
}
// TRIP FIRST: T1 = the dispatch is executed and HELD OPEN; T2 = the close (its JS preflight already
// saw no trip) starts now. T2's outcome is read after T1 commits.
async function raceTripFirst(env, w, anchor, corr) {
  const t1 = await w.c.client('atc-dispatcher');
  const t2 = await w.c.client('atc-closer');
  await t1.query('BEGIN');
  const startRes = await startV2(t1, anchor, 'rider-1', w.scope);
  const closeP = closeV3(t2, w.s, corr).catch((e) => ({ threw: e.code || e.message }));
  const wait = await lockWait(w.c.su, 'atc-closer');
  await t1.query('COMMIT');
  const closeRes = await closeP;
  return { startRes, closeRes, wait };
}

async function run(env) {
  const KEY_L0 = await advisoryKey(env.admin, 'LA_DIECI_DRIVER_STATO');
  const KEY_LC = await advisoryKey(env.admin, 'service_session_lifecycle');
  assert('setup: the two advisory keys are distinct', KEY_L0 !== KEY_LC, { KEY_L0, KEY_LC });

  // ══ 1. PRE-138: F-1 reproduced ═══════════════════════════════════════════════════════════
  section('F-1 REPRODUCTION (PRE-138): interleaving A -- trip commits first, the close then succeeds');
  {
    const w = await world(env, { pre: true, label: 'preA' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      const corr = await seedCloseable(w.c, w.s);
      const r = await raceTripFirst(env, w, A, corr);
      assert('PRE A: the dispatch succeeded (trip ACTIVE, order EN_ENTREGA)', r.startRes.ok === true && r.startRes.code === 'OK', r.startRes);
      assert('PRE A: the close waited on a ROW lock, NOT on a shared advisory lock (the two RPCs shared no exclusion)',
        !!r.wait && r.wait.waiting_advisory === null && ['transactionid', 'tuple'].includes(r.wait.waiting_locktype), r.wait);
      assert('PRE A: the close then SUCCEEDED (V3_CLOSED) although a trip is ACTIVE for that service', r.closeRes.ok === true && r.closeRes.code === 'V3_CLOSED', r.closeRes);
      const st = await snap(w.c, w.s);
      assert('PRE A: RESULT = service CLOSED + trip ACTIVE (the forbidden state F-1 exists)', st.svc === 'closed' && st.active_trips === 1 && (await harmful(w.c)) === 1, st);
      const s2 = await w.c.fx.day('2026-09-20');
      const B = await w.c.fx.order(w.c.svc, { session: s2, estado: 'LISTO' });
      const later = await startV2(w.c.svc, B, 'rider-1', [s2]);
      assert('PRE A: consequence -- every later departure is blocked globally with ACTIVE_TRIP_CONFLICT (the stranded trip has no recovery in the app)',
        later.ok === false && later.code === 'ACTIVE_TRIP_CONFLICT', later);
    } finally { await w.c.close(); }
  }
  section('F-1 REPRODUCTION (PRE-138): interleaving B -- close commits first, the dispatch (stale scope) then succeeds');
  {
    const w = await world(env, { pre: true, label: 'preB' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      const corr = await seedCloseable(w.c, w.s);
      const r = await raceCloseFirst(env, w, A, corr);
      assert('PRE B: the close committed', r.closeRes.ok === true && r.closeRes.code === 'V3_CLOSED', r.closeRes);
      assert('PRE B: the close held the lifecycle lock but NOT L0 (nothing shared with the dispatch path)', r.closerHeld.includes(KEY_LC) && !r.closerHeld.includes(KEY_L0), { held: r.closerHeld });
      assert('PRE B: the dispatch waited on a ROW lock (FK key-share vs the close\'s row lock), NOT on a shared advisory lock',
        !!r.wait && r.wait.waiting_advisory === null && ['transactionid', 'tuple'].includes(r.wait.waiting_locktype), r.wait);
      assert('PRE B: the dispatch then SUCCEEDED on a service that is already CLOSED', r.startRes.ok === true && r.startRes.code === 'OK', r.startRes);
      const st = await snap(w.c, w.s);
      assert('PRE B: RESULT = trip ACTIVE on a CLOSED service (the forbidden state F-1 exists)', st.svc === 'closed' && st.active_trips === 1 && (await harmful(w.c)) === 1, st);
    } finally { await w.c.close(); }
  }

  // ══ 2. POST-138: the same interleavings are impossible ═══════════════════════════════════
  section('E/F RACE (POST-138): close-first -- the dispatch WAITS ON L0, then is refused SERVICE_NOT_OPEN');
  {
    const w = await world(env, { label: 'postE' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      const corr = await seedCloseable(w.c, w.s);
      const r = await raceCloseFirst(env, w, A, corr);
      assert('E: the close committed', r.closeRes.ok === true && r.closeRes.code === 'V3_CLOSED', r.closeRes);
      assert('E: the dispatch was stuck on the ADVISORY lock L0 (LA_DIECI_DRIVER_STATO) held by the close -- the two RPCs now share one exclusion',
        !!r.wait && r.wait.waiting_advisory === KEY_L0, { wait: r.wait, KEY_L0 });
      assert('E: while open, the close held BOTH the lifecycle lock and L0', r.closerHeld.includes(KEY_LC) && r.closerHeld.includes(KEY_L0), { held: r.closerHeld });
      assert('E: the dispatch is REFUSED with SERVICE_NOT_OPEN and reports status closed',
        r.startRes.ok === false && r.startRes.code === 'SERVICE_NOT_OPEN' && r.startRes.status === 'closed' && r.startRes.service_session_id === w.s, r.startRes);
      const st = await snap(w.c, w.s);
      assert('E: NO trip was created at all', st.trips === 0 && st.active_trips === 0, st);
      assert('E: the order was not moved (still LISTO) -- refusal is atomic', (await orderEstado(w.c, A.id)) === 'LISTO');
      assert('E: INVARIANT service CLOSED + trip ACTIVE never holds', (await harmful(w.c)) === 0);
    } finally { await w.c.close(); }
  }
  {
    const w = await world(env, { label: 'postF' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      const corr = await seedCloseable(w.c, w.s);
      const r = await raceTripFirst(env, w, A, corr);
      assert('F: the dispatch committed first (trip ACTIVE, order EN_ENTREGA)', r.startRes.ok === true && r.startRes.code === 'OK', r.startRes);
      assert('F: the close was stuck on the ADVISORY lock L0 (not on a row lock) and already HELD the lifecycle lock',
        !!r.wait && r.wait.waiting_advisory === KEY_L0 && r.wait.held_advisory.includes(KEY_LC), { wait: r.wait, KEY_L0, KEY_LC });
      assert('F: the close is REFUSED with V3_CLOSE_ACTIVE_RIDER_TRIP carrying the trip and the service',
        r.closeRes.ok === false && r.closeRes.code === 'V3_CLOSE_ACTIVE_RIDER_TRIP' && r.closeRes.service_session_id === w.s
        && r.closeRes.trip && r.closeRes.trip.trip_id === r.startRes.trip_id && r.closeRes.trip.anchor_order_uid === A.order_uid, r.closeRes);
      const st = await snap(w.c, w.s);
      assert('F: the service is still OPEN, the pointer untouched, no closed audit row', st.svc === 'open' && st.pointer === w.s && st.closed_audit === 0, st);
      assert('F: the trip is untouched (still ACTIVE) -- the refusal never mutates it', st.active_trips === 1);
      assert('F: INVARIANT service CLOSED + trip ACTIVE never holds', (await harmful(w.c)) === 0);
    } finally { await w.c.close(); }
  }

  // ══ 3. Regression matrix at the DB boundary ══════════════════════════════════════════════
  section('A. service OPEN, no trip -> close succeeds (behaviour unchanged)');
  {
    const w = await world(env, { label: 'mxA' });
    try {
      const corr = await seedCloseable(w.c, w.s);
      const r = await closeV3(w.c.svc, w.s, corr);
      const st = await snap(w.c, w.s);
      assert('A: V3_CLOSED, service closed, pointer cleared, one closed audit row',
        r.ok === true && r.code === 'V3_CLOSED' && st.svc === 'closed' && st.pointer === null && st.closed_audit === 1, { r, st });
    } finally { await w.c.close(); }
  }
  section('B/H/K. service OPEN, trip ACTIVE -> close REFUSED by the DATABASE (JS preflight bypassed); rider_actor NULL still blocks');
  for (const role of ['rider', 'operator', 'admin']) {
    const w = await world(env, { label: `mxB_${role}` });
    try {
      await makeActor(w.c.su, `${role}-x`, role);
      const A = await w.mk({ estado: 'LISTO' });
      const corr = await seedCloseable(w.c, w.s);
      const dep = await startV2(w.c.svc, A, `${role}-x`, w.scope);
      assert(`B setup (${role}): departure OK`, dep.ok === true, dep);
      const row = (await w.c.su.query('SELECT rider_actor, dispatched_by FROM trip_authority.trips WHERE trip_id = $1', [dep.trip_id])).rows[0];
      if (role === 'rider') assert('B setup (rider): rider_actor is the rider', row.rider_actor === 'rider-x', row);
      else assert(`H (${role}-dispatched): rider_actor IS NULL -- and the trip still blocks the close`, row.rider_actor === null, row);
      // The RPC is called DIRECTLY: no backend preflight, no engine -- exactly a JS check that lost / skipped the race.
      const r = await closeV3(w.c.svc, w.s, corr);
      assert(`B/K (${role}): the close RPC itself refuses V3_CLOSE_ACTIVE_RIDER_TRIP`, r.ok === false && r.code === 'V3_CLOSE_ACTIVE_RIDER_TRIP', r);
      const st = await snap(w.c, w.s);
      assert(`B (${role}): service still open, trip still ACTIVE, nothing closed`, st.svc === 'open' && st.active_trips === 1 && st.closed_audit === 0 && st.pointer === w.s, st);
    } finally { await w.c.close(); }
  }
  section('C/D. start trip: service CLOSED / closing / rolled_over -> refused SERVICE_NOT_OPEN; service OPEN -> succeeds');
  {
    const w = await world(env, { label: 'mxD' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      const r = await startV2(w.c.svc, A, 'rider-1', w.scope);
      assert('D: service OPEN -> the departure succeeds (OK)', r.ok === true && r.code === 'OK', r);
      assert('D: order moved to EN_ENTREGA', (await orderEstado(w.c, A.id)) === 'EN_ENTREGA');
    } finally { await w.c.close(); }
  }
  for (const status of ['closed', 'closing', 'rolled_over']) {
    const w = await world(env, { label: `mxC_${status}` });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      await w.c.su.query('UPDATE public.service_sessions SET status = $2 WHERE id = $1', [w.s, status]);
      const r = await startV2(w.c.svc, A, 'rider-1', w.scope);
      const st = await snap(w.c, w.s);
      assert(`C (${status}): departure refused SERVICE_NOT_OPEN, status echoed`, r.ok === false && r.code === 'SERVICE_NOT_OPEN' && r.status === status && r.service_session_id === w.s, r);
      assert(`C (${status}): no trip row, order untouched (LISTO)`, st.trips === 0 && (await orderEstado(w.c, A.id)) === 'LISTO', st);
    } finally { await w.c.close(); }
  }
  section('C2. multi-order giro on an OPEN service still departs atomically (no behaviour change for the normal path)');
  {
    const w = await world(env, { label: 'mxC2' });
    try {
      const A = await w.mk({ estado: 'LISTO', zona: 'Z1' });
      const B = await w.mk({ estado: 'LISTO', zona: 'Z1' });
      const g = await call(w.c.svc, 'giro_authority_create_or_move_v1', [[A.order_uid, B.order_uid], null, null, 'op-1', w.scope]);
      assert('C2 setup: canonical giro of two orders created', !!g && (g.ok === true || !!g.giro_id), g);
      const r = await startV2(w.c.svc, A, 'rider-1', w.scope);
      assert('C2: both members depart in ONE trip', r.ok === true && Array.isArray(r.order_uids) && r.order_uids.length === 2, r);
    } finally { await w.c.close(); }
  }

  section('G. an ACTIVE trip of ANOTHER service does not block the target (attribution is by service)');
  {
    const w = await world(env, { label: 'mxG', date: '2026-09-19' });
    try {
      // Another (already closed) service, with the legacy-harm shape: a trip ACTIVE on it.
      const old = await w.c.fx.day('2026-09-18', 'closed');
      const oldOrder = await w.c.fx.order(w.c.svc, { session: old, estado: 'RETIRADO' });
      await w.c.su.query('SET ROLE postgres');
      await w.c.su.query(`INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, departed_at, status, seq)
        VALUES (gen_random_uuid(), '2026-09-18', $1, NULL, 'op-1', $2, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'))`, [old, oldOrder.order_uid]);
      await w.c.su.query('RESET ROLE');
      const corr = await seedCloseable(w.c, w.s);
      const proj = (await w.c.su.query('SELECT public.trip_projection_v1($1::uuid[]) AS p', [[w.s]])).rows[0].p;
      assert('G setup: the projection scoped to the target service sees NO trip', proj.ok === true && proj.active === false, proj);
      const r = await closeV3(w.c.svc, w.s, corr);
      assert('G: the target service closes (the other service\'s ACTIVE trip is not attributed to it)', r.ok === true && r.code === 'V3_CLOSED', r);
    } finally { await w.c.close(); }
  }

  section('J. trip completed by the rider (Entregado) and closed (Driver volvio) -> the close then succeeds; R1 semantics untouched');
  {
    const w = await world(env, { label: 'mxJ' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      const corr = await seedCloseable(w.c, w.s);
      await startV2(w.c.svc, A, 'op-1', w.scope);
      const early = await closeV3(w.c.svc, w.s, corr);
      assert('J: with the trip ACTIVE the close is refused', early.code === 'V3_CLOSE_ACTIVE_RIDER_TRIP', early);
      const dv = await call(w.c.svc, 'close_rider_trip', [null]);
      assert('R1: "Driver volvio" (close_rider_trip) does NOT close the trip while the order is still EN_ENTREGA (EARLY_CLOSE) -- not Entregado, not paid, no force completion',
        dv.ok === false && ['EARLY_CLOSE', 'MISSING_TRIP_MEMBER'].includes(dv.code), dv);
      const stillBlocked = await closeV3(w.c.svc, w.s, corr);
      assert('R1: the order is still EN_ENTREGA and the service still blocked',
        (await orderEstado(w.c, A.id)) === 'EN_ENTREGA' && stillBlocked.code === 'V3_CLOSE_ACTIVE_RIDER_TRIP', stillBlocked);
      const col = await collect(w.c.svc, A.id, 'rider-1', 'j-flow');
      assert('J: the REAL rider declares Entregado (rider_collect_and_complete_stop)', col.ok === true && col.code === 'OK', col);
      const dv2 = await call(w.c.svc, 'close_rider_trip', [null]);
      assert('J: "Driver volvio" now closes the trip', dv2.ok === true && dv2.code === 'OK', dv2);
      const r = await closeV3(w.c.svc, w.s, corr);
      assert('J: the service now closes (V3_CLOSED)', r.ok === true && r.code === 'V3_CLOSED', r);
      assert('J: INVARIANT holds', (await harmful(w.c)) === 0);
    } finally { await w.c.close(); }
  }

  // ══ 4. pre-existing outcomes are unchanged (the new refusal is the LAST check) ═══════════
  section('Pre-existing close outcomes: idempotency and precedence are unchanged');
  {
    const w = await world(env, { label: 'prec' });
    try {
      const A = await w.mk({ estado: 'LISTO' });
      await startV2(w.c.svc, A, 'rider-1', w.scope); // ACTIVE trip on the open service
      const corr = crypto.randomUUID();
      // no closeout row: an earlier, pre-existing refusal wins over the new one
      await w.c.su.query('UPDATE public.service_session_state SET current_session_id = $1 WHERE singleton', [w.s]);
      let r = await closeV3(w.c.svc, w.s, corr);
      assert('precedence: CLOSEOUT_NOT_FOUND still wins over the new refusal', r.code === 'CLOSEOUT_NOT_FOUND', r);
      await w.c.su.query('INSERT INTO public.service_closeouts (service_session_id, closeout_correlation_id) VALUES ($1,$2)', [w.s, corr]);
      r = await closeV3(w.c.svc, w.s, corr);
      assert('precedence: ATTEMPT_NOT_ACTIVE still wins over the new refusal', r.code === 'ATTEMPT_NOT_ACTIVE', r);
      await w.c.su.query('UPDATE public.service_session_state SET current_session_id = NULL WHERE singleton');
      r = await closeV3(w.c.svc, w.s, corr);
      assert('precedence: CURRENT_SESSION_MISMATCH still wins over the new refusal', r.code === 'CURRENT_SESSION_MISMATCH', r);
      r = await call(w.c.svc, 'close_service_session_v3', [null, corr, 'op-1', 'x']);
      assert('validation: INVALID_ARGUMENTS unchanged', r.code === 'INVALID_ARGUMENTS', r);
      r = await call(w.c.svc, 'close_service_session_v3', [crypto.randomUUID(), corr, 'op-1', 'x']);
      assert('SERVICE_SESSION_NOT_FOUND unchanged', r.code === 'SERVICE_SESSION_NOT_FOUND', r);
    } finally { await w.c.close(); }
  }
  {
    // ALREADY_CLOSED is an idempotent success and never re-judged -- even for the legacy-harm state
    // (a closed service that still has an ACTIVE trip from before this migration).
    const w = await world(env, { label: 'idem' });
    try {
      const A = await w.mk({ estado: 'RETIRADO' });
      await w.c.su.query('SET ROLE postgres');
      await w.c.su.query(`INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, departed_at, status, seq)
        VALUES (gen_random_uuid(), '2026-09-19', $1, NULL, 'op-1', $2, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'))`, [w.s, A.order_uid]);
      await w.c.su.query('RESET ROLE');
      const corr = crypto.randomUUID();
      await w.c.su.query("UPDATE public.service_sessions SET status='closed', closed_at=now() WHERE id=$1", [w.s]);
      await w.c.su.query('UPDATE public.service_session_state SET current_session_id = NULL, recent_closed_session_id = $1 WHERE singleton', [w.s]);
      const r = await closeV3(w.c.svc, w.s, corr);
      assert('ALREADY_CLOSED: still an idempotent success (a closed service is never re-judged for trips)', r.ok === true && r.code === 'ALREADY_CLOSED' && r.idempotent === true, r);
    } finally { await w.c.close(); }
  }

  // ══ 5. fail closed when the projection cannot answer ═════════════════════════════════════
  section('Fail closed: an unreadable / malformed trip projection refuses the close and writes nothing');
  const bad = {
    'ok:false': "SELECT jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE')",
    'NULL': 'SELECT NULL::jsonb',
    'active not boolean': "SELECT jsonb_build_object('ok', true, 'active', 'yes')",
    'no ok': "SELECT jsonb_build_object('active', false)",
  };
  for (const [label, body] of Object.entries(bad)) {
    const w = await world(env, { label: `fc_${label.replace(/\W+/g, '_')}` });
    try {
      const corr = await seedCloseable(w.c, w.s);
      await w.c.su.query('SET ROLE postgres');
      await w.c.su.query(`CREATE OR REPLACE FUNCTION public.trip_projection_v1(p_operational_session_ids uuid[]) RETURNS jsonb
        LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ ${body} $$`);
      await w.c.su.query('RESET ROLE');
      const r = await closeV3(w.c.svc, w.s, corr);
      const st = await snap(w.c, w.s);
      assert(`fail-closed (${label}): V3_CLOSE_RIDER_TRIP_UNVERIFIABLE, never "no trip"`, r.ok === false && r.code === 'V3_CLOSE_RIDER_TRIP_UNVERIFIABLE', r);
      assert(`fail-closed (${label}): nothing was written (service open, pointer intact, no audit row)`, st.svc === 'open' && st.pointer === w.s && st.closed_audit === 0, st);
    } finally { await w.c.close(); }
  }

  // ══ 6. the intent sweep is preserved (and its pre-existing privilege limitation is unchanged) ═
  // Finding (pre-existing, NOT changed by 138): close_service_session_v3 is SECURITY INVOKER and the caller
  // of record is service_role, which has no USAGE on schema giro_authority; the sweep's SELECT is denied and
  // swallowed by its own EXCEPTION block, so for service_role the sweep is a silent no-op. Staging holds 0 intents.
  section('Intent sweep: identical behaviour PRE and POST-138 (service_role: silent no-op; a role with USAGE: intent EXPIRED)');
  for (const pre of [true, false]) {
    const tag = pre ? 'PRE' : 'POST';
    for (const role of ['service_role', 'postgres']) {
      const w = await world(env, { pre, label: `sweep_${tag}_${role}` });
      try {
        await ensureCaptureTrigger(w.c.su);
        const anchor = await w.mk({ estado: 'EN_COCINA', zona: 'S1' });
        const pending = await w.mk({ estado: 'POR_CONFIRMAR', zona: 'S2', intent: intentInput('ANCHOR', anchor.id) });
        const before = await w.c.fx.intent(pending.order_uid);
        assert(`${tag}/${role}: sweep setup -- the intent is PENDING`, !!before && before.status === 'PENDING', before);
        if (role === 'service_role') {
          const denied = await w.c.svc.query('SELECT 1 FROM giro_authority.giro_intents LIMIT 1').then(() => null, (e) => e.code);
          assert(`${tag}/service_role: cannot read giro_authority (SQLSTATE 42501) -- the sweep's own SELECT is denied and swallowed`, denied === '42501', denied);
        }
        const corr = await seedCloseable(w.c, w.s);
        const closer = role === 'service_role' ? w.c.svc : await w.c.client('atc-sweep-closer', 'postgres');
        const r = await closeV3(closer, w.s, corr);
        assert(`${tag}/${role}: the close succeeds`, r.ok === true && r.code === 'V3_CLOSED', r);
        const after = await w.c.fx.intent(pending.order_uid);
        if (role === 'service_role') {
          assert(`${tag}/service_role: the intent is still PENDING (pre-existing no-op, byte-for-byte the same before and after 138)`, !!after && after.status === 'PENDING', after);
        } else {
          assert(`${tag}/postgres: the sweep ran inside the close and EXPIRED the intent (SERVICE_CLOSED)`,
            !!after && after.status === 'EXPIRED' && after.resolution_code === 'SERVICE_CLOSED', after);
        }
      } finally { await w.c.close(); }
    }
  }

  // ══ 7. the latent lock inversion of the sweep (PRE) is gone (POST) ═══════════════════════
  // Before 138 the close reached L0 only through its intent sweep, LATE -- after it already held the session
  // row lock that the trip INSERT's foreign key needs. A dispatch that holds L0 and waits for that row
  // is the ABBA partner. (For service_role the sweep is a no-op today -- see section 6 -- so this is a
  // LATENT inversion; the closer here is `postgres`, which has USAGE, to make it real.) The window is widened deterministically (harness-only trigger, inside the
  // close, after the row lock, before the sweep) so the collision is forced, not hoped for.
  section('Lock order: close (run by a role for which the sweep executes) vs a dispatch that already holds L0');
  for (const pre of [true, false]) {
    const w = await world(env, { pre, label: pre ? 'abbaPre' : 'abbaPost' });
    try {
      await ensureCaptureTrigger(w.c.su);
      await installSlowCloseTrigger(w.c.su, 350);
      const anchor = await w.mk({ estado: 'EN_COCINA', zona: 'A1' });
      await w.mk({ estado: 'POR_CONFIRMAR', zona: 'A2', intent: intentInput('ANCHOR', anchor.id) }); // PENDING => the sweep runs
      const A = await w.mk({ estado: 'LISTO', zona: 'A3' });
      const corr = await seedCloseable(w.c, w.s);
      const t1 = await w.c.client('atc-closer', 'postgres'); // a role with USAGE on giro_authority: the sweep really runs
      const t2 = await w.c.client('atc-dispatcher');
      const P = (p) => p.then((v) => ({ v }), (e) => ({ e: e.code || e.message }));
      const closeP = P(closeV3(t1, w.s, corr));
      const inSleep = await waitSleeping(w.c.su, 'atc-closer');
      const startP = P(startV2(t2, A, 'rider-1', w.scope));
      const wait = await lockWait(w.c.su, 'atc-dispatcher');
      const [cR, sR] = await Promise.all([closeP, startP]);
      const deadlocks = [cR, sR].filter((x) => x.e === '40P01').length;
      assert(`${pre ? 'PRE' : 'POST'}: the close was inside its terminal write (row lock held) when the dispatch started`, inSleep === true);
      if (pre) {
        assert('PRE: the dispatch waited on a ROW lock while holding L0 -- the ABBA partner of the close\'s late L0 (sweep)',
          !!wait && wait.waiting_advisory === null && wait.held_advisory.includes(KEY_L0), wait);
        assert('PRE: the latent inversion is REAL -- Postgres had to break the cycle (40P01 deadlock detected)', deadlocks === 1, { cR, sR });
      } else {
        assert('POST: the dispatch waited on the ADVISORY lock L0 (held by the close since before its first row lock)', !!wait && wait.waiting_advisory === KEY_L0, wait);
        assert('POST: no deadlock -- the close completed and the dispatch was refused SERVICE_NOT_OPEN',
          deadlocks === 0 && cR.v && cR.v.code === 'V3_CLOSED' && sR.v && sR.v.code === 'SERVICE_NOT_OPEN', { cR, sR });
        const intents = (await w.c.su.query("SELECT status FROM giro_authority.giro_intents WHERE status = 'PENDING'")).rows.length;
        assert('POST: the sweep still ran inside the close (no PENDING intent left)', intents === 0, { intents });
        assert('POST: INVARIANT holds', (await harmful(w.c)) === 0);
      }
    } finally { await w.c.close(); }
  }

  // ══ 8. randomized concurrent stress ═══════════════════════════════════════════════════════
  section('STRESS (POST-138): randomized concurrent close vs dispatch (+ a lifecycle-lock holder) -- never a deadlock, never the forbidden state');
  {
    const N = Number(process.env.ATC_STRESS_N || 30);
    const outcomes = {};
    let deadlocks = 0; let harmed = 0; let bothOk = 0; let unexpected = 0;
    for (let i = 0; i < N; i++) {
      const w = await world(env, { label: `stress${i}` });
      try {
        const A = await w.mk({ estado: 'LISTO' });
        const corr = await seedCloseable(w.c, w.s);
        const cc = await w.c.client('atc-s-close');
        const cd = await w.c.client('atc-s-start');
        const ch = await w.c.client('atc-s-holder');
        const P = (p) => p.then((v) => ({ v }), (e) => ({ e: e.code || e.message }));
        // a third actor that behaves like the lifecycle takers (open_operational_service / intake):
        // lifecycle lock, then the pointer row, held briefly.
        const holder = P((async () => {
          await delay(rnd(6));
          await ch.query('BEGIN');
          await ch.query("SELECT pg_advisory_xact_lock(hashtext('service_session_lifecycle'))");
          await ch.query('SELECT * FROM public.service_session_state WHERE singleton = true FOR UPDATE');
          await delay(rnd(8));
          await ch.query('COMMIT');
          return { ok: true };
        })());
        const [cR, sR] = await Promise.all([
          P((async () => { await delay(rnd(10)); return closeV3(cc, w.s, corr); })()),
          P((async () => { await delay(rnd(10)); return startV2(cd, A, 'rider-1', w.scope); })()),
        ]);
        const hR = await holder;
        const codes = `${cR.v ? cR.v.code : 'ERR:' + cR.e} | ${sR.v ? sR.v.code : 'ERR:' + sR.e}`;
        outcomes[codes] = (outcomes[codes] || 0) + 1;
        if ([cR, sR, hR].some((x) => x.e === '40P01')) deadlocks++;
        if (cR.e || sR.e || hR.e) unexpected++;
        if (cR.v && cR.v.ok === true && sR.v && sR.v.ok === true) bothOk++;
        if ((await harmful(w.c)) !== 0) harmed++;
      } finally { await w.c.close(); }
    }
    console.log('  stress outcome distribution (close | start):', JSON.stringify(outcomes));
    assert(`STRESS: ${N} iterations, zero deadlocks (40P01)`, deadlocks === 0, { deadlocks });
    assert(`STRESS: ${N} iterations, zero unexpected errors`, unexpected === 0, { unexpected, outcomes });
    assert(`STRESS: ${N} iterations, the close and the dispatch never BOTH succeed`, bothOk === 0, { bothOk });
    assert(`STRESS: ${N} iterations, the forbidden state (service CLOSED + trip ACTIVE) never occurs`, harmed === 0, { harmed });
    const kinds = Object.keys(outcomes);
    assert('STRESS: only the two legal outcomes occurred (close-won or trip-won)',
      kinds.every((k) => k === 'V3_CLOSED | SERVICE_NOT_OPEN' || k === 'V3_CLOSE_ACTIVE_RIDER_TRIP | OK'), outcomes);
  }
}

module.exports = { run };
