-- migrations/2026-07-15_auth_admin_access_management.sql
-- Access Control V2 — Block B6A (routine admin access management RPCs).
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive. Creates EXACTLY four SECURITY INVOKER functions used by the future
-- B6B Node service (service_role). Does NOT alter B0–B5 tables, the auth_audit
-- event constraint, or any existing RPC. No dynamic SQL. Fully-qualified table
-- refs. Pinned search_path. Execute revoked from public/anon/authenticated.
-- Reuses ONLY existing audit events (pin_set/pin_change/revoke/actor_enabled/
-- actor_disabled/actor_unlocked). NOT APPLIED — unwired, staging-only.
--
-- Routine management (B6) vs emergency access (B5): B5 windows carry NO human
-- initiator (by_actor NULL) and self-authorize via a one-shot secret; B6 requires
-- an authenticated, active admin initiator (p_by_actor) validated under row lock.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6-PRE).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B6A refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── RPC 1 — set target actor PIN (routine) ───────────────────────────────────
-- Atomic: validate active-admin initiator + target under deterministic locks,
-- replace PIN hash, reset lock/failures, bump session_version once, audit
-- pin_set/pin_change. NEVER sets pin_hash=NULL. Preserves active.
CREATE OR REPLACE FUNCTION public.auth_admin_set_actor_pin(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_hash text, p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb, p_confirm text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_by public.auth_actors%ROWTYPE; v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE; v_event text; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  -- input guards
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_expected_role NOT IN ('admin','operator','rider') THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;
  -- pin hash shape (real hashing is B1 in Node; plaintext never reaches SQL)
  IF p_hash IS NULL OR btrim(p_hash) = '' THEN RAISE EXCEPTION 'AUTH_HASH_INVALID' USING ERRCODE='22023'; END IF;
  IF left(p_hash, 7) <> 'scrypt$' THEN RAISE EXCEPTION 'AUTH_HASH_INVALID' USING ERRCODE='22023'; END IF;

  -- deterministic lock: both required rows in canonical actor-name order (single
  -- row when initiator = target). No row is FOR UPDATE-locked twice.
  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;
  SELECT * INTO v_by  FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.role <> 'admin' THEN RAISE EXCEPTION 'AUTH_NOT_ADMIN' USING ERRCODE='22023'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- owner self-change requires the exact confirmation phrase (no normalization).
  IF p_by_actor = 'owner' AND p_target_actor = 'owner'
     AND p_confirm IS DISTINCT FROM 'CHANGE_OWNER_PIN'
  THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;

  v_event := CASE WHEN v_tgt.pin_hash IS NULL THEN 'pin_set' ELSE 'pin_change' END;

  UPDATE public.auth_actors
     SET pin_hash = p_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = NULL, updated_at = v_now, updated_by = p_by_actor
   WHERE actor = p_target_actor RETURNING * INTO r;   -- active preserved (not in SET)

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES (v_event, p_target_actor, p_by_actor, p_ip_hash, v_meta);   -- confirmation never audited

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
    'changed', true, 'event', v_event);
END;
$fn$;

-- ── RPC 2 — revoke target actor sessions (routine) ───────────────────────────
-- Atomic: bump session_version once, audit revoke. Preserves pin/active/failure/lock.
CREATE OR REPLACE FUNCTION public.auth_admin_revoke_actor_sessions(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb, p_confirm text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_by public.auth_actors%ROWTYPE; v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_expected_role NOT IN ('admin','operator','rider') THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;
  SELECT * INTO v_by  FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.role <> 'admin' THEN RAISE EXCEPTION 'AUTH_NOT_ADMIN' USING ERRCODE='22023'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- owner self-revoke requires the exact confirmation phrase (no normalization).
  IF p_by_actor = 'owner' AND p_target_actor = 'owner'
     AND p_confirm IS DISTINCT FROM 'REVOKE_OWNER_SESSIONS'
  THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;

  UPDATE public.auth_actors
     SET session_version = session_version + 1, updated_at = v_now, updated_by = p_by_actor
   WHERE actor = p_target_actor RETURNING * INTO r;   -- pin/active/failed/lock preserved

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES ('revoke', p_target_actor, p_by_actor, p_ip_hash, v_meta);

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
    'changed', true, 'event', 'revoke');
END;
$fn$;

