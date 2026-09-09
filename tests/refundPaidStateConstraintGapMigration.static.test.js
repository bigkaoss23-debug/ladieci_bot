"use strict";
// REFUND_PAID_STATE_CONSTRAINT_GAP_V1 — static test over migration 124's SQL
// text. No live Postgres is applied for a NEW, unapplied migration
// (STAGING ONLY, no database mutation from this block). Same convention as
// tests/staleServiceProtectionMigration.static.test.js /
// tests/checkCentricUniversalCashV1Migration.test.js.
//
// WHAT THIS FILE DOES NOT PROVE (stated plainly, not hidden): it cannot
// execute the CHECK constraint against real PostgreSQL — no `pg` driver, no
// psql/postgres/initdb binary, no Docker, no Supabase CLI, no running local
// Postgres service exists in this environment (verified in the audit/
// implementation session that produced this migration, not assumed; same
// class of reported tooling limitation this project has documented since
// ledger row 57). Every assertion below is byte-exact text/structure
// verification against the committed migration/rollback files and the
// already-committed writer functions — it proves the SQL says what it must
// say, not that Postgres accepts it. See
// REFUND_PAID_STATE_CONSTRAINT_GAP_V1_IMPLEMENTATION_REPORT.md §7 for the
// LOCAL_DB_EXECUTION_BLOCKED gate this migration was authored under.
//
// THE GAP THIS TEST CLOSES (CHECK_CENTRIC_REFUND_INTERNAL_ERROR_AUDIT.md,
// §11): tests/checkCentricUniversalCashV1Migration.test.js exercises
// order_post_refund_v1 extensively but asserts nothing about
// ofe_pay_state_transition_chk or new_pay_state='paid'; the DAO-level tests
// (checkCentricCashService.test.js) stub `postRefund` to `{ ok: true }`, so
// no test in this repo's history has ever evaluated this constraint's own
// text, or proven that a canonical refund CAN legitimately produce
// new_pay_state='paid'. This file is that missing test.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const FWD = path.join(ROOT, "migrations", "2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.sql");
const RBK = path.join(ROOT, "migrations", "2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.ROLLBACK.sql");
// Already-committed inputs this migration widens the constraint FOR —
// read-only in this test, never modified.
const M122 = path.join(ROOT, "migrations", "2026-09-07_check_centric_universal_cash_v1_migration_122.sql");
const MESA_REFUND_MIG = path.join(ROOT, "migrations", "2026-08-26_refund_v1_slice_a_mesa_post_refund.sql");

function fnBody(src, name) {
  const re = new RegExp(
    "CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\." + name + "\\s*\\([^;]*?\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$",
    "g"
  );
  const m = re.exec(src);
  return m ? m[1] : null;
}

// The two exact constraint texts this migration transitions between,
// verified live against staging (tdikhfeinufaahagmpjz) via
// pg_get_constraintdef() in the 2026-09-09 forensic audit, and
// independently re-derived from the committed V3-H forward migration
// language-guard: allow-legacy v3h_messa_billing_foundation.sql is the existing migration filename this comment cites verbatim, not new vocabulary
// (2026-08-01_v3h_messa_billing_foundation.sql:322-337) — the two sources
// agree. OLD = the V3-H epoch this migration widens FROM. NEW = the exact
// widened text this migration installs.
const OLD_CHK =
  "CHECK ((((type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))) OR ((type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)) OR ((type = 'refund'::text) AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)) OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text])) AND (new_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'refunded'::text]))))) OR ((type = 'void'::text) AND (prev_pay_state = new_pay_state))))";
const NEW_CHK =
  "CHECK ((((type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))) OR ((type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)) OR ((type = 'refund'::text) AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)) OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text])) AND (new_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'paid'::text, 'refunded'::text]))))) OR ((type = 'void'::text) AND (prev_pay_state = new_pay_state))))";

