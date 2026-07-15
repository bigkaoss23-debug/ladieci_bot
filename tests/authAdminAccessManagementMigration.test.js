'use strict';
// B6A static migration/SQL tests. Run: node tests/authAdminAccessManagementMigration.test.js
// NON-EXECUTING: asserts structure/safety of the four B6A admin-management RPCs by
// inspecting the SQL text. No DB, no staging, no migration apply. Robust per-function
// body extraction; structural negative assertions run on COMMENT-STRIPPED SQL so
// prose never masquerades as behavior. Includes negative controls proving the test
// catches: missing sv bump on enable, missing self-disable guard, missing
// actor_unlocked, an unexpected fifth RPC, and an unsafe grant.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── migration discovery / packaging convention ──────────────────────────────
const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL_MIGRATIONS = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const isRollback = (f) => f.endsWith('.ROLLBACK.sql');
const FORWARD_CONVENTION = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const ROLLBACK_CONVENTION = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;
const FORWARD_SET = ALL_MIGRATIONS.filter((f) => !isRollback(f)).sort();
const FWD = '2026-07-15_auth_admin_access_management.sql';
const RB = '2026-07-15_auth_admin_access_management.ROLLBACK.sql';

// (33) filename / discovery convention valid
assert('convention: forward filename matches YYYY-MM-DD_desc.sql', FORWARD_CONVENTION.test(FWD) && !isRollback(FWD));
assert('convention: rollback filename matches .ROLLBACK.sql', ROLLBACK_CONVENTION.test(RB));
assert('discovery: forward INCLUDED in derived forward set', FORWARD_SET.includes(FWD));
assert('discovery: rollback EXCLUDED from forward set', !FORWARD_SET.includes(RB) && isRollback(RB));
assert('uniqueness: forward version appears exactly once', FORWARD_SET.filter((f) => f === FWD).length === 1);
assert('files exist on disk', fs.existsSync(path.join(MIG_DIR, FWD)) && fs.existsSync(path.join(MIG_DIR, RB)));

const SQL = read('migrations/' + FWD);
const RBSQL = read('migrations/' + RB);
const stripComments = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const SQL_NC = stripComments(SQL);
const RB_NC = stripComments(RBSQL);

// ── robust per-function body extraction ──────────────────────────────────────
const FNS = [
  'auth_admin_set_actor_pin',
  'auth_admin_revoke_actor_sessions',
  'auth_admin_set_actor_active',
  'auth_admin_unlock_actor',
];
function createIdx(name) { return SQL_NC.indexOf('CREATE OR REPLACE FUNCTION public.' + name); }
const grantsAt = SQL_NC.indexOf('REVOKE ALL ON FUNCTION');
// body of fn i = from its CREATE up to the next CREATE (or the grants section)
function bodyOf(i) {
  const start = createIdx(FNS[i]);
  const nextStart = i + 1 < FNS.length ? createIdx(FNS[i + 1]) : grantsAt;
  return SQL_NC.slice(start, nextStart);
}
const BODIES = FNS.map((_, i) => bodyOf(i));
const [setPin, revoke, setActive, unlock] = BODIES;

// ── (1)(2) exactly four RPCs, no fifth ───────────────────────────────────────
const createMatches = SQL_NC.match(/CREATE OR REPLACE FUNCTION public\.(auth_admin_[a-z_]+)/g) || [];
const createdFns = createMatches.map((m) => m.replace('CREATE OR REPLACE FUNCTION public.', ''));
assert('exactly four B6 management RPCs created', createdFns.length === 4, createdFns.join(','));
assert('the four RPCs are exactly the expected set', FNS.every((f) => createdFns.includes(f)) && createdFns.every((f) => FNS.includes(f)), createdFns.join(','));
assert('no fifth auth_admin_ management RPC', new Set(createdFns).size === 4 && createdFns.length === 4);
assert('no other CREATE FUNCTION (only the four)', (SQL_NC.match(/CREATE OR REPLACE FUNCTION/g) || []).length === 4);
assert('does NOT redefine frozen B2/B5 RPCs', !/CREATE OR REPLACE FUNCTION public\.auth_(set_pin_hash|bump_session_version|set_active|record_failed_attempt|reset_failed_attempts|consume_recovery_window|register_recovery_window)\b/.test(SQL_NC));

