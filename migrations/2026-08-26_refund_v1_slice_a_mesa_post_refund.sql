-- migrations/2026-08-26_refund_v1_slice_a_mesa_post_refund.sql
-- REFUND V1 -- SLICE A: canonical Mesa refund writer + legacy containment.
--
-- Full contract: MESA_REFUND_REVERSAL_V1_CONTRACT_AUDIT_2026-08-26.md (verdict
-- REFUND_V1_CONTRACT_READY). This migration implements its §K "Migration verdict"
-- plus one CHECK widening found live during this slice's own behavioural probes
-- (see K.3b below): no new table/column/FK/trigger, no backfill, no historical row
-- touched.
--
-- THE MODEL, IN ONE LINE: a refund returns money against ONE identified original
-- payment_transactions row (kind='payment'); it does NOT change the sale. The
-- refunded amount becomes owed again (obligation.gross is invariant; unpaid rises).
-- order_obligations is never touched by this migration or by mesa_post_refund_v1.
--
-- K.1 -- the two refund uniqueness indexes never carried the
-- `payment_transaction_id IS NULL` predicate their PAYMENT sibling
-- (order_financial_events_one_payment_session_uq) already has, so a transaction-backed
-- refund event collided with the legacy one-refund-per-(order,session) guarantee. The
-- legacy guarantee itself is fully preserved -- legacy refund events keep
-- payment_transaction_id IS NULL and stay inside the amended predicate; only
-- transaction-backed refunds are released to be multiple/partial.
--
-- K.2 -- new canonical writer public.mesa_post_refund_v1: transaction-centric target
-- (reverses_transaction_id, already NOT NULL-enforced by
-- payment_transactions_kind_mode_chk), amount defaults to the full refundable
-- remainder, reason mandatory, method forced from the original transaction (no
-- p_payment_method parameter), allocations reversed automatically against the
-- original transaction's OWN allocations in mesa_post_payment_v1's own deterministic
-- line order, capped per (transaction, line). SECURITY INVOKER, same privilege
-- posture as mesa_post_payment_v1: REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO
-- service_role only.
--
-- K.3 -- public.order_refund gains one fail-closed guard: an order carrying
-- transaction-backed evidence (order_financial_events.payment_transaction_id IS NOT
-- NULL) refuses with AUTH_REFUND_TRANSACTION_BACKED rather than silently refunding
-- the wrong amount from the wrong payment. Delegation is impossible (order_refund has
-- no amount parameter and no way to name a transaction), so this is a refusal, never a
-- redirect. Non-Mesa legacy orders (never carry a payment_transaction_id) are
-- completely unaffected.
--
-- K.3b -- ONE CHECK constraint IS widened, discovered live during the rollback-forced
-- behavioural probe run for this slice: auth_audit_event_chk enumerates every
-- permitted event literal, and it did not carry the new 'MESA_PAYMENT_REFUNDED' audit
-- event (contract §I.6/§20). Without this, a real refund's own audit INSERT would
-- fail the CHECK and abort the whole writer after already reversing money -- caught
-- here, before commit, precisely because the probe used the real function against
-- real staging rows inside a forced-rollback transaction. This is the ONLY CHECK
-- touched by this migration, it is additive-only (every existing literal is kept,
-- verbatim, in the same order), and it is on auth_audit -- not on any of the five
-- money tables the rest of this migration's guarantees are about.
--
-- K.4 -- post-conditions below, inside this same transaction, prove: both amended
-- index predicates include payment_transaction_id IS NULL; mesa_post_refund_v1 exists
-- with the exact argument signature and ACL; order_refund's prosrc contains the
-- AUTH_REFUND_TRANSACTION_BACKED marker; mesa_post_payment_v1 and
-- mesa_close_session_v1 are structurally byte-identical to their pre-migration
-- bodies (captured into transaction-local settings before any DDL runs); every
-- append-only trigger on the five money tables is unchanged; no anon/authenticated
-- role holds EXECUTE on the new function.
--
-- Live staging state at write time (verified against runtime, not assumed): backend
-- bdc1112, frontend 2196869, ledger 116. payment_transactions 44, payment_allocations
-- 117, order_financial_events 67, order_obligations 6, zero refunds ever executed.
-- Every rule below is therefore a greenfield decision proven against live schema, not
-- a migration of existing refund behaviour.

