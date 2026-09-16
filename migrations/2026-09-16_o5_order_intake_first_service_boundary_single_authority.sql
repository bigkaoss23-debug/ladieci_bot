-- migrations/2026-09-16_o5_order_intake_first_service_boundary_single_authority.sql
-- O-5 (consolidated) — PRE_UAT_LIFECYCLE_HYGIENE Part C: unify the
-- first-service-open boundary as a single canonical authority, WITHOUT
-- eliminating the distinction between "a Business Day identity exists" and
-- "a brand-new Operational Service may be lazily created".
--
-- THE FINDING, reconfirmed on the TRUE remote tip (99172f9b, branch
-- feature/staging-messa-tables-2026-08-01) via pg_get_functiondef against
-- live staging (tdikhfeinufaahagmpjz) — not from a stale local checkout.
-- resolve_order_intake_context_v1 (the sole DB-canonical writer, called from
-- service_session_assign_order()'s BEFORE INSERT trigger on public.ordenes)
-- and get_order_intake_context_v1 (its STABLE read-only mirror, read by
-- orderIntakePolicy.js) both restate the identical literal:
--   v_can_create_order := (v_minutes_of_day >= 480);
-- 480 = 08:00. A genuine first order between 04:00 and 07:59 is rejected
-- today with ORDER_INTAKE_CLOSED even though the Business Day (04:00
-- rollover) has already resolved a valid operating date for that minute.
--
-- CORRECTED PREMISE (this is a revision of an earlier, wrong conclusion
-- reached in a prior session of this same slice — recorded here rather than
-- silently discarded). This session initially treated 480 as an accidental
-- duplicate and proposed making order intake unconditionally allowed.
-- src/schedule/serviceSchedule.js — THE authoritative runtime schedule,
-- read fresh on this true baseline — proves that premise wrong:
--   "00:00-04:00 belongs to the dinner that opened YESTERDAY. No new
--    session may be created here: an operator arriving at 01:00 to a
--    closed restaurant must not silently mint a service."
-- and R_DAY3_INTAKE_AUTHORITY_AMENDMENT_V1_2026-08-16.md states outright:
--   "Schedule outside intake window | BLOCK | Pre-existing product rule
--    (canCreateNewOrder), unrelated to lifecycle authority. Unchanged."
-- So a schedule-based refusal for brand-new service creation is real,
-- intentional, frozen product policy — Business Day identity (04:00
-- rollover, date-bucketing) and permission to CREATE A NEW SERVICE are two
-- distinct facts, and collapsing them into "always true" would silently
-- delete the 00:00-04:00 rule alongside the 04:00-08:00 one this slice
-- actually targets. The task this migration answers is exactly this: the
-- window that must shrink is 04:00-08:00 (04:00 already began the new
-- Business Day; there is no remaining reason to also wait until 08:00), NOT
-- 00:00-04:00 (which the schedule owner explicitly wants to keep BLOCK).
--
-- THE FIX: one new pure, IMMUTABLE helper, public.order_intake_policy_v1
-- (p_minutes_of_day integer), naming the fact explicitly as
-- 'mayCreateFirstService' rather than reusing the vaguer 'canCreateOrder' —
-- this is specifically about FIRST-SERVICE lazy-open eligibility, never
-- about an already-open canonical service (that is Stale Service Protection
-- V1's continuity fast-path, structurally untouched, checked and returned
-- BEFORE this gate is ever reached — see WHAT DOES NOT CHANGE below).
-- mayCreateFirstService := (p_minutes_of_day >= 240) — the SAME 04:00
-- rollover threshold already used for business-date bucketing, reused as
-- the ALSO-canonical first-service boundary, replacing the independent 480
-- literal. Both resolve_order_intake_context_v1 and get_order_intake_
-- context_v1 delegate to this one function for businessDateIsPreviousDay /
-- serviceKind / the (renamed-at-the-boundary, publicly still called
-- canCreateNewOrder/v_can_create_order — see below) fact — they can no
-- longer restate, and silently diverge on, this arithmetic.
--
-- PUBLIC CONTRACT UNCHANGED. get_order_intake_context_v1's returned jsonb
-- key stays 'canCreateNewOrder' (orderIntakePolicy.js's live external
-- contract; a dozen tests assert this key name) and resolve_order_intake_
-- context_v1's local variable stays v_can_create_order — only what feeds
-- them changes internally, and their comments now name what the fact
-- actually means (first-service eligibility, not "orders in general" —
-- an already-open service was never gated by either variable in the first
-- place, see WHAT DOES NOT CHANGE).
--
-- serviceSchedule.js (the JS-side authoritative schedule, restated here in
-- SQL because a PL/pgSQL trigger cannot call into Node) is updated in the
-- SAME slice, same commit, to keep exact parity: its OUTSIDE_WINDOWS state
-- (04:00-08:00) flips canCreateNewOrder from false to true — its
-- isEscalationBoundary flag and every other one of the six independently-
-- named facts in that state are untouched; AFTER_ORDER_CUTOFF (00:00-04:00,
-- canCreateNewOrder: false) is untouched. tests/rDay3ScheduleParity.test.js
-- is updated in lockstep (both its live SQL-mirror constant and its static
-- 240/480 assertions) so JS and SQL cannot silently drift again.
--
-- WHAT DOES NOT CHANGE. Not one other line of either function: the advisory
-- lock, Stale Service Protection V1's continuity fast-path (an ALREADY-OPEN
-- canonical service is reused regardless of clock, checked and returned
-- BEFORE this gate — Scenario D/E of this slice's own test matrix), the G-1
-- lazy-open call to open_operational_service_v1, every pointer-mismatch
-- integrity RAISE, and the REVOKE/GRANT split (service_role-only) are
-- byte-identical to the live bodies this migration's own predecessor guard
-- verifies before touching anything. ORDER_INTAKE_CLOSED is kept, not
-- deleted — real, tested, canonical infrastructure (orderIntakePolicy.js
-- reads canCreateNewOrder as pure data, hardcodes no threshold of its own,
-- needs no change).
--
-- open_service_session(text,text) is DELIBERATELY NOT touched by this
-- migration (a prior session's draft of this slice incorrectly proposed
-- dropping it — corrected here). It has a real, current JS caller
-- (src/serviceSessions/serviceSessionLifecycle.js's exported .open()
-- method, itself unreached by any live application call site today) kept
-- as a documented, deliberate "fail loudly, not silently" compatibility
-- shim — the exact precedent migrations/2026-08-20_h1_legacy_lifecycle_
-- writer_hardening.sql explicitly names and reuses for four OTHER retired
-- writers. Classified REQUIRED_COMPAT, not DEAD; see the session report for
-- the full privilege/reachability audit.
--
-- open_business_day_v1(text,text) IS dropped by this migration — proven
-- DEAD, not merely unreached today: its OWN introducing migration
-- (2026-08-16_r_day1_business_day_authority_substrate.sql) documents it, at
-- birth, as "a DORMANT bootstrap RPC, not called by any committed
-- application code in this slice", and no later slice ever wired a caller
-- (fresh repo-wide grep this session: zero JS frontend/backend references
-- beyond historical/explanatory comments; zero internal SQL caller across
-- the full public-schema prosrc scan; zero trigger; zero pg_cron job).
-- resolve_order_intake_context_v1 has always written business_day_
-- lifecycle_state.current_business_day_id itself, inline, independently of
-- this function.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_resolve text;
  v_get     text;
BEGIN
  SELECT p.prosrc INTO v_resolve FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'O-5 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-5 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-5 480 formula -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%PREVIOUS_SERVICE_PENDING%' OR v_resolve NOT LIKE '%ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH%' THEN
    RAISE EXCEPTION 'O-5 refused: Stale Service Protection V1 branches missing from the live function -- resolve drift first';
  END IF;

  SELECT p.prosrc INTO v_get FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get IS NULL THEN
    RAISE EXCEPTION 'O-5 refused: public.get_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_get NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-5 refused: get_order_intake_context_v1 does not carry the expected pre-O-5 480 formula -- resolve drift first';
  END IF;
  IF v_get NOT LIKE '%hasValidCurrentService%' THEN
    RAISE EXCEPTION 'O-5 refused: Stale Service Protection V1 hasValidCurrentService fact missing -- resolve drift first';
  END IF;

  IF to_regprocedure('public.open_business_day_v1(text,text)') IS NULL THEN
    RAISE EXCEPTION 'O-5 refused: public.open_business_day_v1(text,text) already absent -- census is stale, resolve drift first';
  END IF;
  IF to_regprocedure('public.open_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'O-5 refused: public.open_service_session(text,text) is absent -- this migration depends on it staying present (REQUIRED_COMPAT), resolve drift first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname <> 'open_business_day_v1'
       AND p.prosrc ILIKE '%open_business_day_v1%'
  ) THEN
    RAISE EXCEPTION 'O-5 refused: a new internal caller of open_business_day_v1 appeared since this session''s zero-caller census -- resolve drift first';
  END IF;
END $$;

BEGIN;

-- ── Single canonical policy (Part C/5) ──────────────────────────────────
-- Pure function of minutes-of-day. No table reads, no clock reads --
-- unit-testable by value (see tests/o5OrderIntakeFirstServiceBoundary.
-- static.test.js and the direct SQL probes in the session report).
CREATE OR REPLACE FUNCTION public.order_intake_policy_v1(p_minutes_of_day integer)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'businessDateIsPreviousDay', p_minutes_of_day < 240,
    'serviceKind', CASE WHEN p_minutes_of_day >= 240 AND p_minutes_of_day < 1050
                        THEN 'PRANZO' ELSE 'SERA' END, -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim for economic classification (S-C), not new vocabulary
    -- O-5 — named explicitly for what it actually decides: eligibility to
    -- LAZILY CREATE the Business Day's first Operational Service. An
    -- already-open canonical service is NEVER gated by this fact (Stale
    -- Service Protection V1's continuity fast-path returns earlier, in
    -- both call sites, before this value is even consulted). Reuses the
    -- SAME 04:00 rollover threshold as businessDateIsPreviousDay above --
    -- one authority for both facts, not a second independent literal.
    'mayCreateFirstService', p_minutes_of_day >= 240
  );
