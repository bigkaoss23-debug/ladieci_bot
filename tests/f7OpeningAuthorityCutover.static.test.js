"use strict";
// F-7 — Finalizar servicio repair: opening authority cutover. Static
// (source-text) proof for the migration + paired rollback. Live acceptance
// (mandatory A-J fixture matrix + concurrency proof, all inside rolled-back
// transactions against real staging) is reported separately, not by this
// file. See tests/serviceSessionCreationSurface.static.test.js for the
// separate, generalized "hard gate" that replays every migration and
// asserts the CURRENT creation surface is exactly the expected 3 functions
// -- this file is scoped narrowly to F-7's own two targets.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-18_f7_opening_authority_cutover.sql");
const ROLLBACK = read("migrations/2026-08-18_f7_opening_authority_cutover.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards (forward migration) ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-7 refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses on ledger-head drift, exact expected value 91",
  /F-7 refused: ledger head is % \(expected 91\)/.test(SQL));
assert("1c: refuses if open_operational_service_v1 (F-6) does not exist",
  /F-7 refused: open_operational_service_v1 \(F-6\) does not exist/.test(SQL));
assert("1d: refuses if the pre-F-7 3-arg ensure_service_session is not found, byte-matched",
  /F-7 refused: ensure_service_session\(text,text,text\) not found/.test(SQL) &&
  /INSERT INTO public\.service_sessions\(' IN v_def_ensure\) = 0/.test(SQL_CODE_ONLY));
assert("1e: refuses if resolve_order_intake_context_v1's pre-F-7 direct-INSERT body is not found, byte-matched",
  /F-7 refused: resolve_order_intake_context_v1 does not match the expected pre-F-7 body/.test(SQL) &&
  /INSERT INTO public\.service_sessions \(business_date, service_kind, status, opened_by, open_source\)' IN v_def_resolve\) = 0/.test(SQL_CODE_ONLY));
assert("1f: refuses if the new 2-arg ensure_service_session already exists (drift guard)",
  /F-7 refused: ensure_service_session\(text,text\) already exists/.test(SQL));
assert("1g: refuses on financial/population baseline drift",
  /F-7 refused: a real operational_service_v1 session already exists/.test(SQL) &&
  /F-7 refused: payment_transactions population is % \(expected 20\)/.test(SQL) &&
  /F-7 refused: service_sessions population is % \(expected 13\)/.test(SQL));

console.log("\n== B. PART 1 -- ensure_service_session clean swap, exact frozen 2-arg signature ==");
assert("2a: DROP FUNCTION on the exact 3-arg signature (not CASCADE, not IF EXISTS -- fails loudly on drift)",
  /DROP FUNCTION public\.ensure_service_session\(text, text, text\);/.test(SQL_CODE_ONLY));
assert("2b: CREATE FUNCTION (not OR REPLACE -- the 3-arg overload was just dropped, this is a genuinely new signature)",
  /CREATE FUNCTION public\.ensure_service_session\(p_opened_by text, p_source text DEFAULT 'auto_entry'::text\)/.test(SQL_CODE_ONLY));
assert("2c: REVOKE ALL FROM PUBLIC, anon, authenticated on the new 2-arg signature",
  /REVOKE ALL ON FUNCTION public\.ensure_service_session\(text, text\) FROM PUBLIC, anon, authenticated;/.test(SQL_CODE_ONLY));
assert("2d: GRANT EXECUTE TO service_role only on the new 2-arg signature",
  /GRANT EXECUTE ON FUNCTION public\.ensure_service_session\(text, text\) TO service_role;/.test(SQL_CODE_ONLY));

const ensureBody = stripSqlComments(
  SQL.split("CREATE FUNCTION public.ensure_service_session")[1].split("$function$;")[0]
);
assert("2e: no INSERT anywhere in the new body",
  !/INSERT INTO/.test(ensureBody));
assert("2f: no PRANZO/SERA literal anywhere in the new body", // language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values named in this assertion's own description/regex, checking they are ABSENT from the function body, not new vocabulary
  !/PRANZO/.test(ensureBody) && !/SERA/.test(ensureBody));
assert("2g: never calls open_operational_service_v1 (read/reuse only, per the frozen brief)",
  !/open_operational_service_v1/.test(ensureBody));
assert("2h: an active session (any status !== closing) is REUSED, era-blind",
  /'ok', true, 'code', 'REUSED', 'created', false/.test(ensureBody));
assert("2i: no current Business Day OR pristine Business Day both resolve to NO_OPEN_SERVICE",
  (ensureBody.match(/'code', 'NO_OPEN_SERVICE'/g) || []).length === 2);
assert("2j: Business Day WITH history, no active session -> REOPEN_REQUIRED",
  /'code', 'REOPEN_REQUIRED'/.test(ensureBody));
assert("2k: the pre-existing MULTIPLE_ACTIVE_SERVICE_SESSIONS / SERVICE_SESSION_STATE_CORRUPT / SERVICE_SESSION_CLOSING defensive branches are preserved",
  /MULTIPLE_ACTIVE_SERVICE_SESSIONS/.test(ensureBody) &&
  /SERVICE_SESSION_STATE_CORRUPT/.test(ensureBody) &&
  /SERVICE_SESSION_CLOSING/.test(ensureBody));
assert("2l: still acquires the same shared advisory lock namespace",
  /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(ensureBody));

console.log("\n== C. PART 2 -- resolve_order_intake_context_v1 cutover ==");
const resolveBody = stripSqlComments(
  SQL.split("CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1")[1].split("$function$;")[0]
);
assert("3a: no direct INSERT INTO service_sessions anywhere in the new body",
  !/INSERT INTO public\.service_sessions\b/.test(resolveBody));
assert("3b: still INSERTs into business_days (Business Day resolution is unchanged, clock-derived, kept)",
  /INSERT INTO public\.business_days/.test(resolveBody));
assert("3c: calls open_operational_service_v1 with the exact frozen 'first_open_of_business_day' reason",
  /public\.open_operational_service_v1\(\s*COALESCE\(p_actor, 'system'\), 'first_open_of_business_day', COALESCE\(p_source, 'order_intake'\)/.test(resolveBody));
assert("3d: returns typed REOPEN_REQUIRED when history exists and nothing is active",
  /'code', 'REOPEN_REQUIRED'/.test(resolveBody));
assert("3e: the canonical Business Day pointer (current_business_day_id/current_ticket_epoch) is written BEFORE the primitive is ever called",
  resolveBody.indexOf("current_business_day_id = v_day.id") < resolveBody.indexOf("open_operational_service_v1("));
assert("3f: current_period_id is set in a SEPARATE, later UPDATE, only after v_period is finally known",
  resolveBody.indexOf("open_operational_service_v1(") < resolveBody.indexOf("current_period_id = v_pointer.current_period_id"));
assert("3g: the intake-window rule (v_can_create_order) is preserved, unchanged shape",
  /v_can_create_order := \(v_minutes_of_day >= 480 AND v_minutes_of_day < 1050\)\s*\n\s*OR \(v_minutes_of_day >= 1080\);/.test(resolveBody));
assert("3h: ORDER_INTAKE_CLOSED is still the typed reject for outside the intake window",
  /'code', 'ORDER_INTAKE_CLOSED'/.test(resolveBody));
assert("3i: v_service_kind is still computed and still returned (economic classification), never gates reuse/creation",
  /serviceKind', v_service_kind/.test(resolveBody));
assert("3j: reuse test is business_day_id-only, no service_kind comparison in the reuse condition",
  /IF FOUND AND v_period\.business_day_id = v_day\.id THEN/.test(resolveBody) &&
  !/v_period\.service_kind = v_service_kind/.test(resolveBody));
assert("3k: the pre-existing cross-day forgotten-close rollover (status='rolled_over') is preserved, unconditional, unchanged shape",
  /SET status = 'rolled_over', rolled_over_at = now\(\), updated_at = now\(\)\s*\n\s*WHERE id = v_period\.id;/.test(resolveBody));
assert("3l: the pointer/epoch integrity assertions (BUSINESS_DAY_POINTER_MISMATCH / TICKET_EPOCH_MIRROR_MISMATCH) are preserved",
  /BUSINESS_DAY_POINTER_MISMATCH/.test(resolveBody) && /TICKET_EPOCH_MIRROR_MISMATCH/.test(resolveBody));
assert("3m: the canonical context return shape is unchanged (businessDayId/businessDate/periodId/serviceKind/ticketEpoch/advanced)",
  /'businessDayId', v_day\.id,\s*\n\s*'businessDate', v_business_date,\s*\n\s*'periodId', v_period\.id,\s*\n\s*'serviceKind', v_service_kind,\s*\n\s*'ticketEpoch', v_day\.ticket_epoch,\s*\n\s*'advanced', v_period_needs_advance/.test(resolveBody));

console.log("\n== D. Post-conditions (forward migration) ==");
assert("4a: post-condition asserts the 3-arg overload is gone and the 2-arg exists",
  /F-7 post-condition failed: ensure_service_session\(text,text\) missing after swap/.test(SQL) &&
  /F-7 post-condition failed: the old 3-arg ensure_service_session overload still exists/.test(SQL));
assert("4b: post-condition text-scans ensure_service_session for the absence of INSERT/PRANZO/SERA/open_operational_service_v1", // language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values named in this assertion's own description/regex, checking they are ABSENT from the migration's post-condition text, not new vocabulary
  /F-7 post-condition failed: ensure_service_session still contains an INSERT/.test(SQL) && // language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values named in the assertion two lines above, checking they are ABSENT from the migration's post-condition text, not new vocabulary
  /F-7 post-condition failed: ensure_service_session still references PRANZO\/SERA identity/.test(SQL) &&
  /F-7 post-condition failed: ensure_service_session must never call open_operational_service_v1/.test(SQL));
assert("4c: post-condition text-scans resolve_order_intake_context_v1 for no direct INSERT + calls the primitive + returns REOPEN_REQUIRED",
  /F-7 post-condition failed: resolve_order_intake_context_v1 still directly INSERTs into service_sessions/.test(SQL) &&
  /F-7 post-condition failed: resolve_order_intake_context_v1 does not call open_operational_service_v1/.test(SQL) &&
  /F-7 post-condition failed: resolve_order_intake_context_v1 does not return REOPEN_REQUIRED/.test(SQL));
assert("4d: post-condition asserts the real active session was never mutated (status/lifecycle_semantics unchanged)",
  /F-7 post-condition failed: the real active session was mutated/.test(SQL));
assert("4e: post-condition asserts pointer/shadow/financial/population invariants unchanged",
  /F-7 post-condition failed: current_period_id changed unexpectedly by this migration/.test(SQL) &&
  /F-7 post-condition failed: legacy shadow changed unexpectedly by this migration/.test(SQL) &&
  /F-7 post-condition failed: payment_transactions population changed/.test(SQL) &&
  /F-7 post-condition failed: service_sessions population changed/.test(SQL));

console.log("\n== E. Transaction discipline (forward migration) ==");
assert("5a: exactly one BEGIN and one COMMIT",
  (SQL.match(/^BEGIN;$/gm) || []).length === 1 && (SQL.match(/^COMMIT;$/gm) || []).length === 1);

console.log("\n== F. Rollback -- PONR-guarded, restores both exact pre-F-7 bodies ==");
assert("6a: refuses if a real operational_service_v1 session exists (PONR guard)",
  /F-7 rollback refused: a real operational_service_v1 session exists/.test(ROLLBACK));
assert("6b: drops the 2-arg ensure_service_session, restores the 3-arg CREATE FUNCTION",
  /DROP FUNCTION IF EXISTS public\.ensure_service_session\(text, text\);/.test(ROLLBACK_CODE_ONLY) &&
  /CREATE FUNCTION public\.ensure_service_session\(p_opened_by text, p_service_kind text, p_source text DEFAULT 'auto_entry'::text\)/.test(ROLLBACK_CODE_ONLY));
assert("6c: restores resolve_order_intake_context_v1's exact pre-F-7 direct-INSERT body",
  /INSERT INTO public\.service_sessions \(business_date, service_kind, status, opened_by, open_source\)/.test(ROLLBACK_CODE_ONLY));
assert("6d: restored ensure_service_session re-grants the exact 3-arg signature",
  /GRANT EXECUTE ON FUNCTION public\.ensure_service_session\(text, text, text\) TO service_role;/.test(ROLLBACK_CODE_ONLY));
assert("6e: exactly one BEGIN and one COMMIT in the rollback",
  (ROLLBACK.match(/^BEGIN;$/gm) || []).length === 1 && (ROLLBACK.match(/^COMMIT;$/gm) || []).length === 1);

console.log("\n== G. Non-interference -- the other three legacy/dormant creators are byte-untouched ==");
for (const otherFn of ["roll_service_session_economic_v1", "ensure_next_service_session_v3", "open_operational_service_v1"]) {
  assert(`7: ${otherFn} is not redefined by this migration`,
    !new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${otherFn}`).test(SQL_CODE_ONLY));
}

console.log("\n== H. No new resource-policy registration, no new HTTP action wiring ==");
assert("8a: no supabaseResourcePolicy.js registration change for either target function",
  !/entry\('rpc\/ensure_service_session'.*text.*text.*text/.test(fs.readFileSync(path.join(__dirname, "..", "src", "utils", "supabaseResourcePolicy.js"), "utf8")));
assert("8b: index.js's openServiceSession action still delegates entirely to ensureCurrentServiceSession (no new direct RPC call introduced)",
  !/action === "openServiceSession"[\s\S]{0,400}rpc\(/.test(fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")));

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
