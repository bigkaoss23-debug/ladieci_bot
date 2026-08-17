"use strict";
// F-3 — Finalizar servicio repair, slice 3. Static (source-text) proof for
// the migration + paired rollback. Live acceptance (mandatory A-F matrix +
// multi-order load-bearing test G1/G2 + the real V3 engine sequence via
// acquire_closeout_attempt + create_service_incident x2 + create_service_
// closeout + close_service_session_v3) was run as its own separate,
// controlled step against real staging, entirely inside BEGIN/ROLLBACK,
// with the post-F-3 guard body installed only for the duration of that one
// transaction: Case A (non-terminal order, no V3 GUC) REJECT; Case B (V3
// GUC, no closeout) REJECT; Case C (V3 GUC + closeout, no incident) REJECT;
// Case D (incident for a different order) REJECT; Case E (generic
// service-level incident only, no order_id) REJECT; Case G1 (2 unresolved
// orders, incident for order A only) REJECT -- proves no existential-any-
// incident bug; Case F/G2 (2 unresolved orders, incident for EVERY
// unresolved order) ALLOW; V3-ENGINE fixture -- close_service_session_v3
// returned ok=true/V3_CLOSED, parent session closed, both child orders
// still exist/still non-terminal/still on the same session (not
// terminalized), canonical pointer cleared (F-1 behavior), legacy shadow
// updated, zero financial rewrite (payment_transactions unchanged). 15/15
// live assertions passed, zero residue confirmed after (fixture rows,
// sessions, closeouts, incidents all absent; guard function back to its
// pre-F-3 3-occurrence shape; ledger head unchanged at 86; real active
// session/canonical pointer/payment_transactions count all byte-identical
// before and after). See the migration's own header and the F-3 report for
// the exact live-verified JSON evidence.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_f3_v3_order_residue_guard_repair.sql");
const ROLLBACK = read("migrations/2026-08-17_f3_v3_order_residue_guard_repair.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-3 refused: staging sentinel migration absent/.test(SQL));
assert("1b: refuses if guard_service_session_closed_v1 does not exist",
  /F-3 refused: guard_service_session_closed_v1 does not exist/.test(SQL));
assert("1c: predecessor-body guard requires the exact byte-for-byte pre-F-3 order-residue exemption",
  /F-3 refused: guard_service_session_closed_v1 does not match the expected pre-F-3 body/.test(SQL));
assert("1d: drift guard refuses if the post-F-3 shape is already present",
  /F-3 refused: guard_service_session_closed_v1 already shows the post-F-3 order-residue V3 branch/.test(SQL));
assert("1e: empirical trigger-shape guard requires exactly one live call site",
  /F-3 refused: service_sessions_closed_live_work_guard trigger not found on service_sessions/.test(SQL) &&
  /F-3 refused: guard_service_session_closed_v1 has more than one live trigger call site/.test(SQL));

console.log("\n== B. The fix -- order-residue exemption gains a V3-authorized branch, mirroring the table-residue block's own shape ==");
const fnBody = stripSqlComments(
  SQL.split("CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1")[1]
    .split("-- Post-conditions")[0]
);

assert("2a: exactly one function is redefined in this migration",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1);
assert("2b: new V3 branch requires BOTH service_closeouts AND per-order service_incidents evidence (AND-chained, not bare)",
  /v_v3_authorized\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_closeouts c WHERE c\.service_session_id = OLD\.id\s*\n\s*\)\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_incidents si\s*\n\s*WHERE si\.service_session_id = OLD\.id\s*\n\s*AND si\.order_id = o\.id::text/.test(fnBody));
assert("2c: exactly 4 occurrences of v_v3_authorized post-fix (1 declare, 1 assign, 1 table-block, 1 NEW order-block)",
  (fnBody.match(/v_v3_authorized/g) || []).length === 4);
assert("2d: legacy incident_safe order-residue branch is byte-unchanged",
  /v_incident_safe\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_incidents si\s*\n\s*WHERE si\.service_session_id = OLD\.id\s*\n\s*AND si\.order_id = o\.id::text/.test(fnBody));

console.log("\n== C. Untouched invariants -- table-residue block + non-terminal-order predicate unchanged ==");
assert("3a: table-residue block's own V3 branch is byte-identical (still requires only service_closeouts, no per-order incident)",
  /IF NOT \(\s*\n\s*\(\s*\n\s*v_v3_authorized\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_closeouts c WHERE c\.service_session_id = OLD\.id\s*\n\s*\)\s*\n\s*\)\s*\n\s*OR v_incident_safe\s*\n\s*\) THEN/.test(fnBody));
assert("3b: MESA_TABLES_NOT_RELEASED message unchanged",
  /MESSAGE = 'MESA_TABLES_NOT_RELEASED'/.test(fnBody));
