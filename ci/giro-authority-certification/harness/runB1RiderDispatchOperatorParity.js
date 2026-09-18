'use strict';
// B1_RIDER_DISPATCH_OPERATOR_PARITY (migration 137) certification runner (ephemeral
// PostgreSQL only). Applies the migration-130..135 candidate chain (the same chain
// runW6RiderLifecycle.js uses), then the new migration-137 candidate on top; re-runs
// the full W3 + W5 Packet 01 + W5 Intent Activation + W6.1 + W6.2 + W6.3/W6.4 regression
// suites, plus the new b1RiderDispatchOperatorParity group covering the migration-137
// delta itself: real admin/operator/rider departures, the dispatched_by/rider_actor
// identity-truth split, the untouched rider-exclusive money-collection contract, the
// predecessor/drift guard, and the exact-restoration/PONR rollback contract.
//
//   node ci/giro-authority-certification/harness/runB1RiderDispatchOperatorParity.js [groupName ...]

const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert, fixture } = require('./lib');

const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle', 'w5packet01', 'w5IntentActivation', 'w6LockOrder', 'w6TripAuthority', 'w6RiderLifecycle'];
const NEW_GROUPS = ['b1RiderDispatchOperatorParity'];

// The exact migration-135 body this candidate replaces, independently re-derived by this
// harness itself (matches both the migration file's own guard constant and the Opus
// delta review's independent extraction: length 11366, md5 8787814e8020b6fa4322d42febc3a78a).
const PRE_137_MD5 = '8787814e8020b6fa4322d42febc3a78a';

const CLOSE_SESSION_PREDECESSOR_STUB = require('fs').readFileSync(
  path.join(__dirname, 'closeSessionStub.b1.sql'), 'utf8');
const LEDGER_WRITER_STUB = require('fs').readFileSync(
  path.join(__dirname, 'ledgerStub.b1.sql'), 'utf8');

async function installCloseSessionPredecessorStub(su) {
  await su.query('SET ROLE postgres');
  await su.query(CLOSE_SESSION_PREDECESSOR_STUB);
  await su.query('RESET ROLE');
}

async function installLedgerWriterStub(su) {
  await su.query('SET ROLE postgres');
  await su.query(LEDGER_WRITER_STUB);
  await su.query(
    'REVOKE EXECUTE ON FUNCTION public._ledger_write_payment(text,text,numeric,text,text,text,jsonb,text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public._ledger_write_payment(text,text,numeric,text,text,text,jsonb,text) TO service_role; ' +
    'GRANT SELECT, INSERT, UPDATE ON public.fixture_ledger_control TO service_role; ' +
    'GRANT SELECT, INSERT ON public.order_financial_events TO service_role; ' +
    'GRANT USAGE, SELECT ON SEQUENCE public.order_financial_events_id_seq TO service_role;');
  await su.query('RESET ROLE');
}

function extractDollarFunction(sql, name, tag) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const i = sql.indexOf(marker);
  if (i < 0) throw new Error(`function ${name} not found`);
  const openTag = `AS $${tag}$`;
  const j = sql.indexOf(openTag, i);
  const closeTag = `$${tag}$;`;
  const k = sql.indexOf(closeTag, j + openTag.length);
  return sql.slice(i, k + closeTag.length);
}

async function installRiderCollectPredecessor(su) {
  const sql = rt.readRepo('migrations/2026-07-27_s2_7d6e3a_rider_ledger_writer_additive.sql');
  const text = extractDollarFunction(sql, 'rider_collect_and_complete_stop', 'fn');
  await su.query('SET ROLE postgres');
  await su.query(text);
  await su.query(
    'REVOKE EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated; ' +
    'GRANT EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) TO service_role;');
  await su.query('RESET ROLE');
}

async function extendAuthActorsForRiderAuth(su) {
  await su.query('SET ROLE postgres');
  await su.query(`
    ALTER TABLE public.auth_actors
      ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'operator',
      ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS workspace_id uuid NOT NULL DEFAULT gen_random_uuid();`);
  await su.query('RESET ROLE');
}

