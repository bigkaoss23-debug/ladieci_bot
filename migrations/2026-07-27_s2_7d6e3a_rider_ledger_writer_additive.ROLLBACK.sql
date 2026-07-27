-- ROLLBACK for 2026-07-27_s2_7d6e2_rider_delivery_collection.sql
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- Restores the pre-S2-7D6E2 shape: order_mark_paid inlines its own accounting again, the
-- ledger-less complete_rider_stop(text, boolean, text) comes back, and the rider contract
-- plus the shared writer are dropped.
--
-- REFUSES if any rider-recorded payment already exists. Those events were written by a
-- 'rider' by_role, which the restored order_mark_paid can neither produce nor replay:
-- rolling back over them would strand rows whose digest no live function can reproduce.
-- Reconcile or reverse them deliberately first.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.order_financial_events
              WHERE type = 'payment' AND by_role = 'rider')
  THEN RAISE EXCEPTION 'ROLLBACK REFUSED: rider-recorded payments exist — reconcile them before reverting'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text);

-- order_mark_paid restored VERBATIM from 2026-07-19_b7_payment_basis_historical_replay_fix.sql.
CREATE OR REPLACE FUNCTION public.order_mark_paid(
  p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    IF v_existing.type <> 'payment'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM false
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_existing.amount, 'payment_method', v_method, 'legacy', false))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment', v_amount, v_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method
   WHERE id = p_order_id;

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$fn$;

DROP FUNCTION IF EXISTS public._ledger_write_payment(text, text, text, text, text, text, jsonb, text);

-- complete_rider_stop restored VERBATIM from
-- 2026-07-21_fix_rider_trip_json_null_idempotency.sql (ledger-less, cobrado-writing).
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
