-- S2-7B — Additive account/workspace foundation.
--
-- Strictly additive: creates the account/workspace layer and its RLS. Touches NOTHING
-- in Auth V2 / PINs / auth_actors / orders / sessions / menu / economia. No operational
-- table gets a workspace_id in this block. No real user/workspace/invitation is inserted.
--
-- Ownership single source of truth: workspace_memberships.role='workspace_owner'
-- (there is deliberately NO workspaces.owner_user_id). At most one ACTIVE owner per
-- workspace (partial unique). An ACTIVE workspace may not lose its only active owner
-- (deferred constraint trigger) while a PROVISIONING workspace may have none — so future
-- atomic ownership transfer stays possible.
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- user_profiles — personal identity, 1:1 with Supabase auth.users. No global role,
-- no credentials (Supabase Auth owns those).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.user_profiles (
  id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text CHECK (display_name IS NULL OR btrim(display_name) <> ''),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- workspaces — one isolated business. No direct owner reference.
--   lifecycle_status: technical  (provisioning → active → closed)
--   commercial_status: commercial (trial | active | grace_period | suspended)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.workspaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE
                      CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  display_name      text NOT NULL CHECK (btrim(display_name) <> ''),
  timezone          text NOT NULL DEFAULT 'Europe/Madrid',
  country           text NOT NULL DEFAULT 'ES' CHECK (country ~ '^[A-Z]{2}$'),
  lifecycle_status  text NOT NULL DEFAULT 'provisioning'
                      CHECK (lifecycle_status IN ('provisioning','active','closed')),
  commercial_status text NOT NULL DEFAULT 'trial'
                      CHECK (commercial_status IN ('trial','active','grace_period','suspended')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- workspace_memberships — ACCOUNT humans only (owner/admin). Operators/riders are
-- PIN actors, not memberships.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.workspace_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('workspace_owner','workspace_admin')),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','removed')),
  invited_by   uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);
-- At most ONE active owner per workspace.
CREATE UNIQUE INDEX workspace_single_active_owner_uq
  ON public.workspace_memberships (workspace_id)
  WHERE role = 'workspace_owner' AND status = 'active';
