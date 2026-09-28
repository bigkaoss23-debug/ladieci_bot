-- migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.sql
-- FINDING A -- PAYMENT x SERVICE CLOSE (DELIVERY x ECONOMIA V1, 2026-09-24): THE RECEIPT SERVICE IS DECIDED UNDER A SHARE LOCK ON THE LIFECYCLE POINTER.
--
-- WHY. order_post_payment_v1 (Cash V1, and through it operator_confirm_delivery_v1, the rider stop and the paid-at-creation intake) and
-- mesa_post_payment_v1 decide the receipt service with an UNLOCKED SELECT of service_session_state joined to service_sessions.status = 'open'. A close
-- (close_service_session_v3: L -> L0 -> service_session_state FOR UPDATE -> service_sessions FOR UPDATE) that has not committed yet is invisible to that
-- read; the payment's INSERT then only waits on the FK to the service row, which checks that the row EXISTS and not that it is still open. The
-- receipt lands on a service that has already been closed (payment_transactions.service_session_id / order_financial_events.event_service_session_id = A,
-- with A closed). Writers that hold L0 (operator_confirm, rider) or L (intake) were already serialized with the close; Cash V1 and Mesa hold neither.
-- Contract and proof: DELIVERY_ECONOMY_V1_PAYMENT_CLOSE_RACE_DECISION_2026-09-24.md (frozen). No design choice is reopened here.
--
-- WHAT. EXACTLY TWO functions are re-issued, each with ONE marked block (`-- 145:BEGIN receipt_service_pointer_lock` ... `-- 145:END receipt_service_pointer_lock`) placed IMMEDIATELY BEFORE the existing,
-- unchanged receipt-service SELECT:
--     PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;
--   * public.order_post_payment_v1(...)  -- predecessor = the POST-M140 body, md5(prosrc) ea4fe577feddbd2ba6f6ae42695feba6 (M140's own pin). NOT the staging body (staging is at 138).
--   * public.mesa_post_payment_v1(...)   -- predecessor = the live body, md5(prosrc) 9543ab52d9933ffd52cc7f9b595c4cfb (equal to the migration-126 text; pure ASCII).
-- The row lock is held to the end of the transaction (normal PostgreSQL semantics). Nothing else changes: no L, no L0, no service-row lock, no FOR UPDATE /
-- FOR KEY SHARE, no retry, no receipt semantics change (off-service M139 contract untouched), no authorization change, no idempotency change.
-- Effect (proved on real bodies, see the report): payment and close are TOTALLY ORDERED -- payment first: the close waits and the receipt is the still-open
-- service; close first: the payment waits, rereads the pointer and records the next open service B, or NULL (off-service). The sale service never changes.
--
-- PREREQUISITE (fail-closed): migration 143 (order_intake_lock_prelude_v1, the C8 intake prelude) MUST already be applied. Without it the intake still
-- takes [TS] -> L -> SS -> D -> W and this lock, taken by a payment that already holds W, closes a cycle: 34 deadlocks were measured (control: 18) on the
-- intake x payment pairs of a database without 143. Migration 144 (order_cancel W-first) is NOT required and is not checked.
-- ROLLOUT for the Economia base: 139 -> 140 -> 143 -> 144 -> 145.   ROLLBACK ORDER: 145 FIRST, THEN 143 (see the paired ROLLBACK file).
--   Rolling 143 back while 145 is applied would knowingly leave the system in "payment pointer lock + no C8 prelude", the configuration that deadlocks.
--   Migration 143's rollback file is frozen and cannot enforce this; it is an operational rule, documented here, in the manifest and in the report.
--
-- NOT TOUCHED (frozen): order_post_refund_v1 and mesa_post_refund_v1 (same unlocked read, same race -- REFUND_RECEIPT_RACE = KNOWN_OPEN_FINDING; locking them now would
-- turn the race into an untyped 23514 when no service is open: Finding B decides their off-service contract first), close_service_session_v3,
-- open_operational_service_v1, resolve_order_intake_context_v1, operator_confirm_delivery_v1, rider_collect_and_complete_stop, order_initial_payment_v1,
-- order_cancel_v1, every table / trigger / constraint / index / grant / data, and migrations 143 / 144. M141 and M142 are not part of this rollout.
--
-- DRIFT GUARDS (fail closed; nothing is created if any fails): 143 present (function + trigger a0_order_intake_lock_prelude_v1 = the first BEFORE INSERT ROW trigger of
-- public.ordenes, enabled); not already applied; the two writers exist exactly once with the pinned signatures and md5(prosrc) = the pins; service_role can take
-- FOR SHARE on service_session_state under the real posture (SELECT + UPDATE privilege, and row-level security either off or bypassed).
-- POST-CONDITIONS: exactly the two functions changed (every other function of every user schema byte-identical); new md5 pins; marker exactly once; the block is exactly the
-- FOR SHARE statement and sits immediately before the receipt SELECT; the body without the block is byte-for-byte the predecessor; owner / SECURITY / search_path / ACL /
-- signature / return type unchanged; no trigger / constraint / column / index / relation / ACL change.
--
-- ROLLBACK: migrations/2026-09-24_payment_close_receipt_lock_v1_migration_145.ROLLBACK.sql (re-issues both predecessors verbatim; refuses over anything that is not exactly the 145 bodies).
-- STAGING ONLY. NOT applied by the session that authored it (staging ledger tip is 138; M139 / M140 / C8 are not applied either).

BEGIN;

-- 0. Preconditions and drift guards ---------------------------------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src    text;
  v_pin    record;
  v_first  name;
  v_rls    boolean;
  v_bypass boolean;
BEGIN
  -- 0.a prerequisite: migration 143 (the C8 intake prelude)
  IF to_regprocedure('public.order_intake_lock_prelude_v1()') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: migration 143 (public.order_intake_lock_prelude_v1) is not applied -- apply 143 first; without it this lock deadlocks against the old intake order';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname = 'a0_order_intake_lock_prelude_v1'
                    AND t.tgfoid = to_regprocedure('public.order_intake_lock_prelude_v1()') AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
                    AND (t.tgtype & 8) = 0 AND (t.tgtype & 16) = 0 AND (t.tgtype & 32) = 0 AND t.tgqual IS NULL AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing, disabled or is not the BEFORE INSERT FOR EACH ROW trigger of the 143 prelude -- apply / repair 143 first';
  END IF;
  SELECT min(t.tgname) INTO v_first FROM pg_trigger t
   WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4;
  IF v_first IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: the 143 prelude is not the first BEFORE INSERT trigger of public.ordenes (first is %) -- resolve drift first', v_first;
  END IF;
  -- 0.b the two writers: exact signature, single overload, not already applied, exact predecessor body
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)', 'order_post_payment_v1', 'ea4fe577feddbd2ba6f6ae42695feba6'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', 'mesa_post_payment_v1', '9543ab52d9933ffd52cc7f9b595c4cfb')
    ) AS t(sig, name, want)
  LOOP
    IF to_regprocedure(v_pin.sig) IS NULL THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: % is missing -- resolve drift first', v_pin.sig;
    END IF;
    IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_pin.name) <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: % has an unexpected overload set -- resolve drift first', v_pin.name;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
    IF position('-- 145:BEGIN receipt_service_pointer_lock' IN v_src) > 0 THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: already applied (% already carries the 145 block)', v_pin.name;
    END IF;
    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: % is not the pinned predecessor body (md5 mismatch: %, expected %) -- resolve drift first; a divergent body is never overwritten', v_pin.name, md5(v_src), v_pin.want;
    END IF;
  END LOOP;
  -- 0.c the lock is a row lock on the lifecycle pointer, taken by service_role (the caller): SELECT + UPDATE privilege are required by PostgreSQL for FOR SHARE, and RLS must not apply
  IF to_regclass('public.service_session_state') IS NULL OR to_regclass('public.service_sessions') IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: service_session_state / service_sessions are missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: role service_role does not exist';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.service_session_state', 'SELECT') OR NOT has_table_privilege('service_role', 'public.service_session_state', 'UPDATE') THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: service_role lacks SELECT + UPDATE on public.service_session_state (required for SELECT ... FOR SHARE) -- the writers would fail with 42501';
  END IF;
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c WHERE c.oid = 'public.service_session_state'::regclass;
  SELECT r.rolbypassrls INTO v_bypass FROM pg_roles r WHERE r.rolname = 'service_role';
  IF v_rls AND NOT v_bypass THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK refused: row-level security is enabled on public.service_session_state and service_role does not bypass it -- FOR SHARE would be filtered by policy';
  END IF;
