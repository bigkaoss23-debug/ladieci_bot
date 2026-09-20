-- migrations/2026-09-19_fdv1_giro_atomic_v1.ROLLBACK.sql
-- Exact inverse of 2026-09-19_fdv1_giro_atomic_v1.sql. The forward migration ONLY creates functions
-- (no table / column / trigger / data change), so the rollback only drops them: afterwards the schema is
-- byte-identical to the state before the forward migration (proved by the PG test harness with a
-- catalog fingerprint + a row checksum of ordenes / manual_giros).
--
-- ORDER: redeploy the previous backend FIRST (it does not call these functions), then run this file.
-- Running it while the new backend is live makes every giro mutation fail CLOSED (503 giro_atomic_unavailable).
--
-- NOT APPLIED to any database by this commit/branch.

BEGIN;

DROP FUNCTION IF EXISTS public.giro_reconcile_v1(boolean);
DROP FUNCTION IF EXISTS public.giro_dissolve_v1(text);
DROP FUNCTION IF EXISTS public.giro_remove_member_v1(text);
DROP FUNCTION IF EXISTS public.giro_add_member_v1(text, text, integer, boolean);
DROP FUNCTION IF EXISTS public.giro_create_v1(text[], text, date, boolean, boolean);
DROP FUNCTION IF EXISTS public.giro_settle_v1(text, boolean);
DROP FUNCTION IF EXISTS public.giro_eligible_v1(text, text);
DROP FUNCTION IF EXISTS public.giro_lock_v1();

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname LIKE 'giro\_%\_v1') THEN
    RAISE EXCEPTION 'FDV1_GIRO_ATOMIC rollback verify failed: a giro_*_v1 function is still present';
  END IF;
END $verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
