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

// ── step B: COMPLETE writer cutover (six functions) ────────────────────────
const DISABLED = Object.freeze([
  ['auth_admin_set_actor_pin',     'text, text, text, text, text, jsonb, text',      'AUTH_LEGACY_PIN_ROTATION_DISABLED'],
  ['auth_account_set_owner_pin',   'uuid, uuid, text, text, jsonb',                  'AUTH_ACCOUNT_OWNER_PIN_V1_DISABLED'],
  ['auth_set_pin_hash',            'text, text, text, jsonb',                        'AUTH_DIRECT_PIN_HASH_WRITE_DISABLED'],
  ['auth_set_active',              'text, boolean, text, jsonb',                     'AUTH_DIRECT_ACTOR_ACTIVE_WRITE_DISABLED'],
  ['auth_admin_set_actor_active',  'text, text, text, boolean, text, jsonb',         'AUTH_ADMIN_ACTOR_ACTIVE_DISABLED'],
  ['auth_consume_recovery_window', 'text, text, text, text, text, text, jsonb',      'AUTH_OPERATIONAL_RECOVERY_DISABLED'],
]);

test('B: all six writers are replaced by fail-closed stubs with their own error', () => {
  for (const [fn, , marker] of DISABLED) {
    assert.match(b, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `${fn} not replaced`);
    assert.match(b, new RegExp(`RAISE EXCEPTION '${marker}'`), `${fn} missing its marker`);
  }
});

test('B: every stub writes nothing and returns nothing successfully', () => {
  const bodies = b.split('CREATE OR REPLACE FUNCTION public.').slice(1);
  assert.equal(bodies.length, DISABLED.length, 'exactly six functions replaced');
  for (const body of bodies) {
    const fnBody = body.slice(body.indexOf('AS $fn$'), body.indexOf('$fn$;') + 5);
    assert.doesNotMatch(fnBody, /UPDATE |INSERT |DELETE /, 'stub must not write');
    assert.doesNotMatch(fnBody, /RETURN /, 'stub must not return successfully');
    assert.match(fnBody, /RAISE EXCEPTION/);
  }
});

test('B: every stub keeps SECURITY INVOKER, fixed search_path and the jsonb return type', () => {
  const bodies = b.split('CREATE OR REPLACE FUNCTION public.').slice(1);
  for (const body of bodies) {
    const head = body.slice(0, body.indexOf('AS $fn$'));
    assert.match(head, /RETURNS jsonb/);
    assert.match(head, /SECURITY INVOKER/);
    assert.match(head, /SET search_path = public, pg_temp/);
  }
});

test('B: stub errors are bare constants — no value is ever interpolated', () => {
  for (const [, , marker] of DISABLED) {
    const line = b.split('\n').find((l) => l.includes(`RAISE EXCEPTION '${marker}'`));
    assert.ok(line, marker);
    // the whole message is the approved constant: no % placeholder, no parameter reference,
    // no concatenation — so no PIN, hash, token or identifier can reach the client.
    assert.match(line.trim(), new RegExp(`^RAISE EXCEPTION '${marker}' USING ERRCODE = 'P0001';$`),
      `${marker} must be raised as a bare constant`);
    assert.doesNotMatch(line, /%|\|\||p_[a-z_]+/, `${marker} interpolates a value`);
  }
});

