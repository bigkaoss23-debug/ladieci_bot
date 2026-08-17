"use strict";
// F-4A — Finalizar servicio repair, slice 4A. Static (source-text) proof for
// the migration + paired rollback (Evidence Model B, frozen by the Opus
// architecture decision on F-4's own live-proven schema blocker). Live
// acceptance (the mandatory A-D matrix, the full V3 evidence chain against a
// rolled-back operational_service_v1+NULL fixture, S-C/S-E economics with a
// NULL session kind, and historical-integrity proof of all 66 pre-existing
// evidence rows) was run as its own separate, controlled step against real
// staging, entirely inside BEGIN/ROLLBACK -- see the migration's own header
// and the F-4A report for the exact live-verified evidence. Zero residue
// confirmed after every run.
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const stripSqlComments = (s) => s.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

const SQL = read("migrations/2026-08-17_f4a_era_aware_close_evidence_contract.sql");
const ROLLBACK = read("migrations/2026-08-17_f4a_era_aware_close_evidence_contract.ROLLBACK.sql");
const SQL_CODE_ONLY = stripSqlComments(SQL);
const ROLLBACK_CODE_ONLY = stripSqlComments(ROLLBACK);

const TABLES = ["service_closeout_snapshots", "service_closeouts", "service_incidents"];

console.log("\n== A. Predecessor guards ==");
assert("1a: refuses on wrong database (sentinel check)",
  /F-4A refused: staging sentinel migration absent/.test(SQL));
assert("1b: drift guard refuses if lifecycle_semantics already present on any evidence table",
  /F-4A refused: lifecycle_semantics column already present on at least one evidence table/.test(SQL));
assert("1c: drift guard refuses if service_kind is already nullable on any evidence table",
  /F-4A refused: service_kind is already nullable on at least one evidence table/.test(SQL));
assert("1d: predecessor-body guard requires the exact pre-F-4A blanket rejection in all three RPCs",
  (SQL.match(/F-4A refused: (capture_closeout_snapshot|create_service_closeout|create_service_incident) does not match the expected pre-F-4A body/g) || []).length === 3);
