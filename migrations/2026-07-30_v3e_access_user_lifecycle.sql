-- migrations/2026-07-30_v3e_access_user_lifecycle.sql
-- Access Control V3 -- Block V3-E: access-user lifecycle foundation, DRAFT ONLY, NOT
-- APPLIED.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- SCOPE. V3-E creates the dormant foundation for deactivateAccessUser /
-- reactivateAccessUser / clearAccessUserCredential. It does NOT:
--   * alter any existing actor row merely by being applied -- no UPDATE/DELETE of
--     auth_actors or auth_actor_pin_fingerprints data anywhere in this file;
--   * widen auth_audit_event_chk -- 'user_deactivated', 'user_reactivated',
--     'credential_cleared' and 'session_invalidated' were ALL already reserved by
--     V3-A's widening specifically for this future phase (see that migration's "new V3
--     vocabulary" comment) and are already live on the CHECK. This migration adds no
--     new event name;
--   * touch auth_set_active or auth_admin_set_actor_active (the LIVE legacy B2/B6
--     active-state writers, which use the DISTINCT legacy events 'actor_disabled'/
--     'actor_enabled') -- deliberately a separate event vocabulary, so an audit row can
--     always be traced to which writer produced it;
--   * touch auth_set_actor_pin_v2, auth_set_actor_pin_v3, auth_change_actor_role_v3,
--     auth_create_access_user_v3, or auth_rename_access_user_v3 in any way;
--   * wire either new RPC into any current route.
--
-- WHAT THIS FILE DOES.
--   1. Creates auth_set_access_user_active_v3: one canonical active-state writer for
--      both directions, distinguished by a boolean parameter and by DISTINCT stable
--      idempotency action identifiers (deactivate_access_user_v3 /
--      reactivate_access_user_v3) -- not two separate RPCs, per the "prefer clear
--      canonical RPCs... a separate deactivate/reactivate RPC only if materially safer"
--      guidance. Unlike the legacy auth_set_active (which bumps session_version only on
--      disable), this RPC bumps it on BOTH directions -- deliberately: every lifecycle
--      state transition is treated as a fresh session epoch. This is a genuinely new,
--      stricter policy for the NEW writer; the legacy RPC's own (looser) behavior is
--      untouched. auth_admin_set_actor_active (B6) already independently bumps on both
--      directions too, so this is not a novel invention, just consistent with the more
--      recent precedent.
--   2. Creates auth_clear_access_user_credential_v3: explicit, separate from
--      deactivation. Clears pin_hash, deletes every auth_actor_pin_fingerprints row for
--      the target (releasing the PIN for reuse), resets failed_count/locked_until, and
--      bumps session_version once -- all atomically. Works on an active OR inactive
--      target.
--   3. Both RPCs share the identical deterministic-lock / role-based owner-authorization
--      / cross-workspace-refusal / session-bound-idempotency discipline as
--      auth_change_actor_role_v3 (V3-C) and the V3-D writers.
BEGIN;

-- Staging-positive guard (same sentinel as every prior auth migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-E refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor (auth_create_access_user_v3, the definitive artifact V3-D's
-- migration creates) and the same "4 legacy rows haven't drifted" precondition every
-- prior auth migration in this family checks.
DO $$
DECLARE v_bad int; v_v3d_found int;
BEGIN
  SELECT count(*) INTO v_v3d_found FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auth_create_access_user_v3';
  IF v_v3d_found <> 1 THEN
    RAISE EXCEPTION 'V3-E refused: auth_create_access_user_v3 not found — apply V3-D first' USING ERRCODE='P0001';
  END IF;

  SELECT count(*) INTO v_bad FROM (VALUES
    ('owner','admin'), ('operator_primary','operator'), ('operator_backup','operator'), ('rider','rider')
  ) AS expected(actor, role)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.auth_actors a WHERE a.actor = expected.actor AND a.role = expected.role
  );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'V3-E refused: legacy auth_actors rows do not match the expected pre-V3-E shape — investigate before migrating' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1) auth_set_access_user_active_v3 -- dormant canonical active-state RPC ────
