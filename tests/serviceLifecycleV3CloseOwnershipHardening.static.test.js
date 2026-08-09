'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.2.1 — static test over the close-ownership-
// hardening migration SQL text itself, same convention as tests/
// serviceLifecycleV3CloseEngineMigration.static.test.js (no live Postgres
// available/permitted in this environment for a NEW, unapplied migration —
// STAGING ONLY, no database mutation). Real-Postgres validation (where
// available) is documented separately in the session report, not here.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_close_ownership_hardening.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_close_ownership_hardening.ROLLBACK.sql');
const PREDECESSOR_PATH = path.join(ROOT, 'migrations', '2026-08-09_service_lifecycle_v3_close_engine.sql');

function extractFn(src, name) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const j = src.indexOf('$fn$;', src.indexOf('$fn$', i + startMarker.length) + 4);
  return src.slice(i, j + 5);
}
function extractFnTrigger(src, name) {
  const startMarker = `CREATE OR REPLACE FUNCTION public.${name}()`;
  const i = src.indexOf(startMarker);
  if (i === -1) return null;
  const j = src.indexOf('$fn$;', src.indexOf('$fn$', i + startMarker.length) + 4);
  return src.slice(i, j + 5);
}
function codeLines(fnText) {
  return fnText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--'));
}

const MARKER = 'ladieci.v3_close_authorized_session_id';

