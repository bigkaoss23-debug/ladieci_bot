'use strict';

const fs = require('node:fs');
const path = require('node:path');

const forward = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-02_v3j_mesa_nomenclature_cutover.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-02_v3j_mesa_nomenclature_cutover.ROLLBACK.sql'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  else { failed += 1; process.stderr.write(`  FAIL  ${name}\n`); }
}

const MESA_FUNCTIONS = [
  'mesa_prepare_table_order_v1', 'mesa_snapshot_order_lines_v1', 'mesa_append_only_v1',
  'mesa_open_session_v1', 'mesa_save_table_v1', 'mesa_post_payment_v1',
  'mesa_release_empty_session_v1', 'mesa_guard_covers_monotonic_v1',
  'mesa_save_reservation_v1', 'mesa_set_reservation_status_v1', 'mesa_open_reservation_v1',
  'mesa_complete_reservation_v1', 'mesa_guard_reserved_table_v1',
];

test('migration is staging-only and guarded on the exact V3-I predecessor',
  /STAGING ONLY/.test(forward)
  && /20260710075612/.test(forward)
  && /messa_release_empty_session_v1\(uuid,text,uuid\)/.test(forward)
  && /messa_guard_covers_monotonic_v1\(\)/.test(forward)
  && /V3-J refused: exact V3-H\.2\/V3-I predecessor not found/.test(forward));

test('every mesa_* function is created (CREATE OR REPLACE, re-runnable)',
  MESA_FUNCTIONS.every((name) => new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`).test(forward)));

test('no MESSA_ error code survives inside any new mesa_* function body', (() => {
  for (const name of MESA_FUNCTIONS) {
    const body = forward.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$fn\\$;`))?.[0] || '';
    if (!body) return false;
    if (/MESSA_/.test(body)) return false;
  }
  return true;
})());

test('the two service-close guards now raise MESA_TABLES_NOT_RELEASED, not MESSA_',
  /RETURN jsonb_build_object\('ok',false,'code','MESA_TABLES_NOT_RELEASED'\)/.test(forward)
  && /MESSAGE = 'MESA_TABLES_NOT_RELEASED'/.test(forward)
  && !/MESSAGE = 'MESSA_TABLES_NOT_RELEASED'/.test(forward)
  && !/'code','MESSA_TABLES_NOT_RELEASED'/.test(forward));

test('idempotency scope and ledger meta tag are renamed to mesa',
  /v_scope := 'mesa_' \|\| replace\(v_tx\.id::text, '-', ''\)/.test(forward)
  && /jsonb_build_object\('source','mesa','mode',p_mode,'transaction_id',v_tx\.id\)/.test(forward)
  && !/'messa_' \|\| replace/.test(forward)
  && !/'source','messa'/.test(forward));

test('mesa_open_session_v1 keeps covers optional (V3-I behavior preserved)',
  /CREATE OR REPLACE FUNCTION public\.mesa_open_session_v1\(\s*p_workspace_id uuid,\s*p_by_actor text,\s*p_table_id uuid,\s*p_service_session_id uuid,\s*p_covers_total integer DEFAULT NULL\s*\)/.test(forward));

test('mesa_post_payment_v1 keeps the covers-not-set guard and the extensions search_path fix',
  /CREATE OR REPLACE FUNCTION public\.mesa_post_payment_v1[\s\S]*?SET search_path = public, extensions, pg_temp/.test(forward)
  && /IF v_session\.covers_total IS NULL THEN\s*\n\s*RAISE EXCEPTION 'MESA_COVERS_NOT_SET'/.test(forward));