CREATE OR REPLACE FUNCTION public.auth_set_access_user_active_v3(
  p_workspace_id uuid, p_by_actor text, p_target_actor text,
  p_expected_active boolean, p_requested_active boolean,
  p_by_sid_hash text, p_client_request_id text, p_request_hash text,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ws public.workspaces%ROWTYPE;
  v_by public.auth_actors%ROWTYPE;
  v_tgt public.auth_actors%ROWTYPE;
  v_idem public.access_management_idempotency%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_action text;
  v_event text;
  v_changed boolean;
  r public.auth_actors%ROWTYPE;
  v_result jsonb;
BEGIN
  -- ── input guards ──────────────────────────────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR btrim(p_target_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  IF p_expected_active IS NULL THEN RAISE EXCEPTION 'AUTH_EXPECTED_ACTIVE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_requested_active IS NULL THEN RAISE EXCEPTION 'AUTH_REQUESTED_ACTIVE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_sid_hash IS NULL OR btrim(p_by_sid_hash) = '' OR length(p_by_sid_hash) > 64
  THEN RAISE EXCEPTION 'AUTH_SID_HASH_INVALID' USING ERRCODE='22023'; END IF;
  IF p_client_request_id IS NULL OR btrim(p_client_request_id) = '' OR length(p_client_request_id) > 128
  THEN RAISE EXCEPTION 'AUTH_CLIENT_REQUEST_ID_INVALID' USING ERRCODE='22023'; END IF;
  IF p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'AUTH_REQUEST_HASH_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip',
       'confirmation','fingerprint','pin_fingerprint','fingerprint_key','hmac_key',
       'proof','step_up_proof','sid','display_name']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  -- stable idempotency action identifier, decided by the REQUESTED direction
  v_action := CASE WHEN p_requested_active THEN 'reactivate_access_user_v3' ELSE 'deactivate_access_user_v3' END;

  -- ── workspace row lock — the serialisation point ──────────────────────────
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- ── idempotency lookup, already serialised by the workspace lock above ────
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = v_action AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_idem.request_hash = p_request_hash THEN
      RETURN v_idem.response_body; -- safe replay: no mutation, no new audit
    ELSE
      RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;

  -- ── deterministic actor-id locking — acting + target, ordered ─────────────
  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- ── acting actor — owner semantics decided by ROLE, never the actor id ────
  IF v_by.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_INITIATOR_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  IF v_by.role NOT IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_NOT_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── target — same workspace, never owner semantics (by ROLE, never actor id) ──
  IF v_tgt.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_TARGET_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_tgt.role IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_TARGET_IS_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── expected active state must match the locked, authoritative target row ─
  IF v_tgt.active <> p_expected_active THEN RAISE EXCEPTION 'AUTH_TARGET_STATE_MISMATCH' USING ERRCODE='22023'; END IF;

  v_changed := (v_tgt.active <> p_requested_active);

  IF NOT v_changed THEN
    -- identical current/requested state — deterministic no-op, no session_version
    -- bump, no audit row.
    v_result := jsonb_build_object(
      'actor', v_tgt.actor, 'active', v_tgt.active, 'role', v_tgt.role,
      'session_version', v_tgt.session_version, 'failed_count', v_tgt.failed_count,
      'locked_until', v_tgt.locked_until, 'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by
    );
  ELSE
    -- real state change — ONLY active + session_version on the TARGET row. role,
    -- display_name, pin_hash, fingerprint rows, failed_count, locked_until, actor,
    -- workspace_id, created_at, created_by: untouched.
    v_event := CASE WHEN p_requested_active THEN 'user_reactivated' ELSE 'user_deactivated' END;

    UPDATE public.auth_actors
       SET active = p_requested_active, session_version = session_version + 1,
           updated_at = v_now, updated_by = p_by_actor
     WHERE actor = p_target_actor
     RETURNING * INTO r;

    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES (v_event, p_target_actor, p_by_actor, NULL,
            v_meta || jsonb_build_object(
              'old_active', v_tgt.active, 'new_active', p_requested_active,
              'workspace_id', p_workspace_id, 'client_request_id', p_client_request_id
            ));

    -- No global session invalidation: only the TARGET's session_version moved.
    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES ('session_invalidated', p_target_actor, p_by_actor, NULL,
            jsonb_build_object('workspace_id', p_workspace_id, 'session_version', r.session_version));

    v_result := jsonb_build_object(
      'actor', r.actor, 'active', r.active, 'role', r.role,
      'session_version', r.session_version, 'failed_count', r.failed_count,
      'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by
    );
  END IF;

  INSERT INTO public.access_management_idempotency
    (workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body)
  VALUES (p_workspace_id, p_by_actor, p_by_sid_hash, v_action, p_client_request_id, p_request_hash, 200, v_result);

  RETURN v_result;
END;
$fn$;

-- ── 2) auth_clear_access_user_credential_v3 -- dormant canonical credential-clear RPC ──
-- p_expected_session_version is the target's optimistic-concurrency staleness token
-- (simpler than the multi-actor "seen" snapshot the PIN-rotation RPCs use, because this
-- operation only ever touches ONE actor's own credential state, never compares it
-- against any other actor).
CREATE OR REPLACE FUNCTION public.auth_clear_access_user_credential_v3(
  p_workspace_id uuid, p_by_actor text, p_target_actor text, p_expected_session_version int,
  p_by_sid_hash text, p_client_request_id text, p_request_hash text,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ws public.workspaces%ROWTYPE;
  v_by public.auth_actors%ROWTYPE;
  v_tgt public.auth_actors%ROWTYPE;
  v_idem public.access_management_idempotency%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_has_credential boolean;
  r public.auth_actors%ROWTYPE;
  v_result jsonb;
BEGIN
  -- ── input guards ──────────────────────────────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR btrim(p_target_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  IF p_expected_session_version IS NULL OR p_expected_session_version < 1
  THEN RAISE EXCEPTION 'AUTH_EXPECTED_SESSION_VERSION_INVALID' USING ERRCODE='22023'; END IF;
  IF p_by_sid_hash IS NULL OR btrim(p_by_sid_hash) = '' OR length(p_by_sid_hash) > 64
  THEN RAISE EXCEPTION 'AUTH_SID_HASH_INVALID' USING ERRCODE='22023'; END IF;
  IF p_client_request_id IS NULL OR btrim(p_client_request_id) = '' OR length(p_client_request_id) > 128
  THEN RAISE EXCEPTION 'AUTH_CLIENT_REQUEST_ID_INVALID' USING ERRCODE='22023'; END IF;
  IF p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'AUTH_REQUEST_HASH_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  -- No plaintext PIN parameter exists on this function at all (see signature above);
  -- the meta blocklist below is additional defense-in-depth against a caller trying to
  -- smuggle credential material through the free-form audit metadata.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip',
       'confirmation','fingerprint','pin_fingerprint','fingerprint_key','hmac_key',
       'proof','step_up_proof','sid','display_name']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  -- ── workspace row lock — the serialisation point ──────────────────────────
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- ── idempotency lookup, already serialised by the workspace lock above ────
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = 'clear_access_user_credential_v3' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_idem.request_hash = p_request_hash THEN
      RETURN v_idem.response_body; -- safe replay: no mutation, no new audit
    ELSE
      RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;

  -- ── deterministic actor-id locking — acting + target, ordered ─────────────
  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- ── acting actor — owner semantics decided by ROLE, never the actor id ────
  IF v_by.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_INITIATOR_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  IF v_by.role NOT IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_NOT_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── target — same workspace, never owner semantics (by ROLE, never actor id) ──
  -- Works on an ACTIVE or INACTIVE target -- no active check here, deliberately.
  IF v_tgt.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_TARGET_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_tgt.role IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_TARGET_IS_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── stale-snapshot check against the locked, authoritative target row ─────
  IF v_tgt.session_version <> p_expected_session_version THEN
    RAISE EXCEPTION 'AUTH_TARGET_STALE' USING ERRCODE='40001'; END IF;

  v_has_credential := (v_tgt.pin_hash IS NOT NULL)
    OR EXISTS (SELECT 1 FROM public.auth_actor_pin_fingerprints WHERE actor = p_target_actor);

  IF NOT v_has_credential THEN
    -- no credential exists — deterministic no-op, no session_version bump, no audit.
    v_result := jsonb_build_object(
      'actor', v_tgt.actor, 'role', v_tgt.role, 'active', v_tgt.active,
      'session_version', v_tgt.session_version, 'failed_count', v_tgt.failed_count,
      'locked_until', v_tgt.locked_until, 'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by
    );
  ELSE
    -- real clear — pin_hash/failed_count/locked_until/session_version on the TARGET
    -- row, plus every fingerprint row for the target, across all key ids. role,
    -- active, display_name, actor, workspace_id, created_at, created_by: untouched.
    UPDATE public.auth_actors
       SET pin_hash = NULL, failed_count = 0, locked_until = NULL,
           session_version = session_version + 1, updated_at = v_now, updated_by = p_by_actor
     WHERE actor = p_target_actor
     RETURNING * INTO r;

    DELETE FROM public.auth_actor_pin_fingerprints WHERE actor = p_target_actor;

    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES ('credential_cleared', p_target_actor, p_by_actor, NULL,
            v_meta || jsonb_build_object(
              'workspace_id', p_workspace_id, 'client_request_id', p_client_request_id
            ));

    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES ('session_invalidated', p_target_actor, p_by_actor, NULL,
            jsonb_build_object('workspace_id', p_workspace_id, 'session_version', r.session_version));

    v_result := jsonb_build_object(
      'actor', r.actor, 'role', r.role, 'active', r.active,
      'session_version', r.session_version, 'failed_count', r.failed_count,
      'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by
    );
  END IF;

  INSERT INTO public.access_management_idempotency
    (workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body)
  VALUES (p_workspace_id, p_by_actor, p_by_sid_hash, 'clear_access_user_credential_v3', p_client_request_id, p_request_hash, 200, v_result);

  RETURN v_result;
END;
$fn$;

-- ── grants: service_role only ─────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.auth_clear_access_user_credential_v3(uuid, text, text, int, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_clear_access_user_credential_v3(uuid, text, text, int, text, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
