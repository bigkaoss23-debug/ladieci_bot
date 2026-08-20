-- ===============================================================
-- MESA FIRST-SEATING STALE SERVICE GUARD
-- 2026-08-20 · ledger row 95 · manifest row 97
--
-- DEFECT (confirmed, empirically observed on staging 2026-08-20).
-- Both Mesa seating primitives accept a caller-supplied p_service_session_id
-- and validate exactly one thing about it: status = 'open'. Neither proves the
-- service belongs to the CURRENT canonical Business Day. Between midnight and
-- the day's first order the pointer still names YESTERDAY's still-open
-- Operational Service, so a walk-in open or a reservation seating in that
-- window binds the new table_sessions row to yesterday. The day's first order
-- then legitimately triggers F-10 forgotten-close, which closes that service
-- underneath the now-active table session -- recreating the orphan class.
--
-- Observed live: on 2026-08-20 between 00:00 and 07:18:52 UTC,
-- service_session_state.current_session_id named b6cd0470-...-e80b7e24df52
-- (business_date 2026-08-19, status open) while get_order_intake_context_v1()
-- already returned businessDate 2026-08-20.
--
-- FIX. Both primitives gain ONE guard, placed in the existing service-status
-- block, immediately after the row is locked FOR UPDATE and before ANY table /
-- reservation row is touched -- so a rejection can never leave a partial Mesa
-- mutation behind.
--
-- AUTHORITY REUSED, NEVER RE-DERIVED. The canonical current Business Date
-- comes from public.get_order_intake_context_v1() -- STABLE, read-only, and
-- constant-for-constant identical to resolve_order_intake_context_v1's own
-- Business Day computation including the 04:00 Madrid overnight cutoff. This
-- is the exact same reuse F-11 (ledger 94) already established for
-- ensure_service_session; no new clock rule, no CURRENT_DATE, no second
-- calendar, no duplicated Business Day model.
--
-- TYPED CONTRACT REUSED. A stale operational_service_v1 raises the SAME
-- structured condition the order-intake resolver already raises, so the
-- ALREADY-DEPLOYED recovery executor (src/serviceSessions/
-- forgottenCloseRecovery.js -> serviceCloseAuthority.js -> V3 close) handles
-- seating identically to intake, with no second engine and no cloned logic:
--
--     SQLSTATE P0001
--     MESSAGE  FORGOTTEN_CLOSE_REQUIRED
--     DETAIL   <stale service_sessions.id>
--
-- A stale NON-operational (legacy economic_period_v1) service is NOT given the
-- forgotten-close contract: that era has its own rollover mechanism owned by
-- the intake resolver, and this guard must never trigger a close against it.
-- It gets a plain typed refusal instead.
--
-- WHY business_date AND NOT business_day_id. On the very first activity of a
-- new day the business_days row for today does not exist yet -- that is the
-- whole point of the defect. Comparing dates works before the row exists;
-- comparing ids would require creating it, which is advance authority this
-- guard deliberately does not have.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not advance the Business Day, does
-- not create or reopen a service, does not move any pointer, does not close
-- anything, and does not touch F-10 or F-11. It only refuses, structurally, to
-- bind a table session to a non-current service. The successor is created by
-- resolve_order_intake_context_v1 on the JS retry, exactly as for an order.
--
-- Everything else in both function bodies is byte-identical to the installed
-- pre-migration definitions.
-- ===============================================================

BEGIN;

-- ── Preconditions: refuse to run against an unexpected schema ─────────────
DO $$
BEGIN
  IF to_regprocedure('public.get_order_intake_context_v1()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: get_order_intake_context_v1() missing';
  END IF;
  IF to_regprocedure('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: mesa_open_session_v1 missing';
  END IF;
  IF to_regprocedure('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: mesa_open_reservation_v1 missing';
  END IF;
  -- F-10 must still be installed: this guard's whole contract depends on the
  -- resolver raising the same condition for the order path.
  IF position('FORGOTTEN_CLOSE_REQUIRED' IN
        pg_get_functiondef(to_regprocedure('public.resolve_order_intake_context_v1(text,text)'))) = 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: F-10 resolver not installed';
  END IF;
END $$;

-- ── 1/2 · walk-in table open ──────────────────────────────────────────────
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

  -- MESA FIRST-SEATING STALE SERVICE GUARD. Canonical date, never re-derived.
  v_current_business_date := (public.get_order_intake_context_v1()->>'businessDate')::date;
  IF v_current_business_date IS NULL THEN
    RAISE EXCEPTION 'MESA_BUSINESS_DATE_UNRESOLVED' USING ERRCODE='55000';
  END IF;
  IF v_service.business_date IS DISTINCT FROM v_current_business_date THEN
    IF v_service.lifecycle_semantics = 'operational_service_v1' THEN
      RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'
        USING ERRCODE = 'P0001', DETAIL = v_service.id::text;
    END IF;
    RAISE EXCEPTION 'MESA_SERVICE_NOT_CURRENT' USING ERRCODE='55000';
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

-- ── 2/2 · reservation seating ─────────────────────────────────────────────
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

  -- MESA FIRST-SEATING STALE SERVICE GUARD. Identical contract to the walk-in
  -- primitive above; placed before the reservation row is touched so a stale
  -- service can never half-seat a booking.
  v_current_business_date := (public.get_order_intake_context_v1()->>'businessDate')::date;
  IF v_current_business_date IS NULL THEN
    RAISE EXCEPTION 'MESA_BUSINESS_DATE_UNRESOLVED' USING ERRCODE='55000';
  END IF;
  IF v_service.business_date IS DISTINCT FROM v_current_business_date THEN
    IF v_service.lifecycle_semantics = 'operational_service_v1' THEN
      RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'
        USING ERRCODE = 'P0001', DETAIL = v_service.id::text;
    END IF;
    RAISE EXCEPTION 'MESA_SERVICE_NOT_CURRENT' USING ERRCODE='55000';
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

-- ── Post-conditions ───────────────────────────────────────────────────────
DO $$
BEGIN
  IF position('FORGOTTEN_CLOSE_REQUIRED' IN
        pg_get_functiondef(to_regprocedure('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: walk-in guard not installed';
  END IF;
  IF position('FORGOTTEN_CLOSE_REQUIRED' IN
        pg_get_functiondef(to_regprocedure('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: reservation guard not installed';
  END IF;
  -- F-10 and F-11 must be untouched by this migration.
  IF position('FORGOTTEN_CLOSE_REQUIRED' IN
        pg_get_functiondef(to_regprocedure('public.resolve_order_intake_context_v1(text,text)'))) = 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: F-10 resolver disturbed';
  END IF;
END $$;

COMMIT;
