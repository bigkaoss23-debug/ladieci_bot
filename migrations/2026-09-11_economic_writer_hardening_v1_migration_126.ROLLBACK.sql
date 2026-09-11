-- migrations/2026-09-11_economic_writer_hardening_v1_migration_126.ROLLBACK.sql
-- Reverses 2026-09-11_economic_writer_hardening_v1_migration_126.sql exactly, and ONLY
-- that. Restores every touched function to its EXACT pre-M126 body (reproduced verbatim
-- from the live catalog read before M126 was authored, in the same session), drops the
-- new E-1 trigger/function, re-creates complete_rider_stop byte-for-byte as it stood
-- before F-6's DROP (including its pre-M126 grants), and restores anon/authenticated
-- EXECUTE on order_has_economic_evidence_v1.
--
-- ROLLBACK_RESTORES_UNFENCED_LEGACY_WRITERS. Running this file removes E-1/E-2/Patch B/the
-- cancelled-payment defense and un-retires order_mark_paid/order_void -- i.e. it restores
-- the exact set of gaps ECONOMIC_WRITER_UNIFICATION_LEGACY_RETIREMENT_AUDIT_V1.md
-- documents. This is exact reversibility of migration history, not a recommendation.
--
-- No table/column/index change in either direction. No DML in either direction.

BEGIN;

