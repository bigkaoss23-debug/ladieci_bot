-- migrations/2026-08-17_f4a_era_aware_close_evidence_contract.ROLLBACK.sql
-- Paired rollback for 2026-08-17_f4a_era_aware_close_evidence_contract.sql.
--
-- PONR (point of no return): the FIRST COMMITTED evidence row in any of the
-- three tables where lifecycle_semantics='operational_service_v1' OR
-- service_kind IS NULL. At that point this rollback would either destroy a
-- real, immutable evidence fact (DROP COLUMN lifecycle_semantics) or corrupt
-- one (SET NOT NULL against a genuinely NULL value would itself fail, but a
-- forced restatement of a fabricated kind would misrepresent it) -- so this
-- rollback refuses outright the instant any such row exists, checked first,
-- before any DDL runs.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_closeout_snapshots WHERE lifecycle_semantics = 'operational_service_v1' OR service_kind IS NULL)
     OR EXISTS (SELECT 1 FROM public.service_closeouts WHERE lifecycle_semantics = 'operational_service_v1' OR service_kind IS NULL)
     OR EXISTS (SELECT 1 FROM public.service_incidents WHERE lifecycle_semantics = 'operational_service_v1' OR service_kind IS NULL)
  THEN
    RAISE EXCEPTION 'F-4A rollback refused: PONR reached -- real new-era evidence exists (lifecycle_semantics=operational_service_v1 or service_kind IS NULL) in at least one evidence table; rolling back would destroy or misrepresent immutable evidence';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_closeout_snapshots' AND column_name='lifecycle_semantics') THEN
    RAISE EXCEPTION 'F-4A rollback refused: lifecycle_semantics column not present on service_closeout_snapshots -- not applied, or already drifted';
  END IF;
END $$;

