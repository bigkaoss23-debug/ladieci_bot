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
// deps: { dao, rotation, slug, displayName, logger? }

const FAIL = Object.freeze({ ok: false, error: 'account_action_failed' });
// Neutral duplicate outcome — never says WHICH actor already uses the PIN.
const DUPLICATE = Object.freeze({ ok: false, error: 'pin_duplicate' });
const OWNER_ACTOR = 'owner';

function isUuid(x) {
  return typeof x === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
}

function createWorkspaceOwnerService(deps = {}) {
  const { dao, rotation } = deps;   // rotation = canonical pinRotationService
  const SLUG = deps.slug || 'la-dieci';
  const DISPLAY_NAME = deps.displayName || 'La Dieci';

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

  // ── create / rotate the owner PIN — via THE canonical rotation protocol ────
  // Delegates to pinRotationService so the account path and the operational-admin path share
  // one protocol, one lock order and one uniqueness check. Anything else would leave a second
  // writer able to break the invariant.
  async function setOwnerPin({ userId, workspaceId, newPin, trustedClientIp } = {}) {
    try {
      if (!isUuid(userId) || !isUuid(workspaceId)) return FAIL;
      if (!rotation || typeof rotation.rotate !== 'function') return FAIL;

      const r = await rotation.rotate({
        targetActor: OWNER_ACTOR,
        newPin,
        trustedClientIp,
        callerKind: 'account_owner',
        userId,
        workspaceId,
      });
      if (r && r.error === 'pin_duplicate') return DUPLICATE;
      if (!r || r.ok !== true) return FAIL;
      return Object.freeze({
        ok: true,
        actor: r.actor,
        sessionVersion: r.sessionVersion,
        event: r.event, // 'pin_set' | 'pin_change'
      });
    } catch (_) { return FAIL; }
  }

  return { claimWorkspace, setOwnerPin };
}

module.exports = { createWorkspaceOwnerService, FAIL, DUPLICATE };
