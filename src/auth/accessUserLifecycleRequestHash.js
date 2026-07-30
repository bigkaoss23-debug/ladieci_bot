'use strict';
// Access Control V3 -- Block V3-E: normalized semantic request hashes for
// deactivateAccessUser / reactivateAccessUser / clearAccessUserCredential idempotency
// (FOUNDATION ONLY, UNWIRED). Pure crypto, no env, no I/O, no DB, no secret material.
//
// Same discipline as roleChangeRequestHash.js / accessUserRequestHash.js: bind the
// idempotency key to WHAT was requested, never to token/proof/cookies/raw sid or any
// other transient auth material. ACTIVE-STATE hashes {target actor, expected current
// active state, requested active state}; CLEAR hashes {target actor, expected session
// snapshot} -- exactly the semantic inputs the V3-E spec names, nothing else.

const crypto = require('crypto');

function sha256Hex(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

// computeActiveStateRequestHash({targetActor, expectedActive, requestedActive}) -> hex | null
function computeActiveStateRequestHash({ targetActor, expectedActive, requestedActive } = {}) {
  if (typeof targetActor !== 'string' || targetActor.length === 0) return null;
  if (typeof expectedActive !== 'boolean') return null;
  if (typeof requestedActive !== 'boolean') return null;
  return sha256Hex({ target_actor: targetActor, expected_active: expectedActive, requested_active: requestedActive });
}

// computeClearCredentialRequestHash({targetActor, expectedSessionVersion}) -> hex | null
function computeClearCredentialRequestHash({ targetActor, expectedSessionVersion } = {}) {
  if (typeof targetActor !== 'string' || targetActor.length === 0) return null;
  if (!Number.isInteger(expectedSessionVersion) || expectedSessionVersion < 1) return null;
  return sha256Hex({ target_actor: targetActor, expected_session_version: expectedSessionVersion });
}

module.exports = { computeActiveStateRequestHash, computeClearCredentialRequestHash };
