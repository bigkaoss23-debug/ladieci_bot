'use strict';
// Test per src/auth/fingerprintKeyRetirement.js — Access Control V3 Block V3-A
// (FOUNDATION, UNWIRED). Eseguire: node tests/fingerprintKeyRetirement.test.js
// Pure/offline: no env, no I/O, no DB, no HMAC secret. No production behavior switch —
// this module is not called from anywhere yet.

const { KEY_STATUSES, keyEligibility, canRetireKey, actorsBlockingRetirement } = require('../src/auth/fingerprintKeyRetirement');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ══ key eligibility — compromised is NOT a graceful-previous variant ══════════
assert('current key: lookup + write both true', keyEligibility('current').lookup === true && keyEligibility('current').write === true);
assert('previous_accepted key: lookup true (fallback), write true (dual-write while accepted)',
  keyEligibility('previous_accepted').lookup === true && keyEligibility('previous_accepted').write === true);
assert('compromised key: lookup IMMEDIATELY false', keyEligibility('compromised').lookup === false);
assert('compromised key: write IMMEDIATELY false (never used for new fingerprint writes)', keyEligibility('compromised').write === false);
assert('retired key: lookup and write both false', keyEligibility('retired').lookup === false && keyEligibility('retired').write === false);
assert('unknown/malformed status fails closed (both false)', keyEligibility('bogus').lookup === false && keyEligibility('bogus').write === false);
assert('compromised does NOT get the normal graceful dual-key treatment (differs from previous_accepted)',
  JSON.stringify(keyEligibility('compromised')) !== JSON.stringify(keyEligibility('previous_accepted')));
assert('KEY_STATUSES enumerates exactly the 4 expected states', KEY_STATUSES.length === 4 &&
  ['current', 'previous_accepted', 'compromised', 'retired'].every((s) => KEY_STATUSES.includes(s)));

// ══ retirement precondition — every configured actor, no active-only filter ═══
const ownerActive = { actor: 'owner', active: true, pinConfigured: true, fingerprintKeyIds: ['k1', 'k2'] };
const cashierActive = { actor: 'usr_abc', active: true, pinConfigured: true, fingerprintKeyIds: ['k1', 'k2'] };
const riderInactivePinned = { actor: 'usr_def', active: false, pinConfigured: true, fingerprintKeyIds: ['k1'] }; // NOT yet on k2
const legacyOperatorPinned = { actor: 'operator_backup', active: true, pinConfigured: true, fingerprintKeyIds: ['k1', 'k2'] };
const noPinRow = { actor: 'usr_never_pinned', active: true, pinConfigured: false, fingerprintKeyIds: [] };

assert('retirement blocked while ANY configured actor lacks the current key — including an INACTIVE one',
  canRetireKey({ actors: [ownerActive, cashierActive, riderInactivePinned, legacyOperatorPinned], keyId: 'k2' }) === false);
assert('retirement allowed once every configured actor (active AND inactive) has the current key',
  canRetireKey({ actors: [ownerActive, cashierActive, { ...riderInactivePinned, fingerprintKeyIds: ['k1', 'k2'] }, legacyOperatorPinned], keyId: 'k2' }) === true);
assert('owner is included in the retirement check like any other configured actor',
  canRetireKey({ actors: [{ ...ownerActive, fingerprintKeyIds: ['k1'] }, cashierActive], keyId: 'k2' }) === false);
assert('legacy_operator rows are included in the retirement check (not exempt)',
  canRetireKey({ actors: [ownerActive, cashierActive, { ...legacyOperatorPinned, fingerprintKeyIds: ['k1'] }], keyId: 'k2' }) === false);
assert('an actor with NO configured PIN never blocks retirement (nothing to reserve)',
  canRetireKey({ actors: [ownerActive, cashierActive, noPinRow], keyId: 'k2' }) === true);
assert('no configured actors at all -> vacuously retirable', canRetireKey({ actors: [noPinRow], keyId: 'k2' }) === true);
assert('malformed input (no actors array) fails closed to false', canRetireKey({ keyId: 'k2' }) === false);
assert('malformed input (no keyId) fails closed to false', canRetireKey({ actors: [ownerActive] }) === false);

// explicitly prove there is NO active-only filter anywhere in this logic: an
// all-inactive-but-configured population still gates retirement correctly.
const allInactive = [
  { actor: 'owner', active: false, pinConfigured: true, fingerprintKeyIds: ['k1'] },
  { actor: 'usr_x', active: false, pinConfigured: true, fingerprintKeyIds: ['k1', 'k2'] },
];
assert('retirement still correctly blocked even when every configured actor is inactive (no active=true filter exists)',
  canRetireKey({ actors: allInactive, keyId: 'k2' }) === false);

// ── progress reporting helper ─────────────────────────────────────────────────
const blocking = actorsBlockingRetirement({ actors: [ownerActive, cashierActive, riderInactivePinned, legacyOperatorPinned], keyId: 'k2' });
assert('actorsBlockingRetirement lists exactly the actor(s) still missing the key', blocking.length === 1 && blocking[0] === 'usr_def');
assert('actorsBlockingRetirement never includes an actor with no configured PIN', !actorsBlockingRetirement({ actors: [noPinRow], keyId: 'k2' }).includes('usr_never_pinned'));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
