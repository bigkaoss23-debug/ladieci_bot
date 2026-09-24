'use strict';
// B-RID-1 RIDER_PAYMENT_RECEIPT_LINEAGE_GAP (migration 140) -- behavioural certification.
//
// THE CONTRACT under test. The rider's Entregado + Efectivo/Tarjeta/Bizum records TWO distinct facts in ONE transaction:
//   1. DELIVERY COMPLETED  -- ordenes.estado EN_ENTREGA -> RETIRADO (+ hora_entrega), unchanged;
//   2. CUSTOMER PAID       -- through the SAME canonical writer as the operator (order_post_payment_v1):
//        payment_transactions (receipt service, by the RIDER) + payment_allocations (the order_uid) +
//        order_financial_events (obligation service = the order's, receipt service = the same as the transaction).
//   Receipt service: A while A is open; B when A is closed and B open; NULL (off-service, 139) when none is open -- never a
//   fabricated A. Actor: the rider, never an operator/admin/owner. Idempotent, atomic, append-only.
//
// Everything runs on real PostgreSQL 17 with the REAL ledger (live table shapes / constraints / triggers, writer bodies
// verbatim) and the REAL migrations 139 + 140. PRE-140 contrast scenarios run on the post-139 template (the state 140
// corrects) and must show the defect. Nothing here touches staging or production.
const crypto = require('crypto');
const { section, assert, call } = require('../lib');
const H = require('./deliveryEconomyDecoupling').helpers;

const META = JSON.stringify({});
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const n = (v) => (v == null ? null : Number(v));
let SID = null;

// The rider RPC exactly as the backend calls it after 140 (8 named arguments, the session proof last), and the
// not-yet-redeployed backend form (7 arguments -> p_by_sid_hash DEFAULT NULL).
const idemOf = (id) => `pay-order-${String(id).replace(/[^A-Za-z0-9_-]/g, '')}`;
const rider = (client, id, method, x = {}) => call(client, 'rider_collect_and_complete_stop',
  [id, method, x.actor || 'rider', x.sv || 1, x.ip === undefined ? 'iphash' : x.ip, x.meta || META, x.idem || idemOf(id), x.sid === undefined ? SID : x.sid]);
const rider7 = (client, id, method, x = {}) => call(client, 'rider_collect_and_complete_stop',
  [id, method, x.actor || 'rider', x.sv || 1, 'iphash', META, x.idem || idemOf(id)]);
const safe = (p) => p.catch((e) => ({ threw: e.code || 'NO_CODE', message: e.message }));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// The canonical writer called DIRECTLY (what a PostgREST / Cash V1 caller can do), optionally inside a transaction that
// carries a hand-made attestation (only a raw SQL session can do that; PostgREST cannot set an arbitrary setting).
async function directWriter(client, ws, o, x = {}) {
  return client.query('SELECT public.order_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) AS r',
    [ws, x.actor || 'rider', SID, o.order_uid, x.method || 'efectivo', x.mode || 'full', x.amount ?? null,
      x.reqId || `direct_${crypto.randomUUID()}`, sha(crypto.randomUUID()), JSON.stringify(x.meta || { source: 'rider_delivery' }), x.confirm === true])
    .then((r) => r.rows[0].r);
}
async function withAttestation(c, value, fn) {
  const t = await c.client('brid-attest');
  await t.query('BEGIN');
  try {
    await t.query("SELECT set_config('ladieci.rider_payment_attestation', $1, true)", [value]);
    const r = await safe(fn(t));
    await t.query(r && r.threw ? 'ROLLBACK' : 'COMMIT');
    return r;
  } finally { await t.end().catch(() => {}); }
}

// Every economic row of ONE order, straight from the ledger tables.
async function full(c, id) {
  const o = (await c.su.query(`SELECT id, order_uid, estado, service_session_id, cobrado, ya_pagado, metodo_pago, created_at, totale
                                  FROM public.ordenes WHERE id = $1`, [id])).rows[0];
  const tx = (await c.su.query(`SELECT t.*, public.classify_economic_period_v1(t.created_at) AS period_at_created FROM public.payment_transactions t
                                  WHERE t.id IN (SELECT a.payment_transaction_id FROM public.payment_allocations a WHERE a.order_uid = $1)
                                  ORDER BY t.created_at`, [o.order_uid])).rows;
  const al = (await c.su.query('SELECT * FROM public.payment_allocations WHERE order_uid = $1 OR order_id = $2 ORDER BY created_at', [o.order_uid, id])).rows;
  const ev = (await c.su.query('SELECT * FROM public.order_financial_events WHERE order_id = $1 ORDER BY created_at', [id])).rows;
  const obligation = n((await c.su.query('SELECT public.order_canonical_obligation_v1($1) AS v', [o.order_uid])).rows[0].v);
  const paid = ev.filter((e) => ['payment', 'payment_imported'].includes(e.type)).reduce((s, e) => s + n(e.amount), 0)
    - ev.filter((e) => e.type === 'refund').reduce((s, e) => s + n(e.amount), 0);
  return { o, tx, al, ev, obligation, paid, unpaid: Math.round((obligation - paid) * 100) / 100 };
}
const totals = async (c) => (await c.su.query(`SELECT (SELECT count(*)::int FROM public.payment_transactions) AS pt,
  (SELECT count(*)::int FROM public.payment_allocations) AS pa, (SELECT count(*)::int FROM public.order_financial_events) AS ofe`)).rows[0];
const hexUid = (uid) => uid.replace(/-/g, '');
// B1: the app shows the rider ordenes.totale; the canonical writer records the OUTSTANDING of the canonical obligation.
const adjustTo = (c, ws, o, serviceId, gross) => c.su.query(`INSERT INTO public.order_obligations (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, source, cause, reason, by_actor, by_role)
                        VALUES ($1, $2, $3, $4, 2, $5, 'order_commercial_adjustment_v1', 'harness', 'harness adjustment', 'owner', 'admin')`, [o.order_uid, o.id, serviceId, ws, gross]);
const isMismatch = (r) => r && r.ok === false && r.code === 'PAYMENT_REFUSED' && r.payment_code === 'RIDER_PAYMENT_AMOUNT_MISMATCH';
// The stop did NOT complete and nothing new was written: same ledger totals, order still EN_ENTREGA with the mirror untouched, trip still ACTIVE.
async function stopUntouched(w, id, before) {
  const f = await full(w.c, id);
  const trip = (await H.tripStatus(w.c))[0];
  return JSON.stringify(await totals(w.c)) === JSON.stringify(before) && f.o.estado === 'EN_ENTREGA' && f.o.cobrado !== true && !!trip && trip.status === 'ACTIVE';
}

// R11 / R12 as a DATABASE-WIDE invariant: every rider-authored transaction is a complete, non-orphan money fact, and no
// rider event exists without its transaction.
async function integrity(c) {
  const r = (await c.su.query(`
    SELECT
      (SELECT count(*)::int FROM public.payment_transactions t WHERE t.by_role = 'rider') AS rider_tx,
      (SELECT count(*)::int FROM public.payment_transactions t WHERE t.by_role = 'rider'
          AND (SELECT count(*) FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id AND a.order_uid IS NOT NULL AND a.amount = t.amount) <> 1) AS tx_bad_alloc,
      (SELECT count(*)::int FROM public.payment_transactions t WHERE t.by_role = 'rider'
          AND (SELECT count(*) FROM public.order_financial_events e JOIN public.payment_allocations a ON a.payment_transaction_id = t.id
                WHERE e.payment_transaction_id = t.id AND e.type = 'payment' AND e.order_id = a.order_id AND e.amount = t.amount
                  AND e.payment_method = t.payment_method AND e.by_actor = t.by_actor AND e.by_role = 'rider'
                  AND e.event_service_session_id IS NOT DISTINCT FROM t.service_session_id) <> 1) AS tx_bad_event,
      (SELECT count(*)::int FROM public.order_financial_events e WHERE e.by_role = 'rider' AND e.payment_transaction_id IS NULL) AS rider_event_only,
      (SELECT count(*)::int FROM public.payment_allocations a WHERE NOT EXISTS (SELECT 1 FROM public.payment_transactions t WHERE t.id = a.payment_transaction_id)) AS orphan_alloc,
      (SELECT count(*)::int FROM public.payment_transactions t WHERE t.meta->>'source' = 'rider_delivery' AND t.by_role <> 'rider') AS impersonated`)).rows[0];
  return r;
}
const intact = (r) => r.tx_bad_alloc === 0 && r.tx_bad_event === 0 && r.rider_event_only === 0 && r.orphan_alloc === 0 && r.impersonated === 0;

async function lockWait(su, app, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query(`SELECT a.wait_event_type, a.wait_event,
        (SELECT l.locktype FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted LIMIT 1) AS waiting_locktype,
        (SELECT l.objid::bigint::text FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted AND l.locktype = 'advisory' LIMIT 1) AS waiting_advisory
        FROM pg_stat_activity a WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'`, [app]);
    if (r.rows.length) return r.rows[0];
    await delay(20);
  }
  return null;
}

