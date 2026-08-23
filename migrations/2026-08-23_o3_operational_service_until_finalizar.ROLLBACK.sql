-- migrations/2026-08-23_o3_operational_service_until_finalizar.ROLLBACK.sql
-- Reverts O-3 (F-10B) by restoring resolve_order_intake_context_v1,
-- get_order_intake_context_v1, mesa_open_session_v1 and
-- mesa_open_reservation_v1's pre-F-10B (post-O-2) bodies byte-identical:
-- an Operational Service still open past a Business Day boundary crossing
-- is treated as stale again, and both order intake and Mesa/reservation
-- seating refuse it with FORGOTTEN_CLOSE_REQUIRED.
--
-- READ THIS BEFORE RUNNING IT. Rolling back reintroduces the exact
-- continuity gap this migration closed: a service genuinely still being
-- worked past ~04:00 Madrid will start refusing new orders and new Mesa
-- seatings the instant the Business Day rolls over, even though nothing
-- about the service itself changed and no operator asked for it to close.
-- No table, column, trigger or grant changes in any direction; this file
-- changes four function bodies only.

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
  v_continuity := v_had_open_or_closing AND v_period.business_date = v_business_date;

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
    IF v_continuity IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
    END IF;
  ELSE
    v_period_needs_advance := true;
    IF v_had_open_or_closing THEN
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

  SELECT EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE status IN ('open','closing') AND business_date = v_business_date
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

REVOKE ALL ON FUNCTION public.mesa_open_reservation_v1(uuid, text, uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_open_reservation_v1(uuid, text, uuid, integer, uuid) TO service_role;

DO $$
DECLARE
  v_resolve_src text;
  v_get_src text;
  v_mesa_open_src text;
  v_mesa_res_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL OR v_resolve_src LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'F-10B rollback post-condition failed: the pre-F-10B body was not restored in resolve_order_intake_context_v1';
  END IF;

  SELECT p.prosrc INTO v_get_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get_src IS NULL OR v_get_src NOT LIKE '%business_date = v_business_date%' THEN
    RAISE EXCEPTION 'F-10B rollback post-condition failed: the pre-F-10B body was not restored in get_order_intake_context_v1';
  END IF;

  SELECT p.prosrc INTO v_mesa_open_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_open_session_v1';
  IF v_mesa_open_src IS NULL OR v_mesa_open_src LIKE '%lifecycle_semantics <> ''operational_service_v1''%' THEN
    RAISE EXCEPTION 'F-10B rollback post-condition failed: the pre-F-10B body was not restored in mesa_open_session_v1';
  END IF;

  SELECT p.prosrc INTO v_mesa_res_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_open_reservation_v1';
  IF v_mesa_res_src IS NULL OR v_mesa_res_src LIKE '%lifecycle_semantics <> ''operational_service_v1''%' THEN
    RAISE EXCEPTION 'F-10B rollback post-condition failed: the pre-F-10B body was not restored in mesa_open_reservation_v1';
  END IF;
END $$;

COMMIT;
