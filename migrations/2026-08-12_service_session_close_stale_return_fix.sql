-- SERVICE LIFECYCLE RUNTIME AUTHORITY RECOVERY — begin_service_session_close
-- stale-return fix.
--
-- ROOT CAUSE (proven live on staging, 2026-08-12, against the real stuck
-- language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to identify the real stuck session this fix was proven against, not new vocabulary
-- 2026-08-11 PRANZO session 421f93e1-ecd5-4da7-b82b-b89d75ecd3a7): this
-- function SELECTs the current session row into v_session, then (on the
-- normal open->closing path) UPDATEs that row's status/closed_by/close_
-- source/updated_at columns in the database -- but the final `RETURN
-- jsonb_build_object(..., 'session', to_jsonb(v_session))` still serializes
-- the PRE-update in-memory snapshot, because v_session itself is never
-- reassigned after the UPDATE. Every caller therefore sees session.status
-- still "open" in the RETURNED payload, even though the row is genuinely
-- "closing" in the database.
--
-- language-guard: allow-legacy chiudiServizio/servizio.js are the existing close-engine identifiers, named here only for audit context (this migration does not call or modify either), not new vocabulary
-- src/utils/servizio.js's chiudiServizio (the ONE close engine every
-- automatic and manual close path shares) treats that stale "open" as a
-- hard identity-mismatch failure immediately after this call
-- (`serviceSession.status !== "closing"`) and aborts the ENTIRE close --
-- backup, archive, summary, and the actual finalization to "closed" never
-- run. The session is left stuck in "closing" forever (closed_at/
-- rolled_over_at both null), and orderIntakePolicy's gate keeps rejecting
-- every new order with STALE_SERVICE_SESSION, because the global current
-- session never advances.
--
-- This is a correctness bug in this function alone, not a design decision:
-- every field it sets in the UPDATE, the RETURN is meant to describe.
--
-- FIX: capture the row this function itself just wrote, via `RETURNING *
-- INTO v_session`, instead of relying on the pre-UPDATE snapshot. No other
-- line changes; no other return code, guard, or side effect is touched.
--
-- Same signature, same guards (MULTIPLE_ACTIVE_SERVICE_SESSIONS /
-- NO_SERVICE_SESSION / INVALID_RECENT_CLOSED_SESSION / ALREADY_CLOSED /
-- INVALID_CURRENT_SERVICE_SESSION / MESA_TABLES_NOT_RELEASED), same
-- advisory lock, same audit-row insert. Idempotent (CREATE OR REPLACE).

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
    -- FIX: RETURNING * INTO v_session replaces the stale pre-update snapshot
    -- with the row this statement itself just wrote, so the final RETURN
    -- below accurately reports status='closing' (and the fresh closed_by/
    -- close_source/updated_at) instead of the row's state from before this
    -- call started.
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
