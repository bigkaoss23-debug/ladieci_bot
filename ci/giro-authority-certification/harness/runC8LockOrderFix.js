'use strict';
// C8 LOCK-ORDER FIX (migrations 143 + 144) certification runner. Ephemeral PostgreSQL only; never staging, never production.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres and pg> [W3_PG_DATA_ROOT=<tmp>] \
//     node ci/giro-authority-certification/harness/runC8LockOrderFix.js [phase ...]
//
// Phases (default: all): provenance apply drift rollback prefix hyp pairs natural numbering parity regress serial
//   C8_QUICK=1  fewer pairs / rounds (smoke);  C8_SCALE=<n>  multiplies the natural-race rounds;
//   C8_FWD143 / C8_RBK143 / C8_FWD144 / C8_RBK144 (absolute or repo-relative paths) run the SAME scenarios against a mutated migration (mutation check).
//
// The database is the STAGING-SHAPED real-body database of c8LockOrderKit.js (real ledger through 138, real 139 + 140, the audit's real intake / Mesa / lifecycle
// bodies, the 27 staging triggers on the 14 graph tables). PRE = that database; POST = PRE + the migration FILES 143 and 144. The same deterministic scenarios run on
// both: PRE must reproduce the defect (negative control), POST must not deadlock.

const fs = require('fs');
const path = require('path');
const rt = require('./pgRuntime');
const { section, assert, state } = require('./lib');
const DED = require('./runDeliveryEconomyDecoupling');
const K = require('./c8LockOrderKit');

const F143 = process.env.C8_FWD143 || 'migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql';
const R143 = process.env.C8_RBK143 || 'migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql';
const F144 = process.env.C8_FWD144 || 'migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql';
const R144 = process.env.C8_RBK144 || 'migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql';
const readAny = (rel) => (path.isAbsolute(rel) ? fs.readFileSync(rel, 'utf8') : rt.readRepo(rel));
const QUICK = process.env.C8_QUICK === '1';
const SCALE = +(process.env.C8_SCALE || 1);
const R = (n) => Math.max(QUICK ? 3 : 4, Math.round(n * SCALE * (QUICK ? 0.25 : 1)));

const LIVE_CANCEL_MD5 = 'd75624fd1393d7dbf94d2155e19626b7';
const PRELUDE_TRG = 'a0_order_intake_lock_prelude_v1';
const CANCEL_SIG = 'public.order_cancel_v1(text,text,text,text,text,text,jsonb)';
const TABLES14 = "ARRAY['ordenes','order_entities','order_obligations','payment_transactions','payment_allocations','order_financial_events','table_sessions','table_order_lines','service_sessions','business_days','business_day_lifecycle_state','service_session_state','auth_actors','workspaces']";
const BI_ORDENES = `SELECT t.tgname FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 ORDER BY t.tgname COLLATE "C"`;
const md5Of = async (su, sig) => (await su.query('SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = to_regprocedure($1)', [sig])).rows[0]?.m || null;
const trgCount = async (su) => (await su.query(`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal AND c.relname = ANY (${TABLES14})`)).rows[0].n;
const biNames = async (su) => (await su.query(BI_ORDENES)).rows.map((r) => r.tgname);
const posture = async (su, sig) => (await su.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS cfg, p.proacl::text AS acl,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig])).rows[0];
const SVC_ONLY = '{postgres=X/postgres,service_role=X/postgres}';

let env; let dbSeq = 0;
async function cloneSu(tpl, label) {
  const db = await env.clone(tpl, label);
  const su = await rt.connect(env.cl, db, { name: `c8-${label}` });
  su.db = db;
  return su;
}
async function applyTo(su, rel) { try { await DED.applyRepoAsPostgres(su, rel); return null; } catch (e) { return e; } }
async function buildDerived(name, files) {
  const su = await cloneSu('c8_pre_tpl', name + '_b'); const db = su.db;
  for (const f of files) { const e = await applyTo(su, f); if (e) { await su.end(); throw new Error(`template ${name}: ${f} -> ${e.message}`); } }
  await su.end();
  return db;
}
const fnDrift = async (su, sig) => {          // a one-comment drift of a function body (same signature, owner, ACL)
  const cur = (await su.query('SELECT pg_get_functiondef($1::regprocedure) AS d', [sig])).rows[0].d;
  await su.query(cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER\n'));
};

// ── P0 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseProvenance() {
  section('C0 PROVENANCE -- the PRE database is the staging-shaped real-body chain (bodies = staging md5, 27 staging triggers, migration 143/144 absent)');
  const rep = await K.buildPreTemplate(env, 'c8_pre_tpl');
  assert('26 real function bodies were installed, each taken from the repo migration text whose md5(prosrc) equals the value recorded on staging (a mismatch aborts the build)', rep.bodies === 26, rep);
  assert('the giro_authority capture function exists (so ordenes_zz_giro_intent_capture_v1 is installed as on staging)', rep.giro_capture_fn === true, rep);
  const su = await cloneSu('c8_pre_tpl', 'prov');
  assert('PRE has exactly 27 triggers on the 14 graph tables (the staging baseline: includes ordenes_zz_giro_intent_capture_v1 and workspace_activation_integrity_trg)', (await trgCount(su)) === 27, await trgCount(su));
  const names = await biNames(su);
  assert('PRE BEFORE INSERT order on ordenes (= firing order, by name) is mesa_prepare_table_order_v1, ordenes_assign_service_session, ordenes_order_entity_anchor_v1, ordenes_zz_giro_intent_capture_v1',
    JSON.stringify(names) === JSON.stringify(['mesa_prepare_table_order_v1', 'ordenes_assign_service_session', 'ordenes_order_entity_anchor_v1', 'ordenes_zz_giro_intent_capture_v1']), names);
  assert(`PRE order_cancel_v1 is the staging body (md5 ${LIVE_CANCEL_MD5})`, (await md5Of(su, CANCEL_SIG)) === LIVE_CANCEL_MD5, await md5Of(su, CANCEL_SIG));
  assert('PRE has neither the prelude function nor its trigger', (await md5Of(su, 'public.order_intake_lock_prelude_v1()')) === null && !names.includes(PRELUDE_TRG));
  const pins = [...readAny(F143).matchAll(/\('(public\.[a-z_0-9]+\(\))',\s+'([0-9a-f]{32})'\)/g)].map((m) => [m[1], m[2]]);
  const bad = [];
  for (const [sig, want] of pins) if ((await md5Of(su, sig)) !== want) bad.push(sig);
  assert('the four md5 pins of migration 143 (anchor, singleton, mesa_prepare, order_initial_payment) are exactly the bodies of the PRE database', pins.length === 4 && bad.length === 0, { pins: pins.length, bad });
  await su.end();
  // POST and control templates
  await env.admin.query('SELECT 1');
  env.tpl = {
    post: await buildDerived('post', [F143, F144]),
    only143: await buildDerived('only143', [F143]),
    only144: await buildDerived('only144', [F144]),
  };
  return true;
}

// ── P1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseApply() {
  section('C1 APPLY -- guards + post-conditions pass; EXACTLY the expected catalog entries move (whole-catalog fingerprint)');
  const su = await cloneSu('c8_pre_tpl', 'apply');
  const fp0 = await DED.catalogFingerprint(su);
  const cancel0 = await posture(su, CANCEL_SIG);
  let e = await applyTo(su, F143);
  assert('migration 143 applies cleanly (drift guards + post-conditions pass)', !e, e && `${e.code} ${e.message}`);
  if (e) { await su.end(); return false; }
  const fp1 = await DED.catalogFingerprint(su);
  const d143 = DED.fingerprintDiff(fp0, fp1);
  assert('143 changed EXACTLY two catalog entries: the new function and the new trigger (nothing else in public / trip_authority / giro_authority: no body, grant, table, column, index, constraint)',
    d143.length === 2 && d143.includes('functions:public.order_intake_lock_prelude_v1()') && d143.includes(`triggers:public.ordenes::${PRELUDE_TRG}`), d143);
  const pp = await posture(su, 'public.order_intake_lock_prelude_v1()');
  assert('the prelude is owned by postgres, SECURITY INVOKER, search_path public, pg_temp, EXECUTE for service_role only', pp.owner === 'postgres' && pp.prosecdef === false && pp.cfg === '{"search_path=public, pg_temp"}' && pp.acl === SVC_ONLY && !pp.anon_x && !pp.auth_x && pp.svc_x, pp);
  assert('trigger count 27 -> 28 on the 14 graph tables', (await trgCount(su)) === 28, await trgCount(su));
  const names = await biNames(su);
  assert('the prelude is the FIRST BEFORE INSERT trigger of ordenes and the M132 capture is still the LAST',
    JSON.stringify(names) === JSON.stringify([PRELUDE_TRG, 'mesa_prepare_table_order_v1', 'ordenes_assign_service_session', 'ordenes_order_entity_anchor_v1', 'ordenes_zz_giro_intent_capture_v1']), names);
  const tg = (await su.query(`SELECT (t.tgtype & 1) = 1 AS row_lvl, (t.tgtype & 2) = 2 AS before, (t.tgtype & 4) = 4 AS ins, (t.tgtype & 24) = 0 AS only_ins, t.tgqual IS NULL AS no_when, t.tgenabled FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname = '${PRELUDE_TRG}'`)).rows[0];
  assert('the trigger is BEFORE INSERT FOR EACH ROW with NO WHEN clause and enabled', tg && tg.row_lvl && tg.before && tg.ins && tg.only_ins && tg.no_when && tg.tgenabled === 'O', tg);
  e = await applyTo(su, F144);
  assert('migration 144 applies cleanly on top of 143 (fail-closed md5 drift guard passes on the staging body)', !e, e && `${e.code} ${e.message}`);
  if (e) { await su.end(); return false; }
  const fp2 = await DED.catalogFingerprint(su);
  const d144 = DED.fingerprintDiff(fp1, fp2);
  assert('144 changed EXACTLY one catalog entry: the body of order_cancel_v1 (owner, SECURITY, search_path, ACL and every other object identical)', d144.length === 1 && d144[0].startsWith('functions:public.order_cancel_v1('), d144);
  const cancel1 = await posture(su, CANCEL_SIG);
  assert('order_cancel_v1 kept owner / SECURITY INVOKER / search_path / ACL (service_role only)', JSON.stringify(cancel0) === JSON.stringify(cancel1) && cancel1.acl === SVC_ONLY && cancel1.cfg === '{"search_path=public, pg_temp"}' && !cancel1.prosecdef, { cancel0, cancel1 });
  const pinNew = [...readAny(R144).matchAll(/IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
  const md5New = await md5Of(su, CANCEL_SIG);
  assert('the installed order_cancel_v1 body is the exact 144 body the ROLLBACK guard pins, and is no longer the staging body', pinNew[0] === md5New && md5New !== LIVE_CANCEL_MD5, { pinNew, md5New });
  const src = (await su.query('SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)', [CANCEL_SIG])).rows[0].prosrc;
  assert('with the marked block removed the installed body is the staging body byte for byte', K.md5(src.replace(/^[ \t]*-- 144:BEGIN ([a-z_]+)\n[\s\S]*?^[ \t]*-- 144:END \1\n/gm, '')) === LIVE_CANCEL_MD5);
  await su.end();

  // independence / commutativity
  const a = await cloneSu('c8_pre_tpl', 'ord144first');
  assert('144 applies alone (no dependency on 143)', !(await applyTo(a, F144)));
  assert('...and 143 then applies on top of it', !(await applyTo(a, F143)));
  const fpB = await DED.catalogFingerprint(a);
  assert('the end state does not depend on the order: (143 then 144) == (144 then 143), entry by entry', DED.fingerprintDiff(fp2, fpB).length === 0, DED.fingerprintDiff(fp2, fpB));
  await a.end();
  // re-apply / rollback without apply
  const b = await cloneSu('c8_pre_tpl', 'dbl');
  await applyTo(b, F143); await applyTo(b, F144);
  const e143 = await applyTo(b, F143), e144 = await applyTo(b, F144);
  assert('a second apply of 143 is refused (typed guard)', !!e143 && /C8_PRELUDE refused/.test(e143.message), e143 && e143.message);
  assert('a second apply of 144 is refused (the body is no longer the pinned staging body)', !!e144 && /C8_CANCEL refused/.test(e144.message), e144 && e144.message);
  await b.end();
  const c = await cloneSu('c8_pre_tpl', 'rbnone');
  const r143 = await applyTo(c, R143), r144 = await applyTo(c, R144);
  assert('rollback 143 without a prior apply is refused (typed guard)', !!r143 && /C8_PRELUDE rollback refused/.test(r143.message), r143 && r143.message);
  assert('rollback 144 without a prior apply is refused (the body is not the 144 body)', !!r144 && /C8_CANCEL rollback refused/.test(r144.message), r144 && r144.message);
  await c.end();
  return true;
}

// ── P2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseDrift() {
  section('C2 DRIFT GUARDS -- fail closed: every injected drift is REFUSED with a typed message and the refused migration leaves NOTHING behind');
  const cases = [
    ['143', 'a drifted order_entity_anchor_v1', F143, /C8_PRELUDE refused/, (su) => fnDrift(su, 'public.order_entity_anchor_v1()')],
    ['143', 'a drifted mesa_singleton_workspace_v1', F143, /C8_PRELUDE refused/, (su) => fnDrift(su, 'public.mesa_singleton_workspace_v1()')],
    ['143', 'a drifted mesa_prepare_table_order_v1', F143, /C8_PRELUDE refused/, (su) => fnDrift(su, 'public.mesa_prepare_table_order_v1()')],
    ['143', 'a drifted order_initial_payment_v1', F143, /C8_PRELUDE refused/, (su) => fnDrift(su, 'public.order_initial_payment_v1()')],
    ['143', 'a missing mesa_singleton_workspace_v1', F143, /C8_PRELUDE refused/, (su) => su.query('DROP FUNCTION public.mesa_singleton_workspace_v1() CASCADE')],
    ['143', 'a BEFORE INSERT trigger on ordenes that sorts BEFORE the prelude', F143, /C8_PRELUDE refused/,
      (su) => su.query('CREATE TRIGGER "0_early" BEFORE INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.mesa_snapshot_order_lines_v1()')],
    ['143', 'a BEFORE INSERT trigger that sorts AFTER the M132 capture (capture not last)', F143, /C8_PRELUDE refused/,
      (su) => su.query('CREATE TRIGGER zz_late BEFORE INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.mesa_snapshot_order_lines_v1()')],
    ['143', 'a prelude function that already exists', F143, /C8_PRELUDE refused/,
      (su) => su.query(`CREATE FUNCTION public.order_intake_lock_prelude_v1() RETURNS trigger LANGUAGE plpgsql AS $x$ BEGIN RETURN NEW; END $x$`)],
    ['144', 'a drifted order_cancel_v1 (one comment added)', F144, /C8_CANCEL refused: order_cancel_v1 is not the pinned staging body/, (su) => fnDrift(su, CANCEL_SIG)],
    ['144', 'a missing order_cancel_v1', F144, /C8_CANCEL refused/, (su) => su.query(`DROP FUNCTION ${CANCEL_SIG}`)],
    ['144', 'an extra order_cancel_v1 overload', F144, /C8_CANCEL refused/,
      (su) => su.query(`CREATE FUNCTION public.order_cancel_v1(p_a text, p_b text, p_c text, p_d text, p_e text, p_f text, p_g jsonb, p_h integer) RETURNS jsonb LANGUAGE sql AS $x$ SELECT '{}'::jsonb $x$`)],
  ];
  for (const [mig, label, file, re, inject] of cases) {
    const su = await cloneSu('c8_pre_tpl', 'drift');
    await su.query('SET ROLE postgres'); await inject(su); await su.query('RESET ROLE');
    const fp0 = await DED.catalogFingerprint(su);
    const e = await applyTo(su, file);
    assert(`${mig} against ${label} is REFUSED (typed guard)`, !!e && re.test(e.message), e ? e.message : '(drift silently accepted)');
    const fp1 = await DED.catalogFingerprint(su);
    assert(`...and the refused ${mig} left NOTHING behind (whole-catalog fingerprint unchanged; a divergent body is never overwritten)`, DED.fingerprintDiff(fp0, fp1).length === 0, DED.fingerprintDiff(fp0, fp1));
    await su.end();
  }
  return true;
}

