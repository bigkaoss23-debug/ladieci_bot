'use strict';
// FINDING B (refund off-service + refund x service close) -- migration 146 certification runner. Ephemeral PostgreSQL only; never staging, never production.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres and pg> [W3_PG_DATA_ROOT=<tmp>] \
//     node ci/giro-authority-certification/harness/runFindingBRefundFix.js [phase ...]
//
// Phases (default: all): provenance isolation apply drift rollback scenarios sweeps regress stress
//   FB_QUICK=1  fewer rounds / pairs (smoke);  FB_FWD146 / FB_RBK146 (absolute or repo-relative) run the SAME certification against a mutated migration (mutation check).
//
// Databases (all staging-shaped: real ledger through 138, REAL 139 + 140, the audit's real bodies -- the two refund writers are the LIVE staging bodies, md5
// f057928b... / 62f0e128... --, the 27 staging triggers; see c8LockOrderKit.js):
//   PRE  = that database                                     (no 143 / 144 / 145 / 146)
//   C8   = PRE + migration FILES 143 + 144                   (the C8 candidate WITHOUT 145: 146 must refuse it -- Economy lineage)
//   BASE = C8 + migration FILE 145                           (the frozen Economy candidate before Finding B: the NEGATIVE CONTROL, must show the defects)
//   POST = BASE + migration FILE 146                         (must not)
// The primary proof of the serialization contract does NOT rely on created_at: controlled transactions, row-lock probes from a third connection
// (SELECT ... FOR <mode> NOWAIT on the lifecycle pointer), pg_blocking_pids, pg_locks (which relation a blocked backend is queued on), the observed pointer and the
// receipt observed after the release. The created_at audit is a supplementary signal only.
// ISOLATION: the candidate's semantics REQUIRE READ COMMITTED (the refund rereads the pointer with a new statement snapshot after the close commits). The bench runs
// READ COMMITTED like staging; the isolation phase records it and shows that REPEATABLE READ fails CLOSED (40001, nothing written), never with a wrong receipt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const rt = require('./pgRuntime');
const { section, assert, state } = require('./lib');
const DED = require('./runDeliveryEconomyDecoupling');
const K = require('./c8LockOrderKit');
const H = K.H; const delay = K.delay;

const M = (n) => `migrations/${n}`;
const F143 = M('2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql');
const F144 = M('2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql');
const F145 = M('2026-09-24_payment_close_receipt_lock_v1_migration_145.sql');
const R145 = M('2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql');
const R143 = M('2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql');
const F146 = process.env.FB_FWD146 || M('2026-09-25_refund_close_receipt_lock_v1_migration_146.sql');
const R146 = process.env.FB_RBK146 || M('2026-09-25_refund_close_receipt_lock_v1_migration_146.ROLLBACK.sql');
const readAny = (rel) => (path.isAbsolute(rel) ? fs.readFileSync(rel, 'utf8') : rt.readRepo(rel));
const SCRATCH = process.env.FB_SCRATCH || os.tmpdir();
const QUICK = process.env.FB_QUICK === '1';
const R = (n) => Math.max(QUICK ? 3 : 4, Math.round(n * (QUICK ? 0.25 : 1)));
const ENSURE_FIXTURE = path.join(__dirname, '..', 'fixture', 'ensure_service_session_lockonly_v1.sql');

const PIN = { order: 'f057928b8f6fade25d38d4bb1d3ed09a', mesa: '62f0e128a6e5d0623b0423a69f0329d3' };        // LIVE staging refund bodies (predecessors)
const PAY145 = { order: '799f8093328b4ac81e1ad5a3d37e1bb6', mesa: '94867e165d0732f36ae4692fc6998c58' };     // the 145 payment bodies (frozen)
const PAY_PRE145 = { order: 'ea4fe577feddbd2ba6f6ae42695feba6', mesa: '9543ab52d9933ffd52cc7f9b595c4cfb' };
const SIG = {
  order: 'public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)',
  mesa: 'public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)',
  opay: 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)',
  mpay: 'public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)',
  prelude: 'public.order_intake_lock_prelude_v1()',
  cancel: 'public.order_cancel_v1(text,text,text,text,text,text,jsonb)',
};
const SVC_ONLY = '{postgres=X/postgres,service_role=X/postgres}';
const RECEIPT_SELECT = "  SELECT ss.id INTO v_receipt_service_id\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";
const LOCK_BLOCK = "  -- 146:BEGIN refund_receipt_pointer_lock\n  PERFORM 1\n  FROM public.service_session_state\n  WHERE singleton = true\n  FOR SHARE;\n  -- 146:END refund_receipt_pointer_lock\n";
const REJECT_BLOCK = "  -- 146:BEGIN order_refund_requires_open_service\n  IF v_receipt_service_id IS NULL THEN\n    RAISE EXCEPTION 'ORDER_REFUND_NO_OPEN_SERVICE'\n      USING ERRCODE = '55000';\n  END IF;\n  -- 146:END order_refund_requires_open_service\n";
// the two 146 body pins are read from the rollback guard: a mutated pair carries its own recomputed pins
const NEW_PINS = (() => { const t = readAny(R146); const g = (n) => new RegExp("\\('public\\." + n + "\\([^']*\\)', '" + n + "', '([0-9a-f]{32})'\\)").exec(t)[1]; return { order: g('order_post_refund_v1'), mesa: g('mesa_post_refund_v1') }; })();
const OWN_MIGRATION = new Map([[F146, 146]]);

// LATEST DEFINER (provenance only). The body a template is expected to carry for a writer is the one installed by the LAST
// migration applied to that template that (re)defines it -- scripts/economy139to146Preflight.js's FN table is the canonical record of
// the body each Economy migration installs (its `files` command binds every pin to the committed file). On this runner's own chain
// that is exactly this runner's migration (its pins read from its own files above, so a mutated file still carries its own pins); with
// later Economy migrations layered on top of POST (e.g. 146 + 147 + 148 through the one-line POST retarget that
// runPaymentCloseFixOnCandidate146.js performs) it is the later body -- mesa_post_refund_v1 is then the 147 body and
// order_post_payment_v1 the 148 body. Only provenance
// expectations read this; no behavioural assertion does.
const { FN: ECONOMY_FN } = require('../../../scripts/economy139to146Preflight');
const appliedOnTop = {};            // template db -> Economy migration numbers applied on top of the staging shape, in apply order
const migrationNumber = (file) => { const own = OWN_MIGRATION.get(file); if (own) return own; const m = /_migration_(\d+)\.sql$/.exec(String(file)); return m ? Number(m[1]) : null; };
function expectedBody(sig, tpl, ownPins = {}) {
  const states = (ECONOMY_FN.find((f) => f.sig === sig) || { states: {} }).states;
  const definers = (appliedOnTop[tpl] || []).filter((n) => Object.prototype.hasOwnProperty.call(states, n));
  const latest = definers[definers.length - 1];
  if (latest === undefined) return states[0];
  return Object.prototype.hasOwnProperty.call(ownPins, latest) ? ownPins[latest] : states[latest];
}

