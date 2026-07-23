-- S2-6A3E — align storico_session_order_uq with the backend's ON CONFLICT target.
--
-- The service-session migration created this unique index PARTIAL
-- (WHERE service_session_id IS NOT NULL). The forced-close archive writes storico via
-- PostgREST upsert `on_conflict=service_session_id,orden_id`, which emits
-- `INSERT ... ON CONFLICT (service_session_id, orden_id) DO UPDATE`. PostgreSQL cannot
-- infer a PARTIAL index for that specification (SQLSTATE 42P10), so every archive write
-- failed and no service could complete its close.
--
-- Fix: replace the partial index with a NON-partial unique index on the same columns.
-- Legacy rows keep service_session_id IS NULL and stay valid: NULLs are DISTINCT under a
-- standard unique index, so multiple legacy (NULL, orden_id) rows remain allowed. No row
-- is deleted or modified. The backend is NOT changed.
BEGIN;

-- 1) guard: refuse if any non-null (service_session_id, orden_id) pair is duplicated,
--    which a full unique index could not hold.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.storico
    WHERE service_session_id IS NOT NULL
    GROUP BY service_session_id, orden_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ABORT: duplicate (service_session_id, orden_id) pairs exist; refusing to build a full unique index';
  END IF;
END $$;

-- 2) build the new non-partial unique index under a temporary name.
CREATE UNIQUE INDEX storico_session_order_uq_new
  ON public.storico (service_session_id, orden_id);

-- 3) drop the old partial index.
DROP INDEX public.storico_session_order_uq;

-- 4) rename the new index to the canonical name the codebase/tests expect.
ALTER INDEX public.storico_session_order_uq_new RENAME TO storico_session_order_uq;

-- 5) reload the PostgREST schema cache so the new conflict target is usable immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
