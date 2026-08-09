"use strict";
// SERVICE CLOSEOUT V2 / SLICE 4C.2C — static guard for
// migrations/2026-08-09_service_closeout_cross_service_table_policy.sql
// (+ its ROLLBACK). Same pattern as tests/serviceCloseLiveWorkGuardMigration.test.js
// and tests/closeoutAttemptOwnership.static.test.js: assert on the SQL text
// itself, no live database required. Real-Postgres transactional proof
// (BEGIN/ROLLBACK against staging tdikhfeinufaahagmpjz) is a separate,
// non-repo-resident step — see the session report for its status.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const migration = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "2026-08-09_service_closeout_cross_service_table_policy.sql"),
  "utf8",
);
const rollback = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "2026-08-09_service_closeout_cross_service_table_policy.ROLLBACK.sql"),
  "utf8",
);

test("wrapped in a single transaction, forward and rollback alike", () => {
  assert.match(migration, /^BEGIN;$/m);
  assert.match(migration, /COMMIT;\s*$/);
  assert.match(rollback, /^BEGIN;$/m);
  assert.match(rollback, /COMMIT;\s*$/);
});

test("refuses to run against the wrong database or on top of missing prerequisites", () => {
  assert.match(migration, /schema_migrations WHERE version='20260710075612'/);
  assert.match(migration, /to_regclass\('public\.service_sessions'\) IS NULL/);
  assert.match(migration, /to_regclass\('public\.service_closeout_attempts'\) IS NULL/);
  assert.match(migration, /to_regclass\('public\.service_incidents'\) IS NULL/);
  assert.match(migration, /to_regclass\('public\.table_sessions'\) IS NULL/);
  assert.match(migration, /to_regprocedure\('public\.begin_service_session_close\(text,text\)'\) IS NULL/);
  assert.match(migration, /to_regprocedure\('public\.guard_service_session_closed_v1\(\)'\) IS NULL/);
  assert.match(migration, /to_regprocedure\('public\.supersede_closeout_attempt\(uuid,text,text\)'\) IS NULL/);
  assert.match(migration, /to_regprocedure\('public\.mesa_release_empty_session_v1\(uuid,text,uuid\)'\) IS NULL/);
});

test("refuses to run twice (mesa_release_empty_session_auto_v1 must not already exist)", () => {
  assert.match(migration, /to_regprocedure\('public\.mesa_release_empty_session_auto_v1\(uuid,uuid\)'\) IS NOT NULL/);
  assert.match(migration, /already exists — resolve drift first/);
});

test("begin_service_session_close skips the open-table check only for an active closeout attempt on THIS session", () => {
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.begin_service_session_close"),
    migration.indexOf("CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1"),
  );
  assert.match(fn, /IF NOT EXISTS \(\s*SELECT 1 FROM public\.service_closeout_attempts\s*WHERE service_session_id = v_session\.id AND status = 'active'\s*\)/);
  assert.match(fn, /PERFORM 1 FROM public\.table_sessions[\s\S]*status = 'open'/);
  assert.match(fn, /'code','MESA_TABLES_NOT_RELEASED'/);
});

test("guard_service_session_closed_v1 applies the identical exemption on the closing->closed transition", () => {
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1"),
    migration.indexOf("CREATE OR REPLACE FUNCTION public.mesa_release_empty_session_auto_v1"),
  );
  assert.match(fn, /IF NOT EXISTS \(\s*SELECT 1 FROM public\.service_closeout_attempts\s*WHERE service_session_id = OLD\.id AND status = 'active'\s*\)/);
  assert.match(fn, /MESSAGE = 'MESA_TABLES_NOT_RELEASED'/);
  // the active-orders check (a separate rule) is untouched
  assert.match(fn, /MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED'/);
  // language-guard: allow-legacy COMPLETATO/CHIUSO_FORZATO are the existing terminal-state literals asserted verbatim from the migration SQL under test, not new vocabulary
  for (const state of ["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO", "CANCELLED", "ANULADO", "CHIUSO_FORZATO"]) {
    assert.ok(fn.includes(`'${state}'`), `terminal state ${state} missing`);
  }
});

