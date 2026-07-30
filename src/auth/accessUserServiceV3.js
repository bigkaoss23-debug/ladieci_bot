'use strict';
// Access Control V3 -- Block V3-D: dynamic access-user orchestration (ISOLATED,
// UNWIRED). Not imported by index.js, login.js, adminAccessService.js, or any current
// PIN/role route -- nothing in the running application calls this file. It exists so
// the eventual createAccessUser/renameAccessUser/listAccessUsers/getAccessUser route
// wiring (a future phase) has a complete, tested starting point.
//
// WRITE services (createAccessUser, renameAccessUser) mirror the role-change V3 service's
// discipline exactly: workspace context and acting-owner identity come from THIS
// service's own authoritative caller, never a client body; step-up is NOT verified here
// (that belongs to the future HTTP route boundary) but a previously-verified,
// session-bound result IS required, and rejected outright if missing or bound to the
// wrong actor/session. sidHash and the normalized semantic request hash are computed
// here, before the RPC is ever called.
//
// READ services (listAccessUsers, getAccessUser) are owner-only but do NOT require
// step-up (read-only, no mutation to protect against replay/CSRF-style risk). Owner
// authorization is verified in Node by looking up the caller's OWN row via the same
// workspace-scoped DAO read used for the projection itself -- never trusted blindly from
// the caller's claim.
//
// deps: { dao, sidHash }
//   dao: { createAccessUserV3, renameAccessUserV3, listAccessUsersForWorkspace, getAccessUserForWorkspace }
//   sidHash: src/auth/sidHash.js's sidHash -- injected, not required directly.

const { isAssignableRole, canonicalRoleForDbRole } = require('./roleTransition');
const { isOwnerCredentialRole } = require('./ownerCredentialRole');
const { normalizeDisplayName } = require('./accessUserDisplayName');
const { computeCreateAccessUserRequestHash, computeRenameAccessUserRequestHash } = require('./accessUserRequestHash');

const FAILED = Object.freeze({ ok: false, error: 'access_user_failed' });
const CONFLICT = Object.freeze({ ok: false, error: 'idempotency_conflict' });
const NOT_FOUND = Object.freeze({ ok: false, error: 'not_found' });

