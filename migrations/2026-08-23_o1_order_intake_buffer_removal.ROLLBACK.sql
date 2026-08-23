-- migrations/2026-08-23_o1_order_intake_buffer_removal.ROLLBACK.sql
-- Reverts O-1 by restoring resolve_order_intake_context_v1 and
-- get_order_intake_context_v1's pre-O-1 bodies byte-identical (the R-DAY3
-- installed bodies, migrations/2026-08-16_r_day3_business_day_intake_
-- authority.sql): the 17:30-18:00 buffer blocks order intake again,
-- including for an already-open Operational Service.
--
-- READ THIS BEFORE RUNNING IT. Rolling back reintroduces a proven, real
-- production incident: a genuine comanda on an already-open, already-seated
-- Mesa gets rejected with ORDER_INTAKE_CLOSED for no reason other than the
-- wall clock, 30 minutes a day, every day. No table, column, trigger or
-- grant changes in either direction; this file changes two function bodies
-- only.

BEGIN;

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
  v_period_needs_advance boolean;
  v_open_result          jsonb;
  v_open_reason          text;
  v_open_source          text;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480 AND v_minutes_of_day < 1050)
                       OR (v_minutes_of_day >= 1080);

  IF NOT v_can_create_order THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

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

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  IF FOUND AND v_period.business_day_id = v_day.id THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      IF v_period.lifecycle_semantics = 'operational_service_v1' THEN
        RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'
          USING ERRCODE = 'P0001', DETAIL = v_period.id::text;
      END IF;

      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

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
    'advanced', v_period_needs_advance
  );
END $function$;

REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_intake_context_v1(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid           timestamp;
  v_minutes_of_day   integer;
  v_business_date    date;
  v_service_kind     text;
  v_can_create_order boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480 AND v_minutes_of_day < 1050)
                       OR (v_minutes_of_day >= 1080);

  RETURN jsonb_build_object(
    'canCreateNewOrder', v_can_create_order,
    'businessDate', v_business_date,
    'serviceKind', v_service_kind
  );
END $function$;

REVOKE ALL ON FUNCTION public.get_order_intake_context_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_intake_context_v1() TO service_role;

DO $$
DECLARE
  v_resolve_src text;
  v_get_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL OR position('>= 1080' in v_resolve_src) = 0 THEN
    RAISE EXCEPTION 'O-1 rollback post-condition failed: the pre-O-1 buffer formula was not restored in resolve_order_intake_context_v1';
  END IF;

  SELECT p.prosrc INTO v_get_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get_src IS NULL OR position('>= 1080' in v_get_src) = 0 THEN
    RAISE EXCEPTION 'O-1 rollback post-condition failed: the pre-O-1 buffer formula was not restored in get_order_intake_context_v1';
  END IF;
END $$;

COMMIT;
