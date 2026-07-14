// Test per src/auth/pinPolicy.js — B3. Eseguire: node tests/pinPolicy.test.js
// Valori SINTETICI. Nessun PIN reale.
const pp = require('../src/auth/pinPolicy');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  → ' + d : '')); } };
const ok = (pin, role) => pp.validatePinFormat(pin, role).ok;

// admin: 8..12 digits
assert('admin 8 strong ok', ok('13572468', 'admin'));
assert('admin 12 strong ok', ok('135724680246', 'admin'));
assert('admin 7 too short', !ok('1357246', 'admin'));
assert('admin 13 too long', !ok('1357246802468', 'admin'));
assert('admin all-same reject', !ok('00000000', 'admin'));
assert('admin sequential reject', !ok('12345678', 'admin'));
assert('admin non-digits reject', !ok('1357abcd', 'admin'));

// operator/rider: 6..8
for (const role of ['operator', 'rider']) {
  assert(`${role} 6 ok`, ok('135724', role));
  assert(`${role} 8 ok`, ok('13572468', role));
  assert(`${role} 5 too short`, !ok('13572', role));
  assert(`${role} 9 too long`, !ok('135724680', role));
  assert(`${role} 123456 weak`, !ok('123456', role));
  assert(`${role} 654321 sequential`, !ok('654321', role));
  assert(`${role} 111111 all-same`, !ok('111111', role));
  assert(`${role} 121212 repeated block`, !ok('121212', role));
  assert(`${role} 123123 repeated block`, !ok('123123', role));
  assert(`${role} non-digits reject`, !ok('12ab56', role));
}

assert('unknown role reject', !ok('13572468', 'superuser'));
assert('empty reject', !ok('', 'operator'));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
