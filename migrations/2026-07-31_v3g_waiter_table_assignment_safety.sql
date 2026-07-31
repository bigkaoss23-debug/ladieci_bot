-- migrations/2026-07-31_v3g_waiter_table_assignment_safety.sql
-- Access Control V3 -- Block V3-G: waiter/table assignment safety foundation, DRAFT
-- ONLY, NOT APPLIED.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
--
-- SCOPE. V3-G answers exactly one question authoritatively at the database level: can
-- this waiter be deactivated right now, or do they still have open table sessions
-- assigned to them? It does NOT implement the tables-ordering product (no table-order
-- UI writer, no billing, no menu-per-table, no automatic waiter selection).
--
-- SOURCE-AUDIT FINDING (see MIGRATION_MANIFEST.md row 39's own V3-A comment, which
-- already reserved this name: "create table_sessions (V3-G)"). No table/mesa/dine-in
-- concept exists ANYWHERE in this codebase today -- `ordenes.tipo_consegna` is a binary
-- DOMICILIO/RITIRO (delivery/pickup) field with no third value, and `service_sessions`
-- is an unrelated, restaurant-wide, AT-MOST-ONE-OPEN-GLOBALLY daily lunch/dinner
-- accounting window (see its `service_sessions_single_active_uq` partial unique index),
-- not a per-table dine-in session. PATH B: this migration creates the minimal canonical
-- model from scratch, modeled stylistically on the existing `manual_giros`
-- assignment-with-soft-close pattern and the `service_session_audit` append-only
-- history pattern, using the established `workspace_id uuid NOT NULL REFERENCES
-- public.workspaces(id)` tenant-scoping convention.
--
-- WHAT THIS FILE DOES.
--   1. Creates table_sessions: one row per restaurant table's open/closed dine-in
--      session, workspace-scoped, with an OPTIONAL (nullable) authoritative
--      assigned_waiter_actor -- a session may legitimately be open and unassigned (e.g.
--      freshly opened before a waiter is chosen, or after an assignment was cleared).
--      Only a NON-NULL assigned_waiter_actor on an OPEN session counts toward that
--      waiter's open-assignment count for deactivation-safety purposes; this is a
--      deliberate, documented choice, not a silent default.
--   2. Creates table_session_assignment_history: append-only (no UPDATE/DELETE grant,
--      RLS default-deny, service_role bypass -- same discipline as auth_audit /
--      access_management_idempotency), one row per real assignment change.
--   3. Creates auth_assign_table_session_waiter_v3: the one dormant canonical writer
--      that ever sets table_sessions.assigned_waiter_actor. Same deterministic-lock /
--      role-based owner-authorization / cross-workspace-refusal / session-bound-
--      idempotency discipline as every prior V3 writer, EXTENDED with the frozen
--      actors-before-sessions global lock order (workspace -> every involved actor,
--      ORDER BY actor -> every affected table session, ORDER BY id).
--   4. Revises auth_set_access_user_active_v3 (CREATE OR REPLACE, guarded by a
--      predecessor-signature check proving the exact V3-E function is what is being
--      replaced) to add exactly one new rule: a waiter with one or more OPEN,
--      NON-NULL-assigned table sessions cannot be deactivated -- AUTH_WAITER_HAS_OPEN_TABLES,
--      raised AFTER authorization/idempotency-replay evaluation but BEFORE any actor
--      mutation, audit insertion, or idempotency insertion, so a stable conflict never
--      leaves a partial trace. Every other V3-E behavior (owner authorization,
--      same-workspace validation, exact target-role allowlist, auth-before-idempotency
--      order, expected-active snapshot, target-only session_version increment,
--      credential preservation, audit behavior, session_invalidated behavior, safe
--      idempotent replay, no-op behavior, service-role-only execution, pinned
--      search_path, SECURITY INVOKER) is preserved byte-for-byte. Reactivation and
--      every non-waiter deactivation are completely unaffected. The already-applied
--      V3-A/B/C/D/E migrations are NOT edited -- this is a strictly additive revision.
--   5. Does NOT widen auth_audit_event_chk: table_session_assignment_history is the
--      operational source of truth for assignment/deactivation-conflict history (per
--      spec section 14's own framing, auth_audit integration is optional "if
--      appropriate" -- V3-G keeps the surface minimal and does not add a new event).
--   6. Does NOT wire any new route -- V3-F's HTTP router remains completely unregistered
--      from index.js; this migration only prepares the database-authoritative guard the
--      NEXT phase's handler change will call into.
BEGIN;

-- Staging-positive guard (same sentinel as every prior auth migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-G refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor: the exact V3-E active-state writer, by its exact accepted
-- 9-argument signature -- proves this migration is about to CREATE OR REPLACE the real
-- V3-E function, not something else that happens to share its name, and that V3-E has
-- actually been applied. Also re-checks the same "4 legacy rows haven't drifted"
-- precondition every prior auth migration in this family checks.
DO $$
DECLARE v_bad int; v_v3e_found int;
BEGIN
  SELECT count(*) INTO v_v3e_found FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auth_set_access_user_active_v3'
     AND pg_get_function_identity_arguments(p.oid) =
       'p_workspace_id uuid, p_by_actor text, p_target_actor text, p_expected_active boolean, p_requested_active boolean, p_by_sid_hash text, p_client_request_id text, p_request_hash text, p_meta jsonb';
  IF v_v3e_found <> 1 THEN
    RAISE EXCEPTION 'V3-G refused: auth_set_access_user_active_v3 (V3-E exact signature) not found — apply V3-E first' USING ERRCODE='P0001';
  END IF;

  SELECT count(*) INTO v_bad FROM (VALUES
    ('owner','admin'), ('operator_primary','operator'), ('operator_backup','operator'), ('rider','rider')
  ) AS expected(actor, role)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.auth_actors a WHERE a.actor = expected.actor AND a.role = expected.role
  );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'V3-G refused: legacy auth_actors rows do not match the expected pre-V3-G shape — investigate before migrating' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- V3-G.1 addition -- required predecessor: the exact V3-C role-change writer, by its
-- exact accepted 9-argument signature -- proves this migration is about to CREATE OR
-- REPLACE the real V3-C function (also revised below, to add the waiter/open-table
-- guard), not something else that happens to share its name, and that V3-C has actually
-- been applied (it has -- V3-C is already live on shared staging, ledger version
-- 20260729162816 -- this migration never edits the original V3-C file, only additively
-- CREATE OR REPLACEs the live function it installed, exactly like it already does for
-- V3-E's auth_set_access_user_active_v3 above).
DO $$
DECLARE v_v3c_found int;
BEGIN
  SELECT count(*) INTO v_v3c_found FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auth_change_actor_role_v3'
     AND pg_get_function_identity_arguments(p.oid) =
       'p_workspace_id uuid, p_by_actor text, p_target_actor text, p_expected_role text, p_requested_role text, p_by_sid_hash text, p_client_request_id text, p_request_hash text, p_meta jsonb';
  IF v_v3c_found <> 1 THEN
    RAISE EXCEPTION 'V3-G refused: auth_change_actor_role_v3 (V3-C exact signature) not found — apply V3-C first' USING ERRCODE='P0001';
  END IF;
END $$;

-- ── 1) table_sessions -- one row per restaurant table's open/closed dine-in session ──
CREATE TABLE IF NOT EXISTS public.table_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id),
  table_ref             text NOT NULL CHECK (btrim(table_ref) <> ''),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- NULL = legitimately unassigned (freshly opened, or assignment cleared). Only a
  -- non-NULL value on an OPEN session counts as an authoritative open assignment.
  assigned_waiter_actor text NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NULL,
  updated_by            text NULL,
  CONSTRAINT table_sessions_closed_at_chk CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  -- Cross-table "assigned actor really belongs to this workspace" integrity -- relies on
  -- the existing auth_actors_ws_actor_key UNIQUE (workspace_id, actor) constraint (V3-A).
  -- Role eligibility (must be exactly 'waiter') is NOT declaratively expressible here
  -- (it spans a different table's mutable column) -- it is proved, under lock, inside
  -- auth_assign_table_session_waiter_v3 below, the ONLY writer of this column.
  CONSTRAINT table_sessions_assigned_waiter_workspace_fkey
    FOREIGN KEY (workspace_id, assigned_waiter_actor) REFERENCES public.auth_actors (workspace_id, actor)
);

