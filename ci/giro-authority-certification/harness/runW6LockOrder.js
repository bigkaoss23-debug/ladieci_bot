'use strict';
// W6.1 Lock-Order Unification certification runner (ephemeral PostgreSQL only). Applies
// the already-certified migration-130 candidate, then 131, then 132 (with the
// close_service_session_v3 predecessor stub, exactly as runW5IntentActivation.js does),
// then the new migration-133 candidate on top, re-runs the full W3 + W5 Packet 01 + W5
// Intent Activation regression suites (proving no regression on any sibling command),
// plus the new w6LockOrder group covering the migration-133 delta itself.
//   node ci/giro-authority-certification/harness/runW6LockOrder.js [groupName ...]

const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert } = require('./lib');

const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle', 'w5packet01', 'w5IntentActivation'];
const NEW_GROUPS = ['w6LockOrder'];

// Identical to runW5IntentActivation.js's own CLOSE_SESSION_PREDECESSOR_STUB /
// installCloseSessionPredecessorStub -- duplicated here rather than imported so this
// new W6.1 runner does not require any change to the existing W5 Intent Activation
// runner file. See that file's own comment for the full rationale: close_service_
// session_v3 lives entirely outside the W3/W5 Giro Authority fixture (a different,
// older migration lineage), so migration 132's real CREATE OR REPLACE on it needs
// minimal structural stubs of the two singleton tables its %ROWTYPE declarations
// resolve against, plus its own real pre-132 body verbatim as the "already exists"
// predecessor. This runner needs the identical predecessor before it can apply 132
// on the way to 133; it does not itself exercise close_service_session_v3 further.
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
// verbatim (its own TRIP_SOURCES), but not rider_collect_and_complete_stop -- migration
// 133's own precondition block requires it to exist (it is one of the six functions the
// migration's authorization covers, even though this migration leaves its body
// untouched). Installed here, verbatim from its source migration, rather than adding it
// to pgRuntime.js's shared TRIP_SOURCES, to avoid any change to that existing file.
// extractFunction (pgRuntime.js) only handles the plain "AS $$ ... $$;" delimiter that
// start_rider_trip/close_rider_trip use; rider_collect_and_complete_stop is delimited
// "AS $fn$ ... $fn$;", so it needs its own tiny extractor.
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

async function phaseApply(env) {
  section('P1 APPLY -- migration 130, then 131, then 132, then the 133 candidate, on a staging-shaped fixture');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'w6lo_apply');
  await installRiderCollectPredecessor(su);
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
  assert('migration 132 candidate applies cleanly on top of 130+131 (predecessor)', !err3, err3 && `${err3.code} ${err3.message}`);
  if (err3) { await su.end(); return false; }

  let err4 = null;
  try { await rt.applyAsPostgres(su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql'); } catch (e) { err4 = e; }
  assert('migration 133 candidate applies cleanly on top of 130+131+132 (guards + post-conditions pass)', !err4, err4 && `${err4.code} ${err4.message}`);
  if (err4) { await su.end(); return false; }

  const l0Count = (await su.query(`
    SELECT count(*)::int AS n FROM (VALUES
      ('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'),
      ('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'),
      ('public.giro_authority_detach_v1(uuid,text,uuid[])'),
      ('public.giro_authority_dissolve_v1(text,text,uuid[])'),
      ('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')
    ) AS t(sig)
    WHERE pg_get_functiondef(t.sig::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%'`
  )).rows[0].n;
  assert('all five live Giro commands now carry the L0 lock', l0Count === 5, { l0Count });
  await su.end();

  // Rollback proof: apply forward (130+131+132+133), then roll back 133 only, then
  // re-apply 133 cleanly on a throwaway clone -- proves the rollback pair is real,
  // non-destructive to 130/131/132, and the forward candidate is re-appliable.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'w6lo_rollback_proof');
  await installRiderCollectPredecessor(rb.su);
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await installCloseSessionPredecessorStub(rb.su);
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w5_intent_activation_v1.sql');
  await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql');
  let rbErr = null;
  try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_lock_order_unification_v1.ROLLBACK.sql'); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const stillL0 = (await rb.su.query(`
      SELECT count(*)::int AS n FROM (VALUES
        ('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'),
        ('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'),
        ('public.giro_authority_detach_v1(uuid,text,uuid[])'),
        ('public.giro_authority_dissolve_v1(text,text,uuid[])'),
        ('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')
      ) AS t(sig)
      WHERE pg_get_functiondef(t.sig::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%'`
    )).rows[0].n;
    assert('rollback removed L0 from all five commands', stillL0 === 0, { stillL0 });
    const predecessorOk = await rb.su.query("SELECT giro_authority.actor_valid_v1('op-1')").catch(() => null);
    assert('predecessor (migrations 130+131+132) objects still callable after rollback', !!predecessorOk);
    let reapplyErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql'); } catch (e) { reapplyErr = e; }
    assert('forward candidate re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
  }
  await rb.su.end();

  // Template for the scenario groups: fixture + all four candidates applied.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'w6lo_tpl');
  await installRiderCollectPredecessor(t.su);
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_v1.sql');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_w5_packet01_v1.sql');
  await installCloseSessionPredecessorStub(t.su);
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_w5_intent_activation_v1.sql');
  await rt.applyAsPostgres(t.su, 'candidate/giro_authority_w6_lock_order_unification_v1.sql');
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'w6lo-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `w6lo_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'w6lo_tpl', name);
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