async function applyThroughMigration134(su) {
  await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await installCloseSessionPredecessorStub(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_intent_activation_v1.sql');
  await extendAuthActorsForRiderAuth(su);
  await installRiderCollectPredecessor(su);
  await installLedgerWriterStub(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_trip_authority_v1.sql');
}

async function applyThroughMigration135(su) {
  await applyThroughMigration134(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_rider_lifecycle_v1.sql');
}

async function applyThroughMigration137(su) {
  await applyThroughMigration135(su);
  await rt.applyAsPostgres(su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.sql');
}

async function phaseApply(env) {
  section('P0 PROVENANCE -- the pre-137 body this candidate replaces is the migration-135 body');
  const prov = await rt.buildFixtureDb(env.cl, env.admin, 'b1_prov');
  await applyThroughMigration135(prov.su);
  const got = (await prov.su.query(`SELECT md5(prosrc) AS m FROM pg_proc
     WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')`)).rows[0].m;
  assert(`pre-137 start_rider_trip_v2 is byte-identical to the migration-135 body (md5 ${PRE_137_MD5})`, got === PRE_137_MD5, { got, expected: PRE_137_MD5 });
  await prov.su.end();

  section('P1 APPLY -- migrations 130-135, then the 137 candidate, on a staging-shaped fixture');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'b1_apply');
  let err = null;
  try { await applyThroughMigration137(su); } catch (e) { err = e; }
  assert('migrations 130-135 + the 137 candidate all apply cleanly (guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  const shape = (await su.query(`
    SELECT
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='trip_authority' AND table_name='trips' AND column_name='rider_actor') AS rider_actor_nullable,
      (SELECT is_nullable FROM information_schema.columns WHERE table_schema='trip_authority' AND table_name='trips' AND column_name='dispatched_by') AS dispatched_by_nullable,
      (SELECT count(*) FROM trip_authority.trips) AS trip_count`)).rows[0];
  assert('rider_actor is now nullable', shape.rider_actor_nullable === 'YES', shape);
  assert('dispatched_by exists and is NOT NULL', shape.dispatched_by_nullable === 'NO', shape);
  assert('trip_authority.trips is still empty immediately after apply', Number(shape.trip_count) === 0, shape);

  const sec = (await su.query(`
    SELECT bool_or(has_function_privilege('anon', s, 'EXECUTE') OR has_function_privilege('authenticated', s, 'EXECUTE')) AS api_can_execute
      FROM unnest(ARRAY['public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure,
                        'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure]) AS s`)).rows[0];
  assert('no API role (anon/authenticated) may execute either canonical entry point', sec.api_can_execute === false, sec);
  await su.end();

  // Double-apply: re-applying 137 on top of ITSELF must fail closed (the predecessor
  // guard sees the post-137 body, not the pinned pre-137 md5, and refuses).
  const dbl = await rt.buildFixtureDb(env.cl, env.admin, 'b1_double_apply');
  await applyThroughMigration137(dbl.su);
  let dblErr = null;
  try { await rt.applyAsPostgres(dbl.su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.sql'); } catch (e) { dblErr = e; }
  assert('double apply of 137 is refused (predecessor guard sees the post-137 body, not migration-135\'s)', !!dblErr, dblErr ? `${dblErr.code} ${dblErr.message}` : '(second apply silently succeeded)');
  await dbl.su.end();

  // Rollback-without-apply: rolling back 137 on a fixture that never applied it must refuse.
  const rbwa = await rt.buildFixtureDb(env.cl, env.admin, 'b1_rollback_without_apply');
  await applyThroughMigration135(rbwa.su);
  let rbwaErr = null;
  try { await rt.applyAsPostgres(rbwa.su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.ROLLBACK.sql'); } catch (e) { rbwaErr = e; }
  assert('rollback without a prior apply is refused (dispatched_by column absent)', !!rbwaErr, rbwaErr ? `${rbwaErr.code} ${rbwaErr.message}` : '(rollback silently succeeded)');
  await rbwa.su.end();

  // Forward drift: mutate the installed migration-135 body slightly (a real prosrc
  // change, not just a COMMENT), then attempt 137 -> must refuse (md5 mismatch), never
  // silently overwrite the drifted body.
  const drift = await rt.buildFixtureDb(env.cl, env.admin, 'b1_forward_drift');
  await applyThroughMigration135(drift.su);
  const fullSql135 = rt.readCert('candidate/giro_authority_w6_rider_lifecycle_v1.sql');
  const driftedFn = extractDollarFunction(fullSql135, 'start_rider_trip_v2', 'fn')
    .replace('BEGIN\n  -- L0 (W6.1 protocol)', 'BEGIN\n  -- DRIFT_MARKER (harness-injected, proves the guard detects real drift)\n  -- L0 (W6.1 protocol)');
  assert('drift fixture actually changed the function text before installing it', driftedFn.includes('DRIFT_MARKER'), { len: driftedFn.length });
  await drift.su.query('SET ROLE postgres');
  await drift.su.query(driftedFn);
  await drift.su.query('RESET ROLE');
  let driftErr = null;
  try { await rt.applyAsPostgres(drift.su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.sql'); } catch (e) { driftErr = e; }
  assert('forward apply against a DRIFTED predecessor body is refused (md5 mismatch)', !!driftErr, driftErr ? `${driftErr.code} ${driftErr.message}` : '(drifted predecessor silently accepted)');
  await drift.su.end();

  // Rollback proof: apply forward (130-137), roll back 137 only, re-apply cleanly.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'b1_rollback_proof');
  await applyThroughMigration137(rb.su);
  let rbErr = null;
  try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.ROLLBACK.sql'); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly while every trip row is rider-dispatched (none NULL)', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const restored = (await rb.su.query(`
      SELECT md5(prosrc) AS m,
             (SELECT is_nullable FROM information_schema.columns WHERE table_schema='trip_authority' AND table_name='trips' AND column_name='rider_actor') AS rider_actor_nullable,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='trip_authority' AND table_name='trips' AND column_name='dispatched_by') AS dispatched_by_exists
        FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')`)).rows[0];
    assert('rollback restored start_rider_trip_v2 byte-identically to the migration-135 body', restored.m === PRE_137_MD5, restored);
    assert('rollback restored rider_actor NOT NULL', restored.rider_actor_nullable === 'NO', restored);
    assert('rollback dropped dispatched_by', restored.dispatched_by_exists === false, restored);
    let reapplyErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.sql'); } catch (e) { reapplyErr = e; }
    assert('forward candidate re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
  }
  await rb.su.end();

  // PONR proof: once an OPERATOR-DISPATCHED trip row exists (rider_actor NULL), rollback
  // must REFUSE rather than fabricate an identity or silently drop the row.
  const ponr = await rt.buildFixtureDb(env.cl, env.admin, 'b1_ponr');
  await applyThroughMigration137(ponr.su);
  let setupErr = null;
  let ponrSvc = null;
  try {
    ponrSvc = await rt.connect(env.cl, 'b1_ponr', { role: 'service_role', name: 'b1-ponr-svc' });
    const fx = fixture(ponr.su);
    const s = await fx.day('2026-09-17');
    const anchor = await fx.order(ponrSvc, { session: s, estado: 'LISTO' });
    await ponr.su.query('SET ROLE postgres');
    await ponr.su.query(`
      INSERT INTO public.auth_actors (actor, role, session_version, active, workspace_id)
      VALUES ('ponr-operator', 'operator', 1, true, gen_random_uuid()) ON CONFLICT (actor) DO NOTHING`);
    await ponr.su.query(`
      INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, departed_at, status, seq)
      VALUES (gen_random_uuid(), '2026-09-17', $1, NULL, 'ponr-operator', $2, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'))`,
      [s, anchor.order_uid]);
    await ponr.su.query('RESET ROLE');
  } catch (e) { setupErr = e; }
  if (ponrSvc) await ponrSvc.end().catch(() => {});
  assert('PONR setup (fixture order + operator-dispatched canonical trip row) succeeded', !setupErr, setupErr && `${setupErr.code || ''} ${setupErr.message}`);
  if (!setupErr) {
    let ponrErr = null;
    try { await rt.applyAsPostgres(ponr.su, 'candidate/giro_authority_b1_rider_dispatch_operator_parity_v1.ROLLBACK.sql'); } catch (e) { ponrErr = e; }
    assert('PONR: rollback REFUSES once an operator-dispatched (rider_actor NULL) trip row exists', !!ponrErr, ponrErr ? `${ponrErr.code} ${ponrErr.message}` : '(rollback silently succeeded)');
  }
  await ponr.su.end();

  // Template for the scenario groups: fixture + every candidate through 137 applied.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'b1_tpl');
  await applyThroughMigration137(t.su);
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'b1-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `b1_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'b1_tpl', name);
      return name;
    };

    const applied = await phaseApply(env);
    if (applied) {
      const groups = only.length ? only : [...REGRESSION_GROUPS, ...NEW_GROUPS];
      for (const g of groups) {
        const file = path.join(__dirname, 'groups', `${g}.js`);
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