BEGIN;

-- ── Capture pre-migration structural fingerprints (K.4 proof material) ─────────
-- Neither function is touched by this migration; these snapshots let the
-- post-condition block below PROVE that, rather than merely assume it.
DO $$
DECLARE
  v_before_payment text;
  v_before_close text;
BEGIN
  SELECT md5(prosrc) INTO v_before_payment FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1';
  SELECT md5(prosrc) INTO v_before_close FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_close_session_v1';
  IF v_before_payment IS NULL THEN RAISE EXCEPTION 'REFUND_V1 pre-condition failed: mesa_post_payment_v1 missing before migration'; END IF;
  IF v_before_close IS NULL THEN RAISE EXCEPTION 'REFUND_V1 pre-condition failed: mesa_close_session_v1 missing before migration'; END IF;
  PERFORM set_config('ladieci.refund_v1_payment_md5_before', v_before_payment, true);
  PERFORM set_config('ladieci.refund_v1_close_md5_before', v_before_close, true);
END $$;

-- ── K.1a -- pre-condition guard: fail closed unless the live index text is EXACTLY
-- what this migration was written against. ───────────────────────────────────────
DO $$
DECLARE
  v_session_def text;
  v_legacy_def text;
BEGIN
  SELECT indexdef INTO v_session_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'order_financial_events_one_refund_session_uq';
  SELECT indexdef INTO v_legacy_def FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'order_financial_events_one_refund_legacy_uq';
  IF v_session_def IS DISTINCT FROM
     'CREATE UNIQUE INDEX order_financial_events_one_refund_session_uq ON public.order_financial_events USING btree (service_session_id, order_id) WHERE ((service_session_id IS NOT NULL) AND (type = ''refund''::text))'
  THEN RAISE EXCEPTION 'REFUND_V1 pre-condition failed: order_financial_events_one_refund_session_uq does not match the expected pre-migration definition: %', v_session_def;
  END IF;
  IF v_legacy_def IS DISTINCT FROM
     'CREATE UNIQUE INDEX order_financial_events_one_refund_legacy_uq ON public.order_financial_events USING btree (order_id) WHERE ((service_session_id IS NULL) AND (type = ''refund''::text))'
  THEN RAISE EXCEPTION 'REFUND_V1 pre-condition failed: order_financial_events_one_refund_legacy_uq does not match the expected pre-migration definition: %', v_legacy_def;
  END IF;
END $$;

-- ── K.1b -- replace both refund unique indexes with the payment sibling's own
-- payment_transaction_id IS NULL predicate. ─────────────────────────────────────
DROP INDEX public.order_financial_events_one_refund_session_uq;
CREATE UNIQUE INDEX order_financial_events_one_refund_session_uq
  ON public.order_financial_events USING btree (service_session_id, order_id)
  WHERE ((service_session_id IS NOT NULL) AND (type = 'refund'::text) AND (payment_transaction_id IS NULL));

DROP INDEX public.order_financial_events_one_refund_legacy_uq;
CREATE UNIQUE INDEX order_financial_events_one_refund_legacy_uq
  ON public.order_financial_events USING btree (order_id)
  WHERE ((service_session_id IS NULL) AND (type = 'refund'::text) AND (payment_transaction_id IS NULL));

