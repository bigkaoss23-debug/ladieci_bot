'use strict';
// Access Control V2 — Block B7A2C: financial ORCHESTRATION service (UNWIRED).
// Four operations one-to-one with the accepted B7A2 SQL RPCs:
//   markPaid → order_mark_paid, importLegacyPayment → order_import_legacy_payment,
//   refund   → order_refund,    voidOrder           → order_void.
// Exposes NO Express route and is NOT imported by index.js; HTTP status mapping is a
// later B7A3 concern. All dependencies injected for offline testing.
//
// SQL is the FINAL authority for authorization, actor role, amount/basis, state and
// pay-state, method validation, legacy confirmation, idempotency digest, replay and
// eligibility. This service only: validates request SHAPE at the application
// boundary, normalizes required strings, takes the actor identity from the TRUSTED
// authenticated context (never the request body), derives the approved IP hash (B3),
// sanitizes metadata (B2), and issues ONE DAO call. It NEVER derives amounts, builds
// digests, decides state, or second-guesses SQL business logic.
//
// deps: { dao, ipHash?, sanitizeMeta?, roleSub?, actors?, logger? }
//   dao        : { markOrderPaid, importLegacyPayment, refundOrder, voidOrder } (B7A2C DAO)
//   ipHash     : (ip) => hash|null                 (B3 ipSecurity.ipHash)
//   sanitizeMeta: (meta) => cleanMeta | throws      (B2 audit.sanitizeMeta)
//   roleSub    : { [role]: Set<actor> }             (B3 jwt.ROLE_SUB) — context integrity
//   actors     : string[] canonical actor allow-list (B2 dao.ACTORS)
//   logger     : optional; by default NOTHING is logged.

const { ACTORS } = require('./dao');
const { sanitizeMeta: auditSanitizeMeta } = require('./audit');
const { ROLE_SUB } = require('./jwt');
const { INTERNAL_ERROR_CODE, RECOGNIZED_DOMAIN_CODES } = require('./financialDao');

const IP_HASH_MAX = 64;                         // must stay ≤ B7A2 SQL cap
const INVALID_REQUEST = 'FINANCIAL_INVALID_REQUEST';
const UNAUTHENTICATED = 'FINANCIAL_UNAUTHENTICATED';
const DOMAIN_SET = new Set(RECOGNIZED_DOMAIN_CODES);

const fail = (code) => Object.freeze({ ok: false, code });

// Required non-empty string → trimmed; otherwise null (rejected by caller).
function reqString(x) {
  if (typeof x !== 'string') return null;
  const t = x.trim();
  return t.length > 0 ? t : null;
}
// Optional reason: trimmed non-empty, else null (SQL enforces blank/mandatory rules).
function normReason(x) {
  if (typeof x !== 'string') return null;
  const t = x.trim();
  return t.length > 0 ? t : null;
}

