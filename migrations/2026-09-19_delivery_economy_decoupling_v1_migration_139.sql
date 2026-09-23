-- migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql
-- Paired rollback: 2026-09-19_delivery_economy_decoupling_v1_migration_139.ROLLBACK.sql
--
-- DELIVERY_ECONOMY_DECOUPLING_V1 -- migration 139.
-- STAGING ONLY. Certified on ephemeral PostgreSQL 17 (ci/giro-authority-certification/harness/
-- runDeliveryEconomyDecoupling.js). NOT applied to staging or production by the session that
-- authored it; application needs its own authorization. Migration 138 is NOT modified: this is a
-- forward migration on top of it, and its rollback returns to the exact post-138 state.
--
-- THE PRODUCT CORRECTION (why this migration exists).
--   Migration 138 made "a service cannot be closed while a rider trip is ACTIVE for it" a database
--   invariant. The targeted live UAT passed, and the UAT also showed the RULE is wrong for the
--   business: economy must not depend on whether the driver has left, has come back, or on the
--   trip status. Delivery movement is an operational fact (Delivery / a future Planner); what the
--   economy needs is (1) is the delivery confirmed, (2) is the money confirmed, (3) what is still
--   owed. A pizzeria closing its service with a rider still out on a trip is the NORMAL case, and
--   the old rule forced it to wait for the physical return of the driver.
--
-- THE NEW INVARIANT (two halves; the second half is migration 138's, unchanged).
--   A. a trip that has ALREADY departed may outlive the close of the economic service: service
--      CLOSED + trip ACTIVE is a valid, recoverable state (the trip stays visible, readable,
--      completable and closable);
--   B. a NEW trip can never become ACTIVE for a service that is not 'open' at the moment of the
--      departure (start_rider_trip_v2, SERVICE_NOT_OPEN -- NOT touched by this migration).
--
-- THE RACE, AFTER THIS MIGRATION (L0 = the dispatch lock, hashtext('LA_DIECI_DRIVER_STATO')).
--   close first -> the dispatch waits for L0, then sees the service 'closed' -> SERVICE_NOT_OPEN,
--                  0 new trips.
--   start first -> the close waits for L0, then PROCEEDS: service CLOSED + trip ACTIVE (allowed).
--   The lock is kept in close_service_session_v3 for exactly this reason: without it "close first"
--   would no longer be guaranteed to be seen by a concurrent departure (READ COMMITTED + no shared
--   lock). Only the REFUSAL is removed.
--
-- WHAT THIS MIGRATION DOES (four functions and ONE table constraint; no table, column, index or trigger).
--   1. close_service_session_v3: the migration-138 body minus the "ACTIVE trip => refuse" block.
--      L0 is kept (lifecycle -> L0 -> row locks, as in 138). Everything else byte-identical.
--   2. trip_residual_scope_v1() -- a tiny read-only SECURITY DEFINER helper that returns the
--      service ids of the ACTIVE trip(s). It exists because trip_authority has no USAGE for
--      service_role and the Node scope resolver would otherwise never learn that a CLOSED service
--      still owns a departed trip. public.trip_projection_v1 is UNCHANGED: its scope check
--      (giro_authority.scope_valid_v1) only requires a non-empty array, it does not look at the
--      status of the services, so it already answers correctly for a closed service id.
--   3. operator_confirm_delivery_v1() -- the pizzeria's own confirmation "the customer received
--      the order": EN_ENTREGA -> RETIRADO by an admin/operator, optionally together with the
--      payment through the EXISTING canonical Cash V1 writer (order_post_payment_v1), in ONE
--      transaction under L0. rider_collect_and_complete_stop stays rider-exclusive and untouched:
--      the rider's attestation and the operator's confirmation are two callers of the same
--      business fact, each with its own identity, and the audit says who recorded it.
--
--   4. THE RECEIPT CONTRACT OF payment_transactions (CORRECTION B2, Option A). Three columns say where a payment
--      belongs and each keeps exactly ONE meaning (migration S2, unchanged by this migration):
--        order_financial_events.service_session_id        = the OBLIGATION service (the order's own, set by trigger)
--        payment_transactions.service_session_id          = the RECEIPT service (open when the money was received)
--        order_financial_events.event_service_session_id  = the EVENT / receipt service (the SAME fact)
--      Money received while NO service is open is an off-service receipt: BOTH receipt columns are NULL. The
--      order's own service is NEVER written into the receipt column -- it is not a scope anchor.
--      payment_transactions_scope_chk (migration 122) forbade that shape for an order payment (it has no table
--      session) only because the order writer used to REFUSE every off-service payment. It is replaced by a
--      strictly narrower exception: neither scope is allowed ONLY for a PAYMENT (kind), mode full|custom_amount,
--      covers_settled 0, whose meta.off_service_receipt is EXACTLY the JSON boolean true. Refunds, Mesa modes and
--      unflagged rows can never be scope-less. The condition is NULL-safe on purpose: an expression such as
--      (meta->>'off_service_receipt' = 'true' AND ...) evaluates to NULL -- which a CHECK ACCEPTS -- when the key
--      is missing, i.e. it would admit a scope-less row with no flag at all (proved on PostgreSQL 17 by the
--      harness, group b2OffServiceReceipt, K1). The two column comments that stated the old shape are corrected;
--      the rollback restores the constraint and both comments verbatim.
--   5. order_post_payment_v1 (CORRECTION B2): the CANONICAL Cash V1 order writer, ledger-126 body (md5 pinned
--      below) with ONE marked block -- it no longer refuses a payment when no service is open (the receipt is
--      then off-service: v_receipt_service_id stays NULL and is written UNCHANGED to BOTH receipt columns), and
--      the flag meta.off_service_receipt is decided by the writer alone: any value supplied by the caller is
--      discarded first. The INSERT of the transaction row is byte-identical to ledger 126. No new writer, no
--      new table, no parallel ledger: the same function, the same rows, the same idempotency and dedup.
--
-- WHAT IT NEVER DOES
--   It never closes, repairs, reopens or mutates a trip or a service; never reassigns an order's
--   service_session_id; never writes a fabricated payment; never moves a sale to another service.
--   A payment recorded after the close, with no service open, keeps the SALE and the OBLIGATION on
--   the order's ORIGINAL service (order_financial_events.service_session_id, set by trigger from the
--   order) while BOTH receipt columns are NULL: no service received that money. The closeout
--   snapshot is a photograph of the moment of the close and is NOT rewritten; current truth stays
--   in the ledger.
--
-- BODIES. The new close body is the post-138 body (ledger 138, md5 pinned below) minus the marked
-- "138:" blocks and its DECL line, plus a marked "-- 139:" comment-only block.
-- tests/deliveryEconomyDecouplingMigration.test.js proves that removing every marked block from
-- the 138 body and from the 139 body yields the SAME text (= the ledger-132 predecessor).

BEGIN;

-- Predecessor / drift guard ---------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: public.close_service_session_v3 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: public.start_rider_trip_v2 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('public.trip_projection_v1(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: public.trip_projection_v1 does not exist -- resolve drift first';
  END IF;
  IF to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: the canonical Cash V1 writer public.order_post_payment_v1 does not exist -- resolve drift first';
  END IF;
  IF to_regclass('public.orden_estado_logs') IS NULL OR to_regclass('public.auth_actors') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: orden_estado_logs / auth_actors missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'trip_authority' AND table_name = 'trips' AND column_name = 'service_session_id'
  ) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: trip_authority.trips.service_session_id is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.operator_confirm_delivery_v1(text,text,integer,jsonb)') IS NOT NULL
     OR to_regprocedure('public.trip_residual_scope_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: a 139 object already exists (already applied?) -- resolve drift first';
  END IF;

  -- The two bodies 139 depends on must be EXACTLY the ledger-138 bodies: the close body is the one this
  -- migration replaces; the start body carries the SERVICE_NOT_OPEN half of the invariant that makes
  -- removing the close-side refusal safe.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)');
  IF md5(v_src) IS DISTINCT FROM '3051158274094b46d668481b0dbdbdc5' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: close_service_session_v3 body is not the exact ledger-138 body (md5 mismatch; already applied, or drifted) -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])');
  IF md5(v_src) IS DISTINCT FROM '0323fbb1bab76a12fd2be3fed0b3187e' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: start_rider_trip_v2 body is not the exact ledger-138 body (md5 mismatch; drifted) -- the SERVICE_NOT_OPEN half of the invariant cannot be relied on';
  END IF;
  -- Correction B2: the canonical order writer this migration edits must be EXACTLY the ledger-126 body.
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)');
  IF md5(v_src) IS DISTINCT FROM '778cd30008632707e47a372e6afa5640' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: order_post_payment_v1 body is not the exact ledger-126 body (md5 mismatch; already applied, or drifted) -- resolve drift first';
  END IF;

  -- Correction B2 (Option A): the receipt-scope constraint and the two column comments this migration REPLACES must be
  -- exactly what staging has today, so that the rollback can restore them verbatim (drift => refuse, never guess).
  IF to_regclass('public.payment_transactions') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: public.payment_transactions does not exist -- resolve drift first';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk')
       IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: payment_transactions_scope_chk is not the exact migration-122 constraint (already applied, or drifted) -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint c
              WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk'
                AND obj_description(c.oid, 'pg_constraint') IS NOT NULL) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: payment_transactions_scope_chk carries a comment the rollback could not restore -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'payment_transactions' AND column_name = 'meta'
                    AND data_type = 'jsonb' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: payment_transactions.meta is not jsonb NOT NULL (the off-service flag lives there) -- resolve drift first';
  END IF;
  IF col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'service_session_id'))
       IS DISTINCT FROM 'RECEIPT SERVICE: the service session open at the moment the money was received. NULL = off-service receipt (no session open). NEVER the table''s origin service. Physical rename to receipt_service_session_id lands in S14.'
     OR col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'table_session_id'))
       IS DISTINCT FROM 'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction always carries at least one scope (table_session_id for Mesa, service_session_id for check-centric).' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING refused: the payment_transactions column comments are not the exact S2 / migration-122 texts -- resolve drift first';
  END IF;
