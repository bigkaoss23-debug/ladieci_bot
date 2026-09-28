-- migrations/2026-09-26_close_day_evidence_freshness_v1_migration_154.ROLLBACK.sql
-- Reverses 2026-09-26_close_day_evidence_freshness_v1_migration_154.sql: restores close_service_session_with_evidence_v1 to the migration 150 body byte for byte
-- (md5 a25b330f095ff3441bca034e79e750f7) and drops public.service_close_day_evidence_digest_v1.
-- Order: THIS rollback first, then the backend (the backend of the same package keeps working against the 150 body: the extra
-- p_day_evidence_digest key is ignored). No data depends on 154; valid at any time. After it the day window is again outside the
-- freshness authority (finding F2 re-opens).

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.service_close_day_evidence_digest_v1(timestamptz,timestamptz)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'c57584ba03c40ee940e402188fd40d2d' THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE rollback refused: migration 154 is not applied with its certified body';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.close_service_session_with_evidence_v1(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_closeout jsonb, p_reconciliation jsonb, p_receipt_ids uuid[])
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

DROP FUNCTION public.service_close_day_evidence_digest_v1(timestamptz,timestamptz);

DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'a25b330f095ff3441bca034e79e750f7'
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'service_close_day_evidence_digest_v1') THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE rollback post-condition failed';
  END IF;
END $post$;

COMMIT;
