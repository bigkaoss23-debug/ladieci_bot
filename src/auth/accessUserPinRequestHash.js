'use strict';
// Access Control V3 -- Block V3-F: normalized semantic request hash for
// setAccessUserPin idempotency (FOUNDATION ONLY, UNWIRED). Pure crypto, no env, no I/O,
// no DB, no secret material.
//
// The canonical v3 PIN-rotation orchestration deliberately implements no idempotency of its own (see
// that file's header) -- setAccessUserPin is the one V3-F write that owns its idempotency
// end to end at the HTTP boundary, and therefore the one write that needs its own
// semantic-request-hash helper (every other V3-F write's RPC computes its own hash
// downstream from a request-hash module that already exists).
//
// Same discipline as every other *RequestHash.js module: bind the idempotency key to WHAT
// was requested, never to token/proof/cookies/raw sid/any transient auth material -- and
// never to the raw PIN either. `pinFingerprint` MUST be the deterministic HMAC-SHA256
// fingerprint of the candidate PIN under the currently configured key
// (src/auth/pinFingerprint.js's deriveFingerprint) -- the one existing V3-B-safe way to
// represent a PIN's identity without storing or hashing it reversibly/quickly. Fingerprints
// are deterministic (same key + same PIN -> same fingerprint), so replaying the SAME PIN
// for the SAME target produces the SAME hash; a DIFFERENT PIN, even for the same target and
// client_request_id, always produces a DIFFERENT hash -- exactly the "same key, changed
// payload -> conflict" contract every other block enforces.

const crypto = require('crypto');

function sha256Hex(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

// computeSetAccessUserPinRequestHash({targetActor, pinFingerprint}) -> hex string | null
function computeSetAccessUserPinRequestHash({ targetActor, pinFingerprint } = {}) {
  if (typeof targetActor !== 'string' || targetActor.length === 0) return null;
  if (typeof pinFingerprint !== 'string' || pinFingerprint.length === 0) return null;
  return sha256Hex({ target_actor: targetActor, pin_fingerprint: pinFingerprint });
}

module.exports = { computeSetAccessUserPinRequestHash };
