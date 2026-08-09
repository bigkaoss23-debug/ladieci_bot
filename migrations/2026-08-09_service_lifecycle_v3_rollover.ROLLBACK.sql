-- migrations/2026-08-09_service_lifecycle_v3_rollover.ROLLBACK.sql
-- Reverts 2026-08-09_service_lifecycle_v3_rollover.sql: drops
-- ensure_next_service_session_v3, drops the partial unique index, drops the
-- rollover_source_session_id column. Does not touch any pre-existing table,
-- row, or object.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 rollover rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.ensure_next_service_session_v3(uuid,text,date,text,text);
DROP INDEX IF EXISTS public.service_sessions_rollover_source_uq;
ALTER TABLE public.service_sessions DROP COLUMN IF EXISTS rollover_source_session_id;

COMMIT;