let env; let dbSeq = 0;
const md5Of = async (su, sig) => (await su.query('SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = to_regprocedure($1)', [sig])).rows[0]?.m || null;
const srcOf = async (su, sig) => (await su.query('SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure($1)', [sig])).rows[0]?.prosrc || '';
const posture = async (su, sig) => (await su.query(`SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS cfg, p.proacl::text AS acl, p.proretset, p.prorettype::regtype::text AS ret, pg_get_function_arguments(p.oid) AS args,
    pg_get_function_identity_arguments(p.oid) AS ident, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig])).rows[0];
async function cloneSu(tpl, label) {
  const db = await env.clone(tpl, label);
  const su = await rt.connect(env.cl, db, { name: `fb-${label}` });
  su.db = db;
  return su;
}
async function applyTo(su, rel) { try { await DED.applyRepoAsPostgres(su, rel); return null; } catch (e) { return e; } }
async function buildDerived(name, files, from) {
  const su = await cloneSu(from, name + '_b'); const db = su.db;
  for (const f of files) { const e = typeof f === 'function' ? await f(su).then(() => null, (x) => x) : await applyTo(su, f); if (e) { await su.end(); throw new Error(`template ${name}: ${typeof f === 'function' ? 'step' : f} -> ${e.message}`); } }
  await su.end();
  appliedOnTop[db] = (appliedOnTop[from] || []).concat(files.filter((f) => typeof f !== 'function').map(migrationNumber));
  return db;
}
const fpOf = async (tpl) => { const s = await cloneSu(tpl, 'fp'); try { return await DED.catalogFingerprint(s); } finally { await s.end(); } };
const fnDrift = async (su, sig) => { const cur = (await su.query('SELECT pg_get_functiondef($1::regprocedure) AS d', [sig])).rows[0].d; await su.query(cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER\n')); };
const asPostgres = async (su, fn) => { await su.query('SET ROLE postgres'); try { await fn(); } finally { await su.query('RESET ROLE'); } };
// the two CREATE statements of a migration file (used to FORCE the 146 bodies onto a database, bypassing the file's own guards, for the negative control)
function createStatements(sql) {
  const out = []; const re = /CREATE OR REPLACE FUNCTION public\.(order|mesa)_post_refund_v1\(/g; let m;
  while ((m = re.exec(sql))) { const s = m.index; const o = sql.indexOf('AS $function$', s) + 'AS $function$'.length; const e = sql.indexOf('$function$;', o) + '$function$;'.length; out.push(sql.slice(s, e)); }
  return out;
}

// ── P0 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseProvenance() {
  section('F0 PROVENANCE -- PRE = the staging-shaped real-body chain; C8 = PRE + 143 + 144; BASE = C8 + 145 (Economy candidate before Finding B); POST = BASE + 146 (the FILE under test)');
  const rep = await K.buildPreTemplate(env, 'fb_pre_tpl');
  assert('26 real function bodies were installed from the repo text whose md5 equals staging (a mismatch aborts the build)', rep.bodies === 26, rep);
  { const su = await rt.connect(env.cl, 'fb_pre_tpl', { name: 'fb-fixture' });
    try { await asPostgres(su, () => su.query(fs.readFileSync(ENSURE_FIXTURE, 'utf8'))); } finally { await su.end(); } }
  const su = await cloneSu('fb_pre_tpl', 'prov');
  assert('PRE refund writers are the LIVE staging bodies (order ' + PIN.order + ', mesa ' + PIN.mesa + '), with the historical mojibake of their comments', (await md5Of(su, SIG.order)) === PIN.order && (await md5Of(su, SIG.mesa)) === PIN.mesa && /¬ß/.test(await srcOf(su, SIG.order)) && /¬ß/.test(await srcOf(su, SIG.mesa)));
  const carriers = [];
  for (const [n, sig] of [['order_post_refund_v1', SIG.order], ['mesa_post_refund_v1', SIG.mesa]]) carriers.push([n, (await srcOf(su, sig)).includes(RECEIPT_SELECT), /service_session_state\s+WHERE singleton = true\s+FOR SHARE/.test(await srcOf(su, sig))]);
  assert('PRE: the receipt-service SELECT is UNLOCKED in both refund writers (the defect)', carriers.every(([, has, locked]) => has && !locked), carriers);
  await su.end();
  env.tpl.pre = 'fb_pre_tpl';
  appliedOnTop.fb_pre_tpl = [139, 140];
  env.tpl.c8 = await buildDerived('c8', [F143, F144], 'fb_pre_tpl');
  env.tpl.base = await buildDerived('base', [F145], env.tpl.c8);
  env.tpl.post = await buildDerived('post', [F146], env.tpl.base);
  env.tpl.pre144 = await buildDerived('pre144', [F144], 'fb_pre_tpl');
  const pb = await cloneSu(env.tpl.base, 'provb'), pp = await cloneSu(env.tpl.post, 'provp');
  assert('BASE carries 143 (prelude) + 144 + 145 (payment bodies ' + PAY145.order + ' / ' + PAY145.mesa + ') and the refund writers are still the live predecessors',
    !!(await md5Of(pb, SIG.prelude)) && (await md5Of(pb, SIG.opay)) === PAY145.order && (await md5Of(pb, SIG.mpay)) === PAY145.mesa && (await md5Of(pb, SIG.order)) === PIN.order && (await md5Of(pb, SIG.mesa)) === PIN.mesa);
  const post = { order: expectedBody(SIG.order, env.tpl.post, { 146: NEW_PINS.order }), mesa: expectedBody(SIG.mesa, env.tpl.post, { 146: NEW_PINS.mesa }),
    opay: expectedBody(SIG.opay, env.tpl.post, { 145: PAY145.order }), mpay: expectedBody(SIG.mpay, env.tpl.post, { 145: PAY145.mesa }) };
  assert('POST = BASE + 146 (' + appliedOnTop[env.tpl.post].join(' + ') + '): the refund writers are the bodies of their LATEST definer in that chain (md5 ' + post.order + ' / ' + post.mesa + '); the payment bodies are their latest definer\'s (' + post.opay + ' / ' + post.mpay + ')',
    (await md5Of(pp, SIG.order)) === post.order && (await md5Of(pp, SIG.mesa)) === post.mesa && (await md5Of(pp, SIG.opay)) === post.opay && (await md5Of(pp, SIG.mpay)) === post.mpay, [await md5Of(pp, SIG.order), await md5Of(pp, SIG.mesa), await md5Of(pp, SIG.opay), await md5Of(pp, SIG.mpay)]);
  await pb.end(); await pp.end();
  return true;
}

// ── P1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseIsolation() {
  section('F1 ISOLATION -- the candidate REQUIRES READ COMMITTED: recorded on the bench (as on staging), and a non-RC transaction fails CLOSED (40001), never with a wrong receipt');
  const w = await K.world(env, env.tpl.post, 'iso', { deadlockMs: 300 });
  try {
    const r = (await w.svc.query(`SELECT current_setting('transaction_isolation') AS t, current_setting('default_transaction_isolation') AS d, current_user AS u`)).rows[0];
    const ovr = (await w.su.query(`SELECT count(*)::int AS n FROM pg_db_role_setting WHERE array_to_string(setconfig, ';') ILIKE '%isolation%'`)).rows[0].n;
    const cfg = (await w.su.query(`SELECT p.proname, p.proconfig::text AS c FROM pg_proc p WHERE p.oid IN (to_regprocedure($1), to_regprocedure($2))`, [SIG.order, SIG.mesa])).rows;
    assert('the service_role connection runs READ COMMITTED (default_transaction_isolation = read committed), no database / role override of the isolation level, and the two writers set only search_path (no isolation in proconfig)',
      r.t === 'read committed' && r.d === 'read committed' && r.u === 'service_role' && ovr === 0 && cfg.length === 2 && cfg.every((x) => x.c === '{"search_path=public, extensions, pg_temp"}'), { r, ovr, cfg });
    let e25001 = null;
    try { await w.svc.query('BEGIN'); await w.svc.query('SELECT 1'); await w.svc.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); } catch (x) { e25001 = x.code; } finally { await w.svc.query('ROLLBACK').catch(() => {}); }
    assert('an RPC cannot change its own isolation level (SET TRANSACTION after the first query = 25001)', e25001 === '25001', e25001);
    // REPEATABLE READ: the same R4 interleaving fails CLOSED (the documented, non-default behaviour)
    const cn = await K.conns(w); const P = await mkTermPaid(w, 12);
    const corr = await H.seedCloseable({ su: w.su }, w.A);
    await cn.T1.query('BEGIN'); const cr = await H.closeV3(cn.T1, w.A, corr);
    const p = okp((async () => { await cn.T2.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); try { const x = await orderRefund(cn.T2, w, P, { amount: 5 }); await cn.T2.query('COMMIT'); return x; } catch (x) { await cn.T2.query('ROLLBACK').catch(() => {}); throw x; } })());
    const wt = await waitPid(w.su, 'c8-t2'); await cn.T1.query('COMMIT'); const res = await p;
    const n = (await refundObs(w, P)).n;
    assert('RECORDED: under REPEATABLE READ the refund queued on the pointer behind an in-flight close fails CLOSED with 40001 (0 refunds written, no receipt on the closed service); the candidate is certified for READ COMMITTED only (final PG17 pre-apply gate re-checks it)',
      cr.code === 'V3_CLOSED' && !!wt && wt.rel === 'service_session_state' && res.err === '40001' && n === 0, { cr: cr.code, wt, res, n });
  } finally { await w.close(); }
  return true;
}

// ── P2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseApply() {
  section('F2 APPLY -- guards + post-conditions pass; EXACTLY two catalog entries move (whole-catalog fingerprint); posture preserved; 143 / 144 / 145 objects untouched; round trip');
  const su = await cloneSu(env.tpl.base, 'apply');
  const fp0 = await DED.catalogFingerprint(su);
  const pos0 = { o: await posture(su, SIG.order), m: await posture(su, SIG.mesa) };
  const frozen0 = { prelude: await md5Of(su, SIG.prelude), cancel: await md5Of(su, SIG.cancel), op: await md5Of(su, SIG.opay), mp: await md5Of(su, SIG.mpay) };
  const nfn0 = (await su.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`)).rows[0].n;
  let e = await applyTo(su, F146);
  assert('migration 146 applies cleanly on the Economy candidate 143 + 144 + 145 (guards + post-conditions pass)', !e, e && `${e.code} ${e.message}`);
  if (e) { await su.end(); return false; }
  const fp1 = await DED.catalogFingerprint(su); const d = DED.fingerprintDiff(fp0, fp1);
  assert('146 changed EXACTLY two catalog entries: the bodies of order_post_refund_v1 and mesa_post_refund_v1 (no other function, trigger, table, column, index, constraint, grant)',
    d.length === 2 && d.every((x) => /^functions:public\.(order_post_refund_v1|mesa_post_refund_v1)\(/.test(x)) && d.some((x) => /order_post_refund_v1/.test(x)) && d.some((x) => /mesa_post_refund_v1/.test(x)), d);
  const nfn1 = (await su.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'`)).rows[0].n;
  assert('no function added or removed (' + nfn0 + ' user functions before and after)', nfn0 === nfn1, { nfn0, nfn1 });
  const pos1 = { o: await posture(su, SIG.order), m: await posture(su, SIG.mesa) };
  assert('owner / SECURITY INVOKER / search_path / ACL / return type / arguments / identity signature of both writers are exactly the pre-146 ones (service_role EXECUTE only)',
    JSON.stringify(pos0) === JSON.stringify(pos1) && pos1.o.acl === SVC_ONLY && pos1.m.acl === SVC_ONLY && !pos1.o.prosecdef && !pos1.m.prosecdef && pos1.o.owner === 'postgres' && pos1.o.cfg === '{"search_path=public, extensions, pg_temp"}' && pos1.m.cfg === pos1.o.cfg && !pos1.o.anon_x && !pos1.m.auth_x && pos1.o.ret === 'jsonb', { pos0, pos1 });
  assert('the installed bodies are the 146 bodies (md5 pins of the file)', (await md5Of(su, SIG.order)) === NEW_PINS.order && (await md5Of(su, SIG.mesa)) === NEW_PINS.mesa);
  const so = await srcOf(su, SIG.order), sm = await srcOf(su, SIG.mesa);
  const cnt = (s, x) => s.split(x).length - 1;
  assert('ORDER: the pointer-lock block once, the typed-refusal block once, lock IMMEDIATELY before the unchanged receipt SELECT, refusal IMMEDIATELY after it, mode exactly FOR SHARE',
    cnt(so, LOCK_BLOCK) === 1 && cnt(so, REJECT_BLOCK) === 1 && cnt(so, '-- 146:BEGIN ') === 2 && so.includes(LOCK_BLOCK + RECEIPT_SELECT + REJECT_BLOCK) && !/FOR\s+(NO\s+KEY\s+)?UPDATE;|KEY SHARE/.test(LOCK_BLOCK));
  const iRej = so.indexOf(REJECT_BLOCK) + REJECT_BLOCK.length;
  assert('ORDER: no write of the refund path precedes the refusal point (first INSERT into payment_transactions / payment_allocations / order_financial_events and the ordenes UPDATE all come after it; the only earlier write is the pre-existing replay audit row, inside the replay branch that RETURNs)',
    ['INSERT INTO public.payment_transactions', 'INSERT INTO public.payment_allocations', 'INSERT INTO public.order_financial_events', 'UPDATE public.ordenes'].every((x) => so.indexOf(x) > iRej)
    && (so.slice(0, iRej).match(/INSERT INTO|UPDATE public\.|DELETE FROM/g) || []).length === 1 && /IF FOUND THEN[\s\S]*INSERT INTO public\.auth_audit[\s\S]*RETURN jsonb_build_object\('ok', true, 'idempotent', true/.test(so.slice(0, iRej)));
  assert('ORDER: the body without its two blocks is the live predecessor BYTE FOR BYTE (md5 ' + PIN.order + ')', K.md5(so.replace(LOCK_BLOCK, '').replace(REJECT_BLOCK, '')) === PIN.order);
  assert('MESA: the pointer-lock block once, immediately before the receipt SELECT; NO ORDER_REFUND_NO_OPEN_SERVICE and no other 146 block; body without the block = live predecessor byte for byte (md5 ' + PIN.mesa + ')',
    cnt(sm, LOCK_BLOCK) === 1 && cnt(sm, '-- 146:BEGIN ') === 1 && sm.includes(LOCK_BLOCK + RECEIPT_SELECT) && !sm.includes('ORDER_REFUND_NO_OPEN_SERVICE') && !/requires_open_service/.test(sm) && K.md5(sm.replace(LOCK_BLOCK, '')) === PIN.mesa);
  assert('the C8 objects (prelude, order_cancel_v1) and the 145 payment writers are byte-identical', (await md5Of(su, SIG.prelude)) === frozen0.prelude && (await md5Of(su, SIG.cancel)) === frozen0.cancel && (await md5Of(su, SIG.opay)) === frozen0.op && (await md5Of(su, SIG.mpay)) === frozen0.mp && frozen0.op === PAY145.order);
  { const svc = await rt.connect(env.cl, su.db, { role: 'service_role', name: 'fb-svcprobe' });
    let ok = false, err = null; try { await svc.query('BEGIN'); await svc.query('SELECT 1 FROM public.service_session_state WHERE singleton = true FOR SHARE'); ok = true; } catch (x) { err = x.message; } finally { await svc.query('ROLLBACK').catch(() => {}); await svc.end(); }
    assert('service_role can take SELECT ... FOR SHARE on the lifecycle pointer under the real posture', ok, err); }
  e = await applyTo(su, F146);
  assert('a second apply of 146 is refused (typed guard: already applied)', !!e && /REFUND_CLOSE_LOCK refused: already applied/.test(e.message), e && e.message);
  assert('...and the refused second apply left NOTHING behind', DED.fingerprintDiff(fp1, await DED.catalogFingerprint(su)).length === 0);
  e = await applyTo(su, R146);
  assert('the rollback applies cleanly', !e, e && `${e.code} ${e.message}`);
  if (!e) {
    const fp2 = await DED.catalogFingerprint(su);
    assert('RB: CATALOG FINGERPRINT after the rollback == the pre-146 catalog, entry by entry', DED.fingerprintDiff(fp0, fp2).length === 0, DED.fingerprintDiff(fp0, fp2));
    assert('RB: both refund writers are the live predecessors again (' + PIN.order + ' / ' + PIN.mesa + '), posture identical', (await md5Of(su, SIG.order)) === PIN.order && (await md5Of(su, SIG.mesa)) === PIN.mesa && JSON.stringify({ o: await posture(su, SIG.order), m: await posture(su, SIG.mesa) }) === JSON.stringify(pos0));
    const e2 = await applyTo(su, R146);
    assert('a second rollback is refused (the bodies are no longer the 146 bodies) and leaves nothing behind', !!e2 && /REFUND_CLOSE_LOCK rollback refused/.test(e2.message) && DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)).length === 0, e2 && e2.message);
    const e3 = await applyTo(su, F146);
    assert('forward re-applies cleanly after the rollback (round trip forward -> rollback -> forward) and reproduces the first-apply catalog exactly (deterministic)', !e3 && DED.fingerprintDiff(fp1, await DED.catalogFingerprint(su)).length === 0, e3 && e3.message);
  }
  await su.end();
  return true;
}

