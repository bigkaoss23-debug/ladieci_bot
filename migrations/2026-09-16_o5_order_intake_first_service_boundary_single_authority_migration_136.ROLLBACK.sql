-- migrations/2026-09-16_o5_order_intake_first_service_boundary_single_authority_migration_136.ROLLBACK.sql
-- Reverses O-5 (migration 136, 2026-09-16_o5_order_intake_first_service_boundary_single_authority_migration_136.sql) and restores the EXACT
-- ledger-135 state of the order-intake surface:
--   1. resolve_order_intake_context_v1 and get_order_intake_context_v1 get
--      their pre-O-5 bodies back BYTE-IDENTICALLY (the Stale Service
--      Protection V1 bodies installed by migration 120, which are exactly
--      the ledger-135 live bodies -- md5 of pg_proc.prosrc pinned below and
--      re-asserted as post-conditions);
--   2. order_intake_policy_v1(integer) is dropped;
--   3. open_business_day_v1(text,text) is re-created with its exact
--      ledger-135 live body (md5 pinned), owner/grants as before;
--   4. open_service_session(text,text) is NOT touched (O-5 never touched it).
-- No table, column, index, trigger or row is read for writing or changed;
-- no business data is created, updated or deleted.
--
-- WHAT A ROLLBACK RE-INSTATES. The independent 08:00 floor comes back:
-- between 04:00 and 07:59 Europe/Madrid a FIRST order (no open service) is
-- again refused with ORDER_INTAKE_CLOSED. An already-open service is still
-- reused at every hour (the continuity fast-path is identical in both
-- versions). Any Operational Service opened between 04:00 and 07:59 while
-- O-5 was live stays a valid, untouched row -- this file does not inspect or
-- modify service data. src/schedule/serviceSchedule.js must be reverted
-- together with this rollback (its canCreateNewOrder parity for 04:00-08:00),
-- or tests/rDay3ScheduleParity.test.js will report the drift.
--
-- There is no point of no return: O-5 wrote no data and changed no schema,
-- so this rollback is valid at any time after the forward was applied.

BEGIN;

-- ── Predecessor guard: refuse unless the EXACT O-5 surface is installed ───
DO $guard$
DECLARE
  v_resolve text;
  v_get     text;
