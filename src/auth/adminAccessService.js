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
//         listActorsForVerify?, logger? }
//   dao          : { adminSetActorPin, adminRevokeActorSessions, adminSetActorActive,
//                    adminUnlockActor, getActorSafe }
//   hashPin      : async (pin) => scryptHash                 (B1 scrypt.hashPin)
//   pinPolicy    : { validatePinFormat(pin, role) }          (B3 shared policy)
//   ipHash       : (ip) => hash|null                         (B3 ipSecurity.ipHash)
//   getTargetActor: async (actor) => { actor, role, active }|null (default dao.getActorSafe)
//   logger       : optional; by default NOTHING is logged (no sensitive redaction needed)

const { ACTORS } = require('./dao');           // canonical actor list (reuse, no 2nd validator)
const { sanitizeMeta } = require('./audit');   // canonical structural meta guard (reuse)

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
  const { dao, hashPin, verifyPin, pinPolicy, ipHash } = deps;
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

  // ── set target actor PIN ───────────────────────────────────────────────────
  async function setActorPin({ byActor, targetActor, newPin, confirmation, trustedClientIp, metadata } = {}) {
    try {
      if (!isCanonicalActor(byActor) || !isCanonicalActor(targetActor)) return ADMIN_FAIL;

      let meta;
      try { meta = sanitizeAdminMeta(metadata); } catch (_) { return ADMIN_FAIL; }

      // authoritative role from DAO drives the PIN policy AND the RPC expected role
      const role = await resolveTargetRole(targetActor);
      if (!role) return ADMIN_FAIL;

      // policy BEFORE any hashing (cheap format/policy gate)
      if (!pinPolicy || !pinPolicy.validatePinFormat(newPin, role).ok) return ADMIN_FAIL;

      // Fail closed when the proposed PIN already belongs to another ACTIVE actor.
      // This intentionally reuses the accepted scrypt verifier and the login-only
      // sensitive DAO read. Hashes never leave this backend boundary and are neither
      // returned nor logged. All four comparisons are performed to avoid exposing the
      // matching actor through early-exit timing.
      if (typeof listActorsForVerify !== 'function' || typeof verifyPin !== 'function') return ADMIN_FAIL;
      let actors;
      try { actors = await listActorsForVerify(); } catch (_) { return ADMIN_FAIL; }
      if (!Array.isArray(actors)) return ADMIN_FAIL;
      let duplicate = false;
      for (const actorRow of actors) {
        if (!actorRow || actorRow.active !== true || actorRow.actor === targetActor) continue;
        let matched = false;
        try { matched = await verifyPin(newPin, actorRow.pin_hash); } catch (_) { matched = false; }
        if (matched) duplicate = true;
      }
      if (duplicate) return ADMIN_FAIL;

      // owner self-change requires the exact phrase (no normalization); passed to
      // SQL only for owner→owner, never stored/returned/logged.
      let confirm = null;
      if (byActor === OWNER && targetActor === OWNER) {
        if (confirmation !== 'CHANGE_OWNER_PIN') return ADMIN_FAIL;
        confirm = 'CHANGE_OWNER_PIN';
      }

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return ADMIN_FAIL; // fail closed if IP hashing unavailable/invalid

      if (typeof hashPin !== 'function') return ADMIN_FAIL;
      let pinHash;
      try { pinHash = await hashPin(newPin); } catch (_) { return ADMIN_FAIL; } // hashed exactly once
      if (typeof pinHash !== 'string' || pinHash.slice(0, 7) !== 'scrypt$') return ADMIN_FAIL;

      let result;
      try {
        result = await dao.adminSetActorPin({
          byActor, targetActor, expectedRole: role, pinHash, ipHash: ipH, meta, confirm,
        });
      } catch (_) { return ADMIN_FAIL; }
      pinHash = null; // release reference (plaintext newPin is not retained here)

      return sanitizeSuccess(result);
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

  // ── set target actor active state ──────────────────────────────────────────
  async function setActorActive({ byActor, targetActor, active, trustedClientIp, metadata } = {}) {
    try {
      if (!isCanonicalActor(byActor) || !isCanonicalActor(targetActor)) return ADMIN_FAIL;
      if (active !== true && active !== false) return ADMIN_FAIL; // strict boolean; no coercion

      let meta;
      try { meta = sanitizeAdminMeta(metadata); } catch (_) { return ADMIN_FAIL; }

      // reject self-disable early (SQL enforces it too)
      if (byActor === targetActor && active === false) return ADMIN_FAIL;

      const role = await resolveTargetRole(targetActor);
      if (!role) return ADMIN_FAIL;

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return ADMIN_FAIL;

      let result;
      try {
        result = await dao.adminSetActorActive({
          byActor, targetActor, expectedRole: role, active, ipHash: ipH, meta,
        });
      } catch (_) { return ADMIN_FAIL; }

      return sanitizeSuccess(result); // preserves SQL `changed`
    } catch (_) { return ADMIN_FAIL; }
  }

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

  return { setActorPin, revokeActorSessions, setActorActive, unlockActor };
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
