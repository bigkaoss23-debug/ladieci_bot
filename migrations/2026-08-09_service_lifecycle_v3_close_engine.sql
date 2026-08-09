-- migrations/2026-08-09_service_lifecycle_v3_close_engine.sql
-- SERVICE LIFECYCLE V3 / SLICE 3.2 — authoritative close engine, HAPPY PATH ONLY.
-- STAGING ONLY. NEW ENGINE, NO LEGACY CLOSEOUT: this migration never touches
-- language-guard: allow-legacy chiudiServizio/storico/serata_summary are named here only to state what this migration does NOT touch, not new vocabulary
-- chiudiServizio, begin_service_session_close, storico, or serata_summary, and
-- does not depend on retired row 56 (2026-08-09_service_closeout_cross_service_
-- table_policy.sql, UNAPPLIED). Two additive RPCs plus one minimal, surgical
-- CREATE OR REPLACE of an existing trigger function, bundled in one migration
-- because the trigger change only exists to make the two new RPCs' own stated
-- contract (an occupied table may survive a V3 close) true at the DB layer —
-- splitting them would leave the RPCs unable to do what they document.
--
--   PART 1 — create_service_closeout: idempotent, INSERT-or-fetch persistence
--            of the ONE authoritative service_closeouts row for a session.
--   PART 2 — close_service_session_v3: the V3-native terminal transition
--            (service_sessions -> 'closed'), replacing the legacy begin/
--            complete_service_session_close two-phase dance the engine is
--            forbidden from calling.
--   PART 3 — guard_service_session_closed_v1: ONE new, narrowly-scoped
--            exemption (see its own header below for the full audit).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 close engine refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_state') IS NULL
     OR to_regclass('public.service_session_audit') IS NULL
     OR to_regclass('public.service_closeout_attempts') IS NULL
     OR to_regclass('public.service_closeouts') IS NULL
     OR to_regclass('public.table_sessions') IS NULL
     OR to_regclass('public.ordenes') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 close engine refused: Service Lifecycle V3 foundation (rows 44/53/55/57) missing — apply those first'; END IF;

  IF to_regprocedure('public.guard_service_session_closed_v1()') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 close engine refused: guard_service_session_closed_v1 missing — apply 2026-07-26_two_service_identity first'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('create_service_closeout', 'close_service_session_v3')
  ) THEN RAISE EXCEPTION 'service lifecycle v3 close engine refused: target function already exists — resolve drift first.'; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — create_service_closeout: the ONLY writer of service_closeouts.
