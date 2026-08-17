"use strict";
// F-2 — Finalizar servicio repair, slice 2. Static (source-text) proof for
// the migration + paired rollback. Live acceptance (5-case matrix, all
// inside rolled-back transactions against real staging, using the real
// current session 5e5777c5-71c8-4b54-aa78-1b1090c4cd04 genuinely closed and
// rolled back for fixture setup via the F-1-proven-safe begin_service_
// session_close/complete_service_session_close pair):
//   Case 1 (predecessor 42P10 reproduction): the pre-F-2 arbiter clause,
//     `ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT
//     NULL`, raised 42P10 against the real live service_sessions_date_kind_
//     active_uq index -- reproduced fresh, immediately before authoring the
//     fix, not merely cited from the earlier architecture audit.
//   Case 2 (create path): the repaired clause let a genuine INSERT succeed,
//     creating a new active row, no 42P10.
//   Case 3 (idempotent reuse): re-calling with the same source_session_id
//     returned the SAME session (REUSED), no duplicate row.
//   Case 4 (historical duplicates coexist): pre-existing CLOSED/ROLLED_OVER
//     rows at the identical (business_date, service_kind) were left
//     completely untouched while a new active row was still created
//     successfully -- proves this migration does not broaden uniqueness.
//   Case 5 (concurrent ensure proxy): two distinct callers ("Caller A",
//     "Caller B") raced the identical (business_date, service_kind) target
//     via the identical arbiter clause -- Caller A's row committed, Caller
//     B's INSERT silently no-op'd via ON CONFLICT ... DO NOTHING, zero
//     42P10, zero duplicate, zero unique-violation escaping
//     (active_rows_for_date_kind=1, global_active_rows=1). True OS-level
//     parallel execution of the real function isn't reachable without a
//     prohibited real service close; the real function's own
//     pg_advisory_xact_lock(hashtext('service_session_lifecycle')) already
//     totally orders every genuine caller before any of them reach this
//     INSERT (unchanged by F-2, asserted in section C below) -- the raw
//     dual-INSERT proxy deliberately bypasses that lock, so it proves the
//     arbiter clause itself is safe even without serialization, as
//     defense-in-depth beyond the lock's own guarantee.
// See the migration's own header and the F-2 report for the exact
// live-verified JSON evidence. Zero residue confirmed after every run.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_f2_v3_next_service_on_conflict_repair.sql");
const ROLLBACK = read("migrations/2026-08-17_f2_v3_next_service_on_conflict_repair.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-2 refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses if ensure_next_service_session_v3 does not exist",
  /F-2 refused: ensure_next_service_session_v3 does not exist/.test(SQL));
assert("1c: predecessor-body guard requires the exact byte-for-byte pre-F-2 arbiter clause",
  /F-2 refused: ensure_next_service_session_v3 does not match the expected pre-F-2 body/.test(SQL));
assert("1d: drift guard refuses if the post-F-2 shape is already present",
  /F-2 refused: ensure_next_service_session_v3 already shows the post-F-2 arbiter clause/.test(SQL));
assert("1e: empirical index-shape guard requires the exact live service_sessions_date_kind_active_uq definition",
  /indexname='service_sessions_date_kind_active_uq'/.test(SQL) &&
  /WHERE \(\(service_kind IS NOT NULL\) AND \(status = ANY \(ARRAY\[''open''::text, ''closing''::text\]\)\)\)/.test(SQL));

console.log("\n== B. The fix -- arbiter clause gains the missing status predicate, nothing else ==");
// Boundary located against the RAW SQL (comments intact) since the
// "-- Post-conditions" marker itself is a comment and would vanish from an
// already-comment-stripped string, silently widening the slice to include
// the post-condition block below (which legitimately references
// lifecycle_semantics/operational_service_v1 as scope-guard checks).
const fnBody = stripSqlComments(
  SQL.split("CREATE OR REPLACE FUNCTION public.ensure_next_service_session_v3")[1]
    .split("-- Post-conditions")[0]
);

assert("2a: repaired ON CONFLICT clause is predicate-identical to the real live index",
  /ON CONFLICT \(business_date, service_kind\) WHERE service_kind IS NOT NULL AND status = ANY \(ARRAY\['open','closing'\]\)/.test(fnBody));
assert("2b: DO NOTHING (not DO UPDATE) preserved -- no upsert semantics introduced",
  /ON CONFLICT \(business_date, service_kind\) WHERE service_kind IS NOT NULL AND status = ANY \(ARRAY\['open','closing'\]\)\s*\n\s*DO NOTHING/.test(fnBody));
assert("2c: exactly one function is redefined in this migration",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1);

console.log("\n== C. Untouched invariants -- advisory lock + pre-checks unchanged ==");
assert("3a: shared advisory lock name unchanged (still totally orders every real caller)",
  /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(fnBody));
assert("3b: MULTIPLE_ACTIVE_SERVICE_SESSIONS pre-check unchanged, still evaluated before the INSERT",
  (() => {
    const guardIdx = fnBody.indexOf("MULTIPLE_ACTIVE_SERVICE_SESSIONS");
    const insertIdx = fnBody.indexOf("INSERT INTO public.service_sessions(");
    return guardIdx !== -1 && insertIdx !== -1 && guardIdx < insertIdx;
  })());
assert("3c: ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED / CURRENT_SESSION_ALREADY_SET checks unchanged",
  /ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED/.test(fnBody) && /CURRENT_SESSION_ALREADY_SET/.test(fnBody));
