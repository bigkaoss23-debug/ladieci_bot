-- migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql
-- Rolls migration 140 back to the EXACT post-139 state:
--   * payment_transactions_by_role_check is restored to the exact V3-H definition (no 'rider'); the constraint comment
--     introduced by 140 disappears with the constraint. Nothing else on the table is touched;
--   * order_post_payment_v1 is restored to the ledger-139 body (md5 af52d59658719bd7898d9cd88dd29179, verbatim from the
--     migration-139 file): no rider attestation;
--   * the 8-argument rider_collect_and_complete_stop is dropped and the 7-argument ledger-135 function is recreated
--     verbatim from the migration-135 file (md5 4b2b4f4ce6155deea2e7f15a74f7707c), owner postgres, EXECUTE for
--     service_role only (the grant set of migration S2-7D6E3A);
--   * public._ledger_write_payment is recreated verbatim from the migration-126 file (md5
--     94fa5265c0ad334b79f3f00228f8300d = staging live at ledger 139), owner postgres, EXECUTE for service_role only.
--
-- REFUSES while ANY payment_transactions row authored by a rider exists (by_role = 'rider'). Those rows are append-only
-- MONEY FACTS (the append-only trigger forbids rewriting them, and re-attributing them to an operator would be exactly
-- the impersonation this migration exists to avoid); the V3-H constraint would reject them, so restoring it would fail on
-- its own validation. This file refuses first, with a typed message, and changes nothing. Past that point recovery is
-- backend-first (redeploy the previous backend: its 7 named arguments still reach the 140 function through the DEFAULT),
-- never a DB rewrite.
--
-- ORDER. Migration 139's own rollback pins the 139 body of order_post_payment_v1, so it refuses while 140 is applied:
-- roll back 140 first, then (if ever) 139.
-- STAGING ONLY. NOT applied by the session that authored it.

BEGIN;

DO $guard$
DECLARE
  v_src text;
  v_n   integer;
