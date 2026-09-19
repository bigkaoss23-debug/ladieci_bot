-- ROLLBACK for ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION_V1 (migration 138).
-- Restores public.close_service_session_v3 to its EXACT ledger-132 body and public.start_rider_trip_v2
-- to its EXACT ledger-137 body (byte-identical, comments included -- transcribed verbatim from
-- migrations/2026-09-15_w5_intent_activation_v1_migration_132.sql and
-- migrations/2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137.sql).
--
-- Migration 138 changes no table, column, index, constraint, trigger or grant, so there is no data
-- dependency and NO point of no return: this rollback is always safe to run. What it does re-open is
-- the race documented in migration 138's header (service CLOSED + trip ACTIVE by collision between the
-- close and a departure); the backend JS preflight (activeRiderTripBlocker) stays in place either way.

BEGIN;

-- Predecessor / drift guard -----------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION ROLLBACK refused: a target function is absent -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)');
  IF md5(v_src) IS DISTINCT FROM '3051158274094b46d668481b0dbdbdc5' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION ROLLBACK refused: close_service_session_v3 is not the exact migration-138 body (not applied, already rolled back, or drifted) -- a later change would be silently discarded, resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])');
  IF md5(v_src) IS DISTINCT FROM '0323fbb1bab76a12fd2be3fed0b3187e' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION ROLLBACK refused: start_rider_trip_v2 is not the exact migration-138 body (not applied, already rolled back, or drifted) -- a later change would be silently discarded, resolve drift first';
  END IF;
END $guard$;

-- Snapshot of the security posture the restored functions must keep (see migration 138).
CREATE TEMP TABLE atc138_before (proname text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text) ON COMMIT DROP;
INSERT INTO atc138_before
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text
    FROM pg_proc p
   WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                   'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);

-- 1. close_service_session_v3 -- exact ledger-132 body ---------------------------------------
CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
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

-- 2. start_rider_trip_v2 -- exact ledger-137 body --------------------------------------------
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

-- 3. Post-conditions -------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure;
  IF md5(v_src) IS DISTINCT FROM '3caf2da77baabd6b5533879d101b2cc7' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION ROLLBACK post-condition failed: close_service_session_v3 is not byte-identical to the ledger-132 body';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure;
  IF md5(v_src) IS DISTINCT FROM 'd3482569db6df9ec5e6445e7748ebc3c' THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION ROLLBACK post-condition failed: start_rider_trip_v2 is not byte-identical to the ledger-137 body';
  END IF;
  IF EXISTS (
    SELECT 1 FROM atc138_before b
      JOIN pg_proc p ON p.oid = CASE b.proname
             WHEN 'close_service_session_v3' THEN 'public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure
             WHEN 'start_rider_trip_v2'      THEN 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure END
     WHERE p.prosecdef IS DISTINCT FROM b.prosecdef OR p.proconfig IS DISTINCT FROM b.proconfig
        OR pg_get_userbyid(p.proowner) IS DISTINCT FROM b.owner OR p.proacl::text IS DISTINCT FROM b.acl) THEN
    RAISE EXCEPTION 'ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION ROLLBACK post-condition failed: a restored function changed its owner / SECURITY attribute / search_path / ACL';
  END IF;
END $$;

COMMIT;
