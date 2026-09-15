'use strict';
// W5 Intent Activation V1 certification runner (ephemeral PostgreSQL only). Applies
// the already-certified migration-130 candidate, then migration-131, then the new
// migration-132 candidate on top, re-runs the full W3 + W5 Packet 01 group suites
// (proving no regression on any sibling command), plus the new w5IntentActivation
// group covering the migration-132 delta itself.
//   node ci/giro-authority-certification/harness/runW5IntentActivation.js [groupName ...]

const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');

const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle', 'w5packet01'];
const NEW_GROUPS = ['w5IntentActivation'];

// close_service_session_v3 lives entirely outside the W3/W5 Giro Authority fixture
// (a different, much older migration lineage -- f4-series/lifecycle-v3). Its real
// staging body already exists there today; this harness's staging-shaped subset
// (fixture/staging_shape_v1.sql) never needed it before and does not carry it or its
// two singleton state tables. To let migration 132's CREATE OR REPLACE on that real
// function be exercised and its post-conditions verified here, install (a) MINIMAL
// structural stubs of the two tables its %ROWTYPE declarations must resolve against
// (only the columns the function body actually reads/writes -- not a functional
// replica of the real schema) and (b) the function's own real pre-132 body verbatim
// (identical to this migration's own ROLLBACK candidate) as the "already exists"
// predecessor. This harness deliberately does NOT attempt a full end-to-end call to
// close_service_session_v3 (that would need service_closeouts/service_closeout_
// attempts/service_session_audit too, which are out of scope here) -- see
// w5IntentActivation.js's own T01-T03 comment for what IS exercised instead: the
// exact sentinel-scope consume call the sweep makes, proven directly and completely.
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

async function phaseApply(env) {
  section('P1 APPLY — migration 130, then 131, then 132 candidate, on a staging-shaped fixture');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'w5ia_apply');
  let err = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_v1.sql'); } catch (e) { err = e; }
  assert('migration 130 candidate applies cleanly (predecessor)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  let err2 = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_packet01_v1.sql'); } catch (e) { err2 = e; }
  assert('migration 131 candidate applies cleanly on top of 130 (predecessor)', !err2, err2 && `${err2.code} ${err2.message}`);
  if (err2) { await su.end(); return false; }

  await installCloseSessionPredecessorStub(su);
  let err3 = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_w5_intent_activation_v1.sql'); } catch (e) { err3 = e; }
  assert('migration 132 candidate applies cleanly on top of 130+131 (guards + post-conditions pass)', !err3, err3 && `${err3.code} ${err3.message}`);
  if (err3) { await su.end(); return false; }

  const trg = (await su.query(
    `SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'ordenes_zz_giro_intent_capture_v1'`
  )).rows;
  assert('capture trigger installed', trg.length === 1);
  const helper = (await su.query(
    `SELECT 1 FROM pg_proc WHERE oid = 'public.giro_authority_list_pending_intents_v1(uuid[],integer)'::regprocedure`
  )).rows;
  assert('pending-intent read helper installed', helper.length === 1);
  const bumps = (await su.query(
    `SELECT pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure) ILIKE '%bump_facts_signal_v1%' AS b`
  )).rows[0].b;
  assert('consume_intent_v1 now bumps the signal', bumps === true);
  await su.end();

  // Rollback proof: apply forward (130+131+132), then roll back 132 only, then
  // re-apply 132 cleanly on a throwaway clone -- proves the rollback pair is real,
  // non-destructive to 130/131, and the forward candidate is re-appliable.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'w5ia_rollback_proof');
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await installCloseSessionPredecessorStub(rb.su);
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_intent_activation_v1.sql');
  let rbErr = null;
  try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_intent_activation_v1.ROLLBACK.sql'); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const gone = await rb.su.query(`
      SELECT (to_regprocedure('public.giro_authority_list_pending_intents_v1(uuid[],integer)') IS NULL
              AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                                 AND tgname = 'ordenes_zz_giro_intent_capture_v1')) AS gone`);
    assert('rollback removed the trigger and the new helper', gone.rows[0].gone === true, gone.rows);
    const unbumped = await rb.su.query(
      `SELECT pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure) ILIKE '%bump_facts_signal_v1%' AS b`);
    assert('rollback restored consume_intent_v1 to its unbumped pre-132 body', unbumped.rows[0].b === false, unbumped.rows);
    const noSweep = await rb.su.query(
      `SELECT pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure) ILIKE '%giro_intent_service_close_sweep%' AS s`);
    assert('rollback restored close_service_session_v3 to its pre-132 body (no sweep)', noSweep.rows[0].s === false, noSweep.rows);
    const predecessorOk = await rb.su.query("SELECT giro_authority.actor_valid_v1('op-1')").catch(() => null);
    assert('predecessor (migrations 130+131) objects still callable after rollback', !!predecessorOk);
    let reapplyErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_intent_activation_v1.sql'); } catch (e) { reapplyErr = e; }
    assert('forward candidate re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
  }
  await rb.su.end();

  // Template for the scenario groups: fixture + all three candidates applied.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'w5ia_tpl');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await installCloseSessionPredecessorStub(t.su);
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_w5_intent_activation_v1.sql');
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'w5ia-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `w5ia_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'w5ia_tpl', name);
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
