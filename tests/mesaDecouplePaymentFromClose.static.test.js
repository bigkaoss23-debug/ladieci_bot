'use strict';
// P0-B.1 — static test over the mesa_decouple_payment_from_close migration
// SQL text itself, same convention as tests/mesaCloseForcesOrphanedOrders
// .static.test.js. Real-Postgres behavioral validation (BEGIN/DO/ROLLBACK
// probe, then the real apply) is documented in
// MESA_P0_B_1_RECOVERY_REPORT.md, not here -- this file only proves the SQL
// TEXT has the properties it claims: payment and table-completion are
// structurally separated, and CHIUSO_FORZATO can only ever come from an
// explicit, audited, operator-forced close -- never from payment alone.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-10_mesa_decouple_payment_from_close.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-10_mesa_decouple_payment_from_close.ROLLBACK.sql');
const PREDECESSOR_PATH = path.join(ROOT, 'migrations', '2026-08-10_mesa_close_forces_orphaned_orders.sql');

function extractFn(src, name) {
  const markers = [`CREATE OR REPLACE FUNCTION public.${name}(`, `CREATE FUNCTION public.${name}(`];
  let i = -1;
  for (const m of markers) { i = src.indexOf(m); if (i !== -1) break; }
  if (i === -1) return null;
  const j = src.indexOf('$fn$;', src.indexOf('$fn$', i) + 4);
  return src.slice(i, j + 5);
}

