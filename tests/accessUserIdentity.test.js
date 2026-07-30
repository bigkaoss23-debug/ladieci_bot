'use strict';
// Test per src/auth/accessUserIdentity.js -- Access Control V3 Block V3-D (FOUNDATION,
// UNWIRED). Eseguire: node tests/accessUserIdentity.test.js
// Pure/offline: no env, no I/O, no DB.

const { LEGACY_ACTOR_IDS, isLegacyActorId, isDynamicActorId, isValidActorId } = require('../src/auth/accessUserIdentity');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── legacy ids ───────────────────────────────────────────────────────────────
for (const id of LEGACY_ACTOR_IDS) {
  assert(`exact legacy id accepted: ${id}`, isLegacyActorId(id) === true && isValidActorId(id) === true);
  assert(`legacy id is not classified as dynamic: ${id}`, isDynamicActorId(id) === false);
}
assert('exactly the 4 documented legacy ids', JSON.stringify([...LEGACY_ACTOR_IDS].sort()) === JSON.stringify(['operator_backup', 'operator_primary', 'owner', 'rider']));

// ── canonical UUID ids ───────────────────────────────────────────────────────
const REAL_UUID = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
assert('canonical lowercase UUID accepted as dynamic', isDynamicActorId(REAL_UUID) === true && isValidActorId(REAL_UUID) === true);
assert('canonical UUID is not classified as legacy', isLegacyActorId(REAL_UUID) === false);

// ── malformed ids rejected ──────────────────────────────────────────────────
for (const bad of [
  'OWNER', // legacy id must match exactly, case-sensitive
  'operator_third',
  'A1B2C3D4-E5F6-4789-9ABC-DEF012345678', // uppercase UUID rejected -- canonical form only
  'a1b2c3d4-e5f6-4789-9abc-def01234567', // one hex digit short
  'a1b2c3d4e5f647899abcdef012345678', // no hyphens
  '', null, undefined, 42, {},
]) {
  assert(`malformed id rejected: ${JSON.stringify(bad)}`, isValidActorId(bad) === false);
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
