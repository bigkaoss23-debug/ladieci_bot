-- Access Control V3 -- V3-H.2: Mesa reservations.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- DRAFT ONLY: do not apply to production.
--
-- Reservations are operational work. Admin/owner, operator/cashier and waiter
-- roles may create, edit, move, cancel, mark no-show and seat them. Structural
-- floor editing remains owner/admin-only in messa_save_table_v1.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612'
  ) THEN
    RAISE EXCEPTION 'V3-H.2 refused: staging sentinel migration absent -- wrong database?';
  END IF;
  IF to_regclass('public.restaurant_tables') IS NULL
     OR to_regprocedure('public.messa_open_session_v1(uuid,text,uuid,uuid,integer)') IS NULL
     OR to_regprocedure('public.messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean)') IS NULL
  THEN
    RAISE EXCEPTION 'V3-H.2 refused: exact V3-H predecessor not found';
  END IF;
END $$;

CREATE TABLE public.table_reservations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT,
  table_id           uuid NOT NULL REFERENCES public.restaurant_tables(id) ON DELETE RESTRICT,
  table_session_id   uuid NULL REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  status             text NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked','seated','completed','cancelled','no_show')),
  guest_name         text NOT NULL CHECK (
    btrim(guest_name) <> '' AND length(guest_name) <= 120
    AND guest_name !~ '[[:cntrl:]]'
  ),
  guest_phone        text NULL CHECK (
    guest_phone IS NULL OR (
      btrim(guest_phone) <> '' AND length(guest_phone) <= 40
      AND guest_phone !~ '[[:cntrl:]]'
    )
  ),
  covers_total       integer NOT NULL CHECK (covers_total BETWEEN 1 AND 99),
  reserved_at        timestamptz NOT NULL,
  duration_minutes   integer NOT NULL DEFAULT 120 CHECK (duration_minutes = 120),
  note               text NULL CHECK (
    note IS NULL OR (
      length(note) <= 1000
      AND translate(note, E'\n\r\t', '') !~ '[[:cntrl:]]'
    )
  ),
  version            integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text NOT NULL,
  updated_by         text NOT NULL,
  seated_at          timestamptz NULL,
  completed_at       timestamptz NULL,
  cancelled_at       timestamptz NULL,
  no_show_at         timestamptz NULL,
  CONSTRAINT table_reservations_session_uq UNIQUE (table_session_id),
  CONSTRAINT table_reservations_created_by_fkey
    FOREIGN KEY (workspace_id, created_by) REFERENCES public.auth_actors(workspace_id, actor),
  CONSTRAINT table_reservations_updated_by_fkey
    FOREIGN KEY (workspace_id, updated_by) REFERENCES public.auth_actors(workspace_id, actor),
  CONSTRAINT table_reservations_lifecycle_chk CHECK (
    (status = 'booked' AND table_session_id IS NULL AND seated_at IS NULL
      AND completed_at IS NULL AND cancelled_at IS NULL AND no_show_at IS NULL)
    OR
    (status = 'seated' AND table_session_id IS NOT NULL AND seated_at IS NOT NULL
      AND completed_at IS NULL AND cancelled_at IS NULL AND no_show_at IS NULL)
    OR
    (status = 'completed' AND table_session_id IS NOT NULL AND seated_at IS NOT NULL
      AND completed_at IS NOT NULL AND cancelled_at IS NULL AND no_show_at IS NULL)
    OR
    (status = 'cancelled' AND table_session_id IS NULL AND seated_at IS NULL
      AND completed_at IS NULL AND cancelled_at IS NOT NULL AND no_show_at IS NULL)
    OR
    (status = 'no_show' AND table_session_id IS NULL AND seated_at IS NULL
      AND completed_at IS NULL AND cancelled_at IS NULL AND no_show_at IS NOT NULL)
  )
);

CREATE INDEX table_reservations_workspace_status_time_idx
  ON public.table_reservations(workspace_id, status, reserved_at, table_id);
CREATE INDEX table_reservations_table_status_time_idx
  ON public.table_reservations(table_id, status, reserved_at);
CREATE INDEX table_reservations_created_by_idx
  ON public.table_reservations(workspace_id, created_by);
CREATE INDEX table_reservations_updated_by_idx
  ON public.table_reservations(workspace_id, updated_by);

