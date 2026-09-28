-- migrations/2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.sql
-- Paired rollback: 2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.ROLLBACK.sql
--
-- ECONOMY BASE -- FINAL LIVENESS GATE, FINDING N2. STAGING CANDIDATE ONLY; not applied by the session that authored it.
-- Evidence: ~/Downloads/ECONOMY_FINAL_LIVENESS_GATE_REPORT_2026-09-27.md.
--
-- DEFECT N2 -- DEADLOCK MONEY WRITER x RIDER TRIP START / GIRO AUTHORITY (pre-existing on the frozen 139 -> 151 chain, reproduced 40P01).
-- The money writers lock WORKSPACE -> ACTOR FOR UPDATE -> [TABLE_SESSION] -> ENTITY (order_entities) FOR UPDATE -> ORDER FOR UPDATE -> pointer
-- FOR SHARE. start_rider_trip_v2 and the live Giro Authority commands lock ORDER FOR SHARE (L4) and only THEN insert rows whose foreign keys
-- point at order_entities (trips.anchor_order_uid, trip_members, manual_giros.anchor_order_uid, giro_members) -- and, for the trip, at the
-- dispatching actor (trips.dispatched_by / rider_actor). A foreign-key check takes FOR KEY SHARE on the referenced row, which conflicts with
-- FOR UPDATE: a payment holding ENTITY (or ACTOR) and waiting for ORDER, against a departure holding ORDER and waiting for ENTITY (or ACTOR),
-- is a cycle. PostgreSQL aborts one of them (40P01): nothing is corrupted, but a payment or a departure fails at random under load.
--
-- FIX (Option A of the gate brief; no money writer is touched, no lock mode of a money writer changes): the SAME KEY SHARE the foreign-key
-- checks take is taken explicitly, BEFORE L4, in the money writers' relative order (ACTOR before ENTITY), ascending order_uid when several:
--   start_rider_trip_v2               actor row FOR KEY SHARE after its identity checks; ENTITY rows of every departing order before L4
--   giro_authority_create_or_move_v1  ENTITY rows of the members (the anchor is one of them) before L4
--   giro_authority_attach_or_move_v1  ENTITY row of the attached order before L4
--   giro_authority_consume_intent_v1  ENTITY rows of the order and of its target before L4
-- Each body is its predecessor plus the marked 155:BEGIN / 155:END block(s) only; signatures, SECURITY DEFINER, owner, search_path and
-- grants are unchanged (CREATE OR REPLACE). Why no new cycle: every function that takes L0 (LA_DIECI_DRIVER_STATO) takes it before any
-- WORKSPACE / ACTOR / ENTITY / ORDER lock, and the money writers take none of L0, the giro rows (L1), the per-order advisory locks (L2) or the
-- intents (L3); a Planner command can therefore wait on ACTOR / ENTITY only behind a writer that never waits on what the command holds.
-- NOT modified: giro_authority_create_v1 / giro_authority_attach_v1 (W3 originals, same shape, but no backend caller and no resource-policy
-- entry: SUPABASE_RESOURCE_NOT_ALLOWED), giro_authority_move_v1 / detach_v1 / dissolve_v1 (no foreign-key check against ENTITY after L4).
-- ROLLOUT: after 154 (chain 139 -> ... -> 150 -> backend -> 151 -> 152 -> 153 -> 154 -> 155). Database only: no signature changes, so every
-- backend of the package (and the older one) calls the same RPCs with the same results; only the lock order inside changes.
-- ROLLBACK: 2026-09-27_planner_entity_key_share_before_order_lock_v1_migration_155.ROLLBACK.sql restores the four predecessor bodies byte for byte; valid at any time (no data depends on it); re-opens N2.