-- ── K.2 -- the canonical Mesa refund writer ─────────────────────────────────────
-- Mirrors mesa_post_payment_v1's validation/lock/idempotency/append-only shape
-- verbatim wherever the operation is the same kind of thing (workspace lock, actor
-- lock+role gate, idempotency-by-(workspace_id,client_request_id), cents-based
-- arithmetic, the SAME deterministic line ordering, the SAME ordenes projection
-- expression). It diverges only where refund semantics require it: the target is a
-- transaction (not a table session outstanding balance), the method is forced from
-- the original (no p_payment_method parameter), covers_settled is always 0, and the
-- allocation loop reverses the ORIGINAL transaction's own allocations rather than
-- allocating a fresh payment across open lines.
CREATE FUNCTION public.mesa_post_refund_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_by_sid_hash text,
  p_table_session_id uuid,
  p_original_transaction_id uuid,
  p_reason text,
  p_client_request_id text,
  p_request_hash text,
  p_amount numeric DEFAULT NULL::numeric,
  p_meta jsonb DEFAULT '{}'::jsonb
)
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
  -- REFUND_ROLES -- narrower than PAYMENT_ROLES on purpose: the role that takes
  -- money should not be the one that can silently return it (admin/owner only).
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'MESA_REFUND_FORBIDDEN' USING ERRCODE='42501'; END IF;

  -- Idempotency -- reuses payment_transactions_idempotency_uq (workspace_id,
  -- client_request_id) verbatim; refunds and payments share the same table and the
  -- same identity rule.
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

  -- Closed tables are accepted deliberately (§J.2 of the contract): a refund never
  -- reopens a table session, never touches status/settled_at/closed_at.
  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Lock the ORIGINAL transaction -- this is what makes concurrent over-refund
  -- attempts serialise and the second recompute a now-lower remaining balance.
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

  -- §H.4 -- record, don't claim: tarjeta/bizum note that La Dieci is RECORDING an
  -- externally executed return, never that it executed a bank/POS operation.
  v_settlement := CASE WHEN v_original.payment_method = 'efectivo' THEN 'drawer' ELSE 'external' END;

  -- The refund's payment_method is FORCED from the original -- no caller-supplied
  -- method exists in this signature (§9 of the brief, frozen for V1).
  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, reverses_transaction_id, by_actor, by_role,
    by_sid_hash, client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_session.service_session_id, 'refund', 'refund',
    v_amount_cents / 100.0, v_original.payment_method, 0, v_original.id,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id, p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_refund_tx;

  -- Reversal allocation loop -- reverses PT-A's OWN allocations, in
  -- mesa_post_payment_v1's own deterministic line order, capped per (PT-A, line) by
  -- what PT-A itself put there minus what prior refunds against PT-A already took.
  -- The operator never chooses lines; this loop is not a fresh allocation.
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

  -- One order_financial_events row per order that actually received a reversal
  -- allocation -- never zero-amount rows, never an order untouched by this refund.
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

  -- Same projection expression mesa_post_payment_v1 uses -- one source of truth,
  -- copied verbatim rather than reimplemented. cobrado/ya_pagado/metodo_pago only;
  -- ordenes.refunded is never set (it means "fully refunded" in the LEGACY sense
  -- and would misstate a partial reversal).
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
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal mesa_post_payment_v1 already filters on, reproduced verbatim in this new writer's own table-outstanding query, not new vocabulary
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

REVOKE ALL ON FUNCTION public.mesa_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb) TO service_role;

-- ── K.3 -- legacy order_refund containment ──────────────────────────────────────
-- CURRENT LIVE BODY restated verbatim (CREATE OR REPLACE requires the full body),
-- with exactly one addition: the AUTH_REFUND_TRANSACTION_BACKED guard, inserted
-- immediately after the existing N-6 ownership check and before the replay lookup.
-- Every other line -- validation, role gate, session-version guard, replay/digest
-- logic, the basis query, the refund INSERT, the return shape -- is unchanged.
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

REVOKE ALL ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text) TO service_role;

-- ── K.3b -- widen auth_audit_event_chk to accept MESA_PAYMENT_REFUNDED ──────────
-- Pre-condition guard: fail closed unless the live constraint text is EXACTLY what
-- this migration was written against (same discipline as K.1a).
DO $$
DECLARE
  v_chk_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_chk_def
    FROM pg_constraint WHERE conrelid = 'public.auth_audit'::regclass AND conname = 'auth_audit_event_chk';
  IF v_chk_def IS DISTINCT FROM
    'CHECK ((event = ANY (ARRAY[''login_ok''::text, ''login_fail''::text, ''locked''::text, ''pin_set''::text, ''pin_change''::text, ''revoke''::text, ''bootstrap''::text, ''recovery''::text, ''actor_disabled''::text, ''actor_enabled''::text, ''actor_unlocked''::text, ''user_created''::text, ''user_renamed''::text, ''role_changed''::text, ''user_deactivated''::text, ''user_reactivated''::text, ''access_denied''::text, ''credential_cleared''::text, ''fingerprint_upgraded''::text, ''session_invalidated''::text, ''rate_limit_triggered''::text, ''migration_login_used''::text, ''PAYMENT_REPLAY_DIFFERENT_ACTOR''::text, ''PAYMENT_DUPLICATE_CONFIRMED''::text])))'
  THEN RAISE EXCEPTION 'REFUND_V1 pre-condition failed: auth_audit_event_chk does not match the expected pre-migration definition: %', v_chk_def;
  END IF;
