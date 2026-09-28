-- migrations/2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.sql
-- Paired rollback: 2026-09-26_close_evidence_freshness_mesa_legacy_guard_v1_migration_150.ROLLBACK.sql
--
-- ECONOMY BASE -- CORRECTIVE SLICE AFTER THE ADVERSARIAL REVIEW (DELIVERY x ECONOMIA V1, 2026-09-26). STAGING CANDIDATE ONLY; not applied by
-- the session that authored it. Evidence: ~/Downloads/DELIVERY_ECONOMY_V1_CORRECTIVE_SLICE_150_2026-09-26.md.
--
-- DEFECT #1 -- A CLOSE FROM STALE FROZEN EVIDENCE. The V3 close persisted its evidence in separate transactions (snapshot, incidents,
-- closeout, reconciliation) and only then ran the terminal step. When that step did not commit, the service stayed open and kept trading,
-- and the retry closed it from the closeout / reconciliation / incidents frozen before the trading (service_closeouts_session_uq allows ONE
-- closeout per service, append-only, so it could never be corrected): V3_CLOSED with gross 2000 / collected 1200 / 2 orders for a service
-- whose ledger held 2500 / 2500 / 3, and a pending financial incident for an order paid in the meantime.
-- FIX #1 (three objects + one trigger; nothing existing is modified -- the authorities are called, pinned):
--   1. public.service_close_evidence_digest_v1(orders, table_sessions, events, obligations) -- the digest of exactly the facts the V3
--      closeout / classification are computed from (aggregate + classifyForV3Close): per order id, estado, totale, cobrado, ya_pagado,
--      metodo_pago; per table session id and (status, covers_total), an empty table (covers_total NULL, auto-released by the close itself)
--      counting only by its id; the id sets of the append-only order_financial_events and order_obligations of the service.
--   2. public.service_close_live_evidence_v1(service) -- the same four service-scoped sets read live, in the snapshot payload's shape.
--   3. public.close_service_session_with_evidence_v1(...) -- the ONE terminal step of the V3 close from now on. Under the lock prefix of
--      close_service_session_v3 (lifecycle advisory -> L0 -> pointer FOR UPDATE: every payment, refund and order intake is excluded while it
--      runs) it judges the evidence: the attempt's snapshot must still equal the live facts of the service, and the receipts attributed to
--      the service must still be exactly the ones the reconciliation was built from. STALE -> CLOSE_EVIDENCE_STALE, nothing written (the engine
--      supersedes the attempt -- supersede_closeout_attempt retires its incidents too -- and starts a fresh one). FRESH -> the closeout
--      (create_service_closeout), the reconciliation (create_service_closeout_reconciliation_v1) and the terminal close + attempt completion
--      (close_service_session_and_complete_attempt_v1, migration 149) commit in ONE transaction, or nothing does.
--   4. CONSTRAINT TRIGGER service_closeouts_terminal_close_v1 (AFTER INSERT, DEFERRABLE INITIALLY DEFERRED): a closeout row can only be
--      committed by the transaction that terminally closes its service. Whoever writes (a previous backend, manual SQL), frozen evidence can
--      no longer outlive a terminal step that did not commit. Existing rows are not touched.
-- DEFECT #2 -- M148 BYPASS THROUGH MESA. mesa_post_payment_v1 never read cobrado / ya_pagado: a table order with a legacy paid mirror and a
-- positive canonical outstanding was charged again.
-- FIX #2: mesa_post_payment_v1 = the 145 body + ONE block (150:BEGIN mesa_legacy_paid_ambiguity_guard), the Mesa counterpart of the 148
-- block: SQLSTATE 55000 ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED, before any payment fact, with the table's orders already held FOR UPDATE.
-- Removing the block yields the 145 body byte for byte. Remedy: reconcile the order's obligation (reduction-only commercial adjustment).
-- DEFECT #5 (per-comanda phantom unpaid + phantom over-collected on a settled table) is a projection defect fixed in the backend
-- (src/tables/tableSettlementNetting.js); this migration does not touch it.
--
-- LOCK ORDER. Function 3 takes the lock prefix of close_service_session_v3 (lifecycle -> L0 -> service_session_state) BEFORE judging the
-- evidence, then the inserts (foreign-key KEY SHARE on the attempt and service rows), then close_service_session_v3 (re-entrant prefix,
-- service_sessions, business_day_lifecycle_state) and the attempt row (complete_closeout_attempt). No new resource is locked ahead of the
-- existing order. The Mesa block takes no lock.
-- ROLLOUT: 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148 -> 149 -> 150, then the backend of the same package (it calls function 3).
-- Between this migration and that deploy a Finalizar through the previous backend fails CLOSED at its closeout step (trigger 4): the service
-- stays open, nothing irreversible is written, and the first Finalizar after the deploy re-judges the evidence. ROLLBACK ORDER: backend first,
-- then 150 (function-only: valid at any time, no data depends on it).
-- DRIFT GUARDS (fail closed): the chain tip is 149; mesa_post_payment_v1 is exactly the 145 body; every authority function 3 calls or relies
-- on is its certified body; the tables / columns it reads exist; nothing of it exists yet.
-- POST-CONDITIONS: md5 pins of the five bodies; the trigger's exact definition; posture (SECURITY INVOKER, search_path, service_role-only
-- EXECUTE); the 150 and 145 blocks exactly once in the Mesa writer; its owner / SECURITY / search_path / ACL / signature unchanged; every other
-- function of every user schema byte-identical.
BEGIN;

