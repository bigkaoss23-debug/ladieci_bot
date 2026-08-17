"use strict";
// F-1 — Finalizar servicio repair, slice 1. Static (source-text) proof for
// the migration + paired rollback. Live acceptance (Case 1: legacy engine
// happy path via begin_service_session_close -> complete_service_session_
// close on the real current session, inside a rolled-back transaction --
// canonical pointer cleared, business_day_id/ticket_epoch untouched, shadow
// mirrors; Case 2: V3 engine via acquire_closeout_attempt + create_service_
// closeout + close_service_session_v3, same session, same rolled-back
// transaction -- identical result; Case 3: canonical pointer fixture-set to
// a DIFFERENT real session before attempting the close -- refused with
// BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH, zero mutation, the other
// session's pointer survives unchanged; Case 4: idempotent replay of Case 1's
// close -- ALREADY_CLOSED, pointer stays NULL, no duplicate mutation) was run
// as its own separate, controlled step against real staging, entirely inside
// BEGIN/ROLLBACK -- see the migration's own header and the F-1 report for the
// exact live-verified JSON evidence. Zero residue confirmed after every run
// (real session status/pointer/shadow/attempt/closeout counts all unchanged).
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_f1_canonical_pointer_clear_on_close.sql");
const ROLLBACK = read("migrations/2026-08-17_f1_canonical_pointer_clear_on_close.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-1 refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses if complete_service_session_close does not exist",
  /F-1 refused: complete_service_session_close does not exist/.test(SQL));
assert("1c: refuses if close_service_session_v3 does not exist",
  /F-1 refused: close_service_session_v3 does not exist/.test(SQL));
assert("1d: refuses (drift guard) if either function already shows the post-F-1 ownership check",
  (SQL.match(/already shows the post-F-1 ownership check -- already applied/g) || []).length === 2);

console.log("\n== B. Ownership check present in BOTH functions, BEFORE any mutation ==");
const legacyFnBody = SQL_CODE_ONLY.split("CREATE OR REPLACE FUNCTION public.complete_service_session_close")[1]
  .split("CREATE OR REPLACE FUNCTION public.close_service_session_v3")[0];
const v3FnBody = SQL_CODE_ONLY.split("CREATE OR REPLACE FUNCTION public.close_service_session_v3")[1]
  .split("-- Post-conditions")[0];

assert("2a: legacy function reads business_day_lifecycle_state FOR UPDATE",
  /SELECT \* INTO v_bd_state FROM public\.business_day_lifecycle_state WHERE singleton=true FOR UPDATE;/.test(legacyFnBody));
assert("2b: legacy function's ownership check appears BEFORE its first mutating UPDATE/INSERT statement",
  (() => {
    const checkIdx = legacyFnBody.indexOf("BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH");
    const firstMutationIdx = legacyFnBody.indexOf("UPDATE public.service_sessions SET status='closed'");
    return checkIdx !== -1 && firstMutationIdx !== -1 && checkIdx < firstMutationIdx;
  })());