-- ── PRE-CONDITION: refuse unless the current state is exactly what M126 forward
-- installed -- never revert an unknown or already-reverted state. ─────────────
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_economic_basis_lock_v1') THEN
    RAISE EXCEPTION 'M126 ROLLBACK refused: order_economic_basis_lock_v1 is missing -- M126 was never applied, or already rolled back';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'complete_rider_stop') THEN
    RAISE EXCEPTION 'M126 ROLLBACK refused: complete_rider_stop already exists -- not at the expected M126 epoch';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = '_ledger_write_payment' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%LEGACY_COLLECTION_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK refused: _ledger_write_payment does not carry the E-2 fence -- not at the expected M126 epoch'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_mark_paid' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%LEGACY_OPERATOR_COLLECTION_RETIRED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK refused: order_mark_paid is not the M126 retirement stub -- not at the expected M126 epoch'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_void' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%LEGACY_VOID_RETIRED_USE_ORDER_CANCEL%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK refused: order_void is not the M126 retirement stub -- not at the expected M126 epoch'; END IF;

  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 125) THEN
      RAISE EXCEPTION 'M126 ROLLBACK refused: ladieci_schema_migrations has no apply_order=125 row';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 126) THEN
      RAISE EXCEPTION 'M126 ROLLBACK refused: ladieci_schema_migrations already has an apply_order=126 row -- roll back the ledger entry first';
    END IF;
  END IF;

  PERFORM set_config('ladieci.m126rb_public_fn_count',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'), false);
  PERFORM set_config('ladieci.m126rb_ordenes_trigger_count',
    (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND NOT tgisinternal), false);
  PERFORM set_config('ladieci.m126rb_ordenes_row_count', (SELECT count(*)::text FROM public.ordenes), false);
  PERFORM set_config('ladieci.m126rb_obligations_row_count', (SELECT count(*)::text FROM public.order_obligations), false);
  PERFORM set_config('ladieci.m126rb_payment_tx_row_count', (SELECT count(*)::text FROM public.payment_transactions), false);
  PERFORM set_config('ladieci.m126rb_ofe_row_count', (SELECT count(*)::text FROM public.order_financial_events), false);
END $guard$;

-- ── E-1 REVERSAL: drop the trigger, then the function ────────────────────────
DROP TRIGGER IF EXISTS ordenes_order_economic_basis_lock_v1 ON public.ordenes;
DROP FUNCTION IF EXISTS public.order_economic_basis_lock_v1();

-- ── E-2 REVERSAL: _ledger_write_payment restored to its exact pre-M126 body ──
CREATE OR REPLACE FUNCTION public._ledger_write_payment(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_by_role text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text := p_by_role; v_method text; v_reason text; v_amount numeric(10,2);
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

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;

  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_role IS NULL OR btrim(v_role) = '' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Same-scope replay is based on immutable event snapshots, not mutable order fields.
  -- Scoped by service_session_id (IS NOT DISTINCT FROM handles the legacy NULL-session
  -- case) to match the partitioned unique indexes from 2026-07-26_two_service_identity.sql
  -- (order_financial_events_one_payment_session_uq / _legacy_uq): an order id/number
  -- recycled into a LATER service session must never match an EARLIER session's event.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
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

  -- SERVER-DERIVED amount. No caller — Node, rider or operator — can supply or override it.
  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  -- Key order and value types are byte-significant: the digest is sha256 over the jsonb
  -- text. Reproduced EXACTLY as in 2026-07-19_b7_payment_basis_historical_replay_fix.sql.
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  -- Same session-scoping as the replay check above: one basis per order PER SESSION, so a
  -- recycled order id/number starts a fresh basis in a later session instead of colliding
  -- with a since-archived one.
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
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
$function$;

-- ── RETIREMENT STUBS REVERSAL: order_mark_paid, order_void restored ──────────
CREATE OR REPLACE FUNCTION public.order_mark_paid(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_role text; v_method text;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
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

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  -- Generic payment authority: admin/operator ONLY. A rider never reaches this function;
  -- it has its own narrower contract (rider_collect_and_complete_stop).
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  RETURN public._ledger_write_payment(
    p_order_id, v_method, p_reason, p_by_actor, v_role, p_ip_hash, v_meta, p_idem_scope_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.order_void(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'void' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
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
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY CASE WHEN type = 'refund' THEN 1 ELSE 2 END, created_at ASC LIMIT 1;
  IF FOUND AND v_pay_event.type = 'refund' THEN v_pay_state := 'refunded';
  ELSIF FOUND THEN v_pay_state := 'paid';
  ELSE v_pay_state := 'unpaid'; END IF;
  IF v_ord.estado NOT IN ('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'AUTH_VOID_STATE_FORBIDDEN' USING ERRCODE='22023'; END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', 'ANULADO',
    'prev_pay_state', v_pay_state, 'new_pay_state', v_pay_state,
    'amount', 0, 'payment_method', NULL, 'original_giro_id', v_ord.manual_giro_id, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'void', 0, NULL, v_reason, false, p_by_actor, v_role,
    v_ord.estado, 'ANULADO', v_pay_state, v_pay_state, v_ord.manual_giro_id,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  PERFORM public.order_obligation_apply_adjustment_v1(
    v_ord.order_uid, 0, 'order_cancellation', v_reason, p_by_actor, v_role,
    'voidadj-' || replace(v_ord.order_uid::text, '-', ''), v_digest, NULL);
  UPDATE public.ordenes SET estado = 'ANULADO', cancelado_at = v_now WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

-- ── IMPORT / REFUND MESA FENCE REVERSAL ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_import_legacy_payment(p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- N-6 — financial ownership must be provable before any historical money is imported.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;

  -- Same-scope replay is based on immutable event snapshots plus current request amount/method/reason.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment_imported' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'payment_imported'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM true
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_amount, 'payment_method', v_method, 'legacy', true))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', true);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF NOT (v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE) THEN
    RAISE EXCEPTION 'AUTH_NOT_LEGACY_PAID' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment_imported', v_amount, v_method, v_reason, true, p_by_actor, v_role,
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
$function$;

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
  -- REFUND V1 §J.1 — refuse, never delegate. order_refund has no amount parameter
  -- and no way to name a transaction, so delegating to mesa_post_refund_v1 would
  -- mean GUESSING which payment and how much — the exact defect this closes.
  -- Keyed on transaction-backed EVIDENCE, not on table_session_id: a non-Mesa order
  -- can never carry a payment_transaction_id, so this changes nothing for legacy
  -- non-Mesa orders.
  IF EXISTS (SELECT 1 FROM public.order_financial_events e
              WHERE e.order_id = p_order_id
                AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
                AND e.payment_transaction_id IS NOT NULL)
  THEN RAISE EXCEPTION 'AUTH_REFUND_TRANSACTION_BACKED' USING ERRCODE='22023',
    DETAIL = format('order_id=%s settled through payment_transactions -- use mesa_post_refund_v1', p_order_id);
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

-- ── PATCH B REVERSAL: mesa_post_payment_v1 restored (no early ordenes lock) ──
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_covers_settled integer DEFAULT NULL::integer, p_line_ids uuid[] DEFAULT NULL::uuid[], p_meta jsonb DEFAULT '{}'::jsonb, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE; v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE; v_tx public.payment_transactions%ROWTYPE;
  v_line record; v_order record; v_total_cents bigint; v_paid_cents bigint; v_outstanding_cents bigint;
  v_amount_cents bigint; v_to_allocate_cents bigint; v_line_remaining_cents bigint; v_allocation_cents bigint;
  v_remaining_covers integer; v_covers_settled integer; v_selected_count integer; v_selected_distinct integer;
  v_selected_matched integer; v_scope text; v_prev_state text; v_new_state text; v_order_total_cents bigint;
  v_order_paid_before_cents bigint; v_order_allocation_cents bigint; v_table_remaining_cents bigint;
  v_order_caps jsonb := '{}'::jsonb; v_order_cap_cents bigint; v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_duplicate_candidate boolean; v_receipt_service_id uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_payment_method NOT IN ('efectivo','tarjeta','bizum')
     OR p_mode NOT IN ('full','equal_split','item_selection','custom_amount')
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'MESA_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESA_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','legacy_operator')
  THEN RAISE EXCEPTION 'MESA_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled);
  END IF;
  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NULL THEN RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(round(sum(
      CASE WHEN EXISTS (SELECT 1 FROM public.order_obligations ob WHERE ob.order_uid = o.order_uid)
                OR EXISTS (SELECT 1 FROM public.table_order_lines l
                            WHERE l.table_session_id = v_session.id AND l.order_id = o.id)
           THEN public.order_canonical_obligation_v1(o.order_uid)
           ELSE 0::numeric END) * 100), 0)::bigint
    INTO v_total_cents
    FROM public.ordenes o
   WHERE o.table_session_id = v_session.id AND o.order_uid IS NOT NULL;
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'MESA_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;
  SELECT v_session.covers_total - COALESCE(sum(
    CASE WHEN kind='payment' THEN covers_settled ELSE -covers_settled END
  ), 0)::integer INTO v_remaining_covers
    FROM public.payment_transactions WHERE table_session_id = v_session.id;
  v_remaining_covers := GREATEST(0, v_remaining_covers);
  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents; v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED');
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023'; END IF;
    SELECT COALESCE(sum(remaining_cents),0)::bigint INTO v_amount_cents FROM (
      SELECT GREATEST(0,
        round(l.net_amount * 100)::bigint - COALESCE(sum(
          CASE WHEN t.kind='refund' THEN -round(a.amount * 100)::bigint ELSE round(a.amount * 100)::bigint END
        ),0)
      ) AS remaining_cents
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
      LEFT JOIN public.payment_allocations a ON a.table_order_line_id = l.id
      LEFT JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
      WHERE l.table_session_id = v_session.id AND l.id = ANY(p_line_ids)
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
      GROUP BY l.id, l.net_amount
    ) selected;
    IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'MESA_LINE_SELECTION_SETTLED' USING ERRCODE='55000'; END IF;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  END IF;
  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents
     OR v_covers_settled < 0 OR v_covers_settled > v_remaining_covers
  THEN RAISE EXCEPTION 'MESA_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount_cents = v_outstanding_cents THEN v_covers_settled := v_remaining_covers; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions pt
     WHERE pt.table_session_id = v_session.id
       AND pt.client_request_id <> p_client_request_id
       AND pt.kind = 'payment' AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0) AND pt.payment_method = p_payment_method
       AND pt.covers_settled = v_covers_settled
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;
  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'MESA_POSSIBLE_DUPLICATE_PAYMENT' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('PAYMENT_DUPLICATE_CONFIRMED', NULL, p_by_actor,
      jsonb_build_object('tableSessionId', v_session.id, 'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0, 'mode', p_mode, 'paymentMethod', p_payment_method,
        'coversSettled', v_covers_settled));
  END IF;
  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;
  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_receipt_service_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, v_covers_settled,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;
  v_to_allocate_cents := v_amount_cents;
  FOR v_line IN
    SELECT l.id, l.order_id, l.net_amount, o.order_uid,
      GREATEST(0, round(l.net_amount * 100)::bigint - COALESCE((
        SELECT sum(CASE WHEN t.kind='refund' THEN -round(a.amount*100)::bigint ELSE round(a.amount*100)::bigint END)
          FROM public.payment_allocations a
          JOIN public.payment_transactions t ON t.id=a.payment_transaction_id
         WHERE a.table_order_line_id=l.id
      ),0)) AS remaining_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
    WHERE l.table_session_id = v_session.id
      AND (p_mode <> 'item_selection' OR l.id = ANY(p_line_ids))
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_allocate_cents <= 0;
    v_line_remaining_cents := v_line.remaining_cents;
    IF v_line_remaining_cents <= 0 THEN CONTINUE; END IF;
    IF NOT (v_order_caps ? v_line.order_id) THEN
      v_order_cap_cents := GREATEST(0,
        round(public.order_canonical_obligation_v1(v_line.order_uid) * 100)::bigint
        - COALESCE((
            SELECT sum(CASE WHEN t.kind='refund' THEN -round(a.amount*100)::bigint
                            ELSE round(a.amount*100)::bigint END)
              FROM public.payment_allocations a
              JOIN public.payment_transactions t ON t.id=a.payment_transaction_id
             WHERE a.order_id = v_line.order_id AND t.table_session_id = v_session.id
          ), 0));
      v_order_caps := v_order_caps || jsonb_build_object(v_line.order_id, v_order_cap_cents);
    END IF;
    v_order_cap_cents := (v_order_caps->>v_line.order_id)::bigint;
    IF v_order_cap_cents <= 0 THEN CONTINUE; END IF;
    v_allocation_cents := LEAST(v_to_allocate_cents, v_line_remaining_cents, v_order_cap_cents);
    IF v_allocation_cents <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_tx.id, v_line.id, v_line.order_id, v_allocation_cents / 100.0, v_now);
    v_to_allocate_cents := v_to_allocate_cents - v_allocation_cents;
    v_order_caps := jsonb_set(v_order_caps, ARRAY[v_line.order_id],
                              to_jsonb(v_order_cap_cents - v_allocation_cents));
  END LOOP;
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents,
      o.service_session_id AS obligation_service_session_id, o.order_uid
      FROM public.payment_allocations a
      JOIN public.ordenes o ON o.id = a.order_id AND o.table_session_id = v_session.id
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id, o.service_session_id, o.order_uid ORDER BY a.order_id
  LOOP
    v_order_total_cents := round(public.order_canonical_obligation_v1(v_order.order_uid) * 100)::bigint;
    SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100),0)::bigint
      INTO v_order_paid_before_cents
      FROM public.order_financial_events e
     WHERE e.service_session_id=v_order.obligation_service_session_id AND e.order_id=v_order.order_id
       AND e.type IN ('payment','payment_imported','refund');
    v_order_allocation_cents := v_order.allocated_cents;
    v_prev_state := CASE
      WHEN v_order_paid_before_cents <= 0 THEN 'unpaid'
      WHEN v_order_paid_before_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_new_state := CASE
      WHEN v_order_paid_before_cents + v_order_allocation_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_scope := 'mesa_' || replace(v_tx.id::text, '-', '');
    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      event_service_session_id, payment_transaction_id, created_at
    )
    SELECT o.id, 'payment', v_order_allocation_cents / 100.0, p_payment_method,
      NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','mesa','mode',p_mode,'transaction_id',v_tx.id),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_tx.id::text, v_order_allocation_cents::text,
        p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_receipt_service_id, v_tx.id, v_now
    FROM public.ordenes o WHERE o.id=v_order.order_id AND o.table_session_id=v_session.id;
  END LOOP;
  UPDATE public.ordenes o SET
    cobrado = calc.is_paid, ya_pagado = calc.is_paid,
    metodo_pago = CASE WHEN calc.is_paid THEN calc.method_projection ELSE COALESCE(o.metodo_pago,'') END
  FROM (
    SELECT src.id AS order_id,
      CASE WHEN src.obligation_cents <= 0 THEN src.collected_cents > 0
           ELSE src.collected_cents >= src.obligation_cents END AS is_paid,
      CASE WHEN src.method_count > 1 THEN 'MIXTO' ELSE src.method_max END AS method_projection
    FROM (
      SELECT o2.id,
        round(public.order_canonical_obligation_v1(o2.order_uid) * 100)::bigint AS obligation_cents,
        COALESCE((SELECT round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100)
                    FROM public.order_financial_events e
                   WHERE e.service_session_id=o2.service_session_id AND e.order_id=o2.id
                     AND e.type IN ('payment','payment_imported','refund')),0)::bigint AS collected_cents,
        (SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
          WHERE e.service_session_id=o2.service_session_id AND e.order_id=o2.id
            AND e.type IN ('payment','payment_imported')) AS method_count,
        (SELECT max(e.payment_method) FROM public.order_financial_events e
          WHERE e.service_session_id=o2.service_session_id AND e.order_id=o2.id
            AND e.type IN ('payment','payment_imported')) AS method_max
      FROM public.ordenes o2
      WHERE o2.table_session_id = v_session.id AND o2.order_uid IS NOT NULL
    ) src
  ) calc
  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;
  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;
  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    'overCollected', GREATEST(0, (v_paid_cents + v_amount_cents - v_total_cents)) / 100.0,
    'tableStatus', 'open'
  );
