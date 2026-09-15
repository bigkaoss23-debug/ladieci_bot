-- ROLLBACK for PLANNER W6.3 + W6.4 -- CANONICAL RIDER LIFECYCLE + GIRO PROJECTION
-- CUTOVER (migration 135). Restores the exact pre-135 database definitions:
--   public.start_rider_trip_v2                  -> migration 134's dormant body, verbatim
--   public.rider_collect_and_complete_stop      -> its pre-135 (2026-07-27) body, verbatim
--   public.close_rider_trip                     -> its pre-135 (2026-07-21) body, verbatim
--   giro_authority.derive_giros_v1              -> migration 130's body, verbatim
--   trip_authority.trip_facts_canonical_v1      -> migration 134's body, verbatim
-- and drops everything migration 135 added: trips_one_trip_per_giro_v1,
-- trip_authority.close_terminal_states_v1 / progress_terminal_states_v1 /
-- departed_hhmm_v1, public.trip_authority_active_trip_v1 /
-- trip_authority_close_active_trip_v1.
--
-- POINT OF NO RETURN
--   This rollback is exact and safe ONLY while trip_authority.trips is still empty --
--   i.e. before the Node activation of start_rider_trip_v2 has created any real
--   canonical trip. It REFUSES outright once any canonical trip row exists, because at
--   that point the canonical lifecycle is the only place a real trip's membership,
--   departure and close are recorded, and reverting the lifecycle functions would strand
--   that history behind readers that cannot see it.
--
--   POST-PONR ROLLBACK STRATEGY (documented, deliberately NOT executed by this file):
--     1. Revert the BACKEND caller only -- riderTrip.startTrip goes back to
--        rpc/start_rider_trip (the v1 RPC is deliberately still installed and still
--        registered in the H1B resource policy until W7, precisely for this). No new
--        canonical trip can then be created.
--     2. LEAVE the database at migration 135. The canonical-aware collect and close are
--        backward compatible with a legacy DRIVER_STATO-only trip by construction and
--        were certified that way, so a v1-driven trip continues to work unchanged.
--     3. Let every already-canonical trip finish through the canonical path, then close
--        it. Only once trip_authority.trips holds no ACTIVE row, and only if the tables
--        must genuinely go, may a DATA-PRESERVING forward migration be authored to
--        retire them -- never this file.
--   Do NOT DROP the trip_authority schema, trips, or trip_members after canonical rows
--   exist, under any circumstance. Real trip history is not recoverable from
--   DRIVER_STATO, which only ever holds the current and last-closed trip.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.trip_authority_active_trip_v1()') IS NULL
     AND to_regprocedure('public.trip_authority_close_active_trip_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'W6_3_4_ROLLBACK refused: migration 135 does not appear to be applied -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM trip_authority.trips) THEN
    RAISE EXCEPTION 'W6_3_4_ROLLBACK refused: % canonical trip row(s) exist -- the operational PONR has been crossed. Revert the Node caller to rpc/start_rider_trip instead and leave the database at 135 (see this file''s header).',
      (SELECT count(*) FROM trip_authority.trips);
  END IF;
END $$;

-- 1. Drop the W6.3 index --------------------------------------------------------------------
DROP INDEX trip_authority.trips_one_trip_per_giro_v1;

