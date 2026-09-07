'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — unit tests for src/cash/cashService.js.
// Same style as tests/mesaService.test.js: node:test, dependency-injected
// dao/hashSid, no DB, no network.

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const {
  createCashService, CashServiceError, buildCheckAccount,
  ORDER_PAYMENT_ROLES, ORDER_REFUND_ROLES, ORDER_ADJUSTMENT_ROLES,
} = require('../src/cash/cashService');

const ORDER_UID = '11111111-1111-4111-8111-111111111111';
const TX_UID = '22222222-2222-4222-8222-222222222222';

const ctx = (overrides = {}) => ({
  actor: 'operator_primary', role: 'operator', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'high-entropy-session-id', ...overrides,
});

// ── ROLE GATES — preserve the EXISTING narrower Servicio gate, no Mesa widening ──

test('payment role gate is admin/operator ONLY, not Mesa\'s broader PAYMENT_ROLES', () => {
  assert.deepEqual([...ORDER_PAYMENT_ROLES].sort(), ['admin', 'operator']);
});
test('refund role gate is admin/owner, identical to Mesa REFUND_ROLES', () => {
  assert.deepEqual([...ORDER_REFUND_ROLES].sort(), ['admin', 'owner']);
});
test('adjustment role gate is admin/owner, identical to Mesa ADJUSTMENT_ROLES', () => {
  assert.deepEqual([...ORDER_ADJUSTMENT_ROLES].sort(), ['admin', 'owner']);
});

