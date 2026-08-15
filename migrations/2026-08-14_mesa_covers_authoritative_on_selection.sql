-- MESA SEND-TO-KITCHEN P0 FIX — covers authoritative at SELECTION time, not
-- at first-command SUCCESS time.
--
-- ROOT CAUSE (proven live on staging 2026-08-14, DB evidence + a matching
-- service_incidents row): V3-I (2026-08-02_v3i_mesa_covers_deferred.sql)
-- deliberately deferred covers_total to be set ONLY atomically inside the
-- first comanda's own INSERT (mesa_prepare_table_order_v1), specifically to
-- avoid a DIFFERENT failure mode -- "covers registered separately while the
-- comanda itself fails, stranding a confirmed guest count with no order".
-- That was a reasonable concern, but it has a side effect V3-I did not
-- anticipate: for the ENTIRE time an operator is browsing/building a draft
-- (which can be many minutes for a real order), the table's covers_total
-- stays NULL, making an actively-worked table indistinguishable from a
-- genuinely abandoned one to any external observer.
--
-- mesa_release_empty_session_auto_v1's ONLY guard against releasing a table
-- is `covers_total IS NOT NULL -> RAISE MESA_TABLE_HAS_ORDERS`. The V3
-- service-lifecycle close engine (serviceLifecycleEngine.js) calls that RPC
-- as a "safe auto-action" on every service close/rollover, for every open
-- table session with covers_total IS NULL.
--
-- Live proof: service_incidents row 8c72c457-c092-4e37-a88f-a624fe3bb0dc,
-- detected_at 2026-08-14 19:38:47.468639+00, incident_type
-- EMPTY_TABLE_LEFT_OPEN, entity_id 039d2644-4068-4902-9fa0-6ed68c776e33 (the
-- Mesa 1 table_session open 2026-08-14 19:08:53 -> 19:38:47, ~30 minutes --
-- consistent with a real operator building a substantial draft),
-- resolution_type auto_released_empty_table, resolution_note "Table session
-- had zero activity (covers_total IS NULL) at service close; automatically
-- released." table_sessions.closed_at for that row matches to the
-- millisecond. A routine service close silently destroyed an in-progress,
-- fully-built 113,50 EUR draft because the ONLY signal available to
-- distinguish "real order in progress" from "genuinely empty table" had
-- never been set.
--
-- FIX (purely additive, one new RPC, zero changes to existing functions):
-- mesa_set_session_covers_v1 lets the backend persist covers_total the
-- MOMENT the operator selects them (MesaOrderBuilder's covers step, before
-- the picker even opens) -- server-authoritative, atomic, immediately
-- protected by the ALREADY-EXISTING monotonic guard trigger
-- (mesa_guard_covers_monotonic_v1, unchanged) and the ALREADY-EXISTING
-- auto-release guard (mesa_release_empty_session_auto_v1, unchanged --
-- `covers_total IS NOT NULL` now correctly reads as true the instant covers
-- are chosen, not only after a successful first comanda).
--
-- mesa_prepare_table_order_v1 (the atomic first-comanda trigger) needs NO
-- change: its own existing branch already handles "covers already set" as a
-- documented no-op ("Any later comanda already has v_session.covers_total
-- set, so this is a no-op and a stray table_covers_total_input value on
-- that request is simply ignored") -- calling this new RPC first and then
-- sending the first comanda exercises exactly that existing, already-tested
-- path. V3-I's original concern (covers registered but the comanda then
-- fails) is deliberately accepted now as a PRODUCT decision, not an
-- oversight: a table with covers set but zero orders must require an
-- EXPLICIT close (mesa_close_session_v1 / the frontend's "Cerrar mesa"),
-- never a silent auto-release -- see MESA_SEND_TO_KITCHEN_P0_FIX_2026-08-14
-- .md, invariant D. This is the smallest possible change that achieves that
-- without touching the close engine, the auto-release RPC, or the
-- monotonic-guard trigger at all.
--
-- Staging-only, no table/column added/dropped, no data touched, no existing
-- function altered. Paired .ROLLBACK.sql drops the new function.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612'
  ) THEN
    RAISE EXCEPTION 'MESA_COVERS_AUTHORITATIVE refused: staging sentinel migration absent -- wrong database?';
  END IF;
  IF to_regclass('public.table_sessions') IS NULL
     OR to_regprocedure('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)') IS NULL
     OR to_regprocedure('public.mesa_release_empty_session_auto_v1(uuid,uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'MESA_COVERS_AUTHORITATIVE refused: exact V3-J (mesa_* nomenclature) predecessor not found';
  END IF;
END $$;

CREATE FUNCTION public.mesa_set_session_covers_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_session_id uuid,
  p_covers_total integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99
  THEN RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_ACTOR_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  -- Same role set addCommand itself already requires (mesaService.js's
  -- OPEN_ROLES) -- setting covers is part of the same "start a comanda"
  -- operator action, not a separate privilege tier.
  IF v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator') THEN
    RAISE EXCEPTION 'MESA_OPEN_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.assigned_waiter_actor IS NOT NULL AND v_actor.role = 'waiter'
     AND v_session.assigned_waiter_actor <> p_by_actor
  THEN RAISE EXCEPTION 'MESA_WAITER_NOT_ASSIGNED' USING ERRCODE='42501'; END IF;

  -- The pre-existing monotonic guard trigger (table_sessions_guard_covers_
  -- monotonic_v1, unchanged by this migration) makes this UPDATE safe by
  -- construction: raising an already-set count to the same or a higher
  -- value always succeeds (a natural retry/re-select of the same or a
  -- larger party is a no-op or a legitimate correction); attempting to
  -- shrink or null an already-set count is rejected there
  -- (MESA_COVERS_IMMUTABLE), never here.
  UPDATE public.table_sessions
     SET covers_total = p_covers_total, updated_at = v_now, updated_by = p_by_actor
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', v_session.id,
    'tableId', v_session.table_id,
    'coversTotal', v_session.covers_total,
    'status', v_session.status
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.mesa_set_session_covers_v1(uuid,text,uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_set_session_covers_v1(uuid,text,uuid,integer) TO service_role;

COMMIT;
