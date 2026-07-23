-- S2-7C — Supabase account-auth boundary hardening + auto-profile.
--
-- Additive/hardening only. Touches NOTHING in Auth V2 / PINs / auth_actors / orders /
-- sessions / menu / economia, and does not add workspace_id to operational tables.
--
--   1. user_profiles: an authenticated user may change ONLY display_name; id/created_at
--      are immutable; updated_at is DB-controlled.
--   2. workspace_account_audit: truly append-only — UPDATE/DELETE blocked for EVERYONE,
--      including service_role; INSERT still allowed.
--   3. auto-create public.user_profiles when a Supabase auth.users row is created.
BEGIN;

-- ─── 1) user_profiles: column-level UPDATE + immutability trigger ──────────────
-- S2-7B granted table-wide UPDATE to authenticated; narrow it to display_name only.
REVOKE UPDATE ON public.user_profiles FROM authenticated;
GRANT  UPDATE (display_name) ON public.user_profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.user_profiles_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  -- id and created_at are immutable; updated_at is always DB-owned.
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'USER_PROFILE_ID_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'USER_PROFILE_CREATED_AT_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER user_profiles_guard_trg
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.user_profiles_guard();

-- ─── 2) workspace_account_audit: append-only against ALL roles ────────────────
-- A BEFORE UPDATE/DELETE trigger fires even for service_role (BYPASSRLS bypasses RLS,
-- not triggers), so historical account events cannot be silently rewritten or removed.
-- Exceptional maintenance would disable this trigger via a separate, deliberate procedure
-- (not implemented here).
CREATE OR REPLACE FUNCTION public.workspace_account_audit_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'workspace_account_audit is append-only' USING ERRCODE = '0A000';
END $$;
CREATE TRIGGER workspace_account_audit_no_update
  BEFORE UPDATE ON public.workspace_account_audit
  FOR EACH ROW EXECUTE FUNCTION public.workspace_account_audit_append_only();
CREATE TRIGGER workspace_account_audit_no_delete
  BEFORE DELETE ON public.workspace_account_audit
  FOR EACH ROW EXECUTE FUNCTION public.workspace_account_audit_append_only();

-- ─── 3) auto-create profile on Supabase user creation ─────────────────────────
-- SECURITY DEFINER, fixed search_path, id taken ONLY from NEW.id, no trust in client
-- metadata/roles, idempotent (ON CONFLICT DO NOTHING). Assigns NO platform role, NO
-- workspace, NO membership, NO ownership.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO public.user_profiles (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.handle_new_auth_user() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

NOTIFY pgrst, 'reload schema';

COMMIT;
