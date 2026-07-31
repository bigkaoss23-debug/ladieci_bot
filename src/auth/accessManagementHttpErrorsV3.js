'use strict';
// Access Control V3 -- Block V3-F: centralized owner-access-management domain-code ->
// HTTP status mapping (ISOLATED, UNWIRED). ONE table, so no handler ever scatters a
// status decision inline. Unknown/unmapped code fails CLOSED to a sanitized 500. Never
// emits SQL text, raw body, proof, or transport detail -- callers return only
// { ok:false, code }. Mirrors financialHttpErrors.js's discipline exactly.

// Explicit class per code. Classes:
//  401 -- unauthenticated / stale-unusable authenticated actor identity
//  403 -- authenticated actor forbidden (non-owner, inactive) / missing-invalid step-up
//  404 -- target outside the workspace or not found (never distinguished from "forbidden")
//  400 -- structurally invalid client input
//  409 -- valid request conflicting with idempotency/PIN-uniqueness/lifecycle-safety state
//  503 -- required server configuration missing
//  500 -- internal / unknown (fail closed)
const STATUS_BY_CODE = Object.freeze({
  // ── 401 ──────────────────────────────────────────────────────────────────────
  AUTH_UNAUTHENTICATED: 401,
  AUTH_SESSION_STALE: 401,
  AUTH_ACTOR_NOT_FOUND: 401,
  // ── 403 ──────────────────────────────────────────────────────────────────────
  AUTH_FORBIDDEN_ROLE: 403,
  AUTH_INITIATOR_INACTIVE: 403,
  AUTH_STEP_UP_REQUIRED: 403,
  // ── 404 ──────────────────────────────────────────────────────────────────────
  AUTH_TARGET_NOT_FOUND: 404,
  // ── 400 (client input) ──────────────────────────────────────────────────────
  AUTH_INVALID_REQUEST: 400,
  AUTH_CLIENT_REQUEST_ID_INVALID: 400,
  AUTH_ROLE_INVALID: 400,
  AUTH_DISPLAY_NAME_INVALID: 400,
  AUTH_PIN_FORMAT_INVALID: 400,
  // ── 409 (state conflict) ────────────────────────────────────────────────────
  AUTH_IDEMPOTENCY_CONFLICT: 409,
  AUTH_PIN_DUPLICATE: 409,
  AUTH_PIN_RESERVED: 409,
  AUTH_WAITER_DEACTIVATION_REQUIRES_TABLE_GUARD: 409,
  // ── 503 ──────────────────────────────────────────────────────────────────────
  AUTH_ACCESS_MANAGEMENT_UNAVAILABLE: 503,
  // ── 500 ──────────────────────────────────────────────────────────────────────
  AUTH_ACCESS_MANAGEMENT_INTERNAL_ERROR: 500,
});

// Fail-closed lookup: unknown / unmapped code -> sanitized 500.
function statusForCode(code) {
  return Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : 500;
}

const UNAUTHENTICATED = 'AUTH_UNAUTHENTICATED';
const INTERNAL_ERROR_CODE = 'AUTH_ACCESS_MANAGEMENT_INTERNAL_ERROR';

module.exports = { STATUS_BY_CODE, statusForCode, UNAUTHENTICATED, INTERNAL_ERROR_CODE };
