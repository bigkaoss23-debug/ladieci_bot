-- migrations/2026-07-29_v3c_auth_change_actor_role.sql
-- Access Control V3 — Block V3-C: role-transition foundation, DRAFT ONLY, NOT APPLIED.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- SCOPE. V3-C creates the dormant foundation for changeAccessUserRole. It does NOT:
--   * change any existing row's role value — no UPDATE of auth_actors.role anywhere in
--     this file; the 4 legacy rows stay exactly owner/admin, operator_primary/operator,
--     operator_backup/operator, rider/rider after this migration applies;
--   * remove the fixed four-actor identity ceiling (auth_actors_actor_chk is untouched —
--     dynamic actor creation is V3-D);
--   * wire auth_change_actor_role_v3 into any current route — it is additive and
--     completely unreferenced by index.js/login.js/current PIN routes;
--   * touch auth_set_actor_pin_v2 or auth_set_actor_pin_v3 in any way.
--
-- WHAT THIS FILE DOES.
--   1. Replaces the hardcoded 1:1 auth_actors_actor_role_map CHECK (which today makes it
--      IMPOSSIBLE for any row to hold anything but its exact original legacy pairing —
--      operator_primary could never become 'cashier' under the old constraint even via
--      a correct, authorized RPC call) with a permissive-but-still-strict replacement:
--      the owner actor's role stays exactly 'admin' (unchanged — V3-C never converts the
--      owner), and every OTHER actor's role may be anything EXCEPT 'admin' or 'owner'.
--      This is additive permission only: all 4 current rows already satisfy the new
--      CHECK without any UPDATE (owner/admin matches the first branch; the other three
--      are non-owner and already hold operator/rider, both outside {admin,owner}).
--   2. Creates auth_change_actor_role_v3 — a dormant canonical RPC that performs one
--      explicit, owner-authorized, session-bound-idempotent conversion of ONE non-owner
--      actor to ONE of the 5 assignable V3 roles (cashier/waiter/kitchen/rider/
--      shift_manager). Nothing calls it yet.
BEGIN;

-- Staging-positive guard (same sentinel as every prior auth migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-C refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor (V3-A's idempotency table, which this RPC uses directly) and a
-- precondition that the 4 legacy rows are still exactly where every prior audit found
-- them — refuse (not guess) if reality has drifted since review time.
DO $$
DECLARE v_bad int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='access_management_idempotency')
  THEN RAISE EXCEPTION 'V3-C refused: access_management_idempotency absent — apply V3-A first' USING ERRCODE='P0001'; END IF;

  SELECT count(*) INTO v_bad FROM (VALUES
    ('owner','admin'), ('operator_primary','operator'), ('operator_backup','operator'), ('rider','rider')
  ) AS expected(actor, role)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.auth_actors a WHERE a.actor = expected.actor AND a.role = expected.role
  );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'V3-C refused: legacy auth_actors rows do not match the expected pre-V3-C shape — investigate before migrating' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1) relax the hardcoded actor-role-map — additive permission only, no row changes ──
-- CREATE-then-DROP+ADD is safe here (unlike auth_actors_ws_actor_key in V3-A): a CHECK
-- constraint is never an FK target, so nothing can depend on it — DROP+ADD is always
-- idempotent-safe to repeat.
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_actor_role_map;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_actor_role_map CHECK (
  (actor = 'owner' AND role = 'admin') OR
  (actor <> 'owner' AND role NOT IN ('admin', 'owner'))
);