END $guard$;

-- Snapshot of the security posture close_service_session_v3 must keep: owner, SECURITY attribute,
-- search_path and ACL. CREATE OR REPLACE preserves all four; the post-conditions re-assert it.
CREATE TEMP TABLE dec139_before (proname text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text) ON COMMIT DROP;
INSERT INTO dec139_before
  SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text
    FROM pg_proc p
   WHERE p.oid IN ('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure,
                   'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure,
                   'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure);

-- Snapshot of everything on payment_transactions this migration must NOT change (B2): every other constraint, every index,
-- every trigger, every column definition, the owner and the ACL. The post-conditions re-derive each and compare.
CREATE TEMP TABLE dec139_pt_before (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO dec139_pt_before VALUES
  ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                          FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_scope_chk')),
  ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
  ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
  ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
  ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                          FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                         WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
  ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));

-- 1. close_service_session_v3 -- the ledger-138 body WITHOUT the active-trip refusal -----------
CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
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

  -- 139:BEGIN close_l0
  -- DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139) -- the dispatch lock (L0), KEPT from migration 138.
  -- Every trip writer (start_rider_trip_v2, close_rider_trip, rider_collect_and_complete_stop,
  -- operator_confirm_delivery_v1 and the Giro Authority commands) takes L0 as its FIRST statement. This
  -- close takes it here -- after the lifecycle lock and BEFORE the first row lock below -- so a close and
  -- a trip start stay serialized by the SAME lock: whichever acquires L0 first decides, and the other one
  -- judges the COMMITTED result of the first. close first -> the departure then sees the service 'closed'
  -- and is refused (SERVICE_NOT_OPEN); departure first -> this close proceeds (a trip that has already
  -- departed may outlive the close of the economic service). Lock order of this function is unchanged:
  -- lifecycle -> L0 -> service_session_state -> service_sessions -> business_day_lifecycle_state. No
  -- function takes L0 and then the lifecycle lock (checked against every live body), so no ABBA cycle.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  -- 139:END close_l0

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

  -- 139:BEGIN close_not_blocked_by_departed_trip
  -- DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139). Migration 138 refused the close here whenever a rider
  -- trip was still ACTIVE for the service. That refusal is REMOVED on purpose: whether a driver has left,
  -- is back, or which status a trip has is an operational (Delivery) fact and must never decide whether
  -- the economic service can be finalized. An order still EN_ENTREGA at the close is handled by the
  -- existing incident policy ("Finalizar con pendientes"): the delivery stays to be confirmed, the
  -- unpaid amount stays a pending, both stay recoverable, and the departed trip stays visible and
  -- completable. No trip is read, closed or mutated by this function.
  -- 139:END close_not_blocked_by_departed_trip

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

