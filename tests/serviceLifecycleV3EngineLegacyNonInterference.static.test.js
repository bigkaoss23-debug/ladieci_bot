'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2 — "NEW ENGINE, NO LEGACY CLOSEOUT" static
// guard. Proves the new V3.2 close-engine files contain zero references to
// language-guard: allow-legacy chiudiServizio/begin_service_session_close/storico/serata_summary are the exact forbidden legacy identifiers this header names, not new vocabulary being introduced
// the legacy close machinery: chiudiServizio, begin_service_session_close,
// language-guard: allow-legacy storico/serata_summary are named here only to state what this scan looks for the ABSENCE of, not new vocabulary
// complete_service_session_close, storico, serata_summary,
// scheduleDeferredCloseRetry. Scope is deliberately just the new engine's own
// language-guard: allow-legacy servizio.js/chiudiServizio are named here only to explain why this file's scan is scoped to new files, not a repo-wide ban — not new vocabulary
// files (not a repo-wide ban — src/utils/servizio.js legitimately DEFINES
// language-guard: allow-legacy chiudiServizio is named here only to explain why this file's scan is scoped to new files, not new vocabulary
// chiudiServizio, index.js legitimately WIRES it, and this migration's own
// SQL comments legitimately DISCUSS why it is not called — see
// tests/serviceLifecycleV3CloseEngineMigration.static.test.js for the SQL
// side). Same walk()/allowlist pattern as tests/serviceLifecycleV3Foundation.
// static.test.js's "application wiring" section.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// Same comment-stripping helper as tests/supabaseRawFetchRatchet.static.test.js
// — this scan is deliberately comment-BLIND: a file's own explanatory prose
// legitimately needs to name a forbidden identifier to explain why it is
// absent; only an ACTUAL CODE reference (a real require()/function-call/
// identifier) is a real violation.
function stripComments(text) {
  let out = ''; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const c2 = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && c2 === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c; out += c; i++;
      while (i < n) {
        if (text[i] === '\\') { out += text[i] + (i + 1 < n ? text[i + 1] : ''); i += 2; continue; }
        out += text[i];
        if (text[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

const ROOT = path.join(__dirname, '..');

const ENGINE_FILES = [
  path.join(ROOT, 'src', 'serviceSessions', 'serviceLifecycleEngine.js'),
  path.join(ROOT, 'src', 'serviceSessions', 'serviceLifecycleV3Transition.js'),
  path.join(ROOT, 'src', 'closeout', 'serviceCloseoutCreation.js'),
  // SLICE 3.4's v3NextServiceIdentity.js was retired by F-5 (the engine no
  // longer derives or ensures a next service as part of close success) —
  // removed from this list along with the file itself, not left as a stale
  // fs.existsSync() check against a deleted path.
];

// language-guard: allow-legacy chiudiServizio/storico/serata_summary are the exact forbidden-term identifiers this test asserts are ABSENT from the new engine, not new vocabulary being introduced
const FORBIDDEN_PATTERNS = [
  // language-guard: allow-legacy chiudiServizio/servizio.js are the exact forbidden identifiers these two entries check for the ABSENCE of, not new vocabulary
  { name: 'chiudiServizio (legacy close function)', re: /chiudiServizio/ },
  // language-guard: allow-legacy servizio.js is the exact forbidden module path this entry checks for the ABSENCE of, not new vocabulary
  { name: "require('../utils/servizio') / require('./utils/servizio') (the legacy close module itself)", re: /require\([^)]*utils\/servizio['"]\)/ },
  { name: 'begin_service_session_close (legacy two-phase close RPC)', re: /begin_service_session_close/ },
  { name: 'complete_service_session_close (legacy two-phase close RPC)', re: /complete_service_session_close/ },
  // language-guard: allow-legacy storico/serata_summary are the exact forbidden identifiers these two entries check for the ABSENCE of, not new vocabulary
  { name: 'storico (legacy archive table)', re: /\bstorico\b/ },
  // language-guard: allow-legacy serata_summary is the exact forbidden identifier this entry checks for the ABSENCE of, not new vocabulary
  { name: 'serata_summary (legacy archive table)', re: /serata_summary/ },
  { name: 'scheduleDeferredCloseRetry (legacy retry mechanism)', re: /scheduleDeferredCloseRetry/ },
  // "no legacy scheduler dependency", "does not enable automatic scheduling",
  // "does not call legacy close machinery": F-5 retired the engine's own
  // clock-derived next-service step entirely (it no longer derives or
  // ensures any successor identity, own or legacy), so this list only needs
  // to keep proving it never reaches for the legacy ensure/auto-close
  // machinery either.
  { name: 'ensure_service_session (legacy next-service RPC)', re: /ensure_service_session\(/ },
  { name: 'ensureCurrentServiceSession / ensureServiceSession.js (legacy S2-7D6B ensure orchestrator)', re: /ensureServiceSession|ensureCurrentServiceSession/ },
  { name: 'incidentSafeRollover / performIncidentSafeRollover (legacy V2 rollover orchestrator)', re: /incidentSafeRollover|performIncidentSafeRollover/ },
  { name: 'rolloverClassifier / classifySessionForRollover (legacy V2 classifier)', re: /rolloverClassifier|classifySessionForRollover|sessionRolloverClassification/ },
  { name: 'autoCloseEngine / autoCloseDecision (legacy automatic-close scheduler)', re: /autoCloseEngine|autoCloseDecision/ },
  { name: 'LEGACY_AUTOMATIC_LIFECYCLE_ENABLED (legacy scheduler feature flag)', re: /LEGACY_AUTOMATIC_LIFECYCLE_ENABLED/ },
  { name: 'mesa_release_empty_session_auto_v1 called directly by name (must go through mesaDao.js only, unchanged since V3.3)', re: /rpc\(\s*['"]mesa_release_empty_session_auto_v1['"]/ },
];

(async () => {
  console.log('\n== V3.2 close engine — legacy non-interference guard ==\n');

  assert('0: the engine file set is non-trivial (guards against a typo silently checking nothing)', ENGINE_FILES.length === 3);

  for (const file of ENGINE_FILES) {
    const rel = path.relative(ROOT, file);
    assert(`${rel}: file exists`, fs.existsSync(file));
    if (!fs.existsSync(file)) continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const { name, re } of FORBIDDEN_PATTERNS) {
      assert(`${rel}: no reference to ${name}`, !re.test(text));
    }
  }

  console.log('\n── the engine\'s dependency-injection defaults never resolve to a legacy module ──');
  {
    const engineText = fs.readFileSync(path.join(ROOT, 'src', 'serviceSessions', 'serviceLifecycleEngine.js'), 'utf8');
    const requireLines = (engineText.match(/^const .+= require\(.+\);$/gm) || []);
    assert('1a: every require() in the engine targets a V3/V3.1/V3.2 module, sbSelect, or the shared aggregate() — never serviceSessionLifecycle.js (the LEGACY begin/complete wrapper)', !requireLines.some((l) => /serviceSessionLifecycle/.test(l)));
    assert('1b: at least 5 require() lines found (sanity — guards against an empty/broken scan)', requireLines.length >= 5, String(requireLines.length));
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
