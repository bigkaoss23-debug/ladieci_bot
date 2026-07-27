'use strict';
// S2-7D6E3 — proves the session-scoping fix to public._ledger_write_payment
// (migrations/2026-07-27_s2_7d6e2_rider_delivery_collection.sql) actually closes the bug
// found while auditing S2-7D6E2's idempotency contract: order id/number "723" recycled
// across two DIFFERENT service sessions must never let session B read a false replay of
// session A's payment, and must never raise a spurious AUTH_IDEMPOTENCY_CONFLICT either.
//
// This is a FAITHFUL line-for-line JS port of the actual (post-fix) SQL body — same two
// lookup queries (now scoped by `service_session_id IS NOT DISTINCT FROM v_ord.service_session_id`),
// same digest canonicalization/comparison — run against an in-memory table, NOT against
// real Postgres. Labelled honestly: this proves the SQL TEXT's own logic is internally
// consistent under these scenarios; it does not substitute for a real-Postgres run.
//
// Run: node tests/ledgerWritePaymentSessionScoping.test.js

const crypto = require('crypto');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + JSON.stringify(detail) : '')); }
};

function digest(canon) {
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// In-memory stand-in for public.order_financial_events + public.ordenes.
function makeDb() {
  const events = [];
  let nextId = 1;
  return {
    events,
    ordenes: new Map(),
    insertEvent(row) {
      const withId = Object.assign({ id: nextId++, created_at: nextId }, row);
      events.push(withId);
      return withId;
    },
  };
}

// Faithful port of public._ledger_write_payment AFTER the S2-7D6E3 session-scoping fix.
function ledgerWritePayment(db, orderId, { paymentMethod, reason, byActor, byRole, ipHash, meta, idemScopeKey }) {
  const vMeta = meta || {};
  if (!ipHash) throw new Error('AUTH_IP_HASH_REQUIRED');
  if (!idemScopeKey || idemScopeKey.length < 8) throw new Error('AUTH_IDEM_KEY_INVALID');

  const vMethod = String(paymentMethod || '').toLowerCase();
  if (!['efectivo', 'tarjeta', 'bizum'].includes(vMethod)) throw new Error('AUTH_METHOD_INVALID');
  if (!byActor) throw new Error('AUTH_ACTOR_NOT_FOUND');
  if (!byRole) throw new Error('AUTH_FORBIDDEN_ROLE');

  const vOrd = db.ordenes.get(orderId);
  if (!vOrd) throw new Error('AUTH_ORDER_NOT_FOUND');

  // FIX: scoped by service_session_id (IS NOT DISTINCT FROM -> null-safe equality).
  const sameScope = (e) => (e.service_session_id ?? null) === (vOrd.service_session_id ?? null);

  const existing = db.events.find(
    (e) => e.order_id === orderId && e.type === 'payment' && e.idem_scope_key === idemScopeKey && sameScope(e)
  );
  if (existing) {
    const replayCanon = {
      order_id: orderId, type: 'payment', idem_scope_key: idemScopeKey,
      by_actor: byActor, by_role: byRole, reason: reason ?? null,
      prev_estado: existing.prev_estado, new_estado: existing.new_estado,
      prev_pay_state: existing.prev_pay_state, new_pay_state: existing.new_pay_state,
      amount: existing.amount, payment_method: vMethod, legacy: false,
    };
    const replayDigest = digest(replayCanon);
    if (existing.payload_digest === replayDigest) {
      return { event_id: existing.id, order_id: existing.order_id, amount: existing.amount,
        payment_method: existing.payment_method, idempotent: true };
    }
    throw new Error('AUTH_IDEMPOTENCY_CONFLICT');
  }

  const vAmount = Math.round(vOrd.totale * 100) / 100;
  if (!(vAmount > 0)) throw new Error('AUTH_AMOUNT_INVALID');

  const canon = {
    order_id: orderId, type: 'payment', idem_scope_key: idemScopeKey,
    by_actor: byActor, by_role: byRole, reason: reason ?? null,
    prev_estado: vOrd.estado, new_estado: vOrd.estado,
    prev_pay_state: 'unpaid', new_pay_state: 'paid',
    amount: vAmount, payment_method: vMethod, legacy: false,
  };
  const dig = digest(canon);

  // FIX: same session-scoping applied to the one-basis-per-order check.
  const existingBasis = db.events
    .filter((e) => e.order_id === orderId && ['payment', 'payment_imported'].includes(e.type) && sameScope(e))
    .sort((a, b) => a.created_at - b.created_at)[0];
  if (existingBasis) throw new Error('AUTH_BASIS_EXISTS');

  if (vOrd.ya_pagado === true || vOrd.cobrado === true) throw new Error('AUTH_LEGACY_IMPORT_REQUIRED');

  const row = db.insertEvent({
    order_id: orderId, type: 'payment', amount: vAmount, payment_method: vMethod,
    reason: reason ?? null, legacy: false, by_actor: byActor, by_role: byRole,
    prev_estado: vOrd.estado, new_estado: vOrd.estado, prev_pay_state: 'unpaid', new_pay_state: 'paid',
    ip_hash: ipHash, meta: vMeta, idem_scope_key: idemScopeKey, payload_digest: dig,
    service_session_id: vOrd.service_session_id ?? null,
  });
  vOrd.ya_pagado = true; vOrd.cobrado = true; vOrd.metodo_pago = vMethod;
  return { event_id: row.id, order_id: row.order_id, amount: row.amount,
    payment_method: row.payment_method, idempotent: false };
}

console.log('\n[scenario: order id "723" recycled across two different service sessions]');
{
  const db = makeDb();
  const SESSION_A = 'session-A-uuid';
  const SESSION_B = 'session-B-uuid';
  db.ordenes.set('723', { totale: 12.50, estado: 'RETIRADO', ya_pagado: false, cobrado: false, service_session_id: SESSION_A });

  const a1 = ledgerWritePayment(db, '723', {
    paymentMethod: 'efectivo', byActor: 'op-alice', byRole: 'operator',
    ipHash: 'iph-a', idemScopeKey: 'pay-order-723',
  });
  check('session A: first payment writes a real event', a1.idempotent === false && a1.amount === 12.50, a1);

  const a2 = ledgerWritePayment(db, '723', {
    paymentMethod: 'efectivo', byActor: 'op-alice', byRole: 'operator',
    ipHash: 'iph-a', idemScopeKey: 'pay-order-723',
  });
  check('session A: retry with the same key replays the SAME event (idempotent)', a2.idempotent === true && a2.event_id === a1.event_id, a2);

  // Session B recycles order id "723": a brand-new ordenes row, different session, different totale.
  db.ordenes.set('723', { totale: 30.00, estado: 'RETIRADO', ya_pagado: false, cobrado: false, service_session_id: SESSION_B });

  const b1 = ledgerWritePayment(db, '723', {
    paymentMethod: 'tarjeta', byActor: 'op-bruno', byRole: 'operator',
    ipHash: 'iph-b', idemScopeKey: 'pay-order-723',
  });
  check('session B: first payment on the RECYCLED id writes its OWN new event, not a replay of session A',
    b1.idempotent === false && b1.event_id !== a1.event_id && b1.amount === 30.00, b1);
  check('session B: amount is session B\'s own order total, not session A\'s stale amount',
    b1.amount === 30.00);

  const b2 = ledgerWritePayment(db, '723', {
    paymentMethod: 'tarjeta', byActor: 'op-bruno', byRole: 'operator',
    ipHash: 'iph-b', idemScopeKey: 'pay-order-723',
  });
  check('session B: retry with the same key replays session B\'s OWN event, not session A\'s',
    b2.idempotent === true && b2.event_id === b1.event_id, b2);

  check('no cross-contamination: exactly 2 real writes total (one per session), not 1',
    db.events.filter((e) => e.idempotent !== true).length === 2 || db.events.length === 2,
    { total: db.events.length });
}

console.log('\n[scenario: same order id, same session, different actor under the same key -> genuine conflict]');
{
  const db = makeDb();
  db.ordenes.set('999', { totale: 8.00, estado: 'RETIRADO', ya_pagado: false, cobrado: false, service_session_id: 'session-C' });
  ledgerWritePayment(db, '999', { paymentMethod: 'efectivo', byActor: 'op-alice', byRole: 'operator', ipHash: 'iph', idemScopeKey: 'pay-order-999' });
  let threw = null;
  try {
    ledgerWritePayment(db, '999', { paymentMethod: 'efectivo', byActor: 'op-bruno', byRole: 'operator', ipHash: 'iph', idemScopeKey: 'pay-order-999' });
  } catch (e) { threw = e.message; }
  check('a different actor under the same key in the SAME session is a genuine conflict, not a silent second charge',
    threw === 'AUTH_IDEMPOTENCY_CONFLICT', threw);
}

console.log('\n[scenario: rider and operator payment on the same order/session]');
{
  const db = makeDb();
  db.ordenes.set('501', { totale: 15.00, estado: 'RETIRADO', ya_pagado: false, cobrado: false, service_session_id: 'session-D' });
  const riderPay = ledgerWritePayment(db, '501', { paymentMethod: 'efectivo', byActor: 'rider-carlos', byRole: 'rider', ipHash: 'iph', idemScopeKey: 'pay-order-501' });
  check('rider collection writes the basis', riderPay.idempotent === false);
  let threw = null;
  try {
    ledgerWritePayment(db, '501', { paymentMethod: 'efectivo', byActor: 'op-alice', byRole: 'operator', ipHash: 'iph', idemScopeKey: 'pay-order-501-op' });
  } catch (e) { threw = e.message; }
  check('an operator payment attempt after the rider already established the basis is refused (one basis per order per session), never a second charge',
    threw === 'AUTH_BASIS_EXISTS', threw);
}

console.log('');
console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
