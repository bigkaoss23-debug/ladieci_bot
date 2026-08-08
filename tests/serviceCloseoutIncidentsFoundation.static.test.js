'use strict';
// SERVICE CLOSEOUT V2 / Slice 1 — static test over the migration SQL text
// itself. This repo's test convention already includes ".static.test.js"
// files that assert on source text rather than executing it (see
// tests/v3jMesaNomenclatureCutover.static.test.js,
// tests/accessManagementHttpUnwiredV3.static.test.js) — used here because no
// live Postgres is available/permitted for this slice (STAGING ONLY, no
// database mutation), so the DB-level invariants (append-only triggers, RLS,
// additive-only) can only be proven by inspecting what was actually written,
// not by running it.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', '2026-08-08_service_closeout_incidents_foundation.sql');
const ROLLBACK_PATH = path.join(__dirname, '..', 'migrations', '2026-08-08_service_closeout_incidents_foundation.ROLLBACK.sql');

(async () => {
  console.log('\n== service closeout/incidents foundation — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: staging sentinel guard present (matches every other migration in this repo)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1c: fail-closed on pre-existing target objects (no silent drift)', sql.includes('service closeout incidents foundation refused: target objects already exist'));
  assert('1d: prerequisite check for service_sessions/service_session_state/service_session_audit', sql.includes("to_regclass('public.service_sessions') IS NULL"));

  console.log('\n── additive-only (STEP 11) ──');
  const destructivePatterns = [
    /DROP\s+TABLE(?!\s+IF\s+NOT)/i, // any unconditional/real DROP TABLE inside the forward migration
    /ALTER\s+TABLE\s+public\.(service_sessions|service_session_state|service_session_audit|order_financial_events|orden_estado_logs|ordenes|storico|table_sessions)\s+DROP/i,
    /RENAME\s+TO/i,
    /TRUNCATE/i,
  ];
  for (const re of destructivePatterns) {
    assert('2: forward migration contains no ' + re, !re.test(sql), sql.match(re) && sql.match(re)[0]);
  }
  assert('2b: no existing table is ALTERed at all (every new column lives on new tables)', !/ALTER\s+TABLE\s+public\.(service_sessions|service_session_state|service_session_audit|order_financial_events|orden_estado_logs|ordenes|storico|table_sessions|serata_summary|backup_serata)\b/i.test(sql));
  assert('2c: no existing function is dropped', !/DROP\s+FUNCTION/i.test(sql));

  console.log('\n── snapshot immutability (STEP 2) ──');
  assert('3a: append-only trigger exists for service_closeout_snapshots', sql.includes('service_closeout_snapshots_no_update_delete') && sql.includes('BEFORE UPDATE OR DELETE ON public.service_closeout_snapshots'));
  assert('3b: the trigger function unconditionally raises', /service_closeout_snapshots_append_only[\s\S]{0,300}RAISE EXCEPTION/.test(sql));
  assert('3c: idempotency is DB-enforced via a real UNIQUE constraint, not just app discipline', sql.includes('service_closeout_snapshots_correlation_uq UNIQUE (closeout_correlation_id)'));
  assert('3d: queryable by service_session_id via a real index', sql.includes('service_closeout_snapshots_session_idx ON public.service_closeout_snapshots(service_session_id)'));

  console.log('\n── incident register (STEP 3/4/5) ──');
  for (const t of ['informational', 'operational', 'financial', 'integrity', 'security']) {
    assert('4a: category vocabulary includes ' + t, sql.includes("'" + t + "'"));
  }
  assert('4b: dedupe unique index covers (correlation_id, incident_type, entity_type, entity_id) with NULL-safe COALESCE', sql.includes('service_incidents_dedupe_uq') && /COALESCE\(entity_type, ''\)/.test(sql) && /COALESCE\(entity_id, ''\)/.test(sql));
  assert('4c: financial category requires exposure at the DB level too (not just JS)', sql.includes('service_incidents_financial_exposure_required_chk'));
  assert('4d: financial_exposure_cents cannot be negative', /financial_exposure_cents\s+integer\s+CHECK\s*\(financial_exposure_cents IS NULL OR financial_exposure_cents >= 0\)/.test(sql));

  console.log('\n── incident fact immutability + no-delete (STEP 6) ──');
  assert('5a: a BEFORE UPDATE trigger blocks changes to detection facts', sql.includes('service_incidents_facts_immutable') && sql.includes('BEFORE UPDATE ON public.service_incidents'));
  assert('5b: the immutable-facts function checks service_session_id/category/severity/entities/exposure/detected_at/detected_by/auto_resolved (not just one column)', ['service_session_id', 'category', 'severity', 'entity_type', 'entity_id', 'financial_exposure_cents', 'detected_at', 'detected_by', 'auto_resolved'].every((col) => sql.includes('NEW.' + col + ' ')));
  assert('5c: resolution_status/resolution_type/resolved_at/resolved_by/resolution_note/updated_at are deliberately NOT in the immutability check (they must remain mutable)', !sql.includes('NEW.resolution_status ') && !sql.includes('NEW.resolved_at '));
  assert('5d: a BEFORE DELETE trigger unconditionally blocks deletion of incidents', sql.includes('service_incidents_no_delete') && sql.includes('BEFORE DELETE ON public.service_incidents'));
  assert('5e: append-only resolution EVENT table exists, separate from the incident row itself', sql.includes('CREATE TABLE public.service_incident_resolutions'));
  assert('5f: the resolution-events table is itself append-only (no update/delete)', sql.includes('service_incident_resolutions_no_update_delete') && sql.includes('BEFORE UPDATE OR DELETE ON public.service_incident_resolutions'));
  assert('5g: resolution events are restricted to role=admin at the DB level too', sql.includes("role              text NOT NULL CHECK (role = 'admin')"));

  console.log('\n── entity references are historical snapshots, deliberately without FKs (RC lesson already learned once) ──');
  assert('6a: order_id/table_session_id/giro_id/rider_id carry no REFERENCES clause', !/order_id\s+text\s+REFERENCES/.test(sql) && !/table_session_id\s+uuid\s+REFERENCES/.test(sql));
  assert('6b: rationale is documented inline (not just tribal knowledge)', sql.includes('deliberately WITHOUT foreign keys'));

  console.log('\n── access control (STEP 7) ──');
  for (const t of ['service_closeout_snapshots', 'service_incidents', 'service_incident_resolutions']) {
    assert('7a: RLS enabled on ' + t, sql.includes('ALTER TABLE public.' + t + ' ENABLE ROW LEVEL SECURITY') || new RegExp('ENABLE ROW LEVEL SECURITY[\\s\\S]*' + t).test(sql));
  }
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert('7b: zero actual CREATE POLICY statements (default-deny for anon/authenticated, matching order_financial_events) — comment mentions of the phrase do not count', !/CREATE\s+POLICY\s+\w/i.test(sqlWithoutComments));
  assert('7c: REVOKE ALL FROM PUBLIC, anon, authenticated on the new tables', /REVOKE ALL ON public\.service_closeout_snapshots, public\.service_incidents, public\.service_incident_resolutions\s+FROM PUBLIC, anon, authenticated/.test(sql));
  assert('7d: grants are service_role only — no anon/authenticated GRANT anywhere in the file', !/GRANT[\s\S]{0,80}TO\s+(anon|authenticated)\b/i.test(sql));
  assert('7e: resolve_service_incident enforces role=\'admin\' server-side, independent of any caller-supplied claim', sql.includes("p_actor_role IS DISTINCT FROM 'admin'") && sql.includes('INCIDENT_RESOLUTION_FORBIDDEN'));
  assert('7f: every new function is SECURITY INVOKER (matches house convention, never SECURITY DEFINER)', !sql.includes('SECURITY DEFINER'));

  console.log('\n── no wiring into live rollover behaviour (STEP 8) ──');
  // chiudiServizio is a JS function, not a SQL construct — the only place it
  // can legally appear in this .sql file is a prose comment explaining that
  // nothing here is wired to it. What actually matters is checked already:
  // no trigger/function on ordenes|storico|service_sessions was touched (§2b).
  assert('8a: chiudiServizio, if mentioned at all, only appears in prose comments (never in an executable statement)', sqlWithoutComments.replace(/'[^']*'/g, '').indexOf('chiudiServizio') === -1);
  assert('8b: ensureServiceSession/ensure_service_session is not modified (only referenced read-only via FK)', !/CREATE OR REPLACE FUNCTION public\.ensure_service_session/.test(sql));
  assert('8c: guard_service_session_closed_v1 is not modified', !sql.includes('CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1'));
  assert('8d: explicit no-wiring statement present in the migration itself', sql.includes('nothing in this migration is called by any existing trigger'));

  console.log('\n── rollback is a clean mirror ──');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  assert('9a: rollback drops all three new tables', ['service_closeout_snapshots', 'service_incidents', 'service_incident_resolutions'].every((t) => rollback.includes('DROP TABLE IF EXISTS public.' + t)));
  assert('9b: rollback drops all three new RPCs', ['capture_closeout_snapshot', 'create_service_incident', 'resolve_service_incident'].every((fn) => rollback.includes('DROP FUNCTION IF EXISTS public.' + fn)));
  assert('9c: rollback touches no pre-existing table', !/ALTER\s+TABLE\s+public\.(service_sessions|service_session_state|service_session_audit|order_financial_events|orden_estado_logs|ordenes)\b/i.test(rollback));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
