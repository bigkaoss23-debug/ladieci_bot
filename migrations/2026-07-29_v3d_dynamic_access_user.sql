-- migrations/2026-07-29_v3d_dynamic_access_user.sql
-- Access Control V3 -- Block V3-D: dynamic access-user foundation, DRAFT ONLY, NOT
-- APPLIED.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- SCOPE. V3-D lifts the fixed four-actor identity ceiling and creates the dormant
-- foundation for creating/renaming a dynamic access user. It does NOT:
--   * rewrite any existing actor id, role, pin_hash, fingerprint row, session_version,
--     active, failed_count, locked_until, or display_name -- no UPDATE of auth_actors
--     data anywhere in this file, only additive/widening DDL;
--   * assign a PIN or create a fingerprint row for anyone;
--   * wire auth_create_access_user_v3 or auth_rename_access_user_v3 into any current
--     route -- both are additive and completely unreferenced by index.js/login.js/
--     current PIN or role routes;
--   * touch auth_set_actor_pin_v2, auth_set_actor_pin_v3, or auth_change_actor_role_v3
--     in any way;
--   * allow a dynamic (UUID) actor to ever hold admin/owner/operator/legacy_operator --
--     the widened auth_actors_actor_role_map-equivalent logic below still pins the
--     owner semantics to the legacy 'owner' actor id alone.
--
-- WHAT THIS FILE DOES.
--   1. Widens every actor-identity CHECK that currently accepts ONLY the 4 legacy
--      literals to ALSO accept a canonical-lowercase-UUID text form: auth_actors.actor
--      (the PK itself), auth_actors.created_by, auth_actors.updated_by,
--      auth_audit.target_actor, auth_audit.by_actor. Nothing about the EXISTING 4 rows
--      changes -- they already satisfy the widened form (it is a strict superset of the
--      old one).
--   2. Adds auth_actors_display_name_chk: every row's display_name (existing 4 included)
--      must already be trimmed, non-empty, control-character-free, and <= 120 chars --
--      the SAME bound documented in src/auth/accessUserDisplayName.js's
--      MAX_DISPLAY_NAME_LENGTH (keep these two numbers in sync by hand; SQL and Node
--      cannot literally share one constant). The 4 legacy display_name values already
--      satisfy this (set in V3-A), so this CHECK is added, not violated, on apply.
--   3. Creates auth_create_access_user_v3: server-generates the new actor's UUID
--      (gen_random_uuid()::text -- the client never chooses or submits an id), inserts
--      exactly one auth_actors row with frozen safe defaults (active=true,
--      session_version=1, failed_count=0, locked_until=NULL, pin_hash=NULL), writes one
--      user_created audit row, and records the mutation + its idempotency response in
--      one transaction.
--   4. Creates auth_rename_access_user_v3: changes ONLY display_name (+ updated_at/
--      updated_by) on an existing actor in the caller's workspace -- including the
--      owner renaming themselves -- never role/active/session_version/pin_hash/
--      fingerprints/failed_count/locked_until.
BEGIN;

-- Staging-positive guard (same sentinel as every prior auth migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-D refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor (auth_change_actor_role_v3, the definitive artifact V3-C's
-- migration creates -- checked by existence, not by matching pg_get_constraintdef()'s
-- exact text, which can format identically-meaning CHECK expressions differently across
-- Postgres versions) and the same "4 legacy rows haven't drifted" precondition every
-- prior auth migration in this family checks -- refuse (not guess) if reality has
-- drifted since review time.
DO $$
DECLARE v_bad int; v_v3c_found int;
BEGIN
  SELECT count(*) INTO v_v3c_found FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auth_change_actor_role_v3';
  IF v_v3c_found <> 1 THEN
    RAISE EXCEPTION 'V3-D refused: auth_change_actor_role_v3 not found — apply V3-C first' USING ERRCODE='P0001';
  END IF;

  SELECT count(*) INTO v_bad FROM (VALUES
    ('owner','admin'), ('operator_primary','operator'), ('operator_backup','operator'), ('rider','rider')
  ) AS expected(actor, role)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.auth_actors a WHERE a.actor = expected.actor AND a.role = expected.role
  );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'V3-D refused: legacy auth_actors rows do not match the expected pre-V3-D shape — investigate before migrating' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1) lift the fixed actor-identity ceiling everywhere it is enforced ──────────
