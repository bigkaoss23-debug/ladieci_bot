'use strict';
// S2-7D6E2 — operator COLLECTION regression scenarios, end to end across the real
// registrar + real financialService + real financialDao, over an in-memory ledger that
// enforces the SQL invariants committed in
//   migrations/2026-07-15_b7_financial_ledger_foundation.sql  (scope uniqueness)
//   migrations/2026-07-26_two_service_identity.sql            (SESSION-SCOPED uniqueness)
//
// Run: node tests/operatorCollectionScenarios.test.js
//
// Nothing is mocked above the RPC boundary: buildIdemScopeKey, the auth-context
// resolution, the digest/replay decision and the basis-uniqueness rule are all the real
// code paths. The fake `rpc` is the ONLY seam, and it re-implements exactly the two SQL
// uniqueness rules the migration installs:
//   UNIQUE (service_session_id, order_id, type, idem_scope_key)   -> replay or conflict
//   UNIQUE (service_session_id, order_id) WHERE type IN (payment, payment_imported)
// Rows with a NULL service_session_id live in their own partial indexes and are NEVER
// rewritten here — legacy stays legacy.
//
// Invariants under test: payment is separate from operative state; a failed collection
// leaves the order exactly where it was; the frontend/caller can never derive
// "collected" from a boolean nobody set; idempotency is SESSION-scoped.

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createOperatorPaymentRegistrar } = require('../src/financial/registerOperatorPayment');
const { createFinancialService } = require('../src/auth/financialService');
const { createFinancialDao, FinancialDaoError, RECOGNIZED_DOMAIN_CODES,
  INTERNAL_ERROR_CODE } = require('../src/auth/financialDao');

const DOMAIN = new Set(RECOGNIZED_DOMAIN_CODES);

const SESSION_A = '00000000-0000-4000-8000-0000000000aa';
const SESSION_B = '00000000-0000-4000-8000-0000000000bb';
const OP_CTX = Object.freeze({ actor: 'operator_primary', role: 'operator', sv: 3 });
const RIDER_CTX = Object.freeze({ actor: 'rider', role: 'rider', sv: 3 });
const IP = '203.0.113.7';

