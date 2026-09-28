'use strict';
// FINDING A (payment x service close) -- migration 145 certification runner. Ephemeral PostgreSQL only; never staging, never production.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres and pg> [W3_PG_DATA_ROOT=<tmp>] \
//     node ci/giro-authority-certification/harness/runPaymentCloseFix.js [phase ...]
//
// Phases (default: all): provenance apply drift rollback serialize scenarios sweeps regress stress
//   PCF_QUICK=1  fewer rounds / pairs (smoke);  PCF_FWD145 / PCF_RBK145 (absolute or repo-relative) run the SAME scenarios against a mutated migration (mutation check).
//
// Databases (all staging-shaped: real ledger through 138, REAL 139 + 140, the audit's real bodies, the 27 staging triggers; see c8LockOrderKit.js):
//   PRE  = that database                                  (no 143 / 144 / 145)
//   BASE = PRE + migration FILES 143 + 144                (the frozen C8 candidate: the NEGATIVE CONTROL, must show the defect)
//   POST = BASE + migration FILE 145                      (must not)
// The primary proof of the serialization contract does NOT rely on payment.created_at (transaction timestamp): it uses controlled transactions, row-lock probes from a third
// connection (SELECT ... FOR <mode> NOWAIT on the lifecycle pointer), pg_blocking_pids, pg_locks (which relation a blocked backend is queued on), the observed pointer and the receipt
// observed after the release. The created_at audit is reported as a supplementary signal only.

const fs = require('fs');
const path = require('path');
const rt = require('./pgRuntime');
const { section, assert, state } = require('./lib');
const DED = require('./runDeliveryEconomyDecoupling');
const K = require('./c8LockOrderKit');
const H = K.H; const delay = K.delay;

const M = (n) => `migrations/${n}`;
const F143 = M('2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql');
const R143 = M('2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql');
const F144 = M('2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql');
const F145 = process.env.PCF_FWD145 || M('2026-09-24_payment_close_receipt_lock_v1_migration_145.sql');
const R145 = process.env.PCF_RBK145 || M('2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql');
const readAny = (rel) => (path.isAbsolute(rel) ? fs.readFileSync(rel, 'utf8') : rt.readRepo(rel));
const os = require('os');
const SCRATCH = process.env.PCF_SCRATCH || os.tmpdir();
const stripPrereq = (sql) => { const a = sql.indexOf('  -- 0.a prerequisite'), b = sql.indexOf('  -- 0.b the two writers'); if (a < 0 || b < a) throw new Error('harness: prerequisite block not found'); return sql.slice(0, a) + sql.slice(b); };
const tmpFile = (name, text) => { const d = path.join(SCRATCH, 'pcf_tmp'); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, name); fs.writeFileSync(f, text); return f; };
const QUICK = process.env.PCF_QUICK === '1';
const R = (n) => Math.max(QUICK ? 3 : 4, Math.round(n * (QUICK ? 0.25 : 1)));
const ENSURE_FIXTURE = path.join(__dirname, '..', 'fixture', 'ensure_service_session_lockonly_v1.sql');

const ORDER_PIN = 'ea4fe577feddbd2ba6f6ae42695feba6';      // POST-M140 order_post_payment_v1
const MESA_PIN = '9543ab52d9933ffd52cc7f9b595c4cfb';       // live / staging mesa_post_payment_v1
const STAGING_PRE140_ORDER = '778cd30008632707e47a372e6afa5640';   // the staging body TODAY (ledger 138): NOT the predecessor
const REFUND_MD5 = { order_post_refund_v1: 'f057928b8f6fade25d38d4bb1d3ed09a', mesa_post_refund_v1: '62f0e128a6e5d0623b0423a69f0329d3' };
const SIG_ORDER = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)';
const SIG_MESA = 'public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)';
const SIG_ORDER_REFUND = 'public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)';
const SIG_MESA_REFUND = 'public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)';
const SVC_ONLY = '{postgres=X/postgres,service_role=X/postgres}';
const M_BEGIN = '-- 145:BEGIN receipt_service_pointer_lock';
const RECEIPT_SELECT = "  SELECT ss.id INTO v_receipt_service_id\n    FROM public.service_session_state sst\n    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'\n   WHERE sst.singleton = true;\n";
// the two 145 body pins are read from the rollback guard (order first, mesa second): a mutated pair carries its own recomputed pins
const NEW_PINS = (() => { const t = readAny(R145); const g = (n) => new RegExp("\\('public\\." + n + "\\([^']*\\)', '" + n + "', '([0-9a-f]{32})'\\)").exec(t)[1]; return { order: g('order_post_payment_v1'), mesa: g('mesa_post_payment_v1') }; })();
const OWN_MIGRATION = new Map([[F145, 145]]);