BEGIN
  IF to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)') IS NULL
     OR to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NOT NULL
     OR to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'B_RID_1 rollback refused: migration 140 is not fully applied (8-argument rider RPC missing, or a 7-argument rider RPC / _ledger_write_payment exists) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)');
  IF md5(v_src) IS DISTINCT FROM '4a4494aa8b579c64a9d943c7573e5ede' THEN
    RAISE EXCEPTION 'B_RID_1 rollback refused: rider_collect_and_complete_stop is not the exact 140 body (md5 mismatch) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');
  IF md5(v_src) IS DISTINCT FROM 'ea4fe577feddbd2ba6f6ae42695feba6' THEN
    RAISE EXCEPTION 'B_RID_1 rollback refused: order_post_payment_v1 is not the exact 140 body (md5 mismatch) -- resolve drift first';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_by_role_check')
       IS DISTINCT FROM 'CHECK (((by_role = ANY (ARRAY[''admin''::text, ''operator''::text, ''owner''::text, ''cashier''::text, ''legacy_operator''::text])) OR ((by_role = ''rider''::text) AND (kind = ''payment''::text) AND (mode = ''full''::text) AND (table_session_id IS NULL) AND (covers_settled = 0) AND COALESCE(((meta -> ''source''::text) = ''"rider_delivery"''::jsonb), false))))' THEN
    RAISE EXCEPTION 'B_RID_1 rollback refused: payment_transactions_by_role_check is not the exact 140 constraint -- resolve drift first';
  END IF;
  IF md5(COALESCE((SELECT obj_description(c.oid, 'pg_constraint') FROM pg_constraint c
                    WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_by_role_check'), ''))
       IS DISTINCT FROM 'b35d7baffb7655d25448617c072c428f' THEN
    RAISE EXCEPTION 'B_RID_1 rollback refused: the payment_transactions_by_role_check comment is not the exact 140 text -- resolve drift first';
  END IF;
  -- Serialize with concurrent payments, then look for rider-authored money facts (the shape the V3-H constraint cannot hold).
  LOCK TABLE public.payment_transactions IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_n FROM public.payment_transactions WHERE by_role = 'rider';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'B_RID_1 rollback refused: % payment transaction(s) authored by a rider exist. They are append-only money facts: the pre-140 constraint would reject them and a rollback must not rewrite or re-attribute them', v_n;
  END IF;
END $guard$;

-- Everything on payment_transactions the rollback must NOT change (all but the role constraint and its comment).
CREATE TEMP TABLE brid140rb_pt_before (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO brid140rb_pt_before VALUES
  ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                          FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_by_role_check')),
  ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
  ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
  ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
  ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                         WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
  ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));

-- 1. payment_transactions_by_role_check -- back to the exact V3-H definition ---------------------------------------
ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_by_role_check;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_by_role_check
  CHECK (by_role IN ('admin', 'operator', 'owner', 'cashier', 'legacy_operator'));

-- 2. order_post_payment_v1 -- back to the ledger-139 body (verbatim from migration 139) -----------------------------
CREATE OR REPLACE FUNCTION public.order_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_order_uid uuid, p_payment_method text, p_mode text, p_amount numeric, p_client_request_id text, p_request_hash text, p_meta jsonb, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_entity public.order_entities%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_tx public.payment_transactions%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_obligation_cents bigint;
  v_paid_before_cents bigint;
  v_outstanding_cents bigint;
  v_amount_cents bigint;
  v_receipt_service_id uuid;
  v_duplicate_candidate boolean;
  v_prev_state text;
  v_new_state text;
  v_new_paid_cents bigint;
  v_scope text;
  v_method_count integer;
  v_method_max text;
  v_is_paid boolean;
  v_method_projection text;
BEGIN
  IF p_workspace_id IS NULL OR p_order_uid IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_payment_method NOT IN ('efectivo','tarjeta','bizum')
     OR p_mode NOT IN ('full','custom_amount')
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'ORDER_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- Preserve the existing Servicio payment gate exactly (order_mark_paid):
  -- admin/operator ONLY. Do NOT widen to Mesa's broader PAYMENT_ROLES
  -- (owner/cashier/legacy_operator) -- an authorization change this slice
  -- does not own (frozen brief §25).
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','operator')
  THEN RAISE EXCEPTION 'ORDER_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method, 'mode', v_existing.mode,
      'orderUid', p_order_uid);
  END IF;

  -- The permanent identity anchor -- resolves workspace/service/display id
  -- without trusting the client. A Mesa order's entity carries a non-null
  -- table_session_id; refuse it here so a table order can never bypass
  -- mesa_post_payment_v1's covers/line authority through this route.
  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_entity.workspace_id <> p_workspace_id THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;
  IF v_entity.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE='22023',
      DETAIL = format('order_uid=%s table_session=%s', p_order_uid, v_entity.table_session_id);
  END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Economic Writer Hardening V1 (migration 126) — refuse a cancelled/annulled order
  -- BEFORE any money fact is created. order_cancel_v1 already revises the obligation to 0,
  -- so ORDER_PAYMENT_ALREADY_SETTLED would eventually catch a zero-outstanding order too --
  -- but a cancelled order predating N-2 (fallback totale, no obligation row) or one
  -- cancelled while still carrying an outstanding balance must never be allowed to look
  -- like an ordinary payment. No payment_transaction, allocation, OFE row or mirror update
  -- happens.
  IF upper(COALESCE(v_ord.estado, '')) IN ('CANCELADO', 'CANCELLED', 'ANULADO') THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_CANCELLED' USING ERRCODE='22023',
      DETAIL = format('order_uid=%s estado=%s -- payment refused on a cancelled/annulled order', p_order_uid, v_ord.estado);
  END IF;

  v_obligation_cents := round(public.order_canonical_obligation_v1(p_order_uid) * 100)::bigint;
  SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100), 0)::bigint
    INTO v_paid_before_cents
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund');
  v_outstanding_cents := GREATEST(0, v_obligation_cents - v_paid_before_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'ORDER_PAYMENT_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;

  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents;
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
  END IF;
  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions pt
    JOIN public.payment_allocations pa ON pa.payment_transaction_id = pt.id
     WHERE pa.order_uid = p_order_uid
       AND pt.client_request_id <> p_client_request_id
       AND pt.kind = 'payment' AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0) AND pt.payment_method = p_payment_method
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;
  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_POSSIBLE_DUPLICATE' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('PAYMENT_DUPLICATE_CONFIRMED', NULL, p_by_actor,
      jsonb_build_object('orderUid', p_order_uid, 'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0, 'mode', p_mode, 'paymentMethod', p_payment_method));
  END IF;

  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;
  -- 139:BEGIN off_service_receipt
  -- DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139), correction B2 (Option A). Migration 122 refused every order payment
  -- while no service was open (ORDER_PAYMENT_NO_OPEN_SERVICE). That is the wrong rule for the business: an authorized
  -- admin/operator who certifies that the customer paid must be able to record the economic FACT even when no service
  -- is open right now (a delivery finalized with the rider still out is settled after the close, typically with no
  -- service open). The receipt is then an OFF-SERVICE receipt and the contract is the historical one (migration S2):
  --   order_financial_events.service_session_id        = the ORDER's service (obligation; set by trigger, never moved)
  --   payment_transactions.service_session_id          = v_receipt_service_id -> NULL: no service received this money
  --   order_financial_events.event_service_session_id  = v_receipt_service_id -> NULL: the SAME fact
  -- v_receipt_service_id is written UNCHANGED to both receipt columns (the two INSERTs below are byte-identical to
  -- ledger 126); the order's own service is NEVER used as a receipt or as a scope anchor. payment_transactions_scope_chk
  -- admits the scope-less row only for a payment carrying meta.off_service_receipt = true, so that flag is decided HERE,
  -- by the writer alone: whatever the caller supplied under that key is discarded first, and it is set only when no
  -- service is open. With a service open the behaviour is byte-for-byte what it was (receipt service = the open one).
  v_meta := v_meta - 'off_service_receipt';
  IF v_receipt_service_id IS NULL THEN
    IF v_ord.service_session_id IS NULL THEN
      RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000';
    END IF;
    v_meta := v_meta || jsonb_build_object('off_service_receipt', true);
    IF length(v_meta::text) > 2048 THEN
      RAISE EXCEPTION 'ORDER_PAYMENT_INVALID' USING ERRCODE='22023';
    END IF;
  END IF;
  -- 139:END off_service_receipt

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, 0,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;

  -- ONE allocation, order_uid-targeted -- the check-centric invariant (§8/§11/
  -- §28 of the brief): one payment_transactions row = one physical money
  -- movement; for a check, that movement is imputed to exactly one order.
  INSERT INTO public.payment_allocations(
    payment_transaction_id, table_order_line_id, order_id, order_uid, amount, created_at
  ) VALUES (v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now);

  v_new_paid_cents := v_paid_before_cents + v_amount_cents;
  v_prev_state := CASE
    WHEN v_paid_before_cents <= 0 THEN 'unpaid'
    WHEN v_paid_before_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_new_state := CASE
    WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_scope := 'order_' || replace(v_tx.id::text, '-', '');

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
    event_service_session_id, payment_transaction_id, created_at
  )
  SELECT o.id, 'payment', v_amount_cents / 100.0, p_payment_method,
    NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
    v_prev_state, v_new_state, NULL, NULL,
    jsonb_build_object('source','order','mode',p_mode,'transaction_id',v_tx.id),
    v_scope,
    encode(digest(concat_ws('|', o.id, v_tx.id::text, v_amount_cents::text,
      p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
    o.service_session_id, v_receipt_service_id, v_tx.id, v_now
  FROM public.ordenes o WHERE o.order_uid = p_order_uid;

  -- Same compatibility-mirror projection mesa_post_payment_v1 uses (§12 of
  -- the brief): 'MIXTO' on mixed tender, computed from order_financial_events
  -- so a legacy event-only collection is never lost from the projection.
  SELECT count(DISTINCT e.payment_method), max(e.payment_method)
    INTO v_method_count, v_method_max
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported');
  v_is_paid := CASE WHEN v_obligation_cents <= 0 THEN v_new_paid_cents > 0
                     ELSE v_new_paid_cents >= v_obligation_cents END;
  v_method_projection := CASE WHEN v_method_count > 1 THEN 'MIXTO' ELSE v_method_max END;

  UPDATE public.ordenes SET
    cobrado = v_is_paid, ya_pagado = v_is_paid,
    metodo_pago = CASE WHEN v_is_paid THEN v_method_projection ELSE COALESCE(metodo_pago,'') END
  WHERE order_uid = p_order_uid;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'orderUid', p_order_uid, 'displayOrderId', v_entity.display_order_id,
    'currentObligation', v_obligation_cents / 100.0,
    'netCollectedBefore', v_paid_before_cents / 100.0,
    'netCollectedAfter', v_new_paid_cents / 100.0,
    'unpaid', GREATEST(0, v_obligation_cents - v_new_paid_cents) / 100.0,
    'overCollected', GREATEST(0, v_new_paid_cents - v_obligation_cents) / 100.0,
    'serviceSessionId', v_receipt_service_id
  );
END;
$function$;

-- 3. _ledger_write_payment -- recreated verbatim from migration 126 ------------------------------------------------
CREATE OR REPLACE FUNCTION public._ledger_write_payment(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_by_role text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text := p_by_role; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
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

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;

  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_role IS NULL OR btrim(v_role) = '' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- E-2 (Economic Writer Hardening V1, migration 126). This legacy family is the only
  -- payment authority that incasses ordenes.totale instead of the canonical obligation
  -- (F-1/F-2 of the audit). Refuse BEFORE the idempotency replay lookup or anything else:
  --   (a) Mesa orders have their own canonical, per-line writer (mesa_post_payment_v1) and
  --       must never be reachable by an unfenced legacy path (N-5 blocker L-1);
  --   (b) any order whose canonical obligation has diverged from totale (a commercial
  --       adjustment or a cancellation happened) would be over- or under-charged by a
  --       totale-based collection.
  -- The normal, still-required rider path (non-Mesa, obligation == totale, no adjustment)
  -- is completely unaffected: both conditions below are false for it.
  IF v_ord.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_COLLECTION_NOT_ALLOWED' USING ERRCODE='22023',
      DETAIL = format('order_id=%s is Mesa-owned (table_session_id=%s) -- legacy OFE-only collection is not permitted on table orders', p_order_id, v_ord.table_session_id);
  END IF;
  IF round(public.order_canonical_obligation_v1(v_ord.order_uid), 2) IS DISTINCT FROM round(v_ord.totale, 2) THEN
    RAISE EXCEPTION 'LEGACY_COLLECTION_NOT_ALLOWED' USING ERRCODE='22023',
      DETAIL = format('order_id=%s canonical_obligation=%s totale=%s -- legacy collection refused: the canonical obligation has diverged from the order total',
                       p_order_id, round(public.order_canonical_obligation_v1(v_ord.order_uid), 2), round(v_ord.totale, 2));
  END IF;

  -- Same-scope replay is based on immutable event snapshots, not mutable order fields.
  -- Scoped by service_session_id (IS NOT DISTINCT FROM handles the legacy NULL-session
  -- case) to match the partitioned unique indexes from 2026-07-26_two_service_identity.sql
  -- (order_financial_events_one_payment_session_uq / _legacy_uq): an order id/number
  -- recycled into a LATER service session must never match an EARLIER session's event.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'payment'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM false
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_existing.amount, 'payment_method', v_method, 'legacy', false))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    -- A different actor/role/amount under the same key is a genuine conflict, never a
    -- silent second charge. This is what refuses a rider collection followed by an
    -- operator one on the same order.
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  -- SERVER-DERIVED amount. No caller — Node, rider or operator — can supply or override it.
  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  -- Key order and value types are byte-significant: the digest is sha256 over the jsonb
  -- text. Reproduced EXACTLY as in 2026-07-19_b7_payment_basis_historical_replay_fix.sql.
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  -- Same session-scoping as the replay check above: one basis per order PER SESSION, so a
  -- recycled order id/number starts a fresh basis in a later session instead of colliding
  -- with a since-archived one.
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment', v_amount, v_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method
   WHERE id = p_order_id;

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

ALTER FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text) TO service_role;

