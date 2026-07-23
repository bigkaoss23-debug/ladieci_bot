-- S2-6A3F ROLLBACK — restore the legacy UNIQUE index on storico(orden_id, fecha).
--
-- DO NOT RUN AUTOMATICALLY. Restoring UNIQUE(orden_id, fecha) re-breaks the
-- multi-service model: two services on the same business date that reuse an order
-- number can no longer both archive (SQLSTATE 23505). The canonical uniqueness is
-- UNIQUE(service_session_id, orden_id); same-day uniqueness on (orden_id, fecha) is
-- intentionally removed and must stay removed while multiple services per day exist.
--
-- This rollback will itself FAIL if duplicate (orden_id, fecha) pairs have since been
-- archived (exactly the multi-service rows this migration enables) — by design: it must
-- not silently discard or collide with real data.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.storico GROUP BY orden_id, fecha HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: duplicate (orden_id, fecha) rows exist (multi-service archives); restoring UNIQUE would break them';
  END IF;
  RAISE WARNING 'Restoring UNIQUE(orden_id, fecha) — this re-breaks multi-service same-day close. Only do this alongside reverting the service-session model.';
END $$;

DROP INDEX IF EXISTS public.storico_orden_id_fecha_idx;

CREATE UNIQUE INDEX storico_orden_id_fecha_key ON public.storico (orden_id, fecha);

NOTIFY pgrst, 'reload schema';

COMMIT;