-- 2. trip_residual_scope_v1 -- which services still own a DEPARTED (ACTIVE) trip ---------------
-- Read-only. trip_authority has no USAGE for service_role, so this is the only window Node has onto
-- "an ACTIVE trip belongs to service X even though X is no longer operational". Returns the DISTINCT
-- service_session_id of every ACTIVE trip (trips_one_active_v1 guarantees at most one today; the
-- shape does not depend on it). It reports attribution only: no member, no rider identity, no state
-- of the service. The caller unions it with the operational scope and hands the result to the
-- UNCHANGED trip_projection_v1.
CREATE FUNCTION public.trip_residual_scope_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_ids uuid[];
BEGIN
  SELECT COALESCE(array_agg(DISTINCT t.service_session_id), ARRAY[]::uuid[]) INTO v_ids
    FROM trip_authority.trips t
   WHERE t.status = 'ACTIVE';
  RETURN jsonb_build_object('ok', true, 'service_session_ids', to_jsonb(v_ids));
END $fn$;

ALTER FUNCTION public.trip_residual_scope_v1() OWNER TO postgres;
COMMENT ON FUNCTION public.trip_residual_scope_v1() IS
  'DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139). Read-only: the service_session_id of every ACTIVE trip, so the operational read scope can include the departed trip of a service that has already been closed. Never returns members, riders or service status.';


