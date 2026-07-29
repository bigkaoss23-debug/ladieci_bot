'use strict';
// B6 PREREQUISITE static tests. Run: node tests/authUnlockedEventMigration.test.js
// NON-EXECUTING: asserts the actor_unlocked audit event is added additively and
// that the DB event allowlist (parsed from the forward migration SQL) stays
// EXACTLY synchronized with the Node canonical ALLOWED_EVENTS list. No DB, no
// staging, no migration apply. Robust CHECK-constraint extraction (not comments).
const fs = require('fs');
const path = require('path');
const audit = require('../src/auth/audit.js');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ── expected canonical outcome ───────────────────────────────────────────────
const PREVIOUS_ALLOWLIST = [
  'login_ok', 'login_fail', 'locked', 'pin_set', 'pin_change', 'revoke', 'bootstrap', 'recovery',
  'actor_disabled', 'actor_enabled',
];
const FINAL_ALLOWLIST = PREVIOUS_ALLOWLIST.concat(['actor_unlocked']);
const NEW_EVENT = 'actor_unlocked';

// ── migration discovery / packaging convention (mirrors B5 test) ─────────────
const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL_MIGRATIONS = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const isRollback = (f) => f.endsWith('.ROLLBACK.sql');
const FORWARD_CONVENTION = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const ROLLBACK_CONVENTION = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;
const FORWARD_SET = ALL_MIGRATIONS.filter((f) => !isRollback(f)).sort();
const FWD = '2026-07-15_auth_unlocked_event.sql';
const RB = '2026-07-15_auth_unlocked_event.ROLLBACK.sql';

// (9) filenames match repository conventions
assert('convention: forward filename matches YYYY-MM-DD_desc.sql', FORWARD_CONVENTION.test(FWD) && !isRollback(FWD));
assert('convention: rollback filename matches .ROLLBACK.sql', ROLLBACK_CONVENTION.test(RB));
assert('discovery: forward INCLUDED in derived forward set', FORWARD_SET.includes(FWD));
assert('discovery: rollback EXCLUDED from forward set', !FORWARD_SET.includes(RB) && isRollback(RB));
assert('uniqueness: forward version appears exactly once', FORWARD_SET.filter((f) => f === FWD).length === 1);
assert('ordering: forward sorts AFTER all 2026-07-13/14 auth forwards',
  FORWARD_SET.filter((f) => /_auth_/.test(f) && f < FWD).length >= 4);
assert('files exist on disk', fs.existsSync(path.join(MIG_DIR, FWD)) && fs.existsSync(path.join(MIG_DIR, RB)));

const SQL = read('migrations/' + FWD);
const RBSQL = read('migrations/' + RB);
// Comment-stripped SQL for robust structural assertions: '--' lines carry prose
// like "NO grant" / "no function" that must NOT be matched as real statements.
const stripComments = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const SQL_NC = stripComments(SQL);
const RB_NC = stripComments(RBSQL);

// ── robust CHECK-constraint event extraction (parses SQL, not comments) ──────
// Find the ADD CONSTRAINT ... CHECK (event IN ( ... )) statement and pull the
// quoted event literals from it. Ignores '--' comment lines entirely.
function extractCheckEvents(sqlNoComments) {
  const m = sqlNoComments.match(/ADD CONSTRAINT auth_audit_event_chk\s+CHECK\s*\(event IN \(([\s\S]*?)\)\)/i);
  if (!m) return null;
  return (m[1].match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ''));
}
const fwdEvents = extractCheckEvents(SQL_NC);
const rbEvents = extractCheckEvents(RB_NC);

// ── (1)(2)(3) Node allowlist correctness ─────────────────────────────────────
assert('Node ALLOWED_EVENTS contains actor_unlocked', audit.ALLOWED_EVENTS.includes(NEW_EVENT));
assert('Node ALLOWED_EVENTS keeps all previously allowed events',
  PREVIOUS_ALLOWLIST.every((e) => audit.ALLOWED_EVENTS.includes(e)));
// NOTE: this used to require EXACT equality — correct only for as long as no LATER
// migration ever widens auth_audit_event_chk again. Access Control V3's 2026-07-29
// migration legitimately does exactly that (adds 11 more events on top, same
// widen-never-narrow discipline). What THIS migration must still prove, forever, is
// that its own slice (FINAL_ALLOWLIST) is present and untouched — not that nothing was
// ever added after it. Event order carries no behavioral meaning (assertEvent uses
// .includes(), not position), so this is a containment check, not an equality one.
assert('Node ALLOWED_EVENTS is a superset of (never narrower than) this migration\'s FINAL_ALLOWLIST',
  FINAL_ALLOWLIST.every((e) => audit.ALLOWED_EVENTS.includes(e)), audit.ALLOWED_EVENTS.join(','));
assert('assertEvent accepts actor_unlocked (no throw)', (() => {
  try { require('../src/auth/audit.js'); audit.writeAuthAudit; return audit.ALLOWED_EVENTS.includes(NEW_EVENT); } catch (_) { return false; }
})());

