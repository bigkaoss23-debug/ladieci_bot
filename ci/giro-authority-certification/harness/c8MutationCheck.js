'use strict';
// C8 (migrations 143 + 144) MUTATION CHECK. Ephemeral PostgreSQL only; never staging, never production.
//
//   W3_PG_NODE_MODULES=<dir> [W3_PG_DATA_ROOT=<tmp>] [C8_MUT_DIR=<dir>] [C8_MUT_ONLY=name,name] node ci/giro-authority-certification/harness/c8MutationCheck.js
//
// Each mutant is a copy of the forward (and, when the pin changes, the rollback) migration with ONE deliberate defect: a lock removed or weakened, the actor hoist
// removed or reordered, a drift guard removed, the trigger moved out of the first position. The migration's OWN md5 pins / post-conditions are recomputed or
// neutralised so that the mutant APPLIES (otherwise its own guards would refuse it and the test would prove nothing about the scenarios). The same certification
// scenarios of runC8LockOrderFix.js (QUICK mode; phases provenance apply drift prefix hyp pairs numbering parity) then run against it through the C8_FWD143 / C8_RBK143 /
// C8_FWD144 / C8_RBK144 hooks. A mutant is KILLED when at least one assertion fails (or the build refuses it); a SURVIVOR is reported and fails the run.
// Every spawned run has a hard timeout (spawnSync kills it); nothing is left running.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F143 = 'migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql';
const R143 = 'migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql';
const F144 = 'migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql';
const R144 = 'migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql';
const OUT = process.env.C8_MUT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'c8-mut-'));
fs.mkdirSync(OUT, { recursive: true });

function must(text, from, to, label) {           // an exact, single, checked replacement: a mutant that silently did not mutate would be a false "survivor"
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`mutation ${label}: pattern not found: ${from.slice(0, 70)}`);
  if (text.indexOf(from, first + 1) >= 0) throw new Error(`mutation ${label}: pattern not unique: ${from.slice(0, 70)}`);
  return text.replace(from, () => to);
}
const bodyOf = (sql, fnHead) => { const i = sql.indexOf(fnHead); const o = /AS\s+\$function\$/.exec(sql.slice(i)); const s = i + o.index + o[0].length; return { s, e: sql.indexOf('$function$', s) }; };

// A mutation of the BODY of the function in `sql`; the pin `oldPin` (md5 of the original body) is replaced by the md5 of the mutated body in `sql` and every `pinned` text.
function mutateBody(sql, fnHead, oldPin, fn, pinned) {
  const { s, e } = bodyOf(sql, fnHead);
  const nb = fn(sql.slice(s, e));
  if (nb === sql.slice(s, e)) throw new Error('mutation changed nothing');
  const nm = md5(nb);
  const swap = (t) => { if (!t.includes(oldPin)) throw new Error('old pin not found'); return t.split(oldPin).join(nm); };
  return { fwd: swap(sql.slice(0, s) + nb + sql.slice(e)), pin: (t) => swap(t) };
}

