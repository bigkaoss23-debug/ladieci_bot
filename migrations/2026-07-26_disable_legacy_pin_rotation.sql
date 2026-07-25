-- migrations/2026-07-26_disable_legacy_pin_rotation.sql
-- S2-7D2 step B — close the legacy PIN write path. STAGING ONLY. DRAFT — NOT APPLIED.
--
-- APPLY THIS ONLY AFTER the backend that routes EVERY owner/operator/rider rotation through
-- public.auth_set_actor_pin_v2 is deployed and verified. Until then the uniqueness invariant
-- does NOT hold: auth_admin_set_actor_pin locks only (initiator, target) and performs no
-- cross-actor duplicate check, so it can still introduce a duplicate behind a v2 caller.
--
-- Two independent stops, because a grant alone can be re-granted and a body alone could be
-- reached by a role that still holds EXECUTE:
--   1. the function body is replaced by a fail-closed deprecation error;
--   2. EXECUTE is revoked from service_role (and re-revoked from PUBLIC/anon/authenticated).
--
-- ONLY the PIN-mutation path is closed. Operational LOGIN is untouched, and the other three
-- B6A admin RPCs (revoke sessions / set active / unlock) keep working unchanged.
BEGIN;

-- Staging-positive guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D2B refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Cutover precondition: the canonical replacement must already exist, otherwise this would
-- leave the deployment with no way to rotate a PIN at all.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'auth_set_actor_pin_v2'
  ) THEN
    RAISE EXCEPTION 'S2-7D2B refused: auth_set_actor_pin_v2 absent — apply step A and deploy the backend cutover first'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1) fail-closed body ──────────────────────────────────────────────────────
-- Signature preserved so any straggler call fails loudly instead of silently resolving to a
-- different overload. It writes nothing.
CREATE OR REPLACE FUNCTION public.auth_admin_set_actor_pin(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_hash text, p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb, p_confirm text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_LEGACY_PIN_ROTATION_DISABLED: use public.auth_set_actor_pin_v2 (S2-7D2)'
    USING ERRCODE = 'P0001';
END;
$fn$;

-- ── 2) revoke execution ──────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
