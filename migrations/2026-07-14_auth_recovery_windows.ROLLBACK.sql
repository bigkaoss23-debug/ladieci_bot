-- migrations/2026-07-14_auth_recovery_windows.ROLLBACK.sql
-- Guarded rollback for B5.   ***STAGING ONLY***
-- REFUSES if any recovery window has been consumed (audit/one-shot evidence).
-- Do NOT run blindly. Do NOT run as part of B5. Drops the 2 RPCs + the table.
BEGIN;
DO $$
DECLARE v_consumed int := 0;
BEGIN
  IF to_regclass('public.auth_recovery_windows') IS NOT NULL THEN
    SELECT count(*) INTO v_consumed FROM public.auth_recovery_windows WHERE consumed_at IS NOT NULL;
  END IF;
  IF v_consumed > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % consumed recovery window(s) present. Manual review required.', v_consumed;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.auth_consume_recovery_window(text, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_register_recovery_window(text, text, text, text, timestamptz, jsonb);
DROP TABLE IF EXISTS public.auth_recovery_windows;
COMMIT;
