-- S2-2D: preserve the accepted close_rider_trip contract while writing native
-- timestamptz values to public.delivery_logs. The original S2-2B migration is immutable.

BEGIN;

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
  v_active := v_ds->'active_trip';

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

REVOKE EXECUTE ON FUNCTION public.close_rider_trip(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_rider_trip(text) TO service_role;

COMMIT;
