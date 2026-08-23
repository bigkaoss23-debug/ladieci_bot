'use strict';
// N-1 — static test over the mesa_force_close_estado_write_removal migration
// SQL text itself, same convention as tests/mesaDecouplePaymentFromClose
// .static.test.js. Real-Postgres behavioral validation (rollback-safe DB
// probe: unsettled table still refused with force, settled+kitchen-active
// table still refused without force, forced close succeeds with the order's
// estado provably unchanged and the audit row correct) is documented in this
// slice's own report, not here -- this file only proves the SQL TEXT has the
// properties it claims.
//
// SCOPE NOTE (per this slice's own FASE 4 instruction): this file
// deliberately does NOT grep every historical migration for the legacy
// literal -- old migrations legitimately contain it (that's what "legacy
// terminal literal" means) and a blanket grep would be a false-positive
// generator, not a guard. What IS checked, and is the actual guard against
// reintroduction: (1) the live-body predecessor/post-condition DO blocks
// inside the migration itself, which run against the ACTUAL deployed
// function at apply time -- covered by the assertions below reading this
// migration's own text; (2) this file's own assertion that the function
// body this migration installs never assigns the legacy literal; (3) active
// application code (src/**/*.js) never writes ordenes.estado to this value
// anywhere -- checked directly below, not via a migrations/ grep.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const ROOT = path.join(__dirname, '..');
const MIGRATION_PATH = path.join(ROOT, 'migrations', '2026-08-23_n1_mesa_force_close_estado_write_removal.sql');
const ROLLBACK_PATH = path.join(ROOT, 'migrations', '2026-08-23_n1_mesa_force_close_estado_write_removal.ROLLBACK.sql');
const PREDECESSOR_PATH = path.join(ROOT, 'migrations', '2026-08-10_mesa_decouple_payment_from_close.sql');

function extractFn(src, name) {
  const markers = [`CREATE OR REPLACE FUNCTION public.${name}(`, `CREATE FUNCTION public.${name}(`];
  let i = -1;
  for (const m of markers) { i = src.indexOf(m); if (i !== -1) break; }
  if (i === -1) return null;
  // Dollar-quote tag varies by migration author ($function$ in this one,
  // $fn$ in the 2026-08-10 predecessor) -- detect it from the body's own
  // "AS $tag$" rather than hardcoding one.
  const asMatch = /AS (\$[A-Za-z_]*\$)/.exec(src.slice(i));
  if (!asMatch) return null;
  const tag = asMatch[1];
  const bodyStart = i + asMatch.index + asMatch[0].length;
  const closeIdx = src.indexOf(tag, bodyStart);
  const j = src.indexOf(';', closeIdx);
  return src.slice(i, j + 1);
}

