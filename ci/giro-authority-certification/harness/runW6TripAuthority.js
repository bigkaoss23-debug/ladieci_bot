'use strict';
// W6.2 Trip Authority Foundation certification runner (ephemeral PostgreSQL only).
// Applies migration-130 candidate, then 131, then 132 (with the close_service_
// session_v3 predecessor stub), then the rider_collect_and_complete_stop predecessor
// (migration 133's own precondition requires it), then 133, then the new
// migration-134 candidate on top, re-runs the full W3 + W5 Packet 01 + W5 Intent
// Activation + W6.1 regression suites (proving no regression on any sibling command),
// plus the new w6TripAuthority group covering the migration-134 delta itself.
//   node ci/giro-authority-certification/harness/runW6TripAuthority.js [groupName ...]

const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert, fixture } = require('./lib');

const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle', 'w5packet01', 'w5IntentActivation', 'w6LockOrder'];
const NEW_GROUPS = ['w6TripAuthority'];

// Identical in spirit to runW5IntentActivation.js's own stub: close_service_
// session_v3 lives entirely outside the W3/W5 Giro Authority fixture. Minimal
// structural stand-in only -- not exercised end-to-end here either.
const CLOSE_SESSION_PREDECESSOR_STUB = `
CREATE TABLE public.service_session_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  current_session_id uuid,
  recent_closed_session_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.service_session_state (singleton, current_session_id) VALUES (true, NULL);

CREATE TABLE public.business_day_lifecycle_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  current_period_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.business_day_lifecycle_state (singleton, current_period_id) VALUES (true, NULL);

CREATE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'closed' THEN
    IF v_state.recent_closed_session_id = v_session.id AND v_state.current_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS');
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE service_session_id = p_service_session_id
       AND closeout_correlation_id = p_closeout_correlation_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_NOT_FOUND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
       AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;

  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id = NULL, updated_at = now() WHERE singleton = true;
  END IF;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

CREATE TABLE public.service_closeouts (service_session_id uuid, closeout_correlation_id uuid);
CREATE TABLE public.service_closeout_attempts (service_session_id uuid, closeout_correlation_id uuid, status text);
CREATE TABLE public.service_session_audit (service_session_id uuid, event_type text, by_actor text, source text, created_at timestamptz NOT NULL DEFAULT now());
`;

async function installCloseSessionPredecessorStub(su) {
  await su.query('SET ROLE postgres');
  await su.query(CLOSE_SESSION_PREDECESSOR_STUB);
  await su.query('RESET ROLE');
}

// pgRuntime.buildFixtureDb already installs the real start_rider_trip/close_rider_trip
// verbatim, but not rider_collect_and_complete_stop -- migration 133's own precondition
// requires it (learned in the W6.1 session). extractFunction (pgRuntime.js) only
// handles the plain "AS $$ ... $$;" delimiter; rider_collect_and_complete_stop uses
// "AS $fn$ ... $fn$;", so it needs its own tiny extractor (identical to runW6LockOrder.js's).
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

// The certification fixture's own auth_actors stub (fixture/staging_shape_v1.sql) is
// a minimal `actor text PRIMARY KEY` -- enough for manual_giros.assigned_actor's FK,
// which is all W3-W5 ever needed. rider_collect_and_complete_stop and (now)
// start_rider_trip_v2 both read role/active/session_version from a real auth_actors
// row, so those columns need to exist for either function to actually be CALLED
// (not merely created -- plpgsql bodies aren't validated against them at CREATE
// time). Added here, not in the shared fixture file, so no other group's fixture
// shape changes.
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
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql');
  await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_trip_authority_v1.sql');
}

