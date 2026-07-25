-- migrations/2026-07-25_operational_pin_uniqueness.sql
-- S2-7D2 — race-safe PIN uniqueness for the account-owner rotation path.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive. DRAFT — NOT APPLIED. Does NOT touch the already-applied S2-7D migration.
--
-- WHY A NEW RPC
-- Uniqueness ("no two active actors in a workspace share a PIN") cannot be decided in SQL:
-- the PINs are scrypt hashes with per-row random salts, so two hashes of the same PIN are
-- different strings and Postgres has no scrypt to re-derive them. The comparison must run in
-- Node (the accepted B1 verifier). That creates a read→verify→write window in which another
-- rotation could introduce the very collision we just ruled out.
--
-- HOW THE RACE IS PREVENTED (optimistic verification under lock, no unsafe data stored)
-- Node passes back the EXACT snapshot it verified against: for every other actor of the
-- workspace, its `actor`, `active` flag and stored `pin_hash` string. This function then,
-- holding FOR UPDATE locks on the workspace and on every actor row of that workspace,
-- re-reads the same columns and requires them to be byte-identical to the snapshot. If any
-- differ — i.e. a concurrent rotation/activation happened after Node's read — it raises
-- AUTH_ROTATION_STALE (serialization_failure) and NOTHING is written; the caller re-reads
-- and re-verifies. When the check passes, Node's "no duplicate" conclusion is provably still
-- true at commit time, and the rotation happens in the same transaction. Two concurrent
-- rotations therefore cannot both commit: the second one's snapshot is stale by construction.
--
-- The snapshot contains only data that already lives in this database and never leaves the
-- service_role boundary. NO plaintext PIN and NO reusable plaintext-derived fingerprint is
-- stored anywhere — the uniqueness decision is transient, exactly like a login check.
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

-- ── RPC — owner PIN rotation with race-safe uniqueness ───────────────────────
-- p_seen : jsonb array [{actor, active, pin_hash}] — the snapshot Node verified against, for
--          EVERY other actor of this workspace (active or not). Order irrelevant.
-- Returns jsonb { actor, role, active, session_version, failed_count, locked_until,
--                 updated_at, changed, event, onboarding_completed }.
CREATE OR REPLACE FUNCTION public.auth_account_set_owner_pin_v2(
  p_user_id uuid, p_workspace_id uuid, p_hash text, p_ip_hash text,
  p_seen jsonb, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_ws public.workspaces%ROWTYPE;
        v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE;
        v_event text; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
        v_other record; v_seen jsonb; v_others int := 0; v_seen_count int;
BEGIN
  -- ── input guards (mirror the accepted B6A/S2-7D contract) ──────────────────
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
  IF p_seen IS NULL OR jsonb_typeof(p_seen) <> 'array'
  THEN RAISE EXCEPTION 'AUTH_SEEN_INVALID' USING ERRCODE='22023'; END IF;

  -- ── lock the workspace, then authorize ─────────────────────────────────────
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.workspace_memberships
     WHERE workspace_id = p_workspace_id AND user_id = p_user_id
       AND role = 'workspace_owner' AND status = 'active'
  ) THEN RAISE EXCEPTION 'NOT_WORKSPACE_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── lock EVERY actor of the workspace (deterministic order, no deadlock) ────
  PERFORM 1 FROM public.auth_actors
   WHERE workspace_id = p_workspace_id ORDER BY actor FOR UPDATE;

  SELECT * INTO v_tgt FROM public.auth_actors
   WHERE actor = 'owner' AND workspace_id = p_workspace_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'OWNER_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.role <> 'admin' THEN RAISE EXCEPTION 'OWNER_ACTOR_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- ── optimistic verification of Node's uniqueness check ─────────────────────
  -- Every OTHER actor must still be exactly as Node saw it. Any drift invalidates the
  -- duplicate check, so we abort instead of risking a collision.
  FOR v_other IN
    SELECT actor, active, pin_hash FROM public.auth_actors
     WHERE workspace_id = p_workspace_id AND actor <> 'owner' ORDER BY actor
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

  -- the snapshot must cover exactly the other actors — no more, no fewer
  SELECT count(*) INTO v_seen_count FROM jsonb_array_elements(p_seen);
  IF v_seen_count <> v_others THEN
    RAISE EXCEPTION 'AUTH_ROTATION_STALE' USING ERRCODE='40001';
  END IF;

  -- ── rotate + complete onboarding, atomically ───────────────────────────────
  v_event := CASE WHEN v_tgt.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change' END;

  UPDATE public.auth_actors
     SET pin_hash = p_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = NULL, updated_at = v_now, updated_by = NULL
   WHERE actor = 'owner' AND workspace_id = p_workspace_id
   RETURNING * INTO r;   -- active preserved; the account never becomes an actor

  UPDATE public.workspaces
     SET owner_pin_onboarding_completed_at = COALESCE(owner_pin_onboarding_completed_at, v_now),
         updated_at = v_now
   WHERE id = p_workspace_id;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES (v_event, 'owner', NULL, p_ip_hash,
          v_meta || jsonb_build_object('source', 'account_owner', 'policy', 'six_digit'));

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at,
    'changed', true, 'event', v_event, 'onboarding_completed', true);
END;
$fn$;

-- ── grants: service_role only ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_account_set_owner_pin_v2(uuid, uuid, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_account_set_owner_pin_v2(uuid, uuid, text, text, jsonb, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
