'use strict';
// Access Control V2 — routine admin-access orchestration service.
// Day-to-day admin management of any actor's PIN / sessions / active-state / lock.
// NOT a human-JWT flow here and NOT a B4 router action — this module exposes NO
// Express route and is NOT imported by index.js. All dependencies are injected for
// offline testing. External result is ALWAYS a single generic failure shape — it
// never reveals which check failed (no initiator/target/role/confirm/state oracle).
//
// The SQL RPC (B6A) is the FINAL authority for initiator existence/role/active,
// target existence/stored-role, self-protection and atomic mutation. This service
// only: validates non-secret shape, resolves the target's AUTHORITATIVE role from
// the DAO to pick the PIN policy (and passes it as the RPC's expected role, which
// SQL re-verifies under lock — closing the role-change race), hashes the PIN (B1),
// derives the approved IP hash (B3), sanitizes metadata, and issues ONE atomic RPC.
//
// deps: { dao, hashPin, verifyPin, pinPolicy, ipHash, getTargetActor?,
//         listActorsForVerify?, logger?, verifyStepUpProof?, isValidAuthMethod? }
//   dao          : { adminSetActorPin, adminRevokeActorSessions, adminSetActorActive,
//                    adminUnlockActor, getActorSafe }
//   hashPin      : async (pin) => scryptHash                 (B1 scrypt.hashPin)
//   pinPolicy    : { validatePinFormat(pin, role) }          (B3 shared policy)
//   ipHash       : (ip) => hash|null                         (B3 ipSecurity.ipHash)
//   getTargetActor: async (actor) => { actor, role, active }|null (default dao.getActorSafe)
//   logger       : optional; by default NOTHING is logged (no sensitive redaction needed)
//   verifyStepUpProof(token, {sid, authMethod}) -> payload|null  (S2-7D6E4 step-up proof
//                                                     verifier; binds to the per-login session
//                                                     id, not a hash of the Bearer, AND to the
//                                                     session's auth_method (S2-7D4C) — see
//                                                     src/auth/jwt.js)
//   isValidAuthMethod(m) -> boolean                  (S2-7D4C closed-enum check — INJECTED,
//                                                     not required directly: this module stays
//                                                     transport/JWT-free, see jwt.isValidAuthMethod)

const { ACTORS } = require('./dao');           // canonical actor list (reuse, no 2nd validator)
const { sanitizeMeta } = require('./audit');   // canonical structural meta guard (reuse)
// S2-7D4C — isValidAuthMethod is INJECTED (deps.isValidAuthMethod), same as verifyStepUpProof:
// this module never requires ./jwt directly (enforced by adminAccessBoundary.static.test.js —
// B6B stays transport/auth-free, no JWT parsing of its own).

const ADMIN_FAIL = Object.freeze({ ok: false, error: 'admin_action_failed' });
const SUPPORTED_ROLES = Object.freeze(['admin', 'operator', 'rider']);
const IP_HASH_MAX = 64;                         // must stay ≤ B6A SQL cap
const OWNER = 'owner';

// Canonical identifier only — exact match, no trimming / case folding / fuzzing.
function isCanonicalActor(x) { return typeof x === 'string' && ACTORS.includes(x); }

// Extra sensitive keys required by B6B on top of the canonical audit guard.
const NORM_EXTRA_SENSITIVE = Object.freeze(new Set(['pinhash', 'rawip', 'confirmation']));
const normalizeKey = (k) => String(k).toLowerCase().replace(/[_\-\s]/g, '');

// Dedicated B6-compatible metadata sanitizer: reuses the canonical guard (object
// only, depth/keys/size, canonical sensitive keys) then rejects the extra B6 keys
// (pin_hash / raw_ip / confirmation) and returns a fresh CLONE (caller not mutated).
// Throws on any violation.
function sanitizeAdminMeta(meta) {
  const base = sanitizeMeta(meta === undefined ? {} : meta); // throws on structural/canonical-sensitive
  const walk = (node) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const k of Object.keys(node)) {
        if (NORM_EXTRA_SENSITIVE.has(normalizeKey(k))) throw new Error('meta sensitive key');
        walk(node[k]);
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    }
  };
  walk(base);
  return JSON.parse(JSON.stringify(base)); // deep clone of a validated JSON-only object
}

