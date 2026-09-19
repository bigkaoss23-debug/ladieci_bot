-- migrations/2026-09-19_active_trip_service_close_exclusion_v1_migration_138.sql
-- Paired rollback: 2026-09-19_active_trip_service_close_exclusion_v1_migration_138.ROLLBACK.sql
--
-- ACTIVE_TRIP_SERVICE_CLOSE_DB_HARDENING_2026-09-19 -- migration 138.
-- STAGING ONLY. Certified on ephemeral PostgreSQL 17 (ci/giro-authority-certification/harness/
-- runActiveTripCloseExclusion.js). NOT applied to staging or production by the session that
-- authored it; application needs its own authorization.
--
-- THE FINDING (F-1 of ACTIVE_TRIP_SERVICE_CLOSE_GUARD_OPUS_REVIEW_2026-09-19.md, ledger tip 137).
--   The backend refuses to close a service while a rider trip is ACTIVE for it, but that check is
--   a JS pre-read; the terminal write is close_service_session_v3, a different transaction. The
--   two RPCs did not share an exclusion:
--     * close_service_session_v3 serializes on the lifecycle advisory lock and NEVER reads a trip;
--     * start_rider_trip_v2 serializes on the dispatch lock (L0, LA_DIECI_DRIVER_STATO) and NEVER
--       checks that the service of the order it departs is still open -- the scope array is
--       resolved by the caller before the call.
--   Reachable interleavings (both harmful, both proven on the ephemeral harness before this fix):
--     A. "Finalizar con pendientes" has classified a LISTO delivery order (an incident is written
--        for it) and is about to close; a dispatch commits (trip ACTIVE, order EN_ENTREGA); the
--        close then commits: service CLOSED + trip ACTIVE.
--     B. the dispatch resolved its scope before the close committed; its INSERT only needs a
--        FOR KEY SHARE on the service row, which a closed row still satisfies: trip ACTIVE on an
--        already CLOSED service.
--   Either state is unrecoverable from the app: the trip is invisible to every operational scope,
--   yet trips_one_active_v1 blocks every later departure with ACTIVE_TRIP_CONFLICT.
--
-- THE INVARIANT (enforced by the database, on both sides, under ONE lock).
--   A. a service cannot become 'closed' while a trip with status ACTIVE is attributed to it
--      (trip_authority.trips.service_session_id);
--   B. a trip cannot become ACTIVE for a service that is not 'open' at the moment of departure.
--
-- THE FIX -- no new lock, no schema change, two CREATE OR REPLACE.
--   L0 (pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'))) is already the FIRST statement of
--   every trip writer. It is reused as the shared exclusion:
--   1. close_service_session_v3 takes L0 right after the lifecycle lock and before its first row
--      lock, and -- after every pre-existing check, immediately before the terminal transition --
--      refuses with V3_CLOSE_ACTIVE_RIDER_TRIP when public.trip_projection_v1([this service])
--      reports an ACTIVE trip (V3_CLOSE_RIDER_TRIP_UNVERIFIABLE if the projection is not a
--      well-formed answer: fail closed).
--   2. start_rider_trip_v2 (L0 already first) refuses with SERVICE_NOT_OPEN when any service of the
--      departing orders is missing or not 'open', judged right before the trip INSERT.
--   Serialization: whichever transaction acquires L0 first decides; the other one then reads the
--   committed result (READ COMMITTED: each statement takes a fresh snapshot after the lock wait).
--     close first -> the dispatch waits, then sees 'closed' -> SERVICE_NOT_OPEN, no trip;
--     trip first  -> the close waits, then sees the ACTIVE trip -> V3_CLOSE_ACTIVE_RIDER_TRIP.
--
-- LOCK PROTOCOL after this migration.
--   close_service_session_v3:  lifecycle -> L0 -> service_session_state -> service_sessions ->
--                              business_day_lifecycle_state (rows FOR UPDATE, unchanged order)
--   start_rider_trip_v2:       L0 -> ... (unchanged) ; the new check only READS service_sessions
--   No live function takes L0 and then the lifecycle lock (verified against every function body on
--   staging, by name and by lock literal), so lifecycle -> L0 cannot form an ABBA cycle.
--   Forward compatibility: the close's intent sweep (ledger 132) also reaches L0 -- late, after the
--   session row lock, the inverse of start_rider_trip_v2's own order (L0, then the FK key-share on that
--   row). Today that sweep cannot run for the real caller: this function is SECURITY INVOKER, service_role
--   has no USAGE on schema giro_authority, and the resulting permission error is swallowed by the sweep's
--   own EXCEPTION block (a pre-existing condition, deliberately NOT changed here; staging holds 0 intents).
--   So the inversion is latent -- but it is real (proven on the harness with a role that does have USAGE),
--   and holding L0 before the first row lock removes it for the day the sweep is repaired.
--
-- WHAT IT NEVER DOES
--   No table, column, index, constraint, trigger or grant is created or changed. No trip is closed,
--   repaired or mutated by a refusal. No order is reassigned, no service reopened, no incident
--   created. Driver-back / Entregado / payment / refund semantics are untouched
--   (close_rider_trip and rider_collect_and_complete_stop are not modified). roll_service_session_
--   economic_v1 (a retired stub since ledger 97) and begin_service_close_if_idle (dead) are not
--   touched. Owner, SECURITY attribute, search_path and EXECUTE grants of both functions are
--   preserved (CREATE OR REPLACE) and re-asserted below.
--
-- BODIES. Each new body is its predecessor (ledger 132 / ledger 137, pinned by md5 below) plus the
-- marked blocks "-- 138:BEGIN <name>" .. "-- 138:END <name>" and one "-- 138:DECL" line each --
-- nothing else. tests/activeTripServiceCloseExclusionMigration.test.js proves that removing the
-- marked text reproduces the predecessor byte for byte.