BEGIN
  IF to_regprocedure('public.order_intake_policy_v1(integer)') IS NULL THEN
    RAISE EXCEPTION 'O-5 ROLLBACK refused: public.order_intake_policy_v1(integer) is absent -- O-5 is not applied, nothing to roll back';
  END IF;

  SELECT p.prosrc INTO v_resolve FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.resolve_order_intake_context_v1(text,text)');
  SELECT p.prosrc INTO v_get FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.get_order_intake_context_v1()');
  IF md5(v_resolve) IS DISTINCT FROM '6a9b99bb2c5df5b208ba9a8b90c76cbe' THEN
    RAISE EXCEPTION 'O-5 ROLLBACK refused: resolve_order_intake_context_v1 is not the exact O-5 body (md5 mismatch) -- a later change would be silently discarded, resolve drift first';
  END IF;
  IF md5(v_get) IS DISTINCT FROM '7bd0ba310ad850cd59afb083d6cc060b' THEN
    RAISE EXCEPTION 'O-5 ROLLBACK refused: get_order_intake_context_v1 is not the exact O-5 body (md5 mismatch) -- a later change would be silently discarded, resolve drift first';
  END IF;

  IF to_regprocedure('public.open_business_day_v1(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'O-5 ROLLBACK refused: public.open_business_day_v1(text,text) already exists -- O-5 is not (fully) applied, resolve drift first';
  END IF;
  IF to_regprocedure('public.open_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'O-5 ROLLBACK refused: public.open_service_session(text,text) is absent -- ledger-135 state cannot be restored, resolve drift first';
  END IF;

  -- Dropping the policy must not break a caller O-5 did not install.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND p.proname NOT IN ('order_intake_policy_v1', 'resolve_order_intake_context_v1', 'get_order_intake_context_v1')
       AND p.prosrc ILIKE '%order_intake_policy_v1%'
  ) THEN
    RAISE EXCEPTION 'O-5 ROLLBACK refused: another function now calls order_intake_policy_v1 -- dropping it would break that caller, resolve drift first';
  END IF;
END $guard$;

-- ── 1. resolve_order_intake_context_v1 — exact ledger-135 body ───────────
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
  v_open_result          jsonb;
  v_open_reason          text;
  v_open_source          text;
  v_had_open_or_closing  boolean;
  v_continuity           boolean;
  v_ticket_epoch          integer;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;
  v_had_open_or_closing := FOUND;

  IF v_had_open_or_closing AND v_period.lifecycle_semantics = 'operational_service_v1' THEN
    -- STALE SERVICE PROTECTION V1 — the Business Day is the grace boundary.
    -- O-3 gave this branch unconditional continuity; it is now bounded to
    -- "the service's own business_date is still the canonical Business Day"
    -- (overnight span included, since v_business_date carries the 04:00
    -- rollover). Once a full Business Day has elapsed the service is stale:
    -- fail closed with a typed refusal so the trigger raises it and no new
    -- order can attach. The JS staleServiceRecovery layer then auto-finalizes
    -- (if AUTO_CLOSE_SAFE) through the one V3 authority, or surfaces
    -- PREVIOUS_SERVICE_PENDING for operator resolution.
    IF v_period.business_date < v_business_date THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'PREVIOUS_SERVICE_PENDING',
        'staleServiceSessionId', v_period.id,
        'staleBusinessDate', v_period.business_date,
        'currentBusinessDate', v_business_date,
        'serviceKind', v_service_kind
      );
    ELSIF v_period.business_date > v_business_date THEN
      -- REVIEW FIX — a FUTURE-dated open service is a lifecycle/business-date
      -- anomaly, never a "previous" service and never ordinary continuity.
      -- Fail closed with the canonical code the opener primitive already uses
      -- for "an active service under a business day other than canonical"
      -- (open_operational_service_v1, ledger 93/96). No recovery path: the JS
      -- layer must not auto-close or reclassify a future-dated service.
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH',
        'serviceSessionId', v_period.id,
        'serviceBusinessDate', v_period.business_date,
        'currentBusinessDate', v_business_date,
        'serviceKind', v_service_kind
      );
    END IF;
    SELECT ticket_epoch INTO v_ticket_epoch FROM public.business_days WHERE id = v_period.business_day_id;
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'RESOLVED',
      'businessDayId', v_period.business_day_id,
      'businessDate', v_period.business_date,
      'periodId', v_period.id,
      'serviceKind', v_service_kind,
      'ticketEpoch', v_ticket_epoch,
      'advanced', false
    );
  END IF;

  v_continuity := false;

  IF NOT v_can_create_order AND NOT v_continuity THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

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

  SELECT * INTO v_period FROM public.service_sessions
   WHERE business_day_id = v_day.id AND status IN ('open','closing');
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id) THEN
      v_open_reason := 'next_service_of_business_day';
      v_open_source := COALESCE(p_source, 'order_intake') || '_next_service';
    ELSE
      v_open_reason := 'first_open_of_business_day';
      v_open_source := COALESCE(p_source, 'order_intake');
    END IF;

    v_open_result := public.open_operational_service_v1(
      COALESCE(p_actor, 'system'), v_open_reason, v_open_source
    );
    IF (v_open_result->>'ok')::boolean IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'code', 'OPEN_OPERATIONAL_SERVICE_FAILED',
        'reason', v_open_result->>'code', 'openReason', v_open_reason, 'businessDate', v_business_date);
    END IF;
    SELECT * INTO v_period FROM public.service_sessions WHERE id = (v_open_result->'session'->>'id')::uuid;
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
    'advanced', true
  );
END $function$;

REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_intake_context_v1(text, text) TO service_role;

-- ── 1b. get_order_intake_context_v1 — exact ledger-135 body ──────────────
CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid                    timestamp;
  v_minutes_of_day            integer;
  v_business_date             date;
  v_service_kind               text;
  v_can_create_order           boolean;
  v_has_valid_current_service  boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  -- STALE SERVICE PROTECTION V1 — an open operational_service_v1 row from a
  -- PAST Business Day is not a valid current service, so this advisory-
  -- preflight fact must not report it as continuity (which would let
  -- orderIntakePolicy.js fail OPEN while the DB-canonical
  -- resolve_order_intake_context_v1 fails CLOSED). Scoped back to
  -- business_date = v_business_date — the pre-O-3 shape, for this read fact
  -- only. Same-business-day (and the O-2 overnight span, since v_business_date
  -- carries the 04:00 rollover) is unaffected.
  SELECT EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE status IN ('open','closing') AND lifecycle_semantics = 'operational_service_v1'
       AND business_date = v_business_date
  ) INTO v_has_valid_current_service;

  RETURN jsonb_build_object(
    'canCreateNewOrder', v_can_create_order,
    'businessDate', v_business_date,
    'serviceKind', v_service_kind,
    'hasValidCurrentService', v_has_valid_current_service
  );
