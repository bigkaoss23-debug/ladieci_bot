"use strict";
// S2-7D6D, hardened by SERVICE CLOSEOUT V2 / SLICE 3 — structural proof that
// cron (serviceCloseTick), boot recovery (catchUpChiusura) and the external
// backup (triggerCloseIfNeeded) all delegate to the SAME decision engine
// (computeAutoCloseDecision) AND the same incident-safe rollover orchestrator
// (performIncidentSafeRollover), rather than each carrying its own rule —
// which is exactly how boot's old SERA-only hour-window heuristic diverged
// from the kind-agnostic cron tick before S2-7D6D, and exactly how a raw
// hasPendingOperationalActivity skip (RC-2) used to let a DUE session stay
// current forever. Same style as tests/twoServiceMigration.test.js: a
// source-text proof for wiring that a live DB round trip cannot cheaply
// exercise for all three triggers at once.
//
// SLICE 3 removed hasPendingOperationalActivity from all three call sites —
// pending activity is no longer a reason to skip a DUE close; it is now
// classified into a persisted incident by performIncidentSafeRollover
// instead (see tests/incidentSafeRollover.test.js for that contract). The
// function/module itself is deliberately preserved, unused by these three
// triggers now, for potential future manual-close preflight warnings.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const INDEX = read("index.js");

console.log("\n══ A. one shared decision module, not three local rules ══");
assert("A: index.js imports computeAutoCloseDecision", /require\("\.\/src\/serviceSessions\/autoCloseDecision"\)/.test(INDEX));
assert("A: index.js imports the incident-safe rollover orchestrator", /require\("\.\/src\/serviceSessions\/incidentSafeRollover"\)/.test(INDEX));
assert("A: no local serviceCloseDecision() duplicate remains", !/function serviceCloseDecision\(/.test(INDEX));
assert("A: pendingActivityGuard is no longer imported/wired into the automatic triggers (RC-2 fix) — the module itself is preserved on disk, just unused here", !/require\("\.\/src\/serviceSessions\/pendingActivityGuard"\)/.test(INDEX));

console.log("\n══ B. serviceCloseTick (cron) uses the shared engine ══");
{
  const tick = INDEX.slice(INDEX.indexOf("async function serviceCloseTick"), INDEX.indexOf("function schedulaCloseTick"));
  assert("B: tick calls computeAutoCloseDecision", /computeAutoCloseDecision\(/.test(tick));
  assert("B: tick no longer skips forever on hasPendingOperationalActivity (RC-2 fixed)", !/hasPendingOperationalActivity\(/.test(tick));
  assert("B: tick delegates to the shared incident-safe rollover orchestrator, not a bare chiudiServizio call", /performIncidentSafeRollover\(\{\s*session, source: decision\.source, actor: "system" \}\)/.test(tick));
}

console.log("\n══ C. catchUpChiusura (boot) is now kind-agnostic ══");
{
  const boot = INDEX.slice(INDEX.indexOf("async function catchUpChiusura"), INDEX.indexOf("if (require.main === module) {\n  schedula2340"));
  assert("C: boot calls computeAutoCloseDecision (same engine as cron)", /computeAutoCloseDecision\(/.test(boot));
  assert("C: boot no longer skips forever on hasPendingOperationalActivity (RC-2 fixed)", !/hasPendingOperationalActivity\(/.test(boot));
  assert("C: the old SERA-only LAST_CLOSE_DATE marker check is gone", !/LAST_CLOSE_DATE/.test(boot));
  assert("C: the old ad-hoc 23:00-05:59 hour window is gone", !/h === 23/.test(boot) && !/h >= 0 && h < 6/.test(boot));
  assert("C: boot delegates to the shared incident-safe rollover orchestrator, not a bare chiudiServizio call", /performIncidentSafeRollover\(\{\s*session, source: "catchUp", actor: "system" \}\)/.test(boot));
}

console.log("\n══ D. triggerCloseIfNeeded (external backup) is no longer an unconditional force-close ══");
{
  const handler = INDEX.slice(INDEX.indexOf('action === "triggerCloseIfNeeded"'), INDEX.indexOf('} else if (action === "scanServizio")'));
  assert("D: no longer an unconditional chiudiServizio(true, \"external\") with zero gate", !/^\s*result = await chiudiServizio\(true, "external"\);\s*$/m.test(handler));
  assert("D: external trigger checks computeAutoCloseDecision", /computeAutoCloseDecision\(/.test(handler));
  assert("D: external trigger no longer skips forever on hasPendingOperationalActivity (RC-2 fixed)", !/hasPendingOperationalActivity\(/.test(handler));
  assert("D: external trigger delegates to the shared incident-safe rollover orchestrator when due", /performIncidentSafeRollover\(\{ session: identity\.session, source: "external", actor: "system" \}\)/.test(handler));
}

console.log("\n══ F. the incident-safe rollover orchestrator itself always delegates archival to chiudiServizio ══");
{
  const ROLLOVER = read("src/serviceSessions/incidentSafeRollover.js");
  // SLICE 4C.1 — the call now also passes closeContext.allowOpenTablesAcrossBoundary:true
  // (accepted cross-service Mesa contract); deleteAttivi=true is unchanged.
  assert("F: performIncidentSafeRollover calls chiudiServizio (via its injectable closeSession, defaulted to the real one) with deleteAttivi=true — the SAME single close implementation every automatic path always used", /closeSession\(true, source, actor, \{ allowOpenTablesAcrossBoundary: true \}\)/.test(ROLLOVER) && /const \{ chiudiServizio \} = require\("\.\.\/utils\/servizio"\);/.test(ROLLOVER));
}

console.log("\n══ E. testability — the audit's flagged gap is closed ══");
assert("E: serviceCloseTick is exported for direct testing", /module\.exports\.serviceCloseTick = serviceCloseTick;/.test(INDEX));
assert("E: catchUpChiusura is exported for direct testing", /module\.exports\.catchUpChiusura = catchUpChiusura;/.test(INDEX));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
