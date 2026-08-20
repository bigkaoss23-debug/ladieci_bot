-- ===============================================================
-- ROLLBACK · MESA FIRST-SEATING STALE SERVICE GUARD (ledger row 95)
--
-- Restores both Mesa seating primitives to their EXACT pre-migration bodies
-- (the definitions installed by the V3-J nomenclature cutover), removing the
-- Business Day guard and the FORGOTTEN_CLOSE_REQUIRED contract from the
-- seating path.
--
-- POINT OF NO RETURN GUARD. Rolling back re-opens the defect: seating will
-- again be able to bind a table_sessions row to a previous-day service. This
-- script therefore refuses to run while any table session is currently open,
-- because such a session could be mid-recovery and would silently lose its
-- structural protection. Release the tables first, or accept the risk by
-- closing them explicitly.
--
-- Adds/drops no table and no column. Touches neither F-10 nor F-11.
-- ===============================================================

BEGIN;

DO $$
DECLARE
  v_open_tables integer;
BEGIN
  SELECT count(*) INTO v_open_tables FROM public.table_sessions WHERE status = 'open';
  IF v_open_tables > 0 THEN
    RAISE EXCEPTION 'PONR: % open table session(s) -- release them before rolling back the seating guard', v_open_tables;
  END IF;
END $$;

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

COMMIT;
