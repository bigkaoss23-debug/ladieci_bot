'use strict';
// FINDING B (migration 146) MUTATION CHECK. Ephemeral PostgreSQL only; never staging, never production.
//
//   W3_PG_NODE_MODULES=<dir> [W3_PG_DATA_ROOT=<tmp>] [FB_MUT_DIR=<dir>] [FB_MUT_ONLY=name,name] node ci/giro-authority-certification/harness/fbMutationCheck.js
//
// Each mutant is a copy of the forward (and, when a body pin changes, the rollback) migration with ONE deliberate defect. For a BODY mutant the migration's own body pins
// are recomputed and its own shape post-conditions are neutralised (RAISE EXCEPTION -> RAISE NOTICE), so that the mutant APPLIES and the behaviour is what gets tested;
// the whole-catalog post-conditions (exactly two functions changed, 145 bodies unchanged, catalog fingerprint) stay live. Two independent nets are run against it:
//   DYNAMIC  runFindingBRefundFix.js via FB_FWD146 / FB_RBK146 -- body mutants: the deterministic scenarios (R1-R12 / M1-M12 with lock probes, pg_locks, pg_blocking_pids);
//            guard mutants: apply / drift / rollback (the violated precondition must be REFUSED, typed, leaving nothing behind)
//   STATIC   tests/refundCloseReceiptLockMigration.test.js via FB_TEST_FWD / FB_TEST_RBK
// A mutant must be killed by the DYNAMIC net with at least one BEHAVIOURAL assertion (a scenario outcome, a probe, a wait relation, a refusal on a real catalogue) -- never
// only by a checksum / manifest assertion. The static net is reported next to it. Every spawned process has a hard timeout; nothing is left running.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = 'migrations/2026-09-25_refund_close_receipt_lock_v1_migration_146.sql';
const R = 'migrations/2026-09-25_refund_close_receipt_lock_v1_migration_146.ROLLBACK.sql';
const HEAD = { order: 'CREATE OR REPLACE FUNCTION public.order_post_refund_v1(', mesa: 'CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(' };
const RECEIPT_SELECT = "  SELECT ss.id INTO v_receipt_service_id\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";
const LOCK_BLOCK = "  -- 146:BEGIN refund_receipt_pointer_lock\n  PERFORM 1\n  FROM public.service_session_state\n  WHERE singleton = true\n  FOR SHARE;\n  -- 146:END refund_receipt_pointer_lock\n";
const LOCK_STMT = "  PERFORM 1\n  FROM public.service_session_state\n  WHERE singleton = true\n  FOR SHARE;\n";
const REJECT_BLOCK = "  -- 146:BEGIN order_refund_requires_open_service\n  IF v_receipt_service_id IS NULL THEN\n    RAISE EXCEPTION 'ORDER_REFUND_NO_OPEN_SERVICE'\n      USING ERRCODE = '55000';\n  END IF;\n  -- 146:END order_refund_requires_open_service\n";
const OUT = process.env.FB_MUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'fb-mut-'));
fs.mkdirSync(OUT, { recursive: true });

function must(text, from, to, label) {           // an exact, single, checked replacement: a mutant that silently did not mutate would be a false "survivor"
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`mutation ${label}: pattern not found: ${from.slice(0, 70)}`);
  if (text.indexOf(from, first + 1) >= 0) throw new Error(`mutation ${label}: pattern not unique: ${from.slice(0, 70)}`);
  return text.replace(from, () => to);
}
const bodyOf = (sql, head) => { const i = sql.indexOf(head); const o = /AS\s+\$function\$/.exec(sql.slice(i)); const s = i + o.index + o[0].length; return { s, e: sql.indexOf('$function$', s) }; };
// the forward's own SHAPE post-conditions become notices (the catalog-wide ones stay live: exactly two functions, 145 bodies, fingerprint, posture)
const KEEP_LIVE = /differ from the before-state|disappeared|a target function was not changed|a 145 payment writer changed|catalog fingerprint|owner \/ SECURITY|EXECUTE of %|is not the expected 146 body|failed: % is missing'/;
const neutral = (f) => f.split('\n').map((l) => (/RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: /.test(l) && !KEEP_LIVE.test(l)) ? l.replace("RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: ", "RAISE NOTICE 'neutralised post-condition: ") : l).join('\n');
function mutateBodies(fns) {
  let f = read(F), r = read(R);
  for (const k of ['order', 'mesa']) {
    if (!fns[k]) continue;
    const { s, e } = bodyOf(f, HEAD[k]); const ob = f.slice(s, e); const nb = fns[k](ob);
    if (nb === ob) throw new Error('mutation changed nothing (' + k + ')');
    f = f.slice(0, s) + nb + f.slice(e);
    const om = md5(ob), nm = md5(nb);
    for (const t of ['f', 'r']) { const txt = t === 'f' ? f : r; if (!txt.includes(om)) throw new Error('pin not found ' + k); const y = txt.split(om).join(nm); if (t === 'f') f = y; else r = y; }
  }
  return { f: neutral(f), r, kind: 'body' };
}
const lockToNull = (b) => must(b, LOCK_STMT, '  NULL;\n', 'nolock');
const both = (fn) => mutateBodies({ order: fn, mesa: fn });
const guardMut = (fn) => () => ({ ...fn(), kind: 'guard' });

