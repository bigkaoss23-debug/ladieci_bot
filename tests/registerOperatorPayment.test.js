'use strict';
// S2-7D6E operator payment registrar tests. Run: node tests/registerOperatorPayment.test.js
// Offline: injected fake financial service (NO real DB, no SQL). Proves the contract that
// replaces the defect found live on staging (order #723: RETIRADO + metodo_pago='efectivo'
// but cobrado=false and zero ledger rows):
//   - a collection produces exactly ONE markPaid call, actor/sv taken from the trusted
//     legacy-guard context and never from the body;
//   - the idempotency key is DETERMINISTIC per order, so a double click replays instead of
//     creating a second basis;
//   - failure is a failure: no silent success the caller could mistake for a paid order;
//   - a missing auth context fails CLOSED rather than falling back to legacy booleans;
//   - an order already paid the legacy way is not double-counted but does not block.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const {
  createOperatorPaymentRegistrar, buildIdemScopeKey,
  CONTEXT_UNAVAILABLE, METHOD_INVALID, ORDER_INVALID, LEGACY_ALREADY_PAID,
} = require('../src/financial/registerOperatorPayment');

// ── fake financial service recorder ───────────────────────────────────────────
function makeSvc(behavior = {}) {
  const calls = [];
  return {
    calls,
    markPaid: async (args) => {
      calls.push(args);
      if (behavior.fail) return { ok: false, code: behavior.fail };
      return { ok: true, result: Object.assign({
        event_id: 'e1', order_id: args.orderId, type: 'payment', amount: 12,
        payment_method: args.paymentMethod, prev_pay_state: 'unpaid', new_pay_state: 'paid',
        legacy: false, idempotent: false, created_at: 't',
      }, behavior.result || {}) };
    },
  };
}
// The legacy guard shape (legacyAuthGuard.js builds {actor, role, sv, ...}).
const OP_CTX = { actor: 'operator_primary', role: 'operator', sv: 2 };
const reg = (svc) => createOperatorPaymentRegistrar({ financialService: svc });

