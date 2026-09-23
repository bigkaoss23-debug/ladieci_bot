-- migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.ROLLBACK.sql
-- Rolls migration 139 back to the EXACT post-138 state (NOT to the pre-138 state): migration 138 stays applied.
--   * close_service_session_v3 is restored to the ledger-138 body (md5 3051158274094b46d668481b0dbdbdc5, taken
--     verbatim from the 138 migration file), i.e. the active-trip refusal returns;
--   * operator_confirm_delivery_v1 and trip_residual_scope_v1 are dropped;
--   * order_post_payment_v1 is restored to the ledger-126 body (md5 778cd30008632707e47a372e6afa5640, taken verbatim
--     from the migration-126 file), i.e. an order payment is again refused while no service is open
--     (ORDER_PAYMENT_NO_OPEN_SERVICE);
--   * payment_transactions_scope_chk is restored to the exact migration-122 definition
--     CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL))), the constraint comment introduced
--     by 139 disappears with the constraint, and the two column comments (service_session_id: S2; table_session_id:
--     migration 122) are restored verbatim. Nothing else on the table is touched.
-- Rows already written by operator_confirm_delivery_v1 (ledger events, payment transactions, orden_estado_logs)
-- are ordinary canonical facts and are intentionally left in place.
--
-- REFUSES when ANY off-service payment receipt exists (payment_transactions with neither table_session_id nor
-- service_session_id -- the shape only 139 admits). Those rows are append-only MONEY FACTS: a rollback can neither
-- rewrite them (the append-only trigger forbids it, and inventing a service for them is exactly the wrong contract this
-- migration corrects) nor keep them under the old constraint, which would reject them. Restoring the old constraint
-- would fail on its own validation; this file refuses first, with a typed message, and changes nothing.
--
-- REFUSES when it would strand a trip: with 138 semantics a CLOSED service that still owns an ACTIVE trip is the
-- exact state 138 called unrecoverable (the trip is invisible to every operational scope and blocks every later
-- departure). Complete/close that trip first (the rider's Entregado, or Driver volvió) and roll back afterwards.
-- STAGING ONLY. NOT applied by the session that authored it.

BEGIN;

DO $guard$
DECLARE
  v_src text;
  v_n   integer;
BEGIN
  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.operator_confirm_delivery_v1(text,text,integer,jsonb)') IS NULL
     OR to_regprocedure('public.trip_residual_scope_v1()') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: migration 139 is not fully applied (an object is missing) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)');
  IF md5(v_src) IS DISTINCT FROM 'a6680181760dd8dabfa29aa43c786906' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: close_service_session_v3 is not the exact ledger-139 body (md5 mismatch) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])');
  IF md5(v_src) IS DISTINCT FROM '0323fbb1bab76a12fd2be3fed0b3187e' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: start_rider_trip_v2 is not the exact ledger-138 body -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');
  IF md5(v_src) IS DISTINCT FROM 'af52d59658719bd7898d9cd88dd29179' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: order_post_payment_v1 is not the exact 139 body (md5 mismatch) -- resolve drift first';
  END IF;

  -- B2 (Option A): the constraint and the comments to be restored must currently be exactly what 139 installed.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk')
       IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL) OR ((table_session_id IS NULL) AND (service_session_id IS NULL) AND (kind = ''payment''::text) AND (mode = ANY (ARRAY[''full''::text, ''custom_amount''::text])) AND (covers_settled = 0) AND COALESCE(((meta -> ''off_service_receipt''::text) = ''true''::jsonb), false))))' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: payment_transactions_scope_chk is not the exact 139 constraint -- resolve drift first';
  END IF;
  IF md5(COALESCE((SELECT obj_description(c.oid, 'pg_constraint') FROM pg_constraint c
                    WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk'), ''))
       IS DISTINCT FROM 'ce5acd99d9e8383d42b792948afdd5b7'
     OR md5(COALESCE(col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'service_session_id')), ''))
       IS DISTINCT FROM '9d13c6006aa59f96efd6988b6bdb3225'
     OR md5(COALESCE(col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'table_session_id')), ''))
       IS DISTINCT FROM '85485ad4bafc274d70f902ddd3cb3f13' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: a payment_transactions comment is not the exact 139 text -- resolve drift first';
  END IF;
  -- Serialize with concurrent payments, then look for off-service receipts (the shape the old constraint cannot hold).
  LOCK TABLE public.payment_transactions IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_n FROM public.payment_transactions WHERE table_session_id IS NULL AND service_session_id IS NULL;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: % off-service payment receipt(s) exist (payment_transactions with neither table_session_id nor service_session_id). They are append-only money facts: the pre-139 constraint would reject them and a rollback must not rewrite or invent a service for them', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM trip_authority.trips t
    JOIN public.service_sessions s ON s.id = t.service_session_id
   WHERE t.status = 'ACTIVE' AND s.status <> 'open';
  IF v_n > 0 THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: % ACTIVE trip(s) belong to a service that is not open -- complete or close them first (with the 138 semantics they would become unrecoverable)', v_n;
  END IF;
