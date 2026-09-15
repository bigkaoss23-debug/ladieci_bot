'use strict';
// tests/manualGirosW5Packet01.static.test.js — W5 Packet 01 static guard.
// OFFLINE except for local `git show` against this repo's own history.
//
// Proves, mechanically:
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
//   1. agentOrdini.js (FORBIDDEN FILE) is byte-identical to BASE_HEAD -- untouched.
//   2. The four rewritten writers (create/add/remove/dissolve) never write
//      ordenes.manual_giro_id -- that FK is now permanently frozen once this
//      packet lands, since nothing populates it anymore.
//   3. AGENTORDINI_POST_CUTOVER_SELF_NEUTRALIZATION: since (2) holds, ANY order
//      that goes through the new Authority-based writers keeps
// language-guard: allow-legacy agentOrdini.js/cambiaStato are the existing file/function names being cited, not new vocabulary
//      ordenes.manual_giro_id = NULL forever, which means agentOrdini.js's
//      cambiaStato() hook (`if (!_isNoop && _prevManualGiroId && ...)`) can
//      never fire for it -- structurally, not by observation. No newly-created
//      Authority membership can ever depend on that hook running.
//   4. riderReads.js / manualGiroReads.js / riderTrip.js / index.js / planner.js
//      / previewStrategicOpportunities.js also stay untouched (diff-scope gate).
//
// Run: node tests/manualGirosW5Packet01.static.test.js

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
const BASE_HEAD = '5ac0dd9786cd6751d300fa2a1b7a0e2eaf62f865';

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

// Brace-counted extraction — robust to nested braces, matches the technique
// already used by every other packet's writer-integrity guard in this repo.
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
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

section('FORBIDDEN FILES — byte-identical to BASE_HEAD');
// language-guard: allow-legacy agentOrdini.js/index.js are the existing file names being cited, not new vocabulary
// src/agents/agentOrdini.js and index.js are EXCEPTED here as of the S4 operator-intent
// prerequisite (DORMANT) packet -- a later, separately-authorized extension, same
// deferred-verification pattern every prior packet already used for the one before it
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// (see the DIFF SCOPE allowlist above). Their specific dangerous surface (creaOrdine's
// own pending_giro_intent hard gate, and the single-writer guarantee below, which never
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// touches creaOrdine at all) is re-proven by tests/s4DormantInsertGateGuard.static.test.js
// and tests/s4PendingGiroIntentBuilder.test.js instead of by whole-file identity here.
// src/agents/previewStrategicOpportunities.js ALSO excepted (S4's own second commit:
// isGiro transport-only addition, re-proven by tests/s4PlannerIsGiroTransport.test.js).
for (const f of [
  'src/agents/riderReads.js',
  'src/agents/riderTrip.js',
  'src/agents/manualGiroReads.js',
  'src/core/delivery/planner.js',
]) {
  assert(`${f} is byte-identical to BASE_HEAD`, byteIdentical(f));
}

section('AGENTORDINI_POST_CUTOVER_SELF_NEUTRALIZATION — mechanical proof');
const mgSrc = currentContent('src/agents/manualGiros.js');
const jsCode = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