// ── P3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseRollback() {
  section('C3 ROLLBACK -- restores EXACTLY the pre-migration catalog (fingerprint), in either order, with a round trip; refuses over tampered objects');
  for (const order of [['144', '143'], ['143', '144']]) {
    const su = await cloneSu('c8_pre_tpl', 'rb' + order.join(''));
    const fp0 = await DED.catalogFingerprint(su);
    const pos0 = [await posture(su, CANCEL_SIG)];
    await applyTo(su, F143); await applyTo(su, F144);
    const fpA = await DED.catalogFingerprint(su);
    assert(`rollback proof pre-condition (${order.join('->')}): the migrations really changed the catalog (the comparison below is not vacuous)`, DED.fingerprintDiff(fp0, fpA).length === 3, DED.fingerprintDiff(fp0, fpA));
    const errs = [];
    for (const m of order) errs.push(await applyTo(su, m === '143' ? R143 : R144));
    assert(`rollbacks apply cleanly (${order.join(' then ')})`, errs.every((x) => !x), errs.map((x) => x && x.message));
    if (errs.every((x) => !x)) {
      const fp1 = await DED.catalogFingerprint(su);
      assert(`RB (${order.join(' then ')}): CATALOG FINGERPRINT == the pre-migration catalog, entry by entry (functions with md5 + owner + SECURITY + search_path + ACL, triggers, columns, indexes, constraints)`, DED.fingerprintDiff(fp0, fp1).length === 0, DED.fingerprintDiff(fp0, fp1));
      assert('RB: order_cancel_v1 is the staging body again, the trigger count is 27 again and the prelude is gone', (await md5Of(su, CANCEL_SIG)) === LIVE_CANCEL_MD5 && (await trgCount(su)) === 27 && (await md5Of(su, 'public.order_intake_lock_prelude_v1()')) === null);
      assert('RB: order_cancel_v1 owner / SECURITY / search_path / ACL are exactly the pre-migration ones', JSON.stringify([await posture(su, CANCEL_SIG)]) === JSON.stringify(pos0));
      if (order[0] === '144') {
        const again = [await applyTo(su, F143), await applyTo(su, F144)];
        assert('forward re-applies cleanly after the rollback (round trip)', again.every((x) => !x), again.map((x) => x && x.message));
        assert('...and the re-applied catalog equals the first-apply catalog (deterministic)', DED.fingerprintDiff(fpA, await DED.catalogFingerprint(su)).length === 0);
      }
    }
    await su.end();
  }
  // refusals over tampered objects
  const t1 = await cloneSu('c8_pre_tpl', 'rbt1');
  await applyTo(t1, F143);
  await t1.query('SET ROLE postgres'); await fnDrift(t1, 'public.order_intake_lock_prelude_v1()'); await t1.query('RESET ROLE');
  const e1 = await applyTo(t1, R143);
  assert('rollback 143 over a TAMPERED prelude is refused (md5 guard) and drops nothing', !!e1 && /C8_PRELUDE rollback refused/.test(e1.message) && (await md5Of(t1, 'public.order_intake_lock_prelude_v1()')) !== null && (await biNames(t1)).includes(PRELUDE_TRG), e1 && e1.message);
  await t1.end();
  const t2 = await cloneSu('c8_pre_tpl', 'rbt2');
  await applyTo(t2, F144);
  await t2.query('SET ROLE postgres'); await fnDrift(t2, CANCEL_SIG); await t2.query('RESET ROLE');
  const md5Drifted = await md5Of(t2, CANCEL_SIG);
  const e2 = await applyTo(t2, R144);
  assert('rollback 144 over a body that is not the exact 144 body is refused and overwrites nothing', !!e2 && /C8_CANCEL rollback refused/.test(e2.message) && (await md5Of(t2, CANCEL_SIG)) === md5Drifted, e2 && e2.message);
  await t2.end();
  const t3 = await cloneSu('c8_pre_tpl', 'rbt3');
  await applyTo(t3, F143);
  await t3.query('CREATE TRIGGER zz_dup BEFORE INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.order_intake_lock_prelude_v1()').catch(() => {});
  const e3 = await applyTo(t3, R143);
  assert('rollback 143 is refused when the prelude function is used by a trigger other than the expected one', !!e3 && /C8_PRELUDE rollback refused/.test(e3.message), e3 && e3.message);
  await t3.end();
  return true;
}

