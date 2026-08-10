-- P0-B — CLOSED MESA TABLE ORDERS REMAIN ACTIVE, fix.
--
-- ROOT CAUSE (proven live on staging, not assumed): mesa_post_payment_v1
-- closes a table_session purely on financial state (outstanding balance
-- reaches zero) and has never touched ordenes.estado -- by design, payment
-- truth and kitchen/service truth are separate domains (see this file's
-- unchanged financial logic above the one block this migration adds). The
-- ONLY UI path that can ever move a Mesa order to a terminal estado is
-- markServed() (LISTO -> RETIRADO), which mesaService.js only exposes through
-- floor()/mesaDao.js's listFloorRows(), itself hard-scoped to
-- table_sessions.status='open' (mesaDao.js line ~42). The moment a table
-- closes, any of its still-non-terminal orders become permanently
-- unreachable through any surviving UI path -- not just "not yet resolved",
-- literally no longer resolvable. Confirmed live 2026-08-10 on real staging
-- data predating this session (Mesa 2 table_session fa549fc2-..., closed via
-- the ordinary Cobrar-todo flow hours earlier: orders #362 stuck LISTO,
-- #363 stuck EN_COCINA) and reproduced fresh under controlled conditions
-- (order #366: EN_COCINA before payment, still EN_COCINA after, table
-- closed) -- see MESA_P0_B_ORDER_TERMINALIZATION_REPORT.md.
--
-- This is not merely cosmetic. guard_service_session_closed_v1 (BEFORE
-- UPDATE OF status ON service_sessions, unconditional, unchanged since
-- 2026-08-02 through every V3 migration -- see that trigger's own body)
-- hard-blocks a SERVICE close with SERVICE_ACTIVE_ORDERS_NOT_RESOLVED while
-- ANY order under that service_session_id is non-terminal. Nothing in
-- serviceLifecycleEngine.js/v3IncidentPolicy.js ever calls cambiaStato/
-- changeOrderState (grepped, confirmed absent) -- V3's "non-terminal order
-- becomes a soft incident, the service still closes" architecture only
-- holds for orders on a table that survived the boundary STILL OPEN; a
-- non-terminal order stranded on an already-CLOSED table is a ticking
-- SERVICE_ACTIVE_ORDERS_NOT_RESOLVED failure the JS layer cannot prevent.
--
-- FIX FAMILY: Option 1 (domain transition), applied ONLY at the one moment
-- the order becomes otherwise-unreachable (table fully settles), and ONLY
-- to orders that are genuinely non-terminal at that instant. Does NOT use
-- RETIRADO -- that would assert "confirmed served/picked up", a claim this
-- code cannot honestly make (the whole reason this bug exists is that
-- nothing recorded that). Uses CHIUSO_FORZATO, the codebase's own existing
-- "force-closed, not confirmed served" terminal value (already load-bearing
-- in every TERMINAL_ORDER_STATES / CANCELLED set this migration's diff
-- touches nothing in) -- honest about what actually happened: the table's
-- business ended, not that the kitchen ticket was hand-confirmed served.
--
-- Payment truth is untouched: this block runs strictly AFTER this
-- function's existing financial logic (allocations, order_financial_events,
-- cobrado/ya_pagado projection, the table_sessions close itself) and reads
-- none of it back. It only ever fires when the table close already
-- happened for real financial reasons; it can never cause or contribute to
-- a table closing.
--
-- Scope: table_session_id = v_session.id only -- never another table, never
-- a non-Mesa order (delivery/WhatsApp orders have table_session_id NULL and
-- structurally cannot match). Idempotent by construction: the WHERE clause
-- excludes anything already terminal, so a payment retry (already
-- short-circuited earlier in this function by the client_request_id replay
-- branch) or any hypothetical re-entry is a clean no-op the second time.
-- Atomic: same implicit transaction as the table close and every other
-- write in this function -- no separate network round-trip, no window
-- where the table can be closed with this step only partially applied.
--
-- Does NOT retroactively heal orders already stranded on tables closed
-- before this migration lands (Mesa 2's #362/#363 above, and this session's
-- own test fixtures on Mesa 1/6/2) -- deliberately out of scope, a data
-- backfill is a separate, smaller, reviewable follow-up, not bundled here.
-- Does NOT touch orderStateMachine.js's transition graph (CHIUSO_FORZATO is
-- not in its KNOWN_STATES) because this fix never calls cambiaStato/
-- validateTransition at all -- it is a direct, scoped SQL UPDATE inside the
-- same authoritative transaction that already writes ordenes in this exact
-- function (the cobrado/ya_pagado/metodo_pago projection above). That gap
-- in orderStateMachine.js is real but pre-existing and unrelated to this
-- fix's own correctness; noted in the report, not fixed here.
BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb)') IS NULL THEN
    RAISE EXCEPTION 'P0-B fix refused: mesa_post_payment_v1 not found -- apply 2026-08-02_v3j_mesa_nomenclature_cutover.sql first';
  END IF;
  -- NOTE: CHIUSO_FORZATO alone is NOT a valid drift signal -- it already
  -- appears in this function's pre-existing billing-exclusion filters
  -- (upper(estado) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')).
  -- 'table_closed_forced' is unique to this fix's new block.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1'
      AND pg_get_functiondef(p.oid) ILIKE '%table_closed_forced%'
  ) THEN
    RAISE EXCEPTION 'P0-B fix refused: mesa_post_payment_v1 already references table_closed_forced -- already patched, resolve drift first';
  END IF;
END $$;

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

  -- Replay is checked before the account-open guard. A final payment closes the
  -- account atomically; if its response was lost, the exact retry must still return
  -- the committed transaction instead of looking like a new payment on a closed ID.
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

  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;
  IF v_table_remaining_cents = 0 THEN
    UPDATE public.table_sessions SET
      status='closed', settled_at=v_now, closed_at=v_now,
      updated_at=v_now, updated_by=p_by_actor
    WHERE id=v_session.id;

    -- P0-B FIX — see this file's header. The table just became otherwise-
    -- unreachable for kitchen/service purposes; force-terminalize any of
    -- its orders that never got there through the normal flow, honestly
    -- (CHIUSO_FORZATO, not RETIRADO), atomically, with an audit trail.
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
    )
    INSERT INTO public.orden_estado_logs(
      orden_id, numero_ordine, estado_from, estado_to, event_type,
      actor_type, actor_id, origin, metadata
    )
    SELECT c.id, c.id, c.old_estado, 'CHIUSO_FORZATO', 'table_closed_forced',
      'system', p_by_actor, 'mesa_table_close',
      jsonb_build_object(
        'table_session_id', v_session.id,
        'payment_transaction_id', v_tx.id,
        'reason', 'table_fully_settled_order_was_not_yet_terminal'
      )
    FROM closed_orphans c;
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
-- mesa_post_payment_v1 keeps its existing grants (CREATE OR REPLACE does not reset them).

COMMIT;
