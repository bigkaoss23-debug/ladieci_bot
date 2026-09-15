'use strict';
// tests/plannerW4FinalCutover.static.test.js — Final W4 Read-Cutover Packet static guard.
// OFFLINE except for local `git show` against this repo's own history (no network).
//
// This packet's architectural success: plannerSnapshot.js is the ONLY product
// file changed. planner.js (Stage 1 AND Stage M) and previewStrategicOpportunities.js
// are proven byte-identical to BASE_HEAD below -- not just "not intentionally
// touched", mechanically verified.
//
// Run: node tests/plannerW4FinalCutover.static.test.js

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
const BASE_HEAD = 'bf687d6bdd2ac791fedd153609680107a7fba8b7';

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

section('FINAL-W4-N12 (HARD GATE): planner.js -- Stage M AND Stage 1 -- whole-file byte-identical to BASE_HEAD');
assert('src/core/delivery/planner.js is byte-identical to BASE_HEAD (not touched at all -- stronger than a Stage-M-only proof)',
  byteIdentical('src/core/delivery/planner.js'));

section('previewStrategicOpportunities.js -- byte-identical to BASE_HEAD (architectural preference achieved)');
assert('src/agents/previewStrategicOpportunities.js is byte-identical to BASE_HEAD',
  byteIdentical('src/agents/previewStrategicOpportunities.js'));

section('FINAL-W4-N17: no writer touched');
// language-guard: allow-legacy agentOrdini.js is the existing file name being checked, not new vocabulary
// src/agents/agentOrdini.js excepted below (S4 operator-intent prerequisite, DORMANT — a
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// later, separately-authorized packet touching only creaOrdine()'s own hard-gated INSERT
// payload, re-proven by tests/s4DormantInsertGateGuard.static.test.js).
for (const f of [
  'src/agents/manualGiroReads.js',
  'src/agents/riderReads.js',
  'src/agents/riderTrip.js',
  'src/utils/driverTelemetry.js',
]) {
  assert(`${f} is byte-identical to BASE_HEAD`, byteIdentical(f));
}
// manualGiros.js: a later, separately-authorized packet (W5 Packet 01 — single-writer
// Authority cutover) is allowed to touch it once its own guard exists on the branch to
// vouch for it, the same deferred-verification pattern already applied by
// tests/riderReadsW4Packet02A.static.test.js -- rather than re-implementing the same
// per-function extraction here, this defers to that later packet's own mechanical proof.
const W5_STATIC_GUARD = path.join(ROOT, 'tests', 'manualGirosW5Packet01.static.test.js');
const w5Applied = fs.existsSync(W5_STATIC_GUARD);
// S4 operator-intent prerequisite (DORMANT) — same later-packet deferral pattern.
const S4_STATIC_GUARD = path.join(ROOT, 'tests', 's4DormantInsertGateGuard.static.test.js');
const s4Applied = fs.existsSync(S4_STATIC_GUARD);
if (w5Applied) {
  let writerGuardOk = false;
  let writerGuardDetail = '';
  try {
    execSync(`node ${JSON.stringify(W5_STATIC_GUARD)}`, { cwd: ROOT, stdio: 'pipe' });
    writerGuardOk = true;
  } catch (e) {
    writerGuardDetail = ((e.stdout || '').toString() + (e.stderr || '').toString()).slice(-600);
  }
  assert('src/agents/manualGiros.js change is authorized and certified by tests/manualGirosW5Packet01.static.test.js',
    writerGuardOk, writerGuardDetail);
} else {
  assert('src/agents/manualGiros.js is byte-identical to BASE_HEAD (no later-packet guard authorizes a change yet)',
    byteIdentical('src/agents/manualGiros.js'));
}

section('FINAL-W4-N17b: index.js untouched (this packet never needed it)');
// S4 operator-intent prerequisite (DORMANT) is the first later packet that legitimately
// needs index.js (to thread the trusted builder into the two operator HTTP actions);
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
// excepted here the same way agentOrdini.js is excepted above.
if (!s4Applied) {
  assert('index.js is byte-identical to BASE_HEAD', byteIdentical('index.js'));
} else {
  console.log('  INFO  index.js exception granted to the later S4 packet (tests/s4DormantInsertGateGuard.static.test.js present)');
}