BEGIN;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'c57584ba03c40ee940e402188fd40d2d'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.service_close_day_evidence_digest_v1(timestamp with time zone,timestamp with time zone)')) IS DISTINCT FROM 'f637aa2eaa3baec55bf7e88332d3d345'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)')) IS DISTINCT FROM 'd79f71a2a40350307493ea1807b5fa77'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)')) IS DISTINCT FROM 'd5f962866a565fe63eb0842124829cfe'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)')) IS DISTINCT FROM '2c411d98f63545c4a4b7d04fd9beb7fe'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM 'bfac4ec3f428daa91d5d9505d8b1285a' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: migrations 151 .. 154 are not applied with their certified bodies -- the chain is 139 -> ... -> 154 -> 155';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) = 'baa7e42e28b15565e93f5da66374a6a9' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])')) = 'b5823fc5417a92007295efe531a899f0'
     AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])')) = '4f39a046a0c4f04ef4ea5cc548328f03' AND (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')) = '2a59a168d43c398d9e34d3ae651d1ea4' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: already applied';
  END IF;
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) IS DISTINCT FROM '0323fbb1bab76a12fd2be3fed0b3187e' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: start_rider_trip_v2 is not the certified predecessor body 0323fbb1... (drift or partial apply) -- a divergent body is never overwritten';
  END IF;
  IF NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: start_rider_trip_v2 is not SECURITY DEFINER owned by postgres with search_path pg_catalog, pg_temp';
  END IF;
  IF to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])')) IS DISTINCT FROM 'e4966ba63a075f6914c26d6508cfef00' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: giro_authority_create_or_move_v1 is not the certified predecessor body e4966ba6... (drift or partial apply) -- a divergent body is never overwritten';
  END IF;
  IF NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])')) THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: giro_authority_create_or_move_v1 is not SECURITY DEFINER owned by postgres with search_path pg_catalog, pg_temp';
  END IF;
  IF to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])') IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])')) IS DISTINCT FROM '85fb8a84ed311edfa02c11a4c7f9afec' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: giro_authority_attach_or_move_v1 is not the certified predecessor body 85fb8a84... (drift or partial apply) -- a divergent body is never overwritten';
  END IF;
  IF NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])')) THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: giro_authority_attach_or_move_v1 is not SECURITY DEFINER owned by postgres with search_path pg_catalog, pg_temp';
  END IF;
  IF to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])') IS NULL OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')) IS DISTINCT FROM '3dde47553cc347d097735df8ba7ca5aa' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: giro_authority_consume_intent_v1 is not the certified predecessor body 3dde4755... (drift or partial apply) -- a divergent body is never overwritten';
  END IF;
  IF NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' AND proconfig = ARRAY['search_path=pg_catalog, pg_temp'] FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')) THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: giro_authority_consume_intent_v1 is not SECURITY DEFINER owned by postgres with search_path pg_catalog, pg_temp';
  END IF;
  IF to_regclass('public.order_entities') IS NULL OR to_regclass('public.auth_actors') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE refused: a required table or role is missing';
  END IF;
END $guard$;

-- start_rider_trip_v2: predecessor 0323fbb1bab76a12fd2be3fed0b3187e -> baa7e42e28b15565e93f5da66374a6a9
CREATE OR REPLACE FUNCTION public.start_rider_trip_v2(p_anchor_order_uid uuid, p_actor text, p_session_version integer, p_operational_session_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
  -- 155:BEGIN actor_key_share
  -- N2 (POST-ASTRA final liveness gate). The trips INSERT further down checks dispatched_by / rider_actor -> auth_actors, taking FOR KEY
  -- SHARE on this actor row AFTER the ORDER lock (L4) -- the inversion of the money writers' ACTOR FOR UPDATE -> ... -> ORDER order when the
  -- same actor pays and dispatches the same order. The same KEY SHARE is now taken here, before L1 / L2 / L4 (L0 is already held).
  PERFORM 1 FROM public.auth_actors a WHERE a.actor = p_actor FOR KEY SHARE;
  -- 155:END actor_key_share

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
  -- 155:BEGIN entity_key_share
  -- N2 (POST-ASTRA final liveness gate). The inserts below check foreign keys against public.order_entities, taking FOR KEY SHARE on the
  -- ENTITY rows. Taken implicitly there, AFTER the ORDER lock (L4) just below, they inverted the money writers' order (WORKSPACE -> ACTOR
  -- -> ENTITY FOR UPDATE -> ORDER FOR UPDATE): a payment / refund / cancel / adjustment holding ENTITY and waiting for ORDER, against this
  -- command holding ORDER and waiting for ENTITY, deadlocked (40P01, reproduced). The same KEY SHARE is now taken explicitly, BEFORE L4,
  -- in ascending order_uid; the later FK checks find it already held. Nothing else in this body changes.
  PERFORM 1 FROM public.order_entities e WHERE e.order_uid = ANY (v_uids) ORDER BY e.order_uid FOR KEY SHARE;
  -- 155:END entity_key_share
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
END $function$
;

