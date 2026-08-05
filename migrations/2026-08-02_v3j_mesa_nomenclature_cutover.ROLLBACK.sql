-- Rollback for V3-J (mesa_* nomenclature cutover). Restores every messa_*
-- function/trigger/error-code exactly as V3-H/V3-H.1A/V3-H.2/V3-I left them,
-- then drops the mesa_* names. Schema-only revert; no data is touched, so this
-- is safe to run even while Mesa accounts are open (unlike the V3-I rollback,
-- which is schema-shape-refused while covers are still NULL).
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'V3-J rollback refused: mesa_* contract not found -- was V3-J actually applied?';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- 1) Recreate every messa_* function, byte-identical to its V3-I state
-- ══════════════════════════════════════════════════════════════════════════

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
  v_covers_total integer;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = NEW.table_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  v_covers_total := v_session.covers_total;
  IF v_covers_total IS NULL THEN
    IF NEW.table_covers_total_input IS NULL
       OR NEW.table_covers_total_input NOT BETWEEN 1 AND 99
    THEN RAISE EXCEPTION 'MESSA_COVERS_REQUIRED' USING ERRCODE='22023'; END IF;
    v_covers_total := NEW.table_covers_total_input;
  END IF;
  NEW.table_covers_total_input := NULL;

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
     SET covers_total = v_covers_total,
         next_command_number = next_command_number + 1,
         updated_at = now()
   WHERE id = v_session.id;

  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_snapshot_order_lines_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
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
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  FOR v_item, v_line_index IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(NEW.items) WITH ORDINALITY
  LOOP
    v_quantity := COALESCE((v_item ->> 'quantity')::integer, (v_item ->> 'q')::integer, 1);
    v_unit_gross_cents := round(COALESCE(
      (v_item ->> 'finalUnitPrice')::numeric,
      (v_item ->> 'p')::numeric
    ) * 100)::bigint;
    IF v_quantity < 1 OR v_unit_gross_cents < 0 THEN
      RAISE EXCEPTION 'MESSA_ITEM_SNAPSHOT_INVALID' USING ERRCODE='22023';
    END IF;
    v_total_units := v_total_units + v_quantity;
    v_total_gross_cents := v_total_gross_cents + (v_quantity * v_unit_gross_cents);
  END LOOP;

  v_net_total_cents := round(COALESCE(NEW.totale, 0) * 100)::bigint;
  IF v_total_units < 1 OR v_total_gross_cents <= 0 OR v_net_total_cents < 0
     OR v_net_total_cents > v_total_gross_cents THEN
    RAISE EXCEPTION 'MESSA_ORDER_TOTAL_INVALID' USING ERRCODE='22023';
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
$fn$;

CREATE OR REPLACE FUNCTION public.messa_append_only_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'MESSA_APPEND_ONLY' USING ERRCODE='55000';
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_open_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_id uuid,
  p_service_session_id uuid,
  p_covers_total integer DEFAULT NULL
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
     OR (p_covers_total IS NOT NULL AND p_covers_total NOT BETWEEN 1 AND 99)
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

  BEGIN
    INSERT INTO public.table_sessions(
      workspace_id, table_id, service_session_id, table_ref, status,
      covers_total, assigned_waiter_actor, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_id, p_service_session_id, v_table.display_name, 'open',
      p_covers_total, CASE WHEN v_actor.role='waiter' THEN p_by_actor ELSE NULL END,
      p_by_actor, p_by_actor
    ) RETURNING * INTO v_session;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MESSA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505';
  END;

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

CREATE OR REPLACE FUNCTION public.messa_save_table_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_id uuid,
  p_table_number integer,
  p_display_name text,
  p_capacity integer,
  p_position_x numeric,
  p_position_y numeric,
  p_shape text,
  p_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