$function$;

REVOKE ALL ON FUNCTION public.order_intake_policy_v1(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_intake_policy_v1(integer) TO service_role;

-- ── resolve_order_intake_context_v1 — surgical replacement, 4 lines ─────
-- Every other line (advisory lock, Stale Service Protection V1, G-1 lazy
-- open, pointer-mismatch integrity RAISEs, RESOLVED/ORDER_INTAKE_CLOSED
-- shapes) is byte-identical to the live body this predecessor guard just
-- verified. v_can_create_order keeps its name (still what the ORDER_INTAKE_
-- CLOSED branch below reads) -- only its source changes.
CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1(p_actor text DEFAULT 'order_intake_v1'::text, p_source text DEFAULT 'order_intake_v1'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid              timestamp;
  v_minutes_of_day      integer;
  v_policy              jsonb;
  v_business_date       date;
  v_service_kind        text;
  v_can_create_order    boolean;
  v_pointer             public.business_day_lifecycle_state%ROWTYPE;
  v_day                 public.business_days%ROWTYPE;
  v_period               public.service_sessions%ROWTYPE;
  v_open_result          jsonb;
  v_open_reason          text;
  v_open_source          text;
  v_had_open_or_closing  boolean;
  v_continuity           boolean;
  v_ticket_epoch          integer;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_policy := public.order_intake_policy_v1(v_minutes_of_day);
  v_business_date := CASE WHEN (v_policy->>'businessDateIsPreviousDay')::boolean
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind     := v_policy->>'serviceKind';
  v_can_create_order := (v_policy->>'mayCreateFirstService')::boolean;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;
  v_had_open_or_closing := FOUND;

  IF v_had_open_or_closing AND v_period.lifecycle_semantics = 'operational_service_v1' THEN
    -- STALE SERVICE PROTECTION V1 — the Business Day is the grace boundary.
    -- O-3 gave this branch unconditional continuity; it is now bounded to
    -- "the service's own business_date is still the canonical Business Day"
    -- (overnight span included, since v_business_date carries the 04:00
    -- rollover). Once a full Business Day has elapsed the service is stale:
    -- fail closed with a typed refusal so the trigger raises it and no new
    -- order can attach. The JS staleServiceRecovery layer then auto-finalizes
    -- (if AUTO_CLOSE_SAFE) through the one V3 authority, or surfaces
    -- PREVIOUS_SERVICE_PENDING for operator resolution.
    IF v_period.business_date < v_business_date THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'PREVIOUS_SERVICE_PENDING',
        'staleServiceSessionId', v_period.id,
        'staleBusinessDate', v_period.business_date,
        'currentBusinessDate', v_business_date,
        'serviceKind', v_service_kind
      );
    ELSIF v_period.business_date > v_business_date THEN
      -- REVIEW FIX — a FUTURE-dated open service is a lifecycle/business-date
      -- anomaly, never a "previous" service and never ordinary continuity.
      -- Fail closed with the canonical code the opener primitive already uses
      -- for "an active service under a business day other than canonical"
      -- (open_operational_service_v1, ledger 93/96). No recovery path: the JS
      -- layer must not auto-close or reclassify a future-dated service.
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH',
        'serviceSessionId', v_period.id,
        'serviceBusinessDate', v_period.business_date,
        'currentBusinessDate', v_business_date,
        'serviceKind', v_service_kind
      );
    END IF;
    SELECT ticket_epoch INTO v_ticket_epoch FROM public.business_days WHERE id = v_period.business_day_id;
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'RESOLVED',
      'businessDayId', v_period.business_day_id,
      'businessDate', v_period.business_date,
      'periodId', v_period.id,
      'serviceKind', v_service_kind,
      'ticketEpoch', v_ticket_epoch,
      'advanced', false
    );
  END IF;

  v_continuity := false;

  IF NOT v_can_create_order AND NOT v_continuity THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

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

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_day.id,
         current_ticket_epoch    = v_day.ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  SELECT * INTO v_period FROM public.service_sessions
   WHERE business_day_id = v_day.id AND status IN ('open','closing');
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id) THEN
      v_open_reason := 'next_service_of_business_day';
      v_open_source := COALESCE(p_source, 'order_intake') || '_next_service';
    ELSE
      v_open_reason := 'first_open_of_business_day';
      v_open_source := COALESCE(p_source, 'order_intake');
    END IF;

    v_open_result := public.open_operational_service_v1(
      COALESCE(p_actor, 'system'), v_open_reason, v_open_source
    );
    IF (v_open_result->>'ok')::boolean IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false, 'code', 'OPEN_OPERATIONAL_SERVICE_FAILED',
        'reason', v_open_result->>'code', 'openReason', v_open_reason, 'businessDate', v_business_date);
    END IF;
    SELECT * INTO v_period FROM public.service_sessions WHERE id = (v_open_result->'session'->>'id')::uuid;
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
    'advanced', true
  );
