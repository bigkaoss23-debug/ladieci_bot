'use strict';
// B7A3 financial HTTP handler + auth-context tests. Run: node tests/financialHttpHandlers.test.js
// Offline: injected fake service + fake req/res (NO real DB / JWT secret / network).
// Proves correct service selection, exactly-one call, operation-specific permitted
// body fields, trusted-context actor (body cannot override), fresh + replay result
// preserved at 200, domain-code → status, unknown → sanitized 500, and no sensitive
// data in response/logs.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createFinancialHandlers, createAuthContextMiddleware } = require('../src/auth/financialHttpHandlers');

function fakeRes() {
  return {
    _status: null, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}
function fakeService(behavior = {}) {
  const calls = [];
  const mk = (name) => async (args) => {
    calls.push({ name, args });
    const b = behavior[name];
    if (b && b.out) return b.out;
    return { ok: true, result: { event_id: 'e1', order_id: args.orderId, type: 'payment', prev_estado: 'EN_COCINA', new_estado: 'EN_COCINA', idempotent: false } };
  };
  return { calls, markPaid: mk('markPaid'), importLegacyPayment: mk('importLegacyPayment'), refund: mk('refund'), voidOrder: mk('voidOrder') };
}
const ADMIN = Object.freeze({ role: 'admin', sub: 'owner', sv: 3 });
const OP = Object.freeze({ role: 'operator', sub: 'operator_primary', sv: 1 });
const reqWith = (ctx, body, ip = '9.9.9.9') => ({ authContext: ctx, body, ip, headers: {} });

(async () => {
  // ── mark_paid: correct method, one call, exact permitted fields, actor context ─
  let svcObj = fakeService();
  let h = createFinancialHandlers({ service: svcObj });
  let res = fakeRes();
  await h.markPaid(reqWith(ADMIN, {
    orderId: 'ORD1', paymentMethod: 'efectivo', reason: 'r', idempotencyKey: 'k12345678', metadata: { n: 1 },
    // hostile body identity/authoritative fields:
    actor: 'rider', by_actor: 'rider', role: 'rider', sub: 'rider', session_version: 99,
    amount: 999, payload_digest: 'dead', prev_estado: 'X', new_pay_state: 'paid',
  }), res);
  assert('mark_paid: exactly one service call to markPaid', svcObj.calls.length === 1 && svcObj.calls[0].name === 'markPaid');
  assert('mark_paid: 200 + ok envelope', res._status === 200 && res._json.ok === true && res._json.result.order_id === 'ORD1');
  assert('mark_paid: actor from context.sub (owner), not body', svcObj.calls[0].args.authContext.sub === 'owner');
  assert('mark_paid: permitted body fields only', JSON.stringify(Object.keys(svcObj.calls[0].args).sort()) === JSON.stringify(['authContext', 'idempotencyKey', 'metadata', 'orderId', 'paymentMethod', 'reason', 'trustedClientIp'].sort()));
  assert('mark_paid: no amount/actor/role/digest/state passed to service', (() => { const k = Object.keys(svcObj.calls[0].args); return !k.includes('amount') && !k.includes('actor') && !k.includes('role') && !k.includes('payload_digest') && !k.includes('prev_estado') && !k.includes('new_pay_state'); })());
  assert('mark_paid: raw ip from req.ip (server-managed), not body', svcObj.calls[0].args.trustedClientIp === '9.9.9.9');

  // ── import: permitted fields incl amount/confirmation ───────────────────────
  svcObj = fakeService(); h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
  await h.importLegacyPayment(reqWith(ADMIN, { orderId: 'ORD2', amount: 30, paymentMethod: 'efectivo', reason: 'hist', confirmation: 'IMPORT_LEGACY_PAYMENT', idempotencyKey: 'k12345678', actor: 'rider' }), res);
  assert('import: one call to importLegacyPayment', svcObj.calls.length === 1 && svcObj.calls[0].name === 'importLegacyPayment');
  assert('import: permitted fields (amount+confirmation)', JSON.stringify(Object.keys(svcObj.calls[0].args).sort()) === JSON.stringify(['amount', 'authContext', 'confirmation', 'idempotencyKey', 'metadata', 'orderId', 'paymentMethod', 'reason', 'trustedClientIp'].sort()));
  assert('import: amount/confirmation forwarded', svcObj.calls[0].args.amount === 30 && svcObj.calls[0].args.confirmation === 'IMPORT_LEGACY_PAYMENT');

  // ── refund: no amount/method fields even if body supplies them ──────────────
  svcObj = fakeService(); h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
  await h.refund(reqWith(ADMIN, { orderId: 'ORD1', reason: 'r', idempotencyKey: 'k12345678', amount: 25, paymentMethod: 'efectivo' }), res);
  assert('refund: permitted fields only (no amount/method)', JSON.stringify(Object.keys(svcObj.calls[0].args).sort()) === JSON.stringify(['authContext', 'idempotencyKey', 'metadata', 'orderId', 'reason', 'trustedClientIp'].sort()));

  // ── void: no caller state/amount/giro ───────────────────────────────────────
  svcObj = fakeService(); h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
  await h.voidOrder(reqWith(OP, { orderId: 'ORD1', reason: 'r', idempotencyKey: 'k12345678', new_estado: 'ANULADO', amount: 0, original_giro_id: 'g' }), res);
  assert('void: routed to voidOrder, operator actor from context', svcObj.calls[0].name === 'voidOrder' && svcObj.calls[0].args.authContext.sub === 'operator_primary');
  assert('void: permitted fields only', JSON.stringify(Object.keys(svcObj.calls[0].args).sort()) === JSON.stringify(['authContext', 'idempotencyKey', 'metadata', 'orderId', 'reason', 'trustedClientIp'].sort()));

  // ── replay result preserved at 200 (same event id + idempotent true) ────────
  svcObj = fakeService({ voidOrder: { out: { ok: true, result: { event_id: 'evX', order_id: 'O', type: 'void', new_estado: 'ANULADO', idempotent: true } } } });
  h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
  await h.voidOrder(reqWith(ADMIN, { orderId: 'O', reason: 'r', idempotencyKey: 'k12345678' }), res);
  assert('replay → 200 (NOT 201), event id + idempotent preserved', res._status === 200 && res._json.result.event_id === 'evX' && res._json.result.idempotent === true);

  // ── domain-code → status mapping through handler ────────────────────────────
  const cases = [
    ['AUTH_FORBIDDEN_ROLE', 403], ['AUTH_ORDER_NOT_FOUND', 404], ['AUTH_IDEMPOTENCY_CONFLICT', 409],
    ['AUTH_NO_PAYMENT_BASIS', 409], ['AUTH_METHOD_INVALID', 400], ['AUTH_ACTOR_NOT_FOUND', 401],
    ['FINANCIAL_INVALID_REQUEST', 400], ['FINANCIAL_UNAUTHENTICATED', 401], ['FINANCIAL_INTERNAL_ERROR', 500],
  ];
  for (const [code, status] of cases) {
    svcObj = fakeService({ refund: { out: { ok: false, code } } });
    h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
    await h.refund(reqWith(ADMIN, { orderId: 'O', reason: 'r', idempotencyKey: 'k12345678' }), res);
    assert(`map ${code} → ${status}`, res._status === status && res._json.ok === false && res._json.code === code);
  }
  // unknown code fails closed to 500
  svcObj = fakeService({ refund: { out: { ok: false, code: 'SOME_UNSEEN_CODE' } } });
  h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
  await h.refund(reqWith(ADMIN, { orderId: 'O', reason: 'r', idempotencyKey: 'k12345678' }), res);
  assert('unknown service code → sanitized 500', res._status === 500 && res._json.ok === false);

  // ── response never leaks internal transport / secrets ───────────────────────
  assert('error envelope has only {ok,code}', JSON.stringify(Object.keys(res._json).sort()) === JSON.stringify(['code', 'ok']));

  // ── defensive: handler without a context fails closed 401 (never trusts body) ─
  svcObj = fakeService(); h = createFinancialHandlers({ service: svcObj }); res = fakeRes();
  await h.markPaid({ body: { orderId: 'O', paymentMethod: 'efectivo', idempotencyKey: 'k12345678', actor: 'owner' }, ip: '1.1.1.1', headers: {} }, res);
  assert('no context → 401, service NOT called', res._status === 401 && res._json.code === 'FINANCIAL_UNAUTHENTICATED' && svcObj.calls.length === 0);

  // ── logging: only safe fields, never sensitive body values ──────────────────
  const logs = [];
  svcObj = fakeService(); h = createFinancialHandlers({ service: svcObj, logger: { info: (r) => logs.push(r) } }); res = fakeRes();
  await h.markPaid(reqWith(ADMIN, { orderId: 'ORDLOG', paymentMethod: 'efectivo', reason: 'topsecret', idempotencyKey: 'k12345678', metadata: { x: 'y' } }), res);
  assert('handler log has only safe keys', logs.length === 1 && JSON.stringify(Object.keys(logs[0]).sort()) === JSON.stringify(['authed', 'code', 'op', 'outcome', 'status'].sort()));
  assert('handler log leaks no reason/ip/order/meta', !/topsecret|9\.9\.9\.9|ORDLOG|"x"/.test(JSON.stringify(logs)));

  // ════════════════ AUTH-CONTEXT MIDDLEWARE ════════════════
  const verifyOK = (t) => (t === 'good' ? { role: 'admin', sub: 'owner', sv: 2 } : null);
  const mw = createAuthContextMiddleware({ verifyToken: verifyOK });

  // valid token → context attached, next called, nothing sent
  let nexted = 0; let req = { headers: { authorization: 'Bearer good' } }; res = fakeRes();
  mw(req, res, () => { nexted++; });
  assert('valid token attaches trusted context {role,sub,sv}', req.authContext && req.authContext.sub === 'owner' && req.authContext.role === 'admin' && nexted === 1 && res._status === null);
  assert('context is frozen (immutable)', Object.isFrozen(req.authContext));

  // missing header → 401, next NOT called
  nexted = 0; req = { headers: {} }; res = fakeRes();
  mw(req, res, () => { nexted++; });
  assert('missing Authorization → 401, no next', res._status === 401 && res._json.code === 'FINANCIAL_UNAUTHENTICATED' && nexted === 0);

  // invalid/unverified token → 401
  nexted = 0; req = { headers: { authorization: 'Bearer bad' } }; res = fakeRes();
  mw(req, res, () => { nexted++; });
  assert('invalid token → 401, no context', res._status === 401 && !req.authContext && nexted === 0);

  // body actor/PIN/token/service-key cannot substitute for auth
  nexted = 0; req = { headers: {}, body: { actor: 'owner', role: 'admin', pin: '1234', token: 'x', service_key: 'sk' } }; res = fakeRes();
  mw(req, res, () => { nexted++; });
  assert('body actor/pin/token cannot substitute for auth → 401', res._status === 401 && nexted === 0 && !req.authContext);

  // non-Bearer scheme ignored
  nexted = 0; req = { headers: { authorization: 'Basic Zm9v' } }; res = fakeRes();
  mw(req, res, () => { nexted++; });
  assert('non-Bearer Authorization → 401', res._status === 401 && nexted === 0);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
