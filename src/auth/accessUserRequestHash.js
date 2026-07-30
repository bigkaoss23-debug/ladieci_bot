'use strict';
// Access Control V3 -- Block V3-D: normalized semantic request hashes for
// createAccessUser / renameAccessUser idempotency (FOUNDATION ONLY, UNWIRED). Pure
// crypto, no env, no I/O, no DB, no secret material.
//
// Same discipline as roleChangeRequestHash.js: bind the idempotency key to WHAT was
// requested, never to token/proof/cookies/raw sid or any other transient auth material.
// CREATE hashes {normalized display name, requested role}; RENAME hashes {target actor,
// normalized display name} -- exactly the semantic inputs listed in the V3-D spec,
// nothing else.

const crypto = require('crypto');
const { isAssignableRole } = require('./roleTransition');
const { normalizeDisplayName } = require('./accessUserDisplayName');

function sha256Hex(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

// computeCreateAccessUserRequestHash({displayName, requestedRole}) -> hex string | null
function computeCreateAccessUserRequestHash({ displayName, requestedRole } = {}) {
  const normalized = normalizeDisplayName(displayName);
  if (normalized === null) return null;
  if (!isAssignableRole(requestedRole)) return null;
  return sha256Hex({ display_name: normalized, requested_role: requestedRole });
}

// computeRenameAccessUserRequestHash({targetActor, newDisplayName}) -> hex string | null
function computeRenameAccessUserRequestHash({ targetActor, newDisplayName } = {}) {
  if (typeof targetActor !== 'string' || targetActor.length === 0) return null;
  const normalized = normalizeDisplayName(newDisplayName);
  if (normalized === null) return null;
  return sha256Hex({ target_actor: targetActor, new_display_name: normalized });
}

module.exports = { computeCreateAccessUserRequestHash, computeRenameAccessUserRequestHash };
