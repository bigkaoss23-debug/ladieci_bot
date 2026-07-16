'use strict';
// B7A2C financial service unit tests. Run: node tests/financialService.test.js
// Offline: injected fake DAO + fake ipHash (NO real DB). Proves trusted-context
// actor sourcing (body cannot override), boundary shape validation before DAO,
// SQL-derived fields never accepted from caller, intact replay results, idempotency
// conflict stays a failure, unknown DAO error sanitized, and no sensitive value in
// emitted result/log output.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { createFinancialService, INVALID_REQUEST, UNAUTHENTICATED } = require('../src/auth/financialService');
const { FinancialDaoError } = require('../src/auth/financialDao');

// ── fake DAO recorder ─────────────────────────────────────────────────────────
function makeDao(behavior = {}) {
  const calls = [];
  const impl = (name) => async (args) => {
    calls.push({ name, args });
    if (behavior[name] && behavior[name].throw) throw behavior[name].throw;
    return (behavior[name] && behavior[name].result) || { event_id: 'e1', order_id: args.orderId, type: 'payment', amount: 25, payment_method: 'efectivo', prev_estado: 'EN_COCINA', new_estado: 'EN_COCINA', prev_pay_state: 'unpaid', new_pay_state: 'paid', legacy: false, original_giro_id: null, idempotent: false, created_at: 't' };
  };
  return { calls, markOrderPaid: impl('markOrderPaid'), importLegacyPayment: impl('importLegacyPayment'), refundOrder: impl('refundOrder'), voidOrder: impl('voidOrder') };
}
const ipHash = (ip) => (typeof ip === 'string' && ip.length ? 'iphash_of_' + ip : null);
const ADMIN_CTX = { role: 'admin', sub: 'owner', sv: 3 };
const OP_CTX = { role: 'operator', sub: 'operator_primary', sv: 2 };
const svc = (dao, extra = {}) => createFinancialService(Object.assign({ dao, ipHash }, extra));

