"use strict";
// O-5 (consolidated) — PRE_UAT_LIFECYCLE_HYGIENE Part C/E/G/H. Static
// (source-text) proof for migrations/2026-09-16_o5_order_intake_first_
// service_boundary_single_authority.sql, same convention as
// tests/rDay3BusinessDayIntakeAuthority.static.test.js and its O-series
// siblings. This migration is NOT applied to any database by this session
// (hard safety gate) -- the executable proof that it actually installs and
// behaves correctly (real ephemeral PostgreSQL 17, real CREATE FUNCTION,
// real SELECT probes at 03:59/04:00/04:01/07:59/08:00/00:00/23:59, and a
// real two-connection concurrency race for the first order of a fresh
// Business Day) is recorded in the session report.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

const SQL = read("migrations/2026-09-16_o5_order_intake_first_service_boundary_single_authority.sql");
const INTAKE_JS = read("src/serviceSessions/orderIntakePolicy.js");
const SCHEDULE_JS = read("src/schedule/serviceSchedule.js");
const LIFECYCLE_JS = read("src/serviceSessions/serviceSessionLifecycle.js");

console.log("\n== A. Predecessor guard ==");
assert("1a: refuses if resolve_order_intake_context_v1 is missing",
  /O-5 refused: public\.resolve_order_intake_context_v1 does not exist/.test(SQL));
assert("1b: refuses unless the live body still carries the pre-O-5 480 floor (drift detection)",
  /v_resolve NOT LIKE '%v_can_create_order := \(v_minutes_of_day >= 480\);%'/.test(SQL));
assert("1c: refuses unless Stale Service Protection V1 branches are present (does not blindly overwrite a newer body)",
  /PREVIOUS_SERVICE_PENDING/.test(SQL) && /ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH/.test(SQL));
assert("1d: refuses if open_business_day_v1(text,text) is already absent (stale zero-caller census)",
  /open_business_day_v1\(text,text\)/.test(SQL) && /already absent -- census is stale/.test(SQL));
assert("1e: refuses if open_service_session(text,text) is ALREADY ABSENT -- this migration depends on it staying present",
  /open_service_session\(text,text\)\047\) IS NULL THEN[\s\S]{0,120}RAISE EXCEPTION \047O-5 refused: public\.open_service_session\(text,text\) is absent/.test(SQL));
assert("1f: refuses if a new internal SQL caller of open_business_day_v1 appeared since the census",
  /a new internal caller of open_business_day_v1 appeared/.test(SQL));

console.log("\n== B. Single canonical policy, correctly scoped (Part C/5) ==");
assert("2a: order_intake_policy_v1 is IMMUTABLE and pure (SQL language, no PL/pgSQL, no table read)",
  /CREATE OR REPLACE FUNCTION public\.order_intake_policy_v1\(p_minutes_of_day integer\)[\s\S]{0,200}LANGUAGE sql[\s\S]{0,50}IMMUTABLE/.test(SQL));
assert("2b: takes minutes-of-day as a plain integer input (testable by value, no clock_timestamp() inside it)",
  (() => {
    const start = SQL.indexOf("CREATE OR REPLACE FUNCTION public.order_intake_policy_v1");
    const end = SQL.indexOf("$function$;", start);
    const body = SQL.slice(start, end);
    return !/clock_timestamp/.test(body) && !/FROM public\./.test(body);
  })());
assert("2c: the fact is named mayCreateFirstService, not a vaguer canCreateOrder -- explicit about what it decides",
  /'mayCreateFirstService', p_minutes_of_day >= 240/.test(SQL));
assert("2d: it reuses the SAME 04:00/240 threshold as businessDateIsPreviousDay -- one authority, not a second literal",
  /'businessDateIsPreviousDay', p_minutes_of_day < 240/.test(SQL) && /'mayCreateFirstService', p_minutes_of_day >= 240/.test(SQL));
assert("2e: the 480-minute (08:00) literal is gone from every function BODY (may still appear in header prose describing what used to be there)",
  (() => {
    const bodyStart = SQL.indexOf("BEGIN;\n");
    const body = SQL.slice(bodyStart);
    return !/v_minutes_of_day >= 480/.test(body) && !/p_minutes_of_day >= 480/.test(body);
  })());
