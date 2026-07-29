-- migrations/2026-07-29_v3b_auth_set_actor_pin_v3.sql
-- Access Control V3 — Block V3-B: auth_set_actor_pin_v3, DRAFT ONLY, NOT APPLIED.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- Purely additive: creates ONE new function alongside the still-untouched, still-sole-
-- live auth_set_actor_pin_v2 (from 2026-07-25_canonical_pin_rotation.sql). Nothing in
-- this migration modifies, replaces, or disables v2. No Node code calls v3 yet — this
-- is schema-only foundation, exactly like V3-A's tables were before any writer used them.
--
-- WHAT v3 ADDS ON TOP OF v2's UNCHANGED DISCIPLINE (workspace row lock taken first,
-- deterministic per-workspace actor-row locking, target re-verification under lock,
-- Node-performed workspace-wide duplicate-PIN comparison whose exact snapshot (p_seen)
-- is re-validated here for staleness, target-only session_version increment, unchanged
-- pin_set/pin_change audit semantics, single generic external failure shape):
--   1. Atomically writes one auth_actor_pin_fingerprints row for the CURRENT key, and
--      one more for the PREVIOUS key when a graceful-rotation previous key is in play
--      — both fingerprints are precomputed by Node (this RPC receives no plaintext PIN,
--      exactly like v2 receives no plaintext, only a hash).
--   2. Removes v2's hardcoded closed-list role check ("p_expected_role NOT IN
--      ('admin','operator','rider')"). V3-A already widened auth_actors.role to a
--      9-value transitional union, and V3-C will introduce real per-row conversions to
--      the 7 accepted V3 codes — a closed 3-value list here would reject a perfectly
--      legitimate rotation for any actor already converted to a V3 role. The ACTUAL
--      authorization-relevant check — that the caller's claimed p_expected_role matches
--      the row's real, current role — is unchanged and still authoritative
--      ("v_tgt.role <> p_expected_role" below); only the redundant, vocabulary-frozen
--      pre-check is gone.
BEGIN;

-- Staging-positive guard (same sentinel as every prior auth migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-B refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessors: V3-A's fingerprint table and v2 itself must already exist,
-- with v2's EXACT expected signature (proving this migration adds alongside it, never
-- silently replaces it).
DO $$
DECLARE v_v2_found int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='auth_actor_pin_fingerprints')
  THEN RAISE EXCEPTION 'V3-B refused: auth_actor_pin_fingerprints absent — apply V3-A first' USING ERRCODE='P0001'; END IF;

  SELECT count(*) INTO v_v2_found
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='auth_set_actor_pin_v2'
     AND oidvectortypes(p.proargtypes) = 'text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb';
  IF v_v2_found <> 1 THEN
    RAISE EXCEPTION 'V3-B refused: auth_set_actor_pin_v2 with its exact expected signature not found exactly once — v3 must be added ALONGSIDE it, not in place of a missing/altered v2' USING ERRCODE='P0001';
  END IF;
END $$;