// ── in-memory ledger reproducing the committed SQL rules ──────────────────────
function makeLedger(seed = {}) {
  const events = [];              // order_financial_events
  const orders = new Map();       // ordenes
  let seq = 0;
  let failNextWith = null;        // simulated transport failure
  let dropNextResponse = false;   // row is written, the answer never comes back

  for (const [id, o] of Object.entries(seed)) {
    orders.set(id, Object.assign({
      id, totale: 12, estado: 'LISTO', metodo_pago: null,
      cobrado: false, ya_pagado: null, service_session_id: SESSION_A, session_version: 3,
    }, o));
  }

  // Digest over the canonical facts SQL hashes: order, type, amount, method.
  const digestOf = (orderId, type, amount, method) =>
    JSON.stringify([orderId, type, Number(amount).toFixed(2), method === undefined ? null : method]);

  // Mirrors financialDao.defaultRpc: a RECOGNIZED SQL marker stays distinguishable,
  // anything else (transport, timeout, unknown) collapses to one internal error.
  function boom(code) { throw new FinancialDaoError(DOMAIN.has(code) ? code : INTERNAL_ERROR_CODE); }

  function rpc(fn, args) {
    if (failNextWith) { const c = failNextWith; failNextWith = null; boom(c); }

    const order = orders.get(args.p_order_id);
    if (!order) boom('AUTH_ORDER_NOT_FOUND');
    if (order.session_version !== args.p_session_version) boom('AUTH_SESSION_STALE');
    const sid = order.service_session_id;

    let type, amount, method;
    if (fn === 'order_mark_paid') {
      // Pre-ledger booleans on an order with no ledger row: SQL demands an explicit
      // legacy import instead of silently double-counting.
      const hasEvent = events.some((e) => e.service_session_id === sid && e.order_id === order.id);
      if (!hasEvent && (order.cobrado === true || order.ya_pagado === true)) boom('AUTH_LEGACY_IMPORT_REQUIRED');
      type = 'payment'; amount = order.totale; method = args.p_payment_method;
    } else if (fn === 'order_refund') {
      const basis = events.find((e) => e.service_session_id === sid && e.order_id === order.id && e.type === 'payment');
      if (!basis) boom('AUTH_NO_PAYMENT_BASIS');
      type = 'refund'; amount = basis.amount; method = basis.payment_method;   // SQL-derived
    } else {
      boom('FINANCIAL_INTERNAL_ERROR');
    }

    const digest = digestOf(order.id, type, amount, method);

    // UNIQUE (service_session_id, order_id, type, idem_scope_key)
    const same = events.find((e) => e.service_session_id === sid && e.order_id === order.id
      && e.type === type && e.idem_scope_key === args.p_idem_scope_key);
    if (same) {
      if (same.digest !== digest) boom('AUTH_IDEMPOTENCY_CONFLICT');
      return Object.assign({}, same.result, { idempotent: true });          // pure replay
    }

    // UNIQUE (service_session_id, order_id) WHERE type IN ('payment','payment_imported')
    if (type === 'payment' && events.some((e) => e.service_session_id === sid
      && e.order_id === order.id && e.type === 'payment')) boom('AUTH_BASIS_EXISTS');
    if (type === 'refund' && events.some((e) => e.service_session_id === sid
      && e.order_id === order.id && e.type === 'refund')) boom('AUTH_ALREADY_REFUNDED');

    const result = {
      event_id: 'ev' + (++seq), order_id: order.id, type, amount,
      payment_method: method === undefined ? null : method, idempotent: false,
    };
    events.push({ service_session_id: sid, order_id: order.id, type, amount,
      payment_method: result.payment_method, idem_scope_key: args.p_idem_scope_key, digest, result });

    // SQL sets the legacy booleans under the same lock — the ledger stays authoritative.
    if (type === 'payment') { order.cobrado = true; order.ya_pagado = true; order.metodo_pago = method; }

    if (dropNextResponse) { dropNextResponse = false; boom('NETWORK'); }      // committed, answer lost
    return result;
  }

  return {
    events, orders,
    countPayments: (orderId, sid) => events.filter((e) => e.order_id === orderId
      && e.type === 'payment' && (sid === undefined || e.service_session_id === sid)).length,
    failNext: (code) => { failNextWith = code || 'NETWORK'; },
    dropResponse: () => { dropNextResponse = true; },
    rpc,
  };
}

const registrarOver = (ledger) => createOperatorPaymentRegistrar({
  financialService: createFinancialService({
    dao: createFinancialDao({ rpc: (fn, args) => Promise.resolve().then(() => ledger.rpc(fn, args)) }),
    ipHash: () => 'iphash-fixed',
  }),
});

// NOTE: no default parameter for ctx — `undefined` must reach the registrar verbatim,
// because "the legacy guard is disabled so req.authCtx is undefined" is scenario 13.
const collect = (reg, orderId, method, ...rest) =>
  reg.registerPayment({ orderId, paymentMethod: method,
    authCtx: rest.length ? rest[0] : OP_CTX, trustedClientIp: IP, origin: 'entregas' });

