-- migrations/2026-08-18_f7_opening_authority_cutover.sql
-- F-7 — Finalizar servicio repair: opening authority cutover. Makes
-- open_operational_service_v1 (F-6, dormant until now) the ONLY normal
-- runtime creator of a NEW service_sessions row, by removing the two direct
-- INSERTs that previously lived inside ensure_service_session and
-- resolve_order_intake_context_v1. Explicit reopen stays UNROUTED (no HTTP/
-- UI change); Finalizar routing, forgotten-close-for-operational_service_v1,
-- and R-DAY5 are all untouched.
--
-- PART 1 — public.ensure_service_session becomes READ/REUSE ONLY.
--   Signature changes from (p_opened_by text, p_service_kind text, p_source
--   text) to (p_opened_by text, p_source text) -- p_service_kind is REMOVED
--   entirely, not merely ignored: a read/reuse-only contract has nothing to
--   decide with it, and keeping a dead parameter would misrepresent the
--   function as still kind-aware. Because Postgres CREATE OR REPLACE cannot
--   change a function's argument list, the 3-arg overload is explicitly
--   DROPped first, then the 2-arg version is CREATEd -- a clean swap, never
--   two live overloads at once.
--   New contract:
--     - an active session exists (any era) -> REUSED (era-blind, exactly
--       the grandfather requirement: an economic_period_v1 session and a
--       future operational_service_v1 session are both simply "the current
--       service" to this read path);
--     - no active session, current Business Day has NEVER had ANY
--       service_sessions row -> NO_OPEN_SERVICE;
--     - no active session, current Business Day already has service
--       history -> REOPEN_REQUIRED.
--   It never creates, never infers PRANZO/SERA identity, never rolls -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe forbidden identity logic this function never performs, not new vocabulary
--   anything, never calls open_operational_service_v1. The pre-existing
--   MULTIPLE_ACTIVE_SERVICE_SESSIONS / SERVICE_SESSION_STATE_CORRUPT /
--   SERVICE_SESSION_CLOSING defensive branches are preserved byte-identical
--   in spirit (same codes, same shape) -- only the "no active session"
--   branch's ending changes, from CREATE to a DB-derived typed read.
--
-- PART 2 — public.resolve_order_intake_context_v1 cutover.
--   KEPT unchanged: the shared advisory lock, the clock-derived Business Day
--   resolution (v_business_date/business_days upsert -- Business Day
--   identity is legitimately clock-derived, a separate concern from SESSION
--   identity), the intake-window rule (v_can_create_order), the pointer/
--   epoch integrity assertions, the canonical context return shape
--   (businessDayId/businessDate/periodId/serviceKind/ticketEpoch/advanced).
--   v_service_kind is STILL computed from the clock and STILL returned in
--   the response (S-C economic-period stamping and callers depend on it),
--   but it no longer determines session identity, reuse, or creation --
--   "compute the economic classification independently," per the frozen
--   brief.
--   REMOVED: the direct INSERT INTO service_sessions.
--   Reuse test changes from (business_date, service_kind) match to
--   (business_day_id) match only -- "do not care about PRANZO/SERA session -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the frozen brief's own requirement, not new vocabulary
--   identity."
--   GRANDFATHER / FORGOTTEN-CLOSE (preserved, unchanged mechanism): when the
--   active session belongs to a DIFFERENT (earlier) Business Day than
--   today's, it is force-rolled to 'rolled_over' -- the EXACT same
--   unconditional UPDATE this function already performed before F-7, not a
--   new mechanism, not new semantics for operational_service_v1. No
--   forgotten-close contract is invented here; the pre-existing generic
--   rollover simply continues to apply era-blind, exactly as it already did.
--   FIRST-EVER LAZY OPEN: when no active session remains and ZERO
--   service_sessions rows exist for today's Business Day, this function
--   calls open_operational_service_v1(actor, 'first_open_of_business_day',
--   source) INSIDE the same transaction/lock. The canonical Business Day
--   pointer (current_business_day_id/current_ticket_epoch) is written
--   BEFORE this call -- open_operational_service_v1 reads it as its sole
--   authority and must never observe a stale/different day (a real ordering
--   bug caught and fixed during this session's own design pass, not merely
--   anticipated).
--   AFTER SERVICE HISTORY: when no active session remains but the Business
--   Day already has service history, this function returns ok:false,
--   code:'REOPEN_REQUIRED' -- no successor, no lazy Service B.
--   service_session_assign_order's existing typed P0001 RAISE EXCEPTION
--   path (unchanged, not touched by this migration) surfaces this: any
--   partial pointer/rollover mutation performed before the REOPEN_REQUIRED
--   RETURN is unwound by that same RAISE EXCEPTION's statement-level
--   transaction abort -- standard Postgres atomicity, not a new safety net.
--
-- PART 3 (no DB change) -- index.js's openServiceSession HTTP action
-- delegates entirely to ensureCurrentServiceSession (the JS orchestrator
-- wrapping ensure_service_session), so Part 1 alone makes it incapable of
-- creating ANYTHING, automatically, with zero code change to that action
-- required -- see the paired backend source commit for the comment-only
-- update documenting this.
--
-- PHASE 0 AUDIT (verified live, fresh, this session, before writing this
-- fix -- re-enumerated via pg_get_functiondef, not trusted from any prior
-- session's notes):
--   - Exactly 5 functions INSERT INTO service_sessions: open_operational_
--     service_v1 (F-6, dormant canonical), ensure_service_session (this
--     migration's Part 1 target), resolve_order_intake_context_v1 (Part 2
--     target), roll_service_session_economic_v1 (JS-reachable via
--     economicBoundaryEngine.js, HTTP-gated OFF on staging --
--     ECONOMIC_PERIOD_ROLLOVER_ENABLED unset, confirmed fresh via `railway
--     variables`), ensure_next_service_session_v3 (JS-reachable only via
--     serviceLifecycleV3Transition.js's ensureNext(), itself unreachable
--     since F-5 removed its only caller).
--   - ensure_service_session has exactly ONE JS caller anywhere in this
--     repo: src/serviceSessions/ensureServiceSession.js:193 (sessionLifecycle
--     .ensure(...), itself called by nothing but ensureCurrentServiceSession
--     -- the module ensureServiceSession.js exports).
--   - resolve_order_intake_context_v1 has ZERO JS rpc(...) call sites --
--     its only caller is the DB trigger service_session_assign_order
--     (BEFORE INSERT ON ordenes), unchanged, not touched by this migration.
--   - openServiceSession (index.js) has zero code path to any INSERT-capable
--     function other than through ensureCurrentServiceSession -- confirmed
--     by direct read, not assumed.
--   - Frontend compatibility audited (ladieci-messa-staging-frontend, -- language-guard: allow-legacy ladieci-messa-staging-frontend is the actual sibling repo's real directory name being cited as an audit source, not new vocabulary
--     read-only, no file modified there): serviceEnsureOutcome.js's
--     classifyEnsureAttempt() already degrades ANY unrecognized res.code to
--     ENSURE_OUTCOME.UNKNOWN -- a retryable, non-crashing generic exception
--     panel (ServiceStateGate.jsx renders it via ServiceExceptionPanel,
--     never blocks/crashes the app). NO_OPEN_SERVICE and REOPEN_REQUIRED
--     both degrade this way with zero frontend change required to avoid a
--     blocking/crashing surface -- confirmed by reading the actual
--     classification code, not assumed by design intent.
--   - Ledger: MAX(apply_order)=91, MAX(verified)=76 -- matches the exact
--     expected pre-state.
--   - Real active session 5e5777c5-71c8-4b54-aa78-1b1090c4cd04: status=open,
--     lifecycle_semantics=economic_period_v1, business_day_id=c8103dd5-b335-
--     4fa8-8ce5-89e95f26c619 (agrees with the canonical pointer). This
--     session is NEVER converted, NEVER mutated in place by this migration
--     -- F-4B's immutability trigger forbids it structurally regardless.
--   - payment_transactions=20, service_sessions=13 total, 0
--     operational_service_v1 rows anywhere.
BEGIN;

DO $$
DECLARE
  v_def_ensure text;
  v_def_resolve text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-7 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF (SELECT max(apply_order) FROM public.ladieci_schema_migrations) <> 91 THEN
    RAISE EXCEPTION 'F-7 refused: ledger head is % (expected 91) -- registration drift, re-verify before proceeding',
      (SELECT max(apply_order) FROM public.ladieci_schema_migrations);
  END IF;

  IF to_regprocedure('public.open_operational_service_v1(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-7 refused: open_operational_service_v1 (F-6) does not exist -- F-6 not applied';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_ensure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_service_session'
     AND pg_get_function_identity_arguments(p.oid) = 'p_opened_by text, p_service_kind text, p_source text';
  IF v_def_ensure IS NULL THEN
    RAISE EXCEPTION 'F-7 refused: ensure_service_session(text,text,text) not found -- already applied or drifted';
  END IF;
  IF position('INSERT INTO public.service_sessions(' IN v_def_ensure) = 0 THEN
    RAISE EXCEPTION 'F-7 refused: ensure_service_session does not match the expected pre-F-7 body -- already patched or drifted, resolve first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_resolve FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF v_def_resolve IS NULL THEN
    RAISE EXCEPTION 'F-7 refused: resolve_order_intake_context_v1 does not exist';
  END IF;
  IF position('INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)' IN v_def_resolve) = 0 THEN
    RAISE EXCEPTION 'F-7 refused: resolve_order_intake_context_v1 does not match the expected pre-F-7 body -- already patched or drifted, resolve first';
  END IF;

  IF to_regprocedure('public.ensure_service_session(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'F-7 refused: ensure_service_session(text,text) already exists -- already applied or drifted';
  END IF;

  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-7 refused: a real operational_service_v1 session already exists -- unexpected pre-state';
  END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-7 refused: payment_transactions population is % (expected 20) -- financial drift detected',
      (SELECT count(*) FROM public.payment_transactions);
  END IF;
  IF (SELECT count(*) FROM public.service_sessions) <> 13 THEN
    RAISE EXCEPTION 'F-7 refused: service_sessions population is % (expected 13) -- drift detected',
      (SELECT count(*) FROM public.service_sessions);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — ensure_service_session becomes read/reuse only. Clean swap: DROP
-- the 3-arg overload, CREATE the 2-arg version -- never two live overloads.
DROP FUNCTION public.ensure_service_session(text, text, text);

CREATE FUNCTION public.ensure_service_session(p_opened_by text, p_source text DEFAULT 'auto_entry'::text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_has_any  boolean;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open', 'closing')) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.service_sessions WHERE id = v_state.current_session_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_SESSION_STATE_CORRUPT');
    END IF;
    IF v_session.status = 'closing' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_SESSION_CLOSING', 'session', to_jsonb(v_session));
    END IF;
    -- REUSED is era-blind by design: an economic_period_v1 session and a
    -- future operational_service_v1 session are both simply "the current
    -- service" to this read-only path -- the grandfather requirement.
    RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'session', to_jsonb(v_session));
  END IF;

  -- No active session -- read-only discriminator, never create, never infer -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe forbidden identity logic this function never performs, not new vocabulary
  -- PRANZO/SERA identity, never roll anything, never call
  -- open_operational_service_v1. businessDate/businessDayId echoed from the
  -- canonical pointer (DB-derived), never from the clock.
  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true;
  IF v_bd_state.current_business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE');
  END IF;

  v_has_any := EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_bd_state.current_business_day_id);
  IF v_has_any THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
      'businessDayId', v_bd_state.current_business_day_id,
      'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
    'businessDayId', v_bd_state.current_business_day_id,
    'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_service_session(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_service_session(text, text) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — resolve_order_intake_context_v1 cutover.
CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1(p_actor text DEFAULT 'order_intake_v1'::text, p_source text DEFAULT 'order_intake_v1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid              timestamp;
  v_minutes_of_day      integer;
  v_business_date       date;
  v_service_kind        text;
  v_can_create_order    boolean;
  v_pointer             public.business_day_lifecycle_state%ROWTYPE;
  v_day                 public.business_days%ROWTYPE;
  v_period               public.service_sessions%ROWTYPE;
  v_period_needs_advance boolean;
  v_open_result          jsonb;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  -- Economic classification only, from here on -- never session identity.
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050 -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind literal values, preserved byte-verbatim from the pre-F-7 body for economic classification only, not new vocabulary
                          THEN 'PRANZO' ELSE 'SERA' END;
  v_can_create_order := (v_minutes_of_day >= 480 AND v_minutes_of_day < 1050)
                       OR (v_minutes_of_day >= 1080);

  IF NOT v_can_create_order THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_pointer FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_day FROM public.business_days WHERE business_date = v_business_date;
  IF NOT FOUND THEN
    INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
    VALUES (v_business_date, COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'), 1, 1)
    ON CONFLICT (business_date) DO NOTHING
    RETURNING * INTO v_day;
    IF NOT FOUND THEN
      SELECT * INTO v_day FROM public.business_days WHERE business_date = v_business_date;
    END IF;
  END IF;
  IF v_day.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'BUSINESS_DAY_UNRESOLVED');
  END IF;

  -- Canonical Business Day pointer established BEFORE any period resolution
  -- -- open_operational_service_v1 (if invoked below) reads current_business_
  -- day_id as its sole authority and must never observe a stale/different
  -- day. current_period_id is deliberately NOT touched by this UPDATE; it is
  -- set once, below, after v_period is finally known.
  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_day.id,
         current_ticket_epoch    = v_day.ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  IF FOUND AND v_period.business_day_id = v_day.id THEN
    -- Reuse. Session-kind/era identity irrelevant here -- "do not care about -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the frozen brief's own requirement, not new vocabulary
    -- PRANZO/SERA session identity." An economic_period_v1 session and a
    -- future operational_service_v1 session are both simply reused.
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      -- PRESERVED, UNCHANGED transitional behavior: a stale active session
      -- belonging to an earlier Business Day is force-rolled here exactly as
      -- it already was before F-7 -- the existing cross-day forgotten-close
      -- protection, not a new mechanism, not new semantics invented for
      -- operational_service_v1.
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_day_id = v_day.id AND status IN ('open','closing');
    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id) THEN
        -- AFTER SERVICE HISTORY: no successor, no lazy Service B. Any
        -- pointer/rollover mutation already performed above is unwound by
        -- service_session_assign_order's own RAISE EXCEPTION path (standard
        -- Postgres statement-level atomicity), not a special case here.
        RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
          'businessDayId', v_day.id, 'businessDate', v_business_date, 'serviceKind', v_service_kind);
      END IF;

      -- FIRST-EVER LAZY OPEN. Reentrant: this function already holds the
      -- same advisory lock namespace (pg_advisory_xact_lock is reentrant
      -- within one transaction) and the same business_day_lifecycle_state
      -- row lock (FOR UPDATE is likewise reentrant within one transaction),
      -- so this call neither blocks nor deadlocks against itself.
      v_open_result := public.open_operational_service_v1(
        COALESCE(p_actor, 'system'), 'first_open_of_business_day', COALESCE(p_source, 'order_intake')
      );
      IF (v_open_result->>'ok')::boolean IS NOT TRUE THEN
        RETURN jsonb_build_object('ok', false, 'code', 'OPEN_OPERATIONAL_SERVICE_FAILED',
          'reason', v_open_result->>'code', 'businessDate', v_business_date);
      END IF;
      SELECT * INTO v_period FROM public.service_sessions WHERE id = (v_open_result->'session'->>'id')::uuid;
    END IF;
  END IF;

  v_pointer.current_period_id := v_period.id;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_period_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  IF v_period.business_day_id IS DISTINCT FROM v_day.id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_period.id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF (SELECT current_ticket_epoch FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM v_day.ticket_epoch THEN
    RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'RESOLVED',
    'businessDayId', v_day.id,
    'businessDate', v_business_date,
    'periodId', v_period.id,
    'serviceKind', v_service_kind,
    'ticketEpoch', v_day.ticket_epoch,
    'advanced', v_period_needs_advance
  );
