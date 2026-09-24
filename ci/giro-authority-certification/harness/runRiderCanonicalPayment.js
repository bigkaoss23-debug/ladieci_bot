'use strict';
// B-RID-1 RIDER_PAYMENT_RECEIPT_LINEAGE_GAP (migration 140) certification runner (ephemeral PostgreSQL only; never staging,
// never production). Builds EXACTLY the chain runDeliveryEconomyDecoupling.js certifies (130-138 + the REAL ledger,
// md5-checked against staging) + the REAL migration 139 = the PRE-140 template (= staging after 139); the REAL
// migrations/2026-09-23_..._migration_140.sql applied on top is the POST-140 template.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres@17 and pg> [W3_PG_DATA_ROOT=<tmp>] \
//     node ci/giro-authority-certification/harness/runRiderCanonicalPayment.js [groupName ...]
//
// Groups: bRid1RiderCanonicalPayment (new, R1..R15 + extras) on POST-140; then, as REGRESSION on POST-140, every
// real-ledger group of the 139 bench (deliveryEconomyDecoupling, b2OffServiceReceipt, boundary, commands, projection,
// capture, consume, concurrency, noMoney, lifecycle, w5packet01, w5IntentActivation, w6LockOrder, w6TripAuthority), with
// the rider calls carrying the session proof (BRID_RIDER_SID_HASH). The two stub-ledger groups (w6RiderLifecycle,
// b1RiderDispatchOperatorParity) cannot run on the real ledger by construction; their money-bearing rider scenarios are
// re-proved end to end on the REAL writer by bRid1RiderCanonicalPayment.
//
// BRID_FWD / BRID_RBK (absolute paths) let the mutation check run the SAME scenarios against a mutated forward / rollback.
// `none` as the only group runs the apply/rollback phase only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');
const DED = require('./runDeliveryEconomyDecoupling');

const M139 = 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql';
const FWD = process.env.BRID_FWD || 'migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql';
const RBK = process.env.BRID_RBK || 'migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql';
const readAny = (rel) => (path.isAbsolute(rel) ? fs.readFileSync(rel, 'utf8') : rt.readRepo(rel));

// Bodies at ledger 139 (the predecessors 140 pins): rider RPC = ledger 135, legacy writer = ledger 126 (= staging live,
// realLedger.LIVE_MD5), canonical writer = ledger 139.
const PRE = Object.freeze({ rider: '4b2b4f4ce6155deea2e7f15a74f7707c', lwp: '94fa5265c0ad334b79f3f00228f8300d', opv1: 'af52d59658719bd7898d9cd88dd29179' });
const OLD_ROLE_CHK = "CHECK ((by_role = ANY (ARRAY['admin'::text, 'operator'::text, 'owner'::text, 'cashier'::text, 'legacy_operator'::text])))";
const SIG7 = 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)';
const SIG8 = 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)';
const SIG_LWP = 'public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)';
const SIG_OPV1 = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)';
const RIDER_SID_HASH = crypto.createHash('sha256').update('sid-rider-harness').digest('hex');

async function bodies(su) {
  const q = (sig) => `(SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('${sig}'))`;
  return (await su.query(`SELECT ${q(SIG7)} AS rider7, ${q(SIG8)} AS rider8, ${q(SIG_LWP)} AS lwp, ${q(SIG_OPV1)} AS opv1,
    (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass
       AND c.conname = 'payment_transactions_by_role_check') AS role_chk`)).rows[0];
}
// md5 pins the ROLLBACK guards on (= the bodies 140 installs).
function rollbackPins() {
  const sql = readAny(RBK);
  const pins = [...sql.matchAll(/md5\(v_src\) IS DISTINCT FROM '([0-9a-f]{32})'/g)].map((m) => m[1]);
  return { rider: pins[0], opv1: pins[1] };
}
const FN_POSTURE = `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig::text AS cfg, p.proacl::text AS acl
                      FROM pg_proc p WHERE p.proname IN ('rider_collect_and_complete_stop', '_ledger_write_payment', 'order_post_payment_v1')
                       AND p.pronamespace = 'public'::regnamespace ORDER BY 1`;

async function buildPre140(su) {
  const led = await DED.buildPre(su);
  await DED.applyRepoAsPostgres(su, M139);
  return led;
}