END $function$;

REVOKE ALL ON FUNCTION public.get_order_intake_context_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_intake_context_v1() TO service_role;

-- ── 2. drop the O-5 policy (no caller left after step 1) ────────────────
DROP FUNCTION public.order_intake_policy_v1(integer);

-- ── 3. open_business_day_v1 — exact ledger-135 live body ─────────────────
CREATE FUNCTION public.open_business_day_v1(p_opened_by text, p_source text DEFAULT 'backend'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.business_day_lifecycle_state%ROWTYPE;
  v_day   public.business_days%ROWTYPE;
  v_date  date;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;

  v_date := (clock_timestamp() AT TIME ZONE 'Europe/Madrid')::date;

  IF v_state.current_business_day_id IS NOT NULL THEN
    SELECT * INTO v_day FROM public.business_days WHERE id = v_state.current_business_day_id;
    IF FOUND AND v_day.business_date = v_date THEN
      RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'businessDay', to_jsonb(v_day));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'ANOTHER_BUSINESS_DAY_CURRENT', 'businessDay', to_jsonb(v_day));
  END IF;

  SELECT * INTO v_day FROM public.business_days WHERE business_date = v_date;
  IF NOT FOUND THEN
    INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
    VALUES (v_date, p_opened_by, COALESCE(p_source, 'backend'), 1, 1)
    RETURNING * INTO v_day;
  END IF;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id       = v_day.id,
         current_period_id             = NULL,
         current_ticket_epoch          = v_day.ticket_epoch,
         recent_closed_business_day_id = NULL,
         updated_at                    = now()
   WHERE singleton = true;

  RETURN jsonb_build_object('ok', true, 'code', 'CREATED', 'created', true, 'businessDay', to_jsonb(v_day));
END $function$;

REVOKE ALL ON FUNCTION public.open_business_day_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_business_day_v1(text, text) TO service_role;

-- ── Post-conditions: byte-exact ledger-135 surface ──────────────────────
DO $post$
BEGIN
  IF to_regprocedure('public.order_intake_policy_v1(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'O-5 ROLLBACK post-condition failed: order_intake_policy_v1 survived';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.resolve_order_intake_context_v1(text,text)'::regprocedure)
       IS DISTINCT FROM '143998dde151b23cc546354c09e36153'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_order_intake_context_v1()'::regprocedure)
       IS DISTINCT FROM '4965a2edebf0a08a403f3d154dcc00a9'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.open_business_day_v1(text,text)'::regprocedure)
       IS DISTINCT FROM '32dd2f23598555783d62ddf629443d9c'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.open_service_session(text,text)'::regprocedure)
       IS DISTINCT FROM '2570bc97f5675975a4aa4353b120a8f5' THEN
    RAISE EXCEPTION 'O-5 ROLLBACK post-condition failed: a restored body is not byte-identical to ledger 135';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.resolve_order_intake_context_v1(text,text)'::regprocedure) IS DISTINCT FROM 'v'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.get_order_intake_context_v1()'::regprocedure) IS DISTINCT FROM 's'
     OR (SELECT provolatile FROM pg_proc WHERE oid = 'public.open_business_day_v1(text,text)'::regprocedure) IS DISTINCT FROM 'v'
     OR EXISTS (SELECT 1 FROM pg_proc WHERE prosecdef
                 AND oid IN ('public.resolve_order_intake_context_v1(text,text)'::regprocedure,
                             'public.get_order_intake_context_v1()'::regprocedure,
                             'public.open_business_day_v1(text,text)'::regprocedure)) THEN
    RAISE EXCEPTION 'O-5 ROLLBACK post-condition failed: volatility/security of a restored function differs from ledger 135';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.open_business_day_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.open_business_day_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.open_business_day_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-5 ROLLBACK post-condition failed: privileges differ from ledger 135 (service_role only)';
  END IF;
END $post$;

-- LEDGER: a rollback is recorded by the operator exactly as the forward was
-- (never by this file). NOT APPLIED by the authoring session.

COMMIT;
