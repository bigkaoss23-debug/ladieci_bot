'use strict';
// B4 §19 — doc↔module consistency. Run: node tests/authorizationContractDocConsistency.test.js
// Parses the CONTRACT-SNAPSHOT block in docs/access-control/B4_AUTHORIZATION_CONTRACT.md
// and asserts it matches the executable source of truth src/auth/authorizationContract.js,
// so the two cannot silently diverge.
const fs = require('fs');
const path = require('path');
const A = require('../src/auth/authorizationContract');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const setEq = (a, b) => { const A2 = new Set(a), B2 = new Set(b); return A2.size === B2.size && [...A2].every((x) => B2.has(x)); };

const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'access-control', 'B4_AUTHORIZATION_CONTRACT.md'), 'utf8');
const snap = (md.split('## CONTRACT-SNAPSHOT')[1] || '').match(/```([\s\S]*?)```/);
assert('doc has a CONTRACT-SNAPSHOT fenced block', !!snap);
const lines = (snap ? snap[1] : '').split('\n').map((l) => l.trim()).filter(Boolean);
const kv = {};
const predicates = {};
for (const line of lines) {
  const pm = line.match(/^PREDICATE\s+(\w+):\s*(\S+)$/);
  if (pm) { predicates[pm[1]] = pm[2]; continue; }
  const i = line.indexOf(':');
  if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
const csv = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

assert('PRINCIPALS match', setEq(csv(kv.PRINCIPALS), A.PRINCIPALS));
assert('CANONICAL_COUNT match', Number(kv.CANONICAL_COUNT) === A.CANONICAL_ACTIONS.length);
assert('SERVICE_ONLY match', setEq(csv(kv.SERVICE_ONLY), A.SERVICE_ONLY_ACTIONS));
assert('ADMIN_ONLY match', setEq(csv(kv.ADMIN_ONLY), A.ADMIN_ONLY_ACTIONS));
assert('RIDER_ENABLED match', setEq(csv(kv.RIDER_ENABLED), A.RIDER_ENABLED_ACTIONS));
assert('FRESH_AUTH match', setEq(csv(kv.FRESH_AUTH), A.FRESH_AUTH_ACTIONS));
assert('ALIAS_MAP documented EMPTY and module empty', kv.ALIAS_MAP === 'EMPTY' && Object.keys(A.ALIAS_MAP).length === 0);
assert('PREDICATE ids match module (keys)', setEq(Object.keys(predicates), Object.keys(A.RIDER_PREDICATES)));
assert('PREDICATE ids match module (values)', Object.entries(predicates).every(([k, v]) => A.RIDER_PREDICATES[k] === v));

// Totals in the doc must match the resolved matrix.
const totals = { admin: 0, operator: 0, rider: 0, service: 0 };
for (const action of A.CANONICAL_ACTIONS) for (const p of A.PRINCIPALS) if (A.isAllowed(p, action)) totals[p]++;
assert('TOTAL admin match', Number(kv['TOTAL admin']) === totals.admin);
assert('TOTAL operator match', Number(kv['TOTAL operator']) === totals.operator);
assert('TOTAL rider match', Number(kv['TOTAL rider']) === totals.rider);
assert('TOTAL service match', Number(kv['TOTAL service']) === totals.service);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
