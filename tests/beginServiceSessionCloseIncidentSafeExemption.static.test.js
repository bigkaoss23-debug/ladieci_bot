"use strict";
// STALE_SERVICE_SESSION_SELF_HEAL — static (source-text) proof for
// 2026-08-15_begin_service_session_close_incident_safe_exemption.sql, the
// third of three independent "are there open Mesa tables" gates, and the
// only one that had no incident-safe exemption at all before this fix.
// Same convention as
// tests/guardServiceSessionClosedIncidentSafeExemption.static.test.js for
// the sibling complete_service_session_close exemption (row 68).
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const MIGRATION = read("migrations/2026-08-15_begin_service_session_close_incident_safe_exemption.sql");
const ROLLBACK = read("migrations/2026-08-15_begin_service_session_close_incident_safe_exemption.ROLLBACK.sql");
const LIFECYCLE = read("src/serviceSessions/serviceSessionLifecycle.js");
// language-guard: allow-legacy the required path below is the real close-engine module this test reads to verify its call site, not new vocabulary
const SERVIZIO = read("src/utils/servizio.js");

console.log("\n== predecessor-body guard: refuses to apply over drift or a re-patch ==");
assert("1a: guards against a missing/renamed 2-arg predecessor", /expected 2-arg begin_service_session_close\(text, text\) not found/.test(MIGRATION));
assert("1b: guards against a body that no longer contains the MESA_TABLES_NOT_RELEASED check", /v_body NOT LIKE '%MESA_TABLES_NOT_RELEASED%'/.test(MIGRATION));
assert("1c: guards against re-applying over an already-patched body", /v_body LIKE '%p_preserve_active_orders%'/.test(MIGRATION) && /already patched/.test(MIGRATION));
assert("1d: the guard runs as its own DO block, before the DROP/CREATE below it", MIGRATION.indexOf("RAISE EXCEPTION") < MIGRATION.indexOf("DROP FUNCTION IF EXISTS public.begin_service_session_close"));

console.log("\n== new parameter: same name/default/meaning as complete_service_session_close's own p_preserve_active_orders ==");
assert("2a: p_preserve_active_orders boolean DEFAULT false, third parameter", /p_source text DEFAULT 'backend'::text,\s*\n\s*p_preserve_active_orders boolean DEFAULT false/.test(MIGRATION));
assert("2b: the MESA_TABLES_NOT_RELEASED check is wrapped in IF NOT p_preserve_active_orders THEN", /IF NOT p_preserve_active_orders THEN\s*\n\s*PERFORM 1 FROM public\.table_sessions/.test(MIGRATION));
assert("2c: the RETURN MESA_TABLES_NOT_RELEASED line is still inside that same guarded block", /IF NOT p_preserve_active_orders THEN[\s\S]{0,300}RETURN jsonb_build_object\('ok',false,'code','MESA_TABLES_NOT_RELEASED'\);[\s\S]{0,50}END IF;\s*\n\s*END IF;/.test(MIGRATION));

console.log("\n== every other guard/behavior is untouched ==");
assert("3a: MULTIPLE_ACTIVE_SERVICE_SESSIONS guard unchanged", /MULTIPLE_ACTIVE_SERVICE_SESSIONS/.test(MIGRATION));
assert("3b: NO_SERVICE_SESSION / INVALID_RECENT_CLOSED_SESSION / ALREADY_CLOSED unchanged", /NO_SERVICE_SESSION/.test(MIGRATION) && /INVALID_RECENT_CLOSED_SESSION/.test(MIGRATION) && /ALREADY_CLOSED/.test(MIGRATION));
assert("3c: INVALID_CURRENT_SERVICE_SESSION guard unchanged", /INVALID_CURRENT_SERVICE_SESSION/.test(MIGRATION));
assert("3d: the advisory lock is still taken first, unchanged", /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(MIGRATION));
assert("3e: the UPDATE...RETURNING * INTO v_session fix from row 67 is preserved verbatim", /UPDATE public\.service_sessions\s*\n\s*SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now\(\)\s*\n\s*WHERE id=v_session\.id\s*\n\s*RETURNING \* INTO v_session;/.test(MIGRATION));
assert("3f: the service_session_audit insert is unchanged", /INSERT INTO public\.service_session_audit\(service_session_id,event_type,by_actor,source\)/.test(MIGRATION));

