'use strict';
// W6.3 + W6.4 Canonical Rider Lifecycle + Giro Projection cutover certification runner
// (ephemeral PostgreSQL only). Applies the migration-130 candidate, then 131, then 132
// (with the close_service_session_v3 predecessor stub), then the
// rider_collect_and_complete_stop predecessor, then 133, then 134, then the new
// migration-135 candidate on top; re-runs the full W3 + W5 Packet 01 + W5 Intent
// Activation + W6.1 + W6.2 regression suites, plus the new w6RiderLifecycle group
// covering the migration-135 delta itself.
//
//   node ci/giro-authority-certification/harness/runW6RiderLifecycle.js [groupName ...]

const path = require('path');
const rt = require('./pgRuntime');
const { state, section, assert, fixture } = require('./lib');

const REGRESSION_GROUPS = ['boundary', 'commands', 'projection', 'capture', 'consume', 'concurrency', 'noMoney', 'lifecycle', 'w5packet01', 'w5IntentActivation', 'w6LockOrder', 'w6TripAuthority'];
const NEW_GROUPS = ['w6RiderLifecycle'];

// The LIVE staging checksums of the two lifecycle functions migration 135 rewrites,
// captured read-only from tdikhfeinufaahagmpjz at ledger head 134 before this candidate
// was authored. Asserting them here proves the repo migration files this harness installs
// are byte-identical to what is actually running on staging -- i.e. that the "pre-135"
// body this candidate replaces is the real one, not a repo-only variant.
const STAGING_PRE_135 = Object.freeze({
  'public.close_rider_trip(text)': '94f5d700d9737a980d1025150f1e473a',
  'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)': 'f8b8ec6a981c56a000a1be83b887db5d',
  'public.start_rider_trip(text)': 'c9e4439ae986cc9a96c1ad1cf92c1296',
});

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

// Structural stand-in for public._ledger_write_payment. The real ledger writer lives
// entirely outside the Giro/Trip Authority fixture (it is the Economy boundary this
// packet is forbidden to touch), so it is NOT reproduced here. What this stub gives the
// certification is exactly what the W6.3 collect contract needs to be proven against:
// a writer that (a) records something durable that a rollback must be able to erase,
// (b) can refuse with the same SQLSTATE the real one uses so PAYMENT_REFUSED is
// exercised, and (c) can raise the single tolerated AUTH_LEGACY_IMPORT_REQUIRED. Money
// AMOUNTS and digests are the real function's business and are neither modelled nor
// asserted here -- migration 135 does not touch that code path at all, which is proven
// separately and exactly by the byte-identical money region of the rewritten function.
const LEDGER_WRITER_STUB = `
CREATE TABLE public.fixture_ledger_control (singleton boolean PRIMARY KEY DEFAULT true, mode text NOT NULL DEFAULT 'ok');
INSERT INTO public.fixture_ledger_control (singleton, mode) VALUES (true, 'ok');

CREATE FUNCTION public._ledger_write_payment(
  p_order_id text, p_method text, p_amount numeric, p_actor text, p_role text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_mode text;
  v_id   bigint;
BEGIN
  SELECT mode INTO v_mode FROM public.fixture_ledger_control WHERE singleton = true;
  IF v_mode = 'refuse' THEN
    RAISE EXCEPTION 'PAYMENT_DIGEST_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF v_mode = 'legacy' THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.order_financial_events (order_id, kind, amount)
  VALUES (p_order_id, 'payment_' || p_method, 10)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('event_id', v_id, 'method', p_method, 'actor', p_actor, 'role', p_role,
                            'idem_scope_key', p_idem_scope_key);
END;
$function$;
`;

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