BEGIN;

-- Predecessor / drift guard ---------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: public.close_service_session_v3 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: public.start_rider_trip_v2 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('public.trip_projection_v1(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: public.trip_projection_v1 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('giro_authority.order_facts_v1(uuid[],jsonb)') IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: giro_authority.order_facts_v1 does not exist -- resolve drift first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'trip_authority' AND table_name = 'trips' AND column_name = 'service_session_id'
  ) THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: trip_authority.trips.service_session_id is missing -- resolve drift first';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)');
  IF md5(v_src) IS DISTINCT FROM '3caf2da77baabd6b5533879d101b2cc7' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: close_service_session_v3 body is not the exact ledger-132 body (md5 mismatch; already applied, or drifted) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])');
  IF md5(v_src) IS DISTINCT FROM 'd3482569db6df9ec5e6445e7748ebc3c' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION refused: start_rider_trip_v2 body is not the exact ledger-137 body (md5 mismatch; already applied, or drifted) -- resolve drift first';
  END IF;
END $guard$;

-- Snapshot of the security posture both functions must keep: owner, SECURITY attribute, search_path
-- and ACL. CREATE OR REPLACE preserves all four; the post-conditions re-assert it against this snapshot.
CREATE TEMP TABLE atc138_before (proname text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text) ON COMMIT DROP;
INSERT INTO atc138_before
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text
    FROM pg_proc p
   WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                   'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);