-- giro_authority_create_or_move_v1: predecessor e4966ba63a075f6914c26d6508cfef00 -> b5823fc5417a92007295efe531a899f0
CREATE OR REPLACE FUNCTION public.giro_authority_create_or_move_v1(p_order_uids uuid[], p_hora_ref text, p_anchor_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_uids   uuid[];
  v_hora   text;
  v_trip   jsonb;
  v_reason text;
  v_dates  date[];
  v_id     text;
  v_effs   text[];
  v_moved  text[];
  r        record;
  d        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'actor'));
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  v_uids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_order_uids, '{}'::uuid[])) AS x WHERE x IS NOT NULL ORDER BY 1);
  IF cardinality(v_uids) < 2 THEN
    RETURN giro_authority.refusal_v1('INSUFFICIENT_MEMBERS', NULL);
  END IF;
  IF p_hora_ref IS NOT NULL AND btrim(p_hora_ref) <> '' THEN
    v_hora := giro_authority.hhmm_norm(p_hora_ref);
    IF v_hora IS NULL THEN
      RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'hora_ref'));
    END IF;
  END IF;
  IF p_anchor_order_uid IS NOT NULL AND NOT (p_anchor_order_uid = ANY (v_uids)) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'anchor_order_uid'));
  END IF;

  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  -- Lock every giro any of these orders currently point to (L1, ascending id),
  -- then the orders themselves (L2 + L4) -- same discipline as every other command.
  PERFORM 1 FROM public.manual_giros mg
    WHERE mg.id IN (SELECT DISTINCT gm.giro_id FROM giro_authority.giro_members gm WHERE gm.order_uid = ANY (v_uids))
    ORDER BY mg.id FOR UPDATE;
  PERFORM giro_authority.lock_orders_v1(v_uids);
  -- 155:BEGIN entity_key_share
  -- N2 (POST-ASTRA final liveness gate). The inserts below check foreign keys against public.order_entities, taking FOR KEY SHARE on the
  -- ENTITY rows. Taken implicitly there, AFTER the ORDER lock (L4) just below, they inverted the money writers' order (WORKSPACE -> ACTOR
  -- -> ENTITY FOR UPDATE -> ORDER FOR UPDATE): a payment / refund / cancel / adjustment holding ENTITY and waiting for ORDER, against this
  -- command holding ORDER and waiting for ENTITY, deadlocked (40P01, reproduced). The same KEY SHARE is now taken explicitly, BEFORE L4,
  -- in ascending order_uid; the later FK checks find it already held. Nothing else in this body changes.
  PERFORM 1 FROM public.order_entities e WHERE e.order_uid = ANY (v_uids) ORDER BY e.order_uid FOR KEY SHARE;
  -- 155:END entity_key_share
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = ANY (v_uids) ORDER BY o.order_uid FOR SHARE;

  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  FOR r IN SELECT * FROM giro_authority.order_facts_v1(v_uids, v_trip) LOOP
    v_reason := giro_authority.member_refusal_v1(r.present, r.estado, r.delivery_type, r.table_session_id,
                                                 r.in_active_trip, r.service_session_id, p_operational_session_ids);
    IF v_reason = 'ORDER_NOT_FOUND' THEN
      RETURN giro_authority.refusal_v1('ORDER_NOT_FOUND', jsonb_build_object('order_uid', r.order_uid));
    ELSIF v_reason IS NOT NULL THEN
      RETURN giro_authority.refusal_v1('ORDER_NOT_ELIGIBLE', jsonb_build_object('order_uid', r.order_uid, 'reason', v_reason));
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT f.business_date) INTO v_dates FROM giro_authority.order_facts_v1(v_uids, v_trip) f;
  IF cardinality(v_dates) <> 1 OR v_dates[1] IS NULL THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;

  -- One computation of each order's current effective giro (or NULL) -- reused below,
  -- never recomputed.
  v_effs := ARRAY(SELECT giro_authority.order_effective_giro_v1(u, p_operational_session_ids, v_trip)
                    FROM unnest(v_uids) AS u);

  -- Idempotent replay: the exact requested set is already the sole effective
  -- membership of one existing giro.
  IF (SELECT count(DISTINCT e) FROM unnest(v_effs) AS e WHERE e IS NOT NULL) = 1
     AND NOT EXISTS (SELECT 1 FROM unnest(v_effs) AS e WHERE e IS NULL) THEN
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_effs[1]], p_operational_session_ids, v_trip);
    IF d.effective_order_uids = v_uids THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', d.giro_id);
    END IF;
  END IF;

  -- Safety invariant shared with detach/move: never silently pull a member out of a
  -- giro whose rider already departed.
  FOR r IN SELECT DISTINCT e AS giro_id FROM unnest(v_effs) AS e WHERE e IS NOT NULL LOOP
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[r.giro_id], p_operational_session_ids, v_trip);
    IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', r.giro_id, 'giro_state', d.giro_state));
    END IF;
  END LOOP;

  v_moved := ARRAY(SELECT DISTINCT e FROM unnest(v_effs) AS e WHERE e IS NOT NULL);
  DELETE FROM giro_authority.giro_members WHERE order_uid = ANY (v_uids);

  v_id := giro_authority.insert_giro_v1(v_dates[1], v_hora, p_anchor_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(u, v_id, p_actor) FROM unnest(v_uids) AS u;
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', v_id, 'business_date', v_dates[1],
                            'order_uids', to_jsonb(v_uids), 'moved_from', to_jsonb(v_moved));
