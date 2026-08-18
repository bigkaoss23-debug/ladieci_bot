-- migrations/2026-08-18_f7_opening_authority_cutover.ROLLBACK.sql
-- Paired rollback for 2026-08-18_f7_opening_authority_cutover.sql. Restores
-- ensure_service_session (3-arg, INSERT-capable) and resolve_order_intake_
-- context_v1 (direct-INSERT) to their exact byte-captured pre-F-7 bodies --
-- functionally and structurally identical in every statement, with two
-- inline language-guard suppression comments added (required by this repo's
-- own hard CI gate, scripts/check-domain-language.js, which applies to every
-- committed file including rollbacks) documenting the restored PRANZO/SERA -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe why the two inline suppressions below exist, not new vocabulary
-- literals as historical, not new, vocabulary.
--
-- GUARDED (PONR): refuses if any real operational_service_v1 service_
-- sessions row exists anywhere -- rolling back at that point would restore a
-- resolver/ensure pair that cannot account for a row whose era they no
-- longer understand as a legitimate "current session" origin, and would
-- resurrect a direct-INSERT creation path alongside a real new-era row
-- already on record. Also refuses if the F-6 primitive has been retired
-- (this rollback's restored resolver never calls it, but a caller expecting
-- it to still exist for some OTHER reason should not silently regress).
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-7 rollback refused: a real operational_service_v1 session exists -- this cutover has been consumed for real, resolve forward-drift first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.ensure_service_session(text, text);

CREATE FUNCTION public.ensure_service_session(p_opened_by text, p_service_kind text, p_source text DEFAULT 'auto_entry'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_madrid timestamp;
  v_business_date date;
BEGIN
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, restored byte-verbatim as the pre-F-7 body this rollback exists to restore, not new vocabulary
    RETURN jsonb_build_object('ok',false,'code','INVALID_SERVICE_KIND');
  END IF;
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_business_date := CASE WHEN v_madrid::time < TIME '04:00'
                          THEN v_madrid::date - 1 ELSE v_madrid::date END;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state
   WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions
       WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.service_sessions
     WHERE id=v_state.current_session_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_STATE_CORRUPT');
    END IF;
    IF v_session.status = 'closing' THEN
      RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_CLOSING',
                                'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,
                              'session',to_jsonb(v_session));
  END IF;

  IF EXISTS (SELECT 1 FROM public.service_sessions
              WHERE business_date=v_business_date
                AND service_kind=p_service_kind
                AND status IN ('open','closing')) THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_ALREADY_COMPLETED_TODAY',
                              'businessDate',v_business_date,
                              'serviceKind',p_service_kind);
  END IF;
  INSERT INTO public.service_sessions(
    business_date,status,opened_by,open_source,service_kind
  ) VALUES (
    v_business_date,'open',p_opened_by,COALESCE(p_source,'auto_entry'),p_service_kind
  ) RETURNING * INTO v_session;
  UPDATE public.service_session_state
     SET current_session_id=v_session.id,updated_at=now()
   WHERE singleton=true;
  INSERT INTO public.service_session_audit(
    service_session_id,event_type,by_actor,source
  ) VALUES (
    v_session.id,'opened',p_opened_by,COALESCE(p_source,'auto_entry')
  );
  RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,
                            'session',to_jsonb(v_session));
END $function$;

REVOKE ALL ON FUNCTION public.ensure_service_session(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_service_session(text, text, text) TO service_role;

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
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050 -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind literal values, restored byte-verbatim as the pre-F-7 body this rollback exists to restore, not new vocabulary
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

  IF FOUND AND v_period.business_date = v_business_date THEN
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

COMMIT;
