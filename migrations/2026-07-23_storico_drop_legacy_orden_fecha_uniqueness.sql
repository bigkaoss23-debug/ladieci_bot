-- S2-6A3F — drop the legacy same-day uniqueness on storico(orden_id, fecha).
--
-- storico_orden_id_fecha_key is a STANDALONE UNIQUE INDEX (not a constraint) on
-- (orden_id, fecha). It predates the service-session model and assumes at most one
-- archive per (order number, business date). That is false under multi-service: two
-- services on the same date reuse order numbers, so the second archive collides
-- (SQLSTATE 23505 on storico_orden_id_fecha_key) even though the session-scoped upsert
-- target (service_session_id, orden_id) is a fresh pair. The canonical uniqueness is now
-- UNIQUE(service_session_id, orden_id); this legacy same-day uniqueness must go.
--
-- (orden_id, fecha) stays useful for historical lookups, so the UNIQUE index is replaced
-- by a plain NON-UNIQUE index on the same columns. No business logic, no time windows,
-- no global numbering is introduced. No row is modified.
BEGIN;

-- 1) guard: the legacy object exists, is an index (not a constraint), is UNIQUE, on
--    exactly (orden_id, fecha).
DO $$
DECLARE v_is_unique boolean; v_cols text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storico_orden_id_fecha_key'
             AND conrelid = 'public.storico'::regclass) THEN
    RAISE EXCEPTION 'ABORT: storico_orden_id_fecha_key is a CONSTRAINT, not a standalone index; use ALTER TABLE ... DROP CONSTRAINT';
  END IF;
  SELECT idx.indisunique INTO v_is_unique
    FROM pg_index idx JOIN pg_class c ON c.oid = idx.indexrelid
    WHERE c.relname = 'storico_orden_id_fecha_key';
  IF v_is_unique IS NULL THEN
    RAISE EXCEPTION 'ABORT: storico_orden_id_fecha_key not found';
  END IF;
  IF v_is_unique IS NOT TRUE THEN
    RAISE EXCEPTION 'ABORT: storico_orden_id_fecha_key is not UNIQUE; unexpected shape';
  END IF;
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO v_cols
    FROM pg_index idx
    JOIN pg_class c ON c.oid = idx.indexrelid
    CROSS JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = idx.indrelid AND a.attnum = k.attnum
   WHERE c.relname = 'storico_orden_id_fecha_key';
  IF v_cols <> 'orden_id,fecha' THEN
    RAISE EXCEPTION 'ABORT: storico_orden_id_fecha_key columns are (%), expected (orden_id,fecha)', v_cols;
  END IF;
END $$;

-- 2) guard: the canonical session-scoped unique index exists and is NON-partial.
DO $$
DECLARE v_def text;
BEGIN
  SELECT indexdef INTO v_def FROM pg_indexes WHERE indexname = 'storico_session_order_uq';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ABORT: canonical storico_session_order_uq is missing';
  END IF;
  IF v_def !~* 'UNIQUE INDEX' OR v_def !~* '\(service_session_id, orden_id\)' OR v_def ~* 'WHERE' THEN
    RAISE EXCEPTION 'ABORT: canonical index is not a non-partial UNIQUE(service_session_id, orden_id): %', v_def;
  END IF;
END $$;

-- 3) drop the legacy UNIQUE index.
DROP INDEX public.storico_orden_id_fecha_key;

-- 4) keep (orden_id, fecha) as a plain NON-UNIQUE lookup index.
CREATE INDEX storico_orden_id_fecha_idx ON public.storico (orden_id, fecha);

-- 5) reload the PostgREST schema cache.
NOTIFY pgrst, 'reload schema';

COMMIT;