const MUTANTS = [
  // ── 143: the prelude ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'm143_no_workspace_lock', desc: 'the prelude never locks W', mig: '143', build() {
    const f = read(F143), r = read(R143); const m = mutateBody(f, 'CREATE FUNCTION public.order_intake_lock_prelude_v1()', '067a9127b4ab4b5435c40ecd4c32f476',
      (b) => must(b, '  PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;\n', '', 'nowl'));
    return { f143: m.fwd, r143: m.pin(r) }; } },
  { name: 'm143_workspace_key_share', desc: 'W taken FOR KEY SHARE (the rejected S2 shape: KS -> FU upgrade later)', mig: '143', build() {
    const f = read(F143), r = read(R143); const m = mutateBody(f, 'CREATE FUNCTION public.order_intake_lock_prelude_v1()', '067a9127b4ab4b5435c40ecd4c32f476',
      (b) => must(b, 'PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;', 'PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR KEY SHARE;', 'wks'));
    return { f143: m.fwd, r143: m.pin(r) }; } },
  { name: 'm143_no_actor_hoist', desc: 'the payer actor is not hoisted', mig: '143', build() {
    const f = read(F143), r = read(R143); const m = mutateBody(f, 'CREATE FUNCTION public.order_intake_lock_prelude_v1()', '067a9127b4ab4b5435c40ecd4c32f476',
      (b) => must(b, "      PERFORM 1 FROM public.auth_actors WHERE workspace_id = v_workspace AND actor = v_actor FOR UPDATE;\n", "      NULL;\n", 'noact'));
    return { f143: m.fwd, r143: m.pin(r) }; } },
  { name: 'm143_actor_before_workspace', desc: 'ACTOR is locked BEFORE W (inverts the writers\' W -> ACTOR)', mig: '143', build() {
    const f = read(F143), r = read(R143); const m = mutateBody(f, 'CREATE FUNCTION public.order_intake_lock_prelude_v1()', '067a9127b4ab4b5435c40ecd4c32f476', (b) => {
      const wl = '  PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;\n';
      let x = must(b, wl, '', 'abw1');
      return must(x, "  IF NEW.initial_payment_intent IS NOT NULL THEN\n", "  IF NEW.initial_payment_intent IS NOT NULL THEN\n    PERFORM 1 FROM public.auth_actors WHERE workspace_id = v_workspace AND actor = btrim(COALESCE(NEW.initial_payment_intent ->> 'actor', '')) FOR UPDATE;\n" + wl, 'abw2'); });
    return { f143: m.fwd, r143: m.pin(r) }; } },
  { name: 'm143_no_lifecycle_lock', desc: 'the prelude does not take L first (W would be taken before L: inverts L -> W)', mig: '143', build() {
    const f = read(F143), r = read(R143); const m = mutateBody(f, 'CREATE FUNCTION public.order_intake_lock_prelude_v1()', '067a9127b4ab4b5435c40ecd4c32f476',
      (b) => must(b, "  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));\n", '', 'nol'));
    return { f143: m.fwd, r143: m.pin(r) }; } },
  { name: 'm143_trigger_after_mesa_prepare', desc: 'the trigger is renamed so it fires AFTER mesa_prepare_table_order_v1 (table session locked before L / W)', mig: '143', build() {
    let f = read(F143), r = read(R143);
    f = must(f, "AND t.tgname <= 'a0_order_intake_lock_prelude_v1'::name) THEN", 'AND false) THEN', 'trg1');
    f = must(f, "  IF v_first IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name THEN", '  IF false THEN', 'trg2');
    f = f.split('a0_order_intake_lock_prelude_v1').join('n0_order_intake_lock_prelude_v1');
    r = r.split('a0_order_intake_lock_prelude_v1').join('n0_order_intake_lock_prelude_v1');
    return { f143: f, r143: r }; } },
  { name: 'm143_drift_guard_removed', desc: 'the md5 drift pin of the four aligned bodies is not enforced', mig: '143', build() {
    return { f143: must(read(F143), '    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN', '    IF false THEN', 'dg143') }; } },
  // ── 144: order_cancel_v1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  { name: 'm144_no_workspace_block', desc: 'order_cancel_v1 keeps the staging body (no W lock)', mig: '144', build() {
    const f = read(F144), r = read(R144); const m = mutateBody(f, 'CREATE OR REPLACE FUNCTION public.order_cancel_v1(', '26408ba35e2a43420273a6f4c126083d',
      (b) => b.replace(/^[ \t]*-- 144:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 144:END \1\n/m, ''));
    return { f144: must(m.fwd, "IF position('-- 144:BEGIN w_first' IN (SELECT prosrc", "IF false AND position('-- 144:BEGIN w_first' IN (SELECT prosrc", 'nb'), r144: m.pin(r) }; } },
  { name: 'm144_workspace_after_actor', desc: 'W is locked AFTER the actor (the order the fix is meant to remove)', mig: '144', build() {
    const f = read(F144), r = read(R144); const m = mutateBody(f, 'CREATE OR REPLACE FUNCTION public.order_cancel_v1(', '26408ba35e2a43420273a6f4c126083d', (b) => {
      const blk = /^[ \t]*-- 144:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 144:END \1\n/m.exec(b)[0];
      const x = b.replace(blk, '');
      return must(x, "  IF v_peek.table_session_id IS NOT NULL THEN\n", blk + "  IF v_peek.table_session_id IS NOT NULL THEN\n", 'waa'); });
    return { f144: must(m.fwd, "> position('FROM public.auth_actors' IN (SELECT prosrc FROM pg_proc WHERE oid = v_oid))", '> 2147483647', 'waa2'), r144: m.pin(r) }; } },
  { name: 'm144_workspace_key_share', desc: 'order_cancel_v1 takes W FOR KEY SHARE', mig: '144', build() {
    const f = read(F144), r = read(R144); const m = mutateBody(f, 'CREATE OR REPLACE FUNCTION public.order_cancel_v1(', '26408ba35e2a43420273a6f4c126083d',
      (b) => must(b, 'PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;', 'PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR KEY SHARE;', 'w144ks'));
    return { f144: must(m.fwd, "position('FROM public.workspaces WHERE id = v_workspace FOR UPDATE' IN", "position('FROM public.workspaces WHERE id = v_workspace FOR KEY SHARE' IN", 'w144ks2'), r144: m.pin(r) }; } },
  { name: 'm144_drift_guard_removed', desc: 'the staging md5 drift pin is not enforced (a divergent body would be overwritten)', mig: '144', build() {
    return { f144: must(read(F144), "  IF md5(v_src) IS DISTINCT FROM 'd75624fd1393d7dbf94d2155e19626b7' THEN", '  IF false THEN', 'dg144') }; } },
];

