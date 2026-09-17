-- ROLLBACK for B1_RIDER_DISPATCH_OPERATOR_PARITY_V1 (migration 137).
-- Restores public.start_rider_trip_v2 to its exact migration-135 body: the identity
-- check goes back to "role = 'rider'" exactly. Safe at any time — this only narrows
-- who may call the function again; it drops nothing and every existing
-- trip_authority.trips row (whatever role its rider_actor recorded) stays untouched.

BEGIN;

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
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  IF p_anchor_order_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- IDENTITY. Role must be exactly 'rider' -- same contract as rider_collect_and_complete_stop.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE');
  END IF;

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

  v_legacy_trip := giro_authority.trip_facts_v1();
  IF NOT (v_legacy_trip->>'available')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNVERIFIABLE', 'reason', v_legacy_trip->>'reason');
  END IF;
  IF (v_legacy_trip->>'active')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT', 'reason', 'LEGACY_TRIP_ACTIVE');
  END IF;

  v_giro_id := giro_authority.order_effective_giro_v1(p_anchor_order_uid, p_operational_session_ids, v_legacy_trip);

  IF v_giro_id IS NOT NULL THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_giro_id FOR UPDATE;
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro_id], p_operational_session_ids, v_legacy_trip);
    IF d.giro_id IS NULL OR d.giro_state <> 'PLANNED' OR NOT (p_anchor_order_uid = ANY (d.effective_order_uids)) THEN
      v_uids := ARRAY[p_anchor_order_uid];
      v_giro_id := NULL;
    ELSE
      v_uids := d.effective_order_uids;
      IF v_uids IS NULL OR NOT (p_anchor_order_uid = ANY (v_uids)) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'order_uid', p_anchor_order_uid);
      END IF;
    END IF;
  ELSE
    v_uids := ARRAY[p_anchor_order_uid];
  END IF;

  PERFORM giro_authority.lock_orders_v1(v_uids);
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = ANY (v_uids) ORDER BY o.order_uid FOR SHARE;

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

  v_trip_id := gen_random_uuid();
  INSERT INTO trip_authority.trips
    (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, giro_id, departed_at, status, seq)
  VALUES
    (v_trip_id, v_dates[1], v_anchor_sess, p_actor, p_anchor_order_uid, v_giro_id, now(), 'ACTIVE',
     nextval('trip_authority.trips_seq_v1'));
  PERFORM trip_authority.freeze_members_v1(v_trip_id, v_uids, p_actor);

  UPDATE public.ordenes
     SET estado = 'EN_ENTREGA', hora_salida = (extract(epoch FROM now()) * 1000)::bigint
   WHERE order_uid = ANY (v_uids) AND estado = 'LISTO';

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
    FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_ds := v_ds || jsonb_build_object(
    'schema', 2, 'stato', 'IN_GIRO', 'zona', to_jsonb(v_zones[1]),
    'partito_alle', to_jsonb(now()), 'n_ordini', COALESCE(array_length(v_uids, 1), 0),
    'rientro_stimato', 'null'::jsonb, 'trip_seq', COALESCE((v_ds->>'trip_seq')::int, 0) + 1,
    'active_trip', v_snapshot);
  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'trip_id', v_trip_id, 'giro_id', v_giro_id,
    'anchor_order_uid', p_anchor_order_uid, 'order_uids', to_jsonb(v_uids), 'business_date', v_dates[1]);
END $fn$;

COMMIT;
