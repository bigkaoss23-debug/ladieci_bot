-- S2-7B ROLLBACK — remove the additive account/workspace foundation.
--
-- Safe because the foundation is fully additive and, in this block, holds no real data.
-- Guard refuses if any workspace/user/membership row exists, so a rollback can never
-- silently discard real account data once bootstrap has happened.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.workspaces) > 0
     OR (SELECT count(*) FROM public.user_profiles) > 0
     OR (SELECT count(*) FROM public.workspace_memberships) > 0
     OR (SELECT count(*) FROM public.workspace_invitations) > 0
     OR (SELECT count(*) FROM public.platform_roles) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: account/workspace data exists; refusing to drop populated foundation';
  END IF;
END $$;

-- Drop tables FIRST: this removes their RLS policies and constraint triggers, which
-- depend on the helper/trigger functions. Only then can the functions be dropped.
DROP TABLE IF EXISTS public.workspace_account_audit;
DROP TABLE IF EXISTS public.platform_roles;
DROP TABLE IF EXISTS public.workspace_invitations;
DROP TABLE IF EXISTS public.workspace_memberships;
DROP TABLE IF EXISTS public.workspaces;
DROP TABLE IF EXISTS public.user_profiles;

DROP FUNCTION IF EXISTS public.workspace_activation_integrity();
DROP FUNCTION IF EXISTS public.workspace_owner_integrity();
DROP FUNCTION IF EXISTS public.is_workspace_admin_or_owner(uuid);
DROP FUNCTION IF EXISTS public.is_workspace_member(uuid);
DROP FUNCTION IF EXISTS public.is_platform_admin();

NOTIFY pgrst, 'reload schema';

COMMIT;
