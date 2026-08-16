"use strict";
// R-DAY1 — static structural proof for
// migrations/2026-08-16_r_day1_business_day_authority_substrate.sql.
// Source inspection only (no DB) -- matching the established convention
// used throughout this repo's migration test suite (e.g.
// closeoutAttemptOwnership.static.test.js, serviceLifecycleEconomicBoundary
// Migration.static.test.js): "no live Postgres available/permitted in this
// environment -- STAGING ONLY, no database mutation -- so the DB-level
// invariants here are proven by inspecting exactly what was written."
//
// Live DB behaviour (the actual concurrency/atomicity/backfill proof) was
// additionally verified this same session against real STAGING via the
// Supabase MCP tool -- see the R-DAY1 execution report for the exact
// queries and results. This file is the committed, re-runnable half of
// that proof.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const MIGRATION_PATH = path.join(ROOT, "migrations", "2026-08-16_r_day1_business_day_authority_substrate.sql");
const ROLLBACK_PATH = path.join(ROOT, "migrations", "2026-08-16_r_day1_business_day_authority_substrate.ROLLBACK.sql");

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
  console.log("\n== R-DAY1 business day authority substrate -- static migration checks ==\n");

  assert("0a: migration file exists", fs.existsSync(MIGRATION_PATH));
  assert("0b: rollback file exists", fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const rollback = fs.readFileSync(ROLLBACK_PATH, "utf8");
  const sqlNoComments = stripComments(sql);
  const rollbackNoComments = stripComments(rollback);

  console.log("\n── staging safety ──");
  assert("1a: wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql.trim()));
  assert("1b: staging sentinel guard present (matches every other migration in this repo)", sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert("1c: fail-closed on pre-existing target objects", sql.includes("a target object already exists"));
  assert("1d: requires S4 (ladieci_schema_migrations) already live", sql.includes("to_regclass('public.ladieci_schema_migrations') IS NULL"));
  assert("1e: requires service_sessions/service_session_state foundation", sql.includes("to_regclass('public.service_sessions') IS NULL") && sql.includes("to_regclass('public.service_session_state') IS NULL"));
  assert("1f: refuses if order_entities already exists (out-of-sequence guard)", sql.includes("to_regclass('public.order_entities') IS NOT NULL"));
  assert("1g: refuses on financial-baseline drift before any mutation (20 = 13 + 4 TEST-S1 + 3 TEST-S2)", /payment_transactions.*<>\s*20/.test(sqlNoComments));

  console.log("\n── R-DAY1 non-goals: forbidden identifiers/behaviour ──");
  const forbidden = [
    { name: "order_entities (R-DAY2/S6 — not this slice)", re: /CREATE TABLE public\.order_entities/ },
    { name: "order_uid column anywhere", re: /order_uid/ },
    { name: "period_consolidations (R-DAY4)", re: /period_consolidations/ },
    { name: "seal_business_day_v1 / business_days.status / sealed_at (R-DAY5)", re: /seal_business_day_v1|business_days[\s\S]{0,40}\bstatus\b|sealed_at|seal_source|sealed_by/ },
    { name: "business_day_closeout_attempts (R-DAY6)", re: /business_day_closeout/ },
    { name: "service_session_assign_order rewritten (R-DAY3 owns the intake flip)", re: /CREATE OR REPLACE FUNCTION public\.service_session_assign_order/ },
    { name: "public.config touched anywhere", re: /\bpublic\.config\b/ },
    // language-guard: allow-legacy ORDER_RESET_TS/LAST_CLOSE_PRANZO/LAST_CLOSE_SERA/LAST_CLOSE_DATE are the exact existing config keys this test asserts are ABSENT from the migration, not new vocabulary
    { name: "ORDER_RESET_TS / LAST_CLOSE_PRANZO / LAST_CLOSE_SERA / LAST_CLOSE_DATE referenced", re: /ORDER_RESET_TS|LAST_CLOSE_PRANZO|LAST_CLOSE_SERA|LAST_CLOSE_DATE/ },
    { name: "any operational table touched (table_sessions/ordenes/payment_transactions row mutation beyond the read-only baseline assertion)", re: /(INSERT INTO public\.(table_sessions|ordenes|payment_transactions|payment_allocations|order_financial_events)|UPDATE public\.(table_sessions|ordenes|payment_transactions|payment_allocations|order_financial_events)\b(?!.{0,5}WHERE.{0,5}false))/ },
    { name: "DRIVER_STATO referenced", re: /DRIVER_STATO/ },
  ];
  for (const { name, re } of forbidden) {
    assert(`2: forward migration never introduces ${name}`, !re.test(sqlNoComments), sqlNoComments.match(re) && sqlNoComments.match(re)[0]);
  }

  console.log("\n── additive-only against pre-existing tables ──");
  const destructivePatterns = [
    /DROP\s+TABLE(?!\s+IF\s+NOT)/i,
    /TRUNCATE/i,
    /RENAME\s+TO/i,
    /ALTER\s+TABLE\s+public\.service_sessions\s+DROP\s+COLUMN(?!\s+IF\s+EXISTS\s+business_day_id)/i,
  ];
  for (const re of destructivePatterns) {
    assert("3: forward migration contains no " + re, !re.test(sqlNoComments), sqlNoComments.match(re) && sqlNoComments.match(re)[0]);
  }
  assert("3b: service_sessions.id/business_date/service_kind never altered", !/ALTER\s+TABLE\s+public\.service_sessions\s+ALTER\s+COLUMN\s+(id|business_date|service_kind)\b/i.test(sqlNoComments));
  assert("3c: the only new column on an existing table is business_day_id", (sqlNoComments.match(/ALTER\s+TABLE\s+public\.service_sessions\s+ADD\s+COLUMN/gi) || []).length === 1 && /ADD COLUMN\s+business_day_id/.test(sqlNoComments));

  console.log("\n── deterministic backfill, no guessing ──");
  assert("4a: business_days backfill is a DISTINCT join on service_sessions.business_date only", /SELECT DISTINCT s\.business_date[\s\S]{0,80}FROM public\.service_sessions s/.test(sqlNoComments));
  assert("4b: backfill never reads table_sessions/ordenes/payment_transactions/config", !/FROM public\.(table_sessions|ordenes|payment_transactions|config)\b/.test(sqlNoComments.split("PART 3")[1]?.split("PART 4")[0] || ""));
  assert("4c: unmapped rows raise rather than default/guess", /% service_sessions rows failed deterministic business_day mapping -- never guess, escalate instead/.test(sql));
  assert("4d: business_day_id is enforced NOT NULL in the same transaction", /ALTER TABLE public\.service_sessions ALTER COLUMN business_day_id SET NOT NULL/.test(sqlNoComments));
  assert("4e: business_day_id references business_days with ON DELETE RESTRICT", /business_day_id uuid NULL REFERENCES public\.business_days\(id\) ON DELETE RESTRICT/.test(sqlNoComments));

  console.log("\n── one Business Day per business_date (constraint, not convention) ──");
  assert("5a: business_days.business_date carries a real UNIQUE constraint", /CONSTRAINT business_days_business_date_uq UNIQUE \(business_date\)/.test(sqlNoComments));

  console.log("\n── the atomic pointer contract (R-DAY0 §6 hard-stop condition) ──");
  assert("6a: business_day_lifecycle_state is a governed singleton (same PK shape as service_session_state)", /singleton\s+boolean\s+PRIMARY KEY DEFAULT true CHECK \(singleton\)/.test(sqlNoComments));
  assert("6b: all three governed columns live on the SAME row", /current_business_day_id[\s\S]{0,200}current_period_id[\s\S]{0,200}current_ticket_epoch/.test(sqlNoComments));
  assert("6c: a BEFORE UPDATE trigger guards all three columns together", /IF \(NEW\.current_business_day_id\s+IS DISTINCT FROM OLD\.current_business_day_id[\s\S]{0,50}OR NEW\.current_period_id\s+IS DISTINCT FROM OLD\.current_period_id[\s\S]{0,50}OR NEW\.current_ticket_epoch\s+IS DISTINCT FROM OLD\.current_ticket_epoch\)/.test(sqlNoComments));
  assert("6d: the guard raises unless the sanctioned session-local flag is set", /BUSINESS_DAY_POINTER_UNAUTHORIZED_MUTATION/.test(sql) && /current_setting\('ladieci\.business_day_pointer_authorized', true\)/.test(sqlNoComments));
  assert("6e: the flag is set with SET LOCAL semantics (is_local = true), never leaks past the transaction", /set_config\('ladieci\.business_day_pointer_authorized', 'true', true\)/.test(sqlNoComments));
  assert("6f: only open_business_day_v1's body ever sets the flag", (sqlNoComments.match(/set_config\('ladieci\.business_day_pointer_authorized'/g) || []).length === 1);
  assert("6g: open_business_day_v1 acquires the EXISTING lifecycle advisory lock, not a new one", /open_business_day_v1[\s\S]{0,600}pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/.test(sqlNoComments));
  assert("6h: no second advisory-lock name is introduced anywhere in this migration", (sqlNoComments.match(/pg_advisory_xact_lock\(hashtext\('([^']+)'\)\)/g) || []).every((m) => m.includes("service_session_lifecycle")));

  console.log("\n── open_business_day_v1 is dormant substrate, not a cutover ──");
  assert("7a: never resolves a Service Period (current_period_id is always NULL here)", /current_period_id\s*=\s*NULL/.test(sqlNoComments));
  assert("7b: refuses rather than transitions when a different day is already current", /ANOTHER_BUSINESS_DAY_CURRENT/.test(sql));
  assert("7c: replay of the same calendar date is idempotent (REUSED, created:false)", /'code', 'REUSED', 'created', false/.test(sql));
  assert("7d: REVOKE ALL + GRANT EXECUTE TO service_role only, matching every other lifecycle RPC in this repo", /REVOKE ALL ON FUNCTION public\.open_business_day_v1\(text, text\) FROM PUBLIC, anon, authenticated/.test(sql) && /GRANT EXECUTE ON FUNCTION public\.open_business_day_v1\(text, text\) TO service_role/.test(sql));

  console.log("\n── config authority boundary (R-DAY0 §9/§16) ──");
  assert("8a: business_day_policy is a dedicated table, not the generic config key/value table", /CREATE TABLE public\.business_day_policy/.test(sqlNoComments));
  assert("8b: business_day_policy is singleton-shaped (single-workspace, matching mesa_singleton_workspace_v1's established pattern)", /singleton\s+boolean\s+PRIMARY KEY DEFAULT true CHECK \(singleton\)[\s\S]{0,400}business_day_policy|business_day_policy[\s\S]{0,400}singleton\s+boolean\s+PRIMARY KEY/.test(sqlNoComments));
  assert("8c: auto_seal_local_time is nullable -- no value guessed", /auto_seal_local_time\s+time\s+NULL/.test(sqlNoComments));

  console.log("\n── RLS / grants match the established shape ──");
  assert("9a: RLS enabled on all three new tables", /ALTER TABLE public\.business_days\s+ENABLE ROW LEVEL SECURITY/.test(sqlNoComments) && /ALTER TABLE public\.business_day_policy\s+ENABLE ROW LEVEL SECURITY/.test(sqlNoComments) && /ALTER TABLE public\.business_day_lifecycle_state\s+ENABLE ROW LEVEL SECURITY/.test(sqlNoComments));
  assert("9b: REVOKE ALL FROM PUBLIC, anon, authenticated on all three new tables", /REVOKE ALL ON public\.business_days, public\.business_day_policy, public\.business_day_lifecycle_state\s+FROM PUBLIC, anon, authenticated/.test(sqlNoComments));

  console.log("\n── post-condition assertions exist (fail loudly, not silently) ──");
  assert("10a: asserts business_days count equals distinct business_date count", /business_days row count \(%\) does not equal distinct service_sessions\.business_date count/.test(sql));
  assert("10b: asserts every service_sessions row is mapped", /rows are unmapped/.test(sql));
  assert("10c: asserts the financial baseline is unchanged after the migration too", sql.split("PART 7")[1] && /payment_transactions\) <> 20/.test(sql.split("PART 7")[1]));

  console.log("\n── rollback is a clean, guarded mirror ──");
  assert("11a: rollback wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback.trim()));
  assert("11b: rollback refuses if order_entities/period_consolidations/business_day_closeout_attempts exist (forward-drift guard)", /order_entities.*IS NOT NULL/.test(rollbackNoComments) && /period_consolidations.*IS NOT NULL/.test(rollbackNoComments) && /business_day_closeout_attempts.*IS NOT NULL/.test(rollbackNoComments));
  assert("11c: rollback refuses if current_period_id has already been consumed for real", /SELECT current_period_id, current_ticket_epoch[\s\S]{0,300}v_period IS NOT NULL/.test(rollbackNoComments));
  assert("11d: rollback drops open_business_day_v1", /DROP FUNCTION IF EXISTS public\.open_business_day_v1\(text, text\)/.test(rollback));
  assert("11e: rollback drops the guard trigger and its function", /DROP TRIGGER IF EXISTS business_day_lifecycle_state_guard_v1/.test(rollback) && /DROP FUNCTION IF EXISTS public\.business_day_lifecycle_state_guard_v1\(\)/.test(rollback));
  assert("11f: rollback drops business_day_id from service_sessions", /ALTER TABLE public\.service_sessions DROP COLUMN IF EXISTS business_day_id/.test(rollback));
  assert("11g: rollback never touches service_sessions.business_date/id/service_kind", !/service_sessions\s+(DROP|ALTER COLUMN)\s+(business_date|id|service_kind)/i.test(rollbackNoComments));
  // language-guard: allow-legacy ordenes/table_sessions/payment_transactions/payment_allocations/order_financial_events/storico are the exact existing table names this test asserts the rollback never touches, not new vocabulary
  assert("11h: rollback never touches any financial or order table", !/\b(ordenes|table_sessions|payment_transactions|payment_allocations|order_financial_events|storico)\b/.test(rollbackNoComments));
  assert("11i: rollback drops all three new tables", /DROP TABLE IF EXISTS public\.business_day_lifecycle_state/.test(rollback) && /DROP TABLE IF EXISTS public\.business_day_policy/.test(rollback) && /DROP TABLE IF EXISTS public\.business_days/.test(rollback));

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