-- Create or edit one still-booked reservation. The workspace row serializes the
-- low-frequency reservation write domain, so two operators cannot both pass an
-- overlap check and commit conflicting bookings. `version` then prevents stale UI
-- edits from silently overwriting a more recent change.
CREATE OR REPLACE FUNCTION public.messa_save_reservation_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_reservation_id uuid,
  p_table_id uuid,
  p_guest_name text,
  p_guest_phone text,
  p_covers_total integer,
  p_reserved_local_date text,
  p_reserved_local_time text,
  p_note text,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_reservation public.table_reservations%ROWTYPE;
  v_reserved_at timestamptz;
  v_date date;
  v_time time;
  v_guest_name text := btrim(COALESCE(p_guest_name,''));
  v_guest_phone text := NULLIF(btrim(COALESCE(p_guest_phone,'')), '');
  v_note text := NULLIF(btrim(COALESCE(p_note,'')), '');
BEGIN
  IF p_workspace_id IS NULL OR p_table_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR v_guest_name = '' OR length(v_guest_name) > 120
     OR v_guest_name ~ '[[:cntrl:]]'
     OR (v_guest_phone IS NOT NULL AND (length(v_guest_phone) > 40 OR v_guest_phone ~ '[[:cntrl:]]'))
     OR p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99
     OR p_reserved_local_date IS NULL OR p_reserved_local_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR p_reserved_local_time IS NULL OR p_reserved_local_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     OR (v_note IS NOT NULL AND length(v_note) > 1000)
     OR (p_reservation_id IS NULL AND p_expected_version IS NOT NULL)
     OR (p_reservation_id IS NOT NULL AND (p_expected_version IS NULL OR p_expected_version < 1))
  THEN RAISE EXCEPTION 'MESSA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  BEGIN
    v_date := p_reserved_local_date::date;
    v_time := p_reserved_local_time::time;
    IF to_char(v_date, 'YYYY-MM-DD') <> p_reserved_local_date
       OR to_char(v_time, 'HH24:MI') <> p_reserved_local_time
    THEN RAISE EXCEPTION 'invalid local timestamp'; END IF;
    v_reserved_at := (v_date + v_time) AT TIME ZONE 'Europe/Madrid';
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_TIME_INVALID' USING ERRCODE='22023';
  END;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','waiter','shift_manager','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESSA_RESERVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;

  IF p_reservation_id IS NOT NULL THEN
    SELECT * INTO v_reservation FROM public.table_reservations
     WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_reservation.status <> 'booked' THEN
      RAISE EXCEPTION 'MESSA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
    END IF;
    IF v_reservation.version <> p_expected_version THEN
      RAISE EXCEPTION 'MESSA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
    END IF;
  END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  IF v_table.capacity IS NOT NULL AND p_covers_total > v_table.capacity THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_CAPACITY_EXCEEDED' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.table_reservations r
     WHERE r.workspace_id = p_workspace_id AND r.table_id = p_table_id
       AND r.status IN ('booked','seated')
       AND (p_reservation_id IS NULL OR r.id <> p_reservation_id)
       AND r.reserved_at < v_reserved_at + interval '120 minutes'
       AND r.reserved_at + make_interval(mins => r.duration_minutes) > v_reserved_at
  ) THEN RAISE EXCEPTION 'MESSA_RESERVATION_OVERLAP' USING ERRCODE='23P01'; END IF;

  IF p_reservation_id IS NULL THEN
    INSERT INTO public.table_reservations(
      workspace_id, table_id, status, guest_name, guest_phone, covers_total,
      reserved_at, duration_minutes, note, version, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_id, 'booked', v_guest_name, v_guest_phone,
      p_covers_total, v_reserved_at, 120, v_note, 1, p_by_actor, p_by_actor
    ) RETURNING * INTO v_reservation;
  ELSE
    UPDATE public.table_reservations SET
      table_id = p_table_id,
      guest_name = v_guest_name,
      guest_phone = v_guest_phone,
      covers_total = p_covers_total,
      reserved_at = v_reserved_at,
      note = v_note,
      version = version + 1,
      updated_at = now(),
      updated_by = p_by_actor
    WHERE id = p_reservation_id RETURNING * INTO v_reservation;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'reservationId', v_reservation.id, 'version', v_reservation.version,
    'status', v_reservation.status, 'tableId', v_reservation.table_id,
    'tableNumber', v_table.table_number, 'guestName', v_reservation.guest_name,
    'guestPhone', v_reservation.guest_phone, 'coversTotal', v_reservation.covers_total,
    'reservedAt', v_reservation.reserved_at, 'durationMinutes', v_reservation.duration_minutes,
    'note', v_reservation.note
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.messa_set_reservation_status_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_reservation_id uuid,
  p_expected_version integer,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_reservation public.table_reservations%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_reservation_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_expected_version IS NULL OR p_expected_version < 1
     OR p_status NOT IN ('cancelled','no_show')
  THEN RAISE EXCEPTION 'MESSA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','waiter','shift_manager','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESSA_RESERVATION_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_reservation FROM public.table_reservations
   WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_reservation.status <> 'booked' THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
  END IF;
  IF v_reservation.version <> p_expected_version THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
  END IF;

  UPDATE public.table_reservations SET
    status = p_status,
    version = version + 1,
    updated_at = v_now,
    updated_by = p_by_actor,
    cancelled_at = CASE WHEN p_status = 'cancelled' THEN v_now ELSE NULL END,
    no_show_at = CASE WHEN p_status = 'no_show' THEN v_now ELSE NULL END
  WHERE id = p_reservation_id RETURNING * INTO v_reservation;

  RETURN jsonb_build_object(
    'ok', true, 'reservationId', v_reservation.id,
    'version', v_reservation.version, 'status', v_reservation.status
  );