(async () => {
  // ── actor comes from trusted context; body cannot override ──────────────────
  let dao = makeDao();
  let s = svc(dao);
  let r = await s.markPaid({ authContext: ADMIN_CTX, orderId: 'ORD1', paymentMethod: 'efectivo', reason: 'x', idempotencyKey: 'k12345678', trustedClientIp: '1.2.3.4',
    // hostile body attempts to override identity / SQL-authoritative fields:
    actor: 'rider', role: 'rider', byActor: 'rider', session_version: 99, payload_digest: 'deadbeef',
    amount: 999, type: 'refund', prev_estado: 'X', new_pay_state: 'paid', refunded: true, cancelado_at: 't' });
  assert('mark_paid ok', r.ok === true && r.result.order_id === 'ORD1');
  assert('actor taken from context.sub (owner), NOT body', dao.calls[0].args.byActor === 'owner');
  assert('DAO payload exposes no role/digest/state/amount/refund keys', (() => {
    const k = Object.keys(dao.calls[0].args);
    return !k.includes('role') && !k.includes('byRole') && !k.includes('payload_digest') && !k.includes('digest')
      && !k.includes('amount') && !k.includes('type') && !k.includes('prev_estado') && !k.includes('new_pay_state') && !k.includes('refunded') && !k.includes('cancelado_at');
  })());
  assert('DAO payload keys are exactly the mark_paid mapping', JSON.stringify(Object.keys(dao.calls[0].args).sort()) === JSON.stringify(['byActor', 'idemScopeKey', 'ipHash', 'meta', 'orderId', 'paymentMethod', 'reason'].sort()));
  assert('ip hash derived from trusted ip, raw ip not forwarded', dao.calls[0].args.ipHash === 'iphash_of_1.2.3.4');

  // ── exactly one DAO call for valid input ────────────────────────────────────
  assert('valid input → exactly one DAO call', dao.calls.length === 1);

  // ── unauthenticated: non-canonical sub / role-sub mismatch → no DAO call ─────
  dao = makeDao(); s = svc(dao);
  r = await s.refund({ authContext: { role: 'admin', sub: 'attacker' }, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('non-canonical actor → UNAUTHENTICATED, no DAO call', r.ok === false && r.code === UNAUTHENTICATED && dao.calls.length === 0);
  r = await s.refund({ authContext: { role: 'rider', sub: 'owner' }, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('role/sub mismatch (forged ctx) → UNAUTHENTICATED', r.ok === false && r.code === UNAUTHENTICATED && dao.calls.length === 0);
  r = await s.refund({ orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('missing context → UNAUTHENTICATED', r.ok === false && r.code === UNAUTHENTICATED);

  // ── malformed required inputs rejected BEFORE DAO ───────────────────────────
  dao = makeDao(); s = svc(dao);
  r = await s.markPaid({ authContext: ADMIN_CTX, orderId: '   ', paymentMethod: 'efectivo', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('blank orderId → INVALID_REQUEST, no DAO call', r.ok === false && r.code === INVALID_REQUEST && dao.calls.length === 0);
  r = await s.markPaid({ authContext: ADMIN_CTX, orderId: 'O', paymentMethod: 'efectivo', idempotencyKey: '', trustedClientIp: '1.1.1.1' });
  assert('empty idempotency key → INVALID_REQUEST', r.ok === false && r.code === INVALID_REQUEST && dao.calls.length === 0);
  r = await s.markPaid({ authContext: ADMIN_CTX, orderId: 'O', paymentMethod: '', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('missing payment method → INVALID_REQUEST', r.ok === false && r.code === INVALID_REQUEST && dao.calls.length === 0);
  r = await s.importLegacyPayment({ authContext: ADMIN_CTX, orderId: 'O', amount: 'lots', paymentMethod: 'efectivo', reason: 'r', confirmation: 'IMPORT_LEGACY_PAYMENT', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('non-numeric import amount → INVALID_REQUEST', r.ok === false && r.code === INVALID_REQUEST && dao.calls.length === 0);

  // ── ip fail-closed & metadata sanitization at the boundary ──────────────────
  dao = makeDao(); s = svc(dao);
  r = await s.voidOrder({ authContext: ADMIN_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '' });
  assert('unresolvable ip hash → INVALID_REQUEST, no DAO call', r.ok === false && r.code === INVALID_REQUEST && dao.calls.length === 0);
  r = await s.voidOrder({ authContext: ADMIN_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1', metadata: { pin: '1234' } });
  assert('sensitive metadata key → INVALID_REQUEST, no DAO call', r.ok === false && r.code === INVALID_REQUEST && dao.calls.length === 0);

  // ── import: valid path maps amount/method/confirm; reason normalized ─────────
  dao = makeDao({ importLegacyPayment: { result: { order_id: 'O', type: 'payment_imported', legacy: true, idempotent: false, amount: 30 } } });
  s = svc(dao);
  r = await s.importLegacyPayment({ authContext: ADMIN_CTX, orderId: 'O', amount: 30, paymentMethod: 'efectivo', reason: '  hist  ', confirmation: 'IMPORT_LEGACY_PAYMENT', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('import ok maps amount/method/confirm and trims reason', r.ok === true && dao.calls[0].args.amount === 30 && dao.calls[0].args.confirm === 'IMPORT_LEGACY_PAYMENT' && dao.calls[0].args.reason === 'hist');
  assert('import DAO keys exact', JSON.stringify(Object.keys(dao.calls[0].args).sort()) === JSON.stringify(['amount', 'byActor', 'confirm', 'idemScopeKey', 'ipHash', 'meta', 'orderId', 'paymentMethod', 'reason'].sort()));

  // ── replay result returned intact; conflict stays a failure ─────────────────
  dao = makeDao({ voidOrder: { result: { order_id: 'O', type: 'void', new_estado: 'ANULADO', idempotent: true, event_id: 'evX' } } });
  s = svc(dao);
  r = await s.voidOrder({ authContext: ADMIN_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('idempotent replay returned intact (ok + idempotent true)', r.ok === true && r.result.idempotent === true && r.result.event_id === 'evX');

  dao = makeDao({ voidOrder: { throw: new FinancialDaoError('AUTH_IDEMPOTENCY_CONFLICT') } });
  s = svc(dao);
  r = await s.voidOrder({ authContext: ADMIN_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('idempotency conflict remains a FAILURE (not success)', r.ok === false && r.code === 'AUTH_IDEMPOTENCY_CONFLICT');

  // ── recognized domain code propagated distinguishably ───────────────────────
  dao = makeDao({ refundOrder: { throw: new FinancialDaoError('AUTH_NO_PAYMENT_BASIS') } });
  s = svc(dao);
  r = await s.refund({ authContext: ADMIN_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('refund no-basis domain code preserved', r.ok === false && r.code === 'AUTH_NO_PAYMENT_BASIS');

  // ── unknown DAO error sanitized ─────────────────────────────────────────────
  dao = makeDao({ refundOrder: { throw: new Error('raw db host db.internal:5432 pwd=secret') } });
  s = svc(dao);
  r = await s.refund({ authContext: ADMIN_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '1.1.1.1' });
  assert('unknown DAO error → FINANCIAL_INTERNAL_ERROR', r.ok === false && r.code === 'FINANCIAL_INTERNAL_ERROR');
  assert('sanitized error exposes only {ok,code}', JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['code', 'ok']) && !/secret|db.internal|5432/.test(JSON.stringify(r)));

  // ── operator context also sourced from trusted claims ───────────────────────
  dao = makeDao(); s = svc(dao);
  r = await s.voidOrder({ authContext: OP_CTX, orderId: 'O', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '9.9.9.9', byActor: 'owner' });
  assert('operator void: byActor = operator_primary from context (not body owner)', r.ok === true && dao.calls[0].args.byActor === 'operator_primary');

  // ── logging: only safe operational fields, never sensitive values ───────────
  const logs = [];
  const logger = { info: (rec) => logs.push(rec) };
  dao = makeDao(); s = svc(dao, { logger });
  await s.markPaid({ authContext: ADMIN_CTX, orderId: 'ORDLOG', paymentMethod: 'efectivo', reason: 'topsecret reason', idempotencyKey: 'k12345678', trustedClientIp: '5.5.5.5', metadata: { note: 'hi' } });
  dao = makeDao({ refundOrder: { throw: new FinancialDaoError('AUTH_FORBIDDEN_ROLE') } }); s = svc(dao, { logger });
  await s.refund({ authContext: ADMIN_CTX, orderId: 'ORDLOG2', reason: 'r', idempotencyKey: 'k12345678', trustedClientIp: '5.5.5.5' });
  assert('logs emitted for ok + fail', logs.length === 2);
  assert('log records contain only safe keys', logs.every((l) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(['by_actor', 'code', 'op', 'order_id', 'outcome'].sort())));
  assert('logs never contain reason/meta/ip/digest/amount/confirmation', !/topsecret|iphash_of_|5\.5\.5\.5|deadbeef|IMPORT_LEGACY_PAYMENT|efectivo/.test(JSON.stringify(logs)));
  assert('fail log carries recognized domain code', logs[1].outcome === 'fail' && logs[1].code === 'AUTH_FORBIDDEN_ROLE');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
