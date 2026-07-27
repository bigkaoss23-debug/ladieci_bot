-- ROLLBACK for 2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql (S2-7D6E3 FASE D)
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- Restores the ledger-less complete_rider_stop(text, boolean, text) VERBATIM from
-- 2026-07-21_fix_rider_trip_json_null_idempotency.sql. This is a genuine step backward
-- (the restored function is the one S2-7D6E3 exists to retire) — only use this to recover
-- from a FASE D applied in error, not as a routine operation. If FASE B has already
-- deployed (backend calling rider_collect_and_complete_stop exclusively), restoring the
-- old function does not undo that — the backend simply never calls it again.
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
AS $fn$
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
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text) TO service_role;

COMMIT;