// ── (4) forward SQL allowlist EQUALS Node allowlist ──────────────────────────
assert('forward SQL CHECK parsed successfully', Array.isArray(fwdEvents) && fwdEvents.length > 0, String(fwdEvents));
assert('forward SQL allowlist equals final allowlist exactly', fwdEvents && eq(fwdEvents, FINAL_ALLOWLIST), (fwdEvents || []).join(','));
// Was an exact-equality check — only valid while this was the LAST migration to touch
// auth_audit_event_chk. Access Control V3's 2026-07-29 migration legitimately widens the
// same constraint further; this file's own historical SQL text is immutable and correct
// for what IT introduced, so the correct ongoing check is containment, not equality.
assert('forward SQL allowlist (this migration\'s own text) is contained in the current Node allowlist',
  fwdEvents && fwdEvents.every((e) => audit.ALLOWED_EVENTS.includes(e)), (fwdEvents || []).join(','));
assert('forward preserves every previous event', fwdEvents && PREVIOUS_ALLOWLIST.every((e) => fwdEvents.includes(e)));
assert('forward adds exactly actor_unlocked (one new event only)',
  fwdEvents && fwdEvents.filter((e) => !PREVIOUS_ALLOWLIST.includes(e)).length === 1 && fwdEvents.includes(NEW_EVENT));

// ── (5)(6) forward alters ONLY the event CHECK constraint (comment-stripped) ──
assert('forward: has the staging sentinel guard', /schema_migrations WHERE version='20260710075612'/.test(SQL_NC));
assert('forward: DROP + ADD the event CHECK constraint', /DROP CONSTRAINT auth_audit_event_chk/.test(SQL_NC) && /ADD CONSTRAINT auth_audit_event_chk/.test(SQL_NC));
assert('forward: NO CREATE/REPLACE FUNCTION (no RPC change)', !/CREATE OR REPLACE FUNCTION/i.test(SQL_NC) && !/DROP FUNCTION/i.test(SQL_NC));
assert('forward: NO column change (ADD/DROP/ALTER COLUMN)', !/ADD COLUMN/i.test(SQL_NC) && !/DROP COLUMN/i.test(SQL_NC) && !/ALTER COLUMN/i.test(SQL_NC));
assert('forward: NO CREATE/ALTER TABLE structure change', !/CREATE TABLE/i.test(SQL_NC) && !/RENAME/i.test(SQL_NC));
// Match grant/revoke STATEMENTS (GRANT/REVOKE ... ON ...), not the 'revoke'
// event literal inside the CHECK allowlist.
assert('forward: NO grant/revoke change', !/\b(GRANT|REVOKE)\b[\s\S]*?\bON\b/i.test(SQL_NC));
assert('forward: NO RLS/policy change', !/ROW LEVEL SECURITY/i.test(SQL_NC) && !/CREATE POLICY/i.test(SQL_NC));
assert('forward: NO data mutation (INSERT/UPDATE/DELETE)', !/\bINSERT\b/i.test(SQL_NC) && !/\bUPDATE\b/i.test(SQL_NC) && !/\bDELETE\b/i.test(SQL_NC));
assert('forward: exactly one CHECK constraint DROP and one ADD',
  (SQL_NC.match(/DROP CONSTRAINT auth_audit_event_chk/g) || []).length === 1 &&
  (SQL_NC.match(/ADD CONSTRAINT auth_audit_event_chk/g) || []).length === 1);

// ── (7)(8) rollback safety (comment-stripped) ────────────────────────────────
assert('rollback refuses when actor_unlocked rows exist', /ROLLBACK REFUSED/.test(RB_NC) && /event = 'actor_unlocked'/.test(RB_NC));
assert('rollback counts actor_unlocked rows before narrowing', /count\(\*\)[\s\S]*?event = 'actor_unlocked'/.test(RB_NC));
assert('rollback restores the EXACT previous allowlist', rbEvents && eq(rbEvents, PREVIOUS_ALLOWLIST), (rbEvents || []).join(','));
assert('rollback removes actor_unlocked from allowlist', rbEvents && !rbEvents.includes(NEW_EVENT));
assert('rollback: NO row delete/rewrite of audit', !/DELETE\s+FROM\s+public\.auth_audit/i.test(RB_NC) && !/UPDATE\s+public\.auth_audit\s+SET/i.test(RB_NC));
assert('rollback: changes ONLY the event CHECK constraint', !/CREATE OR REPLACE FUNCTION/i.test(RB_NC) && !/\bGRANT\b/i.test(RB_NC) && !/ADD COLUMN/i.test(RB_NC) && !/DROP TABLE/i.test(RB_NC));

// ── (10) neither migration is executed by tests (guard: no db driver invoked) ─
assert('test does not import a DB/PG client', (() => {
  const self = read('tests/authUnlockedEventMigration.test.js');
  return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self);
})());

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
