"use strict";
// R-DAY2 HOTFIX — static structural proof for
// migrations/2026-08-16_r_day2_hotfix_service_sessions_business_day_derive.sql.
// This hotfix closes a real regression discovered live during R-DAY2's own
// verification: R-DAY1's `service_sessions.business_day_id SET NOT NULL`
// (no default) silently broke both public.ensure_service_session and
// public.roll_service_session_economic_v1, whose own INSERT statements
// never supply that column -- reproduced live, in a rolled-back
// transaction, before this fix was authored (23502 not-null violation).
// See the R-DAY2 execution report for the exact probe and result.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const MIGRATION_PATH = path.join(ROOT, "migrations", "2026-08-16_r_day2_hotfix_service_sessions_business_day_derive.sql");
const ROLLBACK_PATH = path.join(ROOT, "migrations", "2026-08-16_r_day2_hotfix_service_sessions_business_day_derive.ROLLBACK.sql");

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
  console.log("\n== R-DAY2 hotfix: service_sessions business_day_id derivation -- static checks ==\n");

  assert("0a: migration file exists", fs.existsSync(MIGRATION_PATH));
  assert("0b: rollback file exists", fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const rollback = fs.readFileSync(ROLLBACK_PATH, "utf8");
  const sqlNoComments = stripComments(sql);
  const rollbackNoComments = stripComments(rollback);

  console.log("\n── staging safety ──");
  assert("1a: wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql.trim()));
  assert("1b: staging sentinel guard present", sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert("1c: refuses if the trigger already exists", sql.includes("trigger already exists"));
  assert("1d: refuses if service_sessions.business_day_id already has a default (drift guard)", sql.includes("already has a default"));

  console.log("\n── does not touch the two pre-existing RPCs it fixes ──");
  assert("2a: never modifies ensure_service_session's own body", !/CREATE OR REPLACE FUNCTION public\.ensure_service_session/.test(sqlNoComments));
  assert("2b: never modifies roll_service_session_economic_v1's own body", !/CREATE OR REPLACE FUNCTION public\.roll_service_session_economic_v1/.test(sqlNoComments));

  console.log("\n── does not consume the R-DAY1 pointer tuple ──");
  assert("3a: never reads or writes business_day_lifecycle_state", !/(FROM|UPDATE|INSERT INTO)\s+public\.business_day_lifecycle_state/i.test(sqlNoComments));

  console.log("\n── the derive trigger ──");
  assert("4a: BEFORE INSERT on service_sessions", /CREATE TRIGGER service_sessions_business_day_derive_v1\s+BEFORE INSERT ON public\.service_sessions/.test(sqlNoComments));
  assert("4b: find-or-create against business_days, ON CONFLICT-safe (concurrency backstop, same as business_days_business_date_uq)", /ON CONFLICT \(business_date\) DO NOTHING/.test(sqlNoComments));
  assert("4c: derivation overwrites unconditionally (a forged value can never survive, matching the S10 child-derive pattern)", /NEW\.business_day_id := v_business_day;/.test(sqlNoComments));
  assert("4d: REVOKE ALL on the new function, no anon/authenticated grant", /REVOKE ALL ON FUNCTION public\.service_session_business_day_derive_v1\(\) FROM PUBLIC, anon, authenticated/.test(sqlNoComments));

  console.log("\n── post-condition reproduces and closes the exact live bug ──");
  assert("5a: probe uses status='rolled_over', not 'open' (avoids colliding with the real open session under service_sessions_single_active_uq)", /VALUES \('2099-01-01','rolled_over'/.test(sqlNoComments));
  assert("5b: asserts the probe row's business_day_id is populated", /probe row has no business_day_id/.test(sql));
  assert("5c: probe residue is fully cleaned up (both the session row and its business_days side effect)", /DELETE FROM public\.service_sessions WHERE id = v_new_id/.test(sqlNoComments) && /DELETE FROM public\.business_days WHERE business_date = '2099-01-01'/.test(sqlNoComments));

  console.log("\n── rollback ──");
  assert("6a: rollback wrapped in BEGIN/COMMIT", /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback.trim()));
  assert("6b: rollback drops the trigger and function", /DROP TRIGGER IF EXISTS service_sessions_business_day_derive_v1/.test(rollback) && /DROP FUNCTION IF EXISTS public\.service_session_business_day_derive_v1\(\)/.test(rollback));
  assert("6c: rollback never touches service_sessions data, only the trigger/function objects", !/(UPDATE|DELETE FROM|INSERT INTO)\s+public\.service_sessions/i.test(rollbackNoComments));

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
