'use strict';
// CHECK-CENTRIC UNIVERSAL CASH V1 — HTTP wiring tests for src/cash/
// cashHttpHandlers.js and cashHttpIntegration.js. node:test, no DB, no
// network (a fake Express router/app records what gets registered).

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerCashRoutes, safeError, createCashAuthMiddleware } = require('../src/cash/cashHttpHandlers');
const { isCashHttpEnabled, integrateCashRoutes, PREFIX } = require('../src/cash/cashHttpIntegration');
const { CashServiceError } = require('../src/cash/cashService');

function fakeRouter() {
  const routes = [];
  const router = {
    get: (path, ...mw) => routes.push({ method: 'GET', path }),
    post: (path, ...mw) => routes.push({ method: 'POST', path }),
  };
  return { router, routes };
}

test('registers exactly 4 routes: one read, three writes, all under /checks/:orderUid', () => {
  const { router, routes } = fakeRouter();
  const registered = registerCashRoutes(router, { service: {} });
  assert.equal(registered.routes, 4);
  assert.deepEqual(routes, [
    { method: 'GET', path: '/checks/:orderUid' },
    { method: 'POST', path: '/checks/:orderUid/payments' },
    { method: 'POST', path: '/checks/:orderUid/refunds' },
    { method: 'POST', path: '/checks/:orderUid/adjustments' },
  ]);
});

test('is disabled by default (env flag off) and mounts nothing', () => {
  const app = { use: () => { throw new Error('must not mount when disabled'); } };
  const result = integrateCashRoutes(app, { env: {} });
  assert.equal(result.enabled, false);
  assert.equal(result.routes, 0);
  assert.equal(result.prefix, PREFIX);
});

test('mounts at /api/cash/v1 when CASH_HTTP_ENABLED=true (own prefix, own flag, separate from Mesa)', () => {
  assert.equal(PREFIX, '/api/cash/v1');
  let mountedAt = null;
  const app = { use: (prefix) => { mountedAt = prefix; } };
  const result = integrateCashRoutes(app, { env: { CASH_HTTP_ENABLED: 'true' } });
  assert.equal(result.enabled, true);
  assert.equal(mountedAt, '/api/cash/v1');
  assert.equal(isCashHttpEnabled({ CASH_HTTP_ENABLED: 'true' }), true);
  assert.equal(isCashHttpEnabled({ CASH_HTTP_ENABLED: 'false' }), false);
  assert.equal(isCashHttpEnabled({}), false);
});

// ── safeError — CashServiceError codes and the reused MESA_ADJUSTMENT_* core codes ──

test('CashServiceError maps back to its own status/code verbatim', () => {
  const mapped = safeError(new CashServiceError('CASH_FORBIDDEN', 403));
  assert.deepEqual(mapped, { status: 403, code: 'CASH_FORBIDDEN' });
});

test('ORDER_PAYMENT_ALREADY_SETTLED (a raw RPC exception, not a CashServiceError) maps to 409', () => {
  assert.deepEqual(safeError({ code: 'ORDER_PAYMENT_ALREADY_SETTLED' }), { status: 409, code: 'ORDER_PAYMENT_ALREADY_SETTLED' });
});

test('ORDER_PAYMENT_FORBIDDEN maps to 403', () => {
  assert.deepEqual(safeError({ code: 'ORDER_PAYMENT_FORBIDDEN' }), { status: 403, code: 'ORDER_PAYMENT_FORBIDDEN' });
});

test('ORDER_REFUND_ORDER_NOT_FOUND maps to 404', () => {
  assert.deepEqual(safeError({ code: 'ORDER_REFUND_ORDER_NOT_FOUND' }), { status: 404, code: 'ORDER_REFUND_ORDER_NOT_FOUND' });
});

test('the shared core\'s own MESA_ADJUSTMENT_* vocabulary is admitted (reuse, not renamed — §15)', () => {
  assert.deepEqual(safeError({ code: 'MESA_ADJUSTMENT_EXCEEDS_OBLIGATION' }), { status: 409, code: 'MESA_ADJUSTMENT_EXCEEDS_OBLIGATION' });
  assert.deepEqual(safeError({ code: 'MESA_ADJUSTMENT_ORDER_NOT_FOUND' }), { status: 404, code: 'MESA_ADJUSTMENT_ORDER_NOT_FOUND' });
});

test('an unrecognised code never leaks raw text — collapses to CASH_INTERNAL_ERROR/500', () => {
  assert.deepEqual(safeError({ code: 'some raw sql error text' }), { status: 500, code: 'CASH_INTERNAL_ERROR' });
  assert.deepEqual(safeError(new Error('boom')), { status: 500, code: 'CASH_INTERNAL_ERROR' });
});

// ── auth middleware — same shape as Mesa's, own context key (req.cashContext) ──

test('auth middleware rejects a missing/malformed bearer token with CASH_UNAUTHENTICATED', async () => {
  const auth = createCashAuthMiddleware({ verifyToken: () => null });
  let statusSeen, bodySeen;
  const req = { headers: {} };
  const res = { status: (s) => { statusSeen = s; return res; }, json: (b) => { bodySeen = b; } };
  await auth(req, res, () => { throw new Error('must not call next()'); });
  assert.equal(statusSeen, 401);
  assert.equal(bodySeen.code, 'CASH_UNAUTHENTICATED');
});

test('auth middleware refuses a stale actor (role/session_version mismatch) with CASH_SESSION_STALE', async () => {
  const auth = createCashAuthMiddleware({
    verifyToken: () => ({ sub: 'op-1', role: 'operator', sv: 2, sid: 'sid-1' }),
    getActor: async () => ({ actor: 'op-1', active: true, role: 'operator', session_version: 1, workspace_id: 'ws-1' }),
  });
  let statusSeen, bodySeen;
  const req = { headers: { authorization: 'Bearer token' } };
  const res = { status: (s) => { statusSeen = s; return res; }, json: (b) => { bodySeen = b; } };
  await auth(req, res, () => { throw new Error('must not call next()'); });
  assert.equal(statusSeen, 401);
  assert.equal(bodySeen.code, 'CASH_SESSION_STALE');
});

test('auth middleware builds req.cashContext (not req.mesaContext) from the authoritative actor row', async () => {
  const auth = createCashAuthMiddleware({
    verifyToken: () => ({ sub: 'admin-1', role: 'admin', sv: 3, sid: 'sid-9' }),
    getActor: async () => ({ actor: 'admin-1', active: true, role: 'admin', session_version: 3, workspace_id: 'ws-9' }),
  });
  const req = { headers: { authorization: 'Bearer token' } };
  let nextCalled = false;
  const res = { status: () => res, json: () => {} };
  await auth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(req.cashContext, {
    actor: 'admin-1', role: 'admin', workspaceId: 'ws-9', sessionVersion: 3, sid: 'sid-9',
  });
  assert.equal(req.mesaContext, undefined);
});
