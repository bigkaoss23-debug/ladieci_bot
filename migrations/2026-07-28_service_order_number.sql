BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260710075612'
  ) THEN
    RAISE EXCEPTION 'service order numbering refused: staging sentinel absent';
  END IF;
  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_state') IS NULL THEN
    RAISE EXCEPTION 'service order numbering refused: session identity missing';
  END IF;
END $$;

ALTER TABLE public.service_sessions
  ADD COLUMN next_order_number integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT service_sessions_next_order_number_chk
    CHECK (next_order_number > 0);

ALTER TABLE public.ordenes
  ADD COLUMN service_order_number integer,
  ADD CONSTRAINT ordenes_service_order_number_chk
    CHECK (service_order_number IS NULL OR service_order_number > 0);

CREATE UNIQUE INDEX ordenes_service_order_number_uq
  ON public.ordenes(service_session_id, service_order_number)
  WHERE service_session_id IS NOT NULL AND service_order_number IS NOT NULL;

CREATE OR REPLACE FUNCTION public.service_session_assign_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_madrid timestamp;
  v_business_date date;
BEGIN
  SELECT * INTO v_state
    FROM public.service_session_state
   WHERE singleton = true
   FOR UPDATE;
  IF NOT FOUND OR v_state.current_session_id IS NULL THEN
    RAISE EXCEPTION 'NO_OPEN_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_session
    FROM public.service_sessions
   WHERE id = v_state.current_session_id
   FOR UPDATE;
  IF NOT FOUND OR v_session.status <> 'open' THEN
    RAISE EXCEPTION 'INVALID_OPEN_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;

  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_business_date := CASE
    WHEN v_madrid::time < TIME '04:00' THEN v_madrid::date - 1
    ELSE v_madrid::date
  END;
  IF v_session.business_date <> v_business_date THEN
    RAISE EXCEPTION 'STALE_SERVICE_SESSION' USING
      ERRCODE='P0001',
      DETAIL=format('active=%s expected=%s', v_session.business_date, v_business_date);
  END IF;

  IF NEW.service_session_id IS NOT NULL
     AND NEW.service_session_id <> v_session.id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_FORGERY' USING ERRCODE='P0001';
  END IF;
  IF NEW.service_order_number IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_ORDER_NUMBER_FORGERY' USING ERRCODE='P0001';
  END IF;

  NEW.service_session_id := v_session.id;
  NEW.service_order_number := v_session.next_order_number;
  UPDATE public.service_sessions
     SET next_order_number = next_order_number + 1,
         updated_at = now()
   WHERE id = v_session.id;
  RETURN NEW;
END $$;

-- Recreate explicitly instead of relying on a trigger left behind by the
-- identity migration. This keeps a replay/self-contained apply safe even when
-- the function exists but the trigger was removed or renamed out of band.
DROP TRIGGER IF EXISTS ordenes_assign_service_session ON public.ordenes;
CREATE TRIGGER ordenes_assign_service_session
BEFORE INSERT ON public.ordenes
FOR EACH ROW EXECUTE FUNCTION public.service_session_assign_order();

CREATE OR REPLACE FUNCTION public.service_session_immutable_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.service_session_id IS DISTINCT FROM OLD.service_session_id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  IF NEW.service_order_number IS DISTINCT FROM OLD.service_order_number THEN
    RAISE EXCEPTION 'SERVICE_ORDER_NUMBER_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ordenes_service_session_immutable ON public.ordenes;
CREATE TRIGGER ordenes_service_session_immutable
BEFORE UPDATE ON public.ordenes
FOR EACH ROW EXECUTE FUNCTION public.service_session_immutable_order();

CREATE OR REPLACE FUNCTION public.ensure_service_session(
  p_opened_by text,
  p_service_kind text,
  p_source text DEFAULT 'auto_entry'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
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
                AND service_kind=p_service_kind) THEN
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

REVOKE ALL ON FUNCTION public.service_session_assign_order(),
  public.service_session_immutable_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_service_session(text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_service_session(text,text,text)
  TO service_role;

-- Existing orders deliberately remain unnumbered; service membership cannot be
-- reconstructed safely from order ids or timestamps.
COMMIT;