// ── P3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseDrift() {
  section('F3 DRIFT GUARDS -- fail closed: every violated precondition is REFUSED with a typed message and the refused migration leaves NOTHING behind');
  const cases = [
    ['143 is NOT applied (PRE: no prelude, no 145)', 'fb_pre_tpl', /REFUND_CLOSE_LOCK refused: migration 143 .* is not applied/, async () => {}],
    ['143 is NOT applied (PRE + 144 only)', env.tpl.pre144, /REFUND_CLOSE_LOCK refused: migration 143 .* is not applied/, async () => {}],
    ['the 143 prelude trigger is missing', env.tpl.base, /REFUND_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing/, (su) => su.query('DROP TRIGGER a0_order_intake_lock_prelude_v1 ON public.ordenes')],
    ['the 143 prelude trigger is disabled', env.tpl.base, /REFUND_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing, disabled/, (su) => su.query('ALTER TABLE public.ordenes DISABLE TRIGGER a0_order_intake_lock_prelude_v1')],
    ['the 143 prelude trigger has a WHEN clause', env.tpl.base, /REFUND_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing, disabled/, async (su) => { await su.query('DROP TRIGGER a0_order_intake_lock_prelude_v1 ON public.ordenes'); await su.query('CREATE TRIGGER a0_order_intake_lock_prelude_v1 BEFORE INSERT ON public.ordenes FOR EACH ROW WHEN (new.id IS NOT NULL) EXECUTE FUNCTION public.order_intake_lock_prelude_v1()'); }],
    ['the 143 prelude trigger is AFTER INSERT instead of BEFORE', env.tpl.base, /REFUND_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing, disabled/, async (su) => { await su.query('DROP TRIGGER a0_order_intake_lock_prelude_v1 ON public.ordenes'); await su.query('CREATE TRIGGER a0_order_intake_lock_prelude_v1 AFTER INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.order_intake_lock_prelude_v1()'); }],
    ['the 143 prelude function is missing', env.tpl.base, /REFUND_CLOSE_LOCK refused: migration 143 .* is not applied/, (su) => su.query('DROP FUNCTION public.order_intake_lock_prelude_v1() CASCADE')],
    ['a BEFORE INSERT trigger of ordenes sorts before the prelude (the prelude is not first)', env.tpl.base, /REFUND_CLOSE_LOCK refused: the 143 prelude is not the first BEFORE INSERT trigger/, (su) => su.query('CREATE TRIGGER "0_early" BEFORE INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.mesa_snapshot_order_lines_v1()')],
    ['ECONOMY LINEAGE: 145 is NOT applied (C8 = PRE + 143 + 144)', env.tpl.c8, /REFUND_CLOSE_LOCK refused: ECONOMY_LINEAGE -- migration 145 is not applied \(order_post_payment_v1/, async () => {}],
    ['ECONOMY LINEAGE: only the order payment writer carries 145 (Mesa reverted to its predecessor)', env.tpl.base, /REFUND_CLOSE_LOCK refused: ECONOMY_LINEAGE -- migration 145 is not applied \(mesa_post_payment_v1/, async (su) => {
      await su.query(K.realStatement('mesa_post_payment_v1', '2026-09-11_economic_writer_hardening_v1_migration_126.sql', 'moji', PAY_PRE145.mesa)); }],
    ['ECONOMY LINEAGE: a 145 payment body drifted (one comment added)', env.tpl.base, /REFUND_CLOSE_LOCK refused: ECONOMY_LINEAGE -- migration 145 is not applied \(order_post_payment_v1/, (su) => fnDrift(su, SIG.opay)],
    ['order_post_refund_v1 drifted (one comment added)', env.tpl.base, /REFUND_CLOSE_LOCK refused: order_post_refund_v1 is not the pinned live predecessor body/, (su) => fnDrift(su, SIG.order)],
    ['mesa_post_refund_v1 drifted (one comment added)', env.tpl.base, /REFUND_CLOSE_LOCK refused: mesa_post_refund_v1 is not the pinned live predecessor body/, (su) => fnDrift(su, SIG.mesa)],
    ['order_post_refund_v1 is the RAW migration-122 text (UTF-8 "§", not the live mojibake bytes)', env.tpl.base, /REFUND_CLOSE_LOCK refused: order_post_refund_v1 is not the pinned live predecessor body \(md5 mismatch: b07ca9b2852bedd38dc825baea03a68f/, (su) => su.query(K.realStatement('order_post_refund_v1', '2026-09-07_check_centric_universal_cash_v1_migration_122.sql', 'raw', 'b07ca9b2852bedd38dc825baea03a68f'))],
    ['order_post_refund_v1 is missing', env.tpl.base, /REFUND_CLOSE_LOCK refused: public\.order_post_refund_v1\(.*\) is missing/, (su) => su.query(`DROP FUNCTION ${SIG.order}`)],
    ['mesa_post_refund_v1 is missing', env.tpl.base, /REFUND_CLOSE_LOCK refused: public\.mesa_post_refund_v1\(.*\) is missing/, (su) => su.query(`DROP FUNCTION ${SIG.mesa}`)],
    ['an extra order_post_refund_v1 overload', env.tpl.base, /REFUND_CLOSE_LOCK refused: order_post_refund_v1 has an unexpected overload set/, (su) => su.query('CREATE FUNCTION public.order_post_refund_v1(p_a integer) RETURNS integer LANGUAGE sql AS $x$ SELECT 1 $x$')],
    ['an extra mesa_post_refund_v1 overload', env.tpl.base, /REFUND_CLOSE_LOCK refused: mesa_post_refund_v1 has an unexpected overload set/, (su) => su.query('CREATE FUNCTION public.mesa_post_refund_v1(p_a integer) RETURNS integer LANGUAGE sql AS $x$ SELECT 1 $x$')],
    ['one writer already carries a 146 block (partial / manual apply)', env.tpl.base, /REFUND_CLOSE_LOCK refused: already applied \(mesa_post_refund_v1/, async (su) => {
      const d = (await su.query('SELECT pg_get_functiondef($1::regprocedure) AS d', [SIG.mesa])).rows[0].d; await su.query(d.replace(RECEIPT_SELECT, LOCK_BLOCK + RECEIPT_SELECT)); }],
    ['service_role has no SELECT privilege on service_session_state', env.tpl.base, /REFUND_CLOSE_LOCK refused: service_role lacks SELECT \+ UPDATE/, (su) => su.query('REVOKE SELECT ON public.service_session_state FROM service_role')],
    ['service_role has no UPDATE privilege on service_session_state (FOR SHARE would fail with 42501)', env.tpl.base, /REFUND_CLOSE_LOCK refused: service_role lacks SELECT \+ UPDATE/, (su) => su.query('REVOKE UPDATE ON public.service_session_state FROM service_role')],
  ];
  for (const [label, tpl, re, inject] of cases) {
    const su = await cloneSu(tpl, 'drift');
    try { await asPostgres(su, () => inject(su)); } catch (x) { assert(`harness: drift injection "${label}"`, false, x.message); await su.end(); continue; }
    const fp0 = await DED.catalogFingerprint(su);
    const e = await applyTo(su, F146);
    assert(`146 against "${label}" is REFUSED (typed guard)`, !!e && re.test(e.message), e ? e.message : '(silently accepted)');
    assert('...and the refused 146 left NOTHING behind (whole-catalog fingerprint unchanged)', DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)).length === 0, DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)));
    await su.end();
  }
  { const su = await cloneSu(env.tpl.base, 'driftrls');
    let e = null; let d = [];
    try { await su.query('ALTER TABLE public.service_session_state ENABLE ROW LEVEL SECURITY'); await su.query('ALTER ROLE service_role NOBYPASSRLS'); const fp0 = await DED.catalogFingerprint(su); e = await applyTo(su, F146); d = DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)); }
    finally { await su.query('ALTER ROLE service_role BYPASSRLS'); }
    assert('146 against "RLS enabled on service_session_state and service_role does not bypass it" is REFUSED (typed guard) and leaves nothing behind', !!e && /REFUND_CLOSE_LOCK refused: row-level security is enabled/.test(e.message) && d.length === 0, e ? e.message : '(silently accepted)');
    await su.end(); }
  { const su = await cloneSu(env.tpl.base, 'driftrlsok');
    await su.query('ALTER TABLE public.service_session_state ENABLE ROW LEVEL SECURITY');
    const e = await applyTo(su, F146);
    assert('146 against the STAGING posture (RLS enabled on service_session_state, service_role BYPASSRLS) is ACCEPTED', !e && (await md5Of(su, SIG.order)) === NEW_PINS.order && (await md5Of(su, SIG.mesa)) === NEW_PINS.mesa, e && e.message);
    await su.end(); }
  { const su = await cloneSu(env.tpl.base, 'driftenc');     // the file carries the live non-ASCII bytes: a non-UTF-8 transport must be refused before anything is created
    const fp0 = await DED.catalogFingerprint(su); let e = null;   // node-pg sends the UTF-8 bytes; the server decodes them as LATIN1 (a UTF-8 file loaded with the wrong client encoding)
    try { await su.query("SET client_encoding = 'LATIN1'"); await su.query('SET ROLE postgres'); await su.query(readAny(F146)); } catch (x) { e = x; } finally { await su.query('ROLLBACK').catch(() => {}); await su.query('RESET ROLE').catch(() => {}); await su.query("SET client_encoding = 'UTF8'"); }
    assert('146 sent with a NON-UTF-8 client encoding (the live mojibake bytes would be re-encoded) is REFUSED by the transport guard and leaves nothing behind', !!e && /this file must be sent as UTF-8/.test(e.message) && DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)).length === 0, e ? e.message : '(silently accepted)');
    await su.end(); }
  return true;
}

// ── P4 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseRollback() {
  section('F4 ROLLBACK -- refuses over anything that is not exactly the 146 bodies; independent of 145; operational order 146 -> 145 -> 143 restores the C8 catalog');
  for (const [which, sig, what] of [['order', SIG.order, 'order_post_refund_v1'], ['mesa', SIG.mesa, 'mesa_post_refund_v1']]) {
    const su = await cloneSu(env.tpl.post, 'rbt');
    await asPostgres(su, () => fnDrift(su, sig));
    const fp0 = await DED.catalogFingerprint(su); const e = await applyTo(su, R146);
    assert(`rollback over a TAMPERED ${what} is refused (md5 guard) and overwrites nothing (the other writer is untouched too)`, !!e && /REFUND_CLOSE_LOCK rollback refused: .* is not the exact 146 body/.test(e.message) && DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)).length === 0 && (await md5Of(su, which === 'order' ? SIG.mesa : SIG.order)) === NEW_PINS[which === 'order' ? 'mesa' : 'order'], e && e.message);
    await su.end();
  }
  { const su = await cloneSu(env.tpl.base, 'rbnone'); const e = await applyTo(su, R146);
    assert('rollback without a prior apply is refused (the bodies are the predecessors, not the 146 bodies)', !!e && /REFUND_CLOSE_LOCK rollback refused/.test(e.message), e && e.message); await su.end(); }
  { const su = await cloneSu(env.tpl.post, 'rbno145'); const a = await applyTo(su, R145);     // 145 rolled back FIRST (out of the documented order): 146's rollback must still work
    const fpc8 = await fpOf(env.tpl.c8);
    const b = await applyTo(su, R146);
    assert('the 146 rollback has NO dependency on 145: with 145 already rolled back it still restores both refund predecessors and the catalog equals C8 (143 + 144) exactly', !a && !b && (await md5Of(su, SIG.order)) === PIN.order && (await md5Of(su, SIG.mesa)) === PIN.mesa && DED.fingerprintDiff(fpc8, await DED.catalogFingerprint(su)).length === 0, [a && a.message, b && b.message]);
    await su.end(); }
  { const su = await cloneSu(env.tpl.post, 'rbord'); const fpPre144 = await fpOf(env.tpl.pre144); const fpBase = await fpOf(env.tpl.base);
    const a = await applyTo(su, R146); const aOk = !a && DED.fingerprintDiff(fpBase, await DED.catalogFingerprint(su)).length === 0;
    const b = await applyTo(su, R145); const c = await applyTo(su, R143);
    assert('OPERATIONAL ORDER 146 -> 145 -> 143: each rollback applies cleanly; after 146 the catalog is exactly BASE (pre-146); at the end exactly PRE + 144', aOk && !b && !c && DED.fingerprintDiff(fpPre144, await DED.catalogFingerprint(su)).length === 0, [a && a.message, b && b.message, c && c.message]);
    await su.end(); }
  return true;
}

