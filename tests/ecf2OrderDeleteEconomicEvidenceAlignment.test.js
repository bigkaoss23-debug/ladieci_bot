// tests/ecf2OrderDeleteEconomicEvidenceAlignment.test.js — EC-F2 static migration
// assertions (no SQL run — the behavioral proof is the set of rollback-safe DB probes
// against live staging, recorded in this slice's report). Run:
//   node tests/ecf2OrderDeleteEconomicEvidenceAlignment.test.js
//
// WHAT EC-F2 CLOSES. delete_order_if_not_active recognised only four kinds of economic
// evidence and therefore hard-deleted (proven live, rollback-forced):
//   * a brand-new order carrying an N-2 obligation and zero payments -> deleted, and its
//     append-only order_obligations row left orphaned;
//   * an order whose only evidence was ya_pagado / cobrado (the #999024 class).
// delete_conversation_if_not_active already checked the legacy booleans but also lacked
// the obligation arm. Both now delegate to ONE predicate, so they cannot diverge again.
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } }

const dir = path.join(__dirname, "..", "migrations");
const BASE = "2026-08-25_ecf2_order_delete_economic_evidence_alignment";
const stripComments = (s) => s.replace(/--.*$/gm, "");
const fwdRaw = fs.readFileSync(path.join(dir, BASE + ".sql"), "utf8");
const rbRaw = fs.readFileSync(path.join(dir, BASE + ".ROLLBACK.sql"), "utf8");
const fwd = stripComments(fwdRaw);
const rb = stripComments(rbRaw);

// Isolate individual function bodies: the post-condition DO blocks legitimately MENTION
// these strings while asserting their presence, so a whole-file search is not a safe proxy.
const fnBody = (text, name) => {
  const start = text.indexOf("CREATE OR REPLACE FUNCTION public." + name);
  if (start < 0) return "";
  return text.slice(start, text.indexOf("$fn$;", start) + 5);
};
const helper = fnBody(fwd, "order_has_economic_evidence_v1");
const orderFn = fnBody(fwd, "delete_order_if_not_active");
const convFn = fnBody(fwd, "delete_conversation_if_not_active");
const rbOrderFn = fnBody(rb, "delete_order_if_not_active");
const rbConvFn = fnBody(rb, "delete_conversation_if_not_active");

console.log("── structure ──");
check("wrapped in one transaction", /BEGIN;/.test(fwd) && /COMMIT;\s*$/.test(fwd.trim()));
check("creates the shared predicate order_has_economic_evidence_v1(text)",
  /CREATE OR REPLACE FUNCTION public\.order_has_economic_evidence_v1\(p_order_id text\)/.test(fwd));
check("replaces delete_order_if_not_active(text)",
  /CREATE OR REPLACE FUNCTION public\.delete_order_if_not_active\(p_order_id text\)/.test(fwd));
check("replaces delete_conversation_if_not_active(text)",
  /CREATE OR REPLACE FUNCTION public\.delete_conversation_if_not_active\(p_wa_id text\)/.test(fwd));
check("every function stays SECURITY INVOKER (authority model unchanged)",
  (fwd.match(/SECURITY INVOKER/g) || []).length === 3);
check("every function pins search_path",
  (fwd.match(/SET search_path = public, pg_temp/g) || []).length === 3);
check("predicate is STABLE (a read-only guard, never a writer)", /\nSTABLE\n/.test(helper));
check("no CREATE TABLE / CREATE POLICY / CREATE TRIGGER — function bodies only",
  !/CREATE TABLE/i.test(fwd) && !/CREATE POLICY/i.test(fwd) && !/CREATE TRIGGER/i.test(fwd));
check("no ledger INSERT embedded (checksum self-reference avoided, matches ledgers 96-115)",
  !/INSERT INTO public\.ladieci_schema_migrations/.test(fwd));