END $guard$;

-- Before-state: every function of every user schema, the posture of the two writers, and a catalog fingerprint (the post-conditions prove nothing else moved).
CREATE TEMP TABLE c145_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
CREATE TEMP TABLE c145_posture_before (k text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text, proretset boolean, prorettype regtype, args text) ON COMMIT DROP;
CREATE TEMP TABLE c145_cat_before (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO c145_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
INSERT INTO c145_posture_before
  SELECT p.proname::text, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text, p.proretset, p.prorettype::regtype, pg_get_function_arguments(p.oid)
    FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'), to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)'));
INSERT INTO c145_cat_before (k, v)
  SELECT 'triggers', md5(COALESCE(string_agg(c.relname::text || '.' || t.tgname::text || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid), '|' ORDER BY c.relname, t.tgname), ''))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'constraints', md5(COALESCE(string_agg(con.conrelid::regclass::text || '.' || con.conname::text || ':' || pg_get_constraintdef(con.oid), '|' ORDER BY con.conrelid::regclass::text, con.conname), ''))
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'columns', md5(COALESCE(string_agg(a.attrelid::regclass::text || '.' || a.attname::text || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attrelid::regclass::text, a.attnum), ''))
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'indexes', md5(COALESCE(string_agg(pg_get_indexdef(i.indexrelid), '|' ORDER BY i.indexrelid::regclass::text), ''))
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'relations_and_acls', md5(COALESCE(string_agg(c.oid::regclass::text || ':' || c.relkind::text || ':' || COALESCE(c.relacl::text, '') || ':' || COALESCE(c.reloptions::text, ''), '|' ORDER BY c.oid::regclass::text), ''))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';

