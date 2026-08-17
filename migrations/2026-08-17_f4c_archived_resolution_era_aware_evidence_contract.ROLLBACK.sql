-- migrations/2026-08-17_f4c_archived_resolution_era_aware_evidence_contract.ROLLBACK.sql
-- Paired rollback for 2026-08-17_f4c_archived_resolution_era_aware_evidence_contract.sql.
--
-- PONR (point of no return): the FIRST COMMITTED archived financial
-- resolution where lifecycle_semantics='operational_service_v1' OR
-- service_kind IS NULL. At that point this rollback would either destroy a
-- real, immutable evidence fact (DROP COLUMN lifecycle_semantics) or corrupt
-- one (SET NOT NULL against a genuinely NULL value would itself fail, but a
-- forced restatement of a fabricated kind would misrepresent it) -- so this
-- rollback refuses outright the instant any such row exists, checked first,
-- before any DDL runs. Matches F-4A's own PONR contract exactly.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.archived_order_financial_resolutions WHERE lifecycle_semantics = 'operational_service_v1' OR service_kind IS NULL)
  THEN
    RAISE EXCEPTION 'F-4C rollback refused: PONR reached -- real new-era archived financial resolution evidence exists (lifecycle_semantics=operational_service_v1 or service_kind IS NULL); rolling back would destroy or misrepresent immutable evidence';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='lifecycle_semantics') THEN
    RAISE EXCEPTION 'F-4C rollback refused: lifecycle_semantics column not present on archived_order_financial_resolutions -- not applied, or already drifted';
  END IF;
END $$;