// LATEST DEFINER (provenance only). The body a template is expected to carry for a writer is the one installed by the LAST
// migration applied to that template that (re)defines it -- scripts/economy139to146Preflight.js's FN table is the canonical record of
// the body each Economy migration installs (its `files` command binds every pin to the committed file). On this runner's own chain
// that is exactly this runner's migration (its pins read from its own files above, so a mutated file still carries its own pins); with
// later Economy migrations layered on top of POST (e.g. 146 + 147 + 148 through the one-line POST retarget that
// runPaymentCloseFixOnCandidate146.js performs) it is the later body -- order_post_payment_v1 is then the 148 body. Only provenance
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
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [sig])).rows[0];
async function cloneSu(tpl, label) {
  const db = await env.clone(tpl, label);
  const su = await rt.connect(env.cl, db, { name: `pcf-${label}` });
  su.db = db;
  return su;
}
async function applyTo(su, rel) { try { await DED.applyRepoAsPostgres(su, rel); return null; } catch (e) { return e; } }
async function buildDerived(name, files, from) {
  const su = await cloneSu(from, name + '_b'); const db = su.db;
  for (const f of files) { const e = await applyTo(su, f); if (e) { await su.end(); throw new Error(`template ${name}: ${f} -> ${e.message}`); } }
  await su.end();
  appliedOnTop[db] = (appliedOnTop[from] || []).concat(files.map(migrationNumber));
  return db;
}
const fnDrift = async (su, sig) => { const cur = (await su.query('SELECT pg_get_functiondef($1::regprocedure) AS d', [sig])).rows[0].d; await su.query(cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER\n')); };
const asPostgres = async (su, fn) => { await su.query('SET ROLE postgres'); try { await fn(); } finally { await su.query('RESET ROLE'); } };

// ── P0 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseProvenance() {
  section('D0 PROVENANCE -- PRE = the staging-shaped real-body chain (139 + 140 real); BASE = PRE + 143 + 144 (the frozen C8 candidate); POST = BASE + 145 (the FILE under test)');
  const rep = await K.buildPreTemplate(env, 'pcf_pre_tpl');
  assert('26 real function bodies were installed from the repo text whose md5 equals staging (a mismatch aborts the build)', rep.bodies === 26, rep);
  { const su = await rt.connect(env.cl, 'pcf_pre_tpl', { name: 'pcf-fixture' });
    try { await asPostgres(su, () => su.query(fs.readFileSync(ENSURE_FIXTURE, 'utf8'))); } finally { await su.end(); } }        // ensure_service_session (lock-only fixture of the staging function), in PRE / BASE / POST alike
  const su = await cloneSu('pcf_pre_tpl', 'prov');
  assert('PRE order_post_payment_v1 is the POST-M140 body (md5 ' + ORDER_PIN + ') -- NOT the staging body ' + STAGING_PRE140_ORDER + ' (staging is at ledger 138; 145 is applied only after 139 + 140)', (await md5Of(su, SIG_ORDER)) === ORDER_PIN && ORDER_PIN !== STAGING_PRE140_ORDER, await md5Of(su, SIG_ORDER));
  assert('PRE mesa_post_payment_v1 is the live body (md5 ' + MESA_PIN + ')', (await md5Of(su, SIG_MESA)) === MESA_PIN, await md5Of(su, SIG_MESA));
  assert('PRE refund writers are the staging bodies (order ' + REFUND_MD5.order_post_refund_v1 + ', mesa ' + REFUND_MD5.mesa_post_refund_v1 + ')', (await md5Of(su, SIG_ORDER_REFUND)) === REFUND_MD5.order_post_refund_v1 && (await md5Of(su, SIG_MESA_REFUND)) === REFUND_MD5.mesa_post_refund_v1);
  const carriers = [];
  for (const [n, sig] of [['order_post_payment_v1', SIG_ORDER], ['mesa_post_payment_v1', SIG_MESA], ['order_post_refund_v1', SIG_ORDER_REFUND], ['mesa_post_refund_v1', SIG_MESA_REFUND]]) carriers.push([n, (await srcOf(su, sig)).includes(RECEIPT_SELECT), /service_session_state WHERE singleton = true FOR SHARE/.test(await srcOf(su, sig))]);
  assert('PRE: the receipt-service SELECT is UNLOCKED in all four writers (the defect: no FOR SHARE on the pointer anywhere)', carriers.every(([, has, locked]) => has && !locked), carriers);
  assert('PRE has no prelude (143 absent)', (await md5Of(su, 'public.order_intake_lock_prelude_v1()')) === null);
  await su.end();
  env.tpl.pre = 'pcf_pre_tpl';
  appliedOnTop.pcf_pre_tpl = [139, 140];
  env.tpl.base = await buildDerived('base', [F143, F144], 'pcf_pre_tpl');
  env.tpl.post = await buildDerived('post', [F145], env.tpl.base);
  env.tpl.pre144 = await buildDerived('pre144', [F144], 'pcf_pre_tpl');
  const pb = await cloneSu(env.tpl.base, 'provb'), pp = await cloneSu(env.tpl.post, 'provp');
  assert('BASE carries 143 (prelude first BEFORE INSERT) and 144, and the two payment writers are still the predecessors', !!(await md5Of(pb, 'public.order_intake_lock_prelude_v1()')) && (await md5Of(pb, SIG_ORDER)) === ORDER_PIN && (await md5Of(pb, SIG_MESA)) === MESA_PIN);
  const postOrder = expectedBody(SIG_ORDER, env.tpl.post, { 145: NEW_PINS.order }), postMesa = expectedBody(SIG_MESA, env.tpl.post, { 145: NEW_PINS.mesa });
  assert('POST = BASE + 145 (' + appliedOnTop[env.tpl.post].join(' + ') + '): the two payment writers are the bodies of their LATEST definer in that chain (md5 ' + postOrder + ' / ' + postMesa + ')', (await md5Of(pp, SIG_ORDER)) === postOrder && (await md5Of(pp, SIG_MESA)) === postMesa, [await md5Of(pp, SIG_ORDER), await md5Of(pp, SIG_MESA)]);
  await pb.end(); await pp.end();
  return true;
}

// ── P1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseApply() {
  section('D1 APPLY -- guards + post-conditions pass; EXACTLY two catalog entries move (whole-catalog fingerprint); posture preserved; refunds and C8 objects untouched');
  const su = await cloneSu(env.tpl.base, 'apply');
  const fp0 = await DED.catalogFingerprint(su);
  const pos0 = { o: await posture(su, SIG_ORDER), m: await posture(su, SIG_MESA) };
  const frozen0 = { prelude: await md5Of(su, 'public.order_intake_lock_prelude_v1()'), cancel: await md5Of(su, 'public.order_cancel_v1(text,text,text,text,text,text,jsonb)'), ro: await md5Of(su, SIG_ORDER_REFUND), rm: await md5Of(su, SIG_MESA_REFUND) };
  let e = await applyTo(su, F145);
  assert('migration 145 applies cleanly on the C8 candidate (guards + post-conditions pass)', !e, e && `${e.code} ${e.message}`);
  if (e) { await su.end(); return false; }
  const fp1 = await DED.catalogFingerprint(su); const d = DED.fingerprintDiff(fp0, fp1);
  assert('145 changed EXACTLY two catalog entries: the bodies of order_post_payment_v1 and mesa_post_payment_v1 (no other function, trigger, table, column, index, constraint, grant)',
    d.length === 2 && d.every((x) => /^functions:public\.(order_post_payment_v1|mesa_post_payment_v1)\(/.test(x)) && d.some((x) => /order_post_payment_v1/.test(x)) && d.some((x) => /mesa_post_payment_v1/.test(x)), d);
  const pos1 = { o: await posture(su, SIG_ORDER), m: await posture(su, SIG_MESA) };
  assert('owner / SECURITY INVOKER / search_path / ACL / return type / arguments of both writers are exactly the pre-145 ones (service_role EXECUTE only)', JSON.stringify(pos0) === JSON.stringify(pos1) && pos1.o.acl === SVC_ONLY && pos1.m.acl === SVC_ONLY && !pos1.o.prosecdef && !pos1.m.prosecdef && pos1.o.cfg === '{"search_path=public, extensions, pg_temp"}' && !pos1.o.anon_x && !pos1.m.auth_x, { pos0, pos1 });
  assert('the installed bodies are the 145 bodies (md5 pins of the file)', (await md5Of(su, SIG_ORDER)) === NEW_PINS.order && (await md5Of(su, SIG_MESA)) === NEW_PINS.mesa);
  const so = await srcOf(su, SIG_ORDER), sm = await srcOf(su, SIG_MESA);
  const once = (s) => (s.split(M_BEGIN).length - 1) === 1;
  assert('the 145 marker is present exactly once per body and the lock sits immediately before the (unchanged) receipt-service SELECT, mode FOR SHARE', once(so) && once(sm)
    && so.includes('-- 145:END receipt_service_pointer_lock\n' + RECEIPT_SELECT) && sm.includes('-- 145:END receipt_service_pointer_lock\n' + RECEIPT_SELECT) && /PERFORM 1 FROM public\.service_session_state WHERE singleton = true FOR SHARE;/.test(so) && /PERFORM 1 FROM public\.service_session_state WHERE singleton = true FOR SHARE;/.test(sm));
  assert('the refund writers and the C8 objects (prelude, order_cancel_v1) are byte-identical: Finding B firewall + 143 / 144 untouched',
    (await md5Of(su, SIG_ORDER_REFUND)) === frozen0.ro && (await md5Of(su, SIG_MESA_REFUND)) === frozen0.rm && (await md5Of(su, 'public.order_intake_lock_prelude_v1()')) === frozen0.prelude && (await md5Of(su, 'public.order_cancel_v1(text,text,text,text,text,text,jsonb)')) === frozen0.cancel);
  { const svc = await rt.connect(env.cl, su.db, { role: 'service_role', name: 'pcf-svcprobe' });
    let ok = false, err = null; try { await svc.query('BEGIN'); await svc.query('SELECT 1 FROM public.service_session_state WHERE singleton = true FOR SHARE'); ok = true; } catch (x) { err = x.message; } finally { await svc.query('ROLLBACK').catch(() => {}); await svc.end(); }
    assert('service_role can take SELECT ... FOR SHARE on the lifecycle pointer under the real posture (SELECT + UPDATE privilege, RLS bypass)', ok, err); }
  e = await applyTo(su, F145);
  assert('a second apply of 145 is refused (typed guard: already applied)', !!e && /PAYMENT_CLOSE_LOCK refused: already applied/.test(e.message), e && e.message);
  assert('...and the refused second apply left NOTHING behind', DED.fingerprintDiff(fp1, await DED.catalogFingerprint(su)).length === 0);
  e = await applyTo(su, R145);
  assert('the rollback applies cleanly', !e, e && `${e.code} ${e.message}`);
  if (!e) {
    const fp2 = await DED.catalogFingerprint(su);
    assert('RB: CATALOG FINGERPRINT after the rollback == the pre-145 catalog, entry by entry (functions with md5 + owner + SECURITY + search_path + ACL, triggers, columns, indexes, constraints)', DED.fingerprintDiff(fp0, fp2).length === 0, DED.fingerprintDiff(fp0, fp2));
    assert('RB: both writers are the predecessors again (POST-M140 order body, live Mesa body), posture identical', (await md5Of(su, SIG_ORDER)) === ORDER_PIN && (await md5Of(su, SIG_MESA)) === MESA_PIN && JSON.stringify({ o: await posture(su, SIG_ORDER), m: await posture(su, SIG_MESA) }) === JSON.stringify(pos0));
    const e2 = await applyTo(su, R145);
    assert('a second rollback is refused (the bodies are no longer the 145 bodies)', !!e2 && /PAYMENT_CLOSE_LOCK rollback refused/.test(e2.message), e2 && e2.message);
    const e3 = await applyTo(su, F145);
    assert('forward re-applies cleanly after the rollback (round trip) and reproduces the first-apply catalog exactly', !e3 && DED.fingerprintDiff(fp1, await DED.catalogFingerprint(su)).length === 0, e3 && e3.message);
  }
  await su.end();
  // the prerequisite is 143 ALONE: 144 is not a (false) dependency of 145, and 144 without 143 does not satisfy it
  { const t143 = await buildDerived('only143', [F143], 'pcf_pre_tpl'); const s2 = await cloneSu(t143, 'only143');
    const fpA = await DED.catalogFingerprint(s2); const e = await applyTo(s2, F145);
    assert('145 APPLIES on PRE + 143 WITHOUT 144 (144 is not a dependency of 145: no false prerequisite) and installs exactly the 145 bodies', !e && (await md5Of(s2, SIG_ORDER)) === NEW_PINS.order && (await md5Of(s2, SIG_MESA)) === NEW_PINS.mesa && DED.fingerprintDiff(fpA, await DED.catalogFingerprint(s2)).length === 2, e && e.message);
    const er = await applyTo(s2, R145);
    assert('...and its rollback restores the pre-145 catalog exactly there too (no dependency on 144 in the rollback either)', !er && DED.fingerprintDiff(fpA, await DED.catalogFingerprint(s2)).length === 0, er && er.message);
    await s2.end();
    const s3 = await cloneSu(env.tpl.pre144, 'only144'); const fpB = await DED.catalogFingerprint(s3); const e3 = await applyTo(s3, F145);
    assert('145 on PRE + 144 WITHOUT 143 is REFUSED (144 does not satisfy the prerequisite) and leaves nothing behind', !!e3 && /PAYMENT_CLOSE_LOCK refused: migration 143 .* is not applied/.test(e3.message) && DED.fingerprintDiff(fpB, await DED.catalogFingerprint(s3)).length === 0, e3 ? e3.message : '(silently accepted)');
    await s3.end(); }
  return true;
}

// ── P2 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseDrift() {
  section('D2 DRIFT GUARDS -- fail closed: every violated precondition is REFUSED with a typed message and the refused migration leaves NOTHING behind');
  const cases = [
    ['143 is NOT applied (the single negative control of the prerequisite: the lock deadlocks against the old intake order)', 'pcf_pre_tpl', /PAYMENT_CLOSE_LOCK refused: migration 143 .* is not applied/, async () => {}],
    ['the 143 prelude trigger is missing', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing/, (su) => su.query('DROP TRIGGER a0_order_intake_lock_prelude_v1 ON public.ordenes')],
    ['the 143 prelude trigger is disabled', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing, disabled/, (su) => su.query('ALTER TABLE public.ordenes DISABLE TRIGGER a0_order_intake_lock_prelude_v1')],
    ['the 143 prelude function is missing', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: migration 143 .* is not applied/, (su) => su.query('DROP FUNCTION public.order_intake_lock_prelude_v1() CASCADE')],
    ['a BEFORE INSERT trigger of ordenes sorts before the prelude (the prelude is not first)', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: the 143 prelude is not the first BEFORE INSERT trigger/, (su) => su.query('CREATE TRIGGER "0_early" BEFORE INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.mesa_snapshot_order_lines_v1()')],
    ['order_post_payment_v1 drifted (one comment added)', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: order_post_payment_v1 is not the pinned predecessor body/, (su) => fnDrift(su, SIG_ORDER)],
    ['mesa_post_payment_v1 drifted (one comment added)', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: mesa_post_payment_v1 is not the pinned predecessor body/, (su) => fnDrift(su, SIG_MESA)],
    ['order_post_payment_v1 is the PRE-M140 staging body (the wrong predecessor)', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: order_post_payment_v1 is not the pinned predecessor body \(md5 mismatch: 778cd30008632707e47a372e6afa5640/, async (su) => {
      await su.query(K.realStatement('order_post_payment_v1', '2026-09-11_economic_writer_hardening_v1_migration_126.sql', 'raw', STAGING_PRE140_ORDER));
      if ((await md5Of(su, SIG_ORDER)) !== STAGING_PRE140_ORDER) throw new Error('harness: the staging pre-M140 body was not installed'); }],
    ['order_post_payment_v1 is missing', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: public\.order_post_payment_v1\(.*\) is missing/, (su) => su.query(`DROP FUNCTION ${SIG_ORDER}`)],
    ['mesa_post_payment_v1 is missing', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: public\.mesa_post_payment_v1\(.*\) is missing/, (su) => su.query(`DROP FUNCTION ${SIG_MESA}`)],
    ['an extra order_post_payment_v1 overload', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: order_post_payment_v1 has an unexpected overload set/, (su) => su.query('CREATE FUNCTION public.order_post_payment_v1(p_a integer) RETURNS integer LANGUAGE sql AS $x$ SELECT 1 $x$')],
    ['an extra mesa_post_payment_v1 overload', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: mesa_post_payment_v1 has an unexpected overload set/, (su) => su.query('CREATE FUNCTION public.mesa_post_payment_v1(p_a integer) RETURNS integer LANGUAGE sql AS $x$ SELECT 1 $x$')],
    ['service_role has no SELECT privilege on service_session_state', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: service_role lacks SELECT \+ UPDATE/, (su) => su.query('REVOKE SELECT ON public.service_session_state FROM service_role')],
    ['service_role has no UPDATE privilege on service_session_state (FOR SHARE would fail with 42501)', env.tpl.base, /PAYMENT_CLOSE_LOCK refused: service_role lacks SELECT \+ UPDATE/, (su) => su.query('REVOKE UPDATE ON public.service_session_state FROM service_role')],
  ];
  for (const [label, tpl, re, inject] of cases) {
    const su = await cloneSu(tpl, 'drift');
    await asPostgres(su, () => inject(su));
    const fp0 = await DED.catalogFingerprint(su);
    const e = await applyTo(su, F145);
    assert(`145 against "${label}" is REFUSED (typed guard)`, !!e && re.test(e.message), e ? e.message : '(silently accepted)');
    assert('...and the refused 145 left NOTHING behind (whole-catalog fingerprint unchanged; a divergent body is never overwritten)', DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)).length === 0, DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)));
    await su.end();
  }
  { const su = await cloneSu(env.tpl.base, 'driftrls');      // the role attribute is cluster-global: applied and restored inside one try / finally, no other database is in use meanwhile
    let e = null; let d = [];
    try { await su.query('ALTER TABLE public.service_session_state ENABLE ROW LEVEL SECURITY'); await su.query('ALTER ROLE service_role NOBYPASSRLS'); const fp0 = await DED.catalogFingerprint(su); e = await applyTo(su, F145); d = DED.fingerprintDiff(fp0, await DED.catalogFingerprint(su)); }
    finally { await su.query('ALTER ROLE service_role BYPASSRLS'); }
    assert('145 against "RLS enabled on service_session_state and service_role does not bypass it" is REFUSED (typed guard)', !!e && /PAYMENT_CLOSE_LOCK refused: row-level security is enabled on public\.service_session_state and service_role does not bypass it/.test(e.message), e ? e.message : '(silently accepted)');
    assert('...and the refused 145 left NOTHING behind', d.length === 0, d);
    await su.end(); }
  { const su = await cloneSu(env.tpl.base, 'driftrlsok');   // the staging posture: RLS enabled + service_role BYPASSRLS (the guard must ACCEPT it and the lock must work through the writers)
    await su.query('ALTER TABLE public.service_session_state ENABLE ROW LEVEL SECURITY');
    const e = await applyTo(su, F145);
    assert('145 against the STAGING posture (RLS enabled on service_session_state, service_role BYPASSRLS) is ACCEPTED', !e && (await md5Of(su, SIG_ORDER)) === NEW_PINS.order && (await md5Of(su, SIG_MESA)) === NEW_PINS.mesa, e && e.message);
    await su.end(); }
  return true;
}

