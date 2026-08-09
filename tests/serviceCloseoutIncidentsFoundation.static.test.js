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
  // Comment-stripped view — used wherever a check must scan for actual
  // executable SQL and must not false-positive on prose that merely
  // discusses a keyword (e.g. Slice 1.3's privilege-floor comments legitimately
  // say "TRUNCATE" while explaining why it is withheld, not executing it).
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

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
    assert('2: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
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

  console.log('\n── SLICE 3.2 HARDENING — superseded is a system-only, non-actionable disposition ──');
  assert('4e: resolution_status vocabulary now includes superseded', sql.includes("CHECK (resolution_status IN ('pending','acknowledged','resolved','superseded'))"));
  assert('4f: the resolved-fields tie-in constraint covers superseded too (resolved_at/resolved_by/resolution_type populated exactly when resolved OR superseded)', sql.includes("CHECK ((resolution_status IN ('resolved','superseded')) = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_type IS NOT NULL))"));
  assert('4g: resolve_service_incident (the HUMAN path) still only accepts acknowledged/resolved — superseded is never human-settable through it', /IF p_resolution_status NOT IN \('acknowledged','resolved'\) THEN/.test(sql));
  assert('4h: the only writer of resolution_status=\'superseded\' documented is the Slice 3.1/3.2 attempt-ownership migration', sql.includes('supersede_closeout_attempt()'));

  console.log('\n── incident fact immutability + no-delete (STEP 6) ──');
  assert('5a: a BEFORE UPDATE trigger blocks changes to detection facts', sql.includes('service_incidents_facts_immutable') && sql.includes('BEFORE UPDATE ON public.service_incidents'));

  console.log('\n── deny-by-default immutability (Slice 1.1) ──');
  // The function must compare the FULL row (to_jsonb(OLD)/to_jsonb(NEW)) minus
  // an explicit allowlist, NOT enumerate individual immutable columns. The
  // former protects any future column automatically; the latter (Slice 1's
  // original shape) silently stops protecting a column nobody remembered to
  // add to a checklist. Extract the function body to scope every assertion to
  // it specifically, so a match elsewhere in the file cannot false-positive.
  const immFnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.service_incidents_immutable_facts\(\)[\s\S]*?\$fn\$;/);
  assert('5b-0: service_incidents_immutable_facts() function body found', !!immFnMatch);
  const immFn = immFnMatch ? immFnMatch[0] : '';
  assert('5b: the comparison is a whole-row jsonb diff, not a per-column NEW.<col> IS DISTINCT FROM OLD.<col> checklist', /to_jsonb\(OLD\)\s*-\s*v_mutable_keys/.test(immFn) && /to_jsonb\(NEW\)\s*-\s*v_mutable_keys/.test(immFn) && !/NEW\.\w+\s+IS DISTINCT FROM\s+OLD\.\w+/.test(immFn));
  assert('5b-1: no per-column fact enumeration remains (deny-by-default, not an allow-checklist)', !/NEW\.(service_session_id|category|severity|entity_type|entity_id|financial_exposure_cents|detected_at|detected_by|auto_resolved)\s/.test(immFn));
  const mutableKeysMatch = immFn.match(/v_mutable_keys\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/);
  assert('5c-0: mutable-keys allowlist array present', !!mutableKeysMatch);
  const mutableKeys = mutableKeysMatch ? mutableKeysMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')) : [];
  assert('5c: resolution_status/resolution_type/resolved_at/resolved_by/resolution_note/updated_at are EXACTLY the mutable allowlist — nothing more, nothing less', JSON.stringify(mutableKeys.slice().sort()) === JSON.stringify(['resolution_note', 'resolution_status', 'resolution_type', 'resolved_at', 'resolved_by', 'updated_at'].slice().sort()), JSON.stringify(mutableKeys));
  assert('5c-1: no detection-fact column name leaks into the mutable allowlist', ['service_session_id', 'business_date', 'service_kind', 'closeout_correlation_id', 'snapshot_id', 'incident_type', 'category', 'severity', 'entity_type', 'entity_id', 'order_id', 'table_session_id', 'giro_id', 'rider_id', 'financial_exposure_cents', 'detected_at', 'detected_by', 'auto_resolved', 'created_at'].every((col) => !mutableKeys.includes(col)));

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
  assert('7b: zero actual CREATE POLICY statements (default-deny for anon/authenticated, matching order_financial_events) — comment mentions of the phrase do not count', !/CREATE\s+POLICY\s+\w/i.test(sqlWithoutComments));
  assert('7c: REVOKE ALL FROM PUBLIC, anon, authenticated on the new tables', /REVOKE ALL ON public\.service_closeout_snapshots, public\.service_incidents, public\.service_incident_resolutions\s+FROM PUBLIC, anon, authenticated/.test(sql));
  assert('7d: grants are service_role only — no anon/authenticated GRANT anywhere in the file', !/GRANT[\s\S]{0,80}TO\s+(anon|authenticated)\b/i.test(sql));
  assert('7e: resolve_service_incident enforces role=\'admin\' server-side, independent of any caller-supplied claim', sql.includes("p_actor_role IS DISTINCT FROM 'admin'") && sql.includes('INCIDENT_RESOLUTION_FORBIDDEN'));
  assert('7f: every new function is SECURITY INVOKER (matches house convention, never SECURITY DEFINER)', !sql.includes('SECURITY DEFINER'));

  console.log('\n── deterministic privilege floor (Slice 1.3) ──');
  // Slice 1.2's real-Postgres validation proved this project's ambient
  // ALTER DEFAULT PRIVILEGES rule silently grants service_role
  // DELETE/TRUNCATE/REFERENCES/TRIGGER on every new table at CREATE TABLE
  // time — TRUNCATE in particular bypasses the append-only/immutable-facts
  // triggers entirely (they only fire on UPDATE/DELETE). These checks prove
  // the migration itself, not the project's ambient defaults, is the sole
  // source of truth for the final privilege surface, and that it can never
  // silently regress back to the wider inherited set.
  assert('11a: REVOKE ALL now explicitly includes service_role (not just PUBLIC/anon/authenticated) before any grant-back', /REVOKE ALL ON public\.service_closeout_snapshots, public\.service_incidents, public\.service_incident_resolutions\s+FROM PUBLIC, anon, authenticated, service_role/.test(sql));

  const revokeAllIdx = sql.indexOf('REVOKE ALL ON public.service_closeout_snapshots, public.service_incidents, public.service_incident_resolutions');
  const grantLines = {
    service_closeout_snapshots: sql.match(/GRANT\s+([A-Z, ]+?)\s+ON\s+public\.service_closeout_snapshots\s+TO\s+service_role;/),
    service_incidents: sql.match(/GRANT\s+([A-Z, ]+?)\s+ON\s+public\.service_incidents\s+TO\s+service_role;/),
    service_incident_resolutions: sql.match(/GRANT\s+([A-Z, ]+?)\s+ON\s+public\.service_incident_resolutions\s+TO\s+service_role;/),
  };
  assert('11b-0: exactly one GRANT ... TO service_role statement exists per table (no duplicate/competing grant)', Object.values(grantLines).every((m) => !!m));
  assert('11b-1: deterministic ordering — REVOKE ALL (including service_role) happens BEFORE any grant-back, never after', Object.values(grantLines).every((m) => revokeAllIdx !== -1 && sql.indexOf(m[0]) > revokeAllIdx));

  function privSet(m) { return m[1].split(',').map((s) => s.trim()).filter(Boolean).sort(); }
  assert('11c: service_closeout_snapshots service_role privileges are EXACTLY {INSERT, SELECT} — capture_closeout_snapshot() only ever SELECTs and INSERTs (ON CONFLICT DO NOTHING needs no UPDATE)', JSON.stringify(privSet(grantLines.service_closeout_snapshots)) === JSON.stringify(['INSERT', 'SELECT']), JSON.stringify(privSet(grantLines.service_closeout_snapshots)));
  assert('11d: service_incidents service_role privileges are EXACTLY {INSERT, SELECT, UPDATE} — UPDATE only because resolve_service_incident() changes the resolution-summary columns', JSON.stringify(privSet(grantLines.service_incidents)) === JSON.stringify(['INSERT', 'SELECT', 'UPDATE']), JSON.stringify(privSet(grantLines.service_incidents)));
  assert('11e: service_incident_resolutions service_role privileges are EXACTLY {INSERT, SELECT} — resolve_service_incident() only ever INSERTs an event row', JSON.stringify(privSet(grantLines.service_incident_resolutions)) === JSON.stringify(['INSERT', 'SELECT']), JSON.stringify(privSet(grantLines.service_incident_resolutions)));

  // Regression guard: scan EVERY GRANT statement in the file that mentions
  // any of the three tables and assert none of them ever include the
  // dangerous privileges, however the statement is phrased in the future
  // (single-table, multi-table, ALL, etc.) — this is what must fail if a
  // future edit accidentally restores TRUNCATE to service_role.
  const dangerousPrivileges = ['DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL'];
  const grantStatements = sqlWithoutComments.match(/GRANT\s+[^;]*?\bON\b[^;]*;/gi) || [];
  const grantsOnOurTables = grantStatements.filter((g) => /service_closeout_snapshots|service_incidents\b|service_incident_resolutions/.test(g));
  const offendingGrants = grantsOnOurTables.filter((g) => dangerousPrivileges.some((p) => new RegExp('\\b' + p + '\\b').test(g.slice(0, g.toUpperCase().indexOf(' ON ')))));
  assert('11f: no GRANT statement targeting any of the three tables ever includes DELETE/TRUNCATE/REFERENCES/TRIGGER/ALL, in any phrasing', offendingGrants.length === 0, JSON.stringify(offendingGrants));

  assert('11g: no sequence objects are created by this migration (all three tables use uuid PRIMARY KEY DEFAULT gen_random_uuid(), never serial/bigserial) — so no sequence-level grant is needed', !/CREATE\s+SEQUENCE/i.test(sql));

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

  console.log('\n── authorization trust boundary (Slice 1.1) ──');
  assert('10a: resolve_service_incident header documents p_actor_role is NOT proof by itself (defense-in-depth only)', sql.includes('is NOT proof of anything by') || sql.includes('NOT the security boundary'));
  assert('10b: header points a future admin-resolution action at the real, existing verification pattern (verified JWT role claim)', sql.includes('src/auth/jwt.js') && sql.includes('src/auth/'));
  assert('10c: header explicitly forbids copying role straight from a request body field', /req\.body\.role/.test(sql));

  // "No public HTTP resolution endpoint yet" (plan requirement) — proven by
  // grepping every application source file OUTSIDE this slice's own modules
  // and tests for any reference to the RPC name or the JS wrapper calls.
  // Fails loudly (not silently) the day someone wires this up without also
  // updating this check and the trust-boundary comments above it.
  //
  // SERVICE CLOSEOUT V2 / SLICE 3 update: capture_closeout_snapshot /
  // create_service_incident / closeoutSnapshots.capture() /
  // serviceIncidents.report() are now INTENTIONALLY wired — this is exactly
  // the "future lifecycle orchestrator" closeoutSnapshots.js's own header
  // comment always pointed at (src/serviceSessions/incidentSafeRollover.js).
  //
  // SLICE 4C.2C update: resolution (resolve_service_incident /
  // serviceIncidents.resolve()) is now ALSO intentionally wired, but only
  // from that SAME internal orchestrator — after a safe auto-action (empty
  // table release) actually confirms success, never before, and never from
  // any HTTP action. What remains, and must still be provably true, is that
  // resolution has NO public HTTP path anywhere — a real ADMIN-facing
  // resolution UI/endpoint is still separate, later work.
  const ROOT = path.join(__dirname, '..');
  const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'migrations', 'docs']);
  const EXCLUDED_FILES = new Set([
    path.join(ROOT, 'src', 'closeout', 'closeoutSnapshots.js'),
    path.join(ROOT, 'src', 'incidents', 'serviceIncidents.js'),
  ]);
  // The one module this slice deliberately wires as the "future lifecycle
  // orchestrator" — allowed to create/capture, but still checked against the
  // RESOLUTION-only patterns below like everything else.
  const CREATION_WIRING_ALLOWED_FILES = new Set([
    path.join(ROOT, 'src', 'serviceSessions', 'incidentSafeRollover.js'),
    // SLICE 4C.2A — the H1B transport allowlist registers these RPC names by
    // string (never calls them) so the real sbRpc default can reach them at
    // all; see supabaseResourcePolicy.js's own comment at this entry.
    path.join(ROOT, 'src', 'utils', 'supabaseResourcePolicy.js'),
  ]);
  // SLICE 4C.2C — same orchestrator, now ALSO the sole accepted resolution
  // caller (after a confirmed safe auto-action succeeds); the resource-policy
  // registry now legitimately names the RPC too, for the same registration
  // reason as CREATION_WIRING_ALLOWED_FILES above. index.js is deliberately
  // NOT in this set — its absence is exactly what proves no HTTP route exists.
  const RESOLUTION_WIRING_ALLOWED_FILES = new Set([
    path.join(ROOT, 'src', 'serviceSessions', 'incidentSafeRollover.js'),
    path.join(ROOT, 'src', 'utils', 'supabaseResourcePolicy.js'),
  ]);
  const CREATION_PATTERNS = [/create_service_incident/, /capture_closeout_snapshot/, /serviceIncidents\.report\(/, /closeoutSnapshots\.capture\(/];
  const RESOLUTION_PATTERNS = [/resolve_service_incident/, /serviceIncidents\.resolve\(/];

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

  const unexpectedCreationHits = [];
  const resolutionHits = [];
  for (const f of candidateFiles) {
    const text = fs.readFileSync(f, 'utf8');
    if (!CREATION_WIRING_ALLOWED_FILES.has(f)) {
      for (const re of CREATION_PATTERNS) {
        if (re.test(text)) unexpectedCreationHits.push(path.relative(ROOT, f) + ' matches ' + re);
      }
    }
    if (!RESOLUTION_WIRING_ALLOWED_FILES.has(f)) {
      for (const re of RESOLUTION_PATTERNS) {
        if (re.test(text)) resolutionHits.push(path.relative(ROOT, f) + ' matches ' + re);
      }
    }
  }
  assert('10d: no application module OTHER than the Slice-3 lifecycle orchestrator references the creation/capture RPCs or wrappers', unexpectedCreationHits.length === 0, JSON.stringify(unexpectedCreationHits));
  assert('10d2: the Slice-3 lifecycle orchestrator DOES reference them — confirms the intended wiring actually landed, not just permitted', CREATION_PATTERNS.some((re) => re.test(fs.readFileSync(path.join(ROOT, 'src', 'serviceSessions', 'incidentSafeRollover.js'), 'utf8'))));
  assert('10d3: no application module OTHER than the internal orchestrator (and its own resource-policy registration) references the RESOLUTION RPC/wrapper — still zero public HTTP path', resolutionHits.length === 0, JSON.stringify(resolutionHits));
  assert('10d4: the orchestrator DOES reference resolution now (SLICE 4C.2C) — confirms the intended post-confirmation wiring actually landed, not just permitted', RESOLUTION_PATTERNS.some((re) => re.test(fs.readFileSync(path.join(ROOT, 'src', 'serviceSessions', 'incidentSafeRollover.js'), 'utf8'))));
  assert('10d5: index.js (the only HTTP surface) is NOT in the resolution-allowed set — no accidental admin-resolution HTTP route was added', !RESOLUTION_WIRING_ALLOWED_FILES.has(path.join(ROOT, 'index.js')));
  assert('10e: the scan actually walked a non-trivial number of files (guards against a broken walk silently passing)', candidateFiles.length > 20, String(candidateFiles.length));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