// ── P4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// which of these objects does a stalled backend already HOLD? (NOWAIT probes from a third connection; advisory L via try-lock)
async function heldSet(su, w, o) {
  const held = {};
  const probe = async (label, sql, params) => {
    await su.query('BEGIN');
    try { await su.query(sql, params); held[label] = false; } catch (e) { held[label] = e.code === '55P03'; if (e.code !== '55P03') held[label + '_err'] = e.code; }
    finally { await su.query('ROLLBACK'); }
  };
  await su.query('BEGIN');
  held.L = !(await su.query("SELECT pg_try_advisory_xact_lock(hashtext('service_session_lifecycle')) AS ok")).rows[0].ok;
  await su.query('ROLLBACK');
  await probe('SS', 'SELECT 1 FROM public.service_sessions WHERE id = $1 FOR UPDATE NOWAIT', [w.A]);
  await probe('D', 'SELECT 1 FROM public.business_days WHERE business_date = $1 FOR UPDATE NOWAIT', [w.bd]);
  if (o.table) await probe('TS', 'SELECT 1 FROM public.table_sessions WHERE id = $1 FOR UPDATE NOWAIT', [o.table]);
  if (o.actor) await probe('ACT', 'SELECT 1 FROM public.auth_actors WHERE actor = $1 FOR UPDATE NOWAIT', [o.actor]);
  await probe('W', 'SELECT 1 FROM public.workspaces WHERE id = $1 FOR UPDATE NOWAIT', [w.ws]);
  return held;
}
async function stallAt(tpl, label, party, blockerObj, tableAware) {
  const w = await K.world(env, tpl, label);
  const cn = await K.conns(w);
  try {
    const ctx = await K.PARTIES[party].prep(w, undefined);
    const h = await K.hold(cn.B, [blockerObj(w, ctx)], w);
    const p = K.start({ call: ctx.call, tx: true }, cn.T1);
    const s = await K.settleOrBlock(p, w.su, 'c8-t1', 600);
    const held = s.blocked ? await heldSet(w.su, w, { table: tableAware ? ctx.table : null, actor: ctx.actor }) : null;
    await K.release(cn.B, h);
    const r = await Promise.race([p, K.delay(6000).then(() => ({ timeout: true }))]);
    return { blocked: !!s.blocked, held, result: r && (r.err ? { err: r.err } : { ok: r.ok !== false }) };
  } finally { await w.close(); }
}
async function phasePrefix() {
  section('C4 LOCK PREFIX (empirical trigger order) -- the intake takes L -> W FOR UPDATE -> ACTOR before ANY other lock; PRE takes the service / table rows first');
  const W_FU = () => ({ kind: 'row', k: 'W' });
  for (const [party, label, tableAware] of [['I_UNPAID', 'plain unpaid intake', false], ['I_PAID_SAME', 'paid-at-creation intake', false], ['I_TABLE', 'Mesa comanda', true]]) {
    const post = await stallAt(env.tpl.post, 'pxp', party, W_FU, tableAware);
    assert(`POST ${label}: with W held by a blocker the intake STALLS on W holding ONLY L (no table-session, service, business-day or actor row lock yet)`,
      post.blocked && post.held && post.held.L === true && !post.held.SS && !post.held.D && !post.held.TS && !post.held.ACT, post);
    assert(`POST ${label}: ...and completes once W is released`, post.result && post.result.ok === true, post.result);
    const pre = await stallAt('c8_pre_tpl', 'pxr', party, W_FU, tableAware);
    assert(`PRE ${label} (negative control): the same stall shows the defect -- the intake already holds service / business-day / table rows BEFORE it reaches W`,
      pre.blocked && pre.held && (pre.held.SS || pre.held.D || pre.held.TS), pre);
  }
  // actor hoist: the paid intake holds W (and L) while it waits for the actor row, and nothing else
  const act = await stallAt(env.tpl.post, 'pxa', 'I_PAID_SAME', (w, ctx) => ({ kind: 'row', k: 'ACT', actor: ctx.actor }), false);
  assert('POST paid intake: with the payer ACTOR row held by a blocker it stalls holding L and W (FOR UPDATE) but NO service / business-day row: the actor is hoisted right after W, before the service row',
    act.blocked && act.held && act.held.L === true && act.held.W === true && !act.held.SS && !act.held.D, act);
  const actUn = await stallAt(env.tpl.post, 'pxu', 'I_UNPAID', (w) => ({ kind: 'row', k: 'ACT', actor: 'operator_backup' }), false);
  assert('POST unpaid intake never requests an actor row (the blocker on the actor does not stall it)', !actUn.blocked && actUn.result && actUn.result.ok === true, actUn);
  // mode: the intake takes W FOR UPDATE for ALL intakes (a KEY SHARE holder stalls it); PRE takes KEY SHARE (a KEY SHARE holder does not)
  const KS = () => ({ kind: 'row', k: 'W', mode: 'FOR KEY SHARE' });
  const post = await stallAt(env.tpl.post, 'pxk', 'I_UNPAID', KS, false);
  const pre = await stallAt('c8_pre_tpl', 'pxk2', 'I_UNPAID', KS, false);
  assert('POST unpaid intake is stalled by a KEY SHARE holder of W (it requests FOR UPDATE, never KEY SHARE: no KEY SHARE -> FOR UPDATE upgrade is possible)', post.blocked === true, post);
  assert('PRE unpaid intake is NOT stalled by a KEY SHARE holder of W (it only takes KEY SHARE: the mode the prelude replaces)', pre.blocked === false && pre.result && pre.result.ok === true, pre);
  // L is taken first: with L held by a blocker the intake holds NOTHING else
  const lHeld = await stallAt(env.tpl.post, 'pxl', 'I_TABLE', () => ({ kind: 'adv', k: 'L' }), true);
  assert('POST Mesa comanda: with L held by a blocker it stalls on L holding no table-session / service / workspace / actor row (L is the very first lock)',
    lHeld.blocked && lHeld.held && !lHeld.held.SS && !lHeld.held.TS && !lHeld.held.W && !lHeld.held.D, lHeld);
  // order_cancel_v1 (migration 144): W is its FIRST lock and is taken FOR UPDATE (W -> ACTOR -> [TABLE_SESSION] -> ORDER)
  const cW = await stallAt(env.tpl.post, 'pxc', 'W_CANCEL_TABLE_B', W_FU, true);
  assert('POST order_cancel_v1 (comanda, table path): with W held by a blocker it STALLS on W holding NO actor / table-session / service / business-day row (W is its first lock, before the actor)',
    cW.blocked && cW.held && !cW.held.ACT && !cW.held.TS && !cW.held.SS && !cW.held.D, cW);
  assert('POST order_cancel_v1: ...and completes once W is released', cW.result && cW.result.ok === true, cW.result);
  const cPre = await stallAt('c8_pre_tpl', 'pxc2', 'W_CANCEL_TABLE_B', W_FU, true);
  assert('PRE order_cancel_v1 (negative control): the same blocker on W does NOT stall the cancel (it has no W lock: it starts with the ACTOR row)', cPre.blocked === false && cPre.result && cPre.result.ok === true, cPre);
  const cKs = await stallAt(env.tpl.post, 'pxck', 'W_CANCEL', () => ({ kind: 'row', k: 'W', mode: 'FOR KEY SHARE' }), false);
  assert('POST order_cancel_v1 is stalled by a KEY SHARE holder of W (it requests FOR UPDATE, exactly like every other economic writer; a KEY SHARE request would not conflict)', cKs.blocked === true && cKs.held && !cKs.held.ACT, cKs);
  return true;
}

// ── P5 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function hyp(tpl, kind, label) {
  const w = await K.world(env, tpl, 'h' + kind, { deadlockMs: 400 });
  const cn = await K.conns(w);
  try {
    if (kind === 1) {                                                                        // H1: mesa_open_session_v1 x plain unpaid intake
      const tid = await K.mkRestTable(w, 9);
      const open = (c) => c.query('SELECT public.mesa_open_session_v1($1,$2,$3,$4,$5) AS r', [w.ws, 'operator_backup', tid, w.A, 2]).then((r) => r.rows[0].r);
      return await K.pairRun(w, cn, { t2: { call: open, tx: false }, t1: { call: (c) => K.insertOrder(c, { id: K.nextId('#HY'), totale: 11 }), tx: true }, pause: { who: 't2', objs: [{ kind: 'row', k: 'ACT', actor: 'operator_backup' }] } });
    }
    if (kind === 3) {                                                                        // H3: order_cancel_v1 x paid intake, SAME actor
      const O = await K.mkUnpaid(w, 10);
      const cancel = (c) => c.query('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_backup', 'hyp cancel', K.rid('cx'), K.hex64(K.rid('h')), 'CANCELADO', '{}']).then((r) => r.rows[0].r);
      return await K.pairRun(w, cn, { t2: { call: cancel, tx: false }, t1: { call: (c) => K.insertOrder(c, { id: K.nextId('#HY'), totale: 11, intentJson: K.intent('operator_backup') }), tx: true }, pause: { who: 't2', objs: [{ kind: 'row', k: 'ORD', id: O.id }] } });
    }
    if (kind === 4) {                                                                        // H4: order_cancel_v1 (comanda, actor operator_primary) x mesa_open_session_v1 (busy table, actor operator_backup)
      const ts = await K.mkTable(w, 2); const O = await K.mkTableOrder(w, ts, 10);
      const rt2 = (await w.su.query('SELECT table_id FROM public.table_sessions WHERE id = $1', [ts])).rows[0].table_id;
      const cancel = (c) => c.query('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_primary', 'hyp cancel', K.rid('cx'), K.hex64(K.rid('h')), 'CANCELADO', '{}']).then((r) => r.rows[0].r);
      const open = (c) => c.query('SELECT public.mesa_open_session_v1($1,$2,$3,$4,$5) AS r', [w.ws, 'operator_backup', rt2, w.A, 2]).then((r) => r.rows[0].r);
      return await K.pairRun(w, cn, { t1: { call: cancel, tx: false }, t2: { call: open, tx: false }, pause: { who: 't1', objs: [{ kind: 'row', k: 'ORD', id: O.id }] } });
    }
    // H2: paid plain intake (T1) x comanda (T2) while a KEY SHARE holder sits on W: the paid intake must not upgrade KEY SHARE -> FOR UPDATE behind the comanda
    const t = await K.mkTable(w, 2);
    const comanda = (c) => c.query(`INSERT INTO public.ordenes (id, estado, totale, items, table_session_id) VALUES ($1,'EN_COCINA',7,$2::jsonb,$3) RETURNING id`, [K.nextId('#H2'), JSON.stringify([{ n: 'P', q: 1, p: 7 }]), t]).then((r) => r.rows[0]);
    const h = await K.hold(cn.B, [{ kind: 'row', k: 'W', mode: 'FOR KEY SHARE' }], w);
    const p1 = K.start({ call: (c) => K.insertOrder(c, { id: K.nextId('#HY'), totale: 11, intentJson: K.intent('operator_primary') }), tx: true }, cn.T1);
    const s1 = await K.settleOrBlock(p1, w.su, 'c8-t1', 400);
    const p2 = K.start({ call: comanda, tx: true }, cn.T2);
    const s2 = await K.settleOrBlock(p2, w.su, 'c8-t2', 400);
    await K.release(cn.B, h);
    const r = await Promise.race([Promise.all([p1, p2]), K.delay(6000).then(() => 'TIMEOUT')]);
    return { t1_state: s1.done ? 'done' : (s1.blocked ? 'blocked' : 'running'), t2_state: s2.done ? 'done' : (s2.blocked ? 'blocked' : 'running'),
      timeout: r === 'TIMEOUT', deadlock: r !== 'TIMEOUT' && [r[0], r[1]].some((x) => x && x.err === '40P01'), result: r === 'TIMEOUT' ? null : { t1: r[0], t2: r[1] } };
  } finally { await w.close(); }
}
async function phaseHyp() {
  section('C5 DETERMINISTIC H1 / H2 / H3 (two real connections, pause-point interleavings) -- PRE reproduces the deadlocks, POST has none');
  const ok = (r) => r.result && Object.values(r.result).every((x) => x && x.ok === true);
  const pre1 = await hyp('c8_pre_tpl', 1), post1 = await hyp(env.tpl.post, 1);
  assert('H1 mesa_open_session_v1 x simple intake: PRE deadlocks (40P01, the intake is the victim) -- negative control', pre1.first_state === 'blocked' && pre1.deadlock === true && pre1.victim === 't1', pre1);
  assert('H1 mesa_open_session_v1 x simple intake: POST has NO 40P01, both complete', post1.first_state === 'blocked' && !post1.deadlock && !post1.timeout && ok(post1), post1);
  const pre3 = await hyp('c8_pre_tpl', 3), post3 = await hyp(env.tpl.post, 3);
  assert('H3 order_cancel_v1 x paid intake (same actor): PRE deadlocks (40P01) -- negative control', pre3.first_state === 'blocked' && pre3.deadlock === true, pre3);
  assert('H3 order_cancel_v1 x paid intake (same actor): POST has NO 40P01, both complete (cancel applied, payment recorded)', post3.first_state === 'blocked' && !post3.deadlock && !post3.timeout && ok(post3), post3);
  const pre2 = await hyp('c8_pre_tpl', 2), post2 = await hyp(env.tpl.post, 2);
  assert('H2 paid intake x comanda: PRE has no deadlock (the hazard exists only for a KEY SHARE-first design)', !pre2.deadlock && !pre2.timeout, pre2);
  assert('H2 paid intake x comanda: POST has NO 40P01 and no KEY SHARE -> FOR UPDATE upgrade wait (the paid intake was stalled at the prelude, before any KEY SHARE, and both complete)',
    !post2.deadlock && !post2.timeout && post2.t1_state === 'blocked' && post2.result && post2.result.t1.ok === true && post2.result.t2.ok === true, post2);
  // H4: the cycle order_cancel_v1 (ACT -> TS -> ORD -> SS KEY SHARE, no W) x mesa_open_* (W -> ACT -> SS FOR UPDATE -> TS): closed ONLY by 144
  const pre4 = await hyp('c8_pre_tpl', 4), post4 = await hyp(env.tpl.post, 4), a143 = await hyp(env.tpl.only143, 4), a144 = await hyp(env.tpl.only144, 4);
  const okBoth = (r) => r.result && r.result.t1 && r.result.t2 && (r.result.t1.ok === true || (r.result.t1.err && r.result.t1.err !== '40P01')) && r.result.t2.err !== '40P01';
  assert('H4 order_cancel_v1 (comanda, actor A) x mesa_open_session_v1 (same table, actor B): PRE deadlocks (40P01) -- negative control', pre4.first_state === 'blocked' && pre4.deadlock === true, pre4);
  assert('H4 with 143 ALONE still deadlocks (the prelude only re-orders the intake; order_cancel_v1 has no W lock)', a143.first_state === 'blocked' && a143.deadlock === true, a143);
  assert('H4 with 144 ALONE has NO deadlock (order_cancel_v1 takes W first, like mesa_open_*: the two writers are serialized on W)', a144.first_state === 'blocked' && !a144.deadlock && !a144.timeout && okBoth(a144), a144);
  assert('H4 POST (143 + 144): NO 40P01', post4.first_state === 'blocked' && !post4.deadlock && !post4.timeout && okBoth(post4), post4);
  // each migration alone (controls): the prelude closes H1 and H3 by itself in these pause points; 144 alone closes neither
  const only143 = [await hyp(env.tpl.only143, 1), await hyp(env.tpl.only143, 3)];
  const only144 = [await hyp(env.tpl.only144, 1), await hyp(env.tpl.only144, 3)];
  assert('control: 143 ALONE closes H1 and H3 at these pause points (the prelude is the C8 fix)', only143.every((r) => !r.deadlock && !r.timeout && ok(r)), only143);
  assert('control: 144 ALONE closes neither H1 nor H3 (order_cancel_v1 W-first is only useful together with the prelude)', only144.every((r) => r.deadlock === true), only144);
  return true;
}