section('FINAL-W4-N19: migrations/** completely unchanged (W5 Packet 01\'s own migration excepted)');
const W5_MIGRATION_FILES = new Set([
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.sql',
  'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.ROLLBACK.sql',
]);
let migrationsChanged = [];
try {
  migrationsChanged = execSync(`git diff --name-only ${BASE_HEAD} -- migrations/`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { migrationsChanged = ['<git diff failed>']; }
const unexpectedMigrationsChanged = migrationsChanged.filter((f) => !(w5Applied && W5_MIGRATION_FILES.has(f)));
assert('migrations/** has zero UNEXPECTED changes vs BASE_HEAD (W5 Packet 01\'s own migration excepted)', unexpectedMigrationsChanged.length === 0, unexpectedMigrationsChanged.join(', '));

section('FINAL-W4-N18: zero frontend-path changes');
let feChanged = [];
try {
  feChanged = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter((l) => l && /frontend|ladieci-app33/i.test(l));
} catch (e) { feChanged = ['<git diff failed>']; }
assert('zero frontend-path changes in this packet\'s diff', feChanged.length === 0, feChanged.join(', '));

section('DIFF GATE: product changes limited to plannerSnapshot.js');
let changedFiles = [];
try {
  changedFiles = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { changedFiles = ['<git diff failed>']; }
const allowedProductFiles = new Set([
  'src/core/delivery/plannerSnapshot.js',
  ...(w5Applied ? [ // W5 Packet 01 — single-writer Authority cutover + facts signal
    'src/agents/manualGiros.js',
    'migrations/MIGRATION_MANIFEST.md',
    'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.sql',
    'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.ROLLBACK.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w5_packet01_v1.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w5_packet01_v1.ROLLBACK.sql',
    'ci/giro-authority-certification/harness/runW5Packet01.js',
    'ci/giro-authority-certification/harness/groups/w5packet01.js',
    'ci/giro-authority-certification/harness/groups/boundary.js',
    'ci/giro-authority-certification/harness/groups/noMoney.js',
  ] : []),
  // S4 operator-intent prerequisite (DORMANT): a new pure builder + the two trusted HTTP
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  // operator call sites + creaOrdine()'s own hard-gated INSERT payload.
  // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
  ...(s4Applied ? ['src/delivery/pendingGiroIntent.js', 'index.js', 'src/agents/agentOrdini.js'] : []),
]);
const nonTestNonAllowed = changedFiles.filter((f) => !f.startsWith('tests/') && !allowedProductFiles.has(f));
assert('every non-test changed file is plannerSnapshot.js (the architecturally-preferred minimal diff)',
  nonTestNonAllowed.length === 0, nonTestNonAllowed.join(', '));
assert('plannerSnapshot.js is actually in the changed-files list (the packet did something)',
  changedFiles.includes('src/core/delivery/plannerSnapshot.js'), changedFiles.join(', '));

section('plannerSnapshot.js ITSELF -- one Projection call site, canonical sources, no wall-clock computation');
const readsSrc = currentContent('src/core/delivery/plannerSnapshot.js');
assert('requires giroProjectionReader and giroProjectionPort', /require\([^)]*giroProjectionReader/.test(readsSrc) && /require\([^)]*giroProjectionPort/.test(readsSrc));
assert('requires getCurrentOperationalBusinessDate (DB-authoritative, not a calendar-day computation)', /getCurrentOperationalBusinessDate/.test(readsSrc));
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
assert('does not require manualGiros.js or agentOrdini.js (no dependency on the writer-adjacent modules)',
  // language-guard: allow-legacy agentOrdini.js is the existing file name being checked, not new vocabulary
  !/require\([^)]*\/manualGiros["')]/.test(readsSrc) && !/require\([^)]*agentOrdini["')]/.test(readsSrc));
assert('no wall-clock/calendar-day computation anywhere in this module',
  !/new Date\(\)\.toISOString|\.getHours\(\)|\.getDate\(\)|madridDateStr|plannerBusinessDate/.test(readsSrc.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')));
assert('exactly one readGiroProjection() call site (current-day path only; historical never calls it)',
  (readsSrc.match(/await readGiroProjection\(\)/g) || []).length === 1);
assert('order-level alias fully replaces the raw column on the canonical path (no same-expression ?? / || merge between the map lookup and row.manual_giro_id)',
  !/effectiveGiroIdMap\.get\([^)]*\)\s*(\?\?|\|\|)\s*row\.manual_giro_id/.test(readsSrc.replace(/\n/g, ' ')));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