(async () => {
  console.log('\n== N-1 mesa_force_close_estado_write_removal — static migration checks ==\n');

  assert('0a: migration file exists', fs.existsSync(MIGRATION_PATH));
  assert('0b: rollback file exists', fs.existsSync(ROLLBACK_PATH));
  assert('0c: predecessor (P0-B.1, the pre-N-1 mesa_close_session_v1 body) file exists', fs.existsSync(PREDECESSOR_PATH));
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const rollback = fs.readFileSync(ROLLBACK_PATH, 'utf8');
  const predecessorSql = fs.readFileSync(PREDECESSOR_PATH, 'utf8');
  const sqlWithoutComments = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const fn = extractFn(sql, 'mesa_close_session_v1');
  const predecessorFn = extractFn(predecessorSql, 'mesa_close_session_v1');
  // The migration's own TOP-LEVEL statements (predecessor guard, CREATE OR
  // REPLACE, REVOKE/GRANT, post-conditions) never mutate a business table --
  // but the function BODY it installs legitimately contains INSERT/UPDATE
  // (that is what the RPC does when CALLED later; the migration applying it
  // does not itself execute those writes), and the post-condition DO blocks
  // legitimately MENTION 'INSERT INTO public.orden_estado_logs' etc as LIKE-
  // pattern string literals (checking the live function's text, not
  // executing DML themselves). Strip both the installed function body and
  // every DO $$ ... END $$; block before scanning for real business DML.
  let sqlOutsideFn = fn ? sqlWithoutComments.split(fn.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')).join('') : sqlWithoutComments;
  sqlOutsideFn = sqlOutsideFn.replace(/DO \$\$[\s\S]*?END \$\$;/g, '');

  console.log('\n── staging safety ──');
  assert('1a: has a predecessor guard before the transaction', sql.indexOf("RAISE EXCEPTION 'N-1 refused:") !== -1 && sql.indexOf("RAISE EXCEPTION 'N-1 refused:") < sql.indexOf('BEGIN;'));
  assert('1b: wrapped in BEGIN/COMMIT', /BEGIN;/.test(sql) && /COMMIT;\s*$/.test(sql.trim()));
  assert('1c: predecessor-body guard: refuses unless the live function still writes the legacy literal', sql.includes("NOT LIKE '%estado = ''CHIUSO_FORZATO''%'")); // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this migration's own predecessor guard checks for, not new vocabulary
  const destructivePatterns = [/DROP\s+TABLE/i, /RENAME\s+TO/i, /TRUNCATE/i, /DELETE\s+FROM/i, /CREATE\s+TABLE/i, /ALTER\s+TABLE/i, /DROP\s+FUNCTION/i];
  for (const re of destructivePatterns) {
    assert('1d: forward migration contains no ' + re, !re.test(sqlWithoutComments), sqlWithoutComments.match(re) && sqlWithoutComments.match(re)[0]);
  }
  assert('1e: no business DML OUTSIDE the installed function body (the body itself legitimately contains the INSERT/UPDATE it performs when CALLED later)',
    !!fn &&
    !/\bINSERT INTO public\.(ordenes|table_sessions|orden_estado_logs|table_order_lines|payment_allocations|payment_transactions)\b/.test(sqlOutsideFn) &&
    !/\bUPDATE public\.(ordenes|table_sessions|orden_estado_logs|table_order_lines|payment_allocations|payment_transactions)\b/.test(sqlOutsideFn) &&
    !/\bDELETE FROM public\.(ordenes|table_sessions|orden_estado_logs|table_order_lines|payment_allocations|payment_transactions)\b/.test(sqlOutsideFn));
  assert('1f: no ledger INSERT embedded in the file (checksum self-reference avoided)', !/INSERT INTO public\.ladieci_schema_migrations/.test(sql));

  console.log('\n── grants: mesa_close_session_v1 stays service_role-only ──');
  assert('2a: REVOKE ALL from PUBLIC, anon, authenticated', /REVOKE ALL ON FUNCTION public\.mesa_close_session_v1[\s\S]*FROM PUBLIC,\s*anon,\s*authenticated/.test(sql));
  assert('2b: GRANT EXECUTE to service_role only', /GRANT EXECUTE ON FUNCTION public\.mesa_close_session_v1[\s\S]*TO service_role/.test(sql));

  console.log('\n── THE REMOVAL, proven against this migration\'s own installed body ──');
  assert('3a: mesa_close_session_v1 present in forward migration', !!fn);
  assert('3b: mesa_close_session_v1 present in predecessor', !!predecessorFn);
  // Paren-balanced extraction of just the parameter list, whitespace-
  // normalized -- robust to the predecessor's multi-line param layout vs
  // this migration's single-line one (cosmetic only, not a real diff).
  const sigOf = (f) => {
    if (!f) return null;
    const start = f.indexOf('(');
    let depth = 0, i = start;
    for (; i < f.length; i++) {
      if (f[i] === '(') depth++;
      else if (f[i] === ')') { depth--; if (depth === 0) break; }
    }
    return f.slice(start, i + 1).replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
  };
  assert('3c: parameter list identical to predecessor, whitespace aside (no new/removed/reordered param, p_force still last with DEFAULT false)', sigOf(fn) === sigOf(predecessorFn), sigOf(fn) + ' !== ' + sigOf(predecessorFn));
  assert('3d: the force branch no longer assigns the legacy literal to ordenes.estado', !/ordenes\s+o\s+SET\s+estado\s*=\s*'CHIUSO_FORZATO'/i.test(fn)); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here for the ABSENCE of an assignment, not new vocabulary
  assert('3e: no UPDATE public.ordenes at all anywhere in this function', !/UPDATE\s+public\.ordenes/i.test(fn));
  // Three READ-only occurrences, all pre-existing exclusion-filter IN-lists:
  // the financial gate, the kitchen-completeness EXISTS check, and the
  // orphaned CTE's own WHERE clause (mirrors the EXISTS check to select the
  // same rows) -- reading the literal is not writing it.
  assert('3f: the legacy literal appears only in the three pre-existing exclusion-filter IN-lists, never as an assignment', (fn.match(/'CHIUSO_FORZATO'/g) || []).length === 3); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, counted here to prove it is read-only, not new vocabulary

  console.log('\n── everything FASE 1 says must NOT be removed is still present ──');
  assert('4a: financial-settlement gate present, unconditional', fn.includes('MESA_TABLE_NOT_SETTLED') && fn.includes('v_outstanding_cents > 0'));
  assert('4b: financial gate strictly precedes the force branch (never overridden by p_force)', fn.indexOf('MESA_TABLE_NOT_SETTLED') < fn.indexOf('IF NOT p_force THEN'));
  assert('4c: kitchen-completeness gate present, the only thing p_force overrides', fn.includes('MESA_TABLE_HAS_ACTIVE_ORDERS') && fn.includes('IF NOT p_force THEN'));
  assert('4d: table_sessions close still present and still unconditional (runs whether or not the force branch fired)', /UPDATE public\.table_sessions SET\s*\n\s*status = 'closed'/.test(fn));
  assert('4e: table only closes after both gates (financial, then kitchen)', fn.indexOf("status = 'closed'") > fn.indexOf('KITCHEN/ORDER COMPLETENESS'));
  assert('4f: audit trail (orden_estado_logs INSERT) still present', fn.includes('INSERT INTO public.orden_estado_logs'));
  assert('4g: audit event_type unchanged (table_closed_forced)', fn.includes("'table_closed_forced'"));
  assert('4h: audit actor attribution unchanged (operator, p_by_actor, mesa_close_session_force)', fn.includes("'operator', p_by_actor, 'mesa_close_session_force'"));
  assert('4i: audit metadata (table_session_id, reason) unchanged', fn.includes("'table_session_id', v_session.id") && fn.includes("'reason', 'operator_forced_close_with_pending_kitchen_work'"));
  assert('4j: forced/forcedOrderCount still surfaced honestly in the response', fn.includes("'forced', v_forced_count > 0") && fn.includes("'forcedOrderCount', v_forced_count"));
  assert('4k: candidate orders still locked FOR UPDATE before the audit write (no lost-update race)', fn.includes('FOR UPDATE OF o'));
  assert('4l: eligible roles unchanged', fn.includes("'admin','operator','owner','cashier','waiter','legacy_operator'"));
  assert('4m: idempotent-safe guard unchanged (MESA_SESSION_NOT_OPEN before any gate)', fn.indexOf('MESA_SESSION_NOT_OPEN') < fn.indexOf('MESA_TABLE_NOT_SETTLED'));

  console.log('\n── the new estado_from/estado_to shape ──');
  assert('5a: estado_from/estado_to are both derived from the order\'s OWN current estado, not a literal', /t\.current_estado,\s*COALESCE\(t\.current_estado, 'EN_COCINA'\)/.test(fn));
  assert('5b: estado_to has a NOT-NULL-safe fallback (schema requires estado_to NOT NULL)', fn.includes("COALESCE(t.current_estado, 'EN_COCINA')"));

  console.log('\n── every guard/exception path is preserved, none added or silently dropped ──');
  // Formatting-independent: extract every RAISE EXCEPTION '<CODE>' message
  // from both bodies and compare the sets directly, rather than diffing raw
  // text (which is sensitive to the predecessor's multi-line param layout
  // and older `SET search_path = ...` vs this file's `SET search_path TO
  // '...'` -- both valid, semantically identical Postgres syntax, cosmetic
  // only). An identical code set proves no guard was added or removed.
  const exceptionCodesOf = (f) => {
    const re = /RAISE EXCEPTION '([A-Z_]+)'/g;
    const codes = [];
    let m;
    while ((m = re.exec(f))) codes.push(m[1]);
    return codes.sort();
  };
  assert('6a: identical set of RAISE EXCEPTION codes vs predecessor (no guard added or removed)',
    JSON.stringify(exceptionCodesOf(fn)) === JSON.stringify(exceptionCodesOf(predecessorFn)),
    JSON.stringify(exceptionCodesOf(fn)) + ' !== ' + JSON.stringify(exceptionCodesOf(predecessorFn)));
  assert('6b: predecessor genuinely contains the old force-close write (sanity check on the diff reference itself)', /UPDATE public\.ordenes o SET estado = 'CHIUSO_FORZATO'/.test(predecessorFn)); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here in the historical predecessor as a sanity check, not new vocabulary
  assert('6c: predecessor\'s removed CTE layer (closed_orphans) is absent from the new body', !fn.includes('closed_orphans'));
  assert('6d: the orphaned/logged CTE names are preserved (only closed_orphans and its UPDATE were excised)', fn.includes('WITH orphaned AS (') && fn.includes('logged AS ('));

  console.log('\n── post-conditions present in the migration itself ──');
  assert('7a: post-condition asserts the legacy literal is no longer assigned', /LIKE '%estado = ''CHIUSO_FORZATO''%' THEN/.test(sql) && sql.includes('the live function still assigns the force-close estado literal')); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here in the migration's own post-condition, not new vocabulary
  assert('7b: post-condition asserts the financial gate survived', sql.includes('the financial-settlement gate did not survive'));
  assert('7c: post-condition asserts the kitchen gate survived', sql.includes('the kitchen-completeness gate did not survive'));
  assert('7d: post-condition asserts the table-close write survived', sql.includes('the table-close write did not survive'));
  assert('7e: post-condition asserts the audit-log write survived', sql.includes('the audit-log write did not survive'));
  assert('7f: post-condition asserts actor attribution survived', sql.includes('actor attribution on the audit row did not survive'));
  assert('7g: post-condition asserts guard ordering unchanged', sql.includes('guard ordering changed'));
  assert('7h: post-condition asserts grants (service_role EXECUTE, anon/authenticated denied)',
    /has_function_privilege\('service_role', 'public\.mesa_close_session_v1\(uuid, text, uuid, boolean\)', 'EXECUTE'\)/.test(sql) &&
    /has_function_privilege\('anon', 'public\.mesa_close_session_v1\(uuid, text, uuid, boolean\)', 'EXECUTE'\)/.test(sql));

  console.log('\n── rollback restores the pre-N-1 write capability, verified by property (not fragile text-equality) ──');
  const rollbackFn = extractFn(rollback, 'mesa_close_session_v1');
  assert('8a: rollback redefines mesa_close_session_v1', !!rollbackFn);
  assert('8b: rollback wrapped in BEGIN/COMMIT', /BEGIN;/.test(rollback) && /COMMIT;\s*$/.test(rollback.trim()));
  assert('8c: rollback signature identical to predecessor, whitespace aside', sigOf(rollbackFn) === sigOf(predecessorFn), sigOf(rollbackFn) + ' !== ' + sigOf(predecessorFn));
  assert('8d: rollback genuinely restores the force-close write to ordenes.estado', /UPDATE public\.ordenes o SET estado = 'CHIUSO_FORZATO'/.test(rollbackFn)); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here in the rollback file, not new vocabulary
  assert('8e: rollback restores the closed_orphans CTE layer this migration removed', rollbackFn.includes('closed_orphans'));
  assert('8f: rollback has the identical set of RAISE EXCEPTION codes as the predecessor (nothing else regressed)',
    JSON.stringify(exceptionCodesOf(rollbackFn)) === JSON.stringify(exceptionCodesOf(predecessorFn)),
    JSON.stringify(exceptionCodesOf(rollbackFn)) + ' !== ' + JSON.stringify(exceptionCodesOf(predecessorFn)));
  assert('8g: rollback restates the same grants', /REVOKE ALL ON FUNCTION public\.mesa_close_session_v1[\s\S]*FROM PUBLIC,\s*anon,\s*authenticated/.test(rollback) && /GRANT EXECUTE ON FUNCTION public\.mesa_close_session_v1[\s\S]*TO service_role/.test(rollback));
  assert('8h: rollback has its own post-condition proving the legacy write was restored', /position\('estado = ''CHIUSO_FORZATO''' in v_src\) = 0/.test(rollback)); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here in the rollback's own post-condition, not new vocabulary
  assert('8i: rollback contains no DROP FUNCTION (both parts are CREATE OR REPLACE, never a drop)', !/DROP\s+FUNCTION/i.test(rollback));

  console.log('\n── FASE 4 / prevention of reintroduction: active application code ──');
  // Not a migrations/ grep (old migrations legitimately carry the legacy
  // literal). This walks src/ + index.js only -- the live, reachable
  // application code -- and proves no JS anywhere attempts to write
  // ordenes.estado to the legacy literal, directly or via a template string.
  function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  }
  const appFiles = [];
  walk(path.join(ROOT, 'src'), appFiles);
  appFiles.push(path.join(ROOT, 'index.js'));
  // Every real write this codebase ever makes to a table goes through either
  // a named RPC (sbRpc -- covered by the DB-level guard above, since the RPC
  // body itself is what's being checked) or the hardened sbUpdate/sbUpsert
  // helpers (src/utils/supabase.js) -- raw UPDATE SQL is never issued from
  // JS. So the precise, meaningful check is: no sbUpdate/sbUpsert call
  // targeting 'ordenes' carries the legacy literal anywhere in its payload.
  // KNOWN, ALREADY-AUDITED EXCLUSION: src/utils/servizio.js's chiudiServizio -- language-guard: allow-legacy servizio.js/chiudiServizio are the existing legacy filename/function this exclusion documents, not new vocabulary
  // builds `{ ...o, estado: "CHIUSO_FORZATO" }` as a plain in-memory object -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, cited to explain what this exclusion covers, not new vocabulary
  // (this session's own audit traced it end-to-end) -- it is used only to
  // compute the archived storico row's/summary's classification, is NEVER -- language-guard: allow-legacy storico is the existing archive table name this exclusion's rationale cites, not new vocabulary
  // passed to sbUpdate/sbUpsert against `ordenes`, and the whole call path
  // is unreachable today (LEGACY_AUTOMATIC_LIFECYCLE_ENABLED=false live;
  // zero economic_period_v1 sessions open, none can be newly opened). It
  // predates this migration, is not a `ordenes.estado` writer by the
  // definition FASE 1 cares about, and is explicitly out of this slice's
  // scope to touch -- excluding it here is a documented, narrow exception,
  // not a blanket loophole (any OTHER file matching the write-shaped
  // pattern below still fails this test).
  const KNOWN_NON_WRITER_EXCLUSIONS = new Set(['src/utils/servizio.js']); // language-guard: allow-legacy servizio.js is the same existing legacy filename this exclusion set names, not new vocabulary
  const writeAttempts = [];
  for (const f of appFiles) {
    const rel = path.relative(ROOT, f);
    if (KNOWN_NON_WRITER_EXCLUSIONS.has(rel)) continue;
    const text = fs.readFileSync(f, 'utf8');
    // sbUpdate('ordenes', ...) / sbUpsert('ordenes', ...) with the legacy
    // literal appearing within the same call (a generous 400-char window
    // covers any real payload shape without matching unrelated code far away
    // in the same file).
    const callRe = /sb(?:Update|Upsert)\(\s*['"]ordenes['"][\s\S]{0,400}?\)/g;
    let m;
    while ((m = callRe.exec(text))) {
      if (m[0].includes('CHIUSO_FORZATO')) { writeAttempts.push(rel); break; } // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here inside a real write-call, not new vocabulary
    }
  }
  assert('9a: no active application write call (sbUpdate/sbUpsert against ordenes) assigns the legacy literal', writeAttempts.length === 0, JSON.stringify(writeAttempts));

  console.log('\n── FASE 3 / legacy-read compatibility left untouched (spot check, not a redesign) ──');
  const readerFiles = [
    'src/closeout/currentServiceCloseout.js',
    'src/tables/mesaService.js',
    'src/serviceSessions/serviceLifecycleEngine.js',
    'src/serviceSessions/v3IncidentPolicy.js',
    'src/serviceSessions/rolloverClassifier.js',
    'src/serviceSessions/economicBoundaryEngine.js',
  ];
  for (const rel of readerFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert(`10: ${rel} still recognizes the legacy literal (legacy-read preserved)`, text.includes('CHIUSO_FORZATO')); // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, checked here for legacy-read preservation, not new vocabulary
  }
  const closeoutSrc = fs.readFileSync(path.join(ROOT, 'src/closeout/currentServiceCloseout.js'), 'utf8');
  assert('11: currentServiceCloseout.js\'s CANCELLED set still does NOT treat it as economic void (prior slice\'s fix untouched)', /CANCELLED = new Set\(\["CANCELADO", "CANCELLED", "ANULADO"\]\)/.test(closeoutSrc));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
})();
