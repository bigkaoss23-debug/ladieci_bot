'use strict';
// S2-7D regression — the /api/account/me read path must issue exactly ONE `select`
// parameter per request. sbSelect() prepends `select=*&`, which turned the explicit
// select into a SECOND parameter; PostgREST keeps only the first, silently dropping the
// embedded workspaces(...) resource and nulling every workspace field (making
// adminPinSetupRequired false even for a freshly claimed workspace).
// Verified live on staging: single-select embeds the workspace, duplicated select does not.
// Run: node tests/accountMeSelectQuery.test.js
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'account', 'accountHttpIntegration.js'), 'utf8');
// comment-stripped so the explanatory note cannot satisfy an assertion
const code = SRC.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

test('the /me read path does NOT use sbSelect (which forces select=*)', () => {
  assert.doesNotMatch(code, /sbSelect/, 'sbSelect prepends select=* and breaks the embed');
});

test('the /me read path uses sbRest, which sets the query verbatim', () => {
  assert.match(code, /require\('\.\.\/auth\/audit'\)/);
  assert.match(code, /sbRest\('GET', resource, \{ query \}\)/);
});

test('membership query embeds the workspace incl. the onboarding marker, with ONE select', () => {
  const m = code.match(/selectMemberships:[\s\S]*?\)\n/);
  assert.ok(m, 'selectMemberships present');
  const q = m[0];
  assert.equal((q.match(/select=/g) || []).length, 1, 'exactly one select parameter');
  assert.match(q, /workspaces\(slug,display_name,lifecycle_status,commercial_status,owner_pin_onboarding_completed_at\)/);
});

test('profile query also carries exactly one select', () => {
  const m = code.match(/selectProfile:.*\n/);
  assert.ok(m);
  assert.equal((m[0].match(/select=/g) || []).length, 1);
});

test('non-array / failed reads degrade to [] (fail closed, no crash)', () => {
  assert.match(code, /r\.ok && Array\.isArray\(r\.body\) \? r\.body : \[\]/);
});
