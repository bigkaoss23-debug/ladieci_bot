-- migrations/2026-07-25_operational_pin_uniqueness.ROLLBACK.sql
-- Rollback for S2-7D2. STAGING ONLY. Drops ONLY the new v2 RPC.
--
-- SAFETY: this removes the race-safe uniqueness path. If the backend deployed against it is
-- still live it would fall back to the S2-7D v1 RPC, which performs NO uniqueness check —
-- so this rollback refuses unless the operator explicitly opts in for this transaction:
--     SET LOCAL "s2_7d2.force_rollback" = 'yes';
-- It never touches actors, PIN hashes, workspaces, memberships, the onboarding marker or any
-- audit row; no PIN is rotated or invalidated.
BEGIN;

DO $$
DECLARE v_force text := current_setting('s2_7d2.force_rollback', true);
BEGIN
  IF COALESCE(v_force, '') <> 'yes' THEN
    RAISE EXCEPTION 'S2-7D2 rollback refused: dropping auth_account_set_owner_pin_v2 removes the only race-safe PIN-uniqueness path. Set LOCAL "s2_7d2.force_rollback"=''yes'' to override (and redeploy the backend off the v2 path first).'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.auth_account_set_owner_pin_v2(uuid, uuid, text, text, jsonb, jsonb);

NOTIFY pgrst, 'reload schema';

COMMIT;
