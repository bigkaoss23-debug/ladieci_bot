'use strict';
// B7A2C financial DAO unit tests. Run: node tests/financialDao.test.js
// Offline: injected fake rpc + stubbed global.fetch (NO real DB/network). Proves
// exact RPC name + exact committed parameter keys, exactly one call (no retry),
// intact whitelisted result, recognized SQL domain-code preservation, unknown-error
// sanitization, and no direct table writes / no generic event writer.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://stub.local';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'stub-key';

const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const keys = (o) => Object.keys(o).sort();
const eqKeys = (o, arr) => JSON.stringify(keys(o)) === JSON.stringify([...arr].sort());

const {
  createFinancialDao, FinancialDaoError, RECOGNIZED_DOMAIN_CODES, INTERNAL_ERROR_CODE,
} = require('../src/auth/financialDao');

const okResult = (over = {}) => Object.assign({
  event_id: 'e1', order_id: 'ORD1', type: 'payment', amount: 25, payment_method: 'efectivo',
  prev_estado: 'EN_COCINA', new_estado: 'EN_COCINA', prev_pay_state: 'unpaid', new_pay_state: 'paid',
  legacy: false, original_giro_id: null, idempotent: false, created_at: '2026-07-16T00:00:00Z',
}, over);

(async () => {
  // ── injected-rpc recorder: exact RPC name + exact committed param keys ───────
  let CALLS = [];
  const rec = (nextResult, nextThrow) => (fn, args) => {
    CALLS.push({ fn, args });
    if (nextThrow) return Promise.reject(nextThrow);
    return Promise.resolve(nextResult);
  };

  let dao = createFinancialDao({ rpc: rec(okResult()) });
  CALLS = [];
  let r = await dao.markOrderPaid({ orderId: 'ORD1', paymentMethod: 'efectivo', reason: 'r', byActor: 'owner', ipHash: 'h', meta: { a: 1 }, idemScopeKey: 'k12345678' });
  assert('mark_paid: exactly one RPC call (no retry)', CALLS.length === 1);
  assert('mark_paid: RPC name order_mark_paid', CALLS[0].fn === 'order_mark_paid');
  assert('mark_paid: exact param keys (no p_amount)', eqKeys(CALLS[0].args, ['p_order_id', 'p_payment_method', 'p_reason', 'p_by_actor', 'p_ip_hash', 'p_meta', 'p_idem_scope_key']), keys(CALLS[0].args).join(','));
  assert('mark_paid: exact value mapping', CALLS[0].args.p_order_id === 'ORD1' && CALLS[0].args.p_payment_method === 'efectivo' && CALLS[0].args.p_by_actor === 'owner' && CALLS[0].args.p_ip_hash === 'h' && CALLS[0].args.p_idem_scope_key === 'k12345678');
  assert('mark_paid: no p_by_role / p_expected_role / p_digest', !('p_by_role' in CALLS[0].args) && !('p_expected_role' in CALLS[0].args) && !('p_payload_digest' in CALLS[0].args));
  assert('mark_paid: result returned intact (whitelisted)', r.order_id === 'ORD1' && r.type === 'payment' && r.idempotent === false && Object.isFrozen(r));

  CALLS = [];
  dao = createFinancialDao({ rpc: rec(okResult({ type: 'payment_imported', legacy: true, amount: 30 })) });
  await dao.importLegacyPayment({ orderId: 'ORD2', amount: 30, paymentMethod: 'efectivo', reason: 'hist', byActor: 'owner', ipHash: 'h', meta: {}, idemScopeKey: 'k12345678', confirm: 'IMPORT_LEGACY_PAYMENT' });
  assert('import: RPC name order_import_legacy_payment', CALLS[0].fn === 'order_import_legacy_payment');
  assert('import: exact param keys (incl p_amount + p_confirm)', eqKeys(CALLS[0].args, ['p_order_id', 'p_amount', 'p_payment_method', 'p_reason', 'p_by_actor', 'p_ip_hash', 'p_meta', 'p_idem_scope_key', 'p_confirm']), keys(CALLS[0].args).join(','));
  assert('import: p_amount + p_confirm mapped', CALLS[0].args.p_amount === 30 && CALLS[0].args.p_confirm === 'IMPORT_LEGACY_PAYMENT');

  CALLS = [];
  dao = createFinancialDao({ rpc: rec(okResult({ type: 'refund', new_pay_state: 'refunded' })) });
  await dao.refundOrder({ orderId: 'ORD1', reason: 'ref', byActor: 'owner', ipHash: 'h', meta: {}, idemScopeKey: 'k12345678' });
  assert('refund: RPC name order_refund', CALLS[0].fn === 'order_refund');
  assert('refund: exact param keys (NO amount/method)', eqKeys(CALLS[0].args, ['p_order_id', 'p_reason', 'p_by_actor', 'p_ip_hash', 'p_meta', 'p_idem_scope_key']), keys(CALLS[0].args).join(','));
  assert('refund: no p_amount / p_payment_method (SQL-derived)', !('p_amount' in CALLS[0].args) && !('p_payment_method' in CALLS[0].args));

  CALLS = [];
  dao = createFinancialDao({ rpc: rec(okResult({ type: 'void', new_estado: 'ANULADO', amount: 0, payment_method: null })) });
  await dao.voidOrder({ orderId: 'ORD1', reason: 'vd', byActor: 'owner', ipHash: 'h', meta: {}, idemScopeKey: 'k12345678' });
  assert('void: RPC name order_void', CALLS[0].fn === 'order_void');
  assert('void: exact param keys (NO amount/method/state)', eqKeys(CALLS[0].args, ['p_order_id', 'p_reason', 'p_by_actor', 'p_ip_hash', 'p_meta', 'p_idem_scope_key']), keys(CALLS[0].args).join(','));

  // ── recognized domain code preserved through the DAO layer ──────────────────
  dao = createFinancialDao({ rpc: rec(null, new FinancialDaoError('AUTH_IDEMPOTENCY_CONFLICT')) });
  let err = null; try { await dao.voidOrder({ orderId: 'ORD1', reason: 'x', byActor: 'owner', ipHash: 'h', idemScopeKey: 'k12345678' }); } catch (e) { err = e; }
  assert('domain code preserved (AUTH_IDEMPOTENCY_CONFLICT)', err && err.code === 'AUTH_IDEMPOTENCY_CONFLICT');

  // ── malformed RPC result → sanitized internal error ─────────────────────────
  dao = createFinancialDao({ rpc: rec({ nope: true }) });
  err = null; try { await dao.markOrderPaid({ orderId: 'ORD1', paymentMethod: 'efectivo', byActor: 'owner', ipHash: 'h', idemScopeKey: 'k12345678' }); } catch (e) { err = e; }
  assert('malformed result → FINANCIAL_INTERNAL_ERROR', err && err.code === INTERNAL_ERROR_CODE);

  // ── default transport (fetch stub): exact rpc path + domain-code mapping ─────
  let FCALLS = [];
  let NEXT = { ok: true, status: 200, body: okResult() };
  global.fetch = async (url, opts = {}) => {
    FCALLS.push({ url, method: opts.method, body: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: NEXT.ok, status: NEXT.status, text: async () => (NEXT.body === undefined ? '' : JSON.stringify(NEXT.body)) };
  };
  const ddao = createFinancialDao(); // default sbRest transport

  FCALLS = []; NEXT = { ok: true, status: 200, body: okResult() };
  await ddao.refundOrder({ orderId: 'ORD1', reason: 'r', byActor: 'owner', ipHash: 'h', meta: {}, idemScopeKey: 'k12345678' });
  assert('default transport: one fetch (no retry)', FCALLS.length === 1);
  assert('default transport: POST rpc/order_refund', /\/rest\/v1\/rpc\/order_refund$/.test(FCALLS[0].url) && FCALLS[0].method === 'POST');
  assert('default transport: exact body keys', eqKeys(FCALLS[0].body, ['p_order_id', 'p_reason', 'p_by_actor', 'p_ip_hash', 'p_meta', 'p_idem_scope_key']));

  FCALLS = []; NEXT = { ok: false, status: 400, body: { code: '22023', message: 'AUTH_FORBIDDEN_ROLE', details: 'secret sql text', hint: null } };
  err = null; try { await ddao.refundOrder({ orderId: 'ORD1', reason: 'r', byActor: 'rider', ipHash: 'h', idemScopeKey: 'k12345678' }); } catch (e) { err = e; }
  assert('default transport: recognized marker preserved', err && err.code === 'AUTH_FORBIDDEN_ROLE');
  assert('default transport: no PostgREST body/detail leaked in error', err && err.message === 'AUTH_FORBIDDEN_ROLE' && !/secret sql text/.test(String(err.message)));
  assert('default transport: single fetch on error (no retry)', FCALLS.length === 1);

  FCALLS = []; NEXT = { ok: false, status: 500, body: { code: 'XX000', message: 'some internal db failure detail' } };
  err = null; try { await ddao.voidOrder({ orderId: 'ORD1', reason: 'r', byActor: 'owner', ipHash: 'h', idemScopeKey: 'k12345678' }); } catch (e) { err = e; }
  assert('default transport: unknown db error → internal (no leak)', err && err.code === INTERNAL_ERROR_CODE && !/internal db failure detail/.test(String(err.message)));

  FCALLS = []; NEXT = { ok: false, status: 0, body: null };
  err = null; try { await ddao.markOrderPaid({ orderId: 'ORD1', paymentMethod: 'efectivo', byActor: 'owner', ipHash: 'h', idemScopeKey: 'k12345678' }); } catch (e) { err = e; }
  assert('default transport: transport failure → internal', err && err.code === INTERNAL_ERROR_CODE);

  // ── recognized-code list matches the committed migration markers exactly ─────
  const MIGS = ['migrations/2026-07-15_b7_payment_basis_rpcs.sql', 'migrations/2026-07-15_b7_refund_void_rpcs.sql', 'migrations/2026-07-16_b7_void_digest_replay_fix.sql'];
  const fromSql = new Set();
  for (const m of MIGS) {
    const txt = fs.readFileSync(path.join(__dirname, '..', m), 'utf8');
    (txt.match(/AUTH_[A-Z_]+/g) || []).forEach((x) => fromSql.add(x));
  }
  const listed = new Set(RECOGNIZED_DOMAIN_CODES);
  assert('recognized-code list == exact SQL markers', fromSql.size === listed.size && [...fromSql].every((c) => listed.has(c)) && [...listed].every((c) => fromSql.has(c)), `sql=${[...fromSql].sort().join(',')}`);

  // ── DAO source: no direct table writes / no generic event writer ────────────
  const daoSrc = fs.readFileSync(path.join(__dirname, '..', 'src/auth/financialDao.js'), 'utf8');
  const daoCode = daoSrc.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert('DAO never inserts into order_financial_events', !/order_financial_events/.test(daoCode));
  assert('DAO never writes ordenes directly', !/'ordenes'|"ordenes"|from\(['"]ordenes|rest\/v1\/ordenes/.test(daoCode));
  assert('DAO calls only the four approved RPCs', (() => {
    const invoked = (daoCode.match(/rpc\('(order_[a-z_]+)'/g) || []).map((m) => m.slice(5, -1));
    const allowed = new Set(['order_mark_paid', 'order_import_legacy_payment', 'order_refund', 'order_void']);
    return invoked.length === 4 && invoked.every((n) => allowed.has(n));
  })());
  assert('DAO has no generic financial event writer', !/insertFinancialEvent|writeLedger|insertLedger|order_insert_financial_event/i.test(daoCode));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
