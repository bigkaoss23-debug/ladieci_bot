-- migrations/2026-07-26_disable_legacy_pin_rotation.ROLLBACK.sql
-- Rollback for S2-7D2 step B — EMERGENCY ONLY. STAGING ONLY.
--
-- ══ READ BEFORE RUNNING ═════════════════════════════════════════════════════
-- This file restores EXECUTE on writers that were deliberately fail-closed. Consequences:
--   * restoring ANY old PIN writer (auth_admin_set_actor_pin, auth_account_set_owner_pin,
--     auth_set_pin_hash, auth_consume_recovery_window) REMOVES the PIN-uniqueness invariant:
--     none of them takes the canonical workspace lock or performs a cross-actor duplicate
--     check, so two active actors can end up sharing a PIN;
--   * restoring the active-state writers (auth_set_active, auth_admin_set_actor_active) or
--     the recovery writer MAY PRODUCE ACTIVE DUPLICATE PINs WITHOUT ANY ROTATION: an inactive
--     actor may already hold an active actor's PIN, and reactivating it creates the duplicate
--     directly;
--   * this rollback is justified only to unblock an emergency rollback of the backend
--     cutover. It is NOT a normal operational step.
--
-- It deliberately does NOT recreate the original function bodies. Re-apply them first from
-- their source migrations (below), so the restored behaviour is exactly the reviewed code and
-- not something re-typed here:
--   auth_admin_set_actor_pin, auth_admin_set_actor_active
--       → migrations/2026-07-15_auth_admin_access_management.sql
--   auth_account_set_owner_pin
--       → migrations/2026-07-24_workspace_owner_pin.sql
--   auth_set_pin_hash
--       → migrations/2026-07-13_auth_rpc.sql
--   auth_set_active
--       → migrations/2026-07-13_auth_active_events.sql   (replaces the auth_rpc.sql version)
--   auth_consume_recovery_window
--       → migrations/2026-07-14_auth_recovery_windows.sql
--
-- Required opt-in for this transaction:
--     SET LOCAL "s2_7d2b.force_rollback" = 'yes';
-- ════════════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  v_force text := current_setting('s2_7d2b.force_rollback', true);
  v_names constant text[] := ARRAY[
    'auth_admin_set_actor_pin', 'auth_account_set_owner_pin', 'auth_set_pin_hash',
    'auth_set_active', 'auth_admin_set_actor_active', 'auth_consume_recovery_window'];
  v_markers constant text[] := ARRAY[
    'AUTH_LEGACY_PIN_ROTATION_DISABLED', 'AUTH_ACCOUNT_OWNER_PIN_V1_DISABLED',
    'AUTH_DIRECT_PIN_HASH_WRITE_DISABLED', 'AUTH_DIRECT_ACTOR_ACTIVE_WRITE_DISABLED',
    'AUTH_ADMIN_ACTOR_ACTIVE_DISABLED', 'AUTH_OPERATIONAL_RECOVERY_DISABLED'];
  v_i int; v_still text := '';
BEGIN
  -- (1) explicit force
  IF COALESCE(v_force, '') <> 'yes' THEN
    RAISE EXCEPTION 'S2-7D2B rollback refused: re-enabling these writers removes the PIN-uniqueness invariant and may allow ACTIVE duplicate PINs. Emergency use only — SET LOCAL "s2_7d2b.force_rollback"=''yes'' to override.'
      USING ERRCODE = 'P0001';
  END IF;

  -- (2) the backend must already be redeployed away from anything that relies on the
  -- disabled state. That cannot be proven from SQL, so it is asserted explicitly by the
  -- operator through a second setting — a deliberate, auditable statement of intent.
  IF COALESCE(current_setting('s2_7d2b.backend_reverted', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'S2-7D2B rollback refused: redeploy the backend off the canonical-only assumption FIRST, then assert it with SET LOCAL "s2_7d2b.backend_reverted"=''yes''.'
      USING ERRCODE = 'P0001';
  END IF;

  -- (3)+(4) refuse while ANY fail-closed stub is still installed: grants must never be
  -- restored on a stub, and the original bodies must be re-applied from their source
  -- migrations first (see the header list).
  FOR v_i IN 1 .. array_length(v_names, 1) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = v_names[v_i]
         AND pg_get_functiondef(p.oid) LIKE '%' || v_markers[v_i] || '%'
    ) THEN
      v_still := v_still || v_names[v_i] || ' ';
    END IF;
  END LOOP;
  IF v_still <> '' THEN
    RAISE EXCEPTION 'S2-7D2B rollback refused: fail-closed stub(s) still installed for: %. Re-apply the ORIGINAL bodies from their source migrations first (see this file''s header), then rerun this rollback to restore grants.', btrim(v_still)
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- (5) Only now: restore the required grants, explicitly, one function at a time.
-- ─────────────────────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_account_set_owner_pin(uuid, uuid, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_set_pin_hash(text, text, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_set_active(text, boolean, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_admin_set_actor_active(text, text, text, boolean, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_consume_recovery_window(text, text, text, text, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
