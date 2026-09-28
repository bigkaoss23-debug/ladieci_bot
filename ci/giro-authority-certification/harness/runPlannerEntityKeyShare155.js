'use strict';
// N2 / migration 155 -- Planner re-certification runner (ephemeral PostgreSQL only; never staging, never production).
// PRE-155 = EXACTLY the POST-140 template runRiderCanonicalPayment.js certifies (130-138 + the REAL ledger, md5-checked against
// staging, + the REAL migrations 139 and 140). POST-155 = the same template + the four function bodies of
// migrations/2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.sql, extracted VERBATIM from the committed file
// (the migration's own guard pins the 151 .. 154 Economy bodies, which this Planner fixture does not carry; the four CREATE OR REPLACE
// statements are the complete Planner change). The runner proves the predecessor bodies on the fixture are the ones 155 pins, that
// the installed bodies are the ones 155 certifies, and then re-runs EVERY W3 / W5 / W6 / B1 / B-RID-1 group of the 140 bench on
// PRE-155 and on POST-155: 155 must change no outcome of any Planner scenario.
//
//   PGHOST=... PGPORT=... PGUSER=<bootstrap superuser, not "postgres"> PGPASSWORD=... W3_PG_NODE_MODULES=<dir with pg> \
//     node ci/giro-authority-certification/harness/runPlannerEntityKeyShare155.js [groupName ...]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');
const DED = require('./runDeliveryEconomyDecoupling');

const M139 = 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql';
const M140 = 'migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql';
const M155 = process.env.N2_FWD || 'migrations/2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.sql';
const RIDER_SID_HASH = crypto.createHash('sha256').update('sid-rider-harness').digest('hex');
const TARGETS = [
  ['public.start_rider_trip_v2(uuid,text,integer,uuid[])', '0323fbb1bab76a12fd2be3fed0b3187e', 'baa7e42e28b15565e93f5da66374a6a9'],
  ['public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])', 'e4966ba63a075f6914c26d6508cfef00', 'b5823fc5417a92007295efe531a899f0'],
  ['public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])', '85fb8a84ed311edfa02c11a4c7f9afec', '4f39a046a0c4f04ef4ea5cc548328f03'],
  ['public.giro_authority_consume_intent_v1(uuid,text,uuid[])', '3dde47553cc347d097735df8ba7ca5aa', '2a59a168d43c398d9e34d3ae651d1ea4'],
];

