'use strict';
// tests/manualGiroReadsW4Packet02B.static.test.js — Planner W4 Packet 02B static guard.
// OFFLINE except for local `git show` against this repo's own history (no network).
//
// manualGiros.js is a MIXED reader+writer file (unlike riderReads.js in Packet 02A,
// which had zero writers) -- so "byte-identical file" is the wrong bar: getManualGiros
// and one new require line are SUPPOSED to change. What this file proves instead is a
// mechanical, per-function extraction and comparison of every WRITER (and
// writer-support) function body against BASE_HEAD, so "I didn't touch the writers" is
// demonstrated, not just claimed.
//
// Run: node tests/manualGiroReadsW4Packet02B.static.test.js

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
const BASE_HEAD = '58b8993675317739024b7809a5dc047eab03afa9';

function baseContent(relPath) {
  try {
    return execSync(`git show ${BASE_HEAD}:${relPath}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return null;
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

// Extracts a top-level `(async )?function <name>(...) { ... }` body via brace
// counting from its own source text (robust to nested braces/strings-with-braces
// inside the body, unlike a non-greedy regex).
function extractFunction(src, name) {
  const re = new RegExp('(?:^|\\n)((?:async )?function ' + name + '\\s*\\([\\s\\S]*?\\)\\s*\\{)');
  const m = re.exec(src);
  if (!m) return null;
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  let i = src.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

section('WRITER FUNCTION BODIES — mechanical per-function comparison against BASE_HEAD');
const WRITER_AND_WRITER_SUPPORT_FUNCTIONS = [
  // pure helpers feeding the writers
  'generateManualGiroId', 'isValidHoraRef', 'normalizeHoraRef', 'isOrderEligibleForGiro',
  'isStatusLeavingGiro', 'encodeIdList', 'encodeEqValue',
  // read-only but writer-support only (never a UI-facing reader)
  'nextSeqForDay', 'validateManualGiroOrders', 'verifyOrdersAttachedToGiro', 'countActiveMembers',
  // real writers
  'autoDissolveIfBelowThreshold', 'createManualGiro', 'addOrderToManualGiro',
  'removeOrderFromManualGiro', 'dissolveManualGiro', 'softDissolveActiveManualGirosForClose',
];
const baseManualGiros = baseContent('src/agents/manualGiros.js');
const curManualGiros = currentContent('src/agents/manualGiros.js');
assert('BASE_HEAD copy of manualGiros.js readable', baseManualGiros !== null);
assert('current copy of manualGiros.js readable', curManualGiros !== null);

let allIdentical = true;
for (const fn of WRITER_AND_WRITER_SUPPORT_FUNCTIONS) {
  const baseFn = baseManualGiros ? extractFunction(baseManualGiros, fn) : null;
  const curFn = curManualGiros ? extractFunction(curManualGiros, fn) : null;
  const ok = baseFn !== null && curFn !== null && baseFn === curFn;
  if (!ok) allIdentical = false;
  assert(`${fn}(): body byte-identical to BASE_HEAD`, ok, ok ? '' : `base=${baseFn === null ? 'NOT FOUND' : baseFn.length + ' chars'} cur=${curFn === null ? 'NOT FOUND' : curFn.length + ' chars'}`);
}
assert('WRITER_FUNCTION_BODIES_IDENTICAL = YES (every function above matched)', allIdentical);

section('getManualGiros — the ONE function allowed to change, confirm it actually did');
{
  const baseFn = extractFunction(baseManualGiros, 'getManualGiros');
  const curFn = extractFunction(curManualGiros, 'getManualGiros');
  assert('getManualGiros() body found in both BASE_HEAD and current', baseFn !== null && curFn !== null);
  assert('getManualGiros() body actually changed (the packet did something)', baseFn !== curFn);
  assert('getManualGiros() is now a thin delegate (calls getManualGirosRead)', /getManualGirosRead/.test(curFn));
  assert('getManualGiros() body no longer contains the raw manual_giros/ordenes select logic itself', !/manual_giro_id=in\.\(/.test(curFn));
}

section('WRITER EXPORT SURFACE — module.exports key list unchanged');
{
  const baseExports = (baseManualGiros.match(/module\.exports = \{[\s\S]*?\};/) || [''])[0];
  const curExports = (curManualGiros.match(/module\.exports = \{[\s\S]*?\};/) || [''])[0];
  const keysOf = (s) => (s.match(/^\s*(\w+),?\s*$/gm) || []).map((l) => l.trim().replace(/,$/, '')).filter(Boolean).sort();
  assert('module.exports key list unchanged', JSON.stringify(keysOf(baseExports)) === JSON.stringify(keysOf(curExports)),
    JSON.stringify({ base: keysOf(baseExports), cur: keysOf(curExports) }));
}

section('OTHER FORBIDDEN FILES — byte-identical to BASE_HEAD');
for (const f of [
  // language-guard: allow-legacy agentOrdini.js is the existing file name being checked, not new vocabulary
  'src/agents/agentOrdini.js',
  'src/agents/riderReads.js',
  'src/agents/riderTrip.js',
  'index.js',
  'src/menu/menuSnapshot.js',
]) {
  assert(`${f} is byte-identical to BASE_HEAD`, byteIdentical(f));
}

section('MIGRATIONS + FRONTEND — completely unchanged');
let migrationsChanged = [];
try {
  migrationsChanged = execSync(`git diff --name-only ${BASE_HEAD} -- migrations/`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { migrationsChanged = ['<git diff failed>']; }
assert('migrations/** has zero changes vs BASE_HEAD', migrationsChanged.length === 0, migrationsChanged.join(', '));

let feChanged = [];
try {
  feChanged = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter((l) => l && /frontend|ladieci-app33/i.test(l));
} catch (e) { feChanged = ['<git diff failed>']; }
assert('zero frontend-path changes in this packet\'s diff', feChanged.length === 0, feChanged.join(', '));

section('DIFF SCOPE — product changes limited to manualGiros.js + manualGiroReads.js (+ later packets\' own certified files)');
let changedFiles = [];
try {
  changedFiles = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { changedFiles = ['<git diff failed>']; }
// manualGiros.js + manualGiroReads.js are this packet's own product files. A
// later, separately-authorized W4 packet on this same branch is allowed to
// extend the cumulative diff with its OWN certified product files -- named
// here only once that packet's own static guard exists on the branch to vouch
// for them (mirrors the identical, already-reviewed pattern applied to
// riderReadsW4Packet02A.static.test.js), so this still fails on any file that
// is neither this packet's own nor a later packet's already-certified one.
const FINAL_W4_STATIC_GUARD = path.join(ROOT, 'tests', 'plannerW4FinalCutover.static.test.js');
const PACKET_02B_OWN_PRODUCT_FILES = new Set(['src/agents/manualGiros.js', 'src/agents/manualGiroReads.js']);
const LATER_PACKET_CERTIFIED_PRODUCT_FILES = fs.existsSync(FINAL_W4_STATIC_GUARD)
  ? new Set(['src/core/delivery/plannerSnapshot.js']) // Final W4 Read-Cutover Packet
  : new Set();
const allowedProductFiles = new Set([...PACKET_02B_OWN_PRODUCT_FILES, ...LATER_PACKET_CERTIFIED_PRODUCT_FILES]);
const nonTestNonAllowed = changedFiles.filter((f) => !f.startsWith('tests/') && !allowedProductFiles.has(f));
assert('every non-test changed file is either this packet\'s own product file or a later packet\'s own already-certified product file', nonTestNonAllowed.length === 0, nonTestNonAllowed.join(', '));

// NOTE: this file used to keep its own repo-wide sweep here for "no file
// outside a hardcoded roster references the Authority/projection". That is a
// SYSTEM-WIDE invariant, not a Packet-02B-local one, and duplicating it in a
// packet-scoped snapshot goes stale the moment any later packet legitimately
// adds a new certified consumer (exactly what happened with the Final W4
// Read-Cutover Packet's plannerSnapshot.js). The canonical, always-current
// version of this sweep lives in tests/giroAuthorityW3Candidate.static.test.js's
// own ALLOWED_PROJECTION_CONSUMERS roster -- removed here rather than
// re-duplicated (same resolution already applied to
// riderReadsW4Packet02A.static.test.js).
const readRaw = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

section('manualGiroReads.js ITSELF — no dependency on manualGiros.js, one Projection call site per read function');
const readsSrc = readRaw('src/agents/manualGiroReads.js');
assert('does not require manualGiros.js (no dependency on the writer-adjacent module)',
  !/require\([^)]*\/manualGiros["')]/.test(readsSrc));
assert('requires giroProjectionReader and giroProjectionPort', /require\([^)]*giroProjectionReader/.test(readsSrc) && /require\([^)]*giroProjectionPort/.test(readsSrc));
assert('requires getCurrentOperationalBusinessDate (DB-authoritative, not a calendar-day computation)', /getCurrentOperationalBusinessDate/.test(readsSrc));
assert('no wall-clock/calendar-day computation (new Date().toISOString/getDate/getHours) anywhere in this module',
  !/new Date\(\)\.toISOString|\.getHours\(\)|\.getDate\(\)|madridDateStr/.test(readsSrc.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')));
assert('exactly one readGiroProjection() call site (current-day path only; historical never calls it)',
  (readsSrc.match(/await readGiroProjection\(\)/g) || []).length === 1);

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
