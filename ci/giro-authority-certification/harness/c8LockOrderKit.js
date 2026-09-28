'use strict';
// C8 LOCK-ORDER FIX (migrations 143 / 144) -- real-body concurrency kit. Ephemeral PostgreSQL only; never staging, never production.
//
// Builds the STAGING-SHAPED database the C8 real-body audit measured: the frozen fixture + the REAL ledger through 138 (md5-checked) + the REAL
// migrations 139 and 140 + the REAL function bodies of the intake / Mesa / lifecycle / economic graph (every body is taken from the repo
// migration text whose md5(prosrc) equals the value recorded on staging; four bodies that no migration reproduces come from the staging text) +
// the staging triggers (27 on the 14 graph tables). The migrations under test are then applied as FILES (never a re-typed body).
//
// Exports: buildPreTemplate, world, hold/release/settleOrBlock, pairRun, party specs (T1 intakes, T2 writers), stressMix, integrity/counts/extra.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rt = require('./pgRuntime');
const DED = require('./runDeliveryEconomyDecoupling');
const RL = require('./realLedger');
const { fixture } = require('./lib');

const FIX = path.join(__dirname, '..', 'fixture');
const readFix = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const M139 = 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql';
const M140 = 'migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql';
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const hex64 = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const rid = (p = 'r') => `${p}_${crypto.randomUUID().replace(/-/g, '')}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// the rider RPC of the post-140 chain needs the session proof the shared helper forwards
process.env.BRID_RIDER_SID_HASH = process.env.BRID_RIDER_SID_HASH || crypto.createHash('sha256').update('sid-rider-harness').digest('hex');
const H = require('./groups/deliveryEconomyDecoupling.js').helpers;

// ── real bodies ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const mac = new TextDecoder('macintosh');
const moji = (s) => mac.decode(Buffer.from(s, 'utf8'));
const strip = (b) => b.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
const VARIANTS = { raw: (b) => b, strip, moji, 'moji+strip': (b) => moji(strip(b)) };

// The complete CREATE statement of `name` from a repo migration whose body (after the recorded text variant) has the staging md5.
function realStatement(name, file, variant, wantMd5) {
  const sql = rt.readRepo(`migrations/${file}`);
  const re = new RegExp('CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.' + name + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(sql))) {
    const rest = sql.slice(m.index);
    const o = /AS\s+(\$[A-Za-z_]*\$)/.exec(rest);
    if (!o) continue;
    if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(rest.slice(10, o.index))) continue;
    const tag = o[1];
    const bs = m.index + o.index + o[0].length;
    const e = sql.indexOf(tag, bs);
    const head = sql.slice(m.index, m.index + o.index + o[0].length);
    const body = VARIANTS[variant](sql.slice(bs, e));
    if (md5(body) === wantMd5) return head.replace(/^CREATE FUNCTION/, 'CREATE OR REPLACE FUNCTION') + body + tag + ';';
  }
  throw new Error(`real statement not found: ${name} (${variant}) in ${file}`);
}

async function grantServiceRoleOnly(su, names) {
  await su.query(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (ARRAY[${names.map((n) => `'${n}'`).join(',')}])
    LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig); END LOOP; END $$;`);
}

// Builds the PRE-143 template (= staging + 139 + 140 + the audit's real bodies + the 27 staging triggers) under `name`.
async function buildPreTemplate(env, name) {
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, name);
  const report = { bodies: 0 };
  try {
    await DED.buildPre(su);                                        // chain through 138 + the REAL ledger (md5-checked by the frozen harness)
    await DED.applyRepoAsPostgres(su, M139);
    await DED.applyRepoAsPostgres(su, M140);
    await su.query('SET ROLE postgres');
    await su.query(readFix('c8_lock_order_substrate_v1.sql'));   // ends with RESET ROLE: every object below must be created AS postgres (the staging owner), so re-assume it
    await su.query('SET ROLE postgres');
    const spec = JSON.parse(readFix('c8_lock_order_real_bodies_v1.json')).bodies;
    for (const b of spec) { await su.query(realStatement(b.name, b.file, b.variant, b.md5)); report.bodies++; }
    await su.query(readFix('c8_lock_order_live_only_v1.sql.txt'));
    await grantServiceRoleOnly(su, [...spec.map((b) => b.name), 'order_canonical_obligation_v1', 'order_obligation_anchor_v1', 'order_obligation_apply_adjustment_v1', 'order_cancel_v1']);
    await su.query(readFix('c8_lock_order_triggers_v1.sql'));
    await su.query('SET ROLE postgres');
    await DED.addSingleActiveIndex(su);
    // faithful extras: the history table mesa_open_* writes, the two staging triggers the frozen fixture omits
    await su.query('SET ROLE postgres');
    await su.query(`CREATE TABLE IF NOT EXISTS public.table_session_assignment_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid, table_session_id uuid, previous_waiter_actor text, new_waiter_actor text,
      by_actor text, action text, created_at timestamptz DEFAULT now())`);
    const wai = readFix('c8_workspace_activation_integrity_body_v1.sql.txt').split('\n').slice(1).join('\n');
    if (!(await su.query(`SELECT to_regprocedure('public.workspace_activation_integrity()') IS NOT NULL AS x`)).rows[0].x) {
      await su.query(`CREATE FUNCTION public.workspace_activation_integrity() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $f$${wai}$f$`);
    }
    await su.query('DROP TRIGGER IF EXISTS workspace_activation_integrity_trg ON public.workspaces');
    await su.query('CREATE CONSTRAINT TRIGGER workspace_activation_integrity_trg AFTER INSERT OR UPDATE ON public.workspaces DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.workspace_activation_integrity()');
    report.giro_capture_fn = (await su.query(`SELECT to_regprocedure('giro_authority.capture_giro_intent_v1()') IS NOT NULL AS x`)).rows[0].x;
    if (report.giro_capture_fn) {
      await su.query('DROP TRIGGER IF EXISTS ordenes_zz_giro_intent_capture_v1 ON public.ordenes');
      await su.query('CREATE TRIGGER ordenes_zz_giro_intent_capture_v1 BEFORE INSERT ON public.ordenes FOR EACH ROW WHEN ((new.pending_giro_intent IS NOT NULL)) EXECUTE FUNCTION giro_authority.capture_giro_intent_v1()');
    }
    await su.query('RESET ROLE');
  } finally { await su.end(); }
  return report;
}

