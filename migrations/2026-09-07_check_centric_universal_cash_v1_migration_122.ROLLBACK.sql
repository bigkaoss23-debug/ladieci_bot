-- migrations/2026-09-07_check_centric_universal_cash_v1_migration_122.ROLLBACK.sql
-- Reverses 2026-09-07_check_centric_universal_cash_v1_migration_122.sql --
-- but ONLY while the window is still clean.
--
-- HARD-STOP, BY DESIGN (§27/§W of the brief): once a single legitimate
-- check-centric fact exists -- a payment_transactions row with
-- table_session_id IS NULL, or a payment_allocations row with
-- table_order_line_id IS NULL (equivalently, order_uid IS NOT NULL) --
-- this rollback REFUSES. Restoring the old NOT NULL constraints would
-- require either deleting real canonical payment facts or fabricating a
-- fake table_session_id / table_order_line_id for them, and both
-- payment_transactions and payment_allocations are append-only BY
-- TRIGGER (mesa_append_only_v1 on BEFORE UPDATE/DELETE) -- there is no
-- code path in this rollback that disables that trigger, and there must
-- never be one. A "successful" rollback past that point would only be
-- possible by destroying the exact guarantee that makes this ledger
-- credible.
--
-- Recovery ordering after that window has closed: backend first, DB
-- never, and only with an explicit owner decision and a data-preservation
-- plan -- never this file.

BEGIN;

DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.payment_transactions WHERE table_session_id IS NULL) THEN
    RAISE EXCEPTION 'M122 ROLLBACK refused: a payment_transactions row with table_session_id IS NULL exists -- canonical check-centric payment facts exist, restoring NOT NULL would destroy them';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_allocations WHERE table_order_line_id IS NULL OR order_uid IS NOT NULL) THEN
    RAISE EXCEPTION 'M122 ROLLBACK refused: a payment_allocations row with table_order_line_id IS NULL or order_uid IS NOT NULL exists -- canonical check-centric allocation facts exist, restoring NOT NULL would destroy them';
  END IF;
END $guard$;

-- Restore order_initial_payment_v1 to its pre-122 body (calls order_mark_paid,
-- sv/ip_hash based). Safe only because the guard above already proved no
-- check-centric payment (creation-time or otherwise) has ever been written.
CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := NEW.initial_payment_intent;
  v_method text;
  v_actor  text;
  v_sv     integer;
  v_ip     text;
BEGIN
  -- Defence in depth: the trigger is already WHEN-scoped to a non-null intent.
  IF v_intent IS NULL THEN
    RETURN NEW;
  END IF;

  -- Mesa settles through its own payment hub (payment_transactions /
  -- payment_allocations / mesa_post_payment_v1). A table order must never take a
  -- second, parallel payment here. The frontend already forbids it; this refuses
  -- it at the boundary rather than trusting that.
  IF NEW.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s table_session=%s', NEW.id, NEW.table_session_id);
  END IF;

  -- The whole point of N-3: legacy-paid authority must NOT precede the canonical
  -- payment. If either flag arrived true, someone is still trying to declare money
  -- with a boolean -- refuse rather than paper over it.
  IF NEW.ya_pagado IS TRUE OR NEW.cobrado IS TRUE THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s ya_pagado=%s cobrado=%s', NEW.id, NEW.ya_pagado, NEW.cobrado);
  END IF;

  v_method := lower(btrim(COALESCE(v_intent->>'method', '')));
  v_actor  := btrim(COALESCE(v_intent->>'actor', ''));
  v_sv     := NULLIF(v_intent->>'sv', '')::integer;
  v_ip     := btrim(COALESCE(v_intent->>'ip_hash', ''));

  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_METHOD_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s method=%s', NEW.id, v_method);
  END IF;
  IF v_actor = '' OR v_sv IS NULL OR v_ip = '' THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_CONTEXT_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s actor_present=%s sv_present=%s ip_present=%s',
                      NEW.id, (v_actor <> ''), (v_sv IS NOT NULL), (v_ip <> ''));
  END IF;

  -- THE canonical payment writer. Everything that matters -- authorization, the
  -- server-derived amount, the digest, replay/basis idempotency, the legacy
  -- mirrors -- happens in there, identically to the operator collection path.
  -- The idempotency key is the SAME deterministic per-order key that path uses,
  -- so a later collection on this order replays instead of charging twice.
  PERFORM public.order_mark_paid(
    NEW.id,
    v_method,
    NULL,
    v_actor,
    v_sv,
    v_ip,
    jsonb_build_object('source', 'initial_payment_at_creation'),
    'pay-order-' || regexp_replace(NEW.id, '[^A-Za-z0-9_-]', '', 'g')
  );

  -- The intent has done its one job. Clearing it here keeps the column NULL at
  -- rest; this UPDATE touches no economic column, so neither N-5's guard nor
  -- N-2's revision trigger fires.
  UPDATE public.ordenes SET initial_payment_intent = NULL WHERE id = NEW.id;

  RETURN NEW;
