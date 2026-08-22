"use strict";
// K-1 — the orden_estado_logs lockdown, asserted against the migration's own
// bytes and against the runtime's own source of truth.
//
// The finding: this was the ONE table in the schema with row level security
// never enabled, while anon and authenticated each held the full Supabase
// default grant. The staging publishable key is compiled into the browser
// bundle, so that was an unauthenticated, internet-reachable write path into
// the audit log that holds the only surviving trace of deleted orders.
//
// Two things this file exists to stop:
//   1. a later edit quietly adding a permissive policy "to make it work again",
//      which would hand back precisely what the migration removes; and
//   2. the migration growing beyond its one table.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const ROOT = path.join(__dirname, "..");
const FORWARD = "2026-08-22_k1_orden_estado_logs_rls_lockdown.sql";
const ROLLBACK = "2026-08-22_k1_orden_estado_logs_rls_lockdown.ROLLBACK.sql";
const sql = fs.readFileSync(path.join(ROOT, "migrations", FORWARD), "utf8");
const rollback = fs.readFileSync(path.join(ROOT, "migrations", ROLLBACK), "utf8");
// Comment-blind view: this file explains its own rules in prose that necessarily
// NAMES what those rules forbid, so a scan for statements must not match the
// documentation. Same technique ledger 98 needed.
const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

test("both files exist and are paired, as every migration in this project is", () => {
  assert.ok(sql.length > 0 && rollback.length > 0);
  assert.ok(/^BEGIN;$/m.test(sql) && /^COMMIT;$/m.test(sql));
});

// ── A — RLS ON ─────────────────────────────────────────────────────────────
test("A · row level security is enabled AND forced", () => {
  assert.ok(/ALTER TABLE public\.orden_estado_logs ENABLE ROW LEVEL SECURITY;/.test(statements));
  assert.ok(/ALTER TABLE public\.orden_estado_logs FORCE ROW LEVEL SECURITY;/.test(statements));
  assert.ok(sql.includes("row level security must be enabled AND forced"),
    "and a post-condition proves it rather than assuming the ALTER ran");
});

test("A2 · no compensating policy is created — RLS with zero policies IS the lockdown", () => {
  assert.ok(!/CREATE POLICY/i.test(statements),
    "a permissive policy would hand back exactly what the revokes remove");
  assert.ok(sql.includes("RLS with no policy IS the lockdown"),
    "and the policy count is asserted to stay zero");
});

// ── B & C — anon / authenticated hold nothing ──────────────────────────────
test("B/C · anon and authenticated are revoked BY NAME, not just via PUBLIC", () => {
  // A blanket REVOKE FROM PUBLIC does not remove a grant held directly by a
  // named role — the trap ledger 98's first apply caught with service_role.
  assert.ok(/REVOKE ALL ON public\.orden_estado_logs FROM PUBLIC;/.test(statements));
  assert.ok(/REVOKE ALL ON public\.orden_estado_logs FROM anon;/.test(statements));
  assert.ok(/REVOKE ALL ON public\.orden_estado_logs FROM authenticated;/.test(statements));
});

test("B/C2 · the post-conditions check every privilege, not only the mutating four", () => {
  for (const role of ["anon", "authenticated"]) {
    for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "SELECT", "REFERENCES", "TRIGGER"]) {
      assert.ok(
        sql.includes(`has_table_privilege('${role}','public.orden_estado_logs','${priv}')`),
        `${role}/${priv} is not asserted`,
      );
    }
  }
});

test("B/C3 · SELECT is revoked too — least privilege, not least mutation", () => {
  // Justified by the runtime, asserted below in test F2: nothing outside
  // service_role reads this table.
  assert.ok(!/GRANT[^;]*\bON public\.orden_estado_logs\b[^;]*\bTO (anon|authenticated)\b/i.test(statements),
    "the forward migration must not grant the browser roles anything back");
});

// ── D & E — the canonical writer survives ──────────────────────────────────
test("D · service_role is deliberately NOT revoked, and its privileges are asserted", () => {
  assert.ok(!/REVOKE[^;]*\bON public\.orden_estado_logs\b[^;]*\bFROM[^;]*service_role/i.test(statements),
    "service_role is the canonical writer — revoking it would break the audit trail entirely");
  assert.ok(sql.includes("has_table_privilege('service_role','public.orden_estado_logs','INSERT')"));
  assert.ok(sql.includes("has_table_privilege('service_role','public.orden_estado_logs','SELECT')"),
    "SELECT is load-bearing: PostgREST return=representation reads the row back after POST");
});

test("D2 · the RLS half is proven harmless to service_role, not assumed to be", () => {
  // ENABLE/FORCE would block the writer outright if service_role ever stopped
  // bypassing RLS, and that is a role attribute this migration does not own.
  assert.ok(sql.includes("rolbypassrls"),
    "the migration must assert service_role still bypasses RLS");
  assert.ok(sql.includes("so ENABLE/FORCE would block the writer"));
});

