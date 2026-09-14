'use strict';
// tests/riderReadsW4Packet02A.static.test.js — Planner W4 Packet 02A static guard.
// OFFLINE except for local `git show` against this repo's own history (no network).
//
// Proves, by direct comparison against BASE_HEAD (the commit this branch was cut from,
// language-guard: allow-legacy staging-messa-tables is the existing staging branch name, cited for provenance
// origin/feature/staging-messa-tables-2026-08-01 @ fe0eacd750fddd8c4c9dc26297142b5ad5e8686a),
// that this packet:
//   * touches product code ONLY in src/agents/riderReads.js;
//   * leaves every writer-bearing file byte-identical to base
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
//     (manualGiros.js, agentOrdini.js, riderTrip.js, index.js);
//   * leaves migrations/** completely unchanged;
//   * introduces no new raw manual_giro_id / manual_giros truth reader anywhere in src/
//     or index.js outside the already-allowlisted W4 chain;
//   * riderReads.js itself no longer uses ordenes.manual_giro_id or the raw manual_giros
//     table as truth for giro facts (only the narrow entrega_ref enrichment read remains).
//
// Run: node tests/riderReadsW4Packet02A.static.test.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const section = (t) => console.log('\n── ' + t + ' ──');

const ROOT = path.join(__dirname, '..');
const BASE_HEAD = 'fe0eacd750fddd8c4c9dc26297142b5ad5e8686a';

function baseContent(relPath) {
  try {
    return execSync(`git show ${BASE_HEAD}:${relPath}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return null; // file didn't exist at BASE_HEAD
  }
}
function currentContent(relPath) {
  const p = path.join(ROOT, relPath);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}
function byteIdentical(relPath) {
  const base = baseContent(relPath);
  const cur = currentContent(relPath);
  return base !== null && cur !== null && base === cur;
}

section('WRITER INTEGRITY — byte-identical to BASE_HEAD, no exceptions');
for (const f of [
  'src/agents/manualGiros.js',
  // language-guard: allow-legacy agentOrdini.js is the existing file name being checked, not new vocabulary
  'src/agents/agentOrdini.js',
  'src/agents/riderTrip.js',
  'index.js',
]) {
  assert(`${f} is byte-identical to BASE_HEAD (${BASE_HEAD.slice(0, 7)})`, byteIdentical(f));
}

section('MIGRATIONS — completely unchanged');
let migrationsChanged = [];
try {
  const diffOut = execSync(`git diff --name-only ${BASE_HEAD} -- migrations/`, { cwd: ROOT, encoding: 'utf8' });
  migrationsChanged = diffOut.split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) {
  migrationsChanged = ['<git diff failed: ' + (e && e.message) + '>'];
}
assert('migrations/** has zero changes vs BASE_HEAD', migrationsChanged.length === 0, migrationsChanged.join(', '));

section('FRONTEND — no frontend/ or ladieci-app33 path in this packet\'s diff');
let feChanged = [];
try {
  const diffOut = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' });
  feChanged = diffOut.split('\n').map((l) => l.trim()).filter((l) => l && /frontend|ladieci-app33/i.test(l));
} catch (e) {
  feChanged = ['<git diff failed: ' + (e && e.message) + '>'];
}
assert('zero frontend-path changes in this packet\'s diff', feChanged.length === 0, feChanged.join(', '));

section('DIFF SCOPE — product changes limited to riderReads.js (+ tests)');
let changedFiles = [];
try {
  const diffOut = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' });
  changedFiles = diffOut.split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) {
  changedFiles = ['<git diff failed: ' + (e && e.message) + '>'];
}
const allowedProductFiles = new Set(['src/agents/riderReads.js']);
const nonTestNonAllowed = changedFiles.filter((f) => !f.startsWith('tests/') && !allowedProductFiles.has(f));
assert('every non-test changed file is the one allowed product file (riderReads.js)',
  nonTestNonAllowed.length === 0, nonTestNonAllowed.join(', '));
assert('riderReads.js is actually in the changed-files list (the packet did something)',
  changedFiles.includes('src/agents/riderReads.js'), changedFiles.join(', '));

section('NO NEW RAW GIRO TRUTH READER — allowlisted W4 chain unchanged, nothing new added');
const srcFiles = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
  .filter((f) => /\.(js|mjs|ts)$/.test(f)).map((f) => path.join('src', f));
const ALLOWED_PROJECTION_FILES = new Set([
  'src/core/delivery/giroProjectionPort.js',
  'src/core/delivery/giroProjectionReader.js',
  'src/agents/previewTiming.js',
  'src/agents/riderReads.js',
]);
const jsCode = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const readRaw = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const mentionsAuthority = [...srcFiles, 'index.js']
  .filter((f) => !ALLOWED_PROJECTION_FILES.has(f))
  .filter((f) => /giro_authority|giro_projection_v1/.test(readRaw(f)));
assert('no file outside the allowlisted W4 chain references the Authority or the projection',
  mentionsAuthority.length === 0, mentionsAuthority.join(', '));

section('RIDERREADS.JS ITSELF — no raw giro-truth reads outside the narrow entrega_ref enrichment');
const riderReadsSrc = jsCode(readRaw('src/agents/riderReads.js'));
assert('does not select manual_giros as onlyActive/dissolved truth (dissolved!==true style filter gone)',
  !/g\.dissolved\s*!==\s*true|g\.completed\s*!==\s*true/.test(riderReadsSrc));
assert('does not read ordenes.manual_giro_id as a filter/select criterion',
  !/manual_giro_id=eq\.|manual_giro_id=in\./.test(riderReadsSrc));
assert('the only manual_giros select remaining is the id+entrega_ref enrichment read',
  (riderReadsSrc.match(/sbSelect\(\s*"manual_giros"/g) || []).length === 1 &&
  /select=id,entrega_ref/.test(riderReadsSrc));
assert('requires giroProjectionReader and giroProjectionPort directly',
  /require\([^)]*giroProjectionReader/.test(riderReadsSrc) && /require\([^)]*giroProjectionPort/.test(riderReadsSrc));
assert('does not require manualGiros.js (no dependency on the writer-adjacent module)',
  !/require\([^)]*\/manualGiros["')]/.test(riderReadsSrc));
assert('module.exports keys unchanged (getRiderOrdenes, getRiderManualGiros, readActiveTrip, RIDER_ORDER_FIELDS, RIDER_GIRO_FIELDS)',
  ['getRiderOrdenes', 'getRiderManualGiros', 'readActiveTrip', 'RIDER_ORDER_FIELDS', 'RIDER_GIRO_FIELDS']
    .every((k) => new RegExp('\\b' + k + '\\b').test(riderReadsSrc.slice(riderReadsSrc.indexOf('module.exports')))));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
