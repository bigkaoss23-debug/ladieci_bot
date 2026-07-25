-- migrations/2026-07-26_disable_legacy_pin_rotation.ROLLBACK.sql
-- Rollback for S2-7D2 step B. STAGING ONLY.
--
-- SAFETY: restoring the legacy writer REMOVES the uniqueness invariant again — it locks only
-- (initiator, target) and performs no cross-actor duplicate check, so two active actors could
-- end up sharing a PIN. Only justified to unblock an emergency rollback of the backend
-- cutover. Requires an explicit opt-in for this transaction:
--     SET LOCAL "s2_7d2b.force_rollback" = 'yes';
--
-- It does NOT restore the original B6A body (that would duplicate SQL that already lives in
-- 2026-07-15_auth_admin_access_management.sql). Re-apply the B6A function definition from
-- that migration first, then run this file to restore the grant.
BEGIN;

DO $$
DECLARE v_force text := current_setting('s2_7d2b.force_rollback', true);
BEGIN
  IF COALESCE(v_force, '') <> 'yes' THEN
    RAISE EXCEPTION 'S2-7D2B rollback refused: re-enabling auth_admin_set_actor_pin removes the PIN-uniqueness invariant. Set LOCAL "s2_7d2b.force_rollback"=''yes'' to override.'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='auth_admin_set_actor_pin'
       AND pg_get_functiondef(p.oid) LIKE '%AUTH_LEGACY_PIN_ROTATION_DISABLED%'
  ) THEN
    RAISE EXCEPTION 'S2-7D2B rollback refused: the deprecation stub is still installed. Re-apply the original B6A body from 2026-07-15_auth_admin_access_management.sql first, then rerun this rollback.'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