// ── worlds ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const BD_SQL = `SELECT (CASE WHEN (public.order_intake_policy_v1(y.m) ->> 'businessDateIsPreviousDay')::boolean THEN x.l::date - 1 ELSE x.l::date END)::text AS d
                  FROM (SELECT (clock_timestamp() AT TIME ZONE 'Europe/Madrid') AS l) x, LATERAL (SELECT extract(hour FROM x.l)::int * 60 + extract(minute FROM x.l)::int AS m) y`;
async function clockGuard(su) {     // the business-day boundary (03:58-04:04 Madrid) is a second race the tests must not straddle
  for (let i = 0; i < 300; i++) {
    const m = (await su.query(`SELECT (extract(hour FROM now() AT TIME ZONE 'Europe/Madrid') * 60 + extract(minute FROM now() AT TIME ZONE 'Europe/Madrid'))::int AS m`)).rows[0].m;
    if (m < 238 || m > 244) return;
    await delay(2000);
  }
}

// A clone of `tpl` with an OPEN operational service A, the real actors, one workspace, the pointers coherent.
async function world(env, tpl, label, { deadlockMs = 200, noService = false, trip = false } = {}) {
  const db = await env.clone(tpl, label);
  await env.admin.query(`ALTER DATABASE "${db}" SET deadlock_timeout = '${deadlockMs}ms'`).catch(() => {});
  const su = await rt.connect(env.cl, db, { name: `c8-su-${label}` });
  const svc = await rt.connect(env.cl, db, { role: 'service_role', name: `c8-svc-${label}` });
  const extra = [];
  await clockGuard(su);
  await RL.seedActors(su);
  const bd = (await su.query(BD_SQL)).rows[0].d;
  await su.query('INSERT INTO public.business_days (business_date) VALUES ($1) ON CONFLICT (business_date) DO NOTHING', [bd]);
  const A = (await su.query(`INSERT INTO public.service_sessions (business_date, status, business_day_id, lifecycle_semantics, service_kind)
      SELECT $1::date, 'open', id, 'operational_service_v1', NULL FROM public.business_days WHERE business_date = $1::date RETURNING id`, [bd])).rows[0].id;
  await su.query('UPDATE public.service_session_state SET current_session_id = $1 WHERE singleton', [A]);
  await su.query(`BEGIN; SELECT set_config('ladieci.business_day_pointer_authorized', 'true', true);
     UPDATE public.business_day_lifecycle_state SET current_business_day_id = (SELECT business_day_id FROM public.service_sessions WHERE id = '${A}'), current_period_id = '${A}',
       current_ticket_epoch = (SELECT ticket_epoch FROM public.business_days WHERE business_date = '${bd}') WHERE singleton = true; COMMIT`);
  const ws = (await su.query('SELECT id FROM public.workspaces ORDER BY name LIMIT 1')).rows[0].id;
  const w = { db, su, svc, A, bd, ws, env, label };
  w.client = async (name, role = 'service_role') => { const c = await rt.connect(env.cl, db, { role, name }); extra.push(c); return c; };
  w.close = async () => { for (const c of [...extra, svc, su]) await c.end().catch(() => {}); };
  if (noService) {                                                       // first-open worlds: historical orders exist, the service is closed, NO service open
    w.hist = await mkUnpaid(w, 10);
    w.histPaid = await mkPaid(w, 12);
    if (trip) {
      w.trip = await dispatchedOrder(w);                                 // a delivery with the rider still out (trip ACTIVE): closing is allowed since M139 with per-order incident evidence
      await w.su.query('INSERT INTO public.service_incidents (service_session_id, order_id) VALUES ($1, $2)', [w.A, w.trip.id]);
    }
    await w.su.query("UPDATE public.ordenes SET estado = 'RETIRADO' WHERE id = ANY($1)", [[w.hist.id, w.histPaid.id]]);
    const corr = await H.seedCloseable({ su: w.su }, w.A);
    const r = await H.closeV3(w.svc, w.A, corr);
    if (!(r && r.ok === true)) { await w.close(); throw new Error('noService setup: close failed ' + JSON.stringify(r)); }
  }
  return w;
}

// The application path of a NEW order: ONE INSERT into ordenes as service_role (what PostgREST does).
const INSERT_ORDER = `INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, totale, tipo_consegna, initial_payment_intent) -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name
                      VALUES ($1, $2, 'Q1', '21:00', '20:40', $3, 'DOMICILIO', $4::jsonb) RETURNING id, order_uid, service_session_id, service_order_number`;
const intent = (actor = 'operator_primary', method = 'efectivo') => JSON.stringify({ method, actor, sid_hash: hex64(`sid-${actor}`) });
let seq = 0;
const nextId = (p = '#C8') => `${p}${String(++seq).padStart(5, '0')}`;
const insertOrder = (client, { id = nextId(), estado = 'EN_COCINA', totale = 12.5, intentJson = null } = {}) => client.query(INSERT_ORDER, [id, estado, totale, intentJson]).then((r) => r.rows[0]);
const cashPay = (client, w, o, x = {}) => {
  const reqId = x.reqId || rid('cash');
  return client.query('SELECT public.order_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) AS r',
    [w.ws, x.actor || 'operator_backup', hex64('sid-b'), o.order_uid, x.method || 'efectivo', x.mode || 'full', x.amount ?? null, reqId, x.hash || hex64(`${o.order_uid}|${reqId}`),
      JSON.stringify({ source: 'servicio_dashboard' }), x.confirm === true]).then((r) => r.rows[0].r);
};

const mkUnpaid = (w, totale = 10, id) => insertOrder(w.svc, { id: id || nextId('#O'), totale });
async function mkPaid(w, totale = 10, method = 'efectivo') {
  const o = await insertOrder(w.svc, { id: nextId('#PD'), totale, intentJson: intent('operator_primary', method) });
  const tx = (await w.su.query(`SELECT t.id FROM public.payment_transactions t JOIN public.payment_allocations a ON a.payment_transaction_id = t.id WHERE a.order_uid = $1 AND t.kind = 'payment'`, [o.order_uid])).rows[0].id;
  return { ...o, tx };
}
let tableNo = 6;
async function mkTable(w, covers = 2) {
  tableNo++;
  await w.su.query(`INSERT INTO public.restaurant_tables (workspace_id, table_number, display_name, active) VALUES ($1, $2, 'T${tableNo}', true)`, [w.ws, tableNo]);
  const tid = (await w.su.query('SELECT id FROM public.restaurant_tables ORDER BY created_at DESC LIMIT 1')).rows[0].id;
  return (await w.su.query(`INSERT INTO public.table_sessions (workspace_id, table_ref, status, service_session_id, covers_total, table_id) VALUES ($1, $2, 'open', $3, $4, $5) RETURNING id`, [w.ws, `T${tableNo}`, w.A, covers, tid])).rows[0].id;
}
async function mkTableOrder(w, table, totale = 10) {      // a Mesa comanda through the REAL BEFORE/AFTER INSERT chain
  const items = JSON.stringify([{ n: 'Pizza', q: 1, p: totale }]);
  return (await w.svc.query(`INSERT INTO public.ordenes (id, estado, totale, items, table_session_id) VALUES ($1, 'EN_COCINA', $2, $3::jsonb, $4) RETURNING id, order_uid, service_session_id`, [nextId('#MS'), totale, items, table])).rows[0];
}
const mkRestTable = async (w, n) => {
  await w.su.query(`INSERT INTO public.restaurant_tables (workspace_id, table_number, display_name, active) VALUES ($1, $2, 'R${n}', true)`, [w.ws, n]);
  return (await w.su.query('SELECT id FROM public.restaurant_tables WHERE table_number=$1 ORDER BY created_at DESC LIMIT 1', [n])).rows[0].id;
};
async function dispatchedOrder(w) {
  const wobj = { c: { su: w.su, svc: w.svc, fx: fixture(w.su), client: w.client }, s: w.A, scope: [w.A] };
  wobj.mk = (o = {}) => wobj.c.fx.order(w.svc, { session: w.A, ...o });
  const d = await H.dispatched(wobj, { id: nextId('#RS'), totale: 12.5 });
  if (d.st.ok !== true) throw new Error('dispatch failed ' + JSON.stringify(d.st));
  return d.o;
}
const closeTripQuiet = (w) => H.closeTrip(w.svc).catch(() => {});

// ── economic + state invariants ─────────────────────────────────────────────────────────────────────────────────────────────────
async function integrity(su) {
  const q = async (sql) => (await su.query(sql)).rows[0].n;
  const v = {};
  v.orders_without_entity = await q(`SELECT count(*)::int AS n FROM public.ordenes o WHERE NOT EXISTS (SELECT 1 FROM public.order_entities e WHERE e.order_uid = o.order_uid)`);
  v.orders_without_obligation = await q(`SELECT count(*)::int AS n FROM public.ordenes o WHERE NOT EXISTS (SELECT 1 FROM public.order_obligations b WHERE b.order_uid = o.order_uid)`);
  v.orders_with_intent_left = await q(`SELECT count(*)::int AS n FROM public.ordenes WHERE initial_payment_intent IS NOT NULL`);
  v.tx_without_allocation = await q(`SELECT count(*)::int AS n FROM public.payment_transactions t WHERE NOT EXISTS (SELECT 1 FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id)`);
  v.tx_without_event = await q(`SELECT count(*)::int AS n FROM public.payment_transactions t WHERE NOT EXISTS (SELECT 1 FROM public.order_financial_events e WHERE e.payment_transaction_id = t.id)`);
  v.tx_amount_mismatch = await q(`SELECT count(*)::int AS n FROM public.payment_transactions t WHERE t.amount IS DISTINCT FROM (SELECT sum(a.amount) FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id)
                                     OR t.amount IS DISTINCT FROM (SELECT sum(e.amount) FROM public.order_financial_events e WHERE e.payment_transaction_id = t.id)`);
  v.events_without_tx_non_legacy = await q(`SELECT count(*)::int AS n FROM public.order_financial_events e WHERE e.type IN ('payment','refund') AND e.payment_transaction_id IS NULL AND e.legacy IS NOT TRUE`);
  v.duplicate_full_payments = await q(`SELECT count(*)::int AS n FROM (SELECT order_id FROM public.order_financial_events WHERE type = 'payment' GROUP BY order_id HAVING count(*) > 1) x`);
  v.overcollected = await q(`SELECT count(*)::int AS n FROM public.ordenes o WHERE (SELECT COALESCE(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END),0) FROM public.order_financial_events e WHERE e.order_id = o.id)
                                > public.order_canonical_obligation_v1(o.order_uid)`);
  v.paid_mirror_without_event = await q(`SELECT count(*)::int AS n FROM public.ordenes o WHERE o.cobrado IS TRUE AND NOT EXISTS (SELECT 1 FROM public.order_financial_events e WHERE e.order_id = o.id)`);
  return { violations: Object.entries(v).filter(([, x]) => x > 0).map(([k, x]) => `${k}=${x}`), detail: v };
}
// state invariants of the lifecycle / numbering (the first-open, pointer, business-day and numbering guarantees)
async function stateInvariants(su) {
  const q = async (sql) => (await su.query(sql)).rows[0].n;
  const v = {};
  v.orders_live_on_closed_service = await q(`SELECT count(*)::int AS n FROM public.ordenes o JOIN public.service_sessions s ON s.id = o.service_session_id WHERE s.status = 'closed' AND upper(o.estado) IN ('POR_CONFIRMAR','NUEVO','EN_COCINA','LISTO')`);
  v.duplicate_order_numbers = await q(`SELECT count(*)::int AS n FROM (SELECT service_session_id, service_order_number FROM public.ordenes WHERE service_order_number IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1) x`);
  v.double_active_service = await q(`SELECT GREATEST(count(*) - 1, 0)::int AS n FROM public.service_sessions WHERE status IN ('open','closing')`);
  v.entity_business_day_mismatch = await q(`SELECT count(*)::int AS n FROM public.order_entities e JOIN public.service_sessions s ON s.id = e.service_session_id WHERE e.business_day_id IS DISTINCT FROM s.business_day_id`);
  v.pointer_mismatch = await q(`SELECT count(*)::int AS n FROM public.service_session_state st LEFT JOIN public.service_sessions s ON s.id = st.current_session_id WHERE st.current_session_id IS NOT NULL AND (s.id IS NULL OR s.status NOT IN ('open','closing'))`);
  v.lifecycle_pointer_mismatch = await q(`SELECT count(*)::int AS n FROM public.business_day_lifecycle_state l JOIN public.service_sessions s ON s.id = l.current_period_id WHERE l.current_business_day_id IS DISTINCT FROM s.business_day_id`);
  v.next_number_not_max_plus_one = (await su.query(`SELECT s.next_order_number AS next, COALESCE(max(o.service_order_number),0) AS mx FROM public.service_sessions s LEFT JOIN public.ordenes o ON o.service_session_id = s.id GROUP BY s.id, s.next_order_number`))
    .rows.filter((x) => Number(x.next) !== Number(x.mx) + 1).length;
  v.number_gaps = await q(`SELECT count(*)::int AS n FROM (SELECT service_session_id, count(*) AS c, max(service_order_number) AS mx FROM public.ordenes WHERE service_order_number IS NOT NULL GROUP BY 1) x WHERE x.c <> x.mx`);
  return { violations: Object.entries(v).filter(([, x]) => x > 0).map(([k, x]) => `${k}=${x}`), detail: v };
}
const counts = async (su) => (await su.query(`SELECT (SELECT count(*)::int FROM public.ordenes) AS orders, (SELECT count(*)::int FROM public.order_entities) AS entities, (SELECT count(*)::int FROM public.order_obligations) AS obligations,
    (SELECT count(*)::int FROM public.payment_transactions) AS pt, (SELECT count(*)::int FROM public.payment_allocations) AS pa, (SELECT count(*)::int FROM public.order_financial_events) AS ofe`)).rows[0];

// ── blocker objects, pause-point runner ──────────────────────────────────────────────────────────────────────────────────────────
const ADV = { L: 'service_session_lifecycle', L0: 'LA_DIECI_DRIVER_STATO' };
function objSql(o, w) {
  if (o.kind === 'adv') return { adv: ADV[o.k] };
  const m = o.mode || 'FOR UPDATE';
  const t = {
    W: `SELECT 1 FROM public.workspaces WHERE id = '${w.ws}' ${m}`,
    SS: `SELECT 1 FROM public.service_sessions WHERE id = '${o.id || w.A}' ${m}`,
    D: `SELECT 1 FROM public.business_days WHERE business_date = '${w.bd}' ${m}`,
    STATE: `SELECT 1 FROM public.service_session_state WHERE singleton ${m}`,
    LSTATE: `SELECT 1 FROM public.business_day_lifecycle_state WHERE singleton ${m}`,
    CFG: `SELECT 1 FROM public.config WHERE chiave = 'DRIVER_STATO' ${m}`,
    ACT: `SELECT 1 FROM public.auth_actors WHERE actor = '${o.actor}' ${m}`,
    TS: `SELECT 1 FROM public.table_sessions WHERE id = '${o.id}' ${m}`,
    ORD: `SELECT 1 FROM public.ordenes WHERE id = '${o.id}' ${m}`,
    ENT: `SELECT 1 FROM public.order_entities WHERE order_uid = '${o.uid}' ${m}`,
    PT: `SELECT 1 FROM public.payment_transactions WHERE id = '${o.id}' ${m}`,
    RT: `SELECT 1 FROM public.restaurant_tables WHERE id = '${o.id}' ${m}`,
  }[o.k];
  if (!t) throw new Error('unknown object ' + o.k);
  return { row: t };
}
async function hold(B, objs, w) {
  const advs = [], rows = [];
  for (const o of objs) { const s = objSql(o, w); if (s.adv) advs.push(s.adv); else rows.push(s.row); }
  for (const a of advs) await B.query('SELECT pg_advisory_lock(hashtext($1))', [a]);
  if (rows.length) { await B.query('BEGIN'); for (const r of rows) await B.query(r); }
  return { advs, rows: rows.length };
}
async function release(B, h) {
  if (h.rows) await B.query('ROLLBACK').catch(() => {});
  for (const a of h.advs) await B.query('SELECT pg_advisory_unlock(hashtext($1))', [a]).catch(() => {});
}
const oname = (o) => o.kind === 'adv' ? o.k : (o.k + (o.actor ? ':' + o.actor : '') + (o.id ? ':' + String(o.id).slice(0, 8) : '') + (o.mode ? '[' + o.mode.replace('FOR ', '') + ']' : ''));
const backendPid = async (c) => (await c.query('SELECT pg_backend_pid() AS p')).rows[0].p;
async function waitBlocked(su, app, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query(`SELECT a.pid, pg_blocking_pids(a.pid) AS blockers, a.query FROM pg_stat_activity a WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'`, [app]);
    if (r.rows.length) return r.rows[0];
    await delay(10);
  }
  return null;
}
// resolves to {done:true,value} when the promise settles within ms, or {done:false,blocked:row} if the backend waits on a lock
async function settleOrBlock(p, su, app, ms = 400) {
  let settled = null; p.then((v) => { settled = { value: v }; }, (e) => { settled = { value: { err: e.code || e.message } }; });
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (settled) return { done: true, value: settled.value };
    const b = await waitBlocked(su, app, 1).catch(() => null);
    if (b) return { done: false, blocked: b };
    await delay(5);
  }
  return settled ? { done: true, value: settled.value } : { done: false, blocked: null };
}
async function conns(w) {
  const c = { B: await w.client('c8-b'), T1: await w.client('c8-t1'), T2: await w.client('c8-t2') };
  c.pid = { b: await backendPid(c.B), t1: await backendPid(c.T1), t2: await backendPid(c.T2) };
  return c;
}
const asOutcome = (r) => (r && typeof r === 'object' && r.err) ? { err: r.err } : { ok: !(r && r.ok === false), v: r };
function start(party, conn) {              // party = { call, tx }
  if (!party.tx) return party.call(conn).then(asOutcome, (e) => ({ err: e.code || e.message, msg: String(e.message).slice(0, 90) }));
  return (async () => {
    await conn.query('BEGIN');
    try { const r = await party.call(conn); await conn.query('COMMIT'); return { ok: true, v: r }; }
    catch (e) { await conn.query('ROLLBACK').catch(() => {}); return { err: e.code || e.message, msg: String(e.message).slice(0, 90) }; }
  })();
}
// pause = { who:'t1'|'t2', objs:[obj] }: the blocker holds the objects; that party is started FIRST and must stall on them, then the other party runs free.
async function pairRun(w, cn, { t1, t2, pause, waitMs = 350, settleMs = 5000 }) {
  const first = pause.who, second = first === 't1' ? 't2' : 't1';
  const party = { t1, t2 }, conn = { t1: cn.T1, t2: cn.T2 }, app = { t1: 'c8-t1', t2: 'c8-t2' };
  const h = await hold(cn.B, pause.objs, w);
  const out = { pause: pause.objs.map(oname).join('+'), who: first };
  let p1, p2;
  try {
    p1 = start(party[first], conn[first]);
    const s1 = await settleOrBlock(p1, w.su, app[first], waitMs);
    out.first_state = s1.done ? 'completed_without_blocking' : (s1.blocked ? 'blocked' : 'running');
    if (s1.done) { out.result = { [first]: s1.value }; await release(cn.B, h); return out; }   // the paused party never requests the object: not in its lock set
    p2 = start(party[second], conn[second]);
    const s2 = await settleOrBlock(p2, w.su, app[second], waitMs);
    out.second_state = s2.done ? 'completed' : (s2.blocked ? 'blocked' : 'running');
    if (s2.blocked) { const b = s2.blocked.blockers || []; out.second_blocked_by = b.includes(cn.pid[first]) ? first : (b.includes(cn.pid.b) ? 'blocker' : 'other'); }
  } finally { await release(cn.B, h); }
  const r = await Promise.race([Promise.all([p1, p2]), delay(settleMs).then(() => 'TIMEOUT')]);
  if (r === 'TIMEOUT') { out.timeout = true; await cn.T1.query('ROLLBACK').catch(() => {}); await cn.T2.query('ROLLBACK').catch(() => {}); return out; }
  out.result = { [first]: r[0], [second]: r[1] };
  const t1r = out.result.t1, t2r = out.result.t2;
  out.deadlock = [t1r, t2r].some((x) => x && x.err === '40P01');
  out.victim = out.deadlock ? (t1r.err === '40P01' ? 't1' : 't2') : null;
  return out;
}