// The four CREATE OR REPLACE FUNCTION statements of 155, verbatim.
function statements155() {
  const sql = path.isAbsolute(M155) ? fs.readFileSync(M155, 'utf8') : rt.readRepo(M155);
  const out = [];
  const re = /CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\(/g; let m;
  while ((m = re.exec(sql))) {
    const tagM = /AS (\$[A-Za-z_]*\$)/.exec(sql.slice(m.index)); const tag = tagM[1];
    const bodyStart = m.index + tagM.index + tagM[0].length; const end = sql.indexOf(tag, bodyStart) + tag.length;
    out.push({ name: m[1], sql: sql.slice(m.index, end) + ';' });
  }
  return out;
}
async function md5s(su) {
  const r = {}; for (const [sig] of TARGETS) r[sig] = (await su.query('SELECT md5(prosrc) m FROM pg_proc WHERE oid = to_regprocedure($1)', [sig])).rows[0].m; return r;
}
async function posture(su) {
  return (await su.query(`SELECT p.oid::regprocedure::text sig, p.prosecdef, pg_get_userbyid(p.proowner) owner, p.proconfig::text cfg, p.proacl::text acl
                            FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`, [TARGETS.map((t) => t[0])])).rows;
}
async function buildPre155(su) {
  const led = await DED.buildPre(su);
  await DED.applyRepoAsPostgres(su, M139);
  await DED.applyRepoAsPostgres(su, M140);
  return led;
}
async function apply155(su) {
  await su.query('SET ROLE postgres');
  try { for (const s of statements155()) await su.query(s.sql); } finally { await su.query('RESET ROLE'); }
}

async function phaseApply(env) {
  section('N2-0 PROVENANCE -- PRE-155 = the certified POST-140 Planner/ledger template; its bodies are the ones 155 pins');
  const p = await rt.buildFixtureDb(env.cl, env.admin, 'pc155_prov');
  const led = await buildPre155(p.su);
  assert('the REAL ledger on the fixture is byte-identical to staging', led.mismatches.length === 0 && led.missing.length === 0, led);
  const pre = await md5s(p.su);
  for (const [sig, oldMd5] of TARGETS) assert(`PRE-155 ${sig.slice(7, sig.indexOf('('))} is the predecessor body 155 pins (${oldMd5.slice(0, 8)}...)`, pre[sig] === oldMd5, pre[sig]);
  const postureBefore = await posture(p.su);
  const stmts = statements155();
  assert('migration 155 carries exactly the four Planner CREATE OR REPLACE statements', stmts.length === 4 && JSON.stringify(stmts.map((s) => s.name).sort()) ===
    JSON.stringify(['giro_authority_attach_or_move_v1', 'giro_authority_consume_intent_v1', 'giro_authority_create_or_move_v1', 'start_rider_trip_v2']), stmts.map((s) => s.name));
  await apply155(p.su);
  const post = await md5s(p.su);
  for (const [sig, , newMd5] of TARGETS) assert(`POST-155 ${sig.slice(7, sig.indexOf('('))} is the body 155 certifies (${newMd5.slice(0, 8)}...)`, post[sig] === newMd5, post[sig]);
  const postureAfter = await posture(p.su);
  assert('signature, SECURITY DEFINER, owner, search_path and ACL of the four functions are unchanged', JSON.stringify(postureBefore) === JSON.stringify(postureAfter), { postureBefore, postureAfter });
  await p.su.end();
  const tpre = await rt.buildFixtureDb(env.cl, env.admin, 'pc155_pre155_tpl'); await buildPre155(tpre.su); await tpre.su.end();
  const tpost = await rt.buildFixtureDb(env.cl, env.admin, 'pc155_post155_tpl'); await buildPre155(tpost.su); await apply155(tpost.su); await tpost.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  const perTemplate = {};
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'n2-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);
    // rerunnable: drop every database a previous run of THIS runner left behind (its own pc155_ prefix, plus the two fixed-name
    // scratch databases it builds), and nothing else
    for (const r of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'pc155\\_%' OR datname LIKE 'w3\\_lc\\_%' OR datname = 'brid_ded_pre_tpl'")).rows) {
      await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
    }
    let dbSeq = 0;
    const cloneFrom = async (tpl, label) => { const name = `pc155_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`.slice(0, 60); await rt.cloneDb(admin, tpl, name); return name; };
    env.clonePre = (label) => cloneFrom('brid_ded_pre_tpl', label);
    env.addSingleActiveIndex = DED.addSingleActiveIndex; env.applyRepoAsPostgres = DED.applyRepoAsPostgres; env.catalogFingerprint = DED.catalogFingerprint;
    env.fingerprintDiff = DED.fingerprintDiff; env.md5Of = DED.md5Of; env.RBK = DED.RBK; env.FWD = DED.FWD; env.PRE_CLOSE_MD5 = DED.PRE_CLOSE_MD5;
    env.OLD_SCOPE_CHK = DED.OLD_SCOPE_CHK; env.NEW_SCOPE_CHK = DED.NEW_SCOPE_CHK; env.LIVE_COMMENT_SERVICE = DED.LIVE_COMMENT_SERVICE; env.LIVE_COMMENT_TABLE = DED.LIVE_COMMENT_TABLE;
    env.BRID_FWD = M140; env.BRID_RBK = M140.replace(/\.sql$/, '.ROLLBACK.sql'); env.RIDER_SID_HASH = RIDER_SID_HASH;
    process.env.BRID_RIDER_SID_HASH = RIDER_SID_HASH;
    let applied = false; var expected139 = [];
    try { applied = await phaseApply(env); } catch (e) { section('phaseApply crashed'); assert('phaseApply completed without an unexpected exception', false, `${e.code || ''} ${e.stack || e.message}`); }
    if (applied) {
      // the ledger groups that need the 139 PRE contrast template (DED builds it as brid_ded_pre_tpl)
      const tded = await rt.buildFixtureDb(env.cl, env.admin, 'brid_ded_pre_tpl'); await DED.buildPre(tded.su); await tded.su.end();
      // the B-RID-1 group contrasts against the POST-139 / PRE-140 state, exactly as runRiderCanonicalPayment.js builds it
      const t139 = await rt.buildFixtureDb(env.cl, env.admin, 'pc155_pre140_tpl'); await DED.buildPre(t139.su); await DED.applyRepoAsPostgres(t139.su, M139); await t139.su.end();
      env.clonePre140 = (label) => cloneFrom('pc155_pre140_tpl', label);
      const failing = {};
      const REG = ['bRid1RiderCanonicalPayment', 'deliveryEconomyDecoupling', 'b2OffServiceReceipt', ...DED.REGRESSION_GROUPS.filter((g) => !DED.STUB_LEDGER_GROUPS.includes(g))];
      const groups = only.length ? only : REG;
      for (const [label, tpl] of [['PRE-155', 'pc155_pre155_tpl'], ['POST-155', 'pc155_post155_tpl']]) {
        env.clone = (l) => cloneFrom(tpl, l);
        for (const g of groups) {
          const p0 = state.pass, f0 = state.fail, r0 = state.results.length;
          // the lifecycle group's fixed-name scratch databases (w3_lc_raw, w3_lc_intent, ...): gone before every group, on both templates
          for (const r of (await admin.query("SELECT datname FROM pg_database WHERE datname LIKE 'w3\\_lc\\_%'")).rows) await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
          section(`=== GROUP ${g} on the ${label} template ===`);
          try { await require(path.join(__dirname, 'groups', `${g}.js`)).run(env); } catch (e) {
            section(`GROUP ${g} crashed`); assert(`group ${g} completed without an unexpected exception (${label})`, false, `${e.code || ''} ${e.stack || e.message}`);
          }
          perTemplate[`${label} ${g}`] = { pass: state.pass - p0, fail: state.fail - f0 };
          failing[`${label} ${g}`] = state.results.slice(r0).filter((x) => !x.ok).map((x) => x.name);
        }
      }
      section('N2-8 139 ROLLBACK ORDER -- with 155 applied, the 139 rollback is refused by 139\'s OWN guard (start_rider_trip_v2 is not the body it pins): roll back 155 first');
      { const dbn = await cloneFrom('pc155_post155_tpl', 'rb139'); const su = await rt.connect(env.cl, dbn, { name: 'n2-rb139' }); let err = null;
        try { await DED.applyRepoAsPostgres(su, env.RBK); } catch (e) { err = e; }
        assert('139 ROLLBACK on POST-155 is refused, and the refusal names start_rider_trip_v2', !!err && /start_rider_trip/.test(err.message), err ? err.message : '(accepted)'); await su.end(); }
      section('N2-9 NO PLANNER OUTCOME CHANGED -- every group fails exactly the same assertions on PRE-155 and POST-155, except the 139-rollback scenarios N2-8 proves');
      const ROLLBACK_139 = /^R[12]\//;
      // the 139-rollback scenarios POST-155 fails: the refusal itself (R1/a, R2/a: 139's own guard names start_rider_trip_v2) and the
      // post-rollback checks that therefore cannot hold (R2/b..d). They are EXPECTED -- counted apart, never silently dropped.
      for (const g of groups) {
        const pre = failing['PRE-155 ' + g] || [], post = failing['POST-155 ' + g] || [];
        for (const n of post.filter((x) => !pre.includes(x) && ROLLBACK_139.test(x))) expected139.push(`${g}: ${n}`);
      }
      for (const g of groups) {
        const pre = failing['PRE-155 ' + g] || [], post = failing['POST-155 ' + g] || [];
        const extra = post.filter((n) => !pre.includes(n)), missing = pre.filter((n) => !post.includes(n));
        const onlyRollback139 = extra.every((n) => ROLLBACK_139.test(n)) && missing.length === 0;
        assert(`group ${g}: POST-155 fails nothing PRE-155 does not (extra=${extra.length}, all 139-rollback scenarios=${onlyRollback139}); PRE-155 pass/fail ${JSON.stringify(perTemplate['PRE-155 ' + g])}`, onlyRollback139, { extra, missing, preFailing: pre });
      }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  if (process.env.N2_EVIDENCE_OUT) fs.writeFileSync(process.env.N2_EVIDENCE_OUT, JSON.stringify({ perTemplate, results: state.results }, null, 1));
  const exp = typeof expected139 !== 'undefined' ? expected139 : [];
  if (exp.length) { console.log('\nEXPECTED on POST-155 (139 rollback refused by 139\'s own guard; proven by N2-8, excluded by N2-9):'); for (const x of exp) console.log('  EXPECTED  ' + x); }
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed (' + exp.length + ' of them the expected 139-rollback scenarios on POST-155; unexpected: ' + (state.fail - exp.length) + ') ═══');
  process.exit(state.fail - exp.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