-- 0. Preconditions and drift guards ---------------------------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_pin record;
BEGIN
  IF to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)')) IS DISTINCT FROM 'f53a677bf72aebdec2ce90eea8a81668'
     OR (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname IN ('service_sessions_close_attempt_terminal_v1', 'service_closeout_attempts_open_service_v1')) <> 2 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS refused: the chain tip is not 149 (close_service_session_and_complete_attempt_v1 f53a677b... and its two triggers) -- the rollout is 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148 -> 149 -> 150';
  END IF;
  FOR v_pin IN SELECT * FROM (VALUES
      ('public.close_service_session_v3(uuid,uuid,text,text)', 'a6680181760dd8dabfa29aa43c786906'),
      ('public.complete_closeout_attempt(uuid,text)', 'f96adc7871c50751fdd7a4b1aebf3783'),
      ('public.acquire_closeout_attempt(uuid,text)', 'e0e510d074ce61a6cc6b7d505ac38012'),
      ('public.supersede_closeout_attempt(uuid,text,text)', '1ee565901cad6b66f2e92772aad902ea'),
      ('public.capture_closeout_snapshot(uuid,uuid,text,text,jsonb,integer,text)', '2a3a4b1d746f5bc549991e5f0cdd13c3'),
      ('public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer)', 'e089a36c1cbdcfb1f148a86aaf0ae226'),
      ('public.create_service_closeout_reconciliation_v1(uuid,uuid,timestamp with time zone,timestamp with time zone,text,text,date,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,text,uuid,integer)', 'f8f351a9ec2d2754220b95a165a3ae06'),
      ('public.order_canonical_obligation_v1(uuid)', 'c68e831344fd537128608567727c2f9d'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', '94867e165d0732f36ae4692fc6998c58')
    ) AS x(sig, want) LOOP
    IF to_regprocedure(v_pin.sig) IS NULL
       OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS refused: % is not the certified body % -- resolve drift first', v_pin.sig, v_pin.want;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname IN ('mesa_post_payment_v1', 'create_service_closeout', 'create_service_closeout_reconciliation_v1', 'close_service_session_and_complete_attempt_v1')) <> 4 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS refused: an unexpected overload set of a called function -- resolve drift first';
  END IF;
  IF to_regclass('public.service_closeouts_session_uq') IS NULL OR to_regclass('public.service_closeout_snapshots_correlation_uq') IS NULL
     OR to_regclass('public.scr_correlation_uq') IS NULL THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS refused: the closeout / snapshot / reconciliation uniqueness this migration relies on is missing -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE NOT a.attisdropped AND a.attnum > 0
         AND ((a.attrelid = 'public.ordenes'::regclass AND a.attname IN ('id', 'estado', 'totale', 'cobrado', 'ya_pagado', 'metodo_pago', 'service_session_id', 'table_session_id', 'order_uid'))
           OR (a.attrelid = 'public.table_sessions'::regclass AND a.attname IN ('id', 'status', 'covers_total', 'service_session_id'))
           OR (a.attrelid = 'public.order_financial_events'::regclass AND a.attname IN ('id', 'service_session_id', 'order_id', 'type', 'amount'))
           OR (a.attrelid = 'public.order_obligations'::regclass AND a.attname IN ('id', 'service_session_id'))
           OR (a.attrelid = 'public.payment_transactions'::regclass AND a.attname IN ('id', 'service_session_id', 'created_at'))
           OR (a.attrelid = 'public.service_closeout_snapshots'::regclass AND a.attname IN ('payload', 'closeout_correlation_id', 'service_session_id'))
           OR (a.attrelid = 'public.service_closeout_reconciliations'::regclass AND a.attname IN ('created_at', 'closeout_correlation_id', 'service_session_id')))) <> 29 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS refused: a column this migration reads is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)') IS NOT NULL
     OR to_regprocedure('public.service_close_live_evidence_v1(uuid)') IS NOT NULL
     OR to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])') IS NOT NULL
     OR to_regprocedure('public.service_closeout_requires_terminal_close_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname = 'service_closeouts_terminal_close_v1')
     OR position('-- 150:BEGIN ' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)'))) > 0 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS refused: already applied (an object of migration 150 already exists)';
  END IF;
END $guard$;

-- Before-state: every function of every user schema, and the posture of the Mesa writer (the post-conditions prove nothing else moved).
CREATE TEMP TABLE c150_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c150_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
CREATE TEMP TABLE c150_posture_before ON COMMIT DROP AS
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proretset, p.prorettype::regtype AS rettype, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)');

