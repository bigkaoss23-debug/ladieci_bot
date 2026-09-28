// tests/bRid1RiderCanonicalPaymentMigration.test.js — B-RID-1 RIDER_PAYMENT_RECEIPT_LINEAGE_GAP (migration 140).
// Offline static guard of the migration pair and of the backend wiring. The behaviour is certified on ephemeral
// PostgreSQL 17 by ci/giro-authority-certification/harness/runRiderCanonicalPayment.js; this file proves what text can:
//   * the canonical writer's 140 body is the 139 body with ONE marked block (byte equality after removing it);
//   * the rider RPC's 140 body is the 135 body with ONLY the legacy-writer regions swapped for marked 140 blocks;
//   * the rollback restores the 126 / 135 / 139 statements VERBATIM and refuses over rider-authored money;
//   * the md5 pins are the md5 of the bodies actually in the files;
//   * the perimeter: no Planner / fiscal / trip / service object is touched; no new writer; the legacy writer is dropped;
//   * the backend forwards the verified session proof and never a fabricated one.
// Run: node tests/bRid1RiderCanonicalPaymentMigration.test.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

const FWD_REL = "migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql";
const RBK_REL = "migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql";
const fwd = read(FWD_REL);
const rbk = read(RBK_REL);
const m126 = read("migrations/2026-09-11_economic_writer_hardening_v1_migration_126.sql");
const m135 = read("migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.sql");
const m139 = read("migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql");

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log("  ✓ " + label); } else { fail++; console.log("  ✗ " + label + (detail ? "  -> " + detail : "")); }
}

// The complete statement and the dollar-quoted body (= pg_proc.prosrc) of ONE function definition, located by marker.
function statement(sql, marker) {
  const i = sql.indexOf(marker);
  if (i < 0) return null;
  if (sql.indexOf(marker, i + 1) >= 0) throw new Error(`marker not unique: ${marker}`);
  const open = /AS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(i));
  const tag = open[1];
  const bodyStart = i + open.index + open[0].length;
  const end = sql.indexOf(tag, bodyStart);
  return { text: sql.slice(i, end + tag.length) + ";", body: sql.slice(bodyStart, end) };
}
// Removes every "-- 140:BEGIN x" ... "-- 140:END x" block (whole lines, markers included).
function stripBlocks(body) {
  return body.replace(/^[ \t]*-- 140:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 140:END \1\n/gm, "");
}
function cut(text, from, to, label) {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`region not found: ${label}`);
  return text.slice(0, i) + text.slice(j + to.length);
}

console.log("\n── files, numbering, transaction ──");
check("forward and rollback exist under migrations/ with number 140", fs.existsSync(path.join(ROOT, FWD_REL)) && fs.existsSync(path.join(ROOT, RBK_REL)));
check("140 is the next number after 139: the only migrations >= 140 are the 140 pair and, in this Economia candidate, the C8 pairs 143 / 144, the Finding A pair 145, the Finding B pair 146, the R2 pair 147, the legacy paid guard pair 148, the R4B atomic close pair 149, the corrective slice pair 150, the final concurrency fix pair 151, the POST-ASTRA pairs 152 / 153 / 154 and the final liveness gate pairs 155 / 156 (the Economy package: 140, 143, 144, 145, 146, 147, 148, 149, 150; 141 / 142 = Fiscal M141 / M142 are NOT in it and stay forbidden here)",
  fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /_migration_1(4\d|[5-9]\d)\b/.test(f)).sort().join(",")
    === ["2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql", "2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql",
      "2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql", "2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql",
      "2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql", "2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql",
      "2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql", "2026-09-24_payment_close_receipt_lock_v1_migration_145.sql",
      "2026-09-25_close_attempt_atomic_completion_v1_migration_149.ROLLBACK.sql", "2026-09-25_close_attempt_atomic_completion_v1_migration_149.sql",
      "2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.ROLLBACK.sql", "2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.sql",
      "2026-09-25_mesa_refund_canonical_projection_v1_migration_147.ROLLBACK.sql", "2026-09-25_mesa_refund_canonical_projection_v1_migration_147.sql",
      "2026-09-25_refund_close_receipt_lock_v1_migration_146.ROLLBACK.sql", "2026-09-25_refund_close_receipt_lock_v1_migration_146.sql",
      "2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.ROLLBACK.sql", "2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.sql",
      "2026-09-26_economic_close_gate_v1_migration_151.ROLLBACK.sql", "2026-09-26_economic_close_gate_v1_migration_151.sql",
      // POST-ASTRA corrective cycle: 152 (post-close resolution fact), 153 (canonical order editor), 154 (day-window freshness).
      "2026-09-26_close_day_evidence_freshness_v1_migration_154.ROLLBACK.sql", "2026-09-26_close_day_evidence_freshness_v1_migration_154.sql",
      "2026-09-26_order_editor_canonical_writer_v1_migration_153.ROLLBACK.sql", "2026-09-26_order_editor_canonical_writer_v1_migration_153.sql",
      "2026-09-26_post_close_obligation_resolution_v1_migration_152.ROLLBACK.sql", "2026-09-26_post_close_obligation_resolution_v1_migration_152.sql",
      // final liveness gate: 155 (Planner entity KEY SHARE before the order lock, N2), 156 (close gate on the window fact inserts, F2).
      "2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.ROLLBACK.sql", "2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.sql",
      "2026-09-27_close_gate_on_window_facts_v1_migration_156.ROLLBACK.sql", "2026-09-27_close_gate_on_window_facts_v1_migration_156.sql"].sort().join(","));
