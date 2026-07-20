-- 2026-07-20_rider_trip_rpcs.sql
-- S2-1B: transactional rider trip primitives. Separate PostgREST calls cannot make trip
-- start/close atomic (config.valore is text, no row version, no cross-statement lock), so
-- the lifecycle lives in three SECURITY INVOKER functions, each taking one shared advisory
-- transaction lock, bootstrapping the DRIVER_STATO config row, and returning structured
-- JSON ({ok, code, snapshot?}). No PII is stored in the trip snapshot (IDs only). trip_id
-- uses gen_random_uuid() (pgcrypto). EXECUTE is granted to service_role ONLY (default
-- PUBLIC EXECUTE is revoked). NOT APPLIED IN S2-1B.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- start_rider_trip(anchor) — atomically start one trip and snapshot its members.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.start_rider_trip(p_anchor_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds        jsonb;
  v_active    jsonb;
  v_anchor    public.ordenes%ROWTYPE;
  v_giro      text;
  v_order_ids text[];
  v_zones     text[];
  v_salidas   text[];
  v_giros     text[];
  v_trip_id   text;
  v_trip_seq  int;
  v_now       timestamptz := now();
  v_snapshot  jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  INSERT INTO public.config(chiave, valore)
  VALUES ('DRIVER_STATO', '{}')
  ON CONFLICT (chiave) DO NOTHING;

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;

  v_active := v_ds->'active_trip';

  SELECT * INTO v_anchor FROM public.ordenes WHERE id = p_anchor_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF upper(COALESCE(v_anchor.tipo_consegna,'')) <> 'DOMICILIO' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  END IF;

  -- Idempotent when the anchor already belongs to the active trip (same trip, incl.
  -- a second-member Salgo tap); conflict only for a genuinely different trip start.
  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE' THEN
    IF (v_active->'order_ids' ? p_anchor_order_id)
       OR (v_active->>'anchor_order_id') = p_anchor_order_id THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'snapshot', v_active);
    ELSE
      RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT');
    END IF;
  END IF;

  v_giro := v_anchor.manual_giro_id;
  IF v_giro IS NOT NULL THEN
    SELECT array_agg(id ORDER BY ts) INTO v_order_ids
    FROM public.ordenes
    WHERE manual_giro_id = v_giro AND estado IN ('LISTO','EN_ENTREGA');
  ELSE
    v_order_ids := ARRAY[p_anchor_order_id];
  END IF;

  -- Every selected member must be a delivery order in an eligible state; else roll back.
  IF EXISTS (
    SELECT 1 FROM public.ordenes
    WHERE id = ANY(v_order_ids)
      AND (estado NOT IN ('LISTO','EN_ENTREGA') OR upper(COALESCE(tipo_consegna,'')) <> 'DOMICILIO')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.ordenes
    SET estado = 'EN_ENTREGA',
        hora_salida = (extract(epoch FROM v_now) * 1000)::bigint
  WHERE id = ANY(v_order_ids) AND estado = 'LISTO';

  SELECT array_agg(DISTINCT zona) FILTER (WHERE zona IS NOT NULL),
         array_agg(DISTINCT manual_giro_id) FILTER (WHERE manual_giro_id IS NOT NULL)
    INTO v_zones, v_giros
  FROM public.ordenes WHERE id = ANY(v_order_ids);

  IF v_giros IS NOT NULL THEN
    SELECT array_agg(DISTINCT salida_ref) FILTER (WHERE salida_ref IS NOT NULL)
      INTO v_salidas
    FROM public.manual_giros WHERE id = ANY(v_giros);
  END IF;

  v_trip_id  := gen_random_uuid()::text;
  v_trip_seq := COALESCE((v_ds->>'trip_seq')::int, 0) + 1;

  v_snapshot := jsonb_build_object(
    'trip_id',         v_trip_id,
    'anchor_order_id', p_anchor_order_id,
    'order_ids',       to_jsonb(v_order_ids),
    'manual_giro_ids', to_jsonb(COALESCE(v_giros,   ARRAY[]::text[])),
    'salida_refs',     to_jsonb(COALESCE(v_salidas, ARRAY[]::text[])),
    'zone_sequence',   to_jsonb(COALESCE(v_zones,   ARRAY[]::text[])),
    'n_orders',        COALESCE(array_length(v_order_ids,1), 0),
    'started_at',      to_jsonb(v_now),
    'closed_at',       'null'::jsonb,
    'trip_version',    1,
    'status',          'ACTIVE'
  );

  v_ds := v_ds || jsonb_build_object(
    'schema',          2,
    'stato',           'IN_GIRO',
    'zona',            to_jsonb(v_zones[1]),
    'partito_alle',    to_jsonb(v_now),
    'n_ordini',        COALESCE(array_length(v_order_ids,1), 0),
    'rientro_stimato', 'null'::jsonb,
    'trip_seq',        v_trip_seq,
    'active_trip',     v_snapshot
  );

  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_snapshot,
                            'stato', 'IN_GIRO', 'trip_seq', v_trip_seq);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- complete_rider_stop(order, cobrado, metodo_pago) — EN_ENTREGA -> RETIRADO once.
-- Writes ONLY operational metadata. Never touches pagado/ya_pagado/total/descuento/ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_rider_stop(
  p_order_id    text,
  p_cobrado     boolean,
  p_metodo_pago text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds      jsonb;
  v_active  jsonb;
  v_estado  text;
  v_updated int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  -- Membership: non-member returns NON_MEMBER (mapped to 403, no existence leak).
  IF NOT (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
  END IF;

  SELECT estado INTO v_estado FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_estado = 'RETIRADO' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id);
  END IF;
  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.ordenes
    SET estado       = 'RETIRADO',
        hora_entrega = (extract(epoch FROM now()) * 1000)::bigint,
        cobrado      = COALESCE(p_cobrado, true),
        metodo_pago  = COALESCE(p_metodo_pago, '')
  WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- lost the race to a concurrent transition
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- close_rider_trip() — verify all snapshot orders terminal, close exactly once.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.close_rider_trip()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds        jsonb;
  v_active    jsonb;
  v_order_ids text[];
  v_pending   int;
  v_now       timestamptz := now();
  v_closed    jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  -- Idempotent duplicate close: no active trip -> return last closed, write nothing.
  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' THEN
    IF v_ds ? 'last_closed_trip' AND (v_ds->'last_closed_trip') <> 'null'::jsonb THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT',
                                'snapshot', v_ds->'last_closed_trip');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  SELECT array_agg(value::text) INTO v_order_ids
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  -- Every non-cancelled snapshot order must be terminal-for-delivery.
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

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_closed);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges: PostgreSQL grants EXECUTE to PUBLIC by default — revoke, then grant
-- only to service_role (backend). Exact signatures used everywhere.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.start_rider_trip(text)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_rider_trip()                        FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_rider_trip(text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.close_rider_trip()                         TO service_role;

COMMIT;