-- 1. The evidence digest: exactly the facts the V3 closeout and its classification are computed from ------------------------------------------
CREATE FUNCTION public.service_close_evidence_digest_v1(p_orders jsonb, p_table_sessions jsonb, p_events jsonb, p_obligations jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT md5(
    'orders[' || COALESCE((SELECT string_agg(r, ';' ORDER BY r) FROM (
        SELECT concat_ws('|', COALESCE(e->>'id', ''), COALESCE(e->>'estado', ''), COALESCE(trim_scale((e->>'totale')::numeric)::text, ''),
                              COALESCE(e->>'cobrado', ''), COALESCE(e->>'ya_pagado', ''), COALESCE(e->>'metodo_pago', '')) AS r
          FROM jsonb_array_elements(COALESCE(p_orders, '[]'::jsonb)) e) o), '') || ']'
    || 'tables[' || COALESCE((SELECT string_agg(r, ';' ORDER BY r) FROM (
        SELECT concat_ws('|', COALESCE(e->>'id', ''),
                              CASE WHEN jsonb_typeof(e->'covers_total') IS DISTINCT FROM 'number' THEN 'empty'
                                   ELSE COALESCE(e->>'status', '') || ':' || (e->>'covers_total') END) AS r
          FROM jsonb_array_elements(COALESCE(p_table_sessions, '[]'::jsonb)) e) t), '') || ']'
    || 'events[' || COALESCE((SELECT string_agg(COALESCE(e->>'id', ''), ';' ORDER BY COALESCE(e->>'id', ''))
          FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) e), '') || ']'
    || 'obligations[' || COALESCE((SELECT string_agg(COALESCE(e->>'id', ''), ';' ORDER BY COALESCE(e->>'id', ''))
          FROM jsonb_array_elements(COALESCE(p_obligations, '[]'::jsonb)) e), '') || ']'
  );