END $function$;

REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_intake_context_v1(text, text) TO service_role;

-- ── get_order_intake_context_v1 — surgical replacement, same 4 lines ────
CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid                    timestamp;
  v_minutes_of_day            integer;
  v_policy                    jsonb;
  v_business_date             date;
  v_service_kind               text;
  v_can_create_order           boolean;
  v_has_valid_current_service  boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  v_policy := public.order_intake_policy_v1(v_minutes_of_day);
  v_business_date := CASE WHEN (v_policy->>'businessDateIsPreviousDay')::boolean
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind     := v_policy->>'serviceKind';
  v_can_create_order := (v_policy->>'mayCreateFirstService')::boolean;

  -- STALE SERVICE PROTECTION V1 — an open operational_service_v1 row from a
  -- PAST Business Day is not a valid current service, so this advisory-
  -- preflight fact must not report it as continuity (which would let
  -- orderIntakePolicy.js fail OPEN while the DB-canonical
  -- resolve_order_intake_context_v1 fails CLOSED). Scoped back to
  -- business_date = v_business_date — the pre-O-3 shape, for this read fact
  -- only. Same-business-day (and the O-2 overnight span, since v_business_date
  -- carries the 04:00 rollover) is unaffected.
  SELECT EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE status IN ('open','closing') AND lifecycle_semantics = 'operational_service_v1'
       AND business_date = v_business_date
  ) INTO v_has_valid_current_service;

  RETURN jsonb_build_object(
    'canCreateNewOrder', v_can_create_order,
    'businessDate', v_business_date,
    'serviceKind', v_service_kind,
    'hasValidCurrentService', v_has_valid_current_service
  );