-- 2. Restore giro_authority.derive_giros_v1 to migration 130's body, verbatim ---------------
CREATE OR REPLACE FUNCTION giro_authority.derive_giros_v1(p_giro_ids text[], p_scope uuid[], p_trip jsonb)
RETURNS TABLE (
  giro_id text, seq integer, business_date date, hora_ref text, anchor_order_uid uuid,
  created_at timestamptz, created_by text, dissolved_at timestamptz, dissolved_by text,
  giro_state text, state_reason text,
  effective_order_uids uuid[], effective_order_ids text[], active_order_uids uuid[],
  salida text, salida_source text
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH trip AS (
    SELECT ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'order_ids') = 'array'
                                                       THEN p_trip->'order_ids' ELSE '[]'::jsonb END)) AS order_ids,
           ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'giro_ids') = 'array'
                                                       THEN p_trip->'giro_ids' ELSE '[]'::jsonb END)) AS giro_ids
  ),
  g AS (
    SELECT mg.id, mg.seq, mg.business_date, mg.hora_ref, mg.anchor_order_uid, mg.created_at,
           mg.created_by, mg.dissolved_at, mg.dissolved_by
      FROM public.manual_giros mg
     WHERE mg.id = ANY (p_giro_ids)
  ),
  k AS (
    SELECT gm.giro_id AS g_id, gm.order_uid AS uid, o.id AS oid, o.estado, o.forno_out,
           (o.id IS NOT NULL) AS present,
           COALESCE(o.id = ANY (t.order_ids), false) AS in_active_trip,
           COALESCE(p_scope IS NULL OR o.service_session_id = ANY (p_scope), false) AS in_scope
      FROM giro_authority.giro_members gm
      CROSS JOIN trip t
      LEFT JOIN public.ordenes o ON o.order_uid = gm.order_uid
     WHERE gm.giro_id = ANY (p_giro_ids)
  ),
  kc AS (
    SELECT k.*,
           (k.present AND (k.in_active_trip OR k.estado = 'EN_ENTREGA')) AS departed_live,
           (k.present AND k.estado = ANY (giro_authority.delivered_states_v1())) AS delivered,
           (k.present AND k.estado IN ('EN_COCINA', 'LISTO') AND NOT k.in_active_trip) AS pre_departure
      FROM k
  ),
  a AS (
    SELECT kc.g_id,
           count(*) FILTER (WHERE kc.departed_live)                  AS n_departed,
           count(*) FILTER (WHERE kc.delivered)                      AS n_delivered,
           count(*) FILTER (WHERE kc.pre_departure AND kc.in_scope)  AS n_pre_scope,
           count(*) FILTER (WHERE kc.pre_departure)                  AS n_pre_any
      FROM kc GROUP BY kc.g_id
  ),
  st AS (
    SELECT g.*,
           CASE WHEN g.dissolved_at IS NOT NULL THEN 'DISSOLVED'
                WHEN COALESCE(a.n_departed, 0) > 0 OR g.id = ANY (t.giro_ids) THEN 'IN_TRIP'
                WHEN COALESCE(a.n_delivered, 0) > 0 THEN 'DONE'
                WHEN COALESCE(a.n_pre_scope, 0) >= 2 THEN 'PLANNED'
                ELSE 'DISSOLVED' END AS g_state,
           CASE WHEN g.dissolved_at IS NOT NULL THEN 'EXPLICIT'
                WHEN COALESCE(a.n_departed, 0) > 0 OR g.id = ANY (t.giro_ids) THEN 'DEPARTED'
                WHEN COALESCE(a.n_delivered, 0) > 0 THEN 'DELIVERED'
                WHEN COALESCE(a.n_pre_scope, 0) >= 2 THEN 'OPERATIVE'
                WHEN COALESCE(a.n_pre_any, 0) >= 2 THEN 'SERVICE_CLOSED'
                ELSE 'BELOW_MIN_MEMBERS' END AS g_reason
      FROM g CROSS JOIN trip t LEFT JOIN a ON a.g_id = g.id
  )
  SELECT st.id, st.seq, st.business_date, st.hora_ref, st.anchor_order_uid, st.created_at,
         st.created_by, st.dissolved_at, st.dissolved_by, st.g_state, st.g_reason,
         COALESCE(eff.uids, '{}'::uuid[]), COALESCE(eff.oids, '{}'::text[]), COALESCE(act.uids, '{}'::uuid[]),
         CASE WHEN st.g_state = 'DISSOLVED' THEN NULL
              WHEN giro_authority.hhmm_norm(st.hora_ref) IS NOT NULL THEN giro_authority.hhmm_norm(st.hora_ref)
              ELSE px.salida END,
         CASE WHEN st.g_state = 'DISSOLVED' THEN 'NONE'
              WHEN giro_authority.hhmm_norm(st.hora_ref) IS NOT NULL THEN 'OPERATOR'
              WHEN px.salida IS NOT NULL THEN 'PROXY_MAX_FORNO'
              ELSE 'NONE' END
    FROM st
    LEFT JOIN LATERAL (
      SELECT array_agg(kc.uid ORDER BY kc.uid) AS uids, array_agg(kc.oid ORDER BY kc.uid) AS oids
        FROM kc
       WHERE kc.g_id = st.id
         AND (   (st.g_state = 'PLANNED' AND kc.pre_departure AND kc.in_scope)
              OR (st.g_state = 'IN_TRIP' AND (kc.departed_live OR kc.delivered))
              OR (st.g_state = 'DONE'    AND kc.delivered))
    ) eff ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(kc.uid ORDER BY kc.uid) AS uids
        FROM kc
       WHERE kc.g_id = st.id AND kc.present AND kc.estado IN ('EN_COCINA', 'LISTO', 'EN_ENTREGA')
    ) act ON true
    LEFT JOIN LATERAL (
      SELECT giro_authority.hhmm_norm(kc.forno_out) AS salida
        FROM kc
       WHERE kc.g_id = st.id AND kc.uid = ANY (COALESCE(eff.uids, '{}'::uuid[]))
         AND giro_authority.service_day_minutes(kc.forno_out) IS NOT NULL
       ORDER BY giro_authority.service_day_minutes(kc.forno_out) DESC
       LIMIT 1
    ) px ON true
