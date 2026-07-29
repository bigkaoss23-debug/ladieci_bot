'use strict';
// Access Control V3 — Block V3-C: canonical role-change DAO, v3 (ISOLATED, UNWIRED).
// service_role only.
//
// Calls auth_change_actor_role_v3 (2026-07-29_v3c_auth_change_actor_role.sql, draft, NOT
// applied to staging). Nothing in index.js, login.js, adminAccessService.js, or the
// current PIN routes requires this file — it exists so the eventual V3-D route wiring
// has a complete, tested starting point, not to change any current behavior.

const { AuthDaoError, sbRest } = require('./audit');

const SAFE_RESULT_FIELDS = Object.freeze([
  'actor', 'old_role', 'role', 'session_version', 'changed', 'updated_at', 'updated_by',
]);

function sanitizeRoleChangeResult(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('ROLE_CHANGE_FAILED', 'malformed response');
  }
  if (typeof body.actor !== 'string' || body.actor.length === 0) {
    throw new AuthDaoError('ROLE_CHANGE_FAILED', 'malformed response');
  }
  if (typeof body.role !== 'string' || body.role.length === 0) {
    throw new AuthDaoError('ROLE_CHANGE_FAILED', 'malformed response');
  }
  if (!Number.isInteger(body.session_version)) {
    throw new AuthDaoError('ROLE_CHANGE_FAILED', 'malformed response');
  }
  if (typeof body.changed !== 'boolean') {
    throw new AuthDaoError('ROLE_CHANGE_FAILED', 'malformed response');
  }
  const out = {};
  for (const k of SAFE_RESULT_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

// One canonical v3 role-change call. Never receives a token, step-up proof, or raw sid
// — only byActor/targetActor/roles, the pre-hashed bySidHash, the client-supplied
// clientRequestId, and the pre-computed semantic requestHash.
//
// Error mapping mirrors src/auth/dao.js's callRpc: inspect ONLY for the one known,
// non-sensitive marker the RPC raises for an idempotency-key reuse with a different
// payload (AUTH_IDEMPOTENCY_CONFLICT) and surface that as a distinguishable error code
// — exactly like NOT_FOUND/VALIDATION are distinguished there. Every other failure
// collapses into the single generic shape; no SQL text or PostgREST body ever escapes.
async function changeActorRoleV3({
  workspaceId, byActor, targetActor, expectedRole, requestedRole,
  bySidHash, clientRequestId, requestHash, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_change_actor_role_v3', {
    body: {
      p_workspace_id: workspaceId, p_by_actor: byActor, p_target_actor: targetActor,
      p_expected_role: expectedRole, p_requested_role: requestedRole,
      p_by_sid_hash: bySidHash, p_client_request_id: clientRequestId, p_request_hash: requestHash,
      p_meta: meta,
    },
  }); // single call — no retry; idempotency is the RPC's own job on a legitimate replay
  if (!r.ok) {
    const marker = r.body && typeof r.body.message === 'string' ? r.body.message : '';
    if (marker.includes('AUTH_IDEMPOTENCY_CONFLICT')) throw new AuthDaoError('ROLE_CHANGE_CONFLICT', 'idempotency conflict');
    throw new AuthDaoError('ROLE_CHANGE_FAILED', 'operation failed');
  }
  return sanitizeRoleChangeResult(r.body);
}

module.exports = { SAFE_RESULT_FIELDS, sanitizeRoleChangeResult, changeActorRoleV3 };
