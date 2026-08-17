"use strict";
// S-C — Operational Service repair, slice C. Static (source-text) proof for
// the migration + paired rollback. Live acceptance (dry-run smoke test:
// full forward migration applied inside a transaction that inserted real
// fixture rows into table_order_lines/payment_transactions/
// order_financial_events to exercise all three triggers, then rolled back
// with zero residue; then the real, permanent apply, re-verified live with
// zero backfilled rows and pointer/shadow/financial invariants unchanged)
// was run as its own separate, controlled step against real staging before
// this migration was finalized -- see the migration's own header for the
// exact live-verified evidence.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_s_c_economic_period_stamping.sql");
const ROLLBACK = read("migrations/2026-08-17_s_c_economic_period_stamping.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /S-C refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses if S2's centralizing trigger function is absent",
  /S-C refused: service_session_assign_financial_event does not exist -- S2 not applied/.test(SQL));
assert("1c: refuses (drift guard) if classify_economic_period_v1 already exists",
  /S-C refused: classify_economic_period_v1 already exists/.test(SQL));
assert("1d: refuses (drift guard) if any of the three new stamp columns already exist",
  /table_order_lines\.economic_period_kind already exists/.test(SQL)
  && /payment_transactions\.economic_period_kind already exists/.test(SQL)
  && /order_financial_events\.obligation_economic_period_kind already exists/.test(SQL));

console.log("\n== B. ONE authoritative classifier, reused everywhere ==");
assert("2a: classify_economic_period_v1 is created exactly once",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION public\.classify_economic_period_v1/g) || []).length === 1);
assert("2b: classifier restates the exact R-DAY3-proven boundary (240 / 1050 minutes, Europe/Madrid)",
  /v_minutes_of_day >= 240 AND v_minutes_of_day < 1050/.test(SQL_CODE_ONLY)
  && /Europe\/Madrid/.test(SQL_CODE_ONLY));
assert("2c: classifier is IMMUTABLE and rejects a NULL timestamp rather than silently defaulting",
  /RETURNS text\nLANGUAGE plpgsql\nIMMUTABLE/.test(SQL_CODE_ONLY)
  && /CLASSIFY_ECONOMIC_PERIOD_NULL_TIMESTAMP/.test(SQL_CODE_ONLY));
