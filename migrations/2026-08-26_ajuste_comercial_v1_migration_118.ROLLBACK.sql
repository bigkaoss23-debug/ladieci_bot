-- migrations/2026-08-26_ajuste_comercial_v1_migration_118.ROLLBACK.sql
-- Rollback for AJUSTE COMERCIAL V1 (ledger 118).
--
-- DELIBERATELY PARTIAL, and it says so. This rollback:
--   * drops the four new functions;
--   * restores order_void / mesa_post_payment_v1 / mesa_close_session_v1 to their exact
--     pre-118 bodies (md5-asserted below -- a transcription slip aborts the rollback
--     instead of silently installing a near-miss);
--   * restores order_obligations_source_chk and auth_audit_event_chk;
--   * drops the new constraints and the idempotency index;
--   * drops the seven columns ONLY when not one row carries a value in them.
--
-- IT NEVER DELETES AN OBLIGATION REVISION. A commercial adjustment is a real economic
-- fact about what a real customer was asked to pay; deleting it to make a schema
-- revert tidy would be falsifying financial history. If adjustments exist, the columns
-- stay (with their data) and this file says so out loud. Restoring the narrow
-- source_chk while adjustment rows exist would fail the CHECK, so that revert is also
-- conditional -- by design: you cannot un-invent money facts.

BEGIN;

DROP FUNCTION IF EXISTS public.mesa_post_commercial_adjustment_v1(uuid,text,text,uuid,uuid,numeric,text,text,text,numeric,jsonb);
DROP FUNCTION IF EXISTS public.order_cancel_v1(text,text,text,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric);

-- ── restore order_void (pre-118) ──
CREATE OR REPLACE FUNCTION public.order_void(
  p_order_id text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
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
  -- N-6 — financial ownership must be provable before any pay-state is stamped.
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
END;
$fn$;

-- ── restore mesa_post_payment_v1 (pre-118: estado-filtered line-sum authority) ──
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(
  p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid,
  p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text,
  p_amount numeric, p_covers_settled integer, p_line_ids uuid[], p_meta jsonb,
  p_confirm_duplicate boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_tx public.payment_transactions%ROWTYPE;
  v_line record;
  v_order record;
  v_total_cents bigint;
  v_paid_cents bigint;
  v_outstanding_cents bigint;
  v_amount_cents bigint;
  v_to_allocate_cents bigint;
  v_line_remaining_cents bigint;
  v_allocation_cents bigint;
  v_remaining_covers integer;
  v_covers_settled integer;
  v_selected_count integer;
  v_selected_distinct integer;
  v_selected_matched integer;
  v_scope text;
  v_prev_state text;
  v_new_state text;
  v_order_total_cents bigint;
  v_order_paid_before_cents bigint;
  v_order_allocation_cents bigint;
  v_table_remaining_cents bigint;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_duplicate_candidate boolean;
  v_receipt_service_id uuid;
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
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES (
        'PAYMENT_REPLAY_DIFFERENT_ACTOR',
        v_existing.by_actor,
        p_by_actor,
        jsonb_build_object(
          'transactionId', v_existing.id,
          'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash,
          'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role
        )
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled
    );
  END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NULL THEN
    RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
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
    v_amount_cents := v_outstanding_cents;
    v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
    END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
    END IF;
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
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
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
       AND pt.kind = 'payment'
       AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0)
       AND pt.payment_method = p_payment_method
       AND pt.covers_settled = v_covers_settled
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;

  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'MESA_POSSIBLE_DUPLICATE_PAYMENT' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES (
      'PAYMENT_DUPLICATE_CONFIRMED',
      NULL,
      p_by_actor,
      jsonb_build_object(
        'tableSessionId', v_session.id,
        'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0,
        'mode', p_mode,
        'paymentMethod', p_payment_method,
        'coversSettled', v_covers_settled
      )
    );
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
    SELECT l.id, l.order_id, l.net_amount,
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
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_allocate_cents <= 0;
    v_line_remaining_cents := v_line.remaining_cents;
    IF v_line_remaining_cents <= 0 THEN CONTINUE; END IF;
    v_allocation_cents := LEAST(v_to_allocate_cents, v_line_remaining_cents);
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_tx.id, v_line.id, v_line.order_id, v_allocation_cents / 100.0, v_now);
    v_to_allocate_cents := v_to_allocate_cents - v_allocation_cents;
  END LOOP;
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents,
      o.service_session_id AS obligation_service_session_id
      FROM public.payment_allocations a
      JOIN public.ordenes o ON o.id = a.order_id
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id, o.service_session_id ORDER BY a.order_id
  LOOP
    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents
      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;
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
    cobrado = calc.is_paid,
    ya_pagado = calc.is_paid,
    metodo_pago = CASE WHEN calc.is_paid THEN calc.method_projection ELSE COALESCE(o.metodo_pago,'') END
  FROM (
    SELECT l.order_id,
      COALESCE(sum(l.net_amount),0) <= COALESCE((
        SELECT sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)
          FROM public.order_financial_events e
         WHERE e.service_session_id=l.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported','refund')
      ),0) AS is_paid,
      CASE WHEN (
        SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=l.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) > 1 THEN 'MIXTO' ELSE (
        SELECT max(e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=l.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) END AS method_projection
    FROM public.table_order_lines l WHERE l.table_session_id=v_session.id GROUP BY l.order_id, l.service_session_id
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
    'tableStatus', 'open'
  );
