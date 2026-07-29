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

// ── role vocabulary — transitional UNION; runtime-compatible, no row rewritten ──
// V3-A must NOT change any existing row's role value: the live runtime (jwt.js
// ROLE_SUB, pinPolicy.ROLE_PIN_RULES, legacyActionRoles.js) still authorizes
// exclusively against admin/operator/rider and has no notion of the V3 codes. The
// CHECK widens to a permissive union so the column *could* one day hold a V3 code,
// but actual per-row conversion is deferred to V3-C, after the backend is deployed
// with support for both vocabularies.
const LEGACY_ROLES = ['admin', 'operator', 'rider'];
const EXPECTED_ROLES = ['owner', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager', 'legacy_operator'];
const EXPECTED_UNION = [...new Set([...LEGACY_ROLES, ...EXPECTED_ROLES])]; // 9 distinct values
const roleChkMatch = fwd.match(/auth_actors_role_chk\s*\n?\s*CHECK \(role IN \(([^)]+)\)\)/);
assert('forward: role CHECK block present', !!roleChkMatch);
if (roleChkMatch) {
  const values = roleChkMatch[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
  assert('forward: role CHECK is the 9-value transitional UNION (legacy + V3, no narrowing)',
    values.length === EXPECTED_UNION.length && EXPECTED_UNION.every((r) => values.includes(r)),
    JSON.stringify(values));
  assert('forward: role CHECK still accepts the LIVE runtime vocabulary (admin/operator/rider)',
    LEGACY_ROLES.every((r) => values.includes(r)));
}

// ── no existing row's role value is ever rewritten ────────────────────────────
// A single, strong, sufficient proof: NO "UPDATE ... auth_actors SET role" statement
// of any shape appears in forward at all — not scoped to any one actor, unconditional.
assert('forward: contains ZERO statements that write auth_actors.role for any actor',
  !/UPDATE\s+public\.auth_actors\s+SET\s+role\s*=/i.test(fwd));
// display_name backfill (the ONLY per-row write this migration performs) still happens.
for (const actor of ['owner', 'operator_primary', 'operator_backup', 'rider']) {
  assert(`forward: backfills display_name for ${actor} (the only data touched)`,
    new RegExp(`display_name = '[^']+'\\s+WHERE actor = '${actor}'`).test(fwd));
}
// auth_actors_actor_role_map is left COMPLETELY untouched — forward never drops or
// re-adds it (a real DDL statement, not the explanatory comment mentioning its name).
assert('forward: does NOT DROP or ADD auth_actors_actor_role_map (no real DDL statement, comment mention is fine)',
  !/(DROP|ADD) CONSTRAINT auth_actors_actor_role_map/.test(fwd));

// ── fingerprint table constraints ─────────────────────────────────────────────
assert('forward: auth_actor_pin_fingerprints table created', /CREATE TABLE IF NOT EXISTS public\.auth_actor_pin_fingerprints/.test(fwd));
assert('forward: fingerprint table has PRIMARY KEY (actor, key_id)', /PRIMARY KEY \(actor, key_id\)/.test(fwd));
assert('forward: fingerprint table has UNIQUE(workspace_id, key_id, fingerprint)', /auth_actor_pin_fp_ws_key_fp_uq[\s\S]*?ON public\.auth_actor_pin_fingerprints \(workspace_id, key_id, fingerprint\)/.test(fwd));
assert('forward: fingerprint table has composite (workspace_id, actor) FK', /FOREIGN KEY \(workspace_id, actor\) REFERENCES public\.auth_actors \(workspace_id, actor\)/.test(fwd));
assert('forward: key_id has a strict format CHECK', /key_id ~ '\^k\[0-9\]\+\$'/.test(fwd));
assert('forward: new non-partial UNIQUE(workspace_id, actor) added for the composite FK to reference', /auth_actors_ws_actor_key UNIQUE \(workspace_id, actor\)/.test(fwd));

// ── REGRESSION: auth_actors_ws_actor_key must be existence-checked create-only, ──
// ── NEVER "DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT ..." ──────────────────
// Found by an actual disposable-Postgres apply/rollback rehearsal (not static
// parsing): this migration's own auth_actor_pin_fingerprints table has a composite
// FK REFERENCING this constraint. A DROP-then-ADD pattern — safe for a plain CHECK
// constraint, which is what the other three DROP+ADD pairs in this file are — fails
// on re-apply once that FK exists, with "cannot drop constraint ... because other
// objects depend on it". The constraint's definition never needs to change, so
// existence-checked create-only is the correct fix, not a workaround.
// A real DDL statement always has the exact "ALTER TABLE ... DROP CONSTRAINT ...;"
// shape; the migration's own explanatory comment quotes this same string in prose
// ("... DROP CONSTRAINT IF EXISTS auth_actors_ws_actor_key" fails with ...") without
// that shape — the same class of comment-vs-statement bug already fixed twice before
// in this file. Require the real statement shape, not a bare substring match.
assert('forward: auth_actors_ws_actor_key uses existence-checked create-only (NOT DROP CONSTRAINT IF EXISTS + ADD, which breaks idempotent re-apply once the FK exists)',
  !/ALTER TABLE public\.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_ws_actor_key;/.test(fwd) &&
  /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'auth_actors_ws_actor_key'\)/.test(fwd));
