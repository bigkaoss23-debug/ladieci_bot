-- migrations/2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.ROLLBACK.sql
-- Paired forward: 2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.sql
--
-- ROLLBACK OF MIGRATION 150. Function-only: removes the three evidence functions, the closeout terminal-close trigger and its function, and
-- restores mesa_post_payment_v1 to the 145 body verbatim. No data is read, written or depends on 150, so this is valid at any time -- but the
-- backend of the same package calls close_service_session_with_evidence_v1: ROLL THE BACKEND BACK FIRST (a Finalizar of the new backend
-- without 150 fails closed at its terminal step: the service stays open, nothing is written). Closeouts committed while 150 was installed are
-- ordinary closeouts and stay. After this rollback the database is exactly the 149 state (certified: catalog byte-equal).
-- REFUSES (fail closed) unless every 150 object is exactly the certified one.
BEGIN;

DO $guard$
DECLARE
  v_pin record;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)', 'a7f89499be50f338607ff64f8778f2ae'),
      ('public.service_close_live_evidence_v1(uuid)', '49163cc1ec55c7f2154e4d76ee77445c'),
      ('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'a25b330f095ff3441bca034e79e750f7'),
      ('public.service_closeout_requires_terminal_close_v1()', 'be58c0f28da316fcb8495be7676c2738'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', '2d6ebfe704559dd5a9a083025fb77057')
    ) AS x(sig, want) LOOP
    IF to_regprocedure(v_pin.sig) IS NULL
       OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS rollback refused: % is missing or is not the certified 150 body % -- resolve drift first', v_pin.sig, v_pin.want;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'service_closeouts_terminal_close_v1' AND t.tgrelid = 'public.service_closeouts'::regclass) <> 1 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS rollback refused: the 150 trigger is not present on service_closeouts -- resolve drift first';
  END IF;
END $guard$;

CREATE TEMP TABLE r150_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO r150_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';

DROP TRIGGER service_closeouts_terminal_close_v1 ON public.service_closeouts;
DROP FUNCTION public.service_closeout_requires_terminal_close_v1();
DROP FUNCTION public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[]);
DROP FUNCTION public.service_close_live_evidence_v1(uuid);
DROP FUNCTION public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb);