(async () => {
  console.log("\n== REFUND_PAID_STATE_CONSTRAINT_GAP_V1 — migration 124 static checks ==\n");

  assert("0a: forward migration file exists", fs.existsSync(FWD));
  assert("0b: rollback file exists", fs.existsSync(RBK));
  assert("0c: prerequisite M122 file exists (base commit, untouched by this slice)", fs.existsSync(M122));
  assert("0d: prerequisite Mesa refund migration file exists (base commit, untouched)", fs.existsSync(MESA_REFUND_MIG));
  const sql = fs.readFileSync(FWD, "utf8");
  const rbk = fs.readFileSync(RBK, "utf8");
  const m122 = fs.readFileSync(M122, "utf8");
  const mesaRefundMig = fs.readFileSync(MESA_REFUND_MIG, "utf8");
  const noComments = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  console.log("\n-- staging safety --");
  assert("1a: wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert("1b: pre-condition drift guard present (DO $guard$)", /DO \$guard\$/.test(sql) && /M124 refused:/.test(sql));
  assert("1c: post-condition block present (DO $post$)", /DO \$post\$/.test(sql) && /M124 post-condition failed:/.test(sql));
  assert("1d: refuses if the live definition is not the exact V3-H epoch (byte-exact, not LIKE)",
    /IS DISTINCT FROM \$chk\$/.test(sql));
  assert("1e: DO blocks use named tags ($guard$ / $post$ / $chk$ / $frag$), never a bare top-level $$",
    !/[^a-zA-Z_]\$\$[^a-zA-Z_]/.test(sql.replace(/--[^\n]*/g, "")));
  assert("1f: ledger registration is NOT embedded (separate apply-time statement, as ledgers 96-123)",
    !/INSERT INTO public\.ladieci_schema_migrations/.test(sql));

  console.log("\n-- scope: exactly one constraint, zero functions, zero DML --");
  assert("2a: exactly one DROP CONSTRAINT ofe_pay_state_transition_chk",
    (sql.match(/DROP CONSTRAINT ofe_pay_state_transition_chk/g) || []).length === 1);
  assert("2b: exactly one real ADD CONSTRAINT ofe_pay_state_transition_chk DDL statement",
    (noComments.match(/ADD CONSTRAINT ofe_pay_state_transition_chk CHECK \(/g) || []).length === 1);
  assert("2c: no other constraint (ofe_prev_pay_state_chk / ofe_new_pay_state_chk / any other) is DROPped or ADDed",
    !/DROP CONSTRAINT ofe_prev_pay_state_chk/.test(sql) &&
    !/DROP CONSTRAINT ofe_new_pay_state_chk/.test(sql) &&
    !/ADD CONSTRAINT ofe_prev_pay_state_chk/.test(sql) &&
    !/ADD CONSTRAINT ofe_new_pay_state_chk/.test(sql));
  assert("2d: no CREATE/DROP/REPLACE FUNCTION anywhere — zero functions touched",
    !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(noComments) && !/DROP\s+FUNCTION/i.test(noComments));
  assert("2e: no CREATE/DROP TABLE, no TRIGGER, no INDEX",
    !/CREATE\s+TABLE/i.test(noComments) && !/DROP\s+TABLE/i.test(noComments) &&
    !/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i.test(noComments) && !/CREATE\s+(UNIQUE\s+)?INDEX/i.test(noComments));
  assert("2f: no DML anywhere (no INSERT/UPDATE/DELETE/TRUNCATE outside comments)",
    !/(INSERT INTO|UPDATE\s+public\.|DELETE FROM|TRUNCATE)/i.test(noComments));
  assert("2g: post-condition asserts order_financial_events / payment_transactions / payment_allocations / ordenes / order_obligations row counts are all unchanged",
    /m124_ofe_count/.test(sql) && /m124_pt_count/.test(sql) && /m124_pa_count/.test(sql) &&
    /m124_ordenes_count/.test(sql) && /m124_ob_count/.test(sql));
  assert("2h: post-condition asserts the total constraint count on order_financial_events is unchanged (proves exactly one swap, nothing else)",
    /m124_ofe_constraint_count/.test(sql));
  assert("2i: post-condition asserts the public schema's function count is unchanged (proves zero functions created/dropped/replaced)",
    /m124_public_fn_count/.test(sql));

  console.log("\n-- the exact widening, verified byte-for-byte --");
  assert("3a: guard checks the LIVE constraint against the exact OLD (V3-H) text",
    sql.includes(OLD_CHK));
  assert("3b: post-condition checks the NEW constraint against the exact widened text",
    sql.includes(NEW_CHK));
  assert("3c: the real ADD CONSTRAINT DDL body contains the widened array literal",
    /new_pay_state IN \('unpaid','partially_paid','paid','refunded'\)/.test(noComments));
  assert("3d: the widened array appears in EXACTLY the canonical-refund branch (payment_transaction_id IS NOT NULL), not elsewhere",
    (noComments.match(/new_pay_state IN \('unpaid','partially_paid','paid','refunded'\)/g) || []).length === 1);
  assert("3e: the payment branch text is byte-identical between OLD and NEW (untouched)",
    OLD_CHK.includes("(type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))") &&
    NEW_CHK.includes("(type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))"));
  assert("3f: the payment_imported branch text is byte-identical between OLD and NEW (untouched)",
    OLD_CHK.includes("(type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)") &&
    NEW_CHK.includes("(type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)"));
  assert("3g: the legacy refund branch (payment_transaction_id IS NULL) text is byte-identical between OLD and NEW (untouched)",
    OLD_CHK.includes("(payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)") &&
    NEW_CHK.includes("(payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)"));
  assert("3h: the void branch text is byte-identical between OLD and NEW (untouched)",
    OLD_CHK.includes("(type = 'void'::text) AND (prev_pay_state = new_pay_state)") &&
    NEW_CHK.includes("(type = 'void'::text) AND (prev_pay_state = new_pay_state)"));
  assert("3i: OLD and NEW differ by EXACTLY the string \"'paid'::text, \" inserted once (minimal diff, machine-verified)",
    (() => {
      const idx = NEW_CHK.indexOf("'paid'::text, 'refunded'");
      if (idx === -1) return false;
      const rebuiltOld = NEW_CHK.slice(0, idx) + NEW_CHK.slice(idx + "'paid'::text, ".length);
      return rebuiltOld === OLD_CHK;
    })());
  assert("3j: prev_pay_state for the canonical-refund branch is untouched (still partially_paid/paid only — a refund never starts from unpaid or refunded)",
    OLD_CHK.includes("(payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))") &&
    NEW_CHK.includes("(payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))"));

  console.log("\n-- rollback is a faithful, guarded inverse --");
  assert("4a: rollback wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(rbk) && /COMMIT;\s*$/m.test(rbk));
  assert("4b: rollback guard refuses unless the live text is the exact NEW (widened) state",
    rbk.includes(NEW_CHK) && /M124 ROLLBACK refused:/.test(rbk));
  assert("4c: rollback restores the exact OLD (V3-H) text",
    (() => {
      const rbkNoComments = rbk.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      return (rbkNoComments.match(/ADD CONSTRAINT ofe_pay_state_transition_chk CHECK \(/g) || []).length === 1 &&
        /new_pay_state IN \('unpaid','partially_paid','refunded'\)/.test(rbkNoComments) &&
        !/new_pay_state IN \('unpaid','partially_paid','paid','refunded'\)/.test(rbkNoComments);
    })());
  assert("4d: rollback post-condition checks against the exact OLD text",
    rbk.includes(OLD_CHK));
  assert("4e: rollback documents — does not code around — that re-adding the narrower CHECK fails (23514) if a refund→'paid' row already exists",
    /ROLLBACK_RESTORES_KNOWN_BROKEN_REFUND_OVERCOLLECTION_BEHAVIOR/.test(rbk) &&
    /23514/.test(rbk) &&
    !/DELETE FROM public\.order_financial_events/i.test(rbk) &&
    !/UPDATE public\.order_financial_events/i.test(rbk));
  assert("4f: rollback contains no DML anywhere",
    !/(INSERT INTO|UPDATE\s+public\.|DELETE FROM|TRUNCATE)/i.test(rbk.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")));
  assert("4g: rollback touches zero functions",
    !/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(rbk) && !/DROP\s+FUNCTION/i.test(rbk));

  console.log("\n-- filename / ledger --");
  assert("5a: filename sorts AFTER the ledger-123 migration",
    "2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.sql" >
    "2026-09-08_order_initial_payment_digest_schema_fix_migration_123.sql");
  assert("5b: filename declares apply_order 124 in its own name (house convention since ledger 118)",
    /_migration_124\.sql$/.test(path.basename(FWD)));
  assert("5c: guard checks ladieci_schema_migrations baseline is 123, not yet 124",
    /apply_order = 123/.test(sql) && /apply_order = 124/.test(sql));

  console.log("\n-- WRITER CONTRACT REGRESSION — both refund writers legitimately produce 'paid', unmodified by this slice --");
  // This is the section that proves the FIX belongs at the constraint layer,
  // not either writer: both order_post_refund_v1 and mesa_post_refund_v1
  // already compute new_pay_state='paid' whenever the refund leaves the
  // order's net collected still >= its obligation/total. Neither function's
  // source is touched by this migration or this test — read-only extraction
  // from the already-committed base files.
  const orderRefundFn = fnBody(m122, "order_post_refund_v1");
  const mesaRefundFn = fnBody(mesaRefundMig, "mesa_post_refund_v1");
  assert("6a: order_post_refund_v1 body extracted from migration 122 (non-empty)", !!orderRefundFn && orderRefundFn.length > 500);
  assert("6b: mesa_post_refund_v1 body extracted from its own migration (non-empty)", !!mesaRefundFn && mesaRefundFn.length > 500);
  assert("6c: order_post_refund_v1 computes new_pay_state='paid' when new_paid_cents >= obligation_cents (the exact branch this migration exists to permit)",
    /v_new_state := CASE/.test(orderRefundFn) &&
    /WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'/.test(orderRefundFn));
  assert("6d: mesa_post_refund_v1 computes new_pay_state='paid' via the STRUCTURALLY IDENTICAL rule (>= total THEN 'paid') — same latent defect, same fix required",
    /v_new_state := CASE/.test(mesaRefundFn) &&
    /WHEN v_new_paid_cents >= v_order_total_cents THEN 'paid'/.test(mesaRefundFn));
  assert("6e: neither writer file is modified by this slice (base-commit files, read-only inputs to this test)",
    fs.statSync(M122).isFile() && fs.statSync(MESA_REFUND_MIG).isFile());
  assert("6f: order_post_refund_v1 still INSERTs into order_financial_events with new_pay_state (this migration does not change WHAT is written, only what the constraint accepts)",
    /INSERT INTO public\.order_financial_events/.test(orderRefundFn) && /new_pay_state/.test(orderRefundFn));
  assert("6g: mesa_post_refund_v1 still INSERTs into order_financial_events with new_pay_state",
    /INSERT INTO public\.order_financial_events/.test(mesaRefundFn) && /new_pay_state/.test(mesaRefundFn));

  console.log(`\n== refundPaidStateConstraintGapMigration.static: ${pass} passed, ${fail} failed ==\n`);
  if (fail > 0) process.exitCode = 1;
})();
