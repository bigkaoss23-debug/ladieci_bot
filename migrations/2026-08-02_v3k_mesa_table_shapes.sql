-- Access Control V3 -- V3-K: three Mesa table shapes (round / square /
-- rectangle), where only rectangle has a second, longer length preset.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- DRAFT ONLY: NOT applied to any database by this change.
--
-- Model: base shape (round/square/rectangle) + a length preset that only
-- rectangle actually uses. An earlier draft of this migration also gave
-- square a "rounded" preset (five combinations total); simplified before
-- commit per product review -- round and square never needed a second look,
-- only the rectangle's length is operationally meaningful (6 vs 8 plazas).
-- Capacity itself is NOT constrained by shape/preset anywhere below -- the
-- preset only supplies a suggested default in the frontend; the DB accepts
-- any capacity 1-99 regardless of shape.
-- Requires V3-J (mesa_* names) to already be applied: this migration replaces
-- mesa_save_table_v1, which V3-J created.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612'
  ) THEN
    RAISE EXCEPTION 'V3-K refused: staging sentinel migration absent -- wrong database?';
  END IF;
  IF to_regprocedure('public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean)') IS NULL THEN
    RAISE EXCEPTION 'V3-K refused: exact V3-J predecessor (mesa_save_table_v1, 10-arg) not found -- apply V3-J first';
  END IF;
END $$;

-- ── New preset column, backfilled to 'standard' for every existing table ───
ALTER TABLE public.restaurant_tables
  ADD COLUMN shape_preset text NOT NULL DEFAULT 'standard';

ALTER TABLE public.restaurant_tables
  ADD CONSTRAINT restaurant_tables_shape_preset_chk CHECK (
    (shape = 'round' AND shape_preset = 'standard')
    OR (shape = 'square' AND shape_preset = 'standard')
    OR (shape = 'rectangle' AND shape_preset IN ('standard','long'))
  );

COMMENT ON COLUMN public.restaurant_tables.shape_preset IS
  'Length preset within a base shape: round and square only ever have
   "standard" (they never varied); rectangle is "standard" (6 plazas
   suggested) or "long" (8 plazas suggested). Four valid (shape, shape_preset)
   combinations total -- enforced by restaurant_tables_shape_preset_chk.
   Capacity itself is a fully independent, freely editable field -- the
   plazas figures above are frontend-only starting suggestions, never a
   constraint enforced here.';

-- ── mesa_save_table_v1 gains one trailing DEFAULT-ed parameter. Postgres
-- treats a changed argument list as a distinct overload, so the exact 10-arg
-- V3-J signature must be dropped explicitly before creating the 11-arg one --
-- CREATE OR REPLACE alone would just add a second overload, not replace it. ──
DROP FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean);

CREATE FUNCTION public.mesa_save_table_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_id uuid,
  p_table_number integer,
  p_display_name text,
  p_capacity integer,
  p_position_x numeric,
  p_position_y numeric,
  p_shape text,
  p_active boolean,
  p_shape_preset text DEFAULT 'standard'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_preset text := COALESCE(p_shape_preset, 'standard');
BEGIN
  IF p_table_number IS NULL OR p_table_number NOT BETWEEN 1 AND 999 OR p_display_name IS NULL
     OR btrim(p_display_name) = '' OR length(p_display_name) > 80
     OR p_position_x IS NULL OR p_position_x NOT BETWEEN 0 AND 100
     OR p_position_y IS NULL OR p_position_y NOT BETWEEN 0 AND 100
     OR p_shape NOT IN ('round','square','rectangle')
     OR NOT (
       (p_shape = 'round' AND v_preset = 'standard')
       OR (p_shape = 'square' AND v_preset = 'standard')
       OR (p_shape = 'rectangle' AND v_preset IN ('standard','long'))
     )
     OR (p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 1 AND 99)
     OR p_active IS NULL
  THEN RAISE EXCEPTION 'MESA_TABLE_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'MESA_LAYOUT_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  IF p_table_id IS NULL THEN
    INSERT INTO public.restaurant_tables(
      workspace_id, table_number, display_name, capacity, position_x, position_y,
      shape, shape_preset, active, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_number, btrim(p_display_name), p_capacity,
      p_position_x, p_position_y, p_shape, v_preset, p_active, p_by_actor, p_by_actor
    ) RETURNING * INTO v_table;
  ELSE
    -- Global lock order for an existing table is session(s) -> physical table,
    -- matching the order-insert trigger. Locking the table first and then asking
    -- whether it had an open session would deadlock with a simultaneous command.
    PERFORM 1 FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND table_id = p_table_id
       AND status = 'open'
     ORDER BY id FOR UPDATE;
    SELECT * INTO v_table FROM public.restaurant_tables
     WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MESA_TABLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF p_active IS FALSE AND EXISTS (
      SELECT 1 FROM public.table_sessions
       WHERE workspace_id = p_workspace_id AND table_id = p_table_id AND status = 'open'
    ) THEN
      RAISE EXCEPTION 'MESA_TABLE_NOT_RELEASED' USING ERRCODE='55000';
    END IF;
    UPDATE public.restaurant_tables
       SET table_number = p_table_number, display_name = btrim(p_display_name),
           capacity = p_capacity, position_x = p_position_x, position_y = p_position_y,
           shape = p_shape, shape_preset = v_preset, active = p_active,
           updated_at = now(), updated_by = p_by_actor
     WHERE id = p_table_id RETURNING * INTO v_table;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_table.id, 'tableNumber', v_table.table_number,
    'displayName', v_table.display_name, 'capacity', v_table.capacity,
    'positionX', v_table.position_x, 'positionY', v_table.position_y,
    'shape', v_table.shape, 'shapePreset', v_table.shape_preset, 'active', v_table.active
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean,text)
  TO service_role;

COMMIT;
