-- HARNESS FIXTURE (test only). public.ensure_service_session(text,text) exists on staging (owner postgres, SECURITY INVOKER, search_path public, pg_temp, ACL postgres+service_role)
-- but is not part of the local migration chain. Its LOCK behaviour is what matters to the Finding A study: L -> service_session_state FOR UPDATE -> service_sessions(current) FOR UPDATE,
-- it reads and returns only. Captured with read-only SELECTs on staging (SL-FA2, 2026-09-24); the business-date staleness branches of the staging text (reads only, no lock,
-- via get_order_intake_context_v1) are omitted. Installed by runPaymentCloseFix.js into the PRE template, so PRE / BASE / POST all carry the same fixture.
CREATE OR REPLACE FUNCTION public.ensure_service_session(p_opened_by text, p_source text)
 RETURNS jsonb LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
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
  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE', 'businessDayId', v_bd_state.current_business_day_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.ensure_service_session(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_service_session(text,text) TO service_role;
