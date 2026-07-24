-- migrations/2026-07-24_workspace_owner_pin.sql
-- S2-7D — La Dieci workspace ownership + owner/admin operational-PIN onboarding.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive + idempotent. DRAFT — NOT APPLIED. Reconciled against a live read-only audit
-- of staging (2026-07-24): 1 auth user, 0 workspaces/memberships/invitations/platform roles,
-- exactly 4 operational actors ALL with a configured PIN (owner sv=14). Two consequences,
-- both handled below:
--   (A) onboarding state MUST NOT derive from owner.pin_hash (the legacy owner already has a
--       PIN). A dedicated marker `workspaces.owner_pin_onboarding_completed_at` starts NULL on
--       a freshly claimed workspace and is set atomically when the owner submits the PIN.
--   (B) NO migration-time actor backfill (0 workspaces exist). Actors are associated to the
--       workspace ONLY inside the claim transaction, once the workspace row exists.
--
-- Adds: nullable auth_actors.workspace_id → workspaces(id) + guarded indexes;
--       workspaces.owner_pin_onboarding_completed_at (onboarding state ONLY — never an
--       ownership/authorization source; authorization stays the active owner membership);
--       two SECURITY INVOKER, service_role-only RPCs (claim + owner-PIN). The personal
--       account NEVER becomes an auth_actor. Touches NOTHING in orders/ledger/menu/service
--       sessions/orden_estado_logs.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6A).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── 1) additive DDL (no backfill; 0 workspaces exist live) ───────────────────
ALTER TABLE public.auth_actors
  ADD COLUMN IF NOT EXISTS workspace_id uuid
    REFERENCES public.workspaces(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS auth_actors_workspace_idx
  ON public.auth_actors (workspace_id) WHERE workspace_id IS NOT NULL;

-- Belt-and-suspenders for a future multi-tenant shape; harmless single-tenant.
CREATE UNIQUE INDEX IF NOT EXISTS auth_actors_ws_actor_uq
  ON public.auth_actors (workspace_id, actor) WHERE workspace_id IS NOT NULL;

-- Onboarding marker: NULL until the verified owner completes admin-PIN setup for the
-- workspace. Distinct from the legacy actor's pin_hash, which is already non-null.
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS owner_pin_onboarding_completed_at timestamptz;

-- ── 2) RPC — idempotent owner bootstrap ──────────────────────────────────────
-- Given a VERIFIED account user id (resolved by Node from the Supabase bearer, never from
-- a request body), ensure exactly one active La Dieci workspace owned by that account and
-- associate EXACTLY the four operational actors with it — preserving every actor property
-- (pin_hash / role / active / lock / session_version). Idempotent. Fails closed if any
-- actor is already bound to a DIFFERENT workspace.
--
-- Returns jsonb : { workspace_id, membership_id, created, owner_pin_onboarding_completed }
CREATE OR REPLACE FUNCTION public.auth_account_claim_workspace(
  p_user_id uuid, p_slug text, p_display_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_ws public.workspaces%ROWTYPE;
        v_mem public.workspace_memberships%ROWTYPE;
        v_existing_owner uuid;
        v_created boolean := false;
        v_completed boolean := false;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_USER_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_slug IS NULL OR btrim(p_slug) = '' THEN RAISE EXCEPTION 'WORKSPACE_SLUG_REQUIRED' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'ACCOUNT_PROFILE_MISSING' USING ERRCODE='P0002';
  END IF;

  -- Serialize concurrent claims on the same slug.
  PERFORM pg_advisory_xact_lock(hashtextextended('s2_7d_claim:' || lower(p_slug), 0));

  SELECT * INTO v_ws FROM public.workspaces WHERE slug = lower(p_slug);

  IF NOT FOUND THEN
    -- provisioning → owner membership → activate (deferred activation trigger allows this
    -- ordering in one transaction).
    INSERT INTO public.workspaces (slug, display_name, lifecycle_status, commercial_status)
    VALUES (lower(p_slug), COALESCE(NULLIF(btrim(p_display_name),''), p_slug), 'provisioning', 'trial')
    RETURNING * INTO v_ws;
    v_created := true;

    INSERT INTO public.workspace_memberships (workspace_id, user_id, role, status)
    VALUES (v_ws.id, p_user_id, 'workspace_owner', 'active')
    RETURNING * INTO v_mem;

    UPDATE public.workspaces SET lifecycle_status = 'active', updated_at = now()
     WHERE id = v_ws.id RETURNING * INTO v_ws;

    INSERT INTO public.workspace_account_audit (workspace_id, event, actor_user_id, target_user_id, meta)
    VALUES (v_ws.id, 'workspace_created', p_user_id, p_user_id, jsonb_build_object('source','account_bootstrap'));
    INSERT INTO public.workspace_account_audit (workspace_id, event, actor_user_id, target_user_id, meta)
    VALUES (v_ws.id, 'owner_claimed', p_user_id, p_user_id, jsonb_build_object('source','account_bootstrap'));
  ELSE
    -- single-owner enforcement: a DIFFERENT active owner → refuse; same account → no-op.
    SELECT user_id INTO v_existing_owner
      FROM public.workspace_memberships
     WHERE workspace_id = v_ws.id AND role = 'workspace_owner' AND status = 'active'
     LIMIT 1;

    IF v_existing_owner IS NOT NULL AND v_existing_owner <> p_user_id THEN
      RAISE EXCEPTION 'WORKSPACE_ALREADY_OWNED' USING ERRCODE='P0001';
    END IF;

    IF v_existing_owner IS NULL THEN
      INSERT INTO public.workspace_memberships (workspace_id, user_id, role, status)
      VALUES (v_ws.id, p_user_id, 'workspace_owner', 'active')
      ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET role = 'workspace_owner', status = 'active', updated_at = now()
      RETURNING * INTO v_mem;

      IF v_ws.lifecycle_status = 'provisioning' THEN
        UPDATE public.workspaces SET lifecycle_status = 'active', updated_at = now()
         WHERE id = v_ws.id RETURNING * INTO v_ws;
      END IF;

      INSERT INTO public.workspace_account_audit (workspace_id, event, actor_user_id, target_user_id, meta)
      VALUES (v_ws.id, 'owner_claimed', p_user_id, p_user_id, jsonb_build_object('source','account_bootstrap'));
    ELSE
      SELECT * INTO v_mem FROM public.workspace_memberships
       WHERE workspace_id = v_ws.id AND user_id = p_user_id;
    END IF;
  END IF;

  -- Associate EXACTLY the existing actors with this workspace. Fail closed if any actor is
  -- already bound to a different workspace (no cross-workspace reassignment here). Only
  -- unassigned actors are touched → PIN hashes / roles / active / lock / session_version
  -- are all preserved (workspace_id is the sole column written).
  IF EXISTS (SELECT 1 FROM public.auth_actors
              WHERE workspace_id IS NOT NULL AND workspace_id <> v_ws.id) THEN
    RAISE EXCEPTION 'ACTOR_WORKSPACE_CONFLICT' USING ERRCODE='P0001';
  END IF;
  UPDATE public.auth_actors SET workspace_id = v_ws.id WHERE workspace_id IS NULL;

  SELECT (owner_pin_onboarding_completed_at IS NOT NULL) INTO v_completed
    FROM public.workspaces WHERE id = v_ws.id;

  RETURN jsonb_build_object(
    'workspace_id', v_ws.id,
    'membership_id', v_mem.id,
    'created', v_created,
    'owner_pin_onboarding_completed', COALESCE(v_completed, false)
  );
END;
$fn$;

-- ── 3) RPC — create / rotate the owner actor PIN (account-authenticated) ──────
-- Initiator is the VERIFIED account owner (p_user_id resolved by Node from the bearer).
-- SQL re-verifies, under row locks: active owner membership of an active workspace, and the
-- owner actor belongs to that workspace. Rotates the EXISTING owner actor's PIN (never
-- creating a second actor / never NULLing it), bumps session_version once, resets lock/failed
-- count, and — ATOMICALLY in the same transaction — marks onboarding complete on the
-- workspace. Idempotent re-rotation preserves the FIRST completion timestamp (COALESCE), so
-- onboarding is never recreated. The personal account is NEVER written into auth_actors
-- (by_actor / updated_by stay NULL). Plaintext never reaches SQL (Node passes a scrypt hash).
CREATE OR REPLACE FUNCTION public.auth_account_set_owner_pin(
  p_user_id uuid, p_workspace_id uuid, p_hash text, p_ip_hash text,
  p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_ws public.workspaces%ROWTYPE;
        v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE; v_event text; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_USER_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_hash IS NULL OR btrim(p_hash) = '' OR left(p_hash, 7) <> 'scrypt$'
  THEN RAISE EXCEPTION 'AUTH_HASH_INVALID' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_memberships
     WHERE workspace_id = p_workspace_id AND user_id = p_user_id
       AND role = 'workspace_owner' AND status = 'active'
  ) THEN RAISE EXCEPTION 'NOT_WORKSPACE_OWNER' USING ERRCODE='P0001'; END IF;

  SELECT * INTO v_tgt FROM public.auth_actors
   WHERE actor = 'owner' AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.role <> 'admin' THEN RAISE EXCEPTION 'OWNER_ACTOR_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  v_event := CASE WHEN v_tgt.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change' END;

  UPDATE public.auth_actors
     SET pin_hash = p_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = NULL, updated_at = v_now, updated_by = NULL
   WHERE actor = 'owner' AND workspace_id = p_workspace_id
   RETURNING * INTO r;   -- active preserved

  -- Mark onboarding complete atomically with the rotation. First completion wins; a later
  -- rotation keeps the original timestamp and never recreates onboarding.
  UPDATE public.workspaces
     SET owner_pin_onboarding_completed_at = COALESCE(owner_pin_onboarding_completed_at, v_now),
         updated_at = v_now
   WHERE id = p_workspace_id;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES (v_event, 'owner', NULL, p_ip_hash, v_meta || jsonb_build_object('source','account_owner'));

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at,
    'changed', true, 'event', v_event, 'onboarding_completed', true);
END;
$fn$;

-- ── grants: service_role only (Node calls via the service-role PostgREST) ─────
REVOKE ALL ON FUNCTION public.auth_account_claim_workspace(uuid, text, text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_account_set_owner_pin(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_account_claim_workspace(uuid, text, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_account_set_owner_pin(uuid, uuid, text, text, jsonb) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
