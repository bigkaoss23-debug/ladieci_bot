'use strict';
// Test per src/auth/accessUserDisplayName.js -- Access Control V3 Block V3-D
// (FOUNDATION, UNWIRED). Eseguire: node tests/accessUserDisplayName.test.js
// Pure/offline: no env, no I/O, no DB.

const { normalizeDisplayName, MAX_DISPLAY_NAME_LENGTH } = require('../src/auth/accessUserDisplayName');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

assert('trims surrounding whitespace', normalizeDisplayName('  Ana  ') === 'Ana');
assert('rejects empty string', normalizeDisplayName('') === null);
assert('rejects whitespace-only string', normalizeDisplayName('   ') === null);
assert('rejects non-string input', normalizeDisplayName(null) === null && normalizeDisplayName(undefined) === null && normalizeDisplayName(42) === null);

for (const code of [0, 1, 8, 9, 27, 31, 127]) {
  const s = 'Ana' + String.fromCharCode(code) + 'Maria';
  assert(`rejects control character code ${code}`, normalizeDisplayName(s) === null);
}

assert('accepts exactly MAX_DISPLAY_NAME_LENGTH characters', normalizeDisplayName('x'.repeat(MAX_DISPLAY_NAME_LENGTH)) === 'x'.repeat(MAX_DISPLAY_NAME_LENGTH));
assert('rejects MAX_DISPLAY_NAME_LENGTH + 1 characters', normalizeDisplayName('x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1)) === null);

assert('preserves Spanish accents and letters', normalizeDisplayName('Nino Pena') !== null);
assert('preserves the literal characters of a human name with accents',
  normalizeDisplayName('Ñoño Péña') === 'Ñoño Péña');
assert('preserves non-Latin scripts', normalizeDisplayName('张三') === '张三');
assert('accepts a hyphenated / apostrophe name', normalizeDisplayName("Jean-Luc O'Brien") === "Jean-Luc O'Brien");

assert('two independent normalizations of the same input are identical (determinism)',
  normalizeDisplayName('  Ana  ') === normalizeDisplayName('  Ana  '));
assert('leading/trailing whitespace does not affect duplicate-name detection upstream (both normalize identically)',
  normalizeDisplayName('Ana') === normalizeDisplayName('  Ana  '));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
