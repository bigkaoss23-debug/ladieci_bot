-- Rollback for V3-K (five Mesa table shapes). Restores mesa_save_table_v1 to
-- its exact V3-J 10-argument signature and drops shape_preset. Schema-only
-- revert; refused while any table actually uses a non-"standard" preset,
-- since that state cannot be expressed once the column is gone.
BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.restaurant_tables WHERE shape_preset <> 'standard'
  ) THEN
    RAISE EXCEPTION 'V3-K rollback refused: a table uses a non-standard shape_preset -- reset it to standard first';
  END IF;
  IF to_regprocedure('public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'V3-K rollback refused: 11-arg mesa_save_table_v1 not found -- was V3-K actually applied?';
  END IF;
END $$;

DROP FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean,text);

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
  p_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
BEGIN
  IF p_table_number IS NULL OR p_table_number NOT BETWEEN 1 AND 999 OR p_display_name IS NULL
     OR btrim(p_display_name) = '' OR length(p_display_name) > 80
     OR p_position_x IS NULL OR p_position_x NOT BETWEEN 0 AND 100
     OR p_position_y IS NULL OR p_position_y NOT BETWEEN 0 AND 100
     OR p_shape NOT IN ('round','square','rectangle')
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
      shape, active, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_number, btrim(p_display_name), p_capacity,
      p_position_x, p_position_y, p_shape, p_active, p_by_actor, p_by_actor
    ) RETURNING * INTO v_table;
  ELSE
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
           shape = p_shape, active = p_active, updated_at = now(), updated_by = p_by_actor
     WHERE id = p_table_id RETURNING * INTO v_table;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_table.id, 'tableNumber', v_table.table_number,
    'displayName', v_table.display_name, 'capacity', v_table.capacity,
    'positionX', v_table.position_x, 'positionY', v_table.position_y,
    'shape', v_table.shape, 'active', v_table.active
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean)
  TO service_role;

ALTER TABLE public.restaurant_tables DROP CONSTRAINT IF EXISTS restaurant_tables_shape_preset_chk;
ALTER TABLE public.restaurant_tables DROP COLUMN shape_preset;

COMMIT;