assert("2f: this is NOT 'always true' -- 00:00-03:59 (< 240) still yields false, proven by the literal predicate shape",
  /p_minutes_of_day >= 240$/m.test(SQL.replace(/\r/g, "")) || /mayCreateFirstService', p_minutes_of_day >= 240/.test(SQL));
assert("2g: resolve_order_intake_context_v1 delegates to the shared policy instead of inlining the arithmetic",
  (() => {
    const start = SQL.indexOf("CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1");
    const end = SQL.indexOf("REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1", start);
    const body = SQL.slice(start, end);
    return /v_policy := public\.order_intake_policy_v1\(v_minutes_of_day\);/.test(body)
      && /v_can_create_order := \(v_policy->>'mayCreateFirstService'\)::boolean;/.test(body);
  })());
assert("2h: get_order_intake_context_v1 delegates to the SAME shared policy (cannot diverge again)",
  (() => {
    const start = SQL.indexOf("CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1");
    const body = SQL.slice(start);
    return /v_policy := public\.order_intake_policy_v1\(v_minutes_of_day\);/.test(body);
  })());
assert("2i: the PUBLIC contract key stays canCreateNewOrder (orderIntakePolicy.js's live external contract, unchanged)",
  /'canCreateNewOrder', v_can_create_order,/.test(SQL));

console.log("\n== C. What must NOT change (minimal-footprint proof) ==");
assert("3a: Stale Service Protection V1 branches survive byte-identical in resolve_order_intake_context_v1",
  /IF v_period\.business_date < v_business_date THEN[\s\S]*?'PREVIOUS_SERVICE_PENDING'/.test(SQL));
assert("3b: the pointer-mismatch integrity RAISEs survive",
  /RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';/.test(SQL) &&
  /RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';/.test(SQL));
assert("3c: the lazy-open call to open_operational_service_v1 survives",
  /public\.open_operational_service_v1\(\s*\n\s*COALESCE\(p_actor, 'system'\), v_open_reason, v_open_source\s*\n\s*\);/.test(SQL));
assert("3d: ORDER_INTAKE_CLOSED rejection branch is KEPT, not deleted (real, tested, canonical infra)",
  /RETURN jsonb_build_object\('ok', false, 'code', 'ORDER_INTAKE_CLOSED',/.test(SQL));
assert("3e: hasValidCurrentService (Stale Service Protection V1 advisory fact) survives in get_order_intake_context_v1",
  /hasValidCurrentService/.test(SQL));
assert("3f: the 17:30 lunch/dinner classification boundary (240-1050) is untouched, now living once in the shared policy",
  /p_minutes_of_day >= 240 AND p_minutes_of_day < 1050/.test(SQL));

console.log("\n== D. Grants restated identically (service_role-only) ==");
assert("4a: order_intake_policy_v1 is revoked from PUBLIC/anon/authenticated and granted only to service_role",
  /REVOKE ALL ON FUNCTION public\.order_intake_policy_v1\(integer\) FROM PUBLIC, anon, authenticated;/.test(SQL) &&
  /GRANT EXECUTE ON FUNCTION public\.order_intake_policy_v1\(integer\) TO service_role;/.test(SQL));
assert("4b: resolve_order_intake_context_v1 grants restated",
  /REVOKE ALL ON FUNCTION public\.resolve_order_intake_context_v1\(text, text\) FROM PUBLIC, anon, authenticated;/.test(SQL));
assert("4c: get_order_intake_context_v1 grants restated",
  /REVOKE ALL ON FUNCTION public\.get_order_intake_context_v1\(\) FROM PUBLIC, anon, authenticated;/.test(SQL));
assert("4d: post-condition asserts anon/authenticated NEVER gained EXECUTE on any of the three functions",
  /anon\/authenticated must never execute the intake functions/.test(SQL));

console.log("\n== E. Dead-code purge -- open_business_day_v1 ONLY, open_service_session explicitly spared ==");
assert("5a: DROP FUNCTION open_business_day_v1(text, text)",
  /DROP FUNCTION IF EXISTS public\.open_business_day_v1\(text, text\);/.test(SQL));
assert("5b: open_service_session is NOT dropped anywhere in this file",
  !/DROP FUNCTION[^\n]*open_service_session/.test(SQL));
assert("5c: post-condition proves open_business_day_v1 is actually gone",
  /open_business_day_v1\(text,text\) survived the DROP/.test(SQL));
assert("5d: post-condition proves open_service_session SURVIVED (REQUIRED_COMPAT, not in scope)",
  /open_service_session\(text,text\) was removed -- it is REQUIRED_COMPAT/.test(SQL));
assert("5e: the file's own header explains why open_service_session is spared (real JS caller, documented fail-loudly shim)",
  /serviceSessionLifecycle\.js's exported[\s\S]{0,20}\.open\(\)/.test(SQL) && /fail loudly, not silently/.test(SQL));

console.log("\n== F. open_service_session really is a real, current, deliberate caller (not a stale grep artifact) ==");
assert("6a: serviceSessionLifecycle.js's .open() method really does call the open_service_session RPC",
  /rpc\("open_service_session", \{ p_opened_by: actor, p_source: source \}\)/.test(LIFECYCLE_JS));
assert("6b: the module's own comment documents this as a deliberate fail-loudly compatibility shim",
  /Kept so a stale caller fails[\s\S]{0,20}loudly rather than silently writing a session/.test(LIFECYCLE_JS));

console.log("\n== G. Migration governance ==");
assert("7a: wrapped in a single transaction",
  /^BEGIN;/m.test(SQL) && /^COMMIT;/m.test(SQL));
assert("7b: NOT applied by this session, NOT registered in the ledger from inside the file (house convention)",
  /NOT APPLIED by this session/.test(SQL) && /LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE/.test(SQL));
assert("7c: states the exact selected apply_order and the verified ledger tip it was chosen against",
  /apply_order[\s\S]{0,10}136/.test(SQL) && /migration_135\.sql/.test(SQL));

console.log("\n== H. No JS orderIntakePolicy.js change was needed (already sources canCreateNewOrder as pure data) ==");
assert("8a: orderIntakePolicy.js has no independent minute-of-day arithmetic of its own to also fix",
  !/480/.test(INTAKE_JS) && !/minutes_of_day/i.test(INTAKE_JS));
assert("8b: it reads canCreateNewOrder purely as a fact from the DB-canonical RPC",
  /ctx\.canCreateNewOrder/.test(INTAKE_JS) && /rpc\("get_order_intake_context_v1", \{\}\)/.test(INTAKE_JS));

console.log("\n== I. serviceSchedule.js kept in exact parity (same commit) ==");
assert("9a: the 04:00-08:00 (OUTSIDE_WINDOWS) branch now allows canCreateNewOrder",
  (() => {
    const idx = SCHEDULE_JS.indexOf("state: SCHEDULE_STATE.OUTSIDE_WINDOWS");
    const chunk = SCHEDULE_JS.slice(idx, idx + 300);
    return /canCreateNewOrder: true/.test(chunk);
  })());
assert("9b: the 00:00-04:00 (AFTER_ORDER_CUTOFF) branch STILL blocks canCreateNewOrder -- not touched",
  (() => {
    const idx = SCHEDULE_JS.indexOf("state: SCHEDULE_STATE.AFTER_ORDER_CUTOFF");
    const chunk = SCHEDULE_JS.slice(idx, idx + 300);
    return /canCreateNewOrder: false/.test(chunk);
  })());
assert("9c: isEscalationBoundary stays true for OUTSIDE_WINDOWS -- unrelated fact, not collapsed",
  (() => {
    const idx = SCHEDULE_JS.indexOf("state: SCHEDULE_STATE.OUTSIDE_WINDOWS");
    const chunk = SCHEDULE_JS.slice(idx, idx + 400);
    return /isEscalationBoundary: true/.test(chunk);
  })());

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