-- 3. operator_confirm_delivery_v1 -- the pizzeria confirms "the customer received the order" ---
-- EN_ENTREGA -> RETIRADO by an admin/operator, optionally together with the payment.
--
-- WHAT THE CONFIRMATION MEANS. "The pizzeria confirms the customer has received the order." It does
-- NOT mean "the driver is back": the trip is neither read nor closed here (Driver volvió stays the
-- separate, operational close_rider_trip). It does NOT mean "the money is in the drawer" either:
-- an economic PAYMENT means the customer's debt is settled; whether the banknotes are already in
-- the cash drawer is a Caja / reconciliation question, never an unpaid order.
--
-- TWO FACTS, INDEPENDENT. p_payment IS NULL  => delivery only: the order becomes RETIRADO and its
-- obligation is untouched (delivered + unpaid is a valid state; whatever is still owed stays a
-- normal pending). p_payment present => the canonical Cash V1 writer order_post_payment_v1 records
-- the payment FIRST (money-first, same discipline as rider_collect_and_complete_stop), in the same
-- transaction: any refusal returns before the delivery is confirmed and writes nothing.
--
-- IDENTITY AND AUDIT. Only an active admin/operator with a fresh session_version. The payment is
-- recorded by the operator (by_actor / by_role of the ledger event and of payment_transactions are
-- the operator's, source 'operator_delivery_confirmation') -- NEVER as the rider. The delivery
-- fact is recorded in orden_estado_logs with actor_type = the operator's role, actor_id = the
-- operator and origin 'operator_delivery_confirmation'. Neither the ledger nor the log can be
-- mistaken for a rider attestation.
--
-- NO DOUBLE FACT. Under L0 (the same lock every trip writer takes FIRST) a rider Entregado and an
-- operator confirmation of the same order serialize: the second one finds RETIRADO and answers
-- IDEMPOTENT; the canonical writer refuses a second payment (ORDER_PAYMENT_ALREADY_SETTLED is the
-- one tolerated refusal; anything else is a typed PAYMENT_REFUSED) and replays an honest retry
-- (same client_request_id) without a second event.
--
-- LOCK ORDER. L0 -> plain reads -> the writer's own lock order (workspaces, auth_actors,
-- order_entities, ordenes) -> the guarded UPDATE. This function takes NO row lock of its own before
-- the writer: locking ordenes first would invert the order a standalone Cash V1 payment uses and
-- create a real ABBA deadlock against it.
--
-- WHAT IT NEVER TOUCHES. The trip, trip_members, DRIVER_STATO, delivery_logs, service status, the
-- order's service_session_id, the obligation. A payment after the service was closed stays
-- attributed to the order's original service (ledger trigger); with NO service open the canonical writer
-- (corrected by this same migration, B2) records an off-service receipt: event_service_session_id NULL, the
-- sale/obligation stay on the order's service, nothing is reopened or invented.
CREATE FUNCTION public.operator_confirm_delivery_v1(
  p_order_id        text,
  p_by_actor        text,
  p_session_version integer,
  p_payment         jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_by       public.auth_actors%ROWTYPE;
  v_ord      public.ordenes%ROWTYPE;
  v_replay   boolean;
  v_pay      jsonb := NULL;
  v_pay_note text := NULL;
  v_updated  int;
  v_method   text := NULL;
  v_mode     text := NULL;
  v_amount   numeric := NULL;
  v_meta     jsonb := '{}'::jsonb;
BEGIN
  -- Pure input validation FIRST (no lock, no read).
  IF p_order_id IS NULL OR btrim(p_order_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND');
  END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;
  IF p_payment IS NOT NULL THEN
    IF jsonb_typeof(p_payment) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    END IF;
    v_method := lower(btrim(COALESCE(p_payment->>'method', '')));
    IF v_method NOT IN ('efectivo', 'tarjeta', 'bizum') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'AUTH_METHOD_INVALID');
    END IF;
    v_mode := COALESCE(NULLIF(btrim(p_payment->>'mode'), ''), 'full');
    IF v_mode NOT IN ('full', 'custom_amount') THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    END IF;
    IF v_mode = 'custom_amount' THEN
      IF COALESCE(p_payment->>'amount', '') !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
      END IF;
      v_amount := (p_payment->>'amount')::numeric;
    END IF;
    IF jsonb_typeof(COALESCE(p_payment->'meta', '{}'::jsonb)) <> 'object' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    END IF;
    IF (p_payment ? 'confirm_duplicate') AND jsonb_typeof(p_payment->'confirm_duplicate') <> 'boolean' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    END IF;
    -- Server-forced provenance: the client cannot claim a different source.
    v_meta := COALESCE(p_payment->'meta', '{}'::jsonb) || jsonb_build_object('source', 'operator_delivery_confirmation');
  END IF;

  -- L0 (W6.1 protocol): the same dispatch lock every trip writer -- and, since migration 138, the
  -- service close -- takes FIRST. It serializes this confirmation with a rider Entregado, with the
  -- trip close and with the service close.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  -- IDENTITY. Deliberately NOT "FOR UPDATE": a plain read is enough under L0 (see the header).
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role NOT IN ('admin', 'operator') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE');
  END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- The order, by its display id. A plain read: the guarded UPDATE below and the writer's own row
  -- lock are the serialization points.
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); END IF;
  -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name, not new vocabulary
  IF upper(COALESCE(v_ord.tipo_consegna, '')) <> 'DOMICILIO' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_ELIGIBLE', 'reason', 'NOT_DOMICILIO');
  END IF;
  IF v_ord.table_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_ELIGIBLE', 'reason', 'TABLE_ORDER');
  END IF;

  v_replay := (v_ord.estado = 'RETIRADO');
  IF NOT v_replay AND v_ord.estado IS DISTINCT FROM 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'estado', v_ord.estado);
  END IF;
  IF v_ord.order_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_CANONICAL');
  END IF;

  -- MONEY FIRST. A refusal returns before the delivery is confirmed, and the subtransaction has
  -- already rolled the attempted payment back: nothing half-written either way. The ONE tolerated
  -- refusal is ORDER_PAYMENT_ALREADY_SETTLED (the debt is already settled -- e.g. the rider was
  -- first): the delivery is still confirmed and no second payment exists. A replay of a delivery
  -- that is already RETIRADO still reconciles an explicitly supplied payment through the same writer.
  IF p_payment IS NOT NULL THEN
    BEGIN
      v_pay := public.order_post_payment_v1(
        v_by.workspace_id, p_by_actor, p_payment->>'by_sid_hash', v_ord.order_uid,
        v_method, v_mode, v_amount, p_payment->>'client_request_id', p_payment->>'request_hash',
        v_meta, COALESCE((p_payment->>'confirm_duplicate')::boolean, false));
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' OR SQLSTATE '42501' OR SQLSTATE '23505' OR SQLSTATE '55000' THEN
      v_pay := NULL;
      v_pay_note := SQLERRM;
      IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
      END IF;
    END;
  END IF;

  IF v_replay THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id,
                              'payment', v_pay, 'payment_note', v_pay_note);
  END IF;

  -- The delivery fact. Same columns the rider's Entregado writes (estado + hora_entrega); the
  -- obligation and every payment flag stay the ledger's business.
  UPDATE public.ordenes
     SET estado       = 'RETIRADO',
         hora_entrega = (extract(epoch FROM now()) * 1000)::bigint
   WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    -- Lost the race after taking the money: ABORT so the recorded payment cannot survive a
    -- delivery that was not confirmed. Must RAISE, never RETURN.
    RAISE EXCEPTION 'OPERATOR_DELIVERY_LOST_RACE' USING ERRCODE = '40001';
  END IF;

  -- The audit of WHO recorded the delivery: the operator, never the rider.
  INSERT INTO public.orden_estado_logs
    -- language-guard: allow-legacy numero_ordine is the existing orden_estado_logs column name, not new vocabulary
    (orden_id, numero_ordine, estado_from, estado_to, event_type, actor_type, actor_id, origin, metadata)
  VALUES
    (p_order_id, p_order_id, 'EN_ENTREGA', 'RETIRADO', 'delivered', v_by.role, p_by_actor,
     'operator_delivery_confirmation',
     jsonb_build_object('source', 'operator_delivery_confirmation', 'recorded_by_role', v_by.role,
                        'payment_recorded', (v_pay IS NOT NULL AND COALESCE((v_pay->>'idempotent')::boolean, false) = false)));

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id,
                            'payment', v_pay, 'payment_note', v_pay_note);