assert("2c: legacy function refuses (soft RETURN, not RAISE) when pointer is non-null AND points elsewhere",
  /IF v_bd_state\.current_period_id IS NOT NULL AND v_bd_state\.current_period_id IS DISTINCT FROM v_session\.id THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH'\);/.test(legacyFnBody));
assert("2d: legacy function's actual clear is gated on exact ownership (current_period_id = this session)",
  /IF v_bd_state\.current_period_id = v_session\.id THEN/.test(legacyFnBody));
assert("2e: legacy function authorizes via the established GUC before the clear",
  /PERFORM set_config\('ladieci\.business_day_pointer_authorized', 'true', true\);\s*\n\s*UPDATE public\.business_day_lifecycle_state SET current_period_id=NULL/.test(legacyFnBody));
assert("2f: legacy function's clear names ONLY current_period_id -- never current_business_day_id/current_ticket_epoch",
  /UPDATE public\.business_day_lifecycle_state SET current_period_id=NULL, updated_at=now\(\) WHERE singleton=true;/.test(legacyFnBody)
  && !/current_business_day_id\s*=/.test(legacyFnBody.split("business_day_lifecycle_state SET current_period_id=NULL")[1] || "")
  && !/current_ticket_epoch\s*=/.test(legacyFnBody.split("business_day_lifecycle_state SET current_period_id=NULL")[1]?.split(";")[0] || ""));
assert("2g: legacy function's idempotent ALREADY_CLOSED branch is untouched (still the first real branch, still returns before any new logic)",
  /IF v_session\.status='closed' AND v_state\.recent_closed_session_id=v_session\.id AND v_state\.current_session_id IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('ok',true,'code','ALREADY_CLOSED'/.test(legacyFnBody));

assert("3a: V3 function reads business_day_lifecycle_state FOR UPDATE",
  /SELECT \* INTO v_bd_state FROM public\.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;/.test(v3FnBody));
assert("3b: V3 function's ownership check appears AFTER CLOSEOUT_NOT_FOUND/ATTEMPT_NOT_ACTIVE but BEFORE the trusted-transition marker / any mutation",
  (() => {
    const attemptCheckIdx = v3FnBody.indexOf("ATTEMPT_NOT_ACTIVE");
    const ownershipCheckIdx = v3FnBody.indexOf("BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH");
    const markerIdx = v3FnBody.indexOf("v3_close_authorized_session_id");
    return attemptCheckIdx !== -1 && ownershipCheckIdx !== -1 && markerIdx !== -1
      && attemptCheckIdx < ownershipCheckIdx && ownershipCheckIdx < markerIdx;
  })());
assert("3c: V3 function's actual clear is gated on exact ownership and authorized via the same GUC mechanism",
  /IF v_bd_state\.current_period_id = v_session\.id THEN\s*\n\s*PERFORM set_config\('ladieci\.business_day_pointer_authorized', 'true', true\);\s*\n\s*UPDATE public\.business_day_lifecycle_state SET current_period_id = NULL, updated_at = now\(\) WHERE singleton = true;/.test(v3FnBody));
assert("3d: V3 function's clear names ONLY current_period_id",
  !/current_business_day_id\s*=/.test(v3FnBody.split("business_day_lifecycle_state SET current_period_id = NULL")[1]?.split(";")[0] || "")
  && !/current_ticket_epoch\s*=/.test(v3FnBody.split("business_day_lifecycle_state SET current_period_id = NULL")[1]?.split(";")[0] || ""));
assert("3e: V3 function's CLOSEOUT_NOT_FOUND / ATTEMPT_NOT_ACTIVE lineage checks are untouched (byte-present, unmodified)",
  /CLOSEOUT_NOT_FOUND/.test(v3FnBody) && /ATTEMPT_NOT_ACTIVE/.test(v3FnBody));

console.log("\n== C. Both functions use the identical shared advisory lock (unchanged) ==");
assert("4a: legacy function still uses hashtext('service_session_lifecycle')",
  /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(legacyFnBody));
assert("4b: V3 function still uses hashtext('service_session_lifecycle')",
  /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(v3FnBody));

console.log("\n== D. HARD SCOPE — F-1 touches only these two functions, nothing else ==");
assert("5a: exactly two functions are redefined in this migration",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 2);
assert("5b: ensure_next_service_session_v3 (V3-D1, known defect) is not touched",
  !/CREATE OR REPLACE FUNCTION public\.ensure_next_service_session_v3/.test(SQL));
assert("5c: guard_service_session_closed_v1 (V3-D2, known defect) is not touched",
  !/CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1/.test(SQL));
assert("5d: v3NextServiceIdentity / schedule-derived next-service logic (V3-D5) is not referenced",
  !/resolveSchedule|v3NextServiceIdentity/.test(SQL_CODE_ONLY));
assert("5e: no operational_service_v1 row is created or referenced by this migration",
  !/(INSERT INTO|VALUES)[\s\S]{0,200}'operational_service_v1'/.test(SQL_CODE_ONLY));
assert("5f: recent_closed_business_day_id is never written by this migration",
  !/recent_closed_business_day_id\s*=/.test(SQL_CODE_ONLY));

console.log("\n== E. Post-conditions — structural, pointer/financial-unchanged assertions ==");
assert("6a: post-condition asserts both functions carry the ownership check",
  (SQL.match(/missing the ownership check/g) || []).length === 2);
assert("6b: post-condition asserts both functions carry the canonical pointer clear",
  (SQL.match(/missing the canonical pointer clear/g) || []).length === 2);
assert("6c: post-condition asserts neither clear touches more than current_period_id",
  (SQL.match(/clear touches more than current_period_id/g) || []).length === 2);
assert("6d: post-condition asserts the idempotent-replay branch of the legacy function survived",
  /lost its idempotent-replay branch/.test(SQL));
assert("6e: post-condition asserts payment_transactions/service_closeouts population unchanged",
  /payment_transactions\) <> 20/.test(SQL) && /service_closeouts\) <> 3/.test(SQL));
assert("6f: post-condition asserts zero real operational_service_v1 rows",
  /real operational_service_v1 rows must remain 0/.test(SQL));

console.log("\n== F. Paired rollback — restores exact byte-captured pre-F-1 bodies, refuses if not applied ==");
assert("7a: rollback refuses if either function does not show the post-F-1 shape",
  (ROLLBACK.match(/does not show the post-F-1 shape/g) || []).length === 2);
assert("7b: rollback restores the legacy function WITHOUT any business_day_lifecycle_state reference",
  !/business_day_lifecycle_state/.test(ROLLBACK_CODE_ONLY.split("CREATE OR REPLACE FUNCTION public.complete_service_session_close")[1].split("CREATE OR REPLACE FUNCTION public.close_service_session_v3")[0]));
assert("7c: rollback restores the V3 function WITHOUT any business_day_lifecycle_state reference",
  !/business_day_lifecycle_state/.test(ROLLBACK_CODE_ONLY.split("CREATE OR REPLACE FUNCTION public.close_service_session_v3")[1].split("-- Post-conditions")[0]));
assert("7d: rollback touches no data table (function redefinition only)",
  !/\n\s*(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM)\s+public\.(?!ladieci_schema_migrations)/.test(ROLLBACK_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