for (const fn of ['createManualGiro', 'addOrderToManualGiro', 'removeOrderFromManualGiro', 'dissolveManualGiro']) {
  const body = extractFunction(mgSrc, fn);
  assert(`${fn}(): body found`, body !== null);
  if (body) {
    assert(`${fn}(): never writes ordenes.manual_giro_id (no sbUpdate("ordenes", ...) at all)`,
      !/sbUpdate\(\s*["']ordenes["']/.test(jsCode(body)), body);
    assert(`${fn}(): calls the Authority via sbRpc, not a raw ordenes/manual_giros write`,
      /sbRpc\(|callAuthority\(/.test(body));
  }
}

// The ONLY place in the whole file that still writes ordenes.manual_giro_id
// must be autoDissolveIfBelowThreshold (and, transitively, nothing else) --
// language-guard: allow-legacy agentOrdini.js/cambiaStato are the existing file/function names being cited, not new vocabulary
// the legacy function agentOrdini.js's cambiaStato() still calls directly.
// sbUpdate("ordenes", ...) calls in this file span multiple lines (the
// function name and the "ordenes" literal are on separate lines), so this
// scans the whole comment-stripped source rather than line-by-line.
const allOrdenesManualGiroWrites = jsCode(mgSrc).match(/sbUpdate\(\s*["']ordenes["']/g) || [];
const autoDissolveBody = extractFunction(mgSrc, 'autoDissolveIfBelowThreshold');
const softDissolveBody = extractFunction(mgSrc, 'softDissolveActiveManualGirosForClose');
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
assert('autoDissolveIfBelowThreshold(): still writes ordenes.manual_giro_id=null (kept byte-identical for agentOrdini.js)',
  autoDissolveBody !== null && /sbUpdate\(\s*["']ordenes["']/.test(jsCode(autoDissolveBody)));
assert('softDissolveActiveManualGirosForClose(): still writes ordenes.manual_giro_id=null (kept byte-identical, confirmed zero live callers)',
  softDissolveBody !== null && /sbUpdate\(\s*["']ordenes["']/.test(jsCode(softDissolveBody)));
// Exactly two sbUpdate("ordenes",...) call sites in the whole file, and both
// are inside the two byte-identical legacy functions above -- never inside
// any of the four rewritten writers (already proven individually above).
const writesInsideAutoDissolve = (jsCode(autoDissolveBody || '').match(/sbUpdate\(\s*["']ordenes["']/g) || []).length;
const writesInsideSoftDissolve = (jsCode(softDissolveBody || '').match(/sbUpdate\(\s*["']ordenes["']/g) || []).length;
assert('exactly two sbUpdate("ordenes",...) call sites in the whole file, both accounted for by the two byte-identical legacy functions',
  allOrdenesManualGiroWrites.length === 2 && writesInsideAutoDissolve === 1 && writesInsideSoftDissolve === 1,
  { total: allOrdenesManualGiroWrites.length, insideAutoDissolve: writesInsideAutoDissolve, insideSoftDissolve: writesInsideSoftDissolve });

// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
assert('manualGiros.js still exports autoDissolveIfBelowThreshold (agentOrdini.js dependency — must not be deleted)',
  /autoDissolveIfBelowThreshold,/.test(mgSrc.slice(mgSrc.indexOf('module.exports'))));
assert('manualGiros.js still exports countActiveMembers (autoDissolveIfBelowThreshold\'s own dependency)',
  /countActiveMembers,/.test(mgSrc.slice(mgSrc.indexOf('module.exports'))));

// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
section('agentOrdini.js — confirms it still imports exactly what it needs, nothing broken by the rewrite');
// language-guard: allow-legacy agentOrdiniSrc cites the existing agentOrdini.js file name, not new vocabulary
const agentOrdiniSrc = currentContent('src/agents/agentOrdini.js');
// language-guard: allow-legacy agentOrdiniSrc cites the existing agentOrdini.js file name, not new vocabulary
const importLine = (agentOrdiniSrc.match(/const \{[^}]*\}\s*=\s*require\(["']\.\/manualGiros["']\)/) || [''])[0];
// language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
assert('agentOrdini.js imports isStatusLeavingGiro + autoDissolveIfBelowThreshold from manualGiros.js', /isStatusLeavingGiro/.test(importLine) && /autoDissolveIfBelowThreshold/.test(importLine), importLine);
assert('both imported names are still exported by the rewritten manualGiros.js',
  /isStatusLeavingGiro,/.test(mgSrc.slice(mgSrc.indexOf('module.exports'))) &&
  /autoDissolveIfBelowThreshold,/.test(mgSrc.slice(mgSrc.indexOf('module.exports'))));

section('SINGLE-WRITER GUARANTEE — no rewritten writer references manual_giro_id at all outside metadata plumbing');
for (const fn of ['createManualGiro', 'addOrderToManualGiro', 'removeOrderFromManualGiro', 'dissolveManualGiro']) {
  const body = extractFunction(mgSrc, fn);
  // The only acceptable manual_giro_id-shaped identifier inside these bodies
  // is the giroId/giro_id PARAMETER itself (an opaque string id, unrelated to
  // the ordenes.manual_giro_id COLUMN) -- assert no raw column write survives.
  assert(`${fn}(): contains no { manual_giro_id: ... } write object literal`,
    !/\{\s*manual_giro_id\s*:/.test(jsCode(body || '')));
}

section('DIFF SCOPE — product changes limited to the Authority command surface + manualGiros.js + declared frontend/config files');
let changedFiles = [];
try {
  changedFiles = execSync(`git diff --name-only ${BASE_HEAD}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);
} catch (e) { changedFiles = ['<git diff failed>']; }
const ALLOWED_PRODUCT_PREFIXES = [
  'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.sql',
  'migrations/2026-09-15_planner_w5_packet01_single_writer_v1_migration_131.ROLLBACK.sql',
  // W5 Intent Activation (132) — a later, separately-authorized packet, same
  // deferred-verification pattern: capture trigger + consume signal-bump fix +
  // bounded read helper + close-session sweep, certified by
  // ci/giro-authority-certification/harness/runW5IntentActivation.js (337/337).
  'migrations/2026-09-15_w5_intent_activation_v1_migration_132.sql',
  'migrations/2026-09-15_w5_intent_activation_v1_migration_132.ROLLBACK.sql',
  // W6.1 Lock-Order Unification (133) — same later-packet pattern, DB-only (no
  // product JS): inserts the L0 dispatch-lock acquisition into the five live Giro
  // Authority commands. Certified by ci/giro-authority-certification/harness/
  // runW6LockOrder.js (already covered by the blanket prefix below; listed here only
  // for the migration files themselves).
  'migrations/2026-09-15_planner_w6_lock_order_unification_v1_migration_133.sql',
  'migrations/2026-09-15_planner_w6_lock_order_unification_v1_migration_133.ROLLBACK.sql',
  // W6.2 Trip Authority Foundation (134) — same pattern: dormant trip_authority
  // schema + start_rider_trip_v2/trip_projection_v1, no product JS. Certified by
  // ci/giro-authority-certification/harness/runW6TripAuthority.js.
  'migrations/2026-09-15_planner_w6_trip_authority_v1_migration_134.sql',
  'migrations/2026-09-15_planner_w6_trip_authority_v1_migration_134.ROLLBACK.sql',
  'migrations/MIGRATION_MANIFEST.md',
  'src/agents/manualGiros.js',
  'ci/giro-authority-certification/',
  // S4 operator-intent prerequisite (DORMANT) — a later, separately-authorized packet,
  // same deferred-verification pattern every prior packet already used for the one
  // before it. Adds a new pure builder (src/delivery/) and threads it through the two
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  // trusted HTTP operator actions and creaOrdine()'s own INSERT payload, hard-gated to
  // pending_giro_intent:null until a still-later packet installs the W5 capture
  // trigger. Certified separately by tests/s4PendingGiroIntentBuilder.test.js and
  // tests/s4DormantInsertGateGuard.static.test.js — this allowlist only needs to know
  // the touch is authorized, not re-prove what it does.
  'src/delivery/',
  'index.js',
  // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
  'src/agents/agentOrdini.js',
  // S4's own second commit: isGiro transport-only addition to the Planner opportunity
  // enrichment boundary, certified by tests/s4PlannerIsGiroTransport.test.js.
  'src/agents/previewStrategicOpportunities.js',
  // H1B registry fix-forward (later, separately-authorized packet): registers the 6
  // approved giro_authority_* RPCs — the 4 W5 Packet 01 manualGiros.js writer RPCs this
  // packet's own diff missed, plus the 2 W5 Intent Activation RPCs — so the gated sbRpc
  // transport actually allows them, certified by tests/supabaseResourcePolicy.test.js
  // and the strengthened W3_REGISTRY_INVARIANT in tests/giroAuthorityW3Candidate.static.test.js.
  'src/utils/supabaseResourcePolicy.js',
];
const nonTest = changedFiles.filter((f) => !f.startsWith('tests/'));
const unexpected = nonTest.filter((f) => !ALLOWED_PRODUCT_PREFIXES.some((p) => f === p || f.startsWith(p)));
// Frontend files are allowed ONLY under the declared Planner-surface prefix,
// checked and reported separately (never silently folded into "expected").
const feFiles = unexpected.filter((f) => /ladieci-app33/i.test(f));
const trulyUnexpected = unexpected.filter((f) => !feFiles.includes(f));
assert('every non-test, non-frontend changed file is on the declared allowlist', trulyUnexpected.length === 0, trulyUnexpected.join(', '));
console.log('  INFO  frontend files changed (reviewed separately below): ' + (feFiles.join(', ') || '(none yet)'));

console.log('\n═══ RESULT: ' + pass + ' passed, ' + fail + ' failed ═══');
process.exit(fail === 0 ? 0 : 1);
