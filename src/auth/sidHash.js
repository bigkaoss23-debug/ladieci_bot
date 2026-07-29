'use strict';
// Access Control V3 — Block V3-C: session-id hashing for idempotency keys (FOUNDATION
// ONLY, UNWIRED). Pure crypto, no env, no I/O, no DB, no secret.
//
// access_management_idempotency.by_sid_hash is documented (V3-A migration) as exactly
// sha256(sid), never the raw session id. Plain SHA-256, not HMAC: unlike an IP address
// (low entropy, needs a keyed hash to resist brute-force reconstruction), a `sid` is
// already a high-entropy, per-login random token minted by jwt.js — hashing it without a
// key does not make it guessable, and keeps this binding to the documented contract
// exactly, with no secret to provision or lose.

const crypto = require('crypto');

// sidHash(sid) -> hex string | null
function sidHash(sid) {
  if (typeof sid !== 'string' || sid.length === 0) return null;
  return crypto.createHash('sha256').update(sid, 'utf8').digest('hex');
}

module.exports = { sidHash };