END
$fn$;

-- ── restore mesa_close_session_v1 (pre-118) ──
CREATE OR REPLACE FUNCTION public.mesa_close_session_v1(
  p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_total_cents bigint;
  v_paid_cents bigint;
  v_outstanding_cents bigint;
  v_now timestamptz := now();
  v_forced_count integer := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
  THEN RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- Same eligible roles as mesa_release_empty_session_v1 -- closing a table
  -- (financial safety aside) is an operational floor action, not a
  -- financial one; a waiter who has been serving the table can close it.
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'MESA_CLOSE_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Idempotent-safe, not idempotent-graceful, matching
  -- mesa_release_empty_session_v1's own established precedent: a retry
  -- after success lands here and fails closed before any mutation is
  -- possible -- no duplicate close, no duplicate audit row.
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  -- FINANCIAL SAFETY — absolute, never overridden by p_force. A table must
  -- never become free/available for new guests while money is still owed.
  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this pre-existing exclusion filter already named, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents > 0 THEN
    RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000';
  END IF;

  -- KITCHEN/ORDER COMPLETENESS — the only thing p_force overrides.
  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this pre-existing completeness check already named, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
       ))
  ) THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000';
    END IF;

    -- N-1 — explicit, operator-intentional force close. The order's OWN
    -- estado is left exactly as it genuinely is: this RPC has never had any
    -- authority to certify a kitchen outcome it never observed, and now it
    -- no longer claims one. Finalizar already classifies any order still
    -- non-terminal at that point into a service_incidents row
    -- (v3IncidentPolicy.js, table-status-agnostic) and guard_service_
    -- session_closed_v1's own V3-authorized exemption lets the service
    -- close over it -- the exact same safety net a still-open table's
    -- stranded order already relies on. Only the audit trail is written
    -- here; no row in `ordenes` is touched by this branch at all.
    WITH orphaned AS (
      SELECT o.id, o.estado AS current_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated verbatim for the same reason
         ))
       FOR UPDATE OF o
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs( -- language-guard: allow-legacy numero_ordine below is the existing orden_estado_logs column name, restated verbatim because this INSERT is byte-identical to the pre-N-1 body, not new vocabulary
        orden_id, numero_ordine, estado_from, estado_to, event_type,
        actor_type, actor_id, origin, metadata
      )
      SELECT t.id, t.id, t.current_estado, COALESCE(t.current_estado, 'EN_COCINA'), 'table_closed_forced',
        'operator', p_by_actor, 'mesa_close_session_force',
        jsonb_build_object(
          'table_session_id', v_session.id,
          'reason', 'operator_forced_close_with_pending_kitchen_work'
        )
      FROM orphaned t
      RETURNING 1
    )
    SELECT count(*) INTO v_forced_count FROM logged;
  END IF;

  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_session.id;

  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_session.table_id, 'status', 'closed',
    'forced', v_forced_count > 0, 'forcedOrderCount', v_forced_count
  );
END
$fn$;

DROP FUNCTION IF EXISTS public.order_canonical_obligation_v1(uuid);

-- ── auth_audit: restore the pre-118 literal set ──
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event = ANY (ARRAY[
  'login_ok'::text, 'login_fail'::text, 'locked'::text, 'pin_set'::text, 'pin_change'::text,
  'revoke'::text, 'bootstrap'::text, 'recovery'::text, 'actor_disabled'::text,
  'actor_enabled'::text, 'actor_unlocked'::text, 'user_created'::text, 'user_renamed'::text,
  'role_changed'::text, 'user_deactivated'::text, 'user_reactivated'::text, 'access_denied'::text,
  'credential_cleared'::text, 'fingerprint_upgraded'::text, 'session_invalidated'::text,
  'rate_limit_triggered'::text, 'migration_login_used'::text,
  'PAYMENT_REPLAY_DIFFERENT_ACTOR'::text, 'PAYMENT_DUPLICATE_CONFIRMED'::text,
  'MESA_PAYMENT_REFUNDED'::text]));

