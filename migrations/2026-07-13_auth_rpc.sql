-- migrations/2026-07-13_auth_rpc.sql
-- Access Control V2 — Block B2 (atomic auth DAO RPCs).
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive. Creates 5 SECURITY INVOKER functions used by the backend DAO
-- (service_role). Does NOT alter B0 tables. No dynamic SQL. Fully-qualified
-- table refs. Pinned search_path. Execute revoked from public/anon/authenticated.
BEGIN;

-- Staging-positive guard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B2 refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── 1. record a failed attempt with progressive lock (authoritative) ─────────
CREATE OR REPLACE FUNCTION public.auth_record_failed_attempt(p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE r public.auth_actors%ROWTYPE; nfc int; lock_min int; new_lock timestamptz;
BEGIN
  SELECT * INTO r FROM public.auth_actors WHERE actor = p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Locked window: do NOT increment; report remaining time.
  IF r.locked_until IS NOT NULL AND r.locked_until > now() THEN
    RETURN jsonb_build_object(
      'failed_count', r.failed_count,
      'locked_until', r.locked_until,
      'locked', true,
      'retry_after_sec', ceil(extract(epoch FROM (r.locked_until - now())))::int);
  END IF;

  nfc := r.failed_count + 1;
  lock_min := CASE
    WHEN nfc < 5 THEN 0
    WHEN nfc = 5 THEN 1
    WHEN nfc = 6 THEN 5
    WHEN nfc = 7 THEN 15
    ELSE 60 END;                                  -- nfc >= 8 → 60 (cap)
  new_lock := CASE WHEN lock_min = 0 THEN NULL ELSE now() + make_interval(mins => lock_min) END;

  UPDATE public.auth_actors SET failed_count = nfc, locked_until = new_lock WHERE actor = p_actor;

  RETURN jsonb_build_object(
    'failed_count', nfc,
    'locked_until', new_lock,
    'locked', new_lock IS NOT NULL,
    'retry_after_sec', CASE WHEN new_lock IS NULL THEN 0
                            ELSE ceil(extract(epoch FROM (new_lock - now())))::int END);
END;
$fn$;

-- ── 2. reset failed attempts atomically ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_reset_failed_attempts(p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v public.auth_actors%ROWTYPE;
BEGIN
  UPDATE public.auth_actors SET failed_count = 0, locked_until = NULL
   WHERE actor = p_actor RETURNING * INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  RETURN jsonb_build_object('actor', v.actor, 'session_version', v.session_version,
                            'failed_count', v.failed_count, 'locked_until', v.locked_until, 'active', v.active);
END;
$fn$;

-- ── shared DB-side meta guard (defense-in-depth; deep sanitization is in JS) ──
-- Inlined per function (no shared plpgsql helper) to keep search_path pinned.

-- ── 3. set pin hash + bump session_version + audit (same tx). event derived. ─
CREATE OR REPLACE FUNCTION public.auth_set_pin_hash(p_actor text, p_hash text, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_prev text; v_sv int; v_event text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  SELECT pin_hash INTO v_prev FROM public.auth_actors WHERE actor = p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  v_event := CASE WHEN v_prev IS NULL THEN 'pin_set' ELSE 'pin_change' END;

  UPDATE public.auth_actors
     SET pin_hash = p_hash, session_version = session_version + 1,
         failed_count = 0, locked_until = NULL, updated_at = now(), updated_by = p_by
   WHERE actor = p_actor RETURNING session_version INTO v_sv;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES (v_event, p_actor, p_by, v_meta);

  RETURN jsonb_build_object('actor', p_actor, 'session_version', v_sv, 'event', v_event);
END;
$fn$;

-- ── 4. bump session_version + audit 'revoke' (same tx) ───────────────────────
CREATE OR REPLACE FUNCTION public.auth_bump_session_version(p_actor text, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_sv int; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  UPDATE public.auth_actors SET session_version = session_version + 1
   WHERE actor = p_actor RETURNING session_version INTO v_sv;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES ('revoke', p_actor, p_by, v_meta);

  RETURN jsonb_build_object('actor', p_actor, 'session_version', v_sv, 'event', 'revoke');
END;
$fn$;

-- ── 5. set active + audit (same tx). Deactivation also bumps session_version. ─
-- Audit uses enum event 'revoke' (B0 enum has no dedicated activation event);
-- the actual state is recorded in meta {op:'set_active', active:<bool>}.
CREATE OR REPLACE FUNCTION public.auth_set_active(p_actor text, p_active boolean, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE v_sv int; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  UPDATE public.auth_actors
     SET active = p_active,
         session_version = session_version + (CASE WHEN p_active THEN 0 ELSE 1 END),
         updated_at = now(), updated_by = p_by
   WHERE actor = p_actor RETURNING session_version INTO v_sv;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES ('revoke', p_actor, p_by, v_meta || jsonb_build_object('op','set_active','active',p_active));

  RETURN jsonb_build_object('actor', p_actor, 'active', p_active, 'session_version', v_sv);
END;
$fn$;

-- ── grants: service_role only ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_record_failed_attempt(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_reset_failed_attempts(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_set_pin_hash(text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_bump_session_version(text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_set_active(text, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.auth_record_failed_attempt(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_reset_failed_attempts(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_set_pin_hash(text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_bump_session_version(text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_set_active(text, boolean, text, jsonb) TO service_role;

COMMIT;
