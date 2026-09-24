-- migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql
-- Paired rollback: 2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql
--
-- DELIVERY x ECONOMIA V1 -- B-RID-1 RIDER_PAYMENT_RECEIPT_LINEAGE_GAP -- migration 140.
-- STAGING CANDIDATE ONLY. Certified on ephemeral PostgreSQL 17 (ci/giro-authority-certification/harness/
-- runRiderCanonicalPayment.js). NOT applied to staging or production by the session that authored it; application
-- needs its own authorization. Predecessor: migration 139 (NOT modified). Migrations 122/126/135/138/139 are NOT edited:
-- this is a forward migration on top of them, and its rollback returns to the exact post-139 state.
--
-- THE DEFECT (B-RID-1).
--   The rider's Entregado + Efectivo/Tarjeta/Bizum (rider_collect_and_complete_stop, ledger 135) recorded the money
--   through public._ledger_write_payment (ledger 126): ONE order_financial_events row and nothing else -- no
--   payment_transactions row, no payment_allocations row, event_service_session_id always NULL (not even when a
--   service WAS open), the amount taken from ordenes.totale instead of the canonical obligation. An operator's payment
--   of the same order (Cash V1, order_post_payment_v1) produces transaction + allocation + event with the full
--   obligation/receipt lineage. Since 139 a departed trip outlives the close of its service, so a rider collecting
--   after the close is ordinary, and the event-only shape became the ordinary rider shape.
--
-- THE FIX: ONE ECONOMIC AUTHORITY. The rider stop now records the money through the SAME canonical writer the operator
-- uses, public.order_post_payment_v1 -- no second writer, no parallel pipeline, no copy of its body. Its three public
-- entry points (Cash V1 HTTP, operator_confirm_delivery_v1, rider_collect_and_complete_stop) stay distinct; the
-- persistence converges on ONE function. Consequently the rider's payment gets, unchanged, everything the canonical
-- writer already guarantees: transaction + allocation + event, amount = what is still owed on the canonical obligation
-- (full payment only), receipt service = the service open at that moment (A, B or NULL off-service, migration 139),
-- obligation service = the order's own service (trigger), economic-period stamping (triggers), idempotency by
-- client_request_id, 120 s duplicate protection, ALREADY_SETTLED, append-only rows.
--
-- WHAT THIS MIGRATION DOES
--   1. payment_transactions_by_role_check (migration V3-H; never changed since) admits 'rider' ONLY for the shape a
--      rider can produce: kind payment, mode full, no table session, covers_settled 0, meta.source exactly
--      "rider_delivery". Every other role keeps its exact previous admission. Without this the rider could only be
--      recorded by impersonating an operator -- which this migration refuses to do. (Economic Writer Hardening V1,
--      migration 126, already named this step: "Rider canonicalization (PT-backed, by_role='rider',
--      outstanding-based amount) ... NOT this slice".)
--   2. order_post_payment_v1 -- the ledger-139 body (md5 pinned below) with ONE marked block, at the role gate: a
--      RIDER actor is admitted ONLY when the enclosing transaction carries the rider-delivery attestation for exactly
--      this (actor, order_uid), mode 'full' and no duplicate override. That attestation is a transaction-local setting
--      written ONLY by rider_collect_and_complete_stop, AFTER it has verified the rider identity, the fresh session,
--      the ACTIVE trip membership of that order and its state. A rider (or anyone) calling the writer directly --
--      through PostgREST or Cash V1 -- has no attestation and is refused exactly as before (ORDER_PAYMENT_FORBIDDEN).
--      admin/operator: byte-for-byte the previous behaviour. No other line changes.
--   3. rider_collect_and_complete_stop -- DROP of the 7-argument function + CREATE with an 8th, trailing
--      p_by_sid_hash text DEFAULT NULL (the sha256(sid) proof the canonical writer requires from its caller, exactly
--      the proof the operator's Cash V1 payment carries). The ledger-135 body is kept; the marked "140:" blocks only
--      swap the legacy writer call for the canonical one (twice: the replay branch and the Entregado branch) and
--      derive the deterministic request identity. Delivery vs payment, L0 first, identity (role exactly 'rider'),
--      DRIVER_STATO read, trip membership (canonical trip wins, legacy fallback kept), money-first, the
--      RIDER_STOP_LOST_RACE RAISE and the operative-only UPDATE are unchanged. The DEFAULT keeps a not-yet-redeployed
--      backend (7 named arguments) working for a delivery without money; a collection without the proof is a typed
--      refusal (PAYMENT_CONTEXT_UNAVAILABLE) that writes nothing -- never a guessed proof.
--   4. DROP FUNCTION public._ledger_write_payment -- the legacy OFE-only writer. Its ONLY caller was the rider RPC
--      (order_mark_paid is a raising stub since 126); zero backend references (supabaseResourcePolicy has no entry).
--      The guard below re-proves zero reachability ON THE TARGET DATABASE (no other function body calls it) and refuses
--      otherwise. Historical event-only rows are NOT touched: they stay valid append-only facts, and the canonical
--      writer already counts them (net collected is read from order_financial_events), so an order paid the old way
--      can never be paid a second time the new way.
--
-- IDENTITY. The payment is recorded AS THE RIDER: payment_transactions.by_actor/by_role and order_financial_events
-- by_actor/by_role = the rider (the OFE constraints already admit 'rider'), meta.source 'rider_delivery'. Never an
-- operator, never an admin, never owner.
--
-- IDEMPOTENCY. client_request_id = 'rider-delivery-' || order_uid (hex), request_hash = sha256 of
-- rider_delivery|order_uid|method|full. A double tap, an identical retry or a retry after a lost response replays the
-- SAME transaction (idempotent: true); the same stop retried with a DIFFERENT method is a typed conflict
-- (ORDER_PAYMENT_IDEMPOTENCY_CONFLICT -> PAYMENT_REFUSED), never a second payment. Concurrent invocations serialize on
-- L0 (taken first by the rider RPC) and on the workspace row lock (taken first by the writer).
--
-- ATOMICITY. One transaction: payment (transaction + allocation + event + mirror) THEN the delivery transition. A
-- writer refusal returns before the stop is completed (its subtransaction already rolled the attempt back); a lost race
-- after the money RAISEs 40001 and rolls the payment back with everything else. The single tolerated refusal is
-- ORDER_PAYMENT_ALREADY_SETTLED (nothing is owed any more -- e.g. the operator was first): the delivery is still
-- confirmed and no second payment exists -- the same rule operator_confirm_delivery_v1 applies (139).
--
-- AMOUNT PARITY (B1, independent review). The rider app presents ordenes.totale as the amount to collect and offers only
-- Efectivo/Tarjeta/Bizum. The canonical writer records the OUTSTANDING of the canonical obligation. The rider stop therefore
-- accepts the payment ONLY when the amount the writer just recorded equals round(ordenes.totale, 2) (NUMERIC, 2 decimals,
-- compared inside the same subtransaction and under the writer's row locks -- no read-then-call race, no JS formula). A
-- commercial adjustment (outstanding < totale) or a prior operator payment (outstanding < totale) is refused typed --
-- PAYMENT_REFUSED / RIDER_PAYMENT_AMOUNT_MISMATCH -- and the subtransaction rolls back payment, allocation, event and mirror;
-- the stop is not completed. Outstanding 0 is a different case (ORDER_PAYMENT_ALREADY_SETTLED, tolerated: nothing written,
-- delivery confirmed). An idempotent replay is never re-judged. No partial / adjustment rider flow exists in this version.
--
-- LOCK ORDER. L0 -> auth_actors(rider) -> config(DRIVER_STATO) -> [writer: workspaces -> auth_actors(rider, already
-- held) -> order_entities -> ordenes] -> ordenes (already held). No row lock of an order is taken before the writer's
-- workspace lock, so the PRE-EXISTING rider-vs-Cash deadlock recorded by 139 (the legacy writer locked ordenes first)
-- no longer has its cycle.
--
-- WHAT IT NEVER DOES. It never touches a trip, trip_members, DRIVER_STATO semantics, delivery_logs, a service, the
-- Planner, a Mesa payment, the obligation, consolidate_period_v1 (B-FISC-1 stays open), any historical row.

BEGIN;

-- Predecessor / drift / reachability guard --------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
  v_n   integer;
BEGIN
  IF to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'B_RID_1 refused: the 7-argument public.rider_collect_and_complete_stop does not exist (already applied, or drifted) -- resolve drift first';
  END IF;
  IF to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'B_RID_1 refused: the 8-argument public.rider_collect_and_complete_stop already exists (already applied?) -- resolve drift first';
  END IF;
  IF to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'B_RID_1 refused: public._ledger_write_payment does not exist (already applied, or drifted) -- resolve drift first';
  END IF;
  IF to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'B_RID_1 refused: the canonical writer public.order_post_payment_v1 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('public.trip_authority_active_trip_v1()') IS NULL THEN
    RAISE EXCEPTION 'B_RID_1 refused: public.trip_authority_active_trip_v1 does not exist (migration 135 missing) -- resolve drift first';
  END IF;

  -- The three bodies this migration replaces or drops must be EXACTLY the ledger bodies.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)');
  IF md5(v_src) IS DISTINCT FROM '4b2b4f4ce6155deea2e7f15a74f7707c' THEN
    RAISE EXCEPTION 'B_RID_1 refused: rider_collect_and_complete_stop is not the exact ledger-135 body (md5 mismatch) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)');
  IF md5(v_src) IS DISTINCT FROM '94fa5265c0ad334b79f3f00228f8300d' THEN
    RAISE EXCEPTION 'B_RID_1 refused: _ledger_write_payment is not the exact ledger-126 body (md5 mismatch) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');
  IF md5(v_src) IS DISTINCT FROM 'af52d59658719bd7898d9cd88dd29179' THEN
    RAISE EXCEPTION 'B_RID_1 refused: order_post_payment_v1 is not the exact ledger-139 body (md5 mismatch; migration 139 missing, already applied, or drifted) -- resolve drift first';
  END IF;

  -- ZERO REACHABILITY of the legacy writer on THIS database: apart from itself and the rider RPC this migration
  -- replaces, no function body may call it (a plpgsql body records no pg_depend edge, so this is read from the source).
  SELECT count(*) INTO v_n FROM pg_proc p
   WHERE p.prosrc LIKE '%\_ledger\_write\_payment(%'
     AND p.oid <> to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)')
     AND p.oid <> to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)');
  IF v_n > 0 THEN
    RAISE EXCEPTION 'B_RID_1 refused: % other function(s) still call _ledger_write_payment -- it is not dead on this database; migrate them first', v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_depend d WHERE d.refobjid = to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)')
                                        AND d.deptype = 'n') THEN
    RAISE EXCEPTION 'B_RID_1 refused: an object depends on _ledger_write_payment (pg_depend) -- resolve first';
  END IF;

  -- The role constraint this migration REPLACES must be exactly the V3-H one, with no comment (the rollback restores it
  -- verbatim; drift => refuse, never guess).
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_by_role_check')
       IS DISTINCT FROM 'CHECK ((by_role = ANY (ARRAY[''admin''::text, ''operator''::text, ''owner''::text, ''cashier''::text, ''legacy_operator''::text])))' THEN
    RAISE EXCEPTION 'B_RID_1 refused: payment_transactions_by_role_check is not the exact V3-H constraint (already applied, or drifted) -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_by_role_check'
                AND obj_description(c.oid, 'pg_constraint') IS NOT NULL) THEN
    RAISE EXCEPTION 'B_RID_1 refused: payment_transactions_by_role_check carries a comment the rollback could not restore -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'auth_actors' AND column_name = 'workspace_id') THEN
    RAISE EXCEPTION 'B_RID_1 refused: auth_actors.workspace_id is missing -- resolve drift first';
  END IF;