BEGIN
  IF p_table_number IS NULL OR p_table_number NOT BETWEEN 1 AND 999 OR p_display_name IS NULL
     OR btrim(p_display_name) = '' OR length(p_display_name) > 80
     OR p_position_x IS NULL OR p_position_x NOT BETWEEN 0 AND 100
     OR p_position_y IS NULL OR p_position_y NOT BETWEEN 0 AND 100
     OR p_shape NOT IN ('round','square','rectangle')
     OR (p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 1 AND 99)
     OR p_active IS NULL
  THEN RAISE EXCEPTION 'MESSA_TABLE_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'MESSA_LAYOUT_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  IF p_table_id IS NULL THEN
    INSERT INTO public.restaurant_tables(
      workspace_id, table_number, display_name, capacity, position_x, position_y,
      shape, active, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_number, btrim(p_display_name), p_capacity,
      p_position_x, p_position_y, p_shape, p_active, p_by_actor, p_by_actor
    ) RETURNING * INTO v_table;
  ELSE
    PERFORM 1 FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND table_id = p_table_id
       AND status = 'open'
     ORDER BY id FOR UPDATE;
    SELECT * INTO v_table FROM public.restaurant_tables
     WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_TABLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF p_active IS FALSE AND EXISTS (
      SELECT 1 FROM public.table_sessions
       WHERE workspace_id = p_workspace_id AND table_id = p_table_id AND status = 'open'
    ) THEN
      RAISE EXCEPTION 'MESSA_TABLE_NOT_RELEASED' USING ERRCODE='55000';
    END IF;
    UPDATE public.restaurant_tables
       SET table_number = p_table_number, display_name = btrim(p_display_name),
           capacity = p_capacity, position_x = p_position_x, position_y = p_position_y,
           shape = p_shape, active = p_active, updated_at = now(), updated_by = p_by_actor
     WHERE id = p_table_id RETURNING * INTO v_table;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_table.id, 'tableNumber', v_table.table_number,
    'displayName', v_table.display_name, 'capacity', v_table.capacity,
    'positionX', v_table.position_x, 'positionY', v_table.position_y,
    'shape', v_table.shape, 'active', v_table.active
  );
END
$fn$;

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
  IF v_session.covers_total IS NULL THEN
    RAISE EXCEPTION 'MESSA_COVERS_NOT_SET' USING ERRCODE='55000';
  END IF;

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

CREATE OR REPLACE FUNCTION public.messa_release_empty_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
  THEN RAISE EXCEPTION 'MESSA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'MESSA_OPEN_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NOT NULL THEN
    RAISE EXCEPTION 'MESSA_TABLE_HAS_ORDERS' USING ERRCODE='55000';
  END IF;

  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_session.id;

  RETURN jsonb_build_object('ok', true, 'tableId', v_session.table_id, 'status', 'closed');
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_guard_covers_monotonic_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.covers_total IS NOT NULL AND (
    NEW.covers_total IS NULL OR NEW.covers_total < OLD.covers_total
  ) THEN
    RAISE EXCEPTION 'MESSA_COVERS_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_save_reservation_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_reservation_id uuid,
  p_table_id uuid,
  p_guest_name text,
  p_guest_phone text,
  p_covers_total integer,
  p_reserved_local_date text,
  p_reserved_local_time text,
  p_note text,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_reservation public.table_reservations%ROWTYPE;
  v_reserved_at timestamptz;
  v_date date;
  v_time time;
  v_guest_name text := btrim(COALESCE(p_guest_name,''));
  v_guest_phone text := NULLIF(btrim(COALESCE(p_guest_phone,'')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note,'')), '');
