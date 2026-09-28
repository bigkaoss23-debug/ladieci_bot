-- migrations/2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.sql
-- Paired rollback: 2026-09-25_legacy_paid_ambiguity_payment_guard_v1_migration_148.ROLLBACK.sql
--
-- LEGACY PAID AMBIGUITY -- PAYMENT GUARD (DELIVERY x ECONOMIA V1, 2026-09-25). STAGING CANDIDATE ONLY; not applied by the session that authored it.
-- Evidence: ~/Downloads/DELIVERY_ECONOMY_V1_LEGACY_NO_LEDGER_RECHARGE_2026-09-25.md (LEGACY_NO_LEDGER_RECHARGE=DATA_ABSENT_BUT_CODE_REACHABLE,
-- INTEGRITY_IMPACT=DOUBLE_COLLECTION_POSSIBLE) and DELIVERY_ECONOMY_V1_M148_LEGACY_PAYMENT_GUARD_2026-09-25.md.
--
-- THE DEFECT. order_post_payment_v1 (145 body) derives what is owed ONLY from the canonical obligation minus the order's payment events. A legacy
-- row whose cobrado / ya_pagado say "paid" but whose payment was never recorded in order_financial_events therefore looks fully unpaid, and the FIRST
-- modern request -- Cash V1, operator_confirm_delivery_v1 (also its RETIRADO replay) or rider_collect_and_complete_stop -- recorded a NEW payment of the
-- whole obligation (38 of 41 dynamic scenarios; only cancelled orders were refused). Migration 140 dropped _ledger_write_payment, the last writer that
-- looked at the legacy flags. After such a recharge the historical payment can no longer be imported (order_import_legacy_payment: AUTH_BASIS_EXISTS).
--
-- THE FIX. public.order_post_payment_v1 (predecessor = the 145 body, md5 799f8093328b4ac81e1ad5a3d37e1bb6) is re-issued with ONE marked block inserted right after
-- the ORDER_PAYMENT_ALREADY_SETTLED gate:
--   -- 148:BEGIN legacy_paid_ambiguity_guard   (cobrado OR ya_pagado) AND canonical outstanding > 0  ->  ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED (55000)
-- Removing the block yields the 145 body byte for byte (proved by tests/legacyPaidAmbiguityPaymentGuardMigration.test.js). The contract is the
-- AMBIGUITY one (mirror says paid, ledger says owed), not mere event absence: a legacy row with a partial import, a legacy refund or a partial modern
-- payment is refused too. Orders the ledger already covers (outstanding 0, payment_imported included) keep ORDER_PAYMENT_ALREADY_SETTLED; orders with
-- no paid flag are untouched. The canonical writers never produce the refused state (they set the mirror to net >= obligation with the money they record,
-- refunds recompute it, and N-5 / reduction-only adjustments forbid an obligation increase after payment evidence).
-- UNCHANGED: the idempotent replay (it returns BEFORE this point, so a completed request still replays), authorization and the 140 rider attestation,
-- Mesa exclusion, cancelled gate, ALREADY_SETTLED, amount rules, duplicate window, the 145 pointer lock and the 139 off-service receipt, the events /
-- allocation / mirror projection, the response. NO lock is added or removed (v_ord is the row this transaction already holds FOR UPDATE).
-- PROPAGATION (certified for the pinned wrapper bodies below): SQLSTATE 55000 is caught by operator_confirm_delivery_v1 (139 body bedbfc46ca7e385220c2ea4531064c62)
-- and rider_collect_and_complete_stop (140 body ef3d423028b2d4d823359264bc5cfadc), which return {ok:false, code:'PAYMENT_REFUSED', payment_code:<this code>} BEFORE
-- any state change; only ORDER_PAYMENT_ALREADY_SETTLED is tolerated there. Cash V1 surfaces the ORDER_* code as a typed refusal.
--
-- ROLLOUT: 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148. ROLLBACK ORDER: 148 FIRST (restores the 145 body verbatim), then 147, 146, 145, ...
-- DRIFT GUARDS (fail closed): UTF-8 transport of the embedded body bytes; order_post_payment_v1 exists exactly once with the pinned signature and is
-- EXACTLY the 145 body; not already applied; the two wrapper bodies whose 55000 handling is certified are the pinned 139 / 140 bodies.
-- POST-CONDITIONS: md5 pin of the new body; the 148 block exactly once; the 139 / 140 / 145 blocks still exactly once each; every other function of
-- every user schema byte-identical; owner / SECURITY / search_path / ACL / arguments / return of the writer unchanged.
BEGIN;