$fn$;

-- 3. Restore trip_authority.trip_facts_canonical_v1 to migration 134's body, verbatim -------
CREATE OR REPLACE FUNCTION trip_authority.trip_facts_canonical_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip      trip_authority.trips%ROWTYPE;
  v_order_ids jsonb;
BEGIN
  SELECT * INTO v_trip FROM trip_authority.trips WHERE status = 'ACTIVE';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb,
                              'canonical_trip_exists', false);
  END IF;
  SELECT COALESCE(jsonb_agg(o.id ORDER BY tm.stop_seq), '[]'::jsonb) INTO v_order_ids
    FROM trip_authority.trip_members tm
    JOIN public.ordenes o ON o.order_uid = tm.order_uid
   WHERE tm.trip_id = v_trip.trip_id
     AND NOT (o.estado = ANY (giro_authority.delivered_states_v1()));
  RETURN jsonb_build_object('available', true, 'active', v_order_ids <> '[]'::jsonb, 'trip_id', v_trip.trip_id::text,
    'order_ids', v_order_ids,
    'giro_ids', CASE WHEN v_trip.giro_id IS NULL OR v_order_ids = '[]'::jsonb
                     THEN '[]'::jsonb ELSE jsonb_build_array(v_trip.giro_id) END,
    'canonical_trip_exists', true);
END $fn$;

-- 4. Restore public.start_rider_trip_v2 to migration 134's body, verbatim --------------------
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

  -- IDENTITY. Role must be exactly 'rider' -- same contract as rider_collect_and_complete_stop.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE');
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
      -- Certified behaviour (N06b): the departure takes only the members actually
      -- LISTO right now; an EN_COCINA member is released, never an error, and never
      -- blocks the trip.
      SELECT array_agg(o.order_uid ORDER BY o.order_uid) INTO v_uids
        FROM public.ordenes o WHERE o.order_uid = ANY (d.effective_order_uids) AND o.estado = 'LISTO';
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
  v_trip_id := gen_random_uuid();
  INSERT INTO trip_authority.trips
    (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, giro_id, departed_at, status, seq)
  VALUES
    (v_trip_id, v_dates[1], v_anchor_sess, p_actor, p_anchor_order_uid, v_giro_id, now(), 'ACTIVE',
     nextval('trip_authority.trips_seq_v1'));
  PERFORM trip_authority.freeze_members_v1(v_trip_id, v_uids, p_actor);

  -- Transition eligible orders to EN_ENTREGA atomically. Order stop state stays
  -- authoritative in ordenes.estado/hora_entrega -- never duplicated in trip_members.
  UPDATE public.ordenes
     SET estado = 'EN_ENTREGA', hora_salida = (extract(epoch FROM now()) * 1000)::bigint
   WHERE order_uid = ANY (v_uids) AND estado = 'LISTO';

  -- DRIVER_STATO COMPATIBILITY PROJECTION ONLY -- derived from the canonical facts
  -- just created, never independently authoritative (D-1). Legacy readers/writers
  -- (rider_collect_and_complete_stop, close_rider_trip, Cocina/Entregas dashboards)
  -- keep working unmodified against this row during the W6 compatibility window.
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

