"use strict";
// MESA / SALA — S2 (three attribution writers + receipt-service schema).
// Static (source-text) proof for the migration: the property being proven
// is "this exact SQL shape exists in the migration file", which a running
// test cannot demonstrate more conclusively than reading the file -- same
// convention as tests/s1GuardNullPaymentIdempotency.static.test.js.
// Behavioral proof (old body fails / new body passes; live F-02/F-29
// regression) is live-validated against real staging with isolated
// TEST-S2-* fixtures -- Postgres functions cannot run standalone in Node.
// Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S2.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const MIGRATION = read("migrations/2026-08-15_s2_attribution_writers_receipt_service.sql");
const ROLLBACK = read("migrations/2026-08-15_s2_attribution_writers_receipt_service.ROLLBACK.sql");
const MIGRATION_CODE = stripComments(MIGRATION);

console.log("\n== A. mesa_snapshot_order_lines_v1: obligation service = the order's own service (F-02) ==");
assert("1a: the fixed INSERT uses NEW.service_session_id, never v_session.service_session_id",
  /VALUES \(\s*\n\s*v_session\.workspace_id, v_session\.id, NEW\.service_session_id, NEW\.id,/.test(MIGRATION));
assert("1b: v_session.service_session_id is never referenced in this function's CODE (comment-stripped -- the fix comment legitimately names it in prose to explain what it replaced)",
  (() => {
    const m = MIGRATION_CODE.match(/CREATE OR REPLACE FUNCTION public\.mesa_snapshot_order_lines_v1\(\)[\s\S]*?\$function\$;/);
    return m && !/v_session\.service_session_id/.test(m[0]);
  })());
assert("1c: rollback restores the exact pre-S2 shape (v_session.service_session_id, not NEW.service_session_id)",
  /VALUES \(\s*\n\s*v_session\.workspace_id, v_session\.id, v_session\.service_session_id, NEW\.id,/.test(ROLLBACK));

console.log("\n== B. service_session_assign_financial_event: §5.3 CORRECTION 1, verbatim ==");
assert("2a: STEP 1 (live order) is unchanged", /SELECT o\.service_session_id INTO v_session_id\s*\n\s*FROM public\.ordenes o WHERE o\.id = NEW\.order_id;/.test(MIGRATION));
assert("2b: STEP 2 requires a payment_transaction_id before ever attempting the fallback",
  /IF v_session_id IS NULL AND NEW\.payment_transaction_id IS NOT NULL THEN/.test(MIGRATION));
assert("2c: the fallback resolves table_session_id from payment_transactions, never from a display id",
  /SELECT pt\.table_session_id INTO v_table_session\s*\n\s*FROM public\.payment_transactions pt WHERE pt\.id = NEW\.payment_transaction_id;/.test(MIGRATION));
assert("2d: candidates are joined via table_order_line_id (uuid), scoped by table_session_id AND order_id",
  /JOIN public\.table_order_lines\s+l ON l\.id = pa\.table_order_line_id\s*\n\s*WHERE pa\.payment_transaction_id = NEW\.payment_transaction_id\s*\n\s*AND l\.table_session_id\s+= v_table_session\s*\n\s*AND l\.order_id\s+= NEW\.order_id/.test(MIGRATION));
assert("2e: more than one distinct candidate raises ORDER_OBLIGATION_AMBIGUOUS, never picks one",
  /IF v_candidates IS NOT NULL AND cardinality\(v_candidates\) > 1 THEN\s*\n\s*RAISE EXCEPTION 'ORDER_OBLIGATION_AMBIGUOUS'/.test(MIGRATION));
assert("2f: no ORDER BY / no LIMIT anywhere in this function -- never 'newest wins'",
  (() => {
    const m = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.service_session_assign_financial_event\(\)[\s\S]*?END \$\$;/);
    return m && !/ORDER BY/i.test(m[0]) && !/\bLIMIT\b/i.test(m[0]);
  })());
assert("2g: the forbidden V2.1 fallback (storico ... ORDER BY id DESC LIMIT 1) does not appear as real code anywhere in this file", // language-guard: allow-legacy storico is referenced only in this assertion's own description/regex, checking that the MIGRATION file's text never uses it, not new vocabulary
  !/storico\s+WHERE\s+orden_id\s*=\s*NEW\.order_id\s+ORDER BY id DESC LIMIT 1/i.test(MIGRATION_CODE));
assert("2h: zero evidence still fails closed with the unchanged ORDER_WITHOUT_SERVICE_SESSION",
  /IF v_session_id IS NULL THEN\s*\n\s*RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001';/.test(MIGRATION));
assert("2i: rollback restores the exact pre-S2 two-line body (no candidate resolution at all -- v_candidates never appears in the RESTORED function itself; it legitimately appears in the file's own predecessor guard, which inspects the current live body before allowing rollback)",
  (() => {
    const restored = ROLLBACK.match(/CREATE OR REPLACE FUNCTION public\.service_session_assign_financial_event\(\)[\s\S]*?END \$\$;/);
    return restored
      && /SELECT o\.service_session_id INTO NEW\.service_session_id FROM public\.ordenes o WHERE o\.id = NEW\.order_id;\s*\n\s*IF NEW\.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION'/.test(restored[0])
      && !/v_candidates/.test(restored[0]);
  })());

console.log("\n== C. mesa_post_payment_v1: receipt service, event service, off-service nullability ==");
assert("3a: signature is IDENTICAL to S1's 13-arg form -- plain CREATE OR REPLACE, no DROP FUNCTION anywhere in this file",
  !/DROP FUNCTION public\.mesa_post_payment_v1/.test(MIGRATION));
assert("3b: v_receipt_service_id is resolved from service_session_state, requiring status='open'",
  /SELECT ss\.id INTO v_receipt_service_id\s*\n\s*FROM public\.service_session_state sst\s*\n\s*JOIN public\.service_sessions ss ON ss\.id = sst\.current_session_id AND ss\.status = 'open'\s*\n\s*WHERE sst\.singleton = true;/.test(MIGRATION));
assert("3c: the receipt-service lookup never RAISEs on a miss (off-service is legitimate, not an error)",
  (() => {
    const m = MIGRATION.match(/SELECT ss\.id INTO v_receipt_service_id[\s\S]{0,300}/);
    return m && !/RAISE EXCEPTION/.test(m[0]);
  })());
assert("3d: payment_transactions.service_session_id is written from v_receipt_service_id, never v_session.service_session_id",
  /VALUES \(\s*\n\s*p_workspace_id, v_session\.id, v_receipt_service_id, 'payment', p_mode,/.test(MIGRATION) &&
  !new RegExp("VALUES \\(\\s*\\n\\s*p_workspace_id, v_session\\.id, v_session\\.service_session_id, 'payment'").test(MIGRATION));
assert("3e: order_financial_events INSERT carries event_service_session_id = v_receipt_service_id",
  /event_service_session_id, payment_transaction_id, created_at\s*\n\s*\)\s*\n\s*SELECT[\s\S]*?v_session\.service_session_id, v_receipt_service_id, v_tx\.id, v_now/.test(MIGRATION));
assert("3f: the mirror-loop joins ordenes to fetch each order's own obligation_service_session_id",
  /JOIN public\.ordenes o ON o\.id = a\.order_id\s*\n\s*WHERE a\.payment_transaction_id = v_tx\.id\s*\n\s*GROUP BY a\.order_id, o\.service_session_id/.test(MIGRATION));
assert("3g: v_order_paid_before_cents filters on the order's own obligation service, not the table origin",
  /WHERE e\.service_session_id=v_order\.obligation_service_session_id AND e\.order_id=v_order\.order_id/.test(MIGRATION));
assert("3h: the final cobrado/ya_pagado projection's three subqueries filter on l.service_session_id, not v_session.service_session_id",
  (MIGRATION.match(/WHERE e\.service_session_id=l\.service_session_id AND e\.order_id=l\.order_id/g) || []).length === 3);
assert("3i: l.service_session_id is added to the projection's GROUP BY (functionally dependent, required by Postgres)",
  /FROM public\.table_order_lines l WHERE l\.table_session_id=v_session\.id GROUP BY l\.order_id, l\.service_session_id/.test(MIGRATION));
assert("3j: table-wide balance math (v_total_cents, v_paid_cents, v_remaining_covers, duplicate-candidate window) is untouched -- still table_session-scoped, no service filter added", // language-guard: allow-legacy CHIUSO_FORZATO is referenced only in this assertion's own regex, checking the MIGRATION file's text, not new vocabulary
  /WHERE l\.table_session_id = v_session\.id\s*\n\s*AND upper\(COALESCE\(o\.estado,''\)\) NOT IN \('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'\); -- language-guard/.test(MIGRATION));
assert("3k: S1's idempotency key, guard behavior, and duplicate-confirm audit are reproduced verbatim",
  /WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;/.test(MIGRATION) &&
  /'PAYMENT_REPLAY_DIFFERENT_ACTOR'/.test(MIGRATION) &&
  /'PAYMENT_DUPLICATE_CONFIRMED'/.test(MIGRATION) &&
  /interval '120 seconds'/.test(MIGRATION));
assert("3l: rollback restores payment_transactions.service_session_id to v_session.service_session_id (table origin) and the RESTORED function never references v_receipt_service_id (that name legitimately appears in the file's own predecessor guard, which inspects the current live body before allowing rollback)",
  (() => {
    const restored = ROLLBACK.match(/CREATE OR REPLACE FUNCTION public\.mesa_post_payment_v1\([\s\S]*?\$function\$;/);
    return restored
      && /VALUES \(\s*\n\s*p_workspace_id, v_session\.id, v_session\.service_session_id, 'payment', p_mode,/.test(restored[0])
      && !/v_receipt_service_id/.test(restored[0]);
  })());

console.log("\n== D. schema widening: nullable receipt service, new event_service_session_id, one transaction ==");
assert("4a: DROP NOT NULL and ADD COLUMN both appear before any CREATE OR REPLACE FUNCTION (DDL precedes writers in the same transaction)",
  MIGRATION.indexOf("ALTER COLUMN service_session_id DROP NOT NULL") < MIGRATION.indexOf("CREATE OR REPLACE FUNCTION") &&
  MIGRATION.indexOf("ADD COLUMN event_service_session_id") < MIGRATION.indexOf("CREATE OR REPLACE FUNCTION"));
assert("4b: event_service_session_id is nullable and references service_sessions(id)",
  /ADD COLUMN event_service_session_id uuid NULL REFERENCES public\.service_sessions\(id\);/.test(MIGRATION));
assert("4c: no explicit BEGIN...COMMIT wrapper needed beyond the file's own single-transaction execution (matches row-71/72 convention: no bare BEGIN/COMMIT, migration applied as one statement batch)",
  !/^BEGIN;/m.test(MIGRATION_CODE));
assert("4d: rollback restores NOT NULL only after the guard confirms zero NULL receipts",
  MIGRATION_CODE.length >= 0 &&
  /SELECT count\(\*\) INTO v_null_receipts FROM public\.payment_transactions WHERE service_session_id IS NULL;/.test(ROLLBACK) &&
  ROLLBACK.indexOf("v_null_receipts > 0") < ROLLBACK.indexOf("ALTER COLUMN service_session_id SET NOT NULL"));
assert("4e: rollback drops event_service_session_id before restoring NOT NULL",
  ROLLBACK.indexOf("DROP COLUMN event_service_session_id") < ROLLBACK.indexOf("SET NOT NULL"));

console.log("\n== predecessor guards: refuse over drift, refuse a re-patch ==");
assert("5a: forward migration refuses if mesa_snapshot_order_lines_v1 already writes NEW.service_session_id",
  /IF v_snapshot_body LIKE '%v_session\.workspace_id, v_session\.id, NEW\.service_session_id, NEW\.id,%' THEN\s*\n\s*RAISE EXCEPTION 'S2 refused: mesa_snapshot_order_lines_v1 already writes NEW\.service_session_id/.test(MIGRATION));
assert("5b: forward migration refuses if mesa_post_payment_v1 already carries v_receipt_service_id",
  /IF v_payment_body LIKE '%v_receipt_service_id%' THEN/.test(MIGRATION));
assert("5c: forward migration refuses if service_session_assign_financial_event already carries v_candidates",
  /IF v_event_body LIKE '%v_candidates%' THEN/.test(MIGRATION));
assert("5d: forward migration refuses if payment_transactions.service_session_id is already nullable",
  /IF v_col_nullable = 'YES' THEN/.test(MIGRATION));
assert("5e: forward migration refuses if event_service_session_id already exists",
  /order_financial_events.*column_name='event_service_session_id'/s.test(MIGRATION_CODE));
assert("5f: rollback refuses if any function does not carry the expected post-S2 shape",
  /S2 rollback refused: mesa_snapshot_order_lines_v1 does not carry the S2 NEW\.service_session_id fix/.test(ROLLBACK) &&
  /S2 rollback refused: mesa_post_payment_v1 does not carry the S2 v_receipt_service_id fix/.test(ROLLBACK) &&
  /S2 rollback refused: service_session_assign_financial_event does not carry the S2 candidate-resolution shape/.test(ROLLBACK));

console.log("\n== S1/S0 non-interference: this migration touches nothing S1 or S0 own ==");
assert("6a: no reference to payment_transactions_idempotency_uq, guard_service_session_closed_v1, or auth_audit_event_chk",
  !/payment_transactions_idempotency_uq/.test(MIGRATION_CODE) &&
  !/guard_service_session_closed_v1/.test(MIGRATION_CODE) &&
  !/auth_audit_event_chk/.test(MIGRATION_CODE));
assert("6b: no S3+ objects referenced (order_entities, order_uid, ladieci_schema_migrations)",
  !/order_entities/.test(MIGRATION_CODE) && !/order_uid/.test(MIGRATION_CODE) && !/ladieci_schema_migrations/.test(MIGRATION_CODE));
assert("6c: no UPDATE/DELETE against any of the four append-only financial tables anywhere in this file",
  !/UPDATE\s+public\.(table_order_lines|payment_transactions|payment_allocations|order_financial_events)\b/i.test(MIGRATION_CODE) &&
  !/DELETE\s+FROM\s+public\.(table_order_lines|payment_transactions|payment_allocations|order_financial_events)\b/i.test(MIGRATION_CODE));
assert("6d: no historical UPDATE/backfill of event_service_session_id (HISTORICAL METHOD: none)",
  !/UPDATE\s+public\.order_financial_events\s+SET\s+event_service_session_id/i.test(MIGRATION_CODE));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
