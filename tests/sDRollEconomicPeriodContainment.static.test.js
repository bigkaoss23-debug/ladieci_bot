"use strict";
// S-D Phase 1 — fail-closed containment gate on the rollEconomicPeriod HTTP
// action. Static (source-text) proof only: this is a pure code-shape check
// on index.js, mirroring the SERVICE_PERIOD_CONSOLIDATION_ENABLED gate
// (R-DAY4 containment) byte-for-byte in structure. Live containment proof
// (env unset -> 403, no DB write) is run as its own separate step against
// real staging, either via an authenticated round-trip if a session is
// available, or via static+env evidence otherwise -- see the S-D report.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const INDEX = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

console.log("\n== A. Gate shape and position ==");
const branchStart = INDEX.indexOf('action === "rollEconomicPeriod"');
assert("1a: rollEconomicPeriod branch exists", branchStart !== -1);
const branchSlice = INDEX.slice(branchStart, branchStart + 2000);

assert("1b: gate checks the exact env var name ECONOMIC_PERIOD_ROLLOVER_ENABLED",
  /process\.env\.ECONOMIC_PERIOD_ROLLOVER_ENABLED !== "true"/.test(branchSlice));
assert("1c: gate returns 403 with the typed rejection code ECONOMIC_PERIOD_ROLLOVER_DISABLED",
  /return res\.status\(403\)\.json\(\{ error: "ECONOMIC_PERIOD_ROLLOVER_DISABLED" \}\);/.test(branchSlice));

const gateIdx = branchSlice.indexOf("ECONOMIC_PERIOD_ROLLOVER_ENABLED");
const actorCheckIdx = branchSlice.indexOf("UNVERIFIED_ACTOR");
const rpcCallIdx = branchSlice.indexOf("await rollEconomicPeriod(");
assert("1d: gate is the FIRST operation in the branch — strictly before the actor check and before the RPC call",
  gateIdx !== -1 && actorCheckIdx !== -1 && rpcCallIdx !== -1
  && gateIdx < actorCheckIdx && gateIdx < rpcCallIdx);

console.log("\n== B. Exact-match / fail-closed semantics (mirrors SERVICE_PERIOD_CONSOLIDATION_ENABLED) ==");
assert("2a: comparison is strict inequality against the literal string 'true' (not truthy/falsy coercion)",
  /!== "true"/.test(branchSlice) && !/== 'true'/.test(branchSlice));
assert("2b: no default-enabling fallback (no `|| 'true'`, no `?? 'true'`) anywhere in the gate line",
  !/ECONOMIC_PERIOD_ROLLOVER_ENABLED\s*\|\|/.test(branchSlice)
  && !/ECONOMIC_PERIOD_ROLLOVER_ENABLED\s*\?\?/.test(branchSlice));

console.log("\n== C. Nothing else touched ==");
assert("3a: rollEconomicPeriod RPC call itself is untouched (still calls the real function with the same args)",
  /const rolled = await rollEconomicPeriod\(\{ actor: actorId, source: "operator" \}\);/.test(branchSlice));
assert("3b: economicBoundaryEngine.js is not modified by this change (index.js only)",
  !fs.existsSync(path.join(__dirname, "..", "src", "serviceSessions", "economicBoundaryEngine.js"))
    || fs.readFileSync(path.join(__dirname, "..", "src", "serviceSessions", "economicBoundaryEngine.js"), "utf8").indexOf("ECONOMIC_PERIOD_ROLLOVER_ENABLED") === -1);
assert("3c: the action is not deleted — 'rollEconomicPeriod' string still appears exactly where the branch condition is",
  INDEX.includes('action === "rollEconomicPeriod"'));
assert("3d: consolidateServicePeriod's own existing gate is untouched (still present, unrelated env var)",
  /process\.env\.SERVICE_PERIOD_CONSOLIDATION_ENABLED !== "true"/.test(INDEX));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
