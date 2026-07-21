-- 2026-07-20_rider_trip_rpcs.ROLLBACK.sql
-- Drops the three transactional rider trip functions by EXACT signature.
-- MUST NOT be executed during S2-1B.

BEGIN;

DROP FUNCTION IF EXISTS public.start_rider_trip(text);
DROP FUNCTION IF EXISTS public.complete_rider_stop(text, boolean, text);
DROP FUNCTION IF EXISTS public.close_rider_trip(text);
DROP FUNCTION IF EXISTS public.begin_service_close_if_idle();
DROP FUNCTION IF EXISTS public.end_service_close();
DROP FUNCTION IF EXISTS public.delete_order_if_not_active(text);

COMMIT;
