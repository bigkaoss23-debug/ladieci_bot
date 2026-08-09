-- migrations/2026-08-09_service_lifecycle_v3_table_release.ROLLBACK.sql
-- Reverts 2026-08-09_service_lifecycle_v3_table_release.sql: drops
-- mesa_release_empty_session_auto_v1. Nothing else was created by the
-- forward migration.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 table release rollback refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regprocedure('public.mesa_release_empty_session_auto_v1(uuid,uuid)') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 table release rollback refused: mesa_release_empty_session_auto_v1 not found — nothing to roll back, or already rolled back'; END IF;
END $$;

DROP FUNCTION public.mesa_release_empty_session_auto_v1(uuid,uuid);

COMMIT;
