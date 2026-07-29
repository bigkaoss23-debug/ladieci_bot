'use strict';
// Test per src/auth/ownerCredentialRole.js — Access Control V3 Block V3-B correction
// (FOUNDATION, UNWIRED). Eseguire: node tests/ownerCredentialRole.test.js
// Pure/offline: no env, no I/O, no DB. Proves the reserved-owner-credential decision is
// made by ROLE, never by the actor id literal 'owner'.

const { OWNER_CREDENTIAL_ROLES, isOwnerCredentialRole } = require('../src/auth/ownerCredentialRole');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

assert('transitional legacy owner role: admin -> true', isOwnerCredentialRole('admin') === true);
assert('stable V3 owner role: owner -> true', isOwnerCredentialRole('owner') === true);
assert('operator -> false', isOwnerCredentialRole('operator') === false);
assert('rider -> false', isOwnerCredentialRole('rider') === false);
assert('cashier -> false', isOwnerCredentialRole('cashier') === false);
assert('waiter -> false', isOwnerCredentialRole('waiter') === false);
assert('kitchen -> false', isOwnerCredentialRole('kitchen') === false);
assert('shift_manager -> false', isOwnerCredentialRole('shift_manager') === false);
assert('legacy_operator -> false', isOwnerCredentialRole('legacy_operator') === false);
assert('unknown role string -> false (fail closed, not fail open)', isOwnerCredentialRole('superuser') === false);
assert('non-string input fails closed', isOwnerCredentialRole(null) === false && isOwnerCredentialRole(undefined) === false && isOwnerCredentialRole(42) === false);
assert('the decision is a pure function of ROLE ONLY — actor id/label play no part in its signature',
  isOwnerCredentialRole.length === 1);
assert('OWNER_CREDENTIAL_ROLES is exactly {admin, owner}, frozen', Object.isFrozen(OWNER_CREDENTIAL_ROLES)
  && JSON.stringify([...OWNER_CREDENTIAL_ROLES].sort()) === JSON.stringify(['admin', 'owner']));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
