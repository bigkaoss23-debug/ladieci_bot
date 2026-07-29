'use strict';
// Test per migrations/2026-07-29_v3c_auth_change_actor_role.sql — Access Control V3
// Block V3-C. Eseguire: node tests/v3cAuthChangeActorRoleMigration.static.test.js
// STATIC TEXT ONLY — no DB connection, no SQL execution (the real disposable-Postgres
// rehearsal for this migration is a separate, out-of-band step). Verifies the migration
// and rollback files exist, never mutate any existing role, never touch the PIN writers,
// and enforce the transitional-integrity rules from source text.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FORWARD = path.join(MIGRATIONS_DIR, '2026-07-29_v3c_auth_change_actor_role.sql');
const ROLLBACK = path.join(MIGRATIONS_DIR, '2026-07-29_v3c_auth_change_actor_role.ROLLBACK.sql');

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
assert('forward: refuses if access_management_idempotency is absent (V3-A prerequisite)', /access_management_idempotency.*absent.*apply V3-A first/i.test(fwd));
assert('forward: precondition — the 4 legacy rows must match the expected pre-V3-C shape',
  /VALUES\s*\n\s*\('owner','admin'\), \('operator_primary','operator'\), \('operator_backup','operator'\), \('rider','rider'\)/.test(fwd));

// ── the migration itself contains NO UPDATE of auth_actors.role ──────────────────
assert('forward: contains no UPDATE of auth_actors.role anywhere OUTSIDE the RPC body',
  (() => {
    const body = fwd.match(/AS \$fn\$([\s\S]*?)\$fn\$;/);
    const outside = body ? fwd.replace(body[0], '') : fwd;
    return !/UPDATE\s+public\.auth_actors\s+SET[\s\S]*?role\s*=/i.test(outside);
  })());
assert('forward: no top-level INSERT/UPDATE seeding a new role value for an existing actor',
  !/UPDATE public\.auth_actors[\s\S]{0,40}SET role = '(cashier|waiter|kitchen|shift_manager|legacy_operator|owner)'/i.test(fwd.split('CREATE OR REPLACE FUNCTION')[0]));

// ── relaxed actor-role-map constraint: additive permission only ─────────────────
assert('forward: drops the old hardcoded 1:1 actor-role-map', /DROP CONSTRAINT IF EXISTS auth_actors_actor_role_map/.test(fwd));
assert('forward: new constraint keeps the owner actor pinned to admin',
  /\(actor = 'owner' AND role = 'admin'\)/.test(fwd));
assert('forward: new constraint forbids admin/owner for every NON-owner actor',
  /\(actor <> 'owner' AND role NOT IN \('admin', 'owner'\)\)/.test(fwd));
assert('forward: does NOT touch the fixed four-actor identity ceiling (auth_actors_actor_chk)',
  !/auth_actors_actor_chk/.test(fwdCode));