-- 0. Preconditions and drift guards -------------------------------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' OR octet_length('§—') <> 5 OR md5('§—') IS DISTINCT FROM '5408bc0b2def700243496da590d65681' THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: this file must be sent as UTF-8 to a UTF8 database (client_encoding %, server_encoding %) -- the embedded body bytes would not match their md5 pins', current_setting('client_encoding'), current_setting('server_encoding');
  END IF;
  IF to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: order_post_payment_v1 is missing -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'order_post_payment_v1') <> 1 THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: order_post_payment_v1 has an unexpected overload set -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');
  IF position('-- 148:BEGIN ' IN v_src) > 0 THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: already applied (order_post_payment_v1 already carries a 148 block)';
  END IF;
  IF md5(v_src) IS DISTINCT FROM '799f8093328b4ac81e1ad5a3d37e1bb6' THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: order_post_payment_v1 is not the 145 body (md5 %, expected 799f8093328b4ac81e1ad5a3d37e1bb6) -- the rollout is 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148', md5(v_src);
  END IF;
  IF to_regprocedure('public.operator_confirm_delivery_v1(text,text,integer,jsonb)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.operator_confirm_delivery_v1(text,text,integer,jsonb)')) IS DISTINCT FROM 'bedbfc46ca7e385220c2ea4531064c62' THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: operator_confirm_delivery_v1 is not the 139 body bedbfc46ca7e385220c2ea4531064c62 whose SQLSTATE 55000 handling this guard relies on -- resolve drift first';
  END IF;
  IF to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)')) IS DISTINCT FROM 'ef3d423028b2d4d823359264bc5cfadc' THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD refused: rider_collect_and_complete_stop is not the 140 body ef3d423028b2d4d823359264bc5cfadc whose SQLSTATE 55000 handling this guard relies on -- resolve drift first';
  END IF;
END $guard$;

-- Before-state: every function of every user schema, and the posture of the writer (the post-conditions prove nothing else moved).
CREATE TEMP TABLE c148_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c148_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
CREATE TEMP TABLE c148_posture_before ON COMMIT DROP AS
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proretset, p.prorettype::regtype AS rettype, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');

