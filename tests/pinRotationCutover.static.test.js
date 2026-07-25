'use strict';
// S2-7D2 — static review of the two-step cutover. NON-EXECUTING: inspects SQL text and
// backend source. No DB, no apply.
// Run: node tests/pinRotationCutover.static.test.js
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const A = read('migrations/2026-07-25_canonical_pin_rotation.sql');
const A_RB = read('migrations/2026-07-25_canonical_pin_rotation.ROLLBACK.sql');
const B = read('migrations/2026-07-26_disable_legacy_pin_rotation.sql');
const B_RB = read('migrations/2026-07-26_disable_legacy_pin_rotation.ROLLBACK.sql');
const a = strip(A); const b = strip(B);

// ── step A: the canonical RPC ──────────────────────────────────────────────
test('A: staging sentinel + S2-7D predecessor guards', () => {
  assert.match(a, /schema_migrations WHERE version='20260710075612'/);
  assert.match(a, /column_name='workspace_id'/);
  assert.match(a, /owner_pin_onboarding_completed_at/);
});

test('A: creates exactly one function — the GENERIC rotation RPC', () => {
  const fns = [...a.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(fns, ['auth_set_actor_pin_v2']);
});

test('A: privileged hardening — SECURITY INVOKER, fixed search_path, service_role only', () => {
  assert.match(a, /SECURITY INVOKER/);
  assert.match(a, /SET search_path = public, pg_temp/);
  assert.match(a, /REVOKE ALL ON FUNCTION public\.auth_set_actor_pin_v2[^;]*FROM PUBLIC, anon, authenticated/);
  assert.match(a, /GRANT EXECUTE ON FUNCTION public\.auth_set_actor_pin_v2[^;]*TO service_role/);
  assert.doesNotMatch(a, /GRANT EXECUTE[^;]*auth_set_actor_pin_v2[^;]*TO (anon|authenticated)/);
});

test('A: the WORKSPACE row lock is the serialisation point, then all actors in order', () => {
  assert.match(a, /FROM public\.workspaces WHERE id = v_ws_id FOR UPDATE/);
  assert.match(a, /FROM public\.auth_actors WHERE workspace_id = v_ws_id ORDER BY actor FOR UPDATE/);
});

test('A: handles EVERY canonical actor, not just owner', () => {
  assert.match(a, /p_target_actor NOT IN \('owner','operator_primary','operator_backup','rider'\)/);
});

test('A: both caller kinds authorized distinctly', () => {
  assert.match(a, /p_caller_kind NOT IN \('account_owner','operational_admin'\)/);
  assert.match(a, /role = 'workspace_owner' AND status = 'active'/);   // account path
  assert.match(a, /NOT_WORKSPACE_OWNER/);
  assert.match(a, /AUTH_ACCOUNT_TARGET_FORBIDDEN/);                    // account path: owner only
  assert.match(a, /v_by\.role <> 'admin'/);                            // operational path
  assert.match(a, /AUTH_INITIATOR_OTHER_WORKSPACE/);
  assert.match(a, /'CHANGE_OWNER_PIN'/);                               // preserved B6A phrase
});

test('A: snapshot re-validated under lock; drift aborts with serialization_failure', () => {
  assert.match(a, /AUTH_ROTATION_STALE/);
  assert.match(a, /ERRCODE='40001'/);
  assert.match(a, /IS DISTINCT FROM v_other\.active/);
  assert.match(a, /IS DISTINCT FROM v_other\.pin_hash/);
  assert.match(a, /v_seen_count <> v_others/);
});

test('A: rotates only the requested actor, never creates one', () => {
  const updates = [...a.matchAll(/UPDATE public\.auth_actors/g)];
  assert.equal(updates.length, 1);
  assert.match(a, /WHERE actor = p_target_actor/);
  assert.doesNotMatch(a, /INSERT INTO public\.auth_actors/);
});

test('A: session-version / lock-reset / audit contract preserved', () => {
  assert.match(a, /session_version = session_version \+ 1/);
  assert.match(a, /failed_count = 0, locked_until = NULL/);
  assert.match(a, /INSERT INTO public\.auth_audit/);
  assert.doesNotMatch(a, /pin_hash = NULL/);
});

test('A: onboarding marker only for owner via the account path', () => {
  assert.match(a, /IF v_onboarding THEN[\s\S]*owner_pin_onboarding_completed_at = COALESCE/);
  assert.match(a, /v_onboarding := true;/);
});

test('A: the account never becomes an actor', () => {
  assert.match(a, /CASE WHEN p_caller_kind = 'operational_admin' THEN p_by_actor ELSE NULL END/);
});

test('A: no plaintext, sensitive audit keys rejected, no operational tables touched', () => {
  assert.match(a, /AUTH_META_SENSITIVE_KEY/);
  assert.match(a, /left\(p_hash, 7\) <> 'scrypt\$'/);
  for (const t of ['ordenes', 'orden_estado_logs', 'economia', 'productos']) {
    assert.doesNotMatch(a, new RegExp(`\\b${t}\\b`, 'i'));
  }
});

// ── step B: legacy closure ─────────────────────────────────────────────────
test('B: refuses to run before the canonical replacement exists', () => {
  assert.match(b, /proname = 'auth_set_actor_pin_v2'/);
  assert.match(b, /S2-7D2B refused/);
});

test('B: legacy body replaced by a fail-closed error AND execution revoked', () => {
  assert.match(b, /CREATE OR REPLACE FUNCTION public\.auth_admin_set_actor_pin/);
  assert.match(b, /AUTH_LEGACY_PIN_ROTATION_DISABLED/);
  assert.match(b, /REVOKE ALL ON FUNCTION public\.auth_admin_set_actor_pin[^;]*FROM PUBLIC, anon, authenticated, service_role/);
});

test('B: the deprecated body writes nothing', () => {
  const body = b.slice(b.indexOf('CREATE OR REPLACE FUNCTION public.auth_admin_set_actor_pin'));
  assert.doesNotMatch(body, /UPDATE |INSERT |DELETE /);
});

test('B: closes ONLY the PIN mutation path — login and the other admin RPCs untouched', () => {
  for (const fn of ['auth_admin_revoke_actor_sessions', 'auth_admin_set_actor_active',
                    'auth_admin_unlock_actor', 'auth_login', 'auth_actors_login']) {
    assert.doesNotMatch(b, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}`));
  }
  assert.doesNotMatch(b, /DROP FUNCTION/);
});

// ── rollbacks ──────────────────────────────────────────────────────────────
test('rollback A: guarded, and refuses if step B already landed', () => {
  assert.match(A_RB, /s2_7d2a\.force_rollback/);
  assert.match(A_RB, /rollback refused/i);
  assert.match(A_RB, /AUTH_LEGACY_PIN_ROTATION_DISABLED/);   // detects step B
  assert.match(A_RB, /DROP FUNCTION IF EXISTS public\.auth_set_actor_pin_v2/);
  assert.doesNotMatch(A_RB, /DROP TABLE|DELETE FROM|ALTER TABLE/);
});

test('rollback B: guarded and states that it removes the invariant', () => {
  assert.match(B_RB, /s2_7d2b\.force_rollback/);
  assert.match(B_RB, /removes the PIN-uniqueness invariant/);
  assert.doesNotMatch(B_RB, /DROP TABLE|DELETE FROM/);
});

test('both migrations are single transactions with the naming convention', () => {
  for (const sql of [A, B, A_RB, B_RB]) {
    assert.match(sql.trim(), /^--[\s\S]*BEGIN;/);
    assert.match(sql.trim(), /COMMIT;\s*$/);
  }
});

// ── backend cutover: no call site may reach the legacy RPC ─────────────────
function sourceFiles(dir, acc = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') sourceFiles(rel, acc); }
    else if (e.name.endsWith('.js')) acc.push(rel);
  }
  return acc;
}
const SRC = [...sourceFiles('src'), 'index.js'];
const codeOf = (f) => read(f).split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

test('cutover: NO backend call site references the legacy RPC', () => {
  const hits = SRC.filter((f) => codeOf(f).includes('auth_admin_set_actor_pin'));
  assert.deepEqual(hits, [], `legacy RPC still referenced in: ${hits.join(', ')}`);
});

test('cutover: the only PIN-rotation RPC invoked is auth_set_actor_pin_v2', () => {
  const callers = SRC.filter((f) => codeOf(f).includes('auth_set_actor_pin_v2'));
  assert.deepEqual(callers, ['src/auth/pinRotationDao.js'], 'exactly one DAO may call it');
});

test('cutover: both mutation services delegate to the canonical rotation', () => {
  assert.match(codeOf('src/account/workspaceOwnerService.js'), /rotation\.rotate\(/);
  assert.match(codeOf('src/auth/adminAccessService.js'), /rotation\.rotate\(/);
  // and neither hashes/writes a PIN on its own any more
  assert.doesNotMatch(codeOf('src/account/workspaceOwnerService.js'), /hashPin\(/);
  assert.doesNotMatch(codeOf('src/auth/adminAccessService.js'), /dao\.adminSetActorPin/);
});

test('cutover: the dead legacy wrappers are gone from the DAOs', () => {
  assert.doesNotMatch(codeOf('src/auth/adminAccessDao.js'), /adminSetActorPin/);
  assert.doesNotMatch(codeOf('src/account/workspaceOwnerDao.js'), /setOwnerPin/);
});

test('cutover: index.js builds ONE rotation service and injects it into both paths', () => {
  const idx = codeOf('index.js');
  assert.match(idx, /createPinRotation\(/);
  assert.match(idx, /rotation: pinRotation/);
});
