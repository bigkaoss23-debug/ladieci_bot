'use strict';
// S2-7D2 — THE canonical PIN-rotation DAO (service_role only).
//
// Every owner/operator/rider PIN mutation goes through auth_set_actor_pin_v2 here. The legacy
// auth_admin_set_actor_pin wrapper is retired: it locked only (initiator, target) and did no
// cross-actor duplicate check, so leaving it usable meant the "no two active actors share a
// PIN" invariant did not exist, whichever path the other writer used.
//
// Contract: one generic error for any RPC/transport failure (no PostgREST body, no SQL text),
// a single call per action (no retry), and pin_hash never crosses back out of this boundary.

const { AuthDaoError, sbRest } = require('./audit');

const SAFE_RESULT_FIELDS = Object.freeze([
  'actor', 'role', 'active', 'session_version', 'failed_count', 'locked_until',
  'updated_at', 'updated_by', 'changed', 'event', 'onboarding_completed',
]);

function sanitizeRotation(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('PIN_ROTATION_FAILED', 'malformed response');
  }
  if (typeof body.actor !== 'string' || body.actor.length === 0) {
    throw new AuthDaoError('PIN_ROTATION_FAILED', 'malformed response');
  }
  if (!Number.isInteger(body.session_version)) {
    throw new AuthDaoError('PIN_ROTATION_FAILED', 'malformed response');
  }
  if (body.changed !== true) throw new AuthDaoError('PIN_ROTATION_FAILED', 'malformed response');
  if (!(body.event === 'pin_set' || body.event === 'pin_change')) {
    throw new AuthDaoError('PIN_ROTATION_FAILED', 'malformed response');
  }
  const out = {};
  for (const k of SAFE_RESULT_FIELDS) if (k in body) out[k] = body[k];
  return Object.freeze(out);
}

// SENSITIVE read: includes pin_hash, for the uniqueness check ONLY (same status as the
// login-only read). Returns every actor with its workspace so the caller can scope the
// snapshot; never leaves the service boundary.
async function listActorsWithWorkspaceForVerify_SENSITIVE() {
  const r = await sbRest('GET', 'auth_actors', {
    query: 'select=actor,role,active,workspace_id,pin_hash&order=actor.asc',
  });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('PIN_ROTATION_FAILED', 'read failed');
  return r.body;
}

// One canonical rotation. `seen` is the snapshot of every OTHER actor of the target's
// workspace that the caller verified against; SQL re-validates it under the workspace lock.
//   callerKind 'account_owner'     → { userId, workspaceId } (target must be 'owner')
//   callerKind 'operational_admin' → { byActor, confirm? }
async function setActorPinV2({
  targetActor, expectedRole, pinHash, ipHash, seen, callerKind,
  userId = null, workspaceId = null, byActor = null, confirm = null, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_set_actor_pin_v2', {
    body: {
      p_target_actor: targetActor, p_expected_role: expectedRole, p_hash: pinHash,
      p_ip_hash: ipHash, p_seen: seen, p_caller_kind: callerKind,
      p_user_id: userId, p_workspace_id: workspaceId, p_by_actor: byActor,
      p_confirm: confirm, p_meta: meta,
    },
  }); // single call — no retry
  if (!r.ok) throw new AuthDaoError('PIN_ROTATION_FAILED', 'operation failed');
  return sanitizeRotation(r.body);
}

module.exports = {
  SAFE_RESULT_FIELDS, sanitizeRotation,
  listActorsWithWorkspaceForVerify_SENSITIVE, setActorPinV2,
};
