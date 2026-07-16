'use strict';
// Access Control V2 — Block B7A3: centralized financial domain-code → HTTP status
// mapping. ONE table, so the four handlers never scatter status decisions. Keyed off
// the B7A2C-exported recognized domain codes + the service boundary codes; any
// unknown/unmapped code fails CLOSED to a sanitized 500. Never emits SQL text, body,
// or transport detail — callers return only { ok:false, code }.

const { RECOGNIZED_DOMAIN_CODES, INTERNAL_ERROR_CODE } = require('./financialDao');
const { INVALID_REQUEST, UNAUTHENTICATED } = require('./financialService');

// Explicit class per code. Classes:
//  401 — unauthenticated / stale-unusable authenticated actor identity
//  403 — authenticated actor forbidden / inactive initiator
//  404 — target order not found
//  400 — structurally invalid client input (incl. unsafe meta / ip boundary)
//  409 — valid request conflicting with financial/order state
//  500 — internal / unknown (fail closed)
const STATUS_BY_CODE = Object.freeze({
  // ── 401 ────────────────────────────────────────────────────────────────────
  [UNAUTHENTICATED]: 401,           // FINANCIAL_UNAUTHENTICATED
  AUTH_ACTOR_NOT_FOUND: 401,        // trusted actor no longer resolvable → unusable identity
  // ── 403 ────────────────────────────────────────────────────────────────────
  AUTH_FORBIDDEN_ROLE: 403,
  AUTH_INITIATOR_INACTIVE: 403,
  // ── 404 ────────────────────────────────────────────────────────────────────
  AUTH_ORDER_NOT_FOUND: 404,
  // ── 400 (client input) ──────────────────────────────────────────────────────
  [INVALID_REQUEST]: 400,           // FINANCIAL_INVALID_REQUEST (shape/ip/meta at boundary)
  AUTH_AMOUNT_INVALID: 400,
  AUTH_CONFIRMATION_REQUIRED: 400,
  AUTH_IDEM_KEY_INVALID: 400,
  AUTH_METHOD_INVALID: 400,
  AUTH_REASON_BLANK: 400,
  AUTH_META_INVALID: 400,
  AUTH_META_TOO_LARGE: 400,
  AUTH_META_SENSITIVE_KEY: 400,
  AUTH_IP_HASH_REQUIRED: 400,
  AUTH_IP_HASH_TOO_LONG: 400,
  // ── 409 (state conflict) ────────────────────────────────────────────────────
  AUTH_IDEMPOTENCY_CONFLICT: 409,
  AUTH_BASIS_EXISTS: 409,
  AUTH_LEGACY_IMPORT_REQUIRED: 409,
  AUTH_NOT_LEGACY_PAID: 409,
  AUTH_NO_PAYMENT_BASIS: 409,
  AUTH_ALREADY_REFUNDED: 409,
  AUTH_VOID_STATE_FORBIDDEN: 409,
  AUTH_REFUND_BASIS_INTEGRITY: 409,
  AUTH_VOID_REPLAY_INTEGRITY: 409,
  // ── 500 ─────────────────────────────────────────────────────────────────────
  [INTERNAL_ERROR_CODE]: 500,       // FINANCIAL_INTERNAL_ERROR
});

// Fail-closed lookup: unknown / unmapped code → sanitized 500.
function statusForCode(code) {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : 500;
}

// Every recognized B7A2C domain code must have an explicit class (guarded in tests).
const UNMAPPED_RECOGNIZED = RECOGNIZED_DOMAIN_CODES.filter(
  (c) => !Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, c));

module.exports = {
  STATUS_BY_CODE,
  statusForCode,
  UNMAPPED_RECOGNIZED,
  UNAUTHENTICATED,
  INVALID_REQUEST,
  INTERNAL_ERROR_CODE,
};