-- ============================================================
-- Canonical writer — exact byte-captured pre-F-4C body.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_archived_order_financial_resolution(p_service_session_id uuid, p_archived_order_id text, p_related_incident_id uuid, p_action_correlation_id uuid, p_resolution_type text, p_amount_cents integer, p_actor text, p_actor_role text, p_reason text, p_payment_method text DEFAULT NULL::text, p_reversed_event_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session  public.service_sessions%ROWTYPE;
  v_incident public.service_incidents%ROWTYPE;
  v_prior    public.archived_order_financial_resolutions%ROWTYPE;
  v_reversed public.archived_order_financial_resolutions%ROWTYPE;
  v_row      public.archived_order_financial_resolutions%ROWTYPE;
  v_method   text;
  v_original integer;
  v_remaining integer;
  v_sequence integer;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok',false,'code','FINANCIAL_RESOLUTION_FORBIDDEN');
  END IF;
  IF p_service_session_id IS NULL OR p_archived_order_id IS NULL OR btrim(p_archived_order_id) = '' OR p_action_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  SELECT * INTO v_row FROM public.archived_order_financial_resolutions WHERE action_correlation_id = p_action_correlation_id;
  IF FOUND THEN
    IF v_row.service_session_id IS DISTINCT FROM p_service_session_id
       OR v_row.archived_order_id IS DISTINCT FROM p_archived_order_id
       OR v_row.related_incident_id IS DISTINCT FROM p_related_incident_id
       OR v_row.resolution_type IS DISTINCT FROM p_resolution_type
       OR v_row.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_row.payment_method IS DISTINCT FROM (CASE WHEN p_payment_method IS NULL THEN NULL ELSE lower(btrim(p_payment_method)) END)
       OR v_row.reversed_event_id IS DISTINCT FROM p_reversed_event_id
    THEN
      RETURN jsonb_build_object('ok',false,'code','ACTION_CORRELATION_ID_CONFLICT');
    END IF;
    RETURN jsonb_build_object('ok',true,'code','ALREADY_RECORDED','created',false,'resolution',to_jsonb(v_row));
  END IF;

  IF p_related_incident_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_LINK_REQUIRED');
  END IF;
  IF p_resolution_type IS NULL OR p_resolution_type NOT IN ('recovered_payment','write_off','reversal') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_RESOLUTION_TYPE');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_AMOUNT');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_REASON');
  END IF;

  IF p_resolution_type = 'recovered_payment' THEN
    v_method := lower(btrim(COALESCE(p_payment_method, '')));
    IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
      RETURN jsonb_build_object('ok',false,'code','INVALID_PAYMENT_METHOD');
    END IF;
  ELSE
    IF p_payment_method IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'code','PAYMENT_METHOD_NOT_ALLOWED');
    END IF;
    v_method := NULL;
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.storico -- language-guard: allow-legacy storico is the existing table this RPC always queried, restored verbatim, not new vocabulary
     WHERE service_session_id = p_service_session_id AND orden_id = p_archived_order_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ARCHIVED_ORDER_NOT_FOUND');
  END IF;

  SELECT * INTO v_incident FROM public.service_incidents WHERE id = p_related_incident_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_NOT_FOUND');
  END IF;
  IF v_incident.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_SERVICE_MISMATCH');
  END IF;
  IF v_incident.category <> 'financial' THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_NOT_FINANCIAL');
  END IF;
  IF v_incident.order_id IS DISTINCT FROM p_archived_order_id THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_ORDER_MISMATCH');
  END IF;
  IF v_incident.financial_exposure_cents IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_MISSING_EXPOSURE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_service_session_id::text || ':' || p_archived_order_id));

  SELECT * INTO v_prior FROM public.archived_order_financial_resolutions
   WHERE service_session_id = p_service_session_id AND archived_order_id = p_archived_order_id
   ORDER BY lineage_sequence DESC
   LIMIT 1;

  IF FOUND THEN
    v_original := v_prior.original_exposure_cents;
    v_sequence := v_prior.lineage_sequence + 1;
    IF p_related_incident_id IS DISTINCT FROM v_prior.related_incident_id THEN
      RETURN jsonb_build_object('ok',false,'code','INCIDENT_LINK_MISMATCH');
    END IF;
  ELSE
    v_original := v_incident.financial_exposure_cents;
    v_sequence := 1;
  END IF;

  IF p_resolution_type = 'reversal' THEN
    IF p_reversed_event_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSED_EVENT_REQUIRED');
    END IF;
    SELECT * INTO v_reversed FROM public.archived_order_financial_resolutions
     WHERE id = p_reversed_event_id
       AND service_session_id = p_service_session_id
       AND archived_order_id = p_archived_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSED_EVENT_NOT_FOUND');
    END IF;
    IF v_reversed.resolution_type NOT IN ('recovered_payment','write_off') THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSED_EVENT_NOT_REVERSIBLE');
    END IF;
    IF p_amount_cents IS DISTINCT FROM v_reversed.amount_cents THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSAL_AMOUNT_MISMATCH');
    END IF;
    IF EXISTS (SELECT 1 FROM public.archived_order_financial_resolutions WHERE reversed_event_id = p_reversed_event_id) THEN
      RETURN jsonb_build_object('ok',false,'code','EVENT_ALREADY_REVERSED');
    END IF;
    v_remaining := COALESCE(v_prior.remaining_exposure_cents, v_original) + p_amount_cents;
    IF v_remaining > v_original THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSAL_EXCEEDS_ORIGINAL');
    END IF;
  ELSE
    v_remaining := COALESCE(v_prior.remaining_exposure_cents, v_original) - p_amount_cents;
    IF v_remaining < 0 THEN
      RETURN jsonb_build_object('ok',false,'code','OVER_RESOLUTION_EXCEEDS_REMAINING');
    END IF;
  END IF;

  INSERT INTO public.archived_order_financial_resolutions(
    service_session_id, business_date, service_kind, archived_order_id, related_incident_id,
    action_correlation_id, resolution_type, reversed_event_id,
    original_exposure_cents, amount_cents, remaining_exposure_cents, lineage_sequence,
    payment_method, actor, role, reason, note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_archived_order_id, p_related_incident_id,
    p_action_correlation_id, p_resolution_type, p_reversed_event_id,
    v_original, p_amount_cents, v_remaining, v_sequence,
    v_method, p_actor, p_actor_role, p_reason, p_note
  )
  ON CONFLICT (action_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','RECORDED','created',true,'resolution',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.archived_order_financial_resolutions WHERE action_correlation_id = p_action_correlation_id;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_RECORDED','created',false,'resolution',to_jsonb(v_row));
END;
$function$;

-- ============================================================
-- Schema restoration.
-- ============================================================
ALTER TABLE public.archived_order_financial_resolutions DROP CONSTRAINT archived_order_financial_resolutions_kind_era_chk;
ALTER TABLE public.archived_order_financial_resolutions DROP CONSTRAINT archived_order_financial_resolutions_service_kind_check;
ALTER TABLE public.archived_order_financial_resolutions ADD CONSTRAINT archived_order_financial_resolutions_service_kind_check CHECK (service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, restoring the exact pre-F-4C CHECK verbatim, not new vocabulary
ALTER TABLE public.archived_order_financial_resolutions ALTER COLUMN service_kind SET NOT NULL;
ALTER TABLE public.archived_order_financial_resolutions DROP CONSTRAINT archived_order_financial_resolutions_lifecycle_semantics_chk;
ALTER TABLE public.archived_order_financial_resolutions DROP COLUMN lifecycle_semantics;

-- ============================================================
-- Post-condition.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='lifecycle_semantics') THEN
    RAISE EXCEPTION 'F-4C rollback post-condition failed: lifecycle_semantics still present on archived_order_financial_resolutions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='service_kind' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'F-4C rollback post-condition failed: service_kind still nullable on archived_order_financial_resolutions';
  END IF;
  IF (SELECT count(*) FROM public.archived_order_financial_resolutions) <> 0
  THEN RAISE EXCEPTION 'F-4C rollback post-condition failed: historical row count changed'; END IF;
END $$;

COMMIT;
