'use strict';
// S2-7D — account-authenticated workspace-owner orchestration.
//
// TWO operations, both driven ONLY by a verified account identity (userId comes from
// the canonical Supabase-bearer check upstream — never from a request body):
//   * claimWorkspace  : idempotent La Dieci owner bootstrap (guarded by the HTTP layer).
//   * setOwnerPin     : create / rotate the owner/admin operational PIN.
//
// Reuses the EXISTING primitives verbatim — scrypt hashing and verification (B1) and the
// approved IP hash (B3). S2-7D2: the PIN policy for NEW rotations is exactly 6 digits
// (pinPolicy.validateNewPinFormat, no role bypass), and the PIN must not already belong to
// another ACTIVE actor of the same workspace. Plaintext is hashed exactly once and never
// logged/returned/stored. SQL is the final authority on ownership, uniqueness-freshness and
// atomicity.
//
// deps: { dao, hashPin, verifyPin, pinPolicy, ipHash, slug, displayName, logger? }

const FAIL = Object.freeze({ ok: false, error: 'account_action_failed' });
// Neutral duplicate outcome — never says WHICH actor already uses the PIN.
const DUPLICATE = Object.freeze({ ok: false, error: 'pin_duplicate' });
const OWNER_ACTOR = 'owner';
const IP_HASH_MAX = 64;

function isUuid(x) {
  return typeof x === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
}

function createWorkspaceOwnerService(deps = {}) {
  const { dao, hashPin, verifyPin, pinPolicy, ipHash } = deps;
  const SLUG = deps.slug || 'la-dieci';
  const DISPLAY_NAME = deps.displayName || 'La Dieci';

  function resolveIpHash(trustedClientIp) {
    if (typeof ipHash !== 'function') return null;
    let h;
    try { h = ipHash(trustedClientIp); } catch (_) { return null; }
    if (typeof h !== 'string') return null;
    const t = h.trim();
    if (t.length === 0 || t.length > IP_HASH_MAX) return null;
    return h;
  }

  // ── idempotent owner bootstrap ─────────────────────────────────────────────
  async function claimWorkspace({ userId } = {}) {
    try {
      if (!isUuid(userId)) return FAIL;
      if (!dao || typeof dao.claimWorkspace !== 'function') return FAIL;
      let res;
      try { res = await dao.claimWorkspace({ userId, slug: SLUG, displayName: DISPLAY_NAME }); }
      catch (_) { return FAIL; }
      if (!res || typeof res.workspaceId !== 'string') return FAIL;
      return Object.freeze({
        ok: true,
        workspaceId: res.workspaceId,
        created: res.created === true,
        // Onboarding drives PIN-setup requirement — NOT whether the actor has a PIN.
        adminPinRequired: res.onboardingCompleted !== true,
      });
    } catch (_) { return FAIL; }
  }

  // ── create / rotate the owner PIN (S2-7D2: exactly 6 digits + uniqueness) ──
  // Order matters: cheap policy gate → IP hash → uniqueness check against every OTHER active
  // actor of the workspace → hash once → single atomic RPC carrying the verified snapshot.
  // The candidate is compared against ALL other actors (never early-exit) so response timing
  // cannot reveal which actor matched.
  async function setOwnerPin({ userId, workspaceId, newPin, trustedClientIp } = {}) {
    try {
      if (!isUuid(userId) || !isUuid(workspaceId)) return FAIL;

      // exactly six digits, no separators, no letters, no admin bypass
      if (!pinPolicy || typeof pinPolicy.validateNewPinFormat !== 'function') return FAIL;
      if (!pinPolicy.validateNewPinFormat(newPin).ok) return FAIL;

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return FAIL; // fail closed if IP hashing unavailable

      if (typeof dao.listWorkspaceActorsForVerify_SENSITIVE !== 'function'
          || typeof verifyPin !== 'function') return FAIL;

      let actors;
      try { actors = await dao.listWorkspaceActorsForVerify_SENSITIVE(workspaceId); }
      catch (_) { return FAIL; }
      if (!Array.isArray(actors)) return FAIL;

      // Snapshot of every OTHER actor exactly as read; SQL re-validates it under lock.
      const others = actors.filter((a) => a && a.actor !== OWNER_ACTOR);
      const seen = others.map((a) => Object.freeze({
        actor: a.actor, active: a.active === true, pin_hash: a.pin_hash ?? null,
      }));

      // Uniqueness: reject if the candidate already belongs to another ACTIVE actor.
      let duplicate = false;
      for (const a of others) {
        if (!a || a.active !== true || !a.pin_hash) continue;
        let matched = false;
        try { matched = await verifyPin(newPin, a.pin_hash); } catch (_) { matched = false; }
        if (matched) duplicate = true;          // no break — constant work
      }
      if (duplicate) return DUPLICATE;

      let pinHash;
      try { pinHash = await hashPin(newPin); } catch (_) { return FAIL; }
      if (typeof pinHash !== 'string' || pinHash.slice(0, 7) !== 'scrypt$') return FAIL;

      let result;
      try {
        result = await dao.setOwnerPinV2({ userId, workspaceId, pinHash, ipHash: ipH, seen, meta: {} });
      } catch (_) { return FAIL; }   // includes AUTH_ROTATION_STALE → nothing was written
      pinHash = null;

      if (!result || result.actor !== 'owner' || !Number.isInteger(result.sessionVersion)) return FAIL;
      return Object.freeze({
        ok: true,
        actor: result.actor,
        sessionVersion: result.sessionVersion,
        event: result.event, // 'pin_set' | 'pin_change'
      });
    } catch (_) { return FAIL; }
  }

  return { claimWorkspace, setOwnerPin };
}

module.exports = { createWorkspaceOwnerService, FAIL, DUPLICATE };