assert("1e: each RPC's predecessor-body guard is checked against the SAME literal blanket-rejection text",
  (SQL.match(/IF v_session\.service_kind IS NULL THEN\n {4}RETURN jsonb_build_object\(''ok'',false,''code'',''SERVICE_SESSION_MISSING_KIND''\);\n {2}END IF;'/g) || []).length === 3);

console.log("\n== B. Schema changes -- exactly three tables, identical shape ==");
for (const t of TABLES) {
  assert(`2a[${t}]: ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1'`,
    new RegExp(`ALTER TABLE public\\.${t}\\s*\\n\\s*ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';`).test(SQL_CODE_ONLY));
  assert(`2b[${t}]: lifecycle_semantics domain CHECK restricted to exactly the two known values`,
    new RegExp(`ALTER TABLE public\\.${t}\\s*\\n\\s*ADD CONSTRAINT ${t}_lifecycle_semantics_chk\\s*\\n\\s*CHECK \\(lifecycle_semantics = ANY \\(ARRAY\\['economic_period_v1'::text, 'operational_service_v1'::text\\]\\)\\);`).test(SQL_CODE_ONLY));
  assert(`2c[${t}]: service_kind DROP NOT NULL`,
    new RegExp(`ALTER TABLE public\\.${t}\\s*\\n\\s*ALTER COLUMN service_kind DROP NOT NULL;`).test(SQL_CODE_ONLY));
  assert(`2d[${t}]: old service_kind_check dropped before being replaced`,
    new RegExp(`ALTER TABLE public\\.${t}\\s*\\n\\s*DROP CONSTRAINT ${t}_service_kind_check;`).test(SQL_CODE_ONLY));
  assert(`2e[${t}]: replaced service_kind_check is explicitly NULL-safe (NOT the bare original, which silently permits NULL once NOT NULL is dropped)`,
    // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, quoted verbatim to match the migration's own replaced CHECK expression, not new vocabulary
    new RegExp(`ADD CONSTRAINT ${t}_service_kind_check\\s*\\n\\s*CHECK \\(service_kind IS NULL OR service_kind = ANY \\(ARRAY\\['PRANZO'::text, 'SERA'::text\\]\\)\\);`).test(SQL_CODE_ONLY));
  assert(`2f[${t}]: era-pairing CHECK -- economic_period_v1 requires non-null kind, operational_service_v1 requires NULL kind, no third state`,
    new RegExp(`ADD CONSTRAINT ${t}_kind_era_chk\\s*\\n\\s*CHECK \\(\\s*\\n\\s*\\(lifecycle_semantics = 'economic_period_v1' AND service_kind IS NOT NULL\\)\\s*\\n\\s*OR \\(lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL\\)\\s*\\n\\s*\\);`).test(SQL_CODE_ONLY));
}
assert("2g: exactly three tables receive the new column (no unrelated schema touched)",
  (SQL_CODE_ONLY.match(/ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';/g) || []).length === 3);
assert("2h: era-pairing CHECK referenced exactly 3x per table (ADD CONSTRAINT + post-condition conname + post-condition error message), 9 total -- no unrelated table touched",
  (SQL_CODE_ONLY.match(/_kind_era_chk/g) || []).length === 9);

console.log("\n== C. The three RPCs -- era-aware validation + lifecycle_semantics copied into the INSERT ==");
assert("3a: exactly three functions are redefined in this migration",
  (SQL_CODE_ONLY.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 3);
assert("3b: all three RPCs replace the blanket rejection with the identical era-aware rule",
  (SQL_CODE_ONLY.match(/IF v_session\.lifecycle_semantics = 'economic_period_v1' AND v_session\.service_kind IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','SERVICE_SESSION_MISSING_KIND'\);\s*\n\s*END IF;/g) || []).length === 3);
assert("3c: capture_closeout_snapshot's INSERT column list gains lifecycle_semantics, in the same position as service_kind's neighbor",
  /service_session_id, business_date, service_kind, lifecycle_semantics, closeout_correlation_id,/.test(SQL_CODE_ONLY));
assert("3d: capture_closeout_snapshot's VALUES list copies v_session.lifecycle_semantics verbatim, server-side only",
  /v_session\.id, v_session\.business_date, v_session\.service_kind, v_session\.lifecycle_semantics, p_closeout_correlation_id,/.test(SQL_CODE_ONLY));
assert("3e: create_service_closeout's INSERT column list gains lifecycle_semantics",
  /service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics,/.test(SQL_CODE_ONLY));
assert("3f: create_service_closeout's VALUES list copies v_session.lifecycle_semantics verbatim",
  /v_session\.id, p_closeout_correlation_id, v_session\.business_date, v_session\.service_kind, v_session\.lifecycle_semantics,/.test(SQL_CODE_ONLY));
assert("3g: create_service_incident's INSERT column list gains lifecycle_semantics",
  /service_session_id, business_date, service_kind, lifecycle_semantics, closeout_correlation_id, snapshot_id,/.test(SQL_CODE_ONLY));
assert("3h: create_service_incident's VALUES list copies v_session.lifecycle_semantics verbatim",
  /v_session\.id, v_session\.business_date, v_session\.service_kind, v_session\.lifecycle_semantics, p_closeout_correlation_id, p_snapshot_id,/.test(SQL_CODE_ONLY));

console.log("\n== D. HARD SCOPE -- client cannot supply kind/era; no new parameters; no unrelated function touched ==");
assert("4a: capture_closeout_snapshot's parameter list is byte-identical to pre-F-4A (no new p_service_kind/p_lifecycle_semantics parameter)",
  /CREATE OR REPLACE FUNCTION public\.capture_closeout_snapshot\(p_service_session_id uuid, p_closeout_correlation_id uuid, p_captured_by text, p_source text, p_payload jsonb, p_schema_version integer DEFAULT 1, p_payload_sha256 text DEFAULT NULL::text\)/.test(SQL_CODE_ONLY));
assert("4b: create_service_closeout's parameter list is byte-identical to pre-F-4A",
  /CREATE OR REPLACE FUNCTION public\.create_service_closeout\(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_close_reason text,/.test(SQL_CODE_ONLY));
assert("4c: create_service_incident's parameter list is byte-identical to pre-F-4A",
  /CREATE OR REPLACE FUNCTION public\.create_service_incident\(p_service_session_id uuid, p_closeout_correlation_id uuid, p_incident_type text, p_category text, p_severity text, p_detected_by text,/.test(SQL_CODE_ONLY));
assert("4d: ensure_next_service_session_v3 (V3-D1/D3) is not redefined",
  !/CREATE OR REPLACE FUNCTION public\.ensure_next_service_session_v3/.test(SQL));
assert("4e: guard_service_session_closed_v1 (F-3) is not redefined",
  !/CREATE OR REPLACE FUNCTION public\.guard_service_session_closed_v1/.test(SQL));
assert("4f: close_service_session_v3 / complete_service_session_close (F-1) are not redefined",
  !/CREATE OR REPLACE FUNCTION public\.close_service_session_v3/.test(SQL) &&
  !/CREATE OR REPLACE FUNCTION public\.complete_service_session_close/.test(SQL));
assert("4g: no data is ever written by this migration (schema/function DDL only -- no bare INSERT/UPDATE/DELETE INTO any table outside the function bodies being redefined)",
  !/\n(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM) public\./.test(SQL_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));
assert("4h: archived_order_financial_resolutions (the adjacent, deliberately-deferred defect) is not touched",
  !/ALTER TABLE public\.archived_order_financial_resolutions/.test(SQL));
assert("4i: service_sessions.lifecycle_semantics UPDATE-immutability (the other adjacent, deliberately-deferred prerequisite) is not touched -- no trigger created on service_sessions",
  !/CREATE TRIGGER[\s\S]*ON public\.service_sessions/.test(SQL));

console.log("\n== E. Post-conditions -- structural, matching established discipline ==");
assert("5a: asserts every column shape (NOT NULL + exact default) on all three tables",
  (SQL.match(/lifecycle_semantics missing or wrong shape/g) || []).length === 3);
assert("5b: asserts service_kind is nowhere still NOT NULL",
  /service_kind still NOT NULL on at least one evidence table/.test(SQL));
assert("5c: asserts the exact era-pairing CHECK definition on all three tables",
  (SQL.match(/_kind_era_chk missing or wrong shape/g) || []).length === 3);
assert("5d: asserts the exact NULL-safe service_kind_check definition on all three tables",
  (SQL.match(/_service_kind_check not NULL-safe/g) || []).length === 3);
assert("5e: asserts all three RPC bodies are era-aware AND copy lifecycle_semantics",
  /capture_closeout_snapshot not era-aware/.test(SQL) &&
  /create_service_closeout not era-aware/.test(SQL) &&
  /create_service_incident not era-aware/.test(SQL));
assert("5f: asserts capture_closeout_snapshot's own signature is unchanged (no client-suppliable kind/era)",
  /capture_closeout_snapshot signature changed/.test(SQL));
assert("5g: asserts historical row counts + values + era are byte-identical to Phase 0 evidence for all three tables",
  /service_closeouts historical integrity violated/.test(SQL) &&
  /service_closeout_snapshots historical integrity violated/.test(SQL) &&
  /service_incidents historical integrity violated/.test(SQL));
assert("5h: asserts zero real operational_service_v1 session exists (this migration performs no data writes of its own)",
  /a real operational_service_v1 session exists unexpectedly/.test(SQL));
assert("5i: asserts canonical pointer / legacy shadow / payment_transactions population unchanged",
  /current_period_id changed unexpectedly by this migration/.test(SQL) &&
  /legacy shadow changed unexpectedly by this migration/.test(SQL) &&
  /payment_transactions population changed/.test(SQL));

console.log("\n== F. Paired rollback -- PONR-guarded, restores exact byte-captured pre-F-4A shape ==");
assert("6a: rollback refuses outright if ANY real new-era evidence exists in ANY of the three tables (PONR)",
  /F-4A rollback refused: PONR reached -- real new-era evidence exists/.test(ROLLBACK) &&
  (ROLLBACK.match(/EXISTS \(SELECT 1 FROM public\.\w+ WHERE lifecycle_semantics = 'operational_service_v1' OR service_kind IS NULL\)/g) || []).length === 3);
assert("6b: rollback also refuses if not applied in the first place",
  /F-4A rollback refused: lifecycle_semantics column not present on service_closeout_snapshots/.test(ROLLBACK));
assert("6c: rollback restores all three RPCs to the exact byte-captured pre-F-4A blanket-rejection body",
  (ROLLBACK_CODE_ONLY.match(/IF v_session\.service_kind IS NULL THEN\s*\n\s*RETURN jsonb_build_object\('ok',false,'code','SERVICE_SESSION_MISSING_KIND'\);\s*\n\s*END IF;/g) || []).length === 3);
assert("6d: rollback's restored RPC bodies do NOT reference lifecycle_semantics anywhere (byte-exact pre-F-4A, not a partial revert)",
  (() => {
    const firstFn = ROLLBACK_CODE_ONLY.indexOf("CREATE OR REPLACE FUNCTION public.capture_closeout_snapshot");
    const lastFnEnd = ROLLBACK_CODE_ONLY.lastIndexOf("$function$;") + "$function$;".length;
    const fnBodies = ROLLBACK_CODE_ONLY.slice(firstFn, lastFnEnd);
    return firstFn !== -1 && !/lifecycle_semantics/.test(fnBodies);
  })());
assert("6e: rollback drops the era-pairing CHECK, restores the ORIGINAL (non-NULL-safe) service_kind_check, and restores NOT NULL, on all three tables, in that dependency order",
  TABLES.every((t) => {
    const re = new RegExp(
      `DROP CONSTRAINT ${t}_kind_era_chk;\\s*\\n` +
      `ALTER TABLE public\\.${t} DROP CONSTRAINT ${t}_service_kind_check;\\s*\\n` +
      // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, quoted verbatim to match the rollback's own restored original CHECK expression, not new vocabulary
      `ALTER TABLE public\\.${t} ADD CONSTRAINT ${t}_service_kind_check CHECK \\(service_kind = ANY \\(ARRAY\\['PRANZO'::text, 'SERA'::text\\]\\)\\);.*\\n` +
      `ALTER TABLE public\\.${t} ALTER COLUMN service_kind SET NOT NULL;`
    );
    return re.test(ROLLBACK_CODE_ONLY);
  }));
assert("6f: rollback drops lifecycle_semantics column (and its own domain CHECK) on all three tables",
  TABLES.every((t) => new RegExp(`DROP CONSTRAINT ${t}_lifecycle_semantics_chk;\\s*\\n\\s*ALTER TABLE public\\.${t} DROP COLUMN lifecycle_semantics;`).test(ROLLBACK_CODE_ONLY)));
assert("6g: rollback's own post-condition re-asserts the column is gone and service_kind is NOT NULL again everywhere, plus historical row counts unchanged",
  /lifecycle_semantics still present on at least one evidence table/.test(ROLLBACK) &&
  /service_kind still nullable on at least one evidence table/.test(ROLLBACK) &&
  /historical row counts changed/.test(ROLLBACK));
assert("6h: rollback touches no data table directly (function/constraint/column DDL only, outside the three restored function bodies)",
  !/\n(INSERT INTO|UPDATE public\.(?!.*CREATE)|DELETE FROM) public\./.test(ROLLBACK_CODE_ONLY.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\$function\$;/g, "")));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
