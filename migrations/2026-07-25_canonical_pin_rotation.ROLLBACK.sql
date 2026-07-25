-- migrations/2026-07-25_canonical_pin_rotation.ROLLBACK.sql
-- Rollback for S2-7D2 step A. STAGING ONLY. Drops ONLY the canonical rotation RPC.
--
-- SAFETY: only valid while the legacy writer is still enabled (i.e. step B has NOT been
-- applied) AND no deployed backend routes rotations through v2 — otherwise every PIN
-- rotation breaks. Refuses unless the operator opts in for this transaction:
--     SET LOCAL "s2_7d2a.force_rollback" = 'yes';
-- Never touches actors, PIN hashes, workspaces, memberships, the onboarding marker or audit.
BEGIN;

DO $$
DECLARE v_force text := current_setting('s2_7d2a.force_rollback', true);
        v_legacy_disabled boolean;
BEGIN
  IF COALESCE(v_force, '') <> 'yes' THEN
    RAISE EXCEPTION 'S2-7D2A rollback refused: dropping auth_set_actor_pin_v2 removes the canonical rotation path. Redeploy the backend off v2 first, then SET LOCAL "s2_7d2a.force_rollback"=''yes''.'
      USING ERRCODE = 'P0001';
  END IF;
  -- Extra safety: if step B already disabled the legacy writer, dropping v2 would leave NO
  -- working PIN-rotation path at all.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='auth_admin_set_actor_pin'
       AND pg_get_functiondef(p.oid) LIKE '%AUTH_LEGACY_PIN_ROTATION_DISABLED%'
  ) INTO v_legacy_disabled;
  IF v_legacy_disabled THEN
    RAISE EXCEPTION 'S2-7D2A rollback refused: the legacy writer is already disabled (step B). Roll back step B first, otherwise no PIN rotation path would remain.'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.auth_set_actor_pin_v2(text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb);

NOTIFY pgrst, 'reload schema';

COMMIT;
