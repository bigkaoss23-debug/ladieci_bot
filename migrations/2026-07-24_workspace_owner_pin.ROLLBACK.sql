-- migrations/2026-07-24_workspace_owner_pin.ROLLBACK.sql
-- Rollback for S2-7D workspace-owner + admin-PIN onboarding. STAGING ONLY.
-- Drops the two account RPCs and the additive columns/indexes.
--
-- SAFETY (item 12): dropping auth_actors.workspace_id and
-- workspaces.owner_pin_onboarding_completed_at is DESTRUCTIVE once a real claim / PIN
-- onboarding has run (it discards the actor↔workspace association and the onboarding
-- timestamps). This rollback therefore REFUSES to run when that data exists, unless the
-- operator explicitly opts in for this transaction:
--     SET LOCAL "s2_7d.force_rollback" = 'yes';
-- It NEVER deletes a workspace, membership, invitation, audit row or actor PIN — data
-- removal remains a separate, deliberate operation.
BEGIN;

-- Fail closed if association/onboarding data exists and the force flag is not set.
DO $$
DECLARE v_force text := current_setting('s2_7d.force_rollback', true);
        v_assoc int := 0; v_onb int := 0;
BEGIN
  -- Guarded reads: the columns may already be absent if the forward migration never applied.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='auth_actors' AND column_name='workspace_id') THEN
    EXECUTE 'SELECT count(*) FROM public.auth_actors WHERE workspace_id IS NOT NULL' INTO v_assoc;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='workspaces' AND column_name='owner_pin_onboarding_completed_at') THEN
    EXECUTE 'SELECT count(*) FROM public.workspaces WHERE owner_pin_onboarding_completed_at IS NOT NULL' INTO v_onb;
  END IF;

  IF (v_assoc > 0 OR v_onb > 0) AND COALESCE(v_force, '') <> 'yes' THEN
    RAISE EXCEPTION 'S2-7D rollback refused: % actor association(s) and % onboarding marker(s) exist. Set LOCAL "s2_7d.force_rollback"=''yes'' to override.', v_assoc, v_onb
      USING ERRCODE = 'P0001';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.auth_account_set_owner_pin(uuid, uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_account_claim_workspace(uuid, text, text);

DROP INDEX IF EXISTS public.auth_actors_ws_actor_uq;
DROP INDEX IF EXISTS public.auth_actors_workspace_idx;
ALTER TABLE public.auth_actors DROP COLUMN IF EXISTS workspace_id;

-- Onboarding marker (onboarding state only; dropping it removes no ownership/membership data).
ALTER TABLE public.workspaces DROP COLUMN IF EXISTS owner_pin_onboarding_completed_at;

NOTIFY pgrst, 'reload schema';

COMMIT;