async function phaseApply(env) {
  section('P1 APPLY -- migrations 130-133, then the 134 candidate, on a staging-shaped fixture');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'w6ta_apply');
  let err = null;
  try { await applyThroughMigration134(su); } catch (e) { err = e; }
  assert('migrations 130-133 + the 134 candidate all apply cleanly (guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  const shape = (await su.query(`
    SELECT to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NOT NULL AS v2,
           to_regprocedure('public.trip_projection_v1(uuid[])') IS NOT NULL AS proj,
           (SELECT count(*) FROM pg_namespace WHERE nspname = 'trip_authority') AS schema_count,
           (SELECT count(*) FROM trip_authority.trips) AS trip_count`
  )).rows[0];
  assert('start_rider_trip_v2 installed', shape.v2 === true);
  assert('trip_projection_v1 installed', shape.proj === true);
  assert('trip_authority schema exists exactly once', Number(shape.schema_count) === 1, shape);
  assert('trip_authority.trips is empty immediately after apply', Number(shape.trip_count) === 0, shape);
  await su.end();

  // Rollback proof: apply forward (130-134), then roll back 134 only, then re-apply
  // 134 cleanly on a throwaway clone -- proves the PONR-guarded rollback is real and
  // the forward candidate is re-appliable.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'w6ta_rollback_proof');
  await applyThroughMigration134(rb.su);
  let rbErr = null;
  try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_trip_authority_v1.ROLLBACK.sql'); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly while trip_authority.trips is empty', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const gone = await rb.su.query(`
      SELECT (to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL
              AND to_regprocedure('public.trip_projection_v1(uuid[])') IS NULL
              AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority')) AS gone`);
    assert('rollback removed the schema and both dormant entry points', gone.rows[0].gone === true, gone.rows);
    const restored = await rb.su.query(
      `SELECT pg_get_functiondef('giro_authority.trip_facts_v1()'::regprocedure) ILIKE '%trip_authority%' AS still_canonical`);
    assert('rollback restored trip_facts_v1 to its unpatched pre-134 body', restored.rows[0].still_canonical === false, restored.rows);
    let reapplyErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_trip_authority_v1.sql'); } catch (e) { reapplyErr = e; }
    assert('forward candidate re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
  }

  // PONR proof: once a canonical trip row exists, rollback must REFUSE, on the SAME
  // clone (134 is re-applied above, trips is empty again -- insert one directly as
  // postgres, matching legitimate migration-authority test scaffolding, not a public
  // RPC call).
  let setupErr = null;
  let rbSvc = null;
  try {
    rbSvc = await rt.connect(env.cl, 'w6ta_rollback_proof', { role: 'service_role', name: 'w6ta-rb-svc' });
    const rbFx = fixture(rb.su);
    const s = await rbFx.day('2026-09-15');
    const anchor = await rbFx.order(rbSvc, { session: s, estado: 'LISTO' });
    await rb.su.query('SET ROLE postgres');
    await rb.su.query(`
      INSERT INTO public.auth_actors (actor, role, session_version, active, workspace_id)
      VALUES ('ponr-rider', 'rider', 1, true, gen_random_uuid()) ON CONFLICT (actor) DO NOTHING`);
    await rb.su.query(`
      INSERT INTO trip_authority.trips (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, departed_at, status, seq)
      VALUES (gen_random_uuid(), '2026-09-15', $1, 'ponr-rider', $2, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'))`,
      [s, anchor.order_uid]);
    await rb.su.query('RESET ROLE');
  } catch (e) { setupErr = e; }
  if (rbSvc) await rbSvc.end().catch(() => {});
  assert('PONR setup (fixture order + canonical trip row) succeeded', !setupErr, setupErr && `${setupErr.code || ''} ${setupErr.message}`);
  if (!setupErr) {
    let ponrErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_trip_authority_v1.ROLLBACK.sql'); } catch (e) { ponrErr = e; }
    assert('PONR: rollback REFUSES once a canonical trip row exists', !!ponrErr, ponrErr ? `${ponrErr.code} ${ponrErr.message}` : '(rollback silently succeeded)');
  }
  await rb.su.end();

  // Template for the scenario groups: fixture + all five candidates applied.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'w6ta_tpl');
  await applyThroughMigration134(t.su);
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'w6ta-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `w6ta_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'w6ta_tpl', name);
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