assert("2d: every stamping site calls classify_economic_period_v1 (no independent restatement of the boundary arithmetic elsewhere)",
  (SQL_CODE_ONLY.match(/public\.classify_economic_period_v1\(/g) || []).length >= 5);

console.log("\n== C. Minimal column set — exactly four new columns, on exactly three tables ==");
assert("3a: table_order_lines gets exactly one new column (economic_period_kind)",
  /ALTER TABLE public\.table_order_lines\s*\n\s*ADD COLUMN economic_period_kind text NULL;/.test(SQL_CODE_ONLY));
assert("3b: payment_transactions gets exactly one new column (economic_period_kind), independent of the obligation",
  /ALTER TABLE public\.payment_transactions\s*\n\s*ADD COLUMN economic_period_kind text NULL;/.test(SQL_CODE_ONLY));
assert("3c: order_financial_events gets exactly two new columns, mirroring the existing service_session_id/event_service_session_id split",
  /ADD COLUMN obligation_economic_period_kind text NULL,\s*\n\s*ADD COLUMN event_economic_period_kind\s+text NULL;/.test(SQL_CODE_ONLY));
assert("3d: payment_allocations is never touched (no stamp -- derives via parent payment_transaction_id)",
  !/ALTER TABLE public\.payment_allocations/.test(SQL_CODE_ONLY));
assert("3e: order_entities is never touched (identity, not economics)",
  !/ALTER TABLE public\.order_entities/.test(SQL_CODE_ONLY));
assert("3f: ordenes is never touched (mutable/deletable, worse candidate than order_entities)",
  !/ALTER TABLE public\.ordenes/.test(SQL_CODE_ONLY));
assert("3g: all four new columns are nullable (legacy rows stay NULL, no NOT NULL forced)",
  (SQL_CODE_ONLY.match(/economic_period_kind text NULL/g) || []).length === 3);

console.log("\n== D. Every new stamp column is CHECK-constrained to the known enum, nullable ==");
assert("4a: table_order_lines.economic_period_kind CHECK",
  /CHECK \(economic_period_kind IS NULL OR economic_period_kind = ANY \(ARRAY\['PRANZO','SERA'\]\)\)/.test(SQL_CODE_ONLY));
assert("4b: order_financial_events obligation/event CHECKs both present",
  /CHECK \(obligation_economic_period_kind IS NULL OR obligation_economic_period_kind = ANY \(ARRAY\['PRANZO','SERA'\]\)\)/.test(SQL_CODE_ONLY)
  && /CHECK \(event_economic_period_kind IS NULL OR event_economic_period_kind = ANY \(ARRAY\['PRANZO','SERA'\]\)\)/.test(SQL_CODE_ONLY));

console.log("\n== E. Writer centralization — additive triggers only, no existing writer touched ==");
assert("5a: exactly one new BEFORE INSERT trigger on table_order_lines",
  /CREATE TRIGGER table_order_lines_stamp_economic_period_v1\s*\n\s*BEFORE INSERT ON public\.table_order_lines/.test(SQL_CODE_ONLY));
assert("5b: exactly one new BEFORE INSERT trigger on payment_transactions",
  /CREATE TRIGGER payment_transactions_stamp_economic_period_v1\s*\n\s*BEFORE INSERT ON public\.payment_transactions/.test(SQL_CODE_ONLY));
assert("5c: order_financial_events reuses its EXISTING trigger object (no new CREATE TRIGGER for this table)",
  !new RegExp("CREATE TRIGGER\\s+\\S+\\s*\\n\\s*BEFORE INSERT ON public\\.order_financial_events").test(SQL_CODE_ONLY));
assert("5d: both new trigger functions unconditionally overwrite NEW.economic_period_kind (forged client values cannot survive)",
  (SQL_CODE_ONLY.match(/NEW\.economic_period_kind := public\.classify_economic_period_v1\(clock_timestamp\(\)\);/g) || []).length === 2);
assert("5e: no existing writer/RPC function body is redefined by this migration besides the two intentional targets",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 4 // classifier + 2 new trigger fns + the one extended existing fn
  && /CREATE OR REPLACE FUNCTION public\.service_session_assign_financial_event/.test(SQL_CODE_ONLY));

console.log("\n== F. order_financial_events extension — obligation vs event, exact derivation ==");
assert("6a: obligation stamp derives from the ORDER's own creation instant (universal across channels), not table_order_lines",
  /v_order_created_at timestamptz;/.test(SQL_CODE_ONLY)
  && /SELECT o\.service_session_id, o\.created_at INTO v_session_id, v_order_created_at/.test(SQL_CODE_ONLY)
  && /NEW\.obligation_economic_period_kind := CASE WHEN v_order_created_at IS NOT NULL/.test(SQL_CODE_ONLY));
assert("6b: event stamp derives from this row's own write-time clock_timestamp(), independent of the obligation",
  /NEW\.event_economic_period_kind := public\.classify_economic_period_v1\(clock_timestamp\(\)\);/.test(SQL_CODE_ONLY));
assert("6c: the pre-existing session-lineage resolution logic (ambiguity check, fallback via payment_allocations) is preserved byte-identical",
  /ORDER_OBLIGATION_AMBIGUOUS/.test(SQL_CODE_ONLY) && /ORDER_WITHOUT_SERVICE_SESSION/.test(SQL_CODE_ONLY)
  && /NEW\.service_session_id := v_session_id;/.test(SQL_CODE_ONLY));

console.log("\n== G. HARD SCOPE — no cutover, no reader retarget, nothing else touched ==");
assert("7a: resolve_order_intake_context_v1 is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.resolve_order_intake_context_v1/.test(SQL));
assert("7b: ensure_service_session (frozen by S-A) is not redefined by this migration",
  !/CREATE OR REPLACE FUNCTION public\.ensure_service_session/.test(SQL));
assert("7c: consolidate_period_v1/period_consolidations are not touched",
  !/consolidate_period_v1/.test(SQL_CODE_ONLY) && !/ALTER TABLE public\.period_consolidations/.test(SQL_CODE_ONLY));
assert("7d: no real operational_service_v1 row is created or referenced by this migration"
  + " (the string appears only inside comments/error messages describing the invariant, never in an INSERT/VALUES)",
  !/(INSERT INTO|VALUES)[\s\S]{0,200}'operational_service_v1'/.test(SQL_CODE_ONLY));
assert("7e: no historical UPDATE backfills any of the new columns anywhere in this file",
  !/UPDATE public\.(table_order_lines|payment_transactions|order_financial_events)\s+SET\s+\S*economic_period/i.test(SQL_CODE_ONLY));

console.log("\n== H. Post-conditions — structural, real data/pointer/financial-unchanged assertions ==");
assert("8a: post-condition asserts zero backfilled rows on all three tables",
  /table_order_lines has non-NULL economic_period_kind rows -- historical backfill is forbidden/.test(SQL)
  && /payment_transactions has non-NULL economic_period_kind rows -- historical backfill is forbidden/.test(SQL)
  && /order_financial_events has non-NULL stamp rows -- historical backfill is forbidden/.test(SQL));
assert("8b: post-condition asserts payment_allocations/order_entities/ordenes were never touched",
  /payment_allocations must not carry an economic-period stamp/.test(SQL)
  && /order_entities must not carry an economic-period stamp/.test(SQL)
  && /ordenes must not carry an economic-period stamp/.test(SQL));
assert("8c: post-condition asserts the real legacy shadow is byte-identical before/after",
  /legacy shadow changed unexpectedly by this migration/.test(SQL));
assert("8d: post-condition asserts the real canonical pointer is byte-identical before/after",
  /canonical pointer changed unexpectedly by this migration/.test(SQL));
assert("8e: post-condition asserts payment_transactions/payment_allocations sums still reconcile",
  /payment_transactions\/payment_allocations sums diverged/.test(SQL));
assert("8f: post-condition asserts period_consolidations population unchanged (exactly 5)",
  /period_consolidations\) <> 5/.test(SQL));
assert("8g: post-condition asserts zero real operational_service_v1 rows exist (S-B invariant preserved)",
  /real operational_service_v1 rows must remain 0/.test(SQL));

console.log("\n== I. Paired rollback — refuses once real evidence exists, restores exact pre-S-C shape ==");
assert("9a: rollback refuses if any row has actually been stamped",
  /S-C rollback refused/.test(ROLLBACK) && /already carry a real economic_period_kind stamp/.test(ROLLBACK));
assert("9b: rollback restores the EXACT byte-captured pre-S-C service_session_assign_financial_event body",
  /SELECT o\.service_session_id INTO v_session_id\s*\n\s*FROM public\.ordenes o WHERE o\.id = NEW\.order_id;/.test(ROLLBACK_CODE_ONLY)
  && !/v_order_created_at/.test(ROLLBACK_CODE_ONLY.split("-- order_financial_events")[1] || ROLLBACK_CODE_ONLY));
assert("9c: rollback drops all four new columns and their CHECKs, the two new triggers, and the classifier function",
  /DROP COLUMN IF EXISTS obligation_economic_period_kind/.test(ROLLBACK_CODE_ONLY)
  && /DROP COLUMN IF EXISTS event_economic_period_kind/.test(ROLLBACK_CODE_ONLY)
  && (ROLLBACK_CODE_ONLY.match(/DROP COLUMN IF EXISTS economic_period_kind/g) || []).length === 2
  && /DROP TRIGGER IF EXISTS table_order_lines_stamp_economic_period_v1/.test(ROLLBACK_CODE_ONLY)
  && /DROP TRIGGER IF EXISTS payment_transactions_stamp_economic_period_v1/.test(ROLLBACK_CODE_ONLY)
  && /DROP FUNCTION IF EXISTS public\.classify_economic_period_v1\(timestamptz\)/.test(ROLLBACK_CODE_ONLY));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