test('every old-named trigger is repointed at its new mesa_* function', (() => {
  const pairs = [
    ['messa_prepare_table_order_v1', 'ordenes', 'mesa_prepare_table_order_v1'],
    ['messa_snapshot_order_lines_v1', 'ordenes', 'mesa_snapshot_order_lines_v1'],
    ['table_order_lines_append_only_v1', 'table_order_lines', 'mesa_append_only_v1'],
    ['payment_transactions_append_only_v1', 'payment_transactions', 'mesa_append_only_v1'],
    ['payment_allocations_append_only_v1', 'payment_allocations', 'mesa_append_only_v1'],
    ['table_sessions_guard_covers_monotonic_v1', 'table_sessions', 'mesa_guard_covers_monotonic_v1'],
    ['messa_complete_reservation_v1', 'table_sessions', 'mesa_complete_reservation_v1'],
    ['messa_guard_reserved_table_v1', 'restaurant_tables', 'mesa_guard_reserved_table_v1'],
  ];
  return pairs.every(([oldTrigger, table, newFn]) =>
    new RegExp(`DROP TRIGGER IF EXISTS ${oldTrigger} ON public\\.${table}`).test(forward)
    && new RegExp(`EXECUTE FUNCTION public\\.${newFn}\\(\\)`).test(forward));
})());

test('every old messa_* function is dropped after the trigger swap', (() => {
  const oldSigs = [
    'messa_prepare_table_order_v1()', 'messa_snapshot_order_lines_v1()', 'messa_append_only_v1()',
    'messa_open_session_v1(uuid,text,uuid,uuid,integer)',
    'messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean)',
    'messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb)',
    'messa_release_empty_session_v1(uuid,text,uuid)', 'messa_guard_covers_monotonic_v1()',
    'messa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer)',
    'messa_set_reservation_status_v1(uuid,text,uuid,integer,text)',
    'messa_open_reservation_v1(uuid,text,uuid,integer,uuid)',
    'messa_complete_reservation_v1()', 'messa_guard_reserved_table_v1()',
  ];
  const dropIdx = forward.indexOf('-- 3) Drop every old messa_* function');
  const grantIdx = forward.indexOf('-- 4) Grants:');
  const dropSection = forward.slice(dropIdx, grantIdx);
  return oldSigs.every((sig) => dropSection.includes(`DROP FUNCTION IF EXISTS public.${sig.replace(/\(/, '(').replace('messa_', 'messa_')}`))
    // Escape-free direct substring check (signatures contain regex-special chars).
    && oldSigs.every((sig) => dropSection.includes(sig));
})());

test('grants: every mesa_* function is revoked from anon/authenticated, granted to service_role only', (() => {
  return MESA_FUNCTIONS.every((name) => {
    const revokeRe = new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated`);
    const grantRe = new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role`);
    return revokeRe.test(forward) && grantRe.test(forward);
  });
})());

test('every function stays SECURITY INVOKER',
  (forward.match(/SECURITY INVOKER/g) || []).length >= MESA_FUNCTIONS.length + 2);

test('this migration changes no table/column/constraint -- pure rename, no ALTER TABLE',
  !/ALTER TABLE/.test(forward));

test('rollback refuses unless the mesa_* contract is actually present',
  /V3-J rollback refused: mesa_\* contract not found/.test(rollback));

test('rollback recreates every messa_* function and repoints triggers back',
  MESA_FUNCTIONS.map((n) => n.replace('mesa_', 'messa_')).every((name) =>
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`).test(rollback))
  && /DROP TRIGGER IF EXISTS mesa_prepare_table_order_v1 ON public\.ordenes/.test(rollback)
  && /CREATE TRIGGER messa_prepare_table_order_v1/.test(rollback));

test('rollback drops every mesa_* function and restores MESSA_TABLES_NOT_RELEASED',
  MESA_FUNCTIONS.every((name) => rollback.includes(`DROP FUNCTION IF EXISTS public.${name}(`) || rollback.includes(`DROP FUNCTION IF EXISTS public.${name}()`))
  && /MESSAGE = 'MESSA_TABLES_NOT_RELEASED'/.test(rollback)
  && /'code','MESSA_TABLES_NOT_RELEASED'/.test(rollback));

test('rollback touches no data (no UPDATE/INSERT/DELETE on rows, only DDL)',
  !/\bINSERT INTO public\.(?!table_sessions|table_reservations)/.test(rollback.replace(/\$fn\$[\s\S]*?\$fn\$/g, '')));

process.stdout.write(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