// ── parties: T1 = intake kinds (INSERT INTO ordenes as service_role), T2 = writers ────────────────────────────────────────────────
function worldObjs() {
  return [
    { name: 'L', kind: 'adv', k: 'L' }, { name: 'L0', kind: 'adv', k: 'L0' },
    { name: 'W', kind: 'row', k: 'W' }, { name: 'SS[A]', kind: 'row', k: 'SS' }, { name: 'D', kind: 'row', k: 'D' },
    { name: 'STATE', kind: 'row', k: 'STATE' }, { name: 'LSTATE', kind: 'row', k: 'LSTATE' }, { name: 'CFG', kind: 'row', k: 'CFG' },
    { name: 'ACT:rider', kind: 'row', k: 'ACT', actor: 'rider' }, { name: 'ACT:operator_primary', kind: 'row', k: 'ACT', actor: 'operator_primary' },
    { name: 'ACT:operator_backup', kind: 'row', k: 'ACT', actor: 'operator_backup' }, { name: 'ACT:owner', kind: 'row', k: 'ACT', actor: 'owner' },
  ];
}
const obj = (name, kind, extra) => ({ name, kind, ...extra });
const ORDc = (name, id) => obj(name, 'row', { k: 'ORD', id });
const ENTc = (name, uid) => obj(name, 'row', { k: 'ENT', uid });
const TSc = (name, id) => obj(name, 'row', { k: 'TS', id });
const PTc = (name, id) => obj(name, 'row', { k: 'PT', id });
const rpc = (sql, args) => (c) => c.query(sql, args).then((r) => r.rows[0].r);
const ITEMS = JSON.stringify([{ n: 'Pizza', q: 1, p: 7 }]);
const comanda = (t, intentJson) => (c) => c.query(`INSERT INTO public.ordenes (id, estado, totale, items, table_session_id, initial_payment_intent) VALUES ($1,'EN_COCINA',7,$2::jsonb,$3,$4::jsonb) RETURNING id, order_uid, service_session_id`,
  [nextId('#T1'), ITEMS, t, intentJson || null]).then((r) => r.rows[0]);