function createAdminAccessService(deps = {}) {
  const { dao, hashPin, verifyPin, pinPolicy, ipHash, rotation, verifyStepUpProof, isValidAuthMethod } = deps;
  const getTargetActor = deps.getTargetActor || (dao && dao.getActorSafe);
  const listActorsForVerify = deps.listActorsForVerify;

  // Approved IP hash or null (fail-closed). Raw IP never leaves this function.
  function resolveIpHash(trustedClientIp) {
    if (typeof ipHash !== 'function') return null;
    let h;
    try { h = ipHash(trustedClientIp); } catch (_) { return null; }
    if (typeof h !== 'string') return null;
    const t = h.trim();
    if (t.length === 0 || t.length > IP_HASH_MAX) return null;
    return h;
  }

  // Resolve the target's AUTHORITATIVE role (never caller-supplied). Returns the
  // supported role string, or null if unresolved/unsupported.
  async function resolveTargetRole(targetActor) {
    if (typeof getTargetActor !== 'function') return null;
    let row;
    try { row = await getTargetActor(targetActor); } catch (_) { return null; }
    if (!row || typeof row.role !== 'string' || !SUPPORTED_ROLES.includes(row.role)) return null;
    return row.role;
  }

  // ── set target actor PIN — via THE canonical rotation protocol (S2-7D2) ────
  // Previously this called the legacy auth_admin_set_actor_pin RPC, which locked only
  // (initiator, target) and did no cross-actor duplicate check — a second writer that made
  // the PIN-uniqueness invariant impossible. It now shares pinRotationService with the
  // account-owner path: exactly six digits, workspace-scoped uniqueness, one lock order.
  // The external failure shape stays a SINGLE generic error (accepted B6 contract): a
  // duplicate is not distinguishable from any other rejection on this surface.
  async function setActorPin({
    byActor, byRole, bySv, targetActor, newPin, confirmation, trustedClientIp, metadata,
    stepUpProof, bySid, byAuthMethod,
  } = {}) {
    try {
      if (!isCanonicalActor(byActor) || !isCanonicalActor(targetActor)) return ADMIN_FAIL;
      // S2-7D6E4 — defense in depth. The legacy dispatcher already gates this action to
      // admin via legacyActionRoles/req.authCtx, but a normal admin session, BY ITSELF,
      // must never be enough to change a PIN — that authorization boundary is re-asserted
      // here, right before the one place that actually mutates a PIN.
      if (byRole !== 'admin') return ADMIN_FAIL;
      if (!Number.isInteger(bySv) || bySv < 1) return ADMIN_FAIL;
      try { sanitizeAdminMeta(metadata); } catch (_) { return ADMIN_FAIL; }
      if (!rotation || typeof rotation.rotate !== 'function') return ADMIN_FAIL;
      if (typeof verifyStepUpProof !== 'function') return ADMIN_FAIL;
      if (typeof isValidAuthMethod !== 'function') return ADMIN_FAIL;

      // ── step-up enforcement ────────────────────────────────────────────────
      // Must exist, be unexpired, signed by us, minted for THIS actor/role/session_version/
      // purpose, and bound to the SAME per-login session id (bySid) AND the SAME server-derived
      // auth_method (byAuthMethod, S2-7D4C) making THIS request — a proof from a different
      // session of the same actor at the same session_version is rejected too, because its
      // embedded sid will not match this request's sid, and a proof minted under a different
      // auth_method is rejected because its embedded `am` will not match this session's method.
      // A caller with no sid, or no recognized auth_method, at all (a session signed before
      // this change) is refused outright: there is no weaker fallback for PIN management.
      if (typeof stepUpProof !== 'string' || stepUpProof.length === 0) return ADMIN_FAIL;
      if (typeof bySid !== 'string' || bySid.length === 0) return ADMIN_FAIL;
      if (!isValidAuthMethod(byAuthMethod)) return ADMIN_FAIL;
      let proof;
      try { proof = verifyStepUpProof(stepUpProof, { sid: bySid, authMethod: byAuthMethod }); } catch (_) { proof = null; }
      if (!proof) return ADMIN_FAIL;
      if (proof.purpose !== 'manage_pins') return ADMIN_FAIL;
      if (proof.sub !== byActor || proof.role !== byRole || proof.sv !== bySv) return ADMIN_FAIL;
      // ── end step-up enforcement ────────────────────────────────────────────

      // owner self-change still requires the exact phrase; SQL re-checks it under lock.
      let confirm = null;
      if (byActor === OWNER && targetActor === OWNER) {
        if (confirmation !== 'CHANGE_OWNER_PIN') return ADMIN_FAIL;
        confirm = 'CHANGE_OWNER_PIN';
      }

      const r = await rotation.rotate({
        targetActor, newPin, trustedClientIp,
        callerKind: 'operational_admin', byActor, confirm,
      });
      if (!r || r.ok !== true) return ADMIN_FAIL;   // duplicate/stale/policy all collapse here
      return sanitizeSuccess({
        actor: r.actor, role: r.role, active: r.active,
        session_version: r.sessionVersion, failed_count: r.failedCount,
        locked_until: r.lockedUntil, updated_at: r.updatedAt, updated_by: r.updatedBy,
        changed: true, event: r.event,
      });
    } catch (_) { return ADMIN_FAIL; }
  }

  // ── revoke target actor sessions ───────────────────────────────────────────
  async function revokeActorSessions({ byActor, targetActor, confirmation, trustedClientIp, metadata } = {}) {
    try {
      if (!isCanonicalActor(byActor) || !isCanonicalActor(targetActor)) return ADMIN_FAIL;

      let meta;
      try { meta = sanitizeAdminMeta(metadata); } catch (_) { return ADMIN_FAIL; }

      const role = await resolveTargetRole(targetActor);
      if (!role) return ADMIN_FAIL;

      let confirm = null;
      if (byActor === OWNER && targetActor === OWNER) {
        if (confirmation !== 'REVOKE_OWNER_SESSIONS') return ADMIN_FAIL;
        confirm = 'REVOKE_OWNER_SESSIONS';
      }

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return ADMIN_FAIL;

      let result;
      try {
        result = await dao.adminRevokeActorSessions({
          byActor, targetActor, expectedRole: role, ipHash: ipH, meta, confirm,
        });
      } catch (_) { return ADMIN_FAIL; }

      return sanitizeSuccess(result);
    } catch (_) { return ADMIN_FAIL; }
  }

  // ── set target actor active state — REMOVED (S2-7D2) ──────────────────────
  // auth_admin_set_actor_active is fail-closed by the writer cutover: no runtime route
  // exposed it, and reactivating an actor whose stored PIN already belongs to an active
  // actor would create a duplicate without any rotation. Activation returns in a later block,
  // rebuilt on the canonical workspace lock with duplicate validation.

  // ── unlock target actor ────────────────────────────────────────────────────
  async function unlockActor({ byActor, targetActor, trustedClientIp, metadata } = {}) {
    try {
      if (!isCanonicalActor(byActor) || !isCanonicalActor(targetActor)) return ADMIN_FAIL;

      let meta;
      try { meta = sanitizeAdminMeta(metadata); } catch (_) { return ADMIN_FAIL; }

      const role = await resolveTargetRole(targetActor);
      if (!role) return ADMIN_FAIL;

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return ADMIN_FAIL;

      let result;
      try {
        result = await dao.adminUnlockActor({
          byActor, targetActor, expectedRole: role, ipHash: ipH, meta,
        });
      } catch (_) { return ADMIN_FAIL; }

      return sanitizeSuccess(result); // preserves SQL `changed`; no local sv bump
    } catch (_) { return ADMIN_FAIL; }
  }

  return { setActorPin, revokeActorSessions, unlockActor };
}

// Wrap a sanitized DAO result as a frozen success payload. The DAO already
// whitelists fields (never pin_hash); this only re-shapes and fails closed on a
// missing actor/session_version.
function sanitizeSuccess(result) {
  if (!result || typeof result !== 'object' || typeof result.actor !== 'string'
      || !Number.isInteger(result.session_version)) return ADMIN_FAIL;
  return Object.freeze({
    ok: true,
    actor: result.actor,
    role: result.role,
    active: result.active,
    session_version: result.session_version,
    failed_count: result.failed_count,
    locked_until: result.locked_until,
    updated_at: result.updated_at,
    updated_by: result.updated_by,
    changed: result.changed,
    event: result.event,
  });
}

module.exports = { createAdminAccessService, sanitizeAdminMeta, ADMIN_FAIL, SUPPORTED_ROLES };