$function$;

-- 2. The same four service-scoped sets read live, in the snapshot payload's own shape ---------------------------------------------------------------
CREATE FUNCTION public.service_close_live_evidence_v1(p_service_session_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'orders', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM public.ordenes o WHERE o.service_session_id = p_service_session_id), '[]'::jsonb),
    'tableSessions', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.table_sessions t WHERE t.service_session_id = p_service_session_id), '[]'::jsonb),
    'financialEvents', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM public.order_financial_events e WHERE e.service_session_id = p_service_session_id), '[]'::jsonb),
    'orderObligations', COALESCE((SELECT jsonb_agg(to_jsonb(b)) FROM public.order_obligations b WHERE b.service_session_id = p_service_session_id), '[]'::jsonb)
  );
$function$;

-- 3. The terminal step: judge the evidence, then closeout + reconciliation + close + completion in ONE transaction, or nothing ----------------------
CREATE FUNCTION public.close_service_session_with_evidence_v1(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_closeout jsonb, p_reconciliation jsonb, p_receipt_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session  public.service_sessions%ROWTYPE;
  v_attempt  public.service_closeout_attempts%ROWTYPE;
  v_snapshot public.service_closeout_snapshots%ROWTYPE;
  v_closeout public.service_closeouts%ROWTYPE;
  v_recon    public.service_closeout_reconciliations%ROWTYPE;
  v_live     jsonb;
  v_stale    text[] := ARRAY[]::text[];
  v_step     jsonb;
  v_result   jsonb;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL
     OR (p_closeout IS NOT NULL AND jsonb_typeof(p_closeout) <> 'object')
     OR (p_reconciliation IS NOT NULL AND jsonb_typeof(p_reconciliation) <> 'object') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  -- The lock prefix of close_service_session_v3, taken BEFORE the evidence is judged: from here to commit no payment or refund (both hold
  -- the pointer FOR SHARE), no order intake (lifecycle advisory) and no rider collection (L0) can commit a new fact for this service.
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  SELECT * INTO v_attempt FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;
  -- Already terminal (a lost response, a concurrent Finalizar of the same attempt): nothing is re-judged and nothing is written. Success only
  -- when THIS attempt is completed and its closeout exists -- judged from the service's own facts, never from the current-service pointer.
  IF v_session.status = 'closed' THEN
    IF v_attempt.status = 'completed'
       AND EXISTS (SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = p_service_session_id AND c.closeout_correlation_id = p_closeout_correlation_id) THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'attemptCompleted',true,
                                'attempt',to_jsonb(v_attempt),'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','CLOSED_ATTEMPT_NOT_COMPLETED','attempt',to_jsonb(v_attempt));
  END IF;
  IF v_attempt.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE','attempt',to_jsonb(v_attempt));
  END IF;
  SELECT * INTO v_snapshot FROM public.service_closeout_snapshots
   WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSE_EVIDENCE_INCOMPLETE','missing',jsonb_build_array('snapshot'));
  END IF;
  SELECT * INTO v_closeout FROM public.service_closeouts WHERE service_session_id = p_service_session_id;
  IF FOUND AND v_closeout.closeout_correlation_id IS DISTINCT FROM p_closeout_correlation_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  SELECT * INTO v_recon FROM public.service_closeout_reconciliations WHERE closeout_correlation_id = p_closeout_correlation_id;

  -- FRESHNESS. (a) The service's own facts: the snapshot this attempt's closeout / incidents were computed from must still equal the live facts.
  v_live := public.service_close_live_evidence_v1(p_service_session_id);
  IF public.service_close_evidence_digest_v1(v_snapshot.payload->'orders', v_snapshot.payload->'tableSessions', v_snapshot.payload->'financialEvents', v_snapshot.payload->'orderObligations')
     IS DISTINCT FROM public.service_close_evidence_digest_v1(v_live->'orders', v_live->'tableSessions', v_live->'financialEvents', v_live->'orderObligations') THEN
    v_stale := v_stale || 'service_facts'::text;
  END IF;
  -- (b) The receipts attributed to this service (its cash drawer): exactly the set the reconciliation was built from, or -- for a
  -- reconciliation already persisted before this migration -- none newer than it.
  IF v_recon.id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.payment_transactions t WHERE t.service_session_id = p_service_session_id AND t.created_at > v_recon.created_at) THEN
      v_stale := v_stale || 'receipts'::text;
    END IF;
  ELSIF p_receipt_ids IS NULL
     OR ARRAY(SELECT DISTINCT x FROM unnest(p_receipt_ids) x ORDER BY 1) IS DISTINCT FROM
        ARRAY(SELECT t.id FROM public.payment_transactions t WHERE t.service_session_id = p_service_session_id ORDER BY 1) THEN
    v_stale := v_stale || 'receipts'::text;
  END IF;
  IF cardinality(v_stale) > 0 THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSE_EVIDENCE_STALE','stale',to_jsonb(v_stale),
                              'closeoutCommitted', v_closeout.id IS NOT NULL, 'reconciliationCommitted', v_recon.id IS NOT NULL);
  END IF;

  -- FRESH: closeout + reconciliation + terminal close + completion, all or nothing.
  BEGIN
    IF v_closeout.id IS NULL THEN
      IF p_closeout IS NULL THEN
        v_result := jsonb_build_object('ok',false,'code','CLOSEOUT_PAYLOAD_REQUIRED');
        RAISE EXCEPTION 'closeout payload required' USING ERRCODE = 'LD150';
      END IF;
      v_step := public.create_service_closeout(
        p_service_session_id => p_service_session_id, p_closeout_correlation_id => p_closeout_correlation_id,
        p_closed_by => p_closed_by, p_source => p_source, p_close_reason => p_closeout->>'p_close_reason',
        p_gross_sales_cents => (p_closeout->>'p_gross_sales_cents')::integer, p_net_sales_cents => (p_closeout->>'p_net_sales_cents')::integer,
        p_total_refunds_cents => (p_closeout->>'p_total_refunds_cents')::integer, p_total_void_cents => (p_closeout->>'p_total_void_cents')::integer,
        p_paid_amount_cents => (p_closeout->>'p_paid_amount_cents')::integer, p_unpaid_exposure_cents => (p_closeout->>'p_unpaid_exposure_cents')::integer,
        p_order_count => (p_closeout->>'p_order_count')::integer, p_cash_amount_cents => (p_closeout->>'p_cash_amount_cents')::integer,
        p_card_amount_cents => (p_closeout->>'p_card_amount_cents')::integer, p_bizum_amount_cents => (p_closeout->>'p_bizum_amount_cents')::integer,
        p_other_amount_cents => (p_closeout->>'p_other_amount_cents')::integer, p_open_orders_at_close => (p_closeout->>'p_open_orders_at_close')::integer,
        p_occupied_tables_at_close => (p_closeout->>'p_occupied_tables_at_close')::integer,
        p_kitchen_pending_count => COALESCE((p_closeout->>'p_kitchen_pending_count')::integer, 0), p_listo_count => COALESCE((p_closeout->>'p_listo_count')::integer, 0),
        p_delivery_pending_count => COALESCE((p_closeout->>'p_delivery_pending_count')::integer, 0), p_incident_count => COALESCE((p_closeout->>'p_incident_count')::integer, 0),
        p_critical_incident_count => COALESCE((p_closeout->>'p_critical_incident_count')::integer, 0),
        p_current_obligation_cents => (p_closeout->>'p_current_obligation_cents')::integer, p_over_collected_cents => (p_closeout->>'p_over_collected_cents')::integer);
      IF (v_step->>'ok') IS DISTINCT FROM 'true' THEN
        v_result := v_step;
        RAISE EXCEPTION 'closeout refused' USING ERRCODE = 'LD150';
      END IF;
      SELECT * INTO v_closeout FROM public.service_closeouts WHERE closeout_correlation_id = p_closeout_correlation_id;
    END IF;
    IF v_recon.id IS NULL THEN
      IF p_reconciliation IS NULL THEN
        v_result := jsonb_build_object('ok',false,'code','RECONCILIATION_PAYLOAD_REQUIRED');
        RAISE EXCEPTION 'reconciliation payload required' USING ERRCODE = 'LD150';
      END IF;
      v_step := public.create_service_closeout_reconciliation_v1(
        p_service_session_id => p_service_session_id, p_closeout_correlation_id => p_closeout_correlation_id,
        p_window_from => (p_reconciliation->>'p_window_from')::timestamptz, p_window_to => (p_reconciliation->>'p_window_to')::timestamptz,
        p_window_timezone => p_reconciliation->>'p_window_timezone', p_window_preset => p_reconciliation->>'p_window_preset',
        p_business_date => (p_reconciliation->>'p_business_date')::date,
        p_gross_cents => (p_reconciliation->>'p_gross_cents')::integer, p_collected_cents => (p_reconciliation->>'p_collected_cents')::integer,
        p_unpaid_cents => (p_reconciliation->>'p_unpaid_cents')::integer, p_voided_cents => (p_reconciliation->>'p_voided_cents')::integer,
        p_refunded_cents => (p_reconciliation->>'p_refunded_cents')::integer, p_cash_receipts_cents => (p_reconciliation->>'p_cash_receipts_cents')::integer,
        p_card_receipts_cents => (p_reconciliation->>'p_card_receipts_cents')::integer, p_bizum_receipts_cents => (p_reconciliation->>'p_bizum_receipts_cents')::integer,
        p_other_receipts_cents => (p_reconciliation->>'p_other_receipts_cents')::integer, p_order_count => (p_reconciliation->>'p_order_count')::integer,
        p_service_count => (p_reconciliation->>'p_service_count')::integer, p_actor => COALESCE(p_reconciliation->>'p_actor', p_closed_by),
        p_cash_count_id => (p_reconciliation->>'p_cash_count_id')::uuid, p_counted_cash_cents => (p_reconciliation->>'p_counted_cash_cents')::integer);
      IF (v_step->>'ok') IS DISTINCT FROM 'true' THEN
        v_result := v_step;
        RAISE EXCEPTION 'reconciliation refused' USING ERRCODE = 'LD150';
      END IF;
      SELECT * INTO v_recon FROM public.service_closeout_reconciliations WHERE closeout_correlation_id = p_closeout_correlation_id;
    END IF;
    v_result := public.close_service_session_and_complete_attempt_v1(p_service_session_id, p_closeout_correlation_id, p_closed_by, p_source);
    IF (v_result->>'ok') IS DISTINCT FROM 'true' OR (v_result->>'attemptCompleted') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'terminal step refused' USING ERRCODE = 'LD150';
    END IF;
  EXCEPTION WHEN SQLSTATE 'LD150' THEN
    -- everything of this block is rolled back: no closeout, no reconciliation, the service stays open, the attempt keeps its state
    RETURN COALESCE(v_result, jsonb_build_object('ok',false,'code','CLOSE_WITH_EVIDENCE_REFUSED')) || jsonb_build_object('ok',false,'rolledBack',true);
  END;

  RETURN v_result || jsonb_build_object('evidence','fresh','closeout',to_jsonb(v_closeout),'reconciliation',to_jsonb(v_recon));
