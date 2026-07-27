-- migrations/2026-07-27_order_state_logs_session_identity.ROLLBACK.sql
-- Reverses 2026-07-27_order_state_logs_session_identity.sql.
-- Drops the column and everything derived from it. No data outside
-- orden_estado_logs.service_session_id is affected; log rows themselves are preserved.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D6E rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

DROP TRIGGER IF EXISTS orden_estado_logs_assign_service_session ON public.orden_estado_logs;
DROP FUNCTION IF EXISTS public.orden_estado_logs_assign_service_session();

DROP INDEX IF EXISTS public.orden_estado_logs_session_order_created_idx;
DROP INDEX IF EXISTS public.orden_estado_logs_session_created_idx;

ALTER TABLE public.orden_estado_logs DROP COLUMN IF EXISTS service_session_id;

COMMIT;