console.log("\n== no table_session is ever read for any purpose other than the existence check, never written ==");
assert("4a: table_sessions appears exactly once in the function body (the tolerated existence check itself)", (MIGRATION.match(/public\.table_sessions/g) || []).length === 1);
assert("4b: no UPDATE/DELETE against table_sessions anywhere in this migration", !/UPDATE public\.table_sessions/.test(MIGRATION) && !/DELETE FROM public\.table_sessions/.test(MIGRATION));

console.log("\n== overload-ambiguity discipline: DROP before CREATE, never a bare CREATE OR REPLACE across a widened signature ==");
assert("5a: forward migration drops the 2-arg overload before creating the 3-arg one (bare CREATE, not CREATE OR REPLACE)", /DROP FUNCTION IF EXISTS public\.begin_service_session_close\(text, text\);\s*\n\s*\nCREATE FUNCTION public\.begin_service_session_close\(/.test(MIGRATION));
assert("5b: rollback drops the 3-arg overload before recreating the 2-arg one", /DROP FUNCTION IF EXISTS public\.begin_service_session_close\(text, text, boolean\);\s*\n\s*\nCREATE OR REPLACE FUNCTION public\.begin_service_session_close\(/.test(ROLLBACK));
assert("5c: rollback's restored signature has exactly the original 2 parameters (no 3rd)", /CREATE OR REPLACE FUNCTION public\.begin_service_session_close\(p_closed_by text, p_source text DEFAULT 'backend'::text\)\n/.test(ROLLBACK));
assert("5d: rollback body has no trace of p_preserve_active_orders", !/p_preserve_active_orders/.test(ROLLBACK));

console.log("\n== grants: service_role only, matching every other mesa/service RPC ==");
assert("6a: forward grants execute on the new 3-arg overload to service_role only", /REVOKE ALL ON FUNCTION public\.begin_service_session_close\(text, text, boolean\) FROM PUBLIC, anon, authenticated;\s*\nGRANT EXECUTE ON FUNCTION public\.begin_service_session_close\(text, text, boolean\) TO service_role;/.test(MIGRATION));
assert("6b: rollback restores the grant on the 2-arg overload", /REVOKE ALL ON FUNCTION public\.begin_service_session_close\(text, text\) FROM PUBLIC, anon, authenticated;\s*\nGRANT EXECUTE ON FUNCTION public\.begin_service_session_close\(text, text\) TO service_role;/.test(ROLLBACK));

console.log("\n== JS wiring: preserveActiveOrders flows from the close engine through beginClose to the RPC, mirroring completeClose exactly ==");
assert("7a: serviceSessionLifecycle.beginClose accepts preserveActiveOrders (default false)", /async beginClose\(\{ actor, source = "backend", preserveActiveOrders = false \}\)/.test(LIFECYCLE));
assert("7b: beginClose forwards it as p_preserve_active_orders on the RPC call", /p_closed_by: actor, p_source: source, p_preserve_active_orders: preserveActiveOrders,/.test(LIFECYCLE));
// language-guard: allow-legacy servizio.js is the existing close-engine module path this assertion names, not new vocabulary
assert("7c: servizio.js's beginClose call site passes preserveActiveOrders through", /serviceSessionLifecycle\.beginClose\(\{ actor, source, preserveActiveOrders \}\)/.test(SERVIZIO));

console.log("\n== both halves of the close transition express the identical policy, no contradictory gate remains ==");
assert("8a: begin and complete both use the exact parameter name p_preserve_active_orders", (MIGRATION.match(/p_preserve_active_orders/g) || []).length >= 3);
assert("8b: beginClose and completeClose both default preserveActiveOrders to false in the JS wrapper", (LIFECYCLE.match(/preserveActiveOrders = false/g) || []).length === 2);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