END $function$
;

-- giro_authority_attach_or_move_v1: predecessor 85fb8a84ed311edfa02c11a4c7f9afec -> 4f39a046a0c4f04ef4ea5cc548328f03
CREATE OR REPLACE FUNCTION public.giro_authority_attach_or_move_v1(p_giro_id text, p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_from   text;
  v_trip   jsonb;
  v_reason text;
  d        record;
  dt       record;
  f        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_giro_id IS NULL OR p_order_uid IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;

  SELECT gm.giro_id INTO v_from FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;

  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  -- L1: target giro + (if different) the order's current giro, ascending id -- same
  -- two-giro lock discipline as move_v1. A nonexistent p_giro_id simply locks zero
  -- rows here; existence is authoritatively checked below via derive_giros_v1.
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = ANY (ARRAY[p_giro_id, v_from]::text[]) ORDER BY mg.id FOR UPDATE;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid]);
  -- 155:BEGIN entity_key_share
  -- N2 (POST-ASTRA final liveness gate). The inserts below check foreign keys against public.order_entities, taking FOR KEY SHARE on the
  -- ENTITY rows. Taken implicitly there, AFTER the ORDER lock (L4) just below, they inverted the money writers' order (WORKSPACE -> ACTOR
  -- -> ENTITY FOR UPDATE -> ORDER FOR UPDATE): a payment / refund / cancel / adjustment holding ENTITY and waiting for ORDER, against this
  -- command holding ORDER and waiting for ENTITY, deadlocked (40P01, reproduced). The same KEY SHARE is now taken explicitly, BEFORE L4,
  -- in ascending order_uid; the later FK checks find it already held. Nothing else in this body changes.
  PERFORM 1 FROM public.order_entities e WHERE e.order_uid = p_order_uid FOR KEY SHARE;
  -- 155:END entity_key_share
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = p_order_uid FOR SHARE;

  -- Re-read membership now that locks are held (may have changed since the unlocked
  -- read above).
  SELECT gm.giro_id INTO v_from FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;

  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO dt FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  IF dt.giro_id IS NULL THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;

  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  v_reason := giro_authority.member_refusal_v1(f.present, f.estado, f.delivery_type, f.table_session_id,
                                               f.in_active_trip, f.service_session_id, p_operational_session_ids);
  IF v_reason = 'ORDER_NOT_FOUND' THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_FOUND', NULL);
  ELSIF v_reason IS NOT NULL THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_ELIGIBLE', jsonb_build_object('reason', v_reason));
  END IF;

  -- Already effectively in the target -> idempotent, regardless of the raw v_from row.
  IF p_order_uid = ANY (dt.effective_order_uids) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_giro_id);
  END IF;

  IF dt.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', p_giro_id, 'giro_state', dt.giro_state));
  END IF;
  IF dt.giro_state <> 'PLANNED' THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_PLANNED', jsonb_build_object('giro_id', p_giro_id, 'state_reason', dt.state_reason));
  END IF;
  IF f.business_date IS DISTINCT FROM dt.business_date THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;

  -- Effectively in ANOTHER giro right now -> safety check, then move.
  IF v_from IS NOT NULL THEN
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_from], p_operational_session_ids, v_trip);
    IF p_order_uid = ANY (d.effective_order_uids) AND d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', v_from, 'giro_state', d.giro_state));
    END IF;
  END IF;

  -- put_member_v1 is itself an upsert (INSERT ... ON CONFLICT (order_uid) DO UPDATE),
  -- so the same call serves the unattached, same-target-already-handled-above, and
  -- other-giro cases uniformly -- no separate insert/update branch needed here.
  PERFORM giro_authority.put_member_v1(p_order_uid, p_giro_id, p_actor);
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id, 'order_uid', p_order_uid, 'moved_from', v_from);
END $function$
;