END $$;

ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event = ANY (ARRAY[
  'login_ok'::text, 'login_fail'::text, 'locked'::text, 'pin_set'::text, 'pin_change'::text, 'revoke'::text,
  'bootstrap'::text, 'recovery'::text, 'actor_disabled'::text, 'actor_enabled'::text, 'actor_unlocked'::text,
  'user_created'::text, 'user_renamed'::text, 'role_changed'::text, 'user_deactivated'::text, 'user_reactivated'::text,
  'access_denied'::text, 'credential_cleared'::text, 'fingerprint_upgraded'::text, 'session_invalidated'::text,
  'rate_limit_triggered'::text, 'migration_login_used'::text, 'PAYMENT_REPLAY_DIFFERENT_ACTOR'::text,
  'PAYMENT_DUPLICATE_CONFIRMED'::text,
  -- REFUND V1 SLICE A -- the only literal this migration adds.
  'MESA_PAYMENT_REFUNDED'::text
]));

-- ── K.4 -- post-condition assertions ────────────────────────────────────────────
-- STRUCTURAL ONLY inside this transaction: zero business DML runs here, not one
-- order/obligation/financial-event/payment row is touched. The behavioural proof
-- (A-X matrix: full/partial/multiple refunds, over-refund refusal, refund-of-refund
-- refusal, allocation invariants, idempotency, concurrency, authorization, legacy
-- containment, append-only, projections) runs separately as rollback-forced probes
-- against real staging, recorded in this slice's report.
DO $$
DECLARE
  v_src text;
  v_session_def text;
  v_legacy_def text;
