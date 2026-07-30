'use strict';
// Access Control V3 -- Block V3-D: dynamic access-user DAO (ISOLATED, UNWIRED).
// service_role only.
//
// Calls auth_create_access_user_v3 / auth_rename_access_user_v3
// (2026-07-29_v3d_dynamic_access_user.sql, draft, NOT applied to staging), and provides
// workspace-scoped SAFE reads (no pin_hash ever returned) for list/get. Nothing in
// index.js, login.js, adminAccessService.js, or any current PIN/role route requires this
// file -- it exists so the eventual V3-D route wiring has a complete, tested starting
// point.

const { AuthDaoError, sbRest } = require('./audit');

const WRITE_SAFE_FIELDS = Object.freeze([
  'actor', 'display_name', 'role', 'active', 'session_version', 'created_at', 'updated_at', 'updated_by',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sanitizeWriteResult(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('ACCESS_USER_WRITE_FAILED', 'malformed response');
  }
  if (typeof body.actor !== 'string' || body.actor.length === 0) {
    throw new AuthDaoError('ACCESS_USER_WRITE_FAILED', 'malformed response');
  }
  if (!Number.isInteger(body.session_version)) {
    throw new AuthDaoError('ACCESS_USER_WRITE_FAILED', 'malformed response');
  }
  const out = {};
  for (const k of WRITE_SAFE_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

// Same marker-based error mapping as the role-change V3 DAO: surface ONLY the one known,
// non-sensitive idempotency-conflict marker distinctly; everything else collapses into
// the single generic failure shape. No SQL text or PostgREST body ever escapes.
function mapWriteError(r, failedCode) {
  const marker = r.body && typeof r.body.message === 'string' ? r.body.message : '';
  if (marker.includes('AUTH_IDEMPOTENCY_CONFLICT')) throw new AuthDaoError('ACCESS_USER_CONFLICT', 'idempotency conflict');
  throw new AuthDaoError(failedCode, 'operation failed');
}

// Creates one dynamic access user. Never receives an actor id (the RPC generates it
// server-side), a PIN, or a fingerprint.
async function createAccessUserV3({
  workspaceId, byActor, displayName, requestedRole,
  bySidHash, clientRequestId, requestHash, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_create_access_user_v3', {
    body: {
      p_workspace_id: workspaceId, p_by_actor: byActor, p_display_name: displayName,
      p_requested_role: requestedRole, p_by_sid_hash: bySidHash,
      p_client_request_id: clientRequestId, p_request_hash: requestHash, p_meta: meta,
    },
  }); // single call -- no retry; idempotency is the RPC's own job on a legitimate replay
  if (!r.ok) mapWriteError(r, 'ACCESS_USER_CREATE_FAILED');
  return sanitizeWriteResult(r.body);
}

// Renames one existing access user (including the owner renaming themselves). Only
// display_name (+ updated_at/updated_by) ever changes.
async function renameAccessUserV3({
  workspaceId, byActor, targetActor, newDisplayName,
  bySidHash, clientRequestId, requestHash, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_rename_access_user_v3', {
    body: {
      p_workspace_id: workspaceId, p_by_actor: byActor, p_target_actor: targetActor,
      p_new_display_name: newDisplayName, p_by_sid_hash: bySidHash,
      p_client_request_id: clientRequestId, p_request_hash: requestHash, p_meta: meta,
    },
  });
  if (!r.ok) mapWriteError(r, 'ACCESS_USER_RENAME_FAILED');
  return sanitizeWriteResult(r.body);
}

// SAFE read, workspace-scoped IN THE QUERY ITSELF -- never an unscoped auth_actors
// listing filtered by tenant in Node. pin_hash is fetched ONLY to derive has_pin and is
// stripped before this function returns -- it never leaves this module.
async function listAccessUsersForWorkspace(workspaceId) {
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    throw new AuthDaoError('ACCESS_USER_READ_FAILED', 'workspace required');
  }
  const r = await sbRest('GET', 'auth_actors', {
    query: `select=actor,role,active,session_version,display_name,created_at,updated_at,pin_hash&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=actor.asc`,
  });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('ACCESS_USER_READ_FAILED', 'read failed');
  return r.body.map((row) => {
    const { pin_hash, ...safe } = row;
    return { ...safe, has_pin: pin_hash != null };
  });
}

// SAFE single-actor read, workspace-scoped IN THE QUERY -- same shape as
// listAccessUsersForWorkspace, doubling as the acting-actor lookup for owner
// authorization (it already returns role + active safely, which is all that needs).
async function getAccessUserForWorkspace(workspaceId, actor) {
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    throw new AuthDaoError('ACCESS_USER_READ_FAILED', 'workspace required');
  }
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new AuthDaoError('ACCESS_USER_READ_FAILED', 'actor required');
  }
  const r = await sbRest('GET', 'auth_actors', {
    query: `select=actor,role,active,session_version,display_name,created_at,updated_at,pin_hash&workspace_id=eq.${encodeURIComponent(workspaceId)}&actor=eq.${encodeURIComponent(actor)}&limit=1`,
  });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('ACCESS_USER_READ_FAILED', 'read failed');
  if (r.body.length === 0) return null;
  const { pin_hash, ...safe } = r.body[0];
  return { ...safe, has_pin: pin_hash != null };
}

module.exports = {
  WRITE_SAFE_FIELDS, sanitizeWriteResult,
  createAccessUserV3, renameAccessUserV3,
  listAccessUsersForWorkspace, getAccessUserForWorkspace,
};