-- One authoritative waiter per OPEN table session is already structural (a single
-- scalar column) -- this index additionally makes "every open, assigned session" an O(1)
-- lookup for the deactivation guard and the assignment-safety RPC alike.
CREATE INDEX IF NOT EXISTS table_sessions_open_assigned_idx
  ON public.table_sessions (workspace_id, assigned_waiter_actor)
  WHERE status = 'open' AND assigned_waiter_actor IS NOT NULL;

ALTER TABLE public.table_sessions ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypasses RLS.
REVOKE ALL ON public.table_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.table_sessions TO service_role;

COMMENT ON TABLE public.table_sessions IS
  'Access Control V3 -- Block V3-G: one row per restaurant table''s open/closed dine-in '
  'session. assigned_waiter_actor is nullable BY DESIGN (a session may be legitimately '
  'open and unassigned); only a non-NULL value on an OPEN session counts as an open '
  'assignment for waiter-deactivation safety. The ONLY writer of assigned_waiter_actor '
  'is auth_assign_table_session_waiter_v3. Dormant/unwired: no runtime route creates, '
  'opens, closes, or assigns a table session yet.';

-- ── 2) table_session_assignment_history -- append-only, operational source of truth ──
CREATE TABLE IF NOT EXISTS public.table_session_assignment_history (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id),
  table_session_id      uuid NOT NULL REFERENCES public.table_sessions(id),
  previous_waiter_actor text NULL,
  new_waiter_actor      text NULL,
  by_actor              text NOT NULL,
  action                text NOT NULL CHECK (action IN ('assigned', 'reassigned', 'cleared')),
  client_request_id     text NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS table_session_assignment_history_session_idx
  ON public.table_session_assignment_history (table_session_id, created_at);

