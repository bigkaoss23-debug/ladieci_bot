'use strict';

const fs = require('node:fs');
const path = require('node:path');

const forward = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-02_v3k_mesa_table_shapes.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-02_v3k_mesa_table_shapes.ROLLBACK.sql'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  else { failed += 1; process.stderr.write(`  FAIL  ${name}\n`); }
}

test('migration is staging-only and guarded on the exact V3-J predecessor',
  /STAGING ONLY/.test(forward)
  && /20260710075612/.test(forward)
  && /mesa_save_table_v1\(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean\)/.test(forward)
  && /V3-K refused: exact V3-J predecessor/.test(forward));

test('shape_preset column is added NOT NULL with a standard default (existing rows backfilled)',
  /ADD COLUMN shape_preset text NOT NULL DEFAULT 'standard'/.test(forward));

test('exactly four (shape, shape_preset) combinations are valid -- square never got a second preset', (() => {
  const chk = forward.match(/ADD CONSTRAINT restaurant_tables_shape_preset_chk CHECK \(([\s\S]*?)\);/)?.[1] || '';
  return /shape = 'round' AND shape_preset = 'standard'/.test(chk)
    && /shape = 'square' AND shape_preset = 'standard'/.test(chk)
    && !/shape = 'square' AND shape_preset IN/.test(chk)
    && /shape = 'rectangle' AND shape_preset IN \('standard','long'\)/.test(chk)
    && !/'rounded'/.test(chk);
})());

test('old 10-arg mesa_save_table_v1 is explicitly dropped before the 11-arg one is created (true replace, not a second overload)', (() => {
  const dropIdx = forward.indexOf('DROP FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean);');
  const createIdx = forward.indexOf('CREATE FUNCTION public.mesa_save_table_v1(');
  return dropIdx >= 0 && createIdx > dropIdx;
})());

test('new signature appends p_shape_preset as the 11th, DEFAULT-ed argument (old callers still work)',
  /p_shape text,\s*p_active boolean,\s*p_shape_preset text DEFAULT 'standard'\s*\)/.test(forward));

test('server-side validation mirrors the DB constraint exactly (defense in depth)', (() => {
  const body = forward.match(/CREATE FUNCTION public\.mesa_save_table_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return /v_preset text := COALESCE\(p_shape_preset, 'standard'\)/.test(body)
    && /NOT \(\s*\(p_shape = 'round' AND v_preset = 'standard'\)/.test(body)
    && /RAISE EXCEPTION 'MESA_TABLE_INVALID'/.test(body);
})());

test('both insert and update branches persist shape_preset',
  /shape, shape_preset, active, created_by, updated_by/.test(forward)
  && /shape = p_shape, shape_preset = v_preset, active = p_active/.test(forward));

test('response payload echoes shapePreset back to the caller',
  /'shape', v_table\.shape, 'shapePreset', v_table\.shape_preset, 'active', v_table\.active/.test(forward));

test('grants: new 11-arg overload is revoked from anon/authenticated, service_role execute-only',
  /REVOKE ALL ON FUNCTION public\.mesa_save_table_v1\([^)]*,text\)\s*\n\s*FROM PUBLIC, anon, authenticated/.test(forward)
  && /GRANT EXECUTE ON FUNCTION public\.mesa_save_table_v1\([^)]*,text\)\s*\n\s*TO service_role/.test(forward));

test('this migration adds no new table, only extends restaurant_tables',
  !/CREATE TABLE/.test(forward));

test('capacity is never constrained by shape or preset -- always a plain 1-99 check, independent of p_shape/v_preset', (() => {
  const body = forward.match(/CREATE FUNCTION public\.mesa_save_table_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  const capacityLine = body.match(/OR \(p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 1 AND 99\)/)?.[0] || '';
  return capacityLine.length > 0 && !/p_shape/.test(capacityLine) && !/v_preset/.test(capacityLine);
})());

test('rollback refuses while any table still uses a non-standard preset',
  /shape_preset <> 'standard'/.test(rollback)
  && /rollback refused: a table uses a non-standard shape_preset/.test(rollback));

test('rollback restores the exact V3-J 10-arg signature and drops shape_preset',
  /CREATE FUNCTION public\.mesa_save_table_v1\(\s*p_workspace_id uuid,[\s\S]*?p_active boolean\s*\)/.test(rollback)
  && !/p_shape_preset/.test(rollback.match(/CREATE FUNCTION public\.mesa_save_table_v1\([\s\S]*?\$fn\$;/)?.[0] || 'p_shape_preset-marker-if-match-fails')
  && /ALTER TABLE public\.restaurant_tables DROP CONSTRAINT IF EXISTS restaurant_tables_shape_preset_chk/.test(rollback)
  && /ALTER TABLE public\.restaurant_tables DROP COLUMN shape_preset/.test(rollback));

process.stdout.write(`\n=== RESULT: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
