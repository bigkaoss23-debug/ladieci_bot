'use strict';
// Access Control V3 -- Block V3-E: access-user lifecycle DAO (ISOLATED, UNWIRED).
// service_role only.
//
// Calls auth_set_access_user_active_v3 / auth_clear_access_user_credential_v3
// (2026-07-30_v3e_access_user_lifecycle.sql, draft, NOT applied to staging). Nothing in
// index.js, login.js, adminAccessService.js, or any current PIN/role/access-user route
// requires this file.

const { AuthDaoError, sbRest } = require('./audit');

const SAFE_RESULT_FIELDS = Object.freeze([
  'actor', 'role', 'active', 'session_version', 'failed_count', 'locked_until', 'updated_at', 'updated_by',
]);

function sanitizeResult(body, code) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError(code, 'malformed response');
  }
  if (typeof body.actor !== 'string' || body.actor.length === 0) {
    throw new AuthDaoError(code, 'malformed response');
  }
  if (!Number.isInteger(body.session_version)) {
    throw new AuthDaoError(code, 'malformed response');
  }
  const out = {};
  for (const k of SAFE_RESULT_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

// Same marker-based error mapping as the role-change V3 DAO / access-user V3 DAO: surface
// ONLY the one known, non-sensitive idempotency-conflict marker distinctly; everything
// else collapses into the single generic failure shape. No SQL text or PostgREST body
// ever escapes.
function mapError(r, failedCode) {
  const marker = r.body && typeof r.body.message === 'string' ? r.body.message : '';
  if (marker.includes('AUTH_IDEMPOTENCY_CONFLICT')) throw new AuthDaoError('ACCESS_USER_LIFECYCLE_CONFLICT', 'idempotency conflict');
  throw new AuthDaoError(failedCode, 'operation failed');
}

// Sets (or confirms) the target's active state. p_requested_active decides the stable
// idempotency action identifier server-side (reactivate_access_user_v3 /
// deactivate_access_user_v3) -- the caller never passes an action string.
async function setAccessUserActiveV3({
  workspaceId, byActor, targetActor, expectedActive, requestedActive,
  bySidHash, clientRequestId, requestHash, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_set_access_user_active_v3', {
    body: {
      p_workspace_id: workspaceId, p_by_actor: byActor, p_target_actor: targetActor,
      p_expected_active: expectedActive, p_requested_active: requestedActive,
      p_by_sid_hash: bySidHash, p_client_request_id: clientRequestId, p_request_hash: requestHash,
      p_meta: meta,
    },
  }); // single call -- no retry
  if (!r.ok) mapError(r, 'ACCESS_USER_ACTIVE_STATE_FAILED');
  return sanitizeResult(r.body, 'ACCESS_USER_ACTIVE_STATE_FAILED');
}

// Clears the target's credential (pin_hash + every fingerprint row). Never receives a
// plaintext PIN or fingerprint value -- there is no such parameter on this function.
async function clearAccessUserCredentialV3({
  workspaceId, byActor, targetActor, expectedSessionVersion,
  bySidHash, clientRequestId, requestHash, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_clear_access_user_credential_v3', {
    body: {
      p_workspace_id: workspaceId, p_by_actor: byActor, p_target_actor: targetActor,
      p_expected_session_version: expectedSessionVersion,
      p_by_sid_hash: bySidHash, p_client_request_id: clientRequestId, p_request_hash: requestHash,
      p_meta: meta,
    },
  });
  if (!r.ok) mapError(r, 'ACCESS_USER_CREDENTIAL_CLEAR_FAILED');
  return sanitizeResult(r.body, 'ACCESS_USER_CREDENTIAL_CLEAR_FAILED');
}

module.exports = { SAFE_RESULT_FIELDS, sanitizeResult, setAccessUserActiveV3, clearAccessUserCredentialV3 };
