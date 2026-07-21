-- S2-2E: normalize JSON null to SQL NULL in the three vulnerable rider RPCs.

BEGIN;

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
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  IF v_active IS NULL OR jsonb_typeof(v_active) <> 'object' OR (v_active->>'status') <> 'ACTIVE' THEN
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

CREATE OR REPLACE FUNCTION public.close_rider_trip(p_trigger_order_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.end_service_close(p_close_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds     jsonb;
  v_marker jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  INSERT INTO public.config(chiave, valore) VALUES ('DRIVER_STATO', '{}') ON CONFLICT (chiave) DO NOTHING;
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_marker := NULLIF(v_ds->'service_closing', 'null'::jsonb);
  IF v_marker IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT');
  END IF;
  IF jsonb_typeof(v_marker) <> 'object'
     OR COALESCE(v_marker->>'close_id', '') <> COALESCE(p_close_id, '') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_CLOSE_ID_MISMATCH');
  END IF;
  v_ds := v_ds - 'service_closing';
  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';
  RETURN jsonb_build_object('ok', true, 'code', 'OK');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.close_rider_trip(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_rider_trip(text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.end_service_close(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_service_close(text) TO service_role;

COMMIT;