END
$function$;

-- ── CANCELLED-ORDER DEFENSE REVERSAL: order_post_payment_v1 restored ─────────
CREATE OR REPLACE FUNCTION public.order_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_order_uid uuid, p_payment_method text, p_mode text, p_amount numeric, p_client_request_id text, p_request_hash text, p_meta jsonb, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_entity public.order_entities%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_tx public.payment_transactions%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_obligation_cents bigint;
  v_paid_before_cents bigint;
  v_outstanding_cents bigint;
  v_amount_cents bigint;
  v_receipt_service_id uuid;
  v_duplicate_candidate boolean;
  v_prev_state text;
  v_new_state text;
  v_new_paid_cents bigint;
  v_scope text;
  v_method_count integer;
  v_method_max text;
  v_is_paid boolean;
  v_method_projection text;
BEGIN
  IF p_workspace_id IS NULL OR p_order_uid IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_payment_method NOT IN ('efectivo','tarjeta','bizum')
     OR p_mode NOT IN ('full','custom_amount')
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'ORDER_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- Preserve the existing Servicio payment gate exactly (order_mark_paid):
  -- admin/operator ONLY. Do NOT widen to Mesa's broader PAYMENT_ROLES
  -- (owner/cashier/legacy_operator) -- an authorization change this slice
  -- does not own (frozen brief §25).
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','operator')
  THEN RAISE EXCEPTION 'ORDER_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method, 'mode', v_existing.mode,
      'orderUid', p_order_uid);
  END IF;

  -- The permanent identity anchor -- resolves workspace/service/display id
  -- without trusting the client. A Mesa order's entity carries a non-null
  -- table_session_id; refuse it here so a table order can never bypass
  -- mesa_post_payment_v1's covers/line authority through this route.
  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_entity.workspace_id <> p_workspace_id THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;
  IF v_entity.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE='22023',
      DETAIL = format('order_uid=%s table_session=%s', p_order_uid, v_entity.table_session_id);
  END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  v_obligation_cents := round(public.order_canonical_obligation_v1(p_order_uid) * 100)::bigint;
  SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100), 0)::bigint
    INTO v_paid_before_cents
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund');
  v_outstanding_cents := GREATEST(0, v_obligation_cents - v_paid_before_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'ORDER_PAYMENT_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;

  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents;
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
  END IF;
  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions pt
    JOIN public.payment_allocations pa ON pa.payment_transaction_id = pt.id
     WHERE pa.order_uid = p_order_uid
       AND pt.client_request_id <> p_client_request_id
       AND pt.kind = 'payment' AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0) AND pt.payment_method = p_payment_method
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;
  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_POSSIBLE_DUPLICATE' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('PAYMENT_DUPLICATE_CONFIRMED', NULL, p_by_actor,
      jsonb_build_object('orderUid', p_order_uid, 'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0, 'mode', p_mode, 'paymentMethod', p_payment_method));
  END IF;

  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;
  IF v_receipt_service_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000'; END IF;

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, 0,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;

  -- ONE allocation, order_uid-targeted -- the check-centric invariant (§8/§11/
  -- §28 of the brief): one payment_transactions row = one physical money
  -- movement; for a check, that movement is imputed to exactly one order.
  INSERT INTO public.payment_allocations(
    payment_transaction_id, table_order_line_id, order_id, order_uid, amount, created_at
  ) VALUES (v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now);

  v_new_paid_cents := v_paid_before_cents + v_amount_cents;
  v_prev_state := CASE
    WHEN v_paid_before_cents <= 0 THEN 'unpaid'
    WHEN v_paid_before_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_new_state := CASE
    WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_scope := 'order_' || replace(v_tx.id::text, '-', '');

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
    event_service_session_id, payment_transaction_id, created_at
  )
  SELECT o.id, 'payment', v_amount_cents / 100.0, p_payment_method,
    NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
    v_prev_state, v_new_state, NULL, NULL,
    jsonb_build_object('source','order','mode',p_mode,'transaction_id',v_tx.id),
    v_scope,
    encode(digest(concat_ws('|', o.id, v_tx.id::text, v_amount_cents::text,
      p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
    o.service_session_id, v_receipt_service_id, v_tx.id, v_now
  FROM public.ordenes o WHERE o.order_uid = p_order_uid;

  -- Same compatibility-mirror projection mesa_post_payment_v1 uses (§12 of
  -- the brief): 'MIXTO' on mixed tender, computed from order_financial_events
  -- so a legacy event-only collection is never lost from the projection.
  SELECT count(DISTINCT e.payment_method), max(e.payment_method)
    INTO v_method_count, v_method_max
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported');
  v_is_paid := CASE WHEN v_obligation_cents <= 0 THEN v_new_paid_cents > 0
                     ELSE v_new_paid_cents >= v_obligation_cents END;
  v_method_projection := CASE WHEN v_method_count > 1 THEN 'MIXTO' ELSE v_method_max END;

  UPDATE public.ordenes SET
    cobrado = v_is_paid, ya_pagado = v_is_paid,
    metodo_pago = CASE WHEN v_is_paid THEN v_method_projection ELSE COALESCE(metodo_pago,'') END
  WHERE order_uid = p_order_uid;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'orderUid', p_order_uid, 'displayOrderId', v_entity.display_order_id,
    'currentObligation', v_obligation_cents / 100.0,
    'netCollectedBefore', v_paid_before_cents / 100.0,
    'netCollectedAfter', v_new_paid_cents / 100.0,
    'unpaid', GREATEST(0, v_obligation_cents - v_new_paid_cents) / 100.0,
    'overCollected', GREATEST(0, v_new_paid_cents - v_obligation_cents) / 100.0,
    'serviceSessionId', v_receipt_service_id
  );
END;
$function$;

-- ── F-6 REVERSAL: recreate complete_rider_stop byte-for-byte ─────────────────
CREATE FUNCTION public.complete_rider_stop(p_order_id text, p_cobrado boolean, p_metodo_pago text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

REVOKE EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text) TO service_role;

-- ── PRIVILEGE HYGIENE REVERSAL: restore anon/authenticated EXECUTE ───────────
GRANT EXECUTE ON FUNCTION public.order_has_economic_evidence_v1(text) TO anon, authenticated;

-- ── POST-CONDITION ────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'order_economic_basis_lock_v1') THEN
    RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_economic_basis_lock_v1 still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
              AND NOT tgisinternal AND tgname = 'ordenes_order_economic_basis_lock_v1') THEN
    RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: the E-1 trigger still exists';
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE proname = '_ledger_write_payment' AND pronamespace = 'public'::regnamespace)
       LIKE '%LEGACY_COLLECTION_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: _ledger_write_payment still carries the E-2 fence'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_mark_paid' AND pronamespace = 'public'::regnamespace)
       LIKE '%LEGACY_OPERATOR_COLLECTION_RETIRED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_mark_paid is still the retirement stub'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_void' AND pronamespace = 'public'::regnamespace)
       LIKE '%LEGACY_VOID_RETIRED_USE_ORDER_CANCEL%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_void is still the retirement stub'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_import_legacy_payment' AND pronamespace = 'public'::regnamespace)
       LIKE '%AUTH_MESA_ORDER_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_import_legacy_payment still carries the Mesa fence'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_refund' AND pronamespace = 'public'::regnamespace)
       LIKE '%AUTH_MESA_ORDER_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_refund still carries the Mesa fence'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'mesa_post_payment_v1' AND pronamespace = 'public'::regnamespace)
       LIKE '%PATCH B%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: mesa_post_payment_v1 still carries the Patch B lock'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_post_payment_v1' AND pronamespace = 'public'::regnamespace)
       LIKE '%ORDER_PAYMENT_ORDER_CANCELLED%'
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_post_payment_v1 still carries the cancelled-order defense'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'complete_rider_stop') THEN
    RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: complete_rider_stop was not restored';
  END IF;
  IF has_function_privilege('anon', 'public.complete_rider_stop(text,boolean,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.complete_rider_stop(text,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: complete_rider_stop must not grant anon/authenticated EXECUTE';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.complete_rider_stop(text,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: service_role lost EXECUTE on complete_rider_stop';
  END IF;

  IF NOT has_function_privilege('anon', 'public.order_has_economic_evidence_v1(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.order_has_economic_evidence_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: anon/authenticated EXECUTE on order_has_economic_evidence_v1 was not restored';
  END IF;

  IF (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
     IS DISTINCT FROM current_setting('ladieci.m126rb_public_fn_count', true)
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: public schema function count changed (expected net zero)'; END IF;

  IF (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND NOT tgisinternal)
     IS DISTINCT FROM (current_setting('ladieci.m126rb_ordenes_trigger_count', true)::int - 1)::text
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: ordenes trigger count did not decrease by exactly 1'; END IF;

  IF (SELECT count(*)::text FROM public.ordenes) IS DISTINCT FROM current_setting('ladieci.m126rb_ordenes_row_count', true)
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: ordenes row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.order_obligations) IS DISTINCT FROM current_setting('ladieci.m126rb_obligations_row_count', true)
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_obligations row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.payment_transactions) IS DISTINCT FROM current_setting('ladieci.m126rb_payment_tx_row_count', true)
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: payment_transactions row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.order_financial_events) IS DISTINCT FROM current_setting('ladieci.m126rb_ofe_row_count', true)
  THEN RAISE EXCEPTION 'M126 ROLLBACK post-condition failed: order_financial_events row count changed'; END IF;
END $post$;

COMMIT;
