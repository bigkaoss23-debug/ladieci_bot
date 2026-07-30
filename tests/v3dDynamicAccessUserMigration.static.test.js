'use strict';
// Test per migrations/2026-07-29_v3d_dynamic_access_user.sql -- Access Control V3
// Block V3-D. Eseguire: node tests/v3dDynamicAccessUserMigration.static.test.js
// STATIC TEXT ONLY -- no DB connection, no SQL execution (the real disposable-Postgres
// rehearsal for this migration is a separate, out-of-band step).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FORWARD = path.join(MIGRATIONS_DIR, '2026-07-29_v3d_dynamic_access_user.sql');
const ROLLBACK = path.join(MIGRATIONS_DIR, '2026-07-29_v3d_dynamic_access_user.ROLLBACK.sql');

assert('forward migration file exists', fs.existsSync(FORWARD));
assert('rollback file exists', fs.existsSync(ROLLBACK));

const fwd = fs.readFileSync(FORWARD, 'utf8');
const rb = fs.readFileSync(ROLLBACK, 'utf8');
const strip = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fwdCode = strip(fwd);

const UUID_PATTERN = "'\\^\\[0-9a-f\\]\\{8\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{4\\}-\\[0-9a-f\\]\\{12\\}\\$'";

// ── staging sentinel ──────────────────────────────────────────────────────────
assert('forward: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(fwd));
assert('rollback: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(rb));

// ── predecessor: V3-C must be applied first, checked by robust existence not fragile text ──
assert('forward: refuses if auth_change_actor_role_v3 is absent (V3-C prerequisite)',
  /auth_change_actor_role_v3.*not found.*apply V3-C first/i.test(fwd));
assert('forward: precondition -- the 4 legacy rows must match the expected pre-V3-D shape',
  /VALUES\s*\n\s*\('owner','admin'\), \('operator_primary','operator'\), \('operator_backup','operator'\), \('rider','rider'\)/.test(fwd));

// ── no rewrite of any existing actor/role/PIN/fingerprint/session data ───────────
assert('forward: contains NO UPDATE of auth_actors data anywhere in the file',
  !/UPDATE\s+public\.auth_actors\s+SET/i.test(fwdCode.split('CREATE OR REPLACE FUNCTION')[0]));
{
  // every UPDATE public.auth_actors statement (there should be exactly 2, one inside
  // each RPC body) must only ever touch display_name/updated_at/updated_by (rename) or
  // nothing at all outside the two RPCs.
  const updates = [...fwdCode.matchAll(/UPDATE\s+public\.auth_actors\s+SET([\s\S]*?)WHERE/g)].map((m) => m[1]);
  assert('forward: every UPDATE public.auth_actors touches ONLY display_name/updated_at/updated_by',
    updates.length > 0 && updates.every((set) => /display_name/.test(set) && !/\brole\s*=/.test(set) && !/\bpin_hash\s*=/.test(set) && !/\bactive\s*=/.test(set) && !/\bsession_version\s*=/.test(set) && !/\bfailed_count\s*=/.test(set) && !/\blocked_until\s*=/.test(set)));
}

// ── legacy ids preserved; UUID identities enabled (strict superset, additive) ────
for (const col of ['auth_actors_actor_chk', 'auth_actors_created_by_chk', 'auth_actors_updated_by_chk', 'auth_audit_target_actor_chk', 'auth_audit_by_actor_chk']) {
  assert(`forward: ${col} is widened (DROP + ADD)`, new RegExp(`DROP CONSTRAINT IF EXISTS ${col}`).test(fwd) && new RegExp(`ADD CONSTRAINT ${col}`).test(fwd));
}
assert('forward: the widened actor CHECK still requires the exact 4 legacy literals',
  /actor IN \('owner','operator_primary','operator_backup','rider'\)/.test(fwd));
assert('forward: the widened actor CHECK additionally accepts a canonical UUID pattern',
  fwd.includes("actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"));
assert('forward: created_by/updated_by/audit columns get the SAME UUID pattern (consistent, not a one-off) -- actor, created_by, updated_by, target_actor, by_actor = 5',
  (fwd.split("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'").length - 1) === 5);

// ── UUID users cannot hold owner/admin/operator/legacy_operator ─────────────────
assert('forward: the requested-role whitelist for creation is exactly the 5 assignable roles',
  /p_requested_role NOT IN \('cashier', 'waiter', 'kitchen', 'rider', 'shift_manager'\)/.test(fwd));
assert('forward: creation never accepts admin/operator/owner/legacy_operator as a requested role (whitelist, not blacklist)',
  !/'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', '(admin|operator|owner|legacy_operator)'/.test(fwd));

// ── display_name -- one canonical bound, control chars rejected, trimmed ─────────
assert('forward: auth_actors_display_name_chk added, bound 120, control-char-free, pre-trimmed',
  /auth_actors_display_name_chk/.test(fwd) &&
  /length\(display_name\) <= 120/.test(fwd) &&
  /display_name = btrim\(display_name\)/.test(fwd));
assert('forward: RPC-level display name validation uses the SAME 120 bound and control-char pattern',
  (fwd.match(/> 120/g) || []).length >= 2 && (fwd.match(/\\x00-\\x1F\\x7F/g) || []).length >= 3);

// ── CREATE RPC: no client-chosen identity, server-generated UUID ────────────────
assert('forward: creates auth_create_access_user_v3 (new function)', /CREATE OR REPLACE FUNCTION public\.auth_create_access_user_v3\(/.test(fwd));
assert('forward: CREATE RPC signature has no actor/user id, active, session_version, pin_hash, fingerprint, created_by, or updated_by parameter',
  !/p_actor\b|p_user_id\b|p_active\b|p_session_version\b|p_pin_hash\b|p_fingerprint\b|p_created_by\b|p_updated_by\b/.test(fwd));
assert('forward: the new actor id is generated server-side via gen_random_uuid()::text', /v_new_actor := gen_random_uuid\(\)::text/.test(fwd));
assert('forward: creation defaults are frozen exactly -- pin_hash NULL, session_version 1, active true, failed_count 0, locked_until NULL',
  /v_new_actor, p_requested_role, p_workspace_id, NULL, 1, true, 0,\s*\n\s*NULL, v_display_name/.test(fwd));
assert('forward: creation writes user_created audit exactly once', /'user_created'/.test(fwd));
assert('forward: no fingerprint row is ever written by the create RPC',
  !strip(fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_create_access_user_v3[\s\S]*?\$fn\$;/)[0]).includes('auth_actor_pin_fingerprints'));

// ── RENAME RPC: only display_name changes, self-rename allowed ──────────────────
assert('forward: creates auth_rename_access_user_v3 (new function)', /CREATE OR REPLACE FUNCTION public\.auth_rename_access_user_v3\(/.test(fwd));
assert('forward: rename does NOT exclude the owner as a target (self-rename is explicitly allowed)',
  !/AUTH_TARGET_IS_OWNER/.test(fwd.match(/CREATE OR REPLACE FUNCTION public\.auth_rename_access_user_v3[\s\S]*?\$fn\$;/)[0]));
assert('forward: rename locks acting + target in deterministic ORDER BY actor', /WHERE actor IN \(p_by_actor, p_target_actor\) ORDER BY actor FOR UPDATE/.test(fwd));
assert('forward: identical normalized name short-circuits BEFORE the UPDATE (deterministic no-op)',
  /v_changed := \(v_old_name IS DISTINCT FROM v_new_name\)/.test(fwd) && /IF NOT v_changed THEN/.test(fwd));
assert('forward: rename writes user_renamed audit exactly once, only on real change', /'user_renamed'/.test(fwd));
assert('forward: rename audit meta stores name LENGTHS, not the display name content itself',
  /old_name_len|new_name_len/.test(fwd) && !/'display_name', v_(old|new)_name/.test(fwd));

// ── idempotency: distinct action identifiers, request hash format, atomic record ──
assert('forward: create action identifier is create_access_user_v3', /action = 'create_access_user_v3'/.test(fwd) && /'create_access_user_v3',/.test(fwd));
assert('forward: rename action identifier is rename_access_user_v3', /action = 'rename_access_user_v3'/.test(fwd) && /'rename_access_user_v3',/.test(fwd));
assert('forward: both RPCs validate request_hash format (64 lowercase hex)', (fwd.match(/p_request_hash !~ '\^\[0-9a-f\]\{64\}\$'/g) || []).length === 2);
assert('forward: both RPCs raise AUTH_IDEMPOTENCY_CONFLICT on a same-key different-payload replay', (fwd.match(/AUTH_IDEMPOTENCY_CONFLICT/g) || []).length === 2);

// ── meta sensitive-key guards ──────────────────────────────────────────────────
for (const k of ['token', 'proof', 'sid', 'pin', 'pin_hash', 'fingerprint', 'actor', 'created_by', 'updated_by']) {
  assert(`forward: sensitive-meta-key guard includes '${k}'`, fwd.includes(`'${k}'`));
}

// ── grants: service_role only, both RPCs ─────────────────────────────────────────
assert('forward: CREATE RPC REVOKEs from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.auth_create_access_user_v3\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(fwd));
assert('forward: CREATE RPC GRANTs EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_create_access_user_v3\([^)]*\)\s*\n\s*TO service_role/.test(fwd));
assert('forward: RENAME RPC REVOKEs from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.auth_rename_access_user_v3\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(fwd));
assert('forward: RENAME RPC GRANTs EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_rename_access_user_v3\([^)]*\)\s*\n\s*TO service_role/.test(fwd));

// ── V2/V3-B/V3-C RPCs completely untouched ────────────────────────────────────────
assert('forward: never defines/replaces auth_set_actor_pin_v2', !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v2/.test(fwd));
assert('forward: never defines/replaces auth_set_actor_pin_v3', !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v3/.test(fwd));
assert('forward: never defines/replaces auth_change_actor_role_v3', !/CREATE OR REPLACE FUNCTION public\.auth_change_actor_role_v3/.test(fwd));
assert('forward: never DROPs any prior PIN or role-change writer', !/DROP FUNCTION[^;]*auth_(set_actor_pin_v[23]|change_actor_role_v3)/.test(fwd));

// ── rollback: guarded, refuses rather than guesses ────────────────────────────────
assert('rollback: refuses if any dynamic UUID actor exists', /rollback refused.*dynamic \(UUID\) auth_actors row/i.test(rb));
assert('rollback: refuses if any user_created/user_renamed audit exists', /rollback refused.*user_created\/user_renamed audit/i.test(rb));
assert('rollback: refuses if any create/rename idempotency record exists', /rollback refused.*create\/rename access-user idempotency record/i.test(rb));
assert('rollback: drops both RPCs with their exact signatures',
  /DROP FUNCTION IF EXISTS public\.auth_create_access_user_v3\(uuid, text, text, text, text, text, text, jsonb\)/.test(rb) &&
  /DROP FUNCTION IF EXISTS public\.auth_rename_access_user_v3\(uuid, text, text, text, text, text, text, jsonb\)/.test(rb));
assert('rollback: restores the ORIGINAL closed-4-value actor CHECK', /CHECK \(actor IN \('owner', 'operator_primary', 'operator_backup', 'rider'\)\)/.test(rb));
assert('rollback: never deletes an auth_actors row', !/DELETE FROM public\.auth_actors/.test(rb));
assert('rollback: never touches auth_actors.pin_hash', !/UPDATE\s+public\.auth_actors\s+SET\s+pin_hash/i.test(rb));
assert('rollback: never drops or alters auth_set_actor_pin_v2/v3 or auth_change_actor_role_v3',
  !/DROP FUNCTION[^;]*auth_(set_actor_pin_v[23]|change_actor_role_v3)/.test(rb) && !/CREATE OR REPLACE FUNCTION public\.auth_(set_actor_pin_v[23]|change_actor_role_v3)/.test(rb));
assert('rollback: never drops auth_actor_pin_fingerprints or access_management_idempotency', !/DROP TABLE[^;]*(auth_actor_pin_fingerprints|access_management_idempotency)/.test(rb));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
