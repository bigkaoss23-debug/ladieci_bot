-- migrations/2026-08-16_s_a_ensure_service_session_period_reuse.sql
-- S-A — Operational Service repair, slice A ONLY: remove the live UI-facing
-- gate that still treats PRANZO/SERA as separate Operational Service
-- identities.
--
-- Authority: owner-frozen product contract (this session, immediately after
-- the R-DAY4 architecture challenge/decision report): an Operational Service
-- spans Lunch -> quiet interval -> Dinner and ends ONLY via an explicit
-- Finalizar servicio. A clock/economic-period boundary must never close it,
-- roll it over, create a second one, or block the UI/order intake.
--
-- SCOPE: this migration touches ONLY the "already have a current session"
-- reuse branch of ensure_service_session(). It does NOT touch:
--   - resolve_order_intake_context_v1 (R-DAY3, untouched, unchanged);
--   - consolidate_period_v1/period_consolidations (R-DAY4, untouched);
--   - service_sessions.service_kind/rolled_over semantics (untouched);
--   - the bootstrap/create branch of this same function (untouched --
--     "no current session exists at all" is a genuinely different case from
--     "a current session exists but its kind/date no longer matches the
--     clock", and only the latter is a lifecycle-identity conflation);
--   - any aggregate/reporting reader.
--
-- LIVE CALLER AUDIT (verified this session, before writing this fix):
--   - src/serviceSessions/ensureServiceSession.js's ensureCurrentServiceSession
--     (the ONLY two real callers of this RPC: the frontend's silent per-page
--     Servicio entry, and the "openServiceSession" manual-recovery action)
--     calls currentCloseout() FIRST and, with LEGACY_AUTOMATIC_LIFECYCLE_
--     ENABLED=false (verified live on staging today), already unconditionally
--     reuses any open session without ever reaching this RPC's mismatch
--     branches -- this RPC is reached only when NO session is currently open/
--     closing at all, or in a narrow race window against a concurrent R-DAY3
--     pointer advance. This fix is still correct and necessary: it removes
--     the conflation at its source, closes that race window, and prevents a
--     regression the moment LEGACY_AUTOMATIC_LIFECYCLE_ENABLED is ever
--     unfrozen.
--   - src/serviceSessions/incidentSafeRollover.js's own call (post-close,
--     "establish the next session") only branches on `ok === true` generically
--     and treats ANY failure as non-fatal/best-effort ("a later entry point
--     will retry") -- it does not inspect or depend on the three specific
--     codes being removed. Verified live this session: no non-UI caller
--     relies on LUNCH_SESSION_STILL_ACTIVE/OTHER_SERVICE_STILL_ACTIVE/
--     STALE_SERVICE_SESSION for any safety-critical branch.
--
-- FIX: in the "v_state.current_session_id IS NOT NULL" branch, after the
-- SERVICE_SESSION_CLOSING check (kept -- a genuine in-progress-close
-- concurrency concern, unrelated to PRANZO/SERA), the business_date and
-- service_kind mismatch checks are REMOVED (not merely made unreachable):
-- any already-open, non-closing current session is now unconditionally
-- reused. No write happens in this branch in either the old or new body --
-- only the RETURN value changes from a typed rejection to REUSED/success.
--
-- KEPT, unchanged (true integrity/fail-closed conditions, per instruction):
--   - INVALID_SERVICE_KIND / INVALID_ACTOR (input validation);
--   - MULTIPLE_ACTIVE_SERVICE_SESSIONS (impossible multiple-current state);
--   - SERVICE_SESSION_STATE_CORRUPT (invalid pointer/session FK);
--   - SERVICE_SESSION_CLOSING (genuine in-progress close);
--   - SERVICE_ALREADY_COMPLETED_TODAY (bootstrap-branch corruption guard,
--     untouched -- only reachable when no current session exists at all).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S-A refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
  ) THEN RAISE EXCEPTION 'S-A refused: ensure_service_session does not exist'; END IF;

  -- Reconfirm the exact defect still exists (fail closed rather than
  -- applying a fix for a problem already resolved a different way): the
  -- live function body must still contain both mismatch branches.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
       AND p.prosrc LIKE '%STALE_SERVICE_SESSION%'
       AND p.prosrc LIKE '%LUNCH_SESSION_STILL_ACTIVE%'
  ) THEN RAISE EXCEPTION 'S-A refused: ensure_service_session body does not match the expected pre-fix shape -- already patched or drifted, resolve first'; END IF;
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
    -- S-A: an already-open current session is the Operational Service.
    -- business_date/service_kind are economic-period classifications only
    -- (R-DAY3/frozen product contract) and never gate reuse of an open
    -- Operational Service. STALE_SERVICE_SESSION/LUNCH_SESSION_STILL_ACTIVE/
    -- OTHER_SERVICE_STILL_ACTIVE are removed from this branch entirely -- see
    -- the paired rollback for the exact prior body.
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

-- Post-conditions: structural only, never a real live call (mirrors R-DAY3
-- hotfix's own discipline -- calling the real function here would perform an
-- uncontrolled real ensure at whatever moment this migration happens to be
-- applied).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
       AND (p.prosrc LIKE '%STALE_SERVICE_SESSION%'
         OR p.prosrc LIKE '%LUNCH_SESSION_STILL_ACTIVE%'
         OR p.prosrc LIKE '%OTHER_SERVICE_STILL_ACTIVE%')
  ) THEN RAISE EXCEPTION 'S-A post-condition failed: a removed mismatch code is still present in the live function body'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
       AND p.prosrc LIKE '%SERVICE_SESSION_CLOSING%'
  ) THEN RAISE EXCEPTION 'S-A post-condition failed: SERVICE_SESSION_CLOSING must be preserved'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='ensure_service_session'
       AND p.prosrc LIKE '%MULTIPLE_ACTIVE_SERVICE_SESSIONS%'
       AND p.prosrc LIKE '%SERVICE_SESSION_STATE_CORRUPT%'
       AND p.prosrc LIKE '%SERVICE_ALREADY_COMPLETED_TODAY%'
  ) THEN RAISE EXCEPTION 'S-A post-condition failed: a genuine integrity fail-closed condition was removed'; END IF;

  -- This migration must not itself mutate any existing operational/financial
  -- state, nor the live pointer/shadow.
  IF (SELECT current_session_id FROM public.service_session_state) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-A post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-A post-condition failed: canonical pointer changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-A post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
END $$;

COMMIT;
