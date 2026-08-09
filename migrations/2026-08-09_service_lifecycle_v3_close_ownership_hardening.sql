-- migrations/2026-08-09_service_lifecycle_v3_close_ownership_hardening.sql
-- SERVICE LIFECYCLE V3 / SLICE 3.2.1 — close ownership + occupied-table
-- authorization hardening. STAGING ONLY, additive CREATE OR REPLACE only (no
-- new table, no destructive statement). Requires row 58 (2026-08-09_service_
-- lifecycle_v3_close_engine.sql) already applied — this migration hardens
-- exactly the two functions that row created, restating each in full
-- (CREATE OR REPLACE requires the complete body), guarded by a
-- predecessor-body check against drift, same discipline row 57/58 already
-- established.
--
-- ── WHY THIS EXISTS (SLICE 3.2.1 audit finding) ─────────────────────────────
-- guard_service_session_closed_v1's V3.2 exemption (row 58, PART 3) skips the
-- occupied-table check whenever `EXISTS (SELECT 1 FROM service_closeouts
-- WHERE service_session_id = OLD.id)` — but that trigger fires on ANY UPDATE
-- that sets service_sessions.status = 'closed', regardless of which caller or
-- function performs it. A service_closeouts row, once created by
-- create_service_closeout for a session, is PERMANENT (append-only, no
-- UPDATE/DELETE path). So a LATER, SEPARATE direct service-role write to that
-- SAME session's status column — e.g. a bug, a future ad hoc admin script, or
-- any other code path that ever does `UPDATE service_sessions SET
-- status='closed'` directly instead of calling close_service_session_v3 —
-- would ALSO silently benefit from the occupied-table exemption, forever,
-- purely because the row exists. The exemption was scoped to "a V3 closeout
-- exists for this session" when it needed to be scoped to "THIS EXACT UPDATE
-- IS the authorized V3 transition performing it."
--
-- ── THE FIX — a transaction-local, unforgeable-by-caller marker ────────────
-- close_service_session_v3 now calls `PERFORM set_config('ladieci.v3_close_
-- authorized_session_id', v_session.id::text, true)` immediately before its
-- own UPDATE — is_local=true means the setting is scoped to (and reverted at
-- the end of) the CURRENT transaction only. PostgREST executes one
-- transaction per request (whether a table PATCH or an RPC POST), so no
-- caller reachable through the actual deployed API surface can ever set this
-- GUC itself: it is set only by this function's own compiled body, which only
-- a schema migration (not a runtime service_role caller) can change. The
-- trigger's exemption now requires BOTH this marker (matching OLD.id exactly)
-- AND the service_closeouts row — either alone is insufficient:
--   * a direct UPDATE (no RPC call) never sets the marker -> still DENIED,
--     even when a service_closeouts row already exists from an earlier,
--     genuinely-authorized V3 close of a DIFFERENT prior session lifecycle
--     is not reusable here in any case (service_closeouts_session_uq is
--     one-row-per-session), but the point holds regardless: presence of the
--     row alone is no longer sufficient.
--   * an active service_closeout_attempts row alone was never part of this
--     exemption's condition (row 58 deliberately excluded it) and still
--     isn't.
-- language-guard: allow-legacy chiudiServizio/begin_service_session_close are named here only to state that this legacy path is UNAFFECTED (it never sets the marker), not new vocabulary
--   * the legacy chiudiServizio/begin_service_session_close path never sets
--     the marker and never creates a service_closeouts row -> its own
--     open-table policy is completely unchanged.
-- No new column, table, role, or grant. No HTTP-reachable parameter of any
-- kind influences this GUC — close_service_session_v3's signature is
-- unchanged (still exactly service_session_id/correlation_id/closed_by/
-- source), so there is no `allowOpenTablesAcrossBoundary`-shaped override for
-- a caller to even attempt to pass.
--
--   PART 1 — close_service_session_v3: adds ONE PERFORM set_config(...) line
--            immediately before its terminal UPDATE. Nothing else in this
--            function changes (same signature, same checks, same advisory
--            lock, same idempotent ALREADY_CLOSED branch).
--   PART 2 — guard_service_session_closed_v1: tightens the row-58 exemption
--            condition from `NOT EXISTS(closeout)` to `NOT (marker-matches
--            AND EXISTS(closeout))`. SERVICE_ACTIVE_ORDERS_NOT_RESOLVED stays
--            completely untouched, exactly as row 58 left it.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'close ownership hardening refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.guard_service_session_closed_v1()') IS NULL
  THEN RAISE EXCEPTION 'close ownership hardening refused: row 58 (service lifecycle v3 close engine) not applied — apply it first'; END IF;
END $$;

