'use strict';
// FINDING A (migration 145) MUTATION CHECK. Ephemeral PostgreSQL only; never staging, never production.
//
//   W3_PG_NODE_MODULES=<dir> [W3_PG_DATA_ROOT=<tmp>] [PCF_MUT_DIR=<dir>] [PCF_MUT_ONLY=name,name] node ci/giro-authority-certification/harness/pcfMutationCheck.js
//
// Each mutant is a copy of the forward (and, when a body pin changes, the rollback) migration with ONE deliberate defect: the lock removed, weakened (FOR KEY SHARE), strengthened
// (FOR UPDATE), moved after the receipt SELECT, present in only one writer, taken on the wrong object; the 143 prerequisite guard removed; the md5 drift guard removed; the
// rollback md5 guard removed. The migration's OWN body pins are recomputed and the OWN post-condition regexes that would refuse the mutated shape are neutralised, so that the
// mutant APPLIES (otherwise its own guards would refuse it and the test would prove nothing about the scenarios). Two independent nets are then run against it:
//   STATIC   tests/paymentCloseReceiptLockMigration.test.js via PCF_TEST_FWD / PCF_TEST_RBK        (a failing assertion or a non-zero exit kills it)
//   DYNAMIC  runPaymentCloseFix.js (PCF_QUICK=1: provenance apply drift rollback serialize scenarios) via PCF_FWD145 / PCF_RBK145
// A mutant must be killed by the DYNAMIC net (the behavioural certification); the static net is reported next to it. A mutant that survives the dynamic net fails the run.
// Every spawned process has a hard timeout (spawnSync kills it); nothing is left running.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = 'migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql';
const R = 'migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql';
const ORD_HEAD = 'CREATE OR REPLACE FUNCTION public.order_post_payment_v1(';
const MES_HEAD = 'CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(';
const NEW = { order: '799f8093328b4ac81e1ad5a3d37e1bb6', mesa: '94867e165d0732f36ae4692fc6998c58' };   // the 145 body pins (forward post-conditions + rollback guard)
const LOCK = 'PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;';
const OUT = process.env.PCF_MUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-mut-'));
fs.mkdirSync(OUT, { recursive: true });

function must(text, from, to, label) {           // an exact, single, checked replacement: a mutant that silently did not mutate would be a false "survivor"
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`mutation ${label}: pattern not found: ${from.slice(0, 70)}`);
  if (text.indexOf(from, first + 1) >= 0) throw new Error(`mutation ${label}: pattern not unique: ${from.slice(0, 70)}`);
  return text.replace(from, () => to);
}
const bodyOf = (sql, head) => { const i = sql.indexOf(head); const o = /AS\s+\$function\$/.exec(sql.slice(i)); const s = i + o.index + o[0].length; return { s, e: sql.indexOf('$function$', s) }; };
const BLOCK = /^  -- 145:BEGIN receipt_service_pointer_lock\n[\s\S]*?^  -- 145:END receipt_service_pointer_lock\n/m;
const RECEIPT_SELECT = "  SELECT ss.id INTO v_receipt_service_id\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";
// the migration's own post-conditions that would refuse a mutated block (neutralised in every body mutant; the pins / marker / predecessor-equality checks stay live)
const neutral = (f) => {
  let x = must(f, 'IF v_blk IS NULL OR v_blk !~ ', 'IF false AND v_blk !~ ', 'nblk');
  x = must(x, '    IF v_src !~ $re$-- 145:END receipt_service_pointer_lock', '    IF false AND v_src !~ $re$-- 145:END receipt_service_pointer_lock', 'nimm');
  return x;
};
// mutate the bodies selected in `fns` ({order?: fn, mesa?: fn}); recompute the 145 pins in the forward post-conditions and in the rollback guard
function mutateBodies(fns) {
  let f = read(F), r = read(R);
  for (const [k, head] of [['order', ORD_HEAD], ['mesa', MES_HEAD]]) {
    if (!fns[k]) continue;
    const { s, e } = bodyOf(f, head); const nb = fns[k](f.slice(s, e));
    if (nb === f.slice(s, e)) throw new Error('mutation changed nothing (' + k + ')');
    f = f.slice(0, s) + nb + f.slice(e);
    const nm = md5(nb);
    for (const t of ['f', 'r']) { const txt = t === 'f' ? f : r; if (!txt.includes(NEW[k])) throw new Error('pin not found ' + k); const y = txt.split(NEW[k]).join(nm); if (t === 'f') f = y; else r = y; }
  }
  return { f: neutral(f), r };
}
const lockToNull = (b) => must(b, '  ' + LOCK + '\n', '  NULL;\n', 'nolock');
const both = (fn) => mutateBodies({ order: fn, mesa: fn });

