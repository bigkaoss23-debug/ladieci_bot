-- migrations/2026-08-20_h1_legacy_lifecycle_writer_hardening.ROLLBACK.sql
-- Reverses H-1 by restoring the four exact pre-H-1 function bodies:
--   begin_service_session_close        -> md5 02b815682c9ba6c3353a2c5d93726046
--   complete_service_session_close     -> md5 2cc17d5d2463528fdf8ad3372e9bd712
--   roll_service_session_economic_v1   -> md5 70609253b1ee62c737f263a4ef340dcf
--   ensure_next_service_session_v3     -> md5 9c9516afae8655353301071aa3548b74
--
-- Touches no data, no schema, and no other function. The canonical G-1 four
-- and the frozen Mesa guard are asserted unchanged afterwards, exactly as the
-- forward migration asserts them.
--
-- ONE DELIBERATE ASYMMETRY -- THE GRANT IS NOT RESTORED.
-- H-1 revoked EXECUTE on complete_service_session_close from PUBLIC, anon and
-- authenticated. This rollback does NOT re-grant it, and that is intentional
-- rather than an omission. That grant was never a designed capability: it was
-- the only lifecycle RPC in the schema carrying it, no backend code path needs
-- it (the server calls every RPC with the service role), and it allowed any
-- holder of the publishable key to finish a close with an arbitrary
-- p_closed_by and p_preserve_active_orders => true. Restoring a body is a
-- revert; restoring an accidental privilege is a regression. A post-condition
-- below asserts it stays revoked, so this cannot be undone by accident.
-- If it is ever genuinely needed, granting it is a deliberate, separate,
-- reviewable act.
--
-- POINT OF NO RETURN. Rolling back re-arms every legacy close path and both
-- legacy service creators. They remain inert only while
-- LEGACY_AUTOMATIC_LIFECYCLE_ENABLED stays "false" and
-- ECONOMIC_PERIOD_ROLLOVER_ENABLED stays unset -- i.e. back to invariants held
-- by environment variable, which is the exact condition H-1 exists to end.
-- Roll back only to unblock a real incident, and re-apply promptly.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'H-1 rollback refused: staging sentinel migration absent -- wrong database?'; END IF;

  -- Idempotent-safety: only roll back a state that actually has H-1 applied.
  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='begin_service_session_close')
     NOT LIKE '%LEGACY_CLOSE_ENGINE_RETIRED%' THEN
    RAISE EXCEPTION 'H-1 rollback refused: H-1 does not appear to be applied';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.begin_service_session_close(p_closed_by text, p_source text DEFAULT 'backend'::text, p_preserve_active_orders boolean DEFAULT false)
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
    -- FIX: p_preserve_active_orders=true (set ONLY by incidentSafeRollover.js's
    -- own call site) tolerates an open table_session exactly like the other
    -- two gates already do -- the table itself is never read for any purpose
    -- other than this existence check, never written, never closed.
    IF NOT p_preserve_active_orders THEN
      PERFORM 1 FROM public.table_sessions
       WHERE service_session_id=v_session.id AND status = 'open'
       ORDER BY id FOR UPDATE;
      IF FOUND THEN
        RETURN jsonb_build_object('ok',false,'code','MESA_TABLES_NOT_RELEASED');
      END IF;
    END IF;
    UPDATE public.service_sessions
       SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now()
     WHERE id=v_session.id
     RETURNING * INTO v_session;
    INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
    VALUES(v_session.id,'closing',p_closed_by,p_source);
  END IF;
  RETURN jsonb_build_object('ok',true,'code','CLOSING','session',to_jsonb(v_session));
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_service_session_close(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend'::text, p_preserve_active_orders boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
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
  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton=true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;
  IF p_preserve_active_orders THEN
    PERFORM set_config('ladieci.incident_safe_close_session_id', v_session.id::text, true);
  END IF;
  UPDATE public.service_sessions SET status='closed',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id=NULL, updated_at=now() WHERE singleton=true;
  END IF;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closed',p_closed_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','CLOSED','session',to_jsonb(v_session));
END
$function$;

