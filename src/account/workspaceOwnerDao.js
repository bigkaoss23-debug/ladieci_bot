'use strict';
// S2-7D — account-side workspace-owner DAO (service_role only). Thin wrappers over the
// two account RPCs (auth_account_claim_workspace, auth_account_set_owner_pin) plus a
// safe per-workspace owner-actor read (has_pin only, NEVER pin_hash).
//
// Contract mirrors adminAccessDao: one generic error for any RPC/transport failure
// (no PostgREST body / SQL text leaked), single call (no retry), sanitized outputs,
// and pin_hash can never cross this boundary.

const { AuthDaoError, sbRest } = require('../auth/audit');

async function callRpc(fn, args) {
  const r = await sbRest('POST', `rpc/${fn}`, { body: args }); // single call — no retry
  if (!r.ok) throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'operation failed');
  return r.body;
}

// { workspace_id, membership_id, created, owner_pin_onboarding_completed }
function sanitizeClaim(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  }
  if (typeof body.workspace_id !== 'string' || body.workspace_id.length === 0) {
    throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  }
  return Object.freeze({
    workspaceId: body.workspace_id,
    membershipId: (typeof body.membership_id === 'string' && body.membership_id) || null,
    created: body.created === true,
    onboardingCompleted: body.owner_pin_onboarding_completed === true,
  });
}

// Sanitized PIN-set result. NEVER pin_hash.
function sanitizePinResult(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  }
  if (body.actor !== 'owner') throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  if (!Number.isInteger(body.session_version)) throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  if (body.changed !== true) throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  if (!(body.event === 'pin_set' || body.event === 'pin_change')) {
    throw new AuthDaoError('ACCOUNT_ACTION_FAILED', 'malformed response');
  }
  return Object.freeze({
    actor: body.actor,
    role: body.role,
    active: body.active,
    sessionVersion: body.session_version,
    event: body.event,
    changed: true,
  });
}

async function claimWorkspace({ userId, slug, displayName }) {
  const body = await callRpc('auth_account_claim_workspace', {
    p_user_id: userId, p_slug: slug, p_display_name: displayName,
  });
  return sanitizeClaim(body);
}

async function setOwnerPin({ userId, workspaceId, pinHash, ipHash, meta = {} }) {
  const body = await callRpc('auth_account_set_owner_pin', {
    p_user_id: userId, p_workspace_id: workspaceId, p_hash: pinHash, p_ip_hash: ipHash, p_meta: meta,
  });
  return sanitizePinResult(body);
}

module.exports = {
  claimWorkspace, setOwnerPin,
  sanitizeClaim, sanitizePinResult,
};