END
$fn$;

-- Seating is distinct from opening a walk-in account. It atomically consumes the
-- selected reservation, copies its covers and opens a brand-new Mesa account.
CREATE OR REPLACE FUNCTION public.messa_open_reservation_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_reservation_id uuid,
  p_expected_version integer,
  p_service_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
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
  THEN RAISE EXCEPTION 'MESSA_RESERVATION_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN (
    'admin','operator','owner','cashier','waiter','legacy_operator'
  ) THEN RAISE EXCEPTION 'MESSA_OPEN_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_service FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND OR v_service.status <> 'open' THEN
    RAISE EXCEPTION 'MESSA_SERVICE_NOT_OPEN' USING ERRCODE='55000';
  END IF;

  SELECT * INTO v_reservation FROM public.table_reservations
   WHERE id = p_reservation_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_RESERVATION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_reservation.status <> 'booked' THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_NOT_BOOKED' USING ERRCODE='55000';
  END IF;
  IF v_reservation.version <> p_expected_version THEN
    RAISE EXCEPTION 'MESSA_RESERVATION_VERSION_CONFLICT' USING ERRCODE='40001';
  END IF;

  PERFORM 1 FROM public.table_sessions
   WHERE workspace_id = p_workspace_id AND table_id = v_reservation.table_id
     AND status = 'open'
   ORDER BY id FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'MESSA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505'; END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_reservation.table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
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
$fn$;

-- A fully paid account completes the reservation that opened it. This is part of
-- the same payment transaction; there is no paid-but-occupied state.
CREATE OR REPLACE FUNCTION public.messa_complete_reservation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'closed' THEN
    UPDATE public.table_reservations SET
      status = 'completed', completed_at = COALESCE(NEW.settled_at, now()),
      version = version + 1, updated_at = COALESCE(NEW.settled_at, now()),
      updated_by = COALESCE(NEW.updated_by, updated_by)
    WHERE table_session_id = NEW.id AND status = 'seated';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER messa_complete_reservation_v1
AFTER UPDATE OF status ON public.table_sessions
FOR EACH ROW EXECUTE FUNCTION public.messa_complete_reservation_v1();

-- Soft-removing a physical table with future bookings would strand reservations.
CREATE OR REPLACE FUNCTION public.messa_guard_reserved_table_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF OLD.active IS TRUE AND NEW.active IS FALSE AND EXISTS (
    SELECT 1 FROM public.table_reservations r
     WHERE r.table_id = OLD.id AND r.workspace_id = OLD.workspace_id
       AND r.status = 'booked' AND r.reserved_at >= now()
  ) THEN
    RAISE EXCEPTION 'MESSA_TABLE_HAS_RESERVATIONS' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER messa_guard_reserved_table_v1
BEFORE UPDATE OF active ON public.restaurant_tables
FOR EACH ROW EXECUTE FUNCTION public.messa_guard_reserved_table_v1();

ALTER TABLE public.table_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.table_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.table_reservations TO service_role;

REVOKE ALL ON FUNCTION public.messa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_set_reservation_status_v1(uuid,text,uuid,integer,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_open_reservation_v1(uuid,text,uuid,integer,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_complete_reservation_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_guard_reserved_table_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.messa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_set_reservation_status_v1(uuid,text,uuid,integer,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_open_reservation_v1(uuid,text,uuid,integer,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_complete_reservation_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_guard_reserved_table_v1() TO service_role;

COMMENT ON TABLE public.table_reservations IS
  'Operational Mesa reservations. Bookings are independent from account lifecycle; seating opens a new table_session and full payment completes the linked reservation.';
COMMENT ON COLUMN public.table_reservations.version IS
  'Optimistic concurrency token. Every mutation increments it; stale operator edits are rejected.';

COMMIT;
