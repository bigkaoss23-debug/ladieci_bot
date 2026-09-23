-- migrations/2026-09-23_payment_method_change_v1.ROLLBACK.sql
-- Exact inverse of 2026-09-23_payment_method_change_v1.sql. The forward migration ONLY creates one function
-- (no table / column / trigger / data change), so the rollback only drops it: afterwards the catalog is
-- identical to the state before the forward migration (proved by the payment real harness with a catalog
-- fingerprint + row checksums of ordenes / orden_estado_logs).
--
-- ORDER: redeploy the previous backend FIRST (it does not call this function), then run this file.
-- Running it while the new backend is live makes every explicit payment correction fail CLOSED
-- (payment_atomic_unavailable); finalization (RETIRADO) does not use this function and is unaffected.
--
-- NOT APPLIED to any database by this commit/branch.

BEGIN;

DROP FUNCTION IF EXISTS public.payment_method_change_v1(text, text, text, text, text, text, text);

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'payment_method_change_v1') THEN
    RAISE EXCEPTION 'PAYMENT_METHOD_CHANGE_V1 rollback verify failed: function still present';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