function createFinancialService(deps = {}) {
  const { dao } = deps;
  const ipHash = typeof deps.ipHash === 'function' ? deps.ipHash : null;
  const sanitizeMeta = typeof deps.sanitizeMeta === 'function' ? deps.sanitizeMeta : auditSanitizeMeta;
  const roleSub = deps.roleSub || ROLE_SUB;
  const actors = Array.isArray(deps.actors) ? deps.actors : ACTORS;
  const logger = deps.logger || null;

  // Safe operational log only (never meta/ip/digest/reason/confirmation/amount body).
  function log(op, orderId, byActor, outcome, code) {
    if (!logger || typeof logger.info !== 'function') return;
    try { logger.info({ op, order_id: orderId, by_actor: byActor, outcome, code: code || null }); } catch (_) { /* never throw from logging */ }
  }

  // Trusted actor identity from verified context (JWT claims {role, sub, sv}); the
  // request body can NEVER supply actor/role/sv. sub must be a canonical actor and, when
  // a role is present, must match the role→sub allow-list (forged-context defense). The
  // context must also carry a valid positive session_version (DB-verified by the B7A3
  // middleware) — it is forwarded to SQL for the atomic under-lock guard.
  function resolveActor(authContext) {
    if (!authContext || typeof authContext !== 'object') return null;
    const sub = authContext.sub;
    if (typeof sub !== 'string' || !actors.includes(sub)) return null;
    if (!Number.isInteger(authContext.sv) || authContext.sv < 1) return null;
    const role = authContext.role;
    if (role !== undefined) {
      const set = roleSub && roleSub[role];
      if (!set || typeof set.has !== 'function' || !set.has(sub)) return null;
    }
    return sub;
  }

  // Approved IP hash or null (fail-closed). Raw IP never leaves this function.
  function resolveIpHash(trustedClientIp) {
    if (!ipHash) return null;
    let h;
    try { h = ipHash(trustedClientIp); } catch (_) { return null; }
    if (typeof h !== 'string') return null;
    const t = h.trim();
    if (t.length === 0 || t.length > IP_HASH_MAX) return null;
    return h;
  }

  // Sanitize metadata via the canonical B2 guard; returns clean object or throws.
  function cleanMeta(metadata) {
    return sanitizeMeta(metadata === undefined ? {} : metadata);
  }

  // Map a DAO outcome to a stable service result. Recognized SQL domain codes stay
  // distinguishable; anything else becomes one internal error. Success (incl. an
  // SQL-provided idempotent replay) is returned intact.
  function ok(result) { return Object.freeze({ ok: true, result }); }
  function mapError(err) {
    const code = err && typeof err.code === 'string' && (DOMAIN_SET.has(err.code) || err.code === INTERNAL_ERROR_CODE)
      ? err.code : INTERNAL_ERROR_CODE;
    return fail(code);
  }

  // ── mark an order paid (fresh basis; amount SQL-derived) ────────────────────
  async function markPaid({ authContext, orderId, paymentMethod, reason, idempotencyKey, trustedClientIp, metadata } = {}) {
    const byActor = resolveActor(authContext);
    if (!byActor) return fail(UNAUTHENTICATED);
    const oid = reqString(orderId), key = reqString(idempotencyKey), method = reqString(paymentMethod);
    if (!oid || !key || !method) { log('mark_paid', orderId, byActor, 'reject', INVALID_REQUEST); return fail(INVALID_REQUEST); }
    let meta; try { meta = cleanMeta(metadata); } catch (_) { return fail(INVALID_REQUEST); }
    const ipH = resolveIpHash(trustedClientIp);
    if (!ipH) return fail(INVALID_REQUEST);
    try {
      const result = await dao.markOrderPaid({
        orderId: oid, paymentMethod: method, reason: normReason(reason),
        byActor, sessionVersion: authContext.sv, ipHash: ipH, meta, idemScopeKey: key,
      });
      log('mark_paid', oid, byActor, 'ok', null);
      return ok(result);
    } catch (e) { const r = mapError(e); log('mark_paid', oid, byActor, 'fail', r.code); return r; }
  }

  // ── import a legacy payment (explicit amount/method + exact confirmation) ────
  async function importLegacyPayment({ authContext, orderId, amount, paymentMethod, reason, confirmation, idempotencyKey, trustedClientIp, metadata } = {}) {
    const byActor = resolveActor(authContext);
    if (!byActor) return fail(UNAUTHENTICATED);
    const oid = reqString(orderId), key = reqString(idempotencyKey), method = reqString(paymentMethod);
    if (!oid || !key || !method) return fail(INVALID_REQUEST);
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return fail(INVALID_REQUEST);
    // confirmation passed verbatim (SQL uses exact IS DISTINCT FROM); non-string → null.
    const confirm = typeof confirmation === 'string' ? confirmation : null;
    let meta; try { meta = cleanMeta(metadata); } catch (_) { return fail(INVALID_REQUEST); }
    const ipH = resolveIpHash(trustedClientIp);
    if (!ipH) return fail(INVALID_REQUEST);
    try {
      const result = await dao.importLegacyPayment({
        orderId: oid, amount, paymentMethod: method, reason: normReason(reason),
        byActor, sessionVersion: authContext.sv, ipHash: ipH, meta, idemScopeKey: key, confirm,
      });
      log('import_legacy_payment', oid, byActor, 'ok', null);
      return ok(result);
    } catch (e) { const r = mapError(e); log('import_legacy_payment', oid, byActor, 'fail', r.code); return r; }
  }

  // ── refund an order (amount/method SQL-derived from basis) ───────────────────
  async function refund({ authContext, orderId, reason, idempotencyKey, trustedClientIp, metadata } = {}) {
    const byActor = resolveActor(authContext);
    if (!byActor) return fail(UNAUTHENTICATED);
    const oid = reqString(orderId), key = reqString(idempotencyKey);
    if (!oid || !key) return fail(INVALID_REQUEST);
    let meta; try { meta = cleanMeta(metadata); } catch (_) { return fail(INVALID_REQUEST); }
    const ipH = resolveIpHash(trustedClientIp);
    if (!ipH) return fail(INVALID_REQUEST);
    try {
      const result = await dao.refundOrder({
        orderId: oid, reason: normReason(reason), byActor, sessionVersion: authContext.sv, ipHash: ipH, meta, idemScopeKey: key,
      });
      log('refund', oid, byActor, 'ok', null);
      return ok(result);
    } catch (e) { const r = mapError(e); log('refund', oid, byActor, 'fail', r.code); return r; }
  }

  // ── void an order (→ ANULADO; amount 0/method NULL SQL-authoritative) ────────
  async function voidOrder({ authContext, orderId, reason, idempotencyKey, trustedClientIp, metadata } = {}) {
    const byActor = resolveActor(authContext);
    if (!byActor) return fail(UNAUTHENTICATED);
    const oid = reqString(orderId), key = reqString(idempotencyKey);
    if (!oid || !key) return fail(INVALID_REQUEST);
    let meta; try { meta = cleanMeta(metadata); } catch (_) { return fail(INVALID_REQUEST); }
    const ipH = resolveIpHash(trustedClientIp);
    if (!ipH) return fail(INVALID_REQUEST);
    try {
      const result = await dao.voidOrder({
        orderId: oid, reason: normReason(reason), byActor, sessionVersion: authContext.sv, ipHash: ipH, meta, idemScopeKey: key,
      });
      log('void', oid, byActor, 'ok', null);
      return ok(result);
    } catch (e) { const r = mapError(e); log('void', oid, byActor, 'fail', r.code); return r; }
  }

  return { markPaid, importLegacyPayment, refund, voidOrder };
}

module.exports = {
  createFinancialService,
  INVALID_REQUEST,
  UNAUTHENTICATED,
};