-- 1. close_service_session_v3 -- ledger-132 body + L0 + ACTIVE-trip exclusion ----------------
CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_trip    jsonb; -- 138:DECL
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

  -- 138:BEGIN close_l0
  -- ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) -- step 1 of 2: the dispatch lock (L0).
  -- Every trip writer (start_rider_trip_v2, close_rider_trip, rider_collect_and_complete_stop and
  -- the Giro Authority commands) already takes L0 as its FIRST statement. This close takes it
  -- here -- after the lifecycle lock and BEFORE the first row lock below -- so a close and a trip
  -- start are serialized by the SAME lock: whichever acquires L0 first decides, and the other one
  -- then judges the COMMITTED result of the first. Lock order of this function is now:
  -- lifecycle -> L0 -> service_session_state -> service_sessions -> business_day_lifecycle_state.
  -- No function takes L0 and then the lifecycle lock (checked against every live body), so no
  -- ABBA cycle exists. The intent sweep at the end of this function also reaches L0 (re-entrant in
  -- the same session, so a no-op from now on); were it to run, it would have taken L0 LATE, already
  -- holding the session row lock that the trip INSERT's foreign key needs -- the inverse order.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  -- 138:END close_l0

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

  -- 138:BEGIN close_active_trip
  -- ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) -- step 2 of 2: the exclusion itself.
  -- A service must not become 'closed' while a canonical rider trip is ACTIVE for it. It is judged
  -- HERE, under L0, after every pre-existing check (so no earlier refusal and not the idempotent
  -- ALREADY_CLOSED answer change) and immediately before the terminal transition. The trip is read
  -- through public.trip_projection_v1 -- the SAME projection the backend preflight uses, and the
  -- only way in: this function is SECURITY INVOKER and trip_authority has no USAGE for
  -- service_role -- scoped to exactly this service (attribution is the trip's own
  -- service_session_id; rider_actor is never read, so an operator-dispatched trip blocks like a
  -- rider-dispatched one). Fail closed: anything other than a well-formed { ok:true, active:false }
  -- refuses the close. A refusal writes nothing and never touches the trip.
  SELECT public.trip_projection_v1(ARRAY[v_session.id]) INTO v_trip;
  IF v_trip IS NULL OR (v_trip->>'ok') IS DISTINCT FROM 'true'
     OR jsonb_typeof(v_trip->'active') IS DISTINCT FROM 'boolean' THEN
    RETURN jsonb_build_object('ok',false,'code','V3_CLOSE_RIDER_TRIP_UNVERIFIABLE','service_session_id',v_session.id);
  END IF;
  IF (v_trip->>'active')::boolean THEN
    RETURN jsonb_build_object('ok',false,'code','V3_CLOSE_ACTIVE_RIDER_TRIP',
      'service_session_id',v_session.id,'trip',v_trip - 'ok' - 'active');
  END IF;
  -- 138:END close_active_trip

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

  -- W5 INTENT ACTIVATION V1 -- giro intent close-sweep. Best-effort, own
  -- exception scope: a failure here must never roll back or block the close
  -- above, which has already fully committed its own writes by this point.
  -- The nil-UUID sentinel scope is deliberately never a real session id, so
  -- consume's own service_session_id membership check (unconditional, runs
  -- before any estado/eligibility branch) forces EXPIRED/SERVICE_CLOSED for
  -- every match -- never CONSUMED, never a Giro attachment.
  BEGIN
    PERFORM public.giro_authority_consume_intent_v1(
      gi.order_uid, 'giro_intent_service_close_sweep',
      ARRAY['00000000-0000-0000-0000-000000000000'::uuid])
    FROM giro_authority.giro_intents gi
    JOIN public.ordenes o ON o.order_uid = gi.order_uid
    WHERE gi.status = 'PENDING' AND o.service_session_id = v_session.id;
  EXCEPTION WHEN others THEN
    NULL;
  END;

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