// ── 1. double click ───────────────────────────────────────────────────────────
(async () => {
  console.log('\n[1] double click — two rapid submissions of the same collection');
  const L = makeLedger({ '#723': {} });
  const reg = registrarOver(L);
  const [a, b] = await Promise.all([collect(reg, '#723', 'efectivo'), collect(reg, '#723', 'efectivo')]);
  assert('both clicks report success', a.ok === true && b.ok === true, JSON.stringify([a, b]));
  assert('EXACTLY ONE ledger event', L.countPayments('#723') === 1, String(L.countPayments('#723')));
  assert('exactly one of the two is the real write', [a.idempotent, b.idempotent].filter((x) => x === false).length === 1);
  assert('the other is a flagged replay', [a.idempotent, b.idempotent].filter((x) => x === true).length === 1);
  assert('collected amount is the order total, never caller-supplied', L.events[0].amount === 12);

  // ── 2. retry after a network failure ────────────────────────────────────────
  console.log('\n[2] retry after a network failure');
  const L2 = makeLedger({ '#800': {} });
  const reg2 = registrarOver(L2);
  L2.failNext('NETWORK');                                     // dies BEFORE the insert
  const r1 = await collect(reg2, '#800', 'efectivo');
  assert('transport failure is a FAILURE, not a silent success', r1.ok === false, JSON.stringify(r1));
  assert('failure carries no result the caller could read as paid', r1.result === undefined);
  assert('nothing was written', L2.countPayments('#800') === 0, String(L2.countPayments('#800')));
  const r2 = await collect(reg2, '#800', 'efectivo');
  assert('retry succeeds', r2.ok === true, JSON.stringify(r2));
  assert('one event after the retry', L2.countPayments('#800') === 1, String(L2.countPayments('#800')));

  const L3 = makeLedger({ '#801': {} });
  const reg3 = registrarOver(L3);
  L3.dropResponse();                                          // row COMMITTED, answer lost
  const d1 = await collect(reg3, '#801', 'efectivo');
  assert('lost-answer attempt reads as failure (fail closed)', d1.ok === false, JSON.stringify(d1));
  assert('but the row is on disk', L3.countPayments('#801') === 1);
  const d2 = await collect(reg3, '#801', 'efectivo');
  assert('the retry REPLAYS instead of double-charging', d2.ok === true && d2.idempotent === true, JSON.stringify(d2));
  assert('still exactly ONE ledger event', L3.countPayments('#801') === 1, String(L3.countPayments('#801')));

  // ── 3. HTTP error from the payment endpoint → no partial state ──────────────
  console.log('\n[3] endpoint error — no partial state, order not collected');
  const L4 = makeLedger({ '#802': {} });
  const reg4 = registrarOver(L4);
  L4.failNext('AUTH_SESSION_STALE');
  const e1 = await collect(reg4, '#802', 'efectivo');
  assert('typed SQL code reaches the caller', e1.ok === false && e1.code === 'AUTH_SESSION_STALE', JSON.stringify(e1));
  assert('zero ledger rows', L4.events.length === 0);
  assert('order NOT marked collected', L4.orders.get('#802').cobrado === false);
  assert('order keeps its operative state (payment is separate)', L4.orders.get('#802').estado === 'LISTO');
  assert('no payment method invented', L4.orders.get('#802').metodo_pago === null);
  const e2 = await collect(reg4, '#802', 'efectivo');
  assert('a later clean attempt still works (nothing was poisoned)', e2.ok === true && e2.idempotent === false);

  // ── 4/5. payment in advance vs payment at pickup ────────────────────────────
  console.log('\n[4/5] anticipated payment vs payment at pickup');
  const L5 = makeLedger({
    '#anticipado': { ya_pagado: true, cobrado: true, metodo_pago: 'efectivo', estado: 'EN_COCINA' },
    '#alritiro': { estado: 'LISTO' },
  });
  const reg5 = registrarOver(L5);
  const adv = await collect(reg5, '#anticipado', 'efectivo');
  assert('advance-paid order is let through, not re-charged', adv.ok === true && adv.alreadyPaidLegacy === true, JSON.stringify(adv));
  assert('no second ledger event for the advance payment', L5.countPayments('#anticipado') === 0);
  assert('advance path exposes no ledger result', adv.result === undefined);
  const pick = await collect(reg5, '#alritiro', 'efectivo');
  assert('pickup collection writes the ledger', pick.ok === true && pick.idempotent === false, JSON.stringify(pick));
  assert('one event for the pickup collection', L5.countPayments('#alritiro') === 1);
  assert('advance and pickup keep independent keys', L5.events.every((e) => e.order_id === '#alritiro'));

  // ── 6/7. rider cash and rider card ──────────────────────────────────────────
  console.log('\n[6/7] rider cash and rider card');
  const L6 = makeLedger({ '#cash': {}, '#card': {} });
  const reg6 = registrarOver(L6);
  const cash = await collect(reg6, '#cash', 'efectivo', RIDER_CTX);
  const card = await collect(reg6, '#card', 'tarjeta', RIDER_CTX);
  assert('rider cash collection succeeds', cash.ok === true, JSON.stringify(cash));
  assert('rider card collection succeeds', card.ok === true, JSON.stringify(card));
  assert('cash event carries the cash method', L6.events.find((e) => e.order_id === '#cash').payment_method === 'efectivo');
  assert('card event carries the card method', L6.events.find((e) => e.order_id === '#card').payment_method === 'tarjeta');
  assert('one event per order, no cross-contamination', L6.countPayments('#cash') === 1 && L6.countPayments('#card') === 1);
  const cashDup = await collect(reg6, '#cash', 'efectivo', RIDER_CTX);
  assert('rider double tap replays', cashDup.ok === true && cashDup.idempotent === true);
  assert('rider double tap wrote nothing new', L6.countPayments('#cash') === 1);

  // ── 8. refund ───────────────────────────────────────────────────────────────
  console.log('\n[8] refund');
  const L7 = makeLedger({ '#900': {}, '#901': {} });
  const svc7 = createFinancialService({
    dao: createFinancialDao({ rpc: (fn, args) => Promise.resolve().then(() => L7.rpc(fn, args)) }),
    ipHash: () => 'iphash-fixed',
  });
  const reg7 = createOperatorPaymentRegistrar({ financialService: svc7 });
  await collect(reg7, '#900', 'tarjeta');
  const refundArgs = { authContext: { sub: 'operator_primary', role: 'operator', sv: 3 },
    orderId: '#900', reason: 'cliente devolvió el pedido', idempotencyKey: 'refund-order-900', trustedClientIp: IP };
  const rf = await svc7.refund(refundArgs);
  assert('refund succeeds on top of a real basis', rf.ok === true, JSON.stringify(rf));
  assert('refund amount/method are SQL-derived from the basis',
    rf.result.amount === 12 && rf.result.payment_method === 'tarjeta', JSON.stringify(rf.result));
  const rfReplay = await svc7.refund(refundArgs);
  assert('same-key refund replays, it does not refund twice',
    rfReplay.ok === true && rfReplay.result.idempotent === true, JSON.stringify(rfReplay));
  assert('exactly one refund row', L7.events.filter((e) => e.type === 'refund').length === 1);
  assert('the payment basis is untouched by the refund', L7.countPayments('#900') === 1);
  const rfNoBasis = await svc7.refund(Object.assign({}, refundArgs, { orderId: '#901', idempotencyKey: 'refund-order-901' }));
  assert('refund without a basis is refused', rfNoBasis.ok === false && rfNoBasis.code === 'AUTH_NO_PAYMENT_BASIS', JSON.stringify(rfNoBasis));

  // ── 9. "manual" method with NO payment event ────────────────────────────────
  console.log('\n[9] manual method — no payment event, not collected');
  const L8 = makeLedger({ '#manual': {} });
  const reg8 = registrarOver(L8);
  for (const m of ['manual', 'MANUAL', 'otro', '', ' ']) {
    const r = await collect(reg8, '#manual', m);
    assert('non-collection method ' + JSON.stringify(m) + ' is refused', r.ok === false && r.code === 'PAYMENT_METHOD_INVALID', JSON.stringify(r));
  }
  assert('"manual" produced ZERO ledger events', L8.events.length === 0);
  assert('"manual" left the order not collected', L8.orders.get('#manual').cobrado === false);
  assert('"manual" invented no method on the order', L8.orders.get('#manual').metodo_pago === null);

  // ── 10. two sessions, same order id ─────────────────────────────────────────
  console.log('\n[10] same order id across two service sessions');
  const L9 = makeLedger({ '#711': { service_session_id: SESSION_A } });
  const reg9 = registrarOver(L9);
  const s1 = await collect(reg9, '#711', 'efectivo');
  assert('session A collects', s1.ok === true && s1.idempotent === false, JSON.stringify(s1));
  // The order id is recycled into a NEW service session (id reuse across services is real
  // in this schema: ordenes ids restart, storico keeps the archive).
  L9.orders.get('#711').service_session_id = SESSION_B;
  L9.orders.get('#711').cobrado = false; L9.orders.get('#711').ya_pagado = false; L9.orders.get('#711').metodo_pago = null;
  const s2 = await collect(reg9, '#711', 'efectivo');
  assert('session B collection is a REAL write, not a silent replay of session A',
    s2.ok === true && s2.idempotent === false, JSON.stringify(s2));
  assert('session A keeps exactly one payment', L9.countPayments('#711', SESSION_A) === 1);
  assert('session B has its own single payment', L9.countPayments('#711', SESSION_B) === 1);
  assert('the two events are distinct rows', L9.events[0].result.event_id !== L9.events[1].result.event_id);
  assert('idempotency is SESSION-scoped: the same key exists in both sessions',
    L9.events[0].idem_scope_key === L9.events[1].idem_scope_key, L9.events[0].idem_scope_key);
  const s2again = await collect(reg9, '#711', 'efectivo');
  assert('within session B a repeat still replays', s2again.ok === true && s2again.idempotent === true);
  assert('still one payment per session', L9.countPayments('#711', SESSION_A) === 1 && L9.countPayments('#711', SESSION_B) === 1);

  // ── 13. missing req.authCtx → FAIL CLOSED ───────────────────────────────────
  console.log('\n[13] absent/degraded auth context — fail closed');
  const L10 = makeLedger({ '#auth': {} });
  const reg10 = registrarOver(L10);
  const badCtxs = [
    ['undefined (guard disabled)', undefined],
    ['null', null],
    ['empty object', {}],
    ['actor but no session_version', { actor: 'operator_primary', role: 'operator' }],
    ['session_version 0', { actor: 'operator_primary', role: 'operator', sv: 0 }],
    ['session_version as string', { actor: 'operator_primary', role: 'operator', sv: '3' }],
    ['blank actor', { actor: '', role: 'operator', sv: 3 }],
    ['actor derived from a body field', { actor_id: 'operator_primary', sv: 3 }],
  ];
  for (const [label, ctx] of badCtxs) {
    const r = await collect(reg10, '#auth', 'efectivo', ctx);
    assert('fails closed — ' + label, r.ok === false && r.code === 'PAYMENT_CONTEXT_UNAVAILABLE', JSON.stringify(r));
  }
  assert('no ledger call was even attempted without a verified actor', L10.events.length === 0);
  assert('order untouched by every unauthenticated attempt',
    L10.orders.get('#auth').cobrado === false && L10.orders.get('#auth').metodo_pago === null);
  // A forged context that names an actor the role map does not allow must also die,
  // this time inside the service (resolveActor), still without a ledger row.
  const forged = await collect(reg10, '#auth', 'efectivo', { actor: 'owner', role: 'rider', sv: 3 });
  assert('forged role/actor pair is refused', forged.ok === false, JSON.stringify(forged));
  assert('forged attempt wrote nothing', L10.events.length === 0);
  const unknownActor = await collect(reg10, '#auth', 'efectivo', { actor: 'not_an_actor', role: 'operator', sv: 3 });
  assert('unknown actor is refused', unknownActor.ok === false && unknownActor.code === 'FINANCIAL_UNAUTHENTICATED', JSON.stringify(unknownActor));
  assert('unknown actor wrote nothing', L10.events.length === 0);

  console.log('');
  console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
