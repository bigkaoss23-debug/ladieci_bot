"use strict";
// S-D — Operational Service repair, slice D. Static (source-text) proof for
// the migration + paired rollback. Live acceptance (Phase 3: same
// business_date + opposite economic kind -> SAME session id reused,
// advanced=false, status stays open, pointer/shadow unchanged; Phase 4: a
// real order through the real ordenes_assign_service_session trigger
// attributes to the SAME reused session; Phase 5: forgotten previous-day
// legacy session -> rolled_over with closed_at/close_source both NULL,
// single successor created, no blackout; Phase 6: ensure_service_session
// converges on the successor after the resolver's rollover; Phase 8: S-C's
// order_financial_events stamps still reflect the fresh clock kind even
// though the reused session's own stored kind is stale) was run as its own
// separate, controlled step against real staging, entirely inside
// rolled-back fixture transactions -- see the S-D report for the exact
// live-verified evidence and JSON output.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_s_d_stop_same_day_kind_rollover.sql");
const ROLLBACK = read("migrations/2026-08-17_s_d_stop_same_day_kind_rollover.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /S-D refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses if resolve_order_intake_context_v1 does not exist",
  /S-D refused: resolve_order_intake_context_v1 does not exist -- R-DAY3 not applied/.test(SQL));
assert("1c: refuses unless the EXACT pre-S-D three-term predicate is present (byte-level guard)",
  /position\('IF FOUND AND v_period\.business_date = v_business_date AND v_period\.service_kind = v_service_kind THEN' IN v_def\) = 0/.test(SQL_CODE_ONLY));
assert("1d: refuses (drift guard) if the post-S-D two-term shape is already present",
  /S-D refused: resolve_order_intake_context_v1 already shows the post-S-D two-term predicate/.test(SQL));

console.log("\n== B. The exact single-term change — nothing else in the predicate ==");
assert("2a: the new reuse predicate is the two-term form (business_date only)",
  /IF FOUND AND v_period\.business_date = v_business_date THEN/.test(SQL_CODE_ONLY));
const FUNCTION_BODY_ONLY = SQL_CODE_ONLY.split("$function$")[1] || "";
assert("2b: the removed conjunct does not appear anywhere as part of the IDENTITY predicate"
  + " (checked in the function body only -- the predecessor guard above it legitimately"
  + " quotes the exact pre-S-D string to detect it)",
  !/IF FOUND AND v_period\.business_date = v_business_date AND v_period\.service_kind = v_service_kind THEN/.test(FUNCTION_BODY_ONLY));
assert("2c: the fallback re-SELECT (business_date AND service_kind, unrelated to identity reuse) is left untouched",
  /SELECT \* INTO v_period FROM public\.service_sessions\s*\n\s*WHERE business_date = v_business_date AND service_kind = v_service_kind\s*\n\s*AND status IN \('open','closing'\);/.test(SQL_CODE_ONLY));

console.log("\n== C. Economic classification survives — only its role as identity predicate is removed ==");
assert("3a: v_service_kind is still computed from the clock, byte-identical expression",
  /v_service_kind\s+:= CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050\s*\n\s*THEN 'PRANZO' ELSE 'SERA' END;/.test(SQL_CODE_ONLY));
assert("3b: serviceKind is still returned in the result JSON",
  /'serviceKind', v_service_kind,/.test(SQL_CODE_ONLY));

console.log("\n== D. NO new-era rows — Candidate C discipline ==");
assert("4a: the bootstrap INSERT column list is unchanged (still omits lifecycle_semantics)",
  /INSERT INTO public\.service_sessions \(business_date, service_kind, status, opened_by, open_source\)/.test(SQL_CODE_ONLY));
assert("4b: lifecycle_semantics is never referenced anywhere in the function body",
  !/lifecycle_semantics/.test(SQL_CODE_ONLY.split("$function$")[1] || ""));
assert("4c: post-condition explicitly asserts zero operational_service_v1 rows exist",
  /real operational_service_v1 row\(s\) exist -- S-D must create zero/.test(SQL));

console.log("\n== E. HARD SCOPE — everything else byte-identical, nothing else touched ==");
assert("5a: the shared advisory lock name is unchanged",
  /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(SQL_CODE_ONLY));
assert("5b: the pointer-authorization GUC is unchanged",
  /ladieci\.business_day_pointer_authorized/.test(SQL_CODE_ONLY));
assert("5c: both mirror-consistency assertions are unchanged",
  /BUSINESS_DAY_POINTER_MISMATCH/.test(SQL_CODE_ONLY) && /TICKET_EPOCH_MIRROR_MISMATCH/.test(SQL_CODE_ONLY));
assert("5d: the ORDER_INTAKE_CLOSED schedule gate window is unchanged",
  /\(v_minutes_of_day >= 480 AND v_minutes_of_day < 1050\)\s*\n\s*OR \(v_minutes_of_day >= 1080\)/.test(SQL_CODE_ONLY));
assert("5e: ensure_service_session is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.ensure_service_session/.test(SQL));
assert("5f: roll_service_session_economic_v1 is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.roll_service_session_economic_v1/.test(SQL));
assert("5g: only ONE function is redefined in this migration (resolve_order_intake_context_v1)",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1);
assert("5h: no S-C stamp columns/triggers/classifier are touched",
  !/classify_economic_period_v1/.test(SQL_CODE_ONLY) && !/economic_period_kind/.test(SQL_CODE_ONLY));

console.log("\n== F. Post-conditions — structural, financial-unchanged assertions ==");
assert("6a: post-condition asserts payment_transactions population unchanged (exactly 20)",
  /payment_transactions\) <> 20/.test(SQL));
assert("6b: post-condition asserts period_consolidations population unchanged (exactly 5)",
  /period_consolidations\) <> 5/.test(SQL));

console.log("\n== G. Paired rollback — restores the exact byte-captured pre-S-D three-term predicate ==");
assert("7a: rollback refuses if the post-S-D shape is not detected",
  /S-D rollback refused: post-S-D two-term shape not detected/.test(ROLLBACK));
assert("7b: rollback restores the EXACT three-term predicate verbatim",
  /IF FOUND AND v_period\.business_date = v_business_date AND v_period\.service_kind = v_service_kind THEN/.test(ROLLBACK_CODE_ONLY));
assert("7c: rollback touches no data (no INSERT/UPDATE/DELETE against any data table)",
  !/\n\s*(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM)\s+public\.(?!ladieci_schema_migrations)/.test(ROLLBACK_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