// ── auth_change_actor_role_v3 exists, additive, dormant ──────────────────────────
assert('forward: creates auth_change_actor_role_v3 (new function)', /CREATE OR REPLACE FUNCTION public\.auth_change_actor_role_v3\(/.test(fwd));
assert('forward: requested role is a WHITELIST of exactly the 5 assignable V3 roles',
  /p_requested_role NOT IN \('cashier', 'waiter', 'kitchen', 'rider', 'shift_manager'\)/.test(fwd));
assert('forward: rejects admin as a requested role (whitelist excludes it)', !/'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'admin'/.test(fwd));
assert('forward: rejects owner as a requested role (whitelist excludes it)', !/'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'owner'/.test(fwd));
assert('forward: rejects legacy_operator as a requested role (whitelist excludes it)', !/'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'legacy_operator'/.test(fwd));

// ── acting-owner and target-not-owner decided by ROLE, never the actor id literal ──
assert('forward: acting actor authorized by role IN (admin, owner), not actor id', /v_by\.role NOT IN \('admin', 'owner'\) THEN RAISE EXCEPTION 'AUTH_NOT_OWNER'/.test(fwd));
assert('forward: target rejected when its role is admin/owner, not by actor id "owner"', /v_tgt\.role IN \('admin', 'owner'\) THEN RAISE EXCEPTION 'AUTH_TARGET_IS_OWNER'/.test(fwd));
assert('forward: does not classify the owner target by the literal string comparison p_target_actor = \'owner\'',
  !/p_target_actor\s*=\s*'owner'/.test(fwd));

// ── locking discipline ───────────────────────────────────────────────────────────
assert('forward: takes the workspace row lock first (FOR UPDATE on workspaces)', /FROM public\.workspaces WHERE id = p_workspace_id FOR UPDATE/.test(fwd));
assert('forward: deterministic actor-id locking for acting + target only (not the whole workspace)',
  /WHERE actor IN \(p_by_actor, p_target_actor\) ORDER BY actor FOR UPDATE/.test(fwd));
assert('forward: expected-role match against the authoritative locked row', /v_tgt\.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH'/.test(fwd));

// ── no-op vs real change ──────────────────────────────────────────────────────────
assert('forward: identical current/requested role short-circuits BEFORE the UPDATE (deterministic no-op)',
  /v_changed := \(v_old_role <> p_requested_role\)/.test(fwd) && /IF NOT v_changed THEN/.test(fwd));
assert('forward: session_version increments exactly once, target-only, only on real change',
  /SET role = p_requested_role, session_version = session_version \+ 1/.test(fwd));

// ── never touches pin_hash / fingerprints / active / display_name / failed_count / locked_until ──
{
  const body = fwdCode.match(/AS \$fn\$([\s\S]*?)\$fn\$;/);
  assert('forward: function body captured', !!body);
  if (body) {
    const b = body[1];
    for (const col of ['pin_hash', 'display_name', 'failed_count', 'locked_until']) {
      assert(`forward: RPC body never sets ${col}`, !new RegExp(`SET[^;]*\\b${col}\\s*=`, 'i').test(b));
    }
    assert('forward: RPC body never writes auth_actor_pin_fingerprints', !/auth_actor_pin_fingerprints/.test(b));
    assert('forward: RPC body never writes active=', !/SET[^;]*\bactive\s*=/.test(b));
  }
}

// ── audit: role_changed + session_invalidated, exactly once each, real change only ──
assert('forward: inserts role_changed audit on real change', /INSERT INTO public\.auth_audit\(event, target_actor, by_actor, ip_hash, meta\)\s*\n\s*VALUES \('role_changed'/.test(fwd));
assert('forward: inserts session_invalidated audit on real change', /VALUES \('session_invalidated'/.test(fwd));
assert('forward: session_invalidated meta scopes only the target\'s own session_version (no global invalidation)',
  /session_invalidated'[\s\S]{0,200}session_version', r\.session_version/.test(fwd));

// ── idempotency: same transaction, replay-safe, conflict-safe ────────────────────
assert('forward: idempotency lookup keyed on the full V3-A PK (workspace, by_actor, sid_hash, action, client_request_id)',
  /workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash\s*\n\s*AND action = 'change_actor_role' AND client_request_id = p_client_request_id/.test(fwd));
assert('forward: same request_hash replays the stored response verbatim, no mutation', /IF v_idem\.request_hash = p_request_hash THEN\s*\n\s*RETURN v_idem\.response_body/.test(fwd));
assert('forward: different request_hash under the same key raises a conflict', /RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT'/.test(fwd));
assert('forward: idempotency INSERT happens after the mutation/no-op branch, in the same function body',
  fwd.indexOf('INSERT INTO public.access_management_idempotency') > fwd.indexOf("IF NOT v_changed THEN"));
assert('forward: request_hash format is validated (64 lowercase hex)', /p_request_hash !~ '\^\[0-9a-f\]\{64\}\$'/.test(fwd));

// ── meta never accepts token/proof/sid/pin/fingerprint keys ──────────────────────
for (const k of ['token', 'proof', 'step_up_proof', 'sid', 'pin', 'pin_hash', 'fingerprint']) {
  assert(`forward: sensitive-meta-key guard includes '${k}'`, fwd.includes(`'${k}'`));
}

// ── no plaintext PIN / secret parameter of any kind ───────────────────────────────
assert('forward: no p_pin / p_hash / p_token / p_proof parameter exists', !/\bp_(pin|hash|token|proof)\b/.test(fwd));

// ── grants: service_role only ─────────────────────────────────────────────────
assert('forward: REVOKEs from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.auth_change_actor_role_v3\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(fwd));
assert('forward: GRANTs EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_change_actor_role_v3\([^)]*\)\s*\n\s*TO service_role/.test(fwd));

// ── V2 / V3-B PIN writers completely untouched by this migration ─────────────────
assert('forward: never defines/replaces auth_set_actor_pin_v2', !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v2/.test(fwd));
assert('forward: never defines/replaces auth_set_actor_pin_v3', !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v3/.test(fwd));
assert('forward: never DROPs auth_set_actor_pin_v2 or v3', !/DROP FUNCTION[^;]*auth_set_actor_pin_v[23]/.test(fwd));

// ── rollback: guarded, refuses rather than guesses ────────────────────────────────
assert('rollback: refuses if any auth_actors row has already drifted from its pre-V3-C role', /rollback refused.*explicit role change already happened/i.test(rb));
assert('rollback: refuses if any change_actor_role idempotency record exists', /rollback refused.*change_actor_role idempotency record/i.test(rb));
assert('rollback: drops the RPC with its EXACT 9-parameter signature',
  /DROP FUNCTION IF EXISTS public\.auth_change_actor_role_v3\(uuid, text, text, text, text, text, text, text, jsonb\)/.test(rb));
assert('rollback: restores the ORIGINAL hardcoded 1:1 actor-role-map', /\(actor='owner'\s+and role='admin'\)/.test(rb) && /\(actor='rider'\s+and role='rider'\)/.test(rb));
assert('rollback: never touches auth_actors.pin_hash', !/UPDATE\s+public\.auth_actors\s+SET\s+pin_hash/i.test(rb));
assert('rollback: never drops or alters auth_set_actor_pin_v2 or v3', !/DROP FUNCTION[^;]*auth_set_actor_pin_v[23]/.test(rb) && !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v[23]/.test(rb));
assert('rollback: never drops auth_actor_pin_fingerprints or access_management_idempotency', !/DROP TABLE[^;]*(auth_actor_pin_fingerprints|access_management_idempotency)/.test(rb));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
