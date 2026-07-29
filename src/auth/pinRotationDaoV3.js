'use strict';
// Access Control V3 — Block V3-B: canonical PIN-rotation DAO, v3 writer (ISOLATED,
// UNWIRED). service_role only.
//
// Calls auth_set_actor_pin_v3 (2026-07-29_v3b_auth_set_actor_pin_v3.sql, draft, NOT
// applied to staging). Nothing in index.js, login.js, adminAccessService.js, or
// pinRotationService.js requires this file — it exists so the eventual V3 cutover has
// a working, tested starting point, not to change any current behavior.
//
// Reuses listActorsWithWorkspaceForVerify_SENSITIVE from the EXISTING (v2) DAO — a
// pure read helper with zero side effects, safe to share in this direction (V3 code
// depending on a small piece of already-tested v2 infra). Nothing imports this V3 file
// back into v2/current routes, so this reuse cannot affect current behavior.
const { AuthDaoError, sbRest } = require('./audit');
const { listActorsWithWorkspaceForVerify_SENSITIVE } = require('./pinRotationDao');

const SAFE_RESULT_FIELDS = Object.freeze([
  'actor', 'role', 'active', 'session_version', 'failed_count', 'locked_until',
  'updated_at', 'updated_by', 'changed', 'event', 'onboarding_completed',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// SENSITIVE read, workspace-scoped IN THE QUERY ITSELF (not a Node-side filter of an
// unscoped table read): the v3 semantic duplicate/reserved check must never pull
// another workspace's pin_hash rows into this process. workspaceId is required and
// must already be an authoritative value the caller resolved (its own verified session
// context) — never a value taken from a client request body.
async function listWorkspaceActorsForVerify_SENSITIVE(workspaceId) {
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    throw new AuthDaoError('PIN_ROTATION_FAILED', 'workspace required');
  }
  const r = await sbRest('GET', 'auth_actors', {
    query: `select=actor,role,active,workspace_id,pin_hash&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=actor.asc`,
  });
  if (!r.ok || !Array.isArray(r.body)) throw new AuthDaoError('PIN_ROTATION_FAILED', 'read failed');
  return r.body;
}

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

// One canonical v3 rotation call. `seen` is the same Node-verified snapshot as v2.
// keyIdCurrent/fingerprintCurrent are REQUIRED; keyIdPrevious/fingerprintPrevious are
// both-or-neither, present only during a graceful key-rotation window. Never receives
// a plaintext PIN — pinHash and every fingerprint are precomputed by the caller.
async function setActorPinV3({
  targetActor, expectedRole, pinHash, ipHash, seen, callerKind,
  keyIdCurrent, fingerprintCurrent, keyIdPrevious = null, fingerprintPrevious = null,
  userId = null, workspaceId = null, byActor = null, confirm = null, meta = {},
}) {
  const r = await sbRest('POST', 'rpc/auth_set_actor_pin_v3', {
    body: {
      p_target_actor: targetActor, p_expected_role: expectedRole, p_hash: pinHash,
      p_ip_hash: ipHash, p_seen: seen, p_caller_kind: callerKind,
      p_key_id_current: keyIdCurrent, p_fingerprint_current: fingerprintCurrent,
      p_key_id_previous: keyIdPrevious, p_fingerprint_previous: fingerprintPrevious,
      p_user_id: userId, p_workspace_id: workspaceId, p_by_actor: byActor,
      p_confirm: confirm, p_meta: meta,
    },
  }); // single call — no retry
  if (!r.ok) throw new AuthDaoError('PIN_ROTATION_FAILED', 'operation failed');
  return sanitizeRotation(r.body);
}

module.exports = {
  SAFE_RESULT_FIELDS, sanitizeRotation,
  listActorsWithWorkspaceForVerify_SENSITIVE, // re-exported for a single import surface (unused by the v3 service — see listWorkspaceActorsForVerify_SENSITIVE)
  listWorkspaceActorsForVerify_SENSITIVE,
  setActorPinV3,
};
