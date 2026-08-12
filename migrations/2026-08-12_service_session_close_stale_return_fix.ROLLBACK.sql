-- ROLLBACK for 2026-08-12_service_session_close_stale_return_fix.sql
--
-- Restores begin_service_session_close to the pre-fix definition (v_session
-- never reassigned after the UPDATE, so the RETURNed session.status is the
-- stale pre-update value). Only use this if the RETURNING-clause fix itself
-- is somehow implicated in a NEW problem -- reverting reintroduces the
-- original, proven, live-reproduced bug (every close attempt on a
-- currently-'open' session gets misread as an identity mismatch and aborts,
-- leaving the session stuck in 'closing' forever).

CREATE OR REPLACE FUNCTION public.begin_service_session_close(p_closed_by text, p_source text DEFAULT 'backend'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;
  IF v_state.current_session_id IS NULL THEN
    IF v_state.recent_closed_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','NO_SERVICE_SESSION');
    END IF;
    SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.recent_closed_session_id;
    IF NOT FOUND OR v_session.status <> 'closed' THEN
      RETURN jsonb_build_object('ok',false,'code','INVALID_RECENT_CLOSED_SESSION');
    END IF;
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  SELECT * INTO v_session FROM public.service_sessions
   WHERE id=v_state.current_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CURRENT_SERVICE_SESSION');
  END IF;
  IF v_session.status='open' THEN
    PERFORM 1 FROM public.table_sessions
     WHERE service_session_id=v_session.id AND status = 'open'
     ORDER BY id FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','MESA_TABLES_NOT_RELEASED');
    END IF;
    UPDATE public.service_sessions
       SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now()
     WHERE id=v_session.id;
    INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
    VALUES(v_session.id,'closing',p_closed_by,p_source);
  END IF;
  RETURN jsonb_build_object('ok',true,'code','CLOSING','session',to_jsonb(v_session));
END
$function$;