// ── P3 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseRollback() {
  section('D3 ROLLBACK -- refuses over anything that is not exactly the 145 bodies; rollback order 145 before 143 restores the pre-143 catalog; the operational constraint is documented, not enforceable in 143\'s frozen file');
  for (const [which, sig, what] of [['order', SIG_ORDER, 'order_post_payment_v1'], ['mesa', SIG_MESA, 'mesa_post_payment_v1']]) {
    const su = await cloneSu(env.tpl.post, 'rbt');
    await asPostgres(su, () => fnDrift(su, sig));
    const m0 = await md5Of(su, sig); const e = await applyTo(su, R145);
    assert(`rollback over a TAMPERED ${what} is refused (md5 guard) and overwrites nothing`, !!e && /PAYMENT_CLOSE_LOCK rollback refused: .* is not the exact 145 body/.test(e.message) && (await md5Of(su, sig)) === m0 && (await md5Of(su, which === 'order' ? SIG_MESA : SIG_ORDER)) !== null, e && e.message);
    await su.end();
  }
  { const su = await cloneSu(env.tpl.base, 'rbnone'); const e = await applyTo(su, R145);
    assert('rollback without a prior apply is refused (the bodies are the predecessors, not the 145 bodies)', !!e && /PAYMENT_CLOSE_LOCK rollback refused/.test(e.message), e && e.message); await su.end(); }
  { const su = await cloneSu(env.tpl.post, 'rbord'); const fpPre144 = await (async () => { const s = await cloneSu(env.tpl.pre144, 'fp144'); const f = await DED.catalogFingerprint(s); await s.end(); return f; })();
    const a = await applyTo(su, R145); const b = await applyTo(su, R143);
    assert('OPERATIONAL ORDER (145 first, then 143): both rollbacks apply cleanly and the catalog is exactly PRE + 144 again', !a && !b && DED.fingerprintDiff(fpPre144, await DED.catalogFingerprint(su)).length === 0, [a && a.message, b && b.message, DED.fingerprintDiff(fpPre144, await DED.catalogFingerprint(su))]);
    await su.end(); }
  { const su = await cloneSu(env.tpl.post, 'rb143'); const fpBase = await (async () => { const s = await cloneSu(env.tpl.base, 'fpb'); const f = await DED.catalogFingerprint(s); await s.end(); return f; })();
    const b = await applyTo(su, R143);
    console.log('  INFO  143\'s FROZEN rollback run while 145 is applied: ' + (b ? 'refused (' + b.message.slice(0, 80) + ')' : 'ACCEPTED (nothing enforces the rollback order in 143\'s file) -> OPERATIONAL RULE, documented in the 145 forward / rollback headers, the manifest and the report: 145 is removed BEFORE 143'));
    console.log('  INFO  ...changed catalog entries vs BASE after that out-of-order rollback: ' + DED.fingerprintDiff(fpBase, await DED.catalogFingerprint(su)).length + ' (informative, not an assertion)');
    await su.end(); }
  return true;
}

// ── shared scenario plumbing ───────────────────────────────────────────────────────────────────────────────────────────────────────
const lbl = (w, id) => (id == null ? 'NULL' : id === w.A ? 'A' : id === w.B ? 'B' : 'other');
const okp = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ err: e.code || 'ERR', msg: String(e.message).slice(0, 90) }));
const mkTermUnpaid = async (w, t = 10) => { const O = await K.mkUnpaid(w, t); await w.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [O.id]); return O; };
const withTrip = async (w) => { const d = await K.dispatchedOrder(w); await w.su.query('INSERT INTO public.service_incidents (service_session_id, order_id) VALUES ($1, $2)', [w.A, d.id]); return d; };
const openB = (c) => c.query('SELECT public.open_operational_service_v1($1,$2,$3) AS r', ['operator_primary', 'next_service_of_business_day', 'pcf_open']).then((r) => r.rows[0].r);
const setB = async (w) => { const b = (await w.su.query(`SELECT id FROM public.service_sessions WHERE status='open'`)).rows[0]; w.B = b && b.id; };
const pointerOf = async (w) => lbl(w, (await w.su.query('SELECT current_session_id AS p FROM public.service_session_state WHERE singleton = true')).rows[0].p);
async function obs(w, O) {
  const q = O.order_uid
    ? { sql: `SELECT pt.id, pt.service_session_id AS r, rs.status AS st, (pt.meta->>'off_service_receipt') AS off, (rs.closed_at IS NOT NULL AND pt.created_at > rs.closed_at) AS late, pt.by_role,
        (SELECT count(*)::int FROM public.payment_allocations a WHERE a.payment_transaction_id = pt.id) AS allocs FROM public.payment_transactions pt JOIN public.payment_allocations pa ON pa.payment_transaction_id = pt.id
        LEFT JOIN public.service_sessions rs ON rs.id = pt.service_session_id WHERE pa.order_uid = $1 AND pt.kind = 'payment' ORDER BY pt.created_at`, arg: O.order_uid }
    : { sql: `SELECT pt.id, pt.service_session_id AS r, rs.status AS st, (pt.meta->>'off_service_receipt') AS off, (rs.closed_at IS NOT NULL AND pt.created_at > rs.closed_at) AS late, pt.by_role,
        (SELECT count(*)::int FROM public.payment_allocations a WHERE a.payment_transaction_id = pt.id) AS allocs FROM public.payment_transactions pt LEFT JOIN public.service_sessions rs ON rs.id = pt.service_session_id
        WHERE pt.table_session_id = $1 AND pt.kind = 'payment' ORDER BY pt.created_at`, arg: O.table };
  const pts = (await w.su.query(q.sql, [q.arg])).rows;
  const ofe = O.id ? (await w.su.query(`SELECT e.service_session_id AS sale, e.event_service_session_id AS receipt, e.payment_transaction_id AS ptid FROM public.order_financial_events e WHERE e.order_id = $1 AND e.type = 'payment'`, [O.id])).rows : [];
  const sale = O.id ? lbl(w, (await w.su.query('SELECT service_session_id AS s FROM public.ordenes WHERE id = $1', [O.id])).rows[0].s) : null;
  return { n: pts.length, rc: pts.map((p) => lbl(w, p.r)), rst: pts.map((p) => p.st), off: pts.map((p) => !!p.off), late: pts.map((p) => !!p.late), allocs: pts.map((p) => p.allocs), roles: pts.map((p) => p.by_role),
    ofe: ofe.map((e) => ({ sale: lbl(w, e.sale), receipt: lbl(w, e.receipt), same: pts.some((p) => p.id === e.ptid && (p.r || null) === (e.receipt || null)) })), sale };
}
async function economicAudit(w) {                     // the invariants of the task, on the whole database
  const q = async (s) => (await w.su.query(s)).rows[0].n; const v = [];
  const chk = async (name, sql) => { const n = await q(sql); if (n) v.push(`${name}=${n}`); };
  await chk('duplicate_payment_per_order', `SELECT count(*)::int AS n FROM (SELECT order_id FROM public.order_financial_events WHERE type='payment' GROUP BY order_id HAVING count(*) > 1) x`);
  await chk('pt_without_allocation_or_event', `SELECT count(*)::int AS n FROM public.payment_transactions t WHERE NOT EXISTS (SELECT 1 FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id) OR NOT EXISTS (SELECT 1 FROM public.order_financial_events e WHERE e.payment_transaction_id = t.id)`);
  await chk('pt_amount_ne_allocation_or_event', `SELECT count(*)::int AS n FROM public.payment_transactions t WHERE t.amount IS DISTINCT FROM (SELECT sum(a.amount) FROM public.payment_allocations a WHERE a.payment_transaction_id = t.id) OR t.amount IS DISTINCT FROM (SELECT sum(e.amount) FROM public.order_financial_events e WHERE e.payment_transaction_id = t.id)`);
  await chk('orphan_event', `SELECT count(*)::int AS n FROM public.order_financial_events e WHERE e.type IN ('payment','refund') AND e.payment_transaction_id IS NULL AND e.legacy IS NOT TRUE`);
  await chk('sale_service_moved', `SELECT count(*)::int AS n FROM public.order_financial_events e JOIN public.ordenes o ON o.id = e.order_id WHERE e.type='payment' AND e.service_session_id IS DISTINCT FROM o.service_session_id`);
  await chk('pt_receipt_ne_event_receipt', `SELECT count(*)::int AS n FROM public.order_financial_events e JOIN public.payment_transactions pt ON pt.id = e.payment_transaction_id WHERE pt.service_session_id IS DISTINCT FROM e.event_service_session_id`);
  await chk('offservice_flag_incoherent', `SELECT count(*)::int AS n FROM public.payment_transactions WHERE service_session_id IS NULL AND table_session_id IS NULL AND COALESCE((meta->>'off_service_receipt') = 'true', false) = false`);
  await chk('flag_on_serviced_receipt', `SELECT count(*)::int AS n FROM public.payment_transactions WHERE service_session_id IS NOT NULL AND (meta->>'off_service_receipt') = 'true'`);
  await chk('double_active_service', `SELECT GREATEST(count(*) - 1, 0)::int AS n FROM public.service_sessions WHERE status IN ('open','closing')`);
  await chk('pointer_mismatch', `SELECT count(*)::int AS n FROM public.service_session_state st LEFT JOIN public.service_sessions s ON s.id = st.current_session_id WHERE st.current_session_id IS NOT NULL AND (s.id IS NULL OR s.status NOT IN ('open','closing'))`);
  for (const x of (await K.integrity(w.su)).violations.filter((y) => !/^overcollected/.test(y))) v.push(x);
  for (const x of (await K.stateInvariants(w.su)).violations) v.push(x);
  return v;
}
// the supplementary (NOT primary) signal: a receipt that names a closed service although it was created after that service closed
const lateReceipts = async (w) => (await w.su.query(`SELECT count(*)::int AS n FROM public.payment_transactions pt JOIN public.service_sessions s ON s.id = pt.service_session_id WHERE s.status = 'closed' AND s.closed_at IS NOT NULL AND pt.created_at > s.closed_at`)).rows[0].n;
async function waitPid(su, app, ms = 4000) {           // the backend of `app` waiting on a lock: its pid, who blocks it, and WHICH RELATION its row-lock wait is queued on (the tuple lock it holds while it queues)
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await su.query(`SELECT a.pid, pg_blocking_pids(a.pid) AS blockers FROM pg_stat_activity a WHERE a.application_name = $1 AND a.wait_event_type = 'Lock'`, [app]);
    if (r.rows.length) {
      const pid = r.rows[0].pid;
      const l = await su.query(`SELECT l.locktype, l.relation::regclass::text AS rel, l.granted FROM pg_locks l WHERE l.pid = $1 AND l.locktype IN ('tuple','transactionid','advisory') ORDER BY 1, 3`, [pid]);
      const tup = l.rows.find((x) => x.locktype === 'tuple');
      return { pid, blockers: r.rows[0].blockers, rel: tup ? tup.rel : null, adv: l.rows.some((x) => x.locktype === 'advisory' && !x.granted) };
    }
    await delay(10);
  }
  return null;
}
async function rowProbe(su, mode) {                    // is a row lock of `mode` on the lifecycle pointer obtainable RIGHT NOW? (a real lock request, NOWAIT, rolled back at once)
  await su.query('BEGIN');
  try { await su.query(`SELECT 1 FROM public.service_session_state WHERE singleton = true FOR ${mode} NOWAIT`); return 'acquired'; }
  catch (e) { return e.code === '55P03' ? 'conflict' : 'err:' + e.code; }
  finally { await su.query('ROLLBACK').catch(() => {}); }
}
const probeAll = async (su) => ({ FU: await rowProbe(su, 'UPDATE'), NKU: await rowProbe(su, 'NO KEY UPDATE'), SH: await rowProbe(su, 'SHARE'), KS: await rowProbe(su, 'KEY SHARE') });
// close (T1) holds its locks in an open transaction; the payment (T2) is started against it
async function closeHeldThenPay(w, cn, payCall, extra) {
  const corr = await H.seedCloseable({ su: w.su }, w.A);
  const ptrBefore = await pointerOf(w);
  await cn.T1.query('BEGIN'); const cr = await H.closeV3(cn.T1, w.A, corr);
  const ptrDuring = await pointerOf(w);                   // the uncommitted flip is invisible to every other snapshot: the STALE read that is the defect
  const p = okp(payCall(cn.T2)); const wait = await waitPid(w.su, 'c8-t2');
  const probes = extra && extra.probe ? await probeAll(w.su) : null;
  await cn.T1.query('COMMIT');
  const res = await Promise.race([p, delay(8000).then(() => ({ timeout: true }))]);
  return { close: cr && cr.code, ptrBefore, ptrDuring, ptrAfter: await pointerOf(w), wait, probes, res, closerPid: cn.pid.t1, payPid: cn.pid.t2 };
}

