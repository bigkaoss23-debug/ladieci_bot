'use strict';
// S2-7D6E — THE canonical operator payment registration.
//
// WHY THIS EXISTS. Before this module the operator "Efectivo" click reached the backend
// as `updateEstado(RETIRADO, metodo_pago)`. `cambiaStato` writes `cobrado` ONLY when the
// caller passes it (agentOrdini.js), and the frontend never did — so a real cash sale
// landed as estado=RETIRADO / metodo_pago='efectivo' / cobrado=false with ZERO rows in
// order_financial_events. The closeout reads the ledger and falls back to `cobrado`, so
// the money was invisible: proven live on staging, order #723, Cobrado 0.00 / Pendiente
// 12.00 on a 12.00 cash sale. Worse, serata_summary sums `totale` by `metodo_pago`
// ignoring both the ledger and `cobrado`, so the archived summary reported 12.00 for the
// same service the closeout reported 0.00.
//
// THE FIX IS NOT `cobrado = true`. Setting the boolean would only make the two broken
// accounting systems agree on a number neither of them derived from a payment record.
// Payment is an EVENT, and the ledger that records it already exists (B7A2): the four
// order_* RPCs, the DAO, and the service were built, tested and left UNWIRED from the
// operator flow. This module is the missing wire — it adds no SQL, derives no amount and
// builds no digest.
//
// PAYMENT AND OPERATIONAL STATE ARE DISTINCT. RETIRADO means "the customer took it", not
// "we were paid". The caller must register the payment FIRST and transition ONLY on
// success; on failure the order stays where it is and the operator retries. That ordering
// is the whole contract — see index.js call sites.
//
// IDEMPOTENCY. The scope key is DETERMINISTIC per order: `pay-order-<sanitized id>`.
// SQL enforces uniqueness on (service_session_id, order_id, type, idem_scope_key) AND a
// single payment basis per (service_session_id, order_id). A deterministic key therefore
// turns a double click into a digest-identical REPLAY that returns `idempotent: true`,
// instead of the AUTH_BASIS_EXISTS error a random per-request UUID would produce. The
// session is not part of the key because SQL partitions by it already — the same order id
// recycled into a later service gets a fresh basis, correctly.
//
// deps: { financialService, logger? }
//   financialService: { markPaid } — the accepted B7A2C service (src/auth/financialService)

const PAYMENT_METHODS = Object.freeze(new Set(['efectivo', 'tarjeta', 'bizum']));

// Caller-facing codes. Deliberately distinct from the SQL domain codes so a call site can
// tell "we could not even try" from "SQL refused".
const CONTEXT_UNAVAILABLE = 'PAYMENT_CONTEXT_UNAVAILABLE';
const METHOD_INVALID = 'PAYMENT_METHOD_INVALID';
const ORDER_INVALID = 'PAYMENT_ORDER_INVALID';

// SQL raises this when the order already carries the legacy booleans (ya_pagado/cobrado).
// That is NOT a failure of this operation: the money was already recorded, just in the
// pre-ledger representation. Re-recording it would double-count. The order may proceed.
const LEGACY_ALREADY_PAID = 'AUTH_LEGACY_IMPORT_REQUIRED';

const fail = (code) => Object.freeze({ ok: false, code });

// `ordenes.id` values look like `#723`; the SQL CHECK on idem_scope_key is
// ^[A-Za-z0-9_-]{8,128}$, so `#` must go and the prefix guarantees the 8-char minimum.
function buildIdemScopeKey(orderId) {
  const cleaned = String(orderId == null ? '' : orderId).replace(/[^A-Za-z0-9_-]/g, '');
  if (cleaned.length === 0) return null;
  return `pay-order-${cleaned}`.slice(0, 128);
}

// The legacy guard (legacyAuthGuard.js) builds req.authCtx = {actor, role, sv, ...} with a
// DB-verified session_version. The financial service demands JWT-shaped {sub, role, sv}
// and takes the actor from there and NEVER from the request body.
function toAuthContext(authCtx) {
  if (!authCtx || typeof authCtx !== 'object') return null;
  const { actor, role, sv } = authCtx;
  if (typeof actor !== 'string' || actor.length === 0) return null;
  if (!Number.isInteger(sv) || sv < 1) return null;
  return { sub: actor, role, sv };
}

function createOperatorPaymentRegistrar(deps = {}) {
  const { financialService } = deps;
  const logger = deps.logger || null;

  function log(orderId, outcome, code) {
    if (!logger || typeof logger.info !== 'function') return;
    try {
      logger.info({ op: 'operator_payment', order_id: orderId, outcome, code: code || null });
    } catch (_) { /* never throw from logging */ }
  }

  // Returns:
  //   { ok:true,  result, idempotent }             — ledger event written (or replayed)
  //   { ok:true,  alreadyPaidLegacy:true }         — pre-ledger payment already on record
  //   { ok:false, code }                           — nothing written; caller MUST NOT transition
  async function registerPayment({ orderId, paymentMethod, authCtx, trustedClientIp, origin } = {}) {
    const oid = typeof orderId === 'string' ? orderId.trim() : '';
    if (oid.length === 0) return fail(ORDER_INVALID);

    const method = typeof paymentMethod === 'string' ? paymentMethod.trim().toLowerCase() : '';
    if (!PAYMENT_METHODS.has(method)) { log(oid, 'reject', METHOD_INVALID); return fail(METHOD_INVALID); }

    // Fail closed. Without a verified actor + session_version we cannot write the ledger,
    // and silently falling back to the legacy booleans is precisely the defect being fixed.
    // NOTE: this makes AUTH_V2_LEGACY_GUARD_ENABLED a hard prerequisite for taking payment.
    const authContext = toAuthContext(authCtx);
    if (!authContext) { log(oid, 'reject', CONTEXT_UNAVAILABLE); return fail(CONTEXT_UNAVAILABLE); }

    const idempotencyKey = buildIdemScopeKey(oid);
    if (!idempotencyKey) return fail(ORDER_INVALID);

    if (!financialService || typeof financialService.markPaid !== 'function') {
      log(oid, 'reject', CONTEXT_UNAVAILABLE);
      return fail(CONTEXT_UNAVAILABLE);
    }

    const res = await financialService.markPaid({
      authContext,
      orderId: oid,
      paymentMethod: method,
      idempotencyKey,
      trustedClientIp,
      metadata: { source: `operator_${typeof origin === 'string' && origin ? origin : 'dashboard'}` },
    });

    if (res && res.ok) {
      const idempotent = !!(res.result && res.result.idempotent);
      log(oid, idempotent ? 'replay' : 'ok', null);
      return Object.freeze({ ok: true, result: res.result, idempotent });
    }

    if (res && res.code === LEGACY_ALREADY_PAID) {
      // Already paid before the ledger existed (or by a path that still writes the
      // booleans). Not a new collection — do not import silently, that needs an explicit
      // amount + confirmation. Let the operational transition proceed.
      log(oid, 'already_paid_legacy', LEGACY_ALREADY_PAID);
      return Object.freeze({ ok: true, alreadyPaidLegacy: true });
    }

    const code = (res && res.code) || 'FINANCIAL_INTERNAL_ERROR';
    log(oid, 'fail', code);
    return fail(code);
  }

  return { registerPayment };
}

module.exports = {
  createOperatorPaymentRegistrar,
  buildIdemScopeKey,
  PAYMENT_METHODS,
  CONTEXT_UNAVAILABLE,
  METHOD_INVALID,
  ORDER_INVALID,
  LEGACY_ALREADY_PAID,
};
