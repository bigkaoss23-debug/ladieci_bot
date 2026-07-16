'use strict';
// Access Control V2 — Block B7A2C: financial DAO (service_role only). Thin wrappers
// over the four accepted B7A2 SQL RPCs:
//   order_mark_paid, order_import_legacy_payment, order_refund, order_void
// (migrations 2026-07-15_b7_payment_basis_rpcs.sql, 2026-07-15_b7_refund_void_rpcs.sql,
//  2026-07-16_b7_void_digest_replay_fix.sql). UNWIRED: not imported by index.js, no route.
//
// Responsibility boundary (SQL is authoritative — this DAO adds NO business logic):
//  * invoke EXACTLY one approved RPC per method, with the EXACT committed PostgreSQL
//    argument names, through the accepted service_role transport (audit.sbRest);
//  * return the RPC JSON result intact (whitelisted safe fields only);
//  * PRESERVE recognized SQL domain markers (so the future B7A3 handler can map them);
//  * convert any UNKNOWN db/transport failure into ONE sanitized internal error
//    (never echo PostgREST body, SQL text, host, digest, ip, or metadata);
//  * NEVER write order_financial_events / ordenes directly; NEVER a generic event
//    writer; NEVER query pin hashes/secrets; NEVER auto-retry (one call per action).
//
// The DAO is a factory so the privileged RPC channel can be injected in offline
// tests; by default it uses the accepted audit.sbRest service_role transport.

const { sbRest } = require('./audit');

// Exact SQL domain markers RAISEd by the three committed migrations (message text ==
// marker). These stay distinguishable to callers; everything else is internal-only.
const RECOGNIZED_DOMAIN_CODES = Object.freeze([
  'AUTH_ACTOR_NOT_FOUND', 'AUTH_ALREADY_REFUNDED', 'AUTH_AMOUNT_INVALID', 'AUTH_BASIS_EXISTS',
  'AUTH_CONFIRMATION_REQUIRED', 'AUTH_FORBIDDEN_ROLE', 'AUTH_IDEMPOTENCY_CONFLICT',
  'AUTH_IDEM_KEY_INVALID', 'AUTH_INITIATOR_INACTIVE', 'AUTH_IP_HASH_REQUIRED',
  'AUTH_IP_HASH_TOO_LONG', 'AUTH_LEGACY_IMPORT_REQUIRED', 'AUTH_META_INVALID',
  'AUTH_META_SENSITIVE_KEY', 'AUTH_META_TOO_LARGE', 'AUTH_METHOD_INVALID',
  'AUTH_NOT_LEGACY_PAID', 'AUTH_NO_PAYMENT_BASIS', 'AUTH_ORDER_NOT_FOUND',
  'AUTH_REASON_BLANK', 'AUTH_REFUND_BASIS_INTEGRITY', 'AUTH_VOID_REPLAY_INTEGRITY',
  'AUTH_VOID_STATE_FORBIDDEN',
]);
const DOMAIN_SET = new Set(RECOGNIZED_DOMAIN_CODES);
const INTERNAL_ERROR_CODE = 'FINANCIAL_INTERNAL_ERROR';

// Whitelisted, already-sanitized RPC return fields (SQL never returns ip/meta/digest/
// reason). Copying by whitelist is defense-in-depth against future field drift.
const SAFE_RESULT_FIELDS = Object.freeze([
  'event_id', 'order_id', 'type', 'amount', 'payment_method',
  'prev_estado', 'new_estado', 'prev_pay_state', 'new_pay_state',
  'legacy', 'original_giro_id', 'idempotent', 'created_at',
]);

class FinancialDaoError extends Error {
  constructor(code) { super(code); this.name = 'FinancialDaoError'; this.code = code; }
}

// Whitelist + fail-closed shape check of the sanitized RPC result.
function sanitizeResult(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)
      || typeof body.order_id !== 'string' || typeof body.type !== 'string'
      || typeof body.idempotent !== 'boolean') {
    throw new FinancialDaoError(INTERNAL_ERROR_CODE);
  }
  const out = {};
  for (const k of SAFE_RESULT_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

// One approved RPC invocation. Single call — NO retry. Recognized SQL marker is
// preserved; anything else collapses to one opaque internal error (no body leak).
async function defaultRpc(fn, args) {
  const r = await sbRest('POST', `rpc/${fn}`, { body: args });
  if (r && r.ok) return r.body;
  const marker = r && r.body && typeof r.body.message === 'string' ? r.body.message : null;
  if (marker && DOMAIN_SET.has(marker)) throw new FinancialDaoError(marker);
  throw new FinancialDaoError(INTERNAL_ERROR_CODE);
}

// deps.rpc(fn, args) may be injected for offline tests; defaults to the accepted
// service_role transport. No other dependency: the DAO never touches tables.
function createFinancialDao(deps = {}) {
  const rpc = typeof deps.rpc === 'function' ? deps.rpc : defaultRpc;

  // order_mark_paid — amount is SQL-derived from ordenes.totale (caller cannot supply).
  async function markOrderPaid({ orderId, paymentMethod, reason, byActor, ipHash, meta = {}, idemScopeKey } = {}) {
    return sanitizeResult(await rpc('order_mark_paid', {
      p_order_id: orderId, p_payment_method: paymentMethod, p_reason: reason,
      p_by_actor: byActor, p_ip_hash: ipHash, p_meta: meta, p_idem_scope_key: idemScopeKey,
    }));
  }

  // order_import_legacy_payment — explicit historical amount + method + exact confirm.
  async function importLegacyPayment({ orderId, amount, paymentMethod, reason, byActor, ipHash, meta = {}, idemScopeKey, confirm } = {}) {
    return sanitizeResult(await rpc('order_import_legacy_payment', {
      p_order_id: orderId, p_amount: amount, p_payment_method: paymentMethod, p_reason: reason,
      p_by_actor: byActor, p_ip_hash: ipHash, p_meta: meta, p_idem_scope_key: idemScopeKey, p_confirm: confirm,
    }));
  }

  // order_refund — amount/method derived by SQL from the immutable payment basis.
  async function refundOrder({ orderId, reason, byActor, ipHash, meta = {}, idemScopeKey } = {}) {
    return sanitizeResult(await rpc('order_refund', {
      p_order_id: orderId, p_reason: reason, p_by_actor: byActor,
      p_ip_hash: ipHash, p_meta: meta, p_idem_scope_key: idemScopeKey,
    }));
  }

  // order_void — amount 0 / method NULL / state transition all SQL-authoritative.
  async function voidOrder({ orderId, reason, byActor, ipHash, meta = {}, idemScopeKey } = {}) {
    return sanitizeResult(await rpc('order_void', {
      p_order_id: orderId, p_reason: reason, p_by_actor: byActor,
      p_ip_hash: ipHash, p_meta: meta, p_idem_scope_key: idemScopeKey,
    }));
  }

  return { markOrderPaid, importLegacyPayment, refundOrder, voidOrder };
}

module.exports = {
  createFinancialDao,
  FinancialDaoError,
  RECOGNIZED_DOMAIN_CODES,
  INTERNAL_ERROR_CODE,
  SAFE_RESULT_FIELDS,
  sanitizeResult,
};
