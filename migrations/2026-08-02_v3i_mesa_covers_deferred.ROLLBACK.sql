-- V3-I rollback: restores mandatory covers-at-open. Schema-only revert, refused
-- while any Mesa is currently mid-open with covers not yet registered (that state
-- cannot be expressed once covers_total is NOT NULL again).
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.table_sessions WHERE status = 'open' AND covers_total IS NULL
  ) THEN
    RAISE EXCEPTION 'V3-I rollback refused: a Mesa is open with covers not yet set -- resolve it first';
  END IF;
END $$;

DROP TRIGGER IF EXISTS table_sessions_guard_covers_monotonic_v1 ON public.table_sessions;
DROP FUNCTION IF EXISTS public.messa_guard_covers_monotonic_v1();
DROP FUNCTION IF EXISTS public.messa_release_empty_session_v1(uuid,text,uuid);

-- Restore the exact V3-H open-session body (covers mandatory at open again).
-- CREATE OR REPLACE cannot remove a parameter default (Postgres 42P13), and the
-- V3-I/V3-J-era signature has "p_covers_total integer DEFAULT NULL" -- an
-- explicit drop is required before recreating the no-default V3-H signature.
DROP FUNCTION IF EXISTS public.messa_open_session_v1(uuid,text,uuid,uuid,integer);

CREATE FUNCTION public.messa_open_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_id uuid,
  p_service_session_id uuid,
  p_covers_total integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_service public.service_sessions%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_table_id IS NULL OR p_service_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99
  THEN RAISE EXCEPTION 'MESSA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_ACTOR_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  IF v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator') THEN
    RAISE EXCEPTION 'MESSA_OPEN_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_service FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND OR v_service.status <> 'open' THEN
    RAISE EXCEPTION 'MESSA_SERVICE_NOT_OPEN' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.table_sessions
   WHERE workspace_id = p_workspace_id AND table_id = p_table_id
     AND status = 'open'
   ORDER BY id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'MESSA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505';
  END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.table_sessions(
    workspace_id, table_id, service_session_id, table_ref, status,
    covers_total, assigned_waiter_actor, created_by, updated_by
  ) VALUES (
    p_workspace_id, p_table_id, p_service_session_id, v_table.display_name, 'open',
    p_covers_total, CASE WHEN v_actor.role='waiter' THEN p_by_actor ELSE NULL END,
    p_by_actor, p_by_actor
  ) RETURNING * INTO v_session;

  IF v_actor.role='waiter' THEN
    INSERT INTO public.table_session_assignment_history(
      workspace_id, table_session_id, previous_waiter_actor, new_waiter_actor,
      by_actor, action, created_at
    ) VALUES (
      p_workspace_id, v_session.id, NULL, p_by_actor, p_by_actor, 'assigned', now()
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', v_session.id,
    'tableId', v_session.table_id,
    'tableNumber', v_table.table_number,
    'displayName', v_table.display_name,
    'coversTotal', v_session.covers_total,
    'status', v_session.status,
    'openedAt', v_session.opened_at
  );
END
$fn$;