// ── P6 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PAIRS_FULL = [
  // H1 mesa_open_session_v1 x intake
  ['I_UNPAID', 'W_MOPEN'], ['I_PAID', 'W_MOPEN'], ['I_TABLE', 'W_MOPEN'], ['I_UNPAID', 'W_MOPEN_BUSY'], ['I_TABLE', 'W_MOPEN_BUSY'],
  // Cash V1 / Mesa payment / refund / adjustment x intake
  ['I_UNPAID', 'W_CASH'], ['I_PAID', 'W_CASH'], ['I_PAID_SAME', 'W_CASH'], ['I_TABLE', 'W_CASH'],
  ['I_TABLE', 'W_MPAY'], ['I_UNPAID', 'W_MPAY'], ['I_PAID', 'W_MPAY'], ['I_TABLE', 'W_MREFUND'], ['I_UNPAID', 'W_MREFUND'],
  ['I_UNPAID', 'W_REFUND'], ['I_PAID_SAME', 'W_REFUND'], ['I_UNPAID', 'W_ADJ'], ['I_PAID', 'W_ADJ'],
  // H3 order_cancel_v1 x intake
  ['I_PAID_SAME', 'W_CANCEL'], ['I_UNPAID', 'W_CANCEL'], ['I_PAID', 'W_CANCEL'], ['I_TABLE', 'W_CANCEL_TABLE'], ['I_UNPAID', 'W_CANCEL_TABLE'], ['I_PAID_SAME', 'W_CANCEL_TABLE'],
  ['W_CANCEL', 'W_MOPEN_BUSY'], ['W_CANCEL_TABLE', 'W_MOPEN_BUSY'], ['W_CANCEL', 'W_MOPEN'], ['W_CANCEL_TABLE_B', 'W_MOPEN_BUSY'],
  // operator confirmation / rider x intake
  ['I_PAID_SAME', 'W_OPCONF'], ['I_UNPAID', 'W_OPCONF'], ['I_PAID', 'W_OPCONF'], ['I_TABLE', 'W_OPCONF'],
  ['I_UNPAID', 'W_RIDER'], ['I_PAID', 'W_RIDER'], ['I_TABLE', 'W_RIDER'],
  // close x intake
  ['I_UNPAID', 'W_CLOSE'], ['I_PAID', 'W_CLOSE'], ['I_TABLE', 'W_CLOSE'], ['I_PAID_SAME', 'W_CLOSE'],
  // intake x intake, writer x writer
  ['I_UNPAID', 'I_UNPAID'], ['I_PAID', 'I_PAID'], ['I_PAID_SAME', 'I_PAID'], ['I_TABLE', 'I_TABLE'], ['I_TABLE', 'I_UNPAID'], ['I_PAID', 'I_TABLE'], ['I_PAID_SAME', 'I_TABLE'],
  ['W_CASH', 'W_CANCEL'], ['W_MPAY', 'W_CANCEL_TABLE'], ['W_RIDER', 'W_CASH'],
  // first-open: no service open
  ['I_FIRST', 'W_CASH_HIST'], ['I_FIRST_PAID', 'W_CASH_HIST'], ['I_FIRST', 'W_OPEN'], ['I_FIRST_PAID', 'W_OPEN'], ['I_FIRST', 'W_ADJ_HIST'],
];
const PAIRS_QUICK = [['I_UNPAID', 'W_MOPEN'], ['I_PAID_SAME', 'W_CASH'], ['I_TABLE', 'W_MPAY'], ['I_PAID_SAME', 'W_CANCEL'], ['W_CANCEL_TABLE_B', 'W_MOPEN_BUSY'], ['I_PAID_SAME', 'W_OPCONF'], ['I_UNPAID', 'W_CLOSE'], ['I_FIRST', 'W_OPEN']];
async function phasePairs() {
  section('C6 PAIR SWEEPS -- every lock-level interleaving of the mandatory pairs (a blocker holds each object of the paused party, both directions)');
  const pairs = QUICK ? PAIRS_QUICK : PAIRS_FULL;
  // negative controls: the SAME sweep on PRE must find deadlocks (the harness can see the defect)
  for (const [a, b] of [['I_UNPAID', 'W_MOPEN'], ['I_PAID_SAME', 'W_CANCEL'], ['I_TABLE', 'W_MPAY'], ['W_CANCEL_TABLE_B', 'W_MOPEN_BUSY']]) {
    const r = await K.sweepPair(env, 'c8_pre_tpl', a, b);
    assert(`PRE ${a} x ${b}: the sweep finds deadlocks (${r.deadlocks.length} of ${r.exercised} exercised) -- negative control`, r.deadlocks.length > 0, r);
  }
  let total = { pairs: 0, runs: 0, exercised: 0, deadlocks: 0 }; const reds = []; const documented = [];
  for (const [a, b] of pairs) {
    const r = await K.sweepPair(env, env.tpl.post, a, b);
    total.pairs++; total.runs += r.runs; total.exercised += r.exercised; total.deadlocks += r.deadlocks.length;
    const isRiderSame = a === 'I_PAID_SAME' && b === 'W_RIDER';
    if (r.deadlocks.length && !isRiderSame) reds.push(r);
    if (isRiderSame && r.deadlocks.length) documented.push(r);
    assert(`POST ${a} x ${b}: ${r.exercised} lock-level interleavings exercised, 0 deadlocks, 0 timeouts, integrity + state invariants green`,
      r.deadlocks.length === 0 && r.timeouts === 0 && r.integrity.length === 0 && r.exercised > 0, { deadlocks: r.deadlocks, timeouts: r.timeouts, integrity: r.integrity, exercised: r.exercised, unexpected: r.unexpected.slice(0, 3) });
  }
  assert(`POST totals: ${total.pairs} pairs, ${total.exercised} exercised interleavings, ${total.deadlocks} deadlocks`, total.deadlocks === 0, total);
  // the ONE documented residual: the rider RPC takes its actor row BEFORE W (exception E1, frozen and documented); it can only meet the intake through a rider-actor
  // paid intake, which the role gate makes unreachable. Recorded here, asserted unreachable below, never "normalised".
  const rs = await K.sweepPair(env, env.tpl.post, 'I_PAID_SAME', 'W_RIDER');
  assert(`documented residual (E1): I_PAID_SAME x W_RIDER with the SAME payer actor 'rider' shows ${rs.deadlocks.length} deadlock(s) at these pause points -- it requires a paid-at-creation intake whose actor is a rider`,
    rs.deadlocks.every((d) => d.actors.t1 === 'rider' && d.actors.t2 === 'rider'), rs.deadlocks);
  const roles = require(path.join(__dirname, '..', '..', '..', 'src', 'auth', 'legacyActionRoles.js'));
  assert('ROLE GATE (unreachable): creaOrdine / createOrden -- the ONLY producers of initial_payment_intent -- are not in RIDER_ALLOWED, so a rider session can never author the intent', // language-guard: allow-legacy creaOrdine is the existing legacy action name of src/auth/legacyActionRoles.js, cited in this label and asserted verbatim on the next line, not new vocabulary
    !roles.RIDER_ALLOWED.includes('creaOrdine') && !roles.RIDER_ALLOWED.includes('createOrden') && !roles.isAllowed('rider', 'creaOrdine') && !roles.isAllowed('rider', 'createOrden'), roles.RIDER_ALLOWED);
  const w = await K.world(env, env.tpl.post, 'rg');
  const before = await K.counts(w.su);
  let gate = null;
  try { await K.insertOrder(w.svc, { id: K.nextId('#RG'), totale: 10, intentJson: K.intent('rider') }); } catch (e) { gate = e; }
  assert('ROLE GATE (data): even if a rider-actor intent reached the database, the canonical writer refuses it (ORDER_PAYMENT_FORBIDDEN 42501) and the order is not created (atomic)',
    !!gate && gate.code === '42501' && /ORDER_PAYMENT_FORBIDDEN/.test(gate.message) && JSON.stringify(await K.counts(w.su)) === JSON.stringify(before), gate && gate.message);
  await w.close();
  if (!QUICK) {
    // controls: each migration alone on the pairs it is (not) responsible for
    const c1 = await K.sweepPair(env, env.tpl.only143, 'W_CANCEL_TABLE_B', 'W_MOPEN_BUSY');
    assert(`control: with 143 ALONE the sweep of W_CANCEL_TABLE_B x W_MOPEN_BUSY still finds ${c1.deadlocks.length} deadlock(s) (order_cancel_v1 has no W lock) -- 144 is needed`, c1.deadlocks.length > 0, c1);
    const c1b = await K.sweepPair(env, env.tpl.only144, 'W_CANCEL_TABLE_B', 'W_MOPEN_BUSY');
    assert('control: with 144 ALONE the same pair has 0 deadlocks', c1b.deadlocks.length === 0 && c1b.timeouts === 0, c1b);
    const c2 = await K.sweepPair(env, env.tpl.only144, 'I_UNPAID', 'W_MOPEN');
    assert(`control: with 144 ALONE the sweep of I_UNPAID x W_MOPEN still finds ${c2.deadlocks.length} deadlock(s) -- the prelude is needed`, c2.deadlocks.length > 0, c2);
  }
  return true;
}

