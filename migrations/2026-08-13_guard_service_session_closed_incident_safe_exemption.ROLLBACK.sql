-- ROLLBACK for 2026-08-13_guard_service_session_closed_incident_safe_exemption.sql
-- Restores complete_service_session_close and guard_service_session_closed_v1
-- to their exact pre-migration bodies. Refuses if the new marker/parameter is
-- no longer referenced by either function (already rolled back or drifted).

DO $$
DECLARE v_body1 text; v_body2 text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_body1 FROM pg_proc
   WHERE proname = 'complete_service_session_close' AND pronargs = 4;
  SELECT pg_get_functiondef(oid) INTO v_body2 FROM pg_proc WHERE proname = 'guard_service_session_closed_v1';
  IF v_body1 IS NULL OR v_body1 NOT LIKE '%p_preserve_active_orders%' THEN
    RAISE EXCEPTION 'rollback refused: complete_service_session_close(4 args) not found or no longer references p_preserve_active_orders — already rolled back or drifted, resolve drift first';
  END IF;
  IF v_body2 NOT LIKE '%incident_safe_close_session_id%' THEN
    RAISE EXCEPTION 'rollback refused: guard_service_session_closed_v1 no longer references incident_safe_close_session_id — already rolled back or drifted, resolve drift first';
  END IF;
END $$;

-- The forward migration widened this function's signature (3 args -> 4),
-- which is a distinct overload to Postgres regardless of defaults. Drop the
-- 4-arg overload explicitly before recreating the original 3-arg one, or
-- CREATE OR REPLACE would leave both live simultaneously (the exact mistake
-- the forward migration's own header documents making and then fixing).
DROP FUNCTION IF EXISTS public.complete_service_session_close(uuid, text, text, boolean);

CREATE FUNCTION public.complete_service_session_close(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend'::text)
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
  UPDATE public.service_sessions SET status='closed',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closed',p_closed_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','CLOSED','session',to_jsonb(v_session));
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    IF NOT (
      current_setting('ladieci.v3_close_authorized_session_id', true) = OLD.id::text
      AND EXISTS (
        SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
      )
    ) THEN
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
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            'RETIRADO', 'COMPLETADO', 'COMPLETATO', -- language-guard: allow-legacy COMPLETATO/CHIUSO_FORZATO here and below are the pre-existing terminal-estado literals this guard's original body already enumerated, not new vocabulary
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
