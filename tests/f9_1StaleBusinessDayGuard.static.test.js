"use strict";
// F-9.1 — stale Business Day guard for explicit reopen. Static (source-text)
// proof that the fix is exactly as narrow as the frozen brief requires: one
// reused, pre-existing, side-effect-free read; zero new SQL; zero new
// migration; zero reconciliation/mutation of the canonical Business Day
// pointer; and no naive calendar-date rule invented alongside the real one.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

// Comment-stripped so explanatory prose (which legitimately names
// open_business_day_v1/CURRENT_DATE/business_day_lifecycle_state to explain
// why they are NOT used) can never false-positive against a check whose real
// intent is "no functional reference in code", not "the string never
// appears in a comment" — same technique as f6/f7's own static tests.
function stripJsComments(text) {
  let out = ""; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const c2 = i + 1 < n ? text[i + 1] : "";
    if (c === "/" && c2 === "/") { while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c; out += c; i++;
      while (i < n) {
        if (text[i] === "\\") { out += text[i] + (i + 1 < n ? text[i + 1] : ""); i += 2; continue; }
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

const REOPEN_MODULE = read("src/serviceSessions/explicitReopenServiceSession.js");
const REOPEN_CODE_ONLY = stripJsComments(REOPEN_MODULE);
const LIFECYCLE = read("src/serviceSessions/serviceSessionLifecycle.js");
const INTAKE_POLICY = read("src/serviceSessions/orderIntakePolicy.js");
const ENSURE_MODULE = read("src/serviceSessions/ensureServiceSession.js");

console.log("\n== A. Reuse, not reinvention — the existing order-intake preflight authority ==");
assert("1a: explicitReopenServiceSession.js imports fetchOrderIntakeContext from orderIntakePolicy.js (unmodified module)",
  /require\("\.\/orderIntakePolicy"\)/.test(REOPEN_MODULE) &&
  /const \{ fetchOrderIntakeContext \} = require/.test(REOPEN_MODULE));
assert("1b: orderIntakePolicy.js itself is untouched by this slice (still wraps get_order_intake_context_v1, no new RPC)",
  /rpc\("get_order_intake_context_v1", \{\}\)/.test(INTAKE_POLICY) &&
  (INTAKE_POLICY.match(/await rpc\(/g) || []).length === 1);
assert("1c: no new SQL/RPC call introduced anywhere in explicitReopenServiceSession.js (only the two pre-existing calls: sessionLifecycle.ensure and sessionLifecycle.openOperational)",
  (REOPEN_MODULE.match(/await (sessionLifecycle\.\w+|fetchIntakeContext)\(/g) || []).length === 3);
assert("1d: open_business_day_v1 (the OTHER dormant Business Day primitive, R-DAY1) is deliberately NOT functionally referenced — its own date rule omits the overnight cutoff (named only in explanatory prose, scanned out below)",
  !/open_business_day_v1/.test(REOPEN_CODE_ONLY));

console.log("\n== B. Zero new migration — this is a JS-orchestration-only slice ==");
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const f91Migrations = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /f9[._-]?1|f_9_1/i.test(f));
assert("2a: zero F-9.1-named migration files exist", f91Migrations.length === 0, f91Migrations.join(", "));

console.log("\n== C. No naive calendar-date rule — the canonical overnight-safe authority is reused, never re-derived ==");
assert("3a: no Date/CURRENT_DATE/clock computation of any kind in explicitReopenServiceSession.js's actual code",
  !/new Date\(|Date\.now\(|CURRENT_DATE|clock_timestamp|getUTCDate|toISOString\(\)\.slice/.test(REOPEN_CODE_ONLY));
assert("3b: the staleness decision is a plain string comparison between two already-computed businessDate values, not a fresh clock read",
  /intakeCtx\.businessDate !== read\.businessDate/.test(REOPEN_MODULE));
assert("3c: fetchOrderIntakeContext is called with no arguments (never passed a client-supplied date/business day)",
  /await fetchIntakeContext\(\)/.test(REOPEN_MODULE) && !/fetchIntakeContext\([^)]+\)/.test(REOPEN_MODULE));

console.log("\n== D. Fail-closed on an unreadable freshness check (asymmetric vs orderIntakePolicy's own fail-open) ==");
assert("4a: a null/malformed intake context refuses the reopen (BUSINESS_DAY_VALIDITY_CHECK_FAILED), never silently proceeds",
  /if \(!intakeCtx \|\| typeof intakeCtx\.businessDate !== "string"\)\s*\{\s*return \{[\s\S]{0,200}code: CODE\.BUSINESS_DAY_VALIDITY_CHECK_FAILED/.test(REOPEN_MODULE));
assert("4b: the validity-check-failed branch returns success:false and never calls openOperational",
  REOPEN_MODULE.indexOf("BUSINESS_DAY_VALIDITY_CHECK_FAILED") < REOPEN_MODULE.indexOf('openOperational({ actor, openReason: "explicit_reopen"'));

console.log("\n== E. Stale pointer refuses with zero mutation ==");
assert("5a: STALE_BUSINESS_DAY_REOPEN returns success:false, created:false",
  /code: CODE\.STALE_BUSINESS_DAY_REOPEN[\s\S]{0,10}\}?[\s\S]{0,10}/.test(REOPEN_MODULE) &&
  /success: false, created: false, code: CODE\.STALE_BUSINESS_DAY_REOPEN/.test(REOPEN_MODULE));
assert("5b: no write/UPDATE/business_day_lifecycle_state mutation of any kind in this module's actual code",
  !/UPDATE |business_day_lifecycle_state|current_business_day_id\s*=|current_period_id\s*=|ticket_epoch\s*=/.test(REOPEN_CODE_ONLY));
assert("5c: this module never calls open_business_day_v1 or any reconciliation primitive — Business Day advancement stays exclusively resolve_order_intake_context_v1's job",
  !/reconcile|advanceBusinessDay|open_business_day_v1/i.test(REOPEN_CODE_ONLY));

console.log("\n== F. Page load / order intake / first-open remain untouched by this slice ==");
assert("6a: ensureServiceSession.js (silent page load) does not reference the new stale-guard machinery",
  !/fetchOrderIntakeContext|STALE_BUSINESS_DAY_REOPEN|orderIntakePolicy/.test(ENSURE_MODULE));
// Was a bare `=== 6` method count, which any later legitimate slice trips
// without saying what actually changed. Asserting the exact method SET keeps
// F-9.1's real intent -- this slice introduced no stale-guard RPC of its own,
// and openOperational is still F-9's untouched wrapper -- while naming every
// method a reader has to account for. resolveOperationalContext is the Mesa
// first-seating stale-service guard's reuse of resolve_order_intake_context_v1
// (manifest row 97); 6c re-proves it brought no date logic into this module.
assert("6b: serviceSessionLifecycle.js exposes exactly the expected RPC wrappers (openOperational is F-9's, untouched)",
  JSON.stringify((LIFECYCLE.match(/async (\w+)\(/g) || []).map((m) => m.slice(6, -1))) ===
  JSON.stringify(["ensure", "open", "beginClose", "completeClose", "currentCloseout",
                  "resolveOperationalContext", "openOperational"]));
assert("6c: serviceSessionLifecycle.js still carries no stale-guard or calendar logic of its own",
  !/STALE_BUSINESS_DAY|fetchOrderIntakeContext|Europe\/Madrid|CURRENT_DATE/.test(LIFECYCLE));

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