-- ============================================================
-- RPC 1/3 — capture_closeout_snapshot (exact byte-captured pre-F-4A body)
-- ============================================================
CREATE OR REPLACE FUNCTION public.capture_closeout_snapshot(p_service_session_id uuid, p_closeout_correlation_id uuid, p_captured_by text, p_source text, p_payload jsonb, p_schema_version integer DEFAULT 1, p_payload_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_row     public.service_closeout_snapshots%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_captured_by IS NULL OR btrim(p_captured_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SNAPSHOT_PAYLOAD');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  INSERT INTO public.service_closeout_snapshots(
    service_session_id, business_date, service_kind, closeout_correlation_id,
    schema_version, captured_by, source, payload, payload_sha256
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_closeout_correlation_id,
    COALESCE(p_schema_version, 1), p_captured_by, p_source, p_payload, p_payload_sha256
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CAPTURED','created',true,'snapshot',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_snapshots WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_CAPTURED','created',false,'snapshot',to_jsonb(v_row));
END;
$function$;

-- ============================================================
-- RPC 2/3 — create_service_closeout (exact byte-captured pre-F-4A body)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_service_closeout(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_close_reason text, p_gross_sales_cents integer, p_net_sales_cents integer, p_total_refunds_cents integer, p_total_void_cents integer, p_paid_amount_cents integer, p_unpaid_exposure_cents integer, p_order_count integer, p_cash_amount_cents integer, p_card_amount_cents integer, p_bizum_amount_cents integer, p_other_amount_cents integer, p_open_orders_at_close integer, p_occupied_tables_at_close integer, p_kitchen_pending_count integer DEFAULT 0, p_listo_count integer DEFAULT 0, p_delivery_pending_count integer DEFAULT 0, p_incident_count integer DEFAULT 0, p_critical_incident_count integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_attempt public.service_closeout_attempts%ROWTYPE;
  v_row     public.service_closeouts%ROWTYPE;
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
  IF p_gross_sales_cents IS NULL OR p_gross_sales_cents < 0
     OR p_net_sales_cents IS NULL OR p_net_sales_cents < 0
     OR p_paid_amount_cents IS NULL OR p_paid_amount_cents < 0
     OR p_unpaid_exposure_cents IS NULL OR p_unpaid_exposure_cents < 0
     OR p_order_count IS NULL OR p_order_count < 0
  THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_FINANCIAL_FIELDS');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  SELECT * INTO v_attempt FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;
  IF v_attempt.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_SESSION_MISMATCH');
  END IF;
  IF v_attempt.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  INSERT INTO public.service_closeouts(
    service_session_id, closeout_correlation_id, business_date, service_kind,
    opened_at, closed_at, close_source, close_reason, closed_by,
    gross_sales_cents, net_sales_cents, total_discounts_cents, total_refunds_cents, total_void_cents,
    paid_amount_cents, unpaid_exposure_cents, order_count,
    cash_amount_cents, card_amount_cents, bizum_amount_cents, other_amount_cents,
    open_orders_at_close, occupied_tables_at_close,
    kitchen_pending_count, listo_count, delivery_pending_count,
    incident_count, critical_incident_count
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0),
    COALESCE(p_kitchen_pending_count, 0), COALESCE(p_listo_count, 0), COALESCE(p_delivery_pending_count, 0),
    COALESCE(p_incident_count, 0), COALESCE(p_critical_incident_count, 0)
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,'closeout',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeouts WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_EXISTS','created',false,'closeout',to_jsonb(v_row));
END;
$function$;

-- ============================================================
-- RPC 3/3 — create_service_incident (exact byte-captured pre-F-4A body)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_service_incident(p_service_session_id uuid, p_closeout_correlation_id uuid, p_incident_type text, p_category text, p_severity text, p_detected_by text, p_entity_type text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_order_id text DEFAULT NULL::text, p_table_session_id uuid DEFAULT NULL::uuid, p_giro_id text DEFAULT NULL::text, p_rider_id text DEFAULT NULL::text, p_financial_exposure_cents integer DEFAULT NULL::integer, p_snapshot_id uuid DEFAULT NULL::uuid, p_auto_resolve boolean DEFAULT false, p_auto_resolution_type text DEFAULT NULL::text, p_auto_resolution_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_row     public.service_incidents%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_incident_type IS NULL OR btrim(p_incident_type) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_INCIDENT_TYPE');
  END IF;
  IF p_category NOT IN ('informational','operational','financial','integrity','security') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CATEGORY');
  END IF;
  IF p_severity NOT IN ('info','warning','critical') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SEVERITY');
  END IF;
  IF p_detected_by IS NULL OR btrim(p_detected_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_category = 'financial' AND p_financial_exposure_cents IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','FINANCIAL_EXPOSURE_REQUIRED');
  END IF;
  IF p_auto_resolve AND (p_auto_resolution_type IS NULL OR btrim(p_auto_resolution_type) = '') THEN
    RETURN jsonb_build_object('ok',false,'code','AUTO_RESOLUTION_TYPE_REQUIRED');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  IF p_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_closeout_snapshots WHERE id = p_snapshot_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','SNAPSHOT_NOT_FOUND');
  END IF;

  INSERT INTO public.service_incidents(
    service_session_id, business_date, service_kind, closeout_correlation_id, snapshot_id,
    incident_type, category, severity,
    entity_type, entity_id, order_id, table_session_id, giro_id, rider_id,
    financial_exposure_cents, detected_by,
    auto_resolved, resolution_status, resolution_type, resolved_at, resolved_by, resolution_note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_closeout_correlation_id, p_snapshot_id,
    p_incident_type, p_category, p_severity,
    p_entity_type, p_entity_id, p_order_id, p_table_session_id, p_giro_id, p_rider_id,
    p_financial_exposure_cents, p_detected_by,
    p_auto_resolve,
    CASE WHEN p_auto_resolve THEN 'resolved' ELSE 'pending' END,
    CASE WHEN p_auto_resolve THEN p_auto_resolution_type ELSE NULL END,
    CASE WHEN p_auto_resolve THEN now() ELSE NULL END,
    CASE WHEN p_auto_resolve THEN 'system' ELSE NULL END,
    CASE WHEN p_auto_resolve THEN p_auto_resolution_note ELSE NULL END
  )
  ON CONFLICT (closeout_correlation_id, incident_type, COALESCE(entity_type, ''), COALESCE(entity_id, ''))
  DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','RECORDED','created',true,'incident',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_incidents
   WHERE closeout_correlation_id = p_closeout_correlation_id
     AND incident_type = p_incident_type
     AND COALESCE(entity_type,'') = COALESCE(p_entity_type,'')
     AND COALESCE(entity_id,'')   = COALESCE(p_entity_id,'');
  RETURN jsonb_build_object('ok',true,'code','ALREADY_RECORDED','created',false,'incident',to_jsonb(v_row));
END;
$function$;

-- ============================================================
-- Schema restoration -- reverse order of the forward migration.
-- ============================================================
ALTER TABLE public.service_closeout_snapshots DROP CONSTRAINT service_closeout_snapshots_kind_era_chk;
ALTER TABLE public.service_closeout_snapshots DROP CONSTRAINT service_closeout_snapshots_service_kind_check;
ALTER TABLE public.service_closeout_snapshots ADD CONSTRAINT service_closeout_snapshots_service_kind_check CHECK (service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, restoring the exact pre-F-4A CHECK verbatim, not new vocabulary
ALTER TABLE public.service_closeout_snapshots ALTER COLUMN service_kind SET NOT NULL;
ALTER TABLE public.service_closeout_snapshots DROP CONSTRAINT service_closeout_snapshots_lifecycle_semantics_chk;
ALTER TABLE public.service_closeout_snapshots DROP COLUMN lifecycle_semantics;

ALTER TABLE public.service_closeouts DROP CONSTRAINT service_closeouts_kind_era_chk;
ALTER TABLE public.service_closeouts DROP CONSTRAINT service_closeouts_service_kind_check;
ALTER TABLE public.service_closeouts ADD CONSTRAINT service_closeouts_service_kind_check CHECK (service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason
ALTER TABLE public.service_closeouts ALTER COLUMN service_kind SET NOT NULL;
ALTER TABLE public.service_closeouts DROP CONSTRAINT service_closeouts_lifecycle_semantics_chk;
ALTER TABLE public.service_closeouts DROP COLUMN lifecycle_semantics;

ALTER TABLE public.service_incidents DROP CONSTRAINT service_incidents_kind_era_chk;
ALTER TABLE public.service_incidents DROP CONSTRAINT service_incidents_service_kind_check;
ALTER TABLE public.service_incidents ADD CONSTRAINT service_incidents_service_kind_check CHECK (service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason
ALTER TABLE public.service_incidents ALTER COLUMN service_kind SET NOT NULL;
ALTER TABLE public.service_incidents DROP CONSTRAINT service_incidents_lifecycle_semantics_chk;
ALTER TABLE public.service_incidents DROP COLUMN lifecycle_semantics;

-- ============================================================
-- Post-condition.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND column_name='lifecycle_semantics' AND table_name IN ('service_closeout_snapshots','service_closeouts','service_incidents')) THEN
    RAISE EXCEPTION 'F-4A rollback post-condition failed: lifecycle_semantics still present on at least one evidence table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND column_name='service_kind' AND is_nullable='YES'
      AND table_name IN ('service_closeout_snapshots','service_closeouts','service_incidents')
  ) THEN
    RAISE EXCEPTION 'F-4A rollback post-condition failed: service_kind still nullable on at least one evidence table';
  END IF;
  IF (SELECT count(*) FROM public.service_closeouts) <> 3
     OR (SELECT count(*) FROM public.service_closeout_snapshots) <> 14
     OR (SELECT count(*) FROM public.service_incidents) <> 49
  THEN RAISE EXCEPTION 'F-4A rollback post-condition failed: historical row counts changed'; END IF;
END $$;

COMMIT;