END $guard$;

-- Security posture the replaced functions must keep: owner, SECURITY attribute, search_path and ACL.
CREATE TEMP TABLE brid140_before (k text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text) ON COMMIT DROP;
INSERT INTO brid140_before
  SELECT 'rider', p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text FROM pg_proc p
   WHERE p.oid = 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure
  UNION ALL
  SELECT 'writer', p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text FROM pg_proc p
   WHERE p.oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure;

-- Everything on payment_transactions this migration must NOT change (all but the role constraint and its comment).
CREATE TEMP TABLE brid140_pt_before (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO brid140_pt_before VALUES
  ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                          FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_by_role_check')),
  ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
  ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
  ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
  ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                         WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
  ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));

-- 1. payment_transactions_by_role_check -- 'rider' admitted ONLY for the rider-delivery payment shape --------------
-- Superset of the V3-H constraint (every existing row keeps passing). NULL-safe on purpose: the meta test is
-- COALESCE((meta -> 'source') = '"rider_delivery"'::jsonb, false), so a missing key is FALSE, never NULL (a CHECK
-- accepts NULL). A rider refund, a rider partial/Mesa-mode payment, a rider row on a table session or a rider row without
-- the server-forced source can never be stored.
ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_by_role_check;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_by_role_check CHECK (
  by_role IN ('admin', 'operator', 'owner', 'cashier', 'legacy_operator')
  OR (
        by_role = 'rider'
    AND kind = 'payment'
    AND mode = 'full'
    AND table_session_id IS NULL
    AND covers_settled = 0
    AND COALESCE((meta -> 'source') = '"rider_delivery"'::jsonb, false)
  )
);
COMMENT ON CONSTRAINT payment_transactions_by_role_check ON public.payment_transactions IS
  'B-RID-1 (migration 140). The roles that may be recorded as the author of a money movement. admin/operator/owner/cashier/legacy_operator: any shape the writers allow (unchanged since V3-H). rider: ONLY a full check-centric PAYMENT (no table session, covers 0) whose meta.source is exactly "rider_delivery" -- the one shape rider_collect_and_complete_stop records through the canonical writer order_post_payment_v1. A rider is recorded as the rider, never as an operator.';