-- 1. order_post_payment_v1: the 145 body with the legacy paid ambiguity guard --------------------------------------------------------------------------
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
  -- 140:BEGIN rider_delivery_attestation
  -- B-RID-1 (migration 140). The ONE exception to that gate: a RIDER, when -- and only when -- the enclosing
  -- transaction carries the rider-delivery attestation for exactly this actor and this order_uid, for a full payment
  -- with no duplicate override. Only rider_collect_and_complete_stop writes that attestation (transaction-local,
  -- cleared right after the call), after it has verified the rider identity, the fresh session, the ACTIVE trip
  -- membership of that order and its state. A direct call (the Cash V1 route, PostgREST) carries no attestation and is
  -- refused exactly as before. The payment is then recorded AS THE RIDER (by_actor / by_role below), never as an
  -- operator; admin/operator are judged exactly as before.
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR (v_actor.role NOT IN ('admin','operator')
         AND NOT (v_actor.role = 'rider' AND p_mode = 'full' AND p_confirm_duplicate IS NOT TRUE
                  AND current_setting('ladieci.rider_payment_attestation', true) IS NOT DISTINCT FROM (p_by_actor || '|' || p_order_uid::text)))
  -- 140:END rider_delivery_attestation
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
  -- 148:BEGIN legacy_paid_ambiguity_guard
  -- LEGACY PAID AMBIGUITY (migration 148). Reached only with outstanding > 0 (the gate above) on a non-Mesa, non-cancelled order that
  -- this transaction holds FOR UPDATE. Every canonical writer sets cobrado / ya_pagado to "net collected >= current obligation" in the
  -- same transaction as the money it records, refunds recompute them, and an obligation can only go DOWN once any payment evidence exists
  -- (N-5 guard, reduction-only adjustments). So a paid mirror together with a positive canonical outstanding is never produced by the
  -- canonical writers: it is a legacy row (pay-at-creation before N-3, a door collection declared with a boolean, a partial legacy import,
  -- a legacy OFE-only refund that left the flags). The history says "paid", the ledger says "owed": this writer does not guess. It refuses
  -- BEFORE any payment fact, with its own typed code -- deliberately NOT ORDER_PAYMENT_ALREADY_SETTLED, which operator_confirm_delivery_v1
  -- and rider_collect_and_complete_stop tolerate as "nothing is owed"; SQLSTATE 55000 is the class both wrappers turn into a typed
  -- PAYMENT_REFUSED (payment_code = this message) with nothing written. Remedy: record the historical payment through
  -- order_import_legacy_payment (then this writer answers ORDER_PAYMENT_ALREADY_SETTLED), or reconcile the obligation.
  -- The mirror is never turned into ledger here, and no amount is inferred from it.
  IF v_ord.cobrado IS TRUE OR v_ord.ya_pagado IS TRUE THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED' USING ERRCODE='55000',
      DETAIL = format('order_uid=%s cobrado=%s ya_pagado=%s obligation_cents=%s net_collected_cents=%s outstanding_cents=%s -- a legacy paid mirror contradicts the canonical ledger; import the historical payment or reconcile the obligation before any new collection',
                      p_order_uid, v_ord.cobrado, v_ord.ya_pagado, v_obligation_cents, v_paid_before_cents, v_outstanding_cents);
  END IF;
  -- 148:END legacy_paid_ambiguity_guard

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

-- 2. Post-conditions -----------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_src text;
  v_blk text;
  v_bad text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');
  IF md5(v_src) IS DISTINCT FROM 'e1ce2229f2418d6a7f91fe50771564f8' THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD post-condition failed: order_post_payment_v1 is not the expected 148 body (md5 %)', md5(v_src);
  END IF;
  FOREACH v_blk IN ARRAY ARRAY['148:BEGIN legacy_paid_ambiguity_guard', '148:END legacy_paid_ambiguity_guard', '145:BEGIN receipt_service_pointer_lock',
                               '140:BEGIN rider_delivery_attestation', '139:BEGIN off_service_receipt'] LOOP
    IF (length(v_src) - length(replace(v_src, '-- ' || v_blk, ''))) / length('-- ' || v_blk) <> 1 THEN
      RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD post-condition failed: marker % must be present exactly once', v_blk;
    END IF;
  END LOOP;
  IF (length(v_src) - length(replace(v_src, '-- 148:BEGIN ', ''))) / length('-- 148:BEGIN ') <> 1 THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD post-condition failed: exactly one 148 block is required';
  END IF;
  SELECT string_agg(b.sig, ', ') INTO v_bad
    FROM c148_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE COALESCE(a.sig, b.sig) <> 'order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)' AND COALESCE(a.sig, b.sig) <> 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD post-condition failed: other functions changed (%)', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM c148_posture_before b, pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)')
              AND (p.prosecdef IS DISTINCT FROM b.prosecdef OR p.proconfig IS DISTINCT FROM b.proconfig OR pg_get_userbyid(p.proowner) IS DISTINCT FROM b.owner
                   OR p.proacl::text IS DISTINCT FROM b.acl OR p.proretset IS DISTINCT FROM b.proretset OR p.prorettype::regtype IS DISTINCT FROM b.rettype
                   OR pg_get_function_arguments(p.oid) IS DISTINCT FROM b.args)) THEN
    RAISE EXCEPTION 'LEGACY_PAID_AMBIGUITY_GUARD post-condition failed: owner / SECURITY / search_path / ACL / signature / return of order_post_payment_v1 changed';
  END IF;
END $post$;

COMMIT;
