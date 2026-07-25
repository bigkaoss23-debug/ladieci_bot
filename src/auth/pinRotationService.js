'use strict';
// S2-7D2 — THE canonical PIN-rotation orchestration, shared by every mutation path:
//   * the account-owner path (verified Supabase owner rotating the 'owner' actor);
//   * the operational-admin path (an active admin actor rotating owner/operator/rider).
//
// Both go through the SAME steps and the SAME RPC, which is what makes the uniqueness
// invariant hold: a second writer with narrower locks and no cross-actor check (the legacy
// auth_admin_set_actor_pin) would break it no matter how careful this path is, which is why
// that function is disabled in migration step B after this code is deployed.
//
// Steps: six-digit policy → IP hash → workspace-scoped snapshot read → verify the candidate
// against EVERY other active actor (constant work, no early exit, so timing reveals nothing)
// → hash once → one atomic RPC carrying the snapshot, which SQL re-validates under the
// workspace lock. Plaintext is never stored, logged, returned, or sent to SQL.

const FAILED = Object.freeze({ ok: false, error: 'rotation_failed' });
const DUPLICATE = Object.freeze({ ok: false, error: 'pin_duplicate' });
const IP_HASH_MAX = 64;

// deps: { dao, hashPin, verifyPin, pinPolicy, ipHash }
//   dao: { listActorsWithWorkspaceForVerify_SENSITIVE, setActorPinV2 }
function createPinRotation(deps = {}) {
  const { dao, hashPin, verifyPin, pinPolicy, ipHash } = deps;

  function resolveIpHash(trustedClientIp) {
    if (typeof ipHash !== 'function') return null;
    let h;
    try { h = ipHash(trustedClientIp); } catch (_) { return null; }
    if (typeof h !== 'string') return null;
    const t = h.trim();
    if (t.length === 0 || t.length > IP_HASH_MAX) return null;
    return h;
  }

  // Returns { ok:true, actor, role, sessionVersion, event, onboardingCompleted }
  //      or { ok:false, error:'pin_duplicate' | 'rotation_failed' }
  async function rotate({
    targetActor, newPin, trustedClientIp, callerKind,
    userId = null, workspaceId = null, byActor = null, confirm = null,
  } = {}) {
    try {
      if (callerKind !== 'account_owner' && callerKind !== 'operational_admin') return FAILED;
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      if (callerKind === 'account_owner' && targetActor !== 'owner') return FAILED;

      // exactly six digits, no letters, no separators, no trivial value, no admin bypass
      if (!pinPolicy || typeof pinPolicy.validateNewPinFormat !== 'function') return FAILED;
      if (!pinPolicy.validateNewPinFormat(newPin).ok) return FAILED;

      const ipH = resolveIpHash(trustedClientIp);
      if (!ipH) return FAILED; // fail closed when IP hashing is unavailable

      if (!dao || typeof dao.listActorsWithWorkspaceForVerify_SENSITIVE !== 'function'
          || typeof dao.setActorPinV2 !== 'function' || typeof verifyPin !== 'function'
          || typeof hashPin !== 'function') return FAILED;

      let all;
      try { all = await dao.listActorsWithWorkspaceForVerify_SENSITIVE(); }
      catch (_) { return FAILED; }
      if (!Array.isArray(all)) return FAILED;

      const target = all.find((a) => a && a.actor === targetActor);
      if (!target || !target.workspace_id) return FAILED;      // unassigned actor → fail closed
      if (typeof target.role !== 'string') return FAILED;
      // The account path additionally pins the workspace it authorized against.
      if (callerKind === 'account_owner' && workspaceId && target.workspace_id !== workspaceId) return FAILED;

      // Snapshot of every OTHER actor of the SAME workspace, exactly as read.
      const others = all.filter((a) => a && a.workspace_id === target.workspace_id && a.actor !== targetActor);
      const seen = others.map((a) => ({
        actor: a.actor, active: a.active === true, pin_hash: a.pin_hash ?? null,
      }));

      // Uniqueness: the candidate must not already belong to another ACTIVE actor.
      let duplicate = false;
      for (const a of others) {
        if (!a || a.active !== true || !a.pin_hash) continue;
        let matched = false;
        try { matched = await verifyPin(newPin, a.pin_hash); } catch (_) { matched = false; }
        if (matched) duplicate = true;               // no break — constant work
      }
      if (duplicate) return DUPLICATE;

      let pinHash;
      try { pinHash = await hashPin(newPin); } catch (_) { return FAILED; }
      if (typeof pinHash !== 'string' || pinHash.slice(0, 7) !== 'scrypt$') return FAILED;

      let result;
      try {
        result = await dao.setActorPinV2({
          targetActor,
          expectedRole: target.role,                 // authoritative, re-checked under lock
          pinHash, ipHash: ipH, seen, callerKind,
          userId, workspaceId: callerKind === 'account_owner' ? target.workspace_id : null,
          byActor, confirm, meta: {},
        });
      } catch (_) { return FAILED; }                 // includes AUTH_ROTATION_STALE → no write
      pinHash = null;

      if (!result || result.actor !== targetActor || !Number.isInteger(result.session_version)) return FAILED;
      return Object.freeze({
        ok: true,
        actor: result.actor,
        role: result.role,
        active: result.active,
        sessionVersion: result.session_version,
        failedCount: result.failed_count,
        lockedUntil: result.locked_until,
        updatedAt: result.updated_at,
        updatedBy: result.updated_by,
        changed: true,
        event: result.event,
        onboardingCompleted: result.onboarding_completed === true,
      });
    } catch (_) { return FAILED; }
  }

  return { rotate };
}

module.exports = { createPinRotation, FAILED, DUPLICATE };