END $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Post-conditions.
DO $$
DECLARE
  v_def_ensure text;
  v_def_resolve text;
BEGIN
  IF to_regprocedure('public.ensure_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-7 post-condition failed: ensure_service_session(text,text) missing after swap';
  END IF;
  IF to_regprocedure('public.ensure_service_session(text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'F-7 post-condition failed: the old 3-arg ensure_service_session overload still exists';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_ensure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_service_session';
  IF position('INSERT INTO' IN v_def_ensure) <> 0 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: ensure_service_session still contains an INSERT';
  END IF;
  IF position('PRANZO' IN v_def_ensure) <> 0 OR position('SERA' IN v_def_ensure) <> 0 THEN -- language-guard: allow-legacy PRANZO/SERA are the exact forbidden literal identity values this post-condition scans the live function body for the ABSENCE of, not new vocabulary
    RAISE EXCEPTION 'F-7 post-condition failed: ensure_service_session still references PRANZO/SERA identity';
  END IF;
  IF position('open_operational_service_v1' IN v_def_ensure) <> 0 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: ensure_service_session must never call open_operational_service_v1';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_resolve FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF position('INSERT INTO public.service_sessions' IN v_def_resolve) <> 0 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: resolve_order_intake_context_v1 still directly INSERTs into service_sessions';
  END IF;
  IF position('open_operational_service_v1' IN v_def_resolve) = 0 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: resolve_order_intake_context_v1 does not call open_operational_service_v1';
  END IF;
  IF position('REOPEN_REQUIRED' IN v_def_resolve) = 0 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: resolve_order_intake_context_v1 does not return REOPEN_REQUIRED';
  END IF;

  -- Zero real new-era rows anywhere -- this migration performs no data write
  -- of its own.
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: a real operational_service_v1 session exists unexpectedly';
  END IF;

  -- Nothing else touched: real active session/pointer/shadow/financial/
  -- population invariants unchanged.
  IF (SELECT status FROM public.service_sessions WHERE id = '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid) <> 'open'
     OR (SELECT lifecycle_semantics FROM public.service_sessions WHERE id = '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid) <> 'economic_period_v1'
  THEN RAISE EXCEPTION 'F-7 post-condition failed: the real active session was mutated'; END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton = true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-7 post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton = true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-7 post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: payment_transactions population changed';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions) <> 13 THEN
    RAISE EXCEPTION 'F-7 post-condition failed: service_sessions population changed';
  END IF;
END $$;

COMMIT;