-- The DROP above clears prior grants (CREATE OR REPLACE would have preserved
-- them; a real DROP + CREATE does not) -- restore the same service-role-only
-- grant every other Mesa RPC uses.
REVOKE ALL ON FUNCTION public.messa_open_session_v1(uuid,text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.messa_open_session_v1(uuid,text,uuid,uuid,integer) TO service_role;

-- Restore the exact V3-H order-preparation body (no covers side effect).
CREATE OR REPLACE FUNCTION public.messa_prepare_table_order_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_source_line_id uuid;
  v_raw_id text;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = NEW.table_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_session.table_id FOR SHARE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  IF jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
    RAISE EXCEPTION 'MESSA_ITEMS_REQUIRED' USING ERRCODE='22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.items)
  LOOP
    v_raw_id := v_item ->> 'lineId';
    BEGIN
      v_source_line_id := CASE WHEN v_raw_id IS NULL THEN gen_random_uuid() ELSE v_raw_id::uuid END;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'MESSA_LINE_ID_INVALID' USING ERRCODE='22023';
    END;
    v_items := v_items || jsonb_build_array(
      jsonb_set(v_item, '{lineId}', to_jsonb(v_source_line_id::text), true)
    );
  END LOOP;

  NEW.items := v_items;
  NEW.service_session_id := v_session.service_session_id;
  NEW.table_number_snapshot := v_table.table_number;
  NEW.table_name_snapshot := v_table.display_name;
  NEW.table_command_number := v_session.next_command_number;
  NEW.canal := 'BANCO';
  NEW.tipo_consegna := 'RITIRO';
  NEW.delivery_fee := 0;

  UPDATE public.table_sessions
     SET next_command_number = next_command_number + 1,
         updated_at = now()
   WHERE id = v_session.id;

  RETURN NEW;
END
$fn$;

ALTER TABLE public.ordenes DROP COLUMN IF EXISTS table_covers_total_input;

ALTER TABLE public.table_sessions DROP CONSTRAINT IF EXISTS table_sessions_covers_total_chk;
ALTER TABLE public.table_sessions
  ADD CONSTRAINT table_sessions_covers_total_chk CHECK (covers_total BETWEEN 1 AND 99);
ALTER TABLE public.table_sessions ALTER COLUMN covers_total SET NOT NULL;

-- Restore the exact V3-H payment body (no covers-not-set guard). Kept in the
-- V3-H.1A search_path shape since that migration is applied ahead of this one.
CREATE OR REPLACE FUNCTION public.messa_post_payment_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_by_sid_hash text,
  p_table_session_id uuid,
  p_payment_method text,
  p_mode text,
  p_client_request_id text,
  p_request_hash text,
  p_amount numeric DEFAULT NULL,
  p_covers_settled integer DEFAULT NULL,
  p_line_ids uuid[] DEFAULT NULL,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
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
  THEN RAISE EXCEPTION 'MESSA_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESSA_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','legacy_operator')
  THEN RAISE EXCEPTION 'MESSA_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor
     AND by_sid_hash = p_by_sid_hash AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESSA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled
    );
  END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'MESSA_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;

  SELECT v_session.covers_total - COALESCE(sum(
    CASE WHEN kind='payment' THEN covers_settled ELSE -covers_settled END
  ), 0)::integer INTO v_remaining_covers
    FROM public.payment_transactions WHERE table_session_id = v_session.id;
  v_remaining_covers := GREATEST(0, v_remaining_covers);

  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents;
    v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESSA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESSA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
    END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESSA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
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
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')
      GROUP BY l.id, l.net_amount
    ) selected;
    IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'MESSA_LINE_SELECTION_SETTLED' USING ERRCODE='55000'; END IF;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  END IF;

  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents
     OR v_covers_settled < 0 OR v_covers_settled > v_remaining_covers
  THEN RAISE EXCEPTION 'MESSA_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount_cents = v_outstanding_cents THEN v_covers_settled := v_remaining_covers; END IF;

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_session.service_session_id, 'payment', p_mode,
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
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')
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
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESSA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents
      FROM public.payment_allocations a
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id ORDER BY a.order_id
  LOOP
    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents
      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;
    SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100),0)::bigint
      INTO v_order_paid_before_cents
      FROM public.order_financial_events e
     WHERE e.service_session_id=v_session.service_session_id AND e.order_id=v_order.order_id
       AND e.type IN ('payment','payment_imported','refund');
    v_order_allocation_cents := v_order.allocated_cents;
    v_prev_state := CASE
      WHEN v_order_paid_before_cents <= 0 THEN 'unpaid'
      WHEN v_order_paid_before_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_new_state := CASE
      WHEN v_order_paid_before_cents + v_order_allocation_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_scope := 'messa_' || replace(v_tx.id::text, '-', '');

    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      payment_transaction_id, created_at
    )
    SELECT o.id, 'payment', v_order_allocation_cents / 100.0, p_payment_method,
      NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','messa','mode',p_mode,'transaction_id',v_tx.id),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_tx.id::text, v_order_allocation_cents::text,
        p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_tx.id, v_now
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
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported','refund')
      ),0) AS is_paid,
      CASE WHEN (
        SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) > 1 THEN 'MIXTO' ELSE (
        SELECT max(e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) END AS method_projection
    FROM public.table_order_lines l WHERE l.table_session_id=v_session.id GROUP BY l.order_id
  ) calc
  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;

  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;
  IF v_table_remaining_cents = 0 THEN
    UPDATE public.table_sessions SET
      status='closed', settled_at=v_now, closed_at=v_now,
      updated_at=v_now, updated_by=p_by_actor
    WHERE id=v_session.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    'tableStatus', CASE WHEN v_table_remaining_cents=0 THEN 'free' ELSE 'open' END
  );
END
$fn$;

COMMIT;
