-- migrations/2026-09-06_stale_service_protection_v1_migration_120.sql
-- STALE SERVICE PROTECTION V1 — the Business Day is the grace boundary.
--
-- THE GAP THIS CLOSES, IN ONE LINE: O-3 (ledger 107) made an open
-- operational_service_v1 row "unconditional continuity regardless of Business
-- Day", O-4 (ledger 108) deleted the FORGOTTEN_CLOSE_REQUIRED raise + the
-- forgottenCloseRecovery.js module, and the deferred replacement recovery
-- surface was never built — so on 2026-09-06 a service whose own
-- business_date was 2026-08-25 was still handed back as the current
-- operational service, and a new order created today would be silently
-- assigned to it by the service_session_assign_order() BEFORE-INSERT trigger.
-- (See REPORT_STALE_SERVICE_LIFECYCLE_AUDIT_2026-09-06.md.)
--
-- OWNER DECISION, FINAL: no arbitrary N-day grace. The canonical Business Day
-- (04:00 Madrid rollover, computed exactly as get_order_intake_context_v1
-- already does) IS the grace boundary:
--   service.business_date  = currentBusinessDate  -> may be current/resumable
--                                                    by the normal lifecycle
--   service.business_date  < currentBusinessDate  -> STALE. Must NOT be
--                                                    handed back as normal
--                                                    intake context, and no
--                                                    new work may attach to
--                                                    it.
-- The existing 04:00 rollover already gives overnight continuity: a service
-- opened 23:00 keeps business_date = yesterday, and so does
-- currentBusinessDate until 04:00 the next day — they stay equal, continuity
-- holds. Only once a full Business Day has elapsed does the service turn
-- stale.
--
-- ARCHITECTURE (frozen): REFUSE SYNCHRONOUSLY IN SQL + RECOVER THROUGH THE ONE
-- V3 CLOSE AUTHORITY IN BACKEND JS. This migration is only the SQL half — it
-- makes the intake/lifecycle resolvers fail closed on a stale open service.
-- It NEVER closes a service, rewrites a business_date, touches an order, or
-- writes any business row. The backend module src/serviceSessions/
-- staleServiceRecovery.js then either safely auto-finalizes the stale service
-- through serviceCloseAuthority -> serviceLifecycleEngine (the one and only
-- V3 close path) or surfaces PREVIOUS_SERVICE_PENDING for operator
-- resolution.
--
-- WHAT CHANGES, THREE FUNCTIONS, ONE SHARED IDEA — "an open operational
-- service from a past Business Day is not the current service":
--   * resolve_order_intake_context_v1 — the operational_service_v1
--     short-circuit now returns {ok:false, code:'PREVIOUS_SERVICE_PENDING',
--     staleServiceSessionId, staleBusinessDate, currentBusinessDate} when
--     v_period.business_date < v_business_date, INSTEAD of RESOLVED. The
--     service_session_assign_order() trigger raises that code, so a new order
--     cannot enter a stale service — fail closed, every channel.
--   * ensure_service_session — the current_session_id IS NOT NULL branch now
--     runs the SAME stale check (via get_order_intake_context_v1, exactly the
--     authority the existing F-11 guard uses two branches down) BEFORE it can
--     short-circuit into REUSED. F-11 was structurally unreachable for a
--     still-open stale service; it no longer is.
--   * get_order_intake_context_v1 — hasValidCurrentService is scoped back to
--     business_date = v_business_date (the pre-O-3 shape for this read fact
--     only), so orderIntakePolicy.js's advisory preflight agrees with the
--     DB-canonical resolver instead of fail-opening a stale service through
--     the continuity branch.
--
-- WHAT IS DELIBERATELY UNCHANGED:
--   * Same-business-day continuity and the O-2 overnight (00:00-08:00) span:
--     business_date = currentBusinessDate is never stale.
--   * The 04:00 Madrid rollover, the schedule window, the service-kind
--     classification, ticket-epoch mirroring, the advisory lock, every
--     BUSINESS_DAY_POINTER_MISMATCH assertion — all byte-identical.
--   * No calendar-midnight shortcut, no age threshold, no business_date
--     rewrite, no service close inside SQL, no fabricated financial state.
--   * get_current_service_closeout_session is NOT touched (out of the
--     authorized scope) — the JS recovery layer reads through it and
--     classifies dynamically; no new persistent DB status is added.
--   * F-11's own existing guard (current_session_id IS NULL branch) is left
--     verbatim.