test('B: EXECUTE revoked from PUBLIC, anon, authenticated AND service_role for all six', () => {
  for (const [fn, args] of DISABLED) {
    const re = new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(${args.replace(/[()]/g, '')}\\)\\s*\\n?\\s*FROM PUBLIC, anon, authenticated, service_role`);
    assert.match(b, re, `${fn} revoke missing or incomplete`);
  }
});

test('B: preconditions fail closed — exact overloads, no IF EXISTS skipping', () => {
  // Signatures are compared as an argument TYPE vector. pg_get_function_identity_arguments()
  // also renders parameter NAMES ('p_hash text, …'), which never equals the type-only
  // expectation table and would fail this migration closed on a correct database.
  assert.match(b, /oidvectortypes\(p\.proargtypes\)/);
  assert.doesNotMatch(b, /pg_get_function_identity_arguments\(p\.oid\)/);
  assert.match(b, /expected exactly ONE overload/);
  assert.match(b, /signature mismatch/);
  // the canonical writer must exist AND be executable before anything is disabled
  assert.match(b, /auth_set_actor_pin_v2\(%\) not found exactly once/);
  assert.match(b, /service_role cannot EXECUTE auth_set_actor_pin_v2/);
  // the six are never disabled behind an IF EXISTS guard
  assert.doesNotMatch(b, /DROP FUNCTION IF EXISTS/);
});

test('B: expects every one of the six exact overloads confirmed by the live probe', () => {
  for (const [fn, args] of DISABLED) {
    assert.match(b, new RegExp(`'${fn}',\\s*'${args}'`), `${fn} missing from the precondition table`);
  }
});

test('B: post-condition proves one writer in, zero disabled writers executable', () => {
  assert.match(b, /disabled writer\(s\) still executable by service_role/);
  assert.match(b, /the canonical writer is not executable by service_role/);
});

test('B: operational login and the non-PIN admin RPCs are NOT touched', () => {
  for (const fn of ['auth_record_failed_attempt', 'auth_reset_failed_attempts',
                    'auth_bump_session_version', 'auth_admin_revoke_actor_sessions',
                    'auth_admin_unlock_actor', 'auth_open_recovery_window']) {
    assert.doesNotMatch(b, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`), `${fn} must be untouched`);
    assert.doesNotMatch(b, new RegExp(`REVOKE[^;]*public\\.${fn}\\(`), `${fn} grant must be untouched`);
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

test('rollback B: guarded, emergency-only, and refuses while any stub remains', () => {
  assert.match(B_RB, /EMERGENCY ONLY/);
  assert.match(B_RB, /s2_7d2b\.force_rollback/);
  assert.match(B_RB, /s2_7d2b\.backend_reverted/);           // backend must be reverted first
  assert.match(B_RB, /REMOVES the PIN-uniqueness invariant/);
  assert.match(B_RB, /ACTIVE DUPLICATE PINs WITHOUT ANY ROTATION/);
  assert.match(B_RB, /fail-closed stub\(s\) still installed/);
  assert.doesNotMatch(B_RB, /DROP TABLE|DELETE FROM/);
});

test('rollback B: never recreates bodies — it points at the source migrations', () => {
  assert.doesNotMatch(B_RB, /CREATE OR REPLACE FUNCTION/);
  for (const m of ['2026-07-15_auth_admin_access_management.sql', '2026-07-24_workspace_owner_pin.sql',
                   '2026-07-13_auth_rpc.sql', '2026-07-13_auth_active_events.sql',
                   '2026-07-14_auth_recovery_windows.sql']) {
    assert.ok(B_RB.includes(m), `rollback must reference ${m}`);
  }
});

test('rollback B: restores grants explicitly for each of the six', () => {
  for (const [fn] of DISABLED) {
    assert.match(B_RB, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(`), `${fn} grant missing`);
  }
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

test('cutover: NO executable backend source references ANY of the six disabled writers', () => {
  for (const [fn] of DISABLED) {
    const hits = SRC.filter((f) => codeOf(f).includes(fn));
    assert.deepEqual(hits, [], `${fn} still referenced in: ${hits.join(', ')}`);
  }
});

test('cutover: no runtime route promises activation/deactivation or operational recovery', () => {
  const idx = codeOf('index.js');
  for (const m of ['setActorActive', 'unlockActor', 'revokeActorSessions',
                   'consumeRecoveryWindow', 'openRecoveryWindow']) {
    assert.doesNotMatch(idx, new RegExp(`adminAccessService\\.${m}|recovery[A-Za-z]*\\.${m}`),
      `index.js must not expose ${m}`);
  }
  // and the recovery modules are not wired at all
  const wired = SRC.filter((f) => /require\([^)]*(recoveryDao|bootstrapRecovery)/.test(codeOf(f)));
  assert.deepEqual(wired, [], `recovery modules must stay unwired: ${wired.join(', ')}`);
});

test('cutover: no direct REST write targets auth_actors.pin_hash or active', () => {
  for (const f of SRC) {
    const code = codeOf(f);
    // any non-GET sbRest/sbFetch against auth_actors would bypass the canonical RPC
    const bad = /(sbRest|sbFetch)\(\s*['"](POST|PATCH|PUT|DELETE)['"]\s*,\s*['"]auth_actors/.test(code)
      || /sbUpdate\(\s*['"]auth_actors/.test(code) || /sbUpsert\(\s*['"]auth_actors/.test(code);
    assert.equal(bad, false, `${f} writes auth_actors directly over REST`);
  }
});

test('cutover: workspace claim remains the only runtime writer of workspace_id', () => {
  const callers = SRC.filter((f) => codeOf(f).includes('auth_account_claim_workspace'));
  assert.deepEqual(callers, ['src/account/workspaceOwnerDao.js']);
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