-- giro_authority_consume_intent_v1: predecessor 3dde47553cc347d097735df8ba7ca5aa -> 2a59a168d43c398d9e34d3ae651d1ea4
CREATE OR REPLACE FUNCTION public.giro_authority_consume_intent_v1(p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_row  giro_authority.giro_intents;
  v_trip jsonb;
  v_ctx  jsonb;
  v_cur  text;
  v_new  text;
  v_why  text;
  f      record;
  a      record;
  d      record;
BEGIN
  IF p_order_uid IS NULL OR NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NO_INTENT');
  END IF;
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below,
  -- including the conditional L1 acquisition (GIRO target) two lines down.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  IF v_row.target_kind = 'GIRO' THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_row.target_giro_id FOR UPDATE;   -- L1
  END IF;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid, v_row.target_order_uid]);      -- L2
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid FOR UPDATE;  -- L3
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  -- 155:BEGIN entity_key_share
  -- N2 (POST-ASTRA final liveness gate). The inserts below check foreign keys against public.order_entities, taking FOR KEY SHARE on the
  -- ENTITY rows. Taken implicitly there, AFTER the ORDER lock (L4) just below, they inverted the money writers' order (WORKSPACE -> ACTOR
  -- -> ENTITY FOR UPDATE -> ORDER FOR UPDATE): a payment / refund / cancel / adjustment holding ENTITY and waiting for ORDER, against this
  -- command holding ORDER and waiting for ENTITY, deadlocked (40P01, reproduced). The same KEY SHARE is now taken explicitly, BEFORE L4,
  -- in ascending order_uid; the later FK checks find it already held. Nothing else in this body changes.
  PERFORM 1 FROM public.order_entities e
   WHERE e.order_uid = ANY (ARRAY[p_order_uid, v_row.target_order_uid])
   ORDER BY e.order_uid FOR KEY SHARE;
  -- 155:END entity_key_share
  PERFORM 1 FROM public.ordenes o
   WHERE o.order_uid = ANY (ARRAY[p_order_uid, v_row.target_order_uid])
   ORDER BY o.order_uid FOR SHARE;                                                        -- L4

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'SCOPE_UNAVAILABLE', NULL, p_actor, NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'UNVERIFIABLE', NULL, p_actor,
                                            jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  IF NOT f.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_GONE'));
  END IF;
  IF NOT COALESCE(f.service_session_id = ANY (p_operational_session_ids), false) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'EXPIRED', 'EXPIRY', 'SERVICE_CLOSED', NULL, p_actor, NULL);
  END IF;
  IF f.in_active_trip OR f.estado = 'EN_ENTREGA'
     OR f.estado = ANY (giro_authority.delivered_states_v1())
     OR f.estado = ANY (giro_authority.cancelled_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_STATE', 'estado', f.estado));
  END IF;
  IF f.estado IS NULL OR f.estado NOT IN ('EN_COCINA', 'LISTO') THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NOT_YET_OPERATIVE', 'status', 'PENDING', 'replay', false);
  END IF;
  v_ctx := v_row.order_context;
  IF (v_ctx->>'zona') IS DISTINCT FROM f.zona
     OR (v_ctx->>'hora') IS DISTINCT FROM f.hora
     OR (v_ctx->>'delivery_type') IS DISTINCT FROM f.delivery_type
     OR (v_ctx->>'service_session_id') IS DISTINCT FROM f.service_session_id::text THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor, NULL);
  END IF;
  IF f.delivery_type <> 'DOMICILIO' OR f.table_session_id IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'NOT_DELIVERY'));
  END IF;
  v_cur := giro_authority.order_effective_giro_v1(p_order_uid, p_operational_session_ids, v_trip);

  IF v_row.target_kind = 'GIRO' THEN
    IF v_cur = v_row.target_giro_id THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_cur, p_actor,
                                              jsonb_build_object('already_member', true));
    END IF;
    IF v_cur IS NOT NULL THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                              jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
    END IF;
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_row.target_giro_id], p_operational_session_ids, v_trip);
    IF NOT FOUND THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor, NULL);
    END IF;
    IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor,
                                              jsonb_build_object('giro_state', d.giro_state));
    END IF;
    IF d.giro_state <> 'PLANNED' OR d.business_date IS DISTINCT FROM f.business_date THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                              jsonb_build_object('state_reason', d.state_reason));
    END IF;
    IF giro_authority.target_fingerprint_v1('GIRO', v_row.target_giro_id, NULL) IS DISTINCT FROM v_row.target_fingerprint THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
    END IF;
    PERFORM giro_authority.put_member_v1(p_order_uid, v_row.target_giro_id, p_actor);
    PERFORM giro_authority.bump_facts_signal_v1();
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_row.target_giro_id, p_actor, NULL);
  END IF;

  -- ANCHOR: create {anchor, order}; the anchor must still be a free, operative single.
  IF v_cur IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
  END IF;
  SELECT * INTO a FROM giro_authority.order_facts_v1(ARRAY[v_row.target_order_uid], v_trip);
  IF NOT a.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ANCHOR_GONE'));
  END IF;
  IF a.in_active_trip OR a.estado = 'EN_ENTREGA' OR a.estado = ANY (giro_authority.delivered_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor, NULL);
  END IF;
  v_why := giro_authority.member_refusal_v1(a.present, a.estado, a.delivery_type, a.table_session_id,
                                            a.in_active_trip, a.service_session_id, p_operational_session_ids);
  IF v_why IS NOT NULL OR a.business_date IS DISTINCT FROM f.business_date THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', COALESCE(v_why, 'BUSINESS_DATE')));
  END IF;
  IF giro_authority.order_effective_giro_v1(v_row.target_order_uid, p_operational_session_ids, v_trip) IS NOT NULL
     OR giro_authority.target_fingerprint_v1('ANCHOR', NULL, v_row.target_order_uid) IS DISTINCT FROM v_row.target_fingerprint THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
  END IF;
  v_new := giro_authority.insert_giro_v1(f.business_date, NULL, v_row.target_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(v_row.target_order_uid, v_new, p_actor);
  PERFORM giro_authority.put_member_v1(p_order_uid, v_new, p_actor);
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'GIRO_CREATED', v_new, p_actor, NULL);
END $function$
;

DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) IS DISTINCT FROM 'baa7e42e28b15565e93f5da66374a6a9'
     OR NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])'))
     OR NOT has_function_privilege('service_role', 'public.start_rider_trip_v2(uuid,text,integer,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.start_rider_trip_v2(uuid,text,integer,uuid[])', 'EXECUTE') OR has_function_privilege('authenticated', 'public.start_rider_trip_v2(uuid,text,integer,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE post-condition failed: start_rider_trip_v2';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])')) IS DISTINCT FROM 'b5823fc5417a92007295efe531a899f0'
     OR NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'))
     OR NOT has_function_privilege('service_role', 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])', 'EXECUTE') OR has_function_privilege('authenticated', 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE post-condition failed: giro_authority_create_or_move_v1';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])')) IS DISTINCT FROM '4f39a046a0c4f04ef4ea5cc548328f03'
     OR NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'))
     OR NOT has_function_privilege('service_role', 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])', 'EXECUTE') OR has_function_privilege('authenticated', 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE post-condition failed: giro_authority_attach_or_move_v1';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')) IS DISTINCT FROM '2a59a168d43c398d9e34d3ae651d1ea4'
     OR NOT (SELECT prosecdef AND pg_get_userbyid(proowner) = 'postgres' FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'))
     OR NOT has_function_privilege('service_role', 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])', 'EXECUTE') OR has_function_privilege('authenticated', 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE post-condition failed: giro_authority_consume_intent_v1';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'c57584ba03c40ee940e402188fd40d2d'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.service_close_day_evidence_digest_v1(timestamp with time zone,timestamp with time zone)')) IS DISTINCT FROM 'f637aa2eaa3baec55bf7e88332d3d345'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)')) IS DISTINCT FROM 'd79f71a2a40350307493ea1807b5fa77'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)')) IS DISTINCT FROM 'd5f962866a565fe63eb0842124829cfe'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)')) IS DISTINCT FROM '2c411d98f63545c4a4b7d04fd9beb7fe'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM 'bfac4ec3f428daa91d5d9505d8b1285a' THEN
    RAISE EXCEPTION 'PLANNER_ENTITY_KEY_SHARE post-condition failed: a 151 .. 154 body changed';
  END IF;
END $post$;

COMMIT;
