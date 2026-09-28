-- migrations/2026-09-25_mesa_refund_canonical_projection_v1_migration_147.sql
-- Paired rollback: 2026-09-25_mesa_refund_canonical_projection_v1_migration_147.ROLLBACK.sql
--
-- R2 -- MESA REFUND PROJECTION ON THE CANONICAL OBLIGATION (DELIVERY x ECONOMIA V1, 2026-09-25). STAGING CANDIDATE ONLY; not applied by the session that
-- authored it. Evidence: ~/Downloads/DELIVERY_ECONOMY_V1_TARGETED_FINDINGS_2026-09-25.md (R2=CONFIRMED_BUG) and DELIVERY_ECONOMY_V1_R2_FIX_2026-09-25.md.
--
-- THE DEFECT. Migration 118 moved mesa_post_payment_v1 to the canonical obligation (order_canonical_obligation_v1) for the table total, the per-order total
-- and the cobrado / ya_pagado / metodo_pago projection; mesa_post_refund_v1 was left on the table_order_lines.net_amount sum. A commercial adjustment
-- changes order_obligations and never the lines, so after pay 100 -> adjust 80 -> refund 20 the refund wrote new_pay_state 'partially_paid', set
-- cobrado / ya_pagado = false and answered tableTotal 100 / tableOutstandingAfter 20, while the canonical truth is obligation 80, net collected 80,
-- outstanding 0 (and mesa_post_payment_v1 refuses a further payment with MESA_ALREADY_SETTLED). Money was always right: PT / PA / OFE amounts are unchanged.
--
-- THE FIX. public.mesa_post_refund_v1 (predecessor = the 146 body, md5 9679556fe209fbadac5275b3ac71e456) is re-issued with THREE marked blocks that
-- REPLACE the three net_amount-based computations with the SAME canonical expressions mesa_post_payment_v1 (145 body, md5 94867e165d0732f36ae4692fc6998c58)
-- uses, copied verbatim from that body:
--   -- 147:BEGIN canonical_order_total        per-order total behind prev_pay_state / new_pay_state = order_canonical_obligation_v1(order_uid)
--   -- 147:BEGIN canonical_mirror_projection  the payment writer's cobrado / ya_pagado / metodo_pago UPDATE, verbatim
--   -- 147:BEGIN canonical_table_total        the payment writer's table total, verbatim (INTO v_table_total_cents)
-- Putting the three predecessor regions back yields the 146 body byte for byte (proved by tests/mesaRefundCanonicalProjectionMigration.test.js).
-- UNCHANGED: refund amount, refundable remaining, reversal allocation loop and per-line caps, reverses_transaction_id linkage, payment method forced from the
-- original, receipt service and the 146 pointer lock (FOR SHARE), idempotent replay, authorization (admin / owner), error precedence and codes, the refund
-- state rule itself (net <= 0 unpaid, net >= total paid, else partially_paid), the response fields (no field added or removed), closed tables accepted.
-- No lock is added or removed (order_canonical_obligation_v1 is a STABLE read; every Mesa writer is already serialized on the workspace row).
-- Contract: an over-collection after an adjustment (net > current obligation) is 'paid' with outstanding 0; the excess is the existing overCollected
-- concept of the canonical readers (net collected - current obligation), not a new state.
--
-- ROLLOUT: 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147. ROLLBACK ORDER: 147 FIRST (restores the 146 body verbatim), then 146, 145, 144 / 143, 140.
-- DRIFT GUARDS (fail closed): UTF-8 transport of the embedded live bytes; mesa_post_refund_v1 exists exactly once with the pinned signature and is EXACTLY
-- the 146 body; not already applied; mesa_post_payment_v1 is the 145 body the copied expressions come from; order_canonical_obligation_v1(uuid) exists.
-- POST-CONDITIONS: md5 pin of the new body; each 147 block exactly once; the 146 lock block still exactly once; every other function of every user schema
-- byte-identical; owner / SECURITY / search_path / ACL / arguments / return of the writer unchanged.
BEGIN;

