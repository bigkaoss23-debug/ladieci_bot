-- migrations/2026-08-17_s_d_stop_same_day_kind_rollover.sql
-- S-D — Operational Service repair, slice D: stop clock-driven PRANZO/SERA
-- session splitting WITHIN one Business Day. A single-term predicate change
-- to resolve_order_intake_context_v1() and nothing else.
--
-- Authority: owner-frozen S-D decision (this session), Candidate C, closed
-- after two independent Opus architecture challenges (GRANDFATHER_A for the
-- currently-open legacy row; Candidate C for day-boundary semantics — do NOT
-- create real operational_service_v1 rows yet; that cutover is paired with
-- the still-unbuilt Finalizar servicio / forgotten-day contract).
--
-- PRODUCT RESULT: within the SAME Business Day, PRANZO -> quiet interval ->
-- SERA must NOT create a new service_session merely because economic
-- classification changed. PRANZO/SERA continue to be computed for intake
-- policy, S-C economic fact stamping, and reporting classification -- they
-- cease to be a same-day service IDENTITY boundary.
--
-- EXACT CHANGE: remove exactly one conjunct, `AND v_period.service_kind =
-- v_service_kind`, from the outer reuse predicate. The `business_date`
-- conjunct is KEPT UNCHANGED -- a Business Day boundary still rolls an
-- unfinalized economic_period_v1 session over (legacy forgotten-day
-- transition, NOT Finalizar servicio: no closed_at, no close_source, no
-- financial close -- service_sessions_check already enforces (status=
-- 'closed') = (closed_at IS NOT NULL), so 'rolled_over' structurally cannot
-- carry one). v_service_kind continues to be computed and returned in the
-- result JSON -- still consumed by src/agents/agentOrdini.js and by every
-- S-C stamping trigger, unaffected by this migration. No other line of the
-- function body changes: the now-dead-in-practice inner re-SELECT (after the
-- outer UPDATE ... rolled_over there are zero active rows left, and
-- service_sessions_single_active_uq guarantees at most one can ever exist,
-- so it always falls through to INSERT) is left byte-identical, matching the
-- brief's explicit minimal-footprint instruction.
--
-- NO new-era rows: the INSERT is untouched and continues to omit
-- lifecycle_semantics, inheriting the S-B default economic_period_v1. No
-- operational_service_v1 row is created anywhere in this migration.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=83, MAX(verified)=76, rows 77-83 all
--     bootstrapped_unverified -- matches the exact expected pre-state.
--   - Live active session at Phase 0: business_date=2026-08-16,
--     service_kind=SERA, status=open, lifecycle_semantics=economic_period_v1
--     -- but resolver's own computed business_date was ALREADY 2026-08-17
--     (a pre-existing business_date mismatch, R-DAY3-recovery residue, not
--     caused by this slice) with intake open. This live state is EXPLICITLY
--     NOT relied upon anywhere below -- every guard and post-condition here
--     is written against "whatever session(s) exist at apply time", never
--     against a specific id, matching the brief's identity-agnostic
--     requirement.
--   - S-C PONR (first committed row with any economic_period_kind/
--     obligation_economic_period_kind/event_economic_period_kind stamp):
--     0 at last check before this migration was authored. Verified
--     independently (Opus review) that S-D's safety does not depend on this
--     value either way -- S-C's triggers read only clock_timestamp()/
--     ordenes.created_at, never service_sessions.service_kind or
--     lifecycle_semantics, so nothing in this migration can affect an
--     already-written stamp.
--   - rollEconomicPeriod HTTP action fail-closed-gated in the SAME commit as
--     this migration (index.js, ECONOMIC_PERIOD_ROLLOVER_ENABLED), deployed
--     BEFORE this migration is applied (see the S-D report's activation-
--     order evidence) -- the one other runtime surface able to recreate a
--     period-as-session split is closed first.
BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S-D refused: staging sentinel migration absent -- wrong database?'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'S-D refused: resolve_order_intake_context_v1 does not exist -- R-DAY3 not applied';
  END IF;

  -- Predecessor-body guard: the EXACT pre-S-D three-term predicate must be
  -- present, byte-for-byte, or this migration refuses (already applied,
  -- drifted, or a different body than expected).
  IF position('IF FOUND AND v_period.business_date = v_business_date AND v_period.service_kind = v_service_kind THEN' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D refused: resolve_order_intake_context_v1 does not match the expected pre-S-D three-term reuse predicate -- already patched or drifted, resolve first';
  END IF;

  -- Drift guard: refuse if the two-term (post-S-D) shape is already present.
  IF position('IF FOUND AND v_period.business_date = v_business_date THEN' IN v_def) > 0 THEN
    RAISE EXCEPTION 'S-D refused: resolve_order_intake_context_v1 already shows the post-S-D two-term predicate -- already applied';
  END IF;
END $$;

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
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
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

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  -- S-D: the service_kind conjunct is REMOVED here. Same business_date is
  -- now sufficient for reuse regardless of which economic window (PRANZO/
  -- SERA) the clock currently reports -- a single Operational Service now
  -- spans Lunch -> quiet interval -> Dinner without a same-day identity
  -- split. The business_date conjunct is UNCHANGED: a Business Day boundary
  -- still rolls an unfinalized session over (legacy-only transitional
  -- behavior, not Finalizar servicio).
  IF FOUND AND v_period.business_date = v_business_date THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_date = v_business_date AND service_kind = v_service_kind
       AND status IN ('open','closing');
    IF NOT FOUND THEN
      INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)
      VALUES (v_business_date, v_service_kind, 'open', COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'))
      RETURNING * INTO v_period;
    END IF;
  END IF;

  v_pointer.current_period_id       := v_period.id;
  v_pointer.current_business_day_id := v_day.id;
  v_pointer.current_ticket_epoch    := v_day.ticket_epoch;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_pointer.current_business_day_id,
         current_period_id       = v_pointer.current_period_id,
         current_ticket_epoch    = v_pointer.current_ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  IF v_period.business_day_id IS DISTINCT FROM v_pointer.current_business_day_id THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
  END IF;
  IF v_day.ticket_epoch IS DISTINCT FROM v_pointer.current_ticket_epoch THEN
    RAISE EXCEPTION 'TICKET_EPOCH_MIRROR_MISMATCH' USING ERRCODE='P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'RESOLVED',
    'businessDayId', v_pointer.current_business_day_id,
    'businessDate', v_business_date,
    'periodId', v_pointer.current_period_id,
    'serviceKind', v_service_kind,
    'ticketEpoch', v_pointer.current_ticket_epoch,
    'advanced', v_period_needs_advance
  );
