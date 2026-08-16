-- migrations/2026-08-16_r_day3_business_day_intake_authority.ROLLBACK.sql
-- Paired rollback for 2026-08-16_r_day3_business_day_intake_authority.sql.
--
-- OWNER ERRATUM 1 — TWO DISTINCT POINTS OF NO RETURN.
-- A. OPERATIONAL rollback (restore service_session_assign_order(),
--    ensure_service_session(), roll_service_session_economic_v1() to their
--    exact byte-captured predecessor bodies) is ALWAYS safe: the C1 legacy
--    shadow (service_session_state.current_session_id), maintained
--    atomically for as long as R-DAY3 is live, means the restored old gate
--    finds exactly the state it expects -- a real, open, business-date-
--    correct-at-restore-time session (or, if intake happened on a stale
--    legacy date, the restored gate will raise STALE_SERVICE_SESSION again,
--    exactly its pre-R-DAY3 behaviour -- no worse than before R-DAY3 shipped).
-- B. SCHEMA rollback (restore service_sessions_date_kind_uq, the historical
--    GLOBALLY-unique index) is safe ONLY IF no duplicate (business_date,
--    service_kind) pair exists among current rows. The first time R-DAY3's
--    C2 model allows a second historical period for the same (date, kind)
--    pair to be committed, restoring that index would require deleting,
--    merging, or renaming a period -- forbidden by this project's own
--    append-only discipline (never destructive repair). This is the FIRST
--    R-DAY3 SCHEMA POINT OF NO RETURN.
--
-- This script performs BOTH restorations, or NEITHER — it is intentionally
-- all-or-nothing (a rollback that silently leaves the schema half-migrated
-- is worse than one that refuses cleanly). If the duplicate guard below
-- fires, the entire transaction aborts: nothing is restored, the R-DAY3
-- functions/index remain exactly as they were, and operators needing
-- emergency operational-only recovery (A, without B) must apply that as its
-- own explicit, smaller, manually-authored migration at that time — not
-- auto-derived from this file, so that decision is never made silently.
BEGIN;

DO $$
DECLARE
  v_dupes integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY3 rollback refused: resolve_order_intake_context_v1 does not exist -- R-DAY3 was never applied, nothing to roll back'; END IF;

  SELECT count(*) INTO v_dupes FROM (
    SELECT business_date, service_kind FROM public.service_sessions
     WHERE service_kind IS NOT NULL
     GROUP BY business_date, service_kind HAVING count(*) > 1
  ) dupes;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'R-DAY3 rollback refused: % duplicate (business_date,service_kind) pair(s) exist -- SCHEMA POINT OF NO RETURN reached, service_sessions_date_kind_uq cannot be restored without destructive repair. Operational-only recovery (service_session_assign_order/ensure_service_session/roll_service_session_economic_v1 predecessor bodies) must be applied as its own separate, explicit migration if needed.', v_dupes;
  END IF;
END $$;

-- ── B. Schema restoration (guarded above) ───────────────────────────────────
DROP INDEX IF EXISTS public.service_sessions_date_kind_active_uq;
CREATE UNIQUE INDEX service_sessions_date_kind_uq
  ON public.service_sessions (business_date, service_kind)
  WHERE service_kind IS NOT NULL;

-- ── A. Operational restoration — exact byte-captured predecessor bodies ────
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

CREATE OR REPLACE FUNCTION public.service_session_assign_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;

-- Drop the R-DAY3 resolver functions last (nothing depends on them once the
-- trigger no longer calls them).
DROP FUNCTION IF EXISTS public.resolve_order_intake_context_v1(text, text);
DROP FUNCTION IF EXISTS public.get_order_intake_context_v1();

DO $$
BEGIN
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY3 rollback post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='service_sessions' AND indexname='service_sessions_date_kind_uq'
  ) THEN RAISE EXCEPTION 'R-DAY3 rollback post-condition failed: service_sessions_date_kind_uq not restored'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY3 rollback post-condition failed: resolve_order_intake_context_v1 still present'; END IF;
END $$;

COMMIT;
