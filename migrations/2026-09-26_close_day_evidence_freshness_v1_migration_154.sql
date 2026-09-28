-- migrations/2026-09-26_close_day_evidence_freshness_v1_migration_154.sql
-- Paired rollback: 2026-09-26_close_day_evidence_freshness_v1_migration_154.ROLLBACK.sql
--
-- ECONOMY BASE -- POST-ASTRA CORRECTIVE CYCLE, FINDING F2. STAGING CANDIDATE ONLY; not applied by the session that authored it.
-- Evidence: ~/Downloads/ECONOMY_POST_ASTRA_CORRECTIVE_REPORT_2026-09-26.md.
--
-- DEFECT F2 -- A STALE DAY RECONCILIATION PERSISTED BY A FRESH CLOSE. The terminal step of migration 150
-- (close_service_session_with_evidence_v1) judges the closing service's own facts (snapshot vs live) and the receipts ATTRIBUTED to it
-- (payment_transactions.service_session_id). The reconciliation it persists in the same transaction is NOT a service view: it is the
-- Business Day window (orders born in the window and all of their events and obligation revisions, every receipt event recorded in the
-- window, the cash counts of exactly that window). A fact inside that window that is attributed to ANOTHER service -- the refund of a
-- table carried over from an earlier service stays on the table's origin service by contract -- committed between the reconciliation
-- build and the terminal lock and the close persisted cash 40.00 for a day whose truth at the close commit was 22.00 (reproduced, T13).
-- The rule: a fact included in a persisted reconciliation must be protected by the same freshness authority.
--
-- FIX (no new lock, no signature change, no table / trigger / constraint change, no data change):
--   1. public.service_close_day_evidence_digest_v1(from, to): a STABLE digest over exactly the inputs of the values the reconciliation
--      persists -- orders born in [from, to) (ordenes + archive table) with their identity, grouping, VOID class and legacy basis (never
--      their operational estado), every financial event of born orders plus every in-window event, every obligation revision of born
--      orders (permanent identity; the composite provenance only for rows without it -- post-close resolution facts included), every
--      payment transaction recorded in the window, every cash count of exactly that window. An operational transition of another
--      service's order (a carried-over delivery moving to RETIRADO) moves no persisted value and does not make the close stale.
--   2. close_service_session_with_evidence_v1: ONE added block (c). When the reconciliation is being persisted by this call, the payload
--      must carry p_day_evidence_digest (read by the backend BEFORE it built the reconciliation); it is recomputed under the existing lock
--      prefix (lifecycle -> driver -> pointer FOR UPDATE) over the payload's own window. Different -> CLOSE_EVIDENCE_STALE ('day_window'):
--      the engine supersedes the attempt and builds a new round. Missing -> CLOSE_EVIDENCE_INCOMPLETE ('day_evidence_digest'): fail closed.
--      Every other line of the 150 body is unchanged (rollback restores it byte for byte, md5 a25b330f095ff3441bca034e79e750f7).
-- RESIDUAL (same class as 150's own service-facts check): a writer that does not take the pointer (an operational estado PATCH) can
-- commit between the recomputation and the commit of this transaction; the money writers, order intake and rider collection cannot.
-- ROLLOUT: 139 -> ... -> 150 -> the backend of the package -> 151 -> 152 -> 153 -> 154. The backend sends the digest (a pre-154 database
-- has no digest function: PGRST202, nothing is sent and nothing is asked); 154 is the LAST step.
-- This migration before that backend makes every Finalizar fail closed (CLOSE_EVIDENCE_INCOMPLETE), never persist a stale reconciliation.
-- ROLLBACK: 154 first (the backend of the package keeps working against the 150 body). No data depends on it; valid at any time.

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'a25b330f095ff3441bca034e79e750f7' THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE refused: close_service_session_with_evidence_v1 is not the certified migration 150 body';
  END IF;
  IF to_regprocedure('public.order_economic_service_gate_v1(uuid)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576' THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE refused: migration 151 is not applied with its certified bodies -- the chain is 139 -> ... -> 150 -> backend -> 151 -> 152 -> 153 -> 154';
  END IF;
  -- The chain position: 152 and 153 first (154 is the last step of the package; the backend that sends the digest was deployed before 151).
  IF to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)')) IS DISTINCT FROM 'd79f71a2a40350307493ea1807b5fa77'
     OR to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)')) IS DISTINCT FROM 'd5f962866a565fe63eb0842124829cfe' THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE refused: migrations 152 and 153 are not applied with their certified bodies -- the chain is 139 -> ... -> 150 -> backend -> 151 -> 152 -> 153 -> 154';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'service_close_day_evidence_digest_v1') THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE refused: already applied';
  END IF;
  IF to_regclass('public.storico') IS NULL OR to_regclass('public.cash_counts') IS NULL OR to_regclass('public.payment_transactions') IS NULL
     OR to_regclass('public.order_obligations') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE refused: a required table or role is missing';
  END IF;
END $guard$;