END $function$;

-- Post-conditions.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';

  IF position('IF FOUND AND v_period.business_date = v_business_date THEN' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: two-term (business_date-only) reuse predicate not found';
  END IF;
  IF position('AND v_period.service_kind = v_service_kind THEN' IN v_def) > 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: service_kind reuse conjunct still present -- identity split not removed';
  END IF;

  -- v_service_kind must still be COMPUTED (economic classification survives)
  -- and RETURNED (still consumed by callers) -- only its role as an identity
  -- predicate is removed.
  IF position('v_service_kind  := CASE WHEN v_minutes_of_day >= 240' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: v_service_kind economic classification computation removed -- out of scope';
  END IF;
  IF position('''serviceKind'', v_service_kind' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: serviceKind no longer returned in the result -- out of scope';
  END IF;

  -- Everything else byte-identical: lock name, GUC name, mirror exceptions,
  -- INSERT column list (still omits lifecycle_semantics -- inherits the S-B
  -- default), ORDER_INTAKE_CLOSED gate window.
  IF position('pg_advisory_xact_lock(hashtext(''service_session_lifecycle''))' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: shared advisory lock name changed -- out of scope';
  END IF;
  IF position('ladieci.business_day_pointer_authorized' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: pointer authorization GUC missing -- out of scope';
  END IF;
  IF position('BUSINESS_DAY_POINTER_MISMATCH' IN v_def) = 0 OR position('TICKET_EPOCH_MIRROR_MISMATCH' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: mirror-consistency assertions missing -- out of scope';
  END IF;
  IF position('INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: bootstrap INSERT column list changed -- lifecycle_semantics must NOT be added in S-D';
  END IF;
  IF position('lifecycle_semantics' IN v_def) > 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: lifecycle_semantics referenced anywhere in this function -- S-D creates zero operational_service_v1 rows';
  END IF;
  IF position('(v_minutes_of_day >= 480 AND v_minutes_of_day < 1050)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: ORDER_INTAKE_CLOSED schedule gate window changed -- out of scope';
  END IF;

  -- Zero operational_service_v1 rows exist anywhere in the database as a
  -- result of this migration (identity-agnostic: this checks the whole
  -- table, not any specific row).
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'S-D post-condition failed: real operational_service_v1 row(s) exist -- S-D must create zero';
  END IF;

  -- No financial/attribution table population changed as a side effect of
  -- redefining this function (a CREATE OR REPLACE performs no data writes,
  -- but this is asserted rather than assumed, matching established
  -- discipline in every prior slice of this session).
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-D post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.period_consolidations) <> 5 THEN
    RAISE EXCEPTION 'S-D post-condition failed: period_consolidations population changed -- must be exactly 5';
  END IF;
END $$;

COMMIT;