END
$fn$;

ALTER FUNCTION public.operator_confirm_delivery_v1(text, text, integer, jsonb) OWNER TO postgres;
COMMENT ON FUNCTION public.operator_confirm_delivery_v1(text, text, integer, jsonb) IS
  'DELIVERY_ECONOMY_DECOUPLING_V1 (migration 139). The pizzeria confirms that the customer received a delivery order (EN_ENTREGA -> RETIRADO), optionally with the payment through the canonical Cash V1 writer, in one transaction under the dispatch lock. Recorded as the operator, never as the rider. Does not touch the trip.';

-- 4. payment_transactions -- the RECEIPT-scope contract (B2, Option A) --------------------------------------
-- payment_transactions_scope_chk is REPLACED (DROP + ADD, same name) by the strictly narrower exception described in
-- the header: a scope-less row is valid ONLY as an off-service PAYMENT receipt (kind payment, mode full|custom_amount,
-- covers_settled 0, meta.off_service_receipt exactly boolean true). Every other row is judged exactly as before
-- (table_session_id OR service_session_id). The new predicate is a superset of the old one, so no existing row can fail.
-- NULL-SAFETY: the flag test is COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false). A bare
-- (meta ->> 'off_service_receipt') = 'true' is NULL when the key is missing and a CHECK accepts NULL.
ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_scope_chk;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk CHECK (
  table_session_id IS NOT NULL
  OR service_session_id IS NOT NULL
  OR (
        table_session_id IS NULL
    AND service_session_id IS NULL
    AND kind = 'payment'
    AND mode IN ('full', 'custom_amount')
    AND covers_settled = 0
    AND COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)
  )
);
COMMENT ON CONSTRAINT payment_transactions_scope_chk ON public.payment_transactions IS
  'RECEIPT SCOPE CONTRACT (migration 139). A transaction carries table_session_id (Mesa) or service_session_id (the service that RECEIVED the money). The only shape with neither is a check-centric off-service PAYMENT receipt: kind payment, mode full|custom_amount, covers_settled 0 and meta.off_service_receipt exactly boolean true, written server-side by order_post_payment_v1 when no service is open. Refunds, Mesa modes and unflagged rows can never be scope-less.';
