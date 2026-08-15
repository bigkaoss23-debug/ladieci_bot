'use strict';

// MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) — static structural proof for
// migrations/2026-08-14_mesa_covers_authoritative_on_selection.sql. Purely
// additive (one new RPC): these tests pin the exact guard/grant/signature
// contract, and that NOTHING else (mesa_prepare_table_order_v1, the
// monotonic guard trigger, mesa_release_empty_session_auto_v1) is touched.

const fs = require('node:fs');
const path = require('node:path');

const forward = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-14_mesa_covers_authoritative_on_selection.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(__dirname, '../migrations/2026-08-14_mesa_covers_authoritative_on_selection.ROLLBACK.sql'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  else { failed += 1; process.stderr.write(`  FAIL  ${name}\n`); }
}

test('migration is staging-only and guarded on the exact V3-J (mesa_*) predecessor',
  /STAGING ONLY|Staging-only/.test(forward)
  && /20260710075612/.test(forward)
  && /mesa_open_session_v1\(uuid,text,uuid,uuid,integer\)/.test(forward)
  && /mesa_release_empty_session_auto_v1\(uuid,uuid\)/.test(forward));

test('mesa_set_session_covers_v1 is created with the exact 4-argument signature',
  /CREATE FUNCTION public\.mesa_set_session_covers_v1\(\s*p_workspace_id uuid,\s*p_by_actor text,\s*p_table_session_id uuid,\s*p_covers_total integer\s*\)/.test(forward));

test('rejects a null/out-of-range covers value before touching any row', (() => {
  const body = forward.match(/CREATE FUNCTION public\.mesa_set_session_covers_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return /p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99/.test(body)
    && /MESA_INVALID_REQUEST/.test(body);
})());

test('requires an open session, matching addCommand\'s own guard vocabulary', (() => {
  const body = forward.match(/CREATE FUNCTION public\.mesa_set_session_covers_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return /MESA_SESSION_NOT_FOUND/.test(body) && /MESA_SESSION_NOT_OPEN/.test(body)
    && body.indexOf('MESA_SESSION_NOT_FOUND') < body.indexOf('MESA_SESSION_NOT_OPEN');
})());

test('same role set as addCommand (OPEN_ROLES) -- admin/operator/owner/cashier/waiter/legacy_operator', (() => {
  const body = forward.match(/CREATE FUNCTION public\.mesa_set_session_covers_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return /'admin','operator','owner','cashier','waiter','legacy_operator'/.test(body)
    && /MESA_OPEN_FORBIDDEN/.test(body);
})());

test('a waiter assigned to someone else\'s table is rejected', (() => {
  const body = forward.match(/CREATE FUNCTION public\.mesa_set_session_covers_v1[\s\S]*?\$fn\$;/)?.[0] || '';
  return /assigned_waiter_actor IS NOT NULL AND v_actor\.role = 'waiter'/.test(body)
    && /MESA_WAITER_NOT_ASSIGNED/.test(body);
})());

test('the UPDATE relies on the pre-existing monotonic guard trigger -- does not redefine or bypass it',
  // language-guard: allow-legacy messa is the pre-V3-J legacy function-name alternative this regex checks for the ABSENCE of (alongside the current mesa_ name), not new vocabulary
  !/CREATE (OR REPLACE )?(FUNCTION|TRIGGER) public\.(mesa|messa)_guard_covers_monotonic/i.test(forward)
  && /pre-existing monotonic guard trigger/.test(forward));

test('does not touch mesa_prepare_table_order_v1, mesa_release_empty_session_auto_v1, or mesa_open_session_v1',
  !/CREATE (OR REPLACE )?FUNCTION public\.mesa_prepare_table_order_v1/.test(forward)
  && !/CREATE (OR REPLACE )?FUNCTION public\.mesa_release_empty_session_auto_v1/.test(forward)
  && !/CREATE (OR REPLACE )?FUNCTION public\.mesa_open_session_v1/.test(forward));

test('no table/column is added, dropped, or altered -- purely a new function',
  !/ALTER TABLE/.test(forward) && !/DROP COLUMN/.test(forward) && !/ADD COLUMN/.test(forward));

test('function grants: service_role only, revoked from anon/authenticated/PUBLIC',
  /REVOKE ALL ON FUNCTION public\.mesa_set_session_covers_v1\(uuid,text,uuid,integer\) FROM PUBLIC, anon, authenticated/.test(forward)
  && /GRANT EXECUTE ON FUNCTION public\.mesa_set_session_covers_v1\(uuid,text,uuid,integer\) TO service_role/.test(forward));

test('the function is SECURITY INVOKER, matching every other mesa_* RPC',
  /LANGUAGE plpgsql\s*\nSECURITY INVOKER\s*\nSET search_path = public, pg_temp\s*\nAS \$fn\$/.test(forward));

test('wrapped in a single transaction (BEGIN...COMMIT)',
  /^BEGIN;/m.test(forward) && /\nCOMMIT;\s*$/.test(forward));

test('rollback drops exactly the new function and nothing else',
  /DROP FUNCTION IF EXISTS public\.mesa_set_session_covers_v1\(uuid,text,uuid,integer\)/.test(rollback)
  && !/DROP TABLE|DROP TRIGGER|ALTER TABLE/.test(rollback));

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exitCode = 1;
