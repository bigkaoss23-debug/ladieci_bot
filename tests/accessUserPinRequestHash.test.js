'use strict';
// Access Control V3 -- Block V3-F: accessUserPinRequestHash.js unit tests.
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const { computeSetAccessUserPinRequestHash } = require('../src/auth/accessUserPinRequestHash');

const h1 = computeSetAccessUserPinRequestHash({ targetActor: 'dyn_cashier', pinFingerprint: 'fp_A' });
const h1again = computeSetAccessUserPinRequestHash({ targetActor: 'dyn_cashier', pinFingerprint: 'fp_A' });
const h2 = computeSetAccessUserPinRequestHash({ targetActor: 'dyn_cashier', pinFingerprint: 'fp_B' });
const h3 = computeSetAccessUserPinRequestHash({ targetActor: 'dyn_waiter', pinFingerprint: 'fp_A' });

assert('returns a 64-char hex string', typeof h1 === 'string' && /^[0-9a-f]{64}$/.test(h1));
assert('deterministic: same target + same fingerprint -> identical hash', h1 === h1again);
assert('different fingerprint (different PIN) -> different hash', h1 !== h2);
assert('different target actor -> different hash', h1 !== h3);
assert('missing targetActor -> null', computeSetAccessUserPinRequestHash({ pinFingerprint: 'fp_A' }) === null);
assert('missing pinFingerprint -> null', computeSetAccessUserPinRequestHash({ targetActor: 'x' }) === null);
assert('empty targetActor -> null', computeSetAccessUserPinRequestHash({ targetActor: '', pinFingerprint: 'fp_A' }) === null);
assert('empty pinFingerprint -> null', computeSetAccessUserPinRequestHash({ targetActor: 'x', pinFingerprint: '' }) === null);
assert('no arguments -> null', computeSetAccessUserPinRequestHash() === null);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