check("both files run in ONE transaction (BEGIN ... COMMIT)", /\nBEGIN;\n/.test(fwd) && /\nCOMMIT;\n$/.test(fwd) && /\nBEGIN;\n/.test(rbk) && /\nCOMMIT;\n$/.test(rbk));
check("the manifest registers migration 140 as authored locally and NOT applied",
  /\| 140 \| B-RID-1/.test(read("migrations/MIGRATION_MANIFEST.md")) && /NOT APPLIED to staging/.test(read("migrations/MIGRATION_MANIFEST.md").split("| 140 | B-RID-1")[1] || ""));

console.log("\n── the canonical writer: 139 body + ONE marked block ──");
const w139 = statement(m139, "CREATE OR REPLACE FUNCTION public.order_post_payment_v1(");
const w140 = statement(fwd, "CREATE OR REPLACE FUNCTION public.order_post_payment_v1(");
check("the 139 writer body is the one 140 pins as predecessor (md5 af52d596…)", md5(w139.body) === "af52d59658719bd7898d9cd88dd29179");
check("140 guard pins the 139 writer body", fwd.includes("IS DISTINCT FROM 'af52d59658719bd7898d9cd88dd29179'"));
const GATE_OLD = "  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','operator')\n";
check("removing the ONE marked block and putting back the 139 gate line yields the 139 writer body byte for byte",
  stripBlocks(w140.body).replace("  THEN RAISE EXCEPTION 'ORDER_PAYMENT_FORBIDDEN'", GATE_OLD + "  THEN RAISE EXCEPTION 'ORDER_PAYMENT_FORBIDDEN'") === w139.body);
check("the writer carries exactly ONE 140 block (rider_delivery_attestation)", (w140.body.match(/-- 140:BEGIN /g) || []).length === 1 && /-- 140:BEGIN rider_delivery_attestation/.test(w140.body));
const gate = /-- 140:BEGIN rider_delivery_attestation\n([\s\S]*?)-- 140:END rider_delivery_attestation/.exec(w140.body)[1];
check("the attestation admits ONLY role rider, mode full, no duplicate override, bound to actor AND order_uid",
  /v_actor\.role = 'rider'/.test(gate) && /p_mode = 'full'/.test(gate) && /p_confirm_duplicate IS NOT TRUE/.test(gate)
  && /current_setting\('ladieci\.rider_payment_attestation', true\) IS NOT DISTINCT FROM \(p_by_actor \|\| '\|' \|\| p_order_uid::text\)/.test(gate));
check("admin/operator are judged exactly as before (still NOT IN ('admin','operator') -> refused unless attested rider)", /v_actor\.role NOT IN \('admin','operator'\)/.test(gate));
check("the writer still records by_role = the ACTOR's own role (v_actor.role) on the transaction and on the event -- no impersonation path",
  (w140.body.match(/p_by_actor, v_actor\.role, p_by_sid_hash, p_client_request_id/g) || []).length === 1 && /NULL, false, p_by_actor, v_actor\.role, o\.estado, o\.estado/.test(w140.body));