// ── (3)(4)(5) security invoker + pinned search_path + no dynamic SQL ─────────
assert('all four are SECURITY INVOKER', (SQL_NC.match(/SECURITY INVOKER/g) || []).length === 4);
assert('NO SECURITY DEFINER anywhere', !/SECURITY DEFINER/i.test(SQL_NC));
assert('search_path pinned on all four', (SQL_NC.match(/SET search_path = public, pg_temp/g) || []).length === 4);
assert('no dynamic SQL (EXECUTE format / EXECUTE \'...\')', !/\bEXECUTE\s+format\b/i.test(SQL_NC) && !/\bEXECUTE\s+'/i.test(SQL_NC));

// ── (6) restrictive grants ───────────────────────────────────────────────────
assert('every fn revoked from public/anon/authenticated', (SQL_NC.match(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/g) || []).length === 4);
assert('every fn granted execute to service_role only', (SQL_NC.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/g) || []).length === 4);
assert('no broad GRANT to PUBLIC/anon/authenticated', !/GRANT[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(SQL_NC));
assert('staging sentinel guard present', /schema_migrations WHERE version='20260710075612'/.test(SQL_NC));

// ── (7)(8)(9)(10) initiator/target/lock invariants — present in ALL four ─────
BODIES.forEach((b, i) => {
  const nm = FNS[i];
  assert(`[${nm}] deterministic lock: IN (by,target) ORDER BY actor FOR UPDATE`,
    /WHERE actor IN \(p_by_actor, p_target_actor\) ORDER BY actor FOR UPDATE/.test(b));
  assert(`[${nm}] no row FOR UPDATE-locked twice (single FOR UPDATE)`, (b.match(/FOR UPDATE/g) || []).length === 1);
  assert(`[${nm}] initiator must exist`, /AUTH_INITIATOR_NOT_FOUND/.test(b));
  assert(`[${nm}] initiator stored role must be admin`, /v_by\.role <> 'admin'[\s\S]*?AUTH_NOT_ADMIN/.test(b));
  assert(`[${nm}] initiator must be active`, /v_by\.active <> true[\s\S]*?AUTH_INITIATOR_INACTIVE/.test(b));
  assert(`[${nm}] target must exist`, /v_tgt[\s\S]*?AUTH_ACTOR_NOT_FOUND/.test(b));
  assert(`[${nm}] target role verified vs locked DB row`, /v_tgt\.role <> p_expected_role[\s\S]*?AUTH_TARGET_ROLE_MISMATCH/.test(b));
  assert(`[${nm}] decisions made AFTER lock (lock precedes first RAISE-on-state)`,
    b.indexOf('FOR UPDATE') < b.indexOf('AUTH_NOT_ADMIN'));
  // (28) IP hash mandatory
  assert(`[${nm}] IP hash mandatory (null/empty rejected)`, /p_ip_hash IS NULL OR btrim\(p_ip_hash\) = ''[\s\S]*?AUTH_IP_HASH_REQUIRED/.test(b));
  assert(`[${nm}] IP hash max length enforced`, /length\(p_ip_hash\) > 64[\s\S]*?AUTH_IP_HASH_TOO_LONG/.test(b));
  // (29) metadata guard present
  assert(`[${nm}] metadata object guard`, /jsonb_typeof\(v_meta\) <> 'object'[\s\S]*?AUTH_META_INVALID/.test(b));
  assert(`[${nm}] metadata size guard`, /length\(v_meta::text\) > 2048[\s\S]*?AUTH_META_TOO_LARGE/.test(b));
  assert(`[${nm}] metadata sensitive-key guard (incl raw_ip/confirmation/pin_hash)`,
    /AUTH_META_SENSITIVE_KEY/.test(b) && /'raw_ip'/.test(b) && /'confirmation'/.test(b) && /'pin_hash'/.test(b));
  // (31) sanitized returns — never pin_hash
  assert(`[${nm}] return never exposes pin_hash`, !/'pin_hash'/.test(b.replace(/ANY \(ARRAY\[[\s\S]*?\]\)/g, '')) || !/jsonb_build_object[\s\S]*pin_hash/i.test(b));
  assert(`[${nm}] return payload is sanitized jsonb_build_object`, /RETURN jsonb_build_object\('actor', /.test(b));
});
// (30) no plaintext PIN input anywhere (only hashed p_hash, scrypt-shaped)
assert('no plaintext PIN parameter (only p_hash, scrypt-shaped)', !/p_pin\b/.test(SQL_NC) && /left\(p_hash, 7\) <> 'scrypt\$'/.test(setPin));

// ── (11)(14..18) SET PIN specifics ───────────────────────────────────────────
assert('set_pin: exact owner self-confirm CHANGE_OWNER_PIN (no normalization)',
  /p_by_actor = 'owner' AND p_target_actor = 'owner'[\s\S]*?p_confirm IS DISTINCT FROM 'CHANGE_OWNER_PIN'[\s\S]*?AUTH_CONFIRMATION_REQUIRED/.test(setPin));
assert('set_pin: rejects NULL/empty hash', /p_hash IS NULL OR btrim\(p_hash\) = ''[\s\S]*?AUTH_HASH_INVALID/.test(setPin));
assert('set_pin: requires scrypt$ shape', /left\(p_hash, 7\) <> 'scrypt\$'[\s\S]*?AUTH_HASH_INVALID/.test(setPin));
assert('set_pin: NEVER sets pin_hash=NULL', !/pin_hash = NULL/i.test(setPin));
assert('set_pin: sets pin_hash = p_hash', /SET pin_hash = p_hash/.test(setPin));
assert('set_pin: preserves active (active not in SET clause)', !/SET[\s\S]*?\bactive =/.test(setPin.slice(setPin.indexOf('UPDATE public.auth_actors'), setPin.indexOf('RETURNING'))));
assert('set_pin: resets failed_count=0 and locked_until=NULL', /failed_count = 0, locked_until = NULL/.test(setPin));
assert('set_pin: increments session_version once', (setPin.match(/session_version = session_version \+ 1/g) || []).length === 1);
assert('set_pin: sets updated_at=now-var and updated_by=p_by_actor', /updated_at = v_now, updated_by = p_by_actor/.test(setPin));
assert('set_pin: derives pin_set (prev NULL) / pin_change (prev non-NULL)',
  /v_tgt\.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change'/.test(setPin));
assert('set_pin: audits derived v_event', /INSERT INTO public\.auth_audit[\s\S]*?VALUES \(v_event, p_target_actor, p_by_actor, p_ip_hash, v_meta\)/.test(setPin));
assert('set_pin: confirmation phrase never audited/returned', !/CHANGE_OWNER_PIN/.test(setPin.slice(setPin.indexOf('INSERT INTO'))));

// ── (12)(19)(20) REVOKE specifics ────────────────────────────────────────────
assert('revoke: exact owner self-confirm REVOKE_OWNER_SESSIONS (no normalization)',
  /p_by_actor = 'owner' AND p_target_actor = 'owner'[\s\S]*?p_confirm IS DISTINCT FROM 'REVOKE_OWNER_SESSIONS'[\s\S]*?AUTH_CONFIRMATION_REQUIRED/.test(revoke));
assert('revoke: increments session_version once', (revoke.match(/session_version = session_version \+ 1/g) || []).length === 1);
assert('revoke: does NOT touch pin_hash/active/failed_count/locked_until in SET',
  !/SET[\s\S]*?(pin_hash|active|failed_count|locked_until)/.test(revoke.slice(revoke.indexOf('UPDATE public.auth_actors'), revoke.indexOf('RETURNING'))));
assert('revoke: audits revoke', /VALUES \('revoke', p_target_actor, p_by_actor, p_ip_hash, v_meta\)/.test(revoke));

// ── (13)(21..24) SET ACTIVE specifics ────────────────────────────────────────
assert('active: self-disable forbidden (by=target & active=false)',
  /p_by_actor = p_target_actor AND p_active = false[\s\S]*?AUTH_SELF_DISABLE_FORBIDDEN/.test(setActive));
assert('active: same-state no-op returns changed=false',
  /v_tgt\.active = p_active THEN[\s\S]*?'changed', false/.test(setActive));
assert('active: no-op path does NOT increment sv or audit (single sv bump total in fn)',
  (setActive.match(/session_version = session_version \+ 1/g) || []).length === 1 &&
  (setActive.match(/INSERT INTO public\.auth_audit/g) || []).length === 1);
assert('active: real change increments sv exactly once (covers BOTH enable and disable)',
  /UPDATE public\.auth_actors[\s\S]*?active = p_active, session_version = session_version \+ 1/.test(setActive));
assert('active: event derived actor_enabled (enable) / actor_disabled (disable)',
  /p_active THEN 'actor_enabled' ELSE 'actor_disabled'/.test(setActive));
assert('active: preserves pin_hash/failed_count/locked_until (not in SET)',
  !/SET[\s\S]*?(pin_hash|failed_count|locked_until)/.test(setActive.slice(setActive.indexOf('UPDATE public.auth_actors'), setActive.indexOf('RETURNING'))));

// ── (25)(26)(27) UNLOCK specifics ────────────────────────────────────────────
assert('unlock: already-unlocked no-op returns changed=false',
  /v_tgt\.failed_count = 0 AND v_tgt\.locked_until IS NULL THEN[\s\S]*?'changed', false/.test(unlock));
assert('unlock: real reset sets failed_count=0, locked_until=NULL', /SET failed_count = 0, locked_until = NULL/.test(unlock));
assert('unlock: writes actor_unlocked', /VALUES \('actor_unlocked', p_target_actor, p_by_actor, p_ip_hash, v_meta\)/.test(unlock));
assert('unlock: does NOT change session_version (no bump anywhere)', !/session_version = session_version \+ 1/.test(unlock));
assert('unlock: preserves pin_hash/active (not in SET)',
  !/SET[\s\S]*?(pin_hash|active)/.test(unlock.slice(unlock.indexOf('UPDATE public.auth_actors'), unlock.indexOf('RETURNING'))));
assert('unlock: does NOT revoke sessions (no revoke audit)', !/VALUES \('revoke'/.test(unlock));

// ── (32) rollback drops ONLY the four functions ──────────────────────────────
assert('rollback drops exactly the four B6 RPCs', (RB_NC.match(/DROP FUNCTION IF EXISTS public\.auth_admin_/g) || []).length === 4);
assert('rollback: no other DROP FUNCTION', (RB_NC.match(/DROP FUNCTION/g) || []).length === 4);
assert('rollback: touches NO table/data/constraint/audit', !/DROP TABLE/i.test(RB_NC) && !/ALTER TABLE/i.test(RB_NC) && !/DELETE\b/i.test(RB_NC) && !/UPDATE\s+public\./i.test(RB_NC) && !/DROP CONSTRAINT/i.test(RB_NC));
assert('rollback: does NOT drop frozen B2/B5 functions', !/DROP FUNCTION IF EXISTS public\.auth_(set_pin_hash|bump_session_version|set_active|consume_recovery_window)\b/.test(RB_NC));

// ── forward migration additivity: no table/constraint/existing-RPC change ────
assert('forward: NO CREATE/ALTER TABLE', !/CREATE TABLE/i.test(SQL_NC) && !/ALTER TABLE/i.test(SQL_NC));
assert('forward: NO audit event-constraint change', !/auth_audit_event_chk/.test(SQL_NC));
assert('forward: NO RLS/policy change', !/ROW LEVEL SECURITY/i.test(SQL_NC) && !/CREATE POLICY/i.test(SQL_NC));

// ── doc references the actual filenames ──────────────────────────────────────
const DOC = read('docs/access-control/B6_ADMIN_ACCESS_MANAGEMENT_CONTRACT.md');
assert('doc references forward migration filename', DOC.includes('migrations/' + FWD));
assert('doc references rollback filename', DOC.includes('migrations/' + RB));

// ── (34) migration is not executed by tests (no DB driver / query) ───────────
assert('test does not import a DB client or run queries', (() => {
  const self = read('tests/authAdminAccessManagementMigration.test.js');
  return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self);
})());

// ── NEGATIVE CONTROLS: prove the assertions actually catch defects ───────────
// Each mutates real SQL to inject a defect and asserts the corresponding detector flips.
(function negativeControls() {
  // NC1: missing sv bump on enable — remove the sv increment from set_active UPDATE
  const brokenActive = setActive.replace('active = p_active, session_version = session_version + 1', 'active = p_active');
  assert('NC1: detector catches missing sv bump on real active change',
    !/UPDATE public\.auth_actors[\s\S]*?active = p_active, session_version = session_version \+ 1/.test(brokenActive));
  // NC2: missing self-disable guard
  const noSelfDisable = setActive.replace(/p_by_actor = p_target_actor AND p_active = false[\s\S]*?AUTH_SELF_DISABLE_FORBIDDEN' USING ERRCODE='22023'; END IF;/, '');
  assert('NC2: detector catches missing self-disable guard',
    !/p_by_actor = p_target_actor AND p_active = false[\s\S]*?AUTH_SELF_DISABLE_FORBIDDEN/.test(noSelfDisable));
  // NC3: missing actor_unlocked
  const noUnlockEvent = unlock.replace("VALUES ('actor_unlocked'", "VALUES ('revoke'");
  assert('NC3: detector catches missing actor_unlocked write',
    !/VALUES \('actor_unlocked', p_target_actor, p_by_actor, p_ip_hash, v_meta\)/.test(noUnlockEvent));
  // NC4: unexpected fifth RPC
  const withFifth = SQL_NC + '\nCREATE OR REPLACE FUNCTION public.auth_admin_delete_actor() RETURNS void LANGUAGE sql AS $$ $$;';
  const fifth = (withFifth.match(/CREATE OR REPLACE FUNCTION public\.(auth_admin_[a-z_]+)/g) || []);
  assert('NC4: detector catches an unexpected fifth management RPC', fifth.length === 5);
  // NC5: unsafe grant
  const unsafeGrant = SQL_NC + '\nGRANT EXECUTE ON FUNCTION public.auth_admin_unlock_actor(text,text,text,text,jsonb) TO authenticated;';
  assert('NC5: detector catches an unsafe GRANT to authenticated', /GRANT[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(unsafeGrant));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
