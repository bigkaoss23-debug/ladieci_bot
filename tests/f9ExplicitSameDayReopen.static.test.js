"use strict";
// F-9 — explicit same-Business-Day reopen. Static (source-text) proof that
// the routing cutover is exactly as narrow as the frozen brief requires: one
// new call site, server-resolved, reachable only from the one intentional
// HTTP action, never from page load, never from an ordinary order, and never
// carrying a client-supplied lifecycle identity. No DB migration is part of
// this slice (open_operational_service_v1 and ensure_service_session are
// both pre-existing, F-6/F-7) — this file is scoped to the JS routing layer.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const REOPEN_MODULE = read("src/serviceSessions/explicitReopenServiceSession.js");
const LIFECYCLE = read("src/serviceSessions/serviceSessionLifecycle.js");
const ENSURE_MODULE = read("src/serviceSessions/ensureServiceSession.js");
const INDEX = read("index.js");
const RESOURCE_POLICY = read("src/utils/supabaseResourcePolicy.js");

console.log("\n== A. The primitive gets a dedicated, explicit wrapper (no default open_reason) ==");
assert("1a: serviceSessionLifecycle.js exposes openOperational calling open_operational_service_v1",
  /async openOperational\(\{[^}]*\}\)\s*\{\s*return normalize\(await rpc\("open_operational_service_v1"/.test(LIFECYCLE));
assert("1b: openOperational never defaults p_open_reason (every caller must state it explicitly)",
  !/openOperational\([^)]*openReason\s*=\s*['"]/.test(LIFECYCLE));

console.log("\n== B. Resource policy registration (runtime fail-closed enforcement, H1B) ==");
assert("2a: rpc/open_operational_service_v1 is registered",
  /entry\('rpc\/open_operational_service_v1',\s*KIND\.RPC,\s*\['POST'\]/.test(RESOURCE_POLICY));

console.log("\n== C. explicitReopenServiceSession.js — the ONE call site for 'explicit_reopen' ==");
assert("3a: the module exists and exports explicitReopenServiceSession",
  /module\.exports = \{[\s\S]*explicitReopenServiceSession[\s\S]*\};/.test(REOPEN_MODULE));
assert("3b: exactly one CODE-level 'explicit_reopen' literal passed as an open_reason argument",
  (REOPEN_MODULE.match(/openReason:\s*"explicit_reopen"/g) || []).length === 1);
const reopenRequiredBlock = REOPEN_MODULE.split('read.code === "REOPEN_REQUIRED"')[1] || "";
assert("3c: explicit_reopen is only ever passed after reading REOPEN_REQUIRED from ensure_service_session, AND after F-9.1's staleness check (which appears strictly before it)",
  reopenRequiredBlock.includes('openOperational({ actor, openReason: "explicit_reopen"') &&
  reopenRequiredBlock.indexOf("STALE_BUSINESS_DAY_REOPEN") < reopenRequiredBlock.indexOf('openOperational({ actor, openReason: "explicit_reopen"'));
assert("3d: the discriminator read comes from sessionLifecycle.ensure (ensure_service_session), never re-derived in JS",
  /const read = await sessionLifecycle\.ensure\(\{ actor, source \}\);/.test(REOPEN_MODULE));
assert("3e: no client-supplied lifecycle identity is ever accepted as a function parameter",
  !/\{\s*actor[^}]*businessDayId/.test(REOPEN_MODULE) &&
  !/\{\s*actor[^}]*serviceSessionId/.test(REOPEN_MODULE) &&
  !/\{\s*actor[^}]*openReason/.test(REOPEN_MODULE.split("async function explicitReopenServiceSession")[1]?.split("\n")[0] || "") &&
  !/\{\s*actor[^}]*serviceKind/.test(REOPEN_MODULE) &&
  !/\{\s*actor[^}]*lifecycleSemantics/.test(REOPEN_MODULE));
assert("3f: a pristine Business Day (NO_OPEN_SERVICE) is explicitly rejected as NOT a reopen, zero creation",
  /read\.code === "NO_OPEN_SERVICE"\)\s*\{\s*return \{[\s\S]{0,120}code: CODE\.FIRST_OPEN_NOT_REOPENABLE/.test(REOPEN_MODULE));
assert("3g: an active session (REUSED) returns as-is, no call to openOperational anywhere in that branch",
  /read\.code === "REUSED"\)\s*\{\s*return \{ success: true, created: false, code: CODE\.REUSED/.test(REOPEN_MODULE));
assert("3h: a race where the primitive itself answers REUSED converges, never returns created:true",
  /opened\.code === "REUSED"\)\s*\{[\s\S]{0,400}created: false, code: CODE\.REUSED/.test(REOPEN_MODULE));
assert("3i: SERVICE_SESSION_CLOSING / MULTIPLE_ACTIVE_SERVICE_SESSIONS / SERVICE_SESSION_STATE_CORRUPT are passed through, not reinterpreted",
  /ENSURE_PASSTHROUGH_CODES = new Set\(\[[\s\S]{0,220}CODE\.SERVICE_SESSION_CLOSING[\s\S]{0,220}CODE\.MULTIPLE_ACTIVE_SERVICE_SESSIONS[\s\S]{0,220}CODE\.SERVICE_SESSION_STATE_CORRUPT/.test(REOPEN_MODULE));
assert("3j: no rollover/incident-safe recovery call in this module (forgotten-close stays untouched)",
  !/performIncidentSafeRollover|classifySessionForRollover|incidentSafeRollover|rolloverClassifier/.test(REOPEN_MODULE));
assert("3k: no clock/schedule read anywhere in this module (reopen eligibility is clock-independent)",
  !/new Date\(\)|clock_timestamp|DEFAULT_SCHEDULE|resolveSchedule/.test(REOPEN_MODULE));

console.log("\n== D. index.js — only the intentional openServiceSession action may reach explicit_reopen ==");
// H-1 (LEGACY WRITER HARDENING, ledger 97) RETIRED this HTTP surface. F-9's
// design is unchanged and still correct -- sections A-C above still prove the
// module resolves everything server-side and never trusts a client-supplied
// lifecycle identity -- but G-1 removed the reason for a manual open to exist
// at all, so index.js no longer routes to it. These three assertions are
// inverted rather than deleted, so the retirement itself stays gated: if
// anyone re-wires a manual open into index.js, this file fails.
assert("4a (H-1): explicitReopenServiceSession is NO LONGER imported by index.js",
  !/require\("\.\/src\/serviceSessions\/explicitReopenServiceSession"\)/.test(INDEX));
// Isolate exactly the openServiceSession action's own block text (bounded by
// the next `} else if (action === "rollEconomicPeriod")`), so window-based
// matching can never spill into an unrelated action.
const openActionBlock = INDEX.split('if (action === "openServiceSession")')[1]?.split('} else if (action === "rollEconomicPeriod")')[0] || "";
assert("4b (H-1): the openServiceSession action refuses unconditionally and calls nothing",
  openActionBlock.length > 0 &&
  !/explicitReopenServiceSession\(/.test(openActionBlock) &&
  /MANUAL_SERVICE_OPEN_RETIRED/.test(openActionBlock) &&
  /status\(410\)/.test(openActionBlock));
assert("4c: the openServiceSession action never forwards client body fields as lifecycle identity",
  !/req\.body/.test(openActionBlock));
// Isolate exactly the ensureCurrentServiceSession action's own block text —
// it is a standalone top-level `if`, immediately followed by the equally
// standalone `if (action === "openServiceSession")`, so splitting on the
// latter can never spill this check into the next action's own (legitimate)
// explicitReopenServiceSession call.
const ensureActionBlock = INDEX.split('action === "ensureCurrentServiceSession"')[1]?.split('if (action === "openServiceSession")')[0] || "";
assert("4d: the ensureCurrentServiceSession action (silent page load) is untouched — still calls ensureCurrentServiceSession only, never explicitReopenServiceSession",
  ensureActionBlock.length > 0 &&
  /ensureCurrentServiceSession\(\{ actor: actorId, source: "auto_entry" \}\)/.test(ensureActionBlock) &&
  !/explicitReopenServiceSession/.test(ensureActionBlock));
assert("4e (H-1): ZERO occurrences of explicitReopenServiceSession( as a call in index.js",
  (INDEX.match(/explicitReopenServiceSession\(\{/g) || []).length === 0);

console.log("\n== E. ensureServiceSession.js (silent page load) never reaches explicit_reopen ==");
assert("5a: no reference to explicitReopenServiceSession anywhere in the page-load module",
  !/explicitReopenServiceSession/.test(ENSURE_MODULE));
assert("5b: no reference to 'explicit_reopen' anywhere in the page-load module",
  !/explicit_reopen/.test(ENSURE_MODULE));
assert("5c: no INVOCATION of open_operational_service_v1 in the page-load module (the pre-existing F-7 comment documenting its own non-call is fine and expected)",
  !/rpc\(\s*["']open_operational_service_v1|\.openOperational\(/.test(ENSURE_MODULE));

console.log("\n== F. Ordinary order intake never reaches explicit_reopen (DB layer, F-7-certified, re-checked here) ==");
const RESOLVE_INTAKE_MIGRATION = read("migrations/2026-08-18_f7_opening_authority_cutover.sql");
assert("6a: resolve_order_intake_context_v1 only ever passes 'first_open_of_business_day', never 'explicit_reopen'",
  /open_operational_service_v1\(\s*COALESCE\(p_actor, 'system'\), 'first_open_of_business_day'/.test(RESOLVE_INTAKE_MIGRATION) &&
  !/open_operational_service_v1\([^)]*'explicit_reopen'/.test(RESOLVE_INTAKE_MIGRATION));

console.log("\n== G. No new migration in this slice (the primitive already exists, F-6) ==");
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const f9Migrations = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /f9|f_9/i.test(f));
assert("7a: zero F-9-named migration files exist (routing-only slice, no DB change)",
  f9Migrations.length === 0, f9Migrations.join(", "));

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