// ── P7 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
let lcg = 424242; const rnd = () => { lcg = (lcg * 1103515245 + 12345) & 0x7fffffff; return lcg / 0x7fffffff; };
const pick = (mix) => { const tot = mix.reduce((a, m) => a + m[1], 0); let r = rnd() * tot; for (const [n, wt] of mix) { if ((r -= wt) < 0) return n; } return mix[0][0]; };
async function phaseNatural() {
  section('C7 NATURAL RACES (no forced pauses) -- deadlocks must be 0, invariants green');
  const items = [
    ['B  comanda vs mesa_post_payment (same table)', R(80), () => ['W_MPAY', 'I_TABLE'], true],
    ['C  comanda vs mesa_post_refund (same table)', R(60), () => ['W_MREFUND', 'I_TABLE'], true],
    ['D  order_cancel vs paid intake (same actor)', R(80), () => ['W_CANCEL', 'I_PAID_SAME'], true],
    ['D2 order_cancel(table) vs comanda (same table)', R(60), () => ['W_CANCEL_TABLE', 'I_TABLE'], true],
    ['E  operator_confirm_delivery vs paid intake (same actor)', R(40), () => ['W_OPCONF', 'I_PAID_SAME'], true],
    ['E2 operator_confirm_delivery vs unpaid intake', R(40), () => ['W_OPCONF', 'I_UNPAID'], true],
    ['H  intake vs intake burst (paid/unpaid/table mix)', R(60), () => Array.from({ length: 6 }, () => pick([['I_UNPAID', 3], ['I_PAID', 2], ['I_PAID_SAME', 1], ['I_TABLE', 2]])), true],
    ['I  two comande, SAME table', R(60), () => ['I_TABLE', 'I_TABLE'], true],
    ['J  two comande, DIFFERENT tables', R(60), () => ['I_TABLE', 'I_TABLE'], false],
    ['K  paid-at-creation intake vs Cash V1', R(80), () => ['W_CASH', 'I_PAID'], true],
    ['K2 paid-at-creation intake (same actor) vs Cash V1', R(80), () => ['W_CASH', 'I_PAID_SAME'], true],
    ['L  burst multi-writer', R(60), () => Array.from({ length: 8 }, () => pick([['I_UNPAID', 3], ['I_PAID', 2], ['I_TABLE', 2], ['W_CASH', 3], ['W_MPAY', 1], ['W_REFUND', 1], ['W_ADJ', 1], ['W_CANCEL', 1], ['W_MOPEN', 1]])), true],
    ['H1 mesa_open_session_v1 vs intake', R(60), () => ['W_MOPEN', 'I_UNPAID'], true],
    ['D3 order_cancel(table, DIFFERENT actor) vs mesa_open_session_v1 (same busy table)', R(60), () => ['W_MOPEN_BUSY', 'W_CANCEL_TABLE_B'], true, [/W_MOPEN_BUSY:23505:MESA_TABLE_ACCOUNT_OPEN/]],
  ];
  let ops = 0;
  for (const [label, rounds, plan, share, expected] of QUICK ? items.filter((_, i) => [0, 2, 6, 12, 13].includes(i)) : items) {
    const st = await K.stressMix(env, env.tpl.post, { rounds, plan, share, label, expected });
    ops += st.ops;
    assert(`POST ${label}: ${st.ops} operations${expected ? ' (' + st.refusals + ' expected typed refusals)' : ''}, 0 deadlocks, no unexpected error, invariants green`, st.deadlocks === 0 && Object.keys(st.other_errors).length === 0 && st.integrity.length === 0, { deadlocks: st.deadlocks, other: st.other_errors, integrity: st.integrity });
  }
  // calibration (INFO only, never asserted): the SAME natural mixes on PRE. It shows how much of the defect an UNFORCED race can see; the strength of the proof is the
  // pause-point sweeps of C6 (negative controls that must deadlock), not these counts.
  const calib = { PRE: [], 'only 143': [], 'only 144': [] };
  const tplOf = { PRE: 'c8_pre_tpl', 'only 143': env.tpl.only143, 'only 144': env.tpl.only144 };
  for (const [label, rounds, plan, share, expected] of items.filter((_, i) => [0, 2, 12, 13].includes(i))) {
    for (const which of Object.keys(calib)) {
      if (which !== 'PRE' && QUICK) continue;
      const st = await K.stressMix(env, tplOf[which], { rounds, plan, share, label: label + ' [' + which + ']', expected });
      calib[which].push(`${label.trim().split(/\s+/)[0]}: ${st.deadlocks}/${st.ops}`);
    }
  }
  for (const [which, l] of Object.entries(calib)) if (l.length) console.log(`  INFO  natural-race calibration, ${which} database (deadlocks/ops, NOT asserted): ${l.join('   ')}`);
  // G: close vs intake, both start orders (fresh service every round); F: first-open intake vs writers on a service that is closed
  const g = { rounds: R(20), dl: 0, other: {}, closeOk: 0, intakeOk: 0, inv: [] };
  for (let i = 0; i < g.rounds; i++) {
    const w = await K.world(env, env.tpl.post, 'g', { deadlockMs: 200 });
    try {
      const corr = await K.H.seedCloseable({ su: w.su }, w.A); const cn = await K.conns(w);
      const paid = i % 2 === 0;
      const res = await Promise.all([
        (async () => { await K.delay(Math.floor(rnd() * 12)); try { const r = await K.H.closeV3(cn.T1, w.A, corr); return { n: 'close', ok: r && r.ok === true }; } catch (e) { return { n: 'close', err: e.code }; } })(),
        (async () => { await K.delay(Math.floor(rnd() * 12)); try { await cn.T2.query('BEGIN'); await K.insertOrder(cn.T2, { id: K.nextId('#GG'), estado: 'RETIRADO', totale: 12.5, intentJson: paid ? K.intent('operator_primary') : null }); await cn.T2.query('COMMIT'); return { n: 'intake', ok: true }; } catch (e) { await cn.T2.query('ROLLBACK').catch(() => {}); return { n: 'intake', err: e.code, msg: e.message.slice(0, 50) }; } })(),
      ]);
      for (const x of res) { if (x.err === '40P01') g.dl++; else if (x.err) g.other[`${x.n}:${x.err}:${x.msg || ''}`] = (g.other[`${x.n}:${x.err}:${x.msg || ''}`] || 0) + 1; }
      g.closeOk += res[0].ok ? 1 : 0; g.intakeOk += res[1].ok ? 1 : 0;
      g.inv.push(...(await K.integrity(w.su)).violations, ...(await K.stateInvariants(w.su)).violations);
    } finally { await w.close(); }
  }
  assert(`POST G close_service_session_v3 vs intake (natural, ${g.rounds} rounds, close-first and intake-first): 0 deadlocks, no unexpected error, no live order on a closed service, invariants green`,
    g.dl === 0 && Object.keys(g.other).length === 0 && g.inv.length === 0, g);
  const f = {}; let fdl = 0; const finv = [];
  for (const wname of ['W_CASH_HIST', 'W_OPEN', 'W_ADJ_HIST', 'W_REFUND_HIST']) {
    f[wname] = { rounds: R(10), dl: 0, other: {}, activeMax: 0 };
    for (let i = 0; i < f[wname].rounds; i++) {
      const w = await K.world(env, env.tpl.post, 'fo', { deadlockMs: 200, noService: true });
      try {
        const cn = await K.conns(w);
        const wctx = await K.PARTIES[wname].prep(w);
        const res = await Promise.all([
          (async () => { await K.delay(Math.floor(rnd() * 10)); try { const r = await wctx.call(cn.T1); return { n: wname, ok: !(r && r.ok === false) }; } catch (e) { return { n: wname, err: e.code, msg: e.message.slice(0, 40) }; } })(),
          (async () => { await K.delay(Math.floor(rnd() * 10)); try { await cn.T2.query('BEGIN'); await K.insertOrder(cn.T2, { id: K.nextId('#FO'), totale: 12.5, intentJson: i % 2 ? K.intent('operator_primary') : null }); await cn.T2.query('COMMIT'); return { n: 'intake', ok: true }; } catch (e) { await cn.T2.query('ROLLBACK').catch(() => {}); return { n: 'intake', err: e.code, msg: e.message.slice(0, 40) }; } })(),
        ]);
        for (const x of res) { if (x.err === '40P01') { f[wname].dl++; fdl++; } else if (x.err) f[wname].other[`${x.n}:${x.err}:${x.msg}`] = (f[wname].other[`${x.n}:${x.err}:${x.msg}`] || 0) + 1; }
        finv.push(...(await K.integrity(w.su)).violations, ...(await K.stateInvariants(w.su)).violations);
      } finally { await w.close(); }
    }
    // a refund on a closed service with NO service open is the separate FINDING B (untyped 23514 on payment_transactions), not C8: recorded, never asserted away, never fixed here
    f[wname].known_separate_finding_B = Object.entries(f[wname].other).filter(([k]) => /23514/.test(k)).reduce((a, [, n]) => a + n, 0);
    f[wname].unexpected = Object.keys(f[wname].other).filter((k) => !/23514/.test(k));
  }
  console.log('  INFO  KNOWN_SEPARATE_FINDINGS (out of scope, recorded): B refund without an open service -> untyped 23514 occurrences = ' + JSON.stringify(Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.known_separate_finding_B]))));
  assert('POST F first-open (no service open): intake vs historical payment / adjustment / refund / resume -- 0 deadlocks, no unexpected error (a 23514 on a refund with no service open is the known separate finding B), single active service, business day and pointer coherent, no double service, no live order on a closed service',
    fdl === 0 && finv.length === 0 && Object.values(f).every((v) => v.unexpected.length === 0), { f, finv });
  return true;
}

// ── P8 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseNumbering() {
  section('C8 ORDER NUMBERING under concurrent intake (table + non-table, paid + unpaid, forced rollbacks): monotonic, contiguous, no duplicate');
  const w = await K.world(env, env.tpl.post, 'num', { deadlockMs: 200 });
  const conns = []; for (let i = 0; i < 8; i++) conns.push(await w.client('n-' + i));
  const t = await K.mkTable(w, 4), t2 = await K.mkTable(w, 4);
  const kinds = ['plain', 'paid', 'table', 'table2', 'paid_bad_actor', 'rollback_plain', 'rollback_paid'];
  const stats = { committed: 0, rolled: 0, refused: 0, deadlocks: 0, other: {} }; const seen = []; let cseq = 0;
  for (let r = 0; r < R(40); r++) {
    await Promise.all(conns.map((c) => (async () => {
      const kind = kinds[Math.floor(rnd() * kinds.length)];
      await K.delay(Math.floor(rnd() * 6));
      try {
        await c.query('BEGIN'); let row;
        if (kind === 'plain' || kind === 'rollback_plain') row = await K.insertOrder(c, { id: K.nextId('#NUM'), totale: 9 });
        else if (kind === 'paid' || kind === 'rollback_paid') row = await K.insertOrder(c, { id: K.nextId('#NUM'), totale: 9, intentJson: K.intent('operator_primary') });
        else if (kind === 'paid_bad_actor') row = await K.insertOrder(c, { id: K.nextId('#NUM'), totale: 9, intentJson: K.intent('nobody_here') });
        else row = (await c.query(`INSERT INTO public.ordenes (id, estado, totale, items, table_session_id) VALUES ($1,'EN_COCINA',7,$2::jsonb,$3) RETURNING id, service_session_id`, [K.nextId('#NUM'), JSON.stringify([{ n: 'P', q: 1, p: 7 }]), kind === 'table' ? t : t2])).rows[0];
        if (kind.startsWith('rollback')) { await c.query('ROLLBACK'); stats.rolled++; return; }
        const num = (await c.query('SELECT service_order_number AS n, service_session_id AS s FROM public.ordenes WHERE id = $1', [row.id])).rows[0];
        await c.query('COMMIT'); stats.committed++; seen.push({ seq: ++cseq, s: num.s, n: Number(num.n) });
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        if (e.code === '40P01') stats.deadlocks++; else if (['P0001', '22023', '42501', 'P0002'].includes(e.code)) stats.refused++; else stats.other[e.code + ':' + String(e.message).slice(0, 40)] = 1;
      }
    })()));
  }
  const bySvc = {}; for (const x of seen) (bySvc[x.s] = bySvc[x.s] || []).push(x);
  const mono = Object.values(bySvc).reduce((a, arr) => { arr.sort((p, q) => p.seq - q.seq); let v = 0; for (let i = 1; i < arr.length; i++) if (arr[i].n < arr[i - 1].n) v++; return a + v; }, 0);
  const inv = await K.stateInvariants(w.su);
  assert(`${stats.committed} committed / ${stats.rolled} forced rollbacks / ${stats.refused} typed refusals: 0 deadlocks, no unexpected error`, stats.deadlocks === 0 && Object.keys(stats.other).length === 0 && stats.committed > 0, stats);
  assert('numbers are contiguous per service (no gap, no duplicate, next_order_number = max + 1) and commit-monotonic', inv.violations.length === 0 && mono === 0, { inv: inv.violations, mono });
  assert('economic invariants green after the race (no double payment, no lost allocation, no orphan event, no half-written order)', (await K.integrity(w.su)).violations.length === 0, (await K.integrity(w.su)).violations);
  await w.close();
  return true;
}

