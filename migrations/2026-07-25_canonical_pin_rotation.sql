-- migrations/2026-07-25_canonical_pin_rotation.sql
-- S2-7D2 step A — ONE canonical PIN-rotation protocol for every actor of a workspace.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive. DRAFT — NOT APPLIED. Does not modify any already-applied migration.
--
-- WHY THIS SUPERSEDES THE EARLIER OWNER-ONLY DRAFT
-- An owner-only v2 RPC cannot establish the "no two active actors share a PIN" invariant,
-- because the live auth_admin_set_actor_pin remains a second writer: it locks only
-- (initiator, target) and performs NO cross-actor duplicate check. Interleaving
--   owner-v2 verifies X against rider → owner-v2 locks all, writes X to owner, commits
--   → legacy rider rotation (already waiting) takes its narrower locks and writes X to rider
-- leaves two active actors holding X. One safe ordering is not an invariant. This migration
-- therefore introduces a GENERIC rotation RPC that every mutation path must use; the legacy
-- writer is disabled in a SEPARATE migration, AFTER the backend cutover (see step B).
--
-- HOW THE RACE IS PREVENTED (once step B has landed)
-- Uniqueness cannot be decided in SQL: PIN hashes are scrypt with per-row salts, so equal
-- PINs produce different strings and Postgres cannot re-derive them. Node performs the
-- comparison (accepted B1 verifier) and passes back the EXACT snapshot it verified against.
-- This function then takes the workspace row lock FIRST — serialising every rotation in that
-- workspace — then locks every actor row in deterministic order, and requires each other
-- actor's (active, pin_hash) to be byte-identical to the snapshot. Any drift raises
-- AUTH_ROTATION_STALE (serialization_failure) and nothing is written. Because ALL rotations
-- take the same workspace lock and re-validate the same way, two concurrent rotations to the
-- same PIN cannot both commit regardless of which targets they touch.
--
-- NO plaintext and NO persistent PIN-derived fingerprint is stored: the snapshot is transient
-- input, already-existing service_role data, exactly like a login check.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6A/S2-7D).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D2 refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor: the S2-7D objects must already exist (applied separately).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='auth_actors' AND column_name='workspace_id')
  THEN RAISE EXCEPTION 'S2-7D2 refused: auth_actors.workspace_id absent — apply S2-7D first'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='workspaces'
                    AND column_name='owner_pin_onboarding_completed_at')
  THEN RAISE EXCEPTION 'S2-7D2 refused: onboarding marker absent — apply S2-7D first'; END IF;
END $$;

