-- migrations/2026-08-20_g1_autonomous_resume_operational_service.sql
-- G-1 — THE OPERATIONAL CYCLE RESUMES BY ITSELF.
--
-- THE DEFECT (reproduced live on staging, 2026-08-20, read-only). After a
-- genuine operator Finalizar, the canonical Business Day pointer still names
-- TODAY (it is not stale, so F-11's downgrade correctly does not fire) and
-- that Business Day already has a service. From there:
--
--   * ensure_service_session answered REOPEN_REQUIRED, which the operational
--     gate renders as a full-screen blocking panel over the whole app;
--   * resolve_order_intake_context_v1 answered REOPEN_REQUIRED too, and the
--     ordenes INSERT trigger re-raises that as an exception -- so the NEXT
--     REAL ORDER WAS REFUSED BY THE DATABASE;
--   * seating a table hit the same wall one level up, because Mesa requires
--     an already-open service;
--   * the only way out was a human pressing "Abrir nuevo servicio", i.e.
--     open_operational_service_v1(..., 'explicit_reopen', ...). That
--     ceremony was genuinely performed on 2026-08-19T18:26Z (service
--     b6cd0470, open_source 'manual_recovery') -- it is the documented live
--     workflow, not a hypothetical.
--
-- Both refusals came from ONE assumption that is no longer true: that a
-- Business Day holds at most one Operational Service, so a second one must
-- be an intentional, human-authorised reopen. The product contract says the
-- opposite. The restaurant works; the system follows. A Business Day holds
-- N Operational Services, exactly one of which is ever active
-- (service_sessions_single_active_uq, untouched here and still the backstop).
--
-- THE FIX -- three function bodies, no schema, no data, no new engine.
--
-- PART 1 -- open_operational_service_v1 gains a THIRD accepted open reason,
-- 'next_service_of_business_day'. It is NOT a relaxation of
-- 'first_open_of_business_day' (whose "this Business Day has never had a
-- service" guard is preserved character-for-character) and it is NOT a reuse
-- of 'explicit_reopen' (which keeps its exact meaning and its single
-- authorised JS call site). The new reason lands in the pre-existing ELSE
-- branch, whose rule already IS the correct one for a resume: the Business
-- Day must already have history, and -- from the untouched active-service
-- check above it -- nothing may currently be active. Zero new logic is
-- introduced inside the primitive: one string is added to one allow-list.
--
-- PART 2 -- resolve_order_intake_context_v1 stops refusing. Where it used to
-- RETURN REOPEN_REQUIRED it now selects which of the two openings applies
-- and calls the SAME canonical primitive, in the SAME transaction, under the
-- SAME advisory lock it already holds, with the canonical Business Day
-- pointer already written (that ordering is pre-existing and is exactly why
-- the primitive can trust it). Everything else in this function is
-- preserved: the intake-window rule, the Business Day resolution + creation,
-- the pointer/epoch integrity assertions, the legacy economic_period_v1
-- 'rolled_over' flip, and -- critically -- F-10's
-- FORGOTTEN_CLOSE_REQUIRED raise, which is asserted present both before and
-- after this migration runs.
--
-- PART 3 -- ensure_service_session stops calling it an exception. The
-- same-Business-Day-with-history-and-nothing-active state is now answered
-- NO_OPEN_SERVICE, the code this function ALREADY returns for "nothing is
-- open", carrying one additive diagnostic key (hadPriorServiceToday) so the
-- two shapes stay distinguishable in logs. The operational gate already maps
-- NO_OPEN_SERVICE to a normal, non-blocking idle app (the POST F-10 UX
-- correction), so bootstrap after a Finalizar becomes APP_READY with zero
-- services created -- and this function remains, as F-7 and F-11 left it,
-- incapable of writing anything at all. That is re-asserted below.
--
-- WHAT THIS MIGRATION DOES NOT TOUCH.
--   * F-10 (row 93): the resolver's FORGOTTEN_CLOSE_REQUIRED raise, its
--     SQLSTATE, and its DETAIL payload are asserted present before and after.
--   * F-11 (row 94): the stale-pointer downgrade branch in
--     ensure_service_session, including staleBusinessDay /
--     currentBusinessDate, is preserved verbatim and asserted.
--   * The Mesa first-seating stale-service guard (row 95): mesa_open_session_
--     _v1 and mesa_open_reservation_v1 are not referenced, not replaced, and
--     their pg_get_functiondef md5 checksums are asserted BYTE-IDENTICAL
--     before and after this migration.
--   * The service-creation surface stays exactly three functions. No new
--     creator is introduced; the one that already existed simply accepts one
--     more truthful reason.
--
-- CONCURRENCY. Two first activities racing (order + order, order + seating,
-- seating + seating) both enter resolve_order_intake_context_v1, which takes
-- pg_advisory_xact_lock(hashtext('service_session_lifecycle')) BEFORE
-- reading anything. The loser blocks, then finds the winner's service active
-- and reuses it (the pre-existing `IF FOUND AND v_period.business_day_id =
-- v_day.id` branch). open_operational_service_v1 takes the same lock and has
-- its own REUSED convergence. service_sessions_single_active_uq remains the
-- DB-level backstop. One service, always.
--
-- Paired rollback: 2026-08-20_g1_autonomous_resume_operational_service.ROLLBACK.sql
-- restores all three exact pre-G-1 bodies (pg_get_functiondef md5:
-- open_operational_service_v1        482e64e22b7f992fd018d02d72a5fc4e
-- resolve_order_intake_context_v1    5aa2042a2a7248bccd5d6309ebc10b45
-- ensure_service_session             7b090dd34016d3fa5741e942498e304f).

BEGIN;

DO $$
DECLARE
  v_md5_opener  text;
  v_md5_resolve text;
  v_md5_ensure  text;
  v_src_resolve text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'G-1 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF (SELECT max(apply_order) FROM public.ladieci_schema_migrations) <> 95 THEN
    RAISE EXCEPTION 'G-1 refused: ledger head is % (expected 95) -- registration drift, re-verify before proceeding',
      (SELECT max(apply_order) FROM public.ladieci_schema_migrations);
  END IF;

  -- The three bodies this migration rewrites must be EXACTLY the ones it was
  -- written against. Refusing over drift is cheaper than reasoning about it.
  IF to_regprocedure('public.open_operational_service_v1(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'G-1 refused: open_operational_service_v1(text,text,text) not found -- F-6 not applied, or drifted';
  END IF;
  IF to_regprocedure('public.resolve_order_intake_context_v1(text,text)') IS NULL THEN
    RAISE EXCEPTION 'G-1 refused: resolve_order_intake_context_v1(text,text) not found';
  END IF;
  IF to_regprocedure('public.ensure_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'G-1 refused: ensure_service_session(text,text) not found -- F-7 not applied, or drifted';
  END IF;

  v_md5_opener  := md5(pg_get_functiondef('public.open_operational_service_v1(text,text,text)'::regprocedure));
  v_md5_resolve := md5(pg_get_functiondef('public.resolve_order_intake_context_v1(text,text)'::regprocedure));
  v_md5_ensure  := md5(pg_get_functiondef('public.ensure_service_session(text,text)'::regprocedure));

  IF v_md5_opener IS DISTINCT FROM '482e64e22b7f992fd018d02d72a5fc4e' THEN
    RAISE EXCEPTION 'G-1 refused: installed open_operational_service_v1 does not match the body this migration was written against (expected 482e64e22b7f992fd018d02d72a5fc4e, found %)', v_md5_opener;
  END IF;
  IF v_md5_resolve IS DISTINCT FROM '5aa2042a2a7248bccd5d6309ebc10b45' THEN
    RAISE EXCEPTION 'G-1 refused: installed resolve_order_intake_context_v1 does not match the body this migration was written against (expected 5aa2042a2a7248bccd5d6309ebc10b45, found %)', v_md5_resolve;
  END IF;
  IF v_md5_ensure IS DISTINCT FROM '7b090dd34016d3fa5741e942498e304f' THEN
    RAISE EXCEPTION 'G-1 refused: installed ensure_service_session does not match the body this migration was written against (expected 7b090dd34016d3fa5741e942498e304f, found %)', v_md5_ensure;
  END IF;

  -- F-10 must be present in the PRE state, so the post-condition below is a
  -- genuine preservation check and not a vacuous one.
  SELECT p.prosrc INTO v_src_resolve FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  IF v_src_resolve NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'G-1 refused: F-10 raise absent from the installed resolver -- unexpected pre-state';
  END IF;

  -- The frozen Mesa first-seating guard must exist untouched; its checksums
  -- are re-asserted after the replaces below.
  IF to_regprocedure('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)') IS NULL
     OR to_regprocedure('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)') IS NULL THEN
    RAISE EXCEPTION 'G-1 refused: the Mesa first-seating guard functions are absent -- unexpected pre-state';
  END IF;
  IF md5(pg_get_functiondef('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'::regprocedure))
       IS DISTINCT FROM 'cdf15eb3699a6a86c16519b1dbcd2f1c'
     OR md5(pg_get_functiondef('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)'::regprocedure))
       IS DISTINCT FROM '21f6d47a1e911f01933bd4b2e2d8558e' THEN
    RAISE EXCEPTION 'G-1 refused: the Mesa first-seating guard bodies differ from the frozen row-95 checksums';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — open_operational_service_v1: one more truthful reason.
-- Byte-identical to the installed body except for the reason allow-list and
-- the two comments that explain it.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.open_operational_service_v1(p_opened_by text, p_open_reason text, p_source text)
 RETURNS jsonb
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
  -- G-1 — three reasons, three distinct meanings, never interchangeable:
  --   first_open_of_business_day    the Business Day has NEVER had a service
  --   next_service_of_business_day  it has, none is active, and real
  --                                 operational activity is resuming by
  --                                 itself (no human decision involved)
  --   explicit_reopen               a deliberate, human-triggered reopen
  -- Only the middle one is new. The other two keep their exact F-6/F-9
  -- semantics and their exact guards below.
  IF p_open_reason IS NULL OR p_open_reason NOT IN ('first_open_of_business_day', 'next_service_of_business_day', 'explicit_reopen') THEN
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
  ELSE
    -- Both 'next_service_of_business_day' and 'explicit_reopen' describe a
    -- SUBSEQUENT service of a Business Day that already has history. The rule
    -- is identical and pre-existing; only the stated reason differs, and it
    -- differs durably via the caller's own source string.
    IF NOT v_has_any THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_PRIOR_SERVICE_TO_REOPEN');
    END IF;
  END IF;

  INSERT INTO public.service_sessions (
    business_date, status, opened_by, open_source, service_kind, lifecycle_semantics
  ) VALUES (
    v_day.business_date, 'open', p_opened_by, p_source, NULL, 'operational_service_v1'
  ) RETURNING * INTO v_new;

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

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — resolve_order_intake_context_v1: resume instead of refuse.
-- The ONLY change is the block that used to RETURN REOPEN_REQUIRED.
-- ═══════════════════════════════════════════════════════════════════════════
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

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — ensure_service_session: idle is not an exception.
-- Still READ-ONLY. F-11's stale-pointer branch preserved verbatim.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.ensure_service_session(p_opened_by text, p_source text DEFAULT 'auto_entry'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
  v_has_any  boolean;
  v_pointer_business_date   date;
  v_canonical_business_date date;
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
    RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'session', to_jsonb(v_session));
  END IF;

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true;
  IF v_bd_state.current_business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE');
  END IF;

  v_has_any := EXISTS (SELECT 1 FROM public.service_sessions WHERE business_day_id = v_bd_state.current_business_day_id);
  IF v_has_any THEN
    SELECT business_date INTO v_pointer_business_date
      FROM public.business_days WHERE id = v_bd_state.current_business_day_id;

    -- F-11 — canonical Business Day authority, reused verbatim from the
    -- order-intake path (04:00 Madrid overnight cutoff included). STABLE,
    -- writes nothing. PRESERVED UNCHANGED BY G-1.
    v_canonical_business_date :=
      NULLIF(public.get_order_intake_context_v1() ->> 'businessDate', '')::date;

    -- Downgrade ONLY on positive evidence of staleness. A missing date on
    -- either side leaves the stronger same-day protection in place.
    IF v_pointer_business_date IS NOT NULL
       AND v_canonical_business_date IS NOT NULL
       AND v_pointer_business_date <> v_canonical_business_date
    THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
        'businessDayId', v_bd_state.current_business_day_id,
        'businessDate', v_pointer_business_date,
        'staleBusinessDay', true,
        'currentBusinessDate', v_canonical_business_date);
    END IF;

    -- G-1 — the pointer names the canonically-current Business Day and that
    -- day has already had a service, but none is active. Before G-1 this was
    -- the refusal the operational gate rendered as a blocking panel demanding
    -- a manual open (the retired code is not named here, for the same
    -- prosrc-scanning reason as above). It is simply IDLE: the next real order
    -- or the next table seating opens the next Operational Service by
    -- itself, via resolve_order_intake_context_v1 ->
    -- open_operational_service_v1('next_service_of_business_day').
    -- Same code and same shape as every other "nothing is open" answer this
    -- function already gives, plus one additive diagnostic key so the two
    -- idle shapes stay distinguishable in logs. This function still creates
    -- nothing and writes nothing -- asserted below.
    RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
      'businessDayId', v_bd_state.current_business_day_id,
      'businessDate', v_pointer_business_date,
      'hadPriorServiceToday', true);
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
    'businessDayId', v_bd_state.current_business_day_id,
    'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
END;
$function$;

DO $$
DECLARE
  v_opener  text;
  v_resolve text;
  v_ensure  text;
  v_creators int;
BEGIN
  SELECT p.prosrc INTO v_opener  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='open_operational_service_v1';
  SELECT p.prosrc INTO v_resolve FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  SELECT p.prosrc INTO v_ensure  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_service_session';

  -- Exactly one overload each: a signature change would silently leave a
  -- stale sibling reachable.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN
       ('open_operational_service_v1','resolve_order_intake_context_v1','ensure_service_session')) <> 3 THEN
    RAISE EXCEPTION 'G-1 post-condition failed: expected exactly one overload of each of the three patched functions';
  END IF;

  -- PART 1 ---------------------------------------------------------------
  IF v_opener NOT LIKE '%next_service_of_business_day%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the new open reason is absent from open_operational_service_v1';
  END IF;
  IF v_opener NOT LIKE '%explicit_reopen%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: explicit_reopen was dropped from open_operational_service_v1';
  END IF;
  -- The first-open guard must survive character-for-character: this is the
  -- rule the owner explicitly refused to relax.
  IF v_opener NOT LIKE '%IF p_open_reason = ''first_open_of_business_day'' THEN%'
     OR v_opener NOT LIKE '%SERVICE_REOPEN_REQUIRED%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the first_open_of_business_day guard was weakened or removed';
  END IF;
  IF v_opener NOT LIKE '%NO_PRIOR_SERVICE_TO_REOPEN%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the prior-history guard for subsequent services was removed';
  END IF;

  -- PART 2 ---------------------------------------------------------------
  IF v_resolve LIKE '%REOPEN_REQUIRED%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: resolve_order_intake_context_v1 still refuses with REOPEN_REQUIRED';
  END IF;
  IF v_resolve NOT LIKE '%next_service_of_business_day%'
     OR v_resolve NOT LIKE '%first_open_of_business_day%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the resolver does not select between the two openings';
  END IF;
  -- F-10, untouched and mandatory.
  IF v_resolve NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%'
     OR v_resolve NOT LIKE '%DETAIL = v_period.id::text%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: F-10 forgotten-close raise is missing or altered';
  END IF;
  -- The legacy-era rollover and the integrity assertions must all survive.
  IF v_resolve NOT LIKE '%''rolled_over''%'
     OR v_resolve NOT LIKE '%BUSINESS_DAY_POINTER_MISMATCH%'
     OR v_resolve NOT LIKE '%TICKET_EPOCH_MIRROR_MISMATCH%'
     OR v_resolve NOT LIKE '%ORDER_INTAKE_CLOSED%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: a pre-existing resolver invariant was dropped';
  END IF;
  -- The resolver must still never create a service row itself.
  IF v_resolve ~* 'INSERT\s+INTO\s+public\.service_sessions' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the resolver acquired a direct service_sessions INSERT';
  END IF;

  -- PART 3 ---------------------------------------------------------------
  IF v_ensure LIKE '%REOPEN_REQUIRED%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: ensure_service_session still answers REOPEN_REQUIRED';
  END IF;
  IF v_ensure NOT LIKE '%hadPriorServiceToday%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the idle diagnostic key is absent from ensure_service_session';
  END IF;
  -- F-11, untouched and mandatory.
  IF v_ensure NOT LIKE '%staleBusinessDay%'
     OR v_ensure NOT LIKE '%currentBusinessDate%'
     OR v_ensure NOT LIKE '%get_order_intake_context_v1%' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: F-11 stale-Business-Day classification is missing or altered';
  END IF;
  -- Read-only must survive: no writer may have crept in.
  IF v_ensure ~* '(INSERT INTO|UPDATE\s+public\.|DELETE FROM)' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: ensure_service_session must remain non-mutating, but a write statement is present';
  END IF;

  -- FROZEN NEIGHBOURS -----------------------------------------------------
  IF md5(pg_get_functiondef('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'::regprocedure))
       IS DISTINCT FROM 'cdf15eb3699a6a86c16519b1dbcd2f1c'
     OR md5(pg_get_functiondef('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)'::regprocedure))
       IS DISTINCT FROM '21f6d47a1e911f01933bd4b2e2d8558e' THEN
    RAISE EXCEPTION 'G-1 post-condition failed: the frozen Mesa first-seating guard bodies changed';
  END IF;

  -- CREATION SURFACE ------------------------------------------------------
  -- Still exactly three creators. G-1 adds no new one; it teaches the
  -- existing canonical one a third truthful reason.
  SELECT count(*) INTO v_creators
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
     AND p.prosrc ~* 'INSERT\s+INTO\s+public\.service_sessions';
  IF v_creators <> 3 THEN
    RAISE EXCEPTION 'G-1 post-condition failed: service_sessions creation surface is % functions (expected exactly 3)', v_creators;
  END IF;
END $$;

COMMIT;
