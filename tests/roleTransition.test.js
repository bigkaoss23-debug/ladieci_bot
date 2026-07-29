'use strict';
// Test per src/auth/roleTransition.js — Access Control V3 Block V3-C (FOUNDATION,
// UNWIRED). Eseguire: node tests/roleTransition.test.js
// Pure/offline: no env, no I/O, no DB.

const { canonicalRoleForDbRole, isAssignableRole, ASSIGNABLE_ROLES } = require('../src/auth/roleTransition');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── read-time transitional mapping ──────────────────────────────────────────────
assert('admin -> owner', canonicalRoleForDbRole('admin') === 'owner');
assert('operator -> legacy_operator', canonicalRoleForDbRole('operator') === 'legacy_operator');
assert('rider -> rider', canonicalRoleForDbRole('rider') === 'rider');
for (const r of ['owner', 'cashier', 'waiter', 'kitchen', 'shift_manager', 'legacy_operator']) {
  assert(`already-V3 role maps to itself: ${r}`, canonicalRoleForDbRole(r) === r);
}
assert('unknown role fails closed (null)', canonicalRoleForDbRole('superuser') === null);
assert('empty string fails closed', canonicalRoleForDbRole('') === null);
assert('non-string input fails closed', canonicalRoleForDbRole(null) === null && canonicalRoleForDbRole(undefined) === null);

// ── operator never automatically maps to cashier or waiter ─────────────────────
assert('operator does NOT map to cashier', canonicalRoleForDbRole('operator') !== 'cashier');
assert('operator does NOT map to waiter', canonicalRoleForDbRole('operator') !== 'waiter');

// ── assignable-target whitelist ─────────────────────────────────────────────────
assert('exact assignable set is {cashier, waiter, kitchen, rider, shift_manager}',
  JSON.stringify([...ASSIGNABLE_ROLES].sort()) === JSON.stringify(['cashier', 'kitchen', 'rider', 'shift_manager', 'waiter']));
for (const r of ASSIGNABLE_ROLES) assert(`assignable: ${r}`, isAssignableRole(r) === true);
assert('owner is NOT assignable', isAssignableRole('owner') === false);
assert('legacy_operator is NOT assignable', isAssignableRole('legacy_operator') === false);
assert('admin is NOT assignable', isAssignableRole('admin') === false);
assert('operator is NOT assignable', isAssignableRole('operator') === false);
assert('unknown role is NOT assignable', isAssignableRole('superuser') === false);
assert('non-string is NOT assignable', isAssignableRole(null) === false && isAssignableRole(42) === false);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