-- 0. Preconditions and drift guards -------------------------------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' OR octet_length('¬ß') <> 4 OR md5('¬ß') IS DISTINCT FROM '45e0e64ed4f04e4ea4e6e21148e2eadc' THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: this file must be sent as UTF-8 to a UTF8 database (client_encoding %, server_encoding %) -- the embedded live body bytes would not match their md5 pins', current_setting('client_encoding'), current_setting('server_encoding');
  END IF;
  IF to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: mesa_post_refund_v1 is missing -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'mesa_post_refund_v1') <> 1 THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: mesa_post_refund_v1 has an unexpected overload set -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)');
  IF position('-- 147:BEGIN ' IN v_src) > 0 THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: already applied (mesa_post_refund_v1 already carries a 147 block)';
  END IF;
  IF md5(v_src) IS DISTINCT FROM '9679556fe209fbadac5275b3ac71e456' THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: mesa_post_refund_v1 is not the 146 body (md5 %, expected 9679556fe209fbadac5275b3ac71e456) -- the rollout is 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147', md5(v_src);
  END IF;
  IF to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)'))
        IS DISTINCT FROM '94867e165d0732f36ae4692fc6998c58' THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: mesa_post_payment_v1 is not the 145 body 94867e16... whose canonical expressions this migration copies -- resolve drift first';
  END IF;
  IF to_regprocedure('public.order_canonical_obligation_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION refused: public.order_canonical_obligation_v1(uuid) is missing';
  END IF;
END $guard$;

-- Before-state: every function of every user schema, and the posture of the writer (the post-conditions prove nothing else moved).
CREATE TEMP TABLE c147_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c147_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
CREATE TEMP TABLE c147_posture_before ON COMMIT DROP AS
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proretset, p.prorettype::regtype AS rettype, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)');

-- 1. mesa_post_refund_v1: the 146 body with the three canonical blocks -----------------------------------------------------------------------------
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

  -- Closed tables are accepted deliberately (¬ßJ.2 of the contract): a refund never
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
  -- CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122) -- NULL-safe fix, owner-approved
  -- (¬ß5/¬ß28 of the brief). table_session_id is nullable as of this migration; the old
  -- `<>` evaluated to NULL (never TRUE) when the LEFT side was NULL, so a check-centric
  -- transaction (table_session_id IS NULL) could slip past this scope assertion. For
  -- every existing Mesa transaction (table_session_id always non-null) this is
  -- behaviorally IDENTICAL to the old comparison -- not a Mesa semantic change.
  IF v_original.table_session_id IS DISTINCT FROM p_table_session_id THEN
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

  -- 146:BEGIN refund_receipt_pointer_lock
  PERFORM 1
  FROM public.service_session_state
  WHERE singleton = true
  FOR SHARE;
  -- 146:END refund_receipt_pointer_lock
  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;

  -- ¬ßH.4 -- record, don't claim: tarjeta/bizum note that La Dieci is RECORDING an
  -- externally executed return, never that it executed a bank/POS operation.
  v_settlement := CASE WHEN v_original.payment_method = 'efectivo' THEN 'drawer' ELSE 'external' END;

  -- The refund's payment_method is FORCED from the original -- no caller-supplied
  -- method exists in this signature (¬ß9 of the brief, frozen for V1).
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
    -- 147:BEGIN canonical_order_total
    -- R2 (migration 147): the order's total is its CURRENT canonical obligation, the same value mesa_post_payment_v1 uses
    -- (order_canonical_obligation_v1), never the sum of its table_order_lines: a commercial adjustment moves the obligation, never the lines.
    v_order_total_cents := COALESCE((
      SELECT round(public.order_canonical_obligation_v1(o.order_uid) * 100)::bigint
        FROM public.ordenes o WHERE o.id = v_order.order_id AND o.table_session_id = v_session.id), 0);
    -- 147:END canonical_order_total
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
  -- 147:BEGIN canonical_mirror_projection
  -- R2 (migration 147): the cobrado / ya_pagado / metodo_pago projection of mesa_post_payment_v1 (145 body), copied VERBATIM, so both
  -- Mesa writers project the same canonical truth (current obligation vs net collected; an obligation <= 0 is paid when anything is held).
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
  -- 147:END canonical_mirror_projection

  v_remaining_after_cents := v_remaining_cents - v_amount_cents;

  -- 147:BEGIN canonical_table_total
  -- R2 (migration 147): the table total of mesa_post_payment_v1 (145 body), copied VERBATIM (only the INTO target differs): the sum of the
  -- canonical obligations of the table's orders. tableTotal / tableOutstandingAfter are therefore the same numbers the payment writer
  -- would compute for this table right after the refund.
  SELECT COALESCE(round(sum(
      CASE WHEN EXISTS (SELECT 1 FROM public.order_obligations ob WHERE ob.order_uid = o.order_uid)
                OR EXISTS (SELECT 1 FROM public.table_order_lines l
                            WHERE l.table_session_id = v_session.id AND l.order_id = o.id)
           THEN public.order_canonical_obligation_v1(o.order_uid)
           ELSE 0::numeric END) * 100), 0)::bigint
    INTO v_table_total_cents
    FROM public.ordenes o
   WHERE o.table_session_id = v_session.id AND o.order_uid IS NOT NULL;
  -- 147:END canonical_table_total
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