const PARTIES = {
  I_UNPAID: { name: 'I_UNPAID', tx: true, async prep() { return { objs: [], call: (c) => insertOrder(c, { id: nextId('#T1'), totale: 12.5 }) }; } },
  I_PAID: { name: 'I_PAID', tx: true, async prep() { return { objs: [], actor: 'operator_primary', call: (c) => insertOrder(c, { id: nextId('#T1'), totale: 12.5, intentJson: intent('operator_primary') }) }; } },
  I_PAID_SAME: { name: 'I_PAID_SAME', tx: true, async prep(w, other) { const a = (other && other.actor) || 'operator_backup';
    return { objs: [], actor: a, call: (c) => insertOrder(c, { id: nextId('#T1'), totale: 12.5, intentJson: intent(a) }) }; } },
  I_TABLE: { name: 'I_TABLE', tx: true, async prep(w, other) { const shared = other && other.table; const t = shared || await mkTable(w, 2);
    return { objs: shared ? [] : [TSc('TS:t1', t)], table: t, call: comanda(t) }; } },
  I_TABLE_PAID: { name: 'I_TABLE_PAID', tx: true, async prep(w, other) { const t = (other && other.table) || await mkTable(w, 2);   // must be refused: INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER
    return { objs: (other && other.table) ? [] : [TSc('TS:t1', t)], table: t, actor: 'operator_primary', call: comanda(t, intent('operator_primary')) }; } },
  I_FIRST: { name: 'I_FIRST', tx: true, needsNoService: true, async prep() { return { objs: [], call: (c) => insertOrder(c, { id: nextId('#T1'), totale: 12.5 }) }; } },
  I_FIRST_PAID: { name: 'I_FIRST_PAID', tx: true, needsNoService: true, async prep() { return { objs: [], actor: 'operator_primary', call: (c) => insertOrder(c, { id: nextId('#T1'), totale: 12.5, intentJson: intent('operator_primary') }) }; } },

  W_CASH: { name: 'W_CASH', tx: false, async prep(w) { const O = await mkUnpaid(w, 10); return { objs: [ORDc('ORD:o', O.id), ENTc('ENT:o', O.order_uid)], actor: 'operator_backup', call: (c) => cashPay(c, w, O) }; } },
  W_CASH_HIST: { name: 'W_CASH_HIST', tx: false, needsNoService: true, async prep(w) { const O = w.hist; return { objs: [ORDc('ORD:o', O.id), ENTc('ENT:o', O.order_uid)], actor: 'operator_backup', call: (c) => cashPay(c, w, O) }; } },
  W_MPAY: { name: 'W_MPAY', tx: false, async prep(w) { const t = await mkTable(w, 2); const o1 = await mkTableOrder(w, t, 10); const o2 = await mkTableOrder(w, t, 8);
    return { objs: [TSc('TS:t2', t), ORDc('ORD:o1', o1.id), ORDc('ORD:o2', o2.id)], table: t, actor: 'operator_backup',
      call: rpc('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', hex64('sid-m'), t, 'efectivo', 'full', rid('mp'), hex64(rid('mh')), null, null, null, '{}', false]) }; } },
  W_REFUND: { name: 'W_REFUND', tx: false, async prep(w) { const P = await mkPaid(w, 12); return { objs: [ORDc('ORD:p', P.id), PTc('PT:orig', P.tx)], actor: 'owner',
    call: rpc('SELECT public.order_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', hex64('so'), P.order_uid, P.tx, 'c8 refund', rid('rf'), hex64(rid('rh')), 3, '{}']) }; } },
  W_MREFUND: { name: 'W_MREFUND', tx: false, async prep(w) { const t = await mkTable(w, 2); await mkTableOrder(w, t, 10);
    await w.svc.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', hex64('sid-m'), t, 'efectivo', 'full', rid('mp'), hex64(rid('mh')), null, null, null, '{}', false]);
    const tx = (await w.su.query(`SELECT id FROM public.payment_transactions WHERE table_session_id = $1 AND kind='payment' ORDER BY created_at DESC LIMIT 1`, [t])).rows[0].id;
    return { objs: [TSc('TS:t2', t), PTc('PT:orig', tx)], table: t, actor: 'owner',
      call: rpc('SELECT public.mesa_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', hex64('so'), t, tx, 'c8 mesa refund', rid('mr'), hex64(rid('mrh')), 3, '{}']) }; } },
  W_ADJ: { name: 'W_ADJ', tx: false, async prep(w) { const O = await mkUnpaid(w, 10); return { objs: [ORDc('ORD:o', O.id)], actor: 'owner',
    call: rpc('SELECT public.order_apply_commercial_adjustment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', hex64('so'), O.order_uid, 8, 'c8 adjust', rid('adj'), hex64(rid('ah')), 10, '{}']) }; } },
  W_CANCEL: { name: 'W_CANCEL', tx: false, async prep(w) { const O = await mkUnpaid(w, 10); return { objs: [ORDc('ORD:o', O.id)], actor: 'operator_backup',
    call: rpc('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_backup', 'c8 cancel', rid('cx'), hex64(rid('h')), 'CANCELADO', '{}']) }; } },
  W_CANCEL_TABLE: { name: 'W_CANCEL_TABLE', tx: false, async prep(w) { const t = await mkTable(w, 2); const O = await mkTableOrder(w, t, 10);
    return { objs: [TSc('TS:t2', t), ORDc('ORD:o', O.id)], table: t, actor: 'operator_backup',
      call: rpc('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_backup', 'c8 cancel', rid('cx'), hex64(rid('h')), 'CANCELADO', '{}']) }; } },
  W_CANCEL_TABLE_B: { name: 'W_CANCEL_TABLE_B', tx: false, async prep(w, other) { const t = (other && other.table) || await mkTable(w, 2); const O = await mkTableOrder(w, t, 10);   // a DIFFERENT actor than mesa_open_*'s operator_backup, on the table the other party uses
    return { objs: [ORDc('ORD:o', O.id)].concat((other && other.table) ? [] : [TSc('TS:t2', t)]), table: t, actor: 'operator_primary',
      call: rpc('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_primary', 'c8 cancel', rid('cx'), hex64(rid('h')), 'CANCELADO', '{}']) }; } },
  W_RIDER: { name: 'W_RIDER', tx: false, fresh: true, cleanup: closeTripQuiet, async prep(w) { await closeTripQuiet(w); const O = await dispatchedOrder(w);
    return { objs: [ORDc('ORD:o', O.id), ENTc('ENT:o', O.order_uid)], actor: 'rider', call: (c) => H.riderStop(c, O.id, 'efectivo', `pay-order-${String(O.id).replace(/[^A-Za-z0-9_-]/g, '')}`) }; } },
  W_OPCONF: { name: 'W_OPCONF', tx: false, fresh: true, cleanup: closeTripQuiet, async prep(w) { await closeTripQuiet(w); const O = await dispatchedOrder(w);
    return { objs: [ORDc('ORD:o', O.id), ENTc('ENT:o', O.order_uid)], actor: 'operator_backup', call: (c) => H.opConfirm(c, O.id, H.PAY({ method: 'efectivo' }), 'operator_backup') }; } },
  W_MOPEN: { name: 'W_MOPEN', tx: false, async prep(w) { const t = await mkRestTable(w, 100 + (++seq % 800)); return { objs: [obj('RT:t2', 'row', { k: 'RT', id: t })], actor: 'operator_backup',
    call: rpc('SELECT public.mesa_open_session_v1($1,$2,$3,$4,$5) AS r', [w.ws, 'operator_backup', t, w.A, 2]) }; } },
  W_MOPEN_BUSY: { name: 'W_MOPEN_BUSY', tx: false, async prep(w) { const ts = await mkTable(w, 2); const rt2 = (await w.su.query('SELECT table_id FROM public.table_sessions WHERE id=$1', [ts])).rows[0].table_id;
    return { objs: [TSc('TS:t2', ts)], table: ts, actor: 'operator_backup', call: rpc('SELECT public.mesa_open_session_v1($1,$2,$3,$4,$5) AS r', [w.ws, 'operator_backup', rt2, w.A, 2]) }; } },
  W_CLOSE: { name: 'W_CLOSE', tx: false, fresh: true, async prep(w) { const corr = await H.seedCloseable({ su: w.su }, w.A); return { objs: [], actor: 'operator_primary', call: (c) => H.closeV3(c, w.A, corr) }; } },
  W_OPEN: { name: 'W_OPEN', tx: false, needsNoService: true, async prep() { return { objs: [], actor: 'operator_primary', call: rpc('SELECT public.open_operational_service_v1($1,$2,$3) AS r', ['operator_primary', 'next_service_of_business_day', 'c8_resume']) }; } },
  W_REFUND_HIST: { name: 'W_REFUND_HIST', tx: false, needsNoService: true, async prep(w) { const P = w.histPaid; return { objs: [ORDc('ORD:p', P.id), PTc('PT:orig', P.tx)], actor: 'owner',
    call: rpc('SELECT public.order_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', hex64('so'), P.order_uid, P.tx, 'c8 refund hist', rid('rf'), hex64(rid('rh')), 3, '{}']) }; } },
  W_ADJ_HIST: { name: 'W_ADJ_HIST', tx: false, needsNoService: true, async prep(w) { const O = w.hist; return { objs: [ORDc('ORD:o', O.id)], actor: 'owner',
    call: rpc('SELECT public.order_apply_commercial_adjustment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', hex64('so'), O.order_uid, 8, 'c8 adj hist', rid('adj'), hex64(rid('ah')), 10, '{}']) }; } },
};

