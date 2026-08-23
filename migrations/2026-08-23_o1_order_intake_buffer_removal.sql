-- migrations/2026-08-23_o1_order_intake_buffer_removal.sql
-- O-1 — REMOVE THE 17:30-18:00 ORDER-INTAKE BLACKOUT.
--
-- THE FINDING (surgical audit, this session, read-only, prior slice).
-- resolve_order_intake_context_v1's clock gate --
--   v_can_create_order := (v_minutes_of_day >= 480 AND < 1050) OR (>= 1080)
-- -- returns ORDER_INTAKE_CLOSED unconditionally whenever the wall clock
-- sits in [17:30, 18:00), BEFORE the function ever looks up whether an
-- Operational Service is already open. Real Railway transport logs proved
-- this blocked a genuine new comanda on an already-open, already-seated
-- Mesa (table_session 47218046-..., service f9eefbfe-...) on 2026-08-22 at
-- 17:39-17:45 Madrid -- nothing to do with table balance, purely the clock.
--
-- THE CONTRACT THIS RESTORES. The lunch/dinner labels are classification and
-- reporting only (service_kind, resolveEconomicPeriod's 17:30 cutover for
-- economic attribution) -- untouched by this migration. They were never
-- meant to be a lifecycle interrupt: an Operational Service may start
-- before 18:00, run through 18:00, and keep taking orders continuously
-- until an operator explicitly Finalizes or a genuine forgotten-close
-- recovery fires. The clock's ONLY remaining job for order intake is the
-- overnight floor (00:00-08:00, deliberately UNCHANGED by this migration --
-- out of this slice's scope, see the report).
--
-- WHAT CHANGES. Exactly one boolean expression, restated identically in both
-- functions (the DB-canonical resolver and its read-only JS-preflight
-- mirror):
--   OLD: (v_minutes_of_day >= 480 AND v_minutes_of_day < 1050) OR (v_minutes_of_day >= 1080)
--   NEW: v_minutes_of_day >= 480
-- 08:00-17:30 stays allowed, 17:30-18:00 becomes allowed (was blocked),
-- 18:00-24:00 stays allowed. 00:00-08:00 stays blocked, unchanged. Nothing
-- else in either function body changes: business-day resolution, the
-- advisory lock, the open/reuse/rollover/lazy-open branch, the
-- FORGOTTEN_CLOSE_REQUIRED raise (F-10, untouched), and every pointer
-- write are byte-identical to today's live bodies.
--
-- WHAT DOES NOT CHANGE. Finalizar (serviceLifecycleEngine.js /
-- serviceCloseAuthority.js), mesa_close_session_v1, mesa_post_payment_v1,
-- Cash Count / reconciliation, service_incidents, command numbering, order
-- ownership, and mesa_open_session_v1 (which never read canCreateNewOrder
-- to begin with -- it was already immune to this buffer, confirmed by the
-- prior audit). No schema change, no business-data DML, no backfill.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_resolve text;
  v_get text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'O-1 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%v_minutes_of_day >= 480 AND v_minutes_of_day < 1050%'
     OR v_resolve NOT LIKE '%v_minutes_of_day >= 1080%' THEN
    RAISE EXCEPTION 'O-1 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-1 buffer formula -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'O-1 refused: the F-10 forgotten-close raise is missing from the live function -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_get
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get IS NULL THEN
    RAISE EXCEPTION 'O-1 refused: public.get_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_get NOT LIKE '%v_minutes_of_day >= 480 AND v_minutes_of_day < 1050%'
     OR v_get NOT LIKE '%v_minutes_of_day >= 1080%' THEN
    RAISE EXCEPTION 'O-1 refused: get_order_intake_context_v1 does not carry the expected pre-O-1 buffer formula -- resolve drift first';
  END IF;
END $$;

BEGIN;

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
  v_open_reason          text;
  v_open_source          text;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  -- O-1 — the 17:30-18:00 buffer is REMOVED from order-intake permission.
  -- v_service_kind above stays a pure lunch/dinner classification/reporting
  -- label with its own unchanged 17:30 cutover; this boolean now governs
  -- ONLY the overnight floor (00:00-08:00), which is out of this slice's
  -- scope and stays exactly as it was.
  v_can_create_order := (v_minutes_of_day >= 480);

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

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id = v_day.id,
         current_ticket_epoch    = v_day.ticket_epoch,
         updated_at = now()
   WHERE singleton = true;

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;

  IF FOUND AND v_period.business_day_id = v_day.id THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;
    IF FOUND THEN
      IF v_period.lifecycle_semantics = 'operational_service_v1' THEN
        RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'
          USING ERRCODE = 'P0001', DETAIL = v_period.id::text;
      END IF;

      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

    SELECT * INTO v_period FROM public.service_sessions
     WHERE business_day_id = v_day.id AND status IN ('open','closing');
    IF NOT FOUND THEN
      -- G-1 — a Business Day holds N Operational Services. Which of the two
      -- openings applies is decided here and nowhere else; the opening
      -- itself is performed by the ONE canonical primitive, in this
      -- transaction, under the advisory lock already held above, with the
      -- canonical Business Day pointer already written just above (that
      -- ordering is pre-existing and is precisely why the primitive may
      -- trust current_business_day_id as its sole authority).
      --
      -- The refusal this replaces demanded a human press "Abrir nuevo
      -- servicio" before the restaurant could take its next order on a day
      -- it had already finalised once. That ceremony is gone. The retired
      -- code is deliberately NOT named inside this body: the post-conditions
      -- below scan prosrc, which includes comments, so documenting the token
      -- here would defeat the very check that proves it is gone.
      IF EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_day.id) THEN
        v_open_reason := 'next_service_of_business_day';
        -- Durable, greppable provenance without a schema change: the source
        -- states WHICH opening this was, and open_source is the column an
        -- auditor already reads. 'first_open' sources stay byte-identical.
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

REVOKE ALL ON FUNCTION public.resolve_order_intake_context_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_intake_context_v1(text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
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
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  -- O-1 — same removal as resolve_order_intake_context_v1's own body; this
  -- is its read-only preflight mirror and must never disagree with it.
  v_can_create_order := (v_minutes_of_day >= 480);

  RETURN jsonb_build_object(
    'canCreateNewOrder', v_can_create_order,
    'businessDate', v_business_date,
    'serviceKind', v_service_kind
  );
END $function$;

REVOKE ALL ON FUNCTION public.get_order_intake_context_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_order_intake_context_v1() TO service_role;

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_resolve_src text;
  v_get_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL THEN
    RAISE EXCEPTION 'O-1 post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src LIKE '%v_minutes_of_day < 1050)%OR%' OR v_resolve_src LIKE '%>= 1080%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the 17:30-18:00 buffer formula still appears in resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the expected simplified formula is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the F-10 forgotten-close raise did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%open_operational_service_v1(%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the lazy-open call did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the lunch/dinner classification boundary (17:30) must stay untouched';
  END IF;

  SELECT p.prosrc INTO v_get_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get_src IS NULL THEN
    RAISE EXCEPTION 'O-1 post-condition failed: get_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_get_src LIKE '%>= 1080%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the 17:30-18:00 buffer formula still appears in get_order_intake_context_v1';
  END IF;
  IF v_get_src NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-1 post-condition failed: the expected simplified formula is missing from get_order_intake_context_v1';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_order_intake_context_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-1 post-condition failed: service_role lost EXECUTE on one of the intake functions';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_order_intake_context_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-1 post-condition failed: anon/authenticated must never execute the intake functions';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-104: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 105, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit.

COMMIT;
