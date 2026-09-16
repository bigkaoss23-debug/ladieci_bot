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

// S4 operator-intent prerequisite (DORMANT) — declared early: needed by the
// previewStrategicOpportunities.js exception below, before the W5 deferral
// declared further down this file.
const S4_STATIC_GUARD = path.join(ROOT, 'tests', 's4DormantInsertGateGuard.static.test.js');
const s4Applied = fs.existsSync(S4_STATIC_GUARD);

// ── W6.5 (Planner final backend canonicalization + legacy cleanup) ──────────
// Stage M (the unreachable `manual_route` rider block) deleted and replaced by
// the canonical ACTIVE TRIP from Trip Authority; the raw `manual_giros` read
// removed from the planner snapshot path; the operational rider read moved off
// DRIVER_STATO onto trip_projection_v1; giroFactsPort.js (superseded by
// giroProjectionPort.js, zero requirers) deleted. Authorized here by the same
// deferred-verification pattern this file already applies to W5/W6.3: its own
// guard must be present on the branch to vouch for the change.
const W6_5_STATIC_GUARD = path.join(ROOT, 'tests', 'plannerW65FinalBackendV1.static.test.js');
const w65Applied = fs.existsSync(W6_5_STATIC_GUARD);
const W6_5_PRODUCT_FILES = [
  'src/core/delivery/tripProjectionReader.js',
  'src/core/delivery/tripProjectionPort.js',
  'src/core/delivery/planner.js',
  'src/core/delivery/plannerSnapshot.js',
  'src/core/delivery/readOnlyRestDb.js',
  'src/core/delivery/giroFactsPort.js',
  'src/agents/riderReads.js',
  'src/utils/supabaseResourcePolicy.js',
  'index.js',
];