// ── shared scenario plumbing ───────────────────────────────────────────────────────────────────────────────────────────────────────
const lbl = (w, id) => (id == null ? 'NULL' : id === w.A ? 'A' : id === w.B ? 'B' : 'other');
const okp = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ err: e.code || 'ERR', msg: String(e.message).slice(0, 90) }));
const outc = (x) => (x.ok ? (x.v && x.v.idempotent ? 'ok(idempotent)' : 'ok') : `${x.err}:${(x.msg || '').split(' ')[0]}`);
const openB = (c) => c.query('SELECT public.open_operational_service_v1($1,$2,$3) AS r', ['operator_primary', 'next_service_of_business_day', 'fb_open']).then((r) => r.rows[0].r);
const setB = async (w) => { const b = (await w.su.query(`SELECT id FROM public.service_sessions WHERE status='open'`)).rows[0]; w.B = b && b.id; };
const pointerOf = async (w) => lbl(w, (await w.su.query('SELECT current_session_id AS p FROM public.service_session_state WHERE singleton = true')).rows[0].p);
const terminal = (w, id) => w.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [id]);
async function mkTermPaid(w, t = 12) { const P = await K.mkPaid(w, t); await terminal(w, P.id); return P; }
const mkTermUnpaid = async (w, t = 10) => { const O = await K.mkUnpaid(w, t); await terminal(w, O.id); return O; };
async function mkMesaPaid(w, { total = 10, closeTable = false } = {}) {
  const t = await K.mkTable(w, 2); const o1 = await K.mkTableOrder(w, t, total);
  await w.svc.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', K.rid('mp'), K.hex64(K.rid('mh')), null, null, null, '{}', false]);
  await terminal(w, o1.id);
  // setup only: the table is put in the CLOSED state directly (session_replication_role = replica for this one UPDATE, because the staging trigger
  // mesa_complete_reservation_v1 reads a reservation table the frozen fixture does not carry); the writers under test run with every trigger enabled.
  if (closeTable) await w.su.query(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE public.table_sessions SET status = 'closed', closed_at = now(), settled_at = COALESCE(settled_at, now()) WHERE id = '${t}'; COMMIT`);
  const tx = (await w.su.query(`SELECT id FROM public.payment_transactions WHERE table_session_id = $1 AND kind='payment' ORDER BY created_at DESC LIMIT 1`, [t])).rows[0].id;
  return { table: t, id: o1.id, tx };
}
const orderRefund = (c, w, P, x = {}) => { const reqId = x.reqId || K.rid('rf');
  return c.query('SELECT public.order_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, x.actor || 'owner', K.hex64('so'), x.uid || P.order_uid, x.tx || P.tx, x.reason === undefined ? 'fb refund' : x.reason, reqId, x.hash || K.hex64(`${P.order_uid}|${reqId}`), x.amount === undefined ? null : x.amount, JSON.stringify(x.meta || {})]).then((r) => r.rows[0].r); };
const mesaRefund = (c, w, T, x = {}) => { const reqId = x.reqId || K.rid('mr');
  return c.query('SELECT public.mesa_post_refund_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS r', [w.ws, x.actor || 'owner', K.hex64('so'), x.table || T.table, x.tx || T.tx, x.reason === undefined ? 'fb mesa refund' : x.reason, reqId, x.hash || K.hex64(`${T.table}|${reqId}`), x.amount === undefined ? null : x.amount, JSON.stringify(x.meta || {})]).then((r) => r.rows[0].r); };
// the refunds of one original transaction: PT receipt / scope / amounts / allocations, and the events' receipt / sale services
async function refundObs(w, X) {
  const pts = (await w.su.query(`SELECT pt.id, pt.service_session_id AS r, pt.table_session_id AS ts, pt.amount::float AS amt, (pt.meta->>'off_service_receipt') AS off, rs.status AS rst,
      (SELECT count(*)::int FROM public.payment_allocations a WHERE a.payment_transaction_id = pt.id) AS allocs
      FROM public.payment_transactions pt LEFT JOIN public.service_sessions rs ON rs.id = pt.service_session_id
     WHERE pt.kind = 'refund' AND pt.reverses_transaction_id = $1 ORDER BY pt.created_at, pt.id`, [X.tx])).rows;
  const ev = (await w.su.query(`SELECT e.service_session_id AS sale, e.event_service_session_id AS receipt, es.status AS est, e.payment_transaction_id AS ptid FROM public.order_financial_events e
      JOIN public.payment_transactions pt ON pt.id = e.payment_transaction_id LEFT JOIN public.service_sessions es ON es.id = e.event_service_session_id
     WHERE e.type = 'refund' AND pt.reverses_transaction_id = $1 ORDER BY e.created_at, e.id`, [X.tx])).rows;
  return { n: pts.length, pt_svc: pts.map((p) => lbl(w, p.r)), pt_st: pts.map((p) => p.rst || null), scoped_table: pts.map((p) => !!p.ts), flag: pts.map((p) => p.off), amounts: pts.map((p) => p.amt), allocs: pts.map((p) => p.allocs),
    event_receipt: ev.map((e) => lbl(w, e.receipt)), event_receipt_st: ev.map((e) => e.est || null), event_sale: ev.map((e) => lbl(w, e.sale)) };
}
// economic + lineage invariants over the whole database (refund-aware)
async function economicAudit(w) {
  const q = async (s) => (await w.su.query(s)).rows[0].n; const v = [];
  const chk = async (name, sql) => { const n = await q(sql); if (n) v.push(`${name}=${n}`); };
  await chk('refund_exceeds_original', `SELECT count(*)::int AS n FROM public.payment_transactions o WHERE o.kind = 'payment' AND o.amount < (SELECT COALESCE(sum(r.amount),0) FROM public.payment_transactions r WHERE r.kind = 'refund' AND r.reverses_transaction_id = o.id)`);
  await chk('refund_link_broken', `SELECT count(*)::int AS n FROM public.payment_transactions r LEFT JOIN public.payment_transactions o ON o.id = r.reverses_transaction_id WHERE r.kind = 'refund' AND (o.id IS NULL OR o.kind <> 'payment' OR o.payment_method IS DISTINCT FROM r.payment_method OR o.table_session_id IS DISTINCT FROM r.table_session_id)`);
  await chk('refund_event_link_broken', `SELECT count(*)::int AS n FROM public.order_financial_events e JOIN public.payment_transactions r ON r.id = e.payment_transaction_id WHERE e.type = 'refund' AND (r.kind <> 'refund' OR (e.meta->>'reverses_transaction_id') IS DISTINCT FROM r.reverses_transaction_id::text)`);
  await chk('duplicate_payment_per_order', `SELECT count(*)::int AS n FROM (SELECT order_id FROM public.order_financial_events WHERE type='payment' GROUP BY order_id HAVING count(*) > 1) x`);
  await chk('pt_without_allocation_or_event', `SELECT count(*)::int AS n FROM public.payment_transactions t WHERE NOT EXISTS (SELECT 1 FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id) OR NOT EXISTS (SELECT 1 FROM public.order_financial_events e WHERE e.payment_transaction_id = t.id)`);
  await chk('pt_amount_ne_allocation_or_event', `SELECT count(*)::int AS n FROM public.payment_transactions t WHERE t.amount IS DISTINCT FROM (SELECT sum(a.amount) FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id) OR t.amount IS DISTINCT FROM (SELECT sum(e.amount) FROM public.order_financial_events e WHERE e.payment_transaction_id = t.id)`);
  await chk('orphan_event', `SELECT count(*)::int AS n FROM public.order_financial_events e WHERE e.type IN ('payment','refund') AND e.payment_transaction_id IS NULL AND e.legacy IS NOT TRUE`);
  await chk('sale_service_moved', `SELECT count(*)::int AS n FROM public.order_financial_events e JOIN public.ordenes o ON o.id = e.order_id WHERE e.type IN ('payment','refund') AND e.service_session_id IS DISTINCT FROM o.service_session_id`);
  // receipt contract: order (check-centric) rows -> PT receipt = event receipt; Mesa payment -> equal; Mesa refund -> PT = the table's origin service (M141 exempts it)
  await chk('order_or_payment_pt_receipt_ne_event', `SELECT count(*)::int AS n FROM public.order_financial_events e JOIN public.payment_transactions pt ON pt.id = e.payment_transaction_id WHERE (pt.kind = 'payment' OR pt.table_session_id IS NULL) AND pt.service_session_id IS DISTINCT FROM e.event_service_session_id`);
  await chk('mesa_refund_pt_not_table_origin', `SELECT count(*)::int AS n FROM public.payment_transactions pt JOIN public.table_sessions ts ON ts.id = pt.table_session_id WHERE pt.kind = 'refund' AND pt.service_session_id IS DISTINCT FROM ts.service_session_id`);
  await chk('scopeless_refund', `SELECT count(*)::int AS n FROM public.payment_transactions WHERE kind = 'refund' AND service_session_id IS NULL AND table_session_id IS NULL`);
  await chk('offservice_flag_incoherent', `SELECT count(*)::int AS n FROM public.payment_transactions WHERE service_session_id IS NULL AND table_session_id IS NULL AND COALESCE((meta->>'off_service_receipt') = 'true', false) = false`);
  await chk('double_active_service', `SELECT GREATEST(count(*) - 1, 0)::int AS n FROM public.service_sessions WHERE status IN ('open','closing')`);
  await chk('pointer_mismatch', `SELECT count(*)::int AS n FROM public.service_session_state st LEFT JOIN public.service_sessions s ON s.id = st.current_session_id WHERE st.current_session_id IS NOT NULL AND (s.id IS NULL OR s.status NOT IN ('open','closing'))`);
  // M141 (Fiscal, read-only consumer): its lineage checks transcribed over the whole ledger -- LINEAGE_ANOMALY classification and the qbad quadrature
  await chk('m141_lineage_anomaly', `SELECT count(*)::int AS n FROM public.order_financial_events r WHERE r.type IN ('payment','refund') AND r.event_service_session_id IS NOT NULL AND r.payment_transaction_id IS NULL`);
  await chk('m141_qbad', `WITH rxe AS (SELECT e.* FROM public.order_financial_events e WHERE e.type IN ('payment','refund') AND e.payment_transaction_id IS NOT NULL),
      rxt AS (SELECT t.* FROM public.payment_transactions t WHERE t.id IN (SELECT payment_transaction_id FROM rxe)),
      rxa AS (SELECT a.payment_transaction_id AS tx_id, a.order_id, sum(a.amount) AS amt FROM public.payment_allocations a WHERE a.payment_transaction_id IN (SELECT id FROM rxt) GROUP BY 1, 2),
      rxa_tx AS (SELECT tx_id, sum(amt) AS amt FROM rxa GROUP BY 1), rxe_ord AS (SELECT payment_transaction_id AS tx_id, order_id, sum(amount) AS amt FROM rxe GROUP BY 1, 2), rxe_tx AS (SELECT tx_id, sum(amt) AS amt FROM rxe_ord GROUP BY 1),
      qbad AS (
        SELECT t.id AS tx_id FROM rxt t LEFT JOIN rxa_tx pa ON pa.tx_id = t.id LEFT JOIN rxe_tx oe ON oe.tx_id = t.id
         WHERE t.amount IS DISTINCT FROM pa.amt OR t.amount IS DISTINCT FROM oe.amt OR (t.service_session_id IS NULL AND t.table_session_id IS NULL AND NOT COALESCE((t.meta -> 'off_service_receipt') = 'true'::jsonb, false))
        UNION SELECT COALESCE(oe.tx_id, pa.tx_id) FROM rxe_ord oe FULL JOIN rxa pa ON pa.tx_id = oe.tx_id AND pa.order_id = oe.order_id WHERE oe.amt IS DISTINCT FROM pa.amt
        UNION SELECT o.payment_transaction_id FROM rxe o JOIN rxt t ON t.id = o.payment_transaction_id
         WHERE o.type IS DISTINCT FROM t.kind OR o.payment_method IS DISTINCT FROM t.payment_method OR o.created_at IS DISTINCT FROM t.created_at
            OR ((t.kind = 'payment' OR t.table_session_id IS NULL) AND o.event_service_session_id IS DISTINCT FROM t.service_session_id)
            OR (t.kind = 'refund' AND t.reverses_transaction_id::text IS DISTINCT FROM (o.meta ->> 'reverses_transaction_id')))
      SELECT count(*)::int AS n FROM qbad`);
  for (const x of (await K.integrity(w.su)).violations.filter((y) => !/^overcollected/.test(y))) v.push(x);
  for (const x of (await K.stateInvariants(w.su)).violations) v.push(x);
  return v;
}
// supplementary (NOT primary): a refund event receipt naming a service that was already closed when the refund was created
const lateRefunds = async (w) => (await w.su.query(`SELECT count(*)::int AS n FROM public.order_financial_events e JOIN public.service_sessions s ON s.id = e.event_service_session_id WHERE e.type = 'refund' AND s.status = 'closed' AND s.closed_at IS NOT NULL AND e.created_at > s.closed_at`)).rows[0].n;
async function waitPid(su, app, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query(`SELECT a.pid, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'`, [app]);
    if (r.rows.length) {
      const pid = r.rows[0].pid;
      const l = await su.query(`SELECT l.locktype, l.relation::regclass::text AS rel, l.granted FROM pg_locks l WHERE l.pid = $1 AND l.locktype IN ('tuple','transactionid','advisory') ORDER BY 1, 3`, [pid]);
      const tup = l.rows.find((x) => x.locktype === 'tuple');
      let rel = tup ? tup.rel : null;
      if (!rel) { const x = await su.query(`SELECT l.relation::regclass::text AS rel FROM pg_locks l WHERE l.pid = $1 AND NOT l.granted AND l.relation IS NOT NULL LIMIT 1`, [pid]); rel = x.rows[0] ? x.rows[0].rel : null; }
      return { pid, blockers: r.rows[0].blockers, rel, adv: l.rows.some((x) => x.locktype === 'advisory' && !x.granted) };
    }
    await delay(10);
  }
  return null;
}
async function rowProbe(su, mode) {
  await su.query('BEGIN');
  try { await su.query(`SELECT 1 FROM public.service_session_state WHERE singleton = true FOR ${mode} NOWAIT`); return 'acquired'; }
  catch (e) { return e.code === '55P03' ? 'conflict' : 'err:' + e.code; }
  finally { await su.query('ROLLBACK').catch(() => {}); }
}
const probeAll = async (su) => ({ FU: await rowProbe(su, 'UPDATE'), NKU: await rowProbe(su, 'NO KEY UPDATE'), SH: await rowProbe(su, 'SHARE'), KS: await rowProbe(su, 'KEY SHARE') });
// close service A in a (committed) statement: every order of A must be terminal
const closeA = async (w) => { const corr = await H.seedCloseable({ su: w.su }, w.A); const r = await H.closeV3(w.svc, w.A, corr); if (!r || r.code !== 'V3_CLOSED') throw new Error('closeA: ' + JSON.stringify(r)); return r.code; };
// close(A) held uncommitted by T1; the refund (callFn on T2) is started against it; then the close commits
async function closeHeldThenRefund(w, cn, callFn) {
  const corr = await H.seedCloseable({ su: w.su }, w.A);
  await cn.T1.query('BEGIN'); const cr = await H.closeV3(cn.T1, w.A, corr);
  const ptrDuring = await pointerOf(w);
  const p = okp(callFn(cn.T2)); const wait = await waitPid(w.su, 'c8-t2');
  await cn.T1.query('COMMIT');
  const res = await Promise.race([p, delay(8000).then(() => ({ err: 'TIMEOUT' }))]);
  return { close: cr && cr.code, ptrDuring, ptrAfter: await pointerOf(w), wait, res, closerPid: cn.pid.t1 };
}
// the refund decides FIRST and is stalled AFTER its decision (a blocker holds the service row: the refund waits at its INSERT FK); the close is then started
async function refundFirstThenClose(w, cn, callFn) {
  const corr = await H.seedCloseable({ su: w.su }, w.A);
  const h = await K.hold(cn.B, [{ kind: 'row', k: 'SS' }], w);
  const p = okp(callFn(cn.T2)); const wp = await waitPid(w.su, 'c8-t2');
  const probes = await probeAll(w.su);
  const pc = okp(H.closeV3(cn.T1, w.A, corr)); const wc = await waitPid(w.su, 'c8-t1');
  await K.release(cn.B, h);
  const [rp, rc] = await Promise.all([p, pc]);
  return { wp, wc, probes, rp, close: rc.v && rc.v.code, refundPid: cn.pid.t2, blockerPid: cn.pid.b, ptrAfter: await pointerOf(w) };
}
// an uncommitted pointer transition by T1 (first-open intake or explicit open); the refund on T2 is started against it; then T1 commits
async function openHeldThenRefund(w, cn, kind, callFn) {
  await cn.T1.query('BEGIN');
  if (kind === 'first_open') await K.insertOrder(cn.T1, { id: K.nextId('#FO'), totale: 9 }); else await openB(cn.T1);
  const ptrDuring = await pointerOf(w);
  const p = okp(callFn(cn.T2)); const wait = await waitPid(w.su, 'c8-t2', 1500);
  await cn.T1.query('COMMIT'); await setB(w);
  const res = await Promise.race([p, delay(8000).then(() => ({ err: 'TIMEOUT' }))]);
  return { ptrDuring, ptrAfter: await pointerOf(w), wait, res };
}
async function both(fn) { const b = await fn(env.tpl.base, 'BASE'); const p = await fn(env.tpl.post, 'POST'); return { BASE: b, POST: p }; }
const logScen = (name, r) => { for (const t of ['BASE', 'POST']) console.log(`  INFO  [${t}] ${name}: ${JSON.stringify(r[t]).slice(0, 700)}`); };
const noRaw = (x) => !(x && x.err === '23514');