test("E · the forced-close writer is untouched and stays unreachable from a browser", () => {
  assert.ok(!/CREATE OR REPLACE FUNCTION[^;]*mesa_close_session_v1/i.test(statements),
    "mesa_close_session_v1's semantics must not change");
  assert.ok(sql.includes("mesa_close_session_v1 is missing"),
    "its presence is asserted");
  assert.ok(sql.includes("the forced-close writer became reachable from a browser role"),
    "and so is the fact that anon/authenticated still cannot execute it");
});

test("E2 · a live SET ROLE anon probe proves the refusal, and leaves nothing behind", () => {
  // Privilege bits are a model of the answer; the probe is the answer.
  assert.ok(/SET LOCAL ROLE anon;/.test(statements));
  assert.ok(/INSERT INTO public\.orden_estado_logs/.test(statements));
  assert.ok(sql.includes("WHEN insufficient_privilege THEN v_probe := 'DENIED'"));
  assert.ok(sql.includes("expected DENIED"),
    "and the migration aborts if the insert is somehow permitted");
  assert.ok(sql.includes("the probe left a row behind"),
    "residue is asserted absent, not assumed");
  assert.ok(/RESET ROLE;/.test(statements), "the probe must not leak the role");
});

// ── F — scope ──────────────────────────────────────────────────────────────
test("F · nothing outside orden_estado_logs is modified", () => {
  const mutating = statements.match(/^\s*(ALTER TABLE|GRANT|REVOKE|CREATE POLICY|DROP)\b.*$/gim) || [];
  assert.ok(mutating.length > 0, "sanity: the migration does something");
  for (const line of mutating) {
    assert.ok(/orden_estado_logs/.test(line),
      `out-of-scope statement touches another object: ${line.trim()}`);
  }
});

test("F2 · no DML, no schema change, no new SECURITY DEFINER", () => {
  for (const forbidden of [
    /\bCREATE TABLE\b/i, /\bDROP TABLE\b/i, /\bADD COLUMN\b/i, /\bDROP COLUMN\b/i,
    /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\s+public\./i, /\bTRUNCATE\s+/i,
    /\bCREATE TRIGGER\b/i, /\bDROP TRIGGER\b/i, /\bSECURITY DEFINER\b/i,
  ]) {
    assert.ok(!forbidden.test(statements), `K-1 must not contain ${forbidden}`);
  }
  // The single INSERT is the anon probe, which is required to fail.
  assert.strictEqual((statements.match(/INSERT INTO/g) || []).length, 1);
});

test("F3 · the runtime justifies revoking SELECT: nothing but service_role reads this table", () => {
  // Asserted from the runtime's own source of truth rather than from prose, so
  // that adding a reader without adding a grant fails here first.
  const policy = fs.readFileSync(path.join(ROOT, "src/utils/supabaseResourcePolicy.js"), "utf8");
  const entry = policy.match(/entry\('orden_estado_logs'[^)]*\)/);
  assert.ok(entry, "orden_estado_logs must still be registered in the H1B resource policy");
  assert.ok(/\['POST'\]/.test(entry[0]),
    "the backend is POST-only on this table; if it ever needs GET, this migration's SELECT revoke must be revisited");
  // And the writer is where we think it is.
  const logger = fs.readFileSync(path.join(ROOT, "src/utils/orderStateLogger.js"), "utf8");
  assert.ok(/insert\("orden_estado_logs"/.test(logger), "the canonical writer moved");
});

test("F4 · ledger registration stays outside the file, as in ledgers 96-100", () => {
  assert.ok(!/INSERT INTO public\.ladieci_schema_migrations/.test(statements),
    "embedding the row here would make the checksum self-referential");
  assert.ok(sql.includes("apply_order 101"), "the intended ledger position is stated");
});

test("idempotent-safe: every statement is a no-op on a second run", () => {
  // ENABLE/FORCE RLS and REVOKE are all naturally repeatable; nothing here
  // creates an object that would collide.
  assert.ok(!/CREATE (TABLE|INDEX|TRIGGER|POLICY)\b/i.test(statements));
  assert.ok(sql.includes("IDEMPOTENT BY CONSTRUCTION"));
});

test("the rollback restores the pre-state and states plainly what it costs", () => {
  assert.ok(/DISABLE ROW LEVEL SECURITY/.test(rollback));
  assert.ok(/GRANT[\s\S]*TO anon;/.test(rollback));
  assert.ok(/GRANT[\s\S]*TO authenticated;/.test(rollback));
  assert.ok(/re-opens an unauthenticated, internet-reachable write path/.test(rollback),
    "a rollback that silently re-opens the hole is worse than none");
  assert.ok(rollback.includes("service_role lost the canonical writer privileges"),
    "and it verifies the writer survives the rollback too");
});

console.log(`k1OrdenEstadoLogsRlsLockdownMigration: ${passed} passed`);