// Every lock-level interleaving of the pair reachable by "the paused party stalls on ONE object while holding its prefix": for each candidate object and each
// direction, a blocker holds the object, the paused party starts first and stalls, the other party runs free, the blocker is released. Objects the paused
// party never requests complete without blocking and are not counted as exercised.
async function sweepPair(env, tpl, a, b, { dirs = ['t2', 't1'] } = {}) {
  const s1 = PARTIES[a], s2 = PARTIES[b];
  const fresh = !!(s1.fresh || s2.fresh || s1.needsNoService || s2.needsNoService);
  const noService = !!(s1.needsNoService || s2.needsNoService);
  const out = { pair: `${a} x ${b}`, runs: 0, exercised: 0, deadlocks: [], timeouts: 0, unexpected: [], integrity: [] };
  let shared = fresh ? null : await world(env, tpl, 'sw');
  const shareConns = shared ? await conns(shared) : null;
  for (const dir of dirs) {
    let names = null;
    for (let i = 0; ; i++) {
      const w = shared || await world(env, tpl, 'sw', { noService });
      const cn = shareConns || await conns(w);
      try {
        const c2 = await s2.prep(w); const c1 = await s1.prep(w, c2);
        const pool = worldObjs().concat(c1.objs || [], c2.objs || []);
        if (!names) names = pool.map((o) => o.name).filter((n, k, arr) => arr.indexOf(n) === k);
        if (i >= names.length) { if (s1.cleanup) await s1.cleanup(w); if (s2.cleanup) await s2.cleanup(w); break; }
        const name = names[i];
        let desc = pool.find((o) => o.name === name);
        if (!desc && /^TS:/.test(name)) desc = pool.find((o) => /^TS:/.test(o.name));
        out.runs++;
        if (!desc) { if (s1.cleanup) await s1.cleanup(w); if (s2.cleanup) await s2.cleanup(w); continue; }
        const pauseDesc = desc.kind === 'adv' ? desc : { ...desc, mode: 'FOR UPDATE' };
        const r = await pairRun(w, cn, { t1: { call: c1.call, tx: s1.tx }, t2: { call: c2.call, tx: s2.tx }, pause: { who: dir, objs: [pauseDesc] } });
        if (s1.cleanup) await s1.cleanup(w); if (s2.cleanup) await s2.cleanup(w);
        if (r.first_state === 'blocked') out.exercised++;
        if (r.deadlock) out.deadlocks.push({ dir, obj: name, victim: r.victim, actors: { t1: c1.actor, t2: c2.actor }, t1: r.result.t1 && r.result.t1.err, t2: r.result.t2 && r.result.t2.err });
        if (r.timeout) out.timeouts++;
        for (const k of ['t1', 't2']) { const x = r.result && r.result[k]; if (x && x.err && x.err !== '40P01') out.unexpected.push(`${k}:${x.err}:${(x.msg || '').slice(0, 60)}`); }
      } catch (e) { out.unexpected.push('harness:' + String(e.message).slice(0, 100)); }
      finally { if (fresh) await w.close(); }
    }
  }
  if (shared) { out.integrity = (await integrity(shared.su)).violations.concat((await stateInvariants(shared.su)).violations); await shared.close(); }
  return out;
}

