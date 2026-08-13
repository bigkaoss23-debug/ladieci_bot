"use strict";
// SERVICE LIFECYCLE RUNTIME AUTHORITY — NATURAL ROLLOVER FINAL PROOF.
// Static (source-text) proof for the guard-exemption migration: the
// property being proven is "this exact SQL shape exists in the migration
// file", which a running test cannot demonstrate more conclusively than
// reading the file — same convention as
// tests/crossServiceTableBypassSecurity.static.test.js for the sibling
// allowOpenTablesAcrossBoundary bypass.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const MIGRATION = read("migrations/2026-08-13_guard_service_session_closed_incident_safe_exemption.sql");
const ROLLBACK = read("migrations/2026-08-13_guard_service_session_closed_incident_safe_exemption.ROLLBACK.sql");
const LIFECYCLE = read("src/serviceSessions/serviceSessionLifecycle.js");
// language-guard: allow-legacy the required path below is the real close-engine module this test reads to verify its call site, not new vocabulary
const SERVIZIO = read("src/utils/servizio.js");

console.log("\n== complete_service_session_close: new parameter defaults false, marker set only when true ==");
assert("1a: p_preserve_active_orders defaults to false", /p_preserve_active_orders boolean DEFAULT false/.test(MIGRATION));
assert("1b: the marker is only set inside an IF p_preserve_active_orders THEN block", /IF p_preserve_active_orders THEN\s*\n\s*PERFORM set_config\('ladieci\.incident_safe_close_session_id'/.test(MIGRATION));
assert("1c: the marker set_config call is transaction-scoped (is_local=true, the 3rd arg)", /set_config\('ladieci\.incident_safe_close_session_id', v_session\.id::text, true\)/.test(MIGRATION));

console.log("\n== guard_service_session_closed_v1: NULL-safety on the new marker ==");
assert("2a: v_incident_safe is computed via COALESCE, never a raw current_setting comparison", /v_incident_safe boolean;/.test(MIGRATION) && /v_incident_safe := COALESCE\(current_setting\('ladieci\.incident_safe_close_session_id', true\), ''\) = OLD\.id::text;/.test(MIGRATION));
assert("2b: the table-check OR uses the pre-computed clean boolean, not a raw current_setting call", /OR v_incident_safe\s*\n\s*\) THEN/.test(MIGRATION));
assert("2c: no raw (non-COALESCEd) current_setting('ladieci.incident_safe_close_session_id'...) comparison exists anywhere outside the single v_incident_safe assignment", (MIGRATION.match(/current_setting\('ladieci\.incident_safe_close_session_id'/g) || []).length === 1);

console.log("\n== guard_service_session_closed_v1: pre-existing V3 exemption clause untouched ==");
assert("3a: the v3_close_authorized_session_id clause is preserved verbatim (same AND-with-service_closeouts shape)", /current_setting\('ladieci\.v3_close_authorized_session_id', true\) = OLD\.id::text\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_closeouts c WHERE c\.service_session_id = OLD\.id\s*\n\s*\)/.test(MIGRATION));

console.log("\n== guard_service_session_closed_v1: order check is per-order incident-backed, not a blanket bypass ==");
// language-guard: allow-legacy COMPLETATO/CHIUSO_FORZATO are the pre-existing terminal-estado literals this assertion checks for, not new vocabulary
assert("4a: the order EXISTS query still enumerates the same 7 terminal states, unchanged", /'RETIRADO', 'COMPLETADO', 'COMPLETATO',[^\n]*\n\s*'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'/.test(MIGRATION));
assert("4b: the exemption inside the order check requires v_incident_safe AND a matching service_incidents row for THIS order", /AND NOT \(\s*\n\s*v_incident_safe\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_incidents si\s*\n\s*WHERE si\.service_session_id = OLD\.id\s*\n\s*AND si\.order_id = o\.id::text\s*\n\s*\)\s*\n\s*\)/.test(MIGRATION));

console.log("\n== JS wiring: preserveActiveOrders flows from the close engine through to the RPC ==");
assert("5a: serviceSessionLifecycle.completeClose accepts preserveActiveOrders (default false)", /async completeClose\(\{ sessionId, actor, source = "backend", preserveActiveOrders = false \}\)/.test(LIFECYCLE));
assert("5b: completeClose forwards it as p_preserve_active_orders on the RPC call", /p_preserve_active_orders: preserveActiveOrders,/.test(LIFECYCLE));
// language-guard: allow-legacy servizio.js is the existing close-engine module path this assertion names, not new vocabulary
assert("5c: servizio.js's completeClose call site passes preserveActiveOrders through", /serviceSessionLifecycle\.completeClose\(\{ sessionId: serviceSessionId, actor, source, preserveActiveOrders \}\)/.test(SERVIZIO));

console.log("\n== ROLLBACK: refuses if drifted, restores both bodies without the new marker/parameter ==");
assert("6a: rollback refuses if complete_service_session_close no longer references the new parameter", /v_body1 NOT LIKE '%p_preserve_active_orders%'/.test(ROLLBACK));
assert("6b: rollback refuses if guard_service_session_closed_v1 no longer references the new marker", /v_body2 NOT LIKE '%incident_safe_close_session_id%'/.test(ROLLBACK));
assert("6c: rollback's restored complete_service_session_close signature has exactly the original 3 parameters (no 4th)", /CREATE FUNCTION public\.complete_service_session_close\(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend'::text\)\n/.test(ROLLBACK));

console.log("\n== overload-ambiguity discipline: DROP before CREATE, never a bare CREATE OR REPLACE across a widened signature ==");
assert("7a: forward migration drops the 3-arg overload before creating the 4-arg one (bare CREATE, not CREATE OR REPLACE, for complete_service_session_close)", /DROP FUNCTION IF EXISTS public\.complete_service_session_close\(uuid, text, text\);\s*\n\s*\nCREATE FUNCTION public\.complete_service_session_close\(/.test(MIGRATION));
assert("7b: rollback drops the 4-arg overload before recreating the 3-arg one", /DROP FUNCTION IF EXISTS public\.complete_service_session_close\(uuid, text, text, boolean\);\s*\n\s*\nCREATE FUNCTION public\.complete_service_session_close\(/.test(ROLLBACK));
assert("7c: guard_service_session_closed_v1 keeps CREATE OR REPLACE (its own signature never changes -- trigger functions take no arguments)", /CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1\(\)/.test(MIGRATION) && /CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1\(\)/.test(ROLLBACK));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