BEGIN
  IF p_workspace_id IS NULL OR p_table_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR v_guest_name = '' OR length(v_guest_name) > 120
     OR v_guest_name ~ '[[:cntrl:]]'
     OR (v_guest_phone IS NOT NULL AND (length(v_guest_phone) > 40 OR v_guest_phone ~ '[[:cntrl:]]'))
     OR p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99
     OR p_reserved_local_date IS NULL OR p_reserved_local_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR p_reserved_local_time IS NULL OR p_reserved_local_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR (v_note IS NOT NULL AND length(v_note) > 1000)
     OR (p_reservation_id IS NULL AND p_expected_version IS NOT NULL)
     OR (p_reservation_id IS NOT NULL AND (p_expected_version IS NULL OR p_expected_version < 1))
  THEN RAISE EXCEPTION 'MESSA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  BEGIN
    v_date := p_reserved_local_date::date;
    v_time := p_reserved_local_time::time;
    IF to_char(v_date, 'YYYY-MM-DD') <> p_reserved_local_date
       OR to_char(v_time, 'HH24:MI') <> p_reserved_local_time
    THEN RAISE EXCEPTION 'invalid local timestamp'; END IF;
    v_reserved_at := (v_date + v_time) AT TIME ZONE 'Europe/Madrid';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_TIME_INVALID' USING ERRCODE='22023';
  END;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','waiter','shift_manager','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESSA_RESERVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;

  IF p_reservation_id IS NOT NULL THEN
    SELECT * INTO v_reservation FROM public.table_reservations
     WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_reservation.status <> 'booked' THEN
      RAISE EXCEPTION 'MESSA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
    END IF;
    IF v_reservation.version <> p_expected_version THEN
      RAISE EXCEPTION 'MESSA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
  END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  IF v_table.capacity IS NOT NULL AND p_covers_total > v_table.capacity THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_CAPACITY_EXCEEDED' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_reservations r
     WHERE r.workspace_id = p_workspace_id AND r.table_id = p_table_id
       AND r.status IN ('booked','seated')
       AND (p_reservation_id IS NULL OR r.id <> p_reservation_id)
       AND r.reserved_at < v_reserved_at + interval '120 minutes'
       AND r.reserved_at + make_interval(mins => r.duration_minutes) > v_reserved_at
  ) THEN RAISE EXCEPTION 'MESSA_RESERVATION_OVERLAP' USING ERRCODE='23P01'; END IF;

  IF p_reservation_id IS NULL THEN
    INSERT INTO public.table_reservations(
      workspace_id, table_id, status, guest_name, guest_phone, covers_total,
      reserved_at, duration_minutes, note, version, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_id, 'booked', v_guest_name, v_guest_phone,
      p_covers_total, v_reserved_at, 120, v_note, 1, p_by_actor, p_by_actor
    ) RETURNING * INTO v_reservation;
  ELSE
    UPDATE public.table_reservations SET
      table_id = p_table_id,
      guest_name = v_guest_name,
      guest_phone = v_guest_phone,
      covers_total = p_covers_total,
      reserved_at = v_reserved_at,
      note = v_note,
      version = version + 1,
      updated_at = now(),
      updated_by = p_by_actor
    WHERE id = p_reservation_id RETURNING * INTO v_reservation;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'reservationId', v_reservation.id, 'version', v_reservation.version,
    'status', v_reservation.status, 'tableId', v_reservation.table_id,
    'tableNumber', v_table.table_number, 'guestName', v_reservation.guest_name,
    'guestPhone', v_reservation.guest_phone, 'coversTotal', v_reservation.covers_total,
    'reservedAt', v_reservation.reserved_at, 'durationMinutes', v_reservation.duration_minutes,
    'note', v_reservation.note
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_set_reservation_status_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_reservation_id uuid,
  p_expected_version integer,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_reservation public.table_reservations%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_reservation_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_status NOT IN ('cancelled','no_show')
  THEN RAISE EXCEPTION 'MESSA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','waiter','shift_manager','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESSA_RESERVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_reservation FROM public.table_reservations
   WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_reservation.status <> 'booked' THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
  END IF;
  IF v_reservation.version <> p_expected_version THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
  END IF;

  UPDATE public.table_reservations SET
    status = p_status,
    version = version + 1,
    updated_at = v_now,
    updated_by = p_by_actor,
    cancelled_at = CASE WHEN p_status = 'cancelled' THEN v_now ELSE NULL END,
    no_show_at = CASE WHEN p_status = 'no_show' THEN v_now ELSE NULL END
  WHERE id = p_reservation_id RETURNING * INTO v_reservation;

  RETURN jsonb_build_object(
    'ok', true, 'reservationId', v_reservation.id,
    'version', v_reservation.version, 'status', v_reservation.status
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_open_reservation_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_reservation_id uuid,
  p_expected_version integer,
  p_service_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_reservation public.table_reservations%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_service public.service_sessions%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_reservation_id IS NULL OR p_service_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_expected_version IS NULL OR p_expected_version < 1
  THEN RAISE EXCEPTION 'MESSA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESSA_OPEN_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_service FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND OR v_service.status <> 'open' THEN
    RAISE EXCEPTION 'MESSA_SERVICE_NOT_OPEN' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_reservation FROM public.table_reservations
   WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_reservation.status <> 'booked' THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
  END IF;
  IF v_reservation.version <> p_expected_version THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
  END IF;

  PERFORM 1 FROM public.table_sessions
   WHERE workspace_id = p_workspace_id AND table_id = v_reservation.table_id
     AND status = 'open'
   ORDER BY id FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'MESSA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505'; END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_reservation.table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  INSERT INTO public.table_sessions(
    workspace_id, table_id, service_session_id, table_ref, status,
    covers_total, assigned_waiter_actor, created_by, updated_by
  ) VALUES (
    p_workspace_id, v_table.id, p_service_session_id, v_table.display_name, 'open',
    v_reservation.covers_total, CASE WHEN v_actor.role='waiter' THEN p_by_actor ELSE NULL END,
    p_by_actor, p_by_actor
  ) RETURNING * INTO v_session;

  IF v_actor.role='waiter' THEN
    INSERT INTO public.table_session_assignment_history(
      workspace_id, table_session_id, previous_waiter_actor, new_waiter_actor,
      by_actor, action, created_at
    ) VALUES (
      p_workspace_id, v_session.id, NULL, p_by_actor, p_by_actor, 'assigned', v_now
    );
  END IF;

  UPDATE public.table_reservations SET
    status = 'seated', table_session_id = v_session.id, seated_at = v_now,
    version = version + 1, updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_reservation.id RETURNING * INTO v_reservation;

  RETURN jsonb_build_object(
    'ok', true, 'sessionId', v_session.id, 'reservationId', v_reservation.id,
    'reservationVersion', v_reservation.version, 'tableId', v_table.id,
    'tableNumber', v_table.table_number, 'displayName', v_table.display_name,
    'coversTotal', v_session.covers_total, 'status', v_session.status,
    'openedAt', v_session.opened_at
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_complete_reservation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    UPDATE public.table_reservations SET
      status = 'completed', completed_at = COALESCE(NEW.settled_at, now()),
      version = version + 1, updated_at = COALESCE(NEW.settled_at, now()),
      updated_by = COALESCE(NEW.updated_by, updated_by)
    WHERE table_session_id = NEW.id AND status = 'seated';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_guard_reserved_table_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.active IS TRUE AND NEW.active IS FALSE AND EXISTS (
    SELECT 1 FROM public.table_reservations r
     WHERE r.table_id = OLD.id AND r.workspace_id = OLD.workspace_id
       AND r.status = 'booked' AND r.reserved_at >= now()
  ) THEN
    RAISE EXCEPTION 'MESSA_TABLE_HAS_RESERVATIONS' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.begin_service_session_close(
  p_closed_by text,
  p_source text DEFAULT 'backend'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;
  IF v_state.current_session_id IS NULL THEN
    IF v_state.recent_closed_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','NO_SERVICE_SESSION');
    END IF;
    SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.recent_closed_session_id;
    IF NOT FOUND OR v_session.status <> 'closed' THEN
      RETURN jsonb_build_object('ok',false,'code','INVALID_RECENT_CLOSED_SESSION');
    END IF;
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  SELECT * INTO v_session FROM public.service_sessions
   WHERE id=v_state.current_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CURRENT_SERVICE_SESSION');
  END IF;
  IF v_session.status='open' THEN
    PERFORM 1 FROM public.table_sessions
     WHERE service_session_id=v_session.id AND status = 'open'
     ORDER BY id FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','MESSA_TABLES_NOT_RELEASED');
    END IF;
    UPDATE public.service_sessions
       SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now()
     WHERE id=v_session.id;
    INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
    VALUES(v_session.id,'closing',p_closed_by,p_source);
  END IF;
  RETURN jsonb_build_object('ok',true,'code','CLOSING','session',to_jsonb(v_session));
END
$fn$;

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    IF EXISTS (
      SELECT 1
      FROM public.table_sessions t
      WHERE t.service_session_id = OLD.id
        AND t.status = 'open'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MESSA_TABLES_NOT_RELEASED';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- 2) Repoint every trigger back at its messa_* function
-- ══════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS mesa_prepare_table_order_v1 ON public.ordenes;
CREATE TRIGGER messa_prepare_table_order_v1
BEFORE INSERT ON public.ordenes
FOR EACH ROW EXECUTE FUNCTION public.messa_prepare_table_order_v1();

DROP TRIGGER IF EXISTS mesa_snapshot_order_lines_v1 ON public.ordenes;
CREATE TRIGGER messa_snapshot_order_lines_v1
AFTER INSERT ON public.ordenes
FOR EACH ROW EXECUTE FUNCTION public.messa_snapshot_order_lines_v1();

DROP TRIGGER IF EXISTS table_order_lines_append_only_v1 ON public.table_order_lines;
CREATE TRIGGER table_order_lines_append_only_v1
BEFORE UPDATE OR DELETE ON public.table_order_lines
FOR EACH ROW EXECUTE FUNCTION public.messa_append_only_v1();

DROP TRIGGER IF EXISTS payment_transactions_append_only_v1 ON public.payment_transactions;
CREATE TRIGGER payment_transactions_append_only_v1
BEFORE UPDATE OR DELETE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.messa_append_only_v1();

DROP TRIGGER IF EXISTS payment_allocations_append_only_v1 ON public.payment_allocations;
CREATE TRIGGER payment_allocations_append_only_v1
BEFORE UPDATE OR DELETE ON public.payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.messa_append_only_v1();

DROP TRIGGER IF EXISTS table_sessions_guard_covers_monotonic_v1 ON public.table_sessions;
CREATE TRIGGER table_sessions_guard_covers_monotonic_v1
BEFORE UPDATE OF covers_total ON public.table_sessions
FOR EACH ROW EXECUTE FUNCTION public.messa_guard_covers_monotonic_v1();

DROP TRIGGER IF EXISTS mesa_complete_reservation_v1 ON public.table_sessions;
CREATE TRIGGER messa_complete_reservation_v1
AFTER UPDATE OF status ON public.table_sessions
FOR EACH ROW EXECUTE FUNCTION public.messa_complete_reservation_v1();

DROP TRIGGER IF EXISTS mesa_guard_reserved_table_v1 ON public.restaurant_tables;
CREATE TRIGGER messa_guard_reserved_table_v1
BEFORE UPDATE OF active ON public.restaurant_tables
FOR EACH ROW EXECUTE FUNCTION public.messa_guard_reserved_table_v1();

-- ══════════════════════════════════════════════════════════════════════════
-- 3) Drop every mesa_* function (now trigger-free)
-- ══════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.mesa_prepare_table_order_v1();
DROP FUNCTION IF EXISTS public.mesa_snapshot_order_lines_v1();
DROP FUNCTION IF EXISTS public.mesa_append_only_v1();
DROP FUNCTION IF EXISTS public.mesa_open_session_v1(uuid,text,uuid,uuid,integer);
DROP FUNCTION IF EXISTS public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean);
DROP FUNCTION IF EXISTS public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb);
DROP FUNCTION IF EXISTS public.mesa_release_empty_session_v1(uuid,text,uuid);
DROP FUNCTION IF EXISTS public.mesa_guard_covers_monotonic_v1();
DROP FUNCTION IF EXISTS public.mesa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer);
DROP FUNCTION IF EXISTS public.mesa_set_reservation_status_v1(uuid,text,uuid,integer,text);
DROP FUNCTION IF EXISTS public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid);
DROP FUNCTION IF EXISTS public.mesa_complete_reservation_v1();
DROP FUNCTION IF EXISTS public.mesa_guard_reserved_table_v1();

-- ══════════════════════════════════════════════════════════════════════════
-- 4) Restore original grants
-- ══════════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.messa_prepare_table_order_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_snapshot_order_lines_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_append_only_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_open_session_v1(uuid,text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_release_empty_session_v1(uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_guard_covers_monotonic_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_set_reservation_status_v1(uuid,text,uuid,integer,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_open_reservation_v1(uuid,text,uuid,integer,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_complete_reservation_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_guard_reserved_table_v1() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.messa_prepare_table_order_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_snapshot_order_lines_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_append_only_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_open_session_v1(uuid,text,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_release_empty_session_v1(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_guard_covers_monotonic_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_set_reservation_status_v1(uuid,text,uuid,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_open_reservation_v1(uuid,text,uuid,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_complete_reservation_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_guard_reserved_table_v1() TO service_role;

REVOKE ALL ON FUNCTION public.begin_service_session_close(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_service_session_close(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.guard_service_session_closed_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_service_session_closed_v1() TO service_role;

COMMIT;
