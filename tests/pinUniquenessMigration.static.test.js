'use strict';
// S2-7D2 static migration tests. NON-EXECUTING: asserts structure/safety of the uniqueness
// RPC by inspecting the SQL text. No DB, no apply.
// Run: node tests/pinUniquenessMigration.static.test.js
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const DIR = path.join(__dirname, '..', 'migrations');
const FWD = '2026-07-25_operational_pin_uniqueness.sql';
const RB = '2026-07-25_operational_pin_uniqueness.ROLLBACK.sql';
const sql = fs.readFileSync(path.join(DIR, FWD), 'utf8');
const rb = fs.readFileSync(path.join(DIR, RB), 'utf8');
const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('naming convention + rollback pairing', () => {
  assert.match(FWD, /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/);
  assert.match(RB, /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/);
});

test('staging sentinel + S2-7D predecessor guards present', () => {
  assert.match(code, /schema_migrations WHERE version='20260710075612'/);
  assert.match(code, /auth_actors[\s\S]*column_name='workspace_id'/);
  assert.match(code, /owner_pin_onboarding_completed_at/);
});

test('does NOT replay or edit the applied S2-7D migration', () => {
  // no DDL on the objects S2-7D already created, and no re-creation of its functions
  assert.doesNotMatch(code, /ADD COLUMN/i);
  assert.doesNotMatch(code, /CREATE OR REPLACE FUNCTION public\.auth_account_claim_workspace/);
  assert.doesNotMatch(code, /CREATE OR REPLACE FUNCTION public\.auth_account_set_owner_pin\s*\(/);
  assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX/i);
});

test('creates exactly one new function: the v2 rotation RPC', () => {
  const fns = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(fns, ['auth_account_set_owner_pin_v2']);
});

test('privileged-function hardening: SECURITY INVOKER + fixed search_path', () => {
  assert.match(code, /SECURITY INVOKER/);
  assert.match(code, /SET search_path = public, pg_temp/);
});

test('grants: revoked from PUBLIC/anon/authenticated, granted only to service_role', () => {
  assert.match(code, /REVOKE ALL ON FUNCTION public\.auth_account_set_owner_pin_v2[^;]*FROM PUBLIC, anon, authenticated/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.auth_account_set_owner_pin_v2[^;]*TO service_role/);
  assert.doesNotMatch(code, /GRANT EXECUTE[^;]*_v2[^;]*TO (anon|authenticated)/);
});

test('locks the workspace AND every actor row before deciding', () => {
  assert.match(code, /FROM public\.workspaces WHERE id = p_workspace_id FOR UPDATE/);
  assert.match(code, /FROM public\.auth_actors\s*\n?\s*WHERE workspace_id = p_workspace_id ORDER BY actor FOR UPDATE/);
});

test('re-verifies the snapshot under lock and aborts on drift', () => {
  assert.match(code, /AUTH_ROTATION_STALE/);
  assert.match(code, /ERRCODE='40001'/);            // serialization_failure
  assert.match(code, /IS DISTINCT FROM v_other\.active/);
  assert.match(code, /IS DISTINCT FROM v_other\.pin_hash/);
  assert.match(code, /v_seen_count <> v_others/);   // snapshot must cover every other actor
});

test('authorization stays the active owner membership', () => {
  assert.match(code, /role = 'workspace_owner' AND status = 'active'/);
  assert.match(code, /NOT_WORKSPACE_OWNER/);
});

test('rotation contract preserved: sv+1, lock reset, scrypt hash, never NULLs the PIN', () => {
  assert.match(code, /session_version = session_version \+ 1/);
  assert.match(code, /failed_count = 0, locked_until = NULL/);
  assert.match(code, /left\(p_hash, 7\) <> 'scrypt\$'/);
  assert.doesNotMatch(code, /pin_hash = NULL/);
});

test('onboarding marker completed atomically, first completion preserved', () => {
  assert.match(code, /owner_pin_onboarding_completed_at = COALESCE\(owner_pin_onboarding_completed_at, v_now\)/);
});

test('account never becomes an actor (by_actor / updated_by stay NULL)', () => {
  assert.match(code, /updated_by = NULL/);
  assert.match(code, /VALUES \(v_event, 'owner', NULL,/);
});

test('audit is secret-free: sensitive meta keys rejected, no plaintext column', () => {
  assert.match(code, /AUTH_META_SENSITIVE_KEY/);
  assert.match(code, /'pin_hash'/);
  assert.doesNotMatch(code, /plaintext/i);
});

test('touches no operational data', () => {
  for (const t of ['ordenes', 'orden_estado_logs', 'economia', 'productos', 'service_session']) {
    assert.doesNotMatch(code, new RegExp(`\\b${t}\\b`, 'i'), `must not reference ${t}`);
  }
});

test('single transaction', () => {
  assert.match(code.trim(), /^BEGIN;/);
  assert.match(code.trim(), /COMMIT;\s*$/);
});

test('rollback is guarded and drops only the new function', () => {
  assert.match(rb, /rollback refused/i);
  assert.match(rb, /s2_7d2\.force_rollback/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.auth_account_set_owner_pin_v2/);
  assert.doesNotMatch(rb, /DROP TABLE|DELETE FROM|ALTER TABLE/);
});
