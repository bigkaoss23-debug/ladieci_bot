-- migrations/2026-08-19_f11_ensure_stale_business_day_classification.ROLLBACK.sql
-- Paired rollback for F-11. Restores public.ensure_service_session to its
-- EXACT pre-F-11 body -- the F-7 (row 92) read/reuse-only version, whose
-- installed pg_get_functiondef md5 was 2c41409d31b3006fa5d01828add45ca6.
--
-- After this runs, a stale canonical Business Day pointer once again answers
-- REOPEN_REQUIRED instead of NO_OPEN_SERVICE -- i.e. the 2026-08-19 defect
-- is deliberately restored. Only roll back if F-11 itself is proven wrong;
-- the operator-facing consequence is that a normal idle new Business Day is
-- blocked behind a "reopen the service" panel again.
--
-- Adds/removes no table, no column, no trigger, no function: this is a pure
-- CREATE OR REPLACE of one function body back to its previous text. It does
-- not touch resolve_order_intake_context_v1 (F-10 / migration 93),
-- get_order_intake_context_v1, open_operational_service_v1, or any row of
-- operational data.

BEGIN;

DO $$
DECLARE
  v_def_ensure text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-11 rollback refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF to_regprocedure('public.ensure_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-11 rollback refused: ensure_service_session(text,text) not found';
  END IF;

  SELECT p.prosrc INTO v_def_ensure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='ensure_service_session';

  -- Refuse to "roll back" something that is not F-11: the stale-downgrade
  -- branch must actually be installed right now.
  IF v_def_ensure NOT LIKE '%staleBusinessDay%' THEN
    RAISE EXCEPTION 'F-11 rollback refused: the installed ensure_service_session does not contain the F-11 stale downgrade branch -- nothing to roll back, or drifted';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_service_session(p_opened_by text, p_source text DEFAULT 'auto_entry'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_has_any  boolean;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open', 'closing')) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.service_sessions WHERE id = v_state.current_session_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_SESSION_STATE_CORRUPT');
    END IF;
    IF v_session.status = 'closing' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_SESSION_CLOSING', 'session', to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'session', to_jsonb(v_session));
  END IF;

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true;
  IF v_bd_state.current_business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE');
  END IF;

  v_has_any := EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_bd_state.current_business_day_id);
  IF v_has_any THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
      'businessDayId', v_bd_state.current_business_day_id,
      'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
    'businessDayId', v_bd_state.current_business_day_id,
    'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
END;
$function$;

DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='ensure_service_session';

  IF v_src LIKE '%staleBusinessDay%' OR v_src LIKE '%get_order_intake_context_v1%' THEN
    RAISE EXCEPTION 'F-11 rollback post-condition failed: F-11 content still present after restore';
  END IF;
  IF v_src NOT LIKE '%REOPEN_REQUIRED%' THEN
    RAISE EXCEPTION 'F-11 rollback post-condition failed: restored body is missing the REOPEN_REQUIRED branch';
  END IF;
END $$;

COMMIT;