-- ── canonical rotation RPC ───────────────────────────────────────────────────
-- p_caller_kind:
--   'account_owner'      → p_user_id must hold an ACTIVE workspace_owner membership of the
--                          target's workspace; p_workspace_id must match it; target MUST be
--                          'owner'. Sets the onboarding marker. by_actor/updated_by stay NULL
--                          (the personal account never becomes an actor).
--   'operational_admin'  → p_by_actor must be an ACTIVE admin actor of the SAME workspace
--                          (accepted B6A rule), owner self-change still requires the exact
--                          'CHANGE_OWNER_PIN' phrase. Never touches the onboarding marker.
-- p_seen: jsonb array [{actor, active, pin_hash}] covering EVERY OTHER actor of the workspace.
CREATE OR REPLACE FUNCTION public.auth_set_actor_pin_v2(
  p_target_actor text, p_expected_role text, p_hash text, p_ip_hash text, p_seen jsonb,
  p_caller_kind text, p_user_id uuid DEFAULT NULL, p_workspace_id uuid DEFAULT NULL,
  p_by_actor text DEFAULT NULL, p_confirm text DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_ws_id uuid; v_ws public.workspaces%ROWTYPE;
        v_by public.auth_actors%ROWTYPE; v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE;
        v_event text; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
        v_other record; v_seen jsonb; v_others int := 0; v_seen_count int;
        v_onboarding boolean := false;
BEGIN
  -- ── input guards (mirror the accepted B6A contract) ────────────────────────
  IF p_caller_kind NOT IN ('account_owner','operational_admin')
  THEN RAISE EXCEPTION 'AUTH_CALLER_KIND_INVALID' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR p_target_actor NOT IN ('owner','operator_primary','operator_backup','rider')
  THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  IF p_expected_role NOT IN ('admin','operator','rider')
  THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;
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
  IF p_seen IS NULL OR jsonb_typeof(p_seen) <> 'array'
  THEN RAISE EXCEPTION 'AUTH_SEEN_INVALID' USING ERRCODE='22023'; END IF;

  -- ── resolve the workspace from the TARGET, then serialise on it ────────────
  SELECT workspace_id INTO v_ws_id FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws_id IS NULL THEN RAISE EXCEPTION 'AUTH_ACTOR_WORKSPACE_UNASSIGNED' USING ERRCODE='22023'; END IF;

  -- The workspace row lock is taken by EVERY rotation in this workspace: it is the single
  -- serialisation point that makes the invariant hold across all targets and caller kinds.
  SELECT * INTO v_ws FROM public.workspaces WHERE id = v_ws_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- deterministic actor locking (no deadlock between concurrent rotations)
  PERFORM 1 FROM public.auth_actors WHERE workspace_id = v_ws_id ORDER BY actor FOR UPDATE;

  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.workspace_id IS DISTINCT FROM v_ws_id THEN
    RAISE EXCEPTION 'AUTH_ROTATION_STALE' USING ERRCODE='40001';   -- re-homed while we waited
  END IF;
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- ── authorization, per caller kind ─────────────────────────────────────────
  IF p_caller_kind = 'account_owner' THEN
    IF p_target_actor <> 'owner' THEN RAISE EXCEPTION 'AUTH_ACCOUNT_TARGET_FORBIDDEN' USING ERRCODE='P0001'; END IF;
    IF p_user_id IS NULL THEN RAISE EXCEPTION 'ACCOUNT_USER_REQUIRED' USING ERRCODE='22023'; END IF;
    IF p_workspace_id IS NULL OR p_workspace_id <> v_ws_id
    THEN RAISE EXCEPTION 'WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.workspace_memberships
       WHERE workspace_id = v_ws_id AND user_id = p_user_id
         AND role = 'workspace_owner' AND status = 'active'
    ) THEN RAISE EXCEPTION 'NOT_WORKSPACE_OWNER' USING ERRCODE='P0001'; END IF;
    v_onboarding := true;
  ELSE
    IF p_by_actor IS NULL THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_by.role <> 'admin' THEN RAISE EXCEPTION 'AUTH_NOT_ADMIN' USING ERRCODE='22023'; END IF;
    IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
    IF v_by.workspace_id IS DISTINCT FROM v_ws_id
    THEN RAISE EXCEPTION 'AUTH_INITIATOR_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
    -- accepted B6A rule: owner self-change requires the exact phrase (no normalization)
    IF p_by_actor = 'owner' AND p_target_actor = 'owner'
       AND p_confirm IS DISTINCT FROM 'CHANGE_OWNER_PIN'
    THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;
  END IF;

  -- ── optimistic verification of Node's uniqueness check ─────────────────────
  FOR v_other IN
    SELECT actor, active, pin_hash FROM public.auth_actors
     WHERE workspace_id = v_ws_id AND actor <> p_target_actor ORDER BY actor
  LOOP
    v_others := v_others + 1;
    SELECT e INTO v_seen FROM jsonb_array_elements(p_seen) e
     WHERE e->>'actor' = v_other.actor LIMIT 1;
    IF v_seen IS NULL THEN
      RAISE EXCEPTION 'AUTH_ROTATION_STALE' USING ERRCODE='40001';
    END IF;
    IF ((v_seen->>'active')::boolean) IS DISTINCT FROM v_other.active
       OR (v_seen->>'pin_hash') IS DISTINCT FROM v_other.pin_hash THEN
      RAISE EXCEPTION 'AUTH_ROTATION_STALE' USING ERRCODE='40001';
    END IF;
  END LOOP;

  SELECT count(*) INTO v_seen_count FROM jsonb_array_elements(p_seen);
  IF v_seen_count <> v_others THEN
    RAISE EXCEPTION 'AUTH_ROTATION_STALE' USING ERRCODE='40001';
  END IF;

  -- ── rotate ONLY the requested, already-existing actor ──────────────────────
  v_event := CASE WHEN v_tgt.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change' END;

  UPDATE public.auth_actors
     SET pin_hash = p_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = NULL, updated_at = v_now,
         updated_by = CASE WHEN p_caller_kind = 'operational_admin' THEN p_by_actor ELSE NULL END
   WHERE actor = p_target_actor
   RETURNING * INTO r;   -- active preserved; no actor is ever created here

  -- onboarding completes ONLY for owner via the account-owner path; first completion wins
  IF v_onboarding THEN
    UPDATE public.workspaces
       SET owner_pin_onboarding_completed_at = COALESCE(owner_pin_onboarding_completed_at, v_now),
           updated_at = v_now
     WHERE id = v_ws_id;
  END IF;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES (v_event, p_target_actor,
          CASE WHEN p_caller_kind = 'operational_admin' THEN p_by_actor ELSE NULL END,
          p_ip_hash,
          v_meta || jsonb_build_object('source', p_caller_kind, 'policy', 'six_digit'));

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
    'changed', true, 'event', v_event, 'onboarding_completed', v_onboarding);
END;
$fn$;

-- ── grants: service_role only ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_set_actor_pin_v2(text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_actor_pin_v2(text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
