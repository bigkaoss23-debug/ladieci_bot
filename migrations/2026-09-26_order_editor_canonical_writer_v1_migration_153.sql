-- migrations/2026-09-26_order_editor_canonical_writer_v1_migration_153.sql
-- Paired rollback: 2026-09-26_order_editor_canonical_writer_v1_migration_153.ROLLBACK.sql
--
-- ECONOMY BASE -- POST-ASTRA CORRECTIVE CYCLE, FINDING F5 (+ N1). STAGING CANDIDATE ONLY; not applied by the session that authored it.
-- Evidence: ~/Downloads/ECONOMY_POST_ASTRA_CORRECTIVE_REPORT_2026-09-26.md.
--
-- DEFECT F5 -- LOST UPDATE IN THE ORDER EDITOR. modificaOrdine / aggiungiItems / cambiaStato (discount) read the order, compute totale in
-- the backend and PATCH ordenes directly. Nothing ties the write to the state it was computed from: two edits of the same unpaid order
-- (items by A, a 10% discount by B) both answered success and the later, stale write silently erased the committed discount (obligation
-- 32.00 instead of 28.80).
-- DEFECT N1 -- DEADLOCK EDITOR x PAYMENT. The direct PATCH locks the ORDER row, and its totale trigger (order_obligation_revision_v1) then
-- inserts an obligation revision whose foreign key takes KEY SHARE on the ORDER_ENTITIES row. Every canonical payment writer locks
-- ENTITY FOR UPDATE before ORDER. With a pointer holder ordering them (Finalizar / open), the two deadlock (reproduced: 40P01).
--
-- FIX: ONE canonical writer for the editor, public.order_apply_editor_patch_v1(order_id, patch, expected):
--   1. canonical lock order, the same prefix as the money writers: WORKSPACE FOR UPDATE -> [TABLE_SESSION FOR UPDATE] -> ENTITY FOR UPDATE
--      -> ORDER FOR UPDATE, then the UPDATE (whose triggers -- N-5 paid guard, 126 basis lock, 151 gate + revision -- stay the authority).
--      Nothing new is locked by a pointer holder; the editor no longer takes ORDER before ENTITY.
--   2. compare-and-set: a patch that moves the economic basis (items, totale, delivery_fee, descuento_*, tipo_consegna) must carry the basis
--      it was computed from; any difference with the locked row -> SQLSTATE 55000 ORDER_EDIT_CONFLICT, nothing written. Never a silent
--      stale overwrite, never a false success.
--   3. a closed allow-list of editor columns; identity, service attribution, table snapshot and ledger mirror columns (cobrado, ya_pagado,
--      refunded) are refused; an economic cancellation estado is refused (it belongs to order_cancel_v1, which revises the obligation).
-- No table / column / trigger / constraint / grant change on existing objects; no data change. The backend of the same package calls it.
-- ROLLOUT: 139 -> ... -> 150 -> the backend of the package -> 151 -> 152 -> 153 -> 154. Before 153 that backend finds no such function
-- (PostgREST PGRST202) and keeps the pre-153 direct PATCH, classified fail-closed; from 153 on every economic edit goes through it. Any
-- other refusal / failure of the function is final (typed), never a silent success.
-- ROLLBACK: 154 first, then 153 (function only, no data depends on it); the backend stays (it falls back as above).

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.order_economic_service_gate_v1(uuid)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM 'bfac4ec3f428daa91d5d9505d8b1285a' THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER refused: migration 151 is not applied with its certified bodies -- the chain is 139 -> ... -> 151 -> 153';
  END IF;
  -- The chain position: 152 first (numbered migrations apply in number order).
  IF to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)') IS NULL
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)')) IS DISTINCT FROM 'd79f71a2a40350307493ea1807b5fa77' THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER refused: migration 152 is not applied with its certified body -- the chain is 139 -> ... -> 151 -> 152 -> 153';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'order_apply_editor_patch_v1') THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER refused: already applied';
  END IF;
  IF to_regclass('public.ordenes') IS NULL OR to_regclass('public.order_entities') IS NULL OR to_regclass('public.workspaces') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER refused: a required table or role is missing';
  END IF;
END $guard$;

