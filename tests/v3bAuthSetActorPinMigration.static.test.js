'use strict';
// Test per migrations/2026-07-29_v3b_auth_set_actor_pin_v3.sql — Access Control V3
// Block V3-B. Eseguire: node tests/v3bAuthSetActorPinMigration.static.test.js
// STATIC TEXT ONLY — no DB connection, no SQL execution (the real disposable-Postgres
// rehearsal for this migration is a separate, out-of-band step). Verifies the migration
// and rollback files exist, stay additive alongside auth_set_actor_pin_v2, never touch
// v2 or auth_actors.pin_hash directly, and preserve the accepted invariants.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FORWARD = path.join(MIGRATIONS_DIR, '2026-07-29_v3b_auth_set_actor_pin_v3.sql');
const ROLLBACK = path.join(MIGRATIONS_DIR, '2026-07-29_v3b_auth_set_actor_pin_v3.ROLLBACK.sql');

assert('forward migration file exists', fs.existsSync(FORWARD));
assert('rollback file exists', fs.existsSync(ROLLBACK));

const fwd = fs.readFileSync(FORWARD, 'utf8');
const rb = fs.readFileSync(ROLLBACK, 'utf8');

// ── staging sentinel ──────────────────────────────────────────────────────────
assert('forward: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(fwd));
assert('rollback: staging sentinel guard present', /supabase_migrations\.schema_migrations WHERE version = '20260710075612'/.test(rb));

// ── preconditions: v3 requires V3-A's table AND v2's exact signature first ────
assert('forward: refuses if auth_actor_pin_fingerprints is absent (V3-A prerequisite)', /auth_actor_pin_fingerprints.*absent.*apply V3-A first/i.test(fwd));
assert('forward: refuses unless auth_set_actor_pin_v2 exists with its EXACT expected signature',
  /oidvectortypes\(p\.proargtypes\) = 'text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb'/.test(fwd) &&
  /v3 must be added ALONGSIDE it, not in place of a missing\/altered v2/i.test(fwd));

// ── additive: v3 is a NEW function, v2's own definition is never rewritten ────
assert('forward: creates auth_set_actor_pin_v3 (new function)', /CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v3\(/.test(fwd));
assert('forward: never defines/replaces auth_set_actor_pin_v2 itself', !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v2/.test(fwd));
assert('forward: never DROPs auth_set_actor_pin_v2', !/DROP FUNCTION[^;]*auth_set_actor_pin_v2/.test(fwd));

// ── role check WIDENED via removal of the closed 3-value list, NOT via a new list ──
// v2's own text (not touched by this migration) is known to carry the closed check;
// v3's function body must not repeat it.
assert('forward: v3 function body contains NO hardcoded 3-role closed-list check',
  !/p_expected_role\s+NOT IN\s*\(\s*'admin'\s*,\s*'operator'\s*,\s*'rider'\s*\)/i.test(fwd));
assert('forward: v3 instead only requires p_expected_role to be a non-empty string',
  /p_expected_role IS NULL OR btrim\(p_expected_role\) = ''/.test(fwd));
assert('forward: the AUTHORITATIVE role check (row vs claimed) is unchanged and present',
  /v_tgt\.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH'/.test(fwd));

// ── locking / staleness discipline identical to v2 ─────────────────────────────
assert('forward: takes the workspace row lock first (FOR UPDATE on workspaces)', /FROM public\.workspaces WHERE id = v_ws_id FOR UPDATE/.test(fwd));
assert('forward: deterministic per-workspace actor locking (ORDER BY actor FOR UPDATE)', /WHERE workspace_id = v_ws_id ORDER BY actor FOR UPDATE/.test(fwd));
assert('forward: re-verifies the target under lock (AUTH_ROTATION_STALE on workspace drift)', /IF v_tgt\.workspace_id IS DISTINCT FROM v_ws_id THEN[\s\S]{0,80}AUTH_ROTATION_STALE/.test(fwd));
assert('forward: re-validates the Node-supplied p_seen snapshot against the live table (staleness)', /AUTH_ROTATION_STALE.*40001/.test(fwd) && /jsonb_array_elements\(p_seen\)/.test(fwd));
assert('forward: session_version increments exactly once, target-only', /SET pin_hash = p_hash, session_version = session_version \+ 1/.test(fwd));
assert('forward: pin_set vs pin_change event semantics unchanged', /v_event := CASE WHEN v_tgt\.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change' END/.test(fwd));

// ── fingerprint parameters: required current, both-or-neither previous ────────
for (const p of ['p_key_id_current text', 'p_fingerprint_current text', 'p_key_id_previous text DEFAULT NULL', 'p_fingerprint_previous text DEFAULT NULL']) {
  assert(`forward: function signature declares ${p}`, fwd.includes(p));
}
assert('forward: p_key_id_current format-checked (^k[0-9]+$)', /p_key_id_current !~ '\^k\[0-9\]\+\$'/.test(fwd));
assert('forward: both-or-neither guard for previous key/fingerprint', /p_key_id_previous IS NOT NULL\) IS DISTINCT FROM \(p_fingerprint_previous IS NOT NULL\)/.test(fwd));
assert('forward: current and previous key ids must differ', /p_key_id_previous = p_key_id_current THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_KEY_IDS_MUST_DIFFER'/.test(fwd));

// ── atomic write: pin_hash UPDATE and fingerprint INSERT(s) in the same function ──
// A single plpgsql function body executes as part of its caller's transaction — there
// is no way to commit the UPDATE without also running the INSERT(s) below it, or vice
// versa. Proven by locating both statements inside the SAME $fn$...$fn$ body, with the
// fingerprint INSERT ordered strictly after the pin_hash UPDATE.
{
  const body = fwd.match(/AS \$fn\$([\s\S]*?)\$fn\$;/);
  assert('forward: function body captured for atomicity check', !!body);
  if (body) {
    const updateIdx = body[1].indexOf('SET pin_hash = p_hash');
    const insertIdx = body[1].indexOf('INSERT INTO public.auth_actor_pin_fingerprints');
    assert('forward: pin_hash UPDATE and fingerprint INSERT are both in the one function body, INSERT after UPDATE',
      updateIdx !== -1 && insertIdx !== -1 && insertIdx > updateIdx);
  }
}
assert('forward: fingerprint CURRENT row written via INSERT ... ON CONFLICT (actor, key_id) DO UPDATE',
  /INSERT INTO public\.auth_actor_pin_fingerprints \(actor, key_id, workspace_id, fingerprint\)\s*\n\s*VALUES \(p_target_actor, p_key_id_current, v_ws_id, p_fingerprint_current\)\s*\n\s*ON CONFLICT \(actor, key_id\) DO UPDATE/.test(fwd));
assert('forward: fingerprint PREVIOUS row written conditionally, only IF p_key_id_previous IS NOT NULL',
  /IF p_key_id_previous IS NOT NULL THEN\s*\n\s*INSERT INTO public\.auth_actor_pin_fingerprints/.test(fwd));

// ── no plaintext PIN ever reaches this function ────────────────────────────────
assert('forward: no plaintext-PIN parameter exists (only p_hash, already-hashed)', !/\bp_pin\b/.test(fwd));
assert('forward: hash format guard unchanged (scrypt$ prefix required)', /left\(p_hash, 7\) <> 'scrypt\$'/.test(fwd));

// ── meta sensitive-key guard extended for fingerprint-related keys ────────────
for (const k of ['fingerprint', 'pin_fingerprint', 'fingerprint_key', 'hmac_key']) {
  assert(`forward: sensitive-meta-key guard includes '${k}'`, fwd.includes(`'${k}'`));
}

// ── grants: service_role only, exactly like v2 ─────────────────────────────────
assert('forward: REVOKEs from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.auth_set_actor_pin_v3\([^)]*\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(fwd));
assert('forward: GRANTs EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.auth_set_actor_pin_v3\([^)]*\)\s*\n\s*TO service_role/.test(fwd));

// ── return value never carries pin_hash or any fingerprint value ──────────────
const returnBlock = fwd.match(/RETURN jsonb_build_object\([\s\S]*?\);/);
assert('forward: RETURN block present', !!returnBlock);
if (returnBlock) {
  assert('forward: return value contains no pin_hash/hash/fingerprint field', !/'(pin_hash|hash|fingerprint)'/.test(returnBlock[0]));
}

// ── rollback: scoped to exactly the one function this migration created ───────
assert('rollback: refuses if any fingerprint row exists (evidence runtime may depend on v3)', /rollback refused.*auth_actor_pin_fingerprints/i.test(rb));
assert('rollback: drops v3 with its EXACT 15-parameter signature', /DROP FUNCTION IF EXISTS public\.auth_set_actor_pin_v3\(text, text, text, text, jsonb, text, text, text, text, text, uuid, uuid, text, text, jsonb\)/.test(rb));
assert('rollback: never drops or alters auth_set_actor_pin_v2', !/DROP FUNCTION[^;]*auth_set_actor_pin_v2/.test(rb) && !/CREATE OR REPLACE FUNCTION public\.auth_set_actor_pin_v2/.test(rb));
assert('rollback: postcondition re-verifies v2 is still present with its exact signature', /v_v2_found <> 1 THEN[\s\S]{0,240}must never have touched it/.test(rb));
assert('rollback: never touches auth_actors.pin_hash', !/UPDATE\s+public\.auth_actors\s+SET\s+pin_hash/i.test(rb));
assert('rollback: never DROPs auth_actor_pin_fingerprints (that table\'s lifecycle belongs to V3-A)', !/DROP TABLE[^;]*auth_actor_pin_fingerprints/.test(rb));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