// ── P9 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
async function parityRun(tpl) {
  const w = await K.world(env, tpl, 'par', { deadlockMs: 300 });
  const out = [];
  try {
    const t = await K.mkTable(w, 2);
    const tclosed = await K.mkTable(w, 2); await w.su.query("UPDATE public.table_sessions SET status='closed', closed_at=now() WHERE id=$1", [tclosed]).catch(() => {});
    const ins = async (label, sql, args) => {
      let r;
      try { const q = await w.svc.query(sql, args); const row = q.rows[0] || {}; r = { ok: true, n: row.service_order_number, cmd: row.table_command_number, estado: row.estado, cobrado: row.cobrado, ya_pagado: row.ya_pagado, metodo: row.metodo_pago, uid: !!row.order_uid }; }
      catch (e) { r = { err: e.code, msg: norm(e.message).slice(0, 110) }; }
      const c = await K.counts(w.su); r.counts = Object.values(c).join('/'); out.push({ label, ...r });
    };
    const base = "INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, totale, tipo_consegna, initial_payment_intent) VALUES ($1,'EN_COCINA','Q1','21:00','20:40',$2,'DOMICILIO',$3::jsonb) RETURNING id, order_uid, service_order_number, estado, cobrado, ya_pagado, metodo_pago"; // language-guard: allow-legacy tipo_consegna is the existing ordenes column name
    const it = (o) => JSON.stringify({ method: 'efectivo', actor: 'operator_primary', sid_hash: K.hex64('s'), ...o });
    const id = () => K.nextId('#PA');
    await ins('unpaid', base, [id(), 10, null]);
    await ins('paid efectivo', base, [id(), 10, it({})]);
    await ins('paid tarjeta (owner)', base, [id(), 11, it({ method: 'tarjeta', actor: 'owner' })]);
    await ins('paid bizum', base, [id(), 12, it({ method: 'bizum' })]);
    await ins('paid method invalid', base, [id(), 10, it({ method: 'cripto' })]);
    await ins('paid actor unknown', base, [id(), 10, it({ actor: 'nobody_here' })]);
    await ins('paid actor empty', base, [id(), 10, it({ actor: '' })]);
    await ins('paid sid_hash invalid', base, [id(), 10, it({ sid_hash: 'zz' })]);
    await ins('paid actor rider (role gate)', base, [id(), 10, it({ actor: 'rider' })]);
    await ins('paid actor cashier (role gate)', base, [id(), 10, it({ actor: 'cashier' })]);
    await ins('paid, ya_pagado forged true', "INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, totale, tipo_consegna, ya_pagado, initial_payment_intent) VALUES ($1,'EN_COCINA','Q1','21:00','20:40',$2,'DOMICILIO',true,$3::jsonb) RETURNING id, service_order_number, estado, cobrado, ya_pagado, metodo_pago", [id(), 10, it({})]); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name
    await ins('forged service_session_id', "INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, totale, tipo_consegna, service_session_id) VALUES ($1,'EN_COCINA','Q1','21:00','20:40',$2,'DOMICILIO',$3) RETURNING id, service_order_number", [id(), 10, w.A]); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name
    await ins('forged service_order_number', "INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, totale, tipo_consegna, service_order_number) VALUES ($1,'EN_COCINA','Q1','21:00','20:40',$2,'DOMICILIO',99) RETURNING id, service_order_number", [id(), 10]); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name
    const tbl = "INSERT INTO public.ordenes (id, estado, totale, items, table_session_id, initial_payment_intent) VALUES ($1,'EN_COCINA',$2,$3::jsonb,$4,$5::jsonb) RETURNING id, order_uid, service_order_number, table_command_number, estado";
    const items = JSON.stringify([{ n: 'Pizza', q: 1, p: 7 }]);
    await ins('table comanda', tbl, [id(), 7, items, t, null]);
    await ins('table comanda #2', tbl, [id(), 7, items, t, null]);
    await ins('table not found (canonical typed error)', tbl, [id(), 7, items, '00000000-0000-0000-0000-000000000001', null]);
    await ins('table closed', tbl, [id(), 7, items, tclosed, null]);
    await ins('table + initial payment intent', tbl, [id(), 7, items, t, it({})]);
    await ins('table empty items', tbl, [id(), 7, '[]', t, null]);
    await ins('unpaid after the table cases', base, [id(), 10, null]);
    await ins('giro capture: malformed pending_giro_intent (M132 capture still fires last)', "INSERT INTO public.ordenes (id, estado, zona, hora, forno_out, totale, tipo_consegna, pending_giro_intent) VALUES ($1,'EN_COCINA','Q1','21:00','20:40',$2,'DOMICILIO',$3::jsonb) RETURNING id, order_uid, service_order_number, estado", [id(), 10, JSON.stringify({ v: 2 })]); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name
    out.push({ label: 'giro capture effects', pending_left: (await w.su.query('SELECT count(*)::int AS n FROM public.ordenes WHERE pending_giro_intent IS NOT NULL')).rows[0].n, intents: (await w.su.query('SELECT count(*)::int AS n FROM giro_authority.giro_intents')).rows[0].n });
    // no service open: the first-open path
    for (const o of (await w.su.query('SELECT id FROM public.ordenes')).rows) await w.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [o.id]);
    await w.su.query("UPDATE public.table_sessions SET status='closed', closed_at=now() WHERE status='open'").catch(() => {});
    const corr = await K.H.seedCloseable({ su: w.su }, w.A); const cr = await K.H.closeV3(w.svc, w.A, corr); out.push({ label: 'close service', ok: cr && cr.ok, code: cr && cr.code });
    await ins('first-open unpaid', base, [id(), 10, null]);
    await ins('second after first-open (paid)', base, [id(), 10, it({})]);
    // more than one workspace: the singleton tripwire (typed MESA_WORKSPACE_AMBIGUOUS) keeps its precedence
    await w.su.query('ALTER TABLE public.workspaces DISABLE TRIGGER workspace_activation_integrity_trg');   // the live activation trigger needs a lifecycle_status column the fixture lacks; irrelevant to the tripwire
    await w.su.query("INSERT INTO public.workspaces (name) VALUES ('c8-second-workspace')");
    await ins('AMBIGUOUS singleton: unpaid intake', base, [id(), 10, null]);
    await ins('AMBIGUOUS singleton: paid intake', base, [id(), 10, it({})]);
    await ins('AMBIGUOUS workspaces: table comanda still resolves via its table session', tbl, [id(), 7, items, t, null]);
    out.push({ label: 'integrity + state', v: (await K.integrity(w.su)).violations, s: (await K.stateInvariants(w.su)).violations });
  } finally { await w.close(); }
  return out;
}
async function phaseParity() {
  section('C9 BEHAVIOURAL PARITY of the intake (INSERT INTO ordenes): PRE and POST give the SAME observable outcome for the same inputs (success shape, typed error + message, ledger counts)');
  const pre = await parityRun('c8_pre_tpl'), post = await parityRun(env.tpl.post);
  const diffs = pre.map((r, i) => JSON.stringify(r) === JSON.stringify(post[i]) ? null : { label: r.label, pre: r, post: post[i] }).filter(Boolean);
  assert(`${pre.length} intake cases (unpaid, paid x3 methods, invalid method / actor / sid_hash, role gates, forged fields, table comanda + not found / closed / intent / empty, giro capture, first-open, ambiguous singleton): identical outcomes PRE vs POST`,
    pre.length === post.length && diffs.length === 0, diffs.slice(0, 3));
  const at = (l) => post.find((r) => r.label === l) || {};
  assert('typed errors keep their precedence: MESA_SESSION_NOT_FOUND (unresolvable table session), MESA_WORKSPACE_AMBIGUOUS (workspaces <> 1, raised by the entity anchor, not masked), INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER, ORDER_PAYMENT_FORBIDDEN (role gate)',
    /MESA_SESSION_NOT_FOUND/.test(at('table not found (canonical typed error)').msg || '') && /MESA_WORKSPACE_AMBIGUOUS/.test(at('AMBIGUOUS singleton: unpaid intake').msg || '') && /MESA_WORKSPACE_AMBIGUOUS/.test(at('AMBIGUOUS singleton: paid intake').msg || '')
    && /INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER/.test(at('table + initial payment intent').msg || '') && /ORDER_PAYMENT_FORBIDDEN/.test(at('paid actor rider (role gate)').msg || ''), post.map((r) => r.label + '=' + (r.msg || 'ok')));
  assert('the M132 giro capture still fires (last): the pending intent is consumed (column NULL at rest) and exactly one giro_intents row is written', at('giro capture effects').pending_left === 0 && at('giro capture effects').intents === 1, at('giro capture effects'));
  assert('a refused intake leaves nothing behind (ledger counts identical before/after every refused case) and integrity + state invariants are green', (at('integrity + state').v || []).length === 0 && (at('integrity + state').s || []).length === 0, at('integrity + state'));
  return true;
}