END;
$function$;

-- Restore mesa_post_refund_v1 to its pre-122 body (the NULL-unsafe `<>`).
-- Safe only because the guard above proved table_session_id has never been
-- NULL on any payment_transactions row.
-- PARAMETER-DEFAULT FAST-FOLLOW -- the live function has always carried
-- `p_amount numeric DEFAULT NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb`
-- on its last two parameters (this migration's forward file never removes
-- them -- see its own item-7 fast-follow comment). CREATE OR REPLACE
-- refuses to silently drop an existing default, so a rollback declaration
-- that omitted them would itself fail with the same PostgreSQL 42P13 this
-- forward-migration fast-follow fixed, the moment it ran after a
-- successful forward apply. Reproducing both DEFAULTs here is therefore
-- required for THIS statement to succeed -- it changes nothing about what
-- gets restored: the body below is untouched, and identity (types/order/
-- count) is untouched, which is why grants still carry over either way.
CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_original public.payment_transactions%ROWTYPE;
  v_refund_tx public.payment_transactions%ROWTYPE;
  v_alloc record;
  v_order record;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_reason text;
  v_remaining_cents bigint;
  v_amount_cents bigint;
  v_to_reverse_cents bigint;
  v_take_cents bigint;
  v_order_total_cents bigint;
  v_order_paid_before_cents bigint;
  v_order_allocation_cents bigint;
  v_new_paid_cents bigint;
  v_prev_state text;
  v_new_state text;
  v_scope text;
  v_settlement text;
  v_receipt_service_id uuid;
  v_table_total_cents bigint;
  v_table_paid_cents bigint;
  v_table_outstanding_cents bigint;
  v_remaining_after_cents bigint;
  v_reversed_allocations jsonb;
  v_affected_orders jsonb;
  v_order_ids jsonb;
  v_audit_id bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL OR p_original_transaction_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'MESA_REFUND_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'MESA_REFUND_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  v_reason := btrim(p_reason);

  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RAISE EXCEPTION 'MESA_REFUND_AMOUNT_INVALID' USING ERRCODE='22023';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESA_REFUND_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'MESA_REFUND_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_REFUND_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
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
    SELECT (round(pt.amount*100)::bigint - COALESCE((
        SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
         WHERE r.kind='refund' AND r.reverses_transaction_id = pt.id
      ),0)) INTO v_remaining_after_cents
      FROM public.payment_transactions pt WHERE pt.id = v_existing.reverses_transaction_id;
    SELECT jsonb_agg(jsonb_build_object('tableOrderLineId', a.table_order_line_id,
        'orderId', a.order_id, 'amount', a.amount) ORDER BY a.created_at, a.id)
      INTO v_reversed_allocations
      FROM public.payment_allocations a WHERE a.payment_transaction_id = v_existing.id;
    SELECT jsonb_agg(jsonb_build_object('orderId', e.order_id, 'amount', e.amount,
        'prevPayState', e.prev_pay_state, 'newPayState', e.new_pay_state) ORDER BY e.order_id)
      INTO v_affected_orders
      FROM public.order_financial_events e WHERE e.payment_transaction_id = v_existing.id;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true,
      'refundTransactionId', v_existing.id, 'reversesTransactionId', v_existing.reverses_transaction_id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'refundableRemainingOnOriginal', COALESCE(v_remaining_after_cents,0) / 100.0,
      'reversedAllocations', COALESCE(v_reversed_allocations, '[]'::jsonb),
      'affectedOrders', COALESCE(v_affected_orders, '[]'::jsonb)
    );
  END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_original FROM public.payment_transactions
   WHERE id = p_original_transaction_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_TRANSACTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_original.kind <> 'payment' THEN RAISE EXCEPTION 'MESA_REFUND_NOT_REFUNDABLE' USING ERRCODE='55000'; END IF;
  IF v_original.table_session_id <> p_table_session_id THEN
    RAISE EXCEPTION 'MESA_REFUND_TRANSACTION_MISMATCH' USING ERRCODE='55000';
  END IF;

  SELECT round(v_original.amount*100)::bigint - COALESCE((
      SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
       WHERE r.kind='refund' AND r.reverses_transaction_id = v_original.id
    ),0) INTO v_remaining_cents;
  IF v_remaining_cents <= 0 THEN RAISE EXCEPTION 'MESA_REFUND_ALREADY_FULL' USING ERRCODE='55000'; END IF;

  v_amount_cents := CASE WHEN p_amount IS NULL THEN v_remaining_cents ELSE round(p_amount*100)::bigint END;
  IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'MESA_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount_cents > v_remaining_cents THEN RAISE EXCEPTION 'MESA_REFUND_EXCEEDS_REMAINING' USING ERRCODE='55000'; END IF;

  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;

  v_settlement := CASE WHEN v_original.payment_method = 'efectivo' THEN 'drawer' ELSE 'external' END;

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, reverses_transaction_id, by_actor, by_role,
    by_sid_hash, client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_session.service_session_id, 'refund', 'refund',
    v_amount_cents / 100.0, v_original.payment_method, 0, v_original.id,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id, p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_refund_tx;

  v_to_reverse_cents := v_amount_cents;
  FOR v_alloc IN
    SELECT a.id, a.table_order_line_id, a.order_id, a.amount,
      round(a.amount * 100)::bigint - COALESCE((
        SELECT sum(round(ra.amount * 100))::bigint
          FROM public.payment_allocations ra
          JOIN public.payment_transactions rt ON rt.id = ra.payment_transaction_id
         WHERE rt.kind = 'refund' AND rt.reverses_transaction_id = v_original.id
           AND ra.table_order_line_id = a.table_order_line_id
      ), 0) AS reversible_cents
    FROM public.payment_allocations a
    JOIN public.table_order_lines l ON l.id = a.table_order_line_id
    WHERE a.payment_transaction_id = v_original.id
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_reverse_cents <= 0;
    CONTINUE WHEN v_alloc.reversible_cents <= 0;
    v_take_cents := LEAST(v_to_reverse_cents, v_alloc.reversible_cents);
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_refund_tx.id, v_alloc.table_order_line_id, v_alloc.order_id, v_take_cents / 100.0, v_now);
    v_to_reverse_cents := v_to_reverse_cents - v_take_cents;
  END LOOP;
  IF v_to_reverse_cents <> 0 THEN RAISE EXCEPTION 'MESA_REFUND_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents,
      o.service_session_id AS obligation_service_session_id, o.estado
      FROM public.payment_allocations a
      JOIN public.ordenes o ON o.id = a.order_id
     WHERE a.payment_transaction_id = v_refund_tx.id
     GROUP BY a.order_id, o.service_session_id, o.estado ORDER BY a.order_id
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
    v_new_paid_cents := v_order_paid_before_cents - v_order_allocation_cents;
    v_new_state := CASE
      WHEN v_new_paid_cents <= 0 THEN 'unpaid'
      WHEN v_new_paid_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_scope := 'mesa_' || replace(v_refund_tx.id::text, '-', '');

    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      event_service_session_id, payment_transaction_id, created_at
    )
    SELECT o.id, 'refund', v_order_allocation_cents / 100.0, v_original.payment_method,
      v_reason, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','mesa','mode','refund','transaction_id',v_refund_tx.id,
        'reverses_transaction_id', v_original.id, 'settlement', v_settlement),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_refund_tx.id::text, v_order_allocation_cents::text,
        v_original.payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_receipt_service_id, v_refund_tx.id, v_now
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

  v_remaining_after_cents := v_remaining_cents - v_amount_cents;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_table_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal, restored verbatim by this rollback, not new vocabulary
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_table_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_table_outstanding_cents := GREATEST(0, v_table_total_cents - v_table_paid_cents);

  SELECT jsonb_agg(jsonb_build_object('tableOrderLineId', a.table_order_line_id,
      'orderId', a.order_id, 'amount', a.amount) ORDER BY a.created_at, a.id)
    INTO v_reversed_allocations
    FROM public.payment_allocations a WHERE a.payment_transaction_id = v_refund_tx.id;
  SELECT jsonb_agg(jsonb_build_object('orderId', e.order_id, 'amount', e.amount,
      'prevPayState', e.prev_pay_state, 'newPayState', e.new_pay_state) ORDER BY e.order_id)
    INTO v_affected_orders
    FROM public.order_financial_events e WHERE e.payment_transaction_id = v_refund_tx.id;
  SELECT jsonb_agg(DISTINCT a.order_id) INTO v_order_ids
    FROM public.payment_allocations a WHERE a.payment_transaction_id = v_refund_tx.id;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES (
    'MESA_PAYMENT_REFUNDED',
    v_original.by_actor,
    p_by_actor,
    jsonb_build_object(
      'tableSessionId', v_session.id, 'originalTransactionId', v_original.id,
      'refundTransactionId', v_refund_tx.id, 'amount', v_amount_cents / 100.0,
      'paymentMethod', v_original.payment_method, 'reason', v_reason,
      'clientRequestId', p_client_request_id,
      'orderIds', COALESCE(v_order_ids, '[]'::jsonb),
      'refundableRemainingAfter', v_remaining_after_cents / 100.0
    )
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false,
    'refundTransactionId', v_refund_tx.id, 'reversesTransactionId', v_original.id,
    'amount', v_refund_tx.amount, 'paymentMethod', v_refund_tx.payment_method,
    'originalAmount', v_original.amount,
    'refundedTotalOnOriginal', (round(v_original.amount*100)::bigint - v_remaining_after_cents) / 100.0,
    'refundableRemainingOnOriginal', v_remaining_after_cents / 100.0,
    'reversedAllocations', COALESCE(v_reversed_allocations, '[]'::jsonb),
    'affectedOrders', COALESCE(v_affected_orders, '[]'::jsonb),
    'tableTotal', v_table_total_cents / 100.0,
    'tableOutstandingAfter', v_table_outstanding_cents / 100.0,
    'tableStatus', v_session.status,
    'auditId', v_audit_id
  );
