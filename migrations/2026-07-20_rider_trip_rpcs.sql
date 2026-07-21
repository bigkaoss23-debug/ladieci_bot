-- 2026-07-20_rider_trip_rpcs.sql
-- S2-1B: transactional rider trip primitives. Separate PostgREST calls cannot make trip
-- start/close atomic (config.valore is text, no row version, no cross-statement lock), so
-- the lifecycle lives in three SECURITY INVOKER functions, each taking one shared advisory
-- transaction lock, bootstrapping the DRIVER_STATO config row, and returning structured
-- JSON ({ok, code, snapshot?}). No PII is stored in the trip snapshot (IDs only). trip_id
-- uses gen_random_uuid() (pgcrypto). EXECUTE is granted to service_role ONLY (default
-- PUBLIC EXECUTE is revoked). NOT APPLIED IN S2-1B.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- start_rider_trip(anchor) — atomically start one trip and snapshot its members.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.start_rider_trip(p_anchor_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds        jsonb;
  v_active    jsonb;
  v_anchor    public.ordenes%ROWTYPE;
  v_giro      text;
  v_order_ids text[];
  v_zones     text[];
  v_salidas   text[];
  v_giros     text[];
  v_trip_id   text;
  v_trip_seq  int;
  v_now       timestamptz := now();
  v_snapshot  jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  INSERT INTO public.config(chiave, valore)
  VALUES ('DRIVER_STATO', '{}')
  ON CONFLICT (chiave) DO NOTHING;

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;

  v_active := v_ds->'active_trip';

  -- S2-1H — crash-safe service close gate. Any existing marker blocks new trips until
  -- the exact close_id is explicitly ended; there is no automatic timeout.
  IF v_ds ? 'service_closing' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_CLOSING');
  END IF;

  SELECT * INTO v_anchor FROM public.ordenes WHERE id = p_anchor_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF upper(COALESCE(v_anchor.tipo_consegna,'')) <> 'DOMICILIO' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BAD_REQUEST');
  END IF;

  -- Idempotent when the anchor already belongs to the active trip (same trip, incl.
  -- a second-member Salgo tap); conflict only for a genuinely different trip start.
  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE' THEN
    IF (v_active->'order_ids' ? p_anchor_order_id)
       OR (v_active->>'anchor_order_id') = p_anchor_order_id THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'snapshot', v_active);
    ELSE
      RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT');
    END IF;
  END IF;

  v_giro := v_anchor.manual_giro_id;
  IF v_giro IS NOT NULL THEN
    SELECT array_agg(id ORDER BY ts) INTO v_order_ids
    FROM public.ordenes
    WHERE manual_giro_id = v_giro AND estado IN ('LISTO','EN_ENTREGA');
  ELSE
    v_order_ids := ARRAY[p_anchor_order_id];
  END IF;

  -- Every selected member must be a delivery order in an eligible state; else roll back.
  IF EXISTS (
    SELECT 1 FROM public.ordenes
    WHERE id = ANY(v_order_ids)
      AND (estado NOT IN ('LISTO','EN_ENTREGA') OR upper(COALESCE(tipo_consegna,'')) <> 'DOMICILIO')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.ordenes
    SET estado = 'EN_ENTREGA',
        hora_salida = (extract(epoch FROM v_now) * 1000)::bigint
  WHERE id = ANY(v_order_ids) AND estado = 'LISTO';

  SELECT array_agg(DISTINCT zona) FILTER (WHERE zona IS NOT NULL),
         array_agg(DISTINCT manual_giro_id) FILTER (WHERE manual_giro_id IS NOT NULL)
    INTO v_zones, v_giros
  FROM public.ordenes WHERE id = ANY(v_order_ids);

  IF v_giros IS NOT NULL THEN
    SELECT array_agg(DISTINCT salida_ref) FILTER (WHERE salida_ref IS NOT NULL)
      INTO v_salidas
    FROM public.manual_giros WHERE id = ANY(v_giros);
  END IF;

  v_trip_id  := gen_random_uuid()::text;
  v_trip_seq := COALESCE((v_ds->>'trip_seq')::int, 0) + 1;

  v_snapshot := jsonb_build_object(
    'trip_id',         v_trip_id,
    'anchor_order_id', p_anchor_order_id,
    'order_ids',       to_jsonb(v_order_ids),
    'manual_giro_ids', to_jsonb(COALESCE(v_giros,   ARRAY[]::text[])),
    'salida_refs',     to_jsonb(COALESCE(v_salidas, ARRAY[]::text[])),
    'zone_sequence',   to_jsonb(COALESCE(v_zones,   ARRAY[]::text[])),
    'n_orders',        COALESCE(array_length(v_order_ids,1), 0),
    'started_at',      to_jsonb(v_now),
    'closed_at',       'null'::jsonb,
    'trip_version',    1,
    'status',          'ACTIVE'
  );

  v_ds := v_ds || jsonb_build_object(
    'schema',          2,
    'stato',           'IN_GIRO',
    'zona',            to_jsonb(v_zones[1]),
    'partito_alle',    to_jsonb(v_now),
    'n_ordini',        COALESCE(array_length(v_order_ids,1), 0),
    'rientro_stimato', 'null'::jsonb,
    'trip_seq',        v_trip_seq,
    'active_trip',     v_snapshot
  );

  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_snapshot,
                            'stato', 'IN_GIRO', 'trip_seq', v_trip_seq);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- complete_rider_stop(order, cobrado, metodo_pago) — EN_ENTREGA -> RETIRADO once.
