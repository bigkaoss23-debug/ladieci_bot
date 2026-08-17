"use strict";
// S-B — Operational Service repair, slice B. Static (source-text) proof for
// the migration + paired rollback. Live acceptance (Cases A-H: every
// historical row economic_period_v1, legacy kind invariant preserved,
// reject/accept matrix for the era-aware CHECK, zero residue from isolated
// fixtures, S-A reuse behavior unchanged, pointer/shadow/financial
// invariants unchanged) was run as its own separate, controlled step
// against real staging before this migration was finalized -- see the
// migration's own header for the exact live-verified evidence.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_s_b_service_sessions_lifecycle_semantics.sql");
const ROLLBACK = read("migrations/2026-08-17_s_b_service_sessions_lifecycle_semantics.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses if service_sessions does not exist",
  /S-B refused: service_sessions does not exist/.test(SQL));
assert("1b: refuses if lifecycle_semantics already exists (drift guard)",
  /S-B refused: lifecycle_semantics already exists/.test(SQL));
assert("1c: refuses unless the pre-S-B CHECK matches the exact expected shape",
  /S-B refused: service_sessions_active_kind_chk does not match/.test(SQL));
assert("1d: EMPIRICAL row-by-row validation against the proposed expression BEFORE any ACTUAL ALTER TABLE"
  + " (not merely asserted safe -- the header comment's own description of step 1 is excluded from this check)",
  (() => {
    const empiricalIdx = SQL_CODE_ONLY.indexOf("v_would_violate");
    const alterIdx = SQL_CODE_ONLY.indexOf("ADD COLUMN lifecycle_semantics");
    return empiricalIdx !== -1 && alterIdx !== -1 && empiricalIdx < alterIdx;
  })());

console.log("\n== B. Column + constraints — exact target shape ==");
assert("2a: lifecycle_semantics is text NOT NULL DEFAULT 'economic_period_v1'",
  /ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1'/.test(SQL_CODE_ONLY));
assert("2b: enum-style CHECK restricts to exactly the two known values",
  /CHECK \(lifecycle_semantics = ANY \(ARRAY\['economic_period_v1', 'operational_service_v1'\]\)\)/.test(SQL_CODE_ONLY));
assert("2c: service_sessions_active_kind_chk is replaced (dropped then re-added under the same name)",
  /DROP CONSTRAINT service_sessions_active_kind_chk/.test(SQL_CODE_ONLY)
  && (SQL_CODE_ONLY.match(/ADD CONSTRAINT service_sessions_active_kind_chk/g) || []).length === 1);
assert("2d: era-aware CHECK preserves the EXACT legacy rule for economic_period_v1"
  + " (status='closed' OR service_kind IS NOT NULL)",
  /lifecycle_semantics = 'economic_period_v1' AND \(status = 'closed' OR service_kind IS NOT NULL\)/.test(SQL_CODE_ONLY));
assert("2e: era-aware CHECK requires service_kind IS NULL, unconditionally, for operational_service_v1",
  /lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL/.test(SQL_CODE_ONLY));

console.log("\n== C. HARD SCOPE — no behavior cutover, nothing else touched ==");
assert("3a: no INSERT writer in this migration specifies lifecycle_semantics explicitly"
  + " (every existing writer keeps getting the default)",
  !/INSERT INTO public\.service_sessions[\s\S]{0,400}lifecycle_semantics/.test(SQL_CODE_ONLY));
assert("3b: no INSERT of a real operational_service_v1 row anywhere in this migration",
  !/'operational_service_v1'\)/.test(SQL_CODE_ONLY.replace(/CHECK[\s\S]*?\)\);/g, "")));
assert("3c: resolve_order_intake_context_v1 is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.resolve_order_intake_context_v1/.test(SQL));
assert("3d: roll_service_session_economic_v1 is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.roll_service_session_economic_v1/.test(SQL));
assert("3e: ensure_service_session (frozen by S-A) is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.ensure_service_session/.test(SQL));
assert("3f: consolidate_period_v1/period_consolidations are not touched",
  !/consolidate_period_v1/.test(SQL_CODE_ONLY) && !/ALTER TABLE public\.period_consolidations/.test(SQL_CODE_ONLY));
assert("3g: no economic-period stamping column added to order_entities/table_order_lines/payment_transactions",
  !/ALTER TABLE public\.order_entities/.test(SQL_CODE_ONLY)
  && !/ALTER TABLE public\.table_order_lines/.test(SQL_CODE_ONLY)
  && !/ALTER TABLE public\.payment_transactions/.test(SQL_CODE_ONLY));

console.log("\n== D. Post-conditions — structural, real data/pointer/financial-unchanged assertions ==");
assert("4a: post-condition asserts zero non-economic_period_v1 rows exist",
  /existing row\(s\) are not economic_period_v1/.test(SQL));
assert("4b: post-condition asserts zero real operational_service_v1 rows exist",
  /real operational_service_v1 row\(s\) exist -- S-B must create zero/.test(SQL));
assert("4c: post-condition asserts the real legacy shadow is byte-identical before/after",
  /legacy shadow changed unexpectedly by this migration/.test(SQL));
assert("4d: post-condition asserts the real canonical pointer is byte-identical before/after",
  /canonical pointer changed unexpectedly by this migration/.test(SQL));
assert("4e: post-condition asserts payment_transactions population unchanged (exactly 20)",
  /payment_transactions\) <> 20/.test(SQL));
assert("4f: post-condition asserts period_consolidations population unchanged (exactly 5)",
  /period_consolidations\) <> 5/.test(SQL));

console.log("\n== E. Paired rollback — refuses once real operational_service_v1 evidence exists ==");
assert("5a: rollback refuses if any operational_service_v1 row exists",
  /S-B rollback refused/.test(ROLLBACK) && /operational_service_v1/.test(ROLLBACK));
assert("5b: rollback restores the exact byte-captured pre-S-B constraint definition",
  /CHECK \(\(\(status = 'closed'::text\) OR \(service_kind IS NOT NULL\)\)\)/.test(ROLLBACK));
assert("5c: rollback drops both the semantics CHECK and the column",
  /DROP CONSTRAINT service_sessions_lifecycle_semantics_chk/.test(ROLLBACK)
  && /DROP COLUMN lifecycle_semantics/.test(ROLLBACK));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