(async () => {
  console.log('\n== P0-B.1 mesa_decouple_payment_from_close — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  assert('0c: predecessor (P0-B, mesa_post_payment_v1 close-coupled body) file exists', fs.existsSync(PREDECESSOR_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const predecessorSql = fs.readFileSync(PREDECESSOR_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: predecessor-body guard: refuses unless mesa_post_payment_v1 still carries the P0-B body', sql.includes("ILIKE '%table_closed_forced%'"));
  assert('1c: idempotent-safe guard: refuses if mesa_close_session_v1 already exists', sql.includes('mesa_close_session_v1(uuid,text,uuid,boolean)') && sql.includes('already exists'));
  const destructivePatterns = [/DROP\s+TABLE/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i, /ALTER\s+TABLE/i];
  for (const re of destructivePatterns) {
    assert('1d: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('1e: forward migration contains no DROP FUNCTION (both parts are CREATE [OR REPLACE], never a drop)', !/DROP\s+FUNCTION/i.test(sqlWithoutComments));

  console.log('\n── grants: mesa_close_session_v1 is service_role-only ──');
  assert('2a: REVOKE ALL from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.mesa_close_session_v1[\s\S]*FROM PUBLIC,\s*anon,\s*authenticated/.test(sql));
  assert('2b: GRANT EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.mesa_close_session_v1[\s\S]*TO service_role/.test(sql));

  console.log('\n── PART 1: mesa_post_payment_v1 becomes payment-only ──');
  const fn1 = extractFn(sql, 'mesa_post_payment_v1');
  const predecessorFn = extractFn(predecessorSql, 'mesa_post_payment_v1');
  assert('3a: mesa_post_payment_v1 present in forward migration', !!fn1);
  assert('3b: mesa_post_payment_v1 present in predecessor (P0-B)', !!predecessorFn);
  const sigOf = (f) => f && f.slice(0, f.indexOf(')\nRETURNS'));
  assert('3c: parameter list byte-identical to predecessor (no new/removed/reordered param)', sigOf(fn1) === sigOf(predecessorFn));
  assert('3d: no longer force-terminalizes orders (table_closed_forced marker removed)', !fn1.includes('table_closed_forced'));
  assert('3e: never writes table_sessions again (financial settlement only)', !fn1.includes('table_sessions SET') && !/UPDATE\s+public\.table_sessions/i.test(fn1));
  assert('3f: never writes ordenes.estado (only the legacy cobrado/ya_pagado/metodo_pago projection remains)', !/ordenes\s+o\s+SET\s+estado/i.test(fn1) && !fn1.includes("estado = 'CHIUSO_FORZATO'"));
  assert('3g: legacy cobrado/ya_pagado projection is still present (untouched compatibility path)', fn1.includes('cobrado = calc.is_paid') && fn1.includes('ya_pagado = calc.is_paid'));
  assert('3h: tableStatus in the response is now the literal, structurally-guaranteed \'open\' (not a financial guess)', /'tableStatus',\s*'open'/.test(fn1));
  assert('3i: idempotent replay path untouched (still returns the committed transaction on retry)', fn1.includes("'idempotent', true"));

  console.log('\n── financial logic above the removed close block is unchanged from predecessor ──');
  // Comments are allowed (in fact required) to differ in wording -- code is
  // the invariant being checked here, not prose.
  const codeOnly = (s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).map((l) => l.trim()).filter(Boolean).join('\n');
  const allocationMarker = 'Mirror one event per affected kitchen command';
  const ours1 = codeOnly(fn1.slice(0, fn1.indexOf(allocationMarker)));
  const predecessor1 = codeOnly(predecessorFn.slice(0, predecessorFn.indexOf(allocationMarker)));
  assert('4a: validation/replay/session-lookup/mode-resolution/allocation-loop code is unchanged from predecessor, comments/whitespace aside', ours1 === predecessor1);

  console.log('\n── PART 2: mesa_close_session_v1 is a genuinely new, explicit close ──');
  const fn2 = extractFn(sql, 'mesa_close_session_v1');
  assert('5a: mesa_close_session_v1 present', !!fn2);
  assert('5b: signature is (uuid,text,uuid,boolean) with p_force defaulting to false', fn2.includes('p_table_session_id uuid') && fn2.includes('p_force boolean DEFAULT false'));
  assert('5c: financial safety check appears BEFORE the p_force branch (never overridden by force)', fn2.indexOf('MESA_TABLE_NOT_SETTLED') < fn2.indexOf('IF NOT p_force'));
  assert('5d: outstanding > 0 always raises MESA_TABLE_NOT_SETTLED, force or not (no force check guards it)', /IF v_outstanding_cents > 0 THEN\s*\n\s*RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED'/.test(fn2));
  assert('5e: non-terminal orders block close by default (p_force=false)', fn2.includes("IF NOT p_force THEN") && fn2.includes('MESA_TABLE_HAS_ACTIVE_ORDERS'));
  assert('5f: force path terminalizes to CHIUSO_FORZATO, never assigns RETIRADO (honest -- cannot claim confirmed service)', fn2.includes("estado = 'CHIUSO_FORZATO'") && !fn2.includes("estado = 'RETIRADO'"));
  assert('5g: force path writes an audited orden_estado_logs row', fn2.includes('INSERT INTO public.orden_estado_logs'));
  assert('5h: force-close audit actor_type is operator (a real, explicit human decision -- not a system side-effect)', fn2.includes("'operator', p_by_actor, 'mesa_close_session_force'"));
  assert('5i: force-close audit event_type is distinct/traceable (table_closed_forced)', fn2.includes("'table_closed_forced'"));
  assert('5j: forced/forcedOrderCount are surfaced honestly in the response', fn2.includes("'forced', v_forced_count > 0") && fn2.includes("'forcedOrderCount', v_forced_count"));
  assert('5k: idempotent-safe: a retry after success fails closed before any mutation (matches mesa_release_empty_session_v1 precedent)', fn2.indexOf('MESA_SESSION_NOT_OPEN') < fn2.indexOf('MESA_TABLE_NOT_SETTLED'));
  assert('5l: locks the table_sessions row FOR UPDATE before deciding', fn2.includes('FROM public.table_sessions\n   WHERE id = p_table_session_id') && fn2.includes('FOR UPDATE'));
  assert('5m: locks candidate orphaned orders FOR UPDATE before transitioning -- no lost-update race', fn2.includes('FOR UPDATE OF o'));
  assert('5n: eligible roles match releaseEmptyTable\'s own OPEN_ROLES exactly (operational floor action, not financial)', fn2.includes("'admin','operator','owner','cashier','waiter','legacy_operator'"));
  assert('5o: table only closes after (and structurally cannot close before) both the financial and kitchen gates', fn2.indexOf("status = 'closed'") > fn2.indexOf('KITCHEN/ORDER COMPLETENESS'));

  console.log('\n── rollback restores the exact P0-B (predecessor) body and removes only what this migration added ──');
  const rollbackFn = extractFn(rollback, 'mesa_post_payment_v1');
  assert('6a: rollback redefines mesa_post_payment_v1', !!rollbackFn);
  // Comments legitimately differ: the predecessor's own header comment says
  // "see this file's header", which would be a dangling self-reference if
  // copied verbatim into the rollback file, so the rollback correctly
  // rewords it to name the predecessor file explicitly. Code is the
  // invariant, not prose.
  assert('6b: rollback body is code-identical to the P0-B predecessor body (comments aside)', codeOnly(rollbackFn) === codeOnly(predecessorFn));
  assert('6c: rollback wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback));
  assert('6d: rollback drops mesa_close_session_v1 (the only migration that ever created it)', /DROP FUNCTION IF EXISTS public\.mesa_close_session_v1/.test(rollback));
  assert('6e: rollback does not drop or alter mesa_release_empty_session_v1 (untouched by this whole slice)', !rollback.includes('mesa_release_empty_session_v1'));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
})();