const MUTANTS = [
  { name: 'm145_lock_removed', desc: 'the lock statement is removed from both writers (the marker stays)', build: () => both(lockToNull) },
  { name: 'm145_for_key_share', desc: 'FOR KEY SHARE instead of FOR SHARE (does not conflict with the close: the FK-style non-lock)', build: () => both((b) => must(b, LOCK, LOCK.replace('FOR SHARE', 'FOR KEY SHARE'), 'fks')) },
  { name: 'm145_for_update', desc: 'FOR UPDATE instead of FOR SHARE (payments would serialize among themselves and against the pointer writers)', build: () => both((b) => must(b, LOCK, LOCK.replace('FOR SHARE', 'FOR UPDATE'), 'fu')) },
  { name: 'm145_lock_after_select', desc: 'the lock is taken AFTER the receipt-service SELECT (the decision is already stale)', build: () => both((b) => { const blk = BLOCK.exec(b)[0]; return must(b.replace(blk, ''), RECEIPT_SELECT, RECEIPT_SELECT + blk, 'after'); }) },
  { name: 'm145_lock_only_in_order', desc: 'Mesa keeps no lock (only order_post_payment_v1 is locked)', build: () => mutateBodies({ mesa: lockToNull }) },
  { name: 'm145_lock_only_in_mesa', desc: 'Cash V1 keeps no lock (only mesa_post_payment_v1 is locked)', build: () => mutateBodies({ order: lockToNull }) },
  { name: 'm145_service_row_lock', desc: 'the lock is taken on the OPEN SERVICE ROW instead of the lifecycle pointer (the rejected "weaker" alternative)', build: () => both((b) => must(b, LOCK, "PERFORM 1 FROM public.service_sessions WHERE status = 'open' FOR SHARE;", 'svc')) },
  { name: 'm145_prerequisite_removed', desc: 'the 143 prerequisite guard is removed (145 would apply without the prelude: deadlocks with the old intake order)', build() {
    const f = read(F); const a = f.indexOf('  -- 0.a prerequisite'), b = f.indexOf('  -- 0.b the two writers'); if (a < 0 || b < a) throw new Error('prereq block not found');
    return { f: f.slice(0, a) + f.slice(b), r: read(R) }; } },
  { name: 'm145_md5_guard_removed', desc: 'the predecessor md5 drift pin is not enforced (a divergent body would be overwritten)', build: () => ({ f: must(read(F), '    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN', '    IF false THEN', 'dg145'), r: read(R) }) },
  { name: 'm145_rollback_guard_removed', desc: 'the rollback does not verify that the bodies are the 145 bodies (a divergent body would be overwritten)', build() {
    const r = read(R); const m = /IF md5\(v_src\) IS DISTINCT FROM v_pin\.want THEN/.exec(r); if (!m) throw new Error('rollback guard not found'); return { f: read(F), r: r.replace(m[0], 'IF false THEN') }; } },
  { name: 'm145_already_applied_guard_removed', desc: 'the already-applied guard is removed (a second apply would be accepted)', build: () => ({ f: must(read(F), "    IF position('-- 145:BEGIN receipt_service_pointer_lock' IN v_src) > 0 THEN", '    IF false THEN', 'aa'), r: read(R) }) },
];

