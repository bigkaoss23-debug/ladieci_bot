'use strict';
// S2-7D static migration tests. NON-EXECUTING: asserts structure/safety of the
// workspace-owner + admin-PIN migration by inspecting SQL text. No DB, no apply.
// Run: node tests/workspaceOwnerMigration.static.test.js
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const MIG = path.join(__dirname, '..', 'migrations', '2026-07-24_workspace_owner_pin.sql');
const RB = path.join(__dirname, '..', 'migrations', '2026-07-24_workspace_owner_pin.ROLLBACK.sql');
const sql = fs.readFileSync(MIG, 'utf8');
const rb = fs.readFileSync(RB, 'utf8');
// comment-stripped view so prose never satisfies a structural assertion
const code = sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

test('staging sentinel guard present', () => {
  assert.match(code, /schema_migrations WHERE version='20260710075612'/);
});

test('additive nullable workspace_id on auth_actors, no NOT NULL', () => {
  assert.match(code, /ALTER TABLE public\.auth_actors\s+ADD COLUMN IF NOT EXISTS workspace_id uuid/i);
  assert.doesNotMatch(code, /auth_actors[\s\S]*workspace_id uuid[^;]*NOT NULL/i);
  assert.match(code, /REFERENCES public\.workspaces\(id\)/);
});

test('adds workspaces.owner_pin_onboarding_completed_at onboarding marker', () => {
  assert.match(code, /ALTER TABLE public\.workspaces\s+ADD COLUMN IF NOT EXISTS owner_pin_onboarding_completed_at timestamptz/i);
});

test('NO migration-time actor backfill (0 workspaces live) — actors touched only inside the claim fn', () => {
  // The only UPDATE ... auth_actors SET workspace_id lives inside the claim function body,
  // after a workspace row is created/retrieved — never as top-level migration DDL.
  const claimBody = code.slice(code.indexOf('auth_account_claim_workspace'), code.indexOf('auth_account_set_owner_pin'));
  assert.match(claimBody, /UPDATE public\.auth_actors SET workspace_id = v_ws\.id WHERE workspace_id IS NULL/);
  // No auth_actors UPDATE outside a function body (i.e., before the first CREATE FUNCTION).
  const ddlHead = code.slice(0, code.indexOf('CREATE OR REPLACE FUNCTION'));
  assert.doesNotMatch(ddlHead, /UPDATE public\.auth_actors/);
});

test('creates exactly the two account RPCs', () => {
  const fns = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(fns, ['auth_account_claim_workspace', 'auth_account_set_owner_pin']);
});

test('owner-pin RPC re-verifies active-owner membership under lock', () => {
  assert.match(code, /FROM public\.workspaces WHERE id = p_workspace_id FOR UPDATE/);
  assert.match(code, /workspace_memberships[\s\S]*role = 'workspace_owner' AND status = 'active'/);
  assert.match(code, /NOT_WORKSPACE_OWNER/);
  assert.match(code, /actor = 'owner' AND workspace_id = p_workspace_id FOR UPDATE/);
});

test('owner-pin RPC never writes account into auth_actors (by_actor NULL, updated_by NULL)', () => {
  assert.match(code, /updated_by = NULL/);
  assert.match(code, /INSERT INTO public\.auth_audit\(event, target_actor, by_actor, ip_hash, meta\)\s*\n\s*VALUES \(v_event, 'owner', NULL,/);
});

test('owner-pin RPC bumps session_version and requires scrypt hash', () => {
  assert.match(code, /session_version = session_version \+ 1/);
  assert.match(code, /left\(p_hash, 7\) <> 'scrypt\$'/);
  assert.doesNotMatch(code, /pin_hash = NULL/); // never nulls the PIN
});

test('owner-pin RPC marks onboarding complete ATOMICALLY with rotation, preserving first completion', () => {
  const pinBody = code.slice(code.indexOf('auth_account_set_owner_pin'));
  // rotation UPDATE and the marker UPDATE are both in the same function body (one txn)
  assert.match(pinBody, /UPDATE public\.auth_actors[\s\S]*pin_hash = p_hash/);
  assert.match(pinBody, /UPDATE public\.workspaces\s*\n\s*SET owner_pin_onboarding_completed_at = COALESCE\(owner_pin_onboarding_completed_at, v_now\)/);
});

test('claim RPC is single-owner safe and idempotent', () => {
  assert.match(code, /WORKSPACE_ALREADY_OWNED/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /ON CONFLICT \(workspace_id, user_id\)/);
});

test('claim RPC associates the four actors additively, backfilling only unassigned, and fails closed on conflict', () => {
  assert.match(code, /UPDATE public\.auth_actors SET workspace_id = v_ws\.id WHERE workspace_id IS NULL/);
  assert.match(code, /ACTOR_WORKSPACE_CONFLICT/);
  assert.match(code, /workspace_id IS NOT NULL AND workspace_id <> v_ws\.id/);
});

test('claim RPC returns onboarding state, NOT pin_hash presence', () => {
  assert.match(code, /'owner_pin_onboarding_completed'/);
  assert.doesNotMatch(code, /owner_actor_has_pin/);
});

test('meta sensitive-key guard present in owner-pin RPC', () => {
  assert.match(code, /AUTH_META_SENSITIVE_KEY/);
  assert.match(code, /'pin_hash'/);
});

test('grants: RPCs revoked from anon/authenticated, granted only to service_role', () => {
  assert.match(code, /REVOKE ALL ON FUNCTION public\.auth_account_claim_workspace[^;]*FROM PUBLIC, anon, authenticated/);
  assert.match(code, /REVOKE ALL ON FUNCTION public\.auth_account_set_owner_pin[^;]*FROM PUBLIC, anon, authenticated/);
  assert.match(code, /GRANT EXECUTE ON FUNCTION public\.auth_account_set_owner_pin[^;]*TO service_role/);
  assert.doesNotMatch(code, /GRANT EXECUTE[^;]*auth_account_[^;]*TO (anon|authenticated)/);
});

test('does NOT touch operational tables (orders/ledger/menu/service sessions/logs)', () => {
  for (const t of ['ordenes', 'orden_estado_logs', 'economia', 'productos', 'service_session', 'menu']) {
    assert.doesNotMatch(code, new RegExp(`\\b${t}\\b`, 'i'), `must not reference ${t}`);
  }
});

test('rollback drops both RPCs + columns/indexes, keeps data', () => {
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.auth_account_set_owner_pin/);
  assert.match(rb, /DROP FUNCTION IF EXISTS public\.auth_account_claim_workspace/);
  assert.match(rb, /ALTER TABLE public\.auth_actors DROP COLUMN IF EXISTS workspace_id/);
  assert.match(rb, /ALTER TABLE public\.workspaces DROP COLUMN IF EXISTS owner_pin_onboarding_completed_at/);
  assert.doesNotMatch(rb, /DELETE FROM public\.workspaces/);
  assert.doesNotMatch(rb, /DROP TABLE/);
});

test('rollback refuses destructive reversal after real claim/onboarding data unless forced', () => {
  assert.match(rb, /S2-7D rollback refused/);
  assert.match(rb, /s2_7d\.force_rollback/);
  assert.match(rb, /workspace_id IS NOT NULL/);
  assert.match(rb, /owner_pin_onboarding_completed_at IS NOT NULL/);
});

test('wrapped in a single transaction', () => {
  assert.match(code.trim(), /^BEGIN;/);
  assert.match(code.trim(), /COMMIT;\s*$/);
});
