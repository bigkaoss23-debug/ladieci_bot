-- migrations/2026-08-17_s_d_stop_same_day_kind_rollover.ROLLBACK.sql
-- Paired rollback for 2026-08-17_s_d_stop_same_day_kind_rollover.sql.
--
-- Restores the exact byte-captured pre-S-D three-term reuse predicate.
-- Touches no data -- resolve_order_intake_context_v1 is a pure function
-- redefinition; there is nothing to refuse on (unlike S-C's stamp columns,
-- there is no append-only evidence created by this migration to protect).
BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'S-D rollback refused: resolve_order_intake_context_v1 does not exist';
  END IF;
  IF position('IF FOUND AND v_period.business_date = v_business_date THEN' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D rollback refused: post-S-D two-term shape not detected -- not applied, or already drifted past S-D';
  END IF;
END $$;

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
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END;
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

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  IF FOUND AND v_period.business_date = v_business_date AND v_period.service_kind = v_service_kind THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_date = v_business_date AND service_kind = v_service_kind
       AND status IN ('open','closing');
    IF NOT FOUND THEN
      INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)
      VALUES (v_business_date, v_service_kind, 'open', COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'))
      RETURNING * INTO v_period;
    END IF;
  END IF;

  v_pointer.current_period_id       := v_period.id;
  v_pointer.current_business_day_id := v_day.id;
  v_pointer.current_ticket_epoch    := v_day.ticket_epoch;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_pointer.current_business_day_id,
         current_period_id       = v_pointer.current_period_id,
         current_ticket_epoch    = v_pointer.current_ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  IF v_period.business_day_id IS DISTINCT FROM v_pointer.current_business_day_id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF v_day.ticket_epoch IS DISTINCT FROM v_pointer.current_ticket_epoch THEN
    RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'RESOLVED',
    'businessDayId', v_pointer.current_business_day_id,
    'businessDate', v_business_date,
    'periodId', v_pointer.current_period_id,
    'serviceKind', v_service_kind,
    'ticketEpoch', v_pointer.current_ticket_epoch,
    'advanced', v_period_needs_advance
  );
END $function$;

-- Post-condition.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF position('IF FOUND AND v_period.business_date = v_business_date AND v_period.service_kind = v_service_kind THEN' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D rollback post-condition failed: pre-S-D three-term predicate not restored';
  END IF;
END $$;

COMMIT;
