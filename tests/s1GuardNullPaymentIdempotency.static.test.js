"use strict";
// MESA / SALA — S1 (guard NULL fix + payment idempotency + duplicate-candidate
// protection). Static (source-text) proof for the migration: the property
// being proven is "this exact SQL shape exists in the migration file", which
// a running test cannot demonstrate more conclusively than reading the file
// -- same convention as tests/guardServiceSessionClosedIncidentSafeExemption.static.test.js.
// Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S1.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
// The migration's own header comment legitimately documents (in prose) the
// exact strings these S2-non-interference / raw-current_setting checks look
// for -- once to explain the bug being fixed, once to state what this
// migration deliberately does NOT touch. Stripping `--` comment lines before
// running those specific checks avoids the header's own documentation being
// mistaken for a real DDL/DML reference.
const stripComments = (text) => text.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const MIGRATION = read("migrations/2026-08-15_s1_guard_null_payment_idempotency.sql");
const ROLLBACK = read("migrations/2026-08-15_s1_guard_null_payment_idempotency.ROLLBACK.sql");
const DAO = read("src/tables/mesaDao.js");
const MIGRATION_CODE = stripComments(MIGRATION);
const guardFnMatch = MIGRATION.match(/CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1\(\)[\s\S]*?\$function\$;/);
const GUARD_FN_BODY = guardFnMatch ? guardFnMatch[0] : "";

console.log("\n== A. guard_service_session_closed_v1: NULL-safety on the v3-authorized clause ==");
assert("1a: v_v3_authorized is COALESCE-wrapped, never a raw current_setting comparison",
  /v_v3_authorized boolean;/.test(MIGRATION) &&
  /v_v3_authorized := COALESCE\(current_setting\('ladieci\.v3_close_authorized_session_id', true\), ''\) = OLD\.id::text;/.test(MIGRATION));
assert("1b: v_incident_safe's own COALESCE wrapping is untouched (unchanged from row 68)",
  /v_incident_safe := COALESCE\(current_setting\('ladieci\.incident_safe_close_session_id', true\), ''\) = OLD\.id::text;/.test(MIGRATION));
assert("1c: the table-check clause uses the pre-computed clean boolean, not a raw current_setting call",
  /IF NOT \(\s*\n\s*\(\s*\n\s*v_v3_authorized\s*\n\s*AND EXISTS \(\s*\n\s*SELECT 1 FROM public\.service_closeouts c WHERE c\.service_session_id = OLD\.id\s*\n\s*\)\s*\n\s*\)\s*\n\s*OR v_incident_safe\s*\n\s*\) THEN/.test(MIGRATION));