ALTER TABLE public.table_session_assignment_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.table_session_assignment_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.table_session_assignment_history TO service_role;

COMMENT ON TABLE public.table_session_assignment_history IS
  'Access Control V3 -- Block V3-G: append-only assignment-change history, the '
  'operational source of truth for who was assigned to which table session and when. '
  'No UPDATE/DELETE path exists for this table (application code never issues either); '
  'RLS default-deny with zero policies, service_role bypass only.';

-- ── 3) auth_assign_table_session_waiter_v3 -- dormant canonical assignment RPC ────
-- Assigns/reassigns/clears the authoritative waiter of ONE open table session.
-- Frozen global lock order: workspace -> every involved actor (acting, previous waiter
-- if any, requested waiter if any) in ONE deterministic ORDER BY actor statement ->
-- the target table session -> idempotency (only after authorization AND session
-- validation) -> mutate -> append exactly one history row -> store idempotency response.
CREATE OR REPLACE FUNCTION public.auth_assign_table_session_waiter_v3(
  p_workspace_id uuid, p_by_actor text, p_table_session_id uuid,
  p_expected_assigned_waiter_actor text, p_requested_waiter_actor text,
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
  v_prev public.auth_actors%ROWTYPE;
  v_req public.auth_actors%ROWTYPE;
  v_sess public.table_sessions%ROWTYPE;
  v_idem public.access_management_idempotency%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_actor_set text[];
  v_action text;
  v_changed boolean;
  r public.table_sessions%ROWTYPE;
  v_result jsonb;
BEGIN
  -- ── input guards ──────────────────────────────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_table_session_id IS NULL THEN RAISE EXCEPTION 'AUTH_TABLE_SESSION_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_requested_waiter_actor IS NOT NULL AND btrim(p_requested_waiter_actor) = ''
  THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
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

  v_action := 'assign_table_session_waiter_v3';

  -- ── workspace row lock — the serialisation point ──────────────────────────
  SELECT * INTO v_ws FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ws.lifecycle_status <> 'active' THEN RAISE EXCEPTION 'WORKSPACE_NOT_ACTIVE' USING ERRCODE='22023'; END IF;

  -- ── deterministic actor-id locking — EVERY involved actor, ONE statement ──────
  -- Involved = acting owner, the session's CURRENT assigned waiter (if any -- losing an
  -- assignment is still a state change for that actor), and the REQUESTED waiter (if
  -- any -- clearing an assignment passes NULL here). Deduplicated, sorted, locked in one
  -- deterministic ORDER BY actor statement -- never a loop, never touched before the
  -- table session below.
  SELECT * INTO v_sess FROM public.table_sessions WHERE id = p_table_session_id; -- pre-lock peek only, to learn the CURRENT assignee for the actor set; re-read under lock below
  v_actor_set := ARRAY(
    SELECT DISTINCT a FROM unnest(ARRAY[p_by_actor, v_sess.assigned_waiter_actor, p_requested_waiter_actor]) a
    WHERE a IS NOT NULL
  );
  PERFORM 1 FROM public.auth_actors WHERE actor = ANY (v_actor_set) ORDER BY actor FOR UPDATE;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_INITIATOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- ── acting actor — owner semantics decided by ROLE, never the actor id ────
  IF v_by.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'AUTH_INITIATOR_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  IF v_by.role NOT IN ('admin', 'owner') THEN RAISE EXCEPTION 'AUTH_NOT_OWNER' USING ERRCODE='P0001'; END IF;

  -- ── requested waiter (NULL = explicit clear; skip eligibility check) ──────
  IF p_requested_waiter_actor IS NOT NULL THEN
    SELECT * INTO v_req FROM public.auth_actors WHERE actor = p_requested_waiter_actor;
    IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF v_req.workspace_id IS DISTINCT FROM p_workspace_id THEN
      RAISE EXCEPTION 'AUTH_TARGET_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
    IF v_req.active <> true THEN RAISE EXCEPTION 'AUTH_TARGET_INACTIVE' USING ERRCODE='22023'; END IF;
    -- Exact single-role eligibility (not a broader allowlist -- this RPC assigns ONLY
    -- waiters, unlike V3-E's multi-role lifecycle allowlist).
    IF v_req.role IS DISTINCT FROM 'waiter' THEN
      RAISE EXCEPTION 'AUTH_TARGET_ROLE_INELIGIBLE' USING ERRCODE='P0001'; END IF;
  END IF;

  -- ── table session — locked AFTER every actor, re-read fresh under lock ────
  SELECT * INTO v_sess FROM public.table_sessions WHERE id = p_table_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TABLE_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_sess.workspace_id IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'TABLE_SESSION_OTHER_WORKSPACE' USING ERRCODE='P0001'; END IF;
  IF v_sess.status <> 'open' THEN RAISE EXCEPTION 'TABLE_SESSION_NOT_OPEN' USING ERRCODE='22023'; END IF;

  -- ── idempotency lookup — ONLY now, after acting-owner, target-eligibility AND
  --    session validation are all proved against the CURRENT authoritative rows ──
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = v_action AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_idem.request_hash = p_request_hash THEN
      RETURN v_idem.response_body; -- safe replay: no mutation, no new history row
    ELSE
      RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
  END IF;

  -- ── stale-snapshot check against the locked, authoritative session row ────
  IF v_sess.assigned_waiter_actor IS DISTINCT FROM p_expected_assigned_waiter_actor THEN
    RAISE EXCEPTION 'TABLE_SESSION_ASSIGNMENT_STALE' USING ERRCODE='40001'; END IF;

  v_changed := (v_sess.assigned_waiter_actor IS DISTINCT FROM p_requested_waiter_actor);

  IF NOT v_changed THEN
    -- identical current/requested assignment — deterministic no-op, no history row.
    v_result := jsonb_build_object(
      'table_session_id', v_sess.id, 'assigned_waiter_actor', v_sess.assigned_waiter_actor,
      'status', v_sess.status, 'updated_at', v_sess.updated_at, 'updated_by', v_sess.updated_by
    );
  ELSE
    -- real assignment change — ONLY assigned_waiter_actor + attribution/timestamps on
    -- the session row. table_ref, status, opened_at, closed_at, workspace_id,
    -- created_at, created_by: untouched.
    v_action := CASE
      WHEN v_sess.assigned_waiter_actor IS NULL THEN 'assigned'
      WHEN p_requested_waiter_actor IS NULL THEN 'cleared'
      ELSE 'reassigned'
    END;

    UPDATE public.table_sessions
       SET assigned_waiter_actor = p_requested_waiter_actor, updated_at = v_now, updated_by = p_by_actor
     WHERE id = p_table_session_id
     RETURNING * INTO r;

    INSERT INTO public.table_session_assignment_history
      (workspace_id, table_session_id, previous_waiter_actor, new_waiter_actor, by_actor, action, client_request_id)
    VALUES (p_workspace_id, p_table_session_id, v_sess.assigned_waiter_actor, p_requested_waiter_actor,
            p_by_actor, v_action, p_client_request_id);

    v_result := jsonb_build_object(
      'table_session_id', r.id, 'assigned_waiter_actor', r.assigned_waiter_actor,
      'status', r.status, 'updated_at', r.updated_at, 'updated_by', r.updated_by
    );
  END IF;

  INSERT INTO public.access_management_idempotency
    (workspace_id, by_actor, by_sid_hash, action, client_request_id, request_hash, response_status, response_body)
  VALUES (p_workspace_id, p_by_actor, p_by_sid_hash, 'assign_table_session_waiter_v3', p_client_request_id, p_request_hash, 200, v_result);

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.auth_assign_table_session_waiter_v3(uuid, text, uuid, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_assign_table_session_waiter_v3(uuid, text, uuid, text, text, text, text, text, jsonb)
  TO service_role;

-- ── 4) auth_set_access_user_active_v3 -- V3-G revision: additive waiter-open-tables guard ──
-- Byte-identical to the accepted V3-E body EXCEPT for the one new block marked
-- "V3-G ADDITION" below. That block is reached ONLY for a genuinely NEW (non-replay,
-- non-no-op) deactivation attempt against a locked, authoritative role='waiter' target,
-- placed AFTER authorization/idempotency-replay evaluation and the expected-active
-- snapshot check, but BEFORE any UPDATE/INSERT -- so a conflict leaves zero trace (no
-- actor mutation, no audit row, no idempotency row).
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
  v_open_tables int;
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

  -- ── V3-G ADDITION: waiter-open-tables deactivation guard ──────────────────
  -- Only for a genuinely NEW (v_changed), real DEACTIVATION (NOT p_requested_active) of
  -- a locked, authoritative role='waiter' target. Locks every open table session
  -- currently assigned to this waiter, deterministically (ORDER BY id), so a
  -- concurrent assignment RPC touching the SAME rows serializes behind this lock too —
  -- though the PRIMARY race defense is that both RPCs already lock the waiter's
  -- auth_actors row FIRST, before either ever touches table_sessions. Raises BEFORE
  -- any UPDATE/INSERT below: no actor mutation, no audit row, no idempotency row is
  -- ever written for a rejected attempt.
  IF v_changed AND NOT p_requested_active AND v_tgt.role = 'waiter' THEN
    PERFORM 1 FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND assigned_waiter_actor = p_target_actor AND status = 'open'
     ORDER BY id FOR UPDATE;
    SELECT count(*) INTO v_open_tables FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND assigned_waiter_actor = p_target_actor AND status = 'open';
    IF v_open_tables > 0 THEN
      RAISE EXCEPTION 'AUTH_WAITER_HAS_OPEN_TABLES' USING ERRCODE='P0001';
    END IF;
  END IF;
  -- ── END V3-G ADDITION ──────────────────────────────────────────────────────

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

-- ── grants: service_role only (re-asserted; CREATE OR REPLACE preserves prior grants,
--    but this is explicit and byte-identical to V3-E's own grant statement) ──────
REVOKE ALL ON FUNCTION public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb)
  TO service_role;

-- ── 5) auth_change_actor_role_v3 -- V3-G.1 revision: waiter-open-tables guard,
--       PLUS a reorder correction ────────────────────────────────────────────────
-- Source-audit finding (V3-G.1): the committed V3-C body evaluates the idempotency
-- lookup/replay BEFORE the actor lock and authorization checks -- workspace lock ->
-- idempotency lookup -> actor lock -> authorization, the OPPOSITE of V3-E's already-
-- corrected order (actor lock -> authorization -> idempotency lookup). Under the old
-- V3-C order, a revoked/deactivated/demoted acting owner could still receive a stored
-- success response from a stale idempotency record, because authorization was never
-- re-proved before the replay short-circuit. This revision corrects that ordering to
-- match V3-E's pattern AND places the new waiter guard even earlier -- BEFORE
-- idempotency evaluation -- so a stale idempotency record can never bypass the new
-- guard either. Every other V3-C behavior (workspace lock, deterministic actor
-- locking, actor re-read under lock, active acting owner, owner semantics by role,
-- same-workspace target, owner-target rejection, expected-current-role snapshot,
-- exact requested-role allowlist, target-only role update, target-only
-- session_version increment, role_changed audit, session_invalidated audit, safe
-- no-op behavior, same-key/same-payload replay, changed-payload conflict,
-- service-role-only execution, SECURITY INVOKER, pinned search_path, no credential
-- mutation) is preserved -- only the RELATIVE ORDER of blocks changes, not their
-- content, plus the one new guard block.
--
-- New rule: when the target's authoritative locked role is 'waiter', the requested
-- role differs (v_changed), and one or more OPEN table sessions are assigned to the
-- target, the RPC locks those sessions deterministically, performs no role mutation,
-- no session_version increment, no role_changed/session_invalidated audit, no
-- idempotency insertion, and raises AUTH_WAITER_HAS_OPEN_TABLES. A waiter->waiter
-- no-op never reaches the guard (v_changed is false). Closed historical sessions
-- never block a role change (the guard only counts status='open').
--
-- V3-G.2 FIX (2026-07-31, later same day): the V3-G.1 body above placed the guard
-- AFTER the idempotency replay short-circuit -- reproduced against real PostgreSQL,
-- this let a STORED historical role-change success be replayed after an intervening
-- state change (the target reassigned back to 'waiter' and given a newly-open table
-- session) and still return the old success, bypassing the guard entirely. Fixed by
-- splitting idempotency evaluation into two parts: a changed-payload KEY lookup that
-- still conflicts immediately and unconditionally (payload-conflict detection is
-- never weakened), and a deferred "return the stored response" step that now happens
-- AFTER the guard is re-evaluated against CURRENT state -- so a genuine replay is
-- re-validated every time, while an immediate replay of an already-successful change
-- remains unaffected (its current role already differs from the replayed request's
-- requested role in the OTHER direction, so the guard's v_changed condition is false
-- and it never applies). See the numbered steps inside the function body below.
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
  v_idem_found boolean;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_old_role text;
  v_changed boolean;
  v_open_tables int;
  v_result jsonb;