// ── P4: THE PRIMARY PROOF ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function serializeCase(label, tpl, kind) {
  const w = await K.world(env, tpl, 'ser', { deadlockMs: 300 });
  try {
    const cn = await K.conns(w);
    let O; let call;
    if (kind === 'mesa') { const t = await K.mkTable(w, 2); const o1 = await K.mkTableOrder(w, t, 10); await w.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [o1.id]); O = { table: t, id: o1.id };
      call = (c) => c.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', K.rid('mp'), K.hex64(K.rid('h')), null, null, null, '{}', false]).then((r) => r.rows[0].r); }
    else { O = await mkTermUnpaid(w); call = (c) => K.cashPay(c, w, O); }
    // (B) CLOSE holds STATE FOR UPDATE -> the PAYMENT waits at the pointer -> after the commit it rereads NULL
    const B = await closeHeldThenPay(w, cn, call, { probe: false });
    const ob = await obs(w, O);
    return { w, cn, O, call, B, ob, inv: await economicAudit(w), late: await lateReceipts(w), close: null };
  } catch (e) { throw e; }
}
async function phaseSerialize() {
  section('D4 SERIALIZATION CONTRACT (primary proof: controlled transactions, row-lock probes, pg_blocking_pids, pg_locks, observed pointer + receipt; created_at is only a supplementary audit)');
  for (const kind of ['cash', 'mesa']) {
    const name = kind === 'cash' ? 'Cash V1 (order_post_payment_v1)' : 'Mesa payment (mesa_post_payment_v1)';
    // ── B: CLOSE holds STATE FOR UPDATE first ───────────────────────────────────────────────────────────────────────────────────
    const res = {};
    for (const [tag, tpl] of [['BASE', env.tpl.base], ['POST', env.tpl.post]]) {
      const x = await serializeCase(tag, tpl, kind); res[tag] = x;
      console.log(`  INFO  [${kind}/${tag}] B-direction: pointer before/during(uncommitted close)/after = ${x.B.ptrBefore}/${x.B.ptrDuring}/${x.B.ptrAfter}; payment waited on relation ${x.B.wait && x.B.wait.rel} blocked by ${x.B.wait && x.B.wait.blockers.map((b) => b === x.B.closerPid ? 'CLOSER' : b)}; receipt ${JSON.stringify(x.ob.rc)} off_flag=${JSON.stringify(x.ob.off)}; created-after-close(supplementary)=${x.late}`);
    }
    const P = res.POST, Bs = res.BASE;
    assert(`${kind === 'cash' ? 'P3' : 'P10'} / B [${name}] CLOSE holds the pointer FOR UPDATE: the stale read exists (the uncommitted close is invisible: the pointer still reads A from another snapshot) and the close then commits (pointer NULL)`, P.B.ptrBefore === 'A' && P.B.ptrDuring === 'A' && P.B.ptrAfter === 'NULL' && P.B.close === 'V3_CLOSED', { b: P.B.ptrBefore, d: P.B.ptrDuring, a: P.B.ptrAfter, c: P.B.close });
    assert(`${kind === 'cash' ? 'P3' : 'P10'} / B [${name}] POST: the PAYMENT WAITS FOR THE CLOSE AT THE POINTER ROW (pg_locks: its row-lock wait is queued on public.service_session_state; pg_blocking_pids = the closer)`, !!P.B.wait && P.B.wait.rel === 'service_session_state' && P.B.wait.blockers.includes(P.B.closerPid), P.B.wait);
    assert(`${kind === 'cash' ? 'P3' : 'P10'} / B [${name}] BASE (negative control): the payment does NOT wait at the pointer -- it read the stale pointer and queues later on the service row's FK (public.service_sessions)`, !!Bs.B.wait && Bs.B.wait.rel === 'service_sessions', Bs.B.wait);
    assert(`${kind === 'cash' ? 'P3' : 'P10'} / B [${name}] POST: after the close commits the payment REREADS the pointer (NULL): receipt = NULL (off-service), sale unchanged, exactly one payment / allocation / event, event receipt = transaction receipt`,
      P.B.res && P.B.res.ok === true && P.ob.n === 1 && P.ob.rc[0] === 'NULL' && P.ob.allocs[0] === 1 && (kind === 'mesa' || (P.ob.off[0] === true && P.ob.sale === 'A' && P.ob.ofe.length === 1 && P.ob.ofe[0].sale === 'A' && P.ob.ofe[0].receipt === 'NULL' && P.ob.ofe[0].same)) && P.inv.length === 0, { ob: P.ob, inv: P.inv, res: P.B.res });
    assert(`${kind === 'cash' ? 'P3' : 'P10'} / B [${name}] BASE (negative control): the receipt is attributed to the service that has just been CLOSED (the defect is visible to this harness)`, Bs.B.res && Bs.B.res.ok === true && Bs.ob.n === 1 && Bs.ob.rc[0] === 'A' && Bs.ob.rst[0] === 'closed', Bs.ob);
    assert(`${kind === 'cash' ? 'P3' : 'P10'} / B [${name}] supplementary audit: POST has no receipt created after its service closed (BASE: ${Bs.late})`, P.late === 0, P.late);
    for (const x of Object.values(res)) await x.w.close();
  }
  // ── A: PAYMENT holds STATE FOR SHARE first -> the CLOSE (STATE FOR UPDATE) waits for the payment ─────────────────────────────────
  for (const kind of ['cash', 'mesa']) {
    const name = kind === 'cash' ? 'Cash V1' : 'Mesa';
    const out = {};
    for (const [tag, tpl] of [['BASE', env.tpl.base], ['POST', env.tpl.post]]) {
      const w = await K.world(env, tpl, 'serA', { deadlockMs: 300 });
      try {
        const cn = await K.conns(w); let O; let call;
        if (kind === 'mesa') { const t = await K.mkTable(w, 2); const o1 = await K.mkTableOrder(w, t, 10); await w.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [o1.id]); O = { table: t, id: o1.id };
          call = (c) => c.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', K.rid('mp'), K.hex64(K.rid('h')), null, null, null, '{}', false]).then((r) => r.rows[0].r); }
        else { O = await mkTermUnpaid(w); call = (c) => K.cashPay(c, w, O); }
        const corr = await H.seedCloseable({ su: w.su }, w.A);                 // (seeding UPDATEs the pointer row: it must precede an in-flight payment)
        const h = await K.hold(cn.B, [{ kind: 'row', k: 'SS' }], w);           // a blocker on the service row: the payment stalls AFTER its receipt decision, at the INSERT FK
        const p = okp(call(cn.T2)); const wp = await waitPid(w.su, 'c8-t2');
        const probes = await probeAll(w.su);                                    // which lock does the STALLED payment hold on the pointer?
        const pc = okp(H.closeV3(cn.T1, w.A, corr)); const wc = await waitPid(w.su, 'c8-t1');
        await K.release(cn.B, h);
        const [rp, rc] = await Promise.all([p, pc]);
        out[tag] = { wp, wc, probes, payPid: cn.pid.t2, closerPid: cn.pid.t1, blockerPid: cn.pid.b, ob: await obs(w, O), rp, rc, inv: await economicAudit(w), ptr: await pointerOf(w) };
        console.log(`  INFO  [${kind}/${tag}] A-direction: payment stalled after its decision; row-lock probes from a 3rd connection = ${JSON.stringify(probes)}; the CLOSE waited on relation ${wc && wc.rel} blocked by ${wc && wc.blockers.map((b) => b === cn.pid.t2 ? 'PAYMENT' : b === cn.pid.b ? 'BLOCKER' : b)}; final receipt ${JSON.stringify(out[tag].ob.rc)}, close ${rc.v && rc.v.code}`);
      } finally { await w.close(); }
    }
    const P = out.POST, Bs = out.BASE;
    assert(`P12 / A [${name}] POST: the payment that has decided HOLDS the pointer FOR SHARE (row-lock probes from a third connection: FOR UPDATE and FOR NO KEY UPDATE conflict, FOR SHARE and FOR KEY SHARE are compatible: exactly the SHARE mode, held while the payment is in flight)`,
      P.probes.FU === 'conflict' && P.probes.NKU === 'conflict' && P.probes.SH === 'acquired' && P.probes.KS === 'acquired', P.probes);
    assert(`P12 / A [${name}] BASE (negative control): the same stalled payment holds NO lock on the pointer (every probe is acquired)`, Bs.probes.FU === 'acquired' && Bs.probes.NKU === 'acquired' && Bs.probes.SH === 'acquired' && Bs.probes.KS === 'acquired', Bs.probes);
    assert(`P12 / A [${name}] POST: the CLOSE (STATE FOR UPDATE) WAITS FOR THE PAYMENT: its row-lock wait is queued on public.service_session_state and pg_blocking_pids = the payment (not the service-row blocker)`, !!P.wc && P.wc.rel === 'service_session_state' && P.wc.blockers.includes(P.payPid) && !P.wc.blockers.includes(P.blockerPid), P.wc);
    assert(`P12 / A [${name}] BASE (negative control): the close is NOT ordered at the pointer (it takes it and queues later on the service row behind the blocker)`, !!Bs.wc && Bs.wc.rel === 'service_sessions', Bs.wc);
    assert(`P12 / A [${name}] POST: payment first -> the receipt stays valid on A (the service was open at the payment's serialization point), the close then completes (V3_CLOSED, pointer NULL), exactly one payment, no error, invariants green`,
      P.rp.ok === true && P.rc.ok === true && P.rc.v && P.rc.v.code === 'V3_CLOSED' && P.ob.n === 1 && P.ob.rc[0] === 'A' && P.ptr === 'NULL' && P.inv.length === 0, { rp: P.rp, rc: P.rc, ob: P.ob, inv: P.inv });
  }
  return true;
}

