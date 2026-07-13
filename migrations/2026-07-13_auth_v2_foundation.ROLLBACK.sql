-- migrations/2026-07-13_auth_v2_foundation.ROLLBACK.sql
-- Guarded rollback for B0.   ***STAGING ONLY***
-- REFUSES if real auth data exists. Do NOT run blindly. Do NOT run as part of B0.
BEGIN;
DO $$
DECLARE v_pin int:=0; v_audit int:=0; v_mod int:=0;
BEGIN
  IF to_regclass('public.auth_actors') IS NOT NULL THEN
    SELECT count(*) INTO v_pin FROM public.auth_actors WHERE pin_hash IS NOT NULL;
    SELECT count(*) INTO v_mod FROM public.auth_actors
      WHERE session_version <> 1 OR updated_by IS NOT NULL OR active = false;
  END IF;
  IF to_regclass('public.auth_audit') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.auth_audit;
  END IF;
  IF v_pin > 0 OR v_audit > 0 OR v_mod > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: pin_hash=%, audit_rows=%, modified_actors=% present. Manual review required.', v_pin, v_audit, v_mod;
  END IF;
END $$;
drop table if exists public.auth_audit;
drop table if exists public.auth_actors;
COMMIT;