(async () => {
  console.log('\n== service lifecycle v3 close ownership hardening (Slice 3.2.1) — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  assert('0c: predecessor (row 58) migration file exists', fs.existsSync(PREDECESSOR_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const predecessorSql = fs.readFileSync(PREDECESSOR_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  console.log('\n── staging safety ──');
  assert('1a: wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/m.test(sql));
  assert('1b: staging sentinel guard present', sql.includes("schema_migrations WHERE version='20260710075612'"));
  assert('1c: requires row 58 (close_service_session_v3) already applied', sql.includes("to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL"));
  assert('1d: requires row 58 (guard_service_session_closed_v1) already applied', sql.includes("to_regprocedure('public.guard_service_session_closed_v1()') IS NULL"));

  console.log('\n── additive-only, no new table, no destructive statement ──');
  const destructivePatterns = [/DROP\s+TABLE/i, /DROP\s+FUNCTION/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i, /ALTER\s+TABLE/i];
  for (const re of destructivePatterns) {
    assert('2: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('2b: no GRANT to PUBLIC, anon, or authenticated anywhere (grants unchanged by CREATE OR REPLACE)', !/GRANT[^;]*TO\s+(PUBLIC|anon|authenticated)\b/i.test(sqlWithoutComments));
  assert('2c: no REVOKE/GRANT statements at all — this migration only redefines existing, already-granted function bodies', !/\b(REVOKE|GRANT)\b/i.test(sqlWithoutComments));

  console.log('\n── predecessor-body guards refuse to apply over drift or a double-patch ──');
  assert('3a: a predecessor-body guard runs for close_service_session_v3', /proname = 'close_service_session_v3'/.test(sql) && /already references v3_close_authorized_session_id/.test(sql));
  assert('3b: a predecessor-body guard runs for guard_service_session_closed_v1', /proname = 'guard_service_session_closed_v1'/.test(sql));
  assert('3c: refuses if guard_service_session_closed_v1 does not yet carry the row-58 service_closeouts exemption (row 58 not applied)', sql.includes('does not yet carry the row-58 service_closeouts exemption'));
  // Regression guard for a real bug caught only by real-Postgres validation
  // (see the session report): pg_get_function_identity_arguments() returns
  // the function's ACTUAL parameter names (p_-prefixed, per row 58's own
  // signature), never a caller's preferred short names — a mismatch here
  // makes the predecessor-body guard ALWAYS refuse ("body not found"),
  // permanently blocking this migration from ever applying.
  assert('3d: the close_service_session_v3 predecessor-body guard matches the REAL p_-prefixed parameter names (not a shortened guess)',
    sql.includes("pg_get_function_identity_arguments(p.oid) = 'p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text'"));

  console.log('\n── PART 1 — close_service_session_v3: exactly one new line, everything else untouched ──');
  const predecessorCloseFn = extractFn(predecessorSql, 'close_service_session_v3');
  const newCloseFn = extractFn(sql, 'close_service_session_v3');
  const rollbackCloseFn = extractFn(rollback, 'close_service_session_v3');
  assert('4a: found the row-58 close_service_session_v3 body to diff against', !!predecessorCloseFn);
  assert('4b: found the new close_service_session_v3 body in this migration', !!newCloseFn);
  assert('4c: same signature as row 58 (uuid,uuid,text,text)', newCloseFn && newCloseFn.startsWith('CREATE OR REPLACE FUNCTION public.close_service_session_v3(\n  p_service_session_id      uuid,'));
  assert('4d: sets the transaction-local marker via set_config', newCloseFn && newCloseFn.includes(`set_config('${MARKER}', v_session.id::text, true)`));
  assert('4e: is_local=true (third arg) — transaction-scoped, never session/pooled-connection-scoped', newCloseFn && new RegExp(`set_config\\('${MARKER.replace(/\./g, '\\.')}',\\s*v_session\\.id::text,\\s*true\\)`).test(newCloseFn));
  assert('4f: bound to v_session.id (the exact session being closed), not a bare boolean/constant', newCloseFn && newCloseFn.includes(`v_session.id::text, true)`));

  // Ordering: the marker must be set AFTER every validation (ATTEMPT_NOT_ACTIVE
  // is the last check before mutation) and BEFORE the terminal UPDATE.
  {
    const iAttemptCheck = newCloseFn ? newCloseFn.indexOf('ATTEMPT_NOT_ACTIVE') : -1;
    const iSetConfig = newCloseFn ? newCloseFn.indexOf('set_config') : -1;
    const iUpdate = newCloseFn ? newCloseFn.indexOf("SET status = 'closed'") : -1;
    assert('4g: set_config() runs AFTER the last validation (ATTEMPT_NOT_ACTIVE) and BEFORE the terminal UPDATE — never before a check could still refuse',
      iAttemptCheck !== -1 && iSetConfig !== -1 && iUpdate !== -1 && iAttemptCheck < iSetConfig && iSetConfig < iUpdate,
      `iAttemptCheck=${iAttemptCheck} iSetConfig=${iSetConfig} iUpdate=${iUpdate}`);
  }

  // Every code line from row 58's body must still appear, in order, in the new
  // body (subsequence check — same technique as row 58's own 6f) — proves
  // this is a pure one-line insertion, nothing removed or reordered.
  {
    const predCode = predecessorCloseFn ? codeLines(predecessorCloseFn) : [];
    const newCode = newCloseFn ? codeLines(newCloseFn) : [];
    let i = 0;
    for (const line of newCode) { if (i < predCode.length && line === predCode[i]) i++; }
    assert('4h: every code line from the row-58 body appears, in order, in the new body (pure insertion)', i === predCode.length, `predCode.length=${predCode.length} newCode.length=${newCode.length} matched=${i}`);
    assert('4i: exactly one net new non-comment code line added (the set_config call)', newCode.length === predCode.length + 1, `predCode.length=${predCode.length} newCode.length=${newCode.length}`);
  }

  console.log('\n── PART 2 — guard_service_session_closed_v1: exemption now requires marker AND closeout ──');
  const predecessorGuardFn = extractFnTrigger(predecessorSql, 'guard_service_session_closed_v1');
  const newGuardFn = extractFnTrigger(sql, 'guard_service_session_closed_v1');
  const rollbackGuardFn = extractFnTrigger(rollback, 'guard_service_session_closed_v1');
  assert('5a: found the row-58 guard_service_session_closed_v1 body to diff against', !!predecessorGuardFn);
  assert('5b: found the new guard_service_session_closed_v1 body in this migration', !!newGuardFn);
  assert('5c: row-58 body\'s exemption is EXISTS(closeout) alone — proves the diff below is meaningful', predecessorGuardFn && /IF NOT EXISTS \(\s*SELECT 1 FROM public\.service_closeouts/.test(predecessorGuardFn));
  assert('5d: new body requires current_setting(marker) = OLD.id::text', newGuardFn && newGuardFn.includes(`current_setting('${MARKER}', true) = OLD.id::text`));
  assert('5e: new body still requires the service_closeouts row too (defense in depth, not marker-alone)', newGuardFn && /EXISTS \(\s*SELECT 1 FROM public\.service_closeouts c WHERE c\.service_session_id = OLD\.id\s*\)/.test(newGuardFn));
  assert('5f: the marker check and the closeout check are joined by AND inside one NOT (...)', newGuardFn && /IF NOT \(\s*current_setting\(/.test(newGuardFn));
  assert('5g: current_setting uses missing_ok=true (never raises if unset — a session with no marker at all must be denied, not error)', newGuardFn && new RegExp(`current_setting\\('${MARKER.replace(/\./g, '\\.')}',\\s*true\\)`).test(newGuardFn));
  assert('5h: same GUC name literal used in both PART 1 (set_config) and PART 2 (current_setting) — no typo mismatch', newCloseFn && newGuardFn && newCloseFn.includes(`'${MARKER}'`) && newGuardFn.includes(`'${MARKER}'`));
  assert('5i: never RAISEs for the marker/closeout check itself — only MESA_TABLES_NOT_RELEASED/SERVICE_ACTIVE_ORDERS_NOT_RESOLVED raise, same as row 58', newGuardFn && (newGuardFn.match(/RAISE EXCEPTION/g) || []).length === 2);

  // SERVICE_ACTIVE_ORDERS_NOT_RESOLVED block must be CODE-IDENTICAL
  // (comment-stripped) between row 58 and this migration — untouched.
  {
    const ordersBlockMarker = "IF EXISTS (\n      SELECT 1\n      FROM public.ordenes o";
    const predOrdersBlock = predecessorGuardFn ? predecessorGuardFn.slice(predecessorGuardFn.indexOf(ordersBlockMarker)) : '';
    const newOrdersBlock = newGuardFn ? newGuardFn.slice(newGuardFn.indexOf(ordersBlockMarker)) : '';
    const predOrdersCode = codeLines(predOrdersBlock).join('\n');
    const newOrdersCode = codeLines(newOrdersBlock).join('\n');
    assert('5j: SERVICE_ACTIVE_ORDERS_NOT_RESOLVED block is code-identical between row 58 and this migration (untouched)',
      predOrdersBlock && newOrdersBlock && predOrdersCode === newOrdersCode, `pred.length=${predOrdersCode.length} new.length=${newOrdersCode.length}`);
  }

  // MESA_TABLES_NOT_RELEASED's own RAISE body (message, table_sessions check
  // shape) must also be untouched — only the guarding condition around it changed.
  {
    const mesaBlockMarker = 'RAISE EXCEPTION USING\n          ERRCODE = \'P0001\',\n          MESSAGE = \'MESA_TABLES_NOT_RELEASED\'';
    assert('5k: MESA_TABLES_NOT_RELEASED RAISE body present verbatim in the new guard', newGuardFn && newGuardFn.includes(mesaBlockMarker));
    assert('5l: table_sessions.status = \'open\' scan is untouched', newGuardFn && /FROM public\.table_sessions t\s*WHERE t\.service_session_id = OLD\.id\s*AND t\.status = 'open'/.test(newGuardFn));
  }

  console.log('\n── rollback restores BOTH functions to their exact row-58 bodies ──');
  assert('6a: rollback restores close_service_session_v3 to the exact row-58 body (byte-identical, no marker)', (() => {
    if (!rollbackCloseFn || !predecessorCloseFn) return false;
    return codeLines(rollbackCloseFn).join('\n') === codeLines(predecessorCloseFn).join('\n');
  })());
  assert('6b: rollback restores guard_service_session_closed_v1 to the exact row-58 body (byte-identical, EXISTS(closeout) only)', (() => {
    if (!rollbackGuardFn || !predecessorGuardFn) return false;
    return codeLines(rollbackGuardFn).join('\n') === codeLines(predecessorGuardFn).join('\n');
  })());
  assert('6c: rollback drops nothing (no DROP FUNCTION) — both functions pre-existed row 59, only their bodies revert', !/DROP\s+FUNCTION/i.test(rollback));
  assert('6d: rollback touches no table directly', !/(ALTER|CREATE|DROP)\s+TABLE/i.test(rollback));
  assert('6e: rollback wrapped in BEGIN/COMMIT', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/m.test(rollback));

  console.log('\n── no HTTP-reachable override of any kind ──');
  assert('7a: close_service_session_v3 signature is unchanged (still exactly 4 params) — no new boolean/flag parameter of any kind', newCloseFn && /CREATE OR REPLACE FUNCTION public\.close_service_session_v3\(\s*p_service_session_id\s+uuid,\s*p_closeout_correlation_id\s+uuid,\s*p_closed_by\s+text,\s*p_source\s+text\s*\)/.test(newCloseFn));
  assert('7b: no "allowOpenTablesAcrossBoundary" or similar override literal in any actual SQL code (comments may discuss its absence by name)', !/allowOpenTablesAcrossBoundary/i.test(sqlWithoutComments));
  assert('7c: no request/body/query-shaped parameter name anywhere in either new function', !/p_allow|p_override|p_bypass|p_force/i.test(sqlWithoutComments));

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