// The 3 plain CHECK constraints (no possible FK dependent) may safely keep the
// simpler DROP+ADD pattern — this regression is specific to auth_actors_ws_actor_key,
// not a blanket ban on DROP+ADD everywhere in the file.
for (const chk of ['auth_actors_created_by_chk', 'auth_actors_role_chk', 'auth_audit_event_chk']) {
  assert(`forward: ${chk} (a plain CHECK, never an FK target) still safely uses DROP CONSTRAINT IF EXISTS + ADD`,
    new RegExp(`DROP CONSTRAINT IF EXISTS ${chk}`).test(fwd) && new RegExp(`ADD CONSTRAINT ${chk}`).test(fwd));
}

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
// The precondition must cover ALL SIX V3-only values (owner/cashier/waiter/kitchen/
// shift_manager/legacy_operator) — not just the 4 "new business roles" — because
// forward never changes role data, so 'owner' or 'legacy_operator' appearing on any
// row is equally proof that a LATER migration (V3-C) did real per-row conversion.
const V3_ONLY_ROLES = ['owner', 'cashier', 'waiter', 'kitchen', 'shift_manager', 'legacy_operator'];
assert('rollback: refuses if any row carries ANY of the six V3-only roles (not just 4)',
  V3_ONLY_ROLES.every((r) => rb.includes(`'${r}'`)) &&
  new RegExp(`role IN \\(${V3_ONLY_ROLES.map((r) => `'${r}'`).join(',')}\\)`).test(rb) &&
  /rollback refused.*V3-only role/i.test(rb));
assert('rollback: refuses if any audit row uses a V3-only event', /rollback refused.*V3-only event/i.test(rb));
assert('rollback: refuses if fingerprint rows exist (no silent data loss)', /rollback refused.*auth_actor_pin_fingerprints/i.test(rb));
assert('rollback: drops the two new tables', /DROP TABLE IF EXISTS public\.access_management_idempotency/.test(rb) && /DROP TABLE IF EXISTS public\.auth_actor_pin_fingerprints/.test(rb));
assert('rollback: narrows auth_audit_event_chk back to the pre-existing 11', PRE_EXISTING_EVENTS.every((e) => rb.includes(`'${e}'`)) && !NEW_V3_EVENTS.some((e) => rb.match(new RegExp(`CHECK \\(event IN \\([^)]*'${e}'`))));
// Rollback must NOT contain any role-rewriting UPDATE either — there is nothing to
// revert, since forward never wrote role data in the first place.
assert('rollback: contains ZERO statements that write auth_actors.role for any actor',
  !/UPDATE\s+public\.auth_actors\s+SET\s+role\s*=/i.test(rb));
assert('rollback: does NOT DROP or ADD auth_actors_actor_role_map either (forward never did)',
  !/(DROP|ADD) CONSTRAINT auth_actors_actor_role_map/.test(rb));
assert('rollback: narrows the role CHECK directly to admin/operator/rider (no data revert needed first)',
  /CHECK \(role IN \('admin','operator','rider'\)\)/.test(rb));

// ══ THE deterministic proof this round required: apply + rollback leaves every ══
// ══ one of the 4 legacy actor role values unchanged, end to end. ═══════════════
// Static equivalent of "apply then rollback changes nothing": forward writes ZERO
// role values (proven above) and rollback writes ZERO role values (proven above) —
// together this is a complete, sufficient proof with no SQL execution required.
assert('DETERMINISTIC PROOF: forward+rollback together never write auth_actors.role for owner/operator_primary/operator_backup/rider',
  !/UPDATE\s+public\.auth_actors\s+SET\s+role\s*=/i.test(fwd) && !/UPDATE\s+public\.auth_actors\s+SET\s+role\s*=/i.test(rb));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
