"use strict";
// FINALIZAR V3 CANONICAL CLOSEOUT V1 — the DATABASE half (migration 121),
// asserted against the migration file's own bytes. No live Postgres is
// available/permitted for a NEW, unapplied migration (STAGING ONLY, no DB
// mutation) — same division of labour as every prior slice's *.static.test.js.
// The runtime behaviour (columns enforce the pairing invariant, the writer
// persists both facts, a legacy caller still writes a legacy row) is proven
// against fakes in tests/finalizarV3CanonicalCloseout.test.js.
//
// What this file exists to catch: (a) the additive change turning destructive;
// (b) a second create_service_closeout overload being left behind (the exact
// V3.3 hazard — see migrationV3ChainDependencyOrder.static.test.js); (c) the
// F-4A era-aware body being silently dropped while transcribing around it;
// (d) net_sales_cents / gross_sales_cents being redefined; (e) the rollback
// not being a faithful inverse.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; console.log("  PASS  " + name); }
  catch (e) { failed += 1; console.log("  FAIL  " + name + "\n        " + (e && e.message)); process.exitCode = 1; }
};

const MIG = path.join(__dirname, "..", "migrations");
const FORWARD = "2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.sql";
const ROLLBACK = "2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.ROLLBACK.sql";
const read = (f) => fs.readFileSync(path.join(MIG, f), "utf8");
const sql = read(FORWARD);
const rollback = read(ROLLBACK);
const manifest = read("MIGRATION_MANIFEST.md");
// full-line SQL comments stripped, so structural checks can't be tripped by prose
const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
const rbCode = rollback.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

console.log("\n== A. transaction + staging discipline ==");
test("forward is one transaction (BEGIN/COMMIT, no bare ROLLBACK)", () => {
  assert.ok(/^BEGIN;$/m.test(sql) && /^COMMIT;$/m.test(sql) && !/^ROLLBACK;$/m.test(sql));
});
test("rollback is one transaction", () => {
  assert.ok(/^BEGIN;$/m.test(rollback) && /^COMMIT;$/m.test(rollback));
});
test("DO blocks use named tags ($guard$ / $post$), never a bare $$", () => {
  assert.ok(sql.includes("DO $guard$") && sql.includes("DO $post$"));
  assert.ok(!/DO \$\$/.test(code));
});
test("function body uses $function$ ... $function$", () => {
  assert.ok(/AS \$function\$/.test(sql) && /\$function\$;/.test(sql));
});

console.log("\n== B. additive only — nothing destructive to the table or its data ==");
test("no DROP TABLE / TRUNCATE / DELETE FROM anywhere", () => {
  assert.ok(!/DROP\s+TABLE/i.test(code));
  assert.ok(!/TRUNCATE/i.test(code));
  assert.ok(!/DELETE\s+FROM/i.test(code));
});
test("no UPDATE of service_closeouts rows (append-only respected)", () => {
  assert.ok(!/UPDATE\s+public\.service_closeouts/i.test(code));
  assert.ok(!/UPDATE\s+service_closeouts/i.test(code));
});
test("no backfill — the only INSERT INTO service_closeouts is inside the RPC body", () => {
  // exactly one INSERT INTO public.service_closeouts, and it is the writer's
  const inserts = code.match(/INSERT INTO public\.service_closeouts/g) || [];
  assert.strictEqual(inserts.length, 1);
});
test("the append-only trigger is never dropped or altered", () => {
  assert.ok(!/DROP TRIGGER[^;]*service_closeouts_no_update_delete/i.test(code));
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.service_closeouts_append_only/i.test(code));
});
test("no trigger relaxation of any kind", () => {
  assert.ok(!/DISABLE TRIGGER/i.test(code) && !/ALTER TABLE[^;]*DISABLE/i.test(code));
});

console.log("\n== C. the two additive columns: nullable, no default ==");
test("ADD COLUMN current_obligation_cents integer — nullable, NO default", () => {
  assert.ok(/ADD COLUMN current_obligation_cents integer\b/.test(code));
  assert.ok(!/ADD COLUMN current_obligation_cents integer[^,;]*NOT NULL/i.test(code));
  assert.ok(!/ADD COLUMN current_obligation_cents integer[^,;]*DEFAULT/i.test(code));
});
test("ADD COLUMN over_collected_cents integer — nullable, NO default", () => {
  assert.ok(/ADD COLUMN over_collected_cents\s+integer\b/.test(code));
  assert.ok(!/ADD COLUMN over_collected_cents\s+integer[^,;]*NOT NULL/i.test(code));
  assert.ok(!/ADD COLUMN over_collected_cents\s+integer[^,;]*DEFAULT/i.test(code));
});