BEGIN
  -- Index predicates.
  SELECT indexdef INTO v_session_def FROM pg_indexes
   WHERE schemaname='public' AND indexname='order_financial_events_one_refund_session_uq';
  SELECT indexdef INTO v_legacy_def FROM pg_indexes
   WHERE schemaname='public' AND indexname='order_financial_events_one_refund_legacy_uq';
  IF v_session_def !~ 'payment_transaction_id IS NULL' THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: session refund index missing payment_transaction_id IS NULL predicate';
  END IF;
  IF v_legacy_def !~ 'payment_transaction_id IS NULL' THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: legacy refund index missing payment_transaction_id IS NULL predicate';
  END IF;

  -- mesa_post_refund_v1 exists with the exact signature.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1'
       AND pg_get_function_identity_arguments(p.oid) =
         'p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric, p_meta jsonb'
  ) THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: mesa_post_refund_v1 signature mismatch or missing'; END IF;

  -- ACL: service_role only, never anon/authenticated.
  IF NOT has_function_privilege('service_role', 'public.mesa_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: service_role lacks EXECUTE on mesa_post_refund_v1';
  END IF;
  IF has_function_privilege('anon', 'public.mesa_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mesa_post_refund_v1(uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb)', 'EXECUTE')
  THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: a browser role holds EXECUTE on mesa_post_refund_v1'; END IF;
  IF NOT has_function_privilege('service_role', 'public.order_refund(text, text, text, integer, text, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: service_role lost EXECUTE on order_refund';
  END IF;
  IF has_function_privilege('anon', 'public.order_refund(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_refund(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: a browser role holds EXECUTE on order_refund'; END IF;

  -- order_refund contains the containment marker.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_refund';
  IF v_src !~ 'AUTH_REFUND_TRANSACTION_BACKED' THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: order_refund missing the containment guard';
  END IF;
  IF v_src !~ 'payment_transaction_id IS NOT NULL' THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: order_refund containment guard not keyed on transaction-backed evidence';
  END IF;
  -- Every pre-existing refusal/behaviour must survive verbatim.
  IF v_src !~ 'AUTH_ALREADY_REFUNDED' OR v_src !~ 'AUTH_NO_PAYMENT_BASIS'
     OR v_src !~ 'AUTH_REFUND_BASIS_INTEGRITY' OR v_src !~ 'ORDER_WITHOUT_SERVICE_SESSION'
     OR v_src !~ 'AUTH_FORBIDDEN_ROLE' OR v_src !~ 'ordenes SET refunded = true'
  THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: order_refund lost pre-existing legacy behaviour'; END IF;

  -- mesa_post_payment_v1 / mesa_close_session_v1 structurally byte-identical.
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_payment_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.refund_v1_payment_md5_before', true) THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: mesa_post_payment_v1 was structurally modified';
  END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_close_session_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.refund_v1_close_md5_before', true) THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: mesa_close_session_v1 was structurally modified';
  END IF;

  -- Append-only triggers on all five money tables, unchanged. ONE pg_trigger row
  -- per multi-event trigger (BEFORE INSERT OR UPDATE OR DELETE is stored as a
  -- single row in pg_catalog.pg_trigger; information_schema.triggers is the view
  -- that fans it out per event, not this catalog).
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.payment_transactions'::regclass
        AND NOT tgisinternal AND tgname='payment_transactions_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.payment_allocations'::regclass
        AND NOT tgisinternal AND tgname='payment_allocations_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.table_order_lines'::regclass
        AND NOT tgisinternal AND tgname='table_order_lines_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.order_financial_events'::regclass
        AND NOT tgisinternal AND tgname='order_financial_events_no_update_delete') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.order_obligations'::regclass
        AND NOT tgisinternal AND tgname='order_obligations_append_only_v1') <> 1
  THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: an append-only trigger disappeared'; END IF;

  -- order_obligations untouched: no writer added, no column, no relaxed trigger.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1'
                AND p.prosrc ~ 'order_obligations')
  THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: mesa_post_refund_v1 must never touch order_obligations'; END IF;

  -- The writer must never set the legacy fully-refunded boolean.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1';
  IF v_src ~ 'ordenes.*SET.*refunded\s*=\s*true' OR v_src ~ 'refunded = calc' THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: mesa_post_refund_v1 must never set ordenes.refunded';
  END IF;
  IF v_src ~ 'UPDATE public\.table_sessions' THEN
    RAISE EXCEPTION 'REFUND_V1 post-condition failed: mesa_post_refund_v1 must never write table_sessions';
  END IF;

  -- auth_audit_event_chk: MESA_PAYMENT_REFUNDED now accepted, every prior literal
  -- (all 24 of them) still accepted, nothing removed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.auth_audit'::regclass
                  AND conname='auth_audit_event_chk'
                  AND pg_get_constraintdef(oid) ~ 'MESA_PAYMENT_REFUNDED')
  THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: auth_audit_event_chk does not accept MESA_PAYMENT_REFUNDED'; END IF;
  FOR v_src IN SELECT unnest(ARRAY['login_ok','pin_set','revoke','bootstrap','recovery','actor_disabled',
      'user_created','role_changed','access_denied','session_invalidated','rate_limit_triggered',
      'migration_login_used','PAYMENT_REPLAY_DIFFERENT_ACTOR','PAYMENT_DUPLICATE_CONFIRMED'])
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.auth_audit'::regclass
                    AND conname='auth_audit_event_chk' AND pg_get_constraintdef(oid) ~ ('''' || v_src || '''::text'))
    THEN RAISE EXCEPTION 'REFUND_V1 post-condition failed: auth_audit_event_chk lost pre-existing literal %', v_src; END IF;
  END LOOP;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-116:
-- the manifest records this file's own sha256, and embedding that sha in an INSERT
-- inside the file would make the checksum self-referential. Registered as a separate
-- statement at apply time: apply_order 117, kind 'ddl', checksum = this file's
-- sha256, applied_by = the introducing commit (committed BEFORE this migration is
-- applied -- O-1's ledger-immutability lesson, followed again).

COMMIT;