COMMENT ON COLUMN public.payment_transactions.service_session_id IS
  'RECEIPT SERVICE: the service session open at the moment the money was received. NULL = off-service receipt (no session open). NEVER the table''s origin service and NEVER the order''s own service: it is a receipt attribute, not a scope anchor. A check-centric (order) payment received while no service is open carries NULL here AND NULL in order_financial_events.event_service_session_id -- the same fact; payment_transactions_scope_chk admits that shape only for a payment the canonical writer marked meta.off_service_receipt = true (migration 139). The order''s own service lives in order_financial_events.service_session_id. Physical rename to receipt_service_session_id lands in S14.';
COMMENT ON COLUMN public.payment_transactions.table_session_id IS
  'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction carries at least one scope (table_session_id for Mesa, service_session_id for check-centric), except a check-centric payment received while no service was open (off-service receipt, migration 139), which carries neither and is marked meta.off_service_receipt = true by the canonical writer.';

-- 5. order_post_payment_v1 -- the canonical order writer, no longer refusing an off-service receipt (B2) ----
-- The ledger-126 body (md5 778cd30008632707e47a372e6afa5640 = staging live) with ONE marked block: see the
-- "139:BEGIN off_service_receipt" block. CREATE OR REPLACE keeps owner / SECURITY attribute / search_path / ACL
-- (re-asserted in the post-conditions). tests/deliveryEconomyDecouplingMigration.test.js re-derives this body from
-- the migration-126 file with that single replacement and requires byte equality.
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

