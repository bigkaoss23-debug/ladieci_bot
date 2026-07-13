-- migrations/2026-07-13_auth_rpc.ROLLBACK.sql
-- Guarded rollback for B2 RPCs.   ***STAGING ONLY***
-- Drops ONLY the 5 B2 functions with their exact signatures. Does NOT touch the
-- B0 tables (auth_actors / auth_audit). Do NOT run during normal B2 tests.
BEGIN;
DO $$
BEGIN
  -- Safety: this rollback only removes functions; it must never drop data tables.
  IF to_regclass('public.auth_actors') IS NULL OR to_regclass('public.auth_audit') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: B0 auth tables missing — unexpected state.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.auth_record_failed_attempt(text);
DROP FUNCTION IF EXISTS public.auth_reset_failed_attempts(text);
DROP FUNCTION IF EXISTS public.auth_set_pin_hash(text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_bump_session_version(text, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_set_active(text, boolean, text, jsonb);

COMMIT;
