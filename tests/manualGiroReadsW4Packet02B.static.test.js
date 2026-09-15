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
// W5 Packet 01 is a LATER, separately-authorized packet on this same branch that
// legitimately rewrites the four real writers (single-writer Authority cutover) and
// retires 3 writer-support helpers with no external caller (nextSeqForDay,
// validateManualGiroOrders, verifyOrdersAttachedToGiro). Its own static guard
// (tests/manualGirosW5Packet01.static.test.js) certifies the new writer state in
// depth -- mirrors the identical "later packet extends the allowed diff" resolution
// already applied to the product-files list below and to
// riderReadsW4Packet02A.static.test.js. Detected the same way: presence of that
// later packet's own guard on the branch.
const W5_STATIC_GUARD = path.join(ROOT, 'tests', 'manualGirosW5Packet01.static.test.js');
const w5Applied = fs.existsSync(W5_STATIC_GUARD);
// S4 operator-intent prerequisite (DORMANT) — same later-packet pattern.
const S4_STATIC_GUARD = path.join(ROOT, 'tests', 's4DormantInsertGateGuard.static.test.js');
const s4Applied = fs.existsSync(S4_STATIC_GUARD);
// W5 Intent Activation (132) — same later-packet pattern: migration 132 (capture
// trigger + consume signal-bump fix + bounded read helper + close-session sweep)
// language-guard: allow-legacy agentOrdini is the existing identifier being cited, not new vocabulary
// plus its own JS activation (agentOrdini.js hooks, the new reconciler module,
// index.js wiring). Detected the same way: presence of its own guard on the branch.
const W5IA_STATIC_GUARD = path.join(ROOT, 'tests', 'w5IntentActivationReconciler.test.js');
const w5iaApplied = fs.existsSync(W5IA_STATIC_GUARD);
const RETIRED_BY_W5 = new Set(['nextSeqForDay', 'validateManualGiroOrders', 'verifyOrdersAttachedToGiro']);
const REWRITTEN_BY_W5 = new Set(['createManualGiro', 'addOrderToManualGiro', 'removeOrderFromManualGiro', 'dissolveManualGiro']);
const WRITER_AND_WRITER_SUPPORT_FUNCTIONS = [
  // pure helpers feeding the writers
  'generateManualGiroId', 'isValidHoraRef', 'normalizeHoraRef', 'isOrderEligibleForGiro',
  'isStatusLeavingGiro', 'encodeIdList', 'encodeEqValue',
  // read-only but writer-support only (never a UI-facing reader)
  'nextSeqForDay', 'validateManualGiroOrders', 'verifyOrdersAttachedToGiro', 'countActiveMembers',
  // real writers
  'autoDissolveIfBelowThreshold', 'createManualGiro', 'addOrderToManualGiro',
  'removeOrderFromManualGiro', 'dissolveManualGiro', 'softDissolveActiveManualGirosForClose',
].filter((fn) => !(w5Applied && RETIRED_BY_W5.has(fn)));
const baseManualGiros = baseContent('src/agents/manualGiros.js');
const curManualGiros = currentContent('src/agents/manualGiros.js');
assert('BASE_HEAD copy of manualGiros.js readable', baseManualGiros !== null);
assert('current copy of manualGiros.js readable', curManualGiros !== null);

if (w5Applied) {
  for (const fn of RETIRED_BY_W5) {
    assert(`${fn}(): retired by W5 Packet 01 (no external caller), confirmed absent from current manualGiros.js`,
      curManualGiros !== null && extractFunction(curManualGiros, fn) === null);
  }
}

