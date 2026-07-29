'use strict';
// Test per src/auth/roleRegistry.js — Access Control V3 Block V3-A (FOUNDATION, UNWIRED).
// Eseguire: node tests/roleRegistry.test.js
// Pure/offline: no env, no I/O, no DB.

const roleRegistry = require('../src/auth/roleRegistry');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const EXPECTED = ['owner', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'legacy_operator'];

// ── exact role set ────────────────────────────────────────────────────────────
assert('exactly the 7 accepted role codes, no more, no fewer',
  roleRegistry.ROLE_CODES.length === EXPECTED.length && EXPECTED.every((c) => roleRegistry.ROLE_CODES.includes(c)),
  JSON.stringify(roleRegistry.ROLE_CODES));
assert('ROLE_SET matches ROLE_CODES', EXPECTED.every((c) => roleRegistry.ROLE_SET.has(c)) && roleRegistry.ROLE_SET.size === EXPECTED.length);
assert('every role appears exactly once', new Set(roleRegistry.ROLE_CODES).size === roleRegistry.ROLE_CODES.length);

// ── owner not assignable ──────────────────────────────────────────────────────
assert('owner is not assignable to new users', roleRegistry.isAssignableToNewUsers('owner') === false);
assert('owner not-assignable is reflected on the role object itself', roleRegistry.getRole('owner').assignableToNewUsers === false);

// ── legacy_operator not assignable ────────────────────────────────────────────
assert('legacy_operator is not assignable to new users', roleRegistry.isAssignableToNewUsers('legacy_operator') === false);

// ── every OTHER role IS assignable ────────────────────────────────────────────
for (const code of ['cashier', 'waiter', 'kitchen', 'rider', 'shift_manager']) {
  assert(`${code} is assignable to new users`, roleRegistry.isAssignableToNewUsers(code) === true);
}

// ── shift_manager beta, visibly labeled ───────────────────────────────────────
assert('shift_manager state is beta', roleRegistry.getRole('shift_manager').state === 'beta');
assert('shift_manager carries the exact required beta label', roleRegistry.getRole('shift_manager').betaLabel === 'Beta · En desarrollo');
assert('isBeta(shift_manager) === true', roleRegistry.isBeta('shift_manager') === true);

// ── waiter beta ────────────────────────────────────────────────────────────────
assert('waiter state is beta', roleRegistry.getRole('waiter').state === 'beta');
assert('waiter carries the exact required beta label', roleRegistry.getRole('waiter').betaLabel === 'Beta · En desarrollo');
assert('isBeta(waiter) === true', roleRegistry.isBeta('waiter') === true);

// ── every other role is NOT beta ──────────────────────────────────────────────
for (const code of ['owner', 'cashier', 'kitchen', 'rider']) {
  assert(`${code} is not beta`, roleRegistry.isBeta(code) === false);
}
assert('legacy_operator state is legacy, not beta or stable', roleRegistry.getRole('legacy_operator').state === 'legacy');

// ── no alias of waiter/kitchen/shift_manager to operator ──────────────────────
// These three are new, distinct role codes with no legacy equivalent — none of them
// may collapse onto (or be defined in terms of) the old 'operator' concept anywhere
// in this registry.
for (const code of ['waiter', 'kitchen', 'shift_manager']) {
  const role = roleRegistry.getRole(code);
  assert(`${code} is not aliased to 'operator' (distinct code)`, role.code !== 'operator' && role.code === code);
}
assert(`'operator' is not itself a valid V3 role code (retired vocabulary)`, roleRegistry.isValidRoleCode('operator') === false);
assert(`'admin' is not itself a valid V3 role code (retired vocabulary)`, roleRegistry.isValidRoleCode('admin') === false);

// ── PIN policy references are sane (owner stricter than everyone else) ────────
assert('owner references the admin (9-12 digit) PIN policy', roleRegistry.getRole('owner').pinPolicyRef === 'admin');
for (const code of ['cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'legacy_operator']) {
  assert(`${code} references the operator (6-8 digit) PIN policy`, roleRegistry.getRole(code).pinPolicyRef === 'operator');
}

// ── invalid input handling ────────────────────────────────────────────────────
assert('isValidRoleCode rejects non-string/unknown', roleRegistry.isValidRoleCode(null) === false && roleRegistry.isValidRoleCode('bogus') === false && roleRegistry.isValidRoleCode(123) === false);
assert('getRole returns null for an unknown code', roleRegistry.getRole('bogus') === null);
assert('isAssignableToNewUsers/isBeta are false-safe for unknown codes', roleRegistry.isAssignableToNewUsers('bogus') === false && roleRegistry.isBeta('bogus') === false);

// ── immutability ───────────────────────────────────────────────────────────────
assert('ROLES array is frozen', Object.isFrozen(roleRegistry.ROLES));
assert('each role entry is frozen', roleRegistry.ROLES.every((r) => Object.isFrozen(r)));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
