-- migrations/2026-08-17_f1_canonical_pointer_clear_on_close.ROLLBACK.sql
-- Paired rollback for 2026-08-17_f1_canonical_pointer_clear_on_close.sql.
--
-- Restores the exact byte-captured pre-F-1 bodies of both close functions.
-- Touches no data -- both are pure function redefinitions; there is no
-- append-only evidence created by this migration to protect (the pointer
-- clear itself leaves no row-level trace, only a state transition already
-- fully described by service_sessions.status/closed_at and service_session_
-- audit, neither of which this migration alters the writing of).
BEGIN;

DO $$
DECLARE
  v_def_legacy text;
  v_def_v3 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def_legacy
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_service_session_close';
  IF v_def_legacy IS NULL OR position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_legacy) = 0 THEN
    RAISE EXCEPTION 'F-1 rollback refused: complete_service_session_close does not show the post-F-1 shape -- not applied, or already drifted past F-1';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def_v3
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='close_service_session_v3';
  IF v_def_v3 IS NULL OR position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_v3) = 0 THEN
    RAISE EXCEPTION 'F-1 rollback refused: close_service_session_v3 does not show the post-F-1 shape -- not applied, or already drifted past F-1';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.complete_service_session_close(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend'::text, p_preserve_active_orders boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  SELECT * INTO v_session FROM public.service_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','SESSION_NOT_FOUND'); END IF;
  IF v_session.status='closed' AND v_state.recent_closed_session_id=v_session.id AND v_state.current_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  IF v_state.current_session_id IS DISTINCT FROM v_session.id OR v_session.status <> 'closing' THEN
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;
  IF p_preserve_active_orders THEN
    PERFORM set_config('ladieci.incident_safe_close_session_id', v_session.id::text, true);
  END IF;
  UPDATE public.service_sessions SET status='closed',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closed',p_closed_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','CLOSED','session',to_jsonb(v_session));
END
$function$;

CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
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

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'closed' THEN
    IF v_state.recent_closed_session_id = v_session.id AND v_state.current_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS');
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE service_session_id = p_service_session_id
       AND closeout_correlation_id = p_closeout_correlation_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_NOT_FOUND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
       AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  -- SLICE 3.2.1 — the trusted-transition marker. Transaction-local
  -- (is_local=true): reverted automatically at commit or rollback, never
  -- visible to any other transaction/request.
  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

-- Post-conditions.
DO $$
DECLARE
  v_def_legacy text;
  v_def_v3 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def_legacy
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_service_session_close';
  IF position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_legacy) > 0 THEN
    RAISE EXCEPTION 'F-1 rollback post-condition failed: complete_service_session_close still shows the post-F-1 shape';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def_v3
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='close_service_session_v3';
  IF position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_v3) > 0 THEN
    RAISE EXCEPTION 'F-1 rollback post-condition failed: close_service_session_v3 still shows the post-F-1 shape';
  END IF;
END $$;

COMMIT;
