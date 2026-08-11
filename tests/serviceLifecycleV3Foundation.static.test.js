'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.1 — static test over the migration SQL text
// itself, same convention as tests/closeoutAttemptOwnership.static.test.js
// (no live Postgres available/permitted in this environment for a NEW,
// unapplied migration — STAGING ONLY, no database mutation — so the
// DB-level invariants here are proven by inspecting exactly what was
// written, not by running it). The migration's outer SQL grammar WAS
// validated offline against the real Postgres parser (libpg-query) during
// authoring — see the V3.1 foundation report §17 for that evidence; this
// file covers the structural/semantic properties a parser alone can't.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : "")); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_foundation.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_foundation.ROLLBACK.sql');
const LIVE_TRIGGER_SOURCE_PATH = path.join(ROOT, 'migrations', '2026-08-02_v3j_mesa_nomenclature_cutover.sql');

(async () => {
  console.log('\n== service lifecycle v3 foundation (Slice 3.1) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: staging sentinel guard present (matches every other migration in this repo)', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1c: fail-closed on pre-existing target object (no silent drift)', sql.includes('target object already exists'));
  assert('1d: requires the Service Closeout V2 foundation (rows 44/53/54/55) applied first', sql.includes("to_regclass('public.service_closeout_attempts') IS NULL") && sql.includes("to_regclass('public.service_closeout_snapshots') IS NULL") && sql.includes("to_regclass('public.service_incidents') IS NULL"));
  assert('1e: does not require, mention as a dependency, or apply retired row 56', !/cross_service_table_policy/.test(sqlWithoutComments) && !/mesa_release_empty_session_auto_v1/.test(sql));

  console.log('\n── additive-only ──');
  const destructivePatterns = [
    /DROP\s+TABLE(?!\s+IF\s+NOT)/i,
    /RENAME\s+TO/i,
    /TRUNCATE/i,
    /DELETE\s+FROM/i,
  ];
  for (const re of destructivePatterns) {
    assert('2: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  // language-guard: allow-legacy storico is named only inside a regex alternation of pre-existing table names this migration must NOT ALTER, not new vocabulary
  assert('2b: no existing TABLE is ALTERed (the fix is a function CREATE OR REPLACE, not a DDL change to any table)', !/ALTER\s+TABLE\s+public\.(service_sessions|service_closeout_attempts|service_closeout_snapshots|service_incidents|service_incident_resolutions|archived_order_financial_resolutions|ordenes|storico|table_sessions|restaurant_tables)\b/i.test(sql));
  assert('2c: no existing function is DROPped (mesa_prepare_table_order_v1 is CREATE OR REPLACE, not dropped+recreated)', !/DROP\s+FUNCTION/i.test(sql));
  assert('2d: does not touch service_session_state or service_sessions data (no UPDATE on either)', !/UPDATE\s+public\.service_session_state/i.test(sqlWithoutComments) && !/UPDATE\s+public\.service_sessions\b/i.test(sqlWithoutComments));

  console.log('\n── PART 1 — order-attribution fix ──');
  const liveSql = fs.readFileSync(LIVE_TRIGGER_SOURCE_PATH, 'utf8');
  function extractFn(src, name) {
    const startMarker = `CREATE OR REPLACE FUNCTION public.${name}()`;
    const i = src.indexOf(startMarker);
    if (i === -1) return null;
    const j = src.indexOf('$fn$;', src.indexOf('$fn$', i + startMarker.length) + 4);
    return src.slice(i, j + 5);
  }
  const liveFn = extractFn(liveSql, 'mesa_prepare_table_order_v1');
  const newFn = extractFn(sql, 'mesa_prepare_table_order_v1');
  assert('3a: found the live (currently-applied) mesa_prepare_table_order_v1 body to diff against', !!liveFn);
  assert('3b: found the new mesa_prepare_table_order_v1 body in this migration', !!newFn);
  assert('3c: the live/deployed body still contains the buggy line (proves the diff below is meaningful, not comparing against an already-fixed source)', liveFn && liveFn.includes('NEW.service_session_id := v_session.service_session_id;'));
  const newFnCodeOnly = newFn ? newFn.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n') : '';
  assert('3d: the new body no longer assigns ordenes.service_session_id from the table_session at all (checked against CODE only — the fix deliberately leaves an explanatory comment mentioning the removed line)', newFn && !newFnCodeOnly.includes('NEW.service_session_id := v_session.service_session_id;') && !/NEW\.service_session_id\s*:=/.test(newFnCodeOnly));
  assert('3e: a predecessor-body guard runs before the CREATE OR REPLACE, refusing to apply over a drifted/already-fixed function', /pg_get_functiondef\(p\.oid\) INTO v_body/.test(sql) && /v_body NOT LIKE '%NEW\.service_session_id := v_session\.service_session_id;%'/.test(sql));

  // Every OTHER statement in the live body must survive into the new body,
  // unchanged, in the same relative order — proves this is a single-line
  // removal, not a wider rewrite. (Comment-only lines are intentionally not
  // required verbatim, since the fix adds explanatory comments.)
  function codeLines(fnText) {
    return fnText.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('--'));
  }
  const liveCode = codeLines(liveFn).filter((l) => l !== 'NEW.service_session_id := v_session.service_session_id;');
  const newCode = codeLines(newFn);
  assert('3f: every code line from the live body (minus the one removed line) appears, in order, in the new body — nothing else changed', (() => {
    let i = 0;
    for (const line of newCode) { if (line === liveCode[i]) i++; }
    return i === liveCode.length;
  })(), `matched ${'n/a'}; liveCode.length=${liveCode.length} newCode.length=${newCode.length}`);

  console.log('\n── PART 2 — service_closeouts: identity + uniqueness (case A) ──');
  assert('4a: table created', /CREATE TABLE public\.service_closeouts/.test(sql));
  assert('4b: at most one closeout per SERVICE SESSION — real UNIQUE constraint', /CONSTRAINT service_closeouts_session_uq UNIQUE \(service_session_id\)/.test(sql));
  assert('4c: at most one closeout per ATTEMPT/CORRELATION — real UNIQUE constraint', /CONSTRAINT service_closeouts_correlation_uq UNIQUE \(closeout_correlation_id\)/.test(sql));

  console.log('\n── case B — immutable truth ──');
  assert('5a: dedicated append-only trigger function, unconditionally raises', /service_closeouts_append_only[\s\S]{0,200}RAISE EXCEPTION 'service_closeouts is append-only'/.test(sql));
  assert('5b: trigger fires BEFORE UPDATE OR DELETE, blocking both', /BEFORE UPDATE OR DELETE ON public\.service_closeouts/.test(sql));
  assert('5c: no UPDATE/DELETE grant exists for service_role (enforced twice over: no grant AND the trigger)', !/GRANT[^;]*(UPDATE|DELETE)[^;]*ON public\.service_closeouts/i.test(sql));

  console.log('\n── case C — attempt linkage ──');
  assert('6a: closeout_correlation_id is NOT NULL and FK-references service_closeout_attempts exactly', /closeout_correlation_id uuid NOT NULL REFERENCES public\.service_closeout_attempts\(closeout_correlation_id\) ON DELETE RESTRICT/.test(sql));
  assert('6b: service_session_id is NOT NULL and FK-references service_sessions', /service_session_id\s+uuid NOT NULL REFERENCES public\.service_sessions\(id\) ON DELETE RESTRICT/.test(sql));

  console.log('\n── case D — financial snapshot values (integer cents, exact) ──');
  const financialCols = ['gross_sales_cents', 'net_sales_cents', 'total_discounts_cents', 'total_refunds_cents', 'total_void_cents', 'paid_amount_cents', 'unpaid_exposure_cents'];
  for (const col of financialCols) {
    assert(`7: ${col} is a NOT-NULL-or-defaulted non-negative integer column`, new RegExp(col + '\\s+integer NOT NULL').test(sql) && new RegExp('CHECK \\(' + col + ' >= 0\\)').test(sql));
  }
  assert('7b: unpaid_exposure_cents specifically — the canonical 5750-cent worked example — is a first-class NOT NULL column, not buried in JSON', /unpaid_exposure_cents\s+integer NOT NULL CHECK \(unpaid_exposure_cents >= 0\)/.test(sql));
  assert('7c: payment-method breakdown sums to paid_amount_cents (DB-enforced integrity, not just app-trusted)', /CONSTRAINT service_closeouts_payment_breakdown_chk\s*\n\s*CHECK \(cash_amount_cents \+ card_amount_cents \+ bizum_amount_cents \+ other_amount_cents = paid_amount_cents\)/.test(sql));

  console.log('\n── case E — post-close recovery never rewrites frozen truth ──');
  assert('8a: this migration performs no DML (INSERT/UPDATE/ALTER) against archived_order_financial_resolutions — it is only referenced BY NAME in explanatory comments, documenting that recovery stays a separate, later, append-only fact', !/(INSERT INTO|UPDATE|ALTER TABLE)\s+public\.archived_order_financial_resolutions/i.test(sqlWithoutComments));
  assert('8b: service_closeouts has no resolution/adjustment column of any kind — nothing here is designed to be mutated post-insert', !/resolution/i.test(sqlWithoutComments.match(/CREATE TABLE public\.service_closeouts[\s\S]*?\);/)[0]));

  console.log('\n── case F — table cross-service (table origin never rewritten) ──');
  assert('9a: this migration never ALTERs table_sessions (its service_session_id stays exactly as V3-H left it — historical, immutable)', !/ALTER\s+TABLE\s+public\.table_sessions/i.test(sql));
  assert('9b: this migration never UPDATEs table_sessions.service_session_id', !/table_sessions[\s\S]{0,120}SET[\s\S]{0,120}service_session_id\s*=/.test(sqlWithoutComments));

  console.log('\n── case G — new order attribution (covered structurally by 3d/3e/3f above) ──');
  assert('10: ordenes_assign_service_session (the standard, unified attribution path) is not modified by this migration', !/CREATE OR REPLACE FUNCTION public\.service_session_assign_order/.test(sql));

  console.log('\n── case H — existing historical orders untouched ──');
  assert('11: no UPDATE/DELETE against ordenes anywhere in this migration', !/UPDATE\s+public\.ordenes\b/i.test(sqlWithoutComments) && !/DELETE\s+FROM\s+public\.ordenes\b/i.test(sqlWithoutComments));

  console.log('\n── case I — no destructive dependency (closeout creation never moves/deletes canonical orders) ──');
  // language-guard: allow-legacy storico is named only to prove this migration adds no FK to it, not new vocabulary
  assert('12a: service_closeouts references service_sessions/service_closeout_attempts only — no FK to ordenes/storico', !/service_closeouts[\s\S]*?REFERENCES public\.(ordenes|storico)/.test(sql.slice(sql.indexOf('CREATE TABLE public.service_closeouts'))));
  // language-guard: allow-legacy storico/serata_summary are named only to prove this migration performs no INSERT into them, not new vocabulary
  assert('12b: this migration performs no INSERT into storico, ordenes, or serata_summary', !/INSERT INTO public\.(storico|ordenes|serata_summary)\b/i.test(sql));

  console.log('\n── extension points documented, not fabricated ──');
  assert('13a: fiscal extension point is documented, no fiscal column added', /FISCAL —/.test(sql) && !/tax_|fiscal_/.test(sqlWithoutComments.match(/CREATE TABLE public\.service_closeouts[\s\S]*?\);/)[0]));
  assert('13b: cash-drawer extension point is documented, no cash-session column added', /CASH DRAWER —/.test(sql) && !/expected_cash|counted_cash|cash_variance|cash_session_id/.test(sql));

  console.log('\n── schema-only in this slice — no RPC yet ──');
  assert('14a: no new RPC function is created for service_closeouts (only the append-only guard trigger function)', !/CREATE OR REPLACE FUNCTION public\.create_service_closeout/.test(sql));
  assert('14b: no HTTP action/route is added by this migration (SQL-only file)', !/app\.(get|post)\s*\(/.test(sql));

  console.log('\n── access control (Slice 1.3 deterministic-privilege-floor discipline) ──');
  assert('15a: RLS enabled on the new table', sql.includes('ALTER TABLE public.service_closeouts ENABLE ROW LEVEL SECURITY'));
  assert('15b: zero CREATE POLICY (default-deny for anon/authenticated)', !/CREATE POLICY/i.test(sqlWithoutComments));
  assert('15c: REVOKE ALL FROM service_role first (ambient default grants are never trusted)', /REVOKE ALL ON public\.service_closeouts FROM PUBLIC, anon, authenticated, service_role/.test(sql));
  assert('15d: service_role is granted exactly SELECT, INSERT — never UPDATE/DELETE/TRUNCATE', /GRANT SELECT, INSERT ON public\.service_closeouts TO service_role/.test(sql));
  assert('15e: no sequence-level grant needed or present (uuid PK, gen_random_uuid)', !/GRANT[^;]*SEQUENCE/i.test(sql));

  console.log('\n── rollback is a clean mirror ──');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  assert('16a: rollback drops service_closeouts and its trigger function', rollback.includes('DROP TABLE IF EXISTS public.service_closeouts') && rollback.includes('DROP FUNCTION IF EXISTS public.service_closeouts_append_only()'));
  assert('16b: rollback restores mesa_prepare_table_order_v1 to the exact pre-fix body (the removed line is back)', rollback.includes('NEW.service_session_id := v_session.service_session_id;'));
  assert('16c: rollback touches no other pre-existing table', !/ALTER\s+TABLE\s+public\.(service_sessions|service_closeout_attempts|service_closeout_snapshots|service_incidents|table_sessions)\b/i.test(rollback));

  console.log('\n── application wiring — V3.2 is now the sanctioned engine caller ──');
  const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'tests', 'migrations', 'docs']);
  // SLICE 3.2 (2026-08-09_service_lifecycle_v3_close_engine.sql) is the first
  // real caller this row 57 comment itself predicted ("V3.2's close engine is
  // the first thing that will INSERT a row") — this allowlist was widened
  // from just the read-only serviceCloseouts.js to also include the V3.2
  // write path (serviceCloseoutCreation.js, the sole INSERT-or-fetch DAO;
  // serviceLifecycleEngine.js, the orchestrator that calls it) and its
  // resource-policy registration. See tests/serviceLifecycleV3Foundation.
  // static.test.js's own V3.2 sibling — tests/serviceLifecycleV3CloseEngine
  // Migration.static.test.js — for that engine's own dedicated proof.
  const CALLER_ALLOWED_FILES = new Set([
    path.join(ROOT, 'src', 'closeout', 'serviceCloseouts.js'),
    path.join(ROOT, 'src', 'closeout', 'serviceCloseoutCreation.js'),
    path.join(ROOT, 'src', 'serviceSessions', 'serviceLifecycleEngine.js'),
    path.join(ROOT, 'src', 'utils', 'supabaseResourcePolicy.js'),
    // P0-C2 (2026-08-10_service_lifecycle_economic_boundary_v1.sql) — a second
    // sanctioned orchestrator, same relationship to service_closeouts as
    // serviceLifecycleEngine.js above: calls serviceCloseoutCreation.create()
    // (the sole INSERT-or-fetch DAO, unmodified), never references the table
    // name in executable code — the one hit here is a comment explaining why
    // Phase D exists. Reuses create_service_closeout as-is; does not touch
    // close_service_session_v3, using roll_service_session_economic_v1
    // instead (see that migration's own header for why: guard_service_
    // session_closed_v1's SERVICE_ACTIVE_ORDERS_NOT_RESOLVED check would hard-
    // block an ordinary intraday close with real non-terminal orders).
    path.join(ROOT, 'src', 'serviceSessions', 'economicBoundaryEngine.js'),
    // P0-C3 — previousBusinessDayResidue.js: read-only lookup of a stale
    // session's OWN service_closeouts row (to reuse its closeout_correlation_
    // id as the dedupe key for a residue incident — see that file's own
    // header). Never INSERTs/UPDATEs the table; the only hits here are that
    // same explanation in comments plus the one SELECT-only query string.
    path.join(ROOT, 'src', 'serviceSessions', 'previousBusinessDayResidue.js'),
  ]);
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
  const candidateFiles = [...walk(path.join(ROOT, 'src'), []), path.join(ROOT, 'index.js')].filter((f) => fs.existsSync(f));
  const unexpectedHits = [];
  for (const f of candidateFiles) {
    if (CALLER_ALLOWED_FILES.has(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (/service_closeouts\b/.test(text)) unexpectedHits.push(path.relative(ROOT, f));
  }
  assert('17a: no application module outside the sanctioned V3.1 read path + V3.2 write path references the table', unexpectedHits.length === 0, JSON.stringify(unexpectedHits));
  assert('17b: index.js has no new HTTP route referencing service_closeouts', !/service_closeouts/.test(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8')));
  // language-guard: allow-legacy chiudiServizio is the existing JS close function, named here for audit context (this test proves it is NOT called), not new vocabulary
  assert('17c: no module calls chiudiServizio from this slice\'s new files (schema-first, no engine)', !/chiudiServizio/.test(fs.readFileSync(path.join(ROOT, 'src', 'closeout', 'serviceCloseouts.js'), 'utf8')));
  assert('17d: the scan actually walked a non-trivial number of files (guards against a broken walk silently passing)', candidateFiles.length > 20, String(candidateFiles.length));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