-- 2. Post-conditions -----------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_src text;
  v_blk text;
  v_bad text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)');
  IF md5(v_src) IS DISTINCT FROM '69629f700425ebf48b88cc659c689992' THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION post-condition failed: mesa_post_refund_v1 is not the expected 147 body (md5 %)', md5(v_src);
  END IF;
  FOREACH v_blk IN ARRAY ARRAY['canonical_order_total', 'canonical_mirror_projection', 'canonical_table_total'] LOOP
    IF (length(v_src) - length(replace(v_src, '-- 147:BEGIN ' || v_blk, ''))) / length('-- 147:BEGIN ' || v_blk) <> 1
       OR (length(v_src) - length(replace(v_src, '-- 147:END ' || v_blk, ''))) / length('-- 147:END ' || v_blk) <> 1 THEN
      RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION post-condition failed: block % must be present exactly once', v_blk;
    END IF;
  END LOOP;
  IF (length(v_src) - length(replace(v_src, '-- 147:BEGIN ', ''))) / length('-- 147:BEGIN ') <> 3
     OR (length(v_src) - length(replace(v_src, '-- 146:BEGIN refund_receipt_pointer_lock', ''))) / length('-- 146:BEGIN refund_receipt_pointer_lock') <> 1 THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION post-condition failed: exactly three 147 blocks and the one 146 pointer-lock block are required';
  END IF;
  SELECT string_agg(b.sig, ', ') INTO v_bad
    FROM c147_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE COALESCE(a.sig, b.sig) <> 'mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)' AND COALESCE(a.sig, b.sig) <> 'public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)'
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION post-condition failed: other functions changed (%)', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM c147_posture_before b, pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)')
              AND (p.prosecdef IS DISTINCT FROM b.prosecdef OR p.proconfig IS DISTINCT FROM b.proconfig OR pg_get_userbyid(p.proowner) IS DISTINCT FROM b.owner
                   OR p.proacl::text IS DISTINCT FROM b.acl OR p.proretset IS DISTINCT FROM b.proretset OR p.prorettype::regtype IS DISTINCT FROM b.rettype
                   OR pg_get_function_arguments(p.oid) IS DISTINCT FROM b.args)) THEN
    RAISE EXCEPTION 'MESA_REFUND_CANONICAL_PROJECTION post-condition failed: owner / SECURITY / search_path / ACL / signature / return of mesa_post_refund_v1 changed';
  END IF;
END $post$;

COMMIT;