END;
$function$;

-- 4. A closeout is committed only together with the terminal close of its service -----------------------------------------------------------------
CREATE FUNCTION public.service_closeout_requires_terminal_close_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT s.status INTO v_status FROM public.service_sessions s WHERE s.id = NEW.service_session_id;
  IF v_status IS DISTINCT FROM 'closed' AND v_status IS DISTINCT FROM 'rolled_over' THEN
    RAISE EXCEPTION 'SERVICE_CLOSEOUT_WITHOUT_TERMINAL_CLOSE' USING ERRCODE = 'P0001',
      DETAIL = 'the closeout of service ' || NEW.service_session_id::text || ' can only be committed by the transaction that terminally closes it (status ' || COALESCE(v_status, 'missing') || ')';
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER service_closeouts_terminal_close_v1
  AFTER INSERT ON public.service_closeouts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.service_closeout_requires_terminal_close_v1();

-- 5. mesa_post_payment_v1: the 145 body with the Mesa legacy paid ambiguity guard -------------------------------------------------------------------
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
  -- 150:BEGIN mesa_legacy_paid_ambiguity_guard
  -- LEGACY PAID AMBIGUITY ON A TABLE (migration 150), the Mesa counterpart of the 148 block of order_post_payment_v1. Reached with every
  -- ordenes row of this table session held FOR UPDATE (PATCH B above) and a positive table outstanding. A table order whose mirror says
  -- paid (cobrado / ya_pagado) while its canonical ledger still owes (canonical obligation minus its own payment / payment_imported /
  -- refund events -- the 148 formula) is never produced by the canonical writers: it is a legacy row, and money was possibly collected
  -- outside the ledger. This writer does not guess and does not charge the table again: it refuses BEFORE any payment fact, with the 148
  -- code and SQLSTATE. Remedy: reconcile that order (reduction-only commercial adjustment to what was really collected) -- the legacy import
  -- refuses Mesa orders. No lock is added or removed; no mirror is turned into ledger; no amount is inferred from the mirror.
  SELECT o.id, o.order_uid, o.cobrado, o.ya_pagado,
         round(public.order_canonical_obligation_v1(o.order_uid) * 100)::bigint AS obligation_cents,
         COALESCE((SELECT round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100)::bigint
                     FROM public.order_financial_events e
                    WHERE e.service_session_id = o.service_session_id AND e.order_id = o.id AND e.type IN ('payment','payment_imported','refund')), 0) AS net_cents
    INTO v_order
    FROM public.ordenes o
   WHERE o.table_session_id = v_session.id AND o.order_uid IS NOT NULL
     AND (o.cobrado IS TRUE OR o.ya_pagado IS TRUE)
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
     AND (EXISTS (SELECT 1 FROM public.order_obligations ob WHERE ob.order_uid = o.order_uid)
          OR EXISTS (SELECT 1 FROM public.table_order_lines l WHERE l.table_session_id = v_session.id AND l.order_id = o.id))
     AND round(public.order_canonical_obligation_v1(o.order_uid) * 100)::bigint
         > COALESCE((SELECT round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100)::bigint
                       FROM public.order_financial_events e
                      WHERE e.service_session_id = o.service_session_id AND e.order_id = o.id AND e.type IN ('payment','payment_imported','refund')), 0)
   ORDER BY o.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_LEGACY_IMPORT_REQUIRED' USING ERRCODE='55000',
      DETAIL = format('table_session_id=%s order_id=%s order_uid=%s cobrado=%s ya_pagado=%s obligation_cents=%s net_collected_cents=%s -- a legacy paid mirror contradicts the canonical ledger of a table order; reconcile that order before charging the table',
                      v_session.id, v_order.id, v_order.order_uid, v_order.cobrado, v_order.ya_pagado, v_order.obligation_cents, v_order.net_cents);
  END IF;
  -- 150:END mesa_legacy_paid_ambiguity_guard
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