-- ── canonical rotation RPC, V3 — additive alongside v2, never replacing it ────
-- p_caller_kind / p_user_id / p_workspace_id / p_by_actor / p_confirm / p_meta / p_seen
-- carry EXACTLY the same meaning and validation as in v2 (see 2026-07-25_canonical_
-- pin_rotation.sql for the full narrative). New here: p_key_id_current/
-- p_fingerprint_current (required) and p_key_id_previous/p_fingerprint_previous
-- (both-or-neither, only present during a graceful key rotation window).
CREATE OR REPLACE FUNCTION public.auth_set_actor_pin_v3(
  p_target_actor text, p_expected_role text, p_hash text, p_ip_hash text, p_seen jsonb,
  p_caller_kind text, p_key_id_current text, p_fingerprint_current text,
  p_key_id_previous text DEFAULT NULL, p_fingerprint_previous text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL, p_workspace_id uuid DEFAULT NULL,
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
  -- ── input guards (mirror the accepted v2 contract; role check WIDENED, not removed) ──
  IF p_caller_kind NOT IN ('account_owner','operational_admin')
  THEN RAISE EXCEPTION 'AUTH_CALLER_KIND_INVALID' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR btrim(p_target_actor) = ''
  THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  -- No closed-list check here (see migration header) — p_expected_role need only be a
  -- non-empty string; the AUTHORITATIVE check is v_tgt.role <> p_expected_role below,
  -- against auth_actors' OWN CHECK-enforced vocabulary (whatever it currently accepts).
  IF p_expected_role IS NULL OR btrim(p_expected_role) = ''
  THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip',
       'confirmation','fingerprint','pin_fingerprint','fingerprint_key','hmac_key']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_hash IS NULL OR btrim(p_hash) = '' OR left(p_hash, 7) <> 'scrypt$'
  THEN RAISE EXCEPTION 'AUTH_HASH_INVALID' USING ERRCODE='22023'; END IF;
  IF p_seen IS NULL OR jsonb_typeof(p_seen) <> 'array'
  THEN RAISE EXCEPTION 'AUTH_SEEN_INVALID' USING ERRCODE='22023'; END IF;

  -- ── fingerprint parameter guards — NEW in v3 ────────────────────────────────
  IF p_key_id_current IS NULL OR p_key_id_current !~ '^k[0-9]+$'
  THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_KEY_ID_INVALID' USING ERRCODE='22023'; END IF;
  IF p_fingerprint_current IS NULL OR btrim(p_fingerprint_current) = ''
  THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_INVALID' USING ERRCODE='22023'; END IF;
  IF (p_key_id_previous IS NOT NULL) IS DISTINCT FROM (p_fingerprint_previous IS NOT NULL)
  THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_PREVIOUS_INCOMPLETE' USING ERRCODE='22023'; END IF;
  IF p_key_id_previous IS NOT NULL THEN
    IF p_key_id_previous !~ '^k[0-9]+$' THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_KEY_ID_INVALID' USING ERRCODE='22023'; END IF;
    IF btrim(p_fingerprint_previous) = '' THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_INVALID' USING ERRCODE='22023'; END IF;
    IF p_key_id_previous = p_key_id_current THEN RAISE EXCEPTION 'AUTH_FINGERPRINT_KEY_IDS_MUST_DIFFER' USING ERRCODE='22023'; END IF;
  END IF;

  -- ── resolve the workspace from the TARGET, then serialise on it (unchanged from v2) ──
  SELECT workspace_id INTO v_ws_id FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws_id IS NULL THEN RAISE EXCEPTION 'AUTH_ACTOR_WORKSPACE_UNASSIGNED' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ws FROM public.workspaces WHERE id = v_ws_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- deterministic actor locking (no deadlock between concurrent rotations)
  PERFORM 1 FROM public.auth_actors WHERE workspace_id = v_ws_id ORDER BY actor FOR UPDATE;

  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.workspace_id IS DISTINCT FROM v_ws_id THEN
    RAISE EXCEPTION 'AUTH_ROTATION_STALE' USING ERRCODE='40001';
  END IF;
  -- THE authoritative role check — against auth_actors' actual, current, CHECK-enforced
  -- role value, whatever vocabulary it currently accepts (legacy or V3).
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- ── authorization, per caller kind (unchanged from v2) ─────────────────────
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
    IF p_by_actor = 'owner' AND p_target_actor = 'owner'
       AND p_confirm IS DISTINCT FROM 'CHANGE_OWNER_PIN'
    THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;
  END IF;

  -- ── optimistic verification of Node's uniqueness check (unchanged from v2) ──
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

  -- ── rotate ONLY the requested, already-existing actor (unchanged from v2) ──
  v_event := CASE WHEN v_tgt.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change' END;

  UPDATE public.auth_actors
     SET pin_hash = p_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = NULL, updated_at = v_now,
         updated_by = CASE WHEN p_caller_kind = 'operational_admin' THEN p_by_actor ELSE NULL END
   WHERE actor = p_target_actor
   RETURNING * INTO r;   -- active preserved; no actor is ever created here

  -- ── NEW in v3: atomically write the fingerprint row(s), same transaction ───
  -- ON CONFLICT (actor, key_id) DO UPDATE: a re-rotation of the SAME actor under the
  -- SAME key_id updates in place (actor,key_id) is the fingerprint table's PK; a
  -- genuine cross-actor duplicate at (workspace_id,key_id,fingerprint) would violate
  -- that SEPARATE unique index and raise naturally — deliberately not caught here,
  -- since Node's slow-hash check above (via p_seen) already establishes uniqueness
  -- under the same workspace lock this function already holds.
  INSERT INTO public.auth_actor_pin_fingerprints (actor, key_id, workspace_id, fingerprint)
  VALUES (p_target_actor, p_key_id_current, v_ws_id, p_fingerprint_current)
  ON CONFLICT (actor, key_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, created_at = v_now;

  IF p_key_id_previous IS NOT NULL THEN
    INSERT INTO public.auth_actor_pin_fingerprints (actor, key_id, workspace_id, fingerprint)
    VALUES (p_target_actor, p_key_id_previous, v_ws_id, p_fingerprint_previous)
    ON CONFLICT (actor, key_id) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, created_at = v_now;
  END IF;

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

  -- No PIN, hash, or fingerprint in the return value — matches v2 exactly.
  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
    'changed', true, 'event', v_event, 'onboarding_completed', v_onboarding);
END;
$fn$;

-- ── grants: service_role only — v2 is completely untouched by these statements ──
REVOKE ALL ON FUNCTION public.auth_set_actor_pin_v3(text, text, text, text, jsonb, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_actor_pin_v3(text, text, text, text, jsonb, text, text, text, text, text, uuid, uuid, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