console.log("\n== D. the three additive CHECK constraints ==");
test("NULL-safe non-negative on current_obligation_cents", () => {
  assert.ok(/CONSTRAINT service_closeouts_current_obligation_cents_nonneg_chk\s*\n?\s*CHECK \(current_obligation_cents IS NULL OR current_obligation_cents >= 0\)/.test(code));
});
test("NULL-safe non-negative on over_collected_cents", () => {
  assert.ok(/CONSTRAINT service_closeouts_over_collected_cents_nonneg_chk\s*\n?\s*CHECK \(over_collected_cents IS NULL OR over_collected_cents >= 0\)/.test(code));
});
test("the pairing invariant — both null or both non-null", () => {
  assert.ok(/CONSTRAINT service_closeouts_canonical_obligation_pairing_chk\s*\n?\s*CHECK \(\(current_obligation_cents IS NULL\) = \(over_collected_cents IS NULL\)\)/.test(code));
});

console.log("\n== E. create_service_closeout — DROP + CREATE, exactly one overload ==");
test("DROP FUNCTION targets the exact 23-parameter pre-121 signature", () => {
  assert.ok(/DROP FUNCTION public\.create_service_closeout\(\s*uuid, uuid, text, text, text,\s*integer, integer, integer, integer, integer, integer, integer,\s*integer, integer, integer, integer, integer, integer,\s*integer, integer, integer, integer, integer\s*\)/.test(code));
});
test("CREATE FUNCTION (not CREATE OR REPLACE) — no second overload can survive", () => {
  assert.ok(/\nCREATE FUNCTION public\.create_service_closeout\(/.test(code));
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.create_service_closeout\(/.test(code));
});
test("the two new parameters are trailing and DEFAULT NULL", () => {
  assert.ok(/p_current_obligation_cents integer DEFAULT NULL/.test(code));
  assert.ok(/p_over_collected_cents\s+integer DEFAULT NULL/.test(code));
  // ...after p_critical_incident_count
  assert.ok(/p_critical_incident_count\s+integer DEFAULT 0,\s*\n[\s\S]{0,400}p_current_obligation_cents integer DEFAULT NULL,\s*\n\s*p_over_collected_cents\s+integer DEFAULT NULL\s*\n\)/.test(code));
});
test("SECURITY INVOKER preserved (no SECURITY DEFINER added) + pinned search_path", () => {
  const fn = code.slice(code.indexOf("CREATE FUNCTION public.create_service_closeout("));
  assert.ok(/SET search_path TO 'public', 'pg_temp'/.test(fn));
  assert.ok(!/SECURITY DEFINER/.test(fn.slice(0, fn.indexOf("$function$"))));
});
test("F-4A era-aware body is preserved verbatim (not silently dropped)", () => {
  assert.ok(code.includes("v_session.lifecycle_semantics = 'economic_period_v1' AND v_session.service_kind IS NULL"));
  assert.ok(code.includes("service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics,"));
});
test("Convention A preserved — the writer body never RAISEs", () => {
  const fn = code.slice(code.indexOf("CREATE FUNCTION public.create_service_closeout("), code.indexOf("$function$;"));
  assert.ok(!/RAISE EXCEPTION/.test(fn));
});
test("the NULL-pair validation is present, returns INVALID_CANONICAL_OBLIGATION_PAIR", () => {
  assert.ok(/\(p_current_obligation_cents IS NULL\) <> \(p_over_collected_cents IS NULL\)/.test(code));
  assert.ok(code.includes("INVALID_CANONICAL_OBLIGATION_PAIR"));
});
test("the INSERT carries the two new columns, and their VALUES are raw (never COALESCEd to 0)", () => {
  assert.ok(/incident_count, critical_incident_count,\s*\n\s*current_obligation_cents, over_collected_cents\s*\n\s*\) VALUES/.test(code));
  assert.ok(/COALESCE\(p_incident_count, 0\), COALESCE\(p_critical_incident_count, 0\),\s*\n(?:\s*--[^\n]*\n)?\s*p_current_obligation_cents, p_over_collected_cents\s*\n\s*\)/.test(code));
  assert.ok(!/COALESCE\(p_current_obligation_cents/.test(code));
  assert.ok(!/COALESCE\(p_over_collected_cents/.test(code));
});
test("grants re-established on the 25-parameter signature, service_role only", () => {
  assert.ok(/REVOKE ALL ON FUNCTION public\.create_service_closeout\([\s\S]{0,300}integer, integer\s*\n?\s*\) FROM PUBLIC, anon, authenticated;/.test(code));
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.create_service_closeout\([\s\S]{0,300}integer, integer\s*\n?\s*\) TO service_role;/.test(code));
});

