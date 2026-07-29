'use strict';
// Test per src/auth/pinFingerprintKeyConfig.js — Access Control V3 Block V3-B
// (FOUNDATION, UNWIRED). Eseguire: node tests/pinFingerprintKeyConfig.test.js
// Offline: synthetic env-driven secrets only, never real key material. Nothing in the
// running application reads these env vars yet — loading/failing this module cannot
// affect the current boot/login path.

const crypto = require('crypto');
const cfg = require('../src/auth/pinFingerprintKeyConfig');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ENV_KEYS = [
  'AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID', 'AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL',
  'AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_ID', 'AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_B64URL',
  'AUTH_PIN_FINGERPRINT_HMAC_KEY_COMPROMISED_IDS', 'AUTH_JWT_SECRET_B64URL',
];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
function secret() { return crypto.randomBytes(32).toString('base64url'); }
function reload() { cfg._resetForTests(); return cfg.getConfig(); }

function withEnv(vars, fn) {
  clearEnv();
  Object.assign(process.env, vars);
  try { return fn(); } finally { clearEnv(); cfg._resetForTests(); }
}

// ── valid configurations ───────────────────────────────────────────────────────
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret() }, () => {
  const c = reload();
  assert('CURRENT-only: isReady true', cfg.isReady() === true);
  assert('CURRENT-only: config exposes current.id', c && c.current.id === 'k1');
  assert('CURRENT-only: previous is null', c && c.previous === null);
  assert('CURRENT-only: acceptedKeyIds = [k1]', JSON.stringify(cfg.acceptedKeyIds()) === JSON.stringify(['k1']));
  assert('CURRENT-only: describeConfig never includes secret bytes', (() => {
    const d = cfg.describeConfig();
    return d.ready === true && d.currentId === 'k1' && d.previousId === null &&
      !JSON.stringify(d).includes(c.current.secret.toString('base64url'));
  })());
});

withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k2', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_B64URL: secret(),
}, () => {
  const c = reload();
  assert('CURRENT+PREVIOUS: isReady true', cfg.isReady() === true);
  assert('CURRENT+PREVIOUS: both keys present', c && c.current.id === 'k2' && c.previous.id === 'k1');
  assert('CURRENT+PREVIOUS: acceptedKeyIds = [k2,k1] (current first)', JSON.stringify(cfg.acceptedKeyIds()) === JSON.stringify(['k2', 'k1']));
});

// ── absent configuration is not an error for the current app ──────────────────
withEnv({}, () => {
  assert('no env at all: isReady false, never throws', cfg.isReady() === false && cfg.getConfig() === null);
  assert('describeConfig reports not ready without throwing', JSON.stringify(cfg.describeConfig()) === JSON.stringify({ ready: false }));
});

// ── malformed / incomplete CURRENT ─────────────────────────────────────────────
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret() }, () => {
  assert('missing CURRENT_ID -> not ready', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1' }, () => {
  assert('missing CURRENT_B64URL -> not ready', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'K1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret() }, () => {
  assert('malformed key id (uppercase) -> not ready', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'key1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret() }, () => {
  assert('malformed key id (not ^k[0-9]+$) -> not ready', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: crypto.randomBytes(16).toString('base64url') }, () => {
  assert('secret shorter than 32 bytes -> not ready', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: 'not-valid-b64url==' }, () => {
  assert('non-base64url characters ("=") -> not ready', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: '' }, () => {
  assert('empty secret string -> not ready', reload() === null);
});

// ── both-or-neither for PREVIOUS ───────────────────────────────────────────────
withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k2', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_ID: 'k1',
}, () => {
  assert('PREVIOUS_ID without PREVIOUS_B64URL -> not ready (both-or-neither)', reload() === null);
});
withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k2', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_B64URL: secret(),
}, () => {
  assert('PREVIOUS_B64URL without PREVIOUS_ID -> not ready (both-or-neither)', reload() === null);
});
withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_B64URL: secret(),
}, () => {
  assert('current === previous id -> not ready (must differ)', reload() === null);
});

// ── compromised keys are never accepted, as current OR previous ───────────────
withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k3', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_COMPROMISED_IDS: 'k3,k9',
}, () => {
  assert('a compromised id can never be CURRENT', reload() === null);
});
withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k2', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_PREVIOUS_B64URL: secret(),
  AUTH_PIN_FINGERPRINT_HMAC_KEY_COMPROMISED_IDS: 'k1',
}, () => {
  assert('a compromised id can never be accepted as PREVIOUS', reload() === null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_COMPROMISED_IDS: ' k1 , , k4 ' }, () => {
  assert('compromisedKeyIds trims and drops empties', JSON.stringify([...cfg.compromisedKeyIds()].sort()) === JSON.stringify(['k1', 'k4']));
});
withEnv({}, () => {
  assert('no COMPROMISED_IDS env -> empty set', cfg.compromisedKeyIds().size === 0);
});

// ── fingerprint secret must differ from the JWT signing secret ────────────────
{
  const shared = secret();
  withEnv({
    AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: shared,
    AUTH_JWT_SECRET_B64URL: shared,
  }, () => {
    assert('fingerprint CURRENT secret identical to JWT secret -> not ready', reload() === null);
  });
}
withEnv({
  AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret(),
  AUTH_JWT_SECRET_B64URL: secret(),
}, () => {
  assert('fingerprint secret different from an unrelated JWT secret -> ready', reload() !== null);
});
withEnv({ AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_ID: 'k1', AUTH_PIN_FINGERPRINT_HMAC_KEY_CURRENT_B64URL: secret() }, () => {
  assert('no JWT secret configured at all -> separation check simply skipped, still ready', reload() !== null);
});

// ── isValidKeyId / MIN_SECRET_BYTES exports ────────────────────────────────────
assert('isValidKeyId accepts k0, k1, k42', ['k0', 'k1', 'k42'].every((k) => cfg.isValidKeyId(k)));
for (const bad of ['', 'k', 'K1', 'k-1', '1k', 'k1a', null, undefined, 42]) {
  assert(`isValidKeyId rejects ${JSON.stringify(bad)}`, cfg.isValidKeyId(bad) === false);
}
assert('MIN_SECRET_BYTES is 32', cfg.MIN_SECRET_BYTES === 32);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
