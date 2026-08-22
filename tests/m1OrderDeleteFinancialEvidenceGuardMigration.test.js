// tests/m1OrderDeleteFinancialEvidenceGuardMigration.test.js — M-1 static migration assertions
// (no SQL run — the real behavioral proof is the rollback-safe DB probe against live staging
// data, run separately and recorded in this slice's report). Run:
//   node tests/m1OrderDeleteFinancialEvidenceGuardMigration.test.js
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const dir = path.join(__dirname, "..", "migrations");
const stripComments = (s) => s.replace(/--.*$/gm, "");
const fwdRaw = fs.readFileSync(path.join(dir, "2026-08-22_m1_order_delete_financial_evidence_guard.sql"), "utf8");
const fwd = stripComments(fwdRaw);
const rb = stripComments(fs.readFileSync(path.join(dir, "2026-08-22_m1_order_delete_financial_evidence_guard.ROLLBACK.sql"), "utf8"));

// Isolate just the CREATE OR REPLACE function body -- the predecessor guard
// (forward file) and the post-condition DO block (both files) legitimately
// MENTION these code strings while checking for their presence/absence, so a
// whole-file search is not a safe proxy for "what the restored function
// actually contains".
const fnBody = (text) => {
  const start = text.indexOf("CREATE OR REPLACE FUNCTION");
  return text.slice(start, text.indexOf("$$;", start) + 3);
};
const fwdFn = fnBody(fwd);
const rbFn = fnBody(rb);

