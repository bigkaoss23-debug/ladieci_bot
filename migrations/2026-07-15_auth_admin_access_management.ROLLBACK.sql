-- migrations/2026-07-15_auth_admin_access_management.ROLLBACK.sql
-- Guarded rollback for B6A routine admin access management.  ***STAGING ONLY***
-- (tdikhfeinufaahagmpjz). Drops ONLY the four B6A RPCs. Touches NO table, NO
-- data, NO audit row, NO audit constraint, NO other function. Audit evidence
-- written by these RPCs (pin_set/pin_change/revoke/actor_enabled/actor_disabled/
-- actor_unlocked) is append-only and intentionally preserved. Do NOT run in tests.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.auth_actors') IS NULL OR to_regclass('public.auth_audit') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: auth tables missing — unexpected state.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.auth_admin_revoke_actor_sessions(text, text, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.auth_admin_set_actor_active(text, text, text, boolean, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_admin_unlock_actor(text, text, text, text, jsonb);

COMMIT;
