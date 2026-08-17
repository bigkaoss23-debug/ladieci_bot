-- migrations/2026-08-17_f2_v3_next_service_on_conflict_repair.ROLLBACK.sql
-- Paired rollback for 2026-08-17_f2_v3_next_service_on_conflict_repair.sql.
--
-- Restores the exact byte-captured pre-F-2 (broken, 42P10-raising) arbiter
-- clause. Touches no data -- a pure function redefinition, no append-only
-- evidence to protect (the function's only live caller chain,
-- serviceLifecycleEngine.js, has zero live callers of its own, so no real
-- row could ever have been created through the repaired path since F-2
-- shipped -- confirmed via the same population-count assertions used in the
-- forward migration's own post-condition, restated here defensively).
BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_next_service_session_v3';
  IF v_def IS NULL OR position('WHERE service_kind IS NOT NULL AND status = ANY (ARRAY[''open'',''closing''])' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-2 rollback refused: ensure_next_service_session_v3 does not show the post-F-2 shape -- not applied, or already drifted past F-2';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_next_service_session_v3(p_source_session_id uuid, p_service_kind text, p_business_date date, p_opened_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_existing public.service_sessions%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
BEGIN
  IF p_source_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SERVICE_KIND');
  END IF;
  IF p_business_date IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_BUSINESS_DATE');
  END IF;
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  SELECT * INTO v_existing FROM public.service_sessions
   WHERE rollover_source_session_id = p_source_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_existing));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_existing FROM public.service_sessions
   WHERE rollover_source_session_id = p_source_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_existing));
  END IF;

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  IF v_state.recent_closed_session_id IS DISTINCT FROM p_source_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_ALREADY_SET');
  END IF;

  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 0 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  INSERT INTO public.service_sessions(
    business_date, status, opened_by, open_source, service_kind, rollover_source_session_id
  ) VALUES (
    p_business_date, 'open', p_opened_by, p_source, p_service_kind, p_source_session_id
  )
  ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_session;

  IF FOUND THEN
    UPDATE public.service_session_state
       SET current_session_id = v_session.id, updated_at = now()
     WHERE singleton = true;
    INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
    VALUES (v_session.id, 'opened', p_opened_by, p_source);
    RETURN jsonb_build_object('ok',true,'code','ROLLED_OVER','created',true,'session',to_jsonb(v_session));
  END IF;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE business_date = p_business_date AND service_kind = p_service_kind;
  IF v_session.rollover_source_session_id IS DISTINCT FROM p_source_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','NEXT_SERVICE_IDENTITY_CONFLICT','session',to_jsonb(v_session));
  END IF;
  RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_session));
END;
$function$;

-- Post-condition.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_next_service_session_v3';
  IF position('WHERE service_kind IS NOT NULL AND status = ANY (ARRAY[''open'',''closing''])' IN v_def) > 0 THEN
    RAISE EXCEPTION 'F-2 rollback post-condition failed: repaired arbiter clause still present';
  END IF;
END $$;

COMMIT;
