'use strict';
// Access Control V3 — Block V3-B: deterministic PIN fingerprint derivation.
//
// Pure crypto, no env, no I/O, no DB. Given a key {id, secret} and a PIN, derives a
// stable HMAC-SHA256 fingerprint. Deterministic: the same key + the same PIN always
// produce the same fingerprint (required for O(1) lookup); different keys or
// different PINs always produce different fingerprints (required for uniqueness to
// mean anything). Never returns or logs the secret; the return shape carries only
// the key_id and the fingerprint, matching exactly what auth_actor_pin_fingerprints
// stores.
//
// Isolated from every current boot/login path — nothing requires this module today.

const crypto = require('crypto');

// The PIN is used VERBATIM, never trimmed/cased/re-shaped — matching the existing
// login contract's own discipline ("PIN passed verbatim, not trimmed/normalized").
// "Normalization" here means exactly one thing: a defensive digit-string shape check,
// not any transformation of the value itself.
function isNormalizedPin(pin) {
  return typeof pin === 'string' && pin.length > 0 && /^\d+$/.test(pin);
}

// deriveFingerprint({id, secret}, pin) -> { keyId, fingerprint } | null
// `secret` must be a Buffer (as produced by pinFingerprintKeyConfig's strict base64url
// decode) — this function never parses/decodes key material itself, keeping key
// handling entirely in one place.
function deriveFingerprint(key, pin) {
  if (!key || typeof key.id !== 'string' || key.id.length === 0 || !Buffer.isBuffer(key.secret)) return null;
  if (!isNormalizedPin(pin)) return null;
  const fingerprint = crypto.createHmac('sha256', key.secret).update(pin, 'utf8').digest('hex');
  return Object.freeze({ keyId: key.id, fingerprint });
}

// Convenience: derive under every accepted key from a loaded pinFingerprintKeyConfig
// object ({current, previous}), in the exact order a dual-key write needs — current
// first, then previous if configured. Returns [] on any invalid input (fail-closed,
// never a partial list).
function deriveForAcceptedKeys(config, pin) {
  if (!config || !config.current) return Object.freeze([]);
  const results = [];
  const cur = deriveFingerprint(config.current, pin);
  if (!cur) return Object.freeze([]);
  results.push(cur);
  if (config.previous) {
    const prev = deriveFingerprint(config.previous, pin);
    if (!prev) return Object.freeze([]); // fail-closed: never return a partial dual-write list
    results.push(prev);
  }
  return Object.freeze(results);
}

module.exports = { isNormalizedPin, deriveFingerprint, deriveForAcceptedKeys };
