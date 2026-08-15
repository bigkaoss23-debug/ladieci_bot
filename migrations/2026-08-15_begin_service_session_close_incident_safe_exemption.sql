-- STALE_SERVICE_SESSION_SELF_HEAL — begin_service_session_close incident-safe
-- exemption (third and, per this investigation's live proof, final gate in
-- this chain).
--
-- ROOT CAUSE (proven live on staging, 2026-08-15, against the real stuck
-- 2026-08-13 SERA session c9d5aaa7-d0d5-4740-a6ee-83a8ee57adda): three
-- INDEPENDENT places check "are there open Mesa tables blocking this
-- close", and only two of them had ever been given the incident-safe
-- exemption this codebase's own established contract already grants an
-- occupied table crossing a service boundary:
-- language-guard: allow-legacy chiudiServizio/servizio.js are the existing close-engine function/module names this line references, not new vocabulary
--   1. chiudiServizio's own JS-level Mesa gate (src/utils/servizio.js) --
--      bypassed via closeContext.allowOpenTablesAcrossBoundary (Slice 4C.1).
--   2. guard_service_session_closed_v1, the trigger on the closing->closed
--      transition -- bypassed via the ladieci.incident_safe_close_session_id
--      marker (2026-08-13_guard_service_session_closed_incident_safe_
--      exemption.sql, row 68).
--   3. THIS function, begin_service_session_close, on the EARLIER open->
--      closing transition -- had NO exemption at all. Proven live: after
--      this session's own separate allowActiveRiderTripAcrossBoundary fix
--      (backend commit 183ed7d) correctly got a real incident-safe rollover
--      attempt past the rider-trip gate, the very next step failed here
--      instead, with the identical MESA_TABLES_NOT_RELEASED code gate #1
--      already tolerates -- proving gate #3 was the one nobody had connected
--      to the other two yet.
--
-- FIX (purely additive, same established pattern as row 68's
-- complete_service_session_close, not a new semantic): begin_service_
-- session_close gains a new DEFAULT-false parameter, p_preserve_active_
-- orders -- same name, same meaning, same default as complete_service_
-- session_close already has. When true, the MESA_TABLES_NOT_RELEASED check
-- is skipped (open table_sessions are tolerated, exactly as they already
-- are at gates #1 and #2 under the same flag name) -- nothing else about
-- this function changes: every other guard (MULTIPLE_ACTIVE_SERVICE_
-- SESSIONS, NO_SERVICE_SESSION, INVALID_RECENT_CLOSED_SESSION,
-- INVALID_CURRENT_SERVICE_SESSION) is untouched, and no table_session row
-- is read, written, closed, or reassigned by this function either before or
-- after this change -- an open table simply no longer blocks the
-- transition, exactly like gates #1 and #2.
--
-- Scope discipline (matching rows 67/68 exactly):
--   - Only incidentSafeRollover.js's own call site will ever set
-- language-guard: allow-legacy chiudiServizio is the existing close-engine function name this line references twice, not new vocabulary
--     preserveActiveOrders=true on chiudiServizio, and chiudiServizio is the
--     ONLY caller of serviceSessionLifecycle.beginClose -- so only that one
--     automatic, incident-backed path can ever cause this new parameter to
--     be true. The manual, human-initiated HTTP close action and the frozen
-- language-guard: allow-legacy servizio.js is the existing close-engine module name this line references, not new vocabulary
--     legacy automatic path never set it (see servizio.js/
--     serviceSessionLifecycle.js in this same commit) -- both keep exactly
--     today's strict behavior, unconditionally refusing to begin a close
--     over any open table.
--   - No table_session's service_session_id, status, or any other column is
--     ever touched by this function -- an open table crossing the boundary
--     stays open, unchanged, exactly where it already was. This migration
--     does not "release", "close", or "reassign" tables; it only stops
--     their mere existence from blocking the SERVICE's own state
--     transition, identically to gates #1 and #2's already-accepted
--     contract.
--   - begin_service_session_close and complete_service_session_close now
--     express the identical preservation policy (same parameter name, same
--     default, same meaning) across both halves of the close transition --
--     no contradictory gate remains between them.
--
-- Signature widens 2 args -> 3. Postgres identifies overloads by ALL
-- parameter types regardless of defaults (the exact pitfall row 68's own
-- header documents being caught and fixed on its first apply attempt) -- so
-- the old 2-arg signature is DROPped explicitly first, matching row 68's
-- own established discipline for a widened signature. serviceSessionLifecycle.js
-- is the ONLY real caller (confirmed by repo-wide grep, this same commit)
-- and always sends the parameter by name, so the drop is safe.
--
-- A predecessor-body guard runs before the CREATE OR REPLACE, refusing to
-- apply over a drifted or already-patched function -- same discipline as
-- row 68 (which itself guards against re-patching row 67's fix).
--
-- Staging-only. No table/column added/dropped, no data touched. Paired
-- .ROLLBACK.sql drops the 3-arg overload and restores the original 2-arg
-- begin_service_session_close (row 67's exact post-stale-return-fix body),
-- verbatim.

DO $$
DECLARE v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'begin_service_session_close'
    AND pg_get_function_identity_arguments(p.oid) = 'p_closed_by text, p_source text';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'begin_service_session_close incident-safe exemption refused: expected 2-arg begin_service_session_close(text, text) not found -- resolve drift first';
  END IF;
  IF v_body NOT LIKE '%MESA_TABLES_NOT_RELEASED%' THEN
    RAISE EXCEPTION 'begin_service_session_close incident-safe exemption refused: live body does not match the expected row-67 post-stale-return-fix shape (MESA_TABLES_NOT_RELEASED check not found) -- resolve drift first';
  END IF;
  IF v_body LIKE '%p_preserve_active_orders%' THEN
    RAISE EXCEPTION 'begin_service_session_close incident-safe exemption refused: live body already mentions p_preserve_active_orders -- already patched, resolve drift first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.begin_service_session_close(text, text);

CREATE FUNCTION public.begin_service_session_close(
  p_closed_by text,
  p_source text DEFAULT 'backend'::text,
  p_preserve_active_orders boolean DEFAULT false
)
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
    -- own call site) tolerates an open table_session exactly like gates #1
    -- and #2 already do -- the table itself is never read for any purpose
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

REVOKE ALL ON FUNCTION public.begin_service_session_close(text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_service_session_close(text, text, boolean) TO service_role;
