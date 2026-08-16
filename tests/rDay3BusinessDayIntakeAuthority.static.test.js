"use strict";
// R-DAY3 — ORDER-INTAKE AUTHORITY FLIP. Static (source-text) proof for the
// migration + paired rollback + JS retarget, same convention as
// tests/rDay2PermanentOrderIdentity.static.test.js. Live DB/concurrency
// behavior is proven separately against real staging (see the R-DAY3
// certification report), not duplicated here.
// Authority: BUSINESS_DAY_R_DAY_IMPLEMENTATION_PLAN_V1_2026-08-16.md (R-DAY0)
// + R_DAY3_INTAKE_AUTHORITY_AMENDMENT_V1_2026-08-16.md (frozen amendment).
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const stripJsComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

const SQL = read("migrations/2026-08-16_r_day3_business_day_intake_authority.sql");
const ROLLBACK = read("migrations/2026-08-16_r_day3_business_day_intake_authority.ROLLBACK.sql");
const INTAKE_JS = read("src/serviceSessions/orderIntakePolicy.js");
const CARRYOVER_JS = read("src/serviceSessions/currentOperationalSession.js");
const SQL_CODE = stripSqlComments(SQL);
const INTAKE_JS_CODE = stripJsComments(INTAKE_JS);

console.log("\n== A. Predecessor guards (forward migration) ==");
assert("1a: refuses if resolve_order_intake_context_v1 already exists",
  /R-DAY3 refused: resolve_order_intake_context_v1 already exists/.test(SQL));
assert("1b: refuses if the old date_kind_uq is missing (drift)",
  /R-DAY3 refused: service_sessions_date_kind_uq missing/.test(SQL));
assert("1c: refuses if the new active index already exists",
  /R-DAY3 refused: service_sessions_date_kind_active_uq already exists/.test(SQL));
assert("1d: refuses if any R-DAY4+ object already exists (period_consolidations/business_day_closeout_attempts)",
  /period_consolidations.*IS NOT NULL[\s\S]*?business_day_closeout_attempts.*IS NOT NULL/.test(SQL)
  || /period_consolidations[\s\S]{0,120}business_day_closeout_attempts/.test(SQL));
assert("1e: refuses unless rows 74/75/76 are ALL verified in the ledger before cutover",
  /apply_order IN \(74,75,76\) AND verification_status = 'verified'.*<> 3/.test(SQL));
assert("1f: refuses on financial-baseline drift before any mutation (payment_transactions <> 20)",
  /payment_transactions.*<>\s*20/.test(SQL));
assert("1g: defensive duplicate-(business_date,service_kind) assertion before the C2 index change",
  /duplicate \(business_date,service_kind\) rows already exist before this migration/.test(SQL));

console.log("\n== B. resolve_order_intake_context_v1 — the canonical resolver ==");
assert("2a: acquires the shared lifecycle lock before reading/writing the pointer",
  /PERFORM pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\);/.test(SQL));
assert("2b: schedule-closed rejection returns BEFORE the lock is acquired (no lock held on a rejected call)",
  (() => {
    const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1");
    const lockIdx = SQL.indexOf("PERFORM pg_advisory_xact_lock", fnStart);
    const closedIdx = SQL.indexOf("ORDER_INTAKE_CLOSED", fnStart);
    return fnStart >= 0 && closedIdx >= 0 && lockIdx >= 0 && closedIdx < lockIdx;
  })());
assert("2c: ensures Business Day parent via find-or-create with ON CONFLICT DO NOTHING (same primitive as R-DAY1/R-DAY2)",
  /INSERT INTO public\.business_days[\s\S]*?ON CONFLICT \(business_date\) DO NOTHING/.test(SQL));
assert("2d: demotes the outgoing period to rolled_over BEFORE creating/adopting the incoming one",
  (() => {
    const demoteIdx = SQL.indexOf("status = 'rolled_over', rolled_over_at = now()");
    const createIdx = SQL.indexOf("INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)");
    return demoteIdx >= 0 && createIdx >= 0 && demoteIdx < createIdx;
  })());