check("the B2 receipt contract is intact (v_receipt_service_id unchanged in both receipt columns; flag decided by the writer)",
  w140.body.includes("p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,") && w140.body.includes("o.service_session_id, v_receipt_service_id, v_tx.id, v_now")
  && w140.body.includes("v_meta := v_meta - 'off_service_receipt';") && !/COALESCE\(v_receipt_service_id/.test(w140.body));

console.log("\n── the rider RPC: 135 body with ONLY the legacy-writer regions swapped ──");
const r135 = statement(m135, "CREATE OR REPLACE FUNCTION public.rider_collect_and_complete_stop(");
const r140 = statement(fwd, "CREATE FUNCTION public.rider_collect_and_complete_stop(");
check("the 135 rider body is the one 140 pins as predecessor (md5 4b2b4f4c…)", md5(r135.body) === "4b2b4f4ce6155deea2e7f15a74f7707c" && fwd.includes("'4b2b4f4ce6155deea2e7f15a74f7707c'"));
let legacy = r135.body;
legacy = cut(legacy, "      BEGIN\n        v_pay := public._ledger_write_payment(", "      END;\n", "replay call");
legacy = cut(legacy, "  -- MONEY FIRST. A refusal here", "re-recording it would double-count.\n", "money-first comment");
legacy = cut(legacy, "    BEGIN\n      v_pay := public._ledger_write_payment(", "    END;\n", "entregado call");
legacy = cut(legacy, "  -- OPERATIVE completion ONLY.", "completes with the flags untouched.\n", "operative comment");
// A standalone 140 block sits between blank lines, so removing it leaves one extra blank line: paragraph gaps are
// normalized on both sides -- the 135 body itself has none to normalize (asserted), so this cannot hide a real change.
const para = (t) => t.replace(/\n{3,}/g, "\n\n");
check("the 135 body has no triple newline (the paragraph normalization below only affects the 140 side)", !/\n{3,}/.test(r135.body));
check("removing the 140 blocks from the 140 body == removing the legacy-writer call regions (and the two comments that named them) from the 135 body",
  para(stripBlocks(r140.body)) === legacy);
check("the 140 rider body has exactly the eight named blocks",
  JSON.stringify((r140.body.match(/-- 140:BEGIN ([a-z_]+)/g) || []).map((s) => s.slice(13)))
    === JSON.stringify(["decl", "collection_proofs", "workspace_before_actor", "canonical_request", "canonical_collect_replay", "money_first_comment", "canonical_collect", "operative_comment"]));
// R5 (targeted findings 2026-09-25): a collection locks the rider's own workspace row after L0 and BEFORE the actor row lock.
const r5 = /-- 140:BEGIN workspace_before_actor\n([\s\S]*?)-- 140:END workspace_before_actor/.exec(r140.body)[1];
check("R5: the workspace_before_actor block locks exactly the rider actor's own workspace row FOR UPDATE, only for a collection (v_method <> '')",
  /IF v_method <> '' THEN\n\s+PERFORM 1 FROM public\.workspaces w\n\s+WHERE w\.id = \(SELECT a\.workspace_id FROM public\.auth_actors a WHERE a\.actor = p_by_actor\)\n\s+FOR UPDATE;\n\s+END IF;/.test(r5)
  && (r140.body.match(/FROM public\.workspaces/g) || []).length === 1);
check("R5: order is L0 -> workspace row -> actor row (the block sits after L0 and before the actor FOR UPDATE)",
  r140.body.indexOf("hashtext('LA_DIECI_DRIVER_STATO')") < r140.body.indexOf("-- 140:BEGIN workspace_before_actor")
  && r140.body.indexOf("-- 140:END workspace_before_actor") < r140.body.indexOf("SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;"));
check("signature: the 7 original parameters unchanged + p_by_sid_hash text DEFAULT NULL last",
  /CREATE FUNCTION public\.rider_collect_and_complete_stop\(\n  p_order_id text, p_metodo_pago text, p_by_actor text, p_session_version integer,\n  p_ip_hash text, p_meta jsonb, p_idem_scope_key text,\n  p_by_sid_hash text DEFAULT NULL\)/.test(fwd));
const b = r140.body;
check("L0 is still the first lock (before the actor read)", b.indexOf("hashtext('LA_DIECI_DRIVER_STATO')") > 0 && b.indexOf("hashtext('LA_DIECI_DRIVER_STATO')") < b.indexOf("FROM public.auth_actors"));
check("the collection proofs are validated BEFORE any lock", b.indexOf("PAYMENT_CONTEXT_UNAVAILABLE") < b.indexOf("hashtext('LA_DIECI_DRIVER_STATO')"));
check("identity stays rider-exclusive (role <> 'rider' -> AUTH_FORBIDDEN_ROLE) and membership stays the collection authority (NON_MEMBER / NO_ACTIVE_TRIP)",
  b.includes("IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;") && /NON_MEMBER/.test(b) && /NO_ACTIVE_TRIP/.test(b));
check("the canonical writer is called exactly twice (replay + Entregado), as the rider (p_by_actor, v_by.workspace_id), mode 'full', no amount, no duplicate override",
  (b.match(/public\.order_post_payment_v1\(\n\s+v_by\.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid, v_method, 'full', NULL,\n\s+v_request_id, v_request_hash, v_meta, false\);/g) || []).length === 2);
check("the attestation is set immediately before each call and cleared immediately after", (b.match(/PERFORM set_config\('ladieci\.rider_payment_attestation', p_by_actor \|\| '\|' \|\| v_order_uid::text, true\);\n\s+v_pay := public\.order_post_payment_v1\(/g) || []).length === 2
  && (b.match(/v_meta, false\);\n\s+PERFORM set_config\('ladieci\.rider_payment_attestation', '', true\);/g) || []).length === 2);
check("the single tolerated refusal is ORDER_PAYMENT_ALREADY_SETTLED (anything else -> PAYMENT_REFUSED, before the delivery)",
  (b.match(/IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN\n\s+RETURN jsonb_build_object\('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note\);/g) || []).length === 2
  && !/AUTH_LEGACY_IMPORT_REQUIRED/.test(b));
check("B1 amount guard: in BOTH subtransactions, AFTER the attestation is cleared and BEFORE the handler, a NON-idempotent payment whose NUMERIC amount (rounded to 2) IS DISTINCT FROM round(ordenes.totale, 2) RAISEs RIDER_PAYMENT_AMOUNT_MISMATCH (55000, caught by the existing handler => rolled back => PAYMENT_REFUSED)",
  (b.match(/PERFORM set_config\('ladieci\.rider_payment_attestation', '', true\);\n\s+(?:--[^\n]*\n\s+)+IF COALESCE\(\(v_pay->>'idempotent'\)::boolean, false\) IS NOT TRUE\n\s+AND round\(\(v_pay->>'amount'\)::numeric, 2\) IS DISTINCT FROM \(SELECT round\(o\.totale, 2\) FROM public\.ordenes o WHERE o\.id = p_order_id\) THEN\n\s+RAISE EXCEPTION 'RIDER_PAYMENT_AMOUNT_MISMATCH' USING ERRCODE='55000';\n\s+END IF;\n\s+EXCEPTION WHEN /g) || []).length === 2);
check("B1: the comparison is NUMERIC (no float cast, no text comparison, no JS) and the guard never names the obligation formula (single source of truth stays the writer)",
  !/::(float|double|real)/i.test(b) && !/order_canonical_obligation_v1|order_obligations/.test(b));
check("B1: residual 0 stays a distinct case -- ALREADY_SETTLED is still the ONLY tolerated refusal and is never mapped onto the mismatch",
  !/RIDER_PAYMENT_AMOUNT_MISMATCH[^\n]*ALREADY_SETTLED|ALREADY_SETTLED[^\n]*RIDER_PAYMENT_AMOUNT_MISMATCH/.test(b) && (b.match(/RIDER_PAYMENT_AMOUNT_MISMATCH/g) || []).length === 2);
check("the request identity is derived server-side from the order_uid (not the recyclable display id), and the method is bound in the hash",
  b.includes("v_request_id   := 'rider-delivery-' || replace(v_order_uid::text, '-', '');")
  && b.includes("concat_ws('|', 'rider_delivery', v_order_uid::text, v_method, 'full')"));
check("the server-forced source is applied LAST (no caller meta key can displace it)", /jsonb_build_object\('ip_hash', p_ip_hash, 'idem_scope_key', p_idem_scope_key\)\n\s+\|\| jsonb_build_object\('source', 'rider_delivery'\);/.test(b));
check("money first, then the guarded delivery transition, and the lost race RAISES (never RETURN)",
  b.lastIndexOf("public.order_post_payment_v1(") < b.indexOf("SET estado       = 'RETIRADO'") && b.includes("RAISE EXCEPTION 'RIDER_STOP_LOST_RACE' USING ERRCODE='40001';"));
check("the rider RPC writes NO ledger row itself and names no other identity", !/INSERT INTO public\.(order_financial_events|payment_transactions|payment_allocations)/.test(b)
  && !/_ledger_write_payment/.test(b) && !/'(admin|operator|owner)'/.test(b));

console.log("\n── legacy writer: dropped with a zero-reachability guard ──");
check("the forward DROPs _ledger_write_payment and the 7-argument rider RPC", fwd.includes("DROP FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text);")
  && fwd.includes("DROP FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text);"));
check("the guard refuses if ANY other body still calls _ledger_write_payment, or pg_depend names it", /other function\(s\) still call _ledger_write_payment/.test(fwd) && /an object depends on _ledger_write_payment/.test(fwd));
check("the post-condition proves no body calls it and no overload survives", /a function body still calls _ledger_write_payment/.test(fwd) && /_ledger_write_payment still exists/.test(fwd));
check("the guard pins the legacy writer body (= staging live md5 94fa5265…)", fwd.includes("'94fa5265c0ad334b79f3f00228f8300d'"));

console.log("\n── the role constraint ──");
check("rider is admitted ONLY for kind payment, mode full, no table session, covers 0, meta.source = \"rider_delivery\" (NULL-safe)",
  /by_role IN \('admin', 'operator', 'owner', 'cashier', 'legacy_operator'\)\n  OR \(\n        by_role = 'rider'\n    AND kind = 'payment'\n    AND mode = 'full'\n    AND table_session_id IS NULL\n    AND covers_settled = 0\n    AND COALESCE\(\(meta -> 'source'\) = '"rider_delivery"'::jsonb, false\)\n  \)/.test(fwd));
check("the guard pins the exact V3-H definition and refuses a pre-existing comment", fwd.includes("'CHECK ((by_role = ANY (ARRAY[''admin''::text, ''operator''::text, ''owner''::text, ''cashier''::text, ''legacy_operator''::text])))'")
  && /carries a comment the rollback could not restore/.test(fwd));

console.log("\n── md5 pins == the bodies in the files ──");
const fwdPins = [...fwd.matchAll(/md5\(v_(?:rider|opp)\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
check("forward post-condition pins == md5 of the rider / writer bodies in the file", fwdPins[0] === md5(r140.body) && fwdPins[1] === md5(w140.body), JSON.stringify(fwdPins));
const rbkPins = [...rbk.matchAll(/md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
check("rollback guard pins == md5 of the 140 rider / writer bodies", rbkPins[0] === md5(r140.body) && rbkPins[1] === md5(w140.body), JSON.stringify(rbkPins));
const cmt = /COMMENT ON CONSTRAINT payment_transactions_by_role_check ON public\.payment_transactions IS\s*\n\s*'((?:[^']|'')*)';/.exec(fwd)[1].replace(/''/g, "'");
check("rollback pins the md5 of the constraint comment 140 installs", rbk.includes(`'${md5(cmt)}'`));

console.log("\n── rollback: verbatim restoration, refusal over rider money ──");
check("rollback recreates _ledger_write_payment VERBATIM from migration 126", rbk.includes(statement(m126, "CREATE OR REPLACE FUNCTION public._ledger_write_payment(").text));
check("rollback recreates the 7-argument rider RPC VERBATIM from migration 135", rbk.includes(r135.text));
check("rollback restores order_post_payment_v1 VERBATIM from migration 139", rbk.includes(w139.text));
check("rollback restores the V3-H role constraint", rbk.includes("CHECK (by_role IN ('admin', 'operator', 'owner', 'cashier', 'legacy_operator'));"));
check("rollback REFUSES while any rider-authored transaction exists (after locking the table)",
  rbk.indexOf("LOCK TABLE public.payment_transactions IN SHARE ROW EXCLUSIVE MODE;") < rbk.indexOf("WHERE by_role = 'rider'") && /payment transaction\(s\) authored by a rider exist/.test(rbk));
check("rollback grants: service_role only on both restored functions", (rbk.match(/FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public\.(_ledger_write_payment|rider_collect_and_complete_stop)\([^)]*\) TO service_role;/g) || []).length === 2);

console.log("\n── perimeter ──");
const ddl = fwd.replace(/--[^\n]*/g, "");
for (const forbidden of ["consolidate_period_v1", "manual_giros", "giro_authority", "giro_candidates", "start_rider_trip", "close_rider_trip",
  "close_service_session", "trip_authority.", "delivery_logs", "mesa_post_payment_v1", "order_initial_payment_v1", "operator_confirm_delivery_v1"]) {
  check(`the forward does not touch ${forbidden}`, !ddl.includes(forbidden));
}
check("the only table DDL is the role constraint (DROP + ADD + COMMENT on payment_transactions_by_role_check)",
  (ddl.match(/ALTER TABLE/g) || []).length === 2 && (ddl.match(/ALTER TABLE public\.payment_transactions (DROP|ADD) CONSTRAINT payment_transactions_by_role_check/g) || []).length === 2);
check("no data DML in the forward (only its own temp snapshot tables; ledger table names appear only inside post-condition string literals)",
  !/^\s*(UPDATE|DELETE FROM|INSERT INTO)\s+public\./m.test(ddl.replace(/AS \$(function|fn)\$[\s\S]*?\$\1\$;/g, "")));
check("the new rider RPC is owned by postgres with EXECUTE for service_role only", fwd.includes("ALTER FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text) OWNER TO postgres;")
  && fwd.includes("REVOKE ALL ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;")
  && fwd.includes("GRANT EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text) TO service_role;"));
check("no new payment writer function is created (exactly the two function definitions: the writer replaced, the rider RPC recreated)",
  (ddl.match(/CREATE (OR REPLACE )?FUNCTION/g) || []).length === 2);

console.log("\n── backend wiring ──");
const index = read("index.js");
const riderTrip = read("src/agents/riderTrip.js");
// language-guard: allow-legacy chiudiGiro is the existing router action name used only as the end anchor of the slice, not new vocabulary
const route = index.slice(index.indexOf('case "marcarEntregado": {'), index.indexOf('case "chiudiGiro":'));
check("index.js marcarEntregado derives the proof from the VERIFIED token only (sidHash(ctx.sid)) and refuses a collection without it (401 PAYMENT_CONTEXT_UNAVAILABLE)",
  /const bySidHash = sidHash\(ctx\.sid\);/.test(route) && /if \(payMethod && !bySidHash\) \{\n\s+return \{ status: 401, payload: \{ error: "PAYMENT_CONTEXT_UNAVAILABLE" \} \};/.test(route) && /bySidHash,\n\s+\}\);/.test(route));
check("index.js never reads a proof or amount from the body for the rider stop", !/body\.(by_sid_hash|bySidHash|sid|amount|cobrado)/.test(route));
check("index.js imports the shared sha256(sid) helper", /const \{ sidHash \} = require\("\.\/src\/auth\/sidHash"\);/.test(index));
check("riderTrip.completeStop forwards p_by_sid_hash (null when absent, never invented) through the literal sbRpc form",
  /sbRpc\("rider_collect_and_complete_stop", \{[\s\S]*p_by_sid_hash: typeof ctx\.bySidHash === "string" && ctx\.bySidHash \? ctx\.bySidHash : null,/.test(riderTrip));
check("no backend code calls _ledger_write_payment or registers it as a resource",
  !/rpc\(\s*['"]_ledger_write_payment/.test(index + riderTrip + read("src/utils/supabaseResourcePolicy.js")) && !read("src/utils/supabaseResourcePolicy.js").includes("rpc/_ledger_write_payment"));
check("the rider RPC stays registered in the H1B resource policy (same name, FINANCIAL)", /entry\('rpc\/rider_collect_and_complete_stop', KIND\.RPC, \['POST'\], SENSITIVITY\.FINANCIAL/.test(read("src/utils/supabaseResourcePolicy.js")));

console.log(`\nbRid1RiderCanonicalPaymentMigration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