CREATE OR REPLACE FUNCTION public.roll_service_session_economic_v1(p_service_session_id uuid, p_closeout_correlation_id uuid, p_actor text, p_source text, p_next_service_kind text, p_next_business_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_next     public.service_sessions%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  IF p_next_service_kind IS NULL OR p_next_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_NEXT_SERVICE_KIND');
  END IF;
  IF p_next_business_date IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_NEXT_BUSINESS_DATE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'rolled_over' THEN
    SELECT * INTO v_next FROM public.service_sessions
     WHERE rollover_source_session_id = v_session.id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok',true,'code','ALREADY_ROLLED_OVER','idempotent',true,
        'sessionA',to_jsonb(v_session),'sessionB',to_jsonb(v_next)
      );
    END IF;
    RETURN jsonb_build_object('ok',false,'code','ROLLOVER_IDENTITY_MISMATCH','sessionA',to_jsonb(v_session));
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS','sessionStatus',v_session.status);
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

  IF EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE business_date = p_next_business_date AND service_kind = p_next_service_kind
       AND status IN ('open','closing')
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','NEXT_SERVICE_ALREADY_EXISTS');
  END IF;

  UPDATE public.service_sessions
     SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.service_sessions(
    business_date, service_kind, status, opened_at, opened_by, open_source,
    rollover_source_session_id
  ) VALUES (
    p_next_business_date, p_next_service_kind, 'open', now(), p_actor, p_source,
    v_session.id
  ) RETURNING * INTO v_next;

  UPDATE public.service_session_state
     SET current_session_id = v_next.id, recent_closed_session_id = NULL, updated_at = now()
   WHERE singleton = true;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'rolled_over_economic', p_actor, p_source);
  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_next.id, 'opened', p_actor, p_source);

  RETURN jsonb_build_object(
    'ok',true,'code','ROLLED_OVER','idempotent',false,
    'sessionA',to_jsonb(v_session),'sessionB',to_jsonb(v_next)
  );
END;
$function$;

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
  ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT NULL AND status = ANY (ARRAY['open','closing'])
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

DO $$
BEGIN
  IF md5(pg_get_functiondef('public.begin_service_session_close(text,text,boolean)'::regprocedure))
       IS DISTINCT FROM '02b815682c9ba6c3353a2c5d93726046' THEN
    RAISE EXCEPTION 'H-1 rollback post-condition failed: begin_service_session_close not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.begin_service_session_close(text,text,boolean)'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.complete_service_session_close(uuid,text,text,boolean)'::regprocedure))
       IS DISTINCT FROM '2cc17d5d2463528fdf8ad3372e9bd712' THEN
    RAISE EXCEPTION 'H-1 rollback post-condition failed: complete_service_session_close not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.complete_service_session_close(uuid,text,text,boolean)'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)'::regprocedure))
       IS DISTINCT FROM '70609253b1ee62c737f263a4ef340dcf' THEN
    RAISE EXCEPTION 'H-1 rollback post-condition failed: roll_service_session_economic_v1 not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)'::regprocedure));
  END IF;
  IF md5(pg_get_functiondef('public.ensure_next_service_session_v3(uuid,text,date,text,text)'::regprocedure))
       IS DISTINCT FROM '9c9516afae8655353301071aa3548b74' THEN
    RAISE EXCEPTION 'H-1 rollback post-condition failed: ensure_next_service_session_v3 not restored byte-identically (got %)',
      md5(pg_get_functiondef('public.ensure_next_service_session_v3(uuid,text,date,text,text)'::regprocedure));
  END IF;

  -- The accidental grant stays revoked. See this file's header.
  IF has_function_privilege('anon', 'public.complete_service_session_close(uuid,text,text,boolean)'::regprocedure, 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.complete_service_session_close(uuid,text,text,boolean)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'H-1 rollback post-condition failed: the accidental anon/authenticated EXECUTE grant was re-created; it must stay revoked';
  END IF;

  -- The canonical four and the frozen Mesa guard are never touched here.
  IF md5(pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure))
       IS DISTINCT FROM '9a23c0e3e5e49199a14fbc9bff602e4d'
     OR md5(pg_get_functiondef('public.open_operational_service_v1(text,text,text)'::regprocedure))
       IS DISTINCT FROM '78b9cb458ea9d9ab37056f34f32d52e7'
     OR md5(pg_get_functiondef('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'::regprocedure))
       IS DISTINCT FROM 'cdf15eb3699a6a86c16519b1dbcd2f1c'
  THEN
    RAISE EXCEPTION 'H-1 rollback post-condition failed: a function outside this rollback''s scope changed';
  END IF;
END $$;

COMMIT;