CREATE FUNCTION public.order_apply_editor_patch_v1(p_order_id text, p_patch jsonb, p_expected jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_peek public.ordenes%ROWTYPE;
  v_row jsonb;
  v_workspace uuid;
  v_key text;
  v_sets text[] := ARRAY[]::text[];
  v_mismatch text[] := ARRAY[]::text[];
  v_rows integer;
  v_same boolean;
  v_allowed constant text[] := ARRAY[
    'nombre','tel','items','nota','nota_cucina','hora','estado','llegado','cucina_check','tipo_consegna','direccion','direccion_note',
    'repartidor','hora_salida','hora_entrega','zona','zona_lat','zona_lon','zona_manuale','metodo_pago','delivery_fee','totale','forzado',
    'durata_andata_min','geo_source','durata_google_min','durata_haversine_min','cliente_id','forno_out','ui_offset_min','descuento_tipo',
    'descuento_valor','descuento_importe','listo_origin','listo_actor','listo_at','salida_driver_estimada','entrega_estimada',
    'retraso_estimado_min','conflicto_driver','updated_at','confirmado_at','en_cocina_at','en_entrega_at','retirado_at','completado_at',
    'cancelado_at'];
  v_basis constant text[] := ARRAY['items','totale','delivery_fee','descuento_tipo','descuento_valor','descuento_importe','tipo_consegna'];
  v_numeric constant text[] := ARRAY['totale','delivery_fee','descuento_valor','descuento_importe'];
BEGIN
  IF p_order_id IS NULL OR btrim(p_order_id) = '' OR p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_patch)) = 0
     OR (p_expected IS NOT NULL AND jsonb_typeof(p_expected) <> 'object') THEN
    RAISE EXCEPTION 'ORDER_EDIT_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (v_key = ANY (v_allowed)) THEN
      RAISE EXCEPTION 'ORDER_EDIT_FIELD_NOT_ALLOWED' USING ERRCODE = '22023', DETAIL = format('field=%s', v_key);
    END IF;
  END LOOP;
  IF upper(COALESCE(p_patch->>'estado', '')) IN ('CANCELADO', 'CANCELLED', 'ANULADO') THEN
    RAISE EXCEPTION 'ORDER_EDIT_CANCEL_NOT_ALLOWED' USING ERRCODE = '22023',
      HINT = 'An economic cancellation revises the obligation: use order_cancel_v1.';
  END IF;
  IF p_expected IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(p_expected) LOOP
      IF NOT (v_key = ANY (v_basis)) THEN
        RAISE EXCEPTION 'ORDER_EDIT_INVALID' USING ERRCODE = '22023', DETAIL = format('expected field=%s', v_key);
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k = ANY (v_basis))
     AND (p_expected IS NULL OR NOT (p_expected ?& v_basis)) THEN
    RAISE EXCEPTION 'ORDER_EDIT_EXPECTED_BASIS_REQUIRED' USING ERRCODE = '22023',
      HINT = 'A patch that moves the economic basis must carry the basis it was computed from.';
  END IF;

  SELECT * INTO v_peek FROM public.ordenes WHERE id = p_order_id;                       -- plain read: resolves the lock targets
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_EDIT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_peek.order_uid IS NOT NULL THEN
    SELECT oe.workspace_id INTO v_workspace FROM public.order_entities oe WHERE oe.order_uid = v_peek.order_uid;
  END IF;
  -- Canonical lock order (money writers): WORKSPACE -> [TABLE_SESSION] -> ENTITY -> ORDER.
  IF v_workspace IS NOT NULL THEN PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE; END IF;
  IF v_peek.table_session_id IS NOT NULL THEN
    PERFORM 1 FROM public.table_sessions WHERE id = v_peek.table_session_id FOR UPDATE;
  END IF;
  IF v_peek.order_uid IS NOT NULL THEN
    PERFORM 1 FROM public.order_entities WHERE order_uid = v_peek.order_uid FOR UPDATE;
  END IF;
  SELECT to_jsonb(o) INTO v_row FROM public.ordenes o WHERE o.id = p_order_id FOR UPDATE;
  IF v_row IS NULL THEN RAISE EXCEPTION 'ORDER_EDIT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  -- Compare-and-set on the economic basis the caller computed from (JSON null and SQL NULL are the same absence).
  IF p_expected IS NOT NULL THEN
    FOR v_key IN SELECT jsonb_object_keys(p_expected) LOOP
      IF v_key = ANY (v_numeric) THEN
        v_same := (NULLIF(v_row->>v_key, '')::numeric) IS NOT DISTINCT FROM (NULLIF(p_expected->>v_key, '')::numeric);
      ELSIF v_key = 'items' THEN
        v_same := COALESCE(NULLIF(v_row->'items', 'null'::jsonb), '[]'::jsonb) = COALESCE(NULLIF(p_expected->'items', 'null'::jsonb), '[]'::jsonb);
      ELSE
        v_same := NULLIF(v_row->>v_key, '') IS NOT DISTINCT FROM NULLIF(p_expected->>v_key, '');
      END IF;
      IF NOT v_same THEN v_mismatch := v_mismatch || v_key; END IF;
    END LOOP;
    IF cardinality(v_mismatch) > 0 THEN
      RAISE EXCEPTION 'ORDER_EDIT_CONFLICT' USING ERRCODE = '55000',
        DETAIL = format('order_id=%s changed_fields=%s', p_order_id, array_to_string(v_mismatch, ',')),
        HINT = 'The order changed after it was read: reload it and apply the edit again.';
    END IF;
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) ORDER BY 1 LOOP
    v_sets := v_sets || format('%I = r.%I', v_key, v_key);
  END LOOP;
  EXECUTE format('UPDATE public.ordenes o SET %s FROM jsonb_populate_record(NULL::public.ordenes, $1) r WHERE o.id = $2',
                 array_to_string(v_sets, ', '))
    USING p_patch, p_order_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'ORDER_EDIT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;

  RETURN jsonb_build_object('ok', true, 'orderId', p_order_id, 'updated', v_rows);
END;
$function$;

REVOKE ALL ON FUNCTION public.order_apply_editor_patch_v1(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_apply_editor_patch_v1(text, jsonb, jsonb) TO service_role;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ORDER_EDITOR_WRITER post-condition failed: function missing'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN RAISE EXCEPTION 'ORDER_EDITOR_WRITER post-condition failed: must be SECURITY INVOKER'; END IF;
  IF (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER post-condition failed: search_path not pinned';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER post-condition failed: EXECUTE must be service_role only';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM 'bfac4ec3f428daa91d5d9505d8b1285a'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576' THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER post-condition failed: a 151 body changed';
  END IF;
END $post$;

COMMIT;
