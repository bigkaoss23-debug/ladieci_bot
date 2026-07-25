-- migrations/2026-07-26_disable_legacy_pin_rotation.sql
-- S2-7D2 step B — COMPLETE runtime-writer cutover. STAGING ONLY. DRAFT — NOT APPLIED.
--
-- APPLY ONLY AFTER migration A is applied AND backend f54d6e7 (which routes every
-- owner/operator/rider rotation through public.auth_set_actor_pin_v2) is deployed and
-- verified. Until then the uniqueness invariant does NOT hold.
--
-- WHY SIX FUNCTIONS, NOT ONE
-- A live probe confirmed six functions still exist and are executable by service_role. Each
-- can write auth_actors.pin_hash and/or auth_actors.active outside the canonical workspace
-- lock, so any one of them defeats a database-level single-writer invariant:
--   * pin_hash writers : auth_admin_set_actor_pin, auth_account_set_owner_pin,
--                        auth_set_pin_hash, auth_consume_recovery_window
--   * active writers   : auth_set_active, auth_admin_set_actor_active,
--                        auth_consume_recovery_window (sets active = true)
-- The activation path matters even without any rotation: an INACTIVE actor may already share
-- a PIN with an active one, and reactivating it would create two active actors holding the
-- same PIN. Since no runtime route currently exposes activation or emergency recovery, they
-- are fail-closed here rather than canonicalised; both will be redesigned around the
-- canonical workspace lock in a separate block before being re-enabled.
--
-- INTENDED RUNTIME STATE AFTER THIS MIGRATION
--   PIN mutation writers    : exactly one (public.auth_set_actor_pin_v2)
--   active-state writers    : zero
--   actor creation/deletion : zero
--   operational login       : UNCHANGED (auth_record_failed_attempt / auth_reset_failed_attempts
--                             / auth_bump_session_version and the login path are untouched;
--                             legacy-length login compatibility is unchanged)
--   session revoke / unlock : UNCHANGED (they never write pin_hash or active)
--
-- Each stub preserves its exact signature, overload and jsonb return type, so a stale caller
-- fails loudly instead of silently resolving to another overload. Stubs write nothing, return
-- nothing successfully, stay SECURITY INVOKER with a fixed search_path, and their exceptions
-- carry no secrets.
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDITIONS — fail closed. Nothing is skipped with IF EXISTS: a missing or
-- mismatched writer STOPS the cutover for review rather than leaving a hole.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_expected constant text[][] := ARRAY[
    ['auth_admin_set_actor_pin',      'text, text, text, text, text, jsonb, text'],
    ['auth_account_set_owner_pin',    'uuid, uuid, text, text, jsonb'],
    ['auth_set_pin_hash',             'text, text, text, jsonb'],
    ['auth_set_active',               'text, boolean, text, jsonb'],
    ['auth_admin_set_actor_active',   'text, text, text, boolean, text, jsonb'],
    ['auth_consume_recovery_window',  'text, text, text, text, text, text, jsonb']
  ];
  v_name text; v_args text; v_found int; v_actual text; v_i int;
  v_v2_args constant text := 'text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb';
