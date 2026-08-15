-- ROLLBACK: 2026-08-15_s2_attribution_writers_receipt_service.sql
-- Restores mesa_snapshot_order_lines_v1, mesa_post_payment_v1, and
-- service_session_assign_financial_event to their exact pre-S2 (S1) bodies,
-- drops event_service_session_id, and restores payment_transactions.
-- service_session_id's NOT NULL. Refuses if either function no longer
-- matches the expected post-S2 shape (already rolled back, or drifted
-- further since), OR if any payment_transactions row has service_session_id
-- IS NULL -- an off-service receipt would have committed under S2, and
-- restoring NOT NULL would either fail on it or (if forced) require
-- deleting real money; this rollback refuses and escalates instead.

DO $$
DECLARE
  v_snapshot_body   text;
  v_payment_body    text;
  v_event_body      text;
  v_null_receipts   integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_snapshot_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_snapshot_order_lines_v1';
  IF v_snapshot_body IS NULL OR v_snapshot_body NOT LIKE '%v_session.workspace_id, v_session.id, NEW.service_session_id, NEW.id,%' THEN
    RAISE EXCEPTION 'S2 rollback refused: mesa_snapshot_order_lines_v1 does not carry the S2 NEW.service_session_id fix -- nothing to roll back, or already rolled back';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_payment_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1'
     AND pg_get_function_identity_arguments(p.oid) =
       'p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric, p_covers_settled integer, p_line_ids uuid[], p_meta jsonb, p_confirm_duplicate boolean';
  IF v_payment_body IS NULL OR v_payment_body NOT LIKE '%v_receipt_service_id%' THEN
    RAISE EXCEPTION 'S2 rollback refused: mesa_post_payment_v1 does not carry the S2 v_receipt_service_id fix -- nothing to roll back, or already rolled back';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_event_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'service_session_assign_financial_event';
  IF v_event_body IS NULL OR v_event_body NOT LIKE '%v_candidates%' THEN
    RAISE EXCEPTION 'S2 rollback refused: service_session_assign_financial_event does not carry the S2 candidate-resolution shape -- nothing to roll back, or already rolled back';
  END IF;

  SELECT count(*) INTO v_null_receipts FROM public.payment_transactions WHERE service_session_id IS NULL;
  IF v_null_receipts > 0 THEN
    RAISE EXCEPTION 'S2 rollback refused: % payment_transactions row(s) have service_session_id IS NULL (a real off-service receipt committed under S2) -- restoring NOT NULL would require deleting real money; manual review required', v_null_receipts;
  END IF;
END $$;