BEGIN
  -- ── input guards (byte-identical to V3-C) ─────────────────────────────────
  IF p_workspace_id IS NULL THEN RAISE EXCEPTION 'AUTH_WORKSPACE_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_INITIATOR_REQUIRED' USING ERRCODE='22023'; END IF;
  IF p_target_actor IS NULL OR btrim(p_target_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_INVALID' USING ERRCODE='22023'; END IF;
  IF p_expected_role IS NULL OR btrim(p_expected_role) = '' THEN RAISE EXCEPTION 'AUTH_ROLE_INVALID' USING ERRCODE='22023'; END IF;
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

  -- ── 2) deterministic actor-id locking — acting + target, ordered ─────────────
  -- V3-G.1 REORDER: moved BEFORE idempotency lookup (was after, in the committed V3-C
  -- body) -- authorization must be proved BEFORE any idempotency lookup/replay, exactly
  -- like V3-E's own corrected pattern: a revoked, deactivated, or demoted acting actor
  -- must never receive a stored success response merely because a matching idempotency
  -- record exists from when they WERE authorized.
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

  -- ── 6) idempotency KEY lookup — ONLY now, after acting-owner AND target identity
  --    are both proved against the CURRENT authoritative rows under lock (V3-G.1
  --    REORDER, preserved). V3-G.2 FIX: this fetches the stored row but does NOT yet
  --    return it — a changed-payload reuse of the same key conflicts IMMEDIATELY,
  --    unconditionally, exactly as before and BEFORE anything else runs (payload-
  --    conflict detection must never be preempted by the guard below). ─────────────
  SELECT * INTO v_idem FROM public.access_management_idempotency
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor AND by_sid_hash = p_by_sid_hash
     AND action = 'change_actor_role' AND client_request_id = p_client_request_id;
  -- Captured into a dedicated variable IMMEDIATELY: the guard block below (step 8)
  -- runs its own SELECT/PERFORM statements, which would silently overwrite the
  -- ambient FOUND variable if it were relied on any later than this line.
  v_idem_found := FOUND;
  IF v_idem_found AND v_idem.request_hash <> p_request_hash THEN
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
  END IF;

  -- ── 7) identify the CURRENT operation from the locked, authoritative target row —
  --    computed unconditionally, for BOTH a genuine replay and a brand-new request
  --    (the guard in step 8 needs it either way). This is NOT the expected-role
  --    staleness check (that stays gated to the brand-new-request path in step 9,
  --    below the replay short-circuit — checking it here would reintroduce the
  --    exact bug V3-G.1 already fixed: replaying an already-decided request would
  --    incorrectly fail AUTH_TARGET_ROLE_MISMATCH against the target's now-different
  --    CURRENT role instead of returning the stored response). ─────────────────────
  v_old_role := v_tgt.role;
  v_changed := (v_old_role <> p_requested_role);

  -- ── 8) V3-G.2 FIX — waiter-open-tables role-change guard: ALWAYS evaluated against
  --    CURRENT authoritative state, for BOTH a genuine replay and a brand-new
  --    request. V3-G.1 placed this guard AFTER the idempotency short-circuit, so a
  --    STORED historical success could be replayed after intervening state changes
  --    (the target reassigned back to waiter and given an open table session) and
  --    still return the old success — a real bypass, reproduced against real
  --    PostgreSQL and closed here. Moving the guard here — after the changed-payload
  --    conflict check (step 6) but before the replay-return (step 9) — means a
  --    genuine replay is re-validated against CURRENT truth every time, while a
  --    changed-payload reuse still conflicts first, and an immediate replay of an
  --    already-successful change is unaffected (its CURRENT role already differs
  --    from p_requested_role in the OTHER direction, so v_changed there is false and
  --    the guard never applies). Only for a genuinely changed role (v_changed) AWAY
  --    from a locked, authoritative role='waiter' target — locks every open table
  --    session currently assigned to this waiter, deterministically (ORDER BY id).
  --    Raises BEFORE any mutation, audit, replay-return, or idempotency INSERT below
  --    — a rejected attempt (replay or new) writes nothing and returns nothing stale.
  IF v_changed AND v_old_role = 'waiter' THEN
    PERFORM 1 FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND assigned_waiter_actor = p_target_actor AND status = 'open'
     ORDER BY id FOR UPDATE;
    SELECT count(*) INTO v_open_tables FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND assigned_waiter_actor = p_target_actor AND status = 'open';
    IF v_open_tables > 0 THEN
      RAISE EXCEPTION 'AUTH_WAITER_HAS_OPEN_TABLES' USING ERRCODE='P0001';
    END IF;
  END IF;

  -- ── 9) genuine replay (same key, same payload) — survived the guard above, so it
  --    is safe to return the stored response: no mutation, no new audit, no re-check
  --    of expected-role staleness. Uses v_idem_found (captured at step 6), NEVER the
  --    ambient FOUND — the guard's own SELECT/PERFORM statements overwrite FOUND. ──
  IF v_idem_found THEN
    RETURN v_idem.response_body;
  END IF;

  -- ── 10) brand-new request (no stored idempotency row): expected current role must
  --     match the locked, authoritative target row (unchanged V3-C behavior/order —
  --     this stays AFTER the guard so a brand-new attempt against an open-assigned
  --     waiter reports the same AUTH_WAITER_HAS_OPEN_TABLES conflict a replay would,
  --     rather than a less specific staleness error). ────────────────────────────────
  IF v_tgt.role <> p_expected_role THEN RAISE EXCEPTION 'AUTH_TARGET_ROLE_MISMATCH' USING ERRCODE='22023'; END IF;

  IF NOT v_changed THEN
    -- ── identical current/requested role — deterministic no-op, no session_version
    --    bump, no audit row. Still recorded below so a literal replay of this exact
    --    no-op request is itself idempotent. ──────────────────────────────────────
    v_result := jsonb_build_object(
      'actor', v_tgt.actor, 'old_role', v_old_role, 'role', v_tgt.role,
      'session_version', v_tgt.session_version, 'changed', false,
      'updated_at', v_tgt.updated_at, 'updated_by', v_tgt.updated_by
    );
  ELSE
    -- ── real change — ONLY role + session_version on the TARGET row; pin_hash,
    --    fingerprint rows, active, display_name, failed_count, locked_until are
    --    never touched (the UPDATE below does not name them, and nothing else in
    --    this function writes to any other actor or to auth_actor_pin_fingerprints)
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

-- ── grants: service_role only (re-asserted; CREATE OR REPLACE preserves prior grants,
--    but this is explicit and byte-identical to V3-C's own grant statement) ──────
REVOKE ALL ON FUNCTION public.auth_change_actor_role_v3(uuid, text, text, text, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_change_actor_role_v3(uuid, text, text, text, text, text, text, text, jsonb)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
