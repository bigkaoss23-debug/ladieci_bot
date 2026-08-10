-- migrations/2026-08-10_service_lifecycle_economic_boundary_v1.sql
-- language-guard: allow-legacy chiudiServizio/PRANZO/servizio.js are named in this header only to explain what this migration does NOT call and to describe the PRANZO->SERA boundary, not new vocabulary
-- SERVICE LIFECYCLE / P0-C2 — AUTHORITATIVE INTRADAY ECONOMIC BOUNDARY.
-- STAGING ONLY. Additive only: one new service_sessions.status value, one new
-- timestamp column, one new RPC. Touches NO existing function body, NO
-- existing trigger, NO existing constraint's semantics for the values it
-- already covered.
--
-- ── WHY A NEW STATUS VALUE, NOT close_service_session_v3 ────────────────────
-- Audited first (P0_C2 report §2/§4): guard_service_session_closed_v1's
-- SERVICE_ACTIVE_ORDERS_NOT_RESOLVED check fires on ANY transition INTO
-- status='closed', unconditionally, confirmed unchanged through Slice 3.3
-- (that migration's own header: "does NOT modify close_service_session_v3 or
-- guard_service_session_closed_v1 at all") and re-confirmed against the LIVE
-- function body, not just the migration file.
-- language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to describe the boundary, not new vocabulary
-- An ordinary intraday PRANZO->SERA boundary must coexist with real EN_COCINA/LISTO orders (the clarified
-- product contract) — routing it through status='closed' would either hit
-- that hard block for real, or require weakening a guard that legitimately
-- must stay strict for a true end-of-day/legacy close. A distinct status
-- ('rolled_over') sidesteps guard_service_session_closed_v1 entirely (it only
-- ever inspects `NEW.status = 'closed'`) — zero risk to any existing close
-- path, V2 or V3, and no new exemption branch added to that trigger at all.
--
-- ── WHY NOT closed_at ────────────────────────────────────────────────────
-- service_sessions_check enforces `(status='closed') = (closed_at IS NOT
-- NULL)` bidirectionally. Reusing closed_at for a non-'closed' status would
-- either violate that constraint or require weakening it. A dedicated
-- rolled_over_at column keeps closed_at's existing "genuinely terminal, all
-- orders resolved/archived" meaning completely intact for V2/V3's own closed
-- state, and gives 'rolled_over' its own honest, unambiguous timestamp.
--
-- ── WHY ONE ATOMIC RPC, NOT TWO ─────────────────────────────────────────────
-- Settling A and opening B must commit as a single transaction: any window
-- where current_session_id is briefly inconsistent (A already non-open, B not
-- yet current) would let ordenes_assign_service_session's own hard guard
-- (INVALID_OPEN_SERVICE_SESSION — service_session_assign_order, 2026-07-28
-- migration) fail a real concurrent order for no reason. PostgREST/RPC calls
-- from the JS layer are each their own transaction — the atomicity has to
-- live inside this one function, not be composed from two calls. Reuses the
-- SAME advisory lock name ('service_session_lifecycle') close_service_
-- session_v3/ensure_service_session already use, so this can never race
-- either of them even if somehow invoked concurrently.
--
-- ── WHY IT NEVER TOUCHES ordenes/table_sessions ─────────────────────────────
-- Not in scope by construction: no DML against either table appears anywhere
-- in this function. A's non-terminal orders and open tables simply continue
-- to exist, still attributed to A (their real, permanent economic owner),
-- fully queryable/actionable via the P0-C1 fix (getCurrentOperationalSession
-- already accepts a non-'open' session's data for reads) plus the JS-side
-- multi-session read this slice adds on top for A+B carryover.
--
-- ── REUSES, NOT REINVENTS ───────────────────────────────────────────────────
-- Requires a service_closeouts row to already exist for the exact (session,
-- correlation) pair, identical precondition style to close_service_session_v3
-- — the caller must call the EXISTING create_service_closeout (row 58/61)
-- first. No parallel "economic summary" table or RPC is introduced. B's
-- creation mirrors ensure_service_session's own INSERT shape (2026-07-28
-- migration) exactly (same columns, same audit-row pattern) so the historical
-- record reads identically regardless of which primitive opened a given
-- session.
--
-- ── CONCURRENCY / IDEMPOTENCY ────────────────────────────────────────────────
-- A retry (same p_service_session_id, same p_closeout_correlation_id) after a
-- prior successful call: v_session.status is already 'rolled_over' ->
-- short-circuits to ALREADY_ROLLED_OVER, re-fetching the real B via
-- rollover_source_session_id (unique index, at most one B per A) rather than
-- creating a duplicate. A retry after the app was offline across the cutoff:
-- the caller (JS orchestrator) always derives "which kind should be current
-- right now" from the wall clock at call time, not from any stored intent, so
-- a call made at 18:12 for a cutoff configured at 17:30 still correctly rolls
-- straight to SERA — no special "missed" handling needed here, by
-- construction (see src/serviceSessions/economicBoundaryEngine.js).
--
-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────
-- Does not touch LEGACY_AUTOMATIC_LIFECYCLE_ENABLED, does not wire any
-- scheduler/cron.
-- language-guard: allow-legacy chiudiServizio/servizio.js are the existing legacy identifiers this line names only to state what this migration does NOT modify, not new vocabulary
-- Does not modify chiudiServizio/incidentSafeRollover/ensureServiceSession/
-- close_service_session_v3/guard_service_session_closed_v1/
-- service_sessions_single_active_uq. Pure addition.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'economic boundary v1 refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_state') IS NULL
     OR to_regclass('public.service_session_audit') IS NULL
     OR to_regclass('public.service_closeouts') IS NULL
     OR to_regclass('public.service_closeout_attempts') IS NULL
  THEN RAISE EXCEPTION 'economic boundary v1 refused: Service Lifecycle V3 foundation missing — apply rows 44/53/55/57/58 first'; END IF;

  IF to_regprocedure('public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)') IS NOT NULL THEN
    RAISE EXCEPTION 'economic boundary v1 refused: roll_service_session_economic_v1 already exists — resolve drift first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_sessions_status_check'
      AND pg_get_constraintdef(oid) LIKE '%rolled_over%'
  ) THEN
    RAISE EXCEPTION 'economic boundary v1 refused: service_sessions_status_check already allows rolled_over — already patched, resolve drift first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='rolled_over_at'
  ) THEN
    RAISE EXCEPTION 'economic boundary v1 refused: service_sessions.rolled_over_at already exists — already patched, resolve drift first.';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — schema: one new status value, one new timestamp column.