-- Every widened CHECK below accepts EXACTLY the same 4 legacy literals PLUS a canonical
-- lowercase UUID text form (matching gen_random_uuid()::text byte-for-byte) -- a strict
-- superset, so every existing row already satisfies it with no data change.
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_actor_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_actor_chk CHECK (
  actor IN ('owner','operator_primary','operator_backup','rider')
  OR actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_created_by_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_created_by_chk CHECK (
  created_by IS NULL
  OR created_by IN ('owner','operator_primary','operator_backup','rider')
  OR created_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_updated_by_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_updated_by_chk CHECK (
  updated_by IS NULL
  OR updated_by IN ('owner','operator_primary','operator_backup','rider')
  OR updated_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

ALTER TABLE public.auth_audit DROP CONSTRAINT IF EXISTS auth_audit_target_actor_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_target_actor_chk CHECK (
  target_actor IS NULL
  OR target_actor IN ('owner','operator_primary','operator_backup','rider')
  OR target_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

ALTER TABLE public.auth_audit DROP CONSTRAINT IF EXISTS auth_audit_by_actor_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_by_actor_chk CHECK (
  by_actor IS NULL
  OR by_actor IN ('owner','operator_primary','operator_backup','rider')
  OR by_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
);

-- auth_actor_pin_fingerprints and access_management_idempotency need NO widening: the
-- former's actor identity is enforced only via its composite FK to auth_actors
-- (workspace_id, actor) -- no separate CHECK on actor VALUES -- and the latter's
-- by_actor column has never had a CHECK restricting it to the legacy 4. Both already
-- accept a UUID actor the moment a matching auth_actors row exists.

-- ── 2) display_name -- one canonical bound, every row, new and existing ─────────
-- Keep MAX length numerically in sync with src/auth/accessUserDisplayName.js's
-- MAX_DISPLAY_NAME_LENGTH (120). The 4 legacy rows (V3-A) already satisfy this.
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_display_name_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_display_name_chk CHECK (
  display_name IS NULL
  OR (
    display_name = btrim(display_name)
    AND length(display_name) > 0
    AND length(display_name) <= 120
    AND display_name !~ '[\x00-\x1F\x7F]'
  )
);

-- ── 3) auth_create_access_user_v3 -- dormant canonical user-creation RPC ────────
-- Inputs carry authoritative equivalents of workspace id / acting owner actor id /
-- requested display name / requested role / acting sid hash / client_request_id / a
-- normalized semantic request_hash / safe audit metadata. Never accepts an actor/user
-- id, active, session_version, pin_hash, fingerprint, created_by, or updated_by from the
-- caller -- all of those are computed or frozen server-side. Future HTTP bodies must
-- never control p_workspace_id or p_by_actor.
CREATE OR REPLACE FUNCTION public.auth_create_access_user_v3(
  p_workspace_id uuid, p_by_actor text, p_display_name text, p_requested_role text,
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
  v_idem public.access_management_idempotency%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_display_name text;
  v_new_actor text;
  r public.auth_actors%ROWTYPE;
  v_result jsonb;
BEGIN
  -- ── input guards ──────────────────────────────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_display_name IS NULL THEN RAISE EXCEPTION 'AUTH_DISPLAY_NAME_INVALID' USING ERRCODE='22023'; END IF;
  v_display_name := btrim(p_display_name);
  IF length(v_display_name) = 0 OR length(v_display_name) > 120 OR v_display_name ~ '[\x00-\x1F\x7F]'
  THEN RAISE EXCEPTION 'AUTH_DISPLAY_NAME_INVALID' USING ERRCODE='22023'; END IF;
  IF p_requested_role IS NULL OR p_requested_role NOT IN ('cashier', 'waiter', 'kitchen', 'rider', 'shift_manager')
  THEN RAISE EXCEPTION 'AUTH_REQUESTED_ROLE_INVALID' USING ERRCODE='22023'; END IF;
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
       'proof','step_up_proof','sid','actor','user_id','created_by','updated_by']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  -- ── workspace row lock — the serialisation point ──────────────────────────
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- ── idempotency lookup, already serialised by the workspace lock above ────
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = 'create_access_user_v3' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_idem.request_hash = p_request_hash THEN
      RETURN v_idem.response_body; -- safe replay: same originally-created actor, no new row
    ELSE
      RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;

  -- ── lock and re-read the acting owner actor ───────────────────────────────
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_INITIATOR_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  IF v_by.role NOT IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_NOT_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── generate the new actor id server-side — the client never supplies one ─
  v_new_actor := gen_random_uuid()::text;

  INSERT INTO public.auth_actors (
    actor, role, workspace_id, pin_hash, session_version, active, failed_count,
    locked_until, display_name, created_at, created_by, updated_at, updated_by
  ) VALUES (
    v_new_actor, p_requested_role, p_workspace_id, NULL, 1, true, 0,
    NULL, v_display_name, v_now, p_by_actor, v_now, NULL
  ) RETURNING * INTO r;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES ('user_created', v_new_actor, p_by_actor, NULL,
          v_meta || jsonb_build_object(
            'requested_role', p_requested_role, 'workspace_id', p_workspace_id,
            'client_request_id', p_client_request_id
          ));

  v_result := jsonb_build_object(
    'actor', r.actor, 'display_name', r.display_name, 'role', r.role,
    'active', r.active, 'session_version', r.session_version,
    'created_at', r.created_at, 'updated_at', r.updated_at
  );

  INSERT INTO public.access_management_idempotency
    (workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body)
  VALUES (p_workspace_id, p_by_actor, p_by_sid_hash, 'create_access_user_v3', p_client_request_id, p_request_hash, 200, v_result);

  RETURN v_result;
END;
$fn$;

-- ── 4) auth_rename_access_user_v3 -- dormant canonical rename RPC ───────────────
CREATE OR REPLACE FUNCTION public.auth_rename_access_user_v3(
  p_workspace_id uuid, p_by_actor text, p_target_actor text, p_new_display_name text,
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
  v_new_name text;
  v_old_name text;
  v_changed boolean;
  r public.auth_actors%ROWTYPE;
  v_result jsonb;
BEGIN
  -- ── input guards ──────────────────────────────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR btrim(p_target_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  IF p_new_display_name IS NULL THEN RAISE EXCEPTION 'AUTH_DISPLAY_NAME_INVALID' USING ERRCODE='22023'; END IF;
  v_new_name := btrim(p_new_display_name);
  IF length(v_new_name) = 0 OR length(v_new_name) > 120 OR v_new_name ~ '[\x00-\x1F\x7F]'
  THEN RAISE EXCEPTION 'AUTH_DISPLAY_NAME_INVALID' USING ERRCODE='22023'; END IF;
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
       'proof','step_up_proof','sid','display_name','new_display_name']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  -- ── workspace row lock — the serialisation point ──────────────────────────
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- ── idempotency lookup, already serialised by the workspace lock above ────
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = 'rename_access_user_v3' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_idem.request_hash = p_request_hash THEN
      RETURN v_idem.response_body; -- safe replay: no mutation, no new audit
    ELSE
      RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;

  -- ── deterministic actor-id locking — acting + target, ordered; self-rename
  --    (p_by_actor = p_target_actor, e.g. the owner renaming themselves) is explicitly
  --    allowed and dedupes naturally to one row in the IN-list ──────────────────
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

  -- ── target — same workspace. NO owner exclusion: the owner may rename themselves ──
  IF v_tgt.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_TARGET_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;

  v_old_name := v_tgt.display_name;
  v_changed := (v_old_name IS DISTINCT FROM v_new_name);

  IF NOT v_changed THEN
    -- identical normalized name — deterministic no-op, no audit, no updated_at bump.
    v_result := jsonb_build_object(
      'actor', v_tgt.actor, 'display_name', v_tgt.display_name, 'role', v_tgt.role,
      'active', v_tgt.active, 'session_version', v_tgt.session_version,
      'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by
    );
  ELSE
    -- real rename — ONLY display_name (+ updated_at/updated_by). role, active,
    -- session_version, pin_hash, fingerprint rows, failed_count, locked_until: untouched.
    UPDATE public.auth_actors
       SET display_name = v_new_name, updated_at = v_now, updated_by = p_by_actor
     WHERE actor = p_target_actor
     RETURNING * INTO r;

    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES ('user_renamed', p_target_actor, p_by_actor, NULL,
            v_meta || jsonb_build_object(
              'workspace_id', p_workspace_id, 'client_request_id', p_client_request_id,
              'old_name_len', length(COALESCE(v_old_name, '')), 'new_name_len', length(v_new_name)
            ));

    v_result := jsonb_build_object(
      'actor', r.actor, 'display_name', r.display_name, 'role', r.role,
      'active', r.active, 'session_version', r.session_version,
      'updated_at', r.updated_at, 'updated_by', r.updated_by
    );
  END IF;

  INSERT INTO public.access_management_idempotency
    (workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body)
  VALUES (p_workspace_id, p_by_actor, p_by_sid_hash, 'rename_access_user_v3', p_client_request_id, p_request_hash, 200, v_result);

  RETURN v_result;
END;
$fn$;

-- ── grants: service_role only ─────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_create_access_user_v3(uuid, text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_create_access_user_v3(uuid, text, text, text, text, text, text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION public.auth_rename_access_user_v3(uuid, text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_rename_access_user_v3(uuid, text, text, text, text, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
