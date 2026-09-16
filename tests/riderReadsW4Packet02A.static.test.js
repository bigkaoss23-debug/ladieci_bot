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

section('WRITER INTEGRITY — byte-identical to BASE_HEAD (manualGiros.js: see forward-compatible check below)');
// language-guard: allow-legacy agentOrdini.js is the existing file name being checked, not new vocabulary
// src/agents/agentOrdini.js and index.js excepted below (S4 operator-intent prerequisite,
// DORMANT — a later, separately-authorized packet, same deferral pattern as manualGiros.js
// just above; re-proven by tests/s4DormantInsertGateGuard.static.test.js).
const S4_STATIC_GUARD = path.join(ROOT, 'tests', 's4DormantInsertGateGuard.static.test.js');
const s4Applied = fs.existsSync(S4_STATIC_GUARD);
// Planner W6.3 (migration 135) is the packet that finally ACTIVATES the canonical
// departure, so riderTrip.js is its own product file — the same deferral pattern used
// for the sibling product-file exceptions declared above. Its own guard
// (tests/plannerW6RiderLifecycle.static.test.js) proves, mechanically, that startTrip is
// the ONE canonical call site, that it reads no identity/scope from a client body, and
// that the H1B registry gained exactly one entry. If that guard is absent, no packet has
// earned the right to change this file and the original whole-file check still applies.
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
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
const BYTE_IDENTICAL_TARGETS = (s4Applied ? ['src/agents/riderTrip.js'] : ['src/agents/agentOrdini.js', 'src/agents/riderTrip.js', 'index.js'])
  .filter((f) => !(w63Applied && W6_3_PRODUCT_FILES.includes(f)) && !(w65Applied && W6_5_PRODUCT_FILES.includes(f)));
for (const f of BYTE_IDENTICAL_TARGETS) {
  assert(`${f} is byte-identical to BASE_HEAD (${BASE_HEAD.slice(0, 7)})`, byteIdentical(f));
}
assert('with the W6.3 guard present, riderTrip.js is authorized by it rather than pinned here',
  !w63Applied || !BYTE_IDENTICAL_TARGETS.includes('src/agents/riderTrip.js'));

// manualGiros.js: BASE_HEAD (fe0eacd, Packet 02A's own base) predates Packet 02B,
// whose own, separately-authorized runbook explicitly permits changing this
// file's getManualGiros() body. Whole-file byte-identity is the wrong invariant
// once a later, legitimately-authorized packet lands on this branch -- the real,
// still-required invariant is "writer/writer-support function bodies are
// untouched", which that later packet's own guard already proves mechanically
// (per-function, brace-counted extraction, not a declarative claim). Deferring
// to it here -- rather than re-implementing the same extraction -- avoids two
// guards drifting apart. If that guard is absent (this branch predates Packet
// 02B, e.g. on staging today), no packet has yet earned the right to change
// this file, so it falls back to the original, still-correct whole-file check.
const MANUAL_GIRO_STATIC_GUARD = path.join(ROOT, 'tests', 'manualGiroReadsW4Packet02B.static.test.js');
if (fs.existsSync(MANUAL_GIRO_STATIC_GUARD)) {
  let writerGuardOk = false;
  let writerGuardDetail = '';
  try {
    execSync(`node ${JSON.stringify(MANUAL_GIRO_STATIC_GUARD)}`, { cwd: ROOT, stdio: 'pipe' });
    writerGuardOk = true;
  } catch (e) {
    writerGuardDetail = ((e.stdout || '').toString() + (e.stderr || '').toString()).slice(-600);
  }
  assert('manualGiros.js writer/writer-support function bodies remain byte-identical (mechanically proven by tests/manualGiroReadsW4Packet02B.static.test.js)',
    writerGuardOk, writerGuardDetail);
} else {
  assert('src/agents/manualGiros.js is byte-identical to BASE_HEAD (no later-packet guard authorizes a change yet)',
    byteIdentical('src/agents/manualGiros.js'));
}

