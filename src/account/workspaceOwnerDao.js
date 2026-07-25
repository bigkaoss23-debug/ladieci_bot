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

async function claimWorkspace({ userId, slug, displayName }) {
  const body = await callRpc('auth_account_claim_workspace', {
    p_user_id: userId, p_slug: slug, p_display_name: displayName,
  });
  return sanitizeClaim(body);
}

// NOTE (S2-7D2): the owner-only rotation helpers were REMOVED. Owner PIN rotation now uses
// THE canonical protocol in src/auth/pinRotationService.js, identical to the operational
// admin path — an owner-only path could not establish the uniqueness invariant on its own.
module.exports = { claimWorkspace, sanitizeClaim };
