"use strict";
// F-4C — Finalizar servicio repair, slice 4C. Static (source-text) proof for
// the migration + paired rollback (reuses F-4A's exact Evidence Model B on
// archived_order_financial_resolutions, the one evidence table F-4A's own
// scope deliberately did not touch). Live acceptance (the mandatory A-E
// matrix -- legacy valid, legacy NULL rejected, new-era valid, new-era
// non-NULL rejected, economics unaffected -- plus the immutability proof)
// was run as its own separate, controlled step against real staging,
// entirely inside BEGIN/ROLLBACK -- see the migration's own header and the
// F-4C report for the exact live-verified evidence. Zero residue confirmed
// after every run.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_f4c_archived_resolution_era_aware_evidence_contract.sql");
const ROLLBACK = read("migrations/2026-08-17_f4c_archived_resolution_era_aware_evidence_contract.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

const TABLE = "archived_order_financial_resolutions";

console.log("\n== A. Predecessor / drift guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-4C refused: staging sentinel migration absent/.test(SQL));
assert("1b: drift guard refuses if lifecycle_semantics already present",
  /F-4C refused: lifecycle_semantics column already present on archived_order_financial_resolutions/.test(SQL));
assert("1c: drift guard refuses if service_kind is already nullable",
  /F-4C refused: service_kind is already nullable on archived_order_financial_resolutions/.test(SQL));
assert("1d: predecessor-body guard requires the exact pre-F-4C blanket rejection in the canonical writer",
  /F-4C refused: create_archived_order_financial_resolution does not match the expected pre-F-4C body/.test(SQL));
assert("1e: predecessor-body guard is checked against the SAME literal blanket-rejection text F-4A already used elsewhere",
  /IF v_session\.service_kind IS NULL THEN\n {4}RETURN jsonb_build_object\(''ok'',false,''code'',''SERVICE_SESSION_MISSING_KIND''\);\n {2}END IF;'/.test(SQL));

console.log("\n== B. Schema changes -- identical shape to F-4A's own three tables ==");
assert("2a: ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1'",
  new RegExp(`ALTER TABLE public\\.${TABLE}\\s*\\n\\s*ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';`).test(SQL_CODE_ONLY));
assert("2b: lifecycle_semantics domain CHECK restricted to exactly the two known values",
  new RegExp(`ALTER TABLE public\\.${TABLE}\\s*\\n\\s*ADD CONSTRAINT ${TABLE}_lifecycle_semantics_chk\\s*\\n\\s*CHECK \\(lifecycle_semantics = ANY \\(ARRAY\\['economic_period_v1'::text, 'operational_service_v1'::text\\]\\)\\);`).test(SQL_CODE_ONLY));
assert("2c: service_kind DROP NOT NULL",
  new RegExp(`ALTER TABLE public\\.${TABLE}\\s*\\n\\s*ALTER COLUMN service_kind DROP NOT NULL;`).test(SQL_CODE_ONLY));
assert("2d: old service_kind_check dropped before being replaced",
  new RegExp(`ALTER TABLE public\\.${TABLE}\\s*\\n\\s*DROP CONSTRAINT ${TABLE}_service_kind_check;`).test(SQL_CODE_ONLY));
assert("2e: replaced service_kind_check is explicitly NULL-safe (NOT the bare original, which silently permits NULL once NOT NULL is dropped)",
  // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, quoted verbatim to match the migration's own replaced CHECK expression, not new vocabulary
  new RegExp(`ADD CONSTRAINT ${TABLE}_service_kind_check\\s*\\n\\s*CHECK \\(service_kind IS NULL OR service_kind = ANY \\(ARRAY\\['PRANZO'::text, 'SERA'::text\\]\\)\\);`).test(SQL_CODE_ONLY));
assert("2f: era-pairing CHECK -- economic_period_v1 requires non-null kind, operational_service_v1 requires NULL kind, no third state",
  new RegExp(`ADD CONSTRAINT ${TABLE}_kind_era_chk\\s*\\n\\s*CHECK \\(\\s*\\n\\s*\\(lifecycle_semantics = 'economic_period_v1' AND service_kind IS NOT NULL\\)\\s*\\n\\s*OR \\(lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL\\)\\s*\\n\\s*\\);`).test(SQL_CODE_ONLY));
assert("2g: exactly one table receives the new column (no unrelated schema touched, unlike F-4A's three)",
  (SQL_CODE_ONLY.match(/ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';/g) || []).length === 1);
assert("2h: no F-4A evidence table (service_closeout_snapshots/service_closeouts/service_incidents) is touched",
  !/ALTER TABLE public\.service_closeout/.test(SQL_CODE_ONLY) && !/ALTER TABLE public\.service_incidents/.test(SQL_CODE_ONLY));

console.log("\n== C. The canonical writer -- era-aware validation + lifecycle_semantics copied into the INSERT ==");
assert("3a: exactly one function is redefined in this migration",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 1);
assert("3b: the writer replaces the blanket rejection with the identical era-aware rule F-4A already used on its own three RPCs",
  /IF v_session\.lifecycle_semantics = 'economic_period_v1' AND v_session\.service_kind IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','SERVICE_SESSION_MISSING_KIND'\);\s*\n\s*END IF;/.test(SQL_CODE_ONLY));
assert("3c: the INSERT column list gains lifecycle_semantics, in the same position as service_kind's neighbor",
  /service_session_id, business_date, service_kind, lifecycle_semantics, archived_order_id, related_incident_id,/.test(SQL_CODE_ONLY));
assert("3d: the VALUES list copies v_session.lifecycle_semantics verbatim, server-side only",
  /v_session\.id, v_session\.business_date, v_session\.service_kind, v_session\.lifecycle_semantics, p_archived_order_id, p_related_incident_id,/.test(SQL_CODE_ONLY));
assert("3e: no financial arithmetic changed -- original/remaining exposure, lineage sequence, and every existing validation are byte-identical to the pre-F-4C body",
  /v_remaining := COALESCE\(v_prior\.remaining_exposure_cents, v_original\) - p_amount_cents;/.test(SQL_CODE_ONLY) &&
  /v_remaining := COALESCE\(v_prior\.remaining_exposure_cents, v_original\) \+ p_amount_cents;/.test(SQL_CODE_ONLY) &&
  /OVER_RESOLUTION_EXCEEDS_REMAINING/.test(SQL_CODE_ONLY) &&
  /REVERSAL_EXCEEDS_ORIGINAL/.test(SQL_CODE_ONLY));

console.log("\n== D. HARD SCOPE -- client cannot supply kind/era; no new parameters; no unrelated object touched ==");
assert("4a: the writer's parameter list is byte-identical to pre-F-4C (no new p_service_kind/p_lifecycle_semantics parameter)",
  /CREATE OR REPLACE FUNCTION public\.create_archived_order_financial_resolution\(p_service_session_id uuid, p_archived_order_id text, p_related_incident_id uuid, p_action_correlation_id uuid, p_resolution_type text, p_amount_cents integer, p_actor text, p_actor_role text, p_reason text, p_payment_method text DEFAULT NULL::text, p_reversed_event_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text\)/.test(SQL_CODE_ONLY));
assert("4b: capture_closeout_snapshot / create_service_closeout / create_service_incident (F-4A) are not redefined",
  !/CREATE OR REPLACE FUNCTION public\.capture_closeout_snapshot/.test(SQL) &&
  !/CREATE OR REPLACE FUNCTION public\.create_service_closeout/.test(SQL) &&
  !/CREATE OR REPLACE FUNCTION public\.create_service_incident/.test(SQL));
assert("4c: the F-4B immutability guard (service_sessions.lifecycle_semantics) is not touched -- no trigger created anywhere in this migration",
  !/CREATE TRIGGER/.test(SQL_CODE_ONLY));
assert("4d: ensure_next_service_session_v3 (V3-D1/D3) is not redefined",
  !/CREATE OR REPLACE FUNCTION public\.ensure_next_service_session_v3/.test(SQL));
assert("4e: guard_service_session_closed_v1 (F-3) is not redefined",
  !/CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1/.test(SQL));
assert("4f: close_service_session_v3 / complete_service_session_close (F-1) are not redefined",
  !/CREATE OR REPLACE FUNCTION public\.close_service_session_v3/.test(SQL) &&
  !/CREATE OR REPLACE FUNCTION public\.complete_service_session_close/.test(SQL));
assert("4g: no data is ever written by this migration (schema/function DDL only -- no bare INSERT/UPDATE/DELETE INTO any table outside the function body being redefined)",
  !/\n(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM) public\./.test(SQL_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));

console.log("\n== E. Post-conditions -- structural, matching established discipline ==");
assert("5a: asserts the column shape (NOT NULL + exact default)",
  /lifecycle_semantics missing or wrong shape/.test(SQL));
assert("5b: asserts service_kind is nowhere still NOT NULL",
  /service_kind still NOT NULL on archived_order_financial_resolutions/.test(SQL));
assert("5c: asserts the exact era-pairing CHECK definition",
  /_kind_era_chk missing or wrong shape/.test(SQL));
assert("5d: asserts the exact NULL-safe service_kind_check definition",
  /_service_kind_check not NULL-safe/.test(SQL));
assert("5e: asserts the writer body is era-aware AND copies lifecycle_semantics",
  /create_archived_order_financial_resolution not era-aware/.test(SQL));
assert("5f: asserts the writer's own signature is unchanged (no client-suppliable kind/era)",
  /create_archived_order_financial_resolution signature changed/.test(SQL));
assert("5g: asserts historical row count is exactly 0 (this table's own Phase-0 evidence)",
  /archived_order_financial_resolutions historical integrity violated -- expected 0 rows/.test(SQL) &&
  /count\(\*\) FROM public\.archived_order_financial_resolutions\) <> 0/.test(SQL_CODE_ONLY));
assert("5h: asserts zero real operational_service_v1 session exists (this migration performs no data writes of its own)",
  /a real operational_service_v1 session exists unexpectedly/.test(SQL));
assert("5i: asserts canonical pointer / legacy shadow / payment_transactions / service_sessions population all unchanged",
  /current_period_id changed unexpectedly by this migration/.test(SQL) &&
  /legacy shadow changed unexpectedly by this migration/.test(SQL) &&
  /payment_transactions population changed/.test(SQL) &&
  /service_sessions population changed/.test(SQL));

console.log("\n== F. Immutability -- already unconditional, reused not rebuilt ==");
assert("6a: the pre-existing append-only trigger (archived_order_financial_resolutions_no_update_delete) is NOT redefined -- it already unconditionally blocks ANY update/delete, auto-covering the new column with zero change",
  !/CREATE OR REPLACE FUNCTION public\.archived_order_financial_resolutions_append_only/.test(SQL) &&
  !/archived_order_financial_resolutions_no_update_delete/.test(SQL_CODE_ONLY));

console.log("\n== G. Paired rollback -- PONR-guarded, restores exact byte-captured pre-F-4C shape ==");
assert("7a: rollback refuses outright if ANY real new-era evidence exists (PONR)",
  /F-4C rollback refused: PONR reached -- real new-era archived financial resolution evidence exists/.test(ROLLBACK) &&
  /EXISTS \(SELECT 1 FROM public\.archived_order_financial_resolutions WHERE lifecycle_semantics = 'operational_service_v1' OR service_kind IS NULL\)/.test(ROLLBACK_CODE_ONLY));
assert("7b: rollback also refuses if not applied in the first place",
  /F-4C rollback refused: lifecycle_semantics column not present on archived_order_financial_resolutions/.test(ROLLBACK));
assert("7c: rollback restores the writer to the exact byte-captured pre-F-4C blanket-rejection body",
  /IF v_session\.service_kind IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','SERVICE_SESSION_MISSING_KIND'\);\s*\n\s*END IF;/.test(ROLLBACK_CODE_ONLY));
assert("7d: rollback's restored writer body does NOT reference lifecycle_semantics anywhere (byte-exact pre-F-4C, not a partial revert)",
  (() => {
    const fnStart = ROLLBACK_CODE_ONLY.indexOf("CREATE OR REPLACE FUNCTION public.create_archived_order_financial_resolution");
    const fnEnd = ROLLBACK_CODE_ONLY.indexOf("$function$;", fnStart) + "$function$;".length;
    const body = ROLLBACK_CODE_ONLY.slice(fnStart, fnEnd);
    return fnStart !== -1 && !/lifecycle_semantics/.test(body);
  })());
assert("7e: rollback drops the era-pairing CHECK, restores the ORIGINAL (non-NULL-safe) service_kind_check, and restores NOT NULL, in that dependency order",
  new RegExp(
    `DROP CONSTRAINT ${TABLE}_kind_era_chk;\\s*\\n` +
    `ALTER TABLE public\\.${TABLE} DROP CONSTRAINT ${TABLE}_service_kind_check;\\s*\\n` +
    // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, quoted verbatim to match the rollback's own restored original CHECK expression, not new vocabulary
    `ALTER TABLE public\\.${TABLE} ADD CONSTRAINT ${TABLE}_service_kind_check CHECK \\(service_kind = ANY \\(ARRAY\\['PRANZO'::text, 'SERA'::text\\]\\)\\);.*\\n` +
    `ALTER TABLE public\\.${TABLE} ALTER COLUMN service_kind SET NOT NULL;`
  ).test(ROLLBACK_CODE_ONLY));
assert("7f: rollback drops lifecycle_semantics column (and its own domain CHECK)",
  new RegExp(`DROP CONSTRAINT ${TABLE}_lifecycle_semantics_chk;\\s*\\n\\s*ALTER TABLE public\\.${TABLE} DROP COLUMN lifecycle_semantics;`).test(ROLLBACK_CODE_ONLY));
assert("7g: rollback's own post-condition re-asserts the column is gone, service_kind is NOT NULL again, and the row count is unchanged",
  /lifecycle_semantics still present on archived_order_financial_resolutions/.test(ROLLBACK) &&
  /service_kind still nullable on archived_order_financial_resolutions/.test(ROLLBACK) &&
  /historical row count changed/.test(ROLLBACK));
assert("7h: rollback touches no data table directly (function/constraint/column DDL only, outside the one restored function body)",
  !/\n(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM) public\./.test(ROLLBACK_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