-- 2. order_post_payment_v1 -- the canonical writer, admitting an ATTESTED rider-delivery payment --------------------
-- The ledger-139 body (md5 af52d59658719bd7898d9cd88dd29179) with ONE marked block ("140:BEGIN rider_delivery_attestation")
-- at the role gate. CREATE OR REPLACE keeps owner / SECURITY attribute / search_path / ACL (re-asserted below).
-- tests/bRid1RiderCanonicalPaymentMigration.test.js re-derives this body from the migration-139 file with that single
-- replacement and requires byte equality.
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

-- 3. rider_collect_and_complete_stop -- the rider stop records the money through the canonical writer ---------------
DROP FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text);

-- The ledger-135 body with the marked "140:" blocks (tests/bRid1RiderCanonicalPaymentMigration.test.js proves that
-- removing them from this body and removing the legacy-writer regions from the 135 body yields the SAME text).
CREATE FUNCTION public.rider_collect_and_complete_stop(
  p_order_id text, p_metodo_pago text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text,
  p_by_sid_hash text DEFAULT NULL)
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
  -- 140:BEGIN decl
  v_order_uid    uuid := NULL;
  v_request_id   text := NULL;
  v_request_hash text := NULL;
  -- 140:END decl
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

  -- 140:BEGIN collection_proofs
  -- B-RID-1 (migration 140). Pure input validation of a COLLECTION, before any lock. The canonical writer requires the
  -- proof of the session that attests the money (sha256(sid) -- the same proof an operator's Cash V1 payment carries);
  -- without it nothing is claimed and nothing is written: a typed refusal, never a guessed proof. The IP hash and the
  -- rider's request key keep the legacy contract (both were required by the legacy writer) and are recorded in the
  -- transaction meta for audit. No collection (empty method) needs none of them.
  IF v_method <> '' THEN
    IF p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_CONTEXT_UNAVAILABLE');
    END IF;
    IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' OR length(p_ip_hash) > 64 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', 'AUTH_IP_HASH_REQUIRED');
    END IF;
    IF p_idem_scope_key IS NULL OR p_idem_scope_key !~ '^[A-Za-z0-9_-]{8,128}$' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', 'AUTH_IDEM_KEY_INVALID');
    END IF;
  END IF;
  -- 140:END collection_proofs

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

  -- 140:BEGIN canonical_request
  -- B-RID-1 (migration 140). The request identity of THIS stop's collection for the canonical writer, derived here and
  -- never taken from the client. One stop = one deterministic client_request_id (the order's permanent order_uid, so a
  -- display id recycled in a later service can never replay an earlier order's transaction); the request hash binds
  -- the method, so an honest retry replays the SAME transaction and a retry with a different method is a typed
  -- conflict, never a second payment. Only 'full' exists for a rider (no partial payment in this contract). The
  -- server-forced source is re-applied LAST so no caller-supplied meta key can displace it.
  IF v_method <> '' THEN
    SELECT o.order_uid INTO v_order_uid FROM public.ordenes o WHERE o.id = p_order_id;
    IF v_order_uid IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', 'ORDER_NOT_CANONICAL');
    END IF;
    v_request_id   := 'rider-delivery-' || replace(v_order_uid::text, '-', '');
    v_request_hash := encode(sha256(convert_to(concat_ws('|', 'rider_delivery', v_order_uid::text, v_method, 'full'), 'UTF8')), 'hex');
    v_meta := v_meta || jsonb_build_object('ip_hash', p_ip_hash, 'idem_scope_key', p_idem_scope_key)
                     || jsonb_build_object('source', 'rider_delivery');
  END IF;
  -- 140:END canonical_request

  IF v_estado = 'RETIRADO' THEN
    -- Operative replay. The collection may still need reconciling: a rider whose first
    -- request completed the stop but died before the money was recorded must be able to
    -- retry. The deterministic key makes an honest retry a digest-identical replay.
    IF v_method <> '' THEN
      -- 140:BEGIN canonical_collect_replay
      -- B-RID-1 (migration 140): the SAME canonical writer as the operator, recorded AS THE RIDER. The attestation
      -- (transaction-local, bound to this actor and this order_uid) is the only way a rider is admitted by the writer's
      -- role gate; it is written here, after identity, fresh session, trip membership and state were verified, and
      -- cleared right after the call (a refusal rolls it back with the subtransaction).
      BEGIN
        PERFORM set_config('ladieci.rider_payment_attestation', p_by_actor || '|' || v_order_uid::text, true);
        v_pay := public.order_post_payment_v1(
          v_by.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid, v_method, 'full', NULL,
          v_request_id, v_request_hash, v_meta, false);
        PERFORM set_config('ladieci.rider_payment_attestation', '', true);
        -- B1 (independent review): the app shows the rider ordenes.totale as the amount to collect. A payment the canonical writer
        -- just recorded for a DIFFERENT amount (commercial adjustment, operator partial: the outstanding is not totale) would be a
        -- false success -- the rider collects what the screen says, the ledger says something else. It is refused typed and the
        -- subtransaction rolls the whole attempt back (payment, allocation, event, mirror). Residual 0 never reaches here
        -- (ORDER_PAYMENT_ALREADY_SETTLED is raised earlier and tolerated); an idempotent replay is a recorded fact, not judged again.
        IF COALESCE((v_pay->>'idempotent')::boolean, false) IS NOT TRUE
           AND round((v_pay->>'amount')::numeric, 2) IS DISTINCT FROM (SELECT round(o.totale, 2) FROM public.ordenes o WHERE o.id = p_order_id) THEN
          RAISE EXCEPTION 'RIDER_PAYMENT_AMOUNT_MISMATCH' USING ERRCODE='55000';
        END IF;
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '42501' OR SQLSTATE '23505' OR SQLSTATE '55000' THEN
        v_pay := NULL;
        v_pay_note := SQLERRM;
        IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
        END IF;
      END;
      -- 140:END canonical_collect_replay
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id,
                              'payment', v_pay, 'payment_note', v_pay_note);
  END IF;

  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  -- 140:BEGIN money_first_comment
  -- MONEY FIRST. A refusal here returns before the stop is completed, and the subtransaction
  -- has already rolled the attempted payment back: nothing half-written either way.
  -- ORDER_PAYMENT_ALREADY_SETTLED is the single tolerated refusal (B-RID-1, migration 140) —
  -- nothing is owed any more (e.g. the operator was first), so no second payment is created
  -- and the delivery is still confirmed: the same rule operator_confirm_delivery_v1 applies.
  -- 140:END money_first_comment
  IF v_method <> '' THEN
    -- 140:BEGIN canonical_collect
    BEGIN
      PERFORM set_config('ladieci.rider_payment_attestation', p_by_actor || '|' || v_order_uid::text, true);
      v_pay := public.order_post_payment_v1(
        v_by.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid, v_method, 'full', NULL,
        v_request_id, v_request_hash, v_meta, false);
      PERFORM set_config('ladieci.rider_payment_attestation', '', true);
      -- B1 (independent review): the app shows the rider ordenes.totale as the amount to collect. A payment the canonical writer
      -- just recorded for a DIFFERENT amount (commercial adjustment, operator partial: the outstanding is not totale) would be a
      -- false success -- the rider collects what the screen says, the ledger says something else. It is refused typed and the
      -- subtransaction rolls the whole attempt back (payment, allocation, event, mirror). Residual 0 never reaches here
      -- (ORDER_PAYMENT_ALREADY_SETTLED is raised earlier and tolerated); an idempotent replay is a recorded fact, not judged again.
      IF COALESCE((v_pay->>'idempotent')::boolean, false) IS NOT TRUE
         AND round((v_pay->>'amount')::numeric, 2) IS DISTINCT FROM (SELECT round(o.totale, 2) FROM public.ordenes o WHERE o.id = p_order_id) THEN
        RAISE EXCEPTION 'RIDER_PAYMENT_AMOUNT_MISMATCH' USING ERRCODE='55000';
      END IF;
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '42501' OR SQLSTATE '23505' OR SQLSTATE '55000' THEN
      v_pay := NULL;
      v_pay_note := SQLERRM;
      IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
      END IF;
    END;
    -- 140:END canonical_collect
  END IF;

  -- 140:BEGIN operative_comment
  -- OPERATIVE completion ONLY. cobrado / metodo_pago are deliberately absent here:
  -- RETIRADO does not mean paid, and the canonical writer (order_post_payment_v1) is the
  -- sole writer of those columns. A prepaid or unpaid-on-delivery stop completes with the flags untouched.
  -- 140:END operative_comment
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

