-- migrations/2026-08-09_service_closeout_cross_service_table_policy.sql
-- SERVICE CLOSEOUT V2 / SLICE 4C.2C — cross-service table-boundary policy at
-- the database layer, plus auto-resolution truth ordering.
-- STAGING ONLY. Additive/CREATE-OR-REPLACE-only: no table dropped, no column
-- dropped, no destructive rewrite.
--
-- ── THE GAP THIS CLOSES ──────────────────────────────────────────────────
-- language-guard: allow-legacy chiudiServizio is the existing JS close function (src/utils/servizio.js), named here for audit context, not new vocabulary
-- SLICE 4C.1 taught chiudiServizio()'s OWN JS-level mesa_tables_not_released
-- gate to let a legitimate occupied table_session span the automatic
-- incident-safe rollover's service boundary (closeContext.
-- allowOpenTablesAcrossBoundary, set only by incidentSafeRollover.js). The
-- first real staging attempt after that fix proved the JS gate was not the
-- only one: begin_service_session_close() (open->closing) has its OWN
-- independent inline open-table check, and guard_service_session_closed_v1
-- (closing->closed, 2026-07-26_two_service_identity.sql) has a THIRD,
-- independent one. Fixing only one would just move the failure to the next.
--
-- ── THE SIGNAL: no new boolean, no new column ───────────────────────────
-- Per the accepted design brief: prefer one canonical policy signal over a
-- fourth/fifth duplicated parameter. This migration adds none — it reuses
-- the ALREADY-AUTHORITATIVE fact that only the incident-safe orchestrator
-- can ever produce: an 'active' row in service_closeout_attempts for this
-- exact service_session_id. That row can only exist because
-- acquire_closeout_attempt() created it (2026-08-08_service_closeout_
-- attempt_ownership.sql) — an RPC with no HTTP route anywhere (verified by
-- tests/closeoutAttemptOwnership.static.test.js) and reachable only via the
-- H1B transport allowlist entry SLICE 4C.2A added for incidentSafeRollover.js
-- specifically.
-- language-guard: allow-legacy chiudiServizio is the existing JS close function, named here for audit context, not new vocabulary
-- A manual "chiudiServizio" HTTP close, or any untrusted direct
-- UPDATE, can therefore NEVER cause an active attempt to exist for a session
-- it didn't legitimately reach through that orchestrator — there is no
-- request body field, querystring, or caller-supplied string that forges it.
-- Both functions below simply ask "does a real, already-committed active
-- attempt exist for this session" before enforcing the open-table rule;
-- manual close (no attempt) is completely unchanged.
--
-- ── AUTO-RESOLUTION ORDERING (Bug C) ─────────────────────────────────────
-- The same real run also showed create_service_incident recording
-- EMPTY_TABLE_LEFT_OPEN as resolution_status='resolved' at INSERT time
-- (autoResolve:true, decided at classification time) — before the actual
-- release RPC call even ran. supersede_closeout_attempt's existing
-- incident-reconciliation cascade (SLICE 3.2) only rewrites 'pending'/
-- 'acknowledged' rows, so a prematurely-'resolved' auto-claim was never
-- reachable by it. This migration widens that ONE cascade condition to also
-- catch resolution_type='auto_released_empty_table' rows — a system claim
-- that hasn't been re-verified — while a genuine admin resolution (any other
-- resolution_type) stays permanently protected, exactly as before. The JS
-- side (incidentSafeRollover.js, same commit) now only ever creates an
-- EMPTY_TABLE_LEFT_OPEN incident as pending, and transitions it to resolved
-- via resolve_service_incident ONLY after the release RPC call actually
-- confirms success.
--
-- ── BUG B: no "system" auth_actors row ───────────────────────────────────
-- mesa_release_empty_session_v1 requires p_by_actor to resolve to a real,
-- active auth_actors row with an allowed role — correct for its real caller
-- (a human operator/admin releasing a table via the Mesa UI,
-- mesaService.js releaseEmptyTable()). The automatic orchestrator has no
-- human actor and must not impersonate one. mesa_release_empty_session_auto_v1
-- below is the minimal "explicit trusted system path": the identical
-- session/covers checks, no actor-authorization block, service_role-only
-- grant (never HTTP-exposed, matching acquire_closeout_attempt/
-- capture_closeout_snapshot's own established convention of an unauthenticated
-- p_actor/updated_by label for internal-only automatic RPCs). No new
-- auth_actors row, non-login, impossible to use as a credential — it is not
-- a credential at all, just a service-role-gated function.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'cross-service table policy refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_closeout_attempts') IS NULL
     OR to_regclass('public.service_incidents') IS NULL
     OR to_regclass('public.table_sessions') IS NULL
  THEN RAISE EXCEPTION 'cross-service table policy refused: service session / closeout attempt / incident / table session foundation missing (apply rows 53 and 55 first)'; END IF;

  IF to_regprocedure('public.begin_service_session_close(text,text)') IS NULL
     OR to_regprocedure('public.guard_service_session_closed_v1()') IS NULL
     OR to_regprocedure('public.supersede_closeout_attempt(uuid,text,text)') IS NULL
     OR to_regprocedure('public.mesa_release_empty_session_v1(uuid,text,uuid)') IS NULL
  THEN RAISE EXCEPTION 'cross-service table policy refused: one or more target functions to replace do not exist — resolve drift first.'; END IF;

  IF to_regprocedure('public.mesa_release_empty_session_auto_v1(uuid,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'cross-service table policy refused: mesa_release_empty_session_auto_v1 already exists — resolve drift first.'; END IF;
END $$;

-- ── STEP 1 — begin_service_session_close: skip the open-table check only
-- when an active incident-safe closeout attempt owns this exact session ────
CREATE OR REPLACE FUNCTION public.begin_service_session_close(p_closed_by text, p_source text DEFAULT 'backend'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;
  IF v_state.current_session_id IS NULL THEN
    IF v_state.recent_closed_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','NO_SERVICE_SESSION');
    END IF;
    SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.recent_closed_session_id;
    IF NOT FOUND OR v_session.status <> 'closed' THEN
      RETURN jsonb_build_object('ok',false,'code','INVALID_RECENT_CLOSED_SESSION');
    END IF;
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  SELECT * INTO v_session FROM public.service_sessions
   WHERE id=v_state.current_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CURRENT_SERVICE_SESSION');
  END IF;
  IF v_session.status='open' THEN
    -- SLICE 4C.2C — an active, already-committed incident-safe closeout
    -- attempt for THIS exact session is the sole, unforgeable signal that
    -- this close is the accepted cross-service rollover, not a manual one.
    IF NOT EXISTS (
      SELECT 1 FROM public.service_closeout_attempts
       WHERE service_session_id = v_session.id AND status = 'active'
    ) THEN
      PERFORM 1 FROM public.table_sessions
       WHERE service_session_id=v_session.id AND status = 'open'
       ORDER BY id FOR UPDATE;
      IF FOUND THEN
        RETURN jsonb_build_object('ok',false,'code','MESA_TABLES_NOT_RELEASED');
      END IF;
    END IF;
    UPDATE public.service_sessions
       SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now()
     WHERE id=v_session.id;
    INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
    VALUES(v_session.id,'closing',p_closed_by,p_source);
  END IF;
  RETURN jsonb_build_object('ok',true,'code','CLOSING','session',to_jsonb(v_session));
END
$function$;

-- ── STEP 2 — guard_service_session_closed_v1: same signal, same exemption,
-- for the closing->closed transition. The active-orders check is untouched —
-- it is a different rule, out of this slice's scope, and by the time a
-- successful automatic close reaches this UPDATE its own ordenes rows have
-- language-guard: allow-legacy chiudiServizio is the existing JS close function, named here for audit context, not new vocabulary
-- already been archived/deleted (chiudiServizio PASSO 10), so it is not
-- expected to fire on a real automatic close either way. ─────────────────
CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.service_closeout_attempts
       WHERE service_session_id = OLD.id AND status = 'active'
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM public.table_sessions t
        WHERE t.service_session_id = OLD.id
          AND t.status = 'open'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MESA_TABLES_NOT_RELEASED';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            -- language-guard: allow-legacy COMPLETATO is the existing terminal-state literal from guard_service_session_closed_v1's unchanged active-orders check (2026-08-02_service_close_live_work_guard.sql), restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated verbatim for the same reason
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

-- ── STEP 3 — trusted-system empty-table release (Bug B) ─────────────────
-- Identical session/covers guard clauses to mesa_release_empty_session_v1,
-- minus the human-actor authorization block that RPC correctly requires for
-- its real (human, HTTP-reachable) caller. service_role-only; never granted
-- to anon/authenticated; never referenced by any HTTP action — the H1B
-- resource-policy registry (src/utils/supabaseResourcePolicy.js, same commit)
-- is the only thing standing between this function and the network, exactly
-- like every other internal-only closeout RPC.
CREATE OR REPLACE FUNCTION public.mesa_release_empty_session_auto_v1(
  p_workspace_id uuid,
  p_table_session_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL THEN
    RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NOT NULL THEN
    RAISE EXCEPTION 'MESA_TABLE_HAS_ORDERS' USING ERRCODE='55000';
  END IF;

  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = 'system'
  WHERE id = v_session.id;

  RETURN jsonb_build_object('ok', true, 'tableId', v_session.table_id, 'status', 'closed');
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_release_empty_session_auto_v1(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_release_empty_session_auto_v1(uuid,uuid) TO service_role;

-- ── STEP 4 — supersede_closeout_attempt: reconcile a premature system
-- auto-resolution claim too (Bug C recovery path), never a genuine admin one ──
CREATE OR REPLACE FUNCTION public.supersede_closeout_attempt(
  p_closeout_correlation_id uuid,
  p_actor                   text,
  p_reason                  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_row public.service_closeout_attempts%ROWTYPE;
BEGIN
  IF p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object('ok',false,'code','CANNOT_SUPERSEDE_COMPLETED_ATTEMPT');
  END IF;
  IF v_row.status = 'superseded' THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_SUPERSEDED','idempotent',true,'attempt',to_jsonb(v_row));
  END IF;

  UPDATE public.service_closeout_attempts
     SET status = 'superseded', superseded_at = now(), supersession_reason = p_reason, updated_at = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
  RETURNING * INTO v_row;

  -- SLICE 4C.2C — widened from 'pending'/'acknowledged' to ALSO reconcile a
  -- resolution_status='resolved' row whose resolution_type is specifically
  -- 'auto_released_empty_table' (a system claim of success that this
  -- migration's JS-side fix now only ever records AFTER real confirmation,
  -- but which may still exist from before this fix, or could in principle
  -- recur from a race). A genuine admin resolution (any OTHER
  -- resolution_type) is NEVER touched by this OR clause — it stays
  -- permanently terminal, exactly as before.
  UPDATE public.service_incidents
     SET resolution_status = 'superseded',
         resolution_type   = 'closeout_attempt_superseded',
         resolved_by       = p_actor,
         resolved_at       = now(),
         updated_at        = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
     AND (
       resolution_status IN ('pending','acknowledged')
       OR (resolution_status = 'resolved' AND resolution_type = 'auto_released_empty_table')
     );

  RETURN jsonb_build_object('ok',true,'code','SUPERSEDED','idempotent',false,'attempt',to_jsonb(v_row));
END;
$fn$;

-- No new grants needed for begin_service_session_close/
-- guard_service_session_closed_v1/supersede_closeout_attempt — CREATE OR
-- REPLACE with an unchanged signature preserves their existing grants
-- (verified: all three keep their exact original argument lists).
COMMIT;
