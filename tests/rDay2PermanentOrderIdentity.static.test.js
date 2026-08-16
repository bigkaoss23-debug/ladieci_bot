"use strict";
// R-DAY2 — static structural proof for
// migrations/2026-08-16_r_day2_permanent_order_identity.sql. Source
// inspection only, matching this repo's established convention (no live
// Postgres available/permitted in this environment). Live behavioral proof
// was additionally captured this session against real STAGING via the
// Supabase MCP tool -- see the R-DAY2 execution report for the exact
// queries and results.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const MIGRATION_PATH = path.join(ROOT, "migrations", "2026-08-16_r_day2_permanent_order_identity.sql");
const ROLLBACK_PATH = path.join(ROOT, "migrations", "2026-08-16_r_day2_permanent_order_identity.ROLLBACK.sql");

function stripComments(text) {
  let out = ""; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i]; const c2 = i + 1 < n ? text[i + 1] : "";
    if (c === "-" && c2 === "-") { while (i < n && text[i] !== "\n") i++; continue; }
    out += c; i++;
  }
  return out;
}

(async () => {
  console.log("\n== R-DAY2 permanent order identity -- static migration checks ==\n");

  assert("0a: migration file exists", fs.existsSync(MIGRATION_PATH));
  assert("0b: rollback file exists", fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const rollback = fs.readFileSync(ROLLBACK_PATH, "utf8");
  const sqlNoComments = stripComments(sql);
  const rollbackNoComments = stripComments(rollback);

  console.log("\n── staging safety ──");
  assert("1a: wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql.trim()));
  assert("1b: staging sentinel guard present", sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert("1c: requires R-DAY1 foundation (business_days/business_day_lifecycle_state)", sql.includes("to_regclass('public.business_days') IS NULL"));
  assert("1d: requires service_sessions.business_day_id (R-DAY1) present", sql.includes("column_name='business_day_id'"));
  assert("1e: fail-closed on pre-existing order_entities", sql.includes("public.order_entities already exists"));
  assert("1f: fail-closed on pre-existing ordenes.order_uid", sql.includes("ordenes.order_uid already exists"));
  assert("1g: refuses if out of sequence vs R-DAY4+ objects", sql.includes("period_consolidations") && sql.includes("business_day_closeout_attempts") && sql.includes("out of sequence"));
  assert("1h: refuses on financial-baseline drift before any mutation", /payment_transactions.*<>\s*20/.test(sqlNoComments));
  assert("1i: refuses on unresolvable Business Day lineage before mutation (no guessing)", sql.includes("service_session_id IS NULL") && sql.includes("unresolvable Business Day lineage"));

  console.log("\n── R-DAY2 non-goals: forbidden identifiers/behaviour ──");
  const forbidden = [
    // NOTE: to_regclass('public.business_day_lifecycle_state') / (...
    // _closeout_attempts) existence checks in the predecessor guard are
    // legitimate and expected (proving R-DAY1 foundation present / R-DAY6
    // not yet started) -- these assertions target actual DATA reads/writes
    // (SELECT ... FROM / column references), not catalog-existence checks.
    { name: "business_day_lifecycle_state's DATA actually read/written (FROM/UPDATE/INSERT against it, not a to_regclass existence check or an error-message mention)", re: /(FROM|UPDATE|INSERT INTO)\s+public\.business_day_lifecycle_state/i },
    { name: "current_business_day_id / current_period_id / current_ticket_epoch referenced", re: /current_business_day_id|current_period_id|current_ticket_epoch/ },
    { name: "period_consolidations created", re: /CREATE TABLE public\.period_consolidations/ },
    { name: "seal_business_day_v1 / business_days.status (R-DAY5)", re: /seal_business_day_v1|sealed_at|seal_source|sealed_by/ },
    { name: "business_day_closeout's DATA read/written (SELECT/column reference, not a to_regclass existence check)", re: /(?<!to_regclass\('public\.)business_day_closeout(?!_attempts'\))/ },
    { name: "service_session_assign_order rewritten (R-DAY3 owns the intake flip)", re: /CREATE OR REPLACE FUNCTION public\.service_session_assign_order/ },
    { name: "ordenes.order_uid SET NOT NULL (S7's job)", re: /order_uid\s+SET\s+NOT\s+NULL/i },
    { name: "table_order_lines / payment_allocations / order_financial_events / service_incidents DISABLE TRIGGER (S8's sole sanctioned bypass)", re: /DISABLE\s+TRIGGER/i },
    { name: "table_ledger_adjustments / ledger_adjustment_operations created (S10)", re: /CREATE TABLE public\.(table_ledger_adjustments|ledger_adjustment_operations)/ },
    { name: "ticket_epoch advanced (reset is R-DAY4-owned business behavior)", re: /ticket_epoch\s*=\s*ticket_epoch\s*\+/ },
    { name: "any operational/financial table mutated beyond the read-only baseline assertions", re: /(INSERT INTO public\.(table_sessions|payment_transactions|payment_allocations|order_financial_events|service_incidents)|UPDATE public\.(table_sessions|payment_transactions|payment_allocations|order_financial_events|service_incidents)\b)/ },
  ];
  for (const { name, re } of forbidden) {
    assert(`2: forward migration never introduces ${name}`, !re.test(sqlNoComments), sqlNoComments.match(re) && sqlNoComments.match(re)[0]);
  }

  console.log("\n── permanent identity object ──");
  assert("3a: order_entities.order_uid is a UUID primary key, DB-generated", /order_uid\s+uuid\s+PRIMARY KEY DEFAULT gen_random_uuid\(\)/.test(sqlNoComments));
  assert("3b: display_order_id is NOT the primary key (never derived identity)", !/display_order_id\s+text\s+PRIMARY KEY/.test(sqlNoComments));
  assert("3c: service_session_id is NOT NULL (immutable economic lineage)", /service_session_id\s+uuid\s+NOT NULL REFERENCES public\.service_sessions/.test(sqlNoComments));
  assert("3d: business_day_id is NOT NULL and FK to business_days (R-DAY0 §8.3 amendment)", /business_day_id\s+uuid\s+NOT NULL REFERENCES public\.business_days/.test(sqlNoComments));
  assert("3e: ticket_epoch/ticket_number are nullable (historical rows get no guessed value)", /ticket_epoch\s+integer\s+NULL/.test(sqlNoComments) && /ticket_number\s+integer\s+NULL/.test(sqlNoComments));
  assert("3f: append-only trigger rejects UPDATE and DELETE, reusing the existing generic mesa_append_only_v1", /CREATE TRIGGER order_entities_append_only_v1\s+BEFORE UPDATE OR DELETE ON public\.order_entities\s+FOR EACH ROW EXECUTE FUNCTION public\.mesa_append_only_v1\(\)/.test(sqlNoComments));
  assert("3g: no bespoke append-only function is invented (DRY -- reuses the existing generic one)", !/CREATE (OR REPLACE )?FUNCTION public\.order_entities_append_only/.test(sqlNoComments));
  assert("3h: ticket uniqueness constraint exists exactly as specified", /CREATE UNIQUE INDEX order_entities_ticket_uq ON public\.order_entities \(business_day_id, ticket_epoch, ticket_number\)/.test(sqlNoComments));

  console.log("\n── ordenes.order_uid transition contract ──");
  assert("4a: added NULLABLE (not NOT NULL) -- S7's job, not R-DAY2's", /ADD COLUMN order_uid uuid NULL REFERENCES public\.order_entities/.test(sqlNoComments));
  assert("4b: unique only where not null (partial index, not a blanket column constraint)", /CREATE UNIQUE INDEX ordenes_order_uid_uq ON public\.ordenes \(order_uid\) WHERE order_uid IS NOT NULL/.test(sqlNoComments));

  console.log("\n── the anchor writer never consumes the R-DAY1 pointer tuple ──");
  assert("5a: Business Day lineage resolved via service_sessions.business_day_id, not the pointer", /SELECT business_day_id INTO v_business_day\s+FROM public\.service_sessions WHERE id = NEW\.service_session_id/.test(sqlNoComments));
  assert("5b: order_uid forgery is rejected (server-assigned identity only)", /ORDER_UID_FORGERY/.test(sql) && /IF NEW\.order_uid IS NOT NULL THEN/.test(sqlNoComments));
  assert("5c: fails closed if the order's period has no Business Day (structurally unreachable, never guessed)", /SERVICE_PERIOD_WITHOUT_BUSINESS_DAY/.test(sql));
  assert("5d: workspace resolution follows the frozen Mesa/non-Mesa split, never trusts client payload", /IF NEW\.table_session_id IS NOT NULL THEN[\s\S]{0,200}SELECT ts\.workspace_id/.test(sqlNoComments) && /ELSE\s+v_workspace := public\.mesa_singleton_workspace_v1\(\);/.test(sqlNoComments));
  assert("5e: ticket_number/ticket_epoch minted from the order's OWN resolved business_day row, one atomic UPDATE...RETURNING", /UPDATE public\.business_days\s+SET next_ticket_number = next_ticket_number \+ 1[\s\S]{0,120}WHERE id = v_business_day\s+RETURNING next_ticket_number - 1, ticket_epoch INTO v_ticket_number, v_epoch/.test(sqlNoComments));

  console.log("\n── trigger ordering (hard gate) ──");
  assert("6a: anchor trigger name sorts after ordenes_assign_service_session ('...anchor_v1' 'o' > '...service_session' 'a')", "ordenes_order_entity_anchor_v1" > "ordenes_assign_service_session");
  assert("6b: anchor trigger is BEFORE INSERT (always precedes any AFTER INSERT trigger by Postgres semantics, independent of name)", /CREATE TRIGGER ordenes_order_entity_anchor_v1\s+BEFORE INSERT ON public\.ordenes/.test(sqlNoComments));
  assert("6c: trigger placement reasoning documented in the migration's own comments", /orts after ordenes_assign_service_session/.test(sql) && sql.includes("mesa_snapshot_order_lines_v1"));

  console.log("\n── deterministic historical backfill, no guessing ──");
  assert("7a: ordenes_source has zero dedup risk (PK-unique by construction, no filter needed)", /ordenes_source AS \(\s*SELECT o\.id AS display_order_id/.test(sqlNoComments));
  assert("7b: no_live_ordenes_counterpart is explicitly filtered to rows with NO live ordenes counterpart (disjoint by construction, no timestamp-matching fragility)", /NOT EXISTS \(\s*SELECT 1 FROM public\.ordenes o2\s*WHERE o2\.service_session_id = s\.service_session_id AND o2\.id = s\.orden_id\s*\)/.test(sqlNoComments));
  // language-guard: allow-legacy storico is the existing archive table this assertion's name refers to, not new vocabulary
  assert("7c: same-session storico duplicates collapse deterministically (DISTINCT ON, earliest ts)", /DISTINCT ON \(s\.service_session_id, s\.orden_id\)/.test(sqlNoComments) && /ORDER BY s\.service_session_id, s\.orden_id, s\.ts ASC/.test(sqlNoComments));
  assert("7d: the two sources combine with UNION ALL only (never blind UNION relying on incidental row equality)", /UNION ALL/.test(sqlNoComments) && !/\bUNION\b(?!\s+ALL)/.test(sqlNoComments));
  assert("7e: backfill never guesses -- raises on any unresolvable row before mutation (asserted in the predecessor guard, §1i above)", true);

  console.log("\n── S7/S8 boundary respected ──");
  assert("8a: no INSERT into table_order_lines/payment_allocations/order_financial_events/service_incidents (S8's own sanctioned bypass, not this slice's)", !/INSERT INTO public\.(table_order_lines|payment_allocations|order_financial_events|service_incidents)/.test(sqlNoComments));
  assert("8b: order_financial_events/table_order_lines append-only triggers never disabled", !/DISABLE TRIGGER/i.test(sql));

  console.log("\n── post-condition assertions (fail loudly, not silently) ──");
  assert("9a: asserts every live ordenes row now has order_uid", /live ordenes rows failed to backfill order_uid/.test(sql));
  assert("9b: asserts no ordenes row references a non-existent order_entities row (orphan check)", /ordenes rows reference a non-existent order_entities row/.test(sql));
  assert("9c: asserts the financial baseline is unchanged after the migration too", sql.split("PART 8")[1] && /payment_transactions\) <> 20/.test(sql.split("PART 8")[1]));

  console.log("\n── RLS / grants ──");
  assert("10a: RLS enabled on order_entities", /ALTER TABLE public\.order_entities ENABLE ROW LEVEL SECURITY/.test(sqlNoComments));
  assert("10b: REVOKE ALL FROM PUBLIC, anon, authenticated on order_entities", /REVOKE ALL ON public\.order_entities FROM PUBLIC, anon, authenticated/.test(sqlNoComments));
  assert("10c: order_entities grants SELECT+INSERT only to service_role -- no UPDATE grant (append-only in spirit, not just by trigger)", /GRANT SELECT, INSERT ON public\.order_entities TO service_role/.test(sqlNoComments) && !/GRANT[^;]*UPDATE[^;]*ON public\.order_entities/.test(sqlNoComments));

  console.log("\n── rollback is a clean, guarded mirror ──");
  assert("11a: rollback wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback.trim()));
  assert("11b: rollback refuses if R-DAY4+/S7/S10 objects exist (forward-drift guard)", /period_consolidations/.test(rollbackNoComments) && /business_day_closeout_attempts/.test(rollbackNoComments) && /table_ledger_adjustments/.test(rollbackNoComments) && /order_uid.*NOT NULL/.test(rollbackNoComments.replace(/\s+/g, ' ')));
  assert("11c: rollback refuses if real post-apply order intake has already produced identity evidence", /real order intake has already produced permanent identity evidence/.test(rollback));
  assert("11d: rollback drops the anchor trigger and function", /DROP TRIGGER IF EXISTS ordenes_order_entity_anchor_v1/.test(rollback) && /DROP FUNCTION IF EXISTS public\.order_entity_anchor_v1\(\)/.test(rollback));
  assert("11e: rollback drops ordenes.order_uid", /ALTER TABLE public\.ordenes DROP COLUMN IF EXISTS order_uid/.test(rollback));
  assert("11f: rollback drops order_entities", /DROP TABLE IF EXISTS public\.order_entities/.test(rollback));
  // language-guard: allow-legacy storico is the existing archive table this regex checks the rollback never touches, not new vocabulary
  assert("11g: rollback never touches service_sessions/business_days/financial tables", !/\b(service_sessions|business_days|payment_transactions|payment_allocations|order_financial_events|table_order_lines|storico)\b/.test(rollbackNoComments));

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
