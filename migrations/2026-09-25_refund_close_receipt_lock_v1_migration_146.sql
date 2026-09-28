-- migrations/2026-09-25_refund_close_receipt_lock_v1_migration_146.sql
-- FINDING B -- REFUND OFF-SERVICE + REFUND x SERVICE CLOSE (DELIVERY x ECONOMIA V1, 2026-09-25): THE REFUND RECEIPT SERVICE IS DECIDED UNDER A SHARE LOCK ON THE
-- LIFECYCLE POINTER, AND A CHECK-CENTRIC ORDER REFUND WITH NO OPEN SERVICE IS A TYPED REFUSAL.
--
-- WHY. order_post_refund_v1 and mesa_post_refund_v1 decide the receipt service with the SAME unlocked SELECT of service_session_state joined to
-- service_sessions.status = 'open' that migration 145 locked in the two payment writers: a close_service_session_v3 that has not committed yet is invisible
-- to it, the refund INSERT only waits on the service row's FK, and the refund receipt lands on a service that has just been closed (reproduced on both writers).
-- For the ORDER refund the lock alone is not enough: after the close the SELECT reads no open service and the scope-less refund row violates
-- payment_transactions_scope_chk (raw 23514 -> HTTP 500). M139 excludes refunds from the scope-less exception by construction; the order-refund contract
-- is therefore a TYPED refusal, not a wider ledger. The Mesa refund with no open service is ALREADY valid (table scope, event receipt NULL) and stays as is.
-- Contract and proof: DELIVERY_ECONOMY_V1_FINDING_B_REFUND_DECISION_2026-09-24.md (frozen, REFUND_FINDING_B_DESIGN_READY). No design choice is reopened here.
--
-- WHAT. EXACTLY TWO functions are re-issued; their predecessors are the LIVE staging bodies (migration-122 text as staging stores it, with the historical
-- UTF-8 -> MacRoman mojibake of the section sign in the comments; the file embeds those bytes on purpose, a UTF-8 re-typing of migration 122 would not match):
--   * public.order_post_refund_v1(...)  predecessor md5(prosrc) f057928b8f6fade25d38d4bb1d3ed09a -> 146 body md5 687b55f29d69323d54a73111529cebe9. TWO marked blocks:
--       -- 146:BEGIN refund_receipt_pointer_lock        PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;   IMMEDIATELY BEFORE the unchanged receipt SELECT
--       -- 146:BEGIN order_refund_requires_open_service IF v_receipt_service_id IS NULL THEN RAISE EXCEPTION 'ORDER_REFUND_NO_OPEN_SERVICE' USING ERRCODE = '55000';
--                                                       IMMEDIATELY AFTER that SELECT and before the first write of the refund path
--   * public.mesa_post_refund_v1(...)   predecessor md5(prosrc) 62f0e128a6e5d0623b0423a69f0329d3 -> 146 body md5 9679556fe209fbadac5275b3ac71e456. ONE marked block: the same pointer lock, nothing
--       else. NO refusal: MESA_REFUND_OFF_SERVICE stays ALLOWED_TABLE_SCOPED (payment_transactions.service_session_id = the table's origin service,
--       order_financial_events.event_service_session_id = NULL when no service is open), exactly the existing contract.
-- Error precedence is unchanged and the new refusal comes LAST before the writes: validation -> authorization -> idempotent replay (returns BEFORE the lock and the
-- refusal: a valid replay is never refused) -> order / original-transaction validation -> refundable-amount validation -> pointer lock -> receipt SELECT ->
-- typed no-service refusal (order only) -> writes. No L, no L0, no service-row lock, no FOR UPDATE / FOR KEY SHARE, no retry, no DDL, no data.
-- Effect: refund and close are TOTALLY ORDERED on the pointer row -- refund first: the close waits and the receipt is the still-open service; close first: the
-- refund waits, rereads the pointer and records the next open service B, or (order) ORDER_REFUND_NO_OPEN_SERVICE / (Mesa) the event receipt NULL.
--
-- ISOLATION (recorded, not changed): the rule "the refund rereads the pointer after the close commits" holds under READ COMMITTED (a new snapshot per statement),
-- which is what staging runs (default_transaction_isolation = read committed, no database / role / function override; an RPC cannot change its own level, 25001).
-- Under REPEATABLE READ / SERIALIZABLE the same interleaving fails CLOSED with 40001 (never a wrong receipt). The final PG17 pre-apply gate re-checks
-- default_transaction_isolation, pg_db_role_setting and the proconfig of the writers.
--
-- PREREQUISITE (technical, fail-closed): migration 143 (order_intake_lock_prelude_v1 + trigger a0_order_intake_lock_prelude_v1, enabled, BEFORE INSERT FOR EACH
--   ROW, no WHEN, the first BEFORE INSERT trigger of public.ordenes). Without it the old intake order ([TS] -> L -> SS -> D -> W) plus this lock (taken by a refund
--   that already holds W) closes a cycle (measured in the design: 28 deadlocks on intake x refund pairs without 143).
-- LINEAGE OF THE ECONOMY PACKAGE (fail-closed, NOT a semantic dependency): the rollout is manual, so 146 also refuses unless migration 145 (Finding A) is already
--   applied -- order_post_payment_v1 md5 799f8093328b4ac81e1ad5a3d37e1bb6, mesa_post_payment_v1 md5 94867e165d0732f36ae4692fc6998c58 -- to prevent an incomplete Economy rollout.
-- ROLLOUT for the Economia base: 139 -> 140 -> 143 -> 144 -> 145 -> 146.   ROLLBACK ORDER: 146 FIRST, then 145, then 144 / 143 by their frozen rules.
--   The rollback of 146 has NO dependency on 145 (it restores the two refund predecessors whether or not 145 is still applied).
--
-- NOT TOUCHED (frozen): order_post_payment_v1 / mesa_post_payment_v1 (145), close_service_session_v3, open_operational_service_v1, ensure_service_session,
-- resolve_order_intake_context_v1, operator_confirm_delivery_v1, rider_collect_and_complete_stop, order_initial_payment_v1, order_cancel_v1, the 143 prelude,
-- payment_transactions_scope_chk (M139) and every other table / trigger / constraint / index / grant / row. M141 / M142 (Fiscal) are not part of this rollout.
--
-- DRIFT GUARDS (fail closed; nothing is created if any fails): UTF-8 transport of the embedded live bytes; 143 present; 145 lineage; the two refund writers exist
-- exactly once with the pinned signatures; not already applied; md5(prosrc) = the pins; service_role exists, has SELECT + UPDATE on service_session_state
-- (required for FOR SHARE), and row-level security is off or bypassed (staging: BYPASSRLS).
-- POST-CONDITIONS: exactly the two functions changed (every other function of every user schema byte-identical, none added or removed); new md5 pins; each block
-- present exactly once and byte-exact; lock immediately before the receipt SELECT; refusal immediately after it and before the first write (order only);
-- NO refusal and no ORDER_REFUND_NO_OPEN_SERVICE in the Mesa writer; the bodies without their blocks are byte-for-byte the predecessors; owner / SECURITY
-- INVOKER / search_path / ACL / signature / return unchanged; the 145 payment bodies unchanged; no trigger / constraint / column / index / relation / ACL change.
--
-- ROLLBACK: migrations/2026-09-25_refund_close_receipt_lock_v1_migration_146.ROLLBACK.sql (re-issues both live predecessors verbatim; refuses over anything that is not
-- exactly the 146 bodies). STAGING ONLY. NOT applied by the session that authored it (staging ledger tip is 138; 139 / 140 / 143 / 144 / 145 are not applied either).

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
  -- 0.a transport of the embedded live bytes
  -- the file embeds the LIVE bodies byte for byte, including the historical mojibake of their comments ("¬ß", the UTF-8 section sign read as MacRoman);
  -- it must reach the server as UTF-8, otherwise the re-issued bodies would silently differ from the pins
  IF current_setting('server_encoding') <> 'UTF8' OR octet_length('¬ß') <> 4 OR md5('¬ß') IS DISTINCT FROM '45e0e64ed4f04e4ea4e6e21148e2eadc' THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: this file must be sent as UTF-8 to a UTF8 database (client_encoding %, server_encoding %) -- the embedded live bodies would not match their md5 pins', current_setting('client_encoding'), current_setting('server_encoding');
  END IF;
  -- 0.b prerequisite: migration 143 (the C8 intake prelude)
  IF to_regprocedure('public.order_intake_lock_prelude_v1()') IS NULL THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: migration 143 (public.order_intake_lock_prelude_v1) is not applied -- apply 143 first; without it this lock deadlocks against the old intake order';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname = 'a0_order_intake_lock_prelude_v1'
                    AND t.tgfoid = to_regprocedure('public.order_intake_lock_prelude_v1()') AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
                    AND (t.tgtype & 8) = 0 AND (t.tgtype & 16) = 0 AND (t.tgtype & 32) = 0 AND t.tgqual IS NULL AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: trigger a0_order_intake_lock_prelude_v1 is missing, disabled or is not the BEFORE INSERT FOR EACH ROW trigger of the 143 prelude -- apply / repair 143 first';
  END IF;
  SELECT min(t.tgname) INTO v_first FROM pg_trigger t
   WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4;
  IF v_first IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: the 143 prelude is not the first BEFORE INSERT trigger of public.ordenes (first is %) -- resolve drift first', v_first;
  END IF;
  -- 0.c Economy package lineage: migration 145 (Finding A) must already be applied (rollout order, not a semantic dependency)
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)', 'order_post_payment_v1', '799f8093328b4ac81e1ad5a3d37e1bb6'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', 'mesa_post_payment_v1', '94867e165d0732f36ae4692fc6998c58')
    ) AS t(sig, name, want)
  LOOP
    IF to_regprocedure(v_pin.sig) IS NULL OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: ECONOMY_LINEAGE -- migration 145 is not applied (% is not the 145 body %) -- the Economy rollout is 139 -> 140 -> 143 -> 144 -> 145 -> 146', v_pin.name, v_pin.want;
    END IF;
  END LOOP;
  -- 0.d the two refund writers: exact signature, single overload, not already applied, exact live predecessor body
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', 'order_post_refund_v1', 'f057928b8f6fade25d38d4bb1d3ed09a'),
      ('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', 'mesa_post_refund_v1', '62f0e128a6e5d0623b0423a69f0329d3')
    ) AS t(sig, name, want)
  LOOP
    IF to_regprocedure(v_pin.sig) IS NULL THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: % is missing -- resolve drift first', v_pin.sig;
    END IF;
    IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_pin.name) <> 1 THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: % has an unexpected overload set -- resolve drift first', v_pin.name;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
    IF position('-- 146:BEGIN ' IN v_src) > 0 THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: already applied (% already carries a 146 block)', v_pin.name;
    END IF;
    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: % is not the pinned live predecessor body (md5 mismatch: %, expected %) -- resolve drift first; a divergent body is never overwritten', v_pin.name, md5(v_src), v_pin.want;
    END IF;
  END LOOP;
  -- 0.e the lock is a row lock on the lifecycle pointer, taken by service_role (the caller): SELECT + UPDATE privilege are required for FOR SHARE, and RLS must not apply
  IF to_regclass('public.service_session_state') IS NULL OR to_regclass('public.service_sessions') IS NULL THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: service_session_state / service_sessions are missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: role service_role does not exist';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.service_session_state', 'SELECT') OR NOT has_table_privilege('service_role', 'public.service_session_state', 'UPDATE') THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: service_role lacks SELECT + UPDATE on public.service_session_state (required for SELECT ... FOR SHARE) -- the writers would fail with 42501';
  END IF;
  SELECT c.relrowsecurity INTO v_rls FROM pg_class c WHERE c.oid = 'public.service_session_state'::regclass;
  SELECT r.rolbypassrls INTO v_bypass FROM pg_roles r WHERE r.rolname = 'service_role';
  IF v_rls AND NOT v_bypass THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK refused: row-level security is enabled on public.service_session_state and service_role does not bypass it -- FOR SHARE would be filtered by policy';
  END IF;
