'use strict';
// Access Control V3 — Block V3-B: PIN fingerprint HMAC key configuration.
//
// Reads AUTH_PIN_FINGERPRINT_HMAC_KEY_{CURRENT,PREVIOUS}_{ID,B64URL} at load time and
// validates them fail-closed, mirroring the exact discipline already used for
// AUTH_JWT_SECRET_B64URL in src/auth/jwt.js (strict base64url, canonical round-trip,
// >=32 real bytes) — but deliberately NOT importing jwt.js: this module stays fully
// self-contained so it can never become a boot-path dependency by accident. Nothing
// in index.js, login.js, or any current route requires this module. Loading it has
// zero effect on the running application until something explicitly wires it in.
//
// Never logs, never throws with secret material in the message. A missing/absent
// configuration is NOT an error for the CURRENT application — isReady() simply
// returns false, and every current boot/login/PIN path is entirely unaffected because
// none of them call anything in this file.

const crypto = require('crypto');

const KEY_ID_RE = /^k[0-9]+$/;
const MIN_SECRET_BYTES = 32;

function b64urlDecodeStrict(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.length === 0) return null;
  if (buf.toString('base64url') !== s) return null; // canonical round-trip
  return buf;
}

function isValidKeyId(id) {
  return typeof id === 'string' && KEY_ID_RE.test(id);
}

// Compromised key ids — never accepted as CURRENT or PREVIOUS, however valid their
// secret material might otherwise be. Comma-separated list, e.g. "k1,k4". Absent env
// means an empty set (no key is compromised by default).
function compromisedKeyIds() {
  const raw = process.env.AUTH_PIN_FINGERPRINT_HMAC_KEY_COMPROMISED_IDS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

// Loads and validates once. Returns a frozen config object, or null if anything about
// the configuration is invalid/absent — fail-closed, never throws, never logs.
function loadConfig() {
  const compromised = compromisedKeyIds();

  const currentId = process.env.AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID;
  const currentB64 = process.env.AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL;
  if (!isValidKeyId(currentId)) return null;
  if (compromised.has(currentId)) return null; // a compromised id can never be CURRENT
  const currentSecret = b64urlDecodeStrict(currentB64);
  if (!currentSecret || currentSecret.length < MIN_SECRET_BYTES) return null;

  // Fingerprint secret must be a distinct secret from the JWT signing secret — same
  // byte value for both would mean a JWT-secret compromise also compromises every
  // fingerprint, defeating the point of key separation.
  const jwtSecretRaw = process.env.AUTH_JWT_SECRET_B64URL;
  if (typeof jwtSecretRaw === 'string' && jwtSecretRaw.length > 0) {
    const jwtSecret = b64urlDecodeStrict(jwtSecretRaw);
    if (jwtSecret && jwtSecret.length === currentSecret.length &&
        crypto.timingSafeEqual(jwtSecret, currentSecret)) {
      return null; // refuse: fingerprint secret must not equal the JWT secret
    }
  }

  const previousId = process.env.AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_ID;
  const previousB64 = process.env.AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_B64URL;
  const previousIdSet = previousId !== undefined && previousId !== '';
  const previousB64Set = previousB64 !== undefined && previousB64 !== '';
  if (previousIdSet !== previousB64Set) return null; // both-or-neither

  let previous = null;
  if (previousIdSet) {
    if (!isValidKeyId(previousId)) return null;
    if (compromised.has(previousId)) return null; // a compromised id can never be accepted as PREVIOUS
    if (previousId === currentId) return null; // current and previous must differ
    const previousSecret = b64urlDecodeStrict(previousB64);
    if (!previousSecret || previousSecret.length < MIN_SECRET_BYTES) return null;
    previous = Object.freeze({ id: previousId, secret: previousSecret });
  }

  return Object.freeze({
    current: Object.freeze({ id: currentId, secret: currentSecret }),
    previous, // null, or { id, secret }
    compromisedIds: Object.freeze(new Set(compromised)),
  });
}

let _config; // lazy, computed once per process — never re-reads env mid-run
function getConfig() {
  if (_config === undefined) _config = loadConfig();
  return _config;
}
function isReady() { return getConfig() !== null; }

// Accepted key ids for the CURRENT process config — [currentId] or [currentId, previousId].
function acceptedKeyIds() {
  const cfg = getConfig();
  if (!cfg) return Object.freeze([]);
  return cfg.previous ? Object.freeze([cfg.current.id, cfg.previous.id]) : Object.freeze([cfg.current.id]);
}

// Never returns secret material — only which key ids are configured, safe to log/expose.
function describeConfig() {
  const cfg = getConfig();
  if (!cfg) return Object.freeze({ ready: false });
  return Object.freeze({
    ready: true,
    currentId: cfg.current.id,
    previousId: cfg.previous ? cfg.previous.id : null,
  });
}

// Test-only: force a re-read of env on the next getConfig() call. Never used by any
// production path — production loads env once, like every other secret module here.
function _resetForTests() { _config = undefined; }

module.exports = {
  isValidKeyId, isReady, getConfig, acceptedKeyIds, describeConfig, compromisedKeyIds,
  MIN_SECRET_BYTES, _resetForTests,
};
