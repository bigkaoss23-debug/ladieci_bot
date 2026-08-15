'use strict';
// MESA / SALA — S1 follow-up: proves the REAL HTTP -> service -> DAO call
// chain for confirmDuplicate. The original S1 test suite proved DAO->RPC
// (tests/s1GuardNullPaymentIdempotency.static.test.js, string-match on the
// migration + mesaDao.js's one mapping line) and mesaService.test.js proves
// service->DAO in isolation, but nothing ever drove a request THROUGH
// mesaHttpHandlers.js into a real (non-stubbed) mesaService instance -- so
// the missing HTTP->service->DAO propagation of confirmDuplicate was never
// caught. This file deliberately stubs ONLY the DAO boundary (dao.postPayment)
// -- createMesaHandlers is given a REAL createMesaService instance, not a
// mock -- so every assertion here reflects the actual production call graph
// from an inbound HTTP request down to what would reach the RPC wrapper.
// Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S1.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createMesaHandlers } = require('../src/tables/mesaHttpHandlers');
const { createMesaService } = require('../src/tables/mesaService');

const ctx = () => Object.freeze({
  actor: 'operator_primary', role: 'operator', workspaceId: 'ws-1',
  sessionVersion: 1, sid: 'high-entropy-session-id',
});

const VALID_SESSION_ID = '11111111-1111-4111-8111-111111111111';

function fakeReq({ body = {}, sessionId = VALID_SESSION_ID } = {}) {
  return { mesaContext: ctx(), params: { sessionId }, body };
}
function fakeRes() {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

// Real handler + real service; only the DAO boundary is a stub.
function buildRealChain() {
  let capturedDaoArgs;
  const dao = {
    postPayment: async (args) => {
      capturedDaoArgs = args;
      return { ok: true, idempotent: false, transactionId: 'tx-1' };
    },
  };
  const service = createMesaService({ dao, hashSid: () => 'a'.repeat(64) });
  const handlers = createMesaHandlers({ service, logger: { warn: () => {} } });
  return { handlers, getDaoArgs: () => capturedDaoArgs };
}

const VALID_BODY = { paymentMethod: 'efectivo', mode: 'full', clientRequestId: 'payment-0001' };

test('A: HTTP body confirmDuplicate:true reaches the DAO as confirmDuplicate:true through the real, unstubbed handler+service chain', async () => {
  const { handlers, getDaoArgs } = buildRealChain();
  const res = await handlers.pay(fakeReq({ body: { ...VALID_BODY, confirmDuplicate: true } }), fakeRes());
  assert.equal(res.statusCode, 200);
  assert.equal(getDaoArgs().confirmDuplicate, true);
});

test('B: an omitted confirmDuplicate field reaches the DAO as false', async () => {
  const { handlers, getDaoArgs } = buildRealChain();
  const res = await handlers.pay(fakeReq({ body: { ...VALID_BODY } }), fakeRes());
  assert.equal(res.statusCode, 200);
  assert.equal(getDaoArgs().confirmDuplicate, false);
});

test('C: an explicit confirmDuplicate:false stays disabled', async () => {
  const { handlers, getDaoArgs } = buildRealChain();
  await handlers.pay(fakeReq({ body: { ...VALID_BODY, confirmDuplicate: false } }), fakeRes());
  assert.equal(getDaoArgs().confirmDuplicate, false);
});

test('D: non-boolean values (truthy strings, numbers, objects, null) cannot enable the override', async () => {
  for (const value of ['true', 'yes', 1, {}, [], null, 'false']) {
    const { handlers, getDaoArgs } = buildRealChain();
    await handlers.pay(fakeReq({ body: { ...VALID_BODY, confirmDuplicate: value } }), fakeRes());
    assert.equal(
      getDaoArgs().confirmDuplicate, false,
      `value ${JSON.stringify(value)} must not enable the duplicate-confirm override`
    );
  }
});

test('E: every pre-existing payment field still reaches the DAO unchanged, with confirmDuplicate present', async () => {
  const { handlers, getDaoArgs } = buildRealChain();
  await handlers.pay(fakeReq({
    body: {
      paymentMethod: 'tarjeta', mode: 'item_selection', amount: 12.5, coversSettled: 2,
      lineIds: ['b', 'a'], clientRequestId: 'payment-0002', confirmDuplicate: true,
    },
  }), fakeRes());
  const args = getDaoArgs();
  assert.equal(args.paymentMethod, 'tarjeta');
  assert.equal(args.mode, 'item_selection');
  assert.equal(args.amount, 12.5);
  assert.equal(args.coversSettled, 2);
  assert.deepEqual(args.lineIds, ['a', 'b']);
  assert.equal(args.clientRequestId, 'payment-0002');
  assert.equal(args.bySidHash, 'a'.repeat(64));
  assert.match(args.requestHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(args.meta, { source: 'mesa_dashboard' });
});

test('F: requestHash is byte-identical with vs. without confirmDuplicate -- the flag never enters the semantic payment hash', async () => {
  const body = { paymentMethod: 'efectivo', mode: 'full', clientRequestId: 'payment-0003' };
  const withConfirm = buildRealChain();
  await withConfirm.handlers.pay(fakeReq({ body: { ...body, confirmDuplicate: true } }), fakeRes());
  const withoutConfirm = buildRealChain();
  await withoutConfirm.handlers.pay(fakeReq({ body: { ...body, confirmDuplicate: false } }), fakeRes());
  assert.equal(withConfirm.getDaoArgs().requestHash, withoutConfirm.getDaoArgs().requestHash);
});

test('waiter still cannot pay, confirmDuplicate does not change payment authorization', async () => {
  const { handlers } = buildRealChain();
  const req = fakeReq({ body: { ...VALID_BODY, confirmDuplicate: true } });
  req.mesaContext = Object.freeze({ ...ctx(), actor: 'waiter-1', role: 'waiter' });
  const res = await handlers.pay(req, fakeRes());
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'MESA_FORBIDDEN');
});