-- 2. start_rider_trip_v2 -- ledger-137 body + "service is still open" check ------------------
CREATE OR REPLACE FUNCTION public.start_rider_trip_v2(
  p_anchor_order_uid        uuid,
  p_actor                   text,
  p_session_version         integer,
  p_operational_session_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_by            public.auth_actors%ROWTYPE;
  v_legacy_trip   jsonb;
  v_existing      trip_authority.trips%ROWTYPE;
  v_giro_id       text;
  v_uids          uuid[];
  v_dates         date[];
  v_anchor_sess   uuid;
  v_trip_id       uuid;
  v_ids           text[];
  v_zones         text[];
  v_snapshot      jsonb;
  v_ds            jsonb;
  v_raw           text;
  d               record;
  r               record;
  v_svc           record; -- 138:DECL
BEGIN
  -- L0 (W6.1 protocol): the same dispatch lock every live Giro Authority command and
  -- the real start_rider_trip/rider_collect_and_complete_stop already take first.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  IF p_anchor_order_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- IDENTITY (B1, migration 137). The departure is a dispatch/logistics action, not a
  -- money-collection one — legacyActionRoles.js already lets admin/operator call this
  -- legacy action, so the canonical departure gate now matches it exactly. This does
  -- NOT touch rider_collect_and_complete_stop, which stays rider-exclusive on purpose.
  -- W6.3: deliberately NOT "FOR UPDATE". A departure writes no money, and L0 -- taken
  -- first, and exclusive -- already serializes every trip writer, so a plain read is
  -- sufficient here. Note that the INSERT into trip_authority.trips further down still
  -- takes an implicit FOR KEY SHARE on this row through the dispatched_by foreign key
  -- (always populated, unlike rider_actor which may now be NULL); that is precisely why
  -- rider_collect_and_complete_stop's own L0 had to move ahead of ITS auth_actors FOR
  -- UPDATE in migration 135 (header, correction 2(d)) -- the same structural hazard,
  -- now guarded by dispatched_by instead of rider_actor whenever the caller is not a rider.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role NOT IN ('rider', 'admin', 'operator') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE');
  END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE');
  END IF;

  -- S2-1H crash-safe service-close gate, restored from legacy start_rider_trip: ANY
  -- existing marker blocks a new trip until the exact close_id is explicitly ended.
  -- Activating v2 without this would have silently dropped a live safety guard.
  SELECT c.valore INTO v_raw FROM public.config c WHERE c.chiave = 'DRIVER_STATO';
  IF v_raw IS NOT NULL AND btrim(v_raw) <> '' THEN
    BEGIN
      IF (v_raw::jsonb) ? 'service_closing' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_CLOSING');
      END IF;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'code', 'UNVERIFIABLE', 'reason', 'DRIVER_STATO_UNPARSEABLE');
    END;
  END IF;

  -- SINGLE-RIDER GLOBAL CHECK (D-2). Read under L0, which already fully serializes
  -- every writer (canonical or legacy) -- no second lock is needed to make this safe.
  SELECT * INTO v_existing FROM trip_authority.trips WHERE status = 'ACTIVE';
  IF FOUND THEN
    IF v_existing.anchor_order_uid = p_anchor_order_uid THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'trip_id', v_existing.trip_id,
        'giro_id', v_existing.giro_id, 'anchor_order_uid', v_existing.anchor_order_uid,
        'order_uids', COALESCE((SELECT jsonb_agg(tm.order_uid ORDER BY tm.stop_seq)
                                   FROM trip_authority.trip_members tm WHERE tm.trip_id = v_existing.trip_id), '[]'::jsonb));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT');
  END IF;

  -- No canonical trip is active. Also refuse if the LEGACY (DRIVER_STATO-only) path
  -- shows one active -- trip_facts_v1() falls through to DRIVER_STATO whenever
  -- trip_authority.trips is empty, which it is at this point in the function, so this
  -- read is exactly the legacy compatibility signal, closing the gap a mixed v1/v2
  -- calling environment would otherwise leave open.
  v_legacy_trip := giro_authority.trip_facts_v1();
  IF NOT (v_legacy_trip->>'available')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNVERIFIABLE', 'reason', v_legacy_trip->>'reason');
  END IF;
  IF (v_legacy_trip->>'active')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT', 'reason', 'LEGACY_TRIP_ACTIVE');
  END IF;

  -- CANONICAL GIRO MEMBERSHIP. Resolved exclusively from giro_authority -- never
  -- ordenes.manual_giro_id.
  v_giro_id := giro_authority.order_effective_giro_v1(p_anchor_order_uid, p_operational_session_ids, v_legacy_trip);

  IF v_giro_id IS NOT NULL THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_giro_id FOR UPDATE;   -- L1
    -- Re-derive NOW that the giro row is locked -- same discipline as every other
    -- Giro Authority command (the unlocked read above may already be stale).
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro_id], p_operational_session_ids, v_legacy_trip);
    IF d.giro_id IS NULL OR d.giro_state <> 'PLANNED' OR NOT (p_anchor_order_uid = ANY (d.effective_order_uids)) THEN
      -- Gone/departed/anchor no longer effective between the unlocked read and the
      -- lock -- fall back to a single-order departure on just the anchor, exactly
      -- like legacy start_rider_trip does when no manual_giro_id match is found.
      v_uids := ARRAY[p_anchor_order_uid];
      v_giro_id := NULL;
    ELSE
      -- W6.3 -- CANONICAL_GIRO_DEPARTURE_IS_ATOMIC. The COMPLETE effective member set
      -- departs, or nothing does. This deliberately does NOT narrow the set to the
      -- members that happen to be LISTO right now (migration 134's body did, which
      -- would have allowed a PARTIAL DEPARTURE of a canonical giro): the eligibility
      -- loop below then refuses the whole departure with the existing INVALID_STATE
      -- code if ANY required member is not LISTO, before a single order transitions
      -- and before any trip row is created. derive_giros_v1 already returns this array
      -- ordered by order_uid, which is exactly the ordering the previous body produced.
      v_uids := d.effective_order_uids;
      IF v_uids IS NULL OR NOT (p_anchor_order_uid = ANY (v_uids)) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'order_uid', p_anchor_order_uid);
      END IF;
    END IF;
  ELSE
    v_uids := ARRAY[p_anchor_order_uid];
  END IF;

  PERFORM giro_authority.lock_orders_v1(v_uids);                                                  -- L2
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = ANY (v_uids) ORDER BY o.order_uid FOR SHARE; -- L4

  FOR r IN SELECT * FROM giro_authority.order_facts_v1(v_uids, v_legacy_trip) LOOP
    IF NOT r.present THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND', 'order_uid', r.order_uid);
    END IF;
    IF r.delivery_type <> 'DOMICILIO' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_ELIGIBLE', 'order_uid', r.order_uid, 'reason', 'NOT_DOMICILIO');
    END IF;
    IF r.table_session_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_ELIGIBLE', 'order_uid', r.order_uid, 'reason', 'TABLE_ORDER');
    END IF;
    IF NOT COALESCE(r.service_session_id = ANY (p_operational_session_ids), false) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_MISMATCH', 'order_uid', r.order_uid);
    END IF;
    IF r.estado IS DISTINCT FROM 'LISTO' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'order_uid', r.order_uid, 'estado', r.estado);
    END IF;
    IF r.order_uid = p_anchor_order_uid THEN v_anchor_sess := r.service_session_id; END IF;
  END LOOP;

  SELECT array_agg(DISTINCT f.business_date) INTO v_dates FROM giro_authority.order_facts_v1(v_uids, v_legacy_trip) f;
  IF cardinality(v_dates) <> 1 OR v_dates[1] IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_MISMATCH');
  END IF;

  -- 138:BEGIN start_service_open
  -- ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138). A trip may only become ACTIVE for a
  -- service that is STILL open at this atomic moment. L0 -- this function's first statement -- is
  -- the SAME lock close_service_session_v3 now takes before it closes a service, so the status read
  -- below cannot go stale before this transaction commits: a close that won L0 first has already
  -- committed 'closed' (seen here, so refused); a close that comes later waits for L0 and then
  -- finds this trip ACTIVE (so it refuses). The scope array was resolved by the caller BEFORE
  -- this call and is NOT trusted for liveness. EVERY distinct service of the departing orders is
  -- judged (the anchor's is the trip's own service_session_id): a missing row, or any status other
  -- than 'open' ('closing', 'closed', 'rolled_over'), refuses the departure. No other service is
  -- substituted, no order is reassigned and nothing is reopened.
  FOR v_svc IN
    SELECT s.sid, ss.status
      FROM (SELECT DISTINCT f.service_session_id AS sid
              FROM giro_authority.order_facts_v1(v_uids, v_legacy_trip) f) s
      LEFT JOIN public.service_sessions ss ON ss.id = s.sid
     ORDER BY (s.sid IS NOT DISTINCT FROM v_anchor_sess) DESC, s.sid
  LOOP
    IF v_svc.status IS DISTINCT FROM 'open' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_NOT_OPEN',
        'service_session_id', v_svc.sid, 'status', v_svc.status);
    END IF;
  END LOOP;
  -- 138:END start_service_open

  -- CREATE exactly one canonical trip + freeze its members. The trips_one_active_v1
  -- partial unique index is the DB-level backstop; L0 above is the real serialization.
  -- trips_one_trip_per_giro_v1 (W6.3) is the second backstop: a canonical giro can
  -- produce at most ONE trip in its lifetime. rider_actor (B1, migration 137) is the
  -- caller ONLY when the caller is actually a rider; dispatched_by is always the caller.
  v_trip_id := gen_random_uuid();
  INSERT INTO trip_authority.trips
    (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, giro_id, departed_at, status, seq)
  VALUES
    (v_trip_id, v_dates[1], v_anchor_sess, CASE WHEN v_by.role = 'rider' THEN p_actor ELSE NULL END, p_actor,
     p_anchor_order_uid, v_giro_id, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'));
  PERFORM trip_authority.freeze_members_v1(v_trip_id, v_uids, p_actor);

  -- Transition eligible orders to EN_ENTREGA atomically. Order stop state stays
  -- authoritative in ordenes.estado/hora_entrega -- never duplicated in trip_members.
  UPDATE public.ordenes
     SET estado = 'EN_ENTREGA', hora_salida = (extract(epoch FROM now()) * 1000)::bigint
   WHERE order_uid = ANY (v_uids) AND estado = 'LISTO';

  -- DRIVER_STATO COMPATIBILITY PROJECTION ONLY -- derived from the canonical facts
  -- just created, never independently authoritative (D-1). Legacy readers/writers
  -- (Cocina/Entregas dashboards, delete_order_if_not_active) keep working unmodified
  -- against this row during the W6 compatibility window.
  SELECT array_agg(o.id ORDER BY u.ord) INTO v_ids
    FROM unnest(v_uids) WITH ORDINALITY AS u(order_uid, ord) JOIN public.ordenes o ON o.order_uid = u.order_uid;
  SELECT array_agg(DISTINCT o.zona) FILTER (WHERE o.zona IS NOT NULL) INTO v_zones
    FROM public.ordenes o WHERE o.order_uid = ANY (v_uids);
  v_snapshot := jsonb_build_object(
    'trip_id', v_trip_id::text, 'anchor_order_id', (SELECT id FROM public.ordenes WHERE order_uid = p_anchor_order_uid),
    'order_ids', to_jsonb(v_ids), 'manual_giro_ids', CASE WHEN v_giro_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_giro_id) END,
    'salida_refs', '[]'::jsonb, 'zone_sequence', to_jsonb(COALESCE(v_zones, ARRAY[]::text[])),
    'n_orders', COALESCE(array_length(v_uids, 1), 0), 'started_at', to_jsonb(now()), 'closed_at', 'null'::jsonb,
    'trip_version', 1, 'status', 'ACTIVE');

  INSERT INTO public.config (chiave, valore) VALUES ('DRIVER_STATO', '{}')
  ON CONFLICT (chiave) DO NOTHING;
  SELECT COALESCE(NULLIF(valore, '')::jsonb, '{}'::jsonb) INTO v_ds
    FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;                                   -- L5
  v_ds := v_ds || jsonb_build_object(
    'schema', 2, 'stato', 'IN_GIRO', 'zona', to_jsonb(v_zones[1]),
    -- language-guard: allow-legacy n_ordini is the existing DRIVER_STATO snapshot field name (start_rider_trip's own convention), not new vocabulary
    'partito_alle', to_jsonb(now()), 'n_ordini', COALESCE(array_length(v_uids, 1), 0),
    'rientro_stimato', 'null'::jsonb, 'trip_seq', COALESCE((v_ds->>'trip_seq')::int, 0) + 1,
    'active_trip', v_snapshot);
  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'trip_id', v_trip_id, 'giro_id', v_giro_id,
    'anchor_order_uid', p_anchor_order_uid, 'order_uids', to_jsonb(v_uids), 'business_date', v_dates[1]);