END $guard$;

-- Before-state: every function of every user schema, the posture of the two writers, and a catalog fingerprint (the post-conditions prove nothing else moved).
CREATE TEMP TABLE c146_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
CREATE TEMP TABLE c146_posture_before (k text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text, proretset boolean, prorettype regtype, args text) ON COMMIT DROP;
CREATE TEMP TABLE c146_cat_before (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO c146_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
INSERT INTO c146_posture_before
  SELECT p.proname::text, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text, p.proretset, p.prorettype::regtype, pg_get_function_arguments(p.oid)
    FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)'), to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)'));
INSERT INTO c146_cat_before (k, v)
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

-- 1. The two refund writers: live predecessor + the marked block(s) around the unchanged receipt-service SELECT ------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_post_refund_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_order_uid uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric, p_meta jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_entity public.order_entities%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_original public.payment_transactions%ROWTYPE;
  v_alloc public.payment_allocations%ROWTYPE;
  v_refund_tx public.payment_transactions%ROWTYPE;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_reason text;
  v_remaining_cents bigint;
  v_amount_cents bigint;
  v_remaining_after_cents bigint;
  v_receipt_service_id uuid;
  v_settlement text;
  v_obligation_cents bigint;
  v_paid_before_cents bigint;
  v_new_paid_cents bigint;
  v_prev_state text;
  v_new_state text;
  v_scope text;
  v_method_count integer;
  v_method_max text;
  v_is_paid boolean;
  v_method_projection text;
  v_audit_id bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_order_uid IS NULL OR p_original_transaction_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_REFUND_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ORDER_REFUND_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RAISE EXCEPTION 'ORDER_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'ORDER_REFUND_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- REFUND_ROLES, identical to Mesa: admin/owner only (¬ß25, no widening --
  -- the role that takes money is deliberately not the one that returns it).
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'ORDER_REFUND_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'ORDER_REFUND_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    SELECT round(pt.amount*100)::bigint - COALESCE((
        SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
         WHERE r.kind='refund' AND r.reverses_transaction_id = pt.id
      ),0) INTO v_remaining_after_cents
      FROM public.payment_transactions pt WHERE pt.id = v_existing.reverses_transaction_id;
    RETURN jsonb_build_object('ok', true, 'idempotent', true,
      'refundTransactionId', v_existing.id, 'reversesTransactionId', v_existing.reverses_transaction_id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'refundableRemainingOnOriginal', COALESCE(v_remaining_after_cents,0) / 100.0,
      'orderUid', p_order_uid);
  END IF;

  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_entity.workspace_id <> p_workspace_id THEN
    RAISE EXCEPTION 'ORDER_REFUND_WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Lock the ORIGINAL transaction -- serialises concurrent over-refund
  -- attempts exactly like mesa_post_refund_v1.
  SELECT * INTO v_original FROM public.payment_transactions
   WHERE id = p_original_transaction_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_TRANSACTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_original.kind <> 'payment' THEN RAISE EXCEPTION 'ORDER_REFUND_NOT_REFUNDABLE' USING ERRCODE='55000'; END IF;
  -- A Mesa (table-bound) transaction can never be refunded through this
  -- check-centric route -- symmetric to the null-safe guard mesa_post_
  -- refund_v1 now carries (¬ß28 of the brief).
  IF v_original.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_REFUND_NOT_CHECK_CENTRIC' USING ERRCODE='55000'; END IF;

  SELECT * INTO v_alloc FROM public.payment_allocations
   WHERE payment_transaction_id = v_original.id AND table_order_line_id IS NULL;
  IF NOT FOUND OR v_alloc.order_uid IS DISTINCT FROM p_order_uid THEN
    RAISE EXCEPTION 'ORDER_REFUND_TRANSACTION_MISMATCH' USING ERRCODE='55000'; END IF;

  SELECT round(v_original.amount*100)::bigint - COALESCE((
      SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
       WHERE r.kind='refund' AND r.reverses_transaction_id = v_original.id
    ),0) INTO v_remaining_cents;
  IF v_remaining_cents <= 0 THEN RAISE EXCEPTION 'ORDER_REFUND_ALREADY_FULL' USING ERRCODE='55000'; END IF;

  v_amount_cents := CASE WHEN p_amount IS NULL THEN v_remaining_cents ELSE round(p_amount*100)::bigint END;
  IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'ORDER_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount_cents > v_remaining_cents THEN RAISE EXCEPTION 'ORDER_REFUND_EXCEEDS_REMAINING' USING ERRCODE='55000'; END IF;

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
  -- 146:BEGIN order_refund_requires_open_service
  IF v_receipt_service_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_REFUND_NO_OPEN_SERVICE'
      USING ERRCODE = '55000';
  END IF;
  -- 146:END order_refund_requires_open_service

  -- ¬ßH.4 -- record, don't claim: tarjeta/bizum note that La Dieci is
  -- RECORDING an externally executed return, never that it executed a
  -- bank/POS operation. Identical language to mesa_post_refund_v1.
  v_settlement := CASE WHEN v_original.payment_method = 'efectivo' THEN 'drawer' ELSE 'external' END;

  -- The refund's payment_method is FORCED from the original -- same-tender
  -- invariant, no caller-supplied method exists in this signature.
  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, reverses_transaction_id, by_actor, by_role,
    by_sid_hash, client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, NULL, v_receipt_service_id, 'refund', 'refund',
    v_amount_cents / 100.0, v_original.payment_method, 0, v_original.id,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id, p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_refund_tx;

  INSERT INTO public.payment_allocations(
    payment_transaction_id, table_order_line_id, order_id, order_uid, amount, created_at
  ) VALUES (v_refund_tx.id, NULL, v_alloc.order_id, p_order_uid, v_amount_cents / 100.0, v_now);

  v_obligation_cents := round(public.order_canonical_obligation_v1(p_order_uid) * 100)::bigint;
  SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100), 0)::bigint
    INTO v_paid_before_cents
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund');
  v_prev_state := CASE
    WHEN v_paid_before_cents <= 0 THEN 'unpaid'
    WHEN v_paid_before_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_new_paid_cents := v_paid_before_cents - v_amount_cents;
  v_new_state := CASE
    WHEN v_new_paid_cents <= 0 THEN 'unpaid'
    WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_scope := 'order_' || replace(v_refund_tx.id::text, '-', '');

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
    event_service_session_id, payment_transaction_id, created_at
  )
  SELECT o.id, 'refund', v_amount_cents / 100.0, v_original.payment_method,
    v_reason, false, p_by_actor, v_actor.role, o.estado, o.estado,
    v_prev_state, v_new_state, NULL, NULL,
    jsonb_build_object('source','order','mode','refund','transaction_id',v_refund_tx.id,
      'reverses_transaction_id', v_original.id, 'settlement', v_settlement),
    v_scope,
    encode(digest(concat_ws('|', o.id, v_refund_tx.id::text, v_amount_cents::text,
      v_original.payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
    o.service_session_id, v_receipt_service_id, v_refund_tx.id, v_now
  FROM public.ordenes o WHERE o.order_uid = p_order_uid;

  SELECT count(DISTINCT e.payment_method), max(e.payment_method)
    INTO v_method_count, v_method_max
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported');
  v_is_paid := CASE WHEN v_obligation_cents <= 0 THEN v_new_paid_cents > 0
                     ELSE v_new_paid_cents >= v_obligation_cents END;
  v_method_projection := CASE WHEN v_method_count > 1 THEN 'MIXTO' ELSE v_method_max END;

  -- ordenes.refunded is deliberately never set here -- it means "fully
  -- refunded" in the LEGACY sense and would misstate a partial reversal
  -- (identical reasoning to mesa_post_refund_v1).
  UPDATE public.ordenes SET
    cobrado = v_is_paid, ya_pagado = v_is_paid,
    metodo_pago = CASE WHEN v_is_paid THEN v_method_projection ELSE COALESCE(metodo_pago,'') END
  WHERE order_uid = p_order_uid;

  v_remaining_after_cents := v_remaining_cents - v_amount_cents;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES ('ORDER_PAYMENT_REFUNDED', v_original.by_actor, p_by_actor,
    jsonb_build_object('orderUid', p_order_uid, 'originalTransactionId', v_original.id,
      'refundTransactionId', v_refund_tx.id, 'amount', v_amount_cents / 100.0,
      'paymentMethod', v_original.payment_method, 'reason', v_reason,
      'clientRequestId', p_client_request_id,
      'refundableRemainingAfter', v_remaining_after_cents / 100.0)
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false,
    'refundTransactionId', v_refund_tx.id, 'reversesTransactionId', v_original.id,
    'amount', v_refund_tx.amount, 'paymentMethod', v_refund_tx.payment_method,
    'originalAmount', v_original.amount,
    'refundedTotalOnOriginal', (round(v_original.amount*100)::bigint - v_remaining_after_cents) / 100.0,
    'refundableRemainingOnOriginal', v_remaining_after_cents / 100.0,
    'orderUid', p_order_uid,
    'currentObligation', v_obligation_cents / 100.0,
    'netCollectedAfter', v_new_paid_cents / 100.0,
    'unpaidAfter', GREATEST(0, v_obligation_cents - v_new_paid_cents) / 100.0,
    'overCollectedAfter', GREATEST(0, v_new_paid_cents - v_obligation_cents) / 100.0,
    'auditId', v_audit_id
  );
END;
$function$;

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
    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents
      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;
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

  v_remaining_after_cents := v_remaining_cents - v_amount_cents;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_table_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal mesa_post_payment_v1 already filters on, reproduced verbatim in this new writer's own table-outstanding query, not new vocabulary
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

-- 2. Post-conditions ---------------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_pin  record;
  v_src  text;
  v_oid  oid;
  v_n    integer;
  v_lock text := $blk$  -- 146:BEGIN refund_receipt_pointer_lock
  PERFORM 1
  FROM public.service_session_state
  WHERE singleton = true
  FOR SHARE;
  -- 146:END refund_receipt_pointer_lock
$blk$;
  v_sel  text := $blk$  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;
$blk$;
  v_rej  text := $blk$  -- 146:BEGIN order_refund_requires_open_service
  IF v_receipt_service_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_REFUND_NO_OPEN_SERVICE'
      USING ERRCODE = '55000';
  END IF;
  -- 146:END order_refund_requires_open_service
$blk$;
BEGIN
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', 'order_post_refund_v1', '687b55f29d69323d54a73111529cebe9', 'f057928b8f6fade25d38d4bb1d3ed09a', 2),
      ('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', 'mesa_post_refund_v1', '9679556fe209fbadac5275b3ac71e456', '62f0e128a6e5d0623b0423a69f0329d3', 1)
    ) AS t(sig, name, want_new, want_pre, blocks)
  LOOP
    v_oid := to_regprocedure(v_pin.sig);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % is missing', v_pin.name; END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
    IF md5(v_src) IS DISTINCT FROM v_pin.want_new THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % is not the expected 146 body (md5 %)', v_pin.name, md5(v_src);
    END IF;
    -- the pointer-lock block is present exactly once, byte-exact, IMMEDIATELY before the (unchanged) receipt SELECT
    IF (length(v_src) - length(replace(v_src, v_lock, ''))) / length(v_lock) <> 1
       OR (length(v_src) - length(replace(v_src, '-- 146:BEGIN refund_receipt_pointer_lock', ''))) / length('-- 146:BEGIN refund_receipt_pointer_lock') <> 1
       OR (length(v_src) - length(replace(v_src, '-- 146:END refund_receipt_pointer_lock', ''))) / length('-- 146:END refund_receipt_pointer_lock') <> 1 THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % must carry the byte-exact pointer-lock block (PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE) exactly once', v_pin.name;
    END IF;
    IF position(v_lock || v_sel IN v_src) = 0 THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: the lock of % is not immediately before the receipt-service SELECT', v_pin.name;
    END IF;
    -- the number of 146 blocks: 2 in the order writer (lock + refusal), 1 in the Mesa writer (lock only)
    IF (length(v_src) - length(replace(v_src, '-- 146:BEGIN ', ''))) / length('-- 146:BEGIN ') <> v_pin.blocks
       OR (length(v_src) - length(replace(v_src, '-- 146:END ', ''))) / length('-- 146:END ') <> v_pin.blocks THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % must carry exactly % marked 146 block(s)', v_pin.name, v_pin.blocks;
    END IF;
    IF v_pin.blocks = 2 THEN
      -- order: the typed refusal is present exactly once, IMMEDIATELY after the receipt SELECT, and before the first write of the refund path
      IF (length(v_src) - length(replace(v_src, v_rej, ''))) / length(v_rej) <> 1 OR position(v_lock || v_sel || v_rej IN v_src) = 0 THEN
        RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: the typed refusal of % is missing or not immediately after the receipt SELECT', v_pin.name;
      END IF;
      IF position('INSERT INTO public.payment_transactions' IN v_src) < position(v_rej IN v_src) + length(v_rej)
         OR position('INSERT INTO public.payment_allocations' IN v_src) < position(v_rej IN v_src) + length(v_rej)
         OR position('INSERT INTO public.order_financial_events' IN v_src) < position(v_rej IN v_src) + length(v_rej)
         OR position('UPDATE public.ordenes' IN v_src) < position(v_rej IN v_src) + length(v_rej) THEN
        RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: a write of the refund path of % precedes the typed refusal', v_pin.name;
      END IF;
      IF md5(replace(replace(v_src, v_lock, ''), v_rej, '')) IS DISTINCT FROM v_pin.want_pre THEN
        RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % differs from its predecessor by more than its two blocks', v_pin.name;
      END IF;
    ELSE
      -- Mesa: NO refusal of any kind is added (off-service Mesa refund stays ALLOWED_TABLE_SCOPED)
      IF position('ORDER_REFUND_NO_OPEN_SERVICE' IN v_src) > 0 OR position('order_refund_requires_open_service' IN v_src) > 0 THEN
        RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % must NOT refuse an off-service refund', v_pin.name;
      END IF;
      IF md5(replace(v_src, v_lock, '')) IS DISTINCT FROM v_pin.want_pre THEN
        RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % differs from its predecessor by more than its block', v_pin.name;
      END IF;
    END IF;
    -- posture unchanged
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN c146_posture_before b ON b.k = p.proname::text
                    WHERE p.oid = v_oid AND p.prosecdef IS NOT DISTINCT FROM b.prosecdef AND p.proconfig IS NOT DISTINCT FROM b.proconfig AND pg_get_userbyid(p.proowner) = b.owner
                      AND p.proacl::text IS NOT DISTINCT FROM b.acl AND p.proretset = b.proretset AND p.prorettype::regtype = b.prorettype AND pg_get_function_arguments(p.oid) = b.args) THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: owner / SECURITY / search_path / ACL / return type / arguments of % changed', v_pin.name;
    END IF;
    IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: EXECUTE of % must stay service_role-only', v_pin.name;
    END IF;
  END LOOP;
  -- EXACTLY two functions changed, none added, none removed (every function of every user schema)
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'
     AND NOT EXISTS (SELECT 1 FROM c146_fn_before f WHERE f.sig = p.oid::regprocedure::text AND f.md5 = md5(p.prosrc));
  IF v_n <> 2 THEN RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % function(s) differ from the before-state (expected exactly 2)', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)'), to_regprocedure('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)'))
                AND (SELECT f.md5 FROM c146_fn_before f WHERE f.sig = p.oid::regprocedure::text) = md5(p.prosrc)) THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: a target function was not changed';
  END IF;
  SELECT count(*) INTO v_n FROM c146_fn_before f WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid::regprocedure::text = f.sig);
  IF v_n <> 0 THEN RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % function(s) disappeared', v_n; END IF;
  -- the 145 payment writers are untouched (Finding A frozen)
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)')) IS DISTINCT FROM '799f8093328b4ac81e1ad5a3d37e1bb6'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)')) IS DISTINCT FROM '94867e165d0732f36ae4692fc6998c58' THEN
    RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: a 145 payment writer changed';
  END IF;
  -- no trigger / constraint / column / index / relation / ACL change
  CREATE TEMP TABLE c146_cat_after (k text PRIMARY KEY, v text) ON COMMIT DROP;
INSERT INTO c146_cat_after (k, v)
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
  SELECT count(*) INTO v_n FROM c146_cat_before b JOIN c146_cat_after a USING (k) WHERE a.v IS DISTINCT FROM b.v;
  IF v_n <> 0 THEN RAISE EXCEPTION 'REFUND_CLOSE_LOCK post-condition failed: % catalog fingerprint(s) changed (trigger / constraint / column / index / relation / ACL)', v_n; END IF;
END $post$;

COMMIT;