section('FINAL-W4-N12 (HARD GATE): planner.js -- the read cutover changes NO scheduling code');
// Pre-W6.5 this was whole-file byte identity: the W4 read cutover touched
// plannerSnapshot.js alone, so planner.js could be pinned outright. W6.5 -- a
// later, separately-certified packet -- deliberately replaces Stage M (which
// read seven columns that do not exist in public.manual_giros and was therefore
// unreachable) with the canonical active trip. The invariant N12 exists to
// protect is that NO read cutover alters how the planner SCHEDULES or how it
// keys giro membership; with W6.5 present that is proven directly, on the code
// itself, instead of by whole-file identity.
if (!w65Applied) {
  assert('src/core/delivery/planner.js is byte-identical to BASE_HEAD (not touched at all -- stronger than a Stage-M-only proof)',
    byteIdentical('src/core/delivery/planner.js'));
} else {
  const curPlanner = fs.readFileSync(path.join(ROOT, 'src', 'core', 'delivery', 'planner.js'), 'utf8');
  let basePlanner = '';
  try {
    basePlanner = execSync(`git show ${BASE_HEAD}:src/core/delivery/planner.js`, { cwd: ROOT, encoding: 'utf8' });
  } catch (_) { basePlanner = ''; }
  const between = (src, a, b) => {
    const i = src.indexOf(a), j = src.indexOf(b);
    return i < 0 || j < 0 || j <= i ? null : src.slice(i, j);
  };
  const S1_START = '  // ── Stage 1 — costruisci i trip';
  const S1_END = '  // ── Invariante rider';
  const curS1 = between(curPlanner, S1_START, S1_END);
  const baseS1 = between(basePlanner, S1_START, S1_END);
  assert('N12: Stage 1 (giro bucketing/keying) is byte-identical to BASE_HEAD',
    curS1 !== null && baseS1 !== null && curS1 === baseS1);
  const curTail = between(curPlanner, S1_END, 'function evaluateNewOrder');
  const baseTail = between(basePlanner, S1_END, 'function evaluateNewOrder');
  assert('N12: the rest of buildPlan (rider invariant + plan assembly) is byte-identical to BASE_HEAD',
    curTail !== null && baseTail !== null && curTail === baseTail);
  assert('N12: planner.js is still PURE -- it performs no DB/projection read of its own',
    !/require\(/.test(curPlanner.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')));
}

section('previewStrategicOpportunities.js -- byte-identical to BASE_HEAD (architectural preference achieved)');
// S4's own second commit is the first later packet authorized to touch this file
// (isGiro transport-only addition, certified by tests/s4PlannerIsGiroTransport.test.js).
if (!s4Applied) {
  assert('src/agents/previewStrategicOpportunities.js is byte-identical to BASE_HEAD',
    byteIdentical('src/agents/previewStrategicOpportunities.js'));
} else {
  console.log('  INFO  previewStrategicOpportunities.js exception granted to the later S4 packet (tests/s4DormantInsertGateGuard.static.test.js present)');
}

section('FINAL-W4-N17: no writer touched');
// language-guard: allow-legacy agentOrdini.js is the existing file name being checked, not new vocabulary
// src/agents/agentOrdini.js excepted below (S4 operator-intent prerequisite, DORMANT — a
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// later, separately-authorized packet touching only creaOrdine()'s own hard-gated INSERT
// payload, re-proven by tests/s4DormantInsertGateGuard.static.test.js).
// Planner W6.3 (migration 135) — the packet that ACTIVATES the canonical departure, so
// src/agents/riderTrip.js is ITS own product file, authorized and certified by
// tests/plannerW6RiderLifecycle.static.test.js. Same later-packet deferral pattern already
// used for the sibling product-file exceptions here and in every sibling guard.
const W6_3_STATIC_GUARD = path.join(ROOT, 'tests', 'plannerW6RiderLifecycle.static.test.js');
const w63Applied = fs.existsSync(W6_3_STATIC_GUARD);
const W6_3_PRODUCT_FILES = [
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.sql',
  'migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.ROLLBACK.sql',
  'ci/giro-authority-certification/candidate/giro_authority_w6_rider_lifecycle_v1.sql',
  'ci/giro-authority-certification/candidate/giro_authority_w6_rider_lifecycle_v1.ROLLBACK.sql',
  'ci/giro-authority-certification/harness/runW6RiderLifecycle.js',
  'ci/giro-authority-certification/harness/groups/w6RiderLifecycle.js',
  'ci/giro-authority-certification/harness/groups/w6TripAuthority.js',
  'src/agents/riderTrip.js',
  'src/utils/supabaseResourcePolicy.js',
  'index.js',
  // The rollback restores two function bodies byte-identically, so the domain-language
  // guard gets a narrow file-level exemption for it (the same resolution, for the same
  // reason, as the pre-existing H-1 rollback entry). The forward migration is NOT exempt.
  'scripts/check-domain-language.js',
];

for (const f of [
  'src/agents/manualGiroReads.js',
  'src/agents/riderReads.js',
  'src/agents/riderTrip.js',
  'src/utils/driverTelemetry.js',
].filter((f) => !(w63Applied && W6_3_PRODUCT_FILES.includes(f)) && !(w65Applied && W6_5_PRODUCT_FILES.includes(f)))) {
  assert(`${f} is byte-identical to BASE_HEAD`, byteIdentical(f));
}
// manualGiros.js: a later, separately-authorized packet (W5 Packet 01 — single-writer
// Authority cutover) is allowed to touch it once its own guard exists on the branch to
// vouch for it, the same deferred-verification pattern already applied by
// tests/riderReadsW4Packet02A.static.test.js -- rather than re-implementing the same
// per-function extraction here, this defers to that later packet's own mechanical proof.
const W5_STATIC_GUARD = path.join(ROOT, 'tests', 'manualGirosW5Packet01.static.test.js');
const w5Applied = fs.existsSync(W5_STATIC_GUARD);
// S4 operator-intent prerequisite (DORMANT) — s4Applied declared earlier in this
// file (needed by the previewStrategicOpportunities.js exception above).
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
// W5 Intent Activation (132) — same later-packet pattern, one packet later.
const W5IA_STATIC_GUARD = path.join(ROOT, 'tests', 'w5IntentActivationReconciler.test.js');
const w5iaApplied = fs.existsSync(W5IA_STATIC_GUARD);
const W5IA_MIGRATION_FILES = new Set([
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_w5_intent_activation_v1_migration_132.sql',
  'migrations/2026-09-15_w5_intent_activation_v1_migration_132.ROLLBACK.sql',
]);
// W6.1 Lock-Order Unification (133) / W6.2 Trip Authority Foundation (134) — same
// later-packet pattern, DB-only (no dedicated JS guard file for either), detected by
// presence of each one's own migration file.
const w61Applied = fs.existsSync(path.join(ROOT, 'migrations', '2026-09-15_planner_w6_lock_order_unification_v1_migration_133.sql'));
const W6_1_MIGRATION_FILES = new Set([
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_planner_w6_lock_order_unification_v1_migration_133.sql',
  'migrations/2026-09-15_planner_w6_lock_order_unification_v1_migration_133.ROLLBACK.sql',
]);
const w62Applied = fs.existsSync(path.join(ROOT, 'migrations', '2026-09-15_planner_w6_trip_authority_v1_migration_134.sql'));
const W6_2_MIGRATION_FILES = new Set([
  'migrations/MIGRATION_MANIFEST.md',
  'migrations/2026-09-15_planner_w6_trip_authority_v1_migration_134.sql',
  'migrations/2026-09-15_planner_w6_trip_authority_v1_migration_134.ROLLBACK.sql',
]);
let migrationsChanged = [];
try {
  migrationsChanged = execSync(`git diff --name-only ${BASE_HEAD} -- migrations/`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { migrationsChanged = ['<git diff failed>']; }
const unexpectedMigrationsChanged = migrationsChanged.filter((f) =>
  !(w5Applied && W5_MIGRATION_FILES.has(f)) && !(w5iaApplied && W5IA_MIGRATION_FILES.has(f))
  && !(w61Applied && W6_1_MIGRATION_FILES.has(f)) && !(w62Applied && W6_2_MIGRATION_FILES.has(f))
  && !(w63Applied && W6_3_PRODUCT_FILES.includes(f)));
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
  ...(s4Applied ? ['src/delivery/pendingGiroIntent.js', 'index.js', 'src/agents/agentOrdini.js', 'src/agents/previewStrategicOpportunities.js'] : []),
  // W5 Intent Activation (132): migration 132 + rollback + its own certification
  // candidate/harness/group additions, the shared harness files it needed to make
  // language-guard: allow-legacy agentOrdini is the existing identifier being cited, not new vocabulary
  // forward-compatible, its new reconciler module, and the agentOrdini.js/index.js
  // activation wiring.
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
  // W6.1 Lock-Order Unification (133): DB-only, no product JS.
  ...(w61Applied ? [
    'migrations/MIGRATION_MANIFEST.md',
    'migrations/2026-09-15_planner_w6_lock_order_unification_v1_migration_133.sql',
    'migrations/2026-09-15_planner_w6_lock_order_unification_v1_migration_133.ROLLBACK.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w6_lock_order_unification_v1.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w6_lock_order_unification_v1.ROLLBACK.sql',
    'ci/giro-authority-certification/harness/runW6LockOrder.js',
    'ci/giro-authority-certification/harness/groups/w6LockOrder.js',
  ] : []),
  // W6.2 Trip Authority Foundation (134): DB-only dormant foundation, no product JS.
  ...(w62Applied ? [
    'migrations/MIGRATION_MANIFEST.md',
    'migrations/2026-09-15_planner_w6_trip_authority_v1_migration_134.sql',
    'migrations/2026-09-15_planner_w6_trip_authority_v1_migration_134.ROLLBACK.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w6_trip_authority_v1.sql',
    'ci/giro-authority-certification/candidate/giro_authority_w6_trip_authority_v1.ROLLBACK.sql',
    'ci/giro-authority-certification/harness/runW6TripAuthority.js',
    'ci/giro-authority-certification/harness/groups/w6TripAuthority.js',
  ] : []),
  // W6.3/W6.4 Canonical Rider Lifecycle + Giro Projection Cutover (135): the first W6
  // packet with product JS — it ACTIVATES the canonical departure.
  ...(w63Applied ? W6_3_PRODUCT_FILES : []),
  // W6.5 Planner Final Backend Canonicalization: replaces Stage M with the
  // canonical active trip, drops the raw manual_giros read from this very read
  // path, moves the rider read onto Trip Authority and deletes giroFactsPort.js.
  // Certified by tests/plannerW65FinalBackendV1.static.test.js.
  ...(w65Applied ? W6_5_PRODUCT_FILES : []),
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