END $guard$;

-- The security posture close_service_session_v3 must keep (CREATE OR REPLACE preserves it; re-asserted below).
CREATE TEMP TABLE dec139rb_before (proname text, owner name, prosecdef boolean, proconfig text[], acl text) ON COMMIT DROP;
INSERT INTO dec139rb_before
  SELECT p.proname, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig, p.proacl::text
    FROM pg_proc p WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                                   'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure);

-- Everything on payment_transactions the rollback must NOT change (all but the scope constraint and the two comments).
CREATE TEMP TABLE dec139rb_pt_before (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO dec139rb_pt_before VALUES
  ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                          FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_scope_chk')),
  ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
  ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
  ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
  ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                         WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
  ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));

-- 1. close_service_session_v3 -- back to the ledger-138 body (verbatim from migration 138) ----
CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_trip    jsonb; -- 138:DECL
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  -- 138:BEGIN close_l0
  -- ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) -- step 1 of 2: the dispatch lock (L0).
  -- Every trip writer (start_rider_trip_v2, close_rider_trip, rider_collect_and_complete_stop and
  -- the Giro Authority commands) already takes L0 as its FIRST statement. This close takes it
  -- here -- after the lifecycle lock and BEFORE the first row lock below -- so a close and a trip
  -- start are serialized by the SAME lock: whichever acquires L0 first decides, and the other one
  -- then judges the COMMITTED result of the first. Lock order of this function is now:
  -- lifecycle -> L0 -> service_session_state -> service_sessions -> business_day_lifecycle_state.
  -- No function takes L0 and then the lifecycle lock (checked against every live body), so no
  -- ABBA cycle exists. The intent sweep at the end of this function also reaches L0 (re-entrant in
  -- the same session, so a no-op from now on); were it to run, it would have taken L0 LATE, already
  -- holding the session row lock that the trip INSERT's foreign key needs -- the inverse order.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  -- 138:END close_l0

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'closed' THEN
    IF v_state.recent_closed_session_id = v_session.id AND v_state.current_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS');
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE service_session_id = p_service_session_id
       AND closeout_correlation_id = p_closeout_correlation_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_NOT_FOUND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
       AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;

  -- 138:BEGIN close_active_trip
  -- ACTIVE_TRIP_SERVICE_CLOSE_EXCLUSION (migration 138) -- step 2 of 2: the exclusion itself.
  -- A service must not become 'closed' while a canonical rider trip is ACTIVE for it. It is judged
  -- HERE, under L0, after every pre-existing check (so no earlier refusal and not the idempotent
  -- ALREADY_CLOSED answer change) and immediately before the terminal transition. The trip is read
  -- through public.trip_projection_v1 -- the SAME projection the backend preflight uses, and the
  -- only way in: this function is SECURITY INVOKER and trip_authority has no USAGE for
  -- service_role -- scoped to exactly this service (attribution is the trip's own
  -- service_session_id; rider_actor is never read, so an operator-dispatched trip blocks like a
  -- rider-dispatched one). Fail closed: anything other than a well-formed { ok:true, active:false }
  -- refuses the close. A refusal writes nothing and never touches the trip.
  SELECT public.trip_projection_v1(ARRAY[v_session.id]) INTO v_trip;
  IF v_trip IS NULL OR (v_trip->>'ok') IS DISTINCT FROM 'true'
     OR jsonb_typeof(v_trip->'active') IS DISTINCT FROM 'boolean' THEN
    RETURN jsonb_build_object('ok',false,'code','V3_CLOSE_RIDER_TRIP_UNVERIFIABLE','service_session_id',v_session.id);
  END IF;
  IF (v_trip->>'active')::boolean THEN
    RETURN jsonb_build_object('ok',false,'code','V3_CLOSE_ACTIVE_RIDER_TRIP',
      'service_session_id',v_session.id,'trip',v_trip - 'ok' - 'active');
  END IF;
  -- 138:END close_active_trip

  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id = NULL, updated_at = now() WHERE singleton = true;
  END IF;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  -- W5 INTENT ACTIVATION V1 -- giro intent close-sweep. Best-effort, own
  -- exception scope: a failure here must never roll back or block the close
  -- above, which has already fully committed its own writes by this point.
  -- The nil-UUID sentinel scope is deliberately never a real session id, so
  -- consume's own service_session_id membership check (unconditional, runs
  -- before any estado/eligibility branch) forces EXPIRED/SERVICE_CLOSED for
  -- every match -- never CONSUMED, never a Giro attachment.
  BEGIN
    PERFORM public.giro_authority_consume_intent_v1(
      gi.order_uid, 'giro_intent_service_close_sweep',
      ARRAY['00000000-0000-0000-0000-000000000000'::uuid])
    FROM giro_authority.giro_intents gi
    JOIN public.ordenes o ON o.order_uid = gi.order_uid
    WHERE gi.status = 'PENDING' AND o.service_session_id = v_session.id;
  EXCEPTION WHEN others THEN
    NULL;
  END;

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

