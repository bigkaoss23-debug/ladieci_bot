'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2 — static test over the migration SQL text
// itself, same convention as tests/serviceLifecycleV3Foundation.static.test.js
// (no live Postgres available/permitted in this environment for a NEW,
// unapplied migration — STAGING ONLY, no database mutation).

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_close_engine.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_close_engine.ROLLBACK.sql');
const LIVE_TRIGGER_SOURCE_PATH = path.join(ROOT, 'migrations', '2026-08-02_v3j_mesa_nomenclature_cutover.sql');

function extractFn(src, name) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const j = src.indexOf('$fn$;', src.indexOf('$fn$', i + startMarker.length) + 4);
  return src.slice(i, j + 5);
}
function codeLines(fnText) {
  return fnText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
}

(async () => {
  console.log('\n== service lifecycle v3 close engine (Slice 3.2) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: staging sentinel guard present', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1c: fail-closed on pre-existing target function (no silent drift)', sql.includes('target function already exists'));
  assert('1d: requires the Service Lifecycle V3 foundation (rows 44/53/55/57)', sql.includes("to_regclass('public.service_closeouts') IS NULL") && sql.includes("to_regclass('public.service_closeout_attempts') IS NULL"));
  assert('1e: does not require or depend on retired row 56', !/cross_service_table_policy/.test(sqlWithoutComments) && !/mesa_release_empty_session_auto_v1/.test(sql));

  console.log('\n── additive-only, no new table ──');
  const destructivePatterns = [/DROP\s+TABLE/i, /DROP\s+FUNCTION/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i];
  for (const re of destructivePatterns) {
    assert('2: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('2b: no CREATE TABLE — service_closeouts already exists (row 57), not duplicated', !/CREATE\s+TABLE/i.test(sqlWithoutComments));
  assert('2c: no ALTER TABLE anywhere', !/ALTER\s+TABLE/i.test(sqlWithoutComments));

  console.log('\n── NEW ENGINE, NO LEGACY CLOSEOUT: no DML against legacy archive tables ──');
  // language-guard: allow-legacy storico/serata_summary are named only to prove this migration performs no DML against them, not new vocabulary
  assert('3a: no INSERT/UPDATE against storico', !/(INSERT INTO|UPDATE)\s+public\.storico\b/i.test(sqlWithoutComments));
  // language-guard: allow-legacy serata_summary is named only to prove this migration performs no DML against it, not new vocabulary
  assert('3b: no INSERT/UPDATE against serata_summary', !/(INSERT INTO|UPDATE)\s+public\.serata_summary\b/i.test(sqlWithoutComments));
  assert('3c: begin_service_session_close/complete_service_session_close are never CREATE OR REPLACEd (untouched)', !/CREATE OR REPLACE FUNCTION public\.(begin|complete)_service_session_close/i.test(sql));

  console.log('\n── PART 1 — create_service_closeout ──');
  const createFn = extractFn(sql, 'create_service_closeout');
  assert('4a: function created', !!createFn);
  assert('4b: idempotent — ON CONFLICT (closeout_correlation_id) DO NOTHING, same recipe as capture_closeout_snapshot', createFn && /ON CONFLICT \(closeout_correlation_id\) DO NOTHING/.test(createFn));
  assert('4c: re-fetches and verifies session-id match on conflict, before declaring ALREADY_EXISTS (never hands back a mismatched row)', createFn && /CLOSEOUT_CORRELATION_ID_CONFLICT/.test(createFn) && /ALREADY_EXISTS/.test(createFn));
  assert('4d: business_date/service_kind/opened_at are NOT caller-supplied params (server-derived from service_sessions only)', createFn && !/p_business_date|p_service_kind|p_opened_at/.test(createFn));
  assert('4e: requires an ACTIVE service_closeout_attempts row owning the exact (session, correlation) pair', createFn && /v_attempt\.status <> 'active'/.test(createFn) && /ATTEMPT_SESSION_MISMATCH/.test(createFn));
  assert('4f: total_discounts_cents is hardcoded 0 in the INSERT, not a caller param — no fabricated metric', createFn && /VALUES\s*\(/.test(createFn) && / 0, COALESCE\(p_total_refunds_cents/.test(createFn));
  assert('4g: never RAISEs for an expected outcome — every branch returns jsonb (Convention A)', createFn && !/RAISE EXCEPTION/.test(createFn));

  console.log('\n── PART 2 — close_service_session_v3 ──');
  const closeFn = extractFn(sql, 'close_service_session_v3');
  assert('5a: function created', !!closeFn);
  assert('5b: reuses the SAME advisory lock namespace as the legacy lifecycle RPCs (cross-engine mutual exclusion)', closeFn && closeFn.includes("pg_advisory_xact_lock(hashtext('service_session_lifecycle'))"));
  assert('5c: idempotent already-closed branch, mirroring complete_service_session_close\'s own check exactly', closeFn && /recent_closed_session_id = v_session\.id AND v_state\.current_session_id IS NULL/.test(closeFn) && /ALREADY_CLOSED/.test(closeFn));
  assert('5d: requires service_closeouts to already exist for the EXACT (session, correlation) pair', closeFn && /CLOSEOUT_NOT_FOUND/.test(closeFn) && /service_closeouts[\s\S]{0,120}closeout_correlation_id = p_closeout_correlation_id/.test(closeFn));
  assert('5e: requires an ACTIVE attempt', closeFn && /ATTEMPT_NOT_ACTIVE/.test(closeFn));
  assert('5f: verifies it is closing the CURRENT session (current_session_id must match)', closeFn && /CURRENT_SESSION_MISMATCH/.test(closeFn));
  assert('5g: never calls begin_service_session_close or complete_service_session_close (hard-banned legacy flow)', closeFn && !/\bbegin_service_session_close\s*\(/.test(closeFn) && !/\bcomplete_service_session_close\s*\(/.test(closeFn));
  assert('5h: never RAISEs for an expected outcome — every branch returns jsonb (Convention A)', closeFn && !/RAISE EXCEPTION/.test(closeFn));
  assert('5i: writes exactly one service_session_audit row, event_type closed', closeFn && /INSERT INTO public\.service_session_audit[\s\S]{0,120}'closed'/.test(closeFn));

  console.log('\n── PART 3 — guard_service_session_closed_v1: minimal, narrowly-scoped exemption ──');
  const liveSql = fs.readFileSync(LIVE_TRIGGER_SOURCE_PATH, 'utf8');
  const liveFn = extractFnTrigger(liveSql, 'guard_service_session_closed_v1');
  const newFn = extractFnTrigger(sql, 'guard_service_session_closed_v1');
  assert('6a: found the live (currently-applied) guard_service_session_closed_v1 body to diff against', !!liveFn);
  assert('6b: found the new guard_service_session_closed_v1 body in this migration', !!newFn);
  assert('6c: the live/deployed body is unconditional — no service_closeouts exemption exists yet (proves the diff below is meaningful)', liveFn && !liveFn.includes('service_closeouts') && liveFn.includes('MESA_TABLES_NOT_RELEASED'));
  assert('6d: the new body wraps MESA_TABLES_NOT_RELEASED in a NOT EXISTS(service_closeouts) guard', newFn && /NOT EXISTS[\s\S]{0,80}service_closeouts[\s\S]*MESA_TABLES_NOT_RELEASED/.test(newFn));
  assert('6e: a predecessor-body guard runs before the CREATE OR REPLACE, refusing to apply over a drifted/already-patched function', /pg_get_functiondef\(p\.oid\) INTO v_body/.test(sql) && /v_body NOT LIKE '%MESA_TABLES_NOT_RELEASED%'/.test(sql) && /v_body LIKE '%service_closeouts%'/.test(sql));

  // Every code line from the live body must still appear, in order, in the
  // new body — proves this is a pure wrap-in-a-condition, nothing removed,
  // nothing reordered (same subsequence technique as V3.1's own 3f check,
  // but nothing is excluded here since nothing is removed this time).
  const liveCode = liveFn ? codeLines(liveFn) : [];
  const newCode = newFn ? codeLines(newFn) : [];
  assert('6f: every code line from the live body appears, in order, in the new body', (() => {
    let i = 0;
    for (const line of newCode) { if (i < liveCode.length && line === liveCode[i]) i++; }
    return i === liveCode.length;
  })(), `liveCode.length=${liveCode.length} newCode.length=${newCode.length}`);

  // SERVICE_ACTIVE_ORDERS_NOT_RESOLVED block must be CODE-IDENTICAL (comments
  // stripped — the new body legitimately carries extra `language-guard:
  // allow-legacy` domain-vocabulary suppression comments around its terminal-
  // state literals that the live body doesn't have; the ACTUAL SQL code, not
  // the comments, is what must stay untouched) — this migration touches ONLY
  // the MESA_TABLES_NOT_RELEASED half, never this one.
  const ordersBlockMarker = "IF EXISTS (\n      SELECT 1\n      FROM public.ordenes o";
  const liveOrdersBlock = liveFn ? liveFn.slice(liveFn.indexOf(ordersBlockMarker)) : '';
  const newOrdersBlock = newFn ? newFn.slice(newFn.indexOf(ordersBlockMarker)) : '';
  const liveOrdersCode = codeLines(liveOrdersBlock).join('\n');
  const newOrdersCode = codeLines(newOrdersBlock).join('\n');
  assert('6g: SERVICE_ACTIVE_ORDERS_NOT_RESOLVED block is code-identical between live and new (untouched — only suppression comments differ)',
    liveOrdersBlock && newOrdersBlock && liveOrdersCode === newOrdersCode, `live.length=${liveOrdersCode.length} new.length=${newOrdersCode.length}`);

  console.log('\n── access control (Slice 1.3 discipline) ──');
  assert('7a: REVOKE ALL then GRANT EXECUTE ... TO service_role for both new functions, exact signatures', /REVOKE ALL ON FUNCTION[\s\S]{0,400}create_service_closeout\(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer\)[\s\S]{0,400}close_service_session_v3\(uuid,uuid,text,text\)/.test(sql));
  assert('7b: GRANT EXECUTE ... TO service_role (not PUBLIC/anon/authenticated) for both', /GRANT EXECUTE ON FUNCTION[\s\S]{0,400}TO service_role/.test(sql));
  assert('7c: no GRANT to PUBLIC, anon, or authenticated anywhere', !/GRANT[^;]*TO\s+(PUBLIC|anon|authenticated)\b/i.test(sqlWithoutComments));

  console.log('\n── rollback is a clean mirror ──');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  assert('8a: rollback restores guard_service_session_closed_v1 to the exact live pre-change body (byte-identical function body)', (() => {
    const rbFn = extractFnTrigger(rollback, 'guard_service_session_closed_v1');
    if (!rbFn || !liveFn) return false;
    return codeLines(rbFn).join('\n') === codeLines(liveFn).join('\n');
  })());
  assert('8b: rollback drops both new functions with matching exact signatures', rollback.includes('DROP FUNCTION IF EXISTS public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer)') && rollback.includes('DROP FUNCTION IF EXISTS public.close_service_session_v3(uuid,uuid,text,text)'));
  assert('8c: rollback touches no table directly (no ALTER/CREATE/DROP TABLE)', !/(ALTER|CREATE|DROP)\s+TABLE/i.test(rollback));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();

// guard_service_session_closed_v1 is a no-arg trigger function — its
// CREATE OR REPLACE marker has an empty arg list, unlike extractFn() above
// (used for the two new, many-argument RPCs).
function extractFnTrigger(src, name) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${name}()`;
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const j = src.indexOf('$fn$;', src.indexOf('$fn$', i + startMarker.length) + 4);
  return src.slice(i, j + 5);
}
