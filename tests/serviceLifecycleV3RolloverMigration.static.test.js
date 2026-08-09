'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.4 — static test over the rollover migration
// SQL text itself. Real-Postgres validation (idempotent-reuse, lineage
// check, current-already-set, the shadow-table proof of the create+conflict
// path, and the post-boundary order-attribution trigger proof) is documented
// in this session's own report, not repeated here.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_rollover.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_rollover.ROLLBACK.sql');

(async () => {
  console.log('\n== service lifecycle v3 rollover (Slice 3.4) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const sqlNoComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const rollbackNoComments = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: forward wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: rollback wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback));
  assert('1c: staging sentinel guard present (forward)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1d: staging sentinel guard present (rollback)', rollback.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1e: requires row 58 (close engine) applied first', sql.includes("to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL"));
  assert('1f: requires row 59 (ownership hardening marker) applied first', sql.includes('v3_close_authorized_session_id'));
  assert('1g: refuses if the column already exists (drift guard)', sql.includes('rollover_source_session_id already exists'));
  assert('1h: refuses if the RPC already exists (drift guard)', sql.includes('ensure_next_service_session_v3(uuid,text,date,text,text)\') IS NOT NULL'));

  console.log('\n── additive only — no destructive statement, no DROP of anything pre-existing ──');
  const destructive = [/DROP\s+TABLE/i, /DROP\s+FUNCTION/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i];
  for (const re of destructive) {
    assert('2: forward migration contains no ' + re, !re.test(sqlNoComments));
  }
  assert('2a: exactly one ALTER TABLE (the new column)', (sqlNoComments.match(/ALTER TABLE/gi) || []).length === 1);
  assert('2b: the ALTER TABLE only ADDs a column, never drops/alters an existing one', /ALTER TABLE public\.service_sessions\s*\n\s*ADD COLUMN rollover_source_session_id/.test(sql));

  console.log('\n── the new column: nullable, FK, own partial unique index ──');
  assert('3a: column is nullable (no NOT NULL)', !/rollover_source_session_id uuid REFERENCES[^,;]*NOT NULL/.test(sqlNoComments));
  assert('3b: FK references service_sessions(id) ON DELETE RESTRICT', /rollover_source_session_id uuid REFERENCES public\.service_sessions\(id\) ON DELETE RESTRICT/.test(sql));
  assert('3c: partial unique index on the new column, WHERE NOT NULL', /CREATE UNIQUE INDEX service_sessions_rollover_source_uq\s*\n\s*ON public\.service_sessions\(rollover_source_session_id\)\s*\n\s*WHERE rollover_source_session_id IS NOT NULL;/.test(sql));

  console.log('\n── the new RPC: correct signature, idempotency-first ordering, lineage + current-pointer guards ──');
  assert('4a: CREATE FUNCTION (not CREATE OR REPLACE — this is a brand new RPC, guarded above to refuse if it already exists)', /CREATE FUNCTION public\.ensure_next_service_session_v3\(/.test(sql));
  assert('4b: five parameters in the documented order', /p_source_session_id uuid,\s*\n\s*p_service_kind\s+text,\s*\n\s*p_business_date\s+date,\s*\n\s*p_opened_by\s+text,\s*\n\s*p_source\s+text/.test(sql));
  assert('4c: idempotent-reuse-by-provenance check appears BEFORE the advisory lock (checked once unlocked, once locked)', (() => {
    const lockIdx = sql.indexOf('pg_advisory_xact_lock');
    const firstProvenanceIdx = sql.indexOf('rollover_source_session_id = p_source_session_id');
    return firstProvenanceIdx !== -1 && lockIdx !== -1 && firstProvenanceIdx < lockIdx;
  })());
  assert('4d: lineage check — source must be recent_closed_session_id', sql.includes('ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED') && sql.includes('v_state.recent_closed_session_id IS DISTINCT FROM p_source_session_id'));
  assert('4e: current-pointer check — refuses if current_session_id already set', sql.includes('CURRENT_SESSION_ALREADY_SET') && sql.includes('v_state.current_session_id IS NOT NULL'));
  assert('4f: defensive MULTIPLE_ACTIVE_SERVICE_SESSIONS backstop present', sql.includes('MULTIPLE_ACTIVE_SERVICE_SESSIONS'));
  assert('4g: INSERT sets rollover_source_session_id to the source (provenance recorded at creation)', /INSERT INTO public\.service_sessions\(\s*\n\s*business_date, status, opened_by, open_source, service_kind, rollover_source_session_id\s*\n\s*\) VALUES \(\s*\n\s*p_business_date, 'open', p_opened_by, p_source, p_service_kind, p_source_session_id/.test(sql));
  assert('4h: ON CONFLICT targets the existing (business_date, service_kind) unique index, not a new one', /ON CONFLICT \(business_date, service_kind\) WHERE service_kind IS NOT NULL/.test(sql));
  assert('4i: on conflict, re-verifies provenance before claiming REUSED — never silently claims an unrelated session as B', sql.includes('NEXT_SERVICE_IDENTITY_CONFLICT') && sql.includes('v_session.rollover_source_session_id IS DISTINCT FROM p_source_session_id'));
  assert('4j: updates current_session_id only inside the FOUND (created) branch', /IF FOUND THEN\s*\n\s*UPDATE public\.service_session_state\s*\n\s*SET current_session_id = v_session\.id/.test(sql));
  assert('4k: writes a service_session_audit row on real creation', sql.includes("INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)") && /VALUES \(v_session\.id, 'opened', p_opened_by, p_source\)/.test(sql));

  console.log('\n── input validation ──');
  for (const code of ['INVALID_ARGUMENTS', 'INVALID_SERVICE_KIND', 'INVALID_BUSINESS_DATE', 'INVALID_ACTOR', 'INVALID_SOURCE']) {
    assert('5: validation code ' + code + ' present', sql.includes(code));
  }

  console.log('\n── grants: service_role only ──');
  assert('6a: REVOKE ALL FROM PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.ensure_next_service_session_v3\(uuid,text,date,text,text\) FROM PUBLIC, anon, authenticated;/.test(sql));
  assert('6b: GRANT EXECUTE TO service_role only', /GRANT EXECUTE ON FUNCTION public\.ensure_next_service_session_v3\(uuid,text,date,text,text\) TO service_role;/.test(sql));

  console.log('\n── zero legacy coupling ──');
  // language-guard: allow-legacy chiudiServizio/storico/serata_summary are the exact forbidden identifiers this test asserts are ABSENT from the migration, not new vocabulary being introduced
  const forbidden = [/chiudiServizio/i, /begin_service_session_close/i, /\bstorico\b/i, /serata_summary/i, /scheduleDeferredCloseRetry/i, /mesa_release_empty_session_v1\(/, /supersede_closeout_attempt/i, /ensure_service_session\(/];
  for (const re of forbidden) {
    assert('7: forward migration references none of ' + re, !re.test(sqlNoComments));
  }
  assert('7a: does not reference retired row 56\'s filename', !sql.includes('cross_service_table_policy'));

  console.log('\n── rollback is a clean, minimal mirror ──');
  assert('8a: rollback drops the RPC', /DROP FUNCTION IF EXISTS public\.ensure_next_service_session_v3\(uuid,text,date,text,text\);/.test(rollback));
  assert('8b: rollback drops the partial unique index', /DROP INDEX IF EXISTS public\.service_sessions_rollover_source_uq;/.test(rollback));
  assert('8c: rollback drops the column', /ALTER TABLE public\.service_sessions DROP COLUMN IF EXISTS rollover_source_session_id;/.test(rollback));
  assert('8d: rollback touches no other table/column', !/service_closeouts|service_incidents|table_sessions|ordenes\b/.test(rollbackNoComments));
  for (const re of destructive.filter((r) => r.source !== 'DROP\\s+FUNCTION')) {
    assert('8e: rollback contains no ' + re + ' beyond its own documented drops', !re.test(rollbackNoComments));
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