(async () => {
  // ── happy path: exactly one ledger call, correctly shaped ───────────────────
  {
    const svc = makeSvc();
    const r = await reg(svc).registerPayment({
      orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX,
      trustedClientIp: '1.2.3.4', origin: 'dashboard',
    });
    assert('cash collection succeeds', r.ok === true, JSON.stringify(r));
    assert('exactly ONE markPaid call', svc.calls.length === 1, String(svc.calls.length));
    const a = svc.calls[0];
    assert('order id forwarded verbatim', a.orderId === '#723', a.orderId);
    assert('method forwarded', a.paymentMethod === 'efectivo', a.paymentMethod);
    assert('actor from trusted ctx (sub)', a.authContext.sub === 'operator_primary', a.authContext.sub);
    assert('session_version from trusted ctx', a.authContext.sv === 2, String(a.authContext.sv));
    assert('client ip forwarded for hashing', a.trustedClientIp === '1.2.3.4', a.trustedClientIp);
    assert('not flagged idempotent on first write', r.idempotent === false, String(r.idempotent));
  }

  // ── idempotency key is deterministic and SQL-legal ──────────────────────────
  {
    const k1 = buildIdemScopeKey('#723');
    const k2 = buildIdemScopeKey('#723');
    assert('key is deterministic', k1 === k2, k1 + ' vs ' + k2);
    assert('key strips the # so it matches the SQL CHECK', /^[A-Za-z0-9_-]+$/.test(k1), k1);
    assert('key respects the 8-char minimum', k1.length >= 8, k1 + ' len=' + k1.length);
    assert('key respects the 128-char maximum', buildIdemScopeKey('x'.repeat(400)).length <= 128);
    assert('different orders get different keys', buildIdemScopeKey('#724') !== k1);
    assert('empty order id yields no key', buildIdemScopeKey('') === null);
  }

  // ── double click → same key → SQL replays, one basis only ───────────────────
  {
    const svc = makeSvc({ result: { idempotent: true } });
    const r1 = await reg(svc).registerPayment({ orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: '1.2.3.4' });
    const r2 = await reg(svc).registerPayment({ orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: '1.2.3.4' });
    assert('replay reported as ok', r1.ok && r2.ok);
    assert('replay flagged idempotent', r2.idempotent === true, String(r2.idempotent));
    assert('both attempts used the SAME idem key', svc.calls[0].idempotencyKey === svc.calls[1].idempotencyKey,
      svc.calls[0].idempotencyKey + ' vs ' + svc.calls[1].idempotencyKey);
  }

  // ── fail closed without a verified actor (guard disabled / no JWT) ──────────
  {
    const svc = makeSvc();
    for (const [label, ctx] of [
      ['missing ctx', undefined],
      ['ctx without actor', { role: 'operator', sv: 2 }],
      ['ctx without session_version', { actor: 'operator_primary', role: 'operator' }],
      ['ctx with invalid session_version', { actor: 'operator_primary', role: 'operator', sv: 0 }],
    ]) {
      const r = await reg(svc).registerPayment({ orderId: '#723', paymentMethod: 'efectivo', authCtx: ctx, trustedClientIp: '1.2.3.4' });
      assert('fails closed — ' + label, r.ok === false && r.code === CONTEXT_UNAVAILABLE, JSON.stringify(r));
    }
    assert('no ledger call attempted without a verified actor', svc.calls.length === 0, String(svc.calls.length));
  }

  // ── method validation: only the three canonical methods are collections ─────
  {
    const svc = makeSvc();
    for (const m of ['manual', '', 'cash', 'EFECTIVO ', null, undefined]) {
      const r = await reg(svc).registerPayment({ orderId: '#723', paymentMethod: m, authCtx: OP_CTX, trustedClientIp: '1.2.3.4' });
      if (m === 'EFECTIVO ') { assert('method is normalised (trim+lowercase)', r.ok === true, JSON.stringify(r)); continue; }
      assert('rejects non-collection method: ' + JSON.stringify(m), r.ok === false && r.code === METHOD_INVALID, JSON.stringify(r));
    }
    assert('tarjeta accepted', (await reg(makeSvc()).registerPayment({ orderId: '#1', paymentMethod: 'tarjeta', authCtx: OP_CTX, trustedClientIp: 'x' })).ok === true);
    assert('bizum accepted', (await reg(makeSvc()).registerPayment({ orderId: '#1', paymentMethod: 'bizum', authCtx: OP_CTX, trustedClientIp: 'x' })).ok === true);
  }

  // ── blank / missing order id ────────────────────────────────────────────────
  {
    const svc = makeSvc();
    for (const oid of ['', '   ', null, undefined, 42]) {
      const r = await reg(svc).registerPayment({ orderId: oid, paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: 'x' });
      assert('rejects invalid order id ' + JSON.stringify(oid), r.ok === false && r.code === ORDER_INVALID, JSON.stringify(r));
    }
    assert('no ledger call for an invalid order id', svc.calls.length === 0);
  }

  // ── a ledger failure must NOT look like success ─────────────────────────────
  {
    for (const code of ['AUTH_SESSION_STALE', 'AUTH_ORDER_NOT_FOUND', 'AUTH_IDEMPOTENCY_CONFLICT', 'FINANCIAL_INTERNAL_ERROR']) {
      const r = await reg(makeSvc({ fail: code })).registerPayment({ orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: 'x' });
      assert('propagates failure ' + code, r.ok === false && r.code === code, JSON.stringify(r));
      assert('failure carries no result the caller could treat as paid — ' + code, r.result === undefined);
    }
  }

  // ── already paid the legacy way: not double counted, not blocking ───────────
  {
    const r = await reg(makeSvc({ fail: LEGACY_ALREADY_PAID })).registerPayment({
      orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: 'x',
    });
    assert('legacy-paid order is allowed through', r.ok === true, JSON.stringify(r));
    assert('legacy-paid order is flagged, not re-recorded', r.alreadyPaidLegacy === true, JSON.stringify(r));
    assert('legacy-paid order produced no ledger result', r.result === undefined);
  }

  // ── a broken/absent service fails closed rather than throwing ───────────────
  {
    const r = await createOperatorPaymentRegistrar({}).registerPayment({
      orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: 'x',
    });
    assert('missing financial service fails closed', r.ok === false && r.code === CONTEXT_UNAVAILABLE, JSON.stringify(r));
  }

  // ── metadata carries provenance, never PII ─────────────────────────────────
  {
    const svc = makeSvc();
    await reg(svc).registerPayment({ orderId: '#723', paymentMethod: 'efectivo', authCtx: OP_CTX, trustedClientIp: 'x', origin: 'entregas' });
    assert('metadata records the operator origin', svc.calls[0].metadata.source === 'operator_entregas', JSON.stringify(svc.calls[0].metadata));
    assert('metadata has no ip/actor leakage', !('ip' in svc.calls[0].metadata) && !('actor' in svc.calls[0].metadata));
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})();
