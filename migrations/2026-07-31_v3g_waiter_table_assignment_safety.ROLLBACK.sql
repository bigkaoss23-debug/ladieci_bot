-- migrations/2026-07-31_v3g_waiter_table_assignment_safety.ROLLBACK.sql
-- Access Control V3 -- Block V3-G rollback. DRAFT ONLY, NOT APPLIED.
--
-- GUARDED, not automatic: refuses rather than guesses. Restores the EXACT accepted V3-E
-- body of auth_set_access_user_active_v3 (byte-identical to
-- migrations/2026-07-30_v3e_access_user_lifecycle.sql's own CREATE OR REPLACE) and drops
-- the one new writer (auth_assign_table_session_waiter_v3) -- but ONLY when it can prove
-- neither was ever actually used:
--   * zero table_session_assignment_history rows -- their presence means a real
--     assignment/reassignment/clear decision was made and produced attributable history
--     this rollback will not erase or reinterpret;
--   * zero access_management_idempotency rows for assign_table_session_waiter_v3 --
--     their presence means the assignment RPC actually ran;
--   * zero table_sessions rows with a non-NULL assigned_waiter_actor -- belt-and-suspenders
--     against any assignment state existing outside the history table.
-- table_sessions and table_session_assignment_history themselves are NEVER dropped by
-- this rollback, even when the guards above pass -- same discipline as V3-A's own
-- access_management_idempotency table, which no subsequent rollback in this family has
-- ever dropped. Every actor, every PIN hash, every fingerprint row, and every prior
-- V2/V3-B/V3-C/V3-D/V3-E writer is untouched by this file. This rollback NEVER
-- deactivates or reactivates a waiter, never closes a table session, never deletes
-- assignment history, never reassigns a table to force itself to pass, and never
-- guesses an alternate waiter.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-G rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── refuse if any real assignment decision has already happened ──────────────────
DO $$
DECLARE v_hist_count int;
BEGIN
  SELECT count(*) INTO v_hist_count FROM public.table_session_assignment_history;
  IF v_hist_count <> 0 THEN
    RAISE EXCEPTION 'V3-G rollback refused: % table_session_assignment_history row(s) exist — this rollback never reverses a human assignment decision', v_hist_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── refuse if any assignment idempotency record exists ────────────────────────────
DO $$
DECLARE v_idem_count int;
BEGIN
  SELECT count(*) INTO v_idem_count FROM public.access_management_idempotency
   WHERE action = 'assign_table_session_waiter_v3';
  IF v_idem_count <> 0 THEN
    RAISE EXCEPTION 'V3-G rollback refused: % assign_table_session_waiter_v3 idempotency record(s) exist — safe deletion is not formally proven, refusing rather than guessing', v_idem_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── refuse if any table session shows a real assignment (belt-and-suspenders) ─────
DO $$
DECLARE v_assigned_count int;
BEGIN
  SELECT count(*) INTO v_assigned_count FROM public.table_sessions WHERE assigned_waiter_actor IS NOT NULL;
  IF v_assigned_count <> 0 THEN
    RAISE EXCEPTION 'V3-G rollback refused: % table_sessions row(s) carry a non-NULL assigned_waiter_actor — safe deletion is not formally proven, refusing rather than guessing', v_assigned_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── safe to proceed: drop the one new RPC, restore V3-E's exact prior body ────────
DROP FUNCTION IF EXISTS public.auth_assign_table_session_waiter_v3(uuid, text, uuid, text, text, text, text, text, jsonb);

-- Byte-identical to migrations/2026-07-30_v3e_access_user_lifecycle.sql's own function
-- body (comments included) -- restores exactly the accepted V3-E behavior, removing the
-- V3-G waiter-open-tables addition.
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

  -- ── deterministic actor-id locking — acting + target, ordered ─────────────
  -- Authorization is proved BEFORE any idempotency lookup/replay below — a revoked,
  -- deactivated, or demoted acting actor must never receive a stored success response
  -- merely because a matching idempotency record exists from when they WERE authorized.
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

  -- ── target — same workspace; owner rejected by ROLE; everything else must be on
  --    the explicit POSITIVE allowlist (never a denylist — an unknown, malformed, or
  --    future role that has not been explicitly approved must fail closed, not pass
  --    through as "not admin/owner") ─────────────────────────────────────────
  IF v_tgt.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_TARGET_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_tgt.role IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_TARGET_IS_OWNER' USING ERRCODE='P0001'; END IF;
  IF v_tgt.role IS NULL OR v_tgt.role NOT IN
     ('operator', 'legacy_operator', 'cashier', 'waiter', 'kitchen', 'rider', 'shift_manager')
  THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_INELIGIBLE' USING ERRCODE='P0001'; END IF;

  -- ── idempotency lookup — ONLY now, after acting-owner AND target-eligibility are
  --    both proved against the CURRENT authoritative rows under lock ───────────
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

REVOKE ALL ON FUNCTION public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