END $fn$;

-- 3. Post-conditions ------------------------------------------------------------------------
DO $$
DECLARE
  v_close text;
  v_start text;
  v_oid   oid;
  v_lit   constant text := 'hashtext(''LA_DIECI_DRIVER_STATO'')';
  p_lc integer; p_l0 integer; p_row integer; p_bd integer; p_trip integer; p_upd integer;
  p_open integer; p_ins integer;
  r record;
BEGIN
  v_close := pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure);
  v_start := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);

  -- close: exactly one L0 acquisition, after the lifecycle lock, before the first row lock.
  IF (length(v_close) - length(replace(v_close, v_lit, ''))) / length(v_lit) <> 1 THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: close_service_session_v3 must acquire L0 exactly once';
  END IF;
  p_lc  := position('hashtext(''service_session_lifecycle'')' in v_close);
  p_l0  := position(v_lit in v_close);
  p_row := position('FOR UPDATE' in v_close);
  IF NOT (p_lc > 0 AND p_l0 > p_lc AND p_row > p_l0) THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: close lock order must be lifecycle -> L0 -> first row lock (lifecycle %, L0 %, row %)', p_lc, p_l0, p_row;
  END IF;
  -- close: the exclusion sits after the last pre-existing check and before the terminal UPDATE.
  p_bd   := position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' in v_close);
  p_trip := position('trip_projection_v1' in v_close);
  p_upd  := position('UPDATE public.service_sessions' in v_close);
  IF NOT (p_bd > 0 AND p_trip > p_bd AND p_upd > p_trip) THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: the ACTIVE-trip check must sit after the last pre-existing refusal and before the terminal UPDATE (%, %, %)', p_bd, p_trip, p_upd;
  END IF;
  IF v_close NOT LIKE '%V3_CLOSE_ACTIVE_RIDER_TRIP%' OR v_close NOT LIKE '%V3_CLOSE_RIDER_TRIP_UNVERIFIABLE%' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: close_service_session_v3 is missing a typed refusal code';
  END IF;
  IF v_close NOT LIKE '%V3_CLOSED%' OR v_close NOT LIKE '%ALREADY_CLOSED%' OR v_close NOT LIKE '%SESSION_CLOSE_IDENTITY_MISMATCH%'
     OR v_close NOT LIKE '%CURRENT_SESSION_MISMATCH%' OR v_close NOT LIKE '%BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH%'
     OR v_close NOT LIKE '%giro_intent_service_close_sweep%' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: close_service_session_v3 lost a pre-existing outcome/guard literal';
  END IF;

  -- start: still exactly one L0, still first; the new check precedes the trip INSERT.
  IF (length(v_start) - length(replace(v_start, v_lit, ''))) / length(v_lit) <> 1 THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: start_rider_trip_v2 must acquire L0 exactly once';
  END IF;
  p_l0   := position(v_lit in v_start);
  p_open := position('SERVICE_NOT_OPEN' in v_start);
  p_ins  := position('INSERT INTO trip_authority.trips' in v_start);
  IF NOT (p_l0 > 0 AND p_open > p_l0 AND p_ins > p_open) THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: SERVICE_NOT_OPEN check must sit after L0 and before the trip INSERT (%, %, %)', p_l0, p_open, p_ins;
  END IF;
  IF v_start NOT LIKE '%v_by.role NOT IN (''rider'', ''admin'', ''operator'')%'
     OR v_start NOT LIKE '%CASE WHEN v_by.role = ''rider'' THEN p_actor ELSE NULL END%'
     OR v_start NOT LIKE '%ACTIVE_TRIP_CONFLICT%' OR v_start NOT LIKE '%SCOPE_MISMATCH%' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: start_rider_trip_v2 lost a pre-existing guard';
  END IF;

  -- Security posture of both functions is exactly what it was: owner, SECURITY attribute, search_path
  -- and ACL equal the snapshot taken before the CREATE OR REPLACEs (no privilege is granted or revoked).
  FOR r IN
    SELECT b.proname, b.prosecdef AS b_sec, b.proconfig AS b_cfg, b.owner AS b_owner, b.acl AS b_acl,
           p.prosecdef AS a_sec, p.proconfig AS a_cfg, pg_get_userbyid(p.proowner) AS a_owner, p.proacl::text AS a_acl
      FROM atc138_before b
      JOIN pg_proc p ON p.oid = CASE b.proname
             WHEN 'close_service_session_v3' THEN 'public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure
             WHEN 'start_rider_trip_v2'      THEN 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure END
  LOOP
    IF r.a_sec IS DISTINCT FROM r.b_sec OR r.a_cfg IS DISTINCT FROM r.b_cfg
       OR r.a_owner IS DISTINCT FROM r.b_owner OR r.a_acl IS DISTINCT FROM r.b_acl THEN
      RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: % changed its owner / SECURITY attribute / search_path / ACL', r.proname;
    END IF;
    IF r.proname = 'close_service_session_v3' AND (r.a_sec IS DISTINCT FROM false OR r.a_cfg IS DISTINCT FROM ARRAY['search_path=public, pg_temp']) THEN
      RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: close_service_session_v3 must be SECURITY INVOKER with search_path public, pg_temp';
    END IF;
    IF r.proname = 'start_rider_trip_v2' AND (r.a_sec IS DISTINCT FROM true OR r.a_cfg IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']) THEN
      RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION post-condition failed: start_rider_trip_v2 must be SECURITY DEFINER with search_path pg_catalog, pg_temp';
    END IF;
  END LOOP;
END $$;

COMMIT;