// ── P5 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseScenarios() {
  section('F5 DETERMINISTIC SCENARIOS R1-R12 (order refund) and M1-M12 (Mesa refund), BASE (143+144+145, negative control) vs POST (+146); primary proof = lock probes / pg_locks / pg_blocking_pids');
  const W = (tpl, label, o) => K.world(env, tpl, label, { deadlockMs: 300, ...(o || {}) });
  // ── ORDER ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const r1 = await both(async (tpl) => { const w = await W(tpl, 'r1'); try { const P = await mkTermPaid(w); const rf = await okp(orderRefund(w.svc, w, P, { amount: 5 })); const close = await closeA(w); return { rf: outc(rf), close, obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R1', r1);
  for (const t of ['BASE', 'POST']) assert(`R1 [${t}] refund BEFORE the close: ok, PT receipt A, event receipt A, sale A, one allocation; the close then succeeds`, r1[t].rf === 'ok' && r1[t].close === 'V3_CLOSED' && r1[t].obs.n === 1 && r1[t].obs.pt_svc[0] === 'A' && r1[t].obs.event_receipt[0] === 'A' && r1[t].obs.event_sale[0] === 'A' && r1[t].obs.allocs[0] === 1 && r1[t].inv.length === 0, r1[t]);
  const r2 = await both(async (tpl) => { const w = await W(tpl, 'r2'); try { const P = await mkTermPaid(w); const close = await closeA(w); const rf = await okp(orderRefund(w.svc, w, P, { amount: 5 })); return { close, rf, obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R2', r2);
  assert('R2 [BASE] (negative control) close first, NO service open: the order refund dies with the RAW 23514 (payment_transactions_scope_chk), nothing written', r2.BASE.rf.err === '23514' && /payment_transactions_scope_chk|violates check/.test(r2.BASE.rf.msg) && r2.BASE.obs.n === 0, r2.BASE);
  assert('R2 [POST] close first, NO service open: TYPED refusal ORDER_REFUND_NO_OPEN_SERVICE / SQLSTATE 55000, nothing written, invariants green', r2.POST.rf.err === '55000' && /^ORDER_REFUND_NO_OPEN_SERVICE/.test(r2.POST.rf.msg) && r2.POST.obs.n === 0 && r2.POST.inv.length === 0, r2.POST);
  const r3 = await both(async (tpl) => { const w = await W(tpl, 'r3'); try { const P = await mkTermPaid(w); await closeA(w); const b = await openB(w.svc); await setB(w); const rf = await okp(orderRefund(w.svc, w, P, { amount: 5 })); return { b: b.code, rf: outc(rf), obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R3', r3);
  for (const t of ['BASE', 'POST']) assert(`R3 [${t}] close, then B open, refund of the A sale: PT receipt B, event receipt B, sale A`, r3[t].rf === 'ok' && r3[t].obs.pt_svc[0] === 'B' && r3[t].obs.event_receipt[0] === 'B' && r3[t].obs.event_sale[0] === 'A' && r3[t].inv.length === 0, r3[t]);
  // R4: close-first race (the close holds the pointer FOR UPDATE, uncommitted)
  const r4 = await both(async (tpl) => { const w = await W(tpl, 'r4'); try { const cn = await K.conns(w); const P = await mkTermPaid(w); const x = await closeHeldThenRefund(w, cn, (c) => orderRefund(c, w, P, { amount: 5 })); return { ...x, obs: await refundObs(w, P), late: await lateRefunds(w), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R4', r4);
  assert('R4 [BASE] (negative control) close in flight: the refund does NOT wait at the pointer (it queues on the service row FK, public.service_sessions) and records its receipt on the service that has just been CLOSED', !!r4.BASE.wait && r4.BASE.wait.rel === 'service_sessions' && r4.BASE.res.ok && r4.BASE.obs.event_receipt[0] === 'A' && r4.BASE.obs.event_receipt_st[0] === 'closed' && r4.BASE.late === 1, r4.BASE);
  assert('R4 [POST] close in flight: the refund WAITS FOR THE CLOSER AT THE POINTER ROW (pg_locks: public.service_session_state; pg_blocking_pids = the closer); the stale read exists (pointer still A from another snapshot)', r4.POST.close === 'V3_CLOSED' && r4.POST.ptrDuring === 'A' && !!r4.POST.wait && r4.POST.wait.rel === 'service_session_state' && r4.POST.wait.blockers.includes(r4.POST.closerPid), r4.POST);
  assert('R4 [POST] after the close commits the refund REREADS the pointer (NULL) and is refused TYPED (55000 ORDER_REFUND_NO_OPEN_SERVICE): no receipt on the closed A, no raw 23514, nothing written', r4.POST.ptrAfter === 'NULL' && r4.POST.res.err === '55000' && /^ORDER_REFUND_NO_OPEN_SERVICE/.test(r4.POST.res.msg) && r4.POST.obs.n === 0 && r4.POST.late === 0 && r4.POST.inv.length === 0, r4.POST);
  // R5: refund-first race (the refund has decided, stalled after its decision; then the close)
  const r5 = await both(async (tpl) => { const w = await W(tpl, 'r5'); try { const cn = await K.conns(w); const P = await mkTermPaid(w); const x = await refundFirstThenClose(w, cn, (c) => orderRefund(c, w, P, { amount: 5 })); return { ...x, obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R5', r5);
  assert('R5 [POST] the refund that has decided HOLDS the pointer FOR SHARE: probes from a third connection -- FOR UPDATE and FOR NO KEY UPDATE conflict, FOR SHARE and FOR KEY SHARE are compatible', r5.POST.probes.FU === 'conflict' && r5.POST.probes.NKU === 'conflict' && r5.POST.probes.SH === 'acquired' && r5.POST.probes.KS === 'acquired', r5.POST.probes);
  assert('R5 [BASE] (negative control) the same stalled refund holds NO lock on the pointer (every probe acquired)', Object.values(r5.BASE.probes).every((x) => x === 'acquired'), r5.BASE.probes);
  assert('R5 [POST] the CLOSE waits FOR THE REFUND at the pointer (public.service_session_state, blocked by the refund pid, not by the service-row blocker); refund ok with receipt A (open at its serialization point), close V3_CLOSED afterwards, pointer NULL',
    !!r5.POST.wc && r5.POST.wc.rel === 'service_session_state' && r5.POST.wc.blockers.includes(r5.POST.refundPid) && !r5.POST.wc.blockers.includes(r5.POST.blockerPid) && r5.POST.rp.ok && r5.POST.close === 'V3_CLOSED' && r5.POST.obs.event_receipt[0] === 'A' && r5.POST.ptrAfter === 'NULL' && r5.POST.inv.length === 0, r5.POST);
  assert('R5 [BASE] (negative control) the close is not ordered at the pointer (it queues later on the service row)', !!r5.BASE.wc && r5.BASE.wc.rel === 'service_sessions', r5.BASE.wc);
  // R6a replay (sequential, and after the close with no service open); R6b the same request twice during the race
  const r6 = await both(async (tpl) => { const w = await W(tpl, 'r6'); try { const P = await mkTermPaid(w); const reqId = K.rid('rf'), hash = K.hex64('h6');
    const a = await okp(orderRefund(w.svc, w, P, { amount: 5, reqId, hash })); const b = await okp(orderRefund(w.svc, w, P, { amount: 5, reqId, hash })); await closeA(w);
    const c = await okp(orderRefund(w.svc, w, P, { amount: 5, reqId, hash })); const d = await okp(orderRefund(w.svc, w, P, { amount: 5, reqId, hash: K.hex64('other') }));
    const e = await okp(orderRefund(w.svc, w, P, { amount: 5, reqId, hash, actor: 'operator_backup' }));
    return { a: outc(a), b: outc(b), c: outc(c), cAmount: c.v && c.v.amount, d: outc(d), e: outc(e), obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R6a', r6);
  for (const t of ['BASE', 'POST']) assert(`R6a [${t}] replay: second call idempotent; replay AFTER the close with NO service open still idempotent (the replay returns BEFORE the lock and the refusal); other hash = 23505 IDEMPOTENCY_CONFLICT; exactly one refund`,
    r6[t].a === 'ok' && r6[t].b === 'ok(idempotent)' && r6[t].c === 'ok(idempotent)' && r6[t].d === '23505:ORDER_REFUND_IDEMPOTENCY_CONFLICT' && r6[t].obs.n === 1 && r6[t].inv.length === 0, r6[t]);
  for (const t of ['BASE', 'POST']) assert(`R6a' [${t}] authorization precedes the replay: the same request by an operator is refused 42501 ORDER_REFUND_FORBIDDEN even after the close`, r6[t].e === '42501:ORDER_REFUND_FORBIDDEN', r6[t].e);
  const r6b = await both(async (tpl) => { const w = await W(tpl, 'r6b'); try { const cn = await K.conns(w); const t2b = await w.client('c8-t2b'); const P = await mkTermPaid(w); const reqId = K.rid('rf'), hash = K.hex64('h6b');
    const corr = await H.seedCloseable({ su: w.su }, w.A); await cn.T1.query('BEGIN'); await H.closeV3(cn.T1, w.A, corr);
    const pa = okp(orderRefund(cn.T2, w, P, { amount: 5, reqId, hash })); await K.settleOrBlock(pa, w.su, 'c8-t2', 500); const pb = okp(orderRefund(t2b, w, P, { amount: 5, reqId, hash })); await K.settleOrBlock(pb, w.su, 'c8-t2b', 500);
    await cn.T1.query('COMMIT'); const [ra, rb] = await Promise.all([pa, pb]); return { ra: outc(ra), rb: outc(rb), obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R6b', r6b);
  assert('R6b [POST] the same request twice during the close race: BOTH typed (55000 ORDER_REFUND_NO_OPEN_SERVICE), 0 refunds (exactly-once = 0 or 1), no raw error', [r6b.POST.ra, r6b.POST.rb].every((x) => x === '55000:ORDER_REFUND_NO_OPEN_SERVICE') && r6b.POST.obs.n === 0 && r6b.POST.inv.length === 0, r6b.POST);
  assert('R6b [BASE] (control) exactly-once holds (1 original + 1 idempotent replay) but the receipt is the closed A', ((r6b.BASE.ra === 'ok' && r6b.BASE.rb === 'ok(idempotent)') || (r6b.BASE.rb === 'ok' && r6b.BASE.ra === 'ok(idempotent)')) && r6b.BASE.obs.n === 1 && r6b.BASE.obs.event_receipt[0] === 'A', r6b.BASE);
  // R7-R9: partial / max / exceeds / already-full (service open)
  const r79 = await both(async (tpl) => { const w = await W(tpl, 'r79'); try { const P = await mkTermPaid(w, 12);
    const a = await okp(orderRefund(w.svc, w, P, { amount: 5 })); const b = await okp(orderRefund(w.svc, w, P, { amount: 3 })); const c = await okp(orderRefund(w.svc, w, P, { amount: 5 }));
    const d = await okp(orderRefund(w.svc, w, P, {})); const e = await okp(orderRefund(w.svc, w, P, {}));
    const proj = (await w.su.query('SELECT cobrado, ya_pagado, metodo_pago FROM public.ordenes WHERE id = $1', [P.id])).rows[0];
    return { a: outc(a), aRem: a.v && a.v.refundableRemainingOnOriginal, b: outc(b), c: outc(c), d: outc(d), dAmt: d.v && d.v.amount, e: outc(e), proj, obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R7-R9', r79);
  for (const t of ['BASE', 'POST']) assert(`R7-R9 [${t}] partial 5 (remaining 7), partial 3, 5 > remaining 4 = 55000 EXCEEDS_REMAINING, NULL amount = the remaining 4, then 55000 ALREADY_FULL; refunds 5+3+4 = the original 12; receipts A`,
    r79[t].a === 'ok' && Number(r79[t].aRem) === 7 && r79[t].b === 'ok' && r79[t].c === '55000:ORDER_REFUND_EXCEEDS_REMAINING' && r79[t].d === 'ok' && Number(r79[t].dAmt) === 4 && r79[t].e === '55000:ORDER_REFUND_ALREADY_FULL'
    && JSON.stringify(r79[t].obs.amounts) === '[5,3,4]' && r79[t].obs.event_receipt.every((x) => x === 'A') && r79[t].inv.length === 0, r79[t]);
  assert('R7-R9 BASE == POST (amounts, outcomes, order projection cobrado / ya_pagado / metodo_pago)', JSON.stringify({ ...r79.BASE, inv: 0 }) === JSON.stringify({ ...r79.POST, inv: 0 }), [r79.BASE.proj, r79.POST.proj]);
  // R10: payment on A, refund while B is open
  const r10 = await both(async (tpl) => { const w = await W(tpl, 'r10'); try { const P = await mkTermPaid(w, 12); await closeA(w); await openB(w.svc); await setB(w); const rf = await okp(orderRefund(w.svc, w, P, {})); return { rf: outc(rf), obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } });
  logScen('R10', r10);
  for (const t of ['BASE', 'POST']) assert(`R10 [${t}] payment received at A, full refund while B is open: PT receipt B, event receipt B, sale A, 12`, r10[t].rf === 'ok' && r10[t].obs.pt_svc[0] === 'B' && r10[t].obs.event_receipt[0] === 'B' && r10[t].obs.event_sale[0] === 'A' && r10[t].obs.amounts[0] === 12 && r10[t].inv.length === 0, r10[t]);
  // R11: refund of an OFF-SERVICE payment (M139), with no service / with B open
  const r11 = await both(async (tpl) => { const out = {};
    { const w = await W(tpl, 'r11a', { noService: true }); try { const O = w.hist; const pay = await okp(K.cashPay(w.svc, w, O)); const tx = (await w.su.query(`SELECT t.id, t.service_session_id AS s, t.meta->>'off_service_receipt' AS f FROM public.payment_transactions t JOIN public.payment_allocations a ON a.payment_transaction_id = t.id WHERE a.order_uid = $1 AND t.kind='payment'`, [O.order_uid])).rows[0];
      const X = { ...O, tx: tx.id }; const rf = await okp(orderRefund(w.svc, w, X, { amount: 4 })); out.a = { pay: outc(pay), orig: lbl(w, tx.s), flag: tx.f, rf, obs: await refundObs(w, X), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'r11b', { noService: true }); try { const O = w.hist; await okp(K.cashPay(w.svc, w, O)); const tx = (await w.su.query(`SELECT t.id FROM public.payment_transactions t JOIN public.payment_allocations a ON a.payment_transaction_id = t.id WHERE a.order_uid = $1 AND t.kind='payment'`, [O.order_uid])).rows[0].id;
      await openB(w.svc); await setB(w); const X = { ...O, tx }; const rf = await okp(orderRefund(w.svc, w, X, { amount: 4 })); out.b = { rf: outc(rf), obs: await refundObs(w, X), inv: await economicAudit(w) }; } finally { await w.close(); } }
    return out; });
  logScen('R11', r11);
  assert('R11a [BASE] (negative control) refund of an off-service payment (M139: receipt NULL + flag) with no service open: RAW 23514', r11.BASE.a.pay === 'ok' && r11.BASE.a.orig === 'NULL' && r11.BASE.a.flag === 'true' && r11.BASE.a.rf.err === '23514' && r11.BASE.a.obs.n === 0, r11.BASE.a);
  assert('R11a [POST] the same: TYPED refusal 55000 ORDER_REFUND_NO_OPEN_SERVICE, nothing written; the M139 off-service payment itself is unchanged (receipt NULL + flag)', r11.POST.a.pay === 'ok' && r11.POST.a.orig === 'NULL' && r11.POST.a.flag === 'true' && r11.POST.a.rf.err === '55000' && /^ORDER_REFUND_NO_OPEN_SERVICE/.test(r11.POST.a.rf.msg) && r11.POST.a.obs.n === 0 && r11.POST.a.inv.length === 0, r11.POST.a);
  for (const t of ['BASE', 'POST']) assert(`R11b [${t}] the same refund once B is open: ok, receipt B (PT + event), sale A (the typed refusal is temporary and recoverable)`, r11[t].b.rf === 'ok' && r11[t].b.obs.pt_svc[0] === 'B' && r11[t].b.obs.event_receipt[0] === 'B' && r11[t].b.obs.event_sale[0] === 'A' && r11[t].b.inv.length === 0, r11[t].b);
  // R12: pointer transitions not yet committed -- (a) first-open intake, (b) refund first in a no-service world, (c) explicit open
  const r12 = await both(async (tpl) => { const out = {};
    { const w = await W(tpl, 'r12a', { noService: true }); try { const cn = await K.conns(w); const P = w.histPaid; const x = await openHeldThenRefund(w, cn, 'first_open', (c) => orderRefund(c, w, P, { amount: 3 })); out.a = { ...x, obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'r12b', { noService: true }); try { const P = w.histPaid; const rf = await okp(orderRefund(w.svc, w, P, { amount: 3 })); const fo = await okp(K.insertOrder(w.svc, { id: K.nextId('#FO'), totale: 9 })); await setB(w); out.b = { rf, fo: fo.ok, ptr: await pointerOf(w), obs: await refundObs(w, P), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'r12c', { noService: true }); try { const cn = await K.conns(w); const P = w.histPaid; const x = await openHeldThenRefund(w, cn, 'open', (c) => orderRefund(c, w, P, { amount: 3 })); out.c = { ...x, obs: await refundObs(w, P), late: await lateRefunds(w), inv: await economicAudit(w) }; } finally { await w.close(); } }
    return out; });
  logScen('R12', r12);
  for (const t of ['BASE', 'POST']) assert(`R12a [${t}] first-open intake uncommitted: the refund waits on the workspace row (143 prelude), then records receipt B (identical with and without 146)`, r12[t].a.ptrDuring === 'NULL' && !!r12[t].a.wait && r12[t].a.wait.rel === 'workspaces' && r12[t].a.res.ok && r12[t].a.obs.event_receipt[0] === 'B' && r12[t].a.obs.pt_svc[0] === 'B' && r12[t].a.inv.length === 0, r12[t].a);
  assert('R12b [BASE] refund with no service BEFORE the first-open: raw 23514 / [POST]: typed 55000; the first-open then succeeds in both', r12.BASE.b.rf.err === '23514' && r12.POST.b.rf.err === '55000' && /^ORDER_REFUND_NO_OPEN_SERVICE/.test(r12.POST.b.rf.msg) && r12.BASE.b.fo && r12.POST.b.fo && r12.POST.b.ptr === 'B' && r12.POST.b.obs.n === 0, { b: r12.BASE.b, p: r12.POST.b });
  assert('R12c [BASE] (negative control) explicit open_operational_service_v1 uncommitted: the refund does NOT wait, reads the stale NULL pointer and dies RAW 23514 although B is being opened', !r12.BASE.c.wait && r12.BASE.c.res.err === '23514' && r12.BASE.c.obs.n === 0, r12.BASE.c);
  assert('R12c [POST] explicit open uncommitted: the refund WAITS at the pointer (service_session_state), then sees B and records receipt B (PT + event)', !!r12.POST.c.wait && r12.POST.c.wait.rel === 'service_session_state' && r12.POST.c.res.ok && r12.POST.c.obs.event_receipt[0] === 'B' && r12.POST.c.obs.pt_svc[0] === 'B' && r12.POST.c.inv.length === 0, r12.POST.c);

  // ── MESA ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const m12 = await both(async (tpl) => { const out = {};
    for (const [k, closeTable] of [['m1', true], ['m1b', false]]) { const w = await W(tpl, k); try { const T = await mkMesaPaid(w, { closeTable }); const rf = await okp(mesaRefund(w.svc, w, T, { amount: 4 })); out[k] = { rf: outc(rf), ts: rf.v && rf.v.tableStatus, obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    for (const [k, closeTable] of [['m2', true], ['m2b', false]]) { const w = await W(tpl, k); try { const T = await mkMesaPaid(w, { closeTable }); await closeA(w); const rf = await okp(mesaRefund(w.svc, w, T, { amount: 4 })); out[k] = { rf: outc(rf), ptr: await pointerOf(w), obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm3'); try { const T = await mkMesaPaid(w, { closeTable: true }); await closeA(w); await openB(w.svc); await setB(w); const rf = await okp(mesaRefund(w.svc, w, T, { amount: 4 })); out.m3 = { rf: outc(rf), obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm4'); try { const cn = await K.conns(w); const T = await mkMesaPaid(w, { closeTable: true }); const x = await closeHeldThenRefund(w, cn, (c) => mesaRefund(c, w, T, { amount: 4 })); out.m4 = { ...x, obs: await refundObs(w, T), late: await lateRefunds(w), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm5'); try { const cn = await K.conns(w); const T = await mkMesaPaid(w, { closeTable: true }); const x = await refundFirstThenClose(w, cn, (c) => mesaRefund(c, w, T, { amount: 4 })); out.m5 = { ...x, obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm6'); try { const T = await mkMesaPaid(w, { closeTable: true }); const reqId = K.rid('mr'), hash = K.hex64('m6');
      const a = await okp(mesaRefund(w.svc, w, T, { amount: 4, reqId, hash })); const b = await okp(mesaRefund(w.svc, w, T, { amount: 4, reqId, hash })); await closeA(w);
      const c = await okp(mesaRefund(w.svc, w, T, { amount: 4, reqId, hash })); const d = await okp(mesaRefund(w.svc, w, T, { amount: 4, reqId, hash: K.hex64('o') }));
      out.m6 = { a: outc(a), b: outc(b), c: outc(c), d: outc(d), obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm79'); try { const T = await mkMesaPaid(w, { total: 12, closeTable: true });
      const a = await okp(mesaRefund(w.svc, w, T, { amount: 5 })); const b = await okp(mesaRefund(w.svc, w, T, { amount: 3 })); const c = await okp(mesaRefund(w.svc, w, T, { amount: 5 })); const d = await okp(mesaRefund(w.svc, w, T, {})); const e = await okp(mesaRefund(w.svc, w, T, {}));
      out.m79 = { a: outc(a), b: outc(b), c: outc(c), d: outc(d), dAmt: d.v && d.v.amount, e: outc(e), obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm10'); try { const T = await mkMesaPaid(w, { total: 12, closeTable: true }); await closeA(w); await openB(w.svc); await setB(w); const rf = await okp(mesaRefund(w.svc, w, T, {})); out.m10 = { rf: outc(rf), obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm11'); try { const T = await mkMesaPaid(w, { closeTable: true }); await closeA(w);
      const f = await okp(mesaRefund(w.svc, w, T, { amount: 4, actor: 'operator_backup' })); const g = await okp(mesaRefund(w.svc, w, T, { amount: 4, tx: '00000000-0000-4000-8000-000000000001' })); const h = await okp(mesaRefund(w.svc, w, T, { amount: 4, reason: ' ' }));
      out.m11 = { forbidden: outc(f), notfound: outc(g), reason: outc(h), obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm12a'); try { const T = await mkMesaPaid(w, { closeTable: true }); await closeA(w); const cn = await K.conns(w); const x = await openHeldThenRefund(w, cn, 'first_open', (c) => mesaRefund(c, w, T, { amount: 4 })); out.m12a = { ...x, obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await W(tpl, 'm12c'); try { const T = await mkMesaPaid(w, { closeTable: true }); await closeA(w); const cn = await K.conns(w); const x = await openHeldThenRefund(w, cn, 'open', (c) => mesaRefund(c, w, T, { amount: 4 })); out.m12c = { ...x, obs: await refundObs(w, T), inv: await economicAudit(w) }; } finally { await w.close(); } }
    return out; });
  logScen('M1-M12', m12);
  const P_ = m12.POST, B_ = m12.BASE;
  for (const t of ['BASE', 'POST']) { const x = m12[t];
    assert(`M1 [${t}] service A open, table CLOSED / OPEN: ok, PT table-scoped with service A (origin), event receipt A, sale A`, ['m1', 'm1b'].every((k) => x[k].rf === 'ok' && x[k].obs.scoped_table[0] && x[k].obs.pt_svc[0] === 'A' && x[k].obs.event_receipt[0] === 'A' && x[k].obs.event_sale[0] === 'A' && x[k].inv.length === 0), { m1: x.m1, m1b: x.m1b });
    assert(`M2 [${t}] NO service open, table CLOSED / OPEN: ALLOWED (table scope), PT.service_session_id = the table's origin A (closed), event receipt NULL, pointer NULL -- the existing contract`, ['m2', 'm2b'].every((k) => x[k].rf === 'ok' && x[k].obs.scoped_table[0] && x[k].obs.pt_svc[0] === 'A' && x[k].obs.event_receipt[0] === 'NULL' && x[k].ptr === 'NULL' && x[k].inv.length === 0), { m2: x.m2, m2b: x.m2b });
    assert(`M3 [${t}] B open: PT = A (origin), event receipt B, sale A`, x.m3.rf === 'ok' && x.m3.obs.pt_svc[0] === 'A' && x.m3.obs.event_receipt[0] === 'B' && x.m3.obs.event_sale[0] === 'A' && x.m3.inv.length === 0, x.m3);
    assert(`M6 [${t}] replay idempotent, replay AFTER the close idempotent, other hash 23505, exactly one refund`, x.m6.a === 'ok' && x.m6.b === 'ok(idempotent)' && x.m6.c === 'ok(idempotent)' && x.m6.d === '23505:MESA_REFUND_IDEMPOTENCY_CONFLICT' && x.m6.obs.n === 1 && x.m6.inv.length === 0, x.m6);
    assert(`M7-M9 [${t}] partial 5, partial 3, 5 > 4 = 55000 EXCEEDS_REMAINING, NULL = remaining 4, 55000 ALREADY_FULL`, x.m79.a === 'ok' && x.m79.b === 'ok' && x.m79.c === '55000:MESA_REFUND_EXCEEDS_REMAINING' && x.m79.d === 'ok' && Number(x.m79.dAmt) === 4 && x.m79.e === '55000:MESA_REFUND_ALREADY_FULL' && JSON.stringify(x.m79.obs.amounts) === '[5,3,4]' && x.m79.inv.length === 0, x.m79);
    assert(`M10 [${t}] payment at A, full refund while B is open: PT = A, event receipt B`, x.m10.rf === 'ok' && x.m10.obs.pt_svc[0] === 'A' && x.m10.obs.event_receipt[0] === 'B' && x.m10.obs.amounts[0] === 12 && x.m10.inv.length === 0, x.m10);
    assert(`M11 [${t}] off-service Mesa refund keeps its errors: operator = 42501 MESA_REFUND_FORBIDDEN, unknown transaction = P0002, blank reason = 22023; nothing written`, x.m11.forbidden === '42501:MESA_REFUND_FORBIDDEN' && x.m11.notfound === 'P0002:MESA_TRANSACTION_NOT_FOUND' && x.m11.reason === '22023:MESA_REFUND_REASON_REQUIRED' && x.m11.obs.n === 0, x.m11);
    assert(`M12a [${t}] first-open intake uncommitted: the Mesa refund waits on the workspace row, then event receipt B`, !!x.m12a.wait && x.m12a.wait.rel === 'workspaces' && x.m12a.res.ok && x.m12a.obs.event_receipt[0] === 'B' && x.m12a.obs.pt_svc[0] === 'A' && x.m12a.inv.length === 0, x.m12a);
  }
  assert('M1-M3 / M6-M11 BASE == POST, field by field (Mesa contract unchanged with an open service AND without one)', ['m1', 'm1b', 'm2', 'm2b', 'm3', 'm6', 'm79', 'm10', 'm11'].every((k) => JSON.stringify(B_[k]) === JSON.stringify(P_[k])), ['m1', 'm2', 'm2b', 'm3', 'm6', 'm79', 'm10', 'm11'].filter((k) => JSON.stringify(B_[k]) !== JSON.stringify(P_[k])));
  assert('M4 [BASE] (negative control) close in flight: the Mesa refund queues on the service row and its event receipt is the CLOSED A', !!B_.m4.wait && B_.m4.wait.rel === 'service_sessions' && B_.m4.res.ok && B_.m4.obs.event_receipt[0] === 'A' && B_.m4.obs.event_receipt_st[0] === 'closed' && B_.m4.late === 1, B_.m4);
  assert('M4 [POST] close in flight: the Mesa refund WAITS at the pointer (service_session_state, blocked by the closer), then succeeds with event receipt NULL (no service open), PT = A (origin); NO refusal (Mesa contract), no late receipt',
    !!P_.m4.wait && P_.m4.wait.rel === 'service_session_state' && P_.m4.wait.blockers.includes(P_.m4.closerPid) && P_.m4.res.ok && P_.m4.obs.event_receipt[0] === 'NULL' && P_.m4.obs.pt_svc[0] === 'A' && P_.m4.late === 0 && P_.m4.inv.length === 0, P_.m4);
  assert('M5 [POST] the Mesa refund that has decided holds the pointer FOR SHARE (FU / NKU conflict, SH / KS compatible); the close waits for it at the pointer; refund ok with event receipt A; close V3_CLOSED',
    P_.m5.probes.FU === 'conflict' && P_.m5.probes.NKU === 'conflict' && P_.m5.probes.SH === 'acquired' && P_.m5.probes.KS === 'acquired' && !!P_.m5.wc && P_.m5.wc.rel === 'service_session_state' && P_.m5.wc.blockers.includes(P_.m5.refundPid) && P_.m5.rp.ok && P_.m5.close === 'V3_CLOSED' && P_.m5.obs.event_receipt[0] === 'A' && P_.m5.inv.length === 0, P_.m5);
  assert('M5 [BASE] (negative control) no lock on the pointer (all probes acquired), the close queues on the service row', Object.values(B_.m5.probes).every((x) => x === 'acquired') && !!B_.m5.wc && B_.m5.wc.rel === 'service_sessions', B_.m5);
  assert('M12c [BASE] (negative control) explicit open uncommitted: the Mesa refund reads the stale NULL pointer (event receipt NULL although B is being opened)', !B_.m12c.wait && B_.m12c.res.ok && B_.m12c.obs.event_receipt[0] === 'NULL', B_.m12c);
  assert('M12c [POST] explicit open uncommitted: the Mesa refund waits at the pointer, then event receipt B', !!P_.m12c.wait && P_.m12c.wait.rel === 'service_session_state' && P_.m12c.res.ok && P_.m12c.obs.event_receipt[0] === 'B' && P_.m12c.inv.length === 0, P_.m12c);
  return true;
}

// ── P6 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const P = K.PARTIES; const { ORDc, TSc } = K; const ENTc = (name, uid) => K.obj(name, 'row', { k: 'ENT', uid }); const PTc = (name, id) => K.obj(name, 'row', { k: 'PT', id });
const rpc = (sql, args) => (c) => c.query(sql, args).then((r) => r.rows[0].r);
const withTrip = async (w) => { const d = await K.dispatchedOrder(w); await w.su.query('INSERT INTO public.service_incidents (service_session_id, order_id) VALUES ($1, $2)', [w.A, d.id]); return d; };
P.W_REFUND_T = { name: 'W_REFUND_T', tx: false, async prep(w) { const X = await mkTermPaid(w, 12); return { objs: [ORDc('ORD:p', X.id), PTc('PT:orig', X.tx)], actor: 'owner', call: (c) => orderRefund(c, w, X, { amount: 3 }) }; } };
P.W_MREFUND_T = { name: 'W_MREFUND_T', tx: false, async prep(w) { const T = await mkMesaPaid(w, { total: 10 }); return { objs: [TSc('TS:t2', T.table), PTc('PT:orig', T.tx), ORDc('ORD:m', T.id)], table: T.table, actor: 'owner', call: (c) => mesaRefund(c, w, T, { amount: 3 }) }; } };
P.W_CASH_T = { name: 'W_CASH_T', tx: false, async prep(w) { const O = await mkTermUnpaid(w, 10); return { objs: [ORDc('ORD:o', O.id), ENTc('ENT:o', O.order_uid)], actor: 'operator_backup', call: (c) => K.cashPay(c, w, O) }; } };
P.W_MPAY_T = { name: 'W_MPAY_T', tx: false, async prep(w) { const t = await K.mkTable(w, 2); const o1 = await K.mkTableOrder(w, t, 10); await terminal(w, o1.id);
  return { objs: [TSc('TS:t2', t), ORDc('ORD:o1', o1.id)], table: t, actor: 'operator_backup', call: rpc('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', K.rid('mp'), K.hex64(K.rid('mh')), null, null, null, '{}', false]) }; } };
P.W_OPCONF_T = { name: 'W_OPCONF_T', tx: false, fresh: true, cleanup: K.closeTripQuiet, async prep(w) { await K.closeTripQuiet(w); const d = await withTrip(w); return { objs: [ORDc('ORD:o', d.id), ENTc('ENT:o', d.order_uid)], actor: 'operator_backup', call: (c) => H.opConfirm(c, d.id, H.PAY({ method: 'efectivo' }), 'operator_backup') }; } };
P.W_RIDER_T = { name: 'W_RIDER_T', tx: false, fresh: true, cleanup: K.closeTripQuiet, async prep(w) { await K.closeTripQuiet(w); const d = await withTrip(w); return { objs: [ORDc('ORD:o', d.id), ENTc('ENT:o', d.order_uid)], actor: 'rider', call: (c) => H.riderStop(c, d.id, 'efectivo', `pay-order-${String(d.id).replace(/[^A-Za-z0-9_-]/g, '')}`) }; } };
P.W_ENSURE = { name: 'W_ENSURE', tx: false, async prep() { return { objs: [], actor: 'operator_primary', call: rpc("SELECT public.ensure_service_session('operator_primary','fb') AS r", []) }; } };
const FINDING_B_PAIRS = [   // the 27 pairs of the design (W_CLOSE / W_REFUND_HIST first: the second party's prep runs first)
  ['W_CLOSE', 'W_REFUND_T'], ['W_CLOSE', 'W_MREFUND_T'], ['W_REFUND_HIST', 'W_OPEN'], ['W_REFUND_HIST', 'I_FIRST'], ['W_REFUND_HIST', 'I_FIRST_PAID'],
  ['I_UNPAID', 'W_REFUND_T'], ['I_PAID_SAME', 'W_REFUND_T'], ['I_TABLE', 'W_MREFUND_T'], ['I_UNPAID', 'W_MREFUND_T'], ['I_PAID_SAME', 'W_MREFUND_T'],
  ['W_CASH_T', 'W_REFUND_T'], ['W_MPAY_T', 'W_MREFUND_T'], ['W_CASH_T', 'W_MREFUND_T'], ['W_MPAY_T', 'W_REFUND_T'],
  ['W_REFUND_T', 'W_REFUND_T'], ['W_REFUND_T', 'W_MREFUND_T'], ['W_MREFUND_T', 'W_MREFUND_T'],
  ['W_REFUND_T', 'W_CANCEL'], ['W_MREFUND_T', 'W_CANCEL_TABLE_B'], ['W_MREFUND_T', 'W_MOPEN_BUSY'],
  ['W_ENSURE', 'W_REFUND_T'], ['W_ENSURE', 'W_MREFUND_T'], ['W_OPCONF_T', 'W_REFUND_T'], ['W_RIDER_T', 'W_REFUND_T'], ['W_OPCONF_T', 'W_MREFUND_T'], ['W_RIDER_T', 'W_MREFUND_T'],
  ['W_REFUND_T', 'W_ADJ'],
];
const INTAKE_REFUND_PAIRS = [['I_UNPAID', 'W_REFUND_T'], ['I_PAID_SAME', 'W_REFUND_T'], ['I_TABLE', 'W_MREFUND_T'], ['I_UNPAID', 'W_MREFUND_T'], ['I_PAID_SAME', 'W_MREFUND_T']];
const TYPED_OK = /^(t1|t2):(55000:ORDER_REFUND_NO_OPEN_SERVICE|55000:MESA_SESSION_NOT_OPEN|23505:MESA_TABLE_ACCOUNT_OPEN|P0001:SERVICE_ACTIVE_ORDERS_NOT_RESOLVED)/;
async function sweepSet(tpl, pairs, label) {
  const tot = { label, pairs: 0, runs: 0, exercised: 0, deadlocks: 0, timeouts: 0, raw23514: 0, untyped: [], integrity: [], perPair: [] };
  for (const [a, b] of pairs) {
    const r = await K.sweepPair(env, tpl, a, b);
    tot.pairs++; tot.runs += r.runs; tot.exercised += r.exercised; tot.deadlocks += r.deadlocks.length; tot.timeouts += r.timeouts;
    tot.raw23514 += r.unexpected.filter((x) => /:23514:/.test(x)).length;
    for (const x of r.unexpected) if (!TYPED_OK.test(x) && !/:23514:/.test(x)) tot.untyped.push(`${a} x ${b} ${x}`);
    tot.integrity.push(...r.integrity.map((x) => `${a} x ${b}: ${x}`));
    tot.perPair.push({ pair: `${a} x ${b}`, exercised: r.exercised, deadlocks: r.deadlocks.length, timeouts: r.timeouts, errors: r.unexpected.reduce((m, x) => { const k = x.split(':').slice(1, 3).join(':'); m[k] = (m[k] || 0) + 1; return m; }, {}) });
    console.log(`  INFO  [${label}] ${a} x ${b}: exercised=${r.exercised} deadlocks=${r.deadlocks.length} timeouts=${r.timeouts} integrity=${JSON.stringify(r.integrity)} errors=${JSON.stringify(tot.perPair[tot.perPair.length - 1].errors)}`);
  }
  console.log(`  INFO  [${label}] TOTAL pairs=${tot.pairs} exercised=${tot.exercised} deadlocks=${tot.deadlocks} timeouts=${tot.timeouts} raw23514=${tot.raw23514}`);
  return tot;
}
async function phaseSweeps() {
  section('F6 LOCK GRAPH -- the 27 Finding B pairs on POST (both directions, every candidate lock object): 40P01 = 0, timeouts = 0, no raw 23514; two NEGATIVE CONTROLS must still deadlock');
  const pairs = QUICK ? FINDING_B_PAIRS.slice(0, 9) : FINDING_B_PAIRS;
  const post = await sweepSet(env.tpl.post, pairs, 'POST');
  assert(`POST-146: ${post.pairs} pairs, ${post.exercised} exercised lock-level interleavings: 0 deadlocks (${post.deadlocks}), 0 timeouts (${post.timeouts}), integrity + state invariants green, every pair exercised`,
    post.deadlocks === 0 && post.timeouts === 0 && post.integrity.length === 0 && post.perPair.every((x) => x.exercised > 0) && post.pairs === pairs.length, { deadlocks: post.deadlocks, timeouts: post.timeouts, integrity: post.integrity.slice(0, 4), zero: post.perPair.filter((x) => !x.exercised).map((x) => x.pair) });
  assert(`POST-146 sweeps: NO raw 23514 anywhere and only TYPED refusals (ORDER_REFUND_NO_OPEN_SERVICE / MESA_SESSION_NOT_OPEN / MESA_TABLE_ACCOUNT_OPEN / SERVICE_ACTIVE_ORDERS_NOT_RESOLVED)`, post.raw23514 === 0 && post.untyped.length === 0, { raw: post.raw23514, untyped: post.untyped.slice(0, 5) });
  if (QUICK && process.env.FB_SKIP_CONTROLS === '1') return true;
  // NEGATIVE CONTROL 1: L (the lifecycle advisory lock) taken INSIDE the refund writers, after W -- the bench must still see the deadlock
  const addL = async (su) => { await su.query('SET ROLE postgres'); try { for (const sig of [SIG.order, SIG.mesa]) { const d = (await su.query('SELECT pg_get_functiondef($1::regprocedure) AS d', [sig])).rows[0].d;
    if (!d.includes('-- 146:BEGIN refund_receipt_pointer_lock\n')) throw new Error('146 block not found in ' + sig);
    await su.query(d.replace('-- 146:BEGIN refund_receipt_pointer_lock\n', "-- 146:BEGIN refund_receipt_pointer_lock\n  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));\n")); } } finally { await su.query('RESET ROLE'); } };
  const tplL = await buildDerived('ctl_L', [addL], env.tpl.post);
  const ctlL = await sweepSet(tplL, INTAKE_REFUND_PAIRS, 'NEG_L_IN_WRITER');
  assert(`NEGATIVE CONTROL 1 -- L taken inside the refund writers (after W): the intake x refund sweeps DEADLOCK (${ctlL.deadlocks} / ${ctlL.exercised}): the bench is sensitive to the rejected design`, ctlL.deadlocks > 0, { deadlocks: ctlL.deadlocks, per: ctlL.perPair.map((x) => `${x.pair}:${x.deadlocks}`) });
  // NEGATIVE CONTROL 2: the 146 bodies FORCED onto a database WITHOUT 143 (PRE + 144; the file's own guards bypassed) -- the prerequisite is necessary
  const stmts = createStatements(readAny(F146));
  if (stmts.length !== 2) throw new Error('harness: the two CREATE statements of 146 were not found');
  const force = async (su) => { await su.query('SET ROLE postgres'); try { for (const s of stmts) await su.query(s); } finally { await su.query('RESET ROLE'); } };
  const tplNo143 = await buildDerived('ctl_no143', [force], env.tpl.pre144);
  { const s = await cloneSu(tplNo143, 'ctlchk'); const ok = (await md5Of(s, SIG.order)) === NEW_PINS.order && (await md5Of(s, SIG.mesa)) === NEW_PINS.mesa && !(await md5Of(s, SIG.prelude)); await s.end();
    assert('negative control 2 template: the 146 bodies are installed and 143 is absent', ok); }
  const ctl2 = await sweepSet(tplNo143, INTAKE_REFUND_PAIRS, 'NEG_146_WITHOUT_143');
  assert(`NEGATIVE CONTROL 2 -- 146 forced WITHOUT 143: the intake x refund sweeps DEADLOCK (${ctl2.deadlocks} / ${ctl2.exercised}): the 143 prerequisite guard is necessary`, ctl2.deadlocks > 0, { deadlocks: ctl2.deadlocks, per: ctl2.perPair.map((x) => `${x.pair}:${x.deadlocks}`) });
  const postIntake = post.perPair.filter((x) => INTAKE_REFUND_PAIRS.some(([a, b]) => x.pair === `${a} x ${b}`));
  assert('...while the same five intake x refund pairs on POST (143 + 144 + 145 + 146) are deadlock-free', postIntake.length === (QUICK ? postIntake.length : 5) && postIntake.every((x) => x.deadlocks === 0), postIntake);
  return true;
}

// ── P7 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseRegress() {
  section('F7 FUNCTIONAL REGRESSION (differential PRE vs BASE vs POST, service OPEN): refunds, payments, lineage and projections are observationally identical; the ONLY intended difference is the off-service order refund');
  const NRM = (o) => JSON.stringify(o).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/#[A-Z0-9]+[0-9]{5}/g, '#ID').replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)/g, '<ts>')
    .replace(/\b(cash|mp|mr|rf|mh|rh)_[0-9a-f]{32}\b/g, '<req>').replace(/\bT\d+\b/g, 'T<n>').replace(/pay-order-[A-Za-z0-9_-]+/g, 'pay-order-<id>').replace(/"auditId":\d+/g, '"auditId":<n>');
  const battery = async (tpl) => { const out = []; const say = (l, o) => out.push({ l, o: NRM(o) });
    const att = async (l, fn) => { try { say(l, { ok: await fn() }); } catch (e) { say(l, { err: e.code, msg: String(e.message).slice(0, 100) }); } };
    const w = await K.world(env, tpl, 'rg', { deadlockMs: 300 });
    try {
      const P1 = await mkTermPaid(w, 12); const P2 = await mkTermPaid(w, 9); const T1 = await mkMesaPaid(w, { total: 10, closeTable: true }); const T2 = await mkMesaPaid(w, { total: 8 });
      const q = (n, h) => ({ reqId: 'rf_' + String(n).repeat(32).slice(0, 32), hash: K.hex64(h) });
      await att('order refund partial 5', () => orderRefund(w.svc, w, P1, { amount: 5, ...q(1, 'o1') })); say('order refund partial [obs]', await refundObs(w, P1));
      await att('order refund replay', () => orderRefund(w.svc, w, P1, { amount: 5, ...q(1, 'o1') }));
      await att('order refund idempotency conflict', () => orderRefund(w.svc, w, P1, { amount: 5, reqId: q(1, 'o1').reqId, hash: K.hex64('other') }));
      await att('order refund replay by another admin (audit row)', () => orderRefund(w.svc, w, P1, { amount: 5, ...q(1, 'o1'), actor: 'owner' }));
      await att('order refund partial 3', () => orderRefund(w.svc, w, P1, { amount: 3, ...q(2, 'o2') }));
      await att('order refund exceeds', () => orderRefund(w.svc, w, P1, { amount: 9, ...q(3, 'o3') }));
      await att('order refund full remaining', () => orderRefund(w.svc, w, P1, { ...q(4, 'o4') }));
      await att('order refund already full', () => orderRefund(w.svc, w, P1, { ...q(5, 'o5') })); say('order refunds [obs]', await refundObs(w, P1));
      await att('order refund auth (operator)', () => orderRefund(w.svc, w, P2, { amount: 1, ...q(6, 'o6'), actor: 'operator_backup' }));
      await att('order refund auth (rider)', () => orderRefund(w.svc, w, P2, { amount: 1, ...q(6, 'o6'), actor: 'rider' }));
      await att('order refund wrong transaction', () => orderRefund(w.svc, w, P2, { amount: 1, ...q(7, 'o7'), tx: '00000000-0000-4000-8000-000000000001' }));
      await att('order refund wrong order (tx of another order)', () => orderRefund(w.svc, w, P2, { amount: 1, ...q(8, 'o8'), tx: P1.tx }));
      await att('order refund of a Mesa transaction', () => orderRefund(w.svc, w, P2, { amount: 1, ...q(9, 'o9'), tx: T1.tx }));
      await att('order refund invalid amount', () => orderRefund(w.svc, w, P2, { amount: -1, ...q('a', 'oa') }));
      await att('order refund reason required', () => orderRefund(w.svc, w, P2, { amount: 1, ...q('b', 'ob'), reason: '' }));
      await att('order refund meta invalid', () => orderRefund(w.svc, w, P2, { amount: 1, ...q('c', 'oc'), meta: { token: 'x' } }));
      await att('order refund unknown order', () => orderRefund(w.svc, w, P2, { amount: 1, ...q('d', 'od'), uid: '00000000-0000-4000-8000-000000000002' }));
      const mq = (n, h) => ({ reqId: 'mr_' + String(n).repeat(32).slice(0, 32), hash: K.hex64(h) });
      await att('mesa refund partial 4', () => mesaRefund(w.svc, w, T1, { amount: 4, ...mq(1, 'm1') })); say('mesa refund partial [obs]', await refundObs(w, T1));
      await att('mesa refund replay', () => mesaRefund(w.svc, w, T1, { amount: 4, ...mq(1, 'm1') }));
      await att('mesa refund exceeds', () => mesaRefund(w.svc, w, T1, { amount: 7, ...mq(2, 'm2') }));
      await att('mesa refund full remaining', () => mesaRefund(w.svc, w, T1, { ...mq(3, 'm3') }));
      await att('mesa refund already full', () => mesaRefund(w.svc, w, T1, { ...mq(4, 'm4') })); say('mesa refunds [obs]', await refundObs(w, T1));
      await att('mesa refund auth (operator)', () => mesaRefund(w.svc, w, T2, { amount: 1, ...mq(5, 'm5'), actor: 'operator_backup' }));
      await att('mesa refund wrong table', () => mesaRefund(w.svc, w, T2, { amount: 1, ...mq(6, 'm6'), tx: T1.tx }));
      await att('mesa refund of an order transaction', () => mesaRefund(w.svc, w, T2, { amount: 1, ...mq(7, 'm7'), tx: P2.tx }));
      await att('mesa refund on the open table', () => mesaRefund(w.svc, w, T2, { amount: 2, ...mq(8, 'm8') })); say('mesa open-table refund [obs]', await refundObs(w, T2));
      say('projections', (await w.su.query(`SELECT o.cobrado, o.ya_pagado, o.metodo_pago, o.estado FROM public.ordenes o WHERE o.id = ANY($1) ORDER BY o.totale, o.id`, [[P1.id, P2.id, T1.id, T2.id]])).rows);
      say('table sessions untouched', (await w.su.query('SELECT status, closed_at IS NOT NULL AS c FROM public.table_sessions WHERE id = ANY($1) ORDER BY status', [[T1.table, T2.table]])).rows);
      // payment lineage (145 writers + M139 + M140), sale service
      const O1 = await K.mkUnpaid(w, 10); await att('cash full', () => K.cashPay(w.svc, w, O1, { reqId: 'cash_' + '1'.repeat(32), hash: K.hex64('rg1') }));
      say('cash lineage', (await w.su.query(`SELECT pt.service_session_id = $2 AS rA, e.event_service_session_id = $2 AS eA, e.service_session_id = $2 AS sA FROM public.payment_transactions pt JOIN public.order_financial_events e ON e.payment_transaction_id = pt.id JOIN public.payment_allocations a ON a.payment_transaction_id = pt.id WHERE a.order_uid = $1`, [O1.order_uid, w.A])).rows);
      await K.closeTripQuiet(w); const d2 = await K.dispatchedOrder(w); await att('rider stop + payment (M140)', () => H.riderStop(w.svc, d2.id, 'efectivo', `pay-order-${String(d2.id).replace(/[^A-Za-z0-9_-]/g, '')}`)); await K.closeTripQuiet(w);
      say('rider lineage', (await w.su.query(`SELECT pt.by_role, pt.service_session_id = $2 AS rA FROM public.payment_transactions pt JOIN public.payment_allocations a ON a.payment_transaction_id = pt.id WHERE a.order_id = $1`, [d2.id, w.A])).rows);
      say('ledger counts', await K.counts(w.su));
      say('invariants', await economicAudit(w));
    } finally { await w.close(); }
    const l1 = await K.world(env, tpl, 'rgl1', { deadlockMs: 300, noService: true });      // M139 off-service PAYMENT unchanged
    try { await att('late payment, no service (M139 off-service)', () => K.cashPay(l1.svc, l1, l1.hist));
      say('M139 off-service lineage', (await l1.su.query(`SELECT pt.service_session_id IS NULL AS rnull, pt.meta->>'off_service_receipt' AS flag, e.event_service_session_id IS NULL AS enull, e.service_session_id = $2 AS saleA FROM public.payment_transactions pt JOIN public.order_financial_events e ON e.payment_transaction_id = pt.id JOIN public.payment_allocations a ON a.payment_transaction_id = pt.id WHERE a.order_uid = $1`, [l1.hist.order_uid, l1.A])).rows);
      say('invariants (no service)', await economicAudit(l1)); } finally { await l1.close(); }
    return out; };
  const pre = await battery('fb_pre_tpl'), base = await battery(env.tpl.base), post = await battery(env.tpl.post);
  for (const r of post) console.log('  INFO  [POST battery] ' + r.l + ' = ' + r.o.slice(0, 400));
  const diff = (a, b) => a.map((r, i) => (b[i] && r.l === b[i].l && r.o === b[i].o) ? null : { label: r.l, a: r.o.slice(0, 220), b: b[i] && b[i].o.slice(0, 220) }).filter(Boolean);
  const dPB = diff(pre, post), dBB = diff(base, post);
  assert(`${post.length} observable steps with a service OPEN (order refund partial / replay / conflict / other-admin replay / partial / exceeds / full remaining / already full / auth / wrong transaction / wrong order / Mesa tx / invalid inputs, Mesa refund partial / replay / exceeds / full / already full / auth / wrong table / order tx / open table, projections, cash + rider payment lineage, M139 off-service payment, invariants): IDENTICAL on PRE (no 143-146), BASE (143-145) and POST (143-146)`,
    pre.length === post.length && base.length === post.length && dPB.length === 0 && dBB.length === 0, { dPB: dPB.slice(0, 3), dBB: dBB.slice(0, 3) });
  const at = (l) => (post.find((r) => r.l === l) || { o: '' }).o;
  assert('the battery is not vacuous: refunds and payments succeeded, the typed errors are the expected ones, the ledger balances (invariants empty)',
    ['order refund partial 5', 'order refund full remaining', 'mesa refund partial 4', 'mesa refund full remaining', 'cash full', 'rider stop + payment (M140)', 'late payment, no service (M139 off-service)'].every((k) => /^\{"ok":/.test(at(k)))
    && /ORDER_REFUND_EXCEEDS_REMAINING/.test(at('order refund exceeds')) && /ORDER_REFUND_ALREADY_FULL/.test(at('order refund already full')) && /ORDER_REFUND_FORBIDDEN/.test(at('order refund auth (operator)'))
    && /ORDER_REFUND_TRANSACTION_MISMATCH/.test(at('order refund wrong order (tx of another order)')) && /ORDER_REFUND_NOT_CHECK_CENTRIC/.test(at('order refund of a Mesa transaction')) && /MESA_REFUND_TRANSACTION_MISMATCH/.test(at('mesa refund wrong table'))
    && /"idempotent":true/.test(at('order refund replay')) && /"idempotent":true/.test(at('mesa refund replay')) && at('invariants') === '[]' && at('invariants (no service)') === '[]'
    && /"rnull":true,"flag":"true","enull":true,"salea":true/.test(at('M139 off-service lineage')) && /"by_role":"rider"/.test(at('rider lineage')), post.map((r) => r.l + '=' + r.o.slice(0, 80)));
  // the ONE intended difference, isolated: the order refund with no service open at its serialization point; the Mesa refund has none
  const offsvc = async (tpl) => { const w = await K.world(env, tpl, 'rgoff', { deadlockMs: 300 }); try { const P1 = await mkTermPaid(w, 12); const T1 = await mkMesaPaid(w, { total: 10, closeTable: true }); await closeA(w);
    const o = await okp(orderRefund(w.svc, w, P1, { amount: 5 })); const m = await okp(mesaRefund(w.svc, w, T1, { amount: 4, reqId: 'mr_' + 'f'.repeat(32), hash: K.hex64('mo') }));
    return { order: o.ok ? 'ok' : `${o.err}:${o.msg.split(' ')[0]}`, mesa: NRM(m), mesaObs: NRM(await refundObs(w, T1)), orderObs: (await refundObs(w, P1)).n, inv: await economicAudit(w) }; } finally { await w.close(); } };
  const oPre = await offsvc('fb_pre_tpl'), oBase = await offsvc(env.tpl.base), oPost = await offsvc(env.tpl.post);
  console.log('  INFO  off-service order refund: PRE=' + oPre.order + ' BASE=' + oBase.order + ' POST=' + oPost.order);
  for (const [t, x] of [['PRE', oPre], ['BASE', oBase], ['POST', oPost]]) console.log(`  INFO  off-service Mesa refund [${t}]: ${x.mesa.slice(0, 300)} | ${x.mesaObs}`);
  assert('THE ONLY INTENDED DIFFERENCE: the order refund with NO service open is RAW 23514 on PRE and BASE and 55000 ORDER_REFUND_NO_OPEN_SERVICE on POST; nothing written in any case', /^23514:/.test(oPre.order) && /^23514:/.test(oBase.order) && oPost.order === '55000:ORDER_REFUND_NO_OPEN_SERVICE' && oPre.orderObs === 0 && oBase.orderObs === 0 && oPost.orderObs === 0, { oPre: oPre.order, oBase: oBase.order, oPost: oPost.order });
  assert('...and the Mesa refund with NO service open is IDENTICAL on PRE, BASE and POST (allowed, table-scoped, PT = origin A, event receipt NULL): no contract difference', oPre.mesa === oPost.mesa && oBase.mesa === oPost.mesa && oPre.mesaObs === oPost.mesaObs && oBase.mesaObs === oPost.mesaObs && /^\{"ok":true,"v":\{"ok":true/.test(oPost.mesa) && /"event_receipt":\["NULL"\]/.test(oPost.mesaObs) && /"pt_svc":\["A"\]/.test(oPost.mesaObs) && oPost.inv.length === 0, { pre: oPre.mesaObs, post: oPost.mesaObs });
  return true;
}

// ── P8 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseStress() {
  section('F8 NATURAL RACES (no forced pauses): refund x close x open x intake with jitter on POST -- 0 deadlocks, invariants green, no refund receipt on an already-closed service, no raw 23514');
  const rounds = R(30); const tally = {}; let dl = 0, invs = 0, late = 0, raw = 0, other = {};
  for (const kind of ['order', 'mesa']) {
    for (let i = 0; i < rounds; i++) {
      const w = await K.world(env, env.tpl.post, 'nat', { deadlockMs: 200 });
      try {
        let call; let X;
        if (kind === 'order') { X = await mkTermPaid(w, 12); call = (c) => orderRefund(c, w, X, { amount: 4 }); }
        else { X = await mkMesaPaid(w, { total: 10, closeTable: i % 2 === 0 }); call = (c) => mesaRefund(c, w, X, { amount: 4 }); }
        const cn = await K.conns(w); const t3 = await w.client('c8-t3'); const t4 = await w.client('c8-t4'); const corr = await H.seedCloseable({ su: w.su }, w.A);
        const jobs = [
          (async () => { await delay(Math.floor(Math.random() * 14)); return okp(H.closeV3(cn.T1, w.A, corr)); })(),
          (async () => { await delay(Math.floor(Math.random() * 14)); return okp(call(cn.T2)); })(),
          (async () => { await delay(Math.floor(Math.random() * 20)); return okp(openB(t3)); })(),
          (async () => { await delay(Math.floor(Math.random() * 20)); return okp((async () => { await t4.query('BEGIN'); try { const r = await K.insertOrder(t4, { id: K.nextId('#NR'), totale: 9 }); await t4.query('COMMIT'); return r; } catch (e) { await t4.query('ROLLBACK').catch(() => {}); throw e; } })()); })(),
        ];
        const res = await Promise.all(jobs);
        dl += res.filter((x) => x.err === '40P01').length; raw += res.filter((x) => x.err === '23514').length;
        for (const x of res) if (x.err && !['40P01', '23514'].includes(x.err)) { const k = `${x.err}:${(x.msg || '').split(' ')[0]}`; other[k] = (other[k] || 0) + 1; }
        await setB(w); const o = await refundObs(w, X); const k = `${kind}:${res[1].ok ? 'ok ' + (o.event_receipt[0] || '?') : res[1].err + ':' + (res[1].msg || '').split(' ')[0]}`; tally[k] = (tally[k] || 0) + 1;
        late += await lateRefunds(w); if ((await economicAudit(w)).length) invs++;
      } finally { await w.close(); }
    }
  }
  console.log(`  INFO  natural races outcomes ${JSON.stringify(tally)} other ${JSON.stringify(other)}`);
  const typedOnly = Object.keys(other).every((k) => /^(55000:ORDER_REFUND_NO_OPEN_SERVICE|P0001:SERVICE_ACTIVE_ORDERS_NOT_RESOLVED|P0001:V3_|55000:|P0001:)/.test(k));
  assert(`natural races refund x close x open x intake (${rounds * 2} rounds x 4 operations, order + Mesa): 0 deadlocks (${dl}), invariants green (${invs} rounds with a violation), no refund receipt created after its service closed (${late}), no raw 23514 (${raw}), only typed refusals`,
    dl === 0 && invs === 0 && late === 0 && raw === 0 && typedOnly, { dl, invs, late, raw, other, tally });
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PHASES = { provenance: phaseProvenance, isolation: phaseIsolation, apply: phaseApply, drift: phaseDrift, rollback: phaseRollback, scenarios: phaseScenarios, sweeps: phaseSweeps, regress: phaseRegress, stress: phaseStress };
async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'fb-admin' });
    await rt.ensureRoles(admin);
    env = { cl, admin, tpl: {}, clone: async (tpl, label) => { const name = `fb_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`.slice(0, 60); await rt.cloneDb(admin, tpl, name); return name; } };
    const names = only.length ? only : Object.keys(PHASES);
    if (!names.includes('provenance')) names.unshift('provenance');
    for (const n of names) {
      if (!PHASES[n]) { assert(`unknown phase ${n}`, false); continue; }
      const t0 = Date.now();
      try { await PHASES[n](); } catch (e) { section(`phase ${n} crashed`); assert(`phase ${n} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`); }
      console.log(`  INFO  phase ${n}: ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  if (process.env.FB_EVIDENCE_OUT) fs.writeFileSync(process.env.FB_EVIDENCE_OUT, JSON.stringify(state.results, null, 1));
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