-- mesa_post_payment_v1: the 145 body, verbatim ---------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_covers_settled integer DEFAULT NULL::integer, p_line_ids uuid[] DEFAULT NULL::uuid[], p_meta jsonb DEFAULT '{}'::jsonb, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE; v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE; v_tx public.payment_transactions%ROWTYPE;
  v_line record; v_order record; v_total_cents bigint; v_paid_cents bigint; v_outstanding_cents bigint;
  v_amount_cents bigint; v_to_allocate_cents bigint; v_line_remaining_cents bigint; v_allocation_cents bigint;
  v_remaining_covers integer; v_covers_settled integer; v_selected_count integer; v_selected_distinct integer;
  v_selected_matched integer; v_scope text; v_prev_state text; v_new_state text; v_order_total_cents bigint;
  v_order_paid_before_cents bigint; v_order_allocation_cents bigint; v_table_remaining_cents bigint;
  v_order_caps jsonb := '{}'::jsonb; v_order_cap_cents bigint; v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_duplicate_candidate boolean; v_receipt_service_id uuid;
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
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled);
  END IF;
  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NULL THEN RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000'; END IF;

  -- PATCH B (Economic Writer Hardening V1, migration 126; closes N-5 blocker L-1). Lock
  -- every ordenes row of this table session BEFORE the first obligation/outstanding
  -- computation below, in the SAME deterministic order (id) every lock-ordering analysis
  -- in this codebase relies on, so the economic anchor cannot move between this snapshot
  -- and the allocation loop later in this function. Previously this writer only locked
  -- table_sessions and left `ordenes` unlocked until its own final UPDATE at the very end
  -- of the transaction -- exactly the race the legacy writer (E-2) and a raw editor (E-1)
  -- could win against. No payment formula, allocation rule, mode, idempotency key or
  -- refund/mirror semantic changes below this line.
  PERFORM 1 FROM public.ordenes o
   WHERE o.table_session_id = v_session.id
   ORDER BY o.id
   FOR UPDATE;

  SELECT COALESCE(round(sum(
      CASE WHEN EXISTS (SELECT 1 FROM public.order_obligations ob WHERE ob.order_uid = o.order_uid)
                OR EXISTS (SELECT 1 FROM public.table_order_lines l
                            WHERE l.table_session_id = v_session.id AND l.order_id = o.id)
           THEN public.order_canonical_obligation_v1(o.order_uid)
           ELSE 0::numeric END) * 100), 0)::bigint
    INTO v_total_cents
    FROM public.ordenes o
   WHERE o.table_session_id = v_session.id AND o.order_uid IS NOT NULL;
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
    v_amount_cents := v_outstanding_cents; v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED');
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023'; END IF;
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
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
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
       AND pt.kind = 'payment' AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0) AND pt.payment_method = p_payment_method
       AND pt.covers_settled = v_covers_settled
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;
  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'MESA_POSSIBLE_DUPLICATE_PAYMENT' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('PAYMENT_DUPLICATE_CONFIRMED', NULL, p_by_actor,
      jsonb_build_object('tableSessionId', v_session.id, 'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0, 'mode', p_mode, 'paymentMethod', p_payment_method,
        'coversSettled', v_covers_settled));
  END IF;
  -- 145:BEGIN receipt_service_pointer_lock
  -- FINDING A (payment x service close). The receipt service is decided by the SELECT below on the lifecycle pointer. Unlocked, that read
  -- runs on the statement snapshot, where a close that has not committed yet is invisible, while the INSERT that follows only waits on the
  -- service row's foreign key (which proves the row EXISTS, not that it is still open). The pointer row is the row EVERY pointer transition
  -- takes (close and open FOR UPDATE, first-open / realignment UPDATE): holding it FOR SHARE from here to commit orders this payment against
  -- them. A close that committed earlier is seen by the SELECT below (no open service, or the next one); a close that has not is made to wait
  -- for this transaction. Lock order: W < ACTOR < TABLE_SESSION < ENTITY < ORDER < this row < service / business-day parent rows.
  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;
  -- 145:END receipt_service_pointer_lock
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
    SELECT l.id, l.order_id, l.net_amount, o.order_uid,
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
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_allocate_cents <= 0;
    v_line_remaining_cents := v_line.remaining_cents;
    IF v_line_remaining_cents <= 0 THEN CONTINUE; END IF;
    IF NOT (v_order_caps ? v_line.order_id) THEN
      v_order_cap_cents := GREATEST(0,
        round(public.order_canonical_obligation_v1(v_line.order_uid) * 100)::bigint
        - COALESCE((
            SELECT sum(CASE WHEN t.kind='refund' THEN -round(a.amount*100)::bigint
                            ELSE round(a.amount*100)::bigint END)
              FROM public.payment_allocations a
              JOIN public.payment_transactions t ON t.id=a.payment_transaction_id
             WHERE a.order_id = v_line.order_id AND t.table_session_id = v_session.id
          ), 0));
      v_order_caps := v_order_caps || jsonb_build_object(v_line.order_id, v_order_cap_cents);
    END IF;
    v_order_cap_cents := (v_order_caps->>v_line.order_id)::bigint;
    IF v_order_cap_cents <= 0 THEN CONTINUE; END IF;
    v_allocation_cents := LEAST(v_to_allocate_cents, v_line_remaining_cents, v_order_cap_cents);
    IF v_allocation_cents <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_tx.id, v_line.id, v_line.order_id, v_allocation_cents / 100.0, v_now);
    v_to_allocate_cents := v_to_allocate_cents - v_allocation_cents;
    v_order_caps := jsonb_set(v_order_caps, ARRAY[v_line.order_id],
                              to_jsonb(v_order_cap_cents - v_allocation_cents));
  END LOOP;
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents,
      o.service_session_id AS obligation_service_session_id, o.order_uid
      FROM public.payment_allocations a
      JOIN public.ordenes o ON o.id = a.order_id AND o.table_session_id = v_session.id
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id, o.service_session_id, o.order_uid ORDER BY a.order_id
  LOOP
    v_order_total_cents := round(public.order_canonical_obligation_v1(v_order.order_uid) * 100)::bigint;
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
  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;
  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    'overCollected', GREATEST(0, (v_paid_cents + v_amount_cents - v_total_cents)) / 100.0,
    'tableStatus', 'open'
  );
END
$function$;

DO $post$
DECLARE
  v_bad text;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)')) IS DISTINCT FROM '94867e165d0732f36ae4692fc6998c58' THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS rollback post-condition failed: mesa_post_payment_v1 is not the 145 body 94867e16...';
  END IF;
  IF to_regprocedure('public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)') IS NOT NULL OR to_regprocedure('public.service_close_live_evidence_v1(uuid)') IS NOT NULL
     OR to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])') IS NOT NULL
     OR to_regprocedure('public.service_closeout_requires_terminal_close_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'service_closeouts_terminal_close_v1') THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS rollback post-condition failed: a 150 object is still present';
  END IF;
  SELECT string_agg(COALESCE(a.sig, b.sig), ', ') INTO v_bad
    FROM r150_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE regexp_replace(COALESCE(a.sig, b.sig), '^public\.', '') NOT IN ('service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)', 'service_close_live_evidence_v1(uuid)',
                                        'close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'service_closeout_requires_terminal_close_v1()',
                                        'mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)')
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS rollback post-condition failed: other functions changed (%)', v_bad;
  END IF;
END $post$;

COMMIT;