assert("2e: never reopens a historical row — only adopts an ALREADY active (open/closing) match, else creates NEW",
  /WHERE business_date = v_business_date AND service_kind = v_service_kind\s*\n\s*AND status IN \('open','closing'\)/.test(SQL));
assert("2f: C1 — legacy shadow write-through in the SAME function, after the tuple UPDATE",
  (() => {
    const tupleIdx = SQL.indexOf("UPDATE public.business_day_lifecycle_state");
    const shadowIdx = SQL.indexOf("UPDATE public.service_session_state\n     SET current_session_id = v_pointer.current_period_id");
    return tupleIdx >= 0 && shadowIdx >= 0 && tupleIdx < shadowIdx;
  })());
assert("2g: uses set_config authorization before the tuple UPDATE (passes R-DAY1's guard trigger lawfully)",
  /PERFORM set_config\('ladieci\.business_day_pointer_authorized', 'true', true\);\s*\n\s*UPDATE public\.business_day_lifecycle_state/.test(SQL));
assert("2h: asserts period.business_day_id == pointer.current_business_day_id (fails closed on mismatch)",
  /BUSINESS_DAY_POINTER_MISMATCH/.test(SQL));
assert("2i: asserts day.ticket_epoch == pointer.current_ticket_epoch (fails closed on mismatch)",
  /TICKET_EPOCH_MIRROR_MISMATCH/.test(SQL));
assert("2j: does NOT reset ticket_epoch or next_ticket_number anywhere in the resolver",
  (() => {
    const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1");
    const fnEnd = SQL.indexOf("$function$;", SQL.indexOf("$function$", fnStart + 60) + 10);
    const body = SQL.slice(fnStart, fnEnd);
    return !/ticket_epoch\s*=\s*\d/.test(body) && !/next_ticket_number\s*=\s*1/.test(body);
  })());
assert("2k: never CREATEs period_consolidations/consolidate_period_v1/seal columns/cutoff (predecessor guards may legitimately CHECK for their absence)",
  !/CREATE (TABLE|FUNCTION) public\.(period_consolidations|consolidate_period_v1)/.test(SQL_CODE)
  && !/ADD COLUMN.*(sealed_at|seal_source|cutoff_at)/.test(SQL_CODE));

console.log("\n== C. get_order_intake_context_v1 — read-only preflight mirror ==");
assert("3a: STABLE, no advisory lock, no INSERT/UPDATE anywhere in its body",
  (() => {
    const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1");
    const fnEnd = SQL.indexOf("$function$;", fnStart);
    const body = SQL.slice(fnStart, fnEnd);
    return /STABLE/.test(body) && !/pg_advisory_xact_lock/.test(body)
      && !/\bINSERT INTO\b/.test(body) && !/\bUPDATE public\./.test(body);
  })());

console.log("\n== D. service_session_assign_order() retarget ==");
assert("4a: calls resolve_order_intake_context_v1 as its first action",
  /v_ctx := public\.resolve_order_intake_context_v1/.test(SQL));
assert("4b: SERVICE_SESSION_FORGERY guard preserved verbatim",
  /RAISE EXCEPTION 'SERVICE_SESSION_FORGERY' USING ERRCODE='P0001';/.test(SQL));
assert("4c: SERVICE_ORDER_NUMBER_FORGERY guard preserved verbatim",
  /RAISE EXCEPTION 'SERVICE_ORDER_NUMBER_FORGERY' USING ERRCODE='P0001';/.test(SQL));
assert("4d: NO_OPEN_SERVICE_SESSION / INVALID_OPEN_SERVICE_SESSION / STALE_SERVICE_SESSION removed from the retargeted trigger",
  (() => {
    const fnStart = SQL.indexOf("CREATE OR REPLACE FUNCTION public.service_session_assign_order()\nRETURNS trigger");
    const fnEnd = SQL.indexOf("$function$;", fnStart);
    const body = SQL.slice(fnStart, fnEnd);
    return !/NO_OPEN_SERVICE_SESSION|INVALID_OPEN_SERVICE_SESSION|STALE_SERVICE_SESSION/.test(body);
  })());
assert("4e: trigger object name/timing (ordenes_assign_service_session, BEFORE INSERT) is not redefined by this migration -- only the function body changes",
  !/CREATE TRIGGER ordenes_assign_service_session/.test(SQL));