CREATE INDEX workspace_memberships_user_idx ON public.workspace_memberships (user_id);
CREATE INDEX workspace_memberships_ws_idx   ON public.workspace_memberships (workspace_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- workspace_invitations — claim_owner (bootstrap) vs invite_admin (ordinary).
-- Only the token DIGEST is stored, never the plaintext token.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.workspace_invitations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  email               text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  invitation_kind     text NOT NULL CHECK (invitation_kind IN ('claim_owner','invite_admin')),
  token_digest        text NOT NULL CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  expires_at          timestamptz NOT NULL,
  invited_by          uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  accepted_by_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- No two equivalent PENDING invitations for the same (workspace, email, kind).
CREATE UNIQUE INDEX workspace_invitation_pending_uq
  ON public.workspace_invitations (workspace_id, email, invitation_kind)
  WHERE status = 'pending';
CREATE INDEX workspace_invitations_ws_idx ON public.workspace_invitations (workspace_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- platform_roles — platform staff, SEPARATE table (no is_platform_admin flag).
-- No self-service policy: only service_role / future admin procedure may write.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.platform_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'platform_admin' CHECK (role IN ('platform_admin')),
  assigned_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- workspace_account_audit — append-only account-lifecycle audit (empty in this block).
-- workspace_id nullable + ON DELETE SET NULL so audit survives workspace removal.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.workspace_account_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid REFERENCES public.workspaces(id) ON DELETE SET NULL,
  event          text NOT NULL CHECK (event IN (
                    'workspace_created','owner_claimed','admin_invited','invitation_revoked',
                    'membership_suspended','membership_removed','ownership_transferred',
                    'workspace_status_changed')),
  actor_user_id  uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_account_audit_ws_idx ON public.workspace_account_audit (workspace_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Owner-integrity enforcement (deferred, transfer-friendly).
-- ─────────────────────────────────────────────────────────────────────────────
-- An ACTIVE workspace must always keep exactly-one active owner. Deferred so an
-- atomic transfer (remove old owner + insert new owner in one tx) is allowed; only
-- the end-of-transaction state is checked. PROVISIONING/CLOSED may have none.
CREATE OR REPLACE FUNCTION public.workspace_owner_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_ws uuid; v_life text; v_cnt int;
BEGIN
  v_ws := COALESCE(NEW.workspace_id, OLD.workspace_id);
  SELECT lifecycle_status INTO v_life FROM public.workspaces WHERE id = v_ws;
  IF v_life IS NULL THEN RETURN NULL; END IF;          -- workspace removed (cascade)
  IF v_life = 'active' THEN
    SELECT count(*) INTO v_cnt FROM public.workspace_memberships
     WHERE workspace_id = v_ws AND role = 'workspace_owner' AND status = 'active';
    IF v_cnt = 0 THEN
      RAISE EXCEPTION 'WORKSPACE_ACTIVE_REQUIRES_OWNER (workspace %)', v_ws USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workspace_owner_integrity_trg
  AFTER UPDATE OR DELETE ON public.workspace_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.workspace_owner_integrity();

-- Activating a workspace (or inserting it already active) requires an active owner.
-- Deferred so "insert active workspace + insert owner" in one tx is allowed.
CREATE OR REPLACE FUNCTION public.workspace_activation_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.lifecycle_status = 'active' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_memberships
       WHERE workspace_id = NEW.id AND role = 'workspace_owner' AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'WORKSPACE_ACTIVATE_REQUIRES_OWNER (workspace %)', NEW.id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER workspace_activation_integrity_trg
  AFTER INSERT OR UPDATE ON public.workspaces
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.workspace_activation_integrity();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS helper functions — SECURITY DEFINER to read memberships WITHOUT triggering the
-- policies on workspace_memberships (breaks the memberships⇄workspaces recursion).
-- Fixed search_path, minimal surface, boolean-only, keyed on auth.uid().
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_platform_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.platform_roles WHERE user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_member(p_ws uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
     WHERE workspace_id = p_ws AND user_id = auth.uid() AND status = 'active');
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin_or_owner(p_ws uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workspace_memberships
     WHERE workspace_id = p_ws AND user_id = auth.uid() AND status = 'active'
       AND role IN ('workspace_owner','workspace_admin'));
$$;

-- REVOKE from PUBLIC *and* anon: Supabase default privileges auto-grant EXECUTE on new
-- public functions to anon, so an explicit anon revoke is required (revoking PUBLIC alone
-- leaves the anon grant in place). These helpers must be callable only by signed-in users.
REVOKE ALL ON FUNCTION public.is_platform_admin(), public.is_workspace_member(uuid),
  public.is_workspace_admin_or_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(), public.is_workspace_member(uuid),
  public.is_workspace_admin_or_owner(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.user_profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_memberships    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_invitations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_account_audit  ENABLE ROW LEVEL SECURITY;

-- user_profiles: an account sees / edits ONLY its own profile. No insert/delete by users.
CREATE POLICY user_profiles_self_select ON public.user_profiles
  FOR SELECT TO authenticated USING (id = auth.uid() OR public.is_platform_admin());
CREATE POLICY user_profiles_self_update ON public.user_profiles
  FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

-- workspaces: visible to active members and platform admins. No user writes.
CREATE POLICY workspaces_member_select ON public.workspaces
  FOR SELECT TO authenticated
  USING (public.is_workspace_member(id) OR public.is_platform_admin());

-- memberships: owner/admin see all rows of their workspace; a user always sees their own
-- membership row; platform admin sees all. NO user write policy → admins cannot change
-- owner, and ownership changes happen only via service_role / future procedure.
CREATE POLICY memberships_visible ON public.workspace_memberships
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_workspace_admin_or_owner(workspace_id)
    OR public.is_platform_admin()
  );

-- invitations: visible only to owner/admin of the workspace (or platform admin). No user writes.
CREATE POLICY invitations_visible ON public.workspace_invitations
  FOR SELECT TO authenticated
  USING (public.is_workspace_admin_or_owner(workspace_id) OR public.is_platform_admin());

-- platform_roles: a user may read only their own row; platform admins read all.
-- NO insert/update/delete policy → nobody can self-promote; only service_role writes.
CREATE POLICY platform_roles_self_select ON public.platform_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_platform_admin());

-- account audit: readable by owner/admin of the workspace or platform admin; append-only
-- (no insert/update/delete policy for users → only service_role writes).
CREATE POLICY account_audit_visible ON public.workspace_account_audit
  FOR SELECT TO authenticated
  USING (public.is_workspace_admin_or_owner(workspace_id) OR public.is_platform_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- Grants: anon has NOTHING. authenticated gets RLS-filtered SELECT everywhere plus
-- UPDATE on its own profile. service_role keeps full operational access.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON public.user_profiles, public.workspaces, public.workspace_memberships,
  public.workspace_invitations, public.platform_roles, public.workspace_account_audit
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.user_profiles, public.workspaces, public.workspace_memberships,
  public.workspace_invitations, public.platform_roles, public.workspace_account_audit
  TO authenticated;
GRANT UPDATE ON public.user_profiles TO authenticated;

GRANT ALL ON public.user_profiles, public.workspaces, public.workspace_memberships,
  public.workspace_invitations, public.platform_roles, public.workspace_account_audit
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
