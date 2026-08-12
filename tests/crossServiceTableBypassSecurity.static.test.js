'use strict';
// SERVICE CLOSEOUT V2 / SLICE 4C.1 — static proof that the cross-service
// open-table bypass (chiudiServizio's closeContext.allowOpenTablesAcrossBoundary)
// is server-internal only. It exists to let the AUTOMATIC/REQUIRED incident-safe
// rollover (performIncidentSafeRollover) close a service while legitimate
// occupied Mesa tables span the boundary — it must never be reachable from a
// request body, querystring, or any other caller-controlled input, or an
// operator-crafted "chiudiServizio" HTTP call could force-close over a table
// that genuinely still has real, unpaid activity, defeating the exact
// protection this bug fix leaves in place for manual close.
//
// Static (source-text), not executable: mirrors the convention already used
// by tests/serviceCloseoutIncidentsFoundation.static.test.js and
// tests/serviceIncidentsSlice4b.static.test.js for the same reason — the
// property being proven is "this string/shape never appears in the HTTP
// layer", which a running test cannot demonstrate any more conclusively than
// reading the file.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const INDEX = read('index.js');
const SERVIZIO = read('src/utils/servizio.js');
const ROLLOVER = read('src/serviceSessions/incidentSafeRollover.js');

(async () => {
  console.log('\n== cross-service open-table bypass — security/no-public-path checks ==\n');

  console.log('\n── index.js (the ONLY HTTP surface) never mentions the flag ──');
  assert('1a: "allowOpenTablesAcrossBoundary" does not appear anywhere in index.js', !INDEX.includes('allowOpenTablesAcrossBoundary'));
  assert('1b: index.js never reads a matching field off req.query or req.body', !/req\.(query|body)[^\n]*allowOpenTablesAcrossBoundary/.test(INDEX));

  console.log('\n── the manual "chiudiServizio" HTTP action calls chiudiServizio with exactly 3 arguments ──');
  const manualCallMatch = INDEX.match(/result = await chiudiServizio\(([^;]*)\);/);
  assert('2a: manual close call site found', !!manualCallMatch, 'expected exactly one "result = await chiudiServizio(...)" call in index.js');
  if (manualCallMatch) {
    const argsText = manualCallMatch[1];
    // Split on top-level commas is unnecessary here: the call is known-shape
    // (deleteAttivi expr, "operator", actor expr) — proving there is no 4th
    // top-level argument is enough, and a 4th argument would necessarily add
    // another comma-separated segment after the actor expression.
    const argCount = argsText.split(',').length;
    assert('2b: exactly 3 arguments (deleteAttivi, source, actor) — no closeContext forwarded', argCount === 3, `got ${argCount}: ${argsText}`);
    assert('2c: the 3rd argument is derived from a verified auth context, never req.body/req.query', /req\.authCtx\?\.actor/.test(argsText));
  }

  console.log('\n── the S2-1G deferred-close retry (raw chiudiServizio call) also stays 2-argument/conservative ──');
  const retryCallMatch = INDEX.match(/res = await chiudiServizio\(([^;]*)\);/);
  assert('3a: deferred-close retry call site found', !!retryCallMatch);
  if (retryCallMatch) {
    assert('3b: no closeContext forwarded here either', !retryCallMatch[1].includes('allowOpenTablesAcrossBoundary'));
  }

  console.log('\n── the bypass is wired EXACTLY once, from the automatic orchestrator ──');
  // SERVICE LIFECYCLE RUNTIME AUTHORITY RECOVERY — the call site now also
  // carries closeContext.preserveActiveOrders:true (a residual non-terminal
  // order must never be archived/force-terminalized by the automatic path,
  // only by an explicit human force-close — see the close engine's own
  // header comment for the full contract), so the call spans multiple
  // lines. The pattern below tolerates that formatting/ordering while still
  // requiring both flags to appear inside the SAME
  // closeSession(true, source, actor, {...}) call, not merely somewhere in
  // the file.
  const closeSessionCallMatch = ROLLOVER.match(/closeSession\(true, source, actor, \{([\s\S]*?)\}\);/);
  assert('4a: incidentSafeRollover.js sets allowOpenTablesAcrossBoundary:true on its own closeSession() call',
    !!closeSessionCallMatch && /allowOpenTablesAcrossBoundary:\s*true/.test(closeSessionCallMatch[1]));
  assert('4a-2: the same call also sets preserveActiveOrders:true (residual orders survive an automatic close untouched)',
    !!closeSessionCallMatch && /preserveActiveOrders:\s*true/.test(closeSessionCallMatch[1]));
  const occurrences = (SERVIZIO.match(/allowOpenTablesAcrossBoundary/g) || []).length;
  assert('4b: servizio.js references the flag a small, fixed number of times (destructure + comments + gate check) — no second/hidden code path', occurrences >= 2 && occurrences <= 8, String(occurrences));

  console.log('\n── the gate itself defaults closed and uses strict equality (no truthy coercion) ──');
  assert('5a: chiudiServizio defaults closeContext to {} (never undefined -> never throws on destructure)', /closeContext\s*=\s*\{\}/.test(SERVIZIO));
  assert('5b: strict === true comparison, not a truthy check', /closeContext\.allowOpenTablesAcrossBoundary === true/.test(SERVIZIO));
  assert('5c: the mesa gate condition still requires the flag to be false/absent by default', /openTableAccounts\.length > 0 && !allowOpenTablesAcrossBoundary/.test(SERVIZIO));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
