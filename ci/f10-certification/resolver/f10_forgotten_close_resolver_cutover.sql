-- migrations/2026-08-19_f10_forgotten_close_resolver_cutover.sql
-- F-10 — Resolver cutover: replaces the ONE reachable legacy writer that
-- silently forces status='rolled_over' onto a stale open Operational Service,
-- with a typed refusal the JS support (F-10.1B, already deployed but dormant)
-- can recover from. This is the ONLY change: the branch that currently reads
--
--   IF FOUND THEN
--     UPDATE public.service_sessions
--        SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
--      WHERE id = v_period.id;
--   END IF;
--
-- inside public.resolve_order_intake_context_v1 now branches on
-- lifecycle_semantics. Nothing else in the function changes: the Madrid
-- 04:00 business-date rule, the schedule window, the business_days
-- create-or-reuse block, the pointer writes, and the post-condition
-- self-checks are byte-identical to the currently-installed body.
--
-- operational_service_v1 (the new era, F-8 onward): the row is left
-- COMPLETELY UNTOUCHED and the function RAISEs a structured refusal instead
-- of returning a jsonb 'ok:false' payload. Doing it as a RAISE (not a
-- RETURN) is deliberate and matches this function's own existing idiom two
-- lines below for BUSINESS_DAY_POINTER_MISMATCH/TICKET_EPOCH_MIRROR_MISMATCH:
-- an exception aborts the WHOLE caller transaction (the order INSERT, via
-- service_session_assign_order), which atomically undoes every write this
-- function already made in this call -- including the tentative business_days
-- row and the business_day_lifecycle_state pointer bump -- so a refused
-- attempt can never leave partial Business Day state, partial pointer state,
-- or a stray ticket_epoch behind. No RETURN-then-trigger-reraises path is
-- introduced, and the trigger (service_session_assign_order) is NOT modified
-- by this migration: its existing generic `RAISE EXCEPTION '%', v_ctx->>'code'`
-- fallback is simply never reached for this case, because the exception
-- already propagated out of the resolver call before the trigger's own IF
-- check runs.
--
-- economic_period_v1 (the historical/transitional era): completely
-- unchanged. The exact same UPDATE ... SET status = 'rolled_over' this
-- function has always performed for that lifecycle_semantics stays exactly
-- as-is. In practice this branch can no longer fire against real data --
-- F-8/S-A stopped creating economic_period_v1 rows as the active session
-- long ago, and the 4 existing rolled_over rows in staging are already
-- terminal -- but preserving it is deliberate: this migration must not
-- rewrite or reinterpret history, only close the ONE new-era gap.
--
-- Structured contract emitted for operational_service_v1:
--   SQLSTATE = P0001
--   MESSAGE  = 'FORGOTTEN_CLOSE_REQUIRED'
--   DETAIL   = the stale service_sessions.id (canonical UUID text)
-- consumed by the already-deployed
-- src/serviceSessions/forgottenCloseRecovery.js:parseForgottenCloseRequired,
-- which requires all three fields exactly (code === "P0001",
-- message === "FORGOTTEN_CLOSE_REQUIRED", details === a valid UUID) and
-- fails closed on any partial match. PostgREST surfaces PostgreSQL's DETAIL
-- as the JSON error body's `details` property (project runtime evidence:
-- src/utils/supabaseTransport.js:305 returns the parsed PostgREST error body
-- untouched, and src/agents/agentOrdini.js:573 already reads `.details` to
-- recover the 23505 unique-violation DETAIL for client_req_id -- the same
-- mapping this migration now relies on for a second exception).
--
-- Why RAISE inside the resolver itself (not a two-step "resolver returns a
-- code, the trigger raises with DETAIL" split): the resolver already RAISEs
-- directly for its two existing invariant violations a few lines below, so
-- this is the established idiom in this exact function, not a new pattern.
-- It also requires zero change to service_session_assign_order and zero
-- change to resolve_order_intake_context_v1's signature or return type --
-- CREATE OR REPLACE is sufficient, no DROP needed.
--
-- Explicitly NOT touched by this migration:
--   * get_order_intake_context_v1 (the read-only UX-preflight sibling) --
--     still answers from the CURRENT installed state at call time and never
--     itself detects staleness; a stale read simply surfaces as ALLOWED
--     followed by the real INSERT's own FORGOTTEN_CLOSE_REQUIRED refusal,
--     exactly the same "friendlier preflight, DB backstop is authoritative"
--     relationship src/serviceSessions/orderIntakePolicy.js already
--     documents for ORDER_INTAKE_CLOSED.
--   * open_operational_service_v1 -- unchanged; it is what the RETRIED order
--     reaches once the stale service is actually closed and this same
--     resolver runs a second time with no active session for the new day.
--   * close_service_session_v3 / serviceLifecycleEngine.js -- unchanged;
--     forgottenCloseRecovery.js already calls the real close path via the
--     canonical serviceCloseAuthority.js facade (F-10.1B), and that facade
--     imports the engine unmodified.
--   * the 4 existing historical rolled_over rows -- left exactly as-is, no
--     backfill, no reclassification.
--   * migration-head verification debt (verified_head 76 vs recorded_head
--     92) -- out of scope for this slice.
--
-- Predecessor-body guard: refuses to apply over a drifted or already-patched
-- function, matching the discipline established for prior CREATE OR REPLACE
-- migrations in this manifest (rows 57/58 etc).

DO $guard$
DECLARE
  v_installed_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_installed_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';

  IF v_installed_md5 IS DISTINCT FROM 'c0aa4c64f53d71b5612c0b34eae86519' THEN
    RAISE EXCEPTION
      'F10_RESOLVER_PREDECESSOR_BODY_MISMATCH: installed resolve_order_intake_context_v1 does not match the exact body this migration was written against (expected md5 c0aa4c64f53d71b5612c0b34eae86519, found %). Refusing to apply over drifted state -- re-derive this migration against the CURRENT installed body before retrying.',
      COALESCE(v_installed_md5, 'NULL (function not found)')
      USING ERRCODE = 'P0001';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1(p_actor text DEFAULT 'order_intake_v1'::text, p_source text DEFAULT 'order_intake_v1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
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
  v_open_result          jsonb;
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

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_day.id,
         current_ticket_epoch    = v_day.ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  IF FOUND AND v_period.business_day_id = v_day.id THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      -- F-10: this is the ONE line this migration changes semantically. The
      -- pre-existing unconditional `UPDATE ... SET status = 'rolled_over'`
      -- is now gated on lifecycle_semantics, so a new-era Operational
      -- Service is never force-closed by a silent write -- it is refused,
      -- with the exact stale identity, and recovered explicitly by
      -- forgottenCloseRecovery.js (F-10.1B, already deployed, dormant until
      -- this migration activates it).
      IF v_period.lifecycle_semantics = 'operational_service_v1' THEN
        RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'
          USING ERRCODE = 'P0001', DETAIL = v_period.id::text;
      END IF;

      -- economic_period_v1 (historical/transitional): byte-identical to the
      -- previously-installed unconditional behavior. Unreachable against
      -- real data today (no economic_period_v1 row has been active since
      -- S-A), preserved so this migration never reinterprets history.
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_day_id = v_day.id AND status IN ('open','closing');
    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
          'businessDayId', v_day.id, 'businessDate', v_business_date, 'serviceKind', v_service_kind);
      END IF;

      v_open_result := public.open_operational_service_v1(
        COALESCE(p_actor, 'system'), 'first_open_of_business_day', COALESCE(p_source, 'order_intake')
      );
      IF (v_open_result->>'ok')::boolean IS NOT TRUE THEN
        RETURN jsonb_build_object('ok', false, 'code', 'OPEN_OPERATIONAL_SERVICE_FAILED',
          'reason', v_open_result->>'code', 'businessDate', v_business_date);
      END IF;
      SELECT * INTO v_period FROM public.service_sessions WHERE id = (v_open_result->'session'->>'id')::uuid;
    END IF;
  END IF;

  v_pointer.current_period_id := v_period.id;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_period_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  IF v_period.business_day_id IS DISTINCT FROM v_day.id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_period.id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF (SELECT current_ticket_epoch FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_day.ticket_epoch THEN
    RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'RESOLVED',
    'businessDayId', v_day.id,
    'businessDate', v_business_date,
    'periodId', v_period.id,
    'serviceKind', v_service_kind,
    'ticketEpoch', v_day.ticket_epoch,
    'advanced', v_period_needs_advance
  );
END $function$;
