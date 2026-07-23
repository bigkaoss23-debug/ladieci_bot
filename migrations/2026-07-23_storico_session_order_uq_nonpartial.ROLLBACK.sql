-- S2-6A3E ROLLBACK — restore the PARTIAL storico_session_order_uq.
--
-- COUPLED PROCEDURE — DO NOT RUN STANDALONE.
-- The partial index (WHERE service_session_id IS NOT NULL) is incompatible with the
-- current backend, which upserts storico via `ON CONFLICT (service_session_id, orden_id)`
-- and needs a NON-partial index to infer the conflict target. Recreating the partial index
-- re-introduces SQLSTATE 42P10 on every service close.
--
-- Only apply this rollback as part of a coordinated change that FIRST ships a backend
-- which no longer relies on that conflict target (e.g. explicit predicate handling or a
-- delete-then-insert archive path). Never run it automatically after the forward fix.
BEGIN;

DO $$
BEGIN
  RAISE WARNING 'storico_session_order_uq is being reverted to PARTIAL; the current backend close path will break unless a compatible backend is deployed first.';
END $$;

CREATE UNIQUE INDEX storico_session_order_uq_partial
  ON public.storico (service_session_id, orden_id)
  WHERE service_session_id IS NOT NULL;

DROP INDEX public.storico_session_order_uq;

ALTER INDEX public.storico_session_order_uq_partial RENAME TO storico_session_order_uq;

NOTIFY pgrst, 'reload schema';

COMMIT;