async function closeA(w) {
  const corr = await H.seedCloseable(w.c, w.s);
  return H.closeV3(w.c.svc, w.s, corr);
}

async function run(env) {
  SID = env.RIDER_SID_HASH;
  const KEY_L0 = String((await env.admin.query("SELECT (hashtext('LA_DIECI_DRIVER_STATO')::bigint & 4294967295)::bigint AS k")).rows[0].k);
  const pre140 = { ...env, clone: env.clonePre140 };

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('BR0 CONTRAST (PRE-140 = post-139): the defect B-RID-1 -- the rider collection is an event-only row, no transaction, no allocation, no receipt service even with A OPEN');
  {
    const w = await H.world(pre140, { label: 'br0-pre' });
    const { o, st } = await H.dispatched(w, { totale: 12.5, id: '#K9001' });
    const r = await rider7(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('pre-140: the stop completes (OK) and ONE payment event exists', st.ok && r.ok === true && r.code === 'OK' && f.ev.length === 1, { r, ev: f.ev.length });
    assert('pre-140 DEFECT: 0 payment_transactions, 0 payment_allocations, event.payment_transaction_id NULL',
      f.tx.length === 0 && f.al.length === 0 && f.ev[0].payment_transaction_id === null, { tx: f.tx.length, al: f.al.length });
    assert('pre-140 DEFECT: event_service_session_id is NULL although service A was OPEN when the money was received (no receipt lineage)',
      f.ev[0].event_service_session_id === null && f.ev[0].service_session_id === w.s, f.ev[0]);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R1 CASE 1 -- A OPEN: the rider collects; transaction receipt = A, event obligation = A, event receipt = A; allocation on the order; recorded AS THE RIDER');
  {
    const w = await H.world(env, { label: 'r1' });
    const { o, st } = await H.dispatched(w, { totale: 12.5, id: '#K0001' });
    assert('R1 setup: trip departed in A (order EN_ENTREGA)', st.ok === true, st);
    const r = await rider(w.c.svc, o.id, 'efectivo');
    assert('R1: the stop completes (OK) with a canonical payment result (not idempotent, 12.50, efectivo, receipt service A)',
      r.ok === true && r.code === 'OK' && r.payment && r.payment.ok === true && r.payment.idempotent === false && n(r.payment.amount) === 12.5
      && r.payment.paymentMethod === 'efectivo' && r.payment.serviceSessionId === w.s && r.payment_note === null, r);
    const f = await full(w.c, o.id);
    const [tx] = f.tx; const [al] = f.al; const [ev] = f.ev;
    assert('R1/R12: exactly ONE payment_transaction, ONE payment_allocation, ONE financial event', f.tx.length === 1 && f.al.length === 1 && f.ev.length === 1, { tx: f.tx.length, al: f.al.length, ev: f.ev.length });
    const linked = (await w.c.su.query(`SELECT count(*)::int AS n FROM public.payment_transactions t
        JOIN public.payment_allocations a ON a.payment_transaction_id = t.id
        JOIN public.order_financial_events e ON e.payment_transaction_id = t.id
       WHERE t.id = $1 AND a.order_uid = $2 AND e.order_id = $3 AND e.type = 'payment' AND t.amount = 12.5 AND a.amount = 12.5 AND e.amount = 12.5`,
      [r.payment.transactionId, o.order_uid, o.id])).rows[0].n;
    assert('R1 (behavioural): the transaction the command RETURNED exists in payment_transactions AND is linked to exactly ONE allocation AND exactly ONE financial event of this order, all 12.50',
      linked === 1 && tx.id === r.payment.transactionId, { linked, returned: r.payment.transactionId, stored: tx.id });
    assert('R1: payment_transactions.service_session_id = A (receipt)', tx.service_session_id === w.s, tx);
    assert('R1: order_financial_events.service_session_id = A (obligation)', ev.service_session_id === w.s, ev);
    assert('R1: order_financial_events.event_service_session_id = A (receipt, the SAME fact as the transaction)', ev.event_service_session_id === w.s, ev);
    assert('R1: transaction = kind payment, mode full, amount = the canonical obligation 12.50, table_session_id NULL, covers 0, not an off-service receipt',
      tx.kind === 'payment' && tx.mode === 'full' && n(tx.amount) === 12.5 && n(tx.amount) === f.obligation && tx.table_session_id === null
      && tx.covers_settled === 0 && tx.meta.off_service_receipt === undefined, tx);
    assert('R11: the allocation points at the SAME order (order_uid + display id), carries the full amount and the transaction id; no Mesa line',
      al.payment_transaction_id === tx.id && al.order_uid === o.order_uid && al.order_id === o.id && n(al.amount) === 12.5 && al.table_order_line_id === null, al);
    assert('R12: the event is bound to the transaction (payment_transaction_id), same amount and method; the transaction is not orphan',
      ev.payment_transaction_id === tx.id && ev.type === 'payment' && n(ev.amount) === 12.5 && ev.payment_method === 'efectivo', ev);
    assert('R5: transaction by_actor = rider, by_role = rider; event by_actor = rider, by_role = rider',
      tx.by_actor === 'rider' && tx.by_role === 'rider' && ev.by_actor === 'rider' && ev.by_role === 'rider', { tx: [tx.by_actor, tx.by_role], ev: [ev.by_actor, ev.by_role] });
    assert('R5: provenance is server-forced (meta.source rider_delivery) and the rider session proof is the one supplied (sha256(sid)); the legacy audit fields are kept in meta',
      tx.meta.source === 'rider_delivery' && tx.by_sid_hash === SID && tx.meta.ip_hash === 'iphash' && tx.meta.idem_scope_key === idemOf(o.id), tx.meta);
    assert('R7 basis: the request identity is deterministic per ORDER (order_uid, not the recyclable display id): client_request_id and request_hash',
      tx.client_request_id === `rider-delivery-${hexUid(o.order_uid)}` && tx.request_hash === sha(`rider_delivery|${o.order_uid}|efectivo|full`), tx);
    assert('R1: the DELIVERY fact: order RETIRADO with hora_entrega; the mirror says paid efectivo (written by the writer, not the rider RPC)',
      f.o.estado === 'RETIRADO' && f.o.cobrado === true && f.o.ya_pagado === true && f.o.metodo_pago === 'efectivo' && f.unpaid === 0, f.o);
    // R13 -- economic-period stamping: the SAME triggers as any canonical payment.
    const cashOrder = await w.mk({ estado: 'RETIRADO', totale: 7, id: '#K0001C' });
    await H.cashPay(w.c.svc, await H.wsOf(w.c), cashOrder, { method: 'tarjeta' });
    const fc = await full(w.c, cashOrder.id);
    const obligationPeriod = (await w.c.su.query('SELECT public.classify_economic_period_v1($1) AS k', [f.o.created_at])).rows[0].k;
    assert('R13: transaction economic_period_kind is stamped by the trigger exactly like the operator Cash V1 payment made in the same instant, and equals classify(created_at)',
      tx.economic_period_kind === fc.tx[0].economic_period_kind && tx.economic_period_kind === tx.period_at_created, { rider: tx.economic_period_kind, operator: fc.tx[0].economic_period_kind, at: tx.period_at_created });
    assert('R13: event obligation period = classify(order created_at) and event period = the transaction period (same stamping as the operator event)',
      ev.obligation_economic_period_kind === obligationPeriod && ev.event_economic_period_kind === tx.economic_period_kind
      && fc.ev[0].event_economic_period_kind === ev.event_economic_period_kind, { ev, obligationPeriod });
    const trip = (await H.tripStatus(w.c))[0];
    assert('R1: the stop did not touch the trip (still ACTIVE, service A); no service row created', trip.status === 'ACTIVE' && trip.service_session_id === w.s
      && (await H.snap(w.c, w.s)).services === 1, trip);
    const fisc = (await w.c.su.query('SELECT count(*)::int AS n FROM public.order_financial_events WHERE event_service_session_id = $1 AND order_id = $2', [w.s, o.id])).rows[0].n;
    assert('B-FISC-1 forward-compat: the rider event is selected by the SAME predicate consolidate_period_v1 uses for any receipt of A (event_service_session_id = A)', fisc === 1, { fisc });
    assert('R11/R12 database-wide: every rider transaction is complete and non-orphan; no rider event without its transaction; no impersonation', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R2 CASE 2 -- order of A, A CLOSED, B OPEN: transaction receipt = B, event obligation = A, event receipt = B (R14: the trip belongs to A)');
  {
    const w = await H.world(env, { label: 'r2' });
    const { o } = await H.dispatched(w, { totale: 18, id: '#K0002' });
    const cl = await closeA(w);
    assert('R2 setup: A closes with the trip ACTIVE (139)', cl.ok === true && cl.code === 'V3_CLOSED', cl);
    const B = await H.openService(w.c, '2026-09-20');
    const r = await rider(w.c.svc, o.id, 'tarjeta');
    assert('R2: the stop completes (OK) with the payment received by B', r.ok === true && r.code === 'OK' && r.payment && r.payment.serviceSessionId === B, r);
    const f = await full(w.c, o.id);
    const [tx] = f.tx; const [ev] = f.ev;
    assert('R2: payment_transactions.service_session_id = B', f.tx.length === 1 && tx.service_session_id === B, tx);
    assert('R2: order_financial_events.service_session_id = A (obligation, never moved)', f.ev.length === 1 && ev.service_session_id === w.s, ev);
    assert('R2: order_financial_events.event_service_session_id = B', ev.event_service_session_id === B, ev);
    assert('R15: the receipt is NOT a fabricated A (neither column names the closed service)', tx.service_session_id !== w.s && ev.event_service_session_id !== w.s);
    const trip = (await H.tripStatus(w.c))[0];
    assert('R14: the trip belongs to A while the receipt is B; the order still belongs to A; A stays CLOSED (never reopened)',
      trip.service_session_id === w.s && f.o.service_session_id === w.s && (await H.snap(w.c, w.s)).svc === 'closed', { trip, o: f.o });
    assert('R2: allocation on the order, rider-authored, full obligation; RETIRADO; unpaid 0', f.al.length === 1 && f.al[0].order_uid === o.order_uid
      && tx.by_role === 'rider' && ev.by_role === 'rider' && n(tx.amount) === 18 && f.o.estado === 'RETIRADO' && f.unpaid === 0, f);
    assert('R2 integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R3 CASE 3 -- order of A, A CLOSED, NO service open: transaction receipt = NULL, event obligation = A, event receipt = NULL (139 off-service contract)');
  {
    const w = await H.world(env, { label: 'r3' });
    const { o } = await H.dispatched(w, { totale: 21.4, id: '#K0003' });
    const cl = await closeA(w);
    assert('R3 setup: A closed, pointer cleared, no service open', cl.ok === true && (await H.snap(w.c, w.s)).pointer === null, cl);
    const r = await rider(w.c.svc, o.id, 'bizum');
    assert('R3: the stop completes (OK); the writer reports NO receipt service', r.ok === true && r.code === 'OK' && r.payment && r.payment.serviceSessionId === null, r);
    const f = await full(w.c, o.id);
    const [tx] = f.tx; const [ev] = f.ev;
    assert('R3: payment_transactions.service_session_id = NULL and table_session_id = NULL', f.tx.length === 1 && tx.service_session_id === null && tx.table_session_id === null, tx);
    assert('R3: order_financial_events.service_session_id = A (obligation)', ev.service_session_id === w.s, ev);
    assert('R3: order_financial_events.event_service_session_id = NULL', ev.event_service_session_id === null, ev);
    assert('R3: the off-service invariant holds: the writer decided meta.off_service_receipt = true (JSON boolean), kind payment, mode full, covers 0 -- the 139 scope constraint admitted the row',
      tx.meta.off_service_receipt === true && tx.kind === 'payment' && tx.mode === 'full' && tx.covers_settled === 0, tx.meta);
    assert('R15: NO fake receipt = A after the close (the order\'s own service is never written as the receipt)', tx.service_session_id !== w.s && ev.event_service_session_id !== w.s);
    const s = await H.snap(w.c, w.s);
    assert('R3: nothing reopened or invented: exactly 1 service row, still CLOSED, pointer NULL; trip still of A', s.services === 1 && s.svc === 'closed' && s.pointer === null
      && (await H.tripStatus(w.c))[0].service_session_id === w.s, s);
    assert('R3: rider-authored, allocation on the order, RETIRADO, unpaid 0, mirror bizum', tx.by_role === 'rider' && ev.by_role === 'rider' && f.al.length === 1
      && f.al[0].order_uid === o.order_uid && f.o.estado === 'RETIRADO' && f.unpaid === 0 && f.o.metodo_pago === 'bizum', f.o);
    assert('R3 integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R4 METHODS -- efectivo / tarjeta / bizum preserved on the transaction, the event and the mirror; no new tender, no MIXTO invented');
  for (const [m, input] of [['efectivo', 'efectivo'], ['tarjeta', 'TARJETA'], ['bizum', ' Bizum ']]) {
    const w = await H.world(env, { label: `r4-${m}` });
    const { o } = await H.dispatched(w, { totale: 9.9, id: `#K004${m[0]}` });
    const r = await rider(w.c.svc, o.id, input);
    const f = await full(w.c, o.id);
    assert(`R4 ${m} (input ${JSON.stringify(input)}): transaction, event and mirror all say "${m}"`, r.ok === true && f.tx.length === 1 && f.tx[0].payment_method === m
      && f.ev[0].payment_method === m && f.o.metodo_pago === m, { r, tx: f.tx[0] && f.tx[0].payment_method, ev: f.ev[0] && f.ev[0].payment_method, mirror: f.o.metodo_pago });
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'r4-bad' });
    const { o } = await H.dispatched(w, { totale: 9, id: '#K004X' });
    const before = await totals(w.c);
    const bad = await rider(w.c.svc, o.id, 'mixto');
    assert('R4: an unknown tender (mixto) is refused (AUTH_METHOD_INVALID) and writes nothing; the order stays EN_ENTREGA',
      bad.ok === false && bad.code === 'AUTH_METHOD_INVALID' && JSON.stringify(await totals(w.c)) === JSON.stringify(before) && (await H.orderEstado(w.c, o.id)) === 'EN_ENTREGA', bad);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R6 NO IMPERSONATION / BOUNDED AUTHORITY -- the rider is never an operator, and gets NO generic capability to collect any order');
  {
    const w = await H.world(env, { label: 'r6' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 15, id: '#K0006' });
    const other = await w.mk({ estado: 'RETIRADO', totale: 11, id: '#K0006Z' });   // NOT in the rider's trip
    const before = await totals(w.c);
    const op = await rider(w.c.svc, o.id, 'efectivo', { actor: 'operator_primary' });
    assert('R6a: an OPERATOR calling the rider RPC is refused (AUTH_FORBIDDEN_ROLE) -- the rider contract never serves an operator', op.ok === false && op.code === 'AUTH_FORBIDDEN_ROLE', op);
    const own = await rider(w.c.svc, o.id, 'efectivo', { actor: 'owner' });
    assert('R6a: an ADMIN/owner calling the rider RPC is refused too', own.ok === false && own.code === 'AUTH_FORBIDDEN_ROLE', own);
    const nm = await rider(w.c.svc, other.id, 'efectivo');
    assert('R6b: the rider cannot collect an order OUTSIDE its active trip (NON_MEMBER) -- authority bound to the trip/stop', nm.ok === false && nm.code === 'NON_MEMBER', nm);
    const direct = await safe(directWriter(w.c.svc, ws, other));
    assert('R6c: the rider calling the canonical writer DIRECTLY (the Cash V1 / PostgREST shape) is refused ORDER_PAYMENT_FORBIDDEN -- no attestation, no capability',
      direct.threw === '42501' && /ORDER_PAYMENT_FORBIDDEN/.test(direct.message), direct);
    const directMember = await safe(directWriter(w.c.svc, ws, o));
    assert('R6c: ...even for an order that IS in its trip: only the rider RPC (identity + session + membership + state verified) can attest', directMember.threw === '42501', directMember);
    assert('R6: all of the above wrote NOTHING (no transaction, allocation or event)', JSON.stringify(await totals(w.c)) === JSON.stringify(before), { before, after: await totals(w.c) });
    // The attestation is bound: actor, order_uid, full only, no duplicate override (a raw SQL session minting it by hand).
    const wrongOrder = await withAttestation(w.c, `rider|${o.order_uid}`, (t) => directWriter(t, ws, other));
    assert('R6d: an attestation for order X does NOT admit a payment of order Y', wrongOrder.threw === '42501', wrongOrder);
    const partial = await withAttestation(w.c, `rider|${o.order_uid}`, (t) => directWriter(t, ws, o, { mode: 'custom_amount', amount: 5 }));
    assert('R6d: an attestation does NOT admit a PARTIAL (custom_amount) rider payment -- full payment only', partial.threw === '42501', partial);
    const dup = await withAttestation(w.c, `rider|${o.order_uid}`, (t) => directWriter(t, ws, o, { confirm: true }));
    assert('R6d: an attestation does NOT admit a duplicate override (p_confirm_duplicate) by a rider', dup.threw === '42501', dup);
    const rider2 = crypto.randomUUID();
    await w.c.su.query("INSERT INTO public.auth_actors (actor, role, active, session_version, workspace_id) VALUES ($1, 'rider', true, 1, $2)", [rider2, ws]);
    const otherActor = await withAttestation(w.c, `rider|${o.order_uid}`, (t) => directWriter(t, ws, o, { actor: rider2 }));
    assert('R6d: an attestation for rider A does NOT admit rider B', otherActor.threw === '42501', otherActor);
    const opUnder = await withAttestation(w.c, `operator_primary|${o.order_uid}`, (t) => directWriter(t, ws, o, { actor: 'operator_primary', meta: { source: 'servicio_dashboard' } }));
    assert('R6d (control): an operator is judged exactly as before (admitted regardless of the attestation) and recorded as the OPERATOR',
      opUnder.ok === true && opUnder.idempotent === false, opUnder);
    const f = await full(w.c, o.id);
    assert('R6: the one payment that exists was recorded by the operator as operator, never relabelled rider', f.tx.length === 1 && f.tx[0].by_role === 'operator' && f.ev[0].by_role === 'operator', f.tx[0]);
    const r = await rider(w.c.svc, o.id, 'efectivo');
    assert('R6 (continuation): the rider then completes the delivery; the debt is already settled, so NO second payment (tolerated ORDER_PAYMENT_ALREADY_SETTLED)',
      r.ok === true && r.code === 'OK' && r.payment === null && r.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && (await full(w.c, o.id)).tx.length === 1 && (await H.orderEstado(w.c, o.id)) === 'RETIRADO', r);
    assert('R6 integrity (no rider_delivery row authored by a non-rider)', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }
  {
    // The table constraint is the last line of defence: 'rider' is admitted ONLY for the rider-delivery payment shape.
    const w = await H.world(env, { label: 'r6-constraint' });
    const ws = await H.wsOf(w.c);
    const ins = (x) => safe(w.c.su.query(`INSERT INTO public.payment_transactions (workspace_id, table_session_id, service_session_id, kind, mode, amount,
        payment_method, covers_settled, reverses_transaction_id, by_actor, by_role, by_sid_hash, client_request_id, request_hash, meta)
      VALUES ($1, NULL, $2, $3, $4, 5, 'efectivo', 0, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING id`,
      [ws, w.s, x.kind || 'payment', x.mode || 'full', x.reverses || null, x.actor || 'rider', x.role || 'rider', SID, `k_${crypto.randomUUID()}`, sha(crypto.randomUUID()),
        JSON.stringify(x.meta === undefined ? { source: 'rider_delivery' } : x.meta)]).then((r) => r.rows[0]));
    const good = await ins({});
    assert('K1: a rider full payment with meta.source "rider_delivery" is admitted (the one legal rider shape)', good && good.id && !good.threw, good);
    for (const [label, x] of [
      ['a rider PARTIAL (custom_amount)', { mode: 'custom_amount' }],
      ['a rider Mesa mode (equal_split)', { mode: 'equal_split' }],
      ['a rider row WITHOUT meta.source', { meta: {} }],
      ['a rider row with another source (servicio_dashboard)', { meta: { source: 'servicio_dashboard' } }],
      ['a rider row whose source is not a JSON string ("rider_delivery" as an array)', { meta: { source: ['rider_delivery'] } }],
      ['a rider REFUND', { kind: 'refund', mode: 'refund', reverses: good.id }],
    ]) {
      const bad = await ins(x);
      assert(`K1: ${label} is REJECTED by payment_transactions_by_role_check (23514)`, bad.threw === '23514' && /by_role_check/.test(bad.message), bad);
    }
    const opPartial = await ins({ role: 'operator', actor: 'operator_primary', mode: 'custom_amount', meta: {} });
    assert('K1 (control): the other roles are admitted exactly as before (an operator partial with no source)', opPartial && opPartial.id && !opPartial.threw, opPartial);
    const waiter = await ins({ role: 'waiter', actor: 'operator_primary', meta: {} });
    assert('K1 (control): a role that was not admitted before is still not admitted (waiter)', waiter.threw === '23514', waiter);
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R7 IDEMPOTENCY -- double tap, identical retry, retry after a lost response, another request key, a different method: ONE transaction');
  {
    const w = await H.world(env, { label: 'r7' });
    const { o } = await H.dispatched(w, { totale: 14, id: '#K0007' });
    const [a, b] = await Promise.all([rider(w.c.svc, o.id, 'efectivo'), rider(w.c.svc, o.id, 'efectivo')]);   // double tap on one connection
    assert('R7 double tap: the first completes (OK), the second is an IDEMPOTENT replay of the SAME transaction',
      a.ok && a.code === 'OK' && b.ok && b.code === 'IDEMPOTENT' && b.payment && b.payment.idempotent === true && b.payment.transactionId === a.payment.transactionId, { a, b });
    // "lost response": the first request committed but the rider never saw it -> the app retries the identical request.
    const retry = await rider(w.c.svc, o.id, 'efectivo');
    assert('R7 retry after a lost response: IDEMPOTENT, same transaction id, no new money', retry.ok && retry.code === 'IDEMPOTENT' && retry.payment.transactionId === a.payment.transactionId, retry);
    const otherKey = await rider(w.c.svc, o.id, 'efectivo', { idem: 'pay-order-some-other-key' });
    assert('R7 same order/stop with ANOTHER request key: still the same transaction (the identity is the order, not the key)', otherKey.ok && otherKey.payment && otherKey.payment.transactionId === a.payment.transactionId, otherKey);
    const diff = await rider(w.c.svc, o.id, 'tarjeta');
    assert('R7 same stop retried with a DIFFERENT method: typed conflict (PAYMENT_REFUSED / ORDER_PAYMENT_IDEMPOTENCY_CONFLICT), never a second payment',
      diff.ok === false && diff.code === 'PAYMENT_REFUSED' && diff.payment_code === 'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT', diff);
    const old = await rider7(w.c.svc, o.id, 'efectivo');
    assert('R7 a NOT-YET-REDEPLOYED backend (7 arguments, no proof) retrying the collection: typed PAYMENT_CONTEXT_UNAVAILABLE, nothing written',
      old.ok === false && old.code === 'PAYMENT_CONTEXT_UNAVAILABLE', old);
    const f = await full(w.c, o.id);
    assert('R7: after 6 attempts: exactly ONE transaction, ONE allocation, ONE event, obligation covered once, RETIRADO', f.tx.length === 1 && f.al.length === 1 && f.ev.length === 1
      && f.unpaid === 0 && f.o.estado === 'RETIRADO' && f.tx[0].payment_method === 'efectivo', { tx: f.tx.length, ev: f.ev.length, unpaid: f.unpaid });
    const ct = await H.closeTrip(w.c.svc, o.id);
    const after = await rider(w.c.svc, o.id, 'efectivo');
    assert('R7 after the trip is closed a retry is a typed refusal (NO_ACTIVE_TRIP), never a second payment', ct.ok === true && after.ok === false && after.code === 'NO_ACTIVE_TRIP'
      && (await full(w.c, o.id)).tx.length === 1, { ct, after });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R8 CONCURRENCY -- duplicate invocations on two connections serialize on L0; rider vs standalone Cash V1: no deadlock, ONE payment');
  {
    const w = await H.world(env, { label: 'r8-forced' });
    const { o } = await H.dispatched(w, { totale: 16, id: '#K0008' });
    const t1 = await w.c.client('brid-r8-first'); const t2 = await w.c.client('brid-r8-second');
    await t1.query('BEGIN');
    const first = await rider(t1, o.id, 'efectivo');
    const p2 = safe(rider(t2, o.id, 'efectivo'));
    const wait = await lockWait(w.c.su, 'brid-r8-second');
    assert('R8 forced: while the first invocation is uncommitted, the duplicate waits on the dispatch lock L0 (advisory), before any row lock',
      !!wait && wait.waiting_locktype === 'advisory' && wait.waiting_advisory === KEY_L0, wait);
    await t1.query('COMMIT');
    const second = await p2;
    assert('R8 forced: the duplicate then replays the SAME transaction (IDEMPOTENT)', first.code === 'OK' && second.ok === true && second.code === 'IDEMPOTENT'
      && second.payment && second.payment.transactionId === first.payment.transactionId, { first, second });
    assert('R8 forced: exactly ONE transaction / allocation / event', (await full(w.c, o.id)).tx.length === 1 && (await full(w.c, o.id)).ev.length === 1);
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'r8-stress' });
    const cs = await Promise.all([0, 1, 2].map((k) => w.c.client(`brid-r8-s${k}`)));
    const N = 12; let deadlocks = 0; let violations = 0; let notDelivered = 0; let anomalies = 0;
    for (let i = 0; i < N; i++) {
      const id = `#KS${String(i).padStart(3, '0')}`;
      const o = await w.mk({ estado: 'LISTO', totale: 10 + i, id, zona: 'Q1' });
      await H.closeTrip(w.c.svc, null).catch(() => {});
      const st = await H.startV2(w.c.svc, o, 'operator_primary', w.scope);
      if (!st.ok) { anomalies++; continue; }
      const method = ['efectivo', 'tarjeta', 'bizum'][i % 3];
      const out = await Promise.all(cs.map((c) => delay(Math.floor(Math.random() * 6)).then(() => safe(rider(c, id, method)))));
      if (out.some((x) => x && x.threw === '40P01')) deadlocks++;
      const f = await full(w.c, id);
      if (f.tx.length !== 1 || f.ev.length !== 1 || f.unpaid !== 0) violations++;
      if (f.o.estado !== 'RETIRADO' || out.filter((x) => x.ok && x.code === 'OK').length !== 1 || out.filter((x) => x.ok && x.code === 'IDEMPOTENT').length !== 2) notDelivered++;
    }
    assert(`R8 stress: ${N} orders x 3 concurrent identical invocations: 0 deadlock`, deadlocks === 0, { deadlocks });
    assert(`R8 stress: every order has exactly ONE transaction and ONE event, fully paid`, violations === 0, { violations });
    assert(`R8 stress: every order RETIRADO, exactly one OK and two IDEMPOTENT per order`, notDelivered === 0 && anomalies === 0, { notDelivered, anomalies });
    assert('R8 stress integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }
  {
    // The EXACT forced interleaving migration 139 recorded as a PRE-EXISTING deadlock (L2: the Cash V1 lock order holding
    // order_entities, then asking for ordenes, while the rider stop runs). The legacy writer locked ordenes FIRST; the
    // canonical writer takes the workspace lock first and no order row lock is taken before it -> no cycle.
    const w = await H.world(env, { label: 'r8-l2' });
    const o = await w.mk({ estado: 'LISTO', totale: 12.5, id: '#K0081', zona: 'Q1' });
    await H.startV2(w.c.svc, o, 'operator_primary', w.scope);
    const cash = await w.c.client('brid-cash-model'); const oc = await w.c.client('brid-rider-model');
    await cash.query('BEGIN');
    await cash.query('SELECT 1 FROM public.order_entities WHERE order_uid = $1 FOR UPDATE', [o.order_uid]);
    const p = safe(rider(oc, o.id, 'efectivo'));
    const wait = await lockWait(w.c.su, 'brid-rider-model');
    let cashErr = null;
    try { await cash.query('SELECT 1 FROM public.ordenes WHERE order_uid = $1 FOR UPDATE', [o.order_uid]); } catch (e) { cashErr = e.code || e.message; }
    await cash.query(cashErr ? 'ROLLBACK' : 'COMMIT');
    const res = await p;
    assert('R8/L2 CLOSED: the 139-recorded rider-vs-Cash V1 interleaving no longer deadlocks: the rider waits (row lock), Cash proceeds, then the rider completes',
      !!wait && cashErr === null && res.ok === true && res.code === 'OK', { wait, cashErr, res });
    const f = await full(w.c, o.id);
    assert('R8/L2: exactly ONE payment (the rider\'s), RETIRADO', f.tx.length === 1 && f.tx[0].by_role === 'rider' && f.o.estado === 'RETIRADO', f.tx);
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'r8-cash' });
    const ws = await H.wsOf(w.c);
    const cs = await Promise.all([0, 1].map((k) => w.c.client(`brid-rc-${k}`)));
    const N = 16; let deadlocks = 0; let violations = 0; let anomalies = 0;
    for (let i = 0; i < N; i++) {
      const id = `#KC${String(i).padStart(3, '0')}`;
      const o = await w.mk({ estado: 'LISTO', totale: 20 + i, id, zona: 'Q1' });
      await H.closeTrip(w.c.svc, null).catch(() => {});
      const st = await H.startV2(w.c.svc, o, 'operator_primary', w.scope);
      if (!st.ok) { anomalies++; continue; }
      const fns = [() => rider(cs[0], id, 'efectivo'), () => H.cashPay(cs[1], ws, o, { method: 'tarjeta' })];
      if (Math.random() < 0.5) fns.reverse();
      const out = await Promise.all(fns.map((f) => delay(Math.floor(Math.random() * 6)).then(f).then((x) => x, (e) => ({ threw: e.code || e.message, message: e.message }))));
      if (out.some((x) => x && x.threw === '40P01')) deadlocks++;
      const f = await full(w.c, id);
      if (f.tx.length !== 1 || f.ev.length !== 1 || f.paid > f.obligation || f.o.estado !== 'RETIRADO') violations++;
    }
    assert(`R8: ${N} randomized races rider stop vs standalone Cash V1 on the same order: 0 deadlock (the 139 side finding is closed)`, deadlocks === 0, { deadlocks });
    assert(`R8: ${N} races: exactly ONE payment per order (whoever wins), never over-collected, and the delivery always completes`, violations === 0 && anomalies === 0, { violations, anomalies });
    assert('R8 rider-vs-Cash integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R9 PAYMENT FAILURE -- a refused or failed collection leaves NO RETIRADO and NO money');
  {
    const w = await H.world(env, { label: 'r9' });
    const ws = await H.wsOf(w.c);
    // (a) a typed refusal raised INSIDE the canonical writer (its own workspace fence): the rider's actor row belongs to
    // another workspace than the order. The writer refuses; the rider RPC must return before the delivery.
    const a = await H.dispatched(w, { totale: 12, id: '#K0091' });
    const ws2 = (await w.c.su.query("INSERT INTO public.workspaces (name) VALUES ('zz-harness-other-workspace') RETURNING id")).rows[0].id;
    await w.c.su.query("UPDATE public.auth_actors SET workspace_id = $1 WHERE actor = 'rider'", [ws2]);
    const before = await totals(w.c);
    const ra = await rider(w.c.svc, a.o.id, 'efectivo');
    const fa = await full(w.c, a.o.id);
    assert('R9a: the canonical writer refuses (PAYMENT_REFUSED / ORDER_PAYMENT_WORKSPACE_MISMATCH)',
      ra.ok === false && ra.code === 'PAYMENT_REFUSED' && ra.payment_code === 'ORDER_PAYMENT_WORKSPACE_MISMATCH', ra);
    assert('R9a: NO RETIRADO (the order stays EN_ENTREGA), no transaction / allocation / event, mirror untouched',
      fa.o.estado === 'EN_ENTREGA' && fa.tx.length === 0 && fa.ev.length === 0 && fa.o.cobrado !== true && JSON.stringify(await totals(w.c)) === JSON.stringify(before), fa.o);
    await w.c.su.query("UPDATE public.auth_actors SET workspace_id = $1 WHERE actor = 'rider'", [ws]);
    const ok = await rider(w.c.svc, a.o.id, 'efectivo');
    assert('R9a: once the fence is satisfied the same stop completes with ONE payment', ok.ok && ok.code === 'OK' && (await full(w.c, a.o.id)).tx.length === 1, ok);
    await w.c.close();
  }
  {
    // (a') B1: the operator took 6.00 of 12.00 at the counter. The canonical outstanding is 6.00 but the rider app shows and
    // asks to collect totale 12.00: recording 6 would be a false success -> REFUSED typed, nothing written, not delivered.
    const w = await H.world(env, { label: 'r9-split' });
    const ws = await H.wsOf(w.c);
    const a = await H.dispatched(w, { totale: 12, id: '#K0093' });
    await H.cashPay(w.c.svc, ws, a.o, { mode: 'custom_amount', amount: 6, method: 'efectivo' });
    const before = await totals(w.c);
    const ra = await rider(w.c.svc, a.o.id, 'efectivo');
    const fa = await full(w.c, a.o.id);
    assert('R9a\' (B1): after an operator partial of 6.00 the rider collection of a 12.00 order is REFUSED (PAYMENT_REFUSED / RIDER_PAYMENT_AMOUNT_MISMATCH); only the operator\'s 6.00 exists, not delivered',
      isMismatch(ra) && fa.tx.length === 1 && fa.tx[0].by_role === 'operator' && fa.paid === 6 && fa.unpaid === 6 && fa.o.estado === 'EN_ENTREGA' && JSON.stringify(await totals(w.c)) === JSON.stringify(before), { ra, tx: fa.tx.map((t) => [t.by_role, t.mode, n(t.amount)]) });
    assert('R9a\' integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'r9b' });
    // (b) no session proof
    const b = await H.dispatched(w, { totale: 8, id: '#K0092' });
    const before = await totals(w.c);
    const rb = await rider(w.c.svc, b.o.id, 'efectivo', { sid: null });
    const rb2 = await rider(w.c.svc, b.o.id, 'efectivo', { sid: 'not-a-hash' });
    assert('R9b: a collection without a valid session proof is refused (PAYMENT_CONTEXT_UNAVAILABLE), nothing written, still EN_ENTREGA',
      rb.code === 'PAYMENT_CONTEXT_UNAVAILABLE' && rb2.code === 'PAYMENT_CONTEXT_UNAVAILABLE' && JSON.stringify(await totals(w.c)) === JSON.stringify(before)
      && (await H.orderEstado(w.c, b.o.id)) === 'EN_ENTREGA', { rb, rb2 });
    const rc = await rider(w.c.svc, b.o.id, 'efectivo', { ip: '' });
    assert('R9b: a collection without the IP hash keeps the legacy refusal (PAYMENT_REFUSED / AUTH_IP_HASH_REQUIRED), nothing written',
      rc.ok === false && rc.code === 'PAYMENT_REFUSED' && rc.payment_code === 'AUTH_IP_HASH_REQUIRED' && JSON.stringify(await totals(w.c)) === JSON.stringify(before), rc);
    const rm = await rider(w.c.svc, b.o.id, 'efectivo', { meta: JSON.stringify({ token: 'x' }) });
    assert('R9b: a sensitive meta key is refused by the canonical writer (PAYMENT_REFUSED / ORDER_PAYMENT_META_INVALID), nothing written',
      rm.ok === false && rm.code === 'PAYMENT_REFUSED' && rm.payment_code === 'ORDER_PAYMENT_META_INVALID' && JSON.stringify(await totals(w.c)) === JSON.stringify(before), rm);
    // (c) a RAW failure inside the writer (an allocation insert that fails) -- installed only in this throwaway database.
    await w.c.su.query(`CREATE FUNCTION public.zz_fail_alloc() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RAISE EXCEPTION 'HARNESS_ALLOCATION_FAILURE'; END $x$;
      CREATE TRIGGER zz_fail_alloc BEFORE INSERT ON public.payment_allocations FOR EACH ROW EXECUTE FUNCTION public.zz_fail_alloc();`);
    const rr = await safe(rider(w.c.svc, b.o.id, 'efectivo'));
    await w.c.su.query('DROP TRIGGER zz_fail_alloc ON public.payment_allocations; DROP FUNCTION public.zz_fail_alloc();');
    const fb = await full(w.c, b.o.id);
    assert('R9c: a raw failure of the allocation aborts the WHOLE command: no transaction, no event, no allocation, NO RETIRADO, mirror untouched',
      !!rr.threw && /HARNESS_ALLOCATION_FAILURE/.test(rr.message) && fb.tx.length === 0 && fb.ev.length === 0 && fb.al.length === 0
      && fb.o.estado === 'EN_ENTREGA' && fb.o.cobrado !== true && JSON.stringify(await totals(w.c)) === JSON.stringify(before), { rr, fb: fb.o });
    const ok = await rider(w.c.svc, b.o.id, 'efectivo');
    assert('R9c: the honest retry afterwards records ONE complete payment and the delivery', ok.ok && ok.code === 'OK' && (await full(w.c, b.o.id)).tx.length === 1, ok);
    assert('R9 integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('R10 DELIVERY-TRANSITION FAILURE -- the money never survives a delivery that did not complete (no partial / orphan payment)');
  {
    const w = await H.world(env, { label: 'r10' });
    const { o } = await H.dispatched(w, { totale: 13, id: '#K0101' });
    // Forced LOST RACE: another writer moves the order out of EN_ENTREGA while the rider is inside the canonical writer.
    const other = await w.c.client('brid-r10-other'); const rc = await w.c.client('brid-r10-rider');
    await other.query('BEGIN');
    await other.query("UPDATE public.ordenes SET estado = 'LISTO' WHERE id = $1", [o.id]);
    const p = safe(rider(rc, o.id, 'efectivo'));
    const wait = await lockWait(w.c.su, 'brid-r10-rider');
    await other.query('COMMIT');
    const res = await p;
    const f = await full(w.c, o.id);
    assert('R10 forced: the rider was blocked INSIDE the writer on the order row (not on L0), then lost the race: RIDER_STOP_LOST_RACE (40001) is RAISED',
      !!wait && wait.waiting_locktype !== 'advisory' && res.threw === '40001' && /RIDER_STOP_LOST_RACE/.test(res.message), { wait, res });
    assert('R10 forced: the payment the writer had already written was ROLLED BACK with the command: 0 transaction, 0 allocation, 0 event; mirror untouched',
      f.tx.length === 0 && f.al.length === 0 && f.ev.length === 0 && f.o.cobrado !== true && f.o.estado === 'LISTO', f.o);
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'r10b' });
    const { o } = await H.dispatched(w, { totale: 13, id: '#K0102' });
    await w.c.su.query(`CREATE FUNCTION public.zz_fail_deliver() RETURNS trigger LANGUAGE plpgsql AS $x$
        BEGIN IF NEW.estado = 'RETIRADO' THEN RAISE EXCEPTION 'HARNESS_DELIVERY_FAILURE'; END IF; RETURN NEW; END $x$;
      CREATE TRIGGER zz_fail_deliver BEFORE UPDATE OF estado ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.zz_fail_deliver();`);
    const res = await safe(rider(w.c.svc, o.id, 'efectivo'));
    const f = await full(w.c, o.id);
    assert('R10b: the delivery transition itself fails AFTER the payment was written: the whole command aborts -- 0 transaction, 0 allocation, 0 event, still EN_ENTREGA',
      /HARNESS_DELIVERY_FAILURE/.test(res.message || '') && f.tx.length === 0 && f.al.length === 0 && f.ev.length === 0 && f.o.estado === 'EN_ENTREGA' && f.o.cobrado !== true, { res, o: f.o });
    await w.c.close();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  section('X1 ZERO REACHABILITY + OLD BACKEND -- the legacy writer is gone; the 7-argument call still delivers without money');
  {
    const w = await H.world(env, { label: 'x1' });
    const gone = (await w.c.su.query(`SELECT to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)') IS NULL AS gone,
      (SELECT count(*)::int FROM pg_proc WHERE proname = '_ledger_write_payment') AS any_overload,
      (SELECT count(*)::int FROM pg_proc WHERE prosrc LIKE '%\\_ledger\\_write\\_payment(%') AS callers,
      (SELECT count(*)::int FROM pg_proc WHERE proname = 'rider_collect_and_complete_stop') AS rider_fns`)).rows[0];
    assert('X1: _ledger_write_payment does not exist (no overload), no body calls it, and exactly ONE rider RPC exists', gone.gone && gone.any_overload === 0 && gone.callers === 0 && gone.rider_fns === 1, gone);
    const direct = await safe(w.c.svc.query("SELECT public._ledger_write_payment('#1','efectivo',NULL,'rider','rider','ip','{}'::jsonb,'pay-order-1')"));
    assert('X1: a direct call to the legacy writer fails (function does not exist, 42883)', direct.threw === '42883', direct);
    const { o } = await H.dispatched(w, { totale: 9, id: '#K0111' });
    const r = await rider7(w.c.svc, o.id, '');
    const f = await full(w.c, o.id);
    assert('X1: the 7-argument (old backend) call of a stop WITHOUT money still completes the delivery (OK), no ledger row, no proof needed',
      r.ok === true && r.code === 'OK' && r.payment === null && f.o.estado === 'RETIRADO' && f.tx.length === 0 && f.ev.length === 0 && f.o.cobrado !== true, r);
    await w.c.close();
  }

  section('X2 CUTOVER -- an order already collected the OLD way (event-only, before 140) can never be collected a second time the new way');
  {
    const w = await H.world(pre140, { label: 'x2-cutover' });
    const { o } = await H.dispatched(w, { totale: 17, id: '#K0121' });
    const old = await rider7(w.c.svc, o.id, 'efectivo');
    assert('X2 setup (pre-140): the legacy writer recorded an event-only payment', old.ok === true && (await full(w.c, o.id)).ev.length === 1 && (await full(w.c, o.id)).tx.length === 0, old);
    await env.applyRepoAsPostgres(w.c.su, env.BRID_FWD);          // 140 applied on THIS database, with the legacy row in it
    const again = await rider(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('X2: after 140 the rider retry is IDEMPOTENT with ORDER_PAYMENT_ALREADY_SETTLED -- the canonical writer counts the legacy event (no second payment)',
      again.ok === true && again.code === 'IDEMPOTENT' && again.payment === null && again.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && f.ev.length === 1 && f.tx.length === 0, again);
    const cash = await safe(H.cashPay(w.c.svc, await H.wsOf(w.c), o));
    assert('X2: an operator Cash V1 payment of the same order is refused too (ORDER_PAYMENT_ALREADY_SETTLED)', /ORDER_PAYMENT_ALREADY_SETTLED/.test(cash.message || ''), cash);
    assert('X2: the historical event-only row is untouched (append-only, not rewritten, not backfilled)', (await full(w.c, o.id)).ev[0].payment_transaction_id === null);
    await w.c.close();
  }
  {
    // An order DEPARTED before 140 and collected after it: the in-flight trip is collected canonically.
    const w = await H.world(pre140, { label: 'x2-inflight' });
    const { o } = await H.dispatched(w, { totale: 11, id: '#K0122' });
    await env.applyRepoAsPostgres(w.c.su, env.BRID_FWD);
    const r = await rider(w.c.svc, o.id, 'tarjeta');
    const f = await full(w.c, o.id);
    assert('X2: an in-flight trip (departed before 140) is collected after it through the canonical writer: tx + allocation + event, receipt A, as the rider',
      r.ok === true && f.tx.length === 1 && f.al.length === 1 && f.ev.length === 1 && f.tx[0].service_session_id === w.s && f.ev[0].event_service_session_id === w.s && f.tx[0].by_role === 'rider', f.tx);
    await w.c.close();
  }

  section('X3 OPERATOR FIRST / RIDER FIRST -- both directions, at most ONE payment; delivery vs payment stay two facts');
  {
    const w = await H.world(env, { label: 'x3' });
    const ws = await H.wsOf(w.c);
    const a = await H.dispatched(w, { totale: 10, id: '#K0131' });
    const rFirst = await rider(w.c.svc, a.o.id, 'efectivo');
    const opAfter = await H.opConfirm(w.c.svc, a.o.id, H.PAY());
    const cashAfter = await safe(H.cashPay(w.c.svc, ws, a.o));
    assert('X3 rider first: the operator confirmation afterwards is IDEMPOTENT with ORDER_PAYMENT_ALREADY_SETTLED, a standalone Cash V1 payment is refused -- ONE payment (the rider\'s)',
      rFirst.code === 'OK' && opAfter.ok === true && opAfter.code === 'IDEMPOTENT' && opAfter.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED'
      && /ORDER_PAYMENT_ALREADY_SETTLED/.test(cashAfter.message || '') && (await full(w.c, a.o.id)).tx.length === 1 && (await full(w.c, a.o.id)).tx[0].by_role === 'rider', { opAfter, cashAfter });
    await H.closeTrip(w.c.svc, null).catch(() => {});
    const b = await H.dispatched(w, { totale: 10, id: '#K0132' });
    const nomoney = await rider(w.c.svc, b.o.id, '');
    const fb = await full(w.c, b.o.id);
    assert('X3 delivery WITHOUT money: RETIRADO, 0 ledger rows, unpaid = the full obligation (delivered + unpaid is a valid state)',
      nomoney.ok && nomoney.code === 'OK' && fb.o.estado === 'RETIRADO' && fb.tx.length === 0 && fb.ev.length === 0 && fb.unpaid === 10 && fb.o.cobrado !== true, fb.o);
    const later = await rider(w.c.svc, b.o.id, 'bizum');
    const fb2 = await full(w.c, b.o.id);
    assert('X3 the money reported LATER on the already-delivered stop (replay branch): ONE canonical payment, the delivery fact is not repeated',
      later.ok && later.code === 'IDEMPOTENT' && later.payment && later.payment.idempotent === false && fb2.tx.length === 1 && fb2.tx[0].by_role === 'rider' && fb2.unpaid === 0, later);
    assert('X3 integrity', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }

  section('X4 AMOUNT -- a commercial adjustment (canonical outstanding 9 < presented totale 12) is REFUSED for the rider (B1); the client cannot supply an amount');
  {
    const w = await H.world(env, { label: 'x4' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#K0141' });
    await adjustTo(w.c, ws, o, w.s, 9);
    const before = await totals(w.c);
    const r = await rider(w.c.svc, o.id, 'efectivo', { meta: JSON.stringify({ amount: 1, source: 'servicio_dashboard' }) });
    const f = await full(w.c, o.id);
    assert('X4 (B1): the rider is REFUSED (RIDER_PAYMENT_AMOUNT_MISMATCH): the ledger would have recorded 9.00 while the app presented 12.00; no client amount is honoured either',
      isMismatch(r) && f.tx.length === 0 && f.ev.length === 0 && f.al.length === 0 && f.unpaid === 9 && f.o.estado === 'EN_ENTREGA' && JSON.stringify(await totals(w.c)) === JSON.stringify(before), { r, tx: f.tx.length });
    await w.c.close();
  }
  {
    const w = await H.world(pre140, { label: 'x4-pre' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#K0142' });
    await w.c.su.query(`INSERT INTO public.order_obligations (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, source, cause, reason, by_actor, by_role)
                        VALUES ($1, $2, $3, $4, 2, 9, 'order_commercial_adjustment_v1', 'harness', 'harness adjustment', 'owner', 'admin')`, [o.order_uid, o.id, w.s, ws]);
    const r = await rider7(w.c.svc, o.id, 'efectivo');
    assert('X4 contrast (pre-140): the legacy writer REFUSED the adjusted order (PAYMENT_REFUSED / LEGACY_COLLECTION_NOT_ALLOWED): the rider could not deliver it with money',
      r.ok === false && r.code === 'PAYMENT_REFUSED' && r.payment_code === 'LEGACY_COLLECTION_NOT_ALLOWED', r);
    await w.c.close();
  }

  section('B1 AMOUNT PARITY -- the rider records a payment ONLY when the canonical outstanding equals the amount the app presented (ordenes.totale); residual 0 stays a delivery-only case');
  {
    // R1: totale == residual -> success.
    const w = await H.world(env, { label: 'b1-r1' });
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB101' });
    const r = await rider(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('B1-R1: totale 12 = residual 12 -> the rider payment of 12.00 succeeds and the order is delivered in the same command',
      r.ok === true && r.code === 'OK' && r.payment && n(r.payment.amount) === 12 && f.tx.length === 1 && f.al.length === 1 && f.ev.length === 1 && n(f.tx[0].amount) === 12 && f.o.estado === 'RETIRADO', r);
    await w.c.close();
  }
  {
    // R2 + R5: commercial adjustment 12 -> 9: refused, nothing written, not delivered; every retry refuses again, no duplication.
    const w = await H.world(env, { label: 'b1-r2' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB102' });
    await adjustTo(w.c, ws, o, w.s, 9);
    const before = await totals(w.c);
    const r = await rider(w.c.svc, o.id, 'efectivo');
    assert('B1-R2: totale 12, adjusted residual 9 -> PAYMENT_REFUSED / RIDER_PAYMENT_AMOUNT_MISMATCH (typed, distinguishable)', isMismatch(r), r);
    assert('B1-R2: ZERO new writes (no transaction, allocation or financial event), the order is NOT delivered (EN_ENTREGA), mirror untouched, trip still ACTIVE', await stopUntouched(w, o.id, before), await full(w.c, o.id));
    const retry = await rider(w.c.svc, o.id, 'efectivo');
    const other = await rider(w.c.svc, o.id, 'tarjeta');
    const [t1, t2] = await Promise.all([rider(w.c.svc, o.id, 'efectivo'), rider(w.c.svc, o.id, 'bizum')]);
    assert('B1-R5: a retry, a retry with another method and a concurrent double tap keep refusing with the SAME typed code (a mismatch never becomes idempotent success, never a conflict)',
      isMismatch(retry) && isMismatch(other) && isMismatch(t1) && isMismatch(t2), { retry, other, t1, t2 });
    assert('B1-R5: still ZERO writes after 4 more attempts (no duplication), still EN_ENTREGA', await stopUntouched(w, o.id, before), await totals(w.c));
    assert('B1-R2: the refusal is distinguishable from the already-settled tolerance and from the context/forbidden refusals',
      r.payment_code !== 'ORDER_PAYMENT_ALREADY_SETTLED' && r.payment_code !== 'ORDER_PAYMENT_FORBIDDEN' && r.code !== 'PAYMENT_CONTEXT_UNAVAILABLE', r);
    // control: the debt IS settled by the operator at the canonical residual, then the rider only confirms the delivery.
    await H.cashPay(w.c.svc, ws, o);
    const done = await rider(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('B1-R4 (after an adjustment): residual settled by the operator (9.00) -> the rider delivers with NO new payment (ALREADY_SETTLED), the only transaction is the operator\'s',
      done.ok === true && done.code === 'OK' && done.payment === null && done.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && f.tx.length === 1 && f.tx[0].by_role === 'operator'
      && n(f.tx[0].amount) === 9 && f.o.estado === 'RETIRADO', { done, tx: f.tx.map((t) => [t.by_role, n(t.amount)]) });
    assert('B1 integrity (adjusted)', intact(await integrity(w.c)), await integrity(w.c));
    await w.c.close();
  }
  {
    // R3: operator already paid 6 of 12 -> residual 6: refused, nothing written, not delivered.
    const w = await H.world(env, { label: 'b1-r3' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB103' });
    await H.cashPay(w.c.svc, ws, o, { mode: 'custom_amount', amount: 6, method: 'efectivo' });
    const before = await totals(w.c);
    const r = await rider(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('B1-R3: totale 12, operator already paid 6 (residual 6) -> RIDER_PAYMENT_AMOUNT_MISMATCH; the operator\'s 6.00 is the only money fact; ZERO new writes; not delivered',
      isMismatch(r) && f.tx.length === 1 && f.tx[0].by_role === 'operator' && (await stopUntouched(w, o.id, before)), { r, tx: f.tx.map((t) => [t.by_role, n(t.amount)]) });
    await w.c.close();
  }
  {
    // R4: already fully settled -> no new payment, delivery completed (distinct from a mismatch).
    const w = await H.world(env, { label: 'b1-r4' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB104' });
    await H.cashPay(w.c.svc, ws, o);
    const before = await totals(w.c);
    const r = await rider(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('B1-R4: totale 12 already fully settled (residual 0) is NOT a mismatch: no new payment / allocation / event, NO rider collection attributed, and the delivery IS completed',
      r.ok === true && r.code === 'OK' && r.payment === null && r.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && JSON.stringify(await totals(w.c)) === JSON.stringify(before)
      && f.tx.length === 1 && f.tx[0].by_role === 'operator' && f.o.estado === 'RETIRADO' && f.ev.length === 1, { r, f: f.o });
    await w.c.close();
  }
  {
    // R6: a mismatch arising CONCURRENTLY with an operator payment: the rider waits inside the canonical writer for the
    // operator's transaction, then judges the residual it finds -- never a false rider collection.
    const w = await H.world(env, { label: 'b1-r6a' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB106' });
    const t1 = await w.c.client('brid-b1-cash'); const t2 = await w.c.client('brid-b1-rider');
    await t1.query('BEGIN');
    await H.cashPay(t1, ws, o, { mode: 'custom_amount', amount: 6, method: 'efectivo' });
    const p = safe(rider(t2, o.id, 'efectivo'));
    const wait = await lockWait(w.c.su, 'brid-b1-rider');
    await t1.query('COMMIT');
    const res = await p;
    const f = await full(w.c, o.id);
    assert('B1-R6: the rider blocked behind an operator partial payment (6 of 12) then finds residual 6 != 12 -> RIDER_PAYMENT_AMOUNT_MISMATCH; no rider collection exists; not delivered',
      !!wait && isMismatch(res) && f.tx.length === 1 && f.tx[0].by_role === 'operator' && f.tx.every((t) => t.by_role !== 'rider') && f.o.estado === 'EN_ENTREGA', { wait, res, tx: f.tx.map((t) => [t.by_role, n(t.amount)]) });
    await w.c.close();
  }
  {
    const w = await H.world(env, { label: 'b1-r6b' });
    const ws = await H.wsOf(w.c);
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB107' });
    await adjustTo(w.c, ws, o, w.s, 9);
    const t1 = await w.c.client('brid-b1-cash2'); const t2 = await w.c.client('brid-b1-rider2');
    await t1.query('BEGIN');
    await H.cashPay(t1, ws, o);
    const p = safe(rider(t2, o.id, 'efectivo'));
    const wait = await lockWait(w.c.su, 'brid-b1-rider2');
    await t1.query('COMMIT');
    const res = await p;
    const f = await full(w.c, o.id);
    assert('B1-R6: the rider blocked behind the operator\'s FULL payment of the adjusted residual (9) finds residual 0 -> ALREADY_SETTLED tolerance: delivered, NO rider collection, one transaction (the operator\'s)',
      !!wait && res.ok === true && res.code === 'OK' && res.payment === null && res.payment_note === 'ORDER_PAYMENT_ALREADY_SETTLED' && f.tx.length === 1 && f.tx[0].by_role === 'operator' && f.o.estado === 'RETIRADO', { wait, res });
    await w.c.close();
  }
  {
    // R10: response lost AFTER COMMIT -> the retry is the same idempotent replay; the guard never turns a recorded fact into a refusal.
    const w = await H.world(env, { label: 'b1-r10' });
    const { o } = await H.dispatched(w, { totale: 12, id: '#KB110' });
    const t = await w.c.client('brid-b1-lost');
    await t.query('BEGIN');
    const first = await rider(t, o.id, 'efectivo');
    await t.query('COMMIT');                       // ...the rider never saw this response
    const retry = await rider(w.c.svc, o.id, 'efectivo');
    const f = await full(w.c, o.id);
    assert('B1-R10: response lost after COMMIT -> the retry is IDEMPOTENT with the SAME transaction id; still ONE transaction / allocation / event',
      first.code === 'OK' && retry.ok === true && retry.code === 'IDEMPOTENT' && retry.payment && retry.payment.transactionId === first.payment.transactionId
      && f.tx.length === 1 && f.al.length === 1 && f.ev.length === 1, { first, retry });
    await w.c.close();
  }

  section('X5 ATTESTATION HYGIENE -- transaction-local, cleared after the call, never left behind by a refusal');
  {
    const w = await H.world(env, { label: 'x5' });
    const ws = await H.wsOf(w.c);
    const a = await H.dispatched(w, { totale: 10, id: '#K0151' });
    const other = await w.mk({ estado: 'RETIRADO', totale: 5, id: '#K0151Z' });
    const t = await w.c.client('brid-x5');
    await t.query('BEGIN');
    const r = await rider(t, a.o.id, 'efectivo');
    const g = (await t.query("SELECT current_setting('ladieci.rider_payment_attestation', true) AS v")).rows[0].v;
    const next = await safe(directWriter(t, ws, other));
    await t.query('ROLLBACK');
    assert('X5: inside the SAME transaction, right after a successful rider collection, the attestation is already cleared and a second (direct) rider payment is FORBIDDEN',
      r.code === 'OK' && (g === '' || g === null) && next.threw === '42501', { g, next });
    const t2 = await w.c.client('brid-x5b');
    await t2.query('BEGIN');
    const refused = await rider(t2, a.o.id, 'tarjeta', { meta: JSON.stringify({ token: 'x' }) });
    const g2 = (await t2.query("SELECT current_setting('ladieci.rider_payment_attestation', true) AS v")).rows[0].v;
    await t2.query('ROLLBACK');
    assert('X5: after a REFUSED collection the attestation is not left set (rolled back with the subtransaction)', refused.code === 'PAYMENT_REFUSED' && (g2 === '' || g2 === null), { refused, g2 });
    await w.c.close();
  }

  section('X7 ROLLBACK against REAL rider money: refused (typed, nothing changes) while a rider-authored transaction exists');
  {
    const w = await H.world(env, { label: 'x7' });
    const { o } = await H.dispatched(w, { totale: 10, id: '#K0171' });
    const r = await rider(w.c.svc, o.id, 'efectivo');
    const fp0 = await env.catalogFingerprint(w.c.su);
    let err = null;
    try { await env.applyRepoAsPostgres(w.c.su, env.BRID_RBK); } catch (e) { err = e; }
    assert('X7: with a rider-authored transaction the 140 rollback is REFUSED with the typed message (append-only money facts), not a raw constraint error',
      r.code === 'OK' && !!err && /B_RID_1 rollback refused: 1 payment transaction\(s\) authored by a rider exist/.test(err.message), err && err.message);
    assert('X7: the refused rollback changed NOTHING (catalog fingerprint identical; the rider payment intact)',
      env.fingerprintDiff(fp0, await env.catalogFingerprint(w.c.su)).length === 0 && (await full(w.c, o.id)).tx.length === 1, env.fingerprintDiff(fp0, await env.catalogFingerprint(w.c.su)));
    await w.c.close();
  }

  section('X6 RIDER AUTHORITY BOUNDS -- stale session, inactive rider, no trip: typed refusals that write nothing');
  {
    const w = await H.world(env, { label: 'x6' });
    const { o } = await H.dispatched(w, { totale: 10, id: '#K0161' });
    const before = await totals(w.c);
    const stale = await rider(w.c.svc, o.id, 'efectivo', { sv: 2 });
    await w.c.su.query("UPDATE public.auth_actors SET active = false WHERE actor = 'rider'");
    const inactive = await rider(w.c.svc, o.id, 'efectivo');
    await w.c.su.query("UPDATE public.auth_actors SET active = true WHERE actor = 'rider'");
    await H.closeTrip(w.c.svc, null).catch(() => {});
    const trip = await H.tripStatus(w.c);
    assert('X6: stale session -> AUTH_SESSION_STALE; inactive rider -> AUTH_INITIATOR_INACTIVE; nothing written, the order still EN_ENTREGA',
      stale.code === 'AUTH_SESSION_STALE' && inactive.code === 'AUTH_INITIATOR_INACTIVE' && JSON.stringify(await totals(w.c)) === JSON.stringify(before)
      && (await H.orderEstado(w.c, o.id)) === 'EN_ENTREGA', { stale, inactive, trip });
    await w.c.close();
  }
}

module.exports = { run };