async function phaseApply(env) {
  section('P0 PROVENANCE -- the pre-135 lifecycle bodies this harness installs are the LIVE staging ones');
  const prov = await rt.buildFixtureDb(env.cl, env.admin, 'w6rl_prov');
  await applyThroughMigration134(prov.su);
  for (const [sig, expected] of Object.entries(STAGING_PRE_135)) {
    const got = (await prov.su.query('SELECT md5(pg_get_functiondef($1::regprocedure)) AS m', [sig])).rows[0].m;
    assert(`pre-135 ${sig} is byte-identical to live staging (md5 ${expected})`, got === expected, { got, expected });
  }
  await prov.su.end();

  section('P1 APPLY -- migrations 130-134, then the 135 candidate, on a staging-shaped fixture');
  const { su } = await rt.buildFixtureDb(env.cl, env.admin, 'w6rl_apply');
  let err = null;
  try { await applyThroughMigration135(su); } catch (e) { err = e; }
  assert('migrations 130-134 + the 135 candidate all apply cleanly (guards + post-conditions pass)', !err, err && `${err.code} ${err.message}`);
  if (err) { await su.end(); return false; }

  const shape = (await su.query(`
    SELECT to_regprocedure('public.trip_authority_active_trip_v1()') IS NOT NULL AS read_helper,
           to_regprocedure('public.trip_authority_close_active_trip_v1(uuid)') IS NOT NULL AS close_helper,
           to_regprocedure('trip_authority.close_terminal_states_v1()') IS NOT NULL AS close_states,
           to_regprocedure('trip_authority.progress_terminal_states_v1()') IS NOT NULL AS progress_states,
           to_regprocedure('trip_authority.departed_hhmm_v1(timestamptz)') IS NOT NULL AS hhmm,
           EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='trip_authority' AND indexname='trips_one_trip_per_giro_v1') AS one_per_giro,
           (SELECT count(*) FROM trip_authority.trips) AS trip_count`)).rows[0];
  assert('trip_authority_active_trip_v1 installed', shape.read_helper === true);
  assert('trip_authority_close_active_trip_v1 installed', shape.close_helper === true);
  assert('close/progress terminal-state helpers + departed_hhmm_v1 installed',
    shape.close_states === true && shape.progress_states === true && shape.hhmm === true, shape);
  assert('trips_one_trip_per_giro_v1 index installed', shape.one_per_giro === true, shape);
  assert('trip_authority.trips is still empty immediately after apply', Number(shape.trip_count) === 0, shape);

  // start_rider_trip_v2 is still NOT registered anywhere in the DB as a Node-reachable
  // resource -- that is a JS-side fact, asserted by tests/supabaseResourcePolicy.test.js.
  // What IS a DB fact and is asserted here: anon/authenticated still cannot execute any
  // of the three canonical entry points, and trip_authority is still private.
  const sec = (await su.query(`
    SELECT bool_or(has_function_privilege('anon', s, 'EXECUTE') OR has_function_privilege('authenticated', s, 'EXECUTE')) AS api_can_execute
      FROM unnest(ARRAY['public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure,
                        'public.trip_projection_v1(uuid[])'::regprocedure,
                        'public.trip_authority_active_trip_v1()'::regprocedure,
                        'public.trip_authority_close_active_trip_v1(uuid)'::regprocedure]) AS s`)).rows[0];
  assert('no API role (anon/authenticated) may execute any canonical trip entry point', sec.api_can_execute === false, sec);
  await su.end();

  // Rollback proof: apply forward (130-135), roll back 135 only, re-apply cleanly.
  const rb = await rt.buildFixtureDb(env.cl, env.admin, 'w6rl_rollback_proof');
  await applyThroughMigration135(rb.su);
  let rbErr = null;
  try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_rider_lifecycle_v1.ROLLBACK.sql'); } catch (e) { rbErr = e; }
  assert('rollback candidate applies cleanly while trip_authority.trips is empty', !rbErr, rbErr && `${rbErr.code} ${rbErr.message}`);
  if (!rbErr) {
    const gone = (await rb.su.query(`
      SELECT (to_regprocedure('public.trip_authority_active_trip_v1()') IS NULL
              AND to_regprocedure('public.trip_authority_close_active_trip_v1(uuid)') IS NULL
              AND to_regprocedure('trip_authority.close_terminal_states_v1()') IS NULL
              AND to_regprocedure('trip_authority.departed_hhmm_v1(timestamptz)') IS NULL
              AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='trip_authority' AND indexname='trips_one_trip_per_giro_v1')) AS gone,
             (EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='trip_authority')
              AND to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NOT NULL) AS m134_intact`)).rows[0];
    assert('rollback removed exactly what 135 added', gone.gone === true, gone);
    assert('rollback left every migration-134 object intact', gone.m134_intact === true, gone);
    // Exactness: the two lifecycle functions are byte-identical to LIVE staging again.
    for (const [sig, expected] of Object.entries(STAGING_PRE_135)) {
      const got = (await rb.su.query('SELECT md5(pg_get_functiondef($1::regprocedure)) AS m', [sig])).rows[0].m;
      assert(`rollback restored ${sig} byte-identically to the live pre-135 body`, got === expected, { got, expected });
    }
    let reapplyErr = null;
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_rider_lifecycle_v1.sql'); } catch (e) { reapplyErr = e; }
    assert('forward candidate re-applies cleanly after rollback (round-trip proof)', !reapplyErr, reapplyErr && `${reapplyErr.code} ${reapplyErr.message}`);
  }

  // PONR proof: once a canonical trip row exists, rollback must REFUSE.
  let setupErr = null;
  let rbSvc = null;
  try {
    rbSvc = await rt.connect(env.cl, 'w6rl_rollback_proof', { role: 'service_role', name: 'w6rl-rb-svc' });
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
    try { await rt.applyAsPostgres(rb.su, 'candidate/giro_authority_w6_rider_lifecycle_v1.ROLLBACK.sql'); } catch (e) { ponrErr = e; }
    assert('PONR: rollback REFUSES once a canonical trip row exists', !!ponrErr, ponrErr ? `${ponrErr.code} ${ponrErr.message}` : '(rollback silently succeeded)');
  }
  await rb.su.end();

  // Template for the scenario groups: fixture + every candidate applied.
  const t = await rt.buildFixtureDb(env.cl, env.admin, 'w6rl_tpl');
  await applyThroughMigration135(t.su);
  await t.su.end();
  return true;
}

async function main() {
  const only = process.argv.slice(2);
  const cl = await rt.startCluster();
  const env = { cl, evidence: { started_at: new Date().toISOString(), mode: cl.mode } };
  let admin;
  try {
    admin = await rt.connect(cl, 'postgres', { name: 'w6rl-admin' });
    env.admin = admin;
    await rt.ensureRoles(admin);

    let dbSeq = 0;
    env.clone = async (label) => {
      const name = `w6rl_${label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${++dbSeq}`;
      await rt.cloneDb(admin, 'w6rl_tpl', name);
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