const only = (process.env.PCF_MUT_ONLY || '').split(',').filter(Boolean);
const results = [];
for (const mu of MUTANTS.filter((m) => !only.length || only.includes(m.name))) {
  const dir = path.join(OUT, mu.name); fs.mkdirSync(dir, { recursive: true });
  let built;
  try { built = mu.build(); } catch (e) { results.push({ name: mu.name, desc: mu.desc, status: 'BUILD_ERROR', detail: e.message }); console.log(`  ${mu.name}: BUILD_ERROR ${e.message}`); continue; }
  const ff = path.join(dir, 'fwd.sql'), rr = path.join(dir, 'rbk.sql'); fs.writeFileSync(ff, built.f); fs.writeFileSync(rr, built.r);
  // static net
  const t0 = Date.now();
  const st = cp.spawnSync(process.execPath, [path.join(ROOT, 'tests', 'paymentCloseReceiptLockMigration.test.js')],
    { env: { ...process.env, PCF_TEST_FWD: path.relative(ROOT, ff), PCF_TEST_RBK: path.relative(ROOT, rr) }, cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  const stOut = (st.stdout || '') + (st.stderr || ''); fs.writeFileSync(path.join(dir, 'static.log'), stOut);
  const stFails = stOut.split('\n').filter((l) => /^\s*(FAIL|✗|not ok)/.test(l)).map((l) => l.trim().slice(0, 200));
  const staticKilled = st.status !== 0;
  // dynamic net
  const env = { ...process.env, PCF_QUICK: '1', PCF_FWD145: ff, PCF_RBK145: rr, PCF_SCRATCH: OUT };
  const t1 = Date.now();
  const run = cp.spawnSync(process.execPath, [path.join(__dirname, 'runPaymentCloseFix.js'), 'provenance', 'apply', 'drift', 'rollback', 'serialize', 'scenarios'],
    { env, cwd: ROOT, encoding: 'utf8', timeout: 1500000, maxBuffer: 64 * 1024 * 1024 });
  const out = (run.stdout || '') + (run.stderr || ''); fs.writeFileSync(path.join(dir, 'run.log'), out);
  const fails = out.split('\n').filter((l) => /^\s+FAIL\s/.test(l)).map((l) => l.trim().slice(0, 240));
  const crashed = out.split('\n').filter((l) => /crashed/.test(l)).length;
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  const dynKilled = !timedOut && (fails.length > 0 || run.status !== 0);
  const status = timedOut ? 'TIMEOUT' : (dynKilled ? 'KILLED' : 'SURVIVED');
  results.push({ name: mu.name, desc: mu.desc, status, dynamic_failing_assertions: fails.length, crashed_phases: crashed, dynamic_seconds: Math.round((Date.now() - t1) / 1000),
    static_killed: staticKilled, static_failing_assertions: stFails.length, static_seconds: Math.round((t1 - t0) / 1000), first_dynamic_failures: fails.slice(0, 4), first_static_failures: stFails.slice(0, 3) });
  console.log(`  ${mu.name}: ${status} -- dynamic ${fails.length} failing assertion(s), ${crashed} crashed phase(s), ${Math.round((Date.now() - t1) / 1000)}s | static ${staticKilled ? 'KILLED' : 'SURVIVED'} (${stFails.length} failing)`);
  for (const f of fails.slice(0, 3)) console.log('      ' + f);
}
const surv = results.filter((r) => r.status !== 'KILLED');
fs.writeFileSync(path.join(OUT, 'mutation_results.json'), JSON.stringify(results, null, 1));
const sSurv = results.filter((r) => !r.static_killed);
console.log(`\n═══ MUTATION CHECK (dynamic): ${results.length - surv.length}/${results.length} mutants killed; survivors / errors: ${surv.map((s) => s.name + ':' + s.status).join(', ') || 'none'} ═══`);
console.log(`═══ MUTATION CHECK (static): ${results.length - sSurv.length}/${results.length} mutants killed by the static test; static survivors: ${sSurv.map((s) => s.name).join(', ') || 'none'} ═══  (${OUT})`);
process.exit(surv.length ? 1 : 0);
