"use strict";
// F-6 — Finalizar servicio repair: DORMANT canonical Operational Service open
// primitive. Static (source-text) proof for the migration + paired rollback.
// Live acceptance (mandatory A-J fixture matrix + concurrency proof, all
// inside rolled-back transactions against real staging) is reported
// separately, not by this file. Zero table/column change in this slice --
// pure CREATE FUNCTION + REVOKE/GRANT, so there is no schema-shape section
// here the way F-4A/F-4B/F-4C's tests have one.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
// Same comment-stripping shape as tests/serviceLifecycleV3EngineLegacyNonInterference
// .static.test.js — section P's own checks are about FUNCTIONAL JS wiring
// (a real rpc(...) call site), not prose; F-7 legitimately names this RPC in
// explanatory comments once it becomes the real, sanctioned caller (via SQL,
// not JS), so a naive raw-substring scan would false-positive on that prose.
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

const SQL = read("migrations/2026-08-18_f6_open_operational_service_primitive.sql");
const ROLLBACK = read("migrations/2026-08-18_f6_open_operational_service_primitive.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards (forward migration) ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-6 refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses if the ledger table itself is missing",
  /F-6 refused: public\.ladieci_schema_migrations \(S4\) is missing/.test(SQL));
assert("1c: refuses on ledger-head drift, exact expected value 90",
  /F-6 refused: ledger head is % \(expected 90\)/.test(SQL) &&
  /IF \(SELECT max\(apply_order\) FROM public\.ladieci_schema_migrations\) <> 90 THEN/.test(SQL_CODE_ONLY));
assert("1d: refuses if predecessor foundation tables are missing",
  /F-6 refused: predecessor foundation \(R-DAY1 \/ S-A\/S-B\) missing/.test(SQL));
assert("1e: refuses if service_sessions.lifecycle_semantics (S-B) is missing",
  /F-6 refused: service_sessions\.lifecycle_semantics \(S-B\) missing/.test(SQL));
assert("1f: refuses if open_operational_service_v1 already exists (drift guard)",
  /F-6 refused: public\.open_operational_service_v1 already exists/.test(SQL) &&
  /to_regprocedure\('public\.open_operational_service_v1\(text,text,text\)'\) IS NOT NULL/.test(SQL_CODE_ONLY));
assert("1g: refuses if a real operational_service_v1 session already exists",
  /F-6 refused: a real operational_service_v1 session already exists/.test(SQL));
assert("1h: refuses on financial-population drift (payment_transactions <> 20)",
  /F-6 refused: payment_transactions population is % \(expected 20\)/.test(SQL));
assert("1i: refuses on service_sessions population drift (<> 13)",
  /F-6 refused: service_sessions population is % \(expected 13\)/.test(SQL));

console.log("\n== B. Function shape -- exact frozen signature, no defaults ==");
assert("2a: CREATE OR REPLACE FUNCTION public.open_operational_service_v1 with the exact frozen 3-arg signature",
  /CREATE OR REPLACE FUNCTION public\.open_operational_service_v1\(\s*p_opened_by\s+text,\s*p_open_reason\s+text,\s*p_source\s+text\s*\) RETURNS jsonb/.test(SQL_CODE_ONLY));
assert("2b: no DEFAULT value anywhere in the signature (no implicit mode)",
  !/CREATE OR REPLACE FUNCTION public\.open_operational_service_v1\([^)]*DEFAULT/i.test(SQL_CODE_ONLY.slice(
    SQL_CODE_ONLY.indexOf("CREATE OR REPLACE FUNCTION public.open_operational_service_v1"),
    SQL_CODE_ONLY.indexOf("RETURNS jsonb", SQL_CODE_ONLY.indexOf("CREATE OR REPLACE FUNCTION public.open_operational_service_v1"))
  )));
assert("2c: LANGUAGE plpgsql, SET search_path (matches every other lifecycle RPC in this repo)",
  /LANGUAGE plpgsql\s*\n\s*SET search_path TO 'public', 'pg_temp'/.test(SQL_CODE_ONLY));
