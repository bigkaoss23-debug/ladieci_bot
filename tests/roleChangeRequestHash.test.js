'use strict';
// Test per src/auth/roleChangeRequestHash.js and src/auth/sidHash.js — Access Control
// V3 Block V3-C (FOUNDATION, UNWIRED). Eseguire: node tests/roleChangeRequestHash.test.js
// Pure/offline: no env, no I/O, no DB, no secret.

const { computeRoleChangeRequestHash } = require('../src/auth/roleChangeRequestHash');
const { sidHash } = require('../src/auth/sidHash');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── request hash ─────────────────────────────────────────────────────────────
const base = { targetActor: 'operator_primary', expectedRole: 'operator', requestedRole: 'cashier' };
assert('valid input produces a hex digest', /^[0-9a-f]{64}$/.test(computeRoleChangeRequestHash(base)));
assert('deterministic: same input -> same hash',
  computeRoleChangeRequestHash(base) === computeRoleChangeRequestHash({ ...base }));
assert('different target actor -> different hash',
  computeRoleChangeRequestHash(base) !== computeRoleChangeRequestHash({ ...base, targetActor: 'operator_backup' }));
assert('different expected role -> different hash',
  computeRoleChangeRequestHash(base) !== computeRoleChangeRequestHash({ ...base, expectedRole: 'legacy_operator' }));
assert('different requested role -> different hash',
  computeRoleChangeRequestHash(base) !== computeRoleChangeRequestHash({ ...base, requestedRole: 'waiter' }));
assert('non-assignable requested role fails closed (null)',
  computeRoleChangeRequestHash({ ...base, requestedRole: 'admin' }) === null);
assert('missing targetActor fails closed', computeRoleChangeRequestHash({ ...base, targetActor: '' }) === null);
assert('missing expectedRole fails closed', computeRoleChangeRequestHash({ ...base, expectedRole: null }) === null);
assert('no token/proof/cookie field can ever influence the hash',
  computeRoleChangeRequestHash({ ...base, token: 'tkn', proof: 'prf', cookie: 'ck' }) === computeRoleChangeRequestHash(base));

// ── sid hash ──────────────────────────────────────────────────────────────────
assert('valid sid produces a hex digest', /^[0-9a-f]{64}$/.test(sidHash('a-real-looking-random-sid-value')));
assert('deterministic: same sid -> same hash', sidHash('same-sid') === sidHash('same-sid'));
assert('different sid -> different hash', sidHash('sid-one') !== sidHash('sid-two'));
assert('empty/non-string sid fails closed', sidHash('') === null && sidHash(null) === null && sidHash(undefined) === null);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
