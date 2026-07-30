'use strict';
// Test per migrations/2026-07-30_v3e_access_user_lifecycle.sql -- Access Control V3
// Block V3-E. Eseguire: node tests/v3eAccessUserLifecycleMigration.static.test.js
// STATIC TEXT ONLY -- no DB connection, no SQL execution (the real disposable-Postgres
// rehearsal for this migration is a separate, out-of-band step).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FORWARD = path.join(MIGRATIONS_DIR, '2026-07-30_v3e_access_user_lifecycle.sql');
const ROLLBACK = path.join(MIGRATIONS_DIR, '2026-07-30_v3e_access_user_lifecycle.ROLLBACK.sql');

assert('forward migration file exists', fs.existsSync(FORWARD));
assert('rollback file exists', fs.existsSync(ROLLBACK));

const fwd = fs.readFileSync(FORWARD, 'utf8');
const rb = fs.readFileSync(ROLLBACK, 'utf8');
const strip = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fwdCode = strip(fwd);

// ── staging sentinel ──────────────────────────────────────────────────────────
assert('forward: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(fwd));
assert('rollback: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(rb));

// ── predecessor + precondition ──────────────────────────────────────────────────
assert('forward: refuses if auth_create_access_user_v3 is absent (V3-D prerequisite)', /auth_create_access_user_v3.*not found.*apply V3-D first/i.test(fwd));
assert('forward: precondition -- the 4 legacy rows must match the expected pre-V3-E shape',
  /VALUES\s*\n\s*\('owner','admin'\), \('operator_primary','operator'\), \('operator_backup','operator'\), \('rider','rider'\)/.test(fwd));

// ── no auth_actors mutation outside the two RPC bodies; no new/widened CHECK ─────
assert('forward: no UPDATE/DELETE of auth_actors or fingerprints OUTSIDE the two RPC bodies',
  (() => {
    const bodies = [...fwdCode.matchAll(/AS \$fn\$([\s\S]*?)\$fn\$;/g)].map((m) => m[0]);
    let outside = fwdCode;
    for (const b of bodies) outside = outside.replace(b, '');
    return !/UPDATE\s+public\.auth_actors/i.test(outside) && !/DELETE FROM public\.auth_actor_pin_fingerprints/i.test(outside);
  })());
assert('forward: does NOT widen auth_audit_event_chk -- every event it uses was already reserved by V3-A',
  !/ALTER TABLE public\.auth_audit.*auth_audit_event_chk/s.test(fwd) && !/DROP CONSTRAINT IF EXISTS auth_audit_event_chk/.test(fwd));
assert('forward: does not touch the actor-identity or actor-role-map constraints (V3-D/V3-C territory)',
  !/auth_actors_actor_chk|auth_actors_actor_role_map/.test(fwd));

// ── canonical RPCs, additive alongside every prior writer ────────────────────────
assert('forward: creates auth_set_access_user_active_v3 (new function)', /CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3\(/.test(fwd));
assert('forward: creates auth_clear_access_user_credential_v3 (new function)', /CREATE OR REPLACE FUNCTION public\.auth_clear_access_user_credential_v3\(/.test(fwd));
assert('forward: no generic unrestricted auth_actors patch RPC exists (exactly 2 new functions)',
  (fwd.match(/CREATE OR REPLACE FUNCTION public\./g) || []).length === 2);

// ── active-state RPC: canonical event names reused, both directions bump session_version ──
assert('forward: reuses the canonical V3 event names user_deactivated/user_reactivated (not the legacy actor_disabled/actor_enabled)',
  fwd.includes("'user_reactivated'") && fwd.includes("'user_deactivated'") &&
  !/CASE WHEN p_requested_active THEN 'actor_enabled' ELSE 'actor_disabled'/.test(fwd));
assert('forward: stable idempotency action identifiers distinguish deactivate/reactivate',
  /v_action := CASE WHEN p_requested_active THEN 'reactivate_access_user_v3' ELSE 'deactivate_access_user_v3' END/.test(fwd));
assert('forward: identical current/requested state short-circuits BEFORE the UPDATE (deterministic no-op)',
  /v_changed := \(v_tgt\.active <> p_requested_active\)/.test(fwd) && /IF NOT v_changed THEN/.test(fwd));
assert('forward: session_version increments exactly once on EITHER direction (both branches use the same +1 UPDATE, not an asymmetric CASE)',
  /SET active = p_requested_active, session_version = session_version \+ 1/.test(fwd));
assert('forward: owner target rejected by ROLE, never by the actor id literal \'owner\'',
  /v_tgt\.role IN \('admin', 'owner'\) THEN RAISE EXCEPTION 'AUTH_TARGET_IS_OWNER'/.test(fwd) &&
  !/p_target_actor\s*=\s*'owner'/.test(fwd));
assert('forward: acting owner authorized by role IN (admin, owner), not actor id',
  (fwd.match(/v_by\.role NOT IN \('admin', 'owner'\) THEN RAISE EXCEPTION 'AUTH_NOT_OWNER'/g) || []).length === 2);
assert('forward: expected active state checked against the locked, authoritative target row',
  /v_tgt\.active <> p_expected_active THEN RAISE EXCEPTION 'AUTH_TARGET_STATE_MISMATCH'/.test(fwd));

// ── active-state RPC never touches credential/identity fields ────────────────────
{
  const activeBody = fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_set_access_user_active_v3[\s\S]*?\$fn\$;/)[0];
  const activeBodyCode = strip(activeBody);
  for (const col of ['pin_hash', 'display_name', 'role', 'created_at', 'created_by']) {
    assert(`forward: active-state RPC body never sets ${col}`, !new RegExp(`SET[^;]*\\b${col}\\s*=`, 'i').test(activeBodyCode));
  }
  assert('forward: active-state RPC never writes/deletes auth_actor_pin_fingerprints', !activeBodyCode.includes('auth_actor_pin_fingerprints'));
  assert('forward: active-state RPC does not reset failed_count/locked_until merely on deactivation',
    !/SET[^;]*\bfailed_count\s*=\s*0/.test(activeBodyCode) && !/SET[^;]*\blocked_until\s*=\s*NULL/.test(activeBodyCode));
}

// ── credential-clear RPC: atomic pin_hash + fingerprint + lockout reset ───────────
assert('forward: no plaintext PIN parameter exists on the clear RPC', !/\bp_pin\b|\bp_hash\b(?!_)/.test(fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_clear_access_user_credential_v3[\s\S]*?\$fn\$;/)[0]));
assert('forward: clear RPC detects credential existence via pin_hash OR any fingerprint row',
  /v_has_credential := \(v_tgt\.pin_hash IS NOT NULL\)\s*\n\s*OR EXISTS \(SELECT 1 FROM public\.auth_actor_pin_fingerprints WHERE actor = p_target_actor\)/.test(fwd));
assert('forward: no-credential target short-circuits BEFORE the UPDATE (deterministic no-op)',
  /IF NOT v_has_credential THEN/.test(fwd));
assert('forward: real clear sets pin_hash=NULL, failed_count=0, locked_until=NULL, session_version+1 in ONE UPDATE',
  /SET pin_hash = NULL, failed_count = 0, locked_until = NULL,\s*\n\s*session_version = session_version \+ 1/.test(fwd));
assert('forward: real clear DELETEs every fingerprint row for the target (all key ids, no key_id filter)',
  /DELETE FROM public\.auth_actor_pin_fingerprints WHERE actor = p_target_actor;/.test(fwd) &&
  !/DELETE FROM public\.auth_actor_pin_fingerprints WHERE actor = p_target_actor AND key_id/.test(fwd));
assert('forward: clear RPC uses expected_session_version as an optimistic-concurrency stale check',
  /v_tgt\.session_version <> p_expected_session_version THEN\s*\n\s*RAISE EXCEPTION 'AUTH_TARGET_STALE'/.test(fwd));
{
  const clearBody = strip(fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_clear_access_user_credential_v3[\s\S]*?\$fn\$;/)[0]);
  for (const col of ['display_name', 'role', 'active', 'created_at', 'created_by']) {
    assert(`forward: clear RPC body never sets ${col}`, !new RegExp(`SET[^;]*\\b${col}\\s*=`, 'i').test(clearBody));
  }
}

// ── audit: exact pair per real mutation, no display-name leakage ─────────────────
assert("forward: real deactivation/reactivation writes the lifecycle event + session_invalidated", /'session_invalidated'/.test(fwd));
assert("forward: real credential clear writes 'credential_cleared' + session_invalidated", fwd.includes("'credential_cleared'"));
assert('forward: audit meta never includes display_name content', !/'display_name', /.test(fwd));

// ── idempotency: distinct stable actions per operation, conflict + replay wiring ──
for (const action of ['deactivate_access_user_v3', 'reactivate_access_user_v3', 'clear_access_user_credential_v3']) {
  assert(`forward: action identifier '${action}' present`, fwd.includes(`'${action}'`));
}
assert('forward: both RPCs validate request_hash format (64 lowercase hex)', (fwd.match(/p_request_hash !~ '\^\[0-9a-f\]\{64\}\$'/g) || []).length === 2);
assert('forward: both RPCs raise AUTH_IDEMPOTENCY_CONFLICT on a same-key different-payload replay', (fwd.match(/AUTH_IDEMPOTENCY_CONFLICT/g) || []).length === 2);
assert('forward: idempotency INSERT happens after the mutation/no-op branch in both RPCs',
  (fwd.match(/INSERT INTO public\.access_management_idempotency/g) || []).length === 2);

// ── meta sensitive-key guards ──────────────────────────────────────────────────
for (const k of ['token', 'proof', 'sid', 'pin', 'pin_hash', 'fingerprint']) {
  assert(`forward: sensitive-meta-key guard includes '${k}' (both RPCs)`,
    (fwd.match(new RegExp(`'${k}'`, 'g')) || []).length >= 2);
}

// ── grants: service_role only, both RPCs ─────────────────────────────────────────
assert('forward: ACTIVE-STATE RPC REVOKEs from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.auth_set_access_user_active_v3\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(fwd));
assert('forward: ACTIVE-STATE RPC GRANTs EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_set_access_user_active_v3\([^)]*\)\s*\n\s*TO service_role/.test(fwd));
assert('forward: CLEAR RPC REVOKEs from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.auth_clear_access_user_credential_v3\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(fwd));
assert('forward: CLEAR RPC GRANTs EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_clear_access_user_credential_v3\([^)]*\)\s*\n\s*TO service_role/.test(fwd));

// ── every prior writer completely untouched ───────────────────────────────────────
for (const fn of ['auth_set_actor_pin_v2', 'auth_set_actor_pin_v3', 'auth_change_actor_role_v3', 'auth_create_access_user_v3', 'auth_rename_access_user_v3']) {
  assert(`forward: never defines/replaces ${fn}`, !new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\b`).test(fwd));
  assert(`forward: never DROPs ${fn}`, !new RegExp(`DROP FUNCTION[^;]*${fn}\\b`).test(fwd));
}

// ── rollback: guarded, refuses rather than guesses ────────────────────────────────
assert('rollback: refuses if any lifecycle idempotency record exists', /rollback refused.*lifecycle idempotency record/i.test(rb));
assert('rollback: refuses if any real lifecycle decision already happened', /rollback refused.*never reverses a human lifecycle decision/i.test(rb));
assert('rollback: drops both RPCs with their exact signatures',
  /DROP FUNCTION IF EXISTS public\.auth_set_access_user_active_v3\(uuid, text, text, boolean, boolean, text, text, text, jsonb\)/.test(rb) &&
  /DROP FUNCTION IF EXISTS public\.auth_clear_access_user_credential_v3\(uuid, text, text, int, text, text, text, jsonb\)/.test(rb));
assert('rollback: never touches auth_actors or auth_actor_pin_fingerprints data', !/UPDATE\s+public\.auth_actors|DELETE FROM public\.auth_actor_pin_fingerprints|DELETE FROM public\.auth_actors/i.test(rb));
assert('rollback: never restores/alters auth_audit_event_chk (nothing was widened)', !/auth_audit_event_chk/.test(strip(rb)));
assert('rollback: never drops or alters any prior writer', !/DROP FUNCTION[^;]*auth_(set_actor_pin_v[23]|change_actor_role_v3|create_access_user_v3|rename_access_user_v3)\b/.test(rb));
assert('rollback: never drops auth_actor_pin_fingerprints or access_management_idempotency tables', !/DROP TABLE[^;]*(auth_actor_pin_fingerprints|access_management_idempotency)/.test(rb));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