-- Mirrors capture_closeout_snapshot's exact idempotency recipe (2026-08-08_
-- service_closeout_incidents_foundation.sql): INSERT ... ON CONFLICT
-- (closeout_correlation_id) DO NOTHING, re-SELECT on conflict, verify the
-- caller-supplied service_session_id still matches the existing row before
-- declaring ALREADY_EXISTS (never silently hand back a DIFFERENT session's
-- closeout under a colliding correlation id). business_date/service_kind/
-- opened_at are derived server-side from service_sessions, never caller-
-- supplied, same discipline as capture_closeout_snapshot. Requires an ACTIVE
-- service_closeout_attempts row owning the exact (session, correlation) pair —
-- "scoped to a valid V3 attempt", not just any caller-supplied uuid pair.
-- total_discounts_cents is always 0: V3.2's reconciliation (JS orchestrator,
-- src/serviceSessions/serviceLifecycleEngine.js) has no clean canonical
-- discount source and does not fabricate one; the column exists for a future
-- slice that does. Every RETURN is a jsonb {ok,code,...} object — this
-- function never RAISEs for an expected/business outcome (Convention A, same
-- as every other Service Closeout V2/V3 lifecycle RPC in this repo).
CREATE OR REPLACE FUNCTION public.create_service_closeout(
  p_service_session_id       uuid,
  p_closeout_correlation_id  uuid,
  p_closed_by                text,
  p_source                   text,
  p_close_reason             text,
  p_gross_sales_cents        integer,
  p_net_sales_cents          integer,
  p_total_refunds_cents      integer,
  p_total_void_cents         integer,
  p_paid_amount_cents        integer,
  p_unpaid_exposure_cents    integer,
  p_order_count              integer,
  p_cash_amount_cents        integer,
  p_card_amount_cents        integer,
  p_bizum_amount_cents       integer,
  p_other_amount_cents       integer,
  p_open_orders_at_close     integer,
  p_occupied_tables_at_close integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_attempt public.service_closeout_attempts%ROWTYPE;
  v_row     public.service_closeouts%ROWTYPE;
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
  IF p_gross_sales_cents IS NULL OR p_gross_sales_cents < 0
     OR p_net_sales_cents IS NULL OR p_net_sales_cents < 0
     OR p_paid_amount_cents IS NULL OR p_paid_amount_cents < 0
     OR p_unpaid_exposure_cents IS NULL OR p_unpaid_exposure_cents < 0
     OR p_order_count IS NULL OR p_order_count < 0
  THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_FINANCIAL_FIELDS');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  SELECT * INTO v_attempt FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;
  IF v_attempt.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_SESSION_MISMATCH');
  END IF;
  IF v_attempt.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  INSERT INTO public.service_closeouts(
    service_session_id, closeout_correlation_id, business_date, service_kind,
    opened_at, closed_at, close_source, close_reason, closed_by,
    gross_sales_cents, net_sales_cents, total_discounts_cents, total_refunds_cents, total_void_cents,
    paid_amount_cents, unpaid_exposure_cents, order_count,
    cash_amount_cents, card_amount_cents, bizum_amount_cents, other_amount_cents,
    open_orders_at_close, occupied_tables_at_close
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0)
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,'closeout',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeouts WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_EXISTS','created',false,'closeout',to_jsonb(v_row));
END;
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — close_service_session_v3: the V3-native terminal transition.
-- Deliberately does NOT call begin_service_session_close/complete_service_
-- session_close (forbidden — "begin_service_session_close() legacy flow" is on
-- the hard ban list) and does not go through the legacy two-phase open->
-- closing->closed dance those RPCs implement: V3.2's happy path already
-- requires every order terminal BEFORE this is ever called (enforced in JS —
-- see serviceLifecycleEngine.js's UNSUPPORTED_NON_HAPPY_PATH gate — and
-- independently backstopped by the untouched SERVICE_ACTIVE_ORDERS_NOT_
-- RESOLVED check inside guard_service_session_closed_v1, PART 3 below), so
-- there is no "let in-flight work finish" phase left to model. One direct
-- open/closing -> closed transition, mirroring complete_service_session_
-- close's second half (session_state bookkeeping, audit row) but performing
-- the status UPDATE itself rather than requiring a prior begin_service_
-- session_close call. Reuses the SAME advisory lock name
-- ('service_session_lifecycle') the legacy RPCs use, specifically so a V3
-- close and a legacy close can never race on the shared service_session_state
-- singleton even if both were ever somehow in flight at once — this is the
-- "true DB integrity primitive, audited before use" Step 6 asks for; it is a
-- generic Postgres advisory-lock namespace, not legacy close orchestration.
-- Idempotent: a retry after this RPC already succeeded (e.g. attempt.complete()
-- crashed afterward) returns ALREADY_CLOSED rather than erroring, mirroring
-- complete_service_session_close's own idempotent-already-closed branch
-- exactly. Requires service_closeouts to already exist for the EXACT (session,
-- correlation) pair being closed — enforced here independently of PART 3's
-- trigger exemption, which checks the same table by session id alone; this
-- RPC's own check is strictly stronger (also pins the correlation id) and is
-- what the JS engine actually depends on for correctness, not the trigger.
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

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — guard_service_session_closed_v1: ONE new, narrowly-scoped exemption.
--
-- ── WHY THIS TRIGGER HAS TO CHANGE AT ALL ───────────────────────────────────
-- guard_service_session_closed_v1 is a BEFORE UPDATE OF status ON
-- service_sessions trigger — it fires on ANY UPDATE that sets status='closed',
-- regardless of which function performs it, including PART 2's brand-new RPC
-- above. Its live body's MESA_TABLES_NOT_RELEASED check has NO exemption of
-- any kind (confirmed by reading the actual live/applied body, not assumed —
-- the exemption drafted for it in row 56, 2026-08-09_service_closeout_cross_
-- service_table_policy.sql, is UNAPPLIED and this migration does not depend
-- on it, reference it, or resurrect its mechanism). So Step 9's required V3.2
-- scenario — a service closes while a legitimately-occupied table survives —
-- is impossible without either touching this trigger, or NOT using the real
-- service_sessions.status column as the close signal (rejected: duplicating
-- session-close state outside service_sessions was explicitly out of bounds,
-- and status IS the one canonical lifecycle column every other reader of
-- service_sessions already trusts).
--
-- ── WHY THIS IS "audit and reuse", NOT "extend legacy close machinery" ──────
-- This is a passive DB data-integrity guard, not orchestration: it does not
-- language-guard: allow-legacy storico/serata_summary are named here only to state what this trigger change does NOT add, not new vocabulary
-- decide HOW to close a service (no storico, no serata_summary, no order
-- deletion — none of that lives here or is added here), it only vetoes WHEN a
-- status write to 'closed' is allowed to stick. Only the MESA_TABLES_NOT_
-- RELEASED half is touched; SERVICE_ACTIVE_ORDERS_NOT_RESOLVED is left
-- completely unconditional below — happy-path orders are already verified
-- terminal in JS before PART 2 is ever called, so that check should never
-- fire for a legitimate V3.2 close, and this migration does not weaken it.
--
-- ── WHY THE NEW CONDITION IS SAFE AND CANNOT LEAK TO THE LEGACY PATH ────────
-- The exemption is gated on `EXISTS (SELECT 1 FROM service_closeouts WHERE
-- service_session_id = OLD.id)` — NOT on service_closeout_attempts (which
-- V2's incidentSafeRollover.js / row 56 also read+write, and which would
-- therefore silently re-open the legacy path's own open-table block the
-- moment an attempt happened to be active — exactly the entanglement this
-- migration avoids by design). service_closeouts has never had a writer
-- before PART 1 above (2026-08-09_service_lifecycle_v3_foundation.sql's own
-- manifest note: "V3.2's close engine is the first thing that will INSERT a
-- row") and is service_role-only INSERT, never HTTP-exposed — so a row can
-- only exist here because create_service_closeout (PART 1) already ran
-- successfully for this EXACT session, under a real active V3 attempt, with
-- language-guard: allow-legacy chiudiServizio is the existing JS close function, named here for audit context, not new vocabulary
-- server-computed totals. The legacy chiudiServizio/begin_service_session_
-- language-guard: allow-legacy servizio.js is the file path of the existing legacy close module, named here for audit context, not new vocabulary
-- close path never creates a service_closeouts row (nothing in servizio.js
-- references the table — verified, see the legacy non-interference test) and
-- therefore can never satisfy this EXISTS check; its own open-table policy is
-- completely unchanged by this migration.
--
-- ── PREDECESSOR-BODY GUARD ───────────────────────────────────────────────
-- Same discipline as V3.1's mesa_prepare_table_order_v1 fix: refuse to apply
-- over a drifted or already-patched function.
DO $$
DECLARE v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_service_session_closed_v1' AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'service lifecycle v3 close engine refused: guard_service_session_closed_v1 body not found';
  END IF;
  IF v_body NOT LIKE '%MESA_TABLES_NOT_RELEASED%' THEN
    RAISE EXCEPTION 'service lifecycle v3 close engine refused: guard_service_session_closed_v1 does not match the expected pre-change body (MESA_TABLES_NOT_RELEASED check not found) — resolve drift first';
  END IF;
  IF v_body LIKE '%service_closeouts%' THEN
    RAISE EXCEPTION 'service lifecycle v3 close engine refused: guard_service_session_closed_v1 already references service_closeouts — already patched, resolve drift first';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    -- SLICE 3.2 EXEMPTION — see PART 3 header above for the full audit. Skips
    -- ONLY this one check, and only when a V3 service_closeouts row already
    -- exists for this exact session (proof a real V3.2 close engine run
    -- already reconciled and froze this session's totals).
    IF NOT EXISTS (
      SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
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

-- ── access control (Slice 1.3 discipline, same as every other V3 RPC) ──────
REVOKE ALL ON FUNCTION
  public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer),
  public.close_service_session_v3(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer),
  public.close_service_session_v3(uuid,uuid,text,text)
  TO service_role;
-- guard_service_session_closed_v1 keeps its existing trigger-function grants
-- (a trigger function is never directly EXECUTEd by a role; Postgres invokes
-- it internally on the UPDATE) — CREATE OR REPLACE does not reset those.

-- No new table in this migration (service_closeouts already exists, row 57) —
-- no RLS/GRANT boilerplate needed here.

COMMIT;