BEGIN;

-- ── PRE-CONDITION: refuse on drift ───────────────────────────────────────────
DO $guard$
DECLARE
  v_resolve text;
  v_ensure  text;
  v_get     text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'M120 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%IF v_had_open_or_closing AND v_period.lifecycle_semantics = ''operational_service_v1'' THEN%'
     OR v_resolve NOT LIKE '%''businessDate'', v_period.business_date,%'
     OR v_resolve NOT LIKE '%''advanced'', false%' THEN
    RAISE EXCEPTION 'M120 refused: resolve_order_intake_context_v1 does not carry the expected post-O-4c short-circuit shape -- resolve drift first';
  END IF;
  IF v_resolve LIKE '%PREVIOUS_SERVICE_PENDING%' THEN
    RAISE EXCEPTION 'M120 refused: resolve_order_intake_context_v1 already carries PREVIOUS_SERVICE_PENDING -- already applied?';
  END IF;
  IF v_resolve LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'M120 refused: resolve_order_intake_context_v1 still carries FORGOTTEN_CLOSE_REQUIRED -- pre-O-4 body, resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_ensure
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ensure_service_session';
  IF v_ensure IS NULL THEN
    RAISE EXCEPTION 'M120 refused: public.ensure_service_session does not exist -- resolve drift first';
  END IF;
  IF v_ensure NOT LIKE '%''code'', ''REUSED'', ''created'', false, ''session'', to_jsonb(v_session)%'
     OR v_ensure NOT LIKE '%v_canonical_business_date :=%get_order_intake_context_v1() ->> ''businessDate''%' THEN
    RAISE EXCEPTION 'M120 refused: ensure_service_session does not carry the expected F-11 shape -- resolve drift first';
  END IF;
  IF v_ensure LIKE '%PREVIOUS_SERVICE_PENDING%' THEN
    RAISE EXCEPTION 'M120 refused: ensure_service_session already carries PREVIOUS_SERVICE_PENDING -- already applied?';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_get
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get IS NULL THEN
    RAISE EXCEPTION 'M120 refused: public.get_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_get NOT LIKE '%status IN (''open'',''closing'') AND lifecycle_semantics = ''operational_service_v1''%' THEN
    RAISE EXCEPTION 'M120 refused: get_order_intake_context_v1 does not carry the expected post-O-3 hasValidCurrentService shape -- resolve drift first';
  END IF;
  IF v_get LIKE '%business_date = v_business_date%' THEN
    RAISE EXCEPTION 'M120 refused: get_order_intake_context_v1 already scopes hasValidCurrentService by business_date -- already applied?';
  END IF;

  -- Snapshot the counts this migration must not change (it writes no business row).
  PERFORM set_config('ladieci.m120_active_sessions_before',
    (SELECT count(*)::text FROM public.service_sessions WHERE status IN ('open','closing')), false);
  PERFORM set_config('ladieci.m120_sessions_before',
    (SELECT count(*)::text FROM public.service_sessions), false);
  PERFORM set_config('ladieci.m120_incidents_before',
    (SELECT count(*)::text FROM public.service_incidents), false);
END $guard$;

-- ── 1. resolve_order_intake_context_v1 — stale short-circuit fails closed ─────
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
  v_open_result          jsonb;
  v_open_reason          text;
  v_open_source          text;
  v_had_open_or_closing  boolean;
  v_continuity           boolean;
  v_ticket_epoch          integer;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

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