console.log("\n== F. gross_sales_cents / net_sales_cents are NOT redefined ==");
test("no rename of gross_sales_cents", () => {
  assert.ok(!/RENAME COLUMN gross_sales_cents/i.test(code));
  assert.ok(!/gross_sales_cents\s+TO\s+/i.test(code));
});
test("net_sales_cents is never dropped, altered, or recomputed here", () => {
  assert.ok(!/DROP COLUMN[^;]*net_sales_cents/i.test(code));
  assert.ok(!/ALTER COLUMN net_sales_cents/i.test(code));
});
test("no fiscal column added", () => {
  assert.ok(!/ADD COLUMN[^;]*(tax_|fiscal_)/i.test(code));
});
test("no change to service_incidents or service_closeout_reconciliations", () => {
  assert.ok(!/ALTER TABLE public\.service_incidents/i.test(code));
  assert.ok(!/ALTER TABLE public\.service_closeout_reconciliations/i.test(code));
  assert.ok(!/CREATE OR REPLACE FUNCTION public\.create_service_incident/i.test(code));
});

console.log("\n== G. guard + post-condition ==");
test("$guard$ refuses if the columns already exist (already applied)", () => {
  assert.ok(/already applied/i.test(sql) && /current_obligation_cents','over_collected_cents/.test(sql));
});
test("$guard$ pins the exact 23-parameter identity before DROPping", () => {
  assert.ok(/pg_get_function_identity_arguments/.test(sql));
  assert.ok(/p_critical_incident_count integer'/.test(sql));
});
test("$guard$ asserts exactly one overload pre-migration", () => {
  assert.ok(/expected exactly 1 create_service_closeout overload before this migration/.test(sql));
});
test("$post$ asserts columns nullable + no default", () => {
  assert.ok(/is_nullable='YES' AND column_default IS NULL/.test(sql));
});
test("$post$ asserts exactly ONE overload after, ending with the two new params", () => {
  assert.ok(/expected exactly 1 create_service_closeout overload, found/.test(sql));
  assert.ok(/p_critical_incident_count integer, p_current_obligation_cents integer, p_over_collected_cents integer/.test(sql));
});
test("$post$ asserts ZERO rows were backfilled", () => {
  assert.ok(/current_obligation_cents IS NOT NULL[\s\S]{0,240}backfilled/.test(sql));
});
test("$post$ asserts service_closeouts + service_incidents row counts unchanged", () => {
  assert.ok(/ladieci\.m121_closeouts_before/.test(sql) && /ladieci\.m121_incidents_before/.test(sql));
});
test("$post$ asserts the append-only trigger survived", () => {
  assert.ok(/service_closeouts_no_update_delete trigger disappeared/.test(sql));
});

console.log("\n== H. rollback is a faithful inverse ==");
test("rollback DROPs the 25-param signature and re-CREATEs the 23-param body", () => {
  assert.ok(/DROP FUNCTION public\.create_service_closeout\([\s\S]{0,300}integer, integer\s*\n\);/.test(rbCode));
  assert.ok(/CREATE FUNCTION public\.create_service_closeout\(/.test(rbCode));
  const start = rbCode.indexOf("CREATE FUNCTION public.create_service_closeout(");
  const body = rbCode.slice(start, rbCode.indexOf("$function$;", start));
  assert.ok(!/p_current_obligation_cents/.test(body) && !/p_over_collected_cents/.test(body));
  assert.ok(!/current_obligation_cents, over_collected_cents/.test(body));
});
test("rollback drops the three CHECKs and the two columns", () => {
  assert.ok(/DROP CONSTRAINT IF EXISTS service_closeouts_canonical_obligation_pairing_chk/.test(rbCode));
  assert.ok(/DROP COLUMN IF EXISTS current_obligation_cents/.test(rbCode));
  assert.ok(/DROP COLUMN IF EXISTS over_collected_cents/.test(rbCode));
});
test("rollback HARD-REFUSES if any canonical-obligation row exists", () => {
  assert.ok(/current_obligation_cents IS NOT NULL[\s\S]{0,160}(destroy immutable close facts|resolve manually)/.test(rollback));
});
test("rollback re-grants service_role only", () => {
  assert.ok(/GRANT EXECUTE ON FUNCTION public\.create_service_closeout\([\s\S]{0,300}\) TO service_role;/.test(rbCode));
});

console.log("\n== I. manifest ==");
test("MIGRATION_MANIFEST.md carries a row for this migration file", () => {
  assert.ok(manifest.includes("| 2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.sql |"));
});
test("the manifest row records apply_order 121, NOT YET APPLIED, and this file's checksum", () => {
  const line = manifest.split("\n").find((l) => l.includes("2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.sql"));
  assert.ok(line && /apply_order 121/.test(line));
  assert.ok(/NOT YET APPLIED/.test(line) && /ledger stays 120/.test(line));
  assert.ok(line.includes("d4012b3677306096"));
});
test("the manifest row states gross_sales_cents is NOT redefined and net_sales_cents NOT touched", () => {
  const line = manifest.split("\n").find((l) => l.includes("2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.sql"));
  assert.ok(/NOT renamed and NOT redefined/.test(line));
});

console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===");
process.exit(failed === 0 ? 0 : 1);