-- 1. The day window digest ----------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.service_close_day_evidence_digest_v1(p_from timestamptz, p_to timestamptz)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- EXACTLY the inputs of the values the Business Day reconciliation persists (economicSnapshot over [p_from, p_to)), nothing operational:
  --   orders born in the window: identity, service / table grouping, the VOID class of estado (the only estado fact safeTicket reads),
  --   totale (the legacy basis when no obligation row exists), the ledger-written paid mirrors, and metodo_pago only where a legacy-paid
  --   ticket can read it; every financial event of those orders plus every event recorded in the window; every obligation revision of
  --   those orders (permanent identity, composite provenance only for rows without it; post-close resolution facts included); every
  --   payment transaction recorded in the window; every cash count of exactly that window. An operational transition (EN_COCINA -> LISTO
  --   -> EN_ENTREGA -> RETIRADO) or a table status change moves none of the persisted values and is deliberately NOT an input.
  WITH born AS (
    SELECT o.id AS order_id, o.order_uid, o.service_session_id, o.table_session_id, o.estado, o.totale, o.cobrado, o.ya_pagado, o.metodo_pago
      FROM public.ordenes o WHERE o.created_at >= p_from AND o.created_at < p_to
    UNION ALL
    SELECT s.orden_id, NULL::uuid, s.service_session_id, s.table_session_id, s.estado, s.totale, s.cobrado, s.ya_pagado, s.metodo_pago
      FROM public.storico s WHERE s.created_at >= p_from AND s.created_at < p_to
  ), events AS (
    SELECT e.id FROM public.order_financial_events e WHERE e.order_id IN (SELECT b.order_id FROM born b)
    UNION
    SELECT e.id FROM public.order_financial_events e WHERE e.created_at >= p_from AND e.created_at < p_to
  ), obligations AS (
    SELECT b.id FROM public.order_obligations b WHERE b.order_uid IN (SELECT x.order_uid FROM born x WHERE x.order_uid IS NOT NULL)
    UNION
    SELECT b.id FROM public.order_obligations b JOIN born x ON x.order_uid IS NULL AND b.order_id = x.order_id AND b.service_session_id = x.service_session_id
  )
  SELECT jsonb_build_object('version', 2, 'from', p_from, 'to', p_to, 'digest', md5(
    'orders[' || COALESCE((SELECT string_agg(r, ';' ORDER BY r) FROM (
        SELECT concat_ws('|', b.order_id, COALESCE(b.order_uid::text, ''), COALESCE(b.service_session_id::text, ''), COALESCE(b.table_session_id::text, ''),
                              CASE WHEN upper(COALESCE(b.estado, '')) IN ('CANCELADO', 'CANCELLED', 'ANULADO') THEN 'void' ELSE '' END,
                              COALESCE(trim_scale(b.totale)::text, ''), COALESCE(b.cobrado::text, ''), COALESCE(b.ya_pagado::text, ''),
                              CASE WHEN b.order_uid IS NULL OR b.cobrado IS TRUE OR b.ya_pagado IS TRUE THEN COALESCE(b.metodo_pago, '') ELSE '' END) AS r
          FROM born b) q), '') || ']'
    || 'events[' || COALESCE((SELECT string_agg(e.id::text, ';' ORDER BY e.id) FROM events e), '') || ']'
    || 'obligations[' || COALESCE((SELECT string_agg(o.id::text, ';' ORDER BY o.id) FROM obligations o), '') || ']'
    || 'receipts[' || COALESCE((SELECT string_agg(t.id::text, ';' ORDER BY t.id)
          FROM public.payment_transactions t WHERE t.created_at >= p_from AND t.created_at < p_to), '') || ']'
    || 'counts[' || COALESCE((SELECT string_agg(c.id::text, ';' ORDER BY c.id)
          FROM public.cash_counts c WHERE c.window_from = p_from AND c.window_to = p_to), '') || ']'
  ));
$function$;

REVOKE ALL ON FUNCTION public.service_close_day_evidence_digest_v1(timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_close_day_evidence_digest_v1(timestamptz,timestamptz) TO service_role;

-- 2. The terminal step: the 150 body plus block (c) -----------------------------------------------------------------------------------------------------
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
  -- (c) POST-ASTRA F2 (migration 154) -- the Business Day window the reconciliation being persisted was built over. It holds facts that are
  -- not attributed to this service (a carried-over table's refund stays on its origin service, orders of an earlier service of the same
  -- day, a post-close resolution fact, a cash count), so (a) and (b) do not cover them. The backend read the window's digest BEFORE it
  -- built the reconciliation; it is recomputed here, under the lock prefix above, over the SAME window. Any difference -> stale (a new
  -- round), never a persisted reconciliation of facts that no longer hold. Without the digest the reconciliation is not persisted at all.
  IF v_recon.id IS NULL AND p_reconciliation IS NOT NULL THEN
    IF jsonb_typeof(p_reconciliation->'p_day_evidence_digest') IS DISTINCT FROM 'string' THEN
      RETURN jsonb_build_object('ok',false,'code','CLOSE_EVIDENCE_INCOMPLETE','missing',jsonb_build_array('day_evidence_digest'),
                                'closeoutCommitted', v_closeout.id IS NOT NULL, 'reconciliationCommitted', false);
    END IF;
    IF (public.service_close_day_evidence_digest_v1((p_reconciliation->>'p_window_from')::timestamptz, (p_reconciliation->>'p_window_to')::timestamptz)->>'digest')
       IS DISTINCT FROM (p_reconciliation->>'p_day_evidence_digest') THEN
      v_stale := v_stale || 'day_window'::text;
    END IF;
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

-- CREATE OR REPLACE keeps the 150 ACL (service_role only).

-- 3. Post-conditions ---------------------------------------------------------------------------------------------------------------------------------------
DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'c57584ba03c40ee940e402188fd40d2d'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.service_close_day_evidence_digest_v1(timestamptz,timestamptz)')) IS DISTINCT FROM 'f637aa2eaa3baec55bf7e88332d3d345' THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE post-condition failed: installed bodies differ from the certified text';
  END IF;
  IF has_function_privilege('anon', 'public.service_close_day_evidence_digest_v1(timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.service_close_day_evidence_digest_v1(timestamptz,timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.service_close_day_evidence_digest_v1(timestamptz,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE post-condition failed: grants';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576' THEN
    RAISE EXCEPTION 'CLOSE_DAY_EVIDENCE post-condition failed: a 151 body changed';
  END IF;
END $post$;

COMMIT;