-- Writes ONLY operational metadata. Never touches pagado/ya_pagado/total/descuento/ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_rider_stop(
  p_order_id    text,
  p_cobrado     boolean,
  p_metodo_pago text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds      jsonb;
  v_active  jsonb;
  v_estado  text;
  v_updated int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  -- Membership: non-member returns NON_MEMBER (mapped to 403, no existence leak).
  IF NOT (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
  END IF;

  SELECT estado INTO v_estado FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_estado = 'RETIRADO' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id);
  END IF;
  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  UPDATE public.ordenes
    SET estado       = 'RETIRADO',
        hora_entrega = (extract(epoch FROM now()) * 1000)::bigint,
        cobrado      = COALESCE(p_cobrado, true),
        metodo_pago  = COALESCE(p_metodo_pago, '')
  WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- lost the race to a concurrent transition
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- close_rider_trip([p_trigger_order_id]) — verify all snapshot orders terminal,
-- close exactly once. When invoked for reconciliation with a trigger order that is
-- NOT a member of the active snapshot, it is a controlled no-op (NON_MEMBER) so an
-- unrelated operator completion never closes or mutates the active trip. Called with
-- no argument (or NULL) for an explicit rider close (no member filter).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.close_rider_trip(p_trigger_order_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds        jsonb;
  v_active    jsonb;
  v_order_ids      text[];
  v_pending        int;
  v_raw_count      int;
  v_distinct_count int;
  v_snapshot_count int;
  v_found          int;
  v_now       timestamptz := now();
  v_closed    jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  -- Idempotent duplicate close: no active trip -> return last closed, write nothing.
  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' THEN
    IF v_ds ? 'last_closed_trip' AND (v_ds->'last_closed_trip') <> 'null'::jsonb THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT',
                                'snapshot', v_ds->'last_closed_trip');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  -- Reconciliation safety: a trigger order that is NOT a snapshot member must never
  -- close the active trip (controlled no-op). NULL trigger = explicit rider close.
  IF p_trigger_order_id IS NOT NULL AND NOT (v_active->'order_ids' ? p_trigger_order_id) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NON_MEMBER_NOOP');
  END IF;

  IF jsonb_typeof(v_active->'order_ids') <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  SELECT count(*), count(DISTINCT value::text)
    INTO v_raw_count, v_distinct_count
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  v_snapshot_count := CASE
    WHEN COALESCE(v_active->>'n_orders', '') ~ '^[0-9]+$' THEN (v_active->>'n_orders')::int
    ELSE -1
  END;

  -- Snapshot structure must be internally consistent before any close side effect.
  -- Duplicates or n_orders drift indicate a corrupted active snapshot and are not
  -- silently deduplicated.
  IF v_raw_count <> v_distinct_count OR v_snapshot_count <> v_raw_count THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  -- Distinct ids are safe to use only after the raw snapshot was validated above.
  SELECT array_agg(DISTINCT value::text) INTO v_order_ids
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  -- Cardinality invariant: a missing snapshot row must NOT be silently treated as
  -- terminal. Every expected member must still exist. If any is gone (hard-deleted), refuse
  -- to close — do not move active_trip, write a log, or touch last_closed_trip.
  SELECT count(*) INTO v_found FROM public.ordenes WHERE id = ANY(v_order_ids);
  IF v_found <> v_raw_count THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MISSING_TRIP_MEMBER');
  END IF;

  -- Only after cardinality equality: every member must be terminal-for-delivery.
  SELECT count(*) INTO v_pending
  FROM public.ordenes
  WHERE id = ANY(v_order_ids)
    AND estado NOT IN ('RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','ANULADO');

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EARLY_CLOSE');
  END IF;

  v_closed := (v_active
    || jsonb_build_object('status', 'CLOSED', 'closed_at', to_jsonb(v_now)));

  v_ds := v_ds || jsonb_build_object(
    'stato',            'LIBERO',
    'rientro_stimato',  to_jsonb(v_now),
    'active_trip',      'null'::jsonb,
    'last_closed_trip', v_closed
  );

  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  -- One operational delivery log per close, in the same transaction (single close
  -- authority; the JS closeGiroInternal no longer inserts logs). IDs/zone only.
  INSERT INTO public.delivery_logs (zona, n_ordini, partito_alle, ultimo_entregado, rientro_stimato)
  VALUES (
    (v_active->'zone_sequence'->>0),
    COALESCE((v_active->>'n_orders')::int, 1),
    (v_active->>'started_at'),
    to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_closed);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- begin_service_close_if_idle() — service-close GATE + idle reset. Sets only the
-- compatible idle fields; PRESERVES schema, trip_seq and last_closed_trip; deletes no
-- snapshot or log. REJECTS with ACTIVE_TRIP_CONFLICT if an unclosed active trip exists.
-- On success it ALSO writes a crash-safe service_closing marker so start_rider_trip rejects
-- new trips until end_service_close(close_id) clears that exact marker. Advisory-locked,
-- service-role-only.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.begin_service_close_if_idle(
  p_service_date text DEFAULT NULL,
  p_source       text DEFAULT 'backend'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds       jsonb;
  v_active   jsonb;
  v_marker   jsonb;
  v_close_id text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  INSERT INTO public.config(chiave, valore)
  VALUES ('DRIVER_STATO', '{}')
  ON CONFLICT (chiave) DO NOTHING;

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';
  v_marker := v_ds->'service_closing';

  -- Crash/restart resume: the same in-progress close keeps its close_id and marker.
  IF v_marker IS NOT NULL AND v_marker <> 'null'::jsonb THEN
    RETURN jsonb_build_object('ok', true, 'code', 'OK', 'marker', v_marker,
                              'close_id', v_marker->>'close_id', 'resumed', true);
  END IF;

  -- Refuse to reset over an unclosed active trip (never destroy an active snapshot).
  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT');
  END IF;

  v_close_id := gen_random_uuid()::text;
  v_marker := jsonb_build_object(
    'close_id',     v_close_id,
    'service_date', COALESCE(NULLIF(p_service_date, ''), CURRENT_DATE::text),
    'started_at',   to_jsonb(now()),
    'source',       COALESCE(NULLIF(p_source, ''), 'backend'),
    'phase',        'started'
  );

  -- Idle fields + service-closing marker; preserve schema / trip_seq / last_closed_trip.
  v_ds := v_ds || jsonb_build_object(
    'stato',              'LIBERO',
    'zona',               'null'::jsonb,
    'partito_alle',       'null'::jsonb,
    'n_ordini',           0,
    'rientro_stimato',    'null'::jsonb,
    'active_trip',        'null'::jsonb,
    'service_closing',    v_marker
  );
  IF NOT (v_ds ? 'schema')   THEN v_ds := v_ds || jsonb_build_object('schema', 2); END IF;
  IF NOT (v_ds ? 'trip_seq') THEN v_ds := v_ds || jsonb_build_object('trip_seq', 0); END IF;

  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'stato', 'LIBERO',
                            'marker', v_marker, 'close_id', v_close_id, 'resumed', false);
END;
$$;

-- end_service_close(close_id) — clears only the matching service_closing marker after the
-- destructive cleanup completes. A wrong close_id never frees another close.
CREATE OR REPLACE FUNCTION public.end_service_close(p_close_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  INSERT INTO public.config(chiave, valore) VALUES ('DRIVER_STATO', '{}') ON CONFLICT (chiave) DO NOTHING;
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  IF NOT (v_ds ? 'service_closing') THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT');
  END IF;
  IF COALESCE(v_ds->'service_closing'->>'close_id', '') <> COALESCE(p_close_id, '') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_CLOSE_ID_MISMATCH');
  END IF;
  v_ds := v_ds - 'service_closing';
  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';
  RETURN jsonb_build_object('ok', true, 'code', 'OK');
END;
$$;

-- delete_order_if_not_active(order) — S2-1G hard-delete guard. An order that is a member
-- of the active_trip snapshot MUST NOT be physically deleted (operator must cancel it via a
-- state transition instead). Membership check + delete happen in ONE transaction under the
-- shared lock — a JS pre-check + sbDelete would be TOCTOU-unsafe.
CREATE OR REPLACE FUNCTION public.delete_order_if_not_active(p_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds      jsonb;
  v_active  jsonb;
  v_deleted int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  DELETE FROM public.ordenes WHERE id = p_order_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'deleted', v_deleted);
END;
$$;

-- delete_conversation_if_not_active(wa_id) — S2-1H conversation delete guard. Deletes the
-- same conversation rows as the legacy handler, but only after atomically proving that none
-- of the wa_id-linked orders belongs to the active_trip snapshot.
CREATE OR REPLACE FUNCTION public.delete_conversation_if_not_active(p_wa_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds          jsonb;
  v_active      jsonb;
  v_order_ids   text[];
  v_conv_del    int;
  v_msgs_del    int;
  v_orders_del  int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  SELECT COALESCE(array_agg(id), ARRAY[]::text[]) INTO v_order_ids
  FROM public.ordenes
  WHERE wa_id = p_wa_id;

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND EXISTS (
       SELECT 1
       FROM unnest(v_order_ids) AS oid(order_id)
       WHERE v_active->'order_ids' ? oid.order_id
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  DELETE FROM public.conv WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_conv_del = ROW_COUNT;
  DELETE FROM public.wa_msgs WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_msgs_del = ROW_COUNT;
  DELETE FROM public.ordenes WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_orders_del = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'code', 'OK',
    'deleted', jsonb_build_object('conv', v_conv_del, 'wa_msgs', v_msgs_del, 'ordenes', v_orders_del));
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges: PostgreSQL grants EXECUTE to PUBLIC by default — revoke, then grant
-- only to service_role (backend). Exact signatures used everywhere.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.start_rider_trip(text)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.close_rider_trip(text)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.begin_service_close_if_idle(text, text)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.end_service_close(text)                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_order_if_not_active(text)          FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.delete_conversation_if_not_active(text)    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.start_rider_trip(text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_rider_stop(text, boolean, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.close_rider_trip(text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.begin_service_close_if_idle(text, text)     TO service_role;
GRANT EXECUTE ON FUNCTION public.end_service_close(text)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_order_if_not_active(text)           TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_conversation_if_not_active(text)     TO service_role;

COMMIT;