BEGIN
  -- (1) staging sentinel
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D2B refused: staging sentinel migration absent — wrong database?'; END IF;

  -- (2) the canonical replacement exists with its EXACT signature
  SELECT count(*) INTO v_found
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auth_set_actor_pin_v2'
     AND pg_get_function_identity_arguments(p.oid) = v_v2_args;
  IF v_found <> 1 THEN
    RAISE EXCEPTION 'S2-7D2B refused: auth_set_actor_pin_v2(%) not found exactly once — apply migration A and deploy the backend cutover first', v_v2_args
      USING ERRCODE = 'P0001';
  END IF;

  -- (3) …and service_role can execute it, otherwise this migration would leave NO writer
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='auth_set_actor_pin_v2'
       AND pg_get_function_identity_arguments(p.oid) = v_v2_args
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'S2-7D2B refused: service_role cannot EXECUTE auth_set_actor_pin_v2 — the cutover would leave no PIN-rotation path'
      USING ERRCODE = 'P0001';
  END IF;

  -- (4)+(5) every legacy writer exists with the EXACT expected overload, exactly once
  FOR v_i IN 1 .. array_length(v_expected, 1) LOOP
    v_name := v_expected[v_i][1];
    v_args := v_expected[v_i][2];

    SELECT count(*) INTO v_found
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_found <> 1 THEN
      RAISE EXCEPTION 'S2-7D2B refused: expected exactly ONE overload of public.% but found % — resolve before cutover', v_name, v_found
        USING ERRCODE = 'P0001';
    END IF;

    SELECT pg_get_function_identity_arguments(p.oid) INTO v_actual
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_name;
    IF v_actual IS DISTINCT FROM v_args THEN
      RAISE EXCEPTION 'S2-7D2B refused: public.% signature mismatch — expected (%) but found (%)', v_name, v_args, v_actual
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- (6) S2-7D schema + workspace association present
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='auth_actors' AND column_name='workspace_id')
  THEN RAISE EXCEPTION 'S2-7D2B refused: auth_actors.workspace_id absent — apply S2-7D first' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='workspaces'
                    AND column_name='owner_pin_onboarding_completed_at')
  THEN RAISE EXCEPTION 'S2-7D2B refused: onboarding marker absent — apply S2-7D first' USING ERRCODE='P0001'; END IF;
  IF EXISTS (SELECT 1 FROM public.auth_actors WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'S2-7D2B refused: some actors are not associated with a workspace — the canonical RPC cannot serialise them'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) auth_admin_set_actor_pin — B6A routine admin PIN rotation (pin_hash writer)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_admin_set_actor_pin(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_hash text, p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb, p_confirm text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_LEGACY_PIN_ROTATION_DISABLED' USING ERRCODE = 'P0001';
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) auth_account_set_owner_pin — S2-7D owner-only rotation (pin_hash writer)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_account_set_owner_pin(
  p_user_id uuid, p_workspace_id uuid, p_hash text, p_ip_hash text,
  p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_ACCOUNT_OWNER_PIN_V1_DISABLED' USING ERRCODE = 'P0001';
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) auth_set_pin_hash — B2 direct primitive (pin_hash writer)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_set_pin_hash(
  p_actor text, p_hash text, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_DIRECT_PIN_HASH_WRITE_DISABLED' USING ERRCODE = 'P0001';
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) auth_set_active — B2 direct primitive (active writer)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_set_active(
  p_actor text, p_active boolean, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_DIRECT_ACTOR_ACTIVE_WRITE_DISABLED' USING ERRCODE = 'P0001';
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) auth_admin_set_actor_active — B6A enable/disable (active writer)
--    Fail-closed rather than canonicalised: reactivating an actor whose stored PIN already
--    belongs to an active actor would create a duplicate with no rotation involved.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_admin_set_actor_active(
  p_by_actor text, p_target_actor text, p_expected_role text,
  p_active boolean, p_ip_hash text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_ADMIN_ACTOR_ACTIVE_DISABLED' USING ERRCODE = 'P0001';
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) auth_consume_recovery_window — B5 emergency recovery (writes pin_hash AND active=true)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auth_consume_recovery_window(
  p_window_id text, p_purpose text, p_actor text, p_secret_digest text,
  p_new_hash text, p_ip_hash text DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'AUTH_OPERATIONAL_RECOVERY_DISABLED' USING ERRCODE = 'P0001';
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- REVOKE EXECUTE from every role, service_role included. Two independent stops: a grant can
-- be re-granted, and a body alone could be reached by a role that still holds EXECUTE.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_admin_set_actor_pin(text, text, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.auth_account_set_owner_pin(uuid, uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.auth_set_pin_hash(text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.auth_set_active(text, boolean, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.auth_admin_set_actor_active(text, text, text, boolean, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.auth_consume_recovery_window(text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- POST-CONDITION — the cutover must have achieved exactly one PIN writer and zero
-- active-state writers, otherwise the whole transaction rolls back.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('auth_admin_set_actor_pin','auth_account_set_owner_pin','auth_set_pin_hash',
                       'auth_set_active','auth_admin_set_actor_active','auth_consume_recovery_window')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'S2-7D2B failed: % disabled writer(s) still executable by service_role', v_open
      USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.proname='auth_set_actor_pin_v2'
       AND has_function_privilege('service_role', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'S2-7D2B failed: the canonical writer is not executable by service_role'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
