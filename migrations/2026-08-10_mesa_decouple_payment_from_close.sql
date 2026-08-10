-- P0-B.1 — DECOUPLE PAYMENT FROM TABLE / KITCHEN COMPLETION.
--
-- PRODUCT CLARIFICATION (authoritative, this session): paying a Mesa table
-- in full does NOT mean the table or the kitchen work is done. A guest may
-- legitimately pay before food is ready (e.g. one of four friends settles
-- the whole bill up front so nobody has to split later, while all four
-- pizzas are still EN_COCINA). PAID != SERVED, PAID != ORDER TERMINAL,
-- PAID != TABLE CLOSED. Financial state, order/kitchen state, and table
-- occupancy state must be three independent domains.
--
-- WHAT THIS CORRECTS: the P0-B migration applied earlier today
-- (2026-08-10_mesa_close_forces_orphaned_orders.sql, migrations row 63,
-- ALREADY PERMANENTLY APPLIED to staging -- not edited here, corrected
-- forward instead, per this session's explicit instruction) solved a real
-- bug the right way for the WRONG trigger: it force-terminalized any
-- still-non-terminal Mesa order the instant `mesa_post_payment_v1` reached
-- a zero outstanding balance, because at the time "table fully paid" and
-- "table administratively closed" were believed to be the same event (the
-- function auto-closed `table_sessions` on zero balance, and had done so
-- since long before P0-B). That coupling is the actual root cause P0-B
-- should have targeted: mesa_post_payment_v1 was doing BOTH financial
-- settlement AND table closure AND (after P0-B) kitchen-order
-- terminalization, all as one implicit, unavoidable side effect of the
-- balance reaching zero. A guest paying early was therefore
-- indistinguishable, to this function, from a table being done -- exactly
-- the false equivalence this correction removes.
--
-- ROOT CAUSE OF THE COUPLING (traced, not assumed): before this migration,
-- `mesa_post_payment_v1`'s only prior close mechanism was itself -- there
-- was, and structurally could be, no OTHER way for an occupied
-- (covers_total IS NOT NULL) table_session to ever reach status='closed'.
-- `mesa_release_empty_session_v1` exists but hard-refuses
-- (MESA_TABLE_HAS_ORDERS) the instant covers_total is set -- it is, and
-- remains, for a genuinely never-ordered table only. The frontend's own
-- "Cerrar mesa" button (TabMesa.jsx) is gated on
-- `session.coversTotal == null` for exactly that reason -- it has never
-- been reachable for an occupied table. Full payment was therefore the
-- ONLY proxy the system had for "this table is done," which is precisely
-- the false equivalence being corrected.
--
-- THE FIX, two parts, one migration:
--
-- PART 1 -- mesa_post_payment_v1 reverts to payment-only semantics.
-- Removes BOTH the implicit `table_sessions` close-on-zero-balance UPDATE
-- (pre-dates P0-B) AND today's P0-B CHIUSO_FORZATO block (which only ever
-- fired as a side effect of that same implicit close). Every other line --
-- validation, allocations, order_financial_events, the cobrado/ya_pagado
-- legacy-boolean projection -- is untouched; this function now only ever
-- writes payment_transactions/payment_allocations/order_financial_events
-- and the cobrado/ya_pagado projection, never table_sessions or
-- ordenes.estado. `tableStatus` in the return payload -- confirmed unused
-- anywhere in the frontend (grepped) -- is corrected from a fabricated
-- financial-based guess ('free' the instant balance hit zero, regardless
-- of whether the table itself ever closed) to the literal, structurally-
-- guaranteed-accurate value: this function can no longer change table
-- occupancy, so it is always 'open' at this point.
--
-- PART 2 -- a genuinely new mesa_close_session_v1 RPC, the first real
-- "Cerrar mesa" for an OCCUPIED table (mesa_release_empty_session_v1 stays
-- completely untouched -- it is correct and sufficient for the empty-table
-- case it already owns). Financial safety is preserved as an absolute,
-- non-negotiable precondition of BOTH normal and forced close (a table
-- must never become free/available for new guests while money is still
-- owed -- this was already true, implicitly, of the one close path that
-- existed before; this migration keeps that invariant explicit rather than
-- relaxing it in either direction -- not in scope, not requested).
-- Kitchen/order completeness is the ONLY thing `p_force` overrides:
--   * outstanding > 0                        -> MESA_TABLE_NOT_SETTLED, always, force or not.
--   * outstanding = 0, non-terminal orders exist, p_force=false (default) -> MESA_TABLE_HAS_ACTIVE_ORDERS (the frontend shows this as a block, no code silently loses work).
--   * outstanding = 0, non-terminal orders exist, p_force=true  -> those orders are terminalized to CHIUSO_FORZATO (today's P0-B logic, moved here verbatim -- same honest "administratively force-closed, not confirmed served" semantics, same audited orden_estado_logs trail), table closes.
--   * outstanding = 0, no non-terminal orders                   -> table closes cleanly, nothing to force, `forced=false` in the response either way.
-- Idempotent the same way mesa_release_empty_session_v1 already is: a
-- retry after success finds status<>'open' and fails closed
-- (MESA_SESSION_NOT_OPEN) before reaching any mutation -- no duplicate
-- close, no duplicate CHIUSO_FORZATO/audit row, on any retry.
--
-- NOT done here (explicitly out of scope, per this session's own
-- instructions): no frontend "force close" button/second-confirmation UI
-- (Phase 6/14 explicitly permit backend-only support with the frontend
-- follow-up documented separately -- see the session report); no
-- retroactive rewrite of the already-applied P0-B migration file itself;
-- no change to mesa_release_empty_session_v1, addCommand, markServed, or
-- any V3 lifecycle file.
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb)') IS NULL THEN
    RAISE EXCEPTION 'P0-B.1 refused: mesa_post_payment_v1 not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1'
      AND pg_get_functiondef(p.oid) ILIKE '%table_closed_forced%'
  ) THEN
    RAISE EXCEPTION 'P0-B.1 refused: mesa_post_payment_v1 does not carry the expected P0-B body (table_closed_forced not found) -- apply 2026-08-10_mesa_close_forces_orphaned_orders.sql first';
  END IF;
  IF to_regprocedure('public.mesa_close_session_v1(uuid,text,uuid,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'P0-B.1 refused: mesa_close_session_v1 already exists -- already patched, resolve drift first';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- PART 1 — mesa_post_payment_v1: payment-only, never touches table_sessions
-- or ordenes.estado again.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(
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

  -- Replay is checked before the account-open guard. An exact retry must
  -- still return the committed transaction instead of looking like a new
  -- payment.
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor
     AND by_sid_hash = p_by_sid_hash AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
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
  -- A Mesa with no comanda yet has nothing to charge and no real covers to settle.
  IF v_session.covers_total IS NULL THEN
    RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000';
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
  -- Paying the final cent always settles every remaining cover.
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
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  -- Mirror one event per affected kitchen command into the canonical closeout ledger.
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

  -- Legacy booleans remain compatibility projections only. Ledger events above are truth.
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

  -- P0-B.1 — payment ends here. No table_sessions write, no ordenes.estado
  -- write, ever, in this function, again. `v_table_remaining_cents` is kept
  -- (still meaningful for the response payload below) but nothing branches
  -- on it to close anything anymore.
  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    -- Structurally accurate now, not a financial guess: this function can
    -- no longer change table occupancy, so the table is always still open
    -- at this point (the precondition check above already required it).
    'tableStatus', 'open'
  );
END
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- PART 2 — mesa_close_session_v1: the first real explicit close for an
-- OCCUPIED table. mesa_release_empty_session_v1 is untouched and remains
-- the correct path for a genuinely never-ordered table.
-- ══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.mesa_close_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_session_id uuid,
  p_force boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
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
  -- possible -- no duplicate close, no duplicate CHIUSO_FORZATO/audit row.
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  -- FINANCIAL SAFETY — absolute, never overridden by p_force. A table must
  -- never become free/available for new guests while money is still owed.
  -- Empty-table sessions (covers_total IS NULL) have no lines, so this is
  -- trivially satisfied (0 = 0) and never blocks that case -- though such a
  -- table should normally go through mesa_release_empty_session_v1 instead.
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
  IF v_outstanding_cents > 0 THEN
    RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000';
  END IF;

  -- KITCHEN/ORDER COMPLETENESS — the only thing p_force overrides.
  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'
       ))
  ) THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000';
    END IF;

    -- Explicit, operator-intentional force close. Same honest semantics as
    -- today's P0-B block, moved here verbatim: CHIUSO_FORZATO (never
    -- RETIRADO -- this never claims an order was confirmed served), fully
    -- audited, scoped to this table_session only.
    WITH orphaned AS (
      SELECT o.id, o.estado AS old_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'
         ))
       FOR UPDATE OF o
    ),
    closed_orphans AS (
      UPDATE public.ordenes o SET estado = 'CHIUSO_FORZATO', updated_at = v_now
      FROM orphaned t WHERE o.id = t.id
      RETURNING o.id, t.old_estado
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs(
        orden_id, numero_ordine, estado_from, estado_to, event_type,
        actor_type, actor_id, origin, metadata
      )
      SELECT c.id, c.id, c.old_estado, 'CHIUSO_FORZATO', 'table_closed_forced',
        'operator', p_by_actor, 'mesa_close_session_force',
        jsonb_build_object(
          'table_session_id', v_session.id,
          'reason', 'operator_forced_close_with_pending_kitchen_work'
        )
      FROM closed_orphans c
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

REVOKE ALL ON FUNCTION public.mesa_close_session_v1(uuid,text,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_close_session_v1(uuid,text,uuid,boolean) TO service_role;

COMMIT;