// ── P11 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// close_service_session_v3 x order intake are serialised by the lifecycle lock L, in BOTH directions, with a deterministic hold (a transaction left open) and proof from pg_locks.
async function waitAdvisory(su, pidWaiter, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query(`SELECT 1 FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' AND NOT granted`, [pidWaiter]);
    if (r.rows.length) return true;
    await K.delay(10);
  }
  return false;
}
async function phaseSerial() {
  section('C11 CLOSE x INTAKE SERIALISATION ON L (deterministic: one party keeps its transaction open, the other queues on the advisory lifecycle lock; proof from pg_locks)');
  // (a) the close holds L (its transaction is left open) -> the intake queues on L -> after the COMMIT the intake finds the service CLOSED and opens the NEXT service (first-open)
  {
    const w = await K.world(env, env.tpl.post, 'sera', { deadlockMs: 300 });
    try {
      const cn = await K.conns(w); const corr = await K.H.seedCloseable({ su: w.su }, w.A);
      await cn.T1.query('BEGIN'); const cr = await K.H.closeV3(cn.T1, w.A, corr);
      const p = K.start({ call: (c) => K.insertOrder(c, { id: K.nextId('#SR'), totale: 10 }), tx: true }, cn.T2);
      const queued = await waitAdvisory(w.su, cn.pid.t2);
      const blockers = (await w.su.query('SELECT pg_blocking_pids($1) AS b', [cn.pid.t2])).rows[0].b;
      await cn.T1.query('COMMIT');
      const r = await Promise.race([p, K.delay(8000).then(() => ({ timeout: true }))]);
      const o = (await w.su.query(`SELECT s.status AS svc_status, (o.service_session_id = $1) AS on_closed_service, o.service_order_number AS n FROM public.ordenes o JOIN public.service_sessions s ON s.id = o.service_session_id ORDER BY o.created_at DESC LIMIT 1`, [w.A])).rows[0];
      const inv = (await K.integrity(w.su)).violations.concat((await K.stateInvariants(w.su)).violations);
      assert('(a) close first: the close returned V3_CLOSED while its transaction was open, and the intake QUEUED on the advisory lifecycle lock held by the closer (pg_locks: advisory, not granted; pg_blocking_pids = the closer)',
        cr && cr.ok === true && queued === true && blockers.includes(cn.pid.t1), { close: cr && cr.code, queued, blockers, closer: cn.pid.t1 });
      assert('(a) ...after the close commits the intake completes on a NEW open service (first-open), never on the service that was just closed; one active service; invariants green',
        r && r.ok === true && o && o.svc_status === 'open' && o.on_closed_service === false && Number(o.n) === 1 && inv.length === 0 && (await w.su.query(`SELECT count(*)::int AS n FROM public.service_sessions WHERE status IN ('open','closing')`)).rows[0].n === 1, { r, o, inv });
    } finally { await w.close(); }
  }
  // (b) the intake holds L (its transaction is left open, order created) -> the close queues on L -> after the COMMIT the close SEES the live order and refuses; the service stays open
  {
    const w = await K.world(env, env.tpl.post, 'serb', { deadlockMs: 300 });
    try {
      const cn = await K.conns(w); const corr = await K.H.seedCloseable({ su: w.su }, w.A);
      await cn.T1.query('BEGIN'); const ins = await K.insertOrder(cn.T1, { id: K.nextId('#SR'), totale: 10 });
      const p = K.H.closeV3(cn.T2, w.A, corr).then((x) => x, (e) => ({ err: e.code, msg: String(e.message).slice(0, 80) }));
      const queued = await waitAdvisory(w.su, cn.pid.t2);
      const blockers = (await w.su.query('SELECT pg_blocking_pids($1) AS b', [cn.pid.t2])).rows[0].b;
      await cn.T1.query('COMMIT');
      const r = await Promise.race([p, K.delay(8000).then(() => ({ timeout: true }))]);
      const svc = (await w.su.query('SELECT status FROM public.service_sessions WHERE id = $1', [w.A])).rows[0].status;
      const inv = (await K.integrity(w.su)).violations.concat((await K.stateInvariants(w.su)).violations);
      console.log('  INFO  (b) outcome of the queued close after the intake committed: ' + JSON.stringify(r && (r.code || r.err || r.msg)) + ' (service ' + svc + ')');
      assert('(b) intake first: the close QUEUED on the advisory lifecycle lock held by the intake transaction (pg_locks: advisory, not granted; pg_blocking_pids = the intake)', ins && queued === true && blockers.includes(cn.pid.t1), { queued, blockers, intake: cn.pid.t1 });
      assert('(b) ...after the intake commits the close sees the LIVE order and does not close over it (typed refusal, the service stays open, no live order on a closed service, invariants green)',
        r && !r.timeout && !(r.ok === true) && svc === 'open' && inv.length === 0, { r: r && (r.code || r.err || r.msg), svc, inv });
    } finally { await w.close(); }
  }
  return true;
}

// ── P10 ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// FUNCTIONAL REGRESSION (differential). The existing writers 143 / 144 must NOT change: the same scenario battery runs on PRE (no 143/144) and on POST (143 + 144 as files)
// and the NORMALISED observable outcome of every step (result JSON, typed error + SQLSTATE + message, ledger counts) must be identical. Areas: order_cancel_v1 (the ONE
// rewritten writer: authorization, ownership, table, state machine, idempotency, JSON), Mesa payment / refund, Cash V1 payment / refund / commercial adjustment, the
// rider canonical payment (M140) and the operator confirmation (M139), close -> first-open -> open_operational_service_v1 and the order numbering.
const nrm = (x) => JSON.stringify(x === undefined ? null : x)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/[0-9a-f]{64}/g, '<h64>').replace(/#[A-Z]+[0-9]{5}/g, '#ID')
  .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)/g, '<ts>').replace(/\b(cx|cash|rf|mp|mr|adj|rr)_[0-9a-f]{32}\b/g, '<req>').replace(/\bT\d+\b/g, 'T<n>').replace(/pay-order-[A-Za-z0-9_-]+/g, 'pay-order-<id>');