assert("2d: REVOKE ALL FROM PUBLIC, anon, authenticated",
  /REVOKE ALL ON FUNCTION public\.open_operational_service_v1\(text, text, text\) FROM PUBLIC, anon, authenticated;/.test(SQL_CODE_ONLY));
assert("2e: GRANT EXECUTE TO service_role only",
  /GRANT EXECUTE ON FUNCTION public\.open_operational_service_v1\(text, text, text\) TO service_role;/.test(SQL_CODE_ONLY));

const fnBody = stripSqlComments(
  SQL.split("CREATE OR REPLACE FUNCTION public.open_operational_service_v1")[1]
     .split("$function$;")[0]
);

console.log("\n== C. Argument validation -- fail-closed, no defaults, exact typed codes ==");
assert("3a: rejects null/blank p_opened_by with INVALID_ACTOR",
  /IF p_opened_by IS NULL OR btrim\(p_opened_by\) = '' THEN/.test(fnBody) &&
  /'code', 'INVALID_ACTOR'/.test(fnBody));
assert("3b: rejects any p_open_reason other than the exact two allowed values, with INVALID_OPEN_REASON",
  /IF p_open_reason IS NULL OR p_open_reason NOT IN \('first_open_of_business_day', 'explicit_reopen'\) THEN/.test(fnBody) &&
  /'code', 'INVALID_OPEN_REASON'/.test(fnBody));
assert("3c: rejects null/blank p_source with INVALID_SOURCE",
  /IF p_source IS NULL OR btrim\(p_source\) = '' THEN/.test(fnBody) &&
  /'code', 'INVALID_SOURCE'/.test(fnBody));
assert("3d: argument validation happens BEFORE the advisory lock is acquired (fast-fail, no lock contention on bad input)",
  fnBody.indexOf("INVALID_SOURCE") < fnBody.indexOf("pg_advisory_xact_lock"));

console.log("\n== D. Lock / authority -- reuses the existing lifecycle lock and pointer GUC, invents nothing new ==");
assert("4a: acquires the SAME advisory lock namespace as every other lifecycle RPC",
  /PERFORM pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\);/.test(fnBody));
assert("4b: locks business_day_lifecycle_state singleton FOR UPDATE",
  /SELECT \* INTO v_bd_state FROM public\.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;/.test(fnBody));
assert("4c: locks service_session_state singleton FOR UPDATE",
  /SELECT \* INTO v_ss_state FROM public\.service_session_state\s+WHERE singleton = true FOR UPDATE;/.test(fnBody));
assert("4d: uses the pre-existing ladieci.business_day_pointer_authorized GUC, not a new lock/flag",
  /PERFORM set_config\('ladieci\.business_day_pointer_authorized', 'true', true\);/.test(fnBody));
assert("4e: no new pg_advisory_xact_lock namespace/hashtext argument introduced anywhere in the body",
  (fnBody.match(/pg_advisory_xact_lock/g) || []).length === 1);
