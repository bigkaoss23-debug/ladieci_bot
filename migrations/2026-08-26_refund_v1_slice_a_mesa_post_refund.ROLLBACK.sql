-- migrations/2026-08-26_refund_v1_slice_a_mesa_post_refund.ROLLBACK.sql
-- Reverses 2026-08-26_refund_v1_slice_a_mesa_post_refund.sql exactly.
--
-- WHAT COMES BACK IS THE DEFECT: order_refund loses the AUTH_REFUND_TRANSACTION_BACKED
-- guard and will again refund the OLDEST payment event's amount/method regardless of
-- what a Mesa transaction-backed order actually needs refunded. This is only safe to
-- run while zero rows exist with kind='refund' in payment_transactions (mesa_post_
-- refund_v1 has never been used for a real refund) -- verify that before applying.

BEGIN;

DROP FUNCTION IF EXISTS public.mesa_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb);

-- Restore auth_audit_event_chk without MESA_PAYMENT_REFUNDED. Safe only while no
-- auth_audit row carries that event -- true as long as mesa_post_refund_v1 has never
-- completed a real refund (verify before running this rollback).
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event = ANY (ARRAY[
  'login_ok'::text, 'login_fail'::text, 'locked'::text, 'pin_set'::text, 'pin_change'::text, 'revoke'::text,
  'bootstrap'::text, 'recovery'::text, 'actor_disabled'::text, 'actor_enabled'::text, 'actor_unlocked'::text,
  'user_created'::text, 'user_renamed'::text, 'role_changed'::text, 'user_deactivated'::text, 'user_reactivated'::text,
  'access_denied'::text, 'credential_cleared'::text, 'fingerprint_upgraded'::text, 'session_invalidated'::text,
  'rate_limit_triggered'::text, 'migration_login_used'::text, 'PAYMENT_REPLAY_DIFFERENT_ACTOR'::text,
  'PAYMENT_DUPLICATE_CONFIRMED'::text
]));

-- Restore order_refund to its pre-2026-08-26 body (no containment guard).
CREATE OR REPLACE FUNCTION public.order_refund(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- N-6 — financial ownership must be provable before any money is touched.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    SELECT * INTO v_basis FROM public.order_financial_events
      WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
        AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
      ORDER BY created_at ASC LIMIT 1;
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
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_NO_PAYMENT_BASIS' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing_refund FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund'
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
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
END;
$function$;

REVOKE ALL ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text) TO service_role;

-- Restore the two refund indexes to their pre-2026-08-26 predicates (WITHOUT
-- payment_transaction_id IS NULL).
DROP INDEX IF EXISTS public.order_financial_events_one_refund_session_uq;
CREATE UNIQUE INDEX order_financial_events_one_refund_session_uq
  ON public.order_financial_events USING btree (service_session_id, order_id)
  WHERE ((service_session_id IS NOT NULL) AND (type = 'refund'::text));

DROP INDEX IF EXISTS public.order_financial_events_one_refund_legacy_uq;
CREATE UNIQUE INDEX order_financial_events_one_refund_legacy_uq
  ON public.order_financial_events USING btree (order_id)
  WHERE ((service_session_id IS NULL) AND (type = 'refund'::text));

COMMIT;