check("no business DML anywhere except the guards' own pre-existing DELETEs",
  !/\bINSERT INTO public\.(ordenes|conv|wa_msgs|order_financial_events|order_obligations|table_order_lines|payment_allocations|payment_transactions|service_incidents|config)\b/.test(fwd) &&
  !/\bUPDATE public\.(ordenes|conv|wa_msgs|order_financial_events|order_obligations|table_order_lines|payment_allocations|payment_transactions|service_incidents|config)\b/.test(fwd) &&
  !/\bDELETE FROM public\.(order_financial_events|order_obligations|table_order_lines|payment_allocations|payment_transactions|service_incidents|config)\b/.test(fwd));
check("no backfill / no historical mutation", !/UPDATE public\.ordenes SET/.test(fwd));

console.log("── the ONE evidence contract: all seven classes ──");
for (const [label, re] of [
  ["legacy ya_pagado", /o\.ya_pagado IS TRUE/],
  ["legacy cobrado", /o\.cobrado IS TRUE/],
  ["N-2 order_obligations", /FROM public\.order_obligations ob/],
  ["order_financial_events", /FROM public\.order_financial_events e/],
  ["table_order_lines", /FROM public\.table_order_lines tol/],
  ["payment_allocations", /FROM public\.payment_allocations pa/],
  ["service_incidents", /FROM public\.service_incidents si/],
]) check("predicate covers " + label, re.test(helper));

console.log("── identity rules ──");
check("obligations matched on the PERMANENT order_uid, never the display id",
  /WHERE ob\.order_uid = o\.order_uid/.test(helper) && !/ob\.order_id/.test(helper));
check("N-6 composite scoping kept on all four display-id lookups (4 lookups, 4 clauses)",
  (helper.match(/o\.service_session_id IS NULL OR/g) || []).length === 4);
check("the NULL-tolerant arms are preserved verbatim (bias toward refusing)",
  /e\.service_session_id IS NULL OR e\.service_session_id = o\.service_session_id/.test(helper) &&
  /pt\.service_session_id IS NULL OR pt\.service_session_id = o\.service_session_id/.test(helper));
check("predicate is scoped to ONE order (o.id = p_order_id)", /WHERE o\.id = p_order_id/.test(helper));

console.log("── both guards delegate; neither keeps a private copy ──");
check("single-order guard calls the shared predicate", /order_has_economic_evidence_v1\(p_order_id\)/.test(orderFn));
check("conversation guard calls the shared predicate", /order_has_economic_evidence_v1\(o\.id\)/.test(convFn));
check("single-order guard has NO inline evidence predicate left",
  !/order_financial_events/.test(orderFn) && !/table_order_lines/.test(orderFn) &&
  !/payment_allocations/.test(orderFn) && !/service_incidents/.test(orderFn));
check("conversation guard has NO inline evidence predicate left",
  !/order_financial_events/.test(convFn) && !/table_order_lines/.test(convFn) &&
  !/payment_allocations/.test(convFn) && !/service_incidents/.test(convFn));

console.log("── pre-existing protections preserved (must not weaken M-1 / N-1) ──");
check("single-order: advisory lock kept", /pg_advisory_xact_lock\('LA_DIECI_DRIVER_STATO'\)|pg_advisory_xact_lock\(hashtext\('LA_DIECI_DRIVER_STATO'\)\)/.test(orderFn));
check("single-order: active-trip refusal kept", /ACTIVE_TRIP_MEMBER_CONFLICT/.test(orderFn));
check("single-order: refusal code unchanged", /ORDER_HAS_FINANCIAL_EVIDENCE/.test(orderFn));
check("single-order: idempotent-retry behaviour kept (v_found gate before the DELETE)",
  /SELECT true INTO v_found FROM public\.ordenes WHERE id = p_order_id/.test(orderFn) && /IF v_found THEN/.test(orderFn));