-- ── A. restore mesa_snapshot_order_lines_v1 verbatim (pre-S2 shape) ─────────
CREATE OR REPLACE FUNCTION public.mesa_snapshot_order_lines_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_item jsonb;
  v_line_index integer;
  v_quantity integer;
  v_unit_index integer;
  v_total_units integer := 0;
  v_seen_units integer := 0;
  v_source_line_id uuid;
  v_description text;
  v_unit_gross_cents bigint;
  v_total_gross_cents bigint := 0;
  v_gross_remaining_cents bigint;
  v_net_total_cents bigint;
  v_net_remaining_cents bigint;
  v_unit_net_cents bigint;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions WHERE id = NEW.table_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  FOR v_item, v_line_index IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(NEW.items) WITH ORDINALITY
  LOOP
    v_quantity := COALESCE((v_item ->> 'quantity')::integer, (v_item ->> 'q')::integer, 1);
    v_unit_gross_cents := round(COALESCE(
      (v_item ->> 'finalUnitPrice')::numeric,
      (v_item ->> 'p')::numeric
    ) * 100)::bigint;
    IF v_quantity < 1 OR v_unit_gross_cents < 0 THEN
      RAISE EXCEPTION 'MESA_ITEM_SNAPSHOT_INVALID' USING ERRCODE='22023';
    END IF;
    v_total_units := v_total_units + v_quantity;
    v_total_gross_cents := v_total_gross_cents + (v_quantity * v_unit_gross_cents);
  END LOOP;

  v_net_total_cents := round(COALESCE(NEW.totale, 0) * 100)::bigint;
  IF v_total_units < 1 OR v_total_gross_cents <= 0 OR v_net_total_cents < 0
     OR v_net_total_cents > v_total_gross_cents THEN
    RAISE EXCEPTION 'MESA_ORDER_TOTAL_INVALID' USING ERRCODE='22023';
  END IF;
  v_net_remaining_cents := v_net_total_cents;
  v_gross_remaining_cents := v_total_gross_cents;

  FOR v_item, v_line_index IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(NEW.items) WITH ORDINALITY
  LOOP
    v_quantity := COALESCE((v_item ->> 'quantity')::integer, (v_item ->> 'q')::integer, 1);
    v_source_line_id := (v_item ->> 'lineId')::uuid;
    v_description := left(COALESCE(NULLIF(v_item ->> 'fantasyName',''), NULLIF(v_item ->> 'n',''), NULLIF(v_item ->> 'classicName',''), 'Producto'), 240);
    v_unit_gross_cents := round(COALESCE(
      (v_item ->> 'finalUnitPrice')::numeric,
      (v_item ->> 'p')::numeric
    ) * 100)::bigint;

    FOR v_unit_index IN 1..v_quantity
    LOOP
      v_seen_units := v_seen_units + 1;
      IF v_seen_units = v_total_units THEN
        v_unit_net_cents := v_net_remaining_cents;
      ELSE
        v_unit_net_cents := floor(
          (v_net_remaining_cents::numeric * v_unit_gross_cents::numeric) / v_gross_remaining_cents::numeric
        )::bigint;
      END IF;
      v_net_remaining_cents := v_net_remaining_cents - v_unit_net_cents;
      v_gross_remaining_cents := v_gross_remaining_cents - v_unit_gross_cents;

      INSERT INTO public.table_order_lines(
        workspace_id, table_session_id, service_session_id, order_id,
        source_line_id, source_line_index, unit_index, description,
        product_snapshot, gross_amount, discount_amount, net_amount
      ) VALUES (
        v_session.workspace_id, v_session.id, v_session.service_session_id, NEW.id,
        v_source_line_id, v_line_index, v_unit_index, v_description,
        v_item, v_unit_gross_cents / 100.0,
        (v_unit_gross_cents - v_unit_net_cents) / 100.0,
        v_unit_net_cents / 100.0
      );
    END LOOP;
  END LOOP;

  RETURN NEW;
END
$function$;

-- ── B. restore service_session_assign_financial_event verbatim (pre-S2, two-line body) ──
CREATE OR REPLACE FUNCTION public.service_session_assign_financial_event()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
BEGIN
  SELECT o.service_session_id INTO NEW.service_session_id FROM public.ordenes o WHERE o.id = NEW.order_id;
  IF NEW.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;

-- ── C. restore mesa_post_payment_v1 verbatim (pre-S2, S1's 13-arg body) ─────
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_by_sid_hash text,
  p_table_session_id uuid,
  p_payment_method text,
  p_mode text,
  p_client_request_id text,
  p_request_hash text,
  p_amount numeric DEFAULT NULL::numeric,
  p_covers_settled integer DEFAULT NULL::integer,
  p_line_ids uuid[] DEFAULT NULL::uuid[],
  p_meta jsonb DEFAULT '{}'::jsonb,
  p_confirm_duplicate boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
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
     -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal, restored verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');
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
       -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, restored verbatim for the same reason
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');
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
        -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, restored verbatim for the same reason
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')
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
      -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, restored verbatim for the same reason
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
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

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
    v_scope := 'mesa_' || replace(v_tx.id::text, '-', '');

    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      payment_transaction_id, created_at
    )
    SELECT o.id, 'payment', v_order_allocation_cents / 100.0, p_payment_method,
      NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','mesa','mode',p_mode,'transaction_id',v_tx.id),
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
$function$;

-- ── D. drop the S2 schema widening ───────────────────────────────────────────
ALTER TABLE public.order_financial_events DROP COLUMN event_service_session_id;

ALTER TABLE public.payment_transactions
  ALTER COLUMN service_session_id SET NOT NULL;