// ── Structure ──
check("has a predecessor guard before the transaction", /RAISE EXCEPTION 'M-1 refused:/.test(fwd) && fwd.indexOf("RAISE EXCEPTION 'M-1 refused:") < fwd.indexOf("BEGIN;"));
check("wrapped in one transaction", /BEGIN;/.test(fwd) && /COMMIT;\s*$/.test(fwd.trim()));
check("replaces delete_order_if_not_active(text)", /CREATE OR REPLACE FUNCTION public\.delete_order_if_not_active\(p_order_id text\)/.test(fwd));
check("stays SECURITY INVOKER (unchanged authority model)", /SECURITY INVOKER/.test(fwd));
check("stays fixed search_path", /SET search_path = public, pg_temp/.test(fwd));
check("no ledger INSERT embedded in the file (checksum self-reference avoided, matches ledgers 96-102)", !/INSERT INTO public\.ladieci_schema_migrations/.test(fwd));
check("no CREATE TABLE / no CREATE POLICY (function-body-only change)", !/CREATE TABLE/i.test(fwd) && !/CREATE POLICY/.test(fwd));
check("no business DML (no INSERT/UPDATE/DELETE against a business table)",
  !/\bINSERT INTO public\.(ordenes|order_financial_events|table_order_lines|payment_allocations|payment_transactions|service_incidents|config)\b/.test(fwd) &&
  !/\bUPDATE public\.(ordenes|order_financial_events|table_order_lines|payment_allocations|payment_transactions|service_incidents|config)\b/.test(fwd) &&
  !/\bDELETE FROM public\.(order_financial_events|table_order_lines|payment_allocations|payment_transactions|service_incidents|config)\b/.test(fwd));

// ── Pre-existing guard preserved ──
check("pre-existing advisory lock unchanged", /pg_advisory_xact_lock\(hashtext\('LA_DIECI_DRIVER_STATO'\)\)/.test(fwd));
check("pre-existing config row lock unchanged", /FROM public\.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE/.test(fwd));
check("pre-existing active-trip guard survives verbatim", /ACTIVE_TRIP_MEMBER_CONFLICT/.test(fwd));
check("active-trip guard textually precedes the new evidence guard", fwdFn.indexOf("ACTIVE_TRIP_MEMBER_CONFLICT") < fwdFn.indexOf("ORDER_HAS_FINANCIAL_EVIDENCE"));
check("the original DELETE statement is unchanged", /DELETE FROM public\.ordenes WHERE id = p_order_id;/.test(fwd));

// ── New guard: typed code + composite identity across all four evidence sources ──
check("new typed code ORDER_HAS_FINANCIAL_EVIDENCE", /'ok', false, 'code', 'ORDER_HAS_FINANCIAL_EVIDENCE'/.test(fwd));
check("checks order_financial_events", /order_financial_events e[\s\S]{0,200}e\.order_id = p_order_id/.test(fwd));
check("checks table_order_lines (Mesa)", /table_order_lines tol[\s\S]{0,200}tol\.order_id = p_order_id/.test(fwd));
check("checks payment_allocations joined through payment_transactions", /payment_allocations pa\s+JOIN public\.payment_transactions pt ON pt\.id = pa\.payment_transaction_id/.test(fwd));
check("checks service_incidents", /service_incidents si[\s\S]{0,200}si\.order_id = p_order_id/.test(fwd));
check("every evidence source is scoped by v_session (composite identity, not order_id alone)",
  (fwd.match(/v_session IS NULL OR [a-z.]+service_session_id/g) || []).length >= 4);
check("v_session is read from the candidate order's OWN row, once, inside this transaction",
  /SELECT true, service_session_id INTO v_found, v_session\s+FROM public\.ordenes WHERE id = p_order_id;/.test(fwd));
check("a not-found order skips the evidence check (idempotent-retry preserved)", /IF v_found THEN/.test(fwd));
check("check and DELETE share one function body (no separate JS pre-check)", fwd.indexOf("v_has_evidence") < fwd.lastIndexOf("DELETE FROM public.ordenes"));

// ── Grants unchanged ──
check("REVOKE ALL FROM PUBLIC, anon, authenticated (exact signature)", /REVOKE ALL ON FUNCTION public\.delete_order_if_not_active\(text\) FROM PUBLIC, anon, authenticated;/.test(fwd));
check("GRANT EXECUTE TO service_role (exact signature)", /GRANT EXECUTE ON FUNCTION public\.delete_order_if_not_active\(text\) TO service_role;/.test(fwd));

// ── Post-conditions present ──
check("post-condition asserts the new guard exists", /position\('ORDER_HAS_FINANCIAL_EVIDENCE' in v_src\) = 0/.test(fwd));
check("post-condition asserts the old guard survived", /position\('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src\) = 0/.test(fwd));
check("post-condition asserts guard ordering", /guard ordering changed/.test(fwd));
check("post-condition asserts grants (service_role has EXECUTE, anon/authenticated do not)",
  /has_function_privilege\('service_role', 'public\.delete_order_if_not_active\(text\)', 'EXECUTE'\)/.test(fwd) &&
  /has_function_privilege\('anon', 'public\.delete_order_if_not_active\(text\)', 'EXECUTE'\)/.test(fwd));

// ── Rollback ──
check("rollback wrapped in one transaction", /BEGIN;/.test(rb) && /COMMIT;\s*$/.test(rb.trim()));
check("rollback restores the exact pre-M-1 body (active-trip only, no evidence guard)",
  /ACTIVE_TRIP_MEMBER_CONFLICT/.test(rbFn) && !/ORDER_HAS_FINANCIAL_EVIDENCE/.test(rbFn));
check("rollback restores the original single-statement DELETE (no v_found/v_session branching)",
  !/v_has_evidence/.test(rbFn) && !/v_session/.test(rbFn));
check("rollback restates the same grants", /REVOKE ALL ON FUNCTION public\.delete_order_if_not_active\(text\) FROM PUBLIC, anon, authenticated;/.test(rb) && /GRANT EXECUTE ON FUNCTION public\.delete_order_if_not_active\(text\) TO service_role;/.test(rb));
check("rollback has its own post-condition", /rollback post-condition failed/.test(rb));

// ── Checksum sanity (documents the convention this file itself follows) ──
const crypto = require("crypto");
const checksum = crypto.createHash("sha256").update(fwdRaw, "utf8").digest("hex").slice(0, 16);
check("checksum is a 16-hex-char string (manifest convention)", /^[0-9a-f]{16}$/.test(checksum));

console.log(`\nm1OrderDeleteFinancialEvidenceGuardMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