-- ── order_obligations: constraints, index, and CONDITIONALLY the columns ──
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_lazy_baseline_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_cause_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_cause_presence_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_adjustment_provenance_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_by_role_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_by_actor_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_actor_role_map_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_request_pair_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_client_request_id_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT IF EXISTS order_obligations_request_hash_chk;
DROP INDEX IF EXISTS public.order_obligations_client_request_uq;

DO $rb$
DECLARE v_adjustments bigint;
BEGIN
  SELECT count(*) INTO v_adjustments FROM public.order_obligations
   WHERE source = 'order_commercial_adjustment_v1';

  IF v_adjustments = 0 THEN
    -- Nothing was ever adjusted: the slice is fully reversible.
    ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_source_chk;
    ALTER TABLE public.order_obligations
      ADD CONSTRAINT order_obligations_source_chk
      CHECK (source = ANY (ARRAY['order_create_v1'::text, 'order_total_revision_v1'::text]));
    ALTER TABLE public.order_obligations
      DROP COLUMN cause, DROP COLUMN reason, DROP COLUMN by_actor, DROP COLUMN by_role,
      DROP COLUMN client_request_id, DROP COLUMN request_hash, DROP COLUMN materialized_lazily;
    RAISE NOTICE 'AJUSTE_118 rollback: full revert (no adjustment revision existed).';
  ELSE
    -- Real economic facts exist. They are NOT deleted and the columns that describe
    -- them are NOT dropped; source_chk keeps accepting the adjustment literal because
    -- rows that carry it are still there. This is a deliberate partial revert.
    RAISE NOTICE 'AJUSTE_118 rollback: PARTIAL. % commercial adjustment revision(s) exist; '
                 'their rows, columns and source literal are preserved. The writers are gone, '
                 'so no new adjustment can be created, but no financial history was erased.',
                 v_adjustments;
  END IF;
END $rb$;

-- ── prove the three restored bodies are byte-identical to their pre-118 text ──
DO $verify$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_void';
  IF v_md5 <> 'a19db124d4c09db12a2f09248a4b7f07' THEN
    RAISE EXCEPTION 'AJUSTE_118 rollback failed: order_void not restored byte-identically (md5 %)', v_md5;
  END IF;
  -- mesa_post_payment_v1 is the ONE restored body that is not byte-identical to its
  -- pre-118 text, and the difference is exactly four comments and nothing else.
  -- The pre-118 live body carried NO language-guard annotations on its four
  -- CHIUSO_FORZATO lines (its creating migration predates the linter), but this  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this note is explaining, not new vocabulary
  -- repository's check:domain-language refuses a newly ADDED line containing that term
  -- without one. Stripping those four comments from the text this file installs
  -- reproduces md5 ddc9d1ad3c654b4e1a639afda22132c9 -- the certified pre-118 body --
  -- exactly, which is asserted offline by tests/ajusteComercialV1.test.js so the
  -- transcription can never drift unnoticed.
  -- CONSEQUENCE, stated rather than hidden: after this rollback a future
  -- "is mesa_post_payment_v1 unchanged?" md5 check against ddc9d1ad... will report a
  -- difference. It is comment-only. Nothing executable differs.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_payment_v1';
  IF v_md5 <> '9eb6d49769a0bdbf134da8d63a2499e3' THEN
    RAISE EXCEPTION 'AJUSTE_118 rollback failed: mesa_post_payment_v1 not restored as intended (md5 %)', v_md5;
  END IF;
  -- ...and the restored body must genuinely be the PRE-118 authority again, not the
  -- obligation-aware one this migration installed.
  IF v_md5 IS NULL OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='mesa_post_payment_v1'
         AND p.prosrc ~ 'order_canonical_obligation_v1')
  THEN RAISE EXCEPTION 'AJUSTE_118 rollback failed: mesa_post_payment_v1 still reads the canonical obligation'; END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_close_session_v1';
  IF v_md5 <> '6b21ffbcee68bd55c24f376af2e69001' THEN
    RAISE EXCEPTION 'AJUSTE_118 rollback failed: mesa_close_session_v1 not restored byte-identically (md5 %)', v_md5;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname IN ('mesa_post_commercial_adjustment_v1',
                'order_cancel_v1','order_obligation_apply_adjustment_v1','order_canonical_obligation_v1'))
  THEN RAISE EXCEPTION 'AJUSTE_118 rollback failed: a new writer survived'; END IF;
END $verify$;

COMMIT;
