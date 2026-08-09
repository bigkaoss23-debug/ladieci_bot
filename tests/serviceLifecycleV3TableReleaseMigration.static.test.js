'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.4 — static test over the new table-release
// migration, the Gate-0 fix for row 60's proven dependency on retired row 56.
// Real-Postgres validation (rows 57->58->59->this->60 applying cleanly end to
// end, with zero residue after ROLLBACK) is documented in this session's own
// report, not repeated here — this file only proves the SQL text's shape.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_table_release.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_table_release.ROLLBACK.sql');
const ROW56_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_closeout_cross_service_table_policy.sql');
const ROW60_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_incident_policy.sql');

(async () => {
  console.log('\n== service lifecycle v3 table release (Slice 3.4 Gate-0 fix) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const row56 = fs.readFileSync(ROW56_PATH, 'utf8');
  const row60 = fs.readFileSync(ROW60_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: forward wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: rollback wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback));
  assert('1c: staging sentinel guard present (forward)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1d: staging sentinel guard present (rollback)', rollback.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1e: refuses if function already exists (drift guard)', sql.includes('already exists — resolve drift first'));

  console.log('\n── ZERO dependency on retired row 56 ──');
  assert('2a: forward migration never references the row-56 filename', !sql.includes('cross_service_table_policy'));
  assert('2b: forward migration never checks for begin_service_session_close/supersede_closeout_attempt (row 56-only objects)', !/begin_service_session_close|supersede_closeout_attempt/.test(sqlWithoutComments));
  assert('2c: forward migration does not touch guard_service_session_closed_v1', !sqlWithoutComments.includes('guard_service_session_closed_v1'));

  console.log('\n── no destructive statement anywhere ──');
  const destructive = [/DROP\s+TABLE/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i, /ALTER\s+TABLE/i];
  for (const re of destructive) {
    assert('3: forward migration contains no ' + re, !re.test(sqlWithoutComments));
  }

  console.log('\n── function body is byte-identical to row 56\'s PART 3 (verbatim extraction, not a rewrite) ──');
  const extractFn = (src, name) => {
    const start = src.indexOf(`CREATE FUNCTION public.${name}(`);
    const startOr = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const i = start !== -1 ? start : startOr;
    if (i === -1) return null;
    const bodyStart = src.indexOf('BEGIN', i);
    const bodyEnd = src.indexOf('$function$;', bodyStart);
    return src.slice(bodyStart, bodyEnd).trim();
  };
  const row56Body = extractFn(row56, 'mesa_release_empty_session_auto_v1');
  const newBody = extractFn(sql, 'mesa_release_empty_session_auto_v1');
  assert('4a: row 56 body extracted successfully (sanity check on the extractor)', !!row56Body && row56Body.length > 100);
  assert('4b: new migration body extracted successfully', !!newBody && newBody.length > 100);
  assert('4c: bodies are byte-identical', row56Body === newBody, 'lengths: row56=' + (row56Body || '').length + ' new=' + (newBody || '').length);

  console.log('\n── grants: service_role-only, same shape as row 56 ──');
  assert('5a: REVOKE ALL FROM PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.mesa_release_empty_session_auto_v1\(uuid,uuid\) FROM PUBLIC, anon, authenticated;/.test(sql));
  assert('5b: GRANT EXECUTE TO service_role only', /GRANT EXECUTE ON FUNCTION public\.mesa_release_empty_session_auto_v1\(uuid,uuid\) TO service_role;/.test(sql));

  console.log('\n── rollback is a clean, minimal mirror ──');
  assert('6a: rollback drops exactly the one function', /DROP FUNCTION public\.mesa_release_empty_session_auto_v1\(uuid,uuid\);/.test(rollback));
  const rollbackDrops = [...rollback.matchAll(/DROP\s+FUNCTION/gi)];
  assert('6b: rollback has exactly one DROP FUNCTION', rollbackDrops.length === 1);
  for (const re of destructive) {
    assert('6c: rollback contains no ' + re + ' either', !re.test(rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')));
  }

  console.log('\n── row 60 now points here instead of row 56 ──');
  assert('7a: row 60 guard error message references this migration\'s filename', row60.includes('apply 2026-08-09_service_lifecycle_v3_table_release first'));
  assert('7b: row 60 guard no longer tells the operator to apply the retired row-56 migration', !row60.includes('apply 2026-08-09_service_closeout_cross_service_table_policy first'));
  assert('7c: row 60\'s dependency check itself is unchanged (still a plain to_regprocedure existence check)', row60.includes("to_regprocedure('public.mesa_release_empty_session_auto_v1(uuid,uuid)') IS NULL"));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
