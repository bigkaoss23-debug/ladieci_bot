-- migrations/2026-08-20_g1_autonomous_resume_operational_service.ROLLBACK.sql
-- Reverses G-1 by restoring the three exact pre-G-1 function bodies:
--   open_operational_service_v1       -> md5 482e64e22b7f992fd018d02d72a5fc4e
--   resolve_order_intake_context_v1   -> md5 5aa2042a2a7248bccd5d6309ebc10b45
--   ensure_service_session            -> md5 7b090dd34016d3fa5741e942498e304f
--
-- Touches no schema, no data, no grants, and no other function. In
-- particular it does not touch F-10's raise, F-11's stale classification, or
-- the frozen Mesa first-seating guard -- all three are asserted intact after
-- the restore, exactly as the forward migration asserts them.
--
-- POINT OF NO RETURN. Rolling back re-installs the refusal that blocks the
-- next real order after a same-day Finalizar. If any Operational Service was
-- opened with reason 'next_service_of_business_day' while G-1 was live, that
-- service is a real, legitimate service and is NOT undone here (nothing in
-- this file writes to service_sessions) -- but the system will once again
-- demand a manual "Abrir nuevo servicio" the next time the same state is
-- reached. Such services are identifiable by open_source LIKE '%_next_service'.
-- This file reports how many exist so the decision is made with the number
-- in view; it refuses only if the caller has not acknowledged them.

BEGIN;

DO $$
DECLARE
  v_resumed int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'G-1 rollback refused: staging sentinel migration absent -- wrong database?'; END IF;

  -- Idempotent-safety: only roll back a state that actually has G-1 applied.
  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='open_operational_service_v1')
     NOT LIKE '%next_service_of_business_day%' THEN
    RAISE EXCEPTION 'G-1 rollback refused: G-1 does not appear to be applied (open_operational_service_v1 has no next_service_of_business_day reason)';
  END IF;

  SELECT count(*) INTO v_resumed FROM public.service_sessions WHERE open_source LIKE '%\_next\_service';
  RAISE NOTICE 'G-1 rollback: % Operational Service(s) were opened by the autonomous resume path; they are real and are left untouched.', v_resumed;
END $$;

CREATE OR REPLACE FUNCTION public.open_operational_service_v1(p_opened_by text, p_open_reason text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_ss_state public.service_session_state%ROWTYPE;
  v_day      public.business_days%ROWTYPE;
  v_active   public.service_sessions%ROWTYPE;
  v_has_any  boolean;
  v_new      public.service_sessions%ROWTYPE;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;
  IF p_open_reason IS NULL OR p_open_reason NOT IN ('first_open_of_business_day', 'explicit_reopen') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_OPEN_REASON');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SOURCE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  SELECT * INTO v_ss_state FROM public.service_session_state       WHERE singleton = true FOR UPDATE;

  IF v_bd_state.current_business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CURRENT_BUSINESS_DAY');
  END IF;

  SELECT * INTO v_day FROM public.business_days WHERE id = v_bd_state.current_business_day_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUSINESS_DAY_NOT_FOUND');
  END IF;

  SELECT * INTO v_active FROM public.service_sessions WHERE status IN ('open', 'closing') FOR UPDATE;
  IF FOUND THEN
    IF v_active.business_day_id IS DISTINCT FROM v_day.id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH', 'session', to_jsonb(v_active));
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'session', to_jsonb(v_active));
  END IF;

  v_has_any := EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id);

  IF p_open_reason = 'first_open_of_business_day' THEN
    IF v_has_any THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_REOPEN_REQUIRED');
    END IF;
  ELSE
    IF NOT v_has_any THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_PRIOR_SERVICE_TO_REOPEN');
    END IF;
  END IF;

  INSERT INTO public.service_sessions (
    business_date, status, opened_by, open_source, service_kind, lifecycle_semantics
  ) VALUES (
    v_day.business_date, 'open', p_opened_by, p_source, NULL, 'operational_service_v1'
  ) RETURNING * INTO v_new;

  IF v_new.business_day_id IS DISTINCT FROM v_day.id THEN
    RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_BUSINESS_DAY_DERIVE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_period_id = v_new.id, updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_new.id, updated_at = now()
   WHERE singleton = true;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_new.id, 'opened', p_opened_by, p_source);

  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_new.id THEN
    RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_POINTER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton = true) IS DISTINCT FROM v_new.id THEN
    RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_SHADOW_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'CREATED', 'created', true, 'session', to_jsonb(v_new));
END;
$function$;

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
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value restored verbatim from the pre-G-1 body, not new vocabulary
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
        RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
          'businessDayId', v_day.id, 'businessDate', v_business_date, 'serviceKind', v_service_kind);
      END IF;

      v_open_result := public.open_operational_service_v1(
        COALESCE(p_actor, 'system'), 'first_open_of_business_day', COALESCE(p_source, 'order_intake')
      );
      IF (v_open_result->>'ok')::boolean IS NOT TRUE THEN
        RETURN jsonb_build_object('ok', false, 'code', 'OPEN_OPERATIONAL_SERVICE_FAILED',
          'reason', v_open_result->>'code', 'businessDate', v_business_date);
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

    -- F-11 — canonical Business Day authority, reused verbatim from the
    -- order-intake path (04:00 Madrid overnight cutoff included). STABLE,
    -- writes nothing.
    v_canonical_business_date :=
      NULLIF(public.get_order_intake_context_v1() ->> 'businessDate', '')::date;

    -- Downgrade ONLY on positive evidence of staleness. A missing date on
    -- either side leaves the stronger same-day protection in place.
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

    RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
      'businessDayId', v_bd_state.current_business_day_id,
      'businessDate', v_pointer_business_date);
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
    'businessDayId', v_bd_state.current_business_day_id,
    'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
END;
$function$;

DO $$
BEGIN
  IF md5(pg_get_functiondef('public.open_operational_service_v1(text,text,text)'::regprocedure))
       IS DISTINCT FROM '482e64e22b7f992fd018d02d72a5fc4e' THEN
    RAISE EXCEPTION 'G-1 rollback post-condition failed: open_operational_service_v1 was not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.open_operational_service_v1(text,text,text)'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.resolve_order_intake_context_v1(text,text)'::regprocedure))
       IS DISTINCT FROM '5aa2042a2a7248bccd5d6309ebc10b45' THEN
    RAISE EXCEPTION 'G-1 rollback post-condition failed: resolve_order_intake_context_v1 was not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.resolve_order_intake_context_v1(text,text)'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.ensure_service_session(text,text)'::regprocedure))
       IS DISTINCT FROM '7b090dd34016d3fa5741e942498e304f' THEN
    RAISE EXCEPTION 'G-1 rollback post-condition failed: ensure_service_session was not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.ensure_service_session(text,text)'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'::regprocedure))
       IS DISTINCT FROM 'cdf15eb3699a6a86c16519b1dbcd2f1c'
     OR md5(pg_get_functiondef('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)'::regprocedure))
       IS DISTINCT FROM '21f6d47a1e911f01933bd4b2e2d8558e' THEN
    RAISE EXCEPTION 'G-1 rollback post-condition failed: the frozen Mesa first-seating guard bodies changed';
  END IF;
END $$;

COMMIT;
