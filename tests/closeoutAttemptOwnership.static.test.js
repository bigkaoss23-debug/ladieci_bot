'use strict';
// SERVICE CLOSEOUT V2 / SLICE 3.1 — static test over the migration SQL text
// itself, same convention as tests/serviceCloseoutIncidentsFoundation.static.test.js
// (no live Postgres available/permitted in this environment — STAGING ONLY,
// no database mutation — so the DB-level invariants here are proven by
// inspecting exactly what was written, not by running it).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : "")); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-08_service_closeout_attempt_ownership.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-08_service_closeout_attempt_ownership.ROLLBACK.sql');

(async () => {
  console.log('\n== service closeout attempt ownership (Slice 3.1) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: staging sentinel guard present (matches every other migration in this repo)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1c: fail-closed on pre-existing target object (no silent drift)', sql.includes('target object already exists'));
  assert('1d: requires Slice 1 foundation (service_closeout_snapshots/service_incidents) applied first', sql.includes("to_regclass('public.service_closeout_snapshots') IS NULL") && sql.includes("to_regclass('public.service_incidents') IS NULL"));

  console.log('\n── additive-only ──');
  const destructivePatterns = [
    /DROP\s+TABLE(?!\s+IF\s+NOT)/i,
    /ALTER\s+TABLE\s+public\.(service_sessions|service_closeout_snapshots|service_incidents|service_incident_resolutions)\s+DROP/i,
    /RENAME\s+TO/i,
    /TRUNCATE/i,
  ];
  for (const re of destructivePatterns) {
    assert('2: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('2b: no existing table is ALTERed at all (the new column lives on a new table)', !/ALTER\s+TABLE\s+public\.(service_sessions|service_closeout_snapshots|service_incidents|service_incident_resolutions|order_financial_events|orden_estado_logs|ordenes|storico|table_sessions)\b/i.test(sql));
  assert('2c: no existing function is dropped', !/DROP\s+FUNCTION/i.test(sql));

  console.log('\n── the DB-enforced concurrency invariant (plan STEP 3) ──');
  assert('3a: a real partial UNIQUE index enforces at most one active attempt per session', /CREATE UNIQUE INDEX service_closeout_attempts_active_uq\s+ON public\.service_closeout_attempts\(service_session_id\) WHERE status = 'active'/.test(sql));
  assert('3b: acquire_closeout_attempt relies on that exact index as its ON CONFLICT target (race-safety is the database, not app code)', /ON CONFLICT \(service_session_id\) WHERE status = 'active' DO NOTHING/.test(sql));
  assert('3c: closeout_correlation_id is minted server-side (gen_random_uuid default), never accepted as a caller argument on acquire', /CREATE TABLE public\.service_closeout_attempts \([\s\S]{0,80}closeout_correlation_id\s+uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/.test(sql) && !/acquire_closeout_attempt\([^)]*p_closeout_correlation_id/.test(sql));

  console.log('\n── lifecycle integrity ──');
  assert('4a: status vocabulary is exactly active/completed/superseded', sql.includes("CHECK (status IN ('active','completed','superseded'))"));
  assert('4b: completed_at/superseded_at are CHECK-tied to their status (cannot silently drift apart)', sql.includes("CHECK ((status = 'completed') = (completed_at IS NOT NULL))") && sql.includes("CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))"));
  assert('4c: rows can never be deleted — dedicated trigger, unconditionally raises', /service_closeout_attempts_no_delete[\s\S]{0,300}RAISE EXCEPTION/.test(sql) && sql.includes('BEFORE DELETE ON public.service_closeout_attempts'));
  assert('4d: identity/origin facts are immutable and terminal statuses are dead ends — deny-by-default guarded-transitions trigger', sql.includes('SERVICE_CLOSEOUT_ATTEMPT_IDENTITY_IMMUTABLE') && sql.includes("SERVICE_CLOSEOUT_ATTEMPT_ALREADY_TERMINAL"));
  assert("4e: the guarded-transitions trigger's mutable allow-list is exactly the five lifecycle columns", /v_mutable_keys text\[\] := ARRAY\['status','completed_at','superseded_at','supersession_reason','updated_at'\]/.test(sql));

  console.log('\n── RPC idempotency contracts ──');
  assert('5a: supersede_closeout_attempt is idempotent on an already-superseded attempt (same success, not an error)', /IF v_row\.status = 'superseded' THEN\s*\n\s*RETURN jsonb_build_object\('ok',true,'code','ALREADY_SUPERSEDED'/.test(sql));
  assert('5b: supersede_closeout_attempt refuses to touch a completed attempt', sql.includes('CANNOT_SUPERSEDE_COMPLETED_ATTEMPT'));
  assert('5c: complete_closeout_attempt is idempotent on an already-completed attempt', /IF v_row\.status = 'completed' THEN\s*\n\s*RETURN jsonb_build_object\('ok',true,'code','ALREADY_COMPLETED'/.test(sql));
  assert('5d: complete_closeout_attempt refuses to touch a superseded attempt', sql.includes('CANNOT_COMPLETE_SUPERSEDED_ATTEMPT'));

  console.log('\n── SLICE 3.2 — atomic superseded-incident disposition ──');
  assert('5e: supersede_closeout_attempt atomically (same function body) disposes of the attempt\'s incidents', /UPDATE public\.service_incidents\s*\n\s*SET resolution_status = 'superseded'/.test(sql));
  assert('5f: the disposition UPDATE is scoped to THIS attempt\'s correlation id only', /WHERE closeout_correlation_id = p_closeout_correlation_id\s*\n\s*AND resolution_status IN \('pending','acknowledged'\)/.test(sql));
  assert('5g: already-resolved or already-superseded incidents are excluded — a real resolution is never re-litigated', sql.includes("resolution_status IN ('pending','acknowledged')") && !sql.includes("resolution_status IN ('pending','acknowledged','resolved')"));
  assert('5h: the disposition records WHO/WHEN via the actual caller, not a hardcoded literal', /resolved_by\s*=\s*p_actor/.test(sql));
  assert('5i: the resolution_type is the documented system-origin reason', sql.includes("resolution_type   = 'closeout_attempt_superseded'"));
  assert('5j: this migration does not touch resolution_note or any detection-fact column of service_incidents (only the same allow-list resolve_service_incident already uses)', !/service_incidents[\s\S]{0,200}SET[\s\S]{0,200}(entity_type|entity_id|financial_exposure_cents|incident_type|detected_at|detected_by)\s*=/.test(sql));

  console.log('\n── access control (Slice 1.3 deterministic-privilege-floor discipline) ──');
  assert('6a: RLS enabled on the new table', sql.includes('ALTER TABLE public.service_closeout_attempts ENABLE ROW LEVEL SECURITY'));
  assert('6b: zero CREATE POLICY (default-deny for anon/authenticated)', !/CREATE POLICY/i.test(sqlWithoutComments));
  assert('6c: REVOKE ALL FROM service_role first (ambient default grants are never trusted)', /REVOKE ALL ON public\.service_closeout_attempts FROM PUBLIC, anon, authenticated, service_role/.test(sql));
  assert('6d: service_role is granted exactly SELECT, INSERT, UPDATE — never DELETE (enforced twice over, also by the no-delete trigger)', /GRANT SELECT, INSERT, UPDATE ON public\.service_closeout_attempts TO service_role/.test(sql) && !/GRANT[^;]*DELETE[^;]*ON public\.service_closeout_attempts/i.test(sql));
  assert('6e: all three RPCs REVOKEd from PUBLIC/anon/authenticated then GRANTed to service_role only', /REVOKE ALL ON FUNCTION\s*\n\s*public\.acquire_closeout_attempt\(uuid,text\),\s*\n\s*public\.supersede_closeout_attempt\(uuid,text,text\),\s*\n\s*public\.complete_closeout_attempt\(uuid,text\)\s*\n\s*FROM PUBLIC, anon, authenticated;/.test(sql));
  assert('6f: no sequence-level grant needed or present (uuid PK, gen_random_uuid — matches Slice 1.3\'s own finding)', !/GRANT[^;]*SEQUENCE/i.test(sql));
  assert('6g: no HTTP action/route is added by this migration (SQL-only file)', !/app\.(get|post)\s*\(/.test(sql));

  console.log('\n── rollback is a clean mirror ──');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  assert('7a: rollback drops the new table', rollback.includes('DROP TABLE IF EXISTS public.service_closeout_attempts'));
  assert('7b: rollback drops all three new RPCs', ['acquire_closeout_attempt', 'supersede_closeout_attempt', 'complete_closeout_attempt'].every((fn) => rollback.includes('DROP FUNCTION IF EXISTS public.' + fn)));
  assert('7c: rollback touches no pre-existing table', !/ALTER\s+TABLE\s+public\.(service_sessions|service_closeout_snapshots|service_incidents|service_incident_resolutions)\b/i.test(rollback));

  console.log('\n── application wiring (no public HTTP path; only the orchestrator calls these RPCs) ──');
  const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'migrations', 'docs']);
  const EXCLUDED_FILES = new Set([
    path.join(ROOT, 'src', 'closeout', 'closeoutAttempts.js'),
  ]);
  const CALLER_ALLOWED_FILES = new Set([
    // N-2 — incidentSafeRollover.js (the orchestrator this allowlist entry
    // used to name) was deleted in the application-wide legacy/dead-code
    // purge (proved zero reachable callers). V3 (serviceLifecycleEngine.js)
    // is the real caller now, via closeoutAttempts.js's JS-level
    // attempts.acquire/complete — but it never mentions the raw RPC name
    // strings in its own source (no comment cites them, unlike
    // incidentSafeRollover.js's did), so it never matches RPC_PATTERNS and
    // needs no entry here.
    // SLICE 4C.2A — the H1B transport allowlist registers these RPC names by
    // string (never calls them) so the real sbRpc default can reach them at
    // all; see supabaseResourcePolicy.js's own comment at this entry.
    path.join(ROOT, 'src', 'utils', 'supabaseResourcePolicy.js'),
  ]);
  const RPC_PATTERNS = [/acquire_closeout_attempt/, /supersede_closeout_attempt/, /complete_closeout_attempt/];

  function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), out);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        out.push(path.join(dir, entry.name));
      }
    }
    return out;
  }

  const candidateFiles = [
    ...walk(path.join(ROOT, 'src'), []),
    path.join(ROOT, 'index.js'),
  ].filter((f) => fs.existsSync(f) && !EXCLUDED_FILES.has(f));

  const unexpectedHits = [];
  for (const f of candidateFiles) {
    if (CALLER_ALLOWED_FILES.has(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    for (const re of RPC_PATTERNS) {
      if (re.test(text)) unexpectedHits.push(path.relative(ROOT, f) + ' matches ' + re);
    }
  }
  assert('8a: no application module OTHER than closeoutAttempts.js (the wrapper) references these RPC names directly', unexpectedHits.length === 0, JSON.stringify(unexpectedHits));
  // N-2 — the orchestrator that used to call attempts.acquire/supersede/
  // complete (incidentSafeRollover.js) was deleted (zero reachable callers,
  // proven). V3 (serviceLifecycleEngine.js) is the real, live caller now —
  // confirms the intended wiring still lands, just through a different file.
  assert('8b: serviceLifecycleEngine.js DOES call attempts.acquire/complete — confirms the intended wiring actually landed', ['attempts.acquire(', 'attempts.complete('].every((needle) => fs.readFileSync(path.join(ROOT, 'src', 'serviceSessions', 'serviceLifecycleEngine.js'), 'utf8').includes(needle)));
  assert('8c: index.js has no new HTTP route for attempt acquisition/supersession/completion', !RPC_PATTERNS.some((re) => re.test(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'))));
  assert('8d: the scan actually walked a non-trivial number of files (guards against a broken walk silently passing)', candidateFiles.length > 20, String(candidateFiles.length));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
