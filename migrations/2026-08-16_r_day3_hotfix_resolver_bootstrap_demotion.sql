-- migrations/2026-08-16_r_day3_hotfix_resolver_bootstrap_demotion.sql
-- R-DAY3 HOTFIX — resolve_order_intake_context_v1()'s demotion detection was
-- keyed on business_day_lifecycle_state.current_period_id (the POINTER),
-- not on what is actually globally active in service_sessions. R-DAY1 left
-- the pointer dormant (current_period_id NULL) by design, and R-DAY3 never
-- activates it except through this same resolver's own first real call.
-- Staging's live legacy session (d20ee320, business_date=2026-08-15,
-- status='open') predates the pointer entirely -- it was opened by
-- ensure_service_session long before R-DAY1 existed. On the resolver's
-- very first genuine invocation (pointer still NULL, d20ee320 still open),
-- v_pointer.current_period_id IS NULL short-circuits the demotion branch,
-- so the resolver never touches d20ee320 and instead tries to INSERT a
-- brand-new 'open' row for today -- violating service_sessions_
-- single_active_uq (at most one globally active row, ever), since d20ee320
-- is still counted.
--
-- Reproduced live, in a rolled-back transaction, before authoring this fix
-- (an isolated pg_temp copy of the resolver's post-schedule-check logic,
-- called with today's real (business_date, service_kind) against the real,
-- unmodified staging state):
--   INSERT INTO service_sessions(business_date, service_kind, status, ...)
--   VALUES ('2026-08-16','SERA','open', ...)
--   -> 23505: duplicate key value violates unique constraint
--      "service_sessions_single_active_uq" DETAIL: Key ((true))=(t) already
--      exists.
-- This is precisely the "stale previous-day Service Period blocks new-day
-- intake" failure R-DAY3 exists to remove -- just relocated from a typed
-- STALE_SERVICE_SESSION rejection to a raw constraint-violation crash. It
-- was never exercised by the original migration's own post-condition block
-- (which asserts object existence/shape only, never calls the resolver
-- against real data) or by any static test (which cannot reach live DB
-- state) -- caught here during pre-cutover acceptance testing, before this
-- resolver has ever been consumed by a real order.
--
-- BLAST RADIUS. Would have fired on literally the next real order attempt
-- once the schedule window opened -- not a corner case, the exact live
-- staging condition this whole slice was built to fix.
--
-- FIX. Demotion detection now queries what is ACTUALLY globally active in
-- service_sessions directly (SELECT ... WHERE status IN ('open','closing')
-- FOR UPDATE) rather than trusting the pointer's own current_period_id.
-- service_sessions_single_active_uq guarantees at most one such row can
-- ever exist, so this single query is authoritative regardless of whether
-- the pointer already agrees with it -- correctly unifying three cases the
-- old logic only handled two of: (a) pointer already tracking the right
-- active period (steady state, unchanged behaviour), (b) pointer tracking a
-- stale period that needs demoting (unchanged behaviour), and (c) pointer
-- still dormant/NULL while a legacy session predating it is genuinely open
-- (the bug -- now correctly demoted like any other stale period). No other
-- line of the function changes; get_order_intake_context_v1() (read-only,
-- never touches service_sessions) is unaffected and not touched here.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY3 hotfix refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY3 hotfix refused: resolve_order_intake_context_v1 does not exist -- R-DAY3 not yet applied'; END IF;

  -- Reconfirm the exact defect still exists (fail closed rather than
  -- applying a fix for a problem already resolved a different way): the
  -- live function body must still key demotion on v_pointer.current_period_id.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
       AND p.prosrc LIKE '%IF v_pointer.current_period_id IS NOT NULL AND v_period.status IN%'
  ) THEN RAISE EXCEPTION 'R-DAY3 hotfix refused: resolver body does not match the expected pre-hotfix shape -- already patched or drifted, resolve first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1(
  p_actor  text DEFAULT 'order_intake_v1',
  p_source text DEFAULT 'order_intake_v1'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_madrid              timestamp;
  v_minutes_of_day      integer;
  v_business_date       date;
  v_service_kind        text;
  v_can_create_order    boolean;
  v_pointer             public.business_day_lifecycle_state%ROWTYPE;
  v_day                 public.business_days%ROWTYPE;
  v_period               public.service_sessions%ROWTYPE;
  v_period_needs_advance boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END;
  v_can_create_order := (v_minutes_of_day >= 480 AND v_minutes_of_day < 1050)
                       OR (v_minutes_of_day >= 1080);

  IF NOT v_can_create_order THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_pointer FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_day FROM public.business_days WHERE business_date = v_business_date;
  IF NOT FOUND THEN
    INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
    VALUES (v_business_date, COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'), 1, 1)
    ON CONFLICT (business_date) DO NOTHING
    RETURNING * INTO v_day;
    IF NOT FOUND THEN
      SELECT * INTO v_day FROM public.business_days WHERE business_date = v_business_date;
    END IF;
  END IF;
  IF v_day.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUSINESS_DAY_UNRESOLVED');
  END IF;

  -- HOTFIX: query what is ACTUALLY globally active directly -- authoritative
  -- via service_sessions_single_active_uq -- rather than trusting the
  -- pointer's own current_period_id, which may still be dormant while a
  -- legacy session predating it is genuinely open.
  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  IF FOUND AND v_period.business_date = v_business_date AND v_period.service_kind = v_service_kind THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      -- Demote whatever is currently active (whether or not the pointer
      -- already knew about it). 'rolled_over' means exactly: no longer
      -- current for new economic attribution -- not paid, not closed, not
      -- reconciled, not archived. guard_service_session_closed_v1 does not
      -- fire on this transition (it only guards -> 'closed').
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    -- Adopt an already-active period for the resolved pair if one somehow
    -- exists; otherwise create a NEW one. NEVER reopen a historical
    -- rolled_over/closed row.
    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_date = v_business_date AND service_kind = v_service_kind
       AND status IN ('open','closing');
    IF NOT FOUND THEN
      INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)
      VALUES (v_business_date, v_service_kind, 'open', COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'))
      RETURNING * INTO v_period;
    END IF;
  END IF;

  v_pointer.current_period_id       := v_period.id;
  v_pointer.current_business_day_id := v_day.id;
  v_pointer.current_ticket_epoch    := v_day.ticket_epoch;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_pointer.current_business_day_id,
         current_period_id       = v_pointer.current_period_id,
         current_ticket_epoch    = v_pointer.current_ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  IF v_period.business_day_id IS DISTINCT FROM v_pointer.current_business_day_id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF v_day.ticket_epoch IS DISTINCT FROM v_pointer.current_ticket_epoch THEN
    RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'RESOLVED',
    'businessDayId', v_pointer.current_business_day_id,
    'businessDate', v_business_date,
    'periodId', v_pointer.current_period_id,
    'serviceKind', v_service_kind,
    'ticketEpoch', v_pointer.current_ticket_epoch,
    'advanced', v_period_needs_advance
  );
