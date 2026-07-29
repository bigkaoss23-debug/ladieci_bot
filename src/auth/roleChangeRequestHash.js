'use strict';
// Access Control V3 — Block V3-C: normalized semantic request hash for
// changeAccessUserRole idempotency (FOUNDATION ONLY, UNWIRED). Pure crypto, no env, no
// I/O, no DB, no secret material.
//
// Binds an idempotency key (workspace_id + by_actor + by_sid_hash + action +
// client_request_id) to WHAT was actually requested, so a replay of the same key with a
// DIFFERENT semantic request is rejected as a conflict rather than silently returning a
// stale response for a different mutation. Deliberately narrow: only the fields that
// describe the mutation itself. Never hash token, proof, cookies, or any transient auth
// material — those authenticate the CALLER, not the REQUEST, and must never affect
// whether two requests are "the same" for replay purposes.

const crypto = require('crypto');
const { isAssignableRole } = require('./roleTransition');

// computeRoleChangeRequestHash({targetActor, expectedRole, requestedRole}) -> hex string | null
function computeRoleChangeRequestHash({ targetActor, expectedRole, requestedRole } = {}) {
  if (typeof targetActor !== 'string' || targetActor.length === 0) return null;
  if (typeof expectedRole !== 'string' || expectedRole.length === 0) return null;
  if (!isAssignableRole(requestedRole)) return null;
  const canonical = JSON.stringify({
    target_actor: targetActor,
    expected_role: expectedRole,
    requested_role: requestedRole,
  });
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

module.exports = { computeRoleChangeRequestHash };
