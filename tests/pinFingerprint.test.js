'use strict';
// Test per src/auth/pinFingerprint.js — Access Control V3 Block V3-B (FOUNDATION,
// UNWIRED). Eseguire: node tests/pinFingerprint.test.js
// Pure crypto, no env, no I/O, no DB. Nothing calls this module yet.

const crypto = require('crypto');
const { isNormalizedPin, deriveFingerprint, deriveForAcceptedKeys } = require('../src/auth/pinFingerprint');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const key = (id) => Object.freeze({ id, secret: crypto.randomBytes(32) });

// ── isNormalizedPin ────────────────────────────────────────────────────────────
for (const good of ['482915', '903421756', '000000', '1']) {
  assert(`isNormalizedPin accepts ${JSON.stringify(good)}`, isNormalizedPin(good) === true);
}
for (const bad of ['', '48291a', ' 482915', '482915 ', '48-2915', null, undefined, 482915, {}]) {
  assert(`isNormalizedPin rejects ${JSON.stringify(bad)}`, isNormalizedPin(bad) === false);
}

// ── deriveFingerprint: determinism ─────────────────────────────────────────────
{
  const k1 = key('k1');
  const a = deriveFingerprint(k1, '482915');
  const b = deriveFingerprint(k1, '482915');
  assert('same key + same PIN -> identical fingerprint', a.fingerprint === b.fingerprint);
  assert('fingerprint is a 64-char lowercase hex string (sha256)', /^[0-9a-f]{64}$/.test(a.fingerprint));
  assert('returned shape carries only keyId + fingerprint', JSON.stringify(Object.keys(a).sort()) === JSON.stringify(['fingerprint', 'keyId']));
  assert('returned object is frozen', Object.isFrozen(a));
  assert('keyId echoes the key used', a.keyId === 'k1');
}

// ── deriveFingerprint: differentiation ─────────────────────────────────────────
{
  const k1 = key('k1');
  const k2 = key('k2');
  const same = deriveFingerprint(k1, '482915');
  const diffKey = deriveFingerprint(k2, '482915');
  const diffPin = deriveFingerprint(k1, '482916');
  assert('different key, same PIN -> different fingerprint', same.fingerprint !== diffKey.fingerprint);
  assert('same key, different PIN -> different fingerprint', same.fingerprint !== diffPin.fingerprint);
}

// ── deriveFingerprint: never leaks the secret ──────────────────────────────────
{
  const k1 = key('k1');
  const r = deriveFingerprint(k1, '482915');
  assert('fingerprint never equals the raw secret (hex or base64url)', r.fingerprint !== k1.secret.toString('hex') && r.fingerprint !== k1.secret.toString('base64url'));
}

// ── deriveFingerprint: invalid input fails closed to null ─────────────────────
assert('missing key -> null', deriveFingerprint(null, '482915') === null);
assert('key without id -> null', deriveFingerprint({ secret: crypto.randomBytes(32) }, '482915') === null);
assert('key with empty id -> null', deriveFingerprint({ id: '', secret: crypto.randomBytes(32) }, '482915') === null);
assert('key with non-Buffer secret -> null', deriveFingerprint({ id: 'k1', secret: 'not-a-buffer' }, '482915') === null);
for (const bad of ['', '48291a', null, undefined, 482915]) {
  assert(`invalid PIN ${JSON.stringify(bad)} -> null`, deriveFingerprint(key('k1'), bad) === null);
}

// ── deriveForAcceptedKeys: CURRENT-only ────────────────────────────────────────
{
  const k1 = key('k1');
  const config = Object.freeze({ current: k1, previous: null });
  const fps = deriveForAcceptedKeys(config, '482915');
  assert('CURRENT-only: exactly one fingerprint', fps.length === 1);
  assert('CURRENT-only: matches deriveFingerprint(current, pin)', fps[0].fingerprint === deriveFingerprint(k1, '482915').fingerprint);
  assert('CURRENT-only: keyId is current.id', fps[0].keyId === 'k1');
}

// ── deriveForAcceptedKeys: CURRENT + PREVIOUS (graceful rotation window) ──────
{
  const k2 = key('k2');
  const k1 = key('k1');
  const config = Object.freeze({ current: k2, previous: k1 });
  const fps = deriveForAcceptedKeys(config, '482915');
  assert('CURRENT+PREVIOUS: exactly two fingerprints', fps.length === 2);
  assert('CURRENT+PREVIOUS: current listed first', fps[0].keyId === 'k2' && fps[1].keyId === 'k1');
  assert('CURRENT+PREVIOUS: the two fingerprints differ (different keys)', fps[0].fingerprint !== fps[1].fingerprint);
  assert('CURRENT+PREVIOUS: each matches an independent deriveFingerprint call',
    fps[0].fingerprint === deriveFingerprint(k2, '482915').fingerprint &&
    fps[1].fingerprint === deriveFingerprint(k1, '482915').fingerprint);
}

// ── deriveForAcceptedKeys: fail-closed, never a partial dual-write list ───────
{
  const k2 = key('k2');
  const brokenPrevious = { id: 'k1', secret: 'not-a-buffer' }; // would make deriveFingerprint(previous) fail
  const config = Object.freeze({ current: k2, previous: brokenPrevious });
  const fps = deriveForAcceptedKeys(config, '482915');
  assert('a failing PREVIOUS derivation returns [] entirely, never [current] alone', fps.length === 0);
}
assert('missing config -> []', deriveForAcceptedKeys(null, '482915').length === 0);
assert('config without current -> []', deriveForAcceptedKeys({ previous: null }, '482915').length === 0);
assert('invalid PIN with valid config -> []', deriveForAcceptedKeys({ current: key('k1'), previous: null }, 'not-a-pin').length === 0);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
