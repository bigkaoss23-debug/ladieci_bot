-- migrations/2026-08-23_o3_operational_service_until_finalizar.sql
-- O-3 (F-10B) — AN OPERATIONAL SERVICE ENDS ONLY WITH EXPLICIT FINALIZAR.
--
-- Filename note: this is the third slice in the O-series order-intake-
-- authority thread (O-1 removed the 17:30-18:00 blackout, O-2 removed the
-- 00:00-08:00-vs-continuity conflation at midnight); named o3 rather than
-- f10b so it sorts lexically AFTER o1/o2 for tests/serviceSessionCreation
-- Surface.static.test.js's filename-order migration replay, which O-2's own
-- header already documents as verified-not-assumed for this exact file set.
--
-- THE OLD RULE. Every temporal authority in this codebase treated "the
-- Business Day (04:00 Madrid rollover) has advanced past the service's OWN
-- business_date" as a HARD STOP: resolve_order_intake_context_v1 raised
-- FORGOTTEN_CLOSE_REQUIRED for any new order, and mesa_open_session_v1 /
-- mesa_open_reservation_v1 raised the identical exception for any new Mesa
-- seating -- even when the service was demonstrably still open and the
-- operator was still actively working it. O-2 (ledger 106) already proved
-- the SAME clock-vs-continuity conflation was wrong for the 00:00-08:00
-- floor; this migration closes the analogous gap at the Business Day
-- boundary itself.
--
-- THE NEW CONTRACT. Business Day and Operational Service are separate
-- concepts. Business Day is a reporting/provenance container; Operational
-- Service is the real operating session, and only an explicit Finalizar
-- ends one -- never the clock, never a Business Day boundary crossing. A
-- service may legitimately span 23:00 -> 06:00 and beyond, taking new
-- orders and seating new tables throughout, with a STABLE service_session_id
-- the whole time (already immutable by trigger, untouched here).
--
-- WHAT CHANGES, THREE FUNCTIONS, ONE SHARED IDEA. Wherever a caller already
-- holds (or is given) a service_sessions row with status IN ('open',
-- 'closing') AND lifecycle_semantics = 'operational_service_v1', that row is
-- now ALWAYS valid continuity -- full stop, no business_date comparison at
-- all for this case. No new business_days row is created, no pointer is
-- advanced, no successor is opened: the row is reused byte-identical to how
-- it already was.
--   - resolve_order_intake_context_v1: the open/closing lookup (already
--     relocated before the intake gate by O-2) short-circuits to a direct
--     RESOLVED response the moment it finds an operational_service_v1 row,
--     BEFORE the 00:00-08:00 gate, BEFORE any business_days work. Only when
--     NOTHING operational_service_v1 is open does the function fall through
--     to the untouched original gate/lazy-open/legacy-rollover logic --
--     which still includes its own FORGOTTEN_CLOSE_REQUIRED raise, now
--     structurally unreachable for operational_service_v1 rows specifically
--     (they never reach that branch anymore) but left in place, not
--     deleted, as F-10's recovery machinery for a FUTURE manual/late-
--     finalization path -- this slice does not build that path.
--   - mesa_open_session_v1 / mesa_open_reservation_v1: the business_date
--     comparison (and its FORGOTTEN_CLOSE_REQUIRED raise) now applies ONLY
--     when the caller-supplied service is NOT operational_service_v1
--     semantics -- i.e. never, in practice, since G-1 already made
--     operational_service_v1 the only session-creating primitive (zero
--     economic_period_v1 sessions can exist). For operational_service_v1,
--     already verified status='open' just above, seating proceeds
--     unconditionally.
--   - get_order_intake_context_v1: hasValidCurrentService (O-2) drops its
--     business_date filter -- ANY open/closing operational_service_v1 now
--     satisfies the JS preflight's continuity fact, matching the DB-
--     canonical resolver exactly. canCreateNewOrder itself, and every other
--     field, are untouched.
--
-- THE NON-BLOCKING SIGNAL F-10 BECOMES. resolve_order_intake_context_v1's
-- continuity response carries a new, additive, non-authoritative field:
-- crossesBusinessDay (the reused service's own business_date differs from
-- today's clock-computed one). Nothing reads it yet -- no UI, no incident
-- write, no automatic action -- this is deliberately just the metadata hook
-- a future late-finalization/recovery surface would need, per this slice's
-- own explicit non-goal of building that surface now.
--
-- WHAT DOES NOT CHANGE. open_operational_service_v1 (still the sole
-- session-creating primitive, still guards ACTIVE_SERVICE_BUSINESS_DAY_
-- MISMATCH for its own explicit_reopen caller, untouched -- that path is a
-- human deliberately reopening, a different concern from automatic
-- continuity); ensure_service_session (F-7/F-11, already reuses an active
-- session unconditionally with no business_date check at all -- confirmed
-- by this slice's own trace, nothing to fix there); forgottenCloseRecovery.js
-- / serviceCloseAuthority.js / serviceLifecycleEngine.js (the recovery
-- executor itself, unchanged, ready for a future caller); Finalizar,
-- service_closeouts semantics, Cash Count, Economía, order ownership
-- (service_session_id immutable, untouched), payment attribution, the
-- 04:00 business-date rollover FORMULA itself (still computed identically,
-- only what it is COMPARED against for a hard stop changes), the 17:30
-- lunch/dinner classification boundary, and O-1/O-2's own 00:00-08:00
-- floor for the genuinely-no-open-service case. No schema change, no
-- business-data DML, no backfill.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_resolve text;
  v_get text;
  v_mesa_open text;
  v_mesa_res text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'F-10B refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%v_continuity := v_had_open_or_closing AND v_period.business_date = v_business_date;%' THEN
    RAISE EXCEPTION 'F-10B refused: resolve_order_intake_context_v1 does not carry the expected pre-F-10B (post-O-2) shape -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'F-10B refused: the F-10 forgotten-close raise is missing from the live function -- resolve drift first';
  END IF;
  IF v_resolve LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'F-10B refused: resolve_order_intake_context_v1 already carries crossesBusinessDay -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_get
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get IS NULL THEN
    RAISE EXCEPTION 'F-10B refused: public.get_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_get NOT LIKE '%status IN (''open'',''closing'') AND business_date = v_business_date%' THEN
    RAISE EXCEPTION 'F-10B refused: get_order_intake_context_v1 does not carry the expected pre-F-10B (post-O-2) hasValidCurrentService shape -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_mesa_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_open_session_v1';
  IF v_mesa_open IS NULL THEN
    RAISE EXCEPTION 'F-10B refused: public.mesa_open_session_v1 does not exist -- resolve drift first';
  END IF;
  IF v_mesa_open NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' OR v_mesa_open NOT LIKE '%MESA_SERVICE_NOT_CURRENT%' THEN
    RAISE EXCEPTION 'F-10B refused: mesa_open_session_v1 does not carry the expected pre-F-10B seating guard -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_mesa_res
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_open_reservation_v1';
  IF v_mesa_res IS NULL THEN
    RAISE EXCEPTION 'F-10B refused: public.mesa_open_reservation_v1 does not exist -- resolve drift first';
  END IF;
  IF v_mesa_res NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' OR v_mesa_res NOT LIKE '%MESA_SERVICE_NOT_CURRENT%' THEN
    RAISE EXCEPTION 'F-10B refused: mesa_open_reservation_v1 does not carry the expected pre-F-10B seating guard -- resolve drift first';
  END IF;
END $$;

BEGIN;

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
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;
  v_had_open_or_closing := FOUND;

  -- F-10B — an Operational Service ends only with an explicit Finalizar.
  -- Any open/closing operational_service_v1 row is unconditional continuity:
  -- no business_date comparison, no business_days work, no pointer write, no
  -- successor. The row is returned exactly as it already was. crossesBusinessDay
  -- is a pure, non-authoritative signal -- nothing downstream reads it yet.
  IF v_had_open_or_closing AND v_period.lifecycle_semantics = 'operational_service_v1' THEN
    SELECT ticket_epoch INTO v_ticket_epoch FROM public.business_days WHERE id = v_period.business_day_id;
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'RESOLVED',
      'businessDayId', v_period.business_day_id,
      'businessDate', v_period.business_date,
      'periodId', v_period.id,
      'serviceKind', v_service_kind,
      'ticketEpoch', v_ticket_epoch,
      'advanced', false,
      'crossesBusinessDay', v_period.business_date IS DISTINCT FROM v_business_date
    );
  END IF;

  -- O-2's continuity flag is now decided entirely by the F-10B branch above
  -- (an operational_service_v1 row never reaches this point). What remains
  -- here is the ORIGINAL, byte-identical gate/lazy-open/legacy-rollover
  -- logic for the "nothing operational_service_v1 is open" case.
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

  IF v_had_open_or_closing AND v_period.business_day_id = v_day.id THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF v_had_open_or_closing THEN
      -- F-10B — structurally unreachable today: any operational_service_v1
      -- row already returned above. Left in place, not deleted, as F-10's
      -- own recovery contract for a legacy (non-operational_service_v1)
      -- session, should one ever exist again.
      IF v_period.lifecycle_semantics = 'operational_service_v1' THEN
        RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'
          USING ERRCODE = 'P0001', DETAIL = v_period.id::text;
      END IF;

      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

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

REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_intake_context_v1(text, text) TO service_role;

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
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  -- F-10B — hasValidCurrentService drops the business_date filter O-2 gave
  -- it: ANY open/closing operational_service_v1 is valid continuity now,
  -- matching resolve_order_intake_context_v1's own unconditional reuse.
  SELECT EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE status IN ('open','closing') AND lifecycle_semantics = 'operational_service_v1'
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

CREATE OR REPLACE FUNCTION public.mesa_open_session_v1(p_workspace_id uuid, p_by_actor text, p_table_id uuid, p_service_session_id uuid, p_covers_total integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_service public.service_sessions%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_current_business_date date;
BEGIN
  IF p_workspace_id IS NULL OR p_table_id IS NULL OR p_service_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR (p_covers_total IS NOT NULL AND p_covers_total NOT BETWEEN 1 AND 99)
  THEN RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_ACTOR_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  IF v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator') THEN
    RAISE EXCEPTION 'MESA_OPEN_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_service FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND OR v_service.status <> 'open' THEN
    RAISE EXCEPTION 'MESA_SERVICE_NOT_OPEN' USING ERRCODE='55000';
  END IF;

  -- F-10B — an open operational_service_v1 is valid regardless of business
  -- date: only Finalizar ends a service, never a Business Day boundary
  -- crossing. The business-date currency check now applies ONLY to legacy
  -- (non-operational_service_v1) semantics, which G-1 already made
  -- structurally impossible to create -- kept as a defensive backstop, not
  -- deleted.
  IF v_service.lifecycle_semantics <> 'operational_service_v1' THEN
    v_current_business_date := (public.get_order_intake_context_v1()->>'businessDate')::date;
    IF v_current_business_date IS NULL THEN
      RAISE EXCEPTION 'MESA_BUSINESS_DATE_UNRESOLVED' USING ERRCODE='55000';
    END IF;
    IF v_service.business_date IS DISTINCT FROM v_current_business_date THEN
      RAISE EXCEPTION 'MESA_SERVICE_NOT_CURRENT' USING ERRCODE='55000';
    END IF;
  END IF;

  PERFORM 1 FROM public.table_sessions
   WHERE workspace_id = p_workspace_id AND table_id = p_table_id
     AND status = 'open'
   ORDER BY id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'MESA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505';
  END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  BEGIN
    INSERT INTO public.table_sessions(
      workspace_id, table_id, service_session_id, table_ref, status,
      covers_total, assigned_waiter_actor, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_id, p_service_session_id, v_table.display_name, 'open',
      p_covers_total, CASE WHEN v_actor.role='waiter' THEN p_by_actor ELSE NULL END,
      p_by_actor, p_by_actor
    ) RETURNING * INTO v_session;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MESA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505';
  END;

  IF v_actor.role='waiter' THEN
    INSERT INTO public.table_session_assignment_history(
      workspace_id, table_session_id, previous_waiter_actor, new_waiter_actor,
      by_actor, action, created_at
    ) VALUES (
      p_workspace_id, v_session.id, NULL, p_by_actor, p_by_actor, 'assigned', now()
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', v_session.id,
    'tableId', v_session.table_id,
    'tableNumber', v_table.table_number,
    'displayName', v_table.display_name,
    'coversTotal', v_session.covers_total,
    'status', v_session.status,
    'openedAt', v_session.opened_at
  );
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_open_session_v1(uuid, text, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_open_session_v1(uuid, text, uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.mesa_open_reservation_v1(p_workspace_id uuid, p_by_actor text, p_reservation_id uuid, p_expected_version integer, p_service_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_reservation public.table_reservations%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_service public.service_sessions%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_now timestamptz := now();
  v_current_business_date date;
BEGIN
  IF p_workspace_id IS NULL OR p_reservation_id IS NULL OR p_service_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_expected_version IS NULL OR p_expected_version < 1
  THEN RAISE EXCEPTION 'MESA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESA_OPEN_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_service FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND OR v_service.status <> 'open' THEN
    RAISE EXCEPTION 'MESA_SERVICE_NOT_OPEN' USING ERRCODE='55000';
  END IF;

  -- F-10B — same relaxation as mesa_open_session_v1's own, for the same
  -- reason: only Finalizar ends an operational_service_v1, never a Business
  -- Day boundary crossing. Legacy-semantics backstop kept, not deleted.
  IF v_service.lifecycle_semantics <> 'operational_service_v1' THEN
    v_current_business_date := (public.get_order_intake_context_v1()->>'businessDate')::date;
    IF v_current_business_date IS NULL THEN
      RAISE EXCEPTION 'MESA_BUSINESS_DATE_UNRESOLVED' USING ERRCODE='55000';
    END IF;
    IF v_service.business_date IS DISTINCT FROM v_current_business_date THEN
      RAISE EXCEPTION 'MESA_SERVICE_NOT_CURRENT' USING ERRCODE='55000';
    END IF;
  END IF;

  SELECT * INTO v_reservation FROM public.table_reservations
   WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_reservation.status <> 'booked' THEN
    RAISE EXCEPTION 'MESA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
  END IF;
  IF v_reservation.version <> p_expected_version THEN
    RAISE EXCEPTION 'MESA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
  END IF;

  PERFORM 1 FROM public.table_sessions
   WHERE workspace_id = p_workspace_id AND table_id = v_reservation.table_id
     AND status = 'open'
   ORDER BY id FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'MESA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505'; END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_reservation.table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  INSERT INTO public.table_sessions(
    workspace_id, table_id, service_session_id, table_ref, status,
    covers_total, assigned_waiter_actor, created_by, updated_by
  ) VALUES (
    p_workspace_id, v_table.id, p_service_session_id, v_table.display_name, 'open',
    v_reservation.covers_total, CASE WHEN v_actor.role='waiter' THEN p_by_actor ELSE NULL END,
    p_by_actor, p_by_actor
  ) RETURNING * INTO v_session;

  IF v_actor.role='waiter' THEN
    INSERT INTO public.table_session_assignment_history(
      workspace_id, table_session_id, previous_waiter_actor, new_waiter_actor,
      by_actor, action, created_at
    ) VALUES (
      p_workspace_id, v_session.id, NULL, p_by_actor, p_by_actor, 'assigned', v_now
    );
  END IF;

  UPDATE public.table_reservations SET
    status = 'seated', table_session_id = v_session.id, seated_at = v_now,
    version = version + 1, updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_reservation.id RETURNING * INTO v_reservation;

  RETURN jsonb_build_object(
    'ok', true, 'sessionId', v_session.id, 'reservationId', v_reservation.id,
    'reservationVersion', v_reservation.version, 'tableId', v_table.id,
    'tableNumber', v_table.table_number, 'displayName', v_table.display_name,
    'coversTotal', v_session.covers_total, 'status', v_session.status,
    'openedAt', v_session.opened_at
  );
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_open_reservation_v1(uuid, text, uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_open_reservation_v1(uuid, text, uuid, integer, uuid) TO service_role;

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_resolve_src text;
  v_get_src text;
  v_mesa_open_src text;
  v_mesa_res_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL THEN
    RAISE EXCEPTION 'F-10B post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src NOT LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: crossesBusinessDay is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%v_had_open_or_closing AND v_period.lifecycle_semantics = ''operational_service_v1'' THEN%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the unconditional continuity fast-path is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the F-10 recovery raise (kept as a backstop) did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%open_operational_service_v1(%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the lazy-open call did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the lunch/dinner classification boundary (17:30) must stay untouched';
  END IF;
  -- The continuity fast-path must be reachable BEFORE the intake-window gate.
  IF position('v_had_open_or_closing AND v_period.lifecycle_semantics' in v_resolve_src)
     > position('IF NOT v_can_create_order AND NOT v_continuity THEN' in v_resolve_src) THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the continuity fast-path must precede the intake-window gate';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'status IN \(''open'',''closing''\) FOR UPDATE', 'g')) <> 1 THEN
    RAISE EXCEPTION 'F-10B post-condition failed: expected exactly one open/closing FOR UPDATE query, found a different count';
  END IF;

  SELECT p.prosrc INTO v_get_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get_src IS NULL THEN
    RAISE EXCEPTION 'F-10B post-condition failed: get_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_get_src LIKE '%business_date = v_business_date%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: hasValidCurrentService still filters by business_date in get_order_intake_context_v1';
  END IF;
  IF v_get_src NOT LIKE '%hasValidCurrentService%' OR v_get_src NOT LIKE '%lifecycle_semantics = ''operational_service_v1''%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: hasValidCurrentService does not carry the expected relaxed shape';
  END IF;

  SELECT p.prosrc INTO v_mesa_open_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_open_session_v1';
  IF v_mesa_open_src IS NULL THEN
    RAISE EXCEPTION 'F-10B post-condition failed: mesa_open_session_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_mesa_open_src NOT LIKE '%IF v_service.lifecycle_semantics <> ''operational_service_v1'' THEN%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: mesa_open_session_v1 does not scope the business-date check to legacy semantics';
  END IF;
  IF v_mesa_open_src NOT LIKE '%MESA_SERVICE_NOT_OPEN%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the pre-existing MESA_SERVICE_NOT_OPEN guard did not survive the replace';
  END IF;

  SELECT p.prosrc INTO v_mesa_res_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_open_reservation_v1';
  IF v_mesa_res_src IS NULL THEN
    RAISE EXCEPTION 'F-10B post-condition failed: mesa_open_reservation_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_mesa_res_src NOT LIKE '%IF v_service.lifecycle_semantics <> ''operational_service_v1'' THEN%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: mesa_open_reservation_v1 does not scope the business-date check to legacy semantics';
  END IF;
  IF v_mesa_res_src NOT LIKE '%MESA_RESERVATION_VERSION_CONFLICT%' THEN
    RAISE EXCEPTION 'F-10B post-condition failed: the pre-existing optimistic-version guard did not survive the replace';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F-10B post-condition failed: service_role lost EXECUTE on one of the four functions';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F-10B post-condition failed: anon/authenticated must never execute any of the four functions';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-106: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 107, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