ALTER FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text, text) TO service_role;

-- 4. _ledger_write_payment -- the legacy OFE-only writer: zero callers left (proved in the guard) -> DROP -------------
DROP FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text);


-- 5. Post-conditions -------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_rider text;
  v_opp   text;
  v_lit   constant text := 'hashtext(''LA_DIECI_DRIVER_STATO'')';
  r record;
BEGIN
  IF to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname = '_ledger_write_payment' AND p.pronamespace = 'public'::regnamespace) THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: _ledger_write_payment still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosrc LIKE '%\_ledger\_write\_payment(%') THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: a function body still calls _ledger_write_payment';
  END IF;
  IF to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NOT NULL
     OR (SELECT count(*) FROM pg_proc p WHERE p.proname = 'rider_collect_and_complete_stop' AND p.pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: exactly ONE rider_collect_and_complete_stop (the 8-argument one) must exist';
  END IF;

  v_rider := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)'::regprocedure);
  v_opp   := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure);
  IF md5(v_rider) IS DISTINCT FROM '4a4494aa8b579c64a9d943c7573e5ede' THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: rider_collect_and_complete_stop is not the exact 140 body';
  END IF;
  IF md5(v_opp) IS DISTINCT FROM 'ea4fe577feddbd2ba6f6ae42695feba6' THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: order_post_payment_v1 is not the exact 140 body';
  END IF;

  -- rider RPC: L0 is still the first lock (before the actor read); the canonical writer is called twice (replay +
  -- Entregado), always as the rider, always 'full', never with a duplicate override; the lost-race RAISE is intact.
  IF (length(v_rider) - length(replace(v_rider, v_lit, ''))) / length(v_lit) <> 1
     OR position(v_lit in v_rider) > position('FROM public.auth_actors' in v_rider) THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: rider_collect_and_complete_stop must take L0 exactly once, before reading the actor';
  END IF;
  IF (length(v_rider) - length(replace(v_rider, 'public.order_post_payment_v1(', ''))) / length('public.order_post_payment_v1(') <> 2
     OR v_rider NOT LIKE '%v_by.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid, v_method, ''full'', NULL,%'
     OR v_rider NOT LIKE '%v_request_id, v_request_hash, v_meta, false);%'
     OR v_rider NOT LIKE '%RAISE EXCEPTION ''RIDER_STOP_LOST_RACE'' USING ERRCODE=''40001'';%'
     OR v_rider NOT LIKE '%IF v_by.role <> ''rider'' THEN RETURN jsonb_build_object(''ok'', false, ''code'', ''AUTH_FORBIDDEN_ROLE''); END IF;%'
     OR v_rider NOT LIKE '%NON_MEMBER%' OR v_rider NOT LIKE '%trip_authority_active_trip_v1()%'
     OR (length(v_rider) - length(replace(v_rider, 'RIDER_PAYMENT_AMOUNT_MISMATCH', ''))) / length('RIDER_PAYMENT_AMOUNT_MISMATCH') <> 2 THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: rider_collect_and_complete_stop lost a contract element';
  END IF;
  IF v_rider LIKE '%INSERT INTO public.order_financial_events%' OR v_rider LIKE '%INSERT INTO public.payment_transactions%'
     OR v_rider LIKE '%INSERT INTO public.payment_allocations%' OR v_rider LIKE '%''operator''%' OR v_rider LIKE '%''admin''%' THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: rider_collect_and_complete_stop must write no ledger row itself and never name an operator/admin identity';
  END IF;

  -- writer: the attestation block is present, bound to actor + order_uid, full only, no duplicate override; every
  -- pre-existing canonical guard and the B2 receipt contract are intact.
  IF v_opp NOT LIKE '%current_setting(''ladieci.rider_payment_attestation'', true)%'
     OR v_opp NOT LIKE '%(p_by_actor || ''|'' || p_order_uid::text)%'
     OR v_opp NOT LIKE '%v_actor.role = ''rider''%' OR v_opp NOT LIKE '%p_mode = ''full''%'
     OR v_opp NOT LIKE '%p_confirm_duplicate IS NOT TRUE%'
     OR v_opp NOT LIKE '%ORDER_PAYMENT_FORBIDDEN%' OR v_opp NOT LIKE '%ORDER_PAYMENT_ALREADY_SETTLED%'
     OR v_opp NOT LIKE '%ORDER_PAYMENT_POSSIBLE_DUPLICATE%' OR v_opp NOT LIKE '%ORDER_PAYMENT_IDEMPOTENCY_CONFLICT%'
     OR v_opp NOT LIKE '%p_workspace_id, NULL, v_receipt_service_id, ''payment'', p_mode,%'
     OR v_opp NOT LIKE '%o.service_session_id, v_receipt_service_id, v_tx.id, v_now%'
     OR v_opp NOT LIKE '%v_meta := v_meta - ''off_service_receipt'';%' THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: order_post_payment_v1 lost a canonical guard or the attestation block';
  END IF;

  -- payment_transactions: the role constraint is exactly the 140 one, and NOTHING else on the table moved.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_by_role_check')
       IS DISTINCT FROM 'CHECK (((by_role = ANY (ARRAY[''admin''::text, ''operator''::text, ''owner''::text, ''cashier''::text, ''legacy_operator''::text])) OR ((by_role = ''rider''::text) AND (kind = ''payment''::text) AND (mode = ''full''::text) AND (table_session_id IS NULL) AND (covers_settled = 0) AND COALESCE(((meta -> ''source''::text) = ''"rider_delivery"''::jsonb), false))))' THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: payment_transactions_by_role_check is not the exact 140 constraint';
  END IF;
  CREATE TEMP TABLE brid140_pt_after (k text PRIMARY KEY, v text) ON COMMIT DROP;
  INSERT INTO brid140_pt_after VALUES
    ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                            FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_by_role_check')),
    ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
    ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
    ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
    ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                           WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
    ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));
  IF EXISTS (SELECT 1 FROM brid140_pt_before b JOIN brid140_pt_after a USING (k) WHERE a.v IS DISTINCT FROM b.v) THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: something on payment_transactions other than payment_transactions_by_role_check moved (%)',
      (SELECT string_agg(b.k, ', ') FROM brid140_pt_before b JOIN brid140_pt_after a USING (k) WHERE a.v IS DISTINCT FROM b.v);
  END IF;

  -- Security posture: the new rider RPC carries EXACTLY the owner / SECURITY attribute / search_path / ACL of the
  -- function it replaces (service_role only; no anon / authenticated / PUBLIC), and the writer kept its own.
  FOR r IN
    SELECT b.k, b.prosecdef AS b_sec, b.proconfig AS b_cfg, b.owner AS b_owner, b.acl AS b_acl,
           p.prosecdef AS a_sec, p.proconfig AS a_cfg, pg_get_userbyid(p.proowner) AS a_owner, p.proacl::text AS a_acl
      FROM brid140_before b
      JOIN pg_proc p ON p.oid = CASE b.k
             WHEN 'rider'  THEN 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)'::regprocedure
             WHEN 'writer' THEN 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure END
  LOOP
    IF r.a_sec IS DISTINCT FROM r.b_sec OR r.a_cfg IS DISTINCT FROM r.b_cfg
       OR r.a_owner IS DISTINCT FROM r.b_owner OR r.a_acl IS DISTINCT FROM r.b_acl THEN
      RAISE EXCEPTION 'B_RID_1 post-condition failed: % changed its owner / SECURITY attribute / search_path / ACL (before %/%/%/%, after %/%/%/%)',
        r.k, r.b_owner, r.b_sec, r.b_cfg, r.b_acl, r.a_owner, r.a_sec, r.a_cfg, r.a_acl;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B_RID_1 post-condition failed: rider_collect_and_complete_stop must be executable by service_role only';
  END IF;
END $post$;

COMMIT;
