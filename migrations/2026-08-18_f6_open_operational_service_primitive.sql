-- migrations/2026-08-18_f6_open_operational_service_primitive.sql
-- F-6 — Finalizar servicio repair: DORMANT canonical Operational Service open
-- primitive. Zero runtime callers, zero cutover, zero table/column changes --
-- exactly the same "dormant substrate" discipline as 2026-08-16_r_day1_
-- business_day_authority_substrate.sql's own public.open_business_day_v1.
--
-- Authority: owner-frozen F-6 brief, itself downstream of the Opus F-5.5
-- opening-authority challenge (read-only). That challenge found FOUR live
-- SQL creators of service_sessions (not the two originally named) --
-- resolve_order_intake_context_v1, ensure_service_session,
-- roll_service_session_economic_v1, ensure_next_service_session_v3 -- and
-- proved neither of the two reachable ones can ever produce an
-- operational_service_v1 row: service_sessions_active_kind_chk requires
-- lifecycle_semantics='operational_service_v1' -> service_kind IS NULL, but
-- ensure_service_session validates p_service_kind IN ('PRANZO','SERA') and -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe why these two legacy creators cannot produce a new-era row, not new vocabulary
-- resolve_order_intake_context_v1 always writes a clock-derived PRANZO/SERA
-- kind. No cutover of either can promote it -- a genuinely new primitive is
-- required, which is exactly and only what this migration installs.
--
-- WHAT THIS MIGRATION DOES
--   public.open_operational_service_v1(p_opened_by text, p_open_reason text,
--   p_source text) RETURNS jsonb -- the future single sanctioned writer of a
--   NEW-ERA service_sessions row. Not called by any committed application
--   code in this slice. Exists so F-6's own concurrency/idempotency/
--   discriminator claims are provable against real DB behaviour now, and so
--   F-7+'s cutover has a working, already-tested primitive to build on
--   rather than a paper design -- the identical rationale R-DAY1 recorded for
--   open_business_day_v1.
--
-- WHY NO NEW TABLE/COLUMN
-- The state discriminator the brief specifies --
--   has_any_service := EXISTS(SELECT 1 FROM service_sessions
--                               WHERE business_day_id = current_business_day_id)
-- -- is already total and already provably correct: service_sessions.
-- business_day_id has been NOT NULL since R-DAY1 and is derived
-- deterministically by the service_sessions_business_day_derive_v1 trigger
-- (BEFORE INSERT, unconditional, ignores any client-supplied value) from
-- business_date, which is itself resolved from the canonical pointer inside
-- this function, never from the client and never from the clock. No lineage
-- field is invented for explicit_reopen: rollover_source_session_id was
-- audited fresh this session (grepped every pg_proc body referencing it) and
-- is written by exactly two functions, both economic-rollover-specific
-- (ensure_next_service_session_v3's p_service_kind/p_business_date
-- parameters, roll_service_session_economic_v1's p_next_service_kind/
-- p_next_business_date) -- an overloaded, PRANZO/SERA-specific field, not a -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe why rollover_source_session_id is not reused, not new vocabulary
-- generic predecessor pointer, so this migration does not write it. A
-- created row's predecessor is already fully and honestly recoverable via
-- business_day_id + opened_at ordering without any new column.
--
-- LOCK / AUTHORITY -- reuses, never duplicates
--   pg_advisory_xact_lock(hashtext('service_session_lifecycle')) -- the same
--   namespace ensure_service_session/open_service_session/
--   begin_service_session_close/roll_service_session_economic_v1/
--   close_service_session_v3/open_business_day_v1 already use. Then locks
--   business_day_lifecycle_state singleton FOR UPDATE and
--   service_session_state singleton FOR UPDATE, exactly mirroring
--   close_service_session_v3's own two-singleton locking order.
--   business_day_lifecycle_state.current_period_id is written only via the
--   pre-existing ladieci.business_day_pointer_authorized GUC (set_config(...,
--   true) SET LOCAL, cannot leak past this transaction), the SAME
--   authorization mechanism close_service_session_v3/F-1/open_business_day_v1
--   already use -- no new lock family, no new guard.
--
-- STATE DISCRIMINATOR (RULE A vs RULE B vs REUSE), fresh-verified live this
-- session across 12 real business_days rows (11 finalized, 1 pristine
-- fixture) before writing this fix -- see the F-5.5 challenge transcript:
--   - service_sessions_single_active_uq is a GLOBAL UNIQUE INDEX ON (true)
--     WHERE status IN ('open','closing') -- there can be AT MOST ONE active
--     row in the ENTIRE table, not merely per business day. This function's
--     "is any service active" check is therefore correctly UNSCOPED by
--     business_day_id (a business-day-scoped SELECT would only ever find the
--     one single active row anyway, or none) -- it selects the sole possible
--     active row directly and then separately verifies that row's
--     business_day_id agrees with the canonical current one, returning a
--     distinct typed code (ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH) if it does
--     not, rather than silently trusting an invariant this migration does
--     not itself enforce.
--   - has_any_service := EXISTS(service_sessions WHERE business_day_id =
--     current). Live-proven total and monotone: business_date 1999-01-01 (a
--     pre-existing fixture business_days row with genuinely zero
--     service_sessions rows) is the only NEVER_OPENED case found; every real
--     day with any history -- including one still `open` right now -- is
--     FINALIZED-or-ACTIVE. No new fact is required.
--
-- TARGET ROW SHAPE
--   lifecycle_semantics='operational_service_v1', service_kind=NULL (both
--   explicit in the INSERT column/value list, never relying on a nullable
--   default alone), status='open', business_day_id=canonical current
--   Business Day (derived, asserted immediately after INSERT, not trusted),
--   opened_by=p_opened_by, open_source=p_source. next_order_number is never
--   listed in the INSERT column list -- its DEFAULT 1 applies untouched, so
--   no Business Day/order counter is written by this function.
--
-- NO CLOCK IDENTITY
-- business_date for the INSERT comes from business_days.business_date of the
-- ALREADY-canonical current_business_day_id -- never from clock_timestamp()/
-- now(), never a fresh PRANZO/SERA computation. This function calls no -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the forbidden identity logic this primitive never performs, not new vocabulary
-- schedule/period-resolution logic at all; p_service_kind is not a parameter
-- of this signature and cannot be supplied by any caller. now() is used only
-- for ordinary updated_at/created_at bookkeeping columns, identical to every
-- other RPC in this codebase -- not an identity decision.
--
-- IDEMPOTENCY
-- pg_advisory_xact_lock totally orders every genuine caller before either
-- singleton read, exactly like every existing lifecycle RPC -- two
-- overlapping first-open (or reopen) attempts cannot both observe "no active
-- service" and both proceed to INSERT; the second is serialized behind the
-- first's commit/rollback and then re-reads a real active row, returning
-- REUSED. Live-proven this session with genuinely overlapping backend
-- connections (Phase 3 concurrency proof), not merely asserted.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (F-6 non-goals, per the
-- frozen brief)
--   - does not cut over resolve_order_intake_context_v1, ensure_service_
--     session, roll_service_session_economic_v1, or ensure_next_service_
--     session_v3 -- all four remain untouched, still the only reachable
--     creators from live application code (F-7+'s job, one at a time);
--   - creates zero real operational_service_v1 rows -- F-6 is dormant
--     substrate only, proven via a mandatory A-J fixture matrix entirely
--     inside rolled-back transactions;
--   - does not add an HTTP action, a frontend caller, or a supabaseResource
--     Policy.js registration -- open_business_day_v1 (R-DAY1) is live
--     precedent for a dormant RPC needing none of the three: the resource-
--     policy completeness test (tests/supabaseResourcePolicy.test.js) scans
--     application SOURCE CODE for rpc(...) call sites and requires each
--     found call site to be registered -- it is a forward (code ->
--     registry) direction, never a backward (live DB pg_proc -> registry)
--     completeness scan, confirmed fresh by reading the test file this
--     session. Zero call sites for open_operational_service_v1 exist
--     anywhere in this repo, so no registration is required, and adding one
--     would not itself create any new reachability (the registry is a
--     permission table consulted BY an HTTP handler, not a router) -- but
--     per the brief's own explicit caution, none is added in F-6;
--   - does not touch recent_closed_session_id / recent_closed_business_day_id
--     -- business_day_lifecycle_state_guard_v1's own trigger body (read live,
--     fresh, this session) only guards current_business_day_id/
--     current_period_id/current_ticket_epoch; recent_closed_business_day_id
--     is unguarded and untouched here regardless, no evidence found that
--     opening must change it;
--   - writes no ticket_epoch, no business_days counter of any kind.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=90, MAX(verified)=76, 41 verified / 49
--     bootstrapped_unverified -- matches the exact expected pre-state.
--   - to_regprocedure('public.open_operational_service_v1(text,text,text)')
--     IS NULL -- not yet installed.
--   - business_day_lifecycle_state: current_business_day_id=c8103dd5-b335-
--     4fa8-8ce5-89e95f26c619, current_period_id=5e5777c5-71c8-4b54-aa78-
--     1b1090c4cd04, current_ticket_epoch=2. service_session_state:
--     current_session_id=5e5777c5..., recent_closed_session_id=c9d5aaa7-
--     d0d5-4740-a6ee-83a8ee57adda. The real active session's own
--     business_day_id (c8103dd5...) agrees with the canonical pointer,
--     confirmed by direct read -- the live invariant this function's
--     ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH branch defends is not
--     hypothetical, it is the actual current state.
--   - payment_transactions=20, service_sessions=13 total, 0
--     operational_service_v1 rows anywhere.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-6 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF to_regclass('public.ladieci_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'F-6 refused: public.ladieci_schema_migrations (S4) is missing -- resolve drift first';
  END IF;

  IF (SELECT max(apply_order) FROM public.ladieci_schema_migrations) <> 90 THEN
    RAISE EXCEPTION 'F-6 refused: ledger head is % (expected 90) -- registration drift, re-verify before proceeding',
      (SELECT max(apply_order) FROM public.ladieci_schema_migrations);
  END IF;

  IF to_regclass('public.business_day_lifecycle_state') IS NULL
     OR to_regclass('public.service_session_state') IS NULL
     OR to_regclass('public.business_days') IS NULL
     OR to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_audit') IS NULL
  THEN RAISE EXCEPTION 'F-6 refused: predecessor foundation (R-DAY1 / S-A/S-B) missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='lifecycle_semantics'
  ) THEN RAISE EXCEPTION 'F-6 refused: service_sessions.lifecycle_semantics (S-B) missing'; END IF;

  IF to_regprocedure('public.open_operational_service_v1(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'F-6 refused: public.open_operational_service_v1 already exists -- already applied or drifted';
  END IF;

  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-6 refused: a real operational_service_v1 session already exists -- unexpected pre-state';
  END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-6 refused: payment_transactions population is % (expected 20) -- financial drift detected, re-verify before proceeding',
      (SELECT count(*) FROM public.payment_transactions);
  END IF;

  IF (SELECT count(*) FROM public.service_sessions) <> 13 THEN
    RAISE EXCEPTION 'F-6 refused: service_sessions population is % (expected 13) -- drift detected, re-verify before proceeding',
      (SELECT count(*) FROM public.service_sessions);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- public.open_operational_service_v1 -- the future single canonical opener.
-- DORMANT: no committed application code calls this RPC in F-6.
CREATE OR REPLACE FUNCTION public.open_operational_service_v1(
  p_opened_by   text,
  p_open_reason text,
  p_source      text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_ss_state public.service_session_state%ROWTYPE;
  v_day      public.business_days%ROWTYPE;
  v_active   public.service_sessions%ROWTYPE;
  v_has_any  boolean;
  v_new      public.service_sessions%ROWTYPE;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;
  -- No default, no implicit mode: any value other than the exact two
  -- allowed reasons is rejected here, before any lock is even acquired.
  IF p_open_reason IS NULL OR p_open_reason NOT IN ('first_open_of_business_day', 'explicit_reopen') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_OPEN_REASON');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_SOURCE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  SELECT * INTO v_ss_state FROM public.service_session_state       WHERE singleton = true FOR UPDATE;

  IF v_bd_state.current_business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CURRENT_BUSINESS_DAY');
  END IF;

  SELECT * INTO v_day FROM public.business_days WHERE id = v_bd_state.current_business_day_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUSINESS_DAY_NOT_FOUND');
  END IF;

  -- service_sessions_single_active_uq (UNIQUE ON (true) WHERE status IN
  -- ('open','closing')) guarantees at most one row can ever match this
  -- SELECT in the whole table -- correctly unscoped by business_day_id, then
  -- separately checked for business-day agreement below.
  SELECT * INTO v_active FROM public.service_sessions WHERE status IN ('open', 'closing') FOR UPDATE;
  IF FOUND THEN
    IF v_active.business_day_id IS DISTINCT FROM v_day.id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH', 'session', to_jsonb(v_active));
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'session', to_jsonb(v_active));
  END IF;

  v_has_any := EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id);

  IF p_open_reason = 'first_open_of_business_day' THEN
    IF v_has_any THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_REOPEN_REQUIRED');
    END IF;
  ELSE -- explicit_reopen
    IF NOT v_has_any THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_PRIOR_SERVICE_TO_REOPEN');
    END IF;
  END IF;

  INSERT INTO public.service_sessions (
    business_date, status, opened_by, open_source, service_kind, lifecycle_semantics
  ) VALUES (
    v_day.business_date, 'open', p_opened_by, p_source, NULL, 'operational_service_v1'
  ) RETURNING * INTO v_new;

  -- Defense-in-depth: service_sessions_business_day_derive_v1 (BEFORE
  -- INSERT) always overwrites NEW.business_day_id from NEW.business_date via
  -- business_days_business_date_uq -- since v_day.business_date is already
  -- that exact row's own date, this MUST resolve back to v_day.id. Asserted,
  -- not merely assumed, mirroring resolve_order_intake_context_v1's own
  -- post-write BUSINESS_DAY_POINTER_MISMATCH check.
  IF v_new.business_day_id IS DISTINCT FROM v_day.id THEN
    RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_BUSINESS_DAY_DERIVE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_period_id = v_new.id, updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_new.id, updated_at = now()
   WHERE singleton = true;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_new.id, 'opened', p_opened_by, p_source);

  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_new.id THEN
    RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_POINTER_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton = true) IS DISTINCT FROM v_new.id THEN
    RAISE EXCEPTION 'OPEN_OPERATIONAL_SERVICE_SHADOW_MISMATCH' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'CREATED', 'created', true, 'session', to_jsonb(v_new));
