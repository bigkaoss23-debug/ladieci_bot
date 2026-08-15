-- S2 — THREE ATTRIBUTION WRITERS + RECEIPT-SERVICE SCHEMA
-- Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S2
-- (§5 BLOCKER A, §19 S2 spec). S0=PASS, S1=CERTIFIED under that
-- specification.
--
-- ONE MIGRATION TRANSACTION, per §5.1: the DDL and all three function
-- replacements land together so there is no interval where the schema and
-- writer semantics disagree.
--
-- THREE INDEPENDENT WRITER FIXES + ONE SCHEMA WIDENING.
--
-- A. mesa_snapshot_order_lines_v1 — obligation-service writer fix (F-02).
--
--    ROOT CAUSE: this AFTER INSERT trigger on ordenes stamped
--    table_order_lines.service_session_id from v_session.service_session_id
--    (the TABLE SESSION's origin service, looked up from table_sessions),
--    even though V3.1 already made ordenes_assign_service_session
--    (mesa_prepare_table_order_v1 < ordenes_assign_service_session
--    alphabetically, both BEFORE INSERT) the SOLE writer of order->service
--    attribution -- by the time this AFTER INSERT trigger fires,
--    NEW.service_session_id on the ordenes row already holds the order's
--    own, correct, current service. A table that spans a service boundary
--    keeps its historical origin service on table_sessions (frozen fact,
--    architecture decision #4) forever, so any order placed on that table
--    AFTER the boundary got its lines silently mis-attributed to the wrong
--    (stale, possibly closed) service. Proven live pre-fix: F-02, 4 orders /
--    EUR 47.51 across the frozen S0 baseline.
--
--    FIX: one column swap, NEW.service_session_id instead of
--    v_session.service_session_id. table_sessions is still looked up (for
--    workspace_id and the row's own id, both table-scoped, unchanged) but
--    its service_session_id is never read again.
--
-- B. mesa_post_payment_v1 — receipt-service writer fix (F-29) + event
--    service + off-service nullability + cobrado-projection consistency.
--
--    ROOT CAUSE (F-29): the same pattern -- payment_transactions.service_
--    session_id was stamped from v_session.service_session_id (table
--    origin), so cash received after a service boundary was booked to a
--    session that might already be closed. Proven live pre-fix: F-29, 2
--    payment transactions / EUR 77.51 (historical, NOT repaired by S2 --
--    see the historical-repair prohibition below).
--
--    FIX: a new local, v_receipt_service_id, resolved from
--    service_session_state (the same singleton pointer
--    service_session_assign_order already trusts for "what's open right
--    now"), joined to service_sessions requiring status='open'. If nothing
--    is open, v_receipt_service_id stays NULL -- exactly the S2 nullability
--    contract: NULL = off-service receipt, never an error, never the
--    table's origin service. Unlike order creation (which REQUIRES an open
--    session and RAISEs NO_OPEN_SERVICE_SESSION), a payment legitimately
--    can happen off-service, so this lookup is a plain SELECT INTO with no
--    RAISE on a miss.
--
--    v_receipt_service_id is used for BOTH:
--      - payment_transactions.service_session_id (RECEIPT service), and
--      - order_financial_events.event_service_session_id (EVENT service,
--        new nullable column) -- the same real-world instant, same value,
--        by construction (the RPC's own payment IS the event).
--
--    order_financial_events.service_session_id keeps its OBLIGATION
--    meaning and is never written by this RPC -- the BEFORE INSERT trigger
--    service_session_assign_financial_event (part C, below) overwrites
--    whatever value is supplied here regardless, so the pre-existing
--    v_session.service_session_id literal in that one INSERT's value list
--    is left untouched (inert, unchanged diff surface) and
--    event_service_session_id is added as a new column alongside it.
--
--    COBRADO-PROJECTION CONSISTENCY: three correlated subqueries (the
--    per-order v_order_paid_before_cents lookup, and the two inside the
--    final cobrado/ya_pagado UPDATE...FROM) filtered order_financial_events
--    by e.service_session_id = v_session.service_session_id (table
--    origin). Once table_order_lines.service_session_id and
--    order_financial_events.service_session_id both correctly mean "this
--    order's own service" (fix A + the pre-existing trigger), a
--    cross-boundary order's true obligation service differs from the
--    table's origin, so the OLD filter silently found zero matching events
--    for exactly those orders -- always computing v_order_paid_before_cents
--    = 0 and re-deriving a wrong prev_pay_state/is_paid for any order that
--    crossed a boundary. FIX: the mirror-loop now joins ordenes to fetch
--    each order's own obligation_service_session_id and filters on that;
--    the final UPDATE's three subqueries filter on l.service_session_id
--    (now correctly the order's own service per fix A) instead of
--    v_session.service_session_id, with l.service_session_id added to the
--    GROUP BY (functionally dependent on l.order_id, required by Postgres
--    for a column referenced inside a correlated subquery in a grouped
--    query). For a NON-crossing order these two values are identical, so
--    output is byte-identical to before (S2's own TEST 2 requirement); for
--    a crossing order the projection is now correct instead of silently
--    wrong.
--
--    Everything table-scoped and service-agnostic by design (§12/§13's
--    table-wide balance equation: v_total_cents, v_paid_cents,
--    v_outstanding_cents, v_remaining_covers, the duplicate-candidate
--    window, the payment_allocations loop) is UNCHANGED -- those are
--    intentionally about the whole table session regardless of which
--    service any given line belongs to, and S2 does not touch them.
--
--    Signature is IDENTICAL to S1's (13 args, same names/types/defaults) --
--    a plain CREATE OR REPLACE, no DROP needed, no new overload.
--
-- C. service_session_assign_financial_event — the §5.3 safe fail-closed
--    obligation resolution (BLOCKER A root fix).
--
--    CURRENT (pre-S2) body is two lines: look up ordenes.service_session_id
--    by NEW.order_id, RAISE ORDER_WITHOUT_SERVICE_SESSION if the order row
--    is gone. That RAISE aborts the WHOLE payment whenever the order has
--    been deleted or de-linked -- exactly the EUR 140.50 / 11-line
--    order_deleted + order_delinked population (S0 §A) this plan exists to
--    make payable.
--
--    FIX: verbatim §5.3 CORRECTION 1 body. STEP 1 (live order) is
--    unchanged -- every in-service order behaves exactly as today. STEP 2
--    fires ONLY when the order row is already gone AND a
--    payment_transaction_id is available: it resolves the transaction's
--    own immutable table_session_id, then joins payment_allocations to
--    table_order_lines by table_order_line_id (a uuid, never recycled),
--    scoped to that table_session_id and filtered by order_id (a filter
--    within one transaction's own allocations, never a lookup key). Zero
--    candidates -> falls through to STEP 3's fail-closed RAISE (unchanged
--    error). Exactly one candidate -> resolved. More than one distinct
--    candidate -> RAISE ORDER_OBLIGATION_AMBIGUOUS, never guesses, never
--    picks "newest" or "first". No #NNN display id is ever used as a
--    lookup key anywhere in this function -- it appears only as an
--    intra-transaction filter after the uuid join has already scoped the
--    candidate set. The V2.1 fallback this replaces
--    (storico WHERE orden_id = NEW.order_id ORDER BY id DESC LIMIT 1) is -- language-guard: allow-legacy storico is named only to state the forbidden V2.1 fallback this migration does NOT use, not new vocabulary
--    explicitly forbidden and does not appear anywhere in this file.
--
-- D. Schema widening (strictly additive, cannot fail on existing rows):
--      ALTER TABLE payment_transactions ALTER COLUMN service_session_id
--        DROP NOT NULL;
--      ALTER TABLE order_financial_events ADD COLUMN
--        event_service_session_id uuid NULL REFERENCES service_sessions(id);
--    order_financial_events's six partial unique indexes
--    (order_financial_events_{one_refund,scope,one_payment}_{session,legacy}_uq)
--    are untouched -- the new column is unindexed and no existing
--    service_session_id value is ever changed, so no row can move
--    namespace between the *_session_uq and *_legacy_uq partitions.
--
-- HISTORICAL METHOD: none. No backfill of event_service_session_id;
-- historical rows (all of them, since the column is brand new) stay NULL
-- and are legacy/"event service unknown", exactly per V2.1.2. The F-02 (4
-- orders / EUR 47.51) and F-29 (2 transactions / EUR 77.51) historical
-- populations are NOT touched by this migration -- S2 fixes future writers
-- only; historical repair is a later, unstarted slice (S16). No
-- UPDATE/DELETE against table_order_lines, payment_transactions,
-- payment_allocations, or order_financial_events appears anywhere below;
-- those four tables' own append-only triggers are untouched and unbypassed.
--
-- S1 non-interference: this migration does not reference
-- payment_transactions_idempotency_uq, guard_service_session_closed_v1,
-- auth_audit, or p_confirm_duplicate's semantics -- S1's idempotency key,
-- NULL guard fix, and duplicate-candidate window are reproduced verbatim
-- (required because CREATE OR REPLACE needs the full function body) and
-- otherwise untouched.
--
-- Paired .ROLLBACK.sql restores mesa_snapshot_order_lines_v1 and
-- mesa_post_payment_v1 verbatim to their pre-S2 (S1) bodies, restores
-- service_session_assign_financial_event to its pre-S2 two-line body,
-- drops event_service_session_id, and restores payment_transactions.
-- service_session_id's NOT NULL -- the last step REFUSES if any row has
-- service_session_id IS NULL (an off-service receipt would have committed;
-- the rollback stops and escalates rather than deleting real money).

-- ── Predecessor guard: refuse over drift or a re-patch ───────────────────────
DO $$
DECLARE
  v_snapshot_body  text;
  v_payment_body   text;
  v_event_body     text;
  v_col_nullable   text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_snapshot_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_snapshot_order_lines_v1';
  IF v_snapshot_body IS NULL THEN
    RAISE EXCEPTION 'S2 refused: mesa_snapshot_order_lines_v1 not found -- resolve drift first';
  END IF;
  IF v_snapshot_body LIKE '%v_session.workspace_id, v_session.id, NEW.service_session_id, NEW.id,%' THEN
    RAISE EXCEPTION 'S2 refused: mesa_snapshot_order_lines_v1 already writes NEW.service_session_id -- already patched, resolve drift first';
  END IF;
  IF v_snapshot_body NOT LIKE '%v_session.workspace_id, v_session.id, v_session.service_session_id, NEW.id,%' THEN
    RAISE EXCEPTION 'S2 refused: mesa_snapshot_order_lines_v1 does not match the expected pre-S2 shape -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_payment_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1'
     AND pg_get_function_identity_arguments(p.oid) =
       'p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric, p_covers_settled integer, p_line_ids uuid[], p_meta jsonb, p_confirm_duplicate boolean';
  IF v_payment_body IS NULL THEN
    RAISE EXCEPTION 'S2 refused: expected 13-arg mesa_post_payment_v1 (post-S1) not found -- resolve drift first';
  END IF;
  IF v_payment_body LIKE '%v_receipt_service_id%' THEN
    RAISE EXCEPTION 'S2 refused: mesa_post_payment_v1 already references v_receipt_service_id -- already patched, resolve drift first';
  END IF;
  IF v_payment_body LIKE '%event_service_session_id%' THEN
    RAISE EXCEPTION 'S2 refused: mesa_post_payment_v1 already references event_service_session_id -- already patched, resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_event_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'service_session_assign_financial_event';
  IF v_event_body IS NULL THEN
    RAISE EXCEPTION 'S2 refused: service_session_assign_financial_event not found -- resolve drift first';
  END IF;
  IF v_event_body LIKE '%v_candidates%' THEN
    RAISE EXCEPTION 'S2 refused: service_session_assign_financial_event already carries the S2 candidate-resolution shape -- already patched, resolve drift first';
  END IF;

  SELECT is_nullable INTO v_col_nullable FROM information_schema.columns
   WHERE table_schema='public' AND table_name='payment_transactions' AND column_name='service_session_id';
  IF v_col_nullable IS NULL THEN
    RAISE EXCEPTION 'S2 refused: payment_transactions.service_session_id column not found -- resolve drift first';
  END IF;
  IF v_col_nullable = 'YES' THEN
    RAISE EXCEPTION 'S2 refused: payment_transactions.service_session_id is already nullable -- already patched, resolve drift first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_financial_events' AND column_name='event_service_session_id'
  ) THEN
    RAISE EXCEPTION 'S2 refused: order_financial_events.event_service_session_id already exists -- already patched, resolve drift first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_session_state' AND column_name='current_session_id'
  ) THEN
    RAISE EXCEPTION 'S2 refused: service_session_state.current_session_id not found -- resolve drift first';
  END IF;
END $$;

-- ── D. Schema widening ────────────────────────────────────────────────────
ALTER TABLE public.payment_transactions
  ALTER COLUMN service_session_id DROP NOT NULL;

COMMENT ON COLUMN public.payment_transactions.service_session_id IS
  'RECEIPT SERVICE: the service session open at the moment the money was received. '
  'NULL = off-service receipt (no session open). NEVER the table''s origin service. '
  'Physical rename to receipt_service_session_id lands in S14.';

ALTER TABLE public.order_financial_events
  ADD COLUMN event_service_session_id uuid NULL REFERENCES public.service_sessions(id);

-- ── A. mesa_snapshot_order_lines_v1 — obligation service = the order's own service (F-02) ──
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

      -- S2 FIX (F-02): the order's OWN service_session_id (NEW.service_session_id,
      -- already assigned by ordenes_assign_service_session, a BEFORE INSERT trigger
      -- that fires before this AFTER INSERT trigger) -- never the table session's
      -- historical origin service (v_session.service_session_id). A table that spans
      -- a service boundary keeps its origin on table_sessions forever (frozen,
      -- architecture decision #4); an order placed on it after the boundary belongs,
      -- economically, to the service active for THAT ORDER.
      INSERT INTO public.table_order_lines(
        workspace_id, table_session_id, service_session_id, order_id,
        source_line_id, source_line_index, unit_index, description,
        product_snapshot, gross_amount, discount_amount, net_amount
      ) VALUES (
        v_session.workspace_id, v_session.id, NEW.service_session_id, NEW.id,
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

-- ── C. service_session_assign_financial_event — §5.3 CORRECTION 1, verbatim ──
CREATE OR REPLACE FUNCTION public.service_session_assign_financial_event()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $$
DECLARE
  v_session_id     uuid;
  v_table_session  uuid;
  v_candidates     uuid[];
BEGIN
  -- STEP 1 — live order. Exact: ordenes_pkey admits at most one live row per display id.
  SELECT o.service_session_id INTO v_session_id
    FROM public.ordenes o WHERE o.id = NEW.order_id;

  -- STEP 2 — settled-obligation anchor. Used ONLY when the order row is gone.
  IF v_session_id IS NULL AND NEW.payment_transaction_id IS NOT NULL THEN
    SELECT pt.table_session_id INTO v_table_session
      FROM public.payment_transactions pt WHERE pt.id = NEW.payment_transaction_id;

    SELECT array_agg(DISTINCT l.service_session_id) INTO v_candidates
      FROM public.payment_allocations pa
      JOIN public.table_order_lines   l ON l.id = pa.table_order_line_id
     WHERE pa.payment_transaction_id = NEW.payment_transaction_id
       AND l.table_session_id        = v_table_session
       AND l.order_id                = NEW.order_id;

    IF v_candidates IS NOT NULL AND cardinality(v_candidates) > 1 THEN
      RAISE EXCEPTION 'ORDER_OBLIGATION_AMBIGUOUS' USING ERRCODE='P0001',
        DETAIL = format('order=%s table_session=%s candidates=%s',
                        NEW.order_id, v_table_session, v_candidates);
    END IF;
    IF v_candidates IS NOT NULL AND cardinality(v_candidates) = 1 THEN
      v_session_id := v_candidates[1];
    END IF;
  END IF;

  -- STEP 3 — fail closed. Unchanged error code, unchanged semantics.
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;

  NEW.service_session_id := v_session_id;
  RETURN NEW;
END $$;

-- ── B. mesa_post_payment_v1 — receipt service, event service, cobrado-projection fix (F-29) ──
-- Signature IDENTICAL to S1's 13-arg form -- plain CREATE OR REPLACE, no DROP,
-- no new overload.
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

  -- S1: idempotency key narrowed to (workspace_id, client_request_id) --
  -- exactly-once commit per logical payment intent, regardless of actor,
  -- session id, re-login or device. Replay is still checked before the
  -- account-open guard: an exact retry must return the committed
  -- transaction instead of looking like a new payment.
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    -- Same key, same hash: a genuine replay. Actor/role/sid attribution on
    -- the ORIGINAL row is never touched. A replay by a different identity
    -- than the one who committed the original row is never blocked, but is
    -- never silent either -- it leaves an audit trace naming both.
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
  -- A Mesa with no comanda yet has nothing to charge and no real covers to settle.
  IF v_session.covers_total IS NULL THEN
    RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal mesa_post_payment_v1 already filtered on, reproduced verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
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
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, reproduced verbatim for the same reason
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
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO') -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, reproduced verbatim for the same reason
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

  -- S1-C: duplicate-candidate window. NOT idempotency -- a genuinely new
  -- client_request_id whose shape matches a payment that just committed on
  -- the SAME table session, within the previous 120 seconds. Matching shape
  -- is exactly: table_session_id, kind ('payment' -- the only kind this
  -- function ever inserts), mode, amount, payment_method, covers_settled.
  -- No fuzzy matching, no wider window, no new intent lifecycle.
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
    -- Explicit override of a real detected candidate: proceed (every other
    -- gate above already passed), but never silently -- this is a distinct,
    -- confirmed payment, never returned as idempotent:true.
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

  -- S2: receipt/event service = the service open RIGHT NOW (not the table's
  -- origin service). Same singleton pointer service_session_assign_order
  -- already trusts for "what's open" -- but unlike order creation, a
  -- payment can legitimately be off-service, so this is a plain SELECT
  -- INTO with no RAISE on a miss: v_receipt_service_id simply stays NULL.
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
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO') -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, reproduced verbatim for the same reason
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
  -- S2: joins ordenes to fetch each order's own OBLIGATION service
  -- (o.service_session_id) -- the table's origin service is never used here.
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
    -- S2 FIX (cobrado-projection consistency): filter by this order's own
    -- obligation service, not the table's origin service -- a cross-boundary
    -- order's true events live under its own (post-fix-A) service, not
    -- necessarily v_session.service_session_id.
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

    -- S2: event_service_session_id (new, nullable) = v_receipt_service_id --
    -- the same real-world instant as the receipt above. service_session_id
    -- keeps its pre-existing literal (v_session.service_session_id): it is
    -- OBLIGATION-meaning and trigger-owned -- service_session_assign_financial_event
    -- (part C) overwrites whatever value is supplied here regardless, so this
    -- value is inert by design and left unchanged to minimize diff surface.
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

  -- Legacy booleans remain compatibility projections only. Ledger events above are truth.
  -- S2 FIX (cobrado-projection consistency): filter by l.service_session_id
  -- (this order's own service, post-fix-A) instead of v_session.service_session_id
  -- (table origin) -- see the migration header for the full defect this closes.
  -- l.service_session_id is added to GROUP BY: it is functionally dependent on
  -- l.order_id (every line of one order shares the order's own service) but
  -- Postgres still requires it grouped or aggregated to reference it inside a
  -- correlated subquery in the SELECT list of a grouped query.
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

  -- P0-B.1 — payment ends here. No table_sessions write, no ordenes.estado
  -- write, ever, in this function, again.
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