-- 1. The two writers: predecessor + ONE marked block immediately before the unchanged receipt-service SELECT -----------------------------------------------
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

-- 2. Post-conditions ---------------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_pin  record;
  v_src  text;
  v_blk  text;
  v_oid  oid;
  v_n    integer;
BEGIN
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)', 'order_post_payment_v1', '799f8093328b4ac81e1ad5a3d37e1bb6', 'ea4fe577feddbd2ba6f6ae42695feba6'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', 'mesa_post_payment_v1', '94867e165d0732f36ae4692fc6998c58', '9543ab52d9933ffd52cc7f9b595c4cfb')
    ) AS t(sig, name, want_new, want_pre)
  LOOP
    v_oid := to_regprocedure(v_pin.sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % is missing', v_pin.name; END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
    IF md5(v_src) IS DISTINCT FROM v_pin.want_new THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % is not the expected 145 body (md5 %)', v_pin.name, md5(v_src);
    END IF;
    -- the marker is present exactly once (BEGIN and END)
    IF (length(v_src) - length(replace(v_src, '-- 145:BEGIN receipt_service_pointer_lock', ''))) / length('-- 145:BEGIN receipt_service_pointer_lock') <> 1
       OR (length(v_src) - length(replace(v_src, '-- 145:END receipt_service_pointer_lock', ''))) / length('-- 145:END receipt_service_pointer_lock') <> 1 THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % must carry the 145 block exactly once', v_pin.name;
    END IF;
    -- the block is exactly the FOR SHARE statement (comment lines aside): not FOR UPDATE, not FOR KEY SHARE, no advisory lock, no service-row lock
    v_blk := substring(v_src FROM $re$-- 145:BEGIN receipt_service_pointer_lock\n([\s\S]*?)  -- 145:END receipt_service_pointer_lock$re$);
    IF v_blk IS NULL OR v_blk !~ $re$^(  --[^\n]*\n)*  PERFORM 1 FROM public\.service_session_state WHERE singleton = true FOR SHARE;\n(  --[^\n]*\n)*$$re$ THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: the block of % is not exactly "PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;"', v_pin.name;
    END IF;
    -- the lock sits IMMEDIATELY before the (unchanged) receipt-service SELECT
    IF v_src !~ $re$-- 145:END receipt_service_pointer_lock\n  SELECT ss\.id INTO v_receipt_service_id\n    FROM public\.service_session_state sst\n    JOIN public\.service_sessions ss ON ss\.id = sst\.current_session_id AND ss\.status = 'open'\n   WHERE sst\.singleton = true;$re$ THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: the lock of % is not immediately before the receipt-service SELECT', v_pin.name;
    END IF;
    -- with the block removed the body is byte-for-byte the predecessor
    IF md5(regexp_replace(v_src, $re$^  -- 145:BEGIN receipt_service_pointer_lock\n[\s\S]*?^  -- 145:END receipt_service_pointer_lock\n$re$, '', 'n')) IS DISTINCT FROM v_pin.want_pre THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % differs from its predecessor by more than the block', v_pin.name;
    END IF;
    -- posture unchanged
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN c145_posture_before b ON b.k = p.proname::text
                    WHERE p.oid = v_oid AND p.prosecdef IS NOT DISTINCT FROM b.prosecdef AND p.proconfig IS NOT DISTINCT FROM b.proconfig AND pg_get_userbyid(p.proowner) = b.owner
                      AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proretset = b.proretset AND p.prorettype::regtype = b.prorettype AND pg_get_function_arguments(p.oid) = b.args) THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: owner / SECURITY / search_path / ACL / return type / arguments of % changed', v_pin.name;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: EXECUTE of % must stay service_role-only', v_pin.name;
    END IF;
  END LOOP;
  -- EXACTLY two functions changed, none added, none removed (every function of every user schema)
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
     AND NOT EXISTS (SELECT 1 FROM c145_fn_before f WHERE f.sig = p.oid::regprocedure::text AND f.md5 = md5(p.prosrc));
  IF v_n <> 2 THEN RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % function(s) differ from the before-state (expected exactly 2)', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'), to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)'))
                AND (SELECT f.md5 FROM c145_fn_before f WHERE f.sig = p.oid::regprocedure::text) = md5(p.prosrc)) THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: a target function was not changed';
  END IF;
  SELECT count(*) INTO v_n FROM c145_fn_before f WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid::regprocedure::text = f.sig);
  IF v_n <> 0 THEN RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % function(s) disappeared', v_n; END IF;
  -- the refund writers are untouched (Finding B firewall)
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('order_post_refund_v1', 'mesa_post_refund_v1')
         AND md5(p.prosrc) = (SELECT f.md5 FROM c145_fn_before f WHERE f.sig = p.oid::regprocedure::text)) <> 2 THEN
    RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: a refund writer changed (Finding B firewall)';
  END IF;
  -- no trigger / constraint / column / index / relation / ACL change
  CREATE TEMP TABLE c145_cat_after (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO c145_cat_after (k, v)
  SELECT 'triggers', md5(COALESCE(string_agg(c.relname::text || '.' || t.tgname::text || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid), '|' ORDER BY c.relname, t.tgname), ''))
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE NOT t.tgisinternal AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'constraints', md5(COALESCE(string_agg(con.conrelid::regclass::text || '.' || con.conname::text || ':' || pg_get_constraintdef(con.oid), '|' ORDER BY con.conrelid::regclass::text, con.conname), ''))
    FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'columns', md5(COALESCE(string_agg(a.attrelid::regclass::text || '.' || a.attname::text || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attrelid::regclass::text, a.attnum), ''))
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'indexes', md5(COALESCE(string_agg(pg_get_indexdef(i.indexrelid), '|' ORDER BY i.indexrelid::regclass::text), ''))
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
  UNION ALL
  SELECT 'relations_and_acls', md5(COALESCE(string_agg(c.oid::regclass::text || ':' || c.relkind::text || ':' || COALESCE(c.relacl::text, '') || ':' || COALESCE(c.reloptions::text, ''), '|' ORDER BY c.oid::regclass::text), ''))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
  SELECT count(*) INTO v_n FROM c145_cat_before b JOIN c145_cat_after a USING (k) WHERE a.v IS DISTINCT FROM b.v;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PAYMENT_CLOSE_LOCK post-condition failed: % catalog fingerprint(s) changed (trigger / constraint / column / index / relation / ACL)', v_n; END IF;
END $post$;

COMMIT;