async function regressRun(tpl) {
  const out = []; const say = (label, o) => out.push({ label, o: nrm(o) });
  const w = await K.world(env, tpl, 'reg', { deadlockMs: 300 });
  const attempt = async (label, fn) => { try { say(label, { ok: await fn() }); } catch (e) { say(label, { err: e.code, msg: String(e.message).slice(0, 120) }); } };
  const ledger = async (label) => say(label + ' [ledger]', await K.counts(w.su));
  const state = async (label, id) => say(label + ' [order]', (await w.su.query('SELECT estado, cancelado_at IS NOT NULL AS canc, cobrado FROM public.ordenes WHERE id = $1', [id])).rows[0]);
  const cancel = (id, actor = 'operator_backup', o = {}) => w.svc.query('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r',
    [id, actor, o.reason === undefined ? 'reg cancel' : o.reason, o.req || K.rid('cx'), o.hash || K.hex64(K.rid('h')), o.target || 'CANCELADO', '{}']).then((r) => r.rows[0].r);
  try {
    // 1. order_cancel_v1 -----------------------------------------------------------------------------------------------------------------------------------------
    const u1 = await K.mkUnpaid(w, 10); const req1 = K.rid('cx'); const hash1 = K.hex64('h1');
    await attempt('cancel unpaid', () => cancel(u1.id, 'operator_backup', { req: req1, hash: hash1 })); await state('cancel unpaid', u1.id); await ledger('cancel unpaid');
    await attempt('cancel replay (same request id)', () => cancel(u1.id, 'operator_backup', { req: req1, hash: hash1 }));
    await attempt('cancel again (other request id): idempotent', () => cancel(u1.id, 'operator_primary'));
    const p1 = await K.mkPaid(w, 12);
    await attempt('cancel a PAID order', () => cancel(p1.id, 'owner')); await state('cancel paid', p1.id); await ledger('cancel paid');
    const u2 = await K.mkUnpaid(w, 9);
    await attempt('cancel target ANULADO', () => cancel(u2.id, 'operator_backup', { target: 'ANULADO' })); await state('cancel ANULADO', u2.id);
    const u3 = await K.mkUnpaid(w, 9); await w.su.query("UPDATE public.ordenes SET estado = 'RETIRADO' WHERE id = $1", [u3.id]);
    await attempt('cancel a RETIRADO order -> state invalid', () => cancel(u3.id));
    const u4 = await K.mkUnpaid(w, 9);
    await attempt('cancel: bad client_request_id', () => cancel(u4.id, 'operator_backup', { req: 'x' }));
    await attempt('cancel: reason missing', () => cancel(u4.id, 'operator_backup', { reason: '  ' }));
    await attempt('cancel: bad target', () => cancel(u4.id, 'operator_backup', { target: 'BOH' }));
    await attempt('cancel: order not found', () => cancel('#NOPE99999'));
    await attempt('cancel: unknown actor -> forbidden', () => cancel(u4.id, 'nobody_here'));
    await attempt('cancel: rider actor -> forbidden (role gate)', () => cancel(u4.id, 'rider'));
    await w.su.query("UPDATE public.auth_actors SET active = false WHERE actor = 'operator_backup'").catch(() => {});
    await attempt('cancel: inactive actor -> forbidden', () => cancel(u4.id, 'operator_backup'));
    await w.su.query("UPDATE public.auth_actors SET active = true WHERE actor = 'operator_backup'").catch(() => {});
    await state('cancel refused paths leave the order untouched', u4.id); await ledger('cancel refused paths');
    const tc = await K.mkTable(w, 2); const c1 = await K.mkTableOrder(w, tc, 10);
    await attempt('cancel a Mesa comanda (table path, other actor)', () => cancel(c1.id, 'operator_primary')); await state('cancel comanda', c1.id); await ledger('cancel comanda');
    // 2. Mesa payment / refund ----------------------------------------------------------------------------------------------------------------------------------
    const tm = await K.mkTable(w, 2); await K.mkTableOrder(w, tm, 10); await K.mkTableOrder(w, tm, 8);
    const mpReq = K.rid('mp'), mpHash = K.hex64('mph');
    const mp = () => w.svc.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), tm, 'efectivo', 'full', mpReq, mpHash, null, null, null, '{}', false]).then((r) => r.rows[0].r);
    await attempt('mesa_post_payment_v1 full', mp); await ledger('mesa payment');
    await attempt('mesa_post_payment_v1 replay (idempotent)', mp); await ledger('mesa payment replay');
    const mtx = (await w.su.query(`SELECT id FROM public.payment_transactions WHERE table_session_id = $1 AND kind = 'payment' ORDER BY created_at DESC LIMIT 1`, [tm])).rows[0];
    await attempt('mesa_post_refund_v1 partial', () => w.svc.query('SELECT public.mesa_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', K.hex64('so'), tm, mtx && mtx.id, 'reg mesa refund', K.rid('mr'), K.hex64(K.rid('mrh')), 3, '{}']).then((r) => r.rows[0].r)); await ledger('mesa refund');
    // 3. Cash V1 payment / refund / commercial adjustment ---------------------------------------------------------------------------------------------------------
    const o1 = await K.mkUnpaid(w, 10); const cReq = K.rid('cash'), cHash = K.hex64('ch');
    await attempt('order_post_payment_v1 full', () => K.cashPay(w.svc, w, o1, { reqId: cReq, hash: cHash })); await ledger('cash payment');
    await attempt('order_post_payment_v1 replay (idempotent)', () => K.cashPay(w.svc, w, o1, { reqId: cReq, hash: cHash })); await ledger('cash replay');
    await attempt('order_post_payment_v1 on a settled order (typed refusal)', () => K.cashPay(w.svc, w, o1, {}));
    const o2 = await K.mkUnpaid(w, 10);
    await attempt('order_post_payment_v1 custom_amount', () => K.cashPay(w.svc, w, o2, { mode: 'custom_amount', amount: 4, method: 'tarjeta' })); await ledger('cash custom amount');
    const pr = await K.mkPaid(w, 12);
    await attempt('order_post_refund_v1 partial', () => w.svc.query('SELECT public.order_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', K.hex64('so'), pr.order_uid, pr.tx, 'reg refund', K.rid('rf'), K.hex64(K.rid('rh')), 3, '{}']).then((r) => r.rows[0].r)); await ledger('order refund');
    const o3 = await K.mkUnpaid(w, 10);
    await attempt('order_apply_commercial_adjustment_v1', () => w.svc.query('SELECT public.order_apply_commercial_adjustment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, 'owner', K.hex64('so'), o3.order_uid, 8, 'reg adjust', K.rid('adj'), K.hex64(K.rid('ah')), 10, '{}']).then((r) => r.rows[0].r)); await ledger('adjustment');
    // 4. operator confirmation (M139) and rider canonical payment (M140) ------------------------------------------------------------------------------------------
    await K.closeTripQuiet(w); const d1 = await K.dispatchedOrder(w);
    await attempt('operator_confirm_delivery_v1 + payment', () => K.H.opConfirm(w.svc, d1.id, K.H.PAY({ method: 'efectivo' }), 'operator_backup')); await state('operator confirm', d1.id); await ledger('operator confirm');
    await K.closeTripQuiet(w); const d2 = await K.dispatchedOrder(w);
    await attempt('rider_collect_and_complete_stop (canonical payment, rider identity)', () => K.H.riderStop(w.svc, d2.id, 'efectivo', `pay-order-${String(d2.id).replace(/[^A-Za-z0-9_-]/g, '')}`)); await state('rider stop', d2.id); await ledger('rider stop');
    say('payment lineage by role (rider / operator)', (await w.su.query(`SELECT by_role, count(*)::int AS n FROM public.payment_transactions WHERE by_role IN ('rider') GROUP BY by_role ORDER BY 1`)).rows);
    await K.closeTripQuiet(w);
    // 5. numbering (service A) --------------------------------------------------------------------------------------------------------------------------------------
    const num = [];
    for (const k of ['plain', 'paid', 'plain', 'comanda', 'comanda', 'paid']) {
      try {
        const row = k === 'comanda' ? (await w.svc.query(`INSERT INTO public.ordenes (id, estado, totale, items, table_session_id) VALUES ($1,'EN_COCINA',7,$2::jsonb,$3) RETURNING service_order_number AS n, table_command_number AS c`, [K.nextId('#RN'), JSON.stringify([{ n: 'P', q: 1, p: 7 }]), tm])).rows[0]
          : await K.insertOrder(w.svc, { id: K.nextId('#RN'), totale: 9, intentJson: k === 'paid' ? K.intent('operator_primary') : null }).then((r) => ({ n: r.service_order_number, c: null }));
        num.push(`${k}:${row.n}${row.c != null ? '/' + row.c : ''}`);
      } catch (e) { num.push(`${k}:ERR ${e.code} ${String(e.message).slice(0, 60)}`); }
    }
    say('order numbering sequence (service_order_number / table_command_number)', num);
    say('invariants after the battery (service A)', { econ: (await K.integrity(w.su)).violations, state: (await K.stateInvariants(w.su)).violations });
  } finally { await w.close(); }
  // 6. lifecycle: close -> first-open intake -> open_operational_service_v1 -> close -> open -> numbering restarts (fresh world, service closed) ---------------------------------
  const l = await K.world(env, tpl, 'regl', { deadlockMs: 300, noService: true });
  try {
    const q = async (label, fn) => { try { say(label, { ok: await fn() }); } catch (e) { say(label, { err: e.code, msg: String(e.message).slice(0, 120) }); } };
    const active = async () => (await l.su.query(`SELECT count(*)::int AS n, min(business_date)::text AS bd FROM public.service_sessions WHERE status IN ('open','closing')`)).rows[0];
    say('lifecycle: no active service after the close', await active());
    await q('first-open intake (unpaid)', () => K.insertOrder(l.svc, { id: K.nextId('#LC'), totale: 10 }).then((r) => ({ n: r.service_order_number })));
    say('lifecycle: exactly one active service after the first-open intake', await active());
    await q('open_operational_service_v1 while a service is open', () => l.svc.query('SELECT public.open_operational_service_v1($1,$2,$3) AS r', ['operator_primary', 'next_service_of_business_day', 'reg_resume']).then((r) => r.rows[0].r));
    await q('second intake (paid) on the auto-opened service', () => K.insertOrder(l.svc, { id: K.nextId('#LC'), totale: 11, intentJson: K.intent('operator_primary') }).then((r) => ({ n: r.service_order_number })));
    const s2 = (await l.su.query(`SELECT id FROM public.service_sessions WHERE status = 'open'`)).rows[0];
    await l.su.query(`UPDATE public.ordenes SET estado = 'RETIRADO' WHERE service_session_id = $1`, [s2.id]);
    const corr = await K.H.seedCloseable({ su: l.su }, s2.id);
    await q('close_service_session_v3', () => K.H.closeV3(l.svc, s2.id, corr));
    say('lifecycle: no active service after the second close', await active());
    await q('open_operational_service_v1 (resume)', () => l.svc.query('SELECT public.open_operational_service_v1($1,$2,$3) AS r', ['operator_primary', 'next_service_of_business_day', 'reg_resume2']).then((r) => r.rows[0].r));
    await q('intake after the resume (number restarts on the new service)', () => K.insertOrder(l.svc, { id: K.nextId('#LC'), totale: 10 }).then((r) => ({ n: r.service_order_number })));
    say('lifecycle: one active service, invariants', { active: await active(), econ: (await K.integrity(l.su)).violations, state: (await K.stateInvariants(l.su)).violations });
  } finally { await l.close(); }
  // 7. KNOWN_SEPARATE_FINDING_A (Cash payment x close_service_session_v3 on the same service): RECORDED, never fixed here. The closer holds the close locks and has flipped the
  // service row (uncommitted); the payment queues behind it and, once the close commits, is attributed to the service that has just been closed. Same on PRE and POST.
  const fa = await K.world(env, tpl, 'rega', { deadlockMs: 300 });
  try {
    const O = await K.mkUnpaid(fa, 10);
    await fa.su.query("UPDATE public.ordenes SET estado = 'RETIRADO' WHERE id = $1", [O.id]);
    const corr = await K.H.seedCloseable({ su: fa.su }, fa.A); const cn = await K.conns(fa);
    await cn.T1.query('BEGIN'); const closeRes = await K.H.closeV3(cn.T1, fa.A, corr);
    const pay = K.cashPay(cn.T2, fa, O).then((r) => ({ ok: !(r && r.ok === false), code: r && r.code }), (e) => ({ err: e.code, msg: String(e.message).slice(0, 80) }));
    const s = await K.settleOrBlock(pay, fa.su, 'c8-t2', 500);
    await cn.T1.query('COMMIT'); const res = await pay;
    const rec = (await fa.su.query(`SELECT s.status AS receipt_service_status, (t.service_session_id = o.service_session_id) AS receipt_is_order_service FROM public.payment_transactions t
                                     JOIN public.payment_allocations a ON a.payment_transaction_id = t.id JOIN public.ordenes o ON o.order_uid = a.order_uid LEFT JOIN public.service_sessions s ON s.id = t.service_session_id WHERE o.id = $1`, [O.id])).rows;
    say('KNOWN_SEPARATE_FINDING_A payment x close', { close: closeRes && closeRes.code, payment_waited_for_the_close: !s.done, payment: res, receipts: rec, integrity: (await K.integrity(fa.su)).violations, state: (await K.stateInvariants(fa.su)).violations });
  } finally { await fa.close(); }
  return out;
}
async function phaseRegress() {
  section('C10 FUNCTIONAL REGRESSION (differential PRE vs POST): order_cancel_v1 matrix, Mesa payment / refund, Cash V1 payment / refund / adjustment, operator confirm (M139), rider canonical payment (M140), close / first-open / resume, numbering');
  const pre = await regressRun('c8_pre_tpl'), post = await regressRun(env.tpl.post);
  if (process.env.C8_REGRESS_DUMP) fs.writeFileSync(process.env.C8_REGRESS_DUMP, JSON.stringify({ pre, post }, null, 1));
  const diffs = pre.map((r, i) => (post[i] && r.label === post[i].label && r.o === post[i].o) ? null : { label: r.label, pre: r.o.slice(0, 260), post: post[i] && post[i].o.slice(0, 260) }).filter(Boolean);
  assert(`${pre.length} observable steps (result JSON / typed error / ledger counts / order state / numbering / lifecycle): identical on PRE and POST`, pre.length === post.length && diffs.length === 0, diffs.slice(0, 4));
  const at = (l) => (post.find((r) => r.label === l) || { o: '' }).o;
  assert('the battery is not vacuous: cancel succeeds and replays idempotently, the typed refusals keep their SQLSTATE (STATE_INVALID / INVALID / REASON_REQUIRED / NOT_FOUND / FORBIDDEN), the table path cancels a comanda',
    /"ok":\{"ok":true[^{}]*"idempotent":false/.test(at('cancel unpaid')) && /"ok":\{"ok":true[^{}]*"idempotent":true/.test(at('cancel replay (same request id)')) && /"ok":\{"ok":true[^{}]*"idempotent":true/.test(at('cancel again (other request id): idempotent'))
    && /ORDER_CANCEL_STATE_INVALID/.test(at('cancel a RETIRADO order -> state invalid')) && /ORDER_CANCEL_INVALID/.test(at('cancel: bad client_request_id')) && /ORDER_CANCEL_REASON_REQUIRED/.test(at('cancel: reason missing'))
    && /ORDER_CANCEL_NOT_FOUND/.test(at('cancel: order not found')) && /ORDER_CANCEL_FORBIDDEN/.test(at('cancel: unknown actor -> forbidden')) && /ORDER_CANCEL_FORBIDDEN/.test(at('cancel: rider actor -> forbidden (role gate)'))
    && /ORDER_CANCEL_FORBIDDEN/.test(at('cancel: inactive actor -> forbidden')) && /"ok":\{"ok":true[^{}]*"idempotent":false/.test(at('cancel a Mesa comanda (table path, other actor)')), post.slice(0, 20).map((r) => r.label + '=' + r.o.slice(0, 80)));
  assert('the payment / refund / delivery writers really ran (each produced a result, not an error) and the rider payment lineage is recorded AS THE RIDER',
    ['mesa_post_payment_v1 full', 'mesa_post_refund_v1 partial', 'order_post_payment_v1 full', 'order_post_refund_v1 partial', 'order_apply_commercial_adjustment_v1', 'operator_confirm_delivery_v1 + payment', 'rider_collect_and_complete_stop (canonical payment, rider identity)']
      .every((l) => /^\{"ok":/.test(at(l))) && /"by_role":"rider"/.test(at('payment lineage by role (rider / operator)')), ['mesa_post_payment_v1 full', 'mesa_post_refund_v1 partial', 'order_post_payment_v1 full', 'order_post_refund_v1 partial', 'order_apply_commercial_adjustment_v1', 'operator_confirm_delivery_v1 + payment', 'rider_collect_and_complete_stop (canonical payment, rider identity)'].map((l) => l + '=' + at(l).slice(0, 90)));
  assert('lifecycle after the fix: exactly one active service after the first-open intake and after the resume, none after each close; state invariants green everywhere; the ONLY economic finding of the battery is the deliberate one (a PAID order was cancelled: its money sits on a zero obligation = overcollected=1, refund pending, identical on PRE) and the lifecycle world is fully green',
    /"n":1/.test(at('lifecycle: exactly one active service after the first-open intake')) && /"n":0/.test(at('lifecycle: no active service after the second close')) && /"active":\{"n":1/.test(at('lifecycle: one active service, invariants'))
    && /"econ":\[\],"state":\[\]/.test(at('lifecycle: one active service, invariants')) && /"econ":\["overcollected=1"\],"state":\[\]/.test(at('invariants after the battery (service A)')), [at('lifecycle: one active service, invariants'), at('invariants after the battery (service A)')]);
  const fA = post.find((r) => r.label === 'KNOWN_SEPARATE_FINDING_A payment x close');
  console.log('  INFO  KNOWN_SEPARATE_FINDING_A (payment x close -> receipt on the just-closed service; NOT fixed here, identical on PRE and POST): ' + (fA ? fA.o.slice(0, 420) : 'n/a'));
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PHASES = { provenance: phaseProvenance, apply: phaseApply, drift: phaseDrift, rollback: phaseRollback, prefix: phasePrefix, hyp: phaseHyp, pairs: phasePairs, natural: phaseNatural, numbering: phaseNumbering, parity: phaseParity, regress: phaseRegress, serial: phaseSerial };
async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'c8-admin' });
    await rt.ensureRoles(admin);
    env = { cl, admin, tpl: {}, clone: async (tpl, label) => { const name = `c8_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`.slice(0, 60); await rt.cloneDb(admin, tpl, name); return name; } };
    env.tpl = { post: 'c8_post_tpl', only143: 'c8_only143_tpl', only144: 'c8_only144_tpl' };
    const names = only.length ? only : Object.keys(PHASES);
    let ok = true;
    if (!names.includes('provenance')) names.unshift('provenance');           // every phase needs the templates
    for (const n of names) {
      if (!PHASES[n]) { assert(`unknown phase ${n}`, false); continue; }
      try { ok = (await PHASES[n]()) !== false && ok; } catch (e) { section(`phase ${n} crashed`); assert(`phase ${n} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`); }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  if (process.env.C8_EVIDENCE_OUT) fs.writeFileSync(process.env.C8_EVIDENCE_OUT, JSON.stringify(state.results, null, 1));
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
