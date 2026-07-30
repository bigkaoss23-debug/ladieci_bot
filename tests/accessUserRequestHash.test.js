'use strict';
// Test per src/auth/accessUserRequestHash.js -- Access Control V3 Block V3-D
// (FOUNDATION, UNWIRED). Eseguire: node tests/accessUserRequestHash.test.js
// Pure/offline: no env, no I/O, no DB, no secret.

const { computeCreateAccessUserRequestHash, computeRenameAccessUserRequestHash } = require('../src/auth/accessUserRequestHash');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── CREATE hash ──────────────────────────────────────────────────────────────
const createBase = { displayName: 'Ana Torres', requestedRole: 'cashier' };
assert('CREATE: valid input produces a 64-hex digest', /^[0-9a-f]{64}$/.test(computeCreateAccessUserRequestHash(createBase)));
assert('CREATE: deterministic', computeCreateAccessUserRequestHash(createBase) === computeCreateAccessUserRequestHash({ ...createBase }));
assert('CREATE: whitespace-only difference normalizes to the SAME hash',
  computeCreateAccessUserRequestHash(createBase) === computeCreateAccessUserRequestHash({ ...createBase, displayName: '  Ana Torres  ' }));
assert('CREATE: different display name -> different hash',
  computeCreateAccessUserRequestHash(createBase) !== computeCreateAccessUserRequestHash({ ...createBase, displayName: 'Ana Perez' }));
assert('CREATE: different requested role -> different hash',
  computeCreateAccessUserRequestHash(createBase) !== computeCreateAccessUserRequestHash({ ...createBase, requestedRole: 'waiter' }));
assert('CREATE: non-assignable role fails closed', computeCreateAccessUserRequestHash({ ...createBase, requestedRole: 'admin' }) === null);
assert('CREATE: invalid display name fails closed', computeCreateAccessUserRequestHash({ ...createBase, displayName: '' }) === null);
assert('CREATE: no token/proof/sid field can influence the hash',
  computeCreateAccessUserRequestHash({ ...createBase, token: 'tkn', proof: 'prf', sid: 'sid-1' }) === computeCreateAccessUserRequestHash(createBase));

// ── RENAME hash ──────────────────────────────────────────────────────────────
const renameBase = { targetActor: 'operator_primary', newDisplayName: 'Ana Torres' };
assert('RENAME: valid input produces a 64-hex digest', /^[0-9a-f]{64}$/.test(computeRenameAccessUserRequestHash(renameBase)));
assert('RENAME: deterministic', computeRenameAccessUserRequestHash(renameBase) === computeRenameAccessUserRequestHash({ ...renameBase }));
assert('RENAME: different target actor -> different hash',
  computeRenameAccessUserRequestHash(renameBase) !== computeRenameAccessUserRequestHash({ ...renameBase, targetActor: 'operator_backup' }));
assert('RENAME: different new name -> different hash',
  computeRenameAccessUserRequestHash(renameBase) !== computeRenameAccessUserRequestHash({ ...renameBase, newDisplayName: 'Ana Perez' }));
assert('RENAME: missing targetActor fails closed', computeRenameAccessUserRequestHash({ ...renameBase, targetActor: '' }) === null);
assert('RENAME: invalid new display name fails closed', computeRenameAccessUserRequestHash({ ...renameBase, newDisplayName: '   ' }) === null);

// ── the two actions never collide even with overlapping-looking inputs ────────
assert('CREATE and RENAME hashes never collide for structurally similar inputs',
  computeCreateAccessUserRequestHash({ displayName: 'operator_primary', requestedRole: 'cashier' }) !==
  computeRenameAccessUserRequestHash({ targetActor: 'operator_primary', newDisplayName: 'cashier' }));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