END $function$;

-- Post-condition: STRUCTURAL only. Deliberately does NOT call the real
-- resolver here -- doing so inside this migration's own transaction would
-- perform a genuine, uncontrolled activation (demoting the real d20ee320,
-- creating a real period, moving the real pointer) at whatever moment this
-- migration happens to be applied, entirely dependent on the schedule
-- window at that instant -- bypassing the controlled, rollback-guarded
-- acceptance testing this certification runs as its own separate, deliberate
-- step immediately after apply. This block only proves the function body
-- itself was correctly replaced.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
       AND p.prosrc LIKE '%SELECT * INTO v_period FROM public.service_sessions WHERE status IN (%open%,%closing%) FOR UPDATE%'
  ) THEN RAISE EXCEPTION 'R-DAY3 hotfix post-condition failed: resolver body does not contain the corrected global-active-session query'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
       AND p.prosrc LIKE '%IF v_pointer.current_period_id IS NOT NULL AND v_period.status IN%'
  ) THEN RAISE EXCEPTION 'R-DAY3 hotfix post-condition failed: the old pointer-keyed demotion condition is still present'; END IF;

  -- The real, live d20ee320 must remain completely untouched by this
  -- migration -- the fix changes only the resolver's own future behaviour,
  -- never mutates existing rows itself.
  IF (SELECT status FROM public.service_sessions WHERE id='d20ee320-6132-4021-af5f-c4dbe95f84a0') <> 'open' THEN
    RAISE EXCEPTION 'R-DAY3 hotfix post-condition failed: d20ee320 status changed unexpectedly -- this migration must not mutate existing session rows';
  END IF;
  IF (SELECT current_business_day_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY3 hotfix post-condition failed: pointer unexpectedly activated -- this migration must not itself trigger a real intake activation';
  END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY3 hotfix post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
END $$;

COMMIT;