-- ── PREDECESSOR-BODY GUARDS — refuse to apply over drifted/already-patched
-- functions (same discipline as row 57's mesa_prepare_table_order_v1 fix and
-- row 58's own guard_service_session_closed_v1 fix). ────────────────────────
DO $$
DECLARE v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'close_service_session_v3'
     AND pg_get_function_identity_arguments(p.oid) = 'p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'close ownership hardening refused: close_service_session_v3 body not found';
  END IF;
  IF v_body NOT LIKE '%SET status = ''closed'', closed_at = now(), closed_by = p_closed_by,%' THEN
    RAISE EXCEPTION 'close ownership hardening refused: close_service_session_v3 does not match the expected row-58 body (terminal UPDATE not found) — resolve drift first';
  END IF;
  IF v_body LIKE '%v3_close_authorized_session_id%' THEN
    RAISE EXCEPTION 'close ownership hardening refused: close_service_session_v3 already references v3_close_authorized_session_id — already patched, resolve drift first';
  END IF;
END $$;

DO $$
DECLARE v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_service_session_closed_v1' AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'close ownership hardening refused: guard_service_session_closed_v1 body not found';
  END IF;
  IF v_body NOT LIKE '%MESA_TABLES_NOT_RELEASED%' THEN
    RAISE EXCEPTION 'close ownership hardening refused: guard_service_session_closed_v1 does not match the expected row-58 body (MESA_TABLES_NOT_RELEASED check not found) — resolve drift first';
  END IF;
  IF v_body NOT LIKE '%service_closeouts%' THEN
    RAISE EXCEPTION 'close ownership hardening refused: guard_service_session_closed_v1 does not yet carry the row-58 service_closeouts exemption — apply row 58 first';
  END IF;
  IF v_body LIKE '%v3_close_authorized_session_id%' THEN
    RAISE EXCEPTION 'close ownership hardening refused: guard_service_session_closed_v1 already references v3_close_authorized_session_id — already patched, resolve drift first';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — close_service_session_v3: sets the transaction-local trusted-
-- transition marker immediately before the terminal UPDATE. Everything else
-- (signature, checks, advisory lock, idempotent branch) is byte-identical to
-- row 58's body — see tests/serviceLifecycleV3CloseOwnershipHardening.
-- static.test.js for the line-for-line diff proof.
CREATE OR REPLACE FUNCTION public.close_service_session_v3(
  p_service_session_id      uuid,
  p_closeout_correlation_id uuid,
  p_closed_by               text,
  p_source                  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'closed' THEN
    IF v_state.recent_closed_session_id = v_session.id AND v_state.current_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS');
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE service_session_id = p_service_session_id
       AND closeout_correlation_id = p_closeout_correlation_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_NOT_FOUND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
       AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  -- SLICE 3.2.1 — the trusted-transition marker. Transaction-local
  -- (is_local=true): reverted automatically at commit or rollback, never
  -- visible to any other transaction/request. See guard_service_session_
  -- closed_v1 (PART 2 below) for the matching check. Bound to the EXACT
  -- session id — a single PostgREST request is a single function call is a
  -- single transaction, so this can never leak across sessions or callers.
  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$fn$;
-- Grants unchanged by CREATE OR REPLACE (same discipline noted in row 58 for
-- guard_service_session_closed_v1): still service_role-only EXECUTE, granted
-- by row 58, never re-granted to PUBLIC/anon/authenticated here.

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — guard_service_session_closed_v1: the exemption now requires the
-- marker PART 1 sets, in addition to the service_closeouts row row 58 already
-- required. SERVICE_ACTIVE_ORDERS_NOT_RESOLVED is untouched — identical to
-- row 58's own body, comment-stripped.
CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    -- SLICE 3.2.1 EXEMPTION — see this migration's header for the full audit.
    -- Skips the occupied-table check ONLY when BOTH: (a) the transaction-local
    -- marker close_service_session_v3 sets (PART 1 above) names this EXACT
    -- session, proving THIS UPDATE is the authorized V3 transition itself,
    -- not merely a later, separate write to a session that happens to have a
    -- closeout on file; AND (b) a service_closeouts row already exists for
    -- this session (the row-58 precondition, kept as defense in depth — a
    -- future caller that set the marker without going through PART 1's own
    -- CLOSEOUT_NOT_FOUND check is still not exempted by the marker alone).
    IF NOT (
      current_setting('ladieci.v3_close_authorized_session_id', true) = OLD.id::text
      AND EXISTS (
        SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
      )
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
            -- language-guard: allow-legacy COMPLETATO is the existing terminal-state literal from guard_service_session_closed_v1's live body, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
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
$fn$;
-- guard_service_session_closed_v1 keeps its existing trigger-function grants
-- (CREATE OR REPLACE does not reset them — same note as row 58).

-- No new table, no RLS/GRANT boilerplate — both PARTs above are CREATE OR
-- REPLACE of existing, already-granted functions only.

COMMIT;