-- ── 2) auth_change_actor_role_v3 — dormant canonical role-change RPC ─────────────
-- Inputs carry authoritative equivalents of workspace id / acting owner actor id /
-- target actor id / expected current role / requested canonical role / acting sid hash
-- / client_request_id / a normalized semantic request_hash / safe audit metadata.
-- Future HTTP bodies must never control p_workspace_id or p_by_actor — those come from
-- the caller's own verified session context, exactly like p_by_actor already does in
-- auth_set_actor_pin_v2/v3's operational_admin path.
CREATE OR REPLACE FUNCTION public.auth_change_actor_role_v3(
  p_workspace_id uuid, p_by_actor text, p_target_actor text,
  p_expected_role text, p_requested_role text,
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
  r public.auth_actors%ROWTYPE;
  v_idem public.access_management_idempotency%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_old_role text;
  v_changed boolean;
  v_result jsonb;
BEGIN
  -- ── input guards ──────────────────────────────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR btrim(p_target_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  IF p_expected_role IS NULL OR btrim(p_expected_role) = '' THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;
  -- Whitelist, not blacklist: only the 5 assignable V3 roles are ever accepted here —
  -- admin/operator/owner/legacy_operator/any unknown value are all rejected by
  -- construction, with no separate blacklist to keep in sync.
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
       'proof','step_up_proof','sid']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  -- ── 1) workspace row lock — the serialisation point (unchanged discipline) ──
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- ── idempotency lookup, already serialised by the workspace lock above: a genuine
  --    concurrent duplicate can never race the INSERT below, it simply waits for this
  --    transaction to commit and then finds the row here on its own turn ──────────
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = 'change_actor_role' AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_idem.request_hash = p_request_hash THEN
      RETURN v_idem.response_body; -- safe replay: no mutation, no new audit, no re-check
    ELSE
      RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;

  -- ── 2) deterministic actor-id locking — acting + target only, ordered ────────
  PERFORM 1 FROM public.auth_actors WHERE actor IN (p_by_actor, p_target_actor) ORDER BY actor FOR UPDATE;

  -- ── 3) re-read both actors under lock ─────────────────────────────────────
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_tgt FROM public.auth_actors WHERE actor = p_target_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- ── 4) acting actor — owner semantics decided by ROLE, never the actor id ────
  IF v_by.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_INITIATOR_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  IF v_by.role NOT IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_NOT_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── 5) target — same workspace, not the owner (by ROLE, never the actor id) ──
  IF v_tgt.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_TARGET_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_tgt.role IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_TARGET_IS_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── 6) expected current role must match the locked, authoritative target row ──
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  v_old_role := v_tgt.role;
  v_changed := (v_old_role <> p_requested_role);

  IF NOT v_changed THEN
    -- ── 9) identical current/requested role — deterministic no-op, no session_version
    --      bump, no audit row. Still recorded below so a literal replay of this exact
    --      no-op request is itself idempotent. ──────────────────────────────────────
    v_result := jsonb_build_object(
      'actor', v_tgt.actor, 'old_role', v_old_role, 'role', v_tgt.role,
      'session_version', v_tgt.session_version, 'changed', false,
      'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by
    );
  ELSE
    -- ── 10) real change — ONLY role + session_version on the TARGET row; pin_hash,
    --       fingerprint rows, active, display_name, failed_count, locked_until are
    --       never touched (the UPDATE below does not name them, and nothing else in
    --       this function writes to any other actor or to auth_actor_pin_fingerprints)
    UPDATE public.auth_actors
       SET role = p_requested_role, session_version = session_version + 1,
           updated_at = v_now, updated_by = p_by_actor
     WHERE actor = p_target_actor
     RETURNING * INTO r;

    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES ('role_changed', p_target_actor, p_by_actor, NULL,
            v_meta || jsonb_build_object(
              'old_role', v_old_role, 'new_role', p_requested_role,
              'workspace_id', p_workspace_id, 'client_request_id', p_client_request_id
            ));

    -- No global session invalidation: only the TARGET's session_version moved, so only
    -- the target's own live sessions stop verifying — everyone else is untouched.
    INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
    VALUES ('session_invalidated', p_target_actor, p_by_actor, NULL,
            jsonb_build_object('workspace_id', p_workspace_id, 'session_version', r.session_version));

    v_result := jsonb_build_object(
      'actor', r.actor, 'old_role', v_old_role, 'role', r.role,
      'session_version', r.session_version, 'changed', true,
      'updated_at', r.updated_at, 'updated_by', r.updated_by
    );
  END IF;

  -- ── idempotency record, same transaction as the mutation (or the no-op) above ──
  INSERT INTO public.access_management_idempotency
    (workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body)
  VALUES (p_workspace_id, p_by_actor, p_by_sid_hash, 'change_actor_role', p_client_request_id, p_request_hash, 200, v_result);

  RETURN v_result;
END;
$fn$;

-- ── grants: service_role only ─────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_change_actor_role_v3(uuid, text, text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_change_actor_role_v3(uuid, text, text, text, text, text, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
