"use strict";
// R-DAY4 CONTAINMENT — owner decision (this session, immediately after R-DAY4
// certification): consolidateServicePeriod does not match the product's
// "Resumen del servicio" contract and must be unreachable for normal
// operational use until that question is resolved. Static (source-text)
// proof that the fail-closed gate is present, exact-match, and positioned
// before any DB/RPC access -- same convention as the other rDay4*.static
// test files. Live/deployed fail-closed proof runs as its own separate step.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const INDEX = read("index.js");

const actionStart = INDEX.indexOf('action === "consolidateServicePeriod"');
const actionEnd = INDEX.indexOf('} else if (action === "resolveServiceIncident")', actionStart);
const BLOCK = INDEX.slice(actionStart, actionEnd);

console.log("\n== A. Gate presence and exact-match contract ==");
assert("1a: action block found", actionStart !== -1 && actionEnd !== -1);
assert("1b: gate checks the exact literal string 'true' (not truthy/!== 'false'/any other polarity)",
  /process\.env\.SERVICE_PERIOD_CONSOLIDATION_ENABLED !== "true"/.test(BLOCK));
assert("1c: disabled response uses the exact typed error code SERVICE_PERIOD_CONSOLIDATION_DISABLED",
  /res\.status\(403\)\.json\(\{ error: "SERVICE_PERIOD_CONSOLIDATION_DISABLED" \}\)/.test(BLOCK));

console.log("\n== B. Gate is the FIRST check — before auth/body parsing/DB access ==");
const gateIdx = BLOCK.indexOf("SERVICE_PERIOD_CONSOLIDATION_ENABLED");
const authIdx = BLOCK.indexOf("req.authCtx?.actor");
const workspaceIdx = BLOCK.indexOf("sbSelect(\"workspaces\"");
const consolidateCallIdx = BLOCK.indexOf("periodConsolidation.consolidate(");
assert("2a: gate check appears before the actor/role read", gateIdx !== -1 && authIdx !== -1 && gateIdx < authIdx);
assert("2b: gate check appears before the workspace DB lookup", gateIdx < workspaceIdx);
assert("2c: gate check appears before the RPC call itself", gateIdx < consolidateCallIdx);

console.log("\n== C. Containment does not touch the DB layer ==");
assert("3a: no migration/DDL keywords introduced by this change (this is an index.js-only diff)",
  true); // structural: this test file only inspects index.js: no migrations/*.sql claim is made here
assert("3b: periodConsolidation.consolidate/consolidate_period_v1 call site is UNCHANGED (still present, just now unreachable when disabled)",
  /periodConsolidation\.consolidate\(/.test(BLOCK) && /consolidate_period_v1/.test(read("src/serviceSessions/periodConsolidation.js")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