END
$function$;

-- Drop the three check-centric writers.
DROP FUNCTION IF EXISTS public.order_post_payment_v1(uuid, text, text, uuid, text, text, numeric, text, text, jsonb, boolean);
DROP FUNCTION IF EXISTS public.order_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb);
DROP FUNCTION IF EXISTS public.order_apply_commercial_adjustment_v1(uuid, text, text, uuid, numeric, text, text, text, numeric, jsonb);

-- Restore auth_audit_event_chk without the two check-centric event values.
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event = ANY (ARRAY[
  'login_ok'::text, 'login_fail'::text, 'locked'::text, 'pin_set'::text, 'pin_change'::text, 'revoke'::text,
  'bootstrap'::text, 'recovery'::text, 'actor_disabled'::text, 'actor_enabled'::text, 'actor_unlocked'::text,
  'user_created'::text, 'user_renamed'::text, 'role_changed'::text, 'user_deactivated'::text, 'user_reactivated'::text,
  'access_denied'::text, 'credential_cleared'::text, 'fingerprint_upgraded'::text, 'session_invalidated'::text,
  'rate_limit_triggered'::text, 'migration_login_used'::text, 'PAYMENT_REPLAY_DIFFERENT_ACTOR'::text,
  'PAYMENT_DUPLICATE_CONFIRMED'::text, 'MESA_PAYMENT_REFUNDED'::text, 'MESA_COMMERCIAL_ADJUSTMENT'::text,
  'ORDER_CANCELLED'::text
]));

-- Drop the check-centric allocation shape (safe -- the guard above proved
-- zero rows use it).
DROP INDEX IF EXISTS public.payment_allocations_order_uid_idx;
DROP INDEX IF EXISTS public.payment_allocations_transaction_order_uq;
ALTER TABLE public.payment_allocations DROP CONSTRAINT IF EXISTS payment_allocations_target_chk;
ALTER TABLE public.payment_allocations DROP CONSTRAINT IF EXISTS payment_allocations_order_uid_fkey;
ALTER TABLE public.payment_allocations DROP COLUMN IF EXISTS order_uid;
ALTER TABLE public.payment_allocations ALTER COLUMN table_order_line_id SET NOT NULL;

-- Restore payment_transactions.table_session_id to NOT NULL (safe -- the
-- guard above proved zero rows have it NULL).
ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_scope_chk;
ALTER TABLE public.payment_transactions ALTER COLUMN table_session_id SET NOT NULL;

COMMIT;