// ── natural-race stress (no forced pauses) ────────────────────────────────────────────────────────────────────────────────────────
let seed = 20260924; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
async function pool(w, n) { const a = []; for (let i = 0; i < n; i++) a.push(await w.client('st-' + i)); return a; }
const runOp = (spec, ctx, conn, jitterMs) => (async () => {
  await delay(Math.floor(rnd() * jitterMs));
  try {
    if (spec.tx) { await conn.query('BEGIN'); try { const r = await ctx.call(conn); await conn.query('COMMIT'); return { spec: spec.name, ok: true }; } catch (e) { await conn.query('ROLLBACK').catch(() => {}); return { spec: spec.name, err: e.code || 'ERR', msg: String(e.message).slice(0, 80) }; } }
    const r = await ctx.call(conn); return { spec: spec.name, ok: !(r && r.ok === false) };
  } catch (e) { return { spec: spec.name, err: e.code || 'ERR', msg: String(e.message).slice(0, 80) }; }
})();
// rounds of concurrently launched operations, each on its own connection with a random jitter. plan(r) -> [party names]; share -> the writer and the intake use the SAME table / actor
// expected = regexes over "<party>:<sqlstate>:<message>" of TYPED refusals that are the correct outcome of a party (e.g. mesa_open_session_v1 on an occupied table)
async function stressMix(env, tpl, { rounds = 40, plan, share = true, jitter = 8, label = 'mix', expected = [] }) {
  const w = await world(env, tpl, 'st', { deadlockMs: 200 });
  const n = plan(0).length;
  const conns2 = await pool(w, n);
  const st = { label, rounds, ops: 0, deadlocks: 0, other_errors: {}, refusals: 0 };
  for (let r = 0; r < rounds; r++) {
    const specs = plan(r).map((k) => PARTIES[k]);
    const ctxs = []; let last = null;
    for (const sp of specs) { const c = await sp.prep(w, last ? { table: share ? last.table : undefined, actor: last.actor } : undefined); ctxs.push(c); last = c; }
    const res = await Promise.all(specs.map((sp, i) => runOp(sp, ctxs[i], conns2[i], jitter)));
    for (const x of res) {
      st.ops++;
      if (x.err === '40P01') st.deadlocks++;
      else if (x.err && expected.some((re) => re.test(`${x.spec}:${x.err}:${x.msg || ''}`))) st.refusals++;
      else if (x.err) { const k = `${x.spec}:${x.err}:${(x.msg || '').slice(0, 40)}`; st.other_errors[k] = (st.other_errors[k] || 0) + 1; }
      else if (x.ok === false) st.refusals++;
    }
    if (specs.some((s) => s.cleanup)) await closeTripQuiet(w);
  }
  st.integrity = (await integrity(w.su)).violations.concat((await stateInvariants(w.su)).violations);
  st.final = await counts(w.su);
  await w.close();
  return st;
}

module.exports = {
  M139, M140, md5, hex64, rid, delay, H, realStatement, buildPreTemplate, world, insertOrder, intent, cashPay, nextId,
  mkUnpaid, mkPaid, mkTable, mkTableOrder, mkRestTable, dispatchedOrder, closeTripQuiet,
  integrity, stateInvariants, counts, hold, release, settleOrBlock, conns, pairRun, start, PARTIES, worldObjs, obj, TSc, ORDc,
  sweepPair, stressMix, backendPid, waitBlocked,
};