function toSafeUser(row) {
  if (!row) return null;
  return Object.freeze({
    userId: row.actor,
    displayName: row.display_name,
    dbRole: row.role,
    canonicalRole: canonicalRoleForDbRole(row.role),
    active: row.active === true,
    hasPin: row.has_pin === true,
    sessionVersion: row.session_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function createAccessUserV3Service(deps = {}) {
  const { dao, sidHash } = deps;

  function stepUpValid(stepUp, byActor, sid) {
    return !!stepUp && typeof stepUp === 'object' && stepUp.sub === byActor && stepUp.sid === sid;
  }

  // createAccessUser({workspaceId, byActor, displayName, requestedRole, sid, clientRequestId, stepUp, meta})
  // Returns { ok:true, userId, displayName, dbRole, canonicalRole, active, sessionVersion, createdAt, updatedAt }
  //      or { ok:false, error:'access_user_failed' | 'idempotency_conflict' }
  async function createAccessUser({
    workspaceId, byActor, displayName, requestedRole, sid, clientRequestId, stepUp, meta = {},
  } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (!isAssignableRole(requestedRole)) return FAILED;
      const normalizedName = normalizeDisplayName(displayName);
      if (normalizedName === null) return FAILED;
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return FAILED;
      if (typeof sid !== 'string' || sid.length === 0) return FAILED;
      if (!stepUpValid(stepUp, byActor, sid)) return FAILED;
      if (!dao || typeof dao.createAccessUserV3 !== 'function' || typeof sidHash !== 'function') return FAILED;

      const bySidHash = sidHash(sid);
      if (typeof bySidHash !== 'string' || bySidHash.length === 0) return FAILED;

      const requestHash = computeCreateAccessUserRequestHash({ displayName: normalizedName, requestedRole });
      if (typeof requestHash !== 'string' || requestHash.length === 0) return FAILED;

      let result;
      try {
        result = await dao.createAccessUserV3({
          workspaceId, byActor, displayName: normalizedName, requestedRole,
          bySidHash, clientRequestId, requestHash, meta: {},
        });
      } catch (e) {
        if (e && e.code === 'ACCESS_USER_CONFLICT') return CONFLICT;
        return FAILED;
      }
      if (!result || typeof result.actor !== 'string') return FAILED;

      return Object.freeze({
        ok: true,
        userId: result.actor,
        displayName: result.display_name,
        dbRole: result.role,
        canonicalRole: canonicalRoleForDbRole(result.role),
        active: result.active === true,
        sessionVersion: result.session_version,
        createdAt: result.created_at,
        updatedAt: result.updated_at,
      });
    } catch (_) {
      return FAILED;
    }
  }

  // renameAccessUser({workspaceId, byActor, targetActor, newDisplayName, sid, clientRequestId, stepUp, meta})
  // byActor MAY equal targetActor -- the owner renaming themselves is explicitly allowed.
  async function renameAccessUser({
    workspaceId, byActor, targetActor, newDisplayName, sid, clientRequestId, stepUp, meta = {},
  } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      const normalizedName = normalizeDisplayName(newDisplayName);
      if (normalizedName === null) return FAILED;
      if (typeof clientRequestId !== 'string' || clientRequestId.length === 0) return FAILED;
      if (typeof sid !== 'string' || sid.length === 0) return FAILED;
      if (!stepUpValid(stepUp, byActor, sid)) return FAILED;
      if (!dao || typeof dao.renameAccessUserV3 !== 'function' || typeof sidHash !== 'function') return FAILED;

      const bySidHash = sidHash(sid);
      if (typeof bySidHash !== 'string' || bySidHash.length === 0) return FAILED;

      const requestHash = computeRenameAccessUserRequestHash({ targetActor, newDisplayName: normalizedName });
      if (typeof requestHash !== 'string' || requestHash.length === 0) return FAILED;

      let result;
      try {
        result = await dao.renameAccessUserV3({
          workspaceId, byActor, targetActor, newDisplayName: normalizedName,
          bySidHash, clientRequestId, requestHash, meta: {},
        });
      } catch (e) {
        if (e && e.code === 'ACCESS_USER_CONFLICT') return CONFLICT;
        return FAILED;
      }
      if (!result || result.actor !== targetActor) return FAILED;

      return Object.freeze({
        ok: true,
        userId: result.actor,
        displayName: result.display_name,
        dbRole: result.role,
        canonicalRole: canonicalRoleForDbRole(result.role),
        active: result.active === true,
        sessionVersion: result.session_version,
        updatedAt: result.updated_at,
      });
    } catch (_) {
      return FAILED;
    }
  }

  // listAccessUsers({workspaceId, byActor}) -- read-only, owner-authorized, no step-up.
  async function listAccessUsers({ workspaceId, byActor } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (!dao || typeof dao.listAccessUsersForWorkspace !== 'function' || typeof dao.getAccessUserForWorkspace !== 'function') return FAILED;

      let acting;
      try { acting = await dao.getAccessUserForWorkspace(workspaceId, byActor); } catch (_) { return FAILED; }
      if (!acting || acting.active !== true || !isOwnerCredentialRole(acting.role)) return FAILED;

      let rows;
      try { rows = await dao.listAccessUsersForWorkspace(workspaceId); } catch (_) { return FAILED; }
      if (!Array.isArray(rows)) return FAILED;

      return Object.freeze({ ok: true, users: Object.freeze(rows.map(toSafeUser)) });
    } catch (_) {
      return FAILED;
    }
  }

  // getAccessUser({workspaceId, byActor, targetActor}) -- read-only, owner-authorized.
  async function getAccessUser({ workspaceId, byActor, targetActor } = {}) {
    try {
      if (typeof workspaceId !== 'string' || workspaceId.length === 0) return FAILED;
      if (typeof byActor !== 'string' || byActor.length === 0) return FAILED;
      if (typeof targetActor !== 'string' || targetActor.length === 0) return FAILED;
      if (!dao || typeof dao.getAccessUserForWorkspace !== 'function') return FAILED;

      let acting;
      try { acting = await dao.getAccessUserForWorkspace(workspaceId, byActor); } catch (_) { return FAILED; }
      if (!acting || acting.active !== true || !isOwnerCredentialRole(acting.role)) return FAILED;

      let target;
      try { target = await dao.getAccessUserForWorkspace(workspaceId, targetActor); } catch (_) { return FAILED; }
      if (!target) return NOT_FOUND;

      return Object.freeze({ ok: true, user: toSafeUser(target) });
    } catch (_) {
      return FAILED;
    }
  }

  return { createAccessUser, renameAccessUser, listAccessUsers, getAccessUser };
}

module.exports = { createAccessUserV3Service, FAILED, CONFLICT, NOT_FOUND };