REVOKE ALL ON FUNCTION public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb), public.service_close_live_evidence_v1(uuid),
  public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[]), public.service_closeout_requires_terminal_close_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb), public.service_close_live_evidence_v1(uuid),
  public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[]) TO service_role;

-- 6. Post-conditions -----------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_pin record;
  v_src text;
  v_bad text;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)', 'a7f89499be50f338607ff64f8778f2ae'),
      ('public.service_close_live_evidence_v1(uuid)', '49163cc1ec55c7f2154e4d76ee77445c'),
      ('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'a25b330f095ff3441bca034e79e750f7'),
      ('public.service_closeout_requires_terminal_close_v1()', 'be58c0f28da316fcb8495be7676c2738'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', '2d6ebfe704559dd5a9a083025fb77057')
    ) AS x(sig, want) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS post-condition failed: % is not the expected body %', v_pin.sig, v_pin.want;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)'),
                                                     to_regprocedure('public.service_close_live_evidence_v1(uuid)'),
                                                     to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])'))
              AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
                   OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS post-condition failed: a new function must be SECURITY INVOKER, search_path public, pg_temp, EXECUTE for service_role only';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'service_closeouts_terminal_close_v1'
        AND t.tgrelid = 'public.service_closeouts'::regclass AND t.tgenabled = 'O' AND t.tgdeferrable AND t.tginitdeferred
        AND t.tgfoid = to_regprocedure('public.service_closeout_requires_terminal_close_v1()')
        AND pg_get_triggerdef(t.oid) = 'CREATE CONSTRAINT TRIGGER service_closeouts_terminal_close_v1 AFTER INSERT ON public.service_closeouts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_closeout_requires_terminal_close_v1()') <> 1 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS post-condition failed: the deferred constraint trigger is not installed exactly as certified';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)');
  IF (length(v_src) - length(replace(v_src, '-- 150:BEGIN mesa_legacy_paid_ambiguity_guard', ''))) / length('-- 150:BEGIN mesa_legacy_paid_ambiguity_guard') <> 1
     OR (length(v_src) - length(replace(v_src, '-- 150:END mesa_legacy_paid_ambiguity_guard', ''))) / length('-- 150:END mesa_legacy_paid_ambiguity_guard') <> 1
     OR (length(v_src) - length(replace(v_src, '-- 145:BEGIN receipt_service_pointer_lock', ''))) / length('-- 145:BEGIN receipt_service_pointer_lock') <> 1 THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS post-condition failed: the Mesa writer must carry the 150 block and the 145 block exactly once each';
  END IF;
  IF EXISTS (SELECT 1 FROM c150_posture_before b, pg_proc p WHERE p.oid = to_regprocedure('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)')
              AND (p.prosecdef IS DISTINCT FROM b.prosecdef OR p.proconfig IS DISTINCT FROM b.proconfig OR pg_get_userbyid(p.proowner) IS DISTINCT FROM b.owner
                   OR p.proacl::text IS DISTINCT FROM b.acl OR p.proretset IS DISTINCT FROM b.proretset OR p.prorettype::regtype IS DISTINCT FROM b.rettype
                   OR pg_get_function_arguments(p.oid) IS DISTINCT FROM b.args)) THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS post-condition failed: owner / SECURITY / search_path / ACL / signature / return of mesa_post_payment_v1 changed';
  END IF;
  SELECT string_agg(COALESCE(a.sig, b.sig), ', ') INTO v_bad
    FROM c150_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE regexp_replace(COALESCE(a.sig, b.sig), '^public\.', '') NOT IN ('service_close_evidence_digest_v1(jsonb,jsonb,jsonb,jsonb)', 'service_close_live_evidence_v1(uuid)',
                                        'close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'service_closeout_requires_terminal_close_v1()',
                                        'mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)')
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CLOSE_EVIDENCE_FRESHNESS post-condition failed: other functions changed (%)', v_bad;
  END IF;
END $post$;

COMMIT;