let allIdentical = true;
for (const fn of WRITER_AND_WRITER_SUPPORT_FUNCTIONS) {
  const baseFn = baseManualGiros ? extractFunction(baseManualGiros, fn) : null;
  const curFn = curManualGiros ? extractFunction(curManualGiros, fn) : null;
  if (w5Applied && REWRITTEN_BY_W5.has(fn)) {
    // Rewritten by W5's authorized single-writer cutover -- certified in depth by
    // W5's own guard, not by byte-identity here. Just confirm it still exists.
    const ok = curFn !== null;
    if (!ok) allIdentical = false;
    assert(`${fn}(): body present (rewritten by W5 Packet 01, certified by tests/manualGirosW5Packet01.static.test.js)`, ok);
    continue;
  }
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

section('WRITER EXPORT SURFACE — module.exports key list unchanged (minus W5-retired helpers)');
{
  const baseExports = (baseManualGiros.match(/module\.exports = \{[\s\S]*?\};/) || [''])[0];
  const curExports = (curManualGiros.match(/module\.exports = \{[\s\S]*?\};/) || [''])[0];
  const keysOf = (s) => (s.match(/^\s*(\w+),?\s*$/gm) || []).map((l) => l.trim().replace(/,$/, '')).filter(Boolean).sort();
  const expectedBaseKeys = keysOf(baseExports).filter((k) => !(w5Applied && RETIRED_BY_W5.has(k)));
  assert('module.exports key list unchanged (W5-retired helpers excepted)', JSON.stringify(expectedBaseKeys) === JSON.stringify(keysOf(curExports)),
    JSON.stringify({ base: expectedBaseKeys, cur: keysOf(curExports) }));
}

section('OTHER FORBIDDEN FILES — byte-identical to BASE_HEAD');
// language-guard: allow-legacy agentOrdini.js/index.js are the existing file names being checked, not new vocabulary
// src/agents/agentOrdini.js and index.js excepted as of the S4 operator-intent prerequisite
// (DORMANT) packet -- a later, separately-authorized extension (same pattern already used
// by tests/manualGirosW5Packet01.static.test.js for this same exception). Re-proven by
// tests/s4DormantInsertGateGuard.static.test.js and tests/s4PendingGiroIntentBuilder.test.js.
for (const f of [
  'src/agents/riderReads.js',
  'src/agents/riderTrip.js',
  'src/menu/menuSnapshot.js',
]) {
  assert(`${f} is byte-identical to BASE_HEAD`, byteIdentical(f));
}

section('MIGRATIONS + FRONTEND — completely unchanged (W5 Packet 01\'s own migration excepted)');
let migrationsChanged = [];
try {
  migrationsChanged = execSync(`git diff --name-only ${BASE_HEAD} -- migrations/`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { migrationsChanged = ['<git diff failed>']; }
// W5 Packet 01 is a later, separately-authorized packet that adds its own numbered
// migration (131) + rollback + the manifest row/reservation documenting it -- same
// "later packet extends the allowed diff" resolution as everywhere else in this file.
const W5_MIGRATION_FILES = new Set([
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.sql',
  'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.ROLLBACK.sql',
]);
// W5 Intent Activation (132) — same exception, one packet later.
const W5IA_MIGRATION_FILES = new Set([
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_w5_intent_activation_v1_migration_132.sql',
  'migrations/2026-09-15_w5_intent_activation_v1_migration_132.ROLLBACK.sql',
]);
const unexpectedMigrationsChanged = migrationsChanged.filter((f) =>
  !(w5Applied && W5_MIGRATION_FILES.has(f)) && !(w5iaApplied && W5IA_MIGRATION_FILES.has(f)));
assert('migrations/** has zero UNEXPECTED changes vs BASE_HEAD (W5 Packet 01\'s own migration excepted)', unexpectedMigrationsChanged.length === 0, unexpectedMigrationsChanged.join(', '));

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
const LATER_PACKET_CERTIFIED_PRODUCT_FILES = new Set([
  ...(fs.existsSync(FINAL_W4_STATIC_GUARD) ? ['src/core/delivery/plannerSnapshot.js'] : []), // Final W4 Read-Cutover Packet
  // W5 Packet 01 — single-writer Authority cutover + facts signal: its own migration,
  // certification harness additions, and manifest row (certified by its own guard).
  ...(w5Applied ? [
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
  // operator call sites + creaOrdine()'s own hard-gated INSERT payload (certified by
  // tests/s4DormantInsertGateGuard.static.test.js and tests/s4PendingGiroIntentBuilder.test.js).
  // S4's own second commit adds src/agents/previewStrategicOpportunities.js (isGiro
  // transport-only, certified by tests/s4PlannerIsGiroTransport.test.js).
  // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
  ...(s4Applied ? ['src/delivery/pendingGiroIntent.js', 'index.js', 'src/agents/agentOrdini.js', 'src/agents/previewStrategicOpportunities.js'] : []),
  // W5 Intent Activation (132): migration 132 + rollback + its own certification
  // candidate/harness/group additions, the shared harness files it needed to make
  // language-guard: allow-legacy agentOrdini is the existing identifier being cited, not new vocabulary
  // forward-compatible, its new reconciler module, and the agentOrdini.js/index.js
  // activation wiring (certified by ci/giro-authority-certification/harness/
  // runW5IntentActivation.js and tests/w5IntentActivationReconciler.test.js).
  ...(w5iaApplied ? [
    'migrations/2026-09-15_w5_intent_activation_v1_migration_132.sql',
    'migrations/2026-09-15_w5_intent_activation_v1_migration_132.ROLLBACK.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w5_intent_activation_v1.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w5_intent_activation_v1.ROLLBACK.sql',
    'ci/giro-authority-certification/harness/runW5IntentActivation.js',
    'ci/giro-authority-certification/harness/groups/w5IntentActivation.js',
    'ci/giro-authority-certification/harness/groups/_ctx.js',
    'ci/giro-authority-certification/harness/groups/capture.js',
    'ci/giro-authority-certification/harness/groups/concurrency.js',
    'ci/giro-authority-certification/harness/groups/consume.js',
    'src/delivery/giroIntentReconciler.js',
    'index.js',
    // language-guard: allow-legacy agentOrdini is the existing identifier being cited, not new vocabulary
    'src/agents/agentOrdini.js',
    // H1B registry fix-forward: registers the 6 approved giro_authority_* RPCs (the 4
    // W5 Packet 01 manualGiros.js writer RPCs missed by that packet's own diff, plus the
    // 2 W5 Intent Activation RPCs) so the gated sbRpc transport actually allows them.
    'src/utils/supabaseResourcePolicy.js',
  ] : []),
]);
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