assert("3d: two-phase rollover-source dedup check (pre-lock and post-lock) unchanged",
  (fnBody.match(/WHERE rollover_source_session_id = p_source_session_id;/g) || []).length === 2);
assert("3e: reuse-vs-conflict tail logic (NEXT_SERVICE_IDENTITY_CONFLICT) unchanged",
  /NEXT_SERVICE_IDENTITY_CONFLICT/.test(fnBody));

console.log("\n== D. HARD SCOPE — F-2 touches only this one function, no sibling defects ==");
assert("4a: complete_service_session_close / close_service_session_v3 (F-1's own logic) not redefined",
  !/CREATE OR REPLACE FUNCTION public\.complete_service_session_close/.test(SQL) &&
  !/CREATE OR REPLACE FUNCTION public\.close_service_session_v3/.test(SQL));
assert("4b: guard_service_session_closed_v1 (V3-D2, known defect) not touched",
  !/CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1/.test(SQL));
assert("4c: p_service_kind validation unchanged -- still exactly PRANZO/SERA, V3-D3 not repaired",
  /p_service_kind NOT IN \('PRANZO','SERA'\)/.test(fnBody));
assert("4d: lifecycle_semantics / operational_service_v1 not referenced by the function itself (post-condition scope-guard checks are fine, expected)",
  !/lifecycle_semantics/.test(fnBody) && !/operational_service_v1/.test(fnBody));
assert("4e: v3NextServiceIdentity / resolveSchedule()-derived successor selection (V3-D5) not referenced",
  !/resolveSchedule|v3NextServiceIdentity/.test(SQL_CODE_ONLY));
assert("4f: service_sessions_date_kind_active_uq itself is not created/dropped/altered as a real DDL statement -- function conforms to the index, never the reverse (the guard's own indexdef string-equality check is expected, not a DDL statement)",
  !/(^|\n)\s*(CREATE|DROP|ALTER)\s+(UNIQUE\s+)?INDEX\s+service_sessions_date_kind_active_uq\b/i.test(SQL_CODE_ONLY));

console.log("\n== E. Post-conditions — empirical re-probe + pointer/financial-unchanged assertions ==");
assert("5a: post-condition asserts the repaired clause is present",
  /F-2 post-condition failed: repaired arbiter clause not found/.test(SQL));
assert("5b: post-condition asserts the stale clause is gone",
  /F-2 post-condition failed: stale arbiter clause still present/.test(SQL));
assert("5c: post-condition asserts unrelated function logic (validation codes) unchanged",
  /F-2 post-condition failed: unrelated function logic changed -- out of scope/.test(SQL));
assert("5d: post-condition asserts lifecycle_semantics still not referenced (V3-D3 guard)",
  /F-2 post-condition failed: lifecycle_semantics referenced -- V3-D3 must remain untouched/.test(SQL));
assert("5e: post-condition performs a REAL empirical re-probe of the exact 42P10 scenario, using PL/pgSQL's own implicit-savepoint BEGIN/EXCEPTION/END (no invalid raw SAVEPOINT statement inside the DO block)",
  /F-2 post-condition failed: repaired arbiter clause STILL raises 42P10 against the real live index/.test(SQL) &&
  !/\bSAVEPOINT\b/.test(SQL_CODE_ONLY));
assert("5f: probe row is explicitly deleted after the re-probe (its own status='closed' never matches the arbiter's status predicate, so it always genuinely commits and must be cleaned up by hand)",
  /DELETE FROM public\.service_sessions WHERE business_date='1999-01-01' AND opened_by='f2_migration_probe';/.test(SQL_CODE_ONLY));
assert("5g: post-condition asserts zero probe-row residue after the explicit cleanup",
  /F-2 post-condition failed: the inference probe row leaked/.test(SQL));
assert("5h: post-condition asserts canonical pointer + legacy shadow unchanged by this migration",
  /current_period_id.*changed unexpectedly by this migration/.test(SQL) &&
  /legacy shadow changed unexpectedly by this migration/.test(SQL));
assert("5i: post-condition asserts payment_transactions/service_closeouts population unchanged",
  /payment_transactions\) <> 20/.test(SQL) && /service_closeouts\) <> 3/.test(SQL));
assert("5j: post-condition asserts zero real operational_service_v1 rows",
  /operational_service_v1['"]?\s*\)\s*<>\s*0/.test(SQL) || /must remain 0/.test(SQL));

console.log("\n== F. Paired rollback — restores exact byte-captured pre-F-2 (broken) body, refuses if not applied ==");
assert("6a: rollback refuses if the function does not show the post-F-2 shape",
  /F-2 rollback refused: ensure_next_service_session_v3 does not show the post-F-2 shape/.test(ROLLBACK));
assert("6b: rollback restores the exact broken pre-F-2 arbiter clause (byte-for-byte)",
  /ON CONFLICT \(business_date, service_kind\) WHERE service_kind IS NOT NULL\s*\n\s*DO NOTHING/.test(
    ROLLBACK_CODE_ONLY.split("CREATE OR REPLACE FUNCTION public.ensure_next_service_session_v3")[1] || ""));
assert("6c: rollback's own post-condition asserts the repaired clause is gone after rollback",
  /F-2 rollback post-condition failed: repaired arbiter clause still present/.test(ROLLBACK));
assert("6d: rollback touches no data table (function redefinition only)",
  !/\n\s*(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM)\s+public\.(?!ladieci_schema_migrations)/.test(
    ROLLBACK_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