-- Drop-then-add is required for a CHECK constraint (Postgres has no ALTER
-- CHECK); the predecessor-body guard above already proved the existing
-- definition is exactly the 3-value array this expects, so this is a like-
-- for-like widen, not a body rewrite.
ALTER TABLE public.service_sessions
  DROP CONSTRAINT service_sessions_status_check;
ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_status_check
  CHECK (status = ANY (ARRAY['open','closing','closed','rolled_over']));

ALTER TABLE public.service_sessions
  ADD COLUMN rolled_over_at timestamptz;

COMMENT ON COLUMN public.service_sessions.rolled_over_at IS
  'P0-C2 — set only by roll_service_session_economic_v1. Distinct from closed_at: '
  'a rolled_over session''s orders/tables are NOT archived or force-terminalized, '
  'they remain live and operable, attributed to this session permanently for '
  'reporting. closed_at stays NULL for a rolled_over session (enforced by '
  'service_sessions_check, unmodified).';

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — roll_service_session_economic_v1: the non-destructive intraday
-- economic-boundary primitive.
CREATE FUNCTION public.roll_service_session_economic_v1(
  p_service_session_id      uuid,
  p_closeout_correlation_id uuid,
  p_actor                   text,
  p_source                  text,
  p_next_service_kind       text,
  p_next_business_date      date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_next     public.service_sessions%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  -- language-guard: allow-legacy PRANZO is the existing service_kind enum value already defined by service_sessions_kind_chk, exercised here verbatim, not new vocabulary
  IF p_next_service_kind IS NULL OR p_next_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_NEXT_SERVICE_KIND');
  END IF;
  IF p_next_business_date IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_NEXT_BUSINESS_DATE');
  END IF;

  -- SAME advisory-lock namespace as close_service_session_v3/
  -- ensure_service_session — a V2 close, a V3 close, and an economic
  -- rollover can never interleave on the shared service_session_state row.
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  -- IDEMPOTENCY — a retry (crash between A's UPDATE and B's INSERT is
  -- impossible within one transaction, but a retry of the WHOLE call after a
  -- prior successful commit is a real, expected case: app restart, a second
  -- concurrent caller, a client retry on a dropped response).
  IF v_session.status = 'rolled_over' THEN
    SELECT * INTO v_next FROM public.service_sessions
     WHERE rollover_source_session_id = v_session.id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok',true,'code','ALREADY_ROLLED_OVER','idempotent',true,
        'sessionA',to_jsonb(v_session),'sessionB',to_jsonb(v_next)
      );
    END IF;
    -- rolled_over with no B on record is an inconsistent state this function
    -- never produces itself (B is always created in the same transaction as
    -- A's UPDATE) — fail closed rather than silently minting a second B.
    RETURN jsonb_build_object('ok',false,'code','ROLLOVER_IDENTITY_MISMATCH','sessionA',to_jsonb(v_session));
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS','sessionStatus',v_session.status);
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  -- Requires the closeout snapshot to already be durably persisted — same
  -- precondition style as close_service_session_v3. This RPC never computes
  -- or writes financial totals itself; create_service_closeout (row 58/61,
  -- unmodified) remains the one writer of service_closeouts.
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

  -- B must not already exist under a different origin for this exact
  -- (date, kind) — service_sessions_date_kind_uq already enforces this at
  -- the INSERT below; this pre-check turns that into a typed result instead
  -- of a raw unique-violation for the one case where it's a real conflict
  -- (not this same rollover's own idempotent retry, already handled above).
  IF EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE business_date = p_next_business_date AND service_kind = p_next_service_kind
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','NEXT_SERVICE_ALREADY_EXISTS');
  END IF;

  -- A: economic settle. NEVER touches ordenes or table_sessions — its
  -- non-terminal orders and open tables remain exactly as they are,
  -- permanently attributed to A, live and operable.
  UPDATE public.service_sessions
     SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  -- B: open, current, fresh — same INSERT shape as ensure_service_session.
  INSERT INTO public.service_sessions(
    business_date, service_kind, status, opened_at, opened_by, open_source,
    rollover_source_session_id
  ) VALUES (
    p_next_business_date, p_next_service_kind, 'open', now(), p_actor, p_source,
    v_session.id
  ) RETURNING * INTO v_next;

  -- Pointer flip — the ONLY moment order attribution changes. Before this
  -- line commits, service_session_assign_order still resolves to A; after,
  -- to B. No intermediate state is ever visible to another transaction.
  UPDATE public.service_session_state
     SET current_session_id = v_next.id, recent_closed_session_id = NULL, updated_at = now()
   WHERE singleton = true;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'rolled_over_economic', p_actor, p_source);
  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_next.id, 'opened', p_actor, p_source);

  RETURN jsonb_build_object(
    'ok',true,'code','ROLLED_OVER','idempotent',false,
    'sessionA',to_jsonb(v_session),'sessionB',to_jsonb(v_next)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION
  public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)
  TO service_role;

COMMIT;
