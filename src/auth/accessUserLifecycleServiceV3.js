'use strict';
// Access Control V3 -- Block V3-E: access-user lifecycle orchestration (ISOLATED,
// UNWIRED). Not imported by index.js, login.js, adminAccessService.js, or any current
// PIN/role/access-user route -- nothing in the running application calls this file. It
// exists so the eventual deactivateAccessUser/reactivateAccessUser/
// clearAccessUserCredential route wiring (a future phase) has a complete, tested
// starting point.
//
// Mirrors the access-user V3 service's discipline: workspace context and acting-owner
// identity come from THIS service's own authoritative caller, never a client body.
// Step-up is NOT cryptographically verified here (that belongs to the future HTTP route
// boundary) but a previously-verified, session-bound, non-expired result IS required and
// rejected outright if missing, expired, or bound to the wrong actor/session. The
// caller's acting role must ALSO already be a DB-fresh read (the future route's own
// auth middleware resolves it) -- this service rejects a non-owner role before ever
// touching the DAO, on top of the RPC's own authoritative re-check under lock.
//
// deactivateAccessUser/reactivateAccessUser are both the SAME underlying RPC
// (auth_set_access_user_active_v3) with a fixed requestedActive boolean -- exposed as
// two named operations, not duplicated logic.
//
// deps: { dao, sidHash }
//   dao: { setAccessUserActiveV3, clearAccessUserCredentialV3 }
//   sidHash: src/auth/sidHash.js's sidHash -- injected, not required directly.

const { isOwnerCredentialRole } = require('./ownerCredentialRole');
const { computeActiveStateRequestHash, computeClearCredentialRequestHash } = require('./accessUserLifecycleRequestHash');

const FAILED = Object.freeze({ ok: false, error: 'access_user_lifecycle_failed' });
const CONFLICT = Object.freeze({ ok: false, error: 'idempotency_conflict' });

function createAccessUserLifecycleV3Service(deps = {}) {
  const { dao, sidHash } = deps;

  function stepUpValid(stepUp, byActor, sid) {
    if (!stepUp || typeof stepUp !== 'object') return false;
    if (stepUp.sub !== byActor) return false;
    if (stepUp.sid !== sid) return false;
    if (typeof stepUp.exp !== 'number' || !Number.isFinite(stepUp.exp)) return false;
    if (Math.floor(Date.now() / 1000) >= stepUp.exp) return false; // expired
    return true;
  }

  async function setActive({
    workspaceId, byActor, actingRole, targetActor, expectedActive, requestedActive,
    sid, clientRequestId, stepUp, meta = {},
  } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (!isOwnerCredentialRole(actingRole)) return FAILED; // non-owner acting role rejected here
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      if (typeof expectedActive !== 'boolean' || typeof requestedActive !== 'boolean') return FAILED;
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return FAILED;
      if (typeof sid !== 'string' || sid.length === 0) return FAILED;
      if (!stepUpValid(stepUp, byActor, sid)) return FAILED;
      if (!dao || typeof dao.setAccessUserActiveV3 !== 'function' || typeof sidHash !== 'function') return FAILED;

      const bySidHash = sidHash(sid);
      if (typeof bySidHash !== 'string' || bySidHash.length === 0) return FAILED;

      const requestHash = computeActiveStateRequestHash({ targetActor, expectedActive, requestedActive });
      if (typeof requestHash !== 'string' || requestHash.length === 0) return FAILED;

      let result;
      try {
        result = await dao.setAccessUserActiveV3({
          workspaceId, byActor, targetActor, expectedActive, requestedActive,
          bySidHash, clientRequestId, requestHash, meta: {},
        });
      } catch (e) {
        if (e && e.code === 'ACCESS_USER_LIFECYCLE_CONFLICT') return CONFLICT;
        return FAILED;
      }
      if (!result || result.actor !== targetActor) return FAILED;

      return Object.freeze({
        ok: true,
        userId: result.actor,
        dbRole: result.role,
        active: result.active === true,
        sessionVersion: result.session_version,
        failedCount: result.failed_count,
        lockedUntil: result.locked_until,
        updatedAt: result.updated_at,
      });
    } catch (_) {
      return FAILED;
    }
  }

  // deactivateAccessUser({workspaceId, byActor, actingRole, targetActor, expectedActive, sid, clientRequestId, stepUp, meta})
  // Only requestedActive is fixed (false). expectedActive stays caller-supplied — it
  // must be the caller's believed CURRENT state, matching the RPC's own contract, so
  // that deactivating an already-inactive target (expectedActive: false) can correctly
  // resolve as the deterministic no-op the spec requires, not a hardcoded mismatch.
  function deactivateAccessUser(args = {}) {
    return setActive({ ...args, requestedActive: false });
  }

  // reactivateAccessUser({workspaceId, byActor, actingRole, targetActor, expectedActive, sid, clientRequestId, stepUp, meta})
  // Only requestedActive is fixed (true); expectedActive stays caller-supplied, same
  // reasoning as deactivateAccessUser above.
  function reactivateAccessUser(args = {}) {
    return setActive({ ...args, requestedActive: true });
  }

  // clearAccessUserCredential({workspaceId, byActor, actingRole, targetActor, expectedSessionVersion, sid, clientRequestId, stepUp, meta})
  async function clearAccessUserCredential({
    workspaceId, byActor, actingRole, targetActor, expectedSessionVersion,
    sid, clientRequestId, stepUp, meta = {},
  } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (!isOwnerCredentialRole(actingRole)) return FAILED;
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      if (!Number.isInteger(expectedSessionVersion) || expectedSessionVersion < 1) return FAILED;
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return FAILED;
      if (typeof sid !== 'string' || sid.length === 0) return FAILED;
      if (!stepUpValid(stepUp, byActor, sid)) return FAILED;
      if (!dao || typeof dao.clearAccessUserCredentialV3 !== 'function' || typeof sidHash !== 'function') return FAILED;

      const bySidHash = sidHash(sid);
      if (typeof bySidHash !== 'string' || bySidHash.length === 0) return FAILED;

      const requestHash = computeClearCredentialRequestHash({ targetActor, expectedSessionVersion });
      if (typeof requestHash !== 'string' || requestHash.length === 0) return FAILED;

      let result;
      try {
        result = await dao.clearAccessUserCredentialV3({
          workspaceId, byActor, targetActor, expectedSessionVersion,
          bySidHash, clientRequestId, requestHash, meta: {},
        });
      } catch (e) {
        if (e && e.code === 'ACCESS_USER_LIFECYCLE_CONFLICT') return CONFLICT;
        return FAILED;
      }
      if (!result || result.actor !== targetActor) return FAILED;

      return Object.freeze({
        ok: true,
        userId: result.actor,
        dbRole: result.role,
        active: result.active === true,
        sessionVersion: result.session_version,
        failedCount: result.failed_count,
        lockedUntil: result.locked_until,
        updatedAt: result.updated_at,
      });
    } catch (_) {
      return FAILED;
    }
  }

  return { deactivateAccessUser, reactivateAccessUser, clearAccessUserCredential };
}

module.exports = { createAccessUserLifecycleV3Service, FAILED, CONFLICT };