test('a cashier cannot post a check-centric payment (Mesa allows cashier; Servicio must not)', async () => {
  const service = createCashService({ dao: {} });
  await assert.rejects(
    service.pay({ context: ctx({ role: 'cashier' }), orderUid: ORDER_UID, paymentMethod: 'efectivo', mode: 'full', clientRequestId: 'req-00000001' }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_FORBIDDEN',
  );
});

test('operator CAN post a check-centric payment (preserves the existing gate)', async () => {
  let args;
  const service = createCashService({
    dao: { postPayment: async (value) => { args = value; return { ok: true }; } },
    hashSid: () => 'a'.repeat(64),
  });
  await service.pay({ context: ctx({ role: 'operator' }), orderUid: ORDER_UID, paymentMethod: 'efectivo', mode: 'full', clientRequestId: 'req-00000001' });
  assert.equal(args.orderUid, ORDER_UID);
});

test('owner cannot post a payment (payment gate is narrower than refund/adjustment gates)', async () => {
  const service = createCashService({ dao: {} });
  await assert.rejects(
    service.pay({ context: ctx({ role: 'owner' }), orderUid: ORDER_UID, paymentMethod: 'efectivo', mode: 'full', clientRequestId: 'req-00000001' }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_FORBIDDEN',
  );
});

test('operator cannot refund (refund is admin/owner only — segregation of duties)', async () => {
  const service = createCashService({ dao: {} });
  await assert.rejects(
    service.refund({ context: ctx({ role: 'operator' }), orderUid: ORDER_UID, originalTransactionId: TX_UID, reason: 'test', clientRequestId: 'req-00000002' }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_FORBIDDEN',
  );
});

test('operator cannot apply a commercial adjustment (admin/owner only)', async () => {
  const service = createCashService({ dao: {} });
  await assert.rejects(
    service.commercialAdjustment({ context: ctx({ role: 'operator' }), orderUid: ORDER_UID, newGross: 50, reason: 'test', clientRequestId: 'req-00000003' }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_FORBIDDEN',
  );
});

test('admin CAN refund and adjust', async () => {
  let refundArgs, adjustArgs;
  const service = createCashService({
    dao: {
      postRefund: async (v) => { refundArgs = v; return { ok: true }; },
      postCommercialAdjustment: async (v) => { adjustArgs = v; return { ok: true }; },
    },
    hashSid: () => 'a'.repeat(64),
  });
  await service.refund({ context: ctx({ role: 'admin' }), orderUid: ORDER_UID, originalTransactionId: TX_UID, reason: 'error de cobro', clientRequestId: 'req-00000004' });
  await service.commercialAdjustment({ context: ctx({ role: 'admin' }), orderUid: ORDER_UID, newGross: 60, reason: 'descuento', clientRequestId: 'req-00000005' });
  assert.equal(refundArgs.orderUid, ORDER_UID);
  assert.equal(adjustArgs.newGross, 60);
});

// ── SID_HASH / IDEMPOTENCY ──

test('payment hashes the trusted session id, never trusts a client-supplied hash', async () => {
  let args;
  const hashSid = (sid) => crypto.createHash('sha256').update(String(sid)).digest('hex');
  const service = createCashService({
    dao: { postPayment: async (value) => { args = value; return { ok: true }; } },
    hashSid,
  });
  await service.pay({ context: ctx({ sid: 'session-xyz' }), orderUid: ORDER_UID, paymentMethod: 'tarjeta', mode: 'full', clientRequestId: 'req-00000006' });
  assert.equal(args.bySidHash, hashSid('session-xyz'));
  assert.notEqual(args.bySidHash, hashSid('a-different-session'));
});

test('missing sid on the context is refused before any DAO call (CASH_RELOGIN_REQUIRED)', async () => {
  const service = createCashService({ dao: { postPayment: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    service.pay({ context: ctx({ sid: null }), orderUid: ORDER_UID, paymentMethod: 'efectivo', mode: 'full', clientRequestId: 'req-00000007' }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_RELOGIN_REQUIRED',
  );
});

test('requestHash is a canonical, order-independent hash of the semantic payload (two identical payments get the same hash)', async () => {
  const seen = [];
  const service = createCashService({
    dao: { postPayment: async (v) => { seen.push(v.requestHash); return { ok: true }; } },
    hashSid: () => 'a'.repeat(64),
  });
  await service.pay({ context: ctx(), orderUid: ORDER_UID, paymentMethod: 'efectivo', mode: 'custom_amount', amount: 30, clientRequestId: 'req-00000008' });
  await service.pay({ context: ctx(), orderUid: ORDER_UID, paymentMethod: 'efectivo', mode: 'custom_amount', amount: 30, clientRequestId: 'req-00000009' });
  assert.equal(seen[0], seen[1]);
  assert.match(seen[0], /^[0-9a-f]{64}$/);
});

test('refund reason is required before any DAO call', async () => {
  const service = createCashService({ dao: { postRefund: async () => { throw new Error('must not be called'); } } });
  await assert.rejects(
    service.refund({ context: ctx({ role: 'admin' }), orderUid: ORDER_UID, originalTransactionId: TX_UID, reason: '  ', clientRequestId: 'req-00000010' }),
    (error) => error instanceof CashServiceError && error.code === 'ORDER_REFUND_REASON_REQUIRED',
  );
});

// ── checkAccount READ MODEL ──

test('checkAccount rejects a Mesa (table-bound) order', async () => {
  const service = createCashService({
    dao: { getOrderByUid: async () => ({ id: '#1', order_uid: ORDER_UID, table_session_id: 'some-table-session', estado: 'EN_COCINA' }) },
  });
  await assert.rejects(
    service.checkAccount({ context: ctx(), orderUid: ORDER_UID }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_ORDER_IS_TABLE_ORDER',
  );
});

test('checkAccount 404s a non-existent order', async () => {
  const service = createCashService({ dao: { getOrderByUid: async () => null } });
  await assert.rejects(
    service.checkAccount({ context: ctx(), orderUid: ORDER_UID }),
    (error) => error instanceof CashServiceError && error.code === 'CASH_ORDER_NOT_FOUND' && error.status === 404,
  );
});

test('buildCheckAccount computes total/paid/outstanding/overCollected exactly like the canonical formulas', () => {
  const order = { id: '#999035', order_uid: ORDER_UID, estado: 'RETIRADO', totale: 85, table_session_id: null };
  const obligations = []; // no revision yet -> falls back to ordenes.totale, exactly like order_canonical_obligation_v1
  const events = [
    { id: 1, type: 'payment', amount: 30, payment_method: 'efectivo', payment_transaction_id: 'tx-1', created_at: 't1' },
    { id: 2, type: 'payment', amount: 20, payment_method: 'tarjeta', payment_transaction_id: 'tx-2', created_at: 't2' },
  ];
  const transactions = [
    { id: 'tx-1', kind: 'payment', mode: 'full', amount: 30, payment_method: 'efectivo', reverses_transaction_id: null, created_at: 't1' },
    { id: 'tx-2', kind: 'payment', mode: 'custom_amount', amount: 20, payment_method: 'tarjeta', reverses_transaction_id: null, created_at: 't2' },
  ];
  const account = buildCheckAccount(order, obligations, events, transactions);
  assert.equal(account.total, 85);
  assert.equal(account.paid, 50);
  assert.equal(account.outstanding, 35);
  assert.equal(account.overCollected, 0);
  assert.equal(account.payments.length, 2);
  assert.deepEqual(account.legacyPayments, []);
  assert.equal(account.commands.length, 1);
  assert.equal(account.commands[0].financial.orderUid, ORDER_UID);
});

test('buildCheckAccount distinguishes a legacy event-only payment from a canonical transaction-backed one (#999035 shape)', () => {
  const order = { id: '#999035', order_uid: ORDER_UID, estado: 'RETIRADO', totale: 85, table_session_id: null };
  const events = [
    { id: 1, type: 'payment', amount: 85, payment_method: 'efectivo', payment_transaction_id: null, created_at: 't1' },
  ];
  const account = buildCheckAccount(order, [], events, []);
  assert.equal(account.paid, 85, 'legacy money is still counted in netCollected');
  assert.equal(account.payments.length, 0, 'no canonical transaction to show as refundable');
  assert.equal(account.legacyPayments.length, 1);
  assert.equal(account.legacyPayments[0].refundable, false);
  assert.equal(account.legacyPayments[0].amount, 85);
});

test('buildCheckAccount reports overCollected without netting it against unpaid, after an adjustment lowers the obligation', () => {
  const order = { id: '#1', order_uid: ORDER_UID, estado: 'RETIRADO', totale: 85, table_session_id: null };
  const obligations = [{ order_uid: ORDER_UID, revision: 2, gross_amount: 60 }, { order_uid: ORDER_UID, revision: 1, gross_amount: 85 }];
  const events = [{ id: 1, type: 'payment', amount: 85, payment_method: 'efectivo', payment_transaction_id: 'tx-1', created_at: 't1' }];
  const transactions = [{ id: 'tx-1', kind: 'payment', mode: 'full', amount: 85, payment_method: 'efectivo', reverses_transaction_id: null, created_at: 't1' }];
  const account = buildCheckAccount(order, obligations, events, transactions);
  assert.equal(account.total, 60);
  assert.equal(account.paid, 85);
  assert.equal(account.outstanding, 0);
  assert.equal(account.overCollected, 25);
});
