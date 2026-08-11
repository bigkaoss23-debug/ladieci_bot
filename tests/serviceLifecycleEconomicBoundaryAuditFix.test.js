"use strict";
// SERVICE LIFECYCLE / P0-C2 — static structural proof for
// migrations/2026-08-11_service_lifecycle_economic_boundary_v1_audit_fix.sql.
// Source inspection only (no DB) — both directions of the actual constraint
// change (accepts 'rolled_over_economic', still rejects an arbitrary bogus
// value, original 3 values still accepted) were proven against an isolated
// shadow copy of the real service_session_audit_event_type_check constraint
// in-session (4/4 checks) before this migration was applied for real; see
// P0_C2_INTRADAY_ECONOMIC_BOUNDARY_REPORT.md.

const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const ROOT = path.join(__dirname, "..");
const MIGRATION_PATH = path.join(ROOT, "migrations", "2026-08-11_service_lifecycle_economic_boundary_v1_audit_fix.sql");
const ROLLBACK_PATH = path.join(ROOT, "migrations", "2026-08-11_service_lifecycle_economic_boundary_v1_audit_fix.ROLLBACK.sql");

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
  console.log("\n== P0-C2 economic boundary audit-fix migration — static structural proof ==\n");

  assert("0: forward migration file exists", fs.existsSync(MIGRATION_PATH));
  assert("0b: rollback file exists", fs.existsSync(ROLLBACK_PATH));

  const sql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const sqlNoComments = stripComments(sql);
  const rollback = fs.readFileSync(ROLLBACK_PATH, "utf8");
  const rollbackNoComments = stripComments(rollback);

  console.log("\n── preflight guards ──");
  assert("1a: refuses on wrong database (sentinel check)", /schema_migrations WHERE version = '20260710075612'/.test(sqlNoComments));
  assert("1b: refuses if row 65's RPC is missing", /to_regprocedure\('public\.roll_service_session_economic_v1\(uuid,uuid,text,text,text,date\)'\) IS NULL/.test(sqlNoComments));
  assert("1c: refuses if already patched (idempotent-refusal, not silent no-op)", /already allows rolled_over_economic/.test(sqlNoComments));
  assert("1d: refuses if the pre-existing constraint isn't the expected 3-value definition (drift guard)", /is not the expected 3-value definition/.test(sqlNoComments));

  console.log("\n── the actual change ──");
  assert("2a: drops the old constraint", /DROP CONSTRAINT service_session_audit_event_type_check/.test(sqlNoComments));
  assert("2b: adds it back widened by exactly one value", /CHECK \(event_type = ANY \(ARRAY\['opened','closing','closed','rolled_over_economic'\]\)\)/.test(sqlNoComments));
  assert("2c: wrapped in a single transaction", /^BEGIN;/m.test(sqlNoComments) && /COMMIT;\s*$/.test(sqlNoComments.trim()));

  console.log("\n── minimal blast radius: nothing else touched ──");
  const alterMatches = sqlNoComments.match(/ALTER TABLE\s+public\.\w+/g) || [];
  assert("3a: exactly one table is ALTERed", new Set(alterMatches).size === 1);
  assert("3b: that table is service_session_audit", alterMatches.every((m) => /service_session_audit$/.test(m)));
  assert("3c: no CREATE FUNCTION / CREATE TRIGGER anywhere", !/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|TRIGGER)/i.test(sqlNoComments));
  assert("3d: no DML against ordenes/table_sessions/service_sessions rows", !/\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(ordenes|table_sessions|service_sessions)\b/i.test(sqlNoComments));
  assert("3e: row 65's own migration file is not re-touched", !sqlNoComments.includes("2026-08-10_service_lifecycle_economic_boundary_v1.sql") || /HOTFIX for row 65/.test(sql));

  console.log("\n── rollback is a clean, safety-guarded mirror ──");
  assert("4a: rollback refuses if any real rolled_over_economic audit row still exists", /event_type = 'rolled_over_economic'[\s\S]*RAISE EXCEPTION/.test(rollbackNoComments));
  assert("4b: rollback restores the original 3-value CHECK exactly", /CHECK \(event_type = ANY \(ARRAY\['opened','closing','closed'\]\)\)/.test(rollbackNoComments));
  assert("4c: rollback touches no other constraint/table", (rollbackNoComments.match(/ALTER TABLE\s+public\.\w+/g) || []).every((m) => /service_session_audit$/.test(m)));

  console.log("");
  console.log("=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