END;
$function$;

REVOKE ALL ON FUNCTION public.open_operational_service_v1(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_operational_service_v1(text, text, text) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- Post-conditions.
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public.open_operational_service_v1(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-6 post-condition failed: open_operational_service_v1 missing after CREATE';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'open_operational_service_v1';

  IF position('clock_timestamp' IN v_def) <> 0
     OR position('PRANZO' IN v_def) <> 0 -- language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values this post-condition scans the live function body for the ABSENCE of, not new vocabulary
     OR position('SERA' IN v_def) <> 0
     OR position('p_service_kind' IN v_def) <> 0
     OR position('resolveSchedule' IN v_def) <> 0
     OR position('rollover_source_session_id' IN v_def) <> 0
  THEN
    RAISE EXCEPTION 'F-6 post-condition failed: open_operational_service_v1 references forbidden clock/kind/lineage identity logic';
  END IF;

  IF (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'open_operational_service_v1')
     <> 'p_opened_by text, p_open_reason text, p_source text'
  THEN RAISE EXCEPTION 'F-6 post-condition failed: open_operational_service_v1 signature does not match the frozen brief'; END IF;

  -- Zero real new-era rows anywhere -- installing the function performs no
  -- data write of its own.
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-6 post-condition failed: a real operational_service_v1 session exists unexpectedly';
  END IF;

  -- Nothing else touched: pointer/shadow/financial/population invariants
  -- unchanged.
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-6 post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton = true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-6 post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-6 post-condition failed: payment_transactions population changed';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions) <> 13 THEN
    RAISE EXCEPTION 'F-6 post-condition failed: service_sessions population changed';
  END IF;
END $$;

COMMIT;