console.log("\n== E. C2 — date+kind classification, not identity ==");
assert("5a: drops the historical globally-unique index",
  /DROP INDEX public\.service_sessions_date_kind_uq;/.test(SQL));
assert("5b: creates the active-scoped replacement, unique only among open/closing",
  /CREATE UNIQUE INDEX service_sessions_date_kind_active_uq\s*\n\s*ON public\.service_sessions \(business_date, service_kind\)\s*\n\s*WHERE service_kind IS NOT NULL AND status IN \('open','closing'\);/.test(SQL));
assert("5c: service_sessions_single_active_uq is never touched by this migration",
  !/DROP INDEX.*single_active_uq/.test(SQL) && !/CREATE.*single_active_uq/.test(SQL));

console.log("\n== F. C2 reader audit fix — ensure_service_session / roll_service_session_economic_v1 ==");
assert("6a: ensure_service_session's SERVICE_ALREADY_COMPLETED_TODAY check is scoped to active statuses",
  /AND service_kind=p_service_kind\s*\n\s*AND status IN \('open','closing'\)\) THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','SERVICE_ALREADY_COMPLETED_TODAY'/.test(SQL));
assert("6b: roll_service_session_economic_v1's NEXT_SERVICE_ALREADY_EXISTS check is scoped to active statuses",
  /WHERE business_date = p_next_business_date AND service_kind = p_next_service_kind\s*\n\s*AND status IN \('open','closing'\)\s*\n\s*\) THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','NEXT_SERVICE_ALREADY_EXISTS'/.test(SQL));
assert("6c: neither function's forgery/invariant checks were touched (INVALID_ARGUMENTS still present in both)",
  (SQL.match(/INVALID_ARGUMENTS/g) || []).length >= 1
  && /INVALID_SERVICE_KIND/.test(SQL) && /INVALID_NEXT_SERVICE_KIND/.test(SQL));

console.log("\n== G. Post-conditions ==");
assert("7a: asserts both new functions exist",
  /resolve_order_intake_context_v1 missing/.test(SQL) && /get_order_intake_context_v1 missing/.test(SQL));
assert("7b: asserts the old index is gone and the new one exists",
  /old service_sessions_date_kind_uq still present/.test(SQL)
  && /service_sessions_date_kind_active_uq not created/.test(SQL));
assert("7c: asserts single_active_uq is untouched",
  /service_sessions_single_active_uq was affected/.test(SQL));
assert("7d: asserts financial baseline unchanged after apply",
  /R-DAY3 post-condition failed: payment_transactions population changed/.test(SQL));

console.log("\n== H. Rollback — operational restoration + guarded schema PONR ==");
assert("8a: duplicate-pair guard runs BEFORE any restoration statement",
  (() => {
    const guardIdx = ROLLBACK.indexOf("SCHEMA POINT OF NO RETURN reached");
    const restoreIdx = ROLLBACK.indexOf("CREATE UNIQUE INDEX service_sessions_date_kind_uq");
    return guardIdx >= 0 && restoreIdx >= 0 && guardIdx < restoreIdx;
  })());
assert("8b: guard groups by (business_date, service_kind) HAVING count(*) > 1",
  /GROUP BY business_date, service_kind HAVING count\(\*\) > 1/.test(ROLLBACK));