// ── P5 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function scen(fn) { const b = await fn(env.tpl.base, 'BASE'); const p = await fn(env.tpl.post, 'POST'); return { b, p }; }
async function phaseScenarios() {
  section('D5 DETERMINISTIC SCENARIOS on BASE (negative control) and POST-145 -- P1 P2 P3 P5 P5b P10 P12 P13 P14 + late payments, replay, opconf / rider / paid-at-creation intake');
  // P1: payment completes before the close
  const p1 = await scen(async (tpl) => { const w = await K.world(env, tpl, 'p1'); try { const O = await mkTermUnpaid(w); const pay = await okp(K.cashPay(w.svc, w, O)); const corr = await H.seedCloseable({ su: w.su }, w.A); const cr = await H.closeV3(w.svc, w.A, corr); return { pay, cr, ob: await obs(w, O), inv: await economicAudit(w) }; } finally { await w.close(); } });
  for (const [t, x] of [['BASE', p1.b], ['POST', p1.p]]) assert(`P1 [${t}] payment completes before the close: receipt = A (closed afterwards), sale A, exactly one payment, the close succeeds`, x.pay.ok && x.cr.code === 'V3_CLOSED' && x.ob.n === 1 && x.ob.rc[0] === 'A' && x.ob.sale === 'A' && x.inv.length === 0, x);
  // P2: close first, then the payment
  const p2 = await scen(async (tpl) => { const w = await K.world(env, tpl, 'p2'); try { const O = await mkTermUnpaid(w); const corr = await H.seedCloseable({ su: w.su }, w.A); const cr = await H.closeV3(w.svc, w.A, corr); const pay = await okp(K.cashPay(w.svc, w, O)); return { pay, cr, ob: await obs(w, O), inv: await economicAudit(w) }; } finally { await w.close(); } });
  for (const [t, x] of [['BASE', p2.b], ['POST', p2.p]]) assert(`P2 [${t}] close first, no B: the payment is OFF-SERVICE (receipt NULL + off_service_receipt flag, event receipt NULL), sale A untouched`, x.pay.ok && x.ob.n === 1 && x.ob.rc[0] === 'NULL' && x.ob.off[0] === true && x.ob.sale === 'A' && x.ob.ofe[0].receipt === 'NULL' && x.inv.length === 0, x);
  // P5: close(A) holds the locks, payment and open(B) queue behind it, then commit; every outcome must be NULL or B, never the closed A
  const p5 = await scen(async (tpl) => { const N = R(12); const tally = {}; let bad = 0, dl = 0, invs = 0;
    for (let i = 0; i < N; i++) { const w = await K.world(env, tpl, 'p5', { deadlockMs: 300 }); try { const O = await mkTermUnpaid(w); const cn = await K.conns(w); const t3 = await w.client('c8-t3');
      const corr = await H.seedCloseable({ su: w.su }, w.A); await cn.T1.query('BEGIN'); await H.closeV3(cn.T1, w.A, corr);
      const pp = okp(K.cashPay(cn.T2, w, O)); await K.settleOrBlock(pp, w.su, 'c8-t2', 400); const po = okp(openB(t3)); await K.settleOrBlock(po, w.su, 'c8-t3', 400);
      await cn.T1.query('COMMIT'); const [rp, ro] = await Promise.all([pp, po]); if (rp.err === '40P01' || ro.err === '40P01') dl++;
      await setB(w); const o = await obs(w, O); if (o.rc[0] === 'A' && o.rst[0] === 'closed') bad++; const k = `${o.rc.join(',')}${o.off[0] ? '(off)' : ''}`; tally[k] = (tally[k] || 0) + 1; if ((await economicAudit(w)).length) invs++;
    } finally { await w.close(); } }
    return { N, bad, dl, invs, tally }; });
  assert(`P5 [POST] close(A) + payment + open(B) queued, ${p5.p.N} rounds: NEVER a receipt on the closed A; every outcome is NULL (off-service) or B; 0 deadlocks; invariants green (${JSON.stringify(p5.p.tally)})`, p5.p.bad === 0 && p5.p.dl === 0 && p5.p.invs === 0 && Object.keys(p5.p.tally).every((k) => /^(NULL|B)/.test(k)), p5.p);
  assert(`P5 [BASE] (negative control): the same rounds attribute EVERY receipt to the closed A (${p5.b.bad}/${p5.b.N})`, p5.b.bad === p5.b.N, p5.b);
  // P5b: the payment is stalled BEFORE its decision (ORD row held); the close AND the open of B commit; on release it must decide B
  const p5b = await scen(async (tpl) => { const w = await K.world(env, tpl, 'p5b', { deadlockMs: 300 }); try { const O = await mkTermUnpaid(w); const cn = await K.conns(w);
    const h = await K.hold(cn.B, [{ kind: 'row', k: 'ORD', id: O.id }], w); const p = okp(K.cashPay(cn.T2, w, O)); const st = await K.settleOrBlock(p, w.su, 'c8-t2', 600);
    const corr = await H.seedCloseable({ su: w.su }, w.A); const cr = await H.closeV3(w.svc, w.A, corr); const ob0 = await openB(w.svc); await setB(w); const ptr = await pointerOf(w);
    await K.release(cn.B, h); const rp = await p; return { stalled: !st.done, cr, ob0, ptr, rp, ob: await obs(w, O), inv: await economicAudit(w) }; } finally { await w.close(); } });
  for (const [t, x] of [['BASE', p5b.b], ['POST', p5b.p]]) assert(`P5b [${t}] B is already open at the decision point: the receipt is B (open), the sale stays A, the pointer reads B`, x.stalled && x.cr.code === 'V3_CLOSED' && x.ob0.code === 'CREATED' && x.ptr === 'B' && x.rp.ok && x.ob.rc[0] === 'B' && x.ob.rst[0] === 'open' && x.ob.sale === 'A' && x.ob.ofe[0].sale === 'A' && x.ob.ofe[0].receipt === 'B' && x.inv.length === 0, x);
  // P10 (Mesa) and P12 (payment first) are proved by D4; P13: exactly-once and replay under the race
  const p13 = await scen(async (tpl) => { const w = await K.world(env, tpl, 'p13', { deadlockMs: 300 }); try { const O = await mkTermUnpaid(w); const cn = await K.conns(w); const t2b = await w.client('c8-t2b');
    const reqId = K.rid('cash'); const hash = K.hex64('h13'); const corr = await H.seedCloseable({ su: w.su }, w.A);
    await cn.T1.query('BEGIN'); const cr = await H.closeV3(cn.T1, w.A, corr); const pa = okp(K.cashPay(cn.T2, w, O, { reqId, hash })); await K.settleOrBlock(pa, w.su, 'c8-t2', 500); const pb = okp(K.cashPay(t2b, w, O, { reqId, hash })); await K.settleOrBlock(pb, w.su, 'c8-t2b', 500);
    await cn.T1.query('COMMIT'); const [ra, rb] = await Promise.all([pa, pb]); const ob = await obs(w, O); return { cr, ra, rb, idem: [ra, rb].map((x) => x.v && x.v.idempotent === true), ob, inv: await economicAudit(w) }; } finally { await w.close(); } });
  assert('P13 [POST] the same request twice + the close: exactly ONE original and ONE idempotent replay, ONE payment / allocation / event, off-service receipt, invariants green', p13.p.ra.ok && p13.p.rb.ok && p13.p.idem.filter(Boolean).length === 1 && p13.p.ob.n === 1 && p13.p.ob.allocs[0] === 1 && p13.p.ob.rc[0] === 'NULL' && p13.p.inv.length === 0, p13.p);
  assert('P13 [BASE] (control): exactly-once holds there too (1 + 1), but the receipt is the closed A', p13.b.idem.filter(Boolean).length === 1 && p13.b.ob.n === 1 && p13.b.ob.rc[0] === 'A', p13.b);
  // P8 / P9: operator_confirm / rider payment x close (already serialized by L0 on BASE: the fix must not change them)
  const race = (kind) => scen(async (tpl) => { const w = await K.world(env, tpl, 'p8' + kind, { deadlockMs: 300 }); try {
    await K.closeTripQuiet(w); const d = await withTrip(w); const cn = await K.conns(w);
    const call = kind === 'opconf' ? (c) => H.opConfirm(c, d.id, H.PAY({ method: 'efectivo' }), 'operator_backup') : (c) => H.riderStop(c, d.id, 'efectivo', `pay-order-${String(d.id).replace(/[^A-Za-z0-9_-]/g, '')}`);
    const corr = await H.seedCloseable({ su: w.su }, w.A); await cn.T1.query('BEGIN'); const cr = await H.closeV3(cn.T1, w.A, corr);
    const p = okp(call(cn.T2)); const wt = await waitPid(w.su, 'c8-t2'); await cn.T1.query('COMMIT'); const res = await p;
    return { cr: cr && cr.code, wt, closer: cn.pid.t1, res, ob: await obs(w, d), inv: await economicAudit(w) }; } finally { await w.close(); } });
  for (const [kind, tag] of [['opconf', 'P8'], ['rider', 'P9']]) { const r = await race(kind);
    for (const [t, x] of [['BASE', r.b], ['POST', r.p]]) assert(`${tag} [${t}] ${kind === 'opconf' ? 'operator_confirm + payment' : 'rider canonical payment'} x close (race): the payment WAITS for the closer on the advisory lock L0 (serialized before and after the fix), then records an off-service receipt (NULL + flag), sale A, payment once, recorded as ${kind === 'opconf' ? 'the operator' : 'the rider'}`,
      x.cr === 'V3_CLOSED' && !!x.wt && x.wt.adv && x.wt.blockers.includes(x.closer) && x.res.ok === true && x.ob.n === 1 && x.ob.rc[0] === 'NULL' && x.ob.off[0] === true && x.ob.sale === 'A' && x.ob.roles[0] === (kind === 'opconf' ? 'operator' : 'rider') && x.inv.length === 0, x); }
  // P14: ensure_service_session (legacy pointer locker) x payment
  const p14 = await scen(async (tpl) => { let dl = 0; const tally = {};
    for (let i = 0; i < R(12); i++) { const w = await K.world(env, tpl, 'p14', { deadlockMs: 300 }); try { const O = await mkTermUnpaid(w); const cn = await K.conns(w);
      const pe = okp(cn.T1.query("SELECT public.ensure_service_session('operator_primary','pcf') AS r").then((r) => r.rows[0].r)); await delay(Math.floor(Math.random() * 8)); const pp = okp(K.cashPay(cn.T2, w, O));
      const [re, rp] = await Promise.all([pe, pp]); if ([re, rp].some((x) => x.err === '40P01')) dl++; const o = await obs(w, O); const k = `${re.ok ? 'ensure ok' : re.err} | ${rp.ok ? 'pay ok' : rp.err} | ${o.rc.join(',')}`; tally[k] = (tally[k] || 0) + 1; } finally { await w.close(); } }
    return { dl, tally }; });
  assert(`P14 [POST] ensure_service_session x payment: 0 deadlocks (${JSON.stringify(p14.p.tally)})`, p14.p.dl === 0 && Object.keys(p14.p.tally).every((k) => /ensure ok \| pay ok/.test(k)), p14.p);
  // late payments / replay / opconf / rider / initial-payment intake (sequential; the receipt rule)
  const seq = await scen(async (tpl) => { const out = {};
    { const w = await K.world(env, tpl, 'p6', { noService: true }); try { const O = w.hist; const r = await okp(K.cashPay(w.svc, w, O)); out.p6 = { r, ob: await obs(w, O), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await K.world(env, tpl, 'p7', { noService: true }); try { const O = w.hist; await openB(w.svc); await setB(w); const r = await okp(K.cashPay(w.svc, w, O)); out.p7 = { r, ob: await obs(w, O), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await K.world(env, tpl, 'replay'); try { const O = await mkTermUnpaid(w); const reqId = K.rid('cash'), hash = K.hex64('hr'); const a = await okp(K.cashPay(w.svc, w, O, { reqId, hash })); const n1 = await obs(w, O); const b = await okp(K.cashPay(w.svc, w, O, { reqId, hash })); out.replay = { a, b, n1, n2: await obs(w, O), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await K.world(env, tpl, 'opc'); try { await K.closeTripQuiet(w); const d = await withTrip(w); const r = await okp(H.opConfirm(w.svc, d.id, H.PAY({ method: 'efectivo' }), 'operator_backup')); out.opc = { r, ob: await obs(w, d), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await K.world(env, tpl, 'rid'); try { await K.closeTripQuiet(w); const d = await K.dispatchedOrder(w); const r = await okp(H.riderStop(w.svc, d.id, 'efectivo', `pay-order-${String(d.id).replace(/[^A-Za-z0-9_-]/g, '')}`)); out.rid = { r, ob: await obs(w, d), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await K.world(env, tpl, 'ipi'); try { const o = await K.insertOrder(w.svc, { id: K.nextId('#PC'), totale: 12.5, intentJson: K.intent('operator_primary') }); out.ipi = { o, ob: await obs(w, o), inv: await economicAudit(w) }; } finally { await w.close(); } }
    { const w = await K.world(env, tpl, 'ipf', { deadlockMs: 300 }); try { const cn = await K.conns(w); const corr = await H.seedCloseable({ su: w.su }, w.A); await cn.T1.query('BEGIN'); await H.closeV3(cn.T1, w.A, corr);
        const p = okp((async () => { await cn.T2.query('BEGIN'); try { const r = await K.insertOrder(cn.T2, { id: K.nextId('#PC'), totale: 12.5, intentJson: K.intent('operator_primary') }); await cn.T2.query('COMMIT'); return r; } catch (e) { await cn.T2.query('ROLLBACK').catch(() => {}); throw e; } })());
        const wt = await waitPid(w.su, 'c8-t2'); await cn.T1.query('COMMIT'); const r = await p; await setB(w); out.ipf = { r, wt, ob: r.v ? await obs(w, r.v) : null, inv: await economicAudit(w) }; } finally { await w.close(); } }
    return out; });
  for (const [t, x] of [['BASE', seq.b], ['POST', seq.p]]) {
    assert(`P6 [${t}] late payment, NO service open: off-service receipt (NULL + flag), sale untouched`, x.p6.r.ok && x.p6.ob.rc[0] === 'NULL' && x.p6.ob.off[0] && x.p6.ob.ofe[0].receipt === 'NULL' && x.p6.inv.length === 0, x.p6);
    assert(`P7 [${t}] late payment of a service-A sale while B is open: receipt = B, sale = A`, x.p7.r.ok && x.p7.ob.rc[0] === 'B' && x.p7.ob.sale === 'A' && x.p7.ob.ofe[0].sale === 'A' && x.p7.ob.ofe[0].receipt === 'B' && !x.p7.ob.off[0] && x.p7.inv.length === 0, x.p7);
    assert(`replay [${t}] the same request twice (sequential): the second is an idempotent replay, no new transaction / allocation / event`, x.replay.a.ok && x.replay.b.ok && x.replay.b.v.idempotent === true && x.replay.n1.n === 1 && x.replay.n2.n === 1 && x.replay.inv.length === 0, x.replay);
    assert(`operator_confirm [${t}] with payment, service open: recorded AS THE OPERATOR, receipt = A, payment once`, x.opc.r.ok && x.opc.ob.n === 1 && x.opc.ob.rc[0] === 'A' && x.opc.ob.roles[0] === 'operator' && x.opc.inv.length === 0, x.opc);
    assert(`rider canonical payment (M140) [${t}] service open: recorded AS THE RIDER, receipt = A, payment once`, x.rid.r.ok && x.rid.ob.n === 1 && x.rid.ob.rc[0] === 'A' && x.rid.ob.roles[0] === 'rider' && x.rid.inv.length === 0, x.rid);
    assert(`paid-at-creation intake [${t}] service open: one payment, receipt = the order's own open service A, intent consumed`, x.ipi.o && x.ipi.ob.n === 1 && x.ipi.ob.rc[0] === 'A' && x.ipi.ob.sale === 'A' && x.ipi.inv.length === 0, x.ipi);
    assert(`paid-at-creation intake x close [${t}] (L-serialized, unchanged): the intake waits on the lifecycle lock, then opens the NEXT service B; receipt = B, sale = B, payment once`, x.ipf.r.ok && x.ipf.ob && x.ipf.ob.n === 1 && x.ipf.ob.rc[0] === 'B' && x.ipf.ob.sale === 'B' && x.ipf.wt && x.ipf.wt.adv && x.ipf.inv.length === 0, x.ipf);
  }
  return true;
}

// ── P6 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const P = K.PARTIES; const { ORDc, TSc } = K; const ENTc = (name, uid) => K.obj(name, 'row', { k: 'ENT', uid });
const rpc = (sql, args) => (c) => c.query(sql, args).then((r) => r.rows[0].r);
P.W_CASH_T = { name: 'W_CASH_T', tx: false, async prep(w) { const O = await mkTermUnpaid(w, 10); return { objs: [ORDc('ORD:o', O.id), ENTc('ENT:o', O.order_uid)], actor: 'operator_backup', call: (c) => K.cashPay(c, w, O) }; } };
P.W_MPAY_T = { name: 'W_MPAY_T', tx: false, async prep(w) { const t = await K.mkTable(w, 2); const o1 = await K.mkTableOrder(w, t, 10); await w.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [o1.id]);
  return { objs: [TSc('TS:t2', t), ORDc('ORD:o1', o1.id)], table: t, actor: 'operator_backup', call: rpc('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', K.rid('mp'), K.hex64(K.rid('mh')), null, null, null, '{}', false]) }; } };
P.W_OPCONF_T = { name: 'W_OPCONF_T', tx: false, fresh: true, cleanup: K.closeTripQuiet, async prep(w) { await K.closeTripQuiet(w); const d = await withTrip(w); return { objs: [ORDc('ORD:o', d.id), ENTc('ENT:o', d.order_uid)], actor: 'operator_backup', call: (c) => H.opConfirm(c, d.id, H.PAY({ method: 'efectivo' }), 'operator_backup') }; } };
P.W_RIDER_T = { name: 'W_RIDER_T', tx: false, fresh: true, cleanup: K.closeTripQuiet, async prep(w) { await K.closeTripQuiet(w); const d = await withTrip(w); return { objs: [ORDc('ORD:o', d.id), ENTc('ENT:o', d.order_uid)], actor: 'rider', call: (c) => H.riderStop(c, d.id, 'efectivo', `pay-order-${String(d.id).replace(/[^A-Za-z0-9_-]/g, '')}`) }; } };
P.W_ENSURE = { name: 'W_ENSURE', tx: false, async prep() { return { objs: [], actor: 'operator_primary', call: rpc("SELECT public.ensure_service_session('operator_primary','pcf') AS r", []) }; } };
const FINDING_A_PAIRS = [   // the 18 pairs of the design (W_CLOSE first: the harness runs the second party's prep first and a closeout attempt would block the creation of an order)
  ['W_CLOSE', 'W_CASH_T'], ['W_CLOSE', 'W_MPAY_T'], ['W_CLOSE', 'W_OPCONF_T'], ['W_CLOSE', 'W_RIDER_T'], ['W_CASH_HIST', 'W_OPEN'],
  ['W_CASH_T', 'W_ENSURE'], ['W_MPAY_T', 'W_ENSURE'], ['W_ENSURE', 'W_CLOSE'],
  ['I_UNPAID', 'W_CASH_T'], ['I_PAID_SAME', 'W_CASH_T'], ['I_TABLE', 'W_MPAY_T'], ['I_FIRST', 'W_CASH_HIST'], ['I_FIRST_PAID', 'W_CASH_HIST'],
  ['W_CASH_T', 'W_CASH_T'], ['W_CASH_T', 'W_MPAY_T'], ['W_CASH_T', 'W_CANCEL'], ['W_MPAY_T', 'W_CANCEL_TABLE_B'], ['W_MPAY_T', 'W_MOPEN_BUSY'],
];
async function hyp(tpl, kind) {              // the C8 deterministic hypotheses (same scenarios as runC8LockOrderFix.js), on any template
  const w = await K.world(env, tpl, 'h' + kind, { deadlockMs: 400 }); const cn = await K.conns(w);
  try {
    if (kind === 1) { const tid = await K.mkRestTable(w, 9); const open = (c) => c.query('SELECT public.mesa_open_session_v1($1,$2,$3,$4,$5) AS r', [w.ws, 'operator_backup', tid, w.A, 2]).then((r) => r.rows[0].r);
      return await K.pairRun(w, cn, { t2: { call: open, tx: false }, t1: { call: (c) => K.insertOrder(c, { id: K.nextId('#HY'), totale: 11 }), tx: true }, pause: { who: 't2', objs: [{ kind: 'row', k: 'ACT', actor: 'operator_backup' }] } }); }
    if (kind === 3) { const O = await K.mkUnpaid(w, 10); const cancel = (c) => c.query('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_backup', 'hyp cancel', K.rid('cx'), K.hex64(K.rid('h')), 'CANCELADO', '{}']).then((r) => r.rows[0].r);
      return await K.pairRun(w, cn, { t2: { call: cancel, tx: false }, t1: { call: (c) => K.insertOrder(c, { id: K.nextId('#HY'), totale: 11, intentJson: K.intent('operator_backup') }), tx: true }, pause: { who: 't2', objs: [{ kind: 'row', k: 'ORD', id: O.id }] } }); }
    if (kind === 4) { const ts = await K.mkTable(w, 2); const O = await K.mkTableOrder(w, ts, 10); const rt2 = (await w.su.query('SELECT table_id FROM public.table_sessions WHERE id = $1', [ts])).rows[0].table_id;
      const cancel = (c) => c.query('SELECT public.order_cancel_v1($1,$2,$3,$4,$5,$6,$7::jsonb) AS r', [O.id, 'operator_primary', 'hyp cancel', K.rid('cx'), K.hex64(K.rid('h')), 'CANCELADO', '{}']).then((r) => r.rows[0].r);
      const open = (c) => c.query('SELECT public.mesa_open_session_v1($1,$2,$3,$4,$5) AS r', [w.ws, 'operator_backup', rt2, w.A, 2]).then((r) => r.rows[0].r);
      return await K.pairRun(w, cn, { t1: { call: cancel, tx: false }, t2: { call: open, tx: false }, pause: { who: 't1', objs: [{ kind: 'row', k: 'ORD', id: O.id }] } }); }
    const t = await K.mkTable(w, 2);      // H2: paid plain intake (T1) x comanda (T2) while a KEY SHARE holder sits on W
    const comanda = (c) => c.query(`INSERT INTO public.ordenes (id, estado, totale, items, table_session_id) VALUES ($1,'EN_COCINA',7,$2::jsonb,$3) RETURNING id`, [K.nextId('#H2'), JSON.stringify([{ n: 'P', q: 1, p: 7 }]), t]).then((r) => r.rows[0]);
    const h = await K.hold(cn.B, [{ kind: 'row', k: 'W', mode: 'FOR KEY SHARE' }], w);
    const p1 = K.start({ call: (c) => K.insertOrder(c, { id: K.nextId('#HY'), totale: 11, intentJson: K.intent('operator_primary') }), tx: true }, cn.T1); const s1 = await K.settleOrBlock(p1, w.su, 'c8-t1', 400);
    const p2 = K.start({ call: comanda, tx: true }, cn.T2); const s2 = await K.settleOrBlock(p2, w.su, 'c8-t2', 400); await K.release(cn.B, h);
    const r = await Promise.race([Promise.all([p1, p2]), K.delay(6000).then(() => 'TIMEOUT')]);
    return { t1_state: s1.done ? 'done' : (s1.blocked ? 'blocked' : 'running'), t2_state: s2.done ? 'done' : (s2.blocked ? 'blocked' : 'running'), timeout: r === 'TIMEOUT', deadlock: r !== 'TIMEOUT' && [r[0], r[1]].some((x) => x && x.err === '40P01'), result: r === 'TIMEOUT' ? null : { t1: r[0], t2: r[1] } };
  } finally { await w.close(); }
}
async function phaseSweeps() {
  section('D6 LOCK REGRESSION on POST-145 -- H1 / H2 / H3 / H4 of C8 + the 18 Finding A pairs (both directions, every candidate lock object): 40P01 = 0 on every reachable pair');
  const ok = (r) => r.result && Object.values(r.result).every((x) => x && x.ok === true);
  const h1 = await hyp(env.tpl.post, 1), h3 = await hyp(env.tpl.post, 3), h2 = await hyp(env.tpl.post, 2), h4 = await hyp(env.tpl.post, 4);
  assert('H1 mesa_open_session_v1 x simple intake on POST-145: NO 40P01, both complete', h1.first_state === 'blocked' && !h1.deadlock && !h1.timeout && ok(h1), h1);
  assert('H2 paid intake x comanda on POST-145: NO 40P01, no KEY SHARE -> FOR UPDATE upgrade wait, both complete', !h2.deadlock && !h2.timeout && h2.t1_state === 'blocked' && h2.result && h2.result.t1.ok === true && h2.result.t2.ok === true, h2);
  assert('H3 order_cancel_v1 x paid intake (same actor) on POST-145: NO 40P01, both complete', h3.first_state === 'blocked' && !h3.deadlock && !h3.timeout && ok(h3), h3);
  const okB = (r) => r.result && r.result.t1 && r.result.t2 && (r.result.t1.ok === true || (r.result.t1.err && r.result.t1.err !== '40P01')) && r.result.t2.err !== '40P01';
  assert('H4 order_cancel_v1 (comanda, actor A) x mesa_open_session_v1 (same table, actor B) on POST-145: NO 40P01', h4.first_state === 'blocked' && !h4.deadlock && !h4.timeout && okB(h4), h4);
  const pairs = QUICK ? FINDING_A_PAIRS.slice(0, 8) : FINDING_A_PAIRS;
  const tot = { pairs: 0, runs: 0, exercised: 0, deadlocks: 0, timeouts: 0 };
  for (const [a, b] of pairs) {
    const r = await K.sweepPair(env, env.tpl.post, a, b);
    tot.pairs++; tot.runs += r.runs; tot.exercised += r.exercised; tot.deadlocks += r.deadlocks.length; tot.timeouts += r.timeouts;
    assert(`POST-145 ${a} x ${b}: ${r.exercised} lock-level interleavings exercised, 0 deadlocks, 0 timeouts, integrity + state invariants green`, r.deadlocks.length === 0 && r.timeouts === 0 && r.integrity.length === 0 && r.exercised > 0, { deadlocks: r.deadlocks, timeouts: r.timeouts, integrity: r.integrity, exercised: r.exercised, unexpected: r.unexpected.slice(0, 3) });
  }
  assert(`POST-145 totals: ${tot.pairs} pairs, ${tot.exercised} exercised interleavings, ${tot.deadlocks} deadlocks`, tot.deadlocks === 0 && tot.timeouts === 0, tot);
  // the ONE negative control of the prerequisite: 145 with its 143 guard stripped, on a database WITHOUT 143 (the configuration the guard exists to forbid)
  const stripped = tmpFile('145_without_prerequisite_guard.sql', stripPrereq(readAny(F145)));
  const tplNo143 = await buildDerived('no143', [stripped], env.tpl.pre144);
  const ctl = { deadlocks: 0, exercised: 0 }; const base = { deadlocks: 0, exercised: 0 }; const detail = [];
  for (const [a, b] of [['I_UNPAID', 'W_CASH_T'], ['I_PAID_SAME', 'W_CASH_T'], ['I_TABLE', 'W_MPAY_T']]) {
    const r = await K.sweepPair(env, tplNo143, a, b); ctl.deadlocks += r.deadlocks.length; ctl.exercised += r.exercised; detail.push(`${a} x ${b}: ${r.deadlocks.length}`);
    const q = await K.sweepPair(env, env.tpl.base, a, b); base.deadlocks += q.deadlocks.length; base.exercised += q.exercised;
  }
  console.log('  INFO  negative control (145 forced onto a database WITHOUT 143): deadlocks per pair = ' + detail.join(' | '));
  assert(`NEGATIVE CONTROL of the prerequisite: with 143 absent the same intake x payment sweeps DEADLOCK (${ctl.deadlocks} deadlocks / ${ctl.exercised} interleavings) -- the guard forbidding 145 without 143 is necessary, and the sweeps are sensitive enough to see it`, ctl.deadlocks > 0, ctl);
  assert(`...while the same three pairs on the C8 candidate (143 + 144, before 145) and on POST-145 are deadlock-free (BASE ${base.deadlocks} / ${base.exercised})`, base.deadlocks === 0, base);
  return true;
}

// ── P7 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseRegress() {
  section('D7 FUNCTIONAL REGRESSION (differential PRE vs POST-145): the receipt rule and the sale service never moved; cash / Mesa / operator_confirm / rider / initial payment / lifecycle / numbering');
  const NRM = (o) => JSON.stringify(o).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>').replace(/#[A-Z]+[0-9]{5}/g, '#ID').replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)/g, '<ts>').replace(/\b(cash|mp|mr|rf)_[0-9a-f]{32}\b/g, '<req>').replace(/\bT\d+\b/g, 'T<n>').replace(/pay-order-[A-Za-z0-9_-]+/g, 'pay-order-<id>');
  const battery = async (tpl) => { const out = []; const say = (l, o) => out.push({ l, o: NRM(o) });
    const w = await K.world(env, tpl, 'rg', { deadlockMs: 300 });
    try {
      const att = async (l, fn) => { try { say(l, { ok: await fn() }); } catch (e) { say(l, { err: e.code, msg: String(e.message).slice(0, 100) }); } };
      const O1 = await K.mkUnpaid(w, 10); await att('cash full', () => K.cashPay(w.svc, w, O1, { reqId: 'cash_' + '1'.repeat(32), hash: K.hex64('rg1') })); say('cash full [ob]', await obs(w, O1));
      await att('cash replay', () => K.cashPay(w.svc, w, O1, { reqId: 'cash_' + '1'.repeat(32), hash: K.hex64('rg1') }));
      await att('cash on a settled order', () => K.cashPay(w.svc, w, O1, {}));
      const O2 = await K.mkUnpaid(w, 10); await att('cash custom_amount tarjeta', () => K.cashPay(w.svc, w, O2, { mode: 'custom_amount', amount: 4, method: 'tarjeta' })); say('cash custom [ob]', await obs(w, O2));
      const t = await K.mkTable(w, 2); await K.mkTableOrder(w, t, 10); await K.mkTableOrder(w, t, 8);
      const mp = () => w.svc.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [w.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', 'mp_' + '2'.repeat(32), K.hex64('rgm'), null, null, null, '{}', false]).then((r) => r.rows[0].r);
      await att('mesa full', mp); await att('mesa replay', mp); say('mesa [ledger]', await K.counts(w.su));
      await K.closeTripQuiet(w); const d1 = await K.dispatchedOrder(w); await att('operator_confirm + payment', () => H.opConfirm(w.svc, d1.id, H.PAY({ method: 'efectivo' }), 'operator_backup')); say('opconf [ob]', await obs(w, d1));
      await K.closeTripQuiet(w); const d2 = await K.dispatchedOrder(w); await att('rider stop + payment', () => H.riderStop(w.svc, d2.id, 'efectivo', `pay-order-${String(d2.id).replace(/[^A-Za-z0-9_-]/g, '')}`)); say('rider [ob]', await obs(w, d2)); await K.closeTripQuiet(w);
      const pi = await K.insertOrder(w.svc, { id: K.nextId('#RG'), totale: 9.5, intentJson: K.intent('operator_primary', 'bizum') }); say('paid-at-creation [ob]', await obs(w, pi));
      const num = []; for (const k of ['plain', 'paid', 'plain']) { const r = await K.insertOrder(w.svc, { id: K.nextId('#RN'), totale: 9, intentJson: k === 'paid' ? K.intent('operator_primary') : null }); num.push(r.service_order_number); } say('numbering', num);
      say('invariants', await economicAudit(w));
    } finally { await w.close(); }
    const l1 = await K.world(env, tpl, 'rgl1', { deadlockMs: 300, noService: true });          // a historical (service A) sale paid AFTER the close, no service open
    try { try { say('late payment, no service (off-service)', { ok: await K.cashPay(l1.svc, l1, l1.hist) }); } catch (e) { say('late payment, no service (off-service)', { err: e.code, msg: String(e.message).slice(0, 100) }); }
      say('late [ob]', await obs(l1, l1.hist)); say('lifecycle invariants (no service)', await economicAudit(l1)); } finally { await l1.close(); }
    const l2 = await K.world(env, tpl, 'rgl2', { deadlockMs: 300, noService: true });          // the same, while the NEXT service B is open
    try { say('open_operational_service_v1', { ok: await openB(l2.svc) }); await setB(l2);
      try { say('late payment of a historical sale while B is open', { ok: await K.cashPay(l2.svc, l2, l2.hist) }); } catch (e) { say('late payment of a historical sale while B is open', { err: e.code, msg: String(e.message).slice(0, 100) }); }
      say('late during B [ob]', await obs(l2, l2.hist));
      say('intake after resume', { n: (await K.insertOrder(l2.svc, { id: K.nextId('#LC'), totale: 10 })).service_order_number });
      say('lifecycle invariants (B)', await economicAudit(l2)); } finally { await l2.close(); }
    return out; };
  const pre = await battery('pcf_pre_tpl'), post = await battery(env.tpl.post);
  const diffs = pre.map((r, i) => (post[i] && r.l === post[i].l && r.o === post[i].o) ? null : { label: r.l, pre: r.o.slice(0, 200), post: post[i] && post[i].o.slice(0, 200) }).filter(Boolean);
  assert(`${pre.length} observable steps (cash full / replay / settled / custom, Mesa full / replay, operator_confirm, rider, paid-at-creation, numbering, late payment off-service, late payment during B, lifecycle): identical on PRE (no 143 / 144 / 145) and POST-145`, pre.length === post.length && diffs.length === 0, diffs.slice(0, 4));
  const at = (l) => (post.find((r) => r.l === l) || { o: '' }).o;
  assert('the battery is not vacuous: every writer produced a result (not an error) and the late payments follow the receipt rule (NULL + off-service flag with no service; the open service B while B is open; the sale service untouched)',
    ['cash full', 'cash replay', 'cash custom_amount tarjeta', 'mesa full', 'mesa replay', 'operator_confirm + payment', 'rider stop + payment', 'late payment, no service (off-service)', 'late payment of a historical sale while B is open', 'open_operational_service_v1'].every((k) => /^\{"ok":/.test(at(k)))
    && /"rc":\["NULL"\],"rst":\[null\],"off":\[true\]/.test(at('late [ob]')) && /"rc":\["B"\],"rst":\["open"\],"off":\[false\]/.test(at('late during B [ob]')) && /"sale":"A"/.test(at('late [ob]')) && /"sale":"A"/.test(at('late during B [ob]'))
    && at('invariants') === '[]' && at('lifecycle invariants (no service)') === '[]' && at('lifecycle invariants (B)') === '[]', post.map((r) => r.l + '=' + r.o.slice(0, 90)));
  return true;
}

// ── P8 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function phaseStress() {
  section('D8 STRESS (reasonable, not an audit): close latency under a payment storm, and natural races payment x close x open with the receipt audit');
  const orders = QUICK ? 200 : 600; const w = await K.world(env, env.tpl.post, 'storm', { deadlockMs: 1000 });
  try {
    const list = []; for (let i = 0; i < orders; i++) list.push(await mkTermUnpaid(w, 5 + (i % 7)));
    const conns = []; for (let i = 0; i < 6; i++) conns.push(await w.client('storm-' + i)); const closer = await w.client('storm-closer'); const corr = await H.seedCloseable({ su: w.su }, w.A);
    let idx = 0; const st = { paid: 0, dl: 0, errs: {} };
    const workers = conns.map((c) => (async () => { while (idx < list.length) { const O = list[idx++]; try { await K.cashPay(c, w, O, {}); st.paid++; } catch (e) { if (e.code === '40P01') st.dl++; else st.errs[e.code] = (st.errs[e.code] || 0) + 1; } } })());
    await delay(150); const t0 = Date.now(); const cr = await H.closeV3(closer, w.A, corr); const ms = Date.now() - t0; await Promise.all(workers);
    const a = await economicAudit(w);
    const tally = (await w.su.query(`SELECT count(*) FILTER (WHERE service_session_id = $1)::int AS on_a, count(*) FILTER (WHERE service_session_id IS NULL)::int AS off, count(*)::int AS n FROM public.payment_transactions WHERE kind = 'payment'`, [w.A])).rows[0];
    console.log(`  INFO  storm: receipts on the closed-after service A = ${tally.on_a}, off-service (NULL, decided after the close) = ${tally.off}, total ${tally.n}`);
    assert('payment storm: the close really landed MID-FLIGHT (payments completed both before it -> receipt A, and after it -> off-service receipt), and none was attributed to a closed service', tally.on_a > 0 && tally.off > 0 && tally.on_a + tally.off === tally.n, tally);
    assert(`payment storm (${orders} payments, 6 connections, close fired mid-flight): the close returns V3_CLOSED in ${ms} ms (no starvation), every payment succeeds (${st.paid}/${orders}), 0 deadlocks, invariants green, no receipt created after its service closed (${await lateReceipts(w)})`,
      cr.code === 'V3_CLOSED' && ms < 1500 && st.paid === orders && st.dl === 0 && Object.keys(st.errs).length === 0 && a.length === 0 && (await lateReceipts(w)) === 0, { cr: cr.code, ms, st, a });
  } finally { await w.close(); }
  let bad = 0, dl = 0, invs = 0, rounds = 0;
  for (const kind of ['cash', 'mesa', 'opconf', 'rider']) {
    for (let i = 0; i < R(20); i++) {
      const wr = await K.world(env, env.tpl.post, 'nat', { deadlockMs: 200 }); rounds++;
      try {
        let call;
        if (kind === 'cash') { const O = await mkTermUnpaid(wr); call = (c) => K.cashPay(c, wr, O); }
        else if (kind === 'mesa') { const t = await K.mkTable(wr, 2); const o1 = await K.mkTableOrder(wr, t, 10); await wr.su.query("UPDATE public.ordenes SET estado='RETIRADO' WHERE id=$1", [o1.id]);
          call = (c) => c.query('SELECT public.mesa_post_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) AS r', [wr.ws, 'operator_backup', K.hex64('sid-m'), t, 'efectivo', 'full', K.rid('mp'), K.hex64(K.rid('h')), null, null, null, '{}', false]).then((r) => r.rows[0].r); }
        else { await K.closeTripQuiet(wr); const d = await withTrip(wr); call = kind === 'opconf' ? (c) => H.opConfirm(c, d.id, H.PAY({ method: 'efectivo' }), 'operator_backup') : (c) => H.riderStop(c, d.id, 'efectivo', `pay-order-${String(d.id).replace(/[^A-Za-z0-9_-]/g, '')}`); }
        const cn = await K.conns(wr); const t3 = await wr.client('c8-t3'); const corr = await H.seedCloseable({ su: wr.su }, wr.A);
        const jobs = [(async () => { await delay(Math.floor(Math.random() * 14)); return okp(H.closeV3(cn.T1, wr.A, corr)); })(), (async () => { await delay(Math.floor(Math.random() * 14)); return okp(call(cn.T2)); })(), (async () => { await delay(Math.floor(Math.random() * 20)); return okp(openB(t3)); })()];
        const res = await Promise.all(jobs); dl += res.filter((x) => x.err === '40P01').length; bad += await lateReceipts(wr); if ((await economicAudit(wr)).length) invs++;
      } finally { await wr.close(); }
    }
  }
  assert(`natural races payment x close x open (${rounds} rounds, cash / Mesa / operator_confirm / rider): 0 deadlocks, invariants green, no receipt created after its service closed (supplementary audit: ${bad})`, dl === 0 && invs === 0 && bad === 0, { dl, invs, bad });
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PHASES = { provenance: phaseProvenance, apply: phaseApply, drift: phaseDrift, rollback: phaseRollback, serialize: phaseSerialize, scenarios: phaseScenarios, sweeps: phaseSweeps, regress: phaseRegress, stress: phaseStress };
async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'pcf-admin' });
    await rt.ensureRoles(admin);
    env = { cl, admin, tpl: {}, clone: async (tpl, label) => { const name = `pcf_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`.slice(0, 60); await rt.cloneDb(admin, tpl, name); return name; } };
    const names = only.length ? only : Object.keys(PHASES);
    if (!names.includes('provenance')) names.unshift('provenance');
    for (const n of names) {
      if (!PHASES[n]) { assert(`unknown phase ${n}`, false); continue; }
      try { await PHASES[n](); } catch (e) { section(`phase ${n} crashed`); assert(`phase ${n} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`); }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  if (process.env.PCF_EVIDENCE_OUT) fs.writeFileSync(process.env.PCF_EVIDENCE_OUT, JSON.stringify(state.results, null, 1));
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