-- 1b. order_post_payment_v1 -- back to the ledger-126 body (verbatim from migration 126) ---------
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
  IF v_receipt_service_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000'; END IF;

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

-- 2. The two objects migration 139 added ------------------------------------------------------
DROP FUNCTION public.operator_confirm_delivery_v1(text, text, integer, jsonb);
DROP FUNCTION public.trip_residual_scope_v1();

-- 3. payment_transactions -- the migration-122 scope constraint and the S2 / 122 column comments, verbatim ----
-- The guard above proved that no scope-less row exists, so the old constraint validates. Dropping the 139 constraint drops
-- its comment with it: the restored constraint has NO comment, exactly as on staging at ledger 138.
ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_scope_chk;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk
  CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL);
COMMENT ON COLUMN public.payment_transactions.service_session_id IS
  'RECEIPT SERVICE: the service session open at the moment the money was received. '
  'NULL = off-service receipt (no session open). NEVER the table''s origin service. '
  'Physical rename to receipt_service_session_id lands in S14.';
COMMENT ON COLUMN public.payment_transactions.table_session_id IS
  'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction always carries at least one scope (table_session_id for Mesa, service_session_id for check-centric).';

-- 4. Post-conditions ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure))
       IS DISTINCT FROM '3051158274094b46d668481b0dbdbdc5' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: close_service_session_v3 is not the exact ledger-138 body';
  END IF;
  IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure))
       IS DISTINCT FROM '778cd30008632707e47a372e6afa5640' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: order_post_payment_v1 is not the exact ledger-126 body';
  END IF;
  IF to_regprocedure('public.operator_confirm_delivery_v1(text,text,integer,jsonb)') IS NOT NULL
     OR to_regprocedure('public.trip_residual_scope_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: a 139 object survived';
  END IF;
  -- payment_transactions is back to the exact migration-122 / S2 state: the constraint, no constraint comment, both column
  -- comments verbatim, and nothing else on the table moved.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk')
       IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: payment_transactions_scope_chk is not the exact migration-122 constraint';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND obj_description(c.oid, 'pg_constraint') IS NOT NULL) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: a comment survived on a payment_transactions constraint';
  END IF;
  IF col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'service_session_id'))
       IS DISTINCT FROM 'RECEIPT SERVICE: the service session open at the moment the money was received. NULL = off-service receipt (no session open). NEVER the table''s origin service. Physical rename to receipt_service_session_id lands in S14.'
     OR col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'table_session_id'))
       IS DISTINCT FROM 'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction always carries at least one scope (table_session_id for Mesa, service_session_id for check-centric).' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: a payment_transactions column comment is not the exact S2 / migration-122 text';
  END IF;
  CREATE TEMP TABLE dec139rb_pt_after (k text PRIMARY KEY, v text) ON COMMIT DROP;
  INSERT INTO dec139rb_pt_after VALUES
    ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                            FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_scope_chk')),
    ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
    ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
    ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
    ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                           WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
    ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));
  IF EXISTS (SELECT 1 FROM dec139rb_pt_before b JOIN dec139rb_pt_after a USING (k) WHERE a.v IS DISTINCT FROM b.v) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: something on payment_transactions other than the scope constraint and its comments changed';
  END IF;
  FOR r IN
    SELECT b.proname, b.owner AS b_owner, b.prosecdef AS b_sec, b.proconfig AS b_cfg, b.acl AS b_acl,
           pg_get_userbyid(p.proowner) AS a_owner, p.prosecdef AS a_sec, p.proconfig AS a_cfg, p.proacl::text AS a_acl
      FROM dec139rb_before b
      JOIN pg_proc p ON p.oid = CASE b.proname
             WHEN 'close_service_session_v3' THEN 'public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure
             WHEN 'order_post_payment_v1'    THEN 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure END
  LOOP
    IF r.a_owner IS DISTINCT FROM r.b_owner OR r.a_sec IS DISTINCT FROM r.b_sec
       OR r.a_cfg IS DISTINCT FROM r.b_cfg OR r.a_acl IS DISTINCT FROM r.b_acl THEN
      RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: % changed owner / SECURITY attribute / search_path / ACL', r.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