assert("4f: no new GUC/set_config name introduced -- only the one pre-existing pointer-authorization flag is set",
  (fnBody.match(/set_config\(/g) || []).length === 1);

console.log("\n== E. Canonical Business Day requirement -- never trusts a client-supplied id, never invents one ==");
assert("5a: p_business_day_id is not a parameter of this function (no client-supplied business day)",
  !/p_business_day_id/.test(fnBody));
assert("5b: reads business_day_lifecycle_state.current_business_day_id as the sole authority",
  /IF v_bd_state\.current_business_day_id IS NULL THEN/.test(fnBody));
assert("5c: NO_CURRENT_BUSINESS_DAY typed rejection when no canonical Business Day exists",
  /'code', 'NO_CURRENT_BUSINESS_DAY'/.test(fnBody));
assert("5d: never INSERTs into public.business_days (does not silently invent a Business Day)",
  !/INSERT INTO public\.business_days/.test(fnBody));
assert("5e: defensive BUSINESS_DAY_NOT_FOUND branch if the pointer references a row that vanished",
  /'code', 'BUSINESS_DAY_NOT_FOUND'/.test(fnBody));

console.log("\n== F. State discriminator -- global active-service check + per-day has_any_service, both DB-derived ==");
assert("6a: active-service SELECT is unscoped by business_day_id (correct, given service_sessions_single_active_uq is GLOBAL)",
  /SELECT \* INTO v_active FROM public\.service_sessions WHERE status IN \('open', 'closing'\) FOR UPDATE;/.test(fnBody));
assert("6b: an active service under a DIFFERENT business day than canonical is a typed reject, not silently trusted",
  /'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH'/.test(fnBody));
assert("6c: an active service under the SAME business day is REUSED, created:false, regardless of requested reason",
  /'ok', true, 'code', 'REUSED', 'created', false/.test(fnBody));
assert("6d: has_any_service is computed via EXISTS(... WHERE business_day_id = v_day.id), no other predicate",
  /v_has_any := EXISTS \(SELECT 1 FROM public\.service_sessions WHERE business_day_id = v_day\.id\);/.test(fnBody));

console.log("\n== G. Rule A (first_open_of_business_day) / Rule B (explicit_reopen) -- DB-validated, mutually exclusive ==");
assert("7a: first_open_of_business_day + has_any_service=true -> SERVICE_REOPEN_REQUIRED",
  /IF p_open_reason = 'first_open_of_business_day' THEN\s*IF v_has_any THEN\s*RETURN jsonb_build_object\('ok', false, 'code', 'SERVICE_REOPEN_REQUIRED'\);/.test(fnBody));
assert("7b: explicit_reopen + has_any_service=false -> NO_PRIOR_SERVICE_TO_REOPEN",
  /IF NOT v_has_any THEN\s*RETURN jsonb_build_object\('ok', false, 'code', 'NO_PRIOR_SERVICE_TO_REOPEN'\);/.test(fnBody));
assert("7c: exactly one INSERT INTO service_sessions in the whole function (both lawful branches converge on the same single writer)",
  (fnBody.match(/INSERT INTO public\.service_sessions/g) || []).length === 1);

console.log("\n== H. Target row shape -- era-correct, no clock/kind identity, no counters ==");
const insertStmt = fnBody.slice(fnBody.indexOf("INSERT INTO public.service_sessions"), fnBody.indexOf("RETURNING * INTO v_new;") + "RETURNING * INTO v_new;".length);
assert("8a: INSERT column list is exactly business_date, status, opened_by, open_source, service_kind, lifecycle_semantics",
  /business_date, status, opened_by, open_source, service_kind, lifecycle_semantics/.test(insertStmt));
assert("8b: service_kind is explicitly NULL (never a bare omission relying on a nullable default)",
  /v_day\.business_date, 'open', p_opened_by, p_source, NULL, 'operational_service_v1'/.test(insertStmt));
assert("8c: lifecycle_semantics is explicitly 'operational_service_v1' (matches S-B's era-pairing CHECK)",
  /'operational_service_v1'/.test(insertStmt));
assert("8d: business_date comes from v_day (the canonical business day row), never clock_timestamp()/now()",
  /v_day\.business_date/.test(insertStmt) && !/clock_timestamp|now\(\)/.test(insertStmt));
assert("8e: next_order_number is never listed in the INSERT column list (default 1 applies untouched, no counter written)",
  !/next_order_number/.test(insertStmt));
assert("8f: ticket_epoch is never referenced anywhere in the function body (no Business Day counter written)",
  !/ticket_epoch/.test(fnBody));
assert("8g: business_days.next_ticket_number is never referenced (no counter written)",
  !/next_ticket_number/.test(fnBody));

console.log("\n== I. No clock/service_kind identity logic (forbidden per the frozen brief) ==");
// language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values this check asserts are ABSENT from the new primitive's body, not new vocabulary being introduced
assert("9a: no clock_timestamp() call anywhere in the function body",
  !/clock_timestamp/.test(fnBody));
assert("9b: no PRANZO/SERA literal anywhere in the function body", // language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values named in this assertion's own description/regex, checking they are ABSENT from the function body, not new vocabulary
  !/PRANZO/.test(fnBody) && !/SERA/.test(fnBody));
assert("9c: p_service_kind is not a parameter of this function (kind is never client-suppliable)",
  !/p_service_kind/.test(fnBody));
assert("9d: no resolveSchedule/resolveEconomicPeriod call anywhere in the function body",
  !/resolveSchedule|resolveEconomicPeriod/.test(fnBody));
assert("9e: rollover_source_session_id is never written by this function (audited: overloaded for economic rollover only, not a generic predecessor pointer -- see migration header)",
  !/rollover_source_session_id/.test(fnBody));

console.log("\n== J. Pointer / shadow write -- exact partial-column UPDATE, asserted afterward, nothing else touched ==");
assert("10a: business_day_lifecycle_state UPDATE touches ONLY current_period_id (+ updated_at) -- current_business_day_id/current_ticket_epoch preserved",
  /UPDATE public\.business_day_lifecycle_state\s*SET current_period_id = v_new\.id, updated_at = now\(\)\s*WHERE singleton = true;/.test(fnBody));
assert("10b: service_session_state UPDATE touches ONLY current_session_id (+ updated_at) -- recent_closed_session_id preserved",
  /UPDATE public\.service_session_state\s*SET current_session_id = v_new\.id, updated_at = now\(\)\s*WHERE singleton = true;/.test(fnBody));
assert("10c: never references recent_closed_session_id or recent_closed_business_day_id anywhere in the body (untouched, per the frozen brief)",
  !/recent_closed_session_id/.test(fnBody) && !/recent_closed_business_day_id/.test(fnBody));
assert("10d: post-write assertion that current_period_id now equals the new session id (RAISE EXCEPTION if not)",
  /IF \(SELECT current_period_id FROM public\.business_day_lifecycle_state WHERE singleton = true\) IS DISTINCT FROM v_new\.id THEN\s*RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_POINTER_MISMATCH'/.test(fnBody));
assert("10e: post-write assertion that current_session_id now equals the new session id (RAISE EXCEPTION if not)",
  /IF \(SELECT current_session_id FROM public\.service_session_state WHERE singleton = true\) IS DISTINCT FROM v_new\.id THEN\s*RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_SHADOW_MISMATCH'/.test(fnBody));
assert("10f: defense-in-depth assertion that the business-day-derive trigger resolved back to the SAME canonical business day",
  /IF v_new\.business_day_id IS DISTINCT FROM v_day\.id THEN\s*RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_BUSINESS_DAY_DERIVE_MISMATCH'/.test(fnBody));

console.log("\n== K. Audit trail -- same support table every other creator/closer already uses ==");
assert("11a: writes exactly one service_session_audit row, event_type='opened'",
  /INSERT INTO public\.service_session_audit\(service_session_id, event_type, by_actor, source\)\s*VALUES \(v_new\.id, 'opened', p_opened_by, p_source\);/.test(fnBody));

console.log("\n== L. Post-conditions (forward migration) -- self-checking, not merely trusted ==");
assert("12a: post-condition asserts the function exists after CREATE",
  /F-6 post-condition failed: open_operational_service_v1 missing after CREATE/.test(SQL));
assert("12b: post-condition text-scans the live function body for forbidden clock\\/kind\\/lineage identity logic",
  /F-6 post-condition failed: open_operational_service_v1 references forbidden clock\/kind\/lineage identity logic/.test(SQL) &&
  /position\('clock_timestamp' IN v_def\) <> 0/.test(SQL_CODE_ONLY) &&
  /position\('rollover_source_session_id' IN v_def\) <> 0/.test(SQL_CODE_ONLY));
assert("12c: post-condition asserts the exact frozen identity-argument signature",
  /F-6 post-condition failed: open_operational_service_v1 signature does not match the frozen brief/.test(SQL));
assert("12d: post-condition asserts zero real operational_service_v1 rows exist after this migration",
  /F-6 post-condition failed: a real operational_service_v1 session exists unexpectedly/.test(SQL));
assert("12e: post-condition asserts the real canonical pointer/shadow are byte-identical to the pre-migration snapshot",
  /F-6 post-condition failed: current_period_id changed unexpectedly by this migration/.test(SQL) &&
  /F-6 post-condition failed: legacy shadow changed unexpectedly by this migration/.test(SQL));
assert("12f: post-condition asserts payment_transactions/service_sessions population unchanged",
  /F-6 post-condition failed: payment_transactions population changed/.test(SQL) &&
  /F-6 post-condition failed: service_sessions population changed/.test(SQL));

console.log("\n== M. Transaction discipline (forward migration) ==");
assert("13a: exactly one BEGIN and one COMMIT, nothing left uncommitted or double-wrapped",
  (SQL.match(/^BEGIN;$/gm) || []).length === 1 && (SQL.match(/^COMMIT;$/gm) || []).length === 1);

console.log("\n== N. Rollback -- PONR-guarded, drops only what this migration created, adds/removes no table/column ==");
assert("14a: refuses if a real operational_service_v1 session exists (PONR guard)",
  /F-6 rollback refused: a real operational_service_v1 session exists/.test(ROLLBACK));
assert("14b: drops exactly the one function this migration created, with the exact 3-arg signature",
  /DROP FUNCTION IF EXISTS public\.open_operational_service_v1\(text, text, text\);/.test(ROLLBACK_CODE_ONLY));
assert("14c: rollback contains no DROP TABLE / DROP COLUMN / ALTER TABLE (F-6 added no table/column, nothing else to remove)",
  !/DROP TABLE|DROP COLUMN|ALTER TABLE/.test(ROLLBACK_CODE_ONLY));
assert("14d: rollback touches no other function/trigger by name",
  (ROLLBACK_CODE_ONLY.match(/DROP FUNCTION/g) || []).length === 1 && !/DROP TRIGGER/.test(ROLLBACK_CODE_ONLY));
assert("14e: exactly one BEGIN and one COMMIT in the rollback file",
  (ROLLBACK.match(/^BEGIN;$/gm) || []).length === 1 && (ROLLBACK.match(/^COMMIT;$/gm) || []).length === 1);

console.log("\n== O. Non-interference -- the four legacy creators are byte-untouched by this migration ==");
for (const legacyFn of ["resolve_order_intake_context_v1", "ensure_service_session", "roll_service_session_economic_v1", "ensure_next_service_session_v3"]) {
  assert(`15: ${legacyFn} is not redefined by this migration`,
    !new RegExp(`CREATE OR REPLACE FUNCTION public\\.${legacyFn}`).test(SQL_CODE_ONLY) &&
    !new RegExp(`CREATE FUNCTION public\\.${legacyFn}`).test(SQL_CODE_ONLY));
}

console.log("\n== P. No application-source change AT F-6's OWN COMMIT -- F-6 itself is DB-only, dormant, zero registration ==");
// F-7 (a later, separate, deliberate slice) added the ONE SQL-only caller
// (resolve_order_intake_context_v1's first-ever-lazy-open path), still never
// from JS/HTTP -- 16a below (index.js only) still guards exactly that and
// remains true. F-9 (owner-frozen brief, dated after this file) is the real
// JS activator anticipated but not yet built when this comment was written:
// explicitReopenServiceSession.js is now the one JS call site, reachable
// only from the one intentional openServiceSession HTTP action, never from
// page load or order intake (see tests/f9ExplicitSameDayReopen.static.test.js
// for that slice's own, narrower guards). 16b/16c's ORIGINAL claim -- "zero
// JS callers, registration unnecessary" -- is retired by design, not by
// drift; the invariant they protected (no SILENT/undocumented JS wiring) is
// carried forward by F-9's own file instead.
assert("16a: no functional HTTP action wiring for this RPC directly in index.js (rpc(...) call site or inline route dispatch) -- F-9 routes through serviceSessionLifecycle.js/explicitReopenServiceSession.js, never a literal rpc() call in index.js itself",
  !/rpc\(\s*['"`]open_operational_service_v1['"`]/.test(stripJsComments(fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8")))
  && !/action\s*===\s*['"`]open_operational_service_v1['"`]/.test(stripJsComments(fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8"))));

console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
process.exit(fail === 0 ? 0 : 1);