section('MIGRATIONS — completely unchanged (W5 Packet 01\'s own migration excepted)');
const W5_STATIC_GUARD = path.join(ROOT, 'tests', 'manualGirosW5Packet01.static.test.js');
const w5Applied = fs.existsSync(W5_STATIC_GUARD);
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
  const diffOut = execSync(`git diff --name-only ${BASE_HEAD} -- migrations/`, { cwd: ROOT, encoding: 'utf8' });
  migrationsChanged = diffOut.split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) {
  migrationsChanged = ['<git diff failed: ' + (e && e.message) + '>'];
}
const unexpectedMigrationsChanged = migrationsChanged.filter((f) =>
  !(w5Applied && W5_MIGRATION_FILES.has(f)) && !(w5iaApplied && W5IA_MIGRATION_FILES.has(f))
  && !(w61Applied && W6_1_MIGRATION_FILES.has(f)) && !(w62Applied && W6_2_MIGRATION_FILES.has(f))
  && !(w63Applied && W6_3_PRODUCT_FILES.includes(f)));
assert('migrations/** has zero UNEXPECTED changes vs BASE_HEAD (W5 Packet 01\'s own migration excepted)', unexpectedMigrationsChanged.length === 0, unexpectedMigrationsChanged.join(', '));

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
// riderReads.js is this packet's own product file. A later, separately-
// authorized W4 packet on this same branch is allowed to extend the cumulative
// diff with its OWN certified product files -- named here only once that
// packet's own static guard exists on the branch to vouch for them, so this
// still fails on any file that is neither Packet 02A's own file nor a later
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
// packet's already-certified one (e.g. riderTrip.js/agentOrdini.js changing
// without authorization still fails this check).
const PACKET_02A_OWN_PRODUCT_FILE = 'src/agents/riderReads.js';
const FINAL_W4_STATIC_GUARD = path.join(ROOT, 'tests', 'plannerW4FinalCutover.static.test.js');
const LATER_PACKET_CERTIFIED_PRODUCT_FILES = new Set([
  // W6.5 — Planner final backend canonicalization + legacy cleanup (certified by
  // tests/plannerW65FinalBackendV1.static.test.js): Stage M deleted and replaced by
  // the canonical active trip, the raw manual_giros read removed from the planner
  // snapshot path, the rider read moved onto Trip Authority, giroFactsPort.js deleted.
  ...(w65Applied ? W6_5_PRODUCT_FILES : []),
  ...(fs.existsSync(MANUAL_GIRO_STATIC_GUARD) ? ['src/agents/manualGiros.js', 'src/agents/manualGiroReads.js'] : []), // Packet 02B
  ...(fs.existsSync(FINAL_W4_STATIC_GUARD) ? ['src/core/delivery/plannerSnapshot.js'] : []), // Final W4 Read-Cutover Packet
  ...(w5Applied ? [ // W5 Packet 01 — single-writer Authority cutover + facts signal
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
  // packet with product JS — it ACTIVATES the canonical departure, so riderTrip.js,
  // index.js and the H1B registry are its own certified product files.
  ...(w63Applied ? W6_3_PRODUCT_FILES : []),
]);
const allowedProductFiles = new Set([PACKET_02A_OWN_PRODUCT_FILE, ...LATER_PACKET_CERTIFIED_PRODUCT_FILES]);
const nonTestNonAllowed = changedFiles.filter((f) => !f.startsWith('tests/') && !allowedProductFiles.has(f));
assert('every non-test changed file is either riderReads.js or a later packet\'s own already-certified product file',
  nonTestNonAllowed.length === 0, nonTestNonAllowed.join(', '));
assert('riderReads.js is actually in the changed-files list (the packet did something)',
  changedFiles.includes('src/agents/riderReads.js'), changedFiles.join(', '));

// NOTE: this file used to keep its own repo-wide sweep here for "no file
// outside a hardcoded roster references the Authority/projection". That is a
// SYSTEM-WIDE invariant, not a Packet-02A-local one, and duplicating it in a
// packet-scoped snapshot goes stale the moment any later packet legitimately
// adds a new certified consumer (exactly what happened with Packet 02B's
// manualGiroReads.js). The canonical, always-current version of this sweep
// lives in tests/giroAuthorityW3Candidate.static.test.js's own
// ALLOWED_PROJECTION_CONSUMERS roster (kept up to date by each packet that
// legitimately extends the chain) -- removed here rather than re-duplicated.
const jsCode = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const readRaw = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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
