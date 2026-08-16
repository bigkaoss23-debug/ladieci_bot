-- migrations/2026-08-16_r_day3_business_day_intake_authority.sql
-- R-DAY3 — ORDER-INTAKE AUTHORITY FLIP: SERVICE PERIOD -> BUSINESS DAY.
-- Authority: BUSINESS_DAY_R_DAY_IMPLEMENTATION_PLAN_V1_2026-08-16.md (R-DAY0,
-- frozen) + R_DAY3_INTAKE_AUTHORITY_AMENDMENT_V1_2026-08-16.md (frozen amendment,
-- mandatory corrections C1/C2/C3) + owner errata (rollback PONR distinction,
-- DB-canonical schedule authority).
--
-- WHAT THIS MIGRATION DOES
--   1. public.resolve_order_intake_context_v1(actor, source) -- the ONE
--      canonical, DB-authoritative intake-context resolver. Runs INSIDE the
--      order INSERT transaction (called from the retargeted trigger below,
--      PART 4), under pg_advisory_xact_lock(hashtext('service_session_
--      lifecycle')) -- the same lock R-DAY1's pointer-transition RPCs already
--      use. Resolves business_date/service_kind/canCreateNewOrder canonically
--      in SQL (parity with src/schedule/serviceSchedule.js -- see the parity
--      test, tests/rDay3ScheduleParity.test.js), ensures the Business Day
--      parent, advances the current Service Period only when its (business_
--      date, service_kind) no longer matches (demoting the outgoing period to
--      'rolled_over' -- NEVER destructive, NEVER reopens a historical row),
--      writes the atomic tuple, and writes through the legacy compatibility
--      shadow (service_session_state.current_session_id) in the SAME
--      transaction -- C1, mandatory: the shadow must never point at a
--      non-open/closing period once this transaction commits.
--   2. public.get_order_intake_context_v1() -- READ-ONLY preflight mirror.
--      No lock, no lifecycle mutation, no authority write. UX-only.
--   3. public.service_session_assign_order() retargeted: the Service-Period
--      permission branches (NO_OPEN_SERVICE_SESSION, INVALID_OPEN_SERVICE_
--      SESSION, STALE_SERVICE_SESSION, and the implicit SERVICE_KIND
--      mismatch) are REMOVED. The trigger now calls the resolver above and
--      stamps NEW.service_session_id from its result. Forgery guards
--      (SERVICE_SESSION_FORGERY, SERVICE_ORDER_NUMBER_FORGERY) are preserved
--      verbatim. Trigger object (ordenes_assign_service_session) and its
--      firing position are UNCHANGED -- R-DAY2's anchor trigger continues to
--      fire immediately after, deriving Business Day lineage through
--      NEW.service_session_id -> service_sessions.business_day_id exactly as
--      before (order_entity_anchor_v1() is NOT modified by this migration).
--   4. C2 -- service_sessions_date_kind_uq (historical, ((business_date,
--      service_kind) globally unique forever) replaced with service_sessions_
--      date_kind_active_uq (unique only among status IN ('open','closing')).
--      business_date + service_kind become CLASSIFICATION, not IDENTITY:
--      multiple historical periods may now share a (date, kind) pair. A
--      period is NEVER reopened; closed_at/rolled_over_at are NEVER rewritten.
--      service_sessions_single_active_uq (the GLOBAL at-most-one-active
--      constraint) is UNTOUCHED.
--   5. C2 reader audit fix -- two functions had a bare EXISTS(business_date,
--      service_kind) check that, before this migration, was harmless (the
--      old index made it equivalent to an active check by construction) but
--      would misfire once (4) allows historical duplicates: they would
--      falsely refuse the instant ANY historical row for that (date,kind)
--      existed, active or not. Both are re-scoped to AND status IN ('open',
--      'closing'); nothing else in either function changes:
--        - ensure_service_session()'s SERVICE_ALREADY_COMPLETED_TODAY check
--        - roll_service_session_economic_v1()'s NEXT_SERVICE_ALREADY_EXISTS
--          check
--      Both functions are already retired from the automatic order-intake
--      path by this same migration (PART 3) and remain reachable only via
--      manual/admin action; the fix removes a latent trap without touching
--      any other line of either function. (Full reachability audit: see this
--      migration's own PART 6 comment and R_DAY3_INTAKE_AUTHORITY_AMENDMENT_
--      V1_2026-08-16.md's C2 reader/writer audit.)
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--   - does NOT create period_consolidations, consolidate_period_v1, any
--     cutoff/checkpoint/snapshot object (R-DAY4);
--   - does NOT add business_days.status/sealed_at/seal_source/sealed_by, does
--     NOT implement SEAL, does NOT touch recent_closed_business_day_id
--     (R-DAY5);
--   - does NOT reset business_days.ticket_epoch/next_ticket_number on a
--     same-day period transition -- only R-DAY4's own explicit consolidation
--     may ever advance ticket_epoch;
--   - does NOT modify order_entity_anchor_v1() (R-DAY2) -- Business Day
--     lineage for order_entities remains derived exclusively through
--     NEW.service_session_id -> service_sessions.business_day_id, never
--     through the pointer;
--   - does NOT touch any financial table, any payment, any table_session, any
--     rider/delivery state;
--   - does NOT delete/reopen/rewrite any historical service_sessions row.
--
-- ROLLBACK POINT OF NO RETURN (owner erratum 1)
-- The paired .ROLLBACK.sql restores service_session_assign_order(),
-- ensure_service_session(), roll_service_session_economic_v1() to their
-- exact byte-captured predecessor bodies UNCONDITIONALLY (this is always
-- safe: the legacy shadow, maintained atomically by C1 for as long as this
-- migration is live, means the restored old gate finds exactly what it
-- expects). It restores service_sessions_date_kind_uq (the historical,
-- globally-unique index) ONLY IF no duplicate (business_date, service_kind)
-- pair exists among current rows -- the first time this migration allows a
-- second historical period for the same (date, kind) pair to be committed,
-- full schema rollback is no longer possible without destructive repair
-- (deleting/merging/renaming a period), which this project's own append-only
-- discipline forbids. The rollback refuses safely (whole transaction aborts,
-- nothing partially applied) rather than attempting that repair.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY3 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF to_regclass('public.business_day_lifecycle_state') IS NULL
     OR to_regclass('public.order_entities') IS NULL
  THEN RAISE EXCEPTION 'R-DAY3 refused: R-DAY1/R-DAY2 foundation missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY3 refused: resolve_order_intake_context_v1 already exists -- already patched, resolve drift first'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='service_sessions' AND indexname='service_sessions_date_kind_uq'
  ) THEN RAISE EXCEPTION 'R-DAY3 refused: service_sessions_date_kind_uq missing -- already patched or drifted, resolve first'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='service_sessions' AND indexname='service_sessions_date_kind_active_uq'
  ) THEN RAISE EXCEPTION 'R-DAY3 refused: service_sessions_date_kind_active_uq already exists -- already patched, resolve drift first'; END IF;

  IF to_regclass('public.period_consolidations') IS NOT NULL
     OR to_regclass('public.business_day_closeout_attempts') IS NOT NULL
  THEN RAISE EXCEPTION 'R-DAY3 refused: an R-DAY4+ object already exists -- this migration is out of sequence'; END IF;

  -- R-DAY3 makes the R-DAY1/R-DAY2 objects real runtime dependencies.
  -- Migration authority for rows 74/75/76 must already be lawfully verified
  -- (S4's own established slug-match method) before this cutover proceeds --
  -- this is a READ-ONLY assertion; R-DAY3 itself never writes to the ledger.
  IF (SELECT count(*) FROM public.ladieci_schema_migrations
       WHERE apply_order IN (74,75,76) AND verification_status = 'verified') <> 3
  THEN RAISE EXCEPTION 'R-DAY3 refused: rows 74/75/76 are not all verified in public.ladieci_schema_migrations -- promote them first, do not cut over on unverified foundation'; END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY3 refused: payment_transactions population is % (expected 20) -- financial drift detected, re-verify before proceeding',
      (SELECT count(*) FROM public.payment_transactions);
  END IF;

  -- Defensive: the OLD index already guarantees this can never fire (at most
  -- one row per (business_date, service_kind) ever, historically) -- kept as
  -- an explicit, self-documenting assertion rather than a silent assumption.
  IF EXISTS (
    SELECT 1 FROM public.service_sessions WHERE service_kind IS NOT NULL
     GROUP BY business_date, service_kind HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'R-DAY3 refused: duplicate (business_date,service_kind) rows already exist before this migration -- integrity gap predates R-DAY3, escalate instead of proceeding'; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — public.resolve_order_intake_context_v1(): the ONE canonical
-- intake-context resolver. Runs inside the order INSERT transaction.
--
-- SCHEDULE PARITY, LOCKED (mirrors src/schedule/serviceSchedule.js's
-- DEFAULT_SCHEDULE EXACTLY -- any change to those JS constants MUST be
-- mirrored here in the same commit; see tests/rDay3ScheduleParity.test.js):
--   rolloverMin            = 04:00 =  240 minutes
--   lunchEnsureStartMin    = 08:00 =  480 minutes
--   lunchBoundaryMin       = 17:30 = 1050 minutes
--   dinnerEnsureStartMin   = 18:00 = 1080 minutes
-- businessDateFor():   minutesOfDay <  240            -> yesterday, else today
-- resolveEconomicPeriod(): 240 <= min < 1050           -> PRANZO, else SERA
-- canCreateNewOrder(): (480 <= min < 1050) OR (min >= 1080)
--   i.e. true in [08:00,17:30) and [18:00,24:00), false in
--   [00:00,08:00) (AFTER_ORDER_CUTOFF + OUTSIDE_WINDOWS) and [17:30,18:00)
--   (BETWEEN_SERVICES). Timezone handled via `AT TIME ZONE 'Europe/Madrid'`,
--   DST-correct by construction (named zone, not a fixed offset) -- same
--   primitive Intl.DateTimeFormat gives the JS side.
CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1(
  p_actor  text DEFAULT 'order_intake_v1',
  p_source text DEFAULT 'order_intake_v1'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_madrid              timestamp;
  v_minutes_of_day      integer;
  v_business_date       date;
  v_service_kind        text;
  v_can_create_order    boolean;
  v_pointer             public.business_day_lifecycle_state%ROWTYPE;
  v_day                 public.business_days%ROWTYPE;
  v_period              public.service_sessions%ROWTYPE;
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

  -- PRODUCT RULE (owner erratum 2): DB-canonical schedule window. This is the
  -- ONLY intake permission signal left besides true integrity blockers below
  -- -- never Service-Period staleness/kind mismatch.
  IF NOT v_can_create_order THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ORDER_INTAKE_CLOSED',
      'businessDate', v_business_date, 'serviceKind', v_service_kind);
  END IF;

  -- The one shared lifecycle lock, unchanged name (R-DAY0 §6): every RPC that
  -- reads or writes the canonical pointer serializes here.
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_pointer FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;

  -- Ensure Business Day parent -- identical find-or-create primitive to
  -- R-DAY1's open_business_day_v1 / R-DAY2's hotfix trigger, protected by the
  -- same business_days_business_date_uq concurrency backstop.
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

  -- Does the current period still match the resolved (date, kind) pair and
  -- remain active? If not, it must advance.
  v_period_needs_advance := true;
  IF v_pointer.current_period_id IS NOT NULL THEN
    SELECT * INTO v_period FROM public.service_sessions WHERE id = v_pointer.current_period_id FOR UPDATE;
    IF FOUND AND v_period.business_date = v_business_date
       AND v_period.service_kind = v_service_kind
       AND v_period.status IN ('open','closing') THEN
      v_period_needs_advance := false;
    END IF;
  END IF;

  IF v_period_needs_advance THEN
    -- Demote the outgoing period FIRST (if one was current and still active)
    -- so service_sessions_single_active_uq is satisfied at every statement
    -- boundary -- never zero active rows mid-transaction, never two.
    -- 'rolled_over' means EXACTLY: no longer current for new economic
    -- attribution. Not paid, not reconciled, not empty, not closed, not
    -- consolidated, not archived -- guard_service_session_closed_v1 does not
    -- even fire on this transition (it only guards -> 'closed').
    IF v_pointer.current_period_id IS NOT NULL AND v_period.status IN ('open','closing') THEN
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    -- Adopt an already-active period for the resolved pair if one somehow
    -- exists; otherwise create a NEW one. NEVER reopen a historical
    -- rolled_over/closed row (C2's core semantic: date+kind is
    -- classification, service_session_id is identity).
    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_date = v_business_date AND service_kind = v_service_kind
       AND status IN ('open','closing');
    IF NOT FOUND THEN
      INSERT INTO public.service_sessions (business_date, service_kind, status, opened_by, open_source)
      VALUES (v_business_date, v_service_kind, 'open', COALESCE(p_actor,'system'), COALESCE(p_source,'order_intake'))
      RETURNING * INTO v_period;
    END IF;

    v_pointer.current_period_id := v_period.id;
  END IF;

  v_pointer.current_business_day_id := v_day.id;
  v_pointer.current_ticket_epoch    := v_day.ticket_epoch;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_pointer.current_business_day_id,
         current_period_id       = v_pointer.current_period_id,
         current_ticket_epoch    = v_pointer.current_ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  -- C1 — MANDATORY, same transaction, same lock: the legacy shadow must
  -- never point at a non-open/closing period once this commits. This is a
  -- write-through projection, never read here for permission.
  UPDATE public.service_session_state
     SET current_session_id = v_pointer.current_period_id, updated_at = now()
   WHERE singleton = true;

  -- Invariant assertions — fail closed rather than silently proceed on any
  -- violation (R_DAY3_INTAKE_AUTHORITY_AMENDMENT_V1_2026-08-16.md §3/§11).
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

REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_intake_context_v1(text, text) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — public.get_order_intake_context_v1(): READ-ONLY preflight mirror.
-- No lock, no lifecycle mutation, no authority write. Computes the exact
-- same schedule/business-date/period-kind facts as PART 1 above for JS UX
-- preflight only -- final authority always remains the in-transaction
-- resolver. STABLE, not VOLATILE: the planner and callers may treat repeated
-- calls within one statement as returning the same result.
CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_madrid           timestamp;
  v_minutes_of_day   integer;
  v_business_date    date;
  v_service_kind     text;
  v_can_create_order boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END;
  v_can_create_order := (v_minutes_of_day >= 480 AND v_minutes_of_day < 1050)
                       OR (v_minutes_of_day >= 1080);

  RETURN jsonb_build_object(
    'canCreateNewOrder', v_can_create_order,
    'businessDate', v_business_date,
    'serviceKind', v_service_kind
  );
END $function$;

REVOKE ALL ON FUNCTION public.get_order_intake_context_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_intake_context_v1() TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — retarget public.service_session_assign_order(). Trigger object
-- (ordenes_assign_service_session, BEFORE INSERT on ordenes) and its firing
-- position are UNCHANGED — only the function body changes. Forgery guards
-- preserved verbatim. R-DAY2's ordenes_order_entity_anchor_v1 still fires
-- immediately after (alphabetical BEFORE-trigger order unchanged) and still
-- derives Business Day lineage through NEW.service_session_id ->
-- service_sessions.business_day_id, untouched by this migration.
CREATE OR REPLACE FUNCTION public.service_session_assign_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_ctx jsonb;
BEGIN
  v_ctx := public.resolve_order_intake_context_v1('order_intake_v1', 'order_intake_v1');
  IF (v_ctx->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '%', COALESCE(v_ctx->>'code', 'ORDER_INTAKE_REJECTED') USING ERRCODE='P0001';
  END IF;

  IF NEW.service_session_id IS NOT NULL
     AND NEW.service_session_id <> (v_ctx->>'periodId')::uuid THEN
    RAISE EXCEPTION 'SERVICE_SESSION_FORGERY' USING ERRCODE='P0001';
  END IF;
  IF NEW.service_order_number IS NOT NULL THEN
    RAISE EXCEPTION 'SERVICE_ORDER_NUMBER_FORGERY' USING ERRCODE='P0001';
  END IF;

  NEW.service_session_id := (v_ctx->>'periodId')::uuid;
  UPDATE public.service_sessions
     SET next_order_number = next_order_number + 1,
         updated_at = now()
   WHERE id = NEW.service_session_id
  RETURNING next_order_number - 1 INTO NEW.service_order_number;

  RETURN NEW;
END $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4 — C2: date+kind is classification, not identity.
DROP INDEX public.service_sessions_date_kind_uq;
CREATE UNIQUE INDEX service_sessions_date_kind_active_uq
  ON public.service_sessions (business_date, service_kind)
  WHERE service_kind IS NOT NULL AND status IN ('open','closing');
-- service_sessions_single_active_uq (global, at most one open/closing row
-- ever) is untouched -- it is a stronger, independent invariant this index
-- change does not weaken.

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5 — C2 reader audit fix. Both functions are already retired from the
-- automatic order-intake path by PART 3 above; both remain reachable only via
-- manual/admin action (ensure_service_session: frozen page-load path +
-- incidentSafeRollover.js; roll_service_session_economic_v1: index.js's
-- admin-only "rollEconomicPeriod" HTTP action). Re-scoping their EXISTS
-- checks to active statuses only removes a latent false-refusal trap that
-- PART 4 would otherwise introduce, with no other change to either function.
CREATE OR REPLACE FUNCTION public.ensure_service_session(p_opened_by text, p_service_kind text, p_source text DEFAULT 'auto_entry'::text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_madrid timestamp;
  v_business_date date;
BEGIN
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SERVICE_KIND');
  END IF;
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_business_date := CASE WHEN v_madrid::time < TIME '04:00'
                          THEN v_madrid::date - 1 ELSE v_madrid::date END;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state
   WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions
       WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.service_sessions
     WHERE id=v_state.current_session_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_STATE_CORRUPT');
    END IF;
    IF v_session.status = 'closing' THEN
      RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_CLOSING',
                                'session',to_jsonb(v_session));
    END IF;
    IF v_session.business_date IS DISTINCT FROM v_business_date THEN
      RETURN jsonb_build_object('ok',false,'code','STALE_SERVICE_SESSION',
                                'expectedBusinessDate',v_business_date,
                                'session',to_jsonb(v_session));
    END IF;
    IF v_session.service_kind IS DISTINCT FROM p_service_kind THEN
      RETURN jsonb_build_object(
        'ok',false,
        'code',CASE WHEN v_session.service_kind='PRANZO'
                    THEN 'LUNCH_SESSION_STILL_ACTIVE'
                    ELSE 'OTHER_SERVICE_STILL_ACTIVE' END,
        'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,
                              'session',to_jsonb(v_session));
  END IF;

  -- C2 fix: scoped to active statuses -- a historical (rolled_over/closed)
  -- row for this (date,kind) must never block a genuinely new one.
  IF EXISTS (SELECT 1 FROM public.service_sessions
              WHERE business_date=v_business_date
                AND service_kind=p_service_kind
                AND status IN ('open','closing')) THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_ALREADY_COMPLETED_TODAY',
                              'businessDate',v_business_date,
                              'serviceKind',p_service_kind);
  END IF;
  INSERT INTO public.service_sessions(
    business_date,status,opened_by,open_source,service_kind
  ) VALUES (
    v_business_date,'open',p_opened_by,COALESCE(p_source,'auto_entry'),p_service_kind
  ) RETURNING * INTO v_session;
  UPDATE public.service_session_state
     SET current_session_id=v_session.id,updated_at=now()
   WHERE singleton=true;
  INSERT INTO public.service_session_audit(
    service_session_id,event_type,by_actor,source
  ) VALUES (
    v_session.id,'opened',p_opened_by,COALESCE(p_source,'auto_entry')
  );
  RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,
                            'session',to_jsonb(v_session));
END $function$;

CREATE OR REPLACE FUNCTION public.roll_service_session_economic_v1(p_service_session_id uuid, p_closeout_correlation_id uuid, p_actor text, p_source text, p_next_service_kind text, p_next_business_date date)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF p_next_service_kind IS NULL OR p_next_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_NEXT_SERVICE_KIND');
  END IF;
  IF p_next_business_date IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_NEXT_BUSINESS_DATE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'rolled_over' THEN
    SELECT * INTO v_next FROM public.service_sessions
     WHERE rollover_source_session_id = v_session.id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok',true,'code','ALREADY_ROLLED_OVER','idempotent',true,
        'sessionA',to_jsonb(v_session),'sessionB',to_jsonb(v_next)
      );
    END IF;
    RETURN jsonb_build_object('ok',false,'code','ROLLOVER_IDENTITY_MISMATCH','sessionA',to_jsonb(v_session));
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS','sessionStatus',v_session.status);
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

  -- C2 fix: scoped to active statuses -- a historical (rolled_over/closed)
  -- row for the next (date,kind) must never block a genuinely new rollover.
  IF EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE business_date = p_next_business_date AND service_kind = p_next_service_kind
       AND status IN ('open','closing')
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','NEXT_SERVICE_ALREADY_EXISTS');
  END IF;

  UPDATE public.service_sessions
     SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  INSERT INTO public.service_sessions(
    business_date, service_kind, status, opened_at, opened_by, open_source,
    rollover_source_session_id
  ) VALUES (
    p_next_business_date, p_next_service_kind, 'open', now(), p_actor, p_source,
    v_session.id
  ) RETURNING * INTO v_next;

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
$function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 6 — post-condition assertions. The migration itself never calls the
-- resolver (only defines it) and creates zero orders, so the pointer/legacy
-- shadow must remain exactly as inert as before it ran.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY3 post-condition failed: resolve_order_intake_context_v1 missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='get_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY3 post-condition failed: get_order_intake_context_v1 missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='service_sessions' AND indexname='service_sessions_date_kind_active_uq'
  ) THEN RAISE EXCEPTION 'R-DAY3 post-condition failed: service_sessions_date_kind_active_uq not created'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='service_sessions' AND indexname='service_sessions_date_kind_uq'
  ) THEN RAISE EXCEPTION 'R-DAY3 post-condition failed: old service_sessions_date_kind_uq still present'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename='service_sessions' AND indexname='service_sessions_single_active_uq'
  ) THEN RAISE EXCEPTION 'R-DAY3 post-condition failed: service_sessions_single_active_uq was affected -- must remain untouched'; END IF;
END $$;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY3 post-condition failed: payment_transactions population changed during this migration -- must be exactly 20';
  END IF;
  IF (SELECT current_business_day_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS NOT NULL
     AND (SELECT count(*) FROM public.business_days WHERE opened_by <> 'r_day1_backfill') = 0
  THEN
    -- Sanity: if the pointer is non-null, at least one non-backfill business_days
    -- row must exist -- this migration itself never activates the pointer.
    RAISE EXCEPTION 'R-DAY3 post-condition failed: pointer unexpectedly non-null with no corroborating business_days row';
  END IF;
END $$;

COMMIT;
