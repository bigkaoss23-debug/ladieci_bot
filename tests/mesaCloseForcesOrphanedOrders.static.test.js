'use strict';
// P0-B — static test over the mesa_close_forces_orphaned_orders migration SQL
// text itself, same convention as tests/serviceLifecycleV3CloseOwnershipHardening
// .static.test.js. Real-Postgres behavioral validation (BEGIN/DO/ROLLBACK probe,
// then the real apply) is documented in MESA_P0_B_ORDER_TERMINALIZATION_REPORT.md,
// not here — this file only proves the SQL TEXT has the properties it claims.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-10_mesa_close_forces_orphaned_orders.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-10_mesa_close_forces_orphaned_orders.ROLLBACK.sql');
const PREDECESSOR_PATH = path.join(ROOT, 'migrations', '2026-08-02_v3j_mesa_nomenclature_cutover.sql');

function extractFn(src, name) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const j = src.indexOf('$fn$;', src.indexOf('$fn$', i + startMarker.length) + 4);
  return src.slice(i, j + 5);
}

const TERMINAL_LIST = "'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'";

(async () => {
  console.log('\n== P0-B mesa_close_forces_orphaned_orders — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  assert('0c: predecessor (row 51, mesa_post_payment_v1 origin) file exists', fs.existsSync(PREDECESSOR_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const predecessorSql = fs.readFileSync(PREDECESSOR_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety / additive-only ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: requires mesa_post_payment_v1 already exists (predecessor guard)', sql.includes("to_regprocedure('public.mesa_post_payment_v1("));
  const destructivePatterns = [/DROP\s+TABLE/i, /DROP\s+FUNCTION/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i, /ALTER\s+TABLE/i];
  for (const re of destructivePatterns) {
    assert('1c: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('1d: no GRANT/REVOKE anywhere — only redefines an existing, already-granted function body', !/\b(REVOKE|GRANT)\b/i.test(sqlWithoutComments));

  console.log('\n── predecessor-body guard is real and not a false positive ──');
  assert('2a: guard checks for table_closed_forced, NOT bare CHIUSO_FORZATO', sql.includes("ILIKE '%table_closed_forced%'"));
  assert('2b: predecessor (unpatched) body already contains CHIUSO_FORZATO in its own billing filters (proves 2a is the right choice — a bare-CHIUSO_FORZATO guard would always false-positive)', predecessorSql.includes('CHIUSO_FORZATO'));
  assert('2c: predecessor (unpatched) body does NOT contain table_closed_forced', !predecessorSql.includes('table_closed_forced'));

  console.log('\n── function signature unchanged ──');
  const fn = extractFn(sql, 'mesa_post_payment_v1');
  const predecessorFn = extractFn(predecessorSql, 'mesa_post_payment_v1');
  assert('3a: mesa_post_payment_v1 present in forward migration', !!fn);
  assert('3b: mesa_post_payment_v1 present in predecessor', !!predecessorFn);
  const sigOf = (f) => f && f.slice(0, f.indexOf(')\nRETURNS'));
  assert('3c: parameter list byte-identical to predecessor (no new/removed/reordered param)', sigOf(fn) === sigOf(predecessorFn));

  console.log('\n── financial logic above the new block is unchanged from predecessor ──');
  const financialBoundaryMarker = "-- P0-B FIX";
  const preBlock = fn.slice(0, fn.indexOf(financialBoundaryMarker));
  const predecessorPreBlock = predecessorFn.slice(0, predecessorFn.indexOf("RETURN jsonb_build_object("));
  const normalize = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  // predecessorPreBlock includes the table_sessions UPDATE + its END IF; ours
  // has the identical UPDATE but the END IF moves after our new block, so
  // compare the normalized text only up through the UPDATE statement itself.
  const closeUpdateMarker = "table_sessions SET";
  const oursNorm = normalize(preBlock);
  const predecessorNorm = normalize(predecessorPreBlock);
  const cut = predecessorNorm.indexOf(closeUpdateMarker, predecessorNorm.lastIndexOf('IF v_table_remaining_cents'));
  const endOfUpdate = predecessorNorm.indexOf(';', cut) + 1;
  assert('4a: financial logic (validation/allocations/financial-events/cobrado projection/table close UPDATE) is unchanged from predecessor, whitespace aside', oursNorm.slice(0, endOfUpdate) === predecessorNorm.slice(0, endOfUpdate));

  console.log('\n── new block correctness ──');
  assert('5a: new block is scoped to table_session_id = v_session.id only', /WHERE o\.table_session_id = v_session\.id\s*$/m.test(fn) || fn.includes('o.table_session_id = v_session.id'));
  assert('5b: excludes rows already in the full terminal set (idempotent, correct exclusion list)', fn.includes(TERMINAL_LIST));
  assert('5c: also excludes NULL estado (matches guard_service_session_closed_v1\'s own IS NULL treatment)', fn.includes('o.estado IS NULL OR upper(o.estado) NOT IN'));
  assert('5d: target state is CHIUSO_FORZATO', fn.includes("estado = 'CHIUSO_FORZATO'"));
  assert('5e: target state is NEVER RETIRADO in the new block (would dishonestly claim confirmed service)', !fn.slice(fn.indexOf(financialBoundaryMarker)).includes("'RETIRADO'") || fn.slice(fn.indexOf(financialBoundaryMarker), fn.indexOf(financialBoundaryMarker) + 50).includes('RETIRADO') === false);
  assert('5f: writes an orden_estado_logs audit row', fn.includes('INSERT INTO public.orden_estado_logs'));
  assert('5g: audit row event_type is distinct/traceable (table_closed_forced)', fn.includes("'table_closed_forced'"));
  assert('5h: audit row actor_type is system, not a fabricated human confirmation', fn.includes("'system', p_by_actor"));
  assert('5i: audit row captures estado_from (old value) for a real before/after trail', fn.includes('t.old_estado') && fn.includes('c.old_estado'));
  assert('5j: audit metadata includes the payment_transaction_id for traceability', fn.includes("'payment_transaction_id', v_tx.id"));
  assert('5k: new block only runs inside the v_table_remaining_cents = 0 branch (never on a partial payment)', fn.indexOf(financialBoundaryMarker) > fn.indexOf('IF v_table_remaining_cents = 0 THEN'));
  assert('5l: locks candidate rows (FOR UPDATE) before transitioning — no lost-update race', fn.includes('FOR UPDATE OF o'));

  console.log('\n── rollback restores the exact pre-fix body ──');
  const rollbackFn = extractFn(rollback, 'mesa_post_payment_v1');
  assert('6a: rollback redefines mesa_post_payment_v1', !!rollbackFn);
  assert('6b: rollback body is byte-identical to the predecessor body', rollbackFn === predecessorFn);
  assert('6c: rollback wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback));
  assert('6d: rollback contains no DROP FUNCTION (schema/behavior revert only, not a delete)', !/DROP\s+FUNCTION/i.test(rollback));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
})();