async function phaseApply(env) {
  section('B0 PROVENANCE -- the pre-140 state is the 139 candidate on the REAL ledger (bodies = the ledger bodies 140 pins)');
  const prov = await rt.buildFixtureDb(env.cl, env.admin, 'brid_prov');
  const led = await buildPre140(prov.su);
  const pre = await bodies(prov.su);
  assert('the REAL ledger installed on the fixture is byte-identical to staging (every helper/writer md5(prosrc) = live)',
    led.mismatches.length === 0 && led.missing.length === 0 && led.checked >= 10, led);
  assert(`pre-140 rider_collect_and_complete_stop (7 args) is the ledger-135 body (md5 ${PRE.rider})`, pre.rider7 === PRE.rider && pre.rider8 === null, pre);
  assert(`pre-140 _ledger_write_payment is the ledger-126 body = staging live (md5 ${PRE.lwp})`, pre.lwp === PRE.lwp, pre);
  assert(`pre-140 order_post_payment_v1 is the ledger-139 body (md5 ${PRE.opv1})`, pre.opv1 === PRE.opv1, pre);
  assert('pre-140 payment_transactions_by_role_check is the exact V3-H constraint (no rider)', pre.role_chk === OLD_ROLE_CHK, pre);
  const callers = (await prov.su.query(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.prosrc LIKE '%\\_ledger\\_write\\_payment(%'
                                          AND p.proname <> '_ledger_write_payment' ORDER BY 1`)).rows.map((r) => r.sig);
  assert('CALLER GRAPH (pre-140, real catalog): the ONLY function body calling _ledger_write_payment is the 7-argument rider RPC',
    JSON.stringify(callers) === JSON.stringify(['rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)']), callers);
  await prov.su.end();

  section('B1 APPLY -- migration 140 on top of 139: guards + post-conditions pass; EXACTLY the expected catalog entries move');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'brid_apply');
  await buildPre140(su);
  const postureBefore = (await su.query(FN_POSTURE)).rows;
  const fpBefore = await DED.catalogFingerprint(su);
  let err = null;
  try { await DED.applyRepoAsPostgres(su, FWD); } catch (e) { err = e; }
  assert('migration 140 applies cleanly on top of 139 (predecessor/drift/reachability guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }
  const post = await bodies(su);
  const pins = rollbackPins();
  assert('the 7-argument rider RPC is GONE and the 8-argument one is the exact body the ROLLBACK guard pins', post.rider7 === null && post.rider8 === pins.rider, { post, pins });
  assert('order_post_payment_v1 is the exact 140 body the ROLLBACK guard pins (and no longer the 139 one)', post.opv1 === pins.opv1 && post.opv1 !== PRE.opv1, { post, pins });
  assert('ZERO REACHABILITY: _ledger_write_payment no longer exists', post.lwp === null, post);
  const stillCalling = (await su.query(`SELECT count(*)::int AS n FROM pg_proc p WHERE p.prosrc LIKE '%\\_ledger\\_write\\_payment(%'`)).rows[0].n;
  assert('ZERO REACHABILITY: no function body in the database calls _ledger_write_payment', stillCalling === 0, { stillCalling });
  const postureAfter = (await su.query(FN_POSTURE)).rows;
  const r8 = postureAfter.find((r) => r.sig.startsWith('rider_collect_and_complete_stop(')); const r7 = postureBefore.find((r) => r.sig.startsWith('rider_collect_and_complete_stop('));
  assert('the 8-argument rider RPC carries EXACTLY the owner / SECURITY INVOKER / search_path / ACL of the function it replaced ({postgres, service_role})',
    r8 && r7 && r8.owner === r7.owner && r8.prosecdef === r7.prosecdef && r8.cfg === r7.cfg && r8.acl === r7.acl && r8.acl === '{postgres=X/postgres,service_role=X/postgres}', { r7, r8 });
  const w0 = postureBefore.find((r) => r.sig.startsWith('order_post_payment_v1(')); const w1 = postureAfter.find((r) => r.sig.startsWith('order_post_payment_v1('));
  assert('order_post_payment_v1 kept owner / SECURITY / search_path / ACL', JSON.stringify(w0) === JSON.stringify(w1), { w0, w1 });
  const priv = (await su.query(`SELECT has_function_privilege('anon', '${SIG8}', 'EXECUTE') AS anon, has_function_privilege('authenticated', '${SIG8}', 'EXECUTE') AS auth,
                                        has_function_privilege('service_role', '${SIG8}', 'EXECUTE') AS svc`)).rows[0];
  assert('only service_role may execute the rider RPC (anon / authenticated may not)', !priv.anon && !priv.auth && priv.svc, priv);
  const fpAfter = await DED.catalogFingerprint(su);
  const touched = DED.fingerprintDiff(fpBefore, fpAfter);
  const EXPECTED = [
    ['constraintComments:public.payment_transactions::payment_transactions_by_role_check', 1],
    ['constraints:public.payment_transactions::payment_transactions_by_role_check', 1],
    ['functions:public._ledger_write_payment(', 1],
    ['functions:public.order_post_payment_v1(', 1],
    ['functions:public.rider_collect_and_complete_stop(', 2],   // the 7-argument one removed, the 8-argument one added
  ];
  assert('B1 CATALOG FINGERPRINT: 140 changed EXACTLY the role constraint + its comment, the canonical writer, the rider RPC (7 -> 8 args) and dropped the legacy writer -- no other constraint, comment, column, index, trigger, table owner/ACL/RLS or function moved',
    touched.length === 6 && EXPECTED.every(([p, n]) => touched.filter((t) => t.startsWith(p)).length === n), touched);
  assert('B1 the new role constraint admits rider ONLY for the rider-delivery payment shape',
    /by_role = 'rider'::text\) AND \(kind = 'payment'::text\) AND \(mode = 'full'::text\) AND \(table_session_id IS NULL\) AND \(covers_settled = 0\) AND COALESCE\(\(\(meta -> 'source'::text\) = '"rider_delivery"'::jsonb\), false\)/.test(post.role_chk), post.role_chk);
  await su.end();

  // Double apply / rollback without apply.
  const dbl = await rt.buildFixtureDb(env.cl, env.admin, 'brid_double');
  await buildPre140(dbl.su);
  await DED.applyRepoAsPostgres(dbl.su, FWD);
  let dblErr = null;
  try { await DED.applyRepoAsPostgres(dbl.su, FWD); } catch (e) { dblErr = e; }
  assert('double apply of 140 is refused (typed guard)', !!dblErr && /B_RID_1 refused/.test(dblErr.message), dblErr ? dblErr.message : '(second apply silently succeeded)');
  await dbl.su.end();
  const rbwa = await rt.buildFixtureDb(env.cl, env.admin, 'brid_rb_without_apply');
  await buildPre140(rbwa.su);
  let rbwaErr = null;
  try { await DED.applyRepoAsPostgres(rbwa.su, RBK); } catch (e) { rbwaErr = e; }
  assert('rollback without a prior apply is refused (typed guard)', !!rbwaErr && /B_RID_1 rollback refused/.test(rbwaErr.message), rbwaErr ? rbwaErr.message : '(rollback silently succeeded)');
  await rbwa.su.end();

  // 140 on top of 138 WITHOUT 139 (the predecessor order is enforced).
  const no139 = await rt.buildFixtureDb(env.cl, env.admin, 'brid_no139');
  await DED.buildPre(no139.su);
  let no139Err = null;
  try { await DED.applyRepoAsPostgres(no139.su, FWD); } catch (e) { no139Err = e; }
  assert('140 on a database WITHOUT 139 is refused (order_post_payment_v1 is not the 139 body)', !!no139Err && /not the exact ledger-139 body/.test(no139Err.message), no139Err ? no139Err.message : '(accepted)');
  await no139.su.end();

  // Drift: one predecessor at a time, and a SECOND caller of the legacy writer (reachability guard).
  const drifts = [
    ['a drifted rider_collect_and_complete_stop', async (c) => {
      const cur = (await c.query(`SELECT pg_get_functiondef('${SIG7}'::regprocedure) AS d`)).rows[0].d;
      await c.query(cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER\n'));
    }],
    ['a drifted _ledger_write_payment', async (c) => {
      const cur = (await c.query(`SELECT pg_get_functiondef('${SIG_LWP}'::regprocedure) AS d`)).rows[0].d;
      await c.query(cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER\n'));
    }],
    ['a drifted order_post_payment_v1', async (c) => {
      const cur = (await c.query(`SELECT pg_get_functiondef('${SIG_OPV1}'::regprocedure) AS d`)).rows[0].d;
      await c.query(cur.replace(/\nBEGIN\n/, '\nBEGIN\n  -- DRIFT_MARKER\n'));
    }],
    ['a drifted payment_transactions_by_role_check', async (c) => {
      await c.query(`ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_by_role_check;
        ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_by_role_check CHECK (by_role IN ('admin','operator','owner','cashier','legacy_operator','rider'))`);
    }],
    ['a comment already present on payment_transactions_by_role_check', async (c) => {
      await c.query(`COMMENT ON CONSTRAINT payment_transactions_by_role_check ON public.payment_transactions IS 'drift'`);
    }],
    ['ANOTHER function still calling _ledger_write_payment (it is not dead on this database)', async (c) => {
      await c.query(`CREATE FUNCTION public.zz_other_legacy_caller() RETURNS jsonb LANGUAGE plpgsql AS $x$
        BEGIN RETURN public._ledger_write_payment('#1', 'efectivo', NULL, 'rider', 'rider', 'ip', '{}'::jsonb, 'pay-order-1'); END $x$`);
    }],
  ];
  for (const [label, inject] of drifts) {
    const d = await rt.buildFixtureDb(env.cl, env.admin, `brid_drift_${drifts.findIndex((x) => x[0] === label)}`);
    await buildPre140(d.su);
    await d.su.query('SET ROLE postgres'); await inject(d.su); await d.su.query('RESET ROLE');
    let e2 = null;
    try { await DED.applyRepoAsPostgres(d.su, FWD); } catch (e) { e2 = e; }
    assert(`forward apply against ${label} is refused (typed guard)`, !!e2 && /B_RID_1 refused/.test(e2.message), e2 ? `${e2.code} ${e2.message}` : '(drift silently accepted)');
    const still = await bodies(d.su);
    assert(`...and the refused forward left NOTHING behind (${label})`, still.rider8 === null && still.lwp !== null, still);
    await d.su.end();
  }

  // Rollback proof: exact restoration to POST-139 + round trip.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'brid_rollback_proof');
  await buildPre140(rb.su);
  const fp0 = await DED.catalogFingerprint(rb.su);
  const posture0 = (await rb.su.query(FN_POSTURE)).rows;
  await DED.applyRepoAsPostgres(rb.su, FWD);
  const fp1 = await DED.catalogFingerprint(rb.su);
  assert('rollback proof pre-condition: 140 really changed the catalog (the comparison below is not vacuous)', DED.fingerprintDiff(fp0, fp1).length === 6, DED.fingerprintDiff(fp0, fp1));
  let rbErr = null;
  try { await DED.applyRepoAsPostgres(rb.su, RBK); } catch (e) { rbErr = e; }
  assert('rollback applies cleanly (no rider-authored transaction exists)', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const fp2 = await DED.catalogFingerprint(rb.su);
    const diff = DED.fingerprintDiff(fp0, fp2);
    assert('RB: CATALOG FINGERPRINT after the rollback == before 140, entry by entry (constraint + comment, the three functions with md5 + owner + SECURITY + search_path + ACL, columns, indexes, triggers): EXACT restoration',
      diff.length === 0, diff);
    const b = await bodies(rb.su);
    assert('RB: rider RPC (7 args) = ledger-135 body, _ledger_write_payment = ledger-126 body, writer = ledger-139 body, role constraint = V3-H',
      b.rider7 === PRE.rider && b.rider8 === null && b.lwp === PRE.lwp && b.opv1 === PRE.opv1 && b.role_chk === OLD_ROLE_CHK, b);
    assert('RB: owner / SECURITY / search_path / ACL of the restored functions are exactly the pre-140 ones', JSON.stringify(posture0) === JSON.stringify((await rb.su.query(FN_POSTURE)).rows));
    let reErr = null;
    try { await DED.applyRepoAsPostgres(rb.su, FWD); } catch (e) { reErr = e; }
    assert('forward 140 re-applies cleanly after the rollback (round trip)', !reErr, reErr && reErr.message);
    const again = await bodies(rb.su);
    assert('re-applied bodies equal the first-apply bodies (deterministic)', again.rider8 === pins.rider && again.opv1 === pins.opv1 && again.lwp === null, again);
  }
  await rb.su.end();

  // 139's own rollback is refused while 140 is applied (the documented order: 140 first).
  const ord = await rt.buildFixtureDb(env.cl, env.admin, 'brid_139rb_order');
  await buildPre140(ord.su);
  await DED.applyRepoAsPostgres(ord.su, FWD);
  let ordErr = null;
  try { await DED.applyRepoAsPostgres(ord.su, DED.RBK); } catch (e) { ordErr = e; }
  assert('the 139 rollback is REFUSED while 140 is applied (typed md5 guard) -- rollback order is 140 then 139', !!ordErr && /refused/.test(ordErr.message), ordErr ? ordErr.message : '(accepted)');
  await ord.su.end();

  // Templates.
  const tpre = await rt.buildFixtureDb(env.cl, env.admin, 'brid_ded_pre_tpl');   // post-138 + real ledger (139 bench PRE)
  await DED.buildPre(tpre.su);
  await tpre.su.end();
  const t139 = await rt.buildFixtureDb(env.cl, env.admin, 'brid_pre140_tpl');    // post-139
  await buildPre140(t139.su);
  await t139.su.end();
  const t140 = await rt.buildFixtureDb(env.cl, env.admin, 'brid_post140_tpl');   // post-140
  await buildPre140(t140.su);
  await DED.applyRepoAsPostgres(t140.su, FWD);
  await t140.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'brid-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);
    let dbSeq = 0;
    const cloneFrom = async (tpl, label) => {
      const name = `brid_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`.slice(0, 60);
      await rt.cloneDb(admin, tpl, name);
      return name;
    };
    env.clone = (label) => cloneFrom('brid_post140_tpl', label);
    env.clonePre = (label) => cloneFrom('brid_ded_pre_tpl', label);      // the 139 bench's PRE-139 contrast, unchanged
    env.clonePre140 = (label) => cloneFrom('brid_pre140_tpl', label);   // post-139 = the state 140 corrects
    env.addSingleActiveIndex = DED.addSingleActiveIndex;
    env.applyRepoAsPostgres = DED.applyRepoAsPostgres;
    env.catalogFingerprint = DED.catalogFingerprint;
    env.fingerprintDiff = DED.fingerprintDiff;
    env.md5Of = DED.md5Of;
    env.RBK = DED.RBK; env.FWD = DED.FWD; env.PRE_CLOSE_MD5 = DED.PRE_CLOSE_MD5;
    env.OLD_SCOPE_CHK = DED.OLD_SCOPE_CHK; env.NEW_SCOPE_CHK = DED.NEW_SCOPE_CHK;
    env.LIVE_COMMENT_SERVICE = DED.LIVE_COMMENT_SERVICE; env.LIVE_COMMENT_TABLE = DED.LIVE_COMMENT_TABLE;
    env.BRID_FWD = FWD; env.BRID_RBK = RBK; env.RIDER_SID_HASH = RIDER_SID_HASH;
    process.env.BRID_RIDER_SID_HASH = RIDER_SID_HASH;                    // the shared riderStop helper passes the proof

    let applied = false;
    try { applied = await phaseApply(env); } catch (e) {
      section('phaseApply crashed');
      assert('phaseApply completed without an unexpected exception', false, `${e.code || ''} ${e.stack || e.message}`);
    }
    if (applied) {
      const REG = ['deliveryEconomyDecoupling', 'b2OffServiceReceipt', ...DED.REGRESSION_GROUPS.filter((g) => !DED.STUB_LEDGER_GROUPS.includes(g))];
      const groups = only.length ? only : ['bRid1RiderCanonicalPayment', ...REG];
      for (const g of groups) {
        if (g === 'none') continue;
        section(`=== GROUP ${g} on the POST-140 template ===`);
        try { await require(path.join(__dirname, 'groups', `${g}.js`)).run(env); } catch (e) {
          section(`GROUP ${g} crashed`);
          assert(`group ${g} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`);
        }
      }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  if (process.env.BRID_EVIDENCE_OUT) fs.writeFileSync(process.env.BRID_EVIDENCE_OUT, JSON.stringify(state.results, null, 1));
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
