'use strict';
// W5 Packet 01 certification runner (ephemeral PostgreSQL only). Applies the
// already-certified migration-130 candidate, then the migration-131 candidate on
// top, then re-runs the full W3 group suite (proving no regression) plus the new
// w5packet01 group.
//   node ci/giro-authority-certification/harness/runW5Packet01.js [groupName ...]

const fs = require('fs');
const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');

const W3_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle'];
const W5_GROUPS = ['w5packet01'];

async function phaseApply(env) {
  section('P1 APPLY — migration 130 candidate, then migration 131 candidate, on a staging-shaped fixture');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'w5_apply');
  let err = null;
  try {
    await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql');
  } catch (e) { err = e; }
  assert('migration 130 candidate applies cleanly (predecessor)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  let err2 = null;
  try {
    await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_packet01_v1.sql');
  } catch (e) { err2 = e; }
  assert('migration 131 candidate applies cleanly on top of 130 (guards + post-conditions pass)', !err2, err2 && `${err2.code} ${err2.message}`);
  if (err2) { await su.end(); return false; }

  const newFns = (await su.query(
    `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('giro_authority_create_or_move_v1', 'giro_authority_attach_or_move_v1')`
  )).rows;
  assert('exactly the 2 new public entry points exist', newFns.length === 2, newFns);
  const helper = await su.query("SELECT 1 FROM pg_proc WHERE oid = 'giro_authority.bump_facts_signal_v1()'::regprocedure");
  assert('private signal-bump helper exists', helper.rows.length === 1);
  const signal = await su.query("SELECT valore FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL'");
  assert('GIRO_FACTS_SIGNAL seeded at version 0', signal.rows.length === 1 && JSON.parse(signal.rows[0].valore).version === 0, signal.rows);
  await su.end();

  // Rollback proof: apply forward, then rollback, then re-apply forward again cleanly
  // on a throwaway clone -- proves the rollback pair is real and non-destructive to
  // the predecessor (migration 130 stays intact).
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'w5_rollback_proof');
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_packet01_v1.sql');
  let rbErr = null;
  try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_packet01_v1.ROLLBACK.sql'); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const gone = await rb.su.query(
      `SELECT (to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NULL
               AND to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])') IS NULL) AS both_gone`
    );
    assert('rollback removed both new commands', gone.rows[0].both_gone === true, gone.rows);
    const signalGone = await rb.su.query("SELECT count(*)::int AS n FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL'");
    assert('rollback removed the untouched (version 0) signal seed', signalGone.rows[0].n === 0, signalGone.rows);
    const detachOk = await rb.su.query("SELECT giro_authority.actor_valid_v1('op-1')").catch(() => null);
    assert('predecessor (migration 130) objects still callable after rollback', !!detachOk);
    let reapplyErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_packet01_v1.sql'); } catch (e) { reapplyErr = e; }
    assert('forward candidate re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
  }
  await rb.su.end();

  // Template for the scenario groups: fixture + both candidates applied.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'w5_tpl');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'w5-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `w5_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'w5_tpl', name);
      return name;
    };

    const applied = await phaseApply(env);
    if (applied) {
      const groups = only.length ? only : [...W3_GROUPS, ...W5_GROUPS];
      for (const g of groups) {
        const file = path.join(__dirname, 'groups', `${g}.js`);
        if (!fs.existsSync(file)) continue;
        try {
          await require(file).run(env);
        } catch (e) {
          section(`GROUP ${g} crashed`);
          assert(`group ${g} completed without an unexpected exception`, false, `${e.code || ''} ${e.stack || e.message}`);
        }
      }
    }
  } finally {
    if (admin) await admin.end().catch(() => {});
    await cl.stop().catch(() => {});
  }
  console.log('\n═══ RESULT: ' + state.pass + ' passed, ' + state.fail + ' failed ═══');
  process.exit(state.fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