test("no request field can forge the exemption: the ONLY signal is an active service_closeout_attempts row", () => {
  // neither function reads p_closed_by/p_source/NEW/OLD for anything other
  // than identity/audit — the exemption predicate itself has no caller input.
  const beginFn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.begin_service_session_close"),
    migration.indexOf("CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1"),
  );
  assert.ok(!/p_closed_by\s*=\s*['"]/.test(beginFn), "exemption must not branch on a caller-supplied string");
  assert.ok(!/p_source\s*=\s*['"]/.test(beginFn), "exemption must not branch on a caller-supplied string");
});

test("mesa_release_empty_session_auto_v1: same session/covers guard as the human path, no actor authorization block, service_role-only", () => {
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.mesa_release_empty_session_auto_v1"),
    migration.indexOf("CREATE OR REPLACE FUNCTION public.supersede_closeout_attempt"),
  );
  assert.match(fn, /p_workspace_id uuid,\s*p_table_session_id uuid/);
  assert.ok(!/p_by_actor/.test(fn), "the trusted-system path must take no actor parameter");
  assert.ok(!/auth_actors/.test(fn), "the trusted-system path must not perform human-actor authorization");
  assert.match(fn, /IF v_session\.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN'/);
  assert.match(fn, /IF v_session\.covers_total IS NOT NULL THEN\s*RAISE EXCEPTION 'MESA_TABLE_HAS_ORDERS'/);
  assert.match(fn, /status = 'closed'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.mesa_release_empty_session_auto_v1\(uuid,uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.mesa_release_empty_session_auto_v1\(uuid,uuid\) TO service_role;/);
  assert.ok(!/TO anon/.test(fn) && !/TO authenticated/.test(migration.split("mesa_release_empty_session_auto_v1")[1] || ""), "never granted to a public browser role");
});

test("supersede_closeout_attempt: widened cascade catches an unverified auto-release claim, never a genuine admin resolution", () => {
  const fn = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.supersede_closeout_attempt"));
  assert.match(fn, /resolution_status IN \('pending','acknowledged'\)/);
  assert.match(fn, /OR \(resolution_status = 'resolved' AND resolution_type = 'auto_released_empty_table'\)/);
  // the reconciliation write itself never sets resolution_type to
  // auto_released_empty_table or anything admin-authored — only the fixed
  // system-superseded marker.
  assert.match(fn, /resolution_type\s*=\s*'closeout_attempt_superseded'/);
});

test("rollback restores the exact pre-4C.2C bodies (no active-attempt exemption, narrower supersede cascade) and drops the new RPC", () => {
  const beginAndGuard = rollback.slice(
    rollback.indexOf("CREATE OR REPLACE FUNCTION public.begin_service_session_close"),
    rollback.indexOf("CREATE OR REPLACE FUNCTION public.supersede_closeout_attempt"),
  );
  assert.ok(!beginAndGuard.includes("status = 'active'"), "pre-4C.2C begin_service_session_close/guard bodies must not carry the active-closeout-attempt exemption");
  assert.match(rollback, /resolution_status IN \('pending','acknowledged'\)/);
  assert.ok(!rollback.includes("auto_released_empty_table"), "rollback's supersede_closeout_attempt must not carry the widened cascade");
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.mesa_release_empty_session_auto_v1\(uuid,uuid\);/);
  assert.ok(rollback.indexOf("REVOKE ALL ON FUNCTION public.mesa_release_empty_session_auto_v1") < rollback.indexOf("DROP FUNCTION IF EXISTS public.mesa_release_empty_session_auto_v1"));
});

test("rollback explicitly disclaims un-happening any row the forward migration's functions already affected", () => {
  assert.match(rollback, /does not and must not un-happen them/);
});

test("forward migration is additive/CREATE-OR-REPLACE-only: no DROP TABLE, no DROP COLUMN, no destructive rewrite", () => {
  assert.ok(!/DROP TABLE/.test(migration));
  assert.ok(!/DROP COLUMN/i.test(migration));
});
