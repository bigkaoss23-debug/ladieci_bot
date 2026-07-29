'use strict';
// Test per migrations/2026-07-29_v3a_access_control_foundation.sql — Access Control V3
// Block V3-A. Eseguire: node tests/v3aFoundationMigration.static.test.js
// STATIC TEXT ONLY — no DB connection, no SQL execution. Verifies the migration/rollback
// files exist, are additive/staging-guarded, and preserve the accepted invariants.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FORWARD = path.join(MIGRATIONS_DIR, '2026-07-29_v3a_access_control_foundation.sql');
const ROLLBACK = path.join(MIGRATIONS_DIR, '2026-07-29_v3a_access_control_foundation.ROLLBACK.sql');

assert('forward migration file exists', fs.existsSync(FORWARD));
assert('rollback file exists', fs.existsSync(ROLLBACK));

const fwd = fs.readFileSync(FORWARD, 'utf8');
const rb = fs.readFileSync(ROLLBACK, 'utf8');

// ── staging sentinel ──────────────────────────────────────────────────────────
assert('forward: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(fwd));
assert('rollback: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(rb));

// ── role vocabulary ────────────────────────────────────────────────────────────
const EXPECTED_ROLES = ['owner', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'legacy_operator'];
const roleChkMatch = fwd.match(/auth_actors_role_chk\s*\n?\s*CHECK \(role IN \(([^)]+)\)\)/);
assert('forward: role CHECK block present', !!roleChkMatch);
if (roleChkMatch) {
  const values = roleChkMatch[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert('forward: role CHECK contains exactly the 7 accepted codes',
    values.length === EXPECTED_ROLES.length && EXPECTED_ROLES.every((r) => values.includes(r)),
    JSON.stringify(values));
  assert('forward: role CHECK does not carry over admin/operator', !values.includes('admin') && !values.includes('operator'));
}

// ── no automatic waiter/cashier conversion ────────────────────────────────────
assert('forward: operator_primary is NOT mapped to cashier', !/operator_primary['"]?\s*AND\s*role\s*=\s*'cashier'/.test(fwd));
assert('forward: operator_backup is NOT mapped to waiter or cashier', !/operator_backup['"]?\s*AND\s*role\s*=\s*'(waiter|cashier)'/.test(fwd));
assert('forward: operator_primary lands on legacy_operator', /operator_primary'\s*AND\s*role\s*=\s*'operator'/.test(fwd) &&
  /role = 'legacy_operator'\s*WHERE actor = 'operator_primary'/.test(fwd));
assert('forward: operator_backup lands on legacy_operator', /role = 'legacy_operator'\s*WHERE actor = 'operator_backup'/.test(fwd));
assert('forward: owner maps directly to owner (unambiguous, no deferral)', /role = 'owner'\s*WHERE actor = 'owner'/.test(fwd));
assert('forward: rider is left unchanged (no UPDATE statement targets it)', !/UPDATE public\.auth_actors SET role[^;]*WHERE actor = 'rider'/.test(fwd));

// ── fingerprint table constraints ─────────────────────────────────────────────
assert('forward: auth_actor_pin_fingerprints table created', /CREATE TABLE IF NOT EXISTS public\.auth_actor_pin_fingerprints/.test(fwd));
assert('forward: fingerprint table has PRIMARY KEY (actor, key_id)', /PRIMARY KEY \(actor, key_id\)/.test(fwd));
assert('forward: fingerprint table has UNIQUE(workspace_id, key_id, fingerprint)', /auth_actor_pin_fp_ws_key_fp_uq[\s\S]*?ON public\.auth_actor_pin_fingerprints \(workspace_id, key_id, fingerprint\)/.test(fwd));
assert('forward: fingerprint table has composite (workspace_id, actor) FK', /FOREIGN KEY \(workspace_id, actor\) REFERENCES public\.auth_actors \(workspace_id, actor\)/.test(fwd));
assert('forward: key_id has a strict format CHECK', /key_id ~ '\^k\[0-9\]\+\$'/.test(fwd));
assert('forward: new non-partial UNIQUE(workspace_id, actor) added for the composite FK to reference', /auth_actors_ws_actor_key UNIQUE \(workspace_id, actor\)/.test(fwd));

// ── RLS / no anonymous access ──────────────────────────────────────────────────
// A real CREATE POLICY statement always starts a line; this repo's own convention
// documents the absence with a "-- ZERO CREATE POLICY" comment, which must NOT be
// mistaken for an actual statement by this check.
assert('forward: no actual CREATE POLICY statement anywhere (default-deny throughout)', !/^CREATE POLICY/m.test(fwd));
for (const table of ['auth_actor_pin_fingerprints', 'access_management_idempotency']) {
  assert(`forward: ${table} has RLS enabled`, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`).test(fwd));
  assert(`forward: ${table} has no anonymous/authenticated grant`, new RegExp(`REVOKE ALL ON public\\.${table} FROM PUBLIC, anon, authenticated`).test(fwd));
  assert(`forward: ${table} grants only service_role`, new RegExp(`GRANT ALL ON public\\.${table} TO service_role`).test(fwd));
}

// ── idempotency table shape (inert, no secrets) ───────────────────────────────
assert('forward: idempotency table has no raw sid column, only by_sid_hash', /by_sid_hash\s+text NOT NULL/.test(fwd) && !/\bsid\s+text/.test(fwd));
assert('forward: idempotency table has no token/proof column', !/stepupproof|step_up_proof|\btoken\b/i.test(fwd.match(/CREATE TABLE IF NOT EXISTS public\.access_management_idempotency[\s\S]*?\);/)[0]));

// ── audit event CHECK — widened, not replaced ─────────────────────────────────
const PRE_EXISTING_EVENTS = ['login_ok', 'login_fail', 'locked', 'pin_set', 'pin_change', 'revoke', 'bootstrap', 'recovery', 'actor_disabled', 'actor_enabled', 'actor_unlocked'];
const NEW_V3_EVENTS = ['user_created', 'user_renamed', 'role_changed', 'user_deactivated', 'user_reactivated', 'access_denied', 'credential_cleared', 'fingerprint_upgraded', 'session_invalidated', 'rate_limit_triggered', 'migration_login_used'];
assert('forward: auth_audit_event_chk preserves every pre-existing (verified live) event',
  PRE_EXISTING_EVENTS.every((e) => fwd.includes(`'${e}'`)));
assert('forward: auth_audit_event_chk adds every new V3 event',
  NEW_V3_EVENTS.every((e) => fwd.includes(`'${e}'`)));

// ── rollback behavior ──────────────────────────────────────────────────────────
assert('rollback: refuses if any row carries a V3-C-assigned role', /role IN \('cashier','waiter','kitchen','shift_manager'\)/.test(rb) && /rollback refused.*V3-C-assigned role/i.test(rb));
assert('rollback: refuses if any audit row uses a V3-only event', /rollback refused.*V3-only event/i.test(rb));
assert('rollback: refuses if fingerprint rows exist (no silent data loss)', /rollback refused.*auth_actor_pin_fingerprints/i.test(rb));
assert('rollback: drops the two new tables', /DROP TABLE IF EXISTS public\.access_management_idempotency/.test(rb) && /DROP TABLE IF EXISTS public\.auth_actor_pin_fingerprints/.test(rb));
assert('rollback: narrows auth_audit_event_chk back to the pre-existing 11', PRE_EXISTING_EVENTS.every((e) => rb.includes(`'${e}'`)) && !NEW_V3_EVENTS.some((e) => rb.match(new RegExp(`CHECK \\(event IN \\([^)]*'${e}'`))));
assert('rollback: reverts role data before narrowing the CHECK', rb.indexOf("role = 'admin'") < rb.lastIndexOf("CHECK (role IN ('admin','operator','rider'))"));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