-- 4. rider_collect_and_complete_stop -- back to the 7-argument ledger-135 function (verbatim from migration 135) -----
DROP FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text);

CREATE OR REPLACE FUNCTION public.rider_collect_and_complete_stop(
  p_order_id text, p_metodo_pago text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_by       public.auth_actors%ROWTYPE;
  v_ds       jsonb;
  v_active   jsonb;
  v_canon    jsonb;
  v_estado   text;
  v_updated  int;
  v_method   text;
  v_meta     jsonb;
  v_pay      jsonb := NULL;
  v_pay_note text := NULL;
BEGIN
  v_method := lower(btrim(COALESCE(p_metodo_pago, '')));

  -- Only real door-collection methods. Anything else (notably the operator override
  -- "manual", or an empty string for an already-prepaid order) means NO money is claimed:
  -- the stop still completes, but nothing is written to the ledger and no flag is invented.
  IF v_method <> '' AND v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_METHOD_INVALID');
  END IF;

  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- L0 (W6.1 protocol) -- MOVED UP by W6.3, from after the auth_actors row lock to here:
  -- after pure input validation, before EVERY other lock. trip_authority.trips.rider_actor
  -- has a FOREIGN KEY to auth_actors, so start_rider_trip_v2's INSERT implicitly takes
  -- FOR KEY SHARE on the rider's actor row; with the old ordering that was a real ABBA
  -- deadlock against the FOR UPDATE below the moment v2 went live. Nothing else about
  -- this function's ordering, refusal codes or lock strengths changes.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  -- IDENTITY. Role must be exactly 'rider' — this contract never serves admin/operator,
  -- and never lets a rider borrow their authority.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  -- W6.3 -- ASSIGNMENT. The order must belong to the currently active delivery.
  -- Membership is the rider's authority to collect on it; without this any rider could
  -- pay off any order. When a CANONICAL trip exists, trip_authority.trip_members is that
  -- authority and DRIVER_STATO is only a compatibility projection, so the canonical path
  -- always wins. With no canonical trip the pre-135 legacy path runs unchanged, so an
  -- in-flight pre-cutover DRIVER_STATO trip can still be collected and closed safely.
  -- A display order id that does not resolve to a frozen member is NON_MEMBER on both
  -- paths -- identical to the legacy behaviour for an id absent from the snapshot.
  v_canon := public.trip_authority_active_trip_v1();
  IF COALESCE((v_canon->>'exists')::boolean, false) THEN
    IF NOT (v_canon->'member_order_ids' ? p_order_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
    END IF;
  ELSE
    IF v_active IS NULL OR jsonb_typeof(v_active) <> 'object' OR (v_active->>'status') <> 'ACTIVE' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
    END IF;
    IF NOT (v_active->'order_ids' ? p_order_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
    END IF;
  END IF;

  SELECT estado INTO v_estado FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Server-forced provenance. The client cannot claim a different source.
  v_meta := COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', 'rider_delivery');

  IF v_estado = 'RETIRADO' THEN
    -- Operative replay. The collection may still need reconciling: a rider whose first
    -- request completed the stop but died before the money was recorded must be able to
    -- retry. The deterministic key makes an honest retry a digest-identical replay.
    IF v_method <> '' THEN
      BEGIN
        v_pay := public._ledger_write_payment(
          p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
        v_pay_note := SQLERRM;
        IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
        END IF;
      END;
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id,
                              'payment', v_pay, 'payment_note', v_pay_note);
  END IF;

  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  -- MONEY FIRST. A refusal here returns before the stop is completed, and the subtransaction
  -- has already rolled the attempted payment back: nothing half-written either way.
  -- AUTH_LEGACY_IMPORT_REQUIRED is the single tolerated refusal — that money is already on
  -- record in the pre-ledger representation, and re-recording it would double-count.
  IF v_method <> '' THEN
    BEGIN
      v_pay := public._ledger_write_payment(
        p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
      v_pay_note := SQLERRM;
      IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
      END IF;
    END;
  END IF;

  -- OPERATIVE completion ONLY. cobrado / metodo_pago are deliberately absent here:
  -- RETIRADO does not mean paid, and _ledger_write_payment is the sole writer of those
  -- columns. A prepaid or unpaid-on-delivery stop completes with the flags untouched.
  UPDATE public.ordenes
    SET estado       = 'RETIRADO',
        hora_entrega = (extract(epoch FROM now()) * 1000)::bigint
  WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Lost the race after taking the money: ABORT so the recorded payment cannot survive
    -- a stop that did not complete. Must RAISE, never RETURN.
    RAISE EXCEPTION 'RIDER_STOP_LOST_RACE' USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id,
                            'payment', v_pay, 'payment_note', v_pay_note);
END;
$fn$;

ALTER FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text) TO service_role;

-- 5. Post-conditions -------------------------------------------------------------------------------------------------
DO $post$
BEGIN
  IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)')))
       IS DISTINCT FROM '4b2b4f4ce6155deea2e7f15a74f7707c'
     OR to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'B_RID_1 rollback post-condition failed: rider_collect_and_complete_stop is not the exact ledger-135 function';
  END IF;
  IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)')))
       IS DISTINCT FROM '94fa5265c0ad334b79f3f00228f8300d' THEN
    RAISE EXCEPTION 'B_RID_1 rollback post-condition failed: _ledger_write_payment is not the exact ledger-126 body';
  END IF;
  IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)')))
       IS DISTINCT FROM 'af52d59658719bd7898d9cd88dd29179' THEN
    RAISE EXCEPTION 'B_RID_1 rollback post-condition failed: order_post_payment_v1 is not the exact ledger-139 body';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_by_role_check')
       IS DISTINCT FROM 'CHECK ((by_role = ANY (ARRAY[''admin''::text, ''operator''::text, ''owner''::text, ''cashier''::text, ''legacy_operator''::text])))'
     OR EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass
                   AND c.conname = 'payment_transactions_by_role_check' AND obj_description(c.oid, 'pg_constraint') IS NOT NULL) THEN
    RAISE EXCEPTION 'B_RID_1 rollback post-condition failed: payment_transactions_by_role_check is not the exact V3-H constraint (or kept a comment)';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'))
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
     OR (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)'))
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'B_RID_1 rollback post-condition failed: the restored functions must be owned by postgres with EXECUTE for service_role only';
  END IF;
  CREATE TEMP TABLE brid140rb_pt_after (k text PRIMARY KEY, v text) ON COMMIT DROP;
  INSERT INTO brid140rb_pt_after VALUES
    ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                            FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_by_role_check')),
    ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
    ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
    ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
    ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                           WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
    ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));
  IF EXISTS (SELECT 1 FROM brid140rb_pt_before b JOIN brid140rb_pt_after a USING (k) WHERE a.v IS DISTINCT FROM b.v) THEN
    RAISE EXCEPTION 'B_RID_1 rollback post-condition failed: something on payment_transactions other than payment_transactions_by_role_check moved';
  END IF;
END $post$;

COMMIT;
