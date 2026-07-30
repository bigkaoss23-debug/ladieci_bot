'use strict';
// Test per src/auth/accessUserLifecycleRequestHash.js -- Access Control V3 Block V3-E
// (FOUNDATION, UNWIRED). Eseguire: node tests/accessUserLifecycleRequestHash.test.js
// Pure/offline: no env, no I/O, no DB, no secret.

const { computeActiveStateRequestHash, computeClearCredentialRequestHash } = require('../src/auth/accessUserLifecycleRequestHash');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── ACTIVE-STATE hash ────────────────────────────────────────────────────────────
const activeBase = { targetActor: 'operator_primary', expectedActive: true, requestedActive: false };
assert('ACTIVE: valid input produces a 64-hex digest', /^[0-9a-f]{64}$/.test(computeActiveStateRequestHash(activeBase)));
assert('ACTIVE: deterministic', computeActiveStateRequestHash(activeBase) === computeActiveStateRequestHash({ ...activeBase }));
assert('ACTIVE: different target -> different hash',
  computeActiveStateRequestHash(activeBase) !== computeActiveStateRequestHash({ ...activeBase, targetActor: 'operator_backup' }));
assert('ACTIVE: different expected state -> different hash',
  computeActiveStateRequestHash(activeBase) !== computeActiveStateRequestHash({ ...activeBase, expectedActive: false }));
assert('ACTIVE: different requested state -> different hash (deactivate vs reactivate)',
  computeActiveStateRequestHash(activeBase) !== computeActiveStateRequestHash({ ...activeBase, requestedActive: true }));
assert('ACTIVE: non-boolean expectedActive fails closed', computeActiveStateRequestHash({ ...activeBase, expectedActive: 'true' }) === null);
assert('ACTIVE: non-boolean requestedActive fails closed', computeActiveStateRequestHash({ ...activeBase, requestedActive: null }) === null);
assert('ACTIVE: missing targetActor fails closed', computeActiveStateRequestHash({ ...activeBase, targetActor: '' }) === null);
assert('ACTIVE: no token/proof/sid field can influence the hash',
  computeActiveStateRequestHash({ ...activeBase, token: 'tkn', proof: 'prf', sid: 'sid-1' }) === computeActiveStateRequestHash(activeBase));

// ── CLEAR CREDENTIAL hash ────────────────────────────────────────────────────────
const clearBase = { targetActor: 'operator_primary', expectedSessionVersion: 10 };
assert('CLEAR: valid input produces a 64-hex digest', /^[0-9a-f]{64}$/.test(computeClearCredentialRequestHash(clearBase)));
assert('CLEAR: deterministic', computeClearCredentialRequestHash(clearBase) === computeClearCredentialRequestHash({ ...clearBase }));
assert('CLEAR: different target -> different hash',
  computeClearCredentialRequestHash(clearBase) !== computeClearCredentialRequestHash({ ...clearBase, targetActor: 'rider' }));
assert('CLEAR: different expected session version -> different hash',
  computeClearCredentialRequestHash(clearBase) !== computeClearCredentialRequestHash({ ...clearBase, expectedSessionVersion: 11 }));
assert('CLEAR: non-integer session version fails closed', computeClearCredentialRequestHash({ ...clearBase, expectedSessionVersion: 1.5 }) === null);
assert('CLEAR: session version < 1 fails closed', computeClearCredentialRequestHash({ ...clearBase, expectedSessionVersion: 0 }) === null);
assert('CLEAR: no pin/pin_hash/fingerprint field can influence the hash',
  computeClearCredentialRequestHash({ ...clearBase, pin: '482915', pin_hash: 'scrypt$x', fingerprint: 'fp' }) === computeClearCredentialRequestHash(clearBase));

// ── the two actions never collide even with structurally similar inputs ──────────
assert('ACTIVE-STATE and CLEAR hashes never collide for structurally similar inputs',
  computeActiveStateRequestHash({ targetActor: 'operator_primary', expectedActive: true, requestedActive: false }) !==
  computeClearCredentialRequestHash({ targetActor: 'operator_primary', expectedSessionVersion: 1 }));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