const MUTANTS = [
  { name: 'm146_lock_removed', desc: 'the lock statement is removed from both writers (markers stay)', build: () => both(lockToNull) },
  { name: 'm146_for_key_share', desc: 'FOR KEY SHARE instead of FOR SHARE', build: () => both((b) => must(b, LOCK_STMT, LOCK_STMT.replace('FOR SHARE;', 'FOR KEY SHARE;'), 'fks')) },
  { name: 'm146_for_update', desc: 'FOR UPDATE instead of FOR SHARE', build: () => both((b) => must(b, LOCK_STMT, LOCK_STMT.replace('FOR SHARE;', 'FOR UPDATE;'), 'fu')) },
  { name: 'm146_lock_after_select', desc: 'the lock is taken AFTER the receipt SELECT (the decision is already stale)', build: () => both((b) => must(b, LOCK_BLOCK + RECEIPT_SELECT, RECEIPT_SELECT + LOCK_BLOCK, 'after')) },
  { name: 'm146_lock_only_order', desc: 'only order_post_refund_v1 is locked (Mesa keeps the unlocked read)', build: () => mutateBodies({ mesa: lockToNull }) },
  { name: 'm146_lock_only_mesa', desc: 'only mesa_post_refund_v1 is locked (the order writer keeps the unlocked read)', build: () => mutateBodies({ order: lockToNull }) },
  { name: 'm146_rejection_removed', desc: 'the order typed refusal is removed (lock only: the race becomes a raw 23514)', build: () => mutateBodies({ order: (b) => must(b, REJECT_BLOCK, '', 'norej') }) },
  { name: 'm146_rejection_before_lock', desc: 'the order refusal is placed BEFORE the lock and the SELECT', build: () => mutateBodies({ order: (b) => must(b, LOCK_BLOCK + RECEIPT_SELECT + REJECT_BLOCK, REJECT_BLOCK + LOCK_BLOCK + RECEIPT_SELECT, 'rejbefore') }) },
  { name: 'm146_rejection_added_to_mesa', desc: 'the refusal is (wrongly) added to the Mesa writer too', build: () => mutateBodies({ mesa: (b) => must(b, LOCK_BLOCK + RECEIPT_SELECT, LOCK_BLOCK + RECEIPT_SELECT + REJECT_BLOCK, 'rejmesa') }) },
  { name: 'm146_prerequisite_removed', desc: 'the 143 prerequisite guard is removed', build: guardMut(() => {
    const f = read(F); const a = f.indexOf('  -- 0.b prerequisite'), b = f.indexOf('  -- 0.c Economy package lineage'); if (a < 0 || b < a) throw new Error('prereq block not found'); return { f: f.slice(0, a) + f.slice(b), r: read(R) }; }) },
  { name: 'm146_lineage_guard_removed', desc: 'the 145 Economy lineage guard is removed (146 would apply on an incomplete rollout)', build: guardMut(() => {
    const f = read(F); const a = f.indexOf('  -- 0.c Economy package lineage'), b = f.indexOf('  -- 0.d the two refund writers'); if (a < 0 || b < a) throw new Error('lineage block not found'); return { f: f.slice(0, a) + f.slice(b), r: read(R) }; }) },
  { name: 'm146_md5_guard_removed', desc: 'the predecessor md5 pin is not enforced (a divergent body would be overwritten)', build: guardMut(() => ({ f: must(read(F), '    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN\n      RAISE EXCEPTION \'REFUND_CLOSE_LOCK refused: % is not the pinned live predecessor body', '    IF false THEN\n      RAISE EXCEPTION \'REFUND_CLOSE_LOCK refused: % is not the pinned live predecessor body', 'md5g'), r: read(R) })) },
  { name: 'm146_rollback_guard_removed', desc: 'the rollback does not verify that the bodies are the 146 bodies', build: guardMut(() => ({ f: read(F), r: must(read(R), '    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN\n      RAISE EXCEPTION \'REFUND_CLOSE_LOCK rollback refused: % is not the exact 146 body', '    IF false THEN\n      RAISE EXCEPTION \'REFUND_CLOSE_LOCK rollback refused: % is not the exact 146 body', 'rbg') })) },
  { name: 'm146_already_applied_guard_removed', desc: 'the already-applied guard is removed', build: guardMut(() => ({ f: must(read(F), "    IF position('-- 146:BEGIN ' IN v_src) > 0 THEN", '    IF false THEN', 'aa'), r: read(R) })) },
];
// a failing dynamic assertion is BEHAVIOURAL when it is about an observed outcome on a real database (scenario, probe, wait, refusal, catalogue after a refused apply),
// not about a checksum: provenance md5 assertions are excluded from that count
const behavioural = (line) => /\b(R\d+[a-c']*|M\d+[a-c]*|M1-M3|R7-R9|M7-M9)\b \[|is REFUSED|rollback over a TAMPERED|second apply of 146 is refused|NEGATIVE CONTROL|waits|probes/.test(line) && !/md5 pins of the file|refund writers are the 146 bodies/.test(line);

const only = (process.env.FB_MUT_ONLY || '').split(',').filter(Boolean);
const results = [];
for (const mu of MUTANTS.filter((m) => !only.length || only.includes(m.name))) {
  const dir = path.join(OUT, mu.name); fs.mkdirSync(dir, { recursive: true });
  let built;
  try { built = mu.build(); } catch (e) { results.push({ name: mu.name, desc: mu.desc, status: 'BUILD_ERROR', detail: e.message }); console.log(`  ${mu.name}: BUILD_ERROR ${e.message}`); continue; }
  const ff = path.join(dir, 'fwd.sql'), rr = path.join(dir, 'rbk.sql'); fs.writeFileSync(ff, built.f); fs.writeFileSync(rr, built.r);
  const t0 = Date.now();
  const st = cp.spawnSync(process.execPath, [path.join(ROOT, 'tests', 'refundCloseReceiptLockMigration.test.js')],
    { env: { ...process.env, FB_TEST_FWD: ff, FB_TEST_RBK: rr }, cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const stOut = (st.stdout || '') + (st.stderr || ''); fs.writeFileSync(path.join(dir, 'static.log'), stOut);
  const stFails = stOut.split('\n').filter((l) => /^\s*✗/.test(l)).map((l) => l.trim().slice(0, 200));
  const staticKilled = st.status !== 0;
  const phases = built.kind === 'body' ? ['scenarios'] : ['apply', 'drift', 'rollback'];
  const env = { ...process.env, FB_FWD146: ff, FB_RBK146: rr, FB_SCRATCH: OUT };
  const t1 = Date.now();
  const run = cp.spawnSync(process.execPath, [path.join(__dirname, 'runFindingBRefundFix.js'), ...phases], { env, cwd: ROOT, encoding: 'utf8', timeout: 1200000, maxBuffer: 64 * 1024 * 1024 });
  const out = (run.stdout || '') + (run.stderr || ''); fs.writeFileSync(path.join(dir, 'run.log'), out);
  const fails = out.split('\n').filter((l) => /^\s+FAIL\s/.test(l)).map((l) => l.trim().slice(0, 260));
  const beh = fails.filter(behavioural);
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  const status = timedOut ? 'TIMEOUT' : (beh.length > 0 ? 'KILLED' : (fails.length > 0 || run.status !== 0 ? 'KILLED_NON_BEHAVIOURAL' : 'SURVIVED'));
  results.push({ name: mu.name, desc: mu.desc, kind: built.kind, phases, status, dynamic_failing: fails.length, behavioural_failing: beh.length, dynamic_seconds: Math.round((Date.now() - t1) / 1000),
    static_killed: staticKilled, static_failing: stFails.length, first_behavioural: beh.slice(0, 4), first_static: stFails.slice(0, 3) });
  console.log(`  ${mu.name}: ${status} -- dynamic ${fails.length} failing (${beh.length} behavioural), ${Math.round((Date.now() - t1) / 1000)}s | static ${staticKilled ? 'KILLED' : 'SURVIVED'} (${stFails.length} failing)`);
  for (const x of beh.slice(0, 3)) console.log('      ' + x.slice(0, 220));
}
const surv = results.filter((r) => r.status !== 'KILLED');
fs.writeFileSync(path.join(OUT, 'mutation_results.json'), JSON.stringify(results, null, 1));
const sSurv = results.filter((r) => !r.static_killed);
console.log(`\n═══ MUTATION CHECK (dynamic, behavioural): ${results.length - surv.length}/${results.length} mutants killed; survivors / errors: ${surv.map((s) => s.name + ':' + s.status).join(', ') || 'none'} ═══`);
console.log(`═══ MUTATION CHECK (static): ${results.length - sSurv.length}/${results.length} mutants killed by the static test; static survivors: ${sSurv.map((s) => s.name).join(', ') || 'none'} ═══  (${OUT})`);
process.exit(surv.length ? 1 : 0);