-- 5. Restore public.rider_collect_and_complete_stop to its pre-135 body, verbatim ------------
CREATE OR REPLACE FUNCTION public.rider_collect_and_complete_stop(
  p_order_id text, p_metodo_pago text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_by       public.auth_actors%ROWTYPE;
  v_ds       jsonb;
  v_active   jsonb;
  v_estado   text;
  v_updated  int;
  v_method   text;
  v_meta     jsonb;
  v_pay      jsonb := NULL;
  v_pay_note text := NULL;
BEGIN
  v_method := lower(btrim(COALESCE(p_metodo_pago, '')));

  -- Only real door-collection methods. Anything else (notably the operator override
  -- "manual", or an empty string for an already-prepaid order) means NO money is claimed:
  -- the stop still completes, but nothing is written to the ledger and no flag is invented.
  IF v_method <> '' AND v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_METHOD_INVALID');
  END IF;

  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- IDENTITY. Role must be exactly 'rider' — this contract never serves admin/operator,
  -- and never lets a rider borrow their authority.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  IF v_active IS NULL OR jsonb_typeof(v_active) <> 'object' OR (v_active->>'status') <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  -- ASSIGNMENT. The order must belong to the currently active delivery. Membership is the
  -- rider's authority to collect on it; without this any rider could pay off any order.
  IF NOT (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
  END IF;

  SELECT estado INTO v_estado FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Server-forced provenance. The client cannot claim a different source.
  v_meta := COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', 'rider_delivery');

  IF v_estado = 'RETIRADO' THEN
    -- Operative replay. The collection may still need reconciling: a rider whose first
    -- request completed the stop but died before the money was recorded must be able to
    -- retry. The deterministic key makes an honest retry a digest-identical replay.
    IF v_method <> '' THEN
      BEGIN
        v_pay := public._ledger_write_payment(
          p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
        v_pay_note := SQLERRM;
        IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
        END IF;
      END;
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id,
                              'payment', v_pay, 'payment_note', v_pay_note);
  END IF;

  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  -- MONEY FIRST. A refusal here returns before the stop is completed, and the subtransaction
  -- has already rolled the attempted payment back: nothing half-written either way.
  -- AUTH_LEGACY_IMPORT_REQUIRED is the single tolerated refusal — that money is already on
  -- record in the pre-ledger representation, and re-recording it would double-count.
  IF v_method <> '' THEN
    BEGIN
      v_pay := public._ledger_write_payment(
        p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
      v_pay_note := SQLERRM;
      IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
      END IF;
    END;
  END IF;

  -- OPERATIVE completion ONLY. cobrado / metodo_pago are deliberately absent here:
  -- RETIRADO does not mean paid, and _ledger_write_payment is the sole writer of those
  -- columns. A prepaid or unpaid-on-delivery stop completes with the flags untouched.
  UPDATE public.ordenes
    SET estado       = 'RETIRADO',
        hora_entrega = (extract(epoch FROM now()) * 1000)::bigint
  WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Lost the race after taking the money: ABORT so the recorded payment cannot survive
    -- a stop that did not complete. Must RAISE, never RETURN.
    RAISE EXCEPTION 'RIDER_STOP_LOST_RACE' USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id,
                            'payment', v_pay, 'payment_note', v_pay_note);
END;
$fn$;

-- 6. Restore public.close_rider_trip to its pre-135 body, verbatim ----------------------------
CREATE OR REPLACE FUNCTION public.close_rider_trip(p_trigger_order_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ds        jsonb;
  v_active    jsonb;
  v_order_ids      text[];
  v_pending        int;
  v_raw_count      int;
  v_distinct_count int;
  v_snapshot_count int;
  v_found          int;
  v_now       timestamptz := now();
  v_closed    jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  IF v_active IS NOT NULL AND jsonb_typeof(v_active) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' THEN
    IF v_ds ? 'last_closed_trip' AND (v_ds->'last_closed_trip') <> 'null'::jsonb THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT',
                                'snapshot', v_ds->'last_closed_trip');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  IF p_trigger_order_id IS NOT NULL AND NOT (v_active->'order_ids' ? p_trigger_order_id) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NON_MEMBER_NOOP');
  END IF;

  IF jsonb_typeof(v_active->'order_ids') <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  SELECT count(*), count(DISTINCT value::text)
    INTO v_raw_count, v_distinct_count
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  v_snapshot_count := CASE
    WHEN COALESCE(v_active->>'n_orders', '') ~ '^[0-9]+$' THEN (v_active->>'n_orders')::int
    ELSE -1
  END;

  IF v_raw_count <> v_distinct_count OR v_snapshot_count <> v_raw_count THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  SELECT array_agg(DISTINCT value::text) INTO v_order_ids
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  SELECT count(*) INTO v_found FROM public.ordenes WHERE id = ANY(v_order_ids);
  IF v_found <> v_raw_count THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MISSING_TRIP_MEMBER');
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.ordenes
  WHERE id = ANY(v_order_ids)
    AND estado NOT IN ('RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','ANULADO');

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EARLY_CLOSE');
  END IF;

  v_closed := (v_active
    || jsonb_build_object('status', 'CLOSED', 'closed_at', to_jsonb(v_now)));

  v_ds := v_ds || jsonb_build_object(
    'stato',            'LIBERO',
    'rientro_stimato',  to_jsonb(v_now),
    'active_trip',      'null'::jsonb,
    'last_closed_trip', v_closed
  );

  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  INSERT INTO public.delivery_logs (zona, n_ordini, partito_alle, ultimo_entregado, rientro_stimato)
  VALUES (
    (v_active->'zone_sequence'->>0),
    COALESCE((v_active->>'n_orders')::int, 1),
    NULLIF(v_active->>'started_at', '')::timestamptz,
    v_now,
    v_now
  );

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_closed);
END;
$fn$;

-- 7. Drop everything migration 135 added -------------------------------------------------------
DROP FUNCTION public.trip_authority_close_active_trip_v1(uuid);
DROP FUNCTION public.trip_authority_active_trip_v1();
DROP FUNCTION trip_authority.departed_hhmm_v1(timestamptz);
DROP FUNCTION trip_authority.progress_terminal_states_v1();
DROP FUNCTION trip_authority.close_terminal_states_v1();

-- 8. Post-conditions ------------------------------------------------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.trip_authority_active_trip_v1()') IS NOT NULL
     OR to_regprocedure('public.trip_authority_close_active_trip_v1(uuid)') IS NOT NULL
     OR to_regprocedure('trip_authority.close_terminal_states_v1()') IS NOT NULL
     OR to_regprocedure('trip_authority.progress_terminal_states_v1()') IS NOT NULL
     OR to_regprocedure('trip_authority.departed_hhmm_v1(timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'W6_3_4_ROLLBACK post-condition failed: a migration-135 helper survived';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'trip_authority' AND indexname = 'trips_one_trip_per_giro_v1') THEN
    RAISE EXCEPTION 'W6_3_4_ROLLBACK post-condition failed: trips_one_trip_per_giro_v1 survived';
  END IF;
  -- Migration 134's own objects are untouched by this rollback.
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority')
     OR to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL
     OR to_regprocedure('public.trip_projection_v1(uuid[])') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'trip_authority' AND indexname = 'trips_one_active_v1') THEN
    RAISE EXCEPTION 'W6_3_4_ROLLBACK post-condition failed: a migration-134 object was removed (this rollback must never do that)';
  END IF;
  FOR v_src IN SELECT pg_get_functiondef(s::regprocedure) FROM unnest(ARRAY[
      'public.close_rider_trip(text)',
      'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)',
      'giro_authority.derive_giros_v1(text[],uuid[],jsonb)'
    ]) AS s
  LOOP
    IF v_src ILIKE '%trip_authority%' THEN
      RAISE EXCEPTION 'W6_3_4_ROLLBACK post-condition failed: a restored function still references trip_authority';
    END IF;
  END LOOP;
  v_src := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);
  IF v_src NOT LIKE '%o.estado = ''LISTO''%' OR v_src LIKE '%SERVICE_CLOSING%' THEN
    RAISE EXCEPTION 'W6_3_4_ROLLBACK post-condition failed: start_rider_trip_v2 was not restored to its migration-134 body';
  END IF;
END $$;

COMMIT;
