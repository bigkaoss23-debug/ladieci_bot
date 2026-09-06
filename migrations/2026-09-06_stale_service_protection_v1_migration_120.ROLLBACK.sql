-- migrations/2026-09-06_stale_service_protection_v1_migration_120.ROLLBACK.sql
-- Reverses STALE SERVICE PROTECTION V1: restores the pre-M120 (post-O-4c /
-- post-O-3) bodies of resolve_order_intake_context_v1, ensure_service_session
-- and get_order_intake_context_v1 VERBATIM.
--
-- WARNING: rolling this back re-opens the exact hazard the audit named — an
-- open operational_service_v1 row from a past Business Day is again handed
-- back as the current service, and a new order can again be assigned to it by
-- the service_session_assign_order() trigger. Do not roll back without also
-- neutralising src/serviceSessions/staleServiceRecovery.js's call sites, or
-- the JS layer will keep classifying a stale service as PREVIOUS_SERVICE_
-- PENDING while the SQL layer keeps handing it back as RESOLVED/REUSED.

BEGIN;

DO $guard$
DECLARE v_r text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_r FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF v_r IS NULL OR v_r NOT LIKE '%PREVIOUS_SERVICE_PENDING%' THEN
    RAISE EXCEPTION 'M120 ROLLBACK refused: resolve_order_intake_context_v1 does not carry the M120 shape -- nothing to roll back, or drift';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1(p_actor text DEFAULT 'order_intake_v1'::text, p_source text DEFAULT 'order_intake_v1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid              timestamp;
  v_minutes_of_day      integer;
  v_business_date       date;
  v_service_kind        text;
  v_can_create_order    boolean;
  v_pointer             public.business_day_lifecycle_state%ROWTYPE;
  v_day                 public.business_days%ROWTYPE;
  v_period               public.service_sessions%ROWTYPE;
  v_open_result          jsonb;
  v_open_reason          text;
  v_open_source          text;
  v_had_open_or_closing  boolean;
  v_continuity           boolean;
  v_ticket_epoch          integer;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;
  v_had_open_or_closing := FOUND;

  IF v_had_open_or_closing AND v_period.lifecycle_semantics = 'operational_service_v1' THEN
    SELECT ticket_epoch INTO v_ticket_epoch FROM public.business_days WHERE id = v_period.business_day_id;
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'RESOLVED',
      'businessDayId', v_period.business_day_id,
      'businessDate', v_period.business_date,
      'periodId', v_period.id,
      'serviceKind', v_service_kind,
      'ticketEpoch', v_ticket_epoch,
      'advanced', false
    );
  END IF;

  v_continuity := false;

  IF NOT v_can_create_order AND NOT v_continuity THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

  SELECT * INTO v_pointer FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_day FROM public.business_days WHERE business_date = v_business_date;
  IF NOT FOUND THEN
    INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
    VALUES (v_business_date, COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'), 1, 1)
    ON CONFLICT (business_date) DO NOTHING
    RETURNING * INTO v_day;
    IF NOT FOUND THEN
      SELECT * INTO v_day FROM public.business_days WHERE business_date = v_business_date;
    END IF;
  END IF;
  IF v_day.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUSINESS_DAY_UNRESOLVED');
  END IF;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_day.id,
         current_ticket_epoch    = v_day.ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  SELECT * INTO v_period FROM public.service_sessions
   WHERE business_day_id = v_day.id AND status IN ('open','closing');
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id) THEN
      v_open_reason := 'next_service_of_business_day';
      v_open_source := COALESCE(p_source, 'order_intake') || '_next_service';
    ELSE
      v_open_reason := 'first_open_of_business_day';
      v_open_source := COALESCE(p_source, 'order_intake');
    END IF;

    v_open_result := public.open_operational_service_v1(
      COALESCE(p_actor, 'system'), v_open_reason, v_open_source
    );
    IF (v_open_result->>'ok')::boolean IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'code', 'OPEN_OPERATIONAL_SERVICE_FAILED',
        'reason', v_open_result->>'code', 'openReason', v_open_reason, 'businessDate', v_business_date);
    END IF;
    SELECT * INTO v_period FROM public.service_sessions WHERE id = (v_open_result->'session'->>'id')::uuid;
  END IF;

  v_pointer.current_period_id := v_period.id;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_period_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  IF v_period.business_day_id IS DISTINCT FROM v_day.id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_period.id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF (SELECT current_ticket_epoch FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_day.ticket_epoch THEN
    RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'RESOLVED',
    'businessDayId', v_day.id,
    'businessDate', v_business_date,
    'periodId', v_period.id,
    'serviceKind', v_service_kind,
    'ticketEpoch', v_day.ticket_epoch,
    'advanced', true
  );
END $function$;

CREATE OR REPLACE FUNCTION public.ensure_service_session(p_opened_by text, p_source text DEFAULT 'auto_entry'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_has_any  boolean;
  v_pointer_business_date   date;
  v_canonical_business_date date;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open', 'closing')) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.service_sessions WHERE id = v_state.current_session_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_SESSION_STATE_CORRUPT');
    END IF;
    IF v_session.status = 'closing' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_SESSION_CLOSING', 'session', to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'session', to_jsonb(v_session));
  END IF;

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true;
  IF v_bd_state.current_business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE');
  END IF;

  v_has_any := EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_bd_state.current_business_day_id);
  IF v_has_any THEN
    SELECT business_date INTO v_pointer_business_date
      FROM public.business_days WHERE id = v_bd_state.current_business_day_id;

    v_canonical_business_date :=
      NULLIF(public.get_order_intake_context_v1() ->> 'businessDate', '')::date;

    IF v_pointer_business_date IS NOT NULL
       AND v_canonical_business_date IS NOT NULL
       AND v_pointer_business_date <> v_canonical_business_date
    THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
        'businessDayId', v_bd_state.current_business_day_id,
        'businessDate', v_pointer_business_date,
        'staleBusinessDay', true,
        'currentBusinessDate', v_canonical_business_date);
    END IF;

    RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
      'businessDayId', v_bd_state.current_business_day_id,
      'businessDate', v_pointer_business_date,
      'hadPriorServiceToday', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
    'businessDayId', v_bd_state.current_business_day_id,
    'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid                    timestamp;
  v_minutes_of_day            integer;
  v_business_date             date;
  v_service_kind               text;
  v_can_create_order           boolean;
  v_has_valid_current_service  boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  SELECT EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE status IN ('open','closing') AND lifecycle_semantics = 'operational_service_v1'
  ) INTO v_has_valid_current_service;

  RETURN jsonb_build_object(
    'canCreateNewOrder', v_can_create_order,
    'businessDate', v_business_date,
    'serviceKind', v_service_kind,
    'hasValidCurrentService', v_has_valid_current_service
  );
END $function$;

COMMIT;
