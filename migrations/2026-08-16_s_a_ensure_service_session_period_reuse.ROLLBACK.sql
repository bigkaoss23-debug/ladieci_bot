-- migrations/2026-08-16_s_a_ensure_service_session_period_reuse.ROLLBACK.sql
-- Restores ensure_service_session() to the exact byte-captured pre-S-A body
-- (business_date/service_kind mismatch checks reinstated verbatim). No data
-- is touched -- neither this migration nor its predecessor writes anything
-- in the reuse branch; this is a pure CREATE OR REPLACE FUNCTION revert.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
       AND p.prosrc NOT LIKE '%STALE_SERVICE_SESSION%'
  ) THEN RAISE EXCEPTION 'S-A rollback refused: ensure_service_session does not match the expected post-S-A shape -- already rolled back or drifted, resolve first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_service_session(p_opened_by text, p_service_kind text, p_source text DEFAULT 'auto_entry'::text)
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
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN
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
    IF v_session.business_date IS DISTINCT FROM v_business_date THEN
      RETURN jsonb_build_object('ok',false,'code','STALE_SERVICE_SESSION',
                                'expectedBusinessDate',v_business_date,
                                'session',to_jsonb(v_session));
    END IF;
    IF v_session.service_kind IS DISTINCT FROM p_service_kind THEN
      RETURN jsonb_build_object(
        'ok',false,
        'code',CASE WHEN v_session.service_kind='PRANZO'
                    THEN 'LUNCH_SESSION_STILL_ACTIVE'
                    ELSE 'OTHER_SERVICE_STILL_ACTIVE' END,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
       AND p.prosrc LIKE '%STALE_SERVICE_SESSION%'
       AND p.prosrc LIKE '%LUNCH_SESSION_STILL_ACTIVE%'
  ) THEN RAISE EXCEPTION 'S-A rollback post-condition failed: pre-S-A mismatch branches not restored'; END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-A rollback post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
END $$;

COMMIT;