-- ── RPC 3 — set target actor active state (routine) ──────────────────────────
-- Atomic. Same-state no-op returns changed=false (no sv bump, no audit). A real
-- change bumps sv once on BOTH disable AND enable (owner rule: a token issued
-- before a disable must never revalidate after reactivation). Self-disable
-- forbidden for every admin, including owner. Preserves pin/failed/lock.
CREATE OR REPLACE FUNCTION public.auth_admin_set_actor_active(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_active boolean, p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_by public.auth_actors%ROWTYPE; v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE; v_event text; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF p_active IS NULL THEN RAISE EXCEPTION 'AUTH_ACTIVE_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_expected_role NOT IN ('admin','operator','rider') THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;
  SELECT * INTO v_by  FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.role <> 'admin' THEN RAISE EXCEPTION 'AUTH_NOT_ADMIN' USING ERRCODE='22023'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- no admin may disable itself
  IF p_by_actor = p_target_actor AND p_active = false
  THEN RAISE EXCEPTION 'AUTH_SELF_DISABLE_FORBIDDEN' USING ERRCODE='22023'; END IF;

  -- same-state no-op: no sv bump, no audit, no timestamp churn
  IF v_tgt.active = p_active THEN
    RETURN jsonb_build_object('actor', v_tgt.actor, 'role', v_tgt.role, 'active', v_tgt.active,
      'session_version', v_tgt.session_version, 'failed_count', v_tgt.failed_count,
      'locked_until', v_tgt.locked_until, 'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by,
      'changed', false, 'event', NULL);
  END IF;

  v_event := CASE WHEN p_active THEN 'actor_enabled' ELSE 'actor_disabled' END;

  UPDATE public.auth_actors
     SET active = p_active, session_version = session_version + 1,
         updated_at = v_now, updated_by = p_by_actor
   WHERE actor = p_target_actor RETURNING * INTO r;   -- pin/failed/lock preserved

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES (v_event, p_target_actor, p_by_actor, p_ip_hash, v_meta || jsonb_build_object('active', p_active));

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
    'changed', true, 'event', v_event);
END;
$fn$;

-- ── RPC 4 — unlock target actor (routine) ────────────────────────────────────
-- Atomic. Already-unlocked no-op returns changed=false. A real reset clears
-- failed_count/locked_until and audits actor_unlocked. Does NOT revoke sessions:
-- session_version, pin_hash and active are preserved.
CREATE OR REPLACE FUNCTION public.auth_admin_unlock_actor(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_by public.auth_actors%ROWTYPE; v_tgt public.auth_actors%ROWTYPE;
        r public.auth_actors%ROWTYPE; v_now timestamptz := now();
        v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_expected_role NOT IN ('admin','operator','rider') THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;
  SELECT * INTO v_by  FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.role <> 'admin' THEN RAISE EXCEPTION 'AUTH_NOT_ADMIN' USING ERRCODE='22023'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  -- already unlocked → no-op (no audit, no sv change, no timestamp churn)
  IF v_tgt.failed_count = 0 AND v_tgt.locked_until IS NULL THEN
    RETURN jsonb_build_object('actor', v_tgt.actor, 'role', v_tgt.role, 'active', v_tgt.active,
      'session_version', v_tgt.session_version, 'failed_count', v_tgt.failed_count,
      'locked_until', v_tgt.locked_until, 'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by,
      'changed', false, 'event', NULL);
  END IF;

  UPDATE public.auth_actors
     SET failed_count = 0, locked_until = NULL, updated_at = v_now, updated_by = p_by_actor
   WHERE actor = p_target_actor RETURNING * INTO r;   -- pin/active/session_version preserved

  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES ('actor_unlocked', p_target_actor, p_by_actor, p_ip_hash, v_meta);

  RETURN jsonb_build_object('actor', r.actor, 'role', r.role, 'active', r.active,
    'session_version', r.session_version, 'failed_count', r.failed_count,
    'locked_until', r.locked_until, 'updated_at', r.updated_at, 'updated_by', r.updated_by,
    'changed', true, 'event', 'actor_unlocked');
END;
$fn$;

-- ── grants: service_role only ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_admin_revoke_actor_sessions(text, text, text, text, jsonb, text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_admin_set_actor_active(text, text, text, boolean, text, jsonb)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_admin_unlock_actor(text, text, text, text, jsonb)                       FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text)         TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_admin_revoke_actor_sessions(text, text, text, text, jsonb, text)        TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_admin_set_actor_active(text, text, text, boolean, text, jsonb)          TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_admin_unlock_actor(text, text, text, text, jsonb)                       TO service_role;

COMMIT;