REVOKE ALL ON FUNCTION public.trip_residual_scope_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_residual_scope_v1() TO service_role;
REVOKE ALL ON FUNCTION public.operator_confirm_delivery_v1(text, text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.operator_confirm_delivery_v1(text, text, integer, jsonb) TO service_role;


-- 6. Post-conditions ------------------------------------------------------------------------
DO $$
DECLARE
  v_close text;
  v_start text;
  v_op    text;
  v_res   text;
  v_opp   text;
  v_lit   constant text := 'hashtext(''LA_DIECI_DRIVER_STATO'')';
  p_lc integer; p_l0 integer; p_row integer;
  r record;
BEGIN
  v_close := pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure);
  v_start := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);
  v_op    := pg_get_functiondef('public.operator_confirm_delivery_v1(text,text,integer,jsonb)'::regprocedure);
  v_res   := pg_get_functiondef('public.trip_residual_scope_v1()'::regprocedure);

  -- close: L0 is kept (exactly once, after the lifecycle lock, before the first row lock) ...
  IF (length(v_close) - length(replace(v_close, v_lit, ''))) / length(v_lit) <> 1 THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: close_service_session_v3 must still acquire L0 exactly once';
  END IF;
  p_lc  := position('hashtext(''service_session_lifecycle'')' in v_close);
  p_l0  := position(v_lit in v_close);
  p_row := position('FOR UPDATE' in v_close);
  IF NOT (p_lc > 0 AND p_l0 > p_lc AND p_row > p_l0) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: close lock order must stay lifecycle -> L0 -> first row lock (lifecycle %, L0 %, row %)', p_lc, p_l0, p_row;
  END IF;
  -- ... and the active-trip refusal is GONE: no trip read, no trip refusal code, no trip variable.
  IF v_close LIKE '%trip_projection_v1%' OR v_close LIKE '%V3_CLOSE_ACTIVE_RIDER_TRIP%'
     OR v_close LIKE '%V3_CLOSE_RIDER_TRIP_UNVERIFIABLE%' OR v_close LIKE '%v_trip%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: close_service_session_v3 still reads or refuses on a rider trip';
  END IF;
  IF v_close NOT LIKE '%V3_CLOSED%' OR v_close NOT LIKE '%ALREADY_CLOSED%' OR v_close NOT LIKE '%SESSION_CLOSE_IDENTITY_MISMATCH%'
     OR v_close NOT LIKE '%CURRENT_SESSION_MISMATCH%' OR v_close NOT LIKE '%BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH%'
     OR v_close NOT LIKE '%giro_intent_service_close_sweep%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: close_service_session_v3 lost a pre-existing outcome/guard literal';
  END IF;

  -- start: NOT touched -- the exact ledger-138 body, still refusing a departure for a service that is not open.
  IF md5((SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure))
       IS DISTINCT FROM '0323fbb1bab76a12fd2be3fed0b3187e' OR v_start NOT LIKE '%SERVICE_NOT_OPEN%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: start_rider_trip_v2 must be untouched';
  END IF;

  -- order_post_payment_v1 (B2): the exact 139 body, still the ONE canonical writer: off-service receipt supported,
  -- the typed no-context refusal kept, and none of the pre-existing guards lost.
  v_opp := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure);
  IF md5(v_opp) IS DISTINCT FROM 'af52d59658719bd7898d9cd88dd29179' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: order_post_payment_v1 is not the exact 139 body';
  END IF;
  IF v_opp NOT LIKE '%off_service_receipt%'
     OR v_opp NOT LIKE '%IF v_ord.service_session_id IS NULL THEN%' OR v_opp NOT LIKE '%ORDER_PAYMENT_NO_OPEN_SERVICE%'
     OR v_opp NOT LIKE '%ORDER_PAYMENT_ALREADY_SETTLED%' OR v_opp NOT LIKE '%ORDER_PAYMENT_POSSIBLE_DUPLICATE%'
     OR v_opp NOT LIKE '%ORDER_PAYMENT_ORDER_CANCELLED%' OR v_opp NOT LIKE '%ORDER_PAYMENT_IDEMPOTENCY_CONFLICT%'
     OR v_opp NOT LIKE '%event_service_session_id%' OR v_opp LIKE '%INSERT INTO public.service_sessions%'
     OR v_opp LIKE '%UPDATE public.service_sessions%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: order_post_payment_v1 lost a canonical guard or gained a service write';
  END IF;
  -- B2 contract: BOTH receipt columns take v_receipt_service_id UNCHANGED; the order's own service is never a receipt or a
  -- scope anchor (no COALESCE/fallback anywhere); the flag is decided by the writer (caller-supplied value discarded first).
  IF v_opp NOT LIKE '%p_workspace_id, NULL, v_receipt_service_id, ''payment'', p_mode,%'
     OR v_opp NOT LIKE '%o.service_session_id, v_receipt_service_id, v_tx.id, v_now%'
     OR v_opp LIKE '%COALESCE(v_receipt_service_id%' OR v_opp LIKE '%v_receipt_service_id := %'
     OR v_opp NOT LIKE '%v_meta := v_meta - ''off_service_receipt'';%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: order_post_payment_v1 must write v_receipt_service_id unchanged to both receipt columns and decide the off-service flag itself';
  END IF;

  -- payment_transactions (B2): the receipt-scope constraint is exactly the new narrow one, both column comments say the
  -- receipt contract, and NOTHING else on the table moved (every other constraint, index, trigger, column, owner, ACL).
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk')
       IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL) OR ((table_session_id IS NULL) AND (service_session_id IS NULL) AND (kind = ''payment''::text) AND (mode = ANY (ARRAY[''full''::text, ''custom_amount''::text])) AND (covers_settled = 0) AND COALESCE(((meta -> ''off_service_receipt''::text) = ''true''::jsonb), false))))' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: payment_transactions_scope_chk is not the exact 139 constraint';
  END IF;
  IF md5(COALESCE((SELECT obj_description(c.oid, 'pg_constraint') FROM pg_constraint c
                    WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname = 'payment_transactions_scope_chk'), ''))
       IS DISTINCT FROM 'ce5acd99d9e8383d42b792948afdd5b7'
     OR md5(COALESCE(col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'service_session_id')), ''))
       IS DISTINCT FROM '9d13c6006aa59f96efd6988b6bdb3225'
     OR md5(COALESCE(col_description('public.payment_transactions'::regclass, (SELECT a.attnum FROM pg_attribute a WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attname = 'table_session_id')), ''))
       IS DISTINCT FROM '85485ad4bafc274d70f902ddd3cb3f13' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: a payment_transactions comment is not the exact 139 text';
  END IF;
  CREATE TEMP TABLE dec139_pt_after (k text PRIMARY KEY, v text) ON COMMIT DROP;
  INSERT INTO dec139_pt_after VALUES
    ('other_constraints', (SELECT md5(COALESCE(string_agg(c.conname || ':' || pg_get_constraintdef(c.oid), '|' ORDER BY c.conname), ''))
                            FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND c.conname <> 'payment_transactions_scope_chk')),
    ('constraint_count',  (SELECT count(*)::text FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass)),
    ('indexes',           (SELECT md5(COALESCE(string_agg(i.indexdef, '|' ORDER BY i.indexname), '')) FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'payment_transactions')),
    ('triggers',          (SELECT md5(COALESCE(string_agg(pg_get_triggerdef(t.oid), '|' ORDER BY t.tgname), '')) FROM pg_trigger t WHERE t.tgrelid = 'public.payment_transactions'::regclass AND NOT t.tgisinternal)),
    ('columns',           (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), ''), '|' ORDER BY a.attnum))
                            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                           WHERE a.attrelid = 'public.payment_transactions'::regclass AND a.attnum > 0 AND NOT a.attisdropped)),
    ('owner_acl',         (SELECT pg_get_userbyid(c.relowner) || '|' || COALESCE(c.relacl::text, '') FROM pg_class c WHERE c.oid = 'public.payment_transactions'::regclass));
  IF EXISTS (SELECT 1 FROM dec139_pt_before b JOIN dec139_pt_after a USING (k) WHERE a.v IS DISTINCT FROM b.v) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: something on payment_transactions other than payment_transactions_scope_chk and its comments changed (%)',
      (SELECT string_agg(b.k, ', ') FROM dec139_pt_before b JOIN dec139_pt_after a USING (k) WHERE a.v IS DISTINCT FROM b.v);
  END IF;

  -- operator RPC: L0 before every other statement that reads or locks; canonical writer reused; it must
  -- never touch a trip; SECURITY INVOKER, search_path public, pg_temp.
  IF (length(v_op) - length(replace(v_op, v_lit, ''))) / length(v_lit) <> 1
     OR position(v_lit in v_op) > position('FROM public.auth_actors' in v_op) THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: operator_confirm_delivery_v1 must take L0 exactly once, before reading the actor';
  END IF;
  IF v_op NOT LIKE '%public.order_post_payment_v1(%' OR v_op LIKE '%_ledger_write_payment%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: operator_confirm_delivery_v1 must use the canonical Cash V1 writer and nothing else';
  END IF;
  IF v_op LIKE '%trip_authority%' OR v_op LIKE '%close_rider_trip%' OR v_op LIKE '%public.config%'
     OR v_op LIKE '%delivery_logs%' OR v_op LIKE '%service_sessions%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: operator_confirm_delivery_v1 must not touch a trip, the DRIVER_STATO config row, delivery_logs or a service';
  END IF;
  IF v_op NOT LIKE '%''operator_delivery_confirmation''%' OR v_op NOT LIKE '%OPERATOR_DELIVERY_LOST_RACE%'
     OR v_op NOT LIKE '%IN (''admin'', ''operator'')%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: operator_confirm_delivery_v1 lost a contract literal';
  END IF;
  IF v_res LIKE '%member%' OR v_res LIKE '%rider_actor%' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: trip_residual_scope_v1 must report attribution only';
  END IF;

  -- Security posture: close/start/order writer keep owner, SECURITY attribute, search_path and ACL; the two new functions
  -- carry exactly the ACL of their siblings ({postgres, service_role}) and nothing for anon/authenticated/PUBLIC.
  FOR r IN
    SELECT b.proname, b.prosecdef AS b_sec, b.proconfig AS b_cfg, b.owner AS b_owner, b.acl AS b_acl,
           p.prosecdef AS a_sec, p.proconfig AS a_cfg, pg_get_userbyid(p.proowner) AS a_owner, p.proacl::text AS a_acl
      FROM dec139_before b
      JOIN pg_proc p ON p.oid = CASE b.proname
             WHEN 'close_service_session_v3' THEN 'public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure
             WHEN 'start_rider_trip_v2'      THEN 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure
             WHEN 'order_post_payment_v1'    THEN 'public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)'::regprocedure END
  LOOP
    IF r.a_sec IS DISTINCT FROM r.b_sec OR r.a_cfg IS DISTINCT FROM r.b_cfg
       OR r.a_owner IS DISTINCT FROM r.b_owner OR r.a_acl IS DISTINCT FROM r.b_acl THEN
      RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: % changed its owner / SECURITY attribute / search_path / ACL', r.proname;
    END IF;
  END LOOP;
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig::text AS cfg, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl
      FROM pg_proc p
     WHERE p.oid IN ('public.operator_confirm_delivery_v1(text,text,integer,jsonb)'::regprocedure,
                     'public.trip_residual_scope_v1()'::regprocedure)
  LOOP
    IF r.owner <> 'postgres' OR r.acl IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
      RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: % must be owned by postgres with ACL {postgres, service_role} only (owner %, acl %)', r.proname, r.owner, r.acl;
    END IF;
    IF r.proname = 'operator_confirm_delivery_v1' AND (r.prosecdef IS DISTINCT FROM false OR r.cfg IS DISTINCT FROM '{"search_path=public, pg_temp"}') THEN
      RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: operator_confirm_delivery_v1 must be SECURITY INVOKER with search_path public, pg_temp';
    END IF;
    IF r.proname = 'trip_residual_scope_v1' AND (r.prosecdef IS DISTINCT FROM true OR r.cfg IS DISTINCT FROM '{"search_path=pg_catalog, pg_temp"}') THEN
      RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: trip_residual_scope_v1 must be SECURITY DEFINER with search_path pg_catalog, pg_temp';
    END IF;
  END LOOP;
END $$;

COMMIT;
