-- migrations/2026-08-09_service_closeout_cross_service_table_policy.ROLLBACK.sql
-- Reverts begin_service_session_close/guard_service_session_closed_v1/
-- supersede_closeout_attempt to their pre-4C.2C bodies (exactly as created by
-- 2026-07-26_two_service_identity.sql and 2026-08-08_service_closeout_
-- attempt_ownership.sql respectively) and drops the new trusted-system RPC.
-- Does NOT touch any row this migration's functions may have already
-- affected (e.g. an attempt already superseded, a table already released) —
-- those are real facts, not schema, and rolling back the function bodies
-- does not and must not un-happen them.
BEGIN;

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

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    IF EXISTS (
      SELECT 1
      FROM public.table_sessions t
      WHERE t.service_session_id = OLD.id
        AND t.status = 'open'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MESA_TABLES_NOT_RELEASED';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            -- language-guard: allow-legacy COMPLETATO is the existing terminal-state literal from guard_service_session_closed_v1's pre-4C.2C body (2026-08-02_service_close_live_work_guard.sql), restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated verbatim for the same reason
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.supersede_closeout_attempt(
  p_closeout_correlation_id uuid,
  p_actor                   text,
  p_reason                  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_row public.service_closeout_attempts%ROWTYPE;
BEGIN
  IF p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object('ok',false,'code','CANNOT_SUPERSEDE_COMPLETED_ATTEMPT');
  END IF;
  IF v_row.status = 'superseded' THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_SUPERSEDED','idempotent',true,'attempt',to_jsonb(v_row));
  END IF;

  UPDATE public.service_closeout_attempts
     SET status = 'superseded', superseded_at = now(), supersession_reason = p_reason, updated_at = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
  RETURNING * INTO v_row;

  UPDATE public.service_incidents
     SET resolution_status = 'superseded',
         resolution_type   = 'closeout_attempt_superseded',
         resolved_by       = p_actor,
         resolved_at       = now(),
         updated_at        = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
     AND resolution_status IN ('pending','acknowledged');

  RETURN jsonb_build_object('ok',true,'code','SUPERSEDED','idempotent',false,'attempt',to_jsonb(v_row));
END;
$fn$;

REVOKE ALL ON FUNCTION public.mesa_release_empty_session_auto_v1(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS public.mesa_release_empty_session_auto_v1(uuid,uuid);

COMMIT;
