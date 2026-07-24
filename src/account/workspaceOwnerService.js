'use strict';
// S2-7D — account-authenticated workspace-owner orchestration.
//
// TWO operations, both driven ONLY by a verified account identity (userId comes from
// the canonical Supabase-bearer check upstream — never from a request body):
//   * claimWorkspace  : idempotent La Dieci owner bootstrap (guarded by the HTTP layer).
//   * setOwnerPin     : create / rotate the owner/admin operational PIN.
//
// Reuses the EXISTING primitives verbatim — the admin PIN policy (pinPolicy, role
// 'admin', 9–12 digits), scrypt hashing (B1), and the approved IP hash (B3). Plaintext
// PIN is hashed exactly once and never logged/returned/stored here. External result is
// a single generic failure shape; SQL is the final authority on ownership + atomicity.
//
// deps: { dao, hashPin, pinPolicy, ipHash, slug, displayName, logger? }

const FAIL = Object.freeze({ ok: false, error: 'account_action_failed' });
const ADMIN_ROLE = 'admin';
const IP_HASH_MAX = 64;

function isUuid(x) {
  return typeof x === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
}

function createWorkspaceOwnerService(deps = {}) {
  const { dao, hashPin, pinPolicy, ipHash } = deps;
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

  // ── create / rotate owner PIN ──────────────────────────────────────────────
  async function setOwnerPin({ userId, workspaceId, newPin, trustedClientIp } = {}) {
    try {
      if (!isUuid(userId) || !isUuid(workspaceId)) return FAIL;

      // numeric admin-PIN policy (reused verbatim); cheap gate BEFORE hashing
      if (!pinPolicy || typeof pinPolicy.validatePinFormat !== 'function') return FAIL;
      if (!pinPolicy.validatePinFormat(newPin, ADMIN_ROLE).ok) return FAIL;

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return FAIL; // fail closed if IP hashing unavailable

      if (typeof hashPin !== 'function') return FAIL;
      let pinHash;
      try { pinHash = await hashPin(newPin); } catch (_) { return FAIL; }
      if (typeof pinHash !== 'string' || pinHash.slice(0, 7) !== 'scrypt$') return FAIL;

      let result;
      try {
        result = await dao.setOwnerPin({ userId, workspaceId, pinHash, ipHash: ipH, meta: {} });
      } catch (_) { return FAIL; }
      pinHash = null; // release reference; plaintext newPin not retained

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

module.exports = { createWorkspaceOwnerService, FAIL };
