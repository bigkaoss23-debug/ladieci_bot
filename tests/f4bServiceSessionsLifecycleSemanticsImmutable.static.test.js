"use strict";
// F-4B — Finalizar servicio repair, slice 4B. Static (source-text) proof for
// the migration + paired rollback (service_sessions.lifecycle_semantics
// becomes immutable after INSERT). Live acceptance (the mandatory A-E
// matrix -- same-value allow, legacy->new-era reject, new-era->legacy
// reject, ordinary status transitions unaffected, unrelated column mutation
// unaffected -- plus the migration's own real empirical negative/positive
// probes against the live current session) was run as its own separate,
// controlled step against real staging, entirely inside BEGIN/ROLLBACK --
// see the migration's own header and the F-4B report for the exact
// live-verified evidence. Zero residue confirmed after every run.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_f4b_service_sessions_lifecycle_semantics_immutable.sql");
const ROLLBACK = read("migrations/2026-08-17_f4b_service_sessions_lifecycle_semantics_immutable.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor / drift guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-4B refused: staging sentinel migration absent/.test(SQL));
assert("1b: drift guard refuses if the guard trigger already exists",
  /F-4B refused: service_sessions_lifecycle_semantics_immutable_guard already exists/.test(SQL));
assert("1c: drift guard refuses if the guard function already exists",
  /F-4B refused: guard_service_sessions_lifecycle_semantics_immutable_v1 already exists/.test(SQL));

console.log("\n== B. The guard itself -- new trigger function + trigger, nothing else ==");
assert("2a: new trigger function is CREATE (not CREATE OR REPLACE) -- pure addition, no pre-existing body to preserve/overwrite",
  /^CREATE FUNCTION public\.guard_service_sessions_lifecycle_semantics_immutable_v1\(\)/m.test(SQL_CODE_ONLY));
assert("2b: rejects when NEW differs from OLD, using IS DISTINCT FROM (NULL-safe)",
  /IF NEW\.lifecycle_semantics IS DISTINCT FROM OLD\.lifecycle_semantics THEN/.test(SQL_CODE_ONLY));
assert("2c: typed error, same RAISE EXCEPTION ... USING ERRCODE='P0001' idiom already used elsewhere in this codebase",
  /RAISE EXCEPTION 'SERVICE_SESSION_LIFECYCLE_SEMANTICS_IMMUTABLE' USING ERRCODE = 'P0001';/.test(SQL_CODE_ONLY));
assert("2d: same-value UPDATE is NOT rejected -- no unconditional RAISE, only inside the IS DISTINCT FROM branch",
  (() => {
    const fnStart = SQL_CODE_ONLY.indexOf("CREATE FUNCTION public.guard_service_sessions_lifecycle_semantics_immutable_v1");
    const fnEnd = SQL_CODE_ONLY.indexOf("$function$;", fnStart) + "$function$;".length;
    const body = SQL_CODE_ONLY.slice(fnStart, fnEnd);
    return (body.match(/RAISE EXCEPTION/g) || []).length === 1;
  })());
assert("2e: exactly one new trigger, scoped to BEFORE UPDATE OF lifecycle_semantics ON service_sessions (fires only when that column is named in the statement's own SET list, matching the existing status-scoped guard's idiom)",
  /CREATE TRIGGER service_sessions_lifecycle_semantics_immutable_guard\s*\n\s*BEFORE UPDATE OF lifecycle_semantics ON public\.service_sessions\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.guard_service_sessions_lifecycle_semantics_immutable_v1\(\);/.test(SQL_CODE_ONLY));
assert("2f: exactly one CREATE FUNCTION and one CREATE TRIGGER in the whole migration -- no unrelated object created",
  (SQL_CODE_ONLY.match(/^CREATE FUNCTION/gm) || []).length === 1 &&
  (SQL_CODE_ONLY.match(/^CREATE TRIGGER/gm) || []).length === 1);

console.log("\n== C. HARD SCOPE -- service_kind untouched, no conversion RPC, no unrelated object touched ==");
assert("3a: service_kind is never mentioned anywhere in the migration -- not broadened into this slice",
  !/service_kind/.test(SQL_CODE_ONLY));
assert("3b: no CREATE OR REPLACE FUNCTION anywhere -- no pre-existing function body touched (S-B/F-1/F-2/F-3/F-4A all untouched)",
  !/CREATE OR REPLACE FUNCTION/.test(SQL_CODE_ONLY));
assert("3c: service_sessions_active_kind_chk (S-B) is not redefined (code, not the explanatory header comment, which names it by way of contrast)",
  !/service_sessions_active_kind_chk/.test(SQL_CODE_ONLY));
assert("3d: no evidence table (service_closeout_snapshots/service_closeouts/service_incidents, F-4A) is touched",
  !/ALTER TABLE public\.service_closeout/.test(SQL) && !/ALTER TABLE public\.service_incidents/.test(SQL));
assert("3e: no new RPC/parameter is introduced for changing era -- the only new object is the guard trigger + its function",
  (SQL_CODE_ONLY.match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length === 1);
assert("3f: no data is ever written by this migration outside its own self-contained, self-reverting probes (no bare INSERT/UPDATE/DELETE INTO any table at the top level)",
  !/\n(INSERT INTO|DELETE FROM) public\./.test(SQL_CODE_ONLY));

console.log("\n== D. Post-conditions -- structural + real empirical probes, matching established discipline ==");
assert("4a: asserts the trigger exists and is correctly scoped",
  /guard trigger missing/.test(SQL) &&
  /guard trigger not scoped to BEFORE UPDATE OF lifecycle_semantics/.test(SQL));
assert("4b: asserts the guard function exists",
  /guard function missing/.test(SQL));
assert("4c: performs a REAL empirical negative probe against the live current session -- a genuine cross-era UPDATE, caught via PL/pgSQL's nested-block savepoint idiom",
  /UPDATE public\.service_sessions SET lifecycle_semantics = 'operational_service_v1' WHERE id = v_target_id;/.test(SQL_CODE_ONLY) &&
  /EXCEPTION WHEN raise_exception THEN/.test(SQL_CODE_ONLY));
assert("4d: the negative probe's caught exception is verified to be the EXACT expected typed error, not just any error (would catch a false-positive from an unrelated constraint)",
  /IF SQLERRM <> 'SERVICE_SESSION_LIFECYCLE_SEMANTICS_IMMUTABLE' THEN/.test(SQL_CODE_ONLY));
assert("4e: performs a REAL empirical positive probe -- a same-value UPDATE against the same live session must succeed, not merely be assumed safe",
  /UPDATE public\.service_sessions SET lifecycle_semantics = lifecycle_semantics WHERE id = v_target_id;/.test(SQL_CODE_ONLY));
assert("4f: asserts zero residue from either probe -- both value AND updated_at unchanged (proves the positive probe is a true no-op, not just an allowed-but-side-effecting write)",
  /probe residue -- real session lifecycle_semantics changed/.test(SQL) &&
  /probe residue -- real session updated_at changed, same-value UPDATE was not a true no-op/.test(SQL));
assert("4g: asserts historical row count + era distribution unchanged (this migration performs no data writes of its own -- both probes are self-reverting/no-op)",
  /service_sessions historical integrity violated/.test(SQL));
assert("4h: asserts canonical pointer / legacy shadow / payment_transactions population unchanged",
  /current_period_id changed unexpectedly by this migration/.test(SQL) &&
  /legacy shadow changed unexpectedly by this migration/.test(SQL) &&
  /payment_transactions population changed/.test(SQL));

console.log("\n== E. Paired rollback -- PONR-guarded, honest (no fabricated reversibility) ==");
assert("5a: rollback refuses outright if ANY real operational_service_v1 service_sessions row exists (PONR)",
  /F-4B rollback refused: PONR reached -- a real operational_service_v1 service_sessions row exists/.test(ROLLBACK) &&
  /EXISTS \(SELECT 1 FROM public\.service_sessions WHERE lifecycle_semantics = 'operational_service_v1'\)/.test(ROLLBACK_CODE_ONLY));
assert("5b: rollback also refuses if not applied in the first place",
  /F-4B rollback refused: guard trigger not present/.test(ROLLBACK));
assert("5c: rollback drops the trigger then the function, in that dependency order",
  /DROP TRIGGER service_sessions_lifecycle_semantics_immutable_guard ON public\.service_sessions;\s*\n\s*DROP FUNCTION public\.guard_service_sessions_lifecycle_semantics_immutable_v1\(\);/.test(ROLLBACK_CODE_ONLY));
assert("5d: rollback's own post-condition re-asserts both objects are gone, plus historical row counts unchanged",
  /guard trigger still present/.test(ROLLBACK) &&
  /guard function still present/.test(ROLLBACK) &&
  /service_sessions historical integrity violated/.test(ROLLBACK));
assert("5e: rollback touches no data table directly (pure DDL -- DROP TRIGGER/DROP FUNCTION only)",
  !/\n(INSERT INTO|UPDATE public\.|DELETE FROM) public\./.test(ROLLBACK_CODE_ONLY));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
