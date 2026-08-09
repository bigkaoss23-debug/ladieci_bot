'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.3 — static test over the incident-policy
// migration SQL text itself, same convention as tests/
// serviceLifecycleV3CloseOwnershipHardening.static.test.js (no live Postgres
// mutation here — the real-Postgres empirical validation of the overload/
// replace question this migration exists to fix is documented in this
// session's own recovery report, run as synthetic scratch-function probes
// against staging inside BEGIN/ROLLBACK, never against create_service_
// closeout itself).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_incident_policy.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_incident_policy.ROLLBACK.sql');

const OLD_SIG = 'uuid, uuid, text, text, text,\n  integer, integer, integer, integer, integer, integer, integer,\n  integer, integer, integer, integer, integer, integer';
const OLD_SIG_FLAT = 'uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer';
const NEW_SIG_FLAT = OLD_SIG_FLAT + ',integer,integer,integer,integer,integer';

(async () => {
  console.log('\n== service lifecycle v3 incident policy (Slice 3.3) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists (was missing from the interrupted WIP — added during recovery)', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const rollbackWithoutComments = rollback.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: forward wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: rollback wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback));
  assert('1c: staging sentinel guard present (forward)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1d: staging sentinel guard present (rollback)', rollback.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1e: requires row 59 (close ownership hardening marker) applied first', sql.includes('v3_close_authorized_session_id'));
  assert('1f: requires create_service_incident already present (row 53)', sql.includes('create_service_incident'));
  assert('1g: requires mesa_release_empty_session_auto_v1 already present (row 56)', sql.includes('mesa_release_empty_session_auto_v1'));

  console.log('\n── the ONE deliberate DROP FUNCTION — proven necessary, not incidental ──');
  const dropMatches = [...sqlWithoutComments.matchAll(/DROP\s+FUNCTION\s+public\.(\w+)\(/gi)];
  assert('2a: exactly one DROP FUNCTION statement in the whole forward migration', dropMatches.length === 1, JSON.stringify(dropMatches.map((m) => m[0])));
  assert('2b: it targets create_service_closeout (the only signature change in this migration)', dropMatches[0] && dropMatches[0][1] === 'create_service_closeout');
  assert('2c: the DROP uses the exact proven-present 18-parameter OLD signature', sql.includes('DROP FUNCTION public.create_service_closeout(\n  ' + OLD_SIG + '\n);'));

  console.log('\n── no OTHER destructive statement anywhere ──');
  const otherDestructive = [/DROP\s+TABLE/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i, /ALTER\s+TABLE/i];
  for (const re of otherDestructive) {
    assert('3: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }

  console.log('\n── predecessor-body guard: refuses over drift or a double-patch ──');
  assert('4a: guard checks the 18-parameter identity-arguments string exactly', sql.includes('p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_close_reason text'));
  assert('4b: guard refuses if body not found (drift)', sql.includes('body not found'));
  assert('4c: guard refuses if already patched (p_kitchen_pending_count already present)', sql.includes('already references p_kitchen_pending_count'));

  console.log('\n── new function: correct new signature, correct grants ──');
  assert('5a: CREATE FUNCTION (not CREATE OR REPLACE) immediately follows the DROP — this IS the single-overload fix', /DROP FUNCTION public\.create_service_closeout\([\s\S]{0,200}\);\s*\n\s*\nCREATE FUNCTION public\.create_service_closeout\(/.test(sql));
  assert('5b: five new trailing params, all DEFAULT 0', /p_kitchen_pending_count\s+integer DEFAULT 0/.test(sql)
    && /p_listo_count\s+integer DEFAULT 0/.test(sql)
    && /p_delivery_pending_count\s+integer DEFAULT 0/.test(sql)
    && /p_incident_count\s+integer DEFAULT 0/.test(sql)
    && /p_critical_incident_count\s+integer DEFAULT 0/.test(sql));
  assert('5c: INSERT list includes all five new columns', /kitchen_pending_count, listo_count, delivery_pending_count,\s*\n\s*incident_count, critical_incident_count/.test(sql));
  const revokeCount = (sqlWithoutComments.match(/REVOKE ALL ON FUNCTION public\.create_service_closeout/g) || []).length;
  const grantCount = (sqlWithoutComments.match(/GRANT EXECUTE ON FUNCTION public\.create_service_closeout/g) || []).length;
  assert('5d: exactly one REVOKE ALL + one GRANT EXECUTE for the new signature (grants do not survive a DROP, must be re-issued)', revokeCount === 1 && grantCount === 1, `revoke=${revokeCount} grant=${grantCount}`);
  assert('5e: grant target is service_role only', /GRANT EXECUTE ON FUNCTION public\.create_service_closeout\([\s\S]{0,300}\) TO service_role;/.test(sql));
  assert('5f: REVOKE precedes GRANT, both target PUBLIC/anon/authenticated correctly on revoke', /REVOKE ALL ON FUNCTION public\.create_service_closeout\([\s\S]{0,300}\) FROM PUBLIC, anon, authenticated;[\s\S]{0,50}GRANT EXECUTE/.test(sql));

  console.log('\n── rollback is a clean, symmetric mirror (DROP the new, restore the old) ──');
  const rollbackDrops = [...rollbackWithoutComments.matchAll(/DROP\s+FUNCTION\s+public\.(\w+)\(/gi)];
  assert('6a: rollback has exactly one DROP FUNCTION, targeting create_service_closeout', rollbackDrops.length === 1 && rollbackDrops[0][1] === 'create_service_closeout');
  assert('6b: rollback DROPs the NEW 23-parameter signature (not the old one — nothing to drop the old one for for)', rollback.includes('DROP FUNCTION public.create_service_closeout(\n  ' + OLD_SIG + ',\n  integer, integer, integer, integer, integer\n);'));
  assert('6c: rollback restores a create/replace of the exact original 18-parameter signature', /CREATE FUNCTION public\.create_service_closeout\(\s*\n\s*p_service_session_id\s+uuid,[\s\S]{0,700}p_occupied_tables_at_close integer\s*\n\) RETURNS jsonb/.test(rollback));
  assert('6d: rollback restored body has no incident-aggregate columns (byte-restored row-58 shape)', !rollback.includes('kitchen_pending_count'));
  assert('6e: rollback re-grants EXECUTE on the restored 18-parameter signature to service_role only', /GRANT EXECUTE ON FUNCTION public\.create_service_closeout\(\s*uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer\s*\) TO service_role;/.test(rollback));
  for (const re of otherDestructive) {
    assert('6f: rollback contains no ' + re + ' either', !re.test(rollbackWithoutComments));
  }
  assert('6g: rollback touches no table other than create_service_closeout (no service_incidents/snapshot/mesa change)', !/service_incidents|service_closeout_snapshots|mesa_release_empty_session/.test(rollbackWithoutComments));

  console.log('\n── signature arithmetic sanity (guards against a silent param-count typo) ──');
  assert('7a: old signature is 18 params', OLD_SIG_FLAT.split(',').length === 18);
  assert('7b: new signature is 23 params (18 + 5)', NEW_SIG_FLAT.split(',').length === 23);
  const dropParamCount = sqlWithoutComments.match(/DROP FUNCTION public\.create_service_closeout\(([^;]*?)\);/s)[1].split(',').map((s) => s.trim()).filter(Boolean).length;
  assert('7c: the forward DROP targets exactly 18 params', dropParamCount === 18, String(dropParamCount));
  const rollbackDropParamCount = rollbackWithoutComments.match(/DROP FUNCTION public\.create_service_closeout\(([^;]*?)\);/s)[1].split(',').map((s) => s.trim()).filter(Boolean).length;
  assert('7d: the rollback DROP targets exactly 23 params', rollbackDropParamCount === 23, String(rollbackDropParamCount));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
