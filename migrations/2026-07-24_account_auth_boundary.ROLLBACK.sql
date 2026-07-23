-- S2-7C ROLLBACK — remove the account-auth boundary hardening + auto-profile.
-- Guarded: refuses if any real account data exists (users/profiles), so a rollback can
-- never run once real accounts have been created.
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM auth.users) > 0
     OR (SELECT count(*) FROM public.user_profiles) > 0
     OR (SELECT count(*) FROM public.workspace_account_audit) > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: account data exists; refusing to undo the account boundary';
  END IF;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();

DROP TRIGGER IF EXISTS workspace_account_audit_no_update ON public.workspace_account_audit;
DROP TRIGGER IF EXISTS workspace_account_audit_no_delete ON public.workspace_account_audit;
DROP FUNCTION IF EXISTS public.workspace_account_audit_append_only();

DROP TRIGGER IF EXISTS user_profiles_guard_trg ON public.user_profiles;
DROP FUNCTION IF EXISTS public.user_profiles_guard();

-- restore S2-7B table-wide UPDATE grant
REVOKE UPDATE (display_name) ON public.user_profiles FROM authenticated;
GRANT UPDATE ON public.user_profiles TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
