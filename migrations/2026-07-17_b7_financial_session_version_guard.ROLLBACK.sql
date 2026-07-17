-- migrations/2026-07-17_b7_financial_session_version_guard.ROLLBACK.sql
-- Guarded rollback of the B7A2D atomic session-version guard.  ***STAGING ONLY***
-- (tdikhfeinufaahagmpjz).
--
-- *** SECURITY DOWNGRADE — READ THIS ***
-- Executing this rollback DROPS the guarded financial RPCs and RESTORES the previous
-- UNGUARDED signatures (no p_session_version). That REMOVES the atomic session-revocation
-- enforcement: a token revoked between the HTTP middleware preflight and the RPC actor lock
-- could again win a financial mutation. Do NOT run this except under a deliberate, reviewed
-- rollback decision.
--
-- Fail-closed by default: refuses unless the operator has EXPLICITLY opted in for THIS
-- session with:
--     SET ladieci.confirm_b7a2d_downgrade = 'I_UNDERSTAND_SESSION_DOWNGRADE';
-- so the downgrade cannot occur accidentally. The rollback NEVER deletes/rewrites financial
-- events, NEVER modifies orders, NEVER changes actor session_version, NEVER alters ledger
-- grants/RLS, and NEVER touches PIN hashes. The restored order_void keeps the canonical-zero
-- replay fix. Do NOT run in tests. Do NOT execute in this phase.
BEGIN;

DO $$
BEGIN
  IF coalesce(current_setting('ladieci.confirm_b7a2d_downgrade', true), '') <> 'I_UNDERSTAND_SESSION_DOWNGRADE' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: session-version guard downgrade not confirmed. Set ladieci.confirm_b7a2d_downgrade to proceed (weakens revocation enforcement).';
  END IF;
  IF to_regclass('public.order_financial_events') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: order_financial_events missing — unexpected state.';
  END IF;
END $$;

-- drop the guarded signatures
REVOKE ALL ON FUNCTION public.order_mark_paid(text, text, text, text, integer, text, jsonb, text)                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text)                                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_void(text, text, text, integer, text, jsonb, text)                                      FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.order_mark_paid(text, text, text, text, integer, text, jsonb, text);
DROP FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text);
DROP FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text);
DROP FUNCTION public.order_void(text, text, text, integer, text, jsonb, text);

-- restore UNGUARDED order_mark_paid (pre-B7A2D)
CREATE FUNCTION public.order_mark_paid(
  p_order_id text, p_payment_method text, p_reason text, p_by_actor text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE; v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_canon jsonb; v_digest text;
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
  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    IF v_existing.payload_digest = v_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported') ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023'; END IF;
  IF v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE THEN RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE='22023'; END IF;
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment', v_amount, v_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END; $fn$;

-- restore UNGUARDED order_import_legacy_payment (pre-B7A2D)
CREATE FUNCTION public.order_import_legacy_payment(
  p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE; v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_canon jsonb; v_digest text;
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
  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  v_amount := round(p_amount, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_confirm IS DISTINCT FROM 'IMPORT_LEGACY_PAYMENT' THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', true);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment_imported' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    IF v_existing.payload_digest = v_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported') ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023'; END IF;
  IF NOT (v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE) THEN RAISE EXCEPTION 'AUTH_NOT_LEGACY_PAID' USING ERRCODE='22023'; END IF;
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment_imported', v_amount, v_method, v_reason, true, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END; $fn$;

-- restore UNGUARDED order_refund (pre-B7A2D)
CREATE FUNCTION public.order_refund(
  p_order_id text, p_reason text, p_by_actor text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_basis public.order_financial_events%ROWTYPE; v_existing public.order_financial_events%ROWTYPE;
  v_existing_refund public.order_financial_events%ROWTYPE; v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
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
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    SELECT * INTO v_basis FROM public.order_financial_events
      WHERE order_id = p_order_id AND type IN ('payment','payment_imported') ORDER BY created_at ASC LIMIT 1;
    IF NOT FOUND OR v_basis.amount IS DISTINCT FROM v_existing.amount
       OR v_basis.payment_method IS DISTINCT FROM v_existing.payment_method
    THEN RAISE EXCEPTION 'AUTH_REFUND_BASIS_INTEGRITY' USING ERRCODE='22023'; END IF;
    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', v_existing.order_id, 'type', 'refund', 'idem_scope_key', v_existing.idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'basis_event_id', v_basis.id, 'amount', v_existing.amount,
      'payment_method', v_existing.payment_method, 'legacy', v_existing.legacy))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'original_giro_id', v_existing.original_giro_id,
        'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported') ORDER BY created_at ASC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_NO_PAYMENT_BASIS' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing_refund FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund' ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'AUTH_ALREADY_REFUNDED' USING ERRCODE='22023'; END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'refund', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'paid', 'new_pay_state', 'refunded',
    'basis_event_id', v_basis.id, 'amount', v_basis.amount,
    'payment_method', v_basis.payment_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'refund', v_basis.amount, v_basis.payment_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'paid', 'refunded', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET refunded = true WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END; $fn$;

-- restore UNGUARDED order_void (pre-B7A2D; canonical-zero replay fix PRESERVED)
CREATE FUNCTION public.order_void(
  p_order_id text, p_reason text, p_by_actor text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE; v_pay_event public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_pay_state text; v_canon jsonb; v_digest text; v_replay_digest text; v_now timestamptz := now();
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
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'void' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    IF v_existing.type <> 'void' OR v_existing.amount <> 0 OR v_existing.payment_method IS NOT NULL
       OR v_existing.legacy IS DISTINCT FROM false OR v_existing.new_estado <> 'ANULADO'
       OR v_existing.prev_pay_state IS DISTINCT FROM v_existing.new_pay_state
    THEN RAISE EXCEPTION 'AUTH_VOID_REPLAY_INTEGRITY' USING ERRCODE='22023'; END IF;
    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', 0, 'payment_method', NULL,
      'original_giro_id', v_existing.original_giro_id, 'legacy', false))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'original_giro_id', v_existing.original_giro_id,
        'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_pay_event FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('refund','payment','payment_imported')
    ORDER BY CASE WHEN type = 'refund' THEN 1 ELSE 2 END, created_at ASC LIMIT 1;
  IF FOUND AND v_pay_event.type = 'refund' THEN v_pay_state := 'refunded';
  ELSIF FOUND THEN v_pay_state := 'paid';
  ELSE v_pay_state := 'unpaid'; END IF;
  IF v_ord.estado NOT IN ('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'AUTH_VOID_STATE_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', 'ANULADO',
    'prev_pay_state', v_pay_state, 'new_pay_state', v_pay_state,
    'amount', 0, 'payment_method', NULL, 'original_giro_id', v_ord.manual_giro_id,
    'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'void', 0, NULL, v_reason, false, p_by_actor, v_role,
    v_ord.estado, 'ANULADO', v_pay_state, v_pay_state, v_ord.manual_giro_id,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET estado = 'ANULADO', cancelado_at = v_now WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END; $fn$;

-- restore grants (service_role only; owner retains)
REVOKE ALL ON FUNCTION public.order_mark_paid(text, text, text, text, text, jsonb, text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_refund(text, text, text, text, jsonb, text)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_void(text, text, text, text, jsonb, text)                                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_mark_paid(text, text, text, text, text, jsonb, text)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, text, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_refund(text, text, text, text, jsonb, text)                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.order_void(text, text, text, text, jsonb, text)                                      TO service_role;

COMMIT;