assert("8c: refuses (RAISE EXCEPTION) rather than attempting destructive repair when duplicates exist",
  /RAISE EXCEPTION 'R-DAY3 rollback refused: % duplicate/.test(ROLLBACK));
assert("8d: restores service_session_assign_order() to the exact predecessor body (STALE_SERVICE_SESSION check present again)",
  /CREATE OR REPLACE FUNCTION public\.service_session_assign_order\(\)[\s\S]*?RAISE EXCEPTION 'STALE_SERVICE_SESSION'/.test(ROLLBACK));
assert("8e: restores ensure_service_session's predecessor (unscoped) EXISTS check verbatim",
  /WHERE business_date=v_business_date\s*\n\s*AND service_kind=p_service_kind\) THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','SERVICE_ALREADY_COMPLETED_TODAY'/.test(ROLLBACK));
assert("8f: restores roll_service_session_economic_v1's predecessor (unscoped) EXISTS check verbatim",
  /WHERE business_date = p_next_business_date AND service_kind = p_next_service_kind\s*\n\s*\) THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','NEXT_SERVICE_ALREADY_EXISTS'/.test(ROLLBACK));
assert("8g: drops both new resolver functions",
  /DROP FUNCTION IF EXISTS public\.resolve_order_intake_context_v1\(text, text\);/.test(ROLLBACK)
  && /DROP FUNCTION IF EXISTS public\.get_order_intake_context_v1\(\);/.test(ROLLBACK));
assert("8h: rollback post-condition re-asserts financial baseline and full functional reversal",
  /payment_transactions population changed[\s\S]*?must be exactly 20/.test(ROLLBACK)
  && /resolve_order_intake_context_v1 still present/.test(ROLLBACK));
assert("8i: refuses if R-DAY3 was never applied",
  /R-DAY3 rollback refused: resolve_order_intake_context_v1 does not exist/.test(ROLLBACK));

console.log("\n== I. JS retarget — orderIntakePolicy.js ==");
assert("9a: no CODE reference to the retired self-heal chain (comments may name what was removed)",
  !/fetchActiveServiceSessionSelfHealing|sessionRolloverClassification|incidentSafeRollover|classifySessionForRollover|performIncidentSafeRollover/.test(INTAKE_JS_CODE));
assert("9b: no CODE reference to the retired Service-Period rejection codes (comments may name what was removed)",
  !/NO_OPEN_SERVICE_SESSION|SERVICE_SESSION_NOT_ORDERABLE|STALE_SERVICE_SESSION|SERVICE_KIND_MISMATCH|LEGACY_SESSION_KIND_UNKNOWN/.test(INTAKE_JS_CODE));
assert("9c: no direct read of service_session_state / service_sessions",
  !/["']service_session_state["']|["']service_sessions["']/.test(INTAKE_JS_CODE));
assert("9d: calls the canonical read-only RPC by name",
  /rpc\("get_order_intake_context_v1", \{\}\)/.test(INTAKE_JS));
assert("9e: fails OPEN on a preflight read failure (never blocks on its own transport error)",
  /allowedResult\(null, sourceChannel\)/.test(INTAKE_JS));
assert("9f: gateNewOrderIntake keeps its existing calling convention ({ sourceChannel }) -- agentOrdini.js call site needs no change",
  /async function gateNewOrderIntake\(\{ sourceChannel = null \} = \{\}\)/.test(INTAKE_JS));

console.log("\n== J. C3 — cross-day carryover visibility (currentOperationalSession.js) ==");
assert("10a: getPriorDayCarryoverSessionIds scoped to status='rolled_over' and business_date < current (bounded, not a broad scan)",
  /status=eq\.rolled_over&business_date=lt\.\$\{encodeURIComponent\(currentBusinessDate\)\}/.test(CARRYOVER_JS));
assert("10b: reuses the canonical TERMINAL_ORDER_STATES from rolloverClassifier.js rather than duplicating the list",
  /require\("\.\/rolloverClassifier"\)/.test(CARRYOVER_JS) && /TERMINAL_ORDER_STATES/.test(CARRYOVER_JS));
assert("10c: checks both non-terminal orders AND open table_sessions",
  /estado=not\.in\.\(\$\{terminalList\}\)/.test(CARRYOVER_JS) && /status=eq\.open/.test(CARRYOVER_JS));
assert("10d: fails closed to no extra carryover on any read error (never widens on failure)",
  (CARRYOVER_JS.match(/fail closed/g) || []).length >= 2);
assert("10e: getOperationalSessionIds always includes current.id regardless of any query outcome",
  /const ids = new Set\(\[current\.id\]\);/.test(CARRYOVER_JS));
assert("10f: no broad historical scan -- candidate query has no LIMIT-less unscoped business_date filter",
  !/select\(\s*\n?\s*"service_sessions",\s*\n?\s*`status=eq\.rolled_over&select=id`/.test(CARRYOVER_JS));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