check("conversation: advisory lock kept", /pg_advisory_xact_lock/.test(convFn));
check("conversation: active-trip refusal kept", /ACTIVE_TRIP_MEMBER_CONFLICT/.test(convFn));
check("conversation: INVALID_WA_ID validation kept", /INVALID_WA_ID/.test(convFn));
check("conversation: refusal code unchanged", /CONVERSATION_HAS_FINANCIAL_EVIDENCE/.test(convFn));
check("conversation: the three original DELETEs kept in order",
  /DELETE FROM public\.conv WHERE wa_id/.test(convFn) &&
  /DELETE FROM public\.wa_msgs WHERE wa_id/.test(convFn) &&
  /DELETE FROM public\.ordenes WHERE wa_id/.test(convFn));
check("no refusal leaks a raw table name to the caller",
  !/'.*order_obligations.*'/.test(orderFn.replace(/RAISE[\s\S]*?;/g, "")) &&
  /jsonb_build_object\('ok', false, 'code', 'ORDER_HAS_FINANCIAL_EVIDENCE'\)/.test(orderFn));

console.log("── post-conditions actually assert the contract ──");
for (const [label, re] of [
  ["seven classes present", /lost one of its seven classes/],
  ["obligation keyed on order_uid", /obligation lookup is not keyed on order_uid/],
  ["4 session-scoped lookups", /expected exactly 4 session-scoped display-id lookups/],
  ["both guards delegate", /does not delegate to the shared predicate/],
  ["no inline copy survives", /still carries its own inline evidence predicate/],
  ["active-trip preserved", /active-trip refusal lost/],
  ["service_role bypasses RLS (the obligation arm would be inert otherwise)", /does not bypass RLS/],
  ["service_role can SELECT order_obligations", /cannot SELECT order_obligations/],
  ["EXECUTE grants present", /service_role EXECUTE grant missing/],
  ["N-2 append-only trigger still present", /order_obligations append-only trigger disappeared/],
]) check("post-condition: " + label, re.test(fwd));

console.log("── grants ──");
check("predicate revoked from PUBLIC then granted to service_role only",
  /REVOKE ALL ON FUNCTION public\.order_has_economic_evidence_v1\(text\) FROM PUBLIC/.test(fwd) &&
  /GRANT EXECUTE ON FUNCTION public\.order_has_economic_evidence_v1\(text\) TO service_role/.test(fwd) &&
  !/TO (anon|authenticated)/.test(fwd));

console.log("── rollback ──");
check("rollback exists and is one transaction", /BEGIN;/.test(rb) && /COMMIT;\s*$/.test(rb.trim()));
check("rollback drops the shared predicate LAST", /DROP FUNCTION IF EXISTS public\.order_has_economic_evidence_v1\(text\)/.test(rb) &&
  rb.indexOf("DROP FUNCTION IF EXISTS public.order_has_economic_evidence_v1") > rb.indexOf("CREATE OR REPLACE FUNCTION public.delete_conversation_if_not_active"));
check("rollback restores both guards to self-contained bodies",
  /order_financial_events/.test(rbOrderFn) && /order_financial_events/.test(rbConvFn) &&
  !/order_has_economic_evidence_v1/.test(rbOrderFn) && !/order_has_economic_evidence_v1/.test(rbConvFn));
check("rollback restores the pre-EC-F2 conversation guard WITH its legacy booleans",
  /o\.ya_pagado IS TRUE/.test(rbConvFn) && /o\.cobrado IS TRUE/.test(rbConvFn));
check("rollback restores the pre-EC-F2 single-order guard WITHOUT them (the defect, as it was)",
  !/ya_pagado/.test(rbOrderFn) && !/cobrado/.test(rbOrderFn) && !/order_obligations/.test(rbOrderFn));
check("rollback DELETES NO financial facts or obligations",
  !/DELETE FROM public\.(order_financial_events|order_obligations|service_closeouts|payment_transactions|payment_allocations|table_order_lines)\b/.test(rb) &&
  !/TRUNCATE/i.test(rb));
check("rollback performs no backfill", !/UPDATE public\.ordenes SET/.test(rb));
check("rollback header states plainly that it reinstates the defect",
  /WHAT COMES BACK IS THE DEFECT/.test(rbRaw));

console.log("\nEC-F2: " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