-- ── 2. ensure_service_session — stale check before REUSED ────────────────────
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

    -- STALE SERVICE PROTECTION V1 — the pointed-at open service is only the
    -- ordinary current service while its own business_date is still the
    -- canonical Business Day. Once a full Business Day has elapsed this must
    -- NOT short-circuit into REUSED (which is exactly how the F-11 guard in
    -- the branch below was being bypassed for a still-open stale service).
    -- Same authority F-11 uses; same typed shape. Reads only, writes
    -- nothing.
    v_canonical_business_date :=
      NULLIF(public.get_order_intake_context_v1() ->> 'businessDate', '')::date;
    IF v_session.business_date IS NOT NULL
       AND v_canonical_business_date IS NOT NULL
       AND v_session.business_date < v_canonical_business_date
    THEN
      RETURN jsonb_build_object('ok', false, 'code', 'PREVIOUS_SERVICE_PENDING',
        'staleServiceSessionId', v_session.id,
        'staleBusinessDate', v_session.business_date,
        'currentBusinessDate', v_canonical_business_date,
        'staleBusinessDay', true,
        'session', to_jsonb(v_session));
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

-- ── 3. get_order_intake_context_v1 — hasValidCurrentService is Business-Day-scoped ──
CREATE OR REPLACE FUNCTION public.get_order_intake_context_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid                    timestamp;
  v_minutes_of_day            integer;
  v_business_date             date;
  v_service_kind               text;
  v_can_create_order           boolean;
  v_has_valid_current_service  boolean;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, reproduced verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

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

-- ── POST-CONDITION: no business row written, all three functions carry the new shape ──
DO $post$
DECLARE
  v_resolve text;
  v_ensure  text;
  v_get     text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1';
  SELECT pg_get_functiondef(p.oid) INTO v_ensure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_service_session';
  SELECT pg_get_functiondef(p.oid) INTO v_get FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_order_intake_context_v1';

  IF v_resolve NOT LIKE '%v_period.business_date < v_business_date%'
     OR v_resolve NOT LIKE '%''code'', ''PREVIOUS_SERVICE_PENDING''%' THEN
    RAISE EXCEPTION 'M120 post-condition failed: resolve_order_intake_context_v1 missing the stale short-circuit';
  END IF;
  IF v_resolve NOT LIKE '%''advanced'', false%' OR v_resolve NOT LIKE '%''advanced'', true%' THEN
    RAISE EXCEPTION 'M120 post-condition failed: resolve_order_intake_context_v1 lost a RESOLVED path';
  END IF;
  IF v_ensure NOT LIKE '%v_session.business_date < v_canonical_business_date%'
     OR v_ensure NOT LIKE '%''code'', ''PREVIOUS_SERVICE_PENDING''%' THEN
    RAISE EXCEPTION 'M120 post-condition failed: ensure_service_session missing the stale check';
  END IF;
  IF v_ensure NOT LIKE '%''code'', ''REUSED'', ''created'', false%' THEN
    RAISE EXCEPTION 'M120 post-condition failed: ensure_service_session lost the REUSED path';
  END IF;
  IF v_get NOT LIKE '%AND business_date = v_business_date%' THEN
    RAISE EXCEPTION 'M120 post-condition failed: get_order_intake_context_v1 hasValidCurrentService not Business-Day-scoped';
  END IF;

  -- Not one business row is written or removed by this migration.
  IF (SELECT count(*)::text FROM public.service_sessions WHERE status IN ('open','closing'))
       IS DISTINCT FROM current_setting('ladieci.m120_active_sessions_before', true) THEN
    RAISE EXCEPTION 'M120 post-condition failed: active service session count changed';
  END IF;
  IF (SELECT count(*)::text FROM public.service_sessions)
       IS DISTINCT FROM current_setting('ladieci.m120_sessions_before', true) THEN
    RAISE EXCEPTION 'M120 post-condition failed: service_sessions row count changed';
  END IF;
  IF (SELECT count(*)::text FROM public.service_incidents)
       IS DISTINCT FROM current_setting('ladieci.m120_incidents_before', true) THEN
    RAISE EXCEPTION 'M120 post-condition failed: service_incidents row count changed';
  END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-119:
-- registered as a separate statement at apply time -- apply_order 120, kind 'ddl',
-- checksum = this file's sha256, applied_by = the introducing commit (committed
-- BEFORE this migration is applied). The manifest (MIGRATION_MANIFEST.md) carries
-- this file's own sha256(:16) for the git-history trail.

COMMIT;