const only = (process.env.C8_MUT_ONLY || '').split(',').filter(Boolean);
const results = [];
for (const mu of MUTANTS.filter((m) => !only.length || only.includes(m.name))) {
  const dir = path.join(OUT, mu.name); fs.mkdirSync(dir, { recursive: true });
  let built;
  try { built = mu.build(); } catch (e) { results.push({ name: mu.name, desc: mu.desc, status: 'BUILD_ERROR', detail: e.message }); console.log(`  ${mu.name}: BUILD_ERROR ${e.message}`); continue; }
  const env = { ...process.env, C8_QUICK: '1' };
  for (const [k, file, envk] of [['f143', 'f143.sql', 'C8_FWD143'], ['r143', 'r143.sql', 'C8_RBK143'], ['f144', 'f144.sql', 'C8_FWD144'], ['r144', 'r144.sql', 'C8_RBK144']]) {
    if (built[k]) { fs.writeFileSync(path.join(dir, file), built[k]); env[envk] = path.join(dir, file); }
  }
  const t0 = Date.now();
  const run = cp.spawnSync(process.execPath, [path.join(__dirname, 'runC8LockOrderFix.js'), 'provenance', 'apply', 'drift', 'prefix', 'hyp', 'pairs', 'numbering', 'parity'],
    { env, cwd: ROOT, encoding: 'utf8', timeout: 1200000, maxBuffer: 64 * 1024 * 1024 });
  const out = (run.stdout || '') + (run.stderr || '');
  fs.writeFileSync(path.join(dir, 'run.log'), out);
  const fails = out.split('\n').filter((l) => /^\s+FAIL\s/.test(l)).map((l) => l.trim().slice(0, 230));
  const crashed = out.split('\n').filter((l) => /crashed/.test(l)).length;
  const timedOut = run.error && run.error.code === 'ETIMEDOUT';
  const status = timedOut ? 'TIMEOUT' : (fails.length || run.status !== 0 ? 'KILLED' : 'SURVIVED');
  results.push({ name: mu.name, desc: mu.desc, status, failing_assertions: fails.length, crashed_phases: crashed, seconds: Math.round((Date.now() - t0) / 1000), first_failures: fails.slice(0, 4) });
  console.log(`  ${mu.name}: ${status} (${fails.length} failing assertion(s), ${crashed} crashed phase(s), ${Math.round((Date.now() - t0) / 1000)}s)`);
  for (const f of fails.slice(0, 3)) console.log('      ' + f);
}
const surv = results.filter((r) => r.status !== 'KILLED');
fs.writeFileSync(path.join(OUT, 'mutation_results.json'), JSON.stringify(results, null, 1));
console.log(`\n═══ MUTATION CHECK: ${results.length - surv.length}/${results.length} mutants killed; survivors / errors: ${surv.map((s) => s.name + ':' + s.status).join(', ') || 'none'} ═══  (${OUT})`);
process.exit(surv.length ? 1 : 0);
