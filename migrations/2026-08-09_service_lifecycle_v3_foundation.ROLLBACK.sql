BEGIN;

-- ── PART 2 rollback — drop service_closeouts ────────────────────────────────
DROP TRIGGER IF EXISTS service_closeouts_no_update_delete ON public.service_closeouts;
DROP FUNCTION IF EXISTS public.service_closeouts_append_only();
DROP TABLE IF EXISTS public.service_closeouts;

-- ── PART 1 rollback — restore mesa_prepare_table_order_v1's pre-fix body ───
CREATE OR REPLACE FUNCTION public.mesa_prepare_table_order_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_source_line_id uuid;
  v_raw_id text;
  v_covers_total integer;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = NEW.table_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  v_covers_total := v_session.covers_total;
  IF v_covers_total IS NULL THEN
    IF NEW.table_covers_total_input IS NULL
       OR NEW.table_covers_total_input NOT BETWEEN 1 AND 99
    THEN RAISE EXCEPTION 'MESA_COVERS_REQUIRED' USING ERRCODE='22023'; END IF;
    v_covers_total := NEW.table_covers_total_input;
  END IF;
  NEW.table_covers_total_input := NULL;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_session.table_id FOR SHARE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  IF jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
    RAISE EXCEPTION 'MESA_ITEMS_REQUIRED' USING ERRCODE='22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.items)
  LOOP
    v_raw_id := v_item ->> 'lineId';
    BEGIN
      v_source_line_id := CASE WHEN v_raw_id IS NULL THEN gen_random_uuid() ELSE v_raw_id::uuid END;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'MESA_LINE_ID_INVALID' USING ERRCODE='22023';
    END;
    v_items := v_items || jsonb_build_array(
      jsonb_set(v_item, '{lineId}', to_jsonb(v_source_line_id::text), true)
    );
  END LOOP;

  NEW.items := v_items;
  NEW.service_session_id := v_session.service_session_id;
  NEW.table_number_snapshot := v_table.table_number;
  NEW.table_name_snapshot := v_table.display_name;
  NEW.table_command_number := v_session.next_command_number;
  NEW.canal := 'BANCO';
  -- language-guard: allow-legacy tipo_consegna/RITIRO are the existing column assignment and value from mesa_prepare_table_order_v1's pre-3.1 body, restated verbatim because this rollback restores the exact original function body, not new vocabulary
  NEW.tipo_consegna := 'RITIRO';
  NEW.delivery_fee := 0;

  UPDATE public.table_sessions
     SET covers_total = v_covers_total,
         next_command_number = next_command_number + 1,
         updated_at = now()
   WHERE id = v_session.id;

  RETURN NEW;
END
$fn$;

COMMIT;