END $function$;

REVOKE ALL ON FUNCTION public.get_order_intake_context_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_intake_context_v1() TO service_role;

-- ── Part G/H dead-code purge: open_business_day_v1 ONLY ─────────────────
-- open_service_session is DELIBERATELY NOT dropped by this migration -- see
-- header. Zero-caller proof for open_business_day_v1(text,text) this
-- session: born DORMANT (its own migration's words), no JS frontend/backend
-- reference beyond historical comments, no internal SQL caller
-- (public-schema-wide prosrc scan), no trigger, no pg_cron job, no RPC
-- invocation in any script or test. resolve_order_intake_context_v1 has
-- always written business_day_lifecycle_state.current_business_day_id
-- itself, inline -- nothing downstream regresses.
DROP FUNCTION IF EXISTS public.open_business_day_v1(text, text);

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_policy_src   text;
  v_resolve_src  text;
  v_get_src      text;
BEGIN
  SELECT p.prosrc INTO v_policy_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'order_intake_policy_v1';
  IF v_policy_src IS NULL THEN
    RAISE EXCEPTION 'O-5 post-condition failed: order_intake_policy_v1 is missing after CREATE';
  END IF;
  IF v_policy_src NOT LIKE '%''mayCreateFirstService'', p_minutes_of_day >= 240%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: order_intake_policy_v1 does not gate first-service creation at the 04:00 boundary';
  END IF;

  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL THEN
    RAISE EXCEPTION 'O-5 post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src LIKE '%>= 480%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: the 08:00 literal still appears in resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%public.order_intake_policy_v1(v_minutes_of_day)%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: resolve_order_intake_context_v1 does not delegate to the canonical policy';
  END IF;
  IF v_resolve_src NOT LIKE '%PREVIOUS_SERVICE_PENDING%' OR v_resolve_src NOT LIKE '%ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH%'
     OR v_resolve_src NOT LIKE '%BUSINESS_DAY_POINTER_MISMATCH%' OR v_resolve_src NOT LIKE '%open_operational_service_v1(%'
     OR v_resolve_src NOT LIKE '%ORDER_INTAKE_CLOSED%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: an unrelated branch of resolve_order_intake_context_v1 did not survive the replace';
  END IF;

  SELECT p.prosrc INTO v_get_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get_src IS NULL THEN
    RAISE EXCEPTION 'O-5 post-condition failed: get_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_get_src LIKE '%>= 480%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: the 08:00 literal still appears in get_order_intake_context_v1';
  END IF;
  IF v_get_src NOT LIKE '%public.order_intake_policy_v1(v_minutes_of_day)%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: get_order_intake_context_v1 does not delegate to the canonical policy';
  END IF;
  IF v_get_src NOT LIKE '%hasValidCurrentService%' THEN
    RAISE EXCEPTION 'O-5 post-condition failed: Stale Service Protection V1 fact did not survive the replace';
  END IF;

  IF to_regprocedure('public.open_business_day_v1(text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'O-5 post-condition failed: open_business_day_v1(text,text) survived the DROP';
  END IF;
  IF to_regprocedure('public.open_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'O-5 post-condition failed: open_service_session(text,text) was removed -- it is REQUIRED_COMPAT, not in scope for this migration';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.order_intake_policy_v1(integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_order_intake_context_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-5 post-condition failed: service_role lost EXECUTE on one of the intake functions';
  END IF;
  IF has_function_privilege('anon', 'public.order_intake_policy_v1(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_intake_policy_v1(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_order_intake_context_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-5 post-condition failed: anon/authenticated must never execute the intake functions';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE (see ledgers 96-104
-- and O-1's own footer). If and when this migration is applied: apply_order
-- 136 (public.ladieci_schema_migrations tip verified at 135 this session --
-- 2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.sql --
-- apply_order 127-129 confirmed reserved/absent, not reused here), kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing
-- commit. NOT REGISTERED, NOT APPLIED by this session.

COMMIT;