assert("3c: non-terminal-order estado vocabulary unchanged (exact 7-value list)",
  // language-guard: allow-legacy COMPLETATO/CHIUSO_FORZATO are the pre-existing terminal-estado literals this assertion checks for, not new vocabulary
  /'RETIRADO', 'COMPLETADO', 'COMPLETATO',\s*\n\s*'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'/.test(fnBody));
assert("3d: SERVICE_ACTIVE_ORDERS_NOT_RESOLVED message unchanged",
  /MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED'/.test(fnBody));
assert("3e: v_incident_safe/v_v3_authorized assignment lines unchanged",
  /v_incident_safe := COALESCE\(current_setting\('ladieci\.incident_safe_close_session_id', true\), ''\) = OLD\.id::text/.test(fnBody) &&
  /v_v3_authorized := COALESCE\(current_setting\('ladieci\.v3_close_authorized_session_id', true\), ''\) = OLD\.id::text/.test(fnBody));

console.log("\n== D. HARD SCOPE -- F-3 touches only this one function, no sibling defects ==");
assert("4a: ensure_next_service_session_v3 (F-2, V3-D1) is not redefined",
  !/CREATE OR REPLACE FUNCTION public\.ensure_next_service_session_v3/.test(SQL));
assert("4b: complete_service_session_close / close_service_session_v3 (F-1's own pointer-clear logic) not redefined",
  !/CREATE OR REPLACE FUNCTION public\.complete_service_session_close/.test(SQL) &&
  !/CREATE OR REPLACE FUNCTION public\.close_service_session_v3/.test(SQL));
assert("4c: no operational_service_v1 vocabulary introduced (V3-D3 untouched)",
  !/operational_service_v1/.test(SQL_CODE_ONLY));
assert("4d: no incident is ever CREATED by this migration (guard validates, never manufactures evidence)",
  !/INSERT INTO public\.service_incidents/.test(SQL_CODE_ONLY));

console.log("\n== E. Post-conditions -- structural, matching the established low-risk discipline ==");
assert("5a: asserts exactly 4 occurrences of v_v3_authorized",
  /v_v3_count <> 4/.test(SQL));
assert("5b: asserts the new V3 branch is AND-chained to both EXISTS clauses",
  /F-3 post-condition failed: new V3 order-residue branch does not require BOTH service_closeouts AND per-order service_incidents evidence/.test(SQL));
assert("5c: asserts the legacy incident_safe branch is unchanged",
  /F-3 post-condition failed: legacy incident_safe order-residue branch missing or changed/.test(SQL));
assert("5d: asserts the table-residue block is byte-unchanged",
  /F-3 post-condition failed: table-residue block changed -- must remain byte-identical/.test(SQL));
assert("5e: asserts the non-terminal-order estado vocabulary is unchanged",
  /F-3 post-condition failed: non-terminal-order predicate changed/.test(SQL));
assert("5f: asserts exactly one trigger call site, unchanged",
  /F-3 post-condition failed: trigger call-site count changed unexpectedly/.test(SQL));
assert("5g: asserts canonical pointer / legacy shadow / payment_transactions / service_closeouts / service_incidents population unchanged (pure CREATE OR REPLACE, no data writes)",
  /current_period_id changed unexpectedly/.test(SQL) &&
  /legacy shadow changed unexpectedly/.test(SQL) &&
  /payment_transactions population changed/.test(SQL) &&
  /service_closeouts population changed/.test(SQL) &&
  /service_incidents population changed/.test(SQL));

console.log("\n== F. Paired rollback -- restores exact byte-captured pre-F-3 (legacy-only) body, refuses if not applied ==");
assert("6a: rollback refuses if the function does not show the post-F-3 shape",
  /F-3 rollback refused: guard_service_session_closed_v1 does not show the post-F-3 shape/.test(ROLLBACK));
assert("6b: rollback restores the exact pre-F-3 order-residue exemption (legacy-only, no V3 branch)",
  (() => {
    const rbBody = stripSqlComments(
      ROLLBACK.split("CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1")[1]
        .split("-- Post-condition")[0]
    );
    return (rbBody.match(/v_v3_authorized/g) || []).length === 3
      && /NOT \(\s*\n\s*v_incident_safe\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_incidents si\s*\n\s*WHERE si\.service_session_id = OLD\.id\s*\n\s*AND si\.order_id = o\.id::text\s*\n\s*\)\s*\n\s*\)/.test(rbBody);
  })());
assert("6c: rollback's own post-condition asserts exactly 3 occurrences of v_v3_authorized after rollback",
  /v_v3_count <> 3/.test(ROLLBACK));
assert("6d: rollback touches no data table (function redefinition only)",
  !/\n\s*(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM)\s+public\./.test(
    ROLLBACK_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