assert("1d: no raw (non-COALESCEd) current_setting('ladieci.v3_close_authorized_session_id'...) comparison exists anywhere in the guard function body outside the single v_v3_authorized assignment",
  GUARD_FN_BODY.length > 0 &&
  (GUARD_FN_BODY.match(/current_setting\('ladieci\.v3_close_authorized_session_id'/g) || []).length === 1);
assert("1e: the four-case truth table is documented in the migration header (including the previously-NULL case)",
  /1\. setting unset \(NULL\), closeouts EXISTS=false/.test(MIGRATION) &&
  /2\. setting unset \(NULL\), closeouts EXISTS=true.*table check RUNS.*\*/.test(MIGRATION) &&
  /3\. setting = OLD\.id::text, closeouts EXISTS=false/.test(MIGRATION) &&
  /4\. setting = OLD\.id::text, closeouts EXISTS=true/.test(MIGRATION));
assert("1f: no new lifecycle exception / allow...AcrossBoundary flag is introduced (no actual SET/current_setting use of such a flag; the term appears only in explanatory prose)",
  !/current_setting\('ladieci\.[a-zA-Z_]*AcrossBoundary/.test(MIGRATION) &&
  !/set_config\('ladieci\.[a-zA-Z_]*AcrossBoundary/.test(MIGRATION) &&
  (MIGRATION.match(/current_setting\('ladieci\.[a-zA-Z_]+'/g) || []).every((m) =>
    /ladieci\.(incident_safe_close_session_id|v3_close_authorized_session_id)'/.test(m)));
assert("1g: guard_service_session_closed_v1 keeps CREATE OR REPLACE in both migration and rollback (trigger function, no argument list ever changes)",
  /CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1\(\)/.test(MIGRATION) &&
  /CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1\(\)/.test(ROLLBACK));

console.log("\n== B. payment idempotency index: narrowed to (workspace_id, client_request_id), never absent ==");
assert("2a: the pre-index safety check re-verifies zero duplicate groups inside the migration transaction (defense in depth alongside the pre-flight check)",
  /GROUP BY workspace_id, client_request_id\s*\n\s*HAVING count\(\*\) > 1/.test(MIGRATION) &&
  /RAISE EXCEPTION 'S1 refused: % duplicate \(workspace_id, client_request_id\) group\(s\) exist/.test(MIGRATION));
assert("2b: the new 2-column unique CONSTRAINT is added BEFORE the old 4-column constraint is dropped (uniqueness never absent; the old one is a genuine UNIQUE constraint, contype='u', confirmed live -- DROP INDEX on it fails with 2BP01)",
  MIGRATION.indexOf("ADD CONSTRAINT payment_transactions_idempotency_v2_uq") <
  MIGRATION.indexOf("DROP CONSTRAINT payment_transactions_idempotency_uq"));
assert("2c: the new constraint is on exactly (workspace_id, client_request_id)",
  /ADD CONSTRAINT payment_transactions_idempotency_v2_uq UNIQUE \(workspace_id, client_request_id\);/.test(MIGRATION));
assert("2d: the new constraint is renamed back to the canonical payment_transactions_idempotency_uq name",
  /RENAME CONSTRAINT payment_transactions_idempotency_v2_uq TO payment_transactions_idempotency_uq;/.test(MIGRATION));
assert("2e: an explicit table lock documents the no-unsafe-window guarantee",
  /LOCK TABLE public\.payment_transactions IN SHARE ROW EXCLUSIVE MODE;/.test(MIGRATION));
assert("2f: rollback restores the original 4-column constraint verbatim, also never-absent ordered",
  ROLLBACK.indexOf("ADD CONSTRAINT payment_transactions_idempotency_v1_uq") <
  ROLLBACK.indexOf("DROP CONSTRAINT payment_transactions_idempotency_uq") &&
  /UNIQUE \(workspace_id, by_actor, by_sid_hash, client_request_id\);/.test(ROLLBACK));

console.log("\n== B. mesa_post_payment_v1 replay lookup: narrowed key, hash conflict still fails closed ==");
assert("3a: the replay SELECT filters only by workspace_id and client_request_id (no by_actor/by_sid_hash in the WHERE)",
  /SELECT \* INTO v_existing FROM public\.payment_transactions\s*\n\s*WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;/.test(MIGRATION));
assert("3b: a request_hash mismatch on the same key still raises MESA_PAYMENT_IDEMPOTENCY_CONFLICT (23505)",
  /IF v_existing\.request_hash <> p_request_hash THEN\s*\n\s*RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';/.test(MIGRATION));
assert("3c: a replay by a different actor appends an auth_audit row naming both identities, before returning idempotent:true",
  /IF p_by_actor <> v_existing\.by_actor THEN\s*\n\s*INSERT INTO public\.auth_audit\(event, target_actor, by_actor, meta\)\s*\n\s*VALUES \(\s*\n\s*'PAYMENT_REPLAY_DIFFERENT_ACTOR',\s*\n\s*v_existing\.by_actor,\s*\n\s*p_by_actor,/.test(MIGRATION));
assert("3d: the audit meta records both sid hashes and the replaying actor's role",
  /'originalBySidHash', v_existing\.by_sid_hash,\s*\n\s*'replayingBySidHash', p_by_sid_hash,\s*\n\s*'replayingRole', v_actor\.role/.test(MIGRATION));
assert("3e: the replay path still returns idempotent:true regardless of whether the actor differed",
  /RETURN jsonb_build_object\(\s*\n\s*'ok', true, 'idempotent', true, 'transactionId', v_existing\.id,/.test(MIGRATION));
assert("3f: the ORIGINAL row's by_actor/by_role/by_sid_hash are never rewritten anywhere in the replay branch (no UPDATE payment_transactions in this migration)",
  !/UPDATE public\.payment_transactions/.test(MIGRATION));

console.log("\n== C. duplicate-candidate window: 120s, exact shape, override is audited, never called idempotent ==");
assert("4a: the window is exactly 120 seconds",
  /pt\.created_at > \(v_now - interval '120 seconds'\)/.test(MIGRATION));
assert("4b: the match excludes the same client_request_id (a different intent) and matches on kind/mode/amount/payment_method/covers_settled/table_session_id",
  /pt\.table_session_id = v_session\.id\s*\n\s*AND pt\.client_request_id <> p_client_request_id\s*\n\s*AND pt\.kind = 'payment'\s*\n\s*AND pt\.mode = p_mode\s*\n\s*AND pt\.amount = \(v_amount_cents \/ 100\.0\)\s*\n\s*AND pt\.payment_method = p_payment_method\s*\n\s*AND pt\.covers_settled = v_covers_settled/.test(MIGRATION));
assert("4c: a candidate without the override raises MESA_POSSIBLE_DUPLICATE_PAYMENT",
  /IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN\s*\n\s*RAISE EXCEPTION 'MESA_POSSIBLE_DUPLICATE_PAYMENT' USING ERRCODE='55000';/.test(MIGRATION));
assert("4d: p_confirm_duplicate defaults to false (opt-in override only)",
  /p_confirm_duplicate boolean DEFAULT false/.test(MIGRATION));
assert("4e: the override path records an auth_audit row and still proceeds to the real INSERT",
  /ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN[\s\S]{0,400}INSERT INTO public\.auth_audit\(event, target_actor, by_actor, meta\)\s*\n\s*VALUES \(\s*\n\s*'PAYMENT_DUPLICATE_CONFIRMED',/.test(MIGRATION));
assert("4f: the duplicate-candidate check runs strictly before the payment_transactions INSERT",
  MIGRATION.indexOf("v_duplicate_candidate boolean;") < MIGRATION.indexOf("INSERT INTO public.payment_transactions(") &&
  MIGRATION.indexOf("MESA_POSSIBLE_DUPLICATE_PAYMENT") < MIGRATION.indexOf("INSERT INTO public.payment_transactions("));
assert("4g: the override branch is never returned as idempotent:true (it falls through to the ordinary non-idempotent success return)",
  MIGRATION.indexOf("PAYMENT_DUPLICATE_CONFIRMED") < MIGRATION.indexOf("'ok', true, 'idempotent', false, 'transactionId', v_tx.id,"));
assert("4h: no fuzzy matching or wider window is introduced (exactly one 120-second literal, exactly one duplicate-candidate query)",
  (MIGRATION.match(/interval '120 seconds'/g) || []).length === 1 &&
  (MIGRATION.match(/v_duplicate_candidate boolean;/g) || []).length === 1);

console.log("\n== overload-ambiguity discipline: DROP before CREATE for the widened mesa_post_payment_v1 signature ==");
assert("5a: forward migration drops the 12-arg overload before creating the 13-arg one (bare CREATE, not CREATE OR REPLACE)",
  /DROP FUNCTION public\.mesa_post_payment_v1\(\s*\n\s*uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid\[\], jsonb\s*\n\s*\);\s*\n\s*\nCREATE FUNCTION public\.mesa_post_payment_v1\(/.test(MIGRATION));
assert("5b: the new signature appends p_confirm_duplicate as the 13th parameter, default false, after every pre-existing parameter",
  /p_meta jsonb DEFAULT '\{\}'::jsonb,\s*\n\s*p_confirm_duplicate boolean DEFAULT false\s*\n\)/.test(MIGRATION));
assert("5c: rollback drops the 13-arg overload before recreating the original 12-arg one",
  /DROP FUNCTION public\.mesa_post_payment_v1\(\s*\n\s*uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid\[\], jsonb, boolean\s*\n\s*\);\s*\n\s*\nCREATE FUNCTION public\.mesa_post_payment_v1\(/.test(ROLLBACK));
assert("5d: rollback's restored signature has exactly the original 12 parameters (no p_confirm_duplicate)",
  !/p_confirm_duplicate/.test(ROLLBACK.slice(ROLLBACK.indexOf("CREATE FUNCTION public.mesa_post_payment_v1(")).slice(0, 600)));
assert("5e: grants on the new 13-arg overload match the established pattern (REVOKE ALL from PUBLIC/anon/authenticated, GRANT EXECUTE to service_role only)",
  /REVOKE ALL ON FUNCTION public\.mesa_post_payment_v1\(\s*\n\s*uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid\[\], jsonb, boolean\s*\n\s*\) FROM PUBLIC, anon, authenticated;\s*\n\s*GRANT EXECUTE ON FUNCTION public\.mesa_post_payment_v1\(\s*\n\s*uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid\[\], jsonb, boolean\s*\n\s*\) TO service_role;/.test(MIGRATION));

console.log("\n== predecessor guards: refuse over drift, refuse a re-patch, refuse unsafe duplicates ==");
assert("6a: forward migration refuses if guard_service_session_closed_v1 already carries v_v3_authorized",
  /IF v_guard_body LIKE '%v_v3_authorized%' THEN\s*\n\s*RAISE EXCEPTION 'S1 refused: guard_service_session_closed_v1 already references v_v3_authorized/.test(MIGRATION));
assert("6b: forward migration refuses if mesa_post_payment_v1 already carries p_confirm_duplicate",
  /IF v_payment_body LIKE '%p_confirm_duplicate%' THEN\s*\n\s*RAISE EXCEPTION 'S1 refused: mesa_post_payment_v1 already references p_confirm_duplicate/.test(MIGRATION));
assert("6c: forward migration refuses if the pre-S1 4-column replay lookup shape is not found (drift)",
  /IF v_payment_body NOT LIKE '%WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor%AND by_sid_hash = p_by_sid_hash AND client_request_id = p_client_request_id%' THEN/.test(MIGRATION));
assert("6d: rollback refuses if the S1 fix is not present (nothing to roll back)",
  /IF v_guard_body IS NULL OR v_guard_body NOT LIKE '%v_v3_authorized%' THEN/.test(ROLLBACK));

console.log("\n== JS wiring: p_confirm_duplicate is reachable from the DAO, default-false, backward compatible ==");
assert("7a: mesaDao.postPayment maps confirmDuplicate -> p_confirm_duplicate, strictly boolean, default false",
  /p_confirm_duplicate: args\.confirmDuplicate === true,/.test(DAO));
assert("7b: every other postPayment parameter mapping is untouched (same field list, same order, up to the new line)",
  /const postPayment = \(args\) => rpc\('mesa_post_payment_v1', \{\s*\n\s*p_workspace_id: args\.workspaceId,\s*\n\s*p_by_actor: args\.byActor,\s*\n\s*p_by_sid_hash: args\.bySidHash,\s*\n\s*p_table_session_id: args\.tableSessionId,\s*\n\s*p_payment_method: args\.paymentMethod,\s*\n\s*p_mode: args\.mode,\s*\n\s*p_client_request_id: args\.clientRequestId,\s*\n\s*p_request_hash: args\.requestHash,\s*\n\s*p_amount: args\.amount \?\? null,\s*\n\s*p_covers_settled: args\.coversSettled \?\? null,\s*\n\s*p_line_ids: Array\.isArray\(args\.lineIds\) \? args\.lineIds : null,\s*\n\s*p_meta: args\.meta \|\| \{\},/.test(DAO));

console.log("\n== S2 non-interference: this migration touches nothing S2 owns (checked against comment-stripped SQL -- the header legitimately documents these terms in prose) ==");
assert("8a: no receipt-service nullability change (no ALTER ... service_session_id DROP NOT NULL)",
  !/DROP NOT NULL/.test(MIGRATION_CODE));
assert("8b: no event_service_session_id column introduced",
  !/event_service_session_id/.test(MIGRATION_CODE));
assert("8c: mesa_snapshot_order_lines_v1 / service_session_assign_financial_event are not touched",
  !/mesa_snapshot_order_lines_v1/.test(MIGRATION_CODE) && !/service_session_assign_financial_event/.test(MIGRATION_CODE));
assert("8d: order_entities / order_uid are not referenced",
  !/order_entities/.test(MIGRATION_CODE) && !/order_uid/.test(MIGRATION_CODE));
assert("8e: no new table is created (additive DDL is limited to the one renamed index)",
  !/CREATE TABLE/.test(MIGRATION_CODE));
assert("8f: the header prose DOES still document what it deliberately avoids touching (sanity check that stripComments actually removed something)",
  MIGRATION.length > MIGRATION_CODE.length && /event_service_session_id/.test(MIGRATION));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
