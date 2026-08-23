-- migrations/2026-08-23_o4b_legacy_rollover_dead_branch_removal.sql
-- O-4.1 — FINAL LEGACY ROLLOVER DEAD-BRANCH REMOVAL.
--
-- THIS SLICE CHANGES NO CONTRACT AND NO LIFECYCLE BEHAVIOUR. O-4 (ledger 108)
-- already deleted the FORGOTTEN_CLOSE_REQUIRED raise and crossesBusinessDay
-- as proven dead code, and its own report flagged one more piece of the same
-- shape it had NOT yet removed: the legacy-rollover UPDATE inside
-- resolve_order_intake_context_v1's slow path. This migration removes
-- exactly that one write statement. Nothing else in the function changes.
--
-- THE REACHABILITY PROOF (control flow + two independent DB-level closures,
-- not "no data today"). Reaching the legacy-rollover UPDATE requires, at the
-- point it runs: v_had_open_or_closing = true (a service_sessions row with
-- status IN ('open','closing') was found) AND that same row's
-- lifecycle_semantics is NOT 'operational_service_v1' (otherwise O-3/O-4's
-- own continuity fast path, textually above, already returned). But:
--   (1) CREATION IS CLOSED. serviceSessionCreationSurface.static.test.js's
--       own replay proves open_operational_service_v1 is the ONLY function
--       in the entire migration history whose latest body can INSERT INTO
--       service_sessions (H-1, ledger 97, fail-closed the two legacy
--       creators). Its INSERT hardcodes the literal 'operational_service_v1'
--       for lifecycle_semantics -- reconfirmed by direct read of the live
--       body this session -- no parameter, no branch, no caller can make it
--       write anything else.
--   (2) MUTATION IS CLOSED. guard_service_sessions_lifecycle_semantics_
--       immutable_v1 (F-4B, ledger 91, BEFORE UPDATE OF lifecycle_semantics)
--       unconditionally raises SERVICE_SESSION_LIFECYCLE_SEMANTICS_IMMUTABLE
--       the instant NEW.lifecycle_semantics IS DISTINCT FROM OLD -- no
--       exception, no actor bypass, reconfirmed by direct read of the live
--       trigger body this session.
-- (1) and (2) together prove, by construction: EVERY row that has ever had
-- status IN ('open','closing') has ALWAYS had lifecycle_semantics =
-- 'operational_service_v1', permanently, and always will. So the instant
-- v_had_open_or_closing is true, the fast path's own condition is already
-- satisfied and the function has already returned -- the legacy-rollover
-- UPDATE's own guard condition (v_had_open_or_closing true AND semantics NOT
-- operational_service_v1) can never once evaluate true. ACTIVE LEGACY
-- ROLLOVER WRITERS = 0, proven structurally, not merely observed empirically.
-- A live schema-wide scan (pg_proc.prosrc LIKE '%rolled_over%' across every
-- function in the public schema, this session) confirms this is the ONLY
-- place the literal exists at all -- no other writer, live or legacy, exists
-- anywhere else to begin with.
--
-- WHAT DOES NOT CHANGE, DELIBERATELY (no redesign, per this slice's own
-- scope). The surrounding IF (v_had_open_or_closing AND v_period.
-- business_day_id = v_day.id) THEN ... ELSE ... END IF structure, the
-- v_period_needs_advance computation, and the re-SELECT + lazy-open path
-- immediately below the deleted block are ALL left completely untouched,
-- even though the same reachability proof above shows the TRUE branch of
-- that outer IF is also structurally unreachable today (v_had_open_or_
-- closing is provably always false by the time the ELSE branch is reached).
-- Collapsing that outer structure would be a deeper control-flow redesign of
-- this function, explicitly out of scope for this slice -- flagged as a
-- FOLLOW-UP observation in the session report, not acted on here. Also
-- unchanged: the status column, its CHECK constraint, the 'rolled_over'
-- enum value itself, and every existing historical row carrying it (4 real
-- rows confirmed live, read by previousBusinessDayResidue.js and
-- currentOperationalSession.js, neither of which this migration touches) --
-- this is a pure writer-side deletion, zero reader-compatibility impact by
-- construction. No table, column, index, trigger or grant-signature change,
-- no business DML, no backfill, no historical row touched.
--
-- WHAT CHANGES: resolve_order_intake_context_v1 ONLY, one deletion:
--   IF v_had_open_or_closing THEN
--     UPDATE public.service_sessions
--        SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
--      WHERE id = v_period.id;
--   END IF;
-- removed in full from the legacy-rollover branch. Nothing replaces it; the
-- re-SELECT for business_day_id = v_day.id AND status IN ('open','closing')
-- immediately follows, unchanged.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_resolve text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'O-4.1 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve LIKE '%FORGOTTEN_CLOSE_REQUIRED%' OR v_resolve LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'O-4.1 refused: resolve_order_intake_context_v1 does not carry the expected post-O-4 shape (F-10 remnants still present) -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%IF v_had_open_or_closing THEN%UPDATE public.service_sessions%SET status = ''rolled_over''%' THEN
    RAISE EXCEPTION 'O-4.1 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-4.1 legacy-rollover UPDATE -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve, 'rolled_over', 'g')) <> 2 THEN
    RAISE EXCEPTION 'O-4.1 refused: expected exactly two rolled_over occurrences (status literal + rolled_over_at column) in the pre-O-4.1 body -- resolve drift first';
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
  v_had_open_or_closing  boolean;
  v_continuity           boolean;
  v_ticket_epoch          integer;
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;
  v_had_open_or_closing := FOUND;

  IF v_had_open_or_closing AND v_period.lifecycle_semantics = 'operational_service_v1' THEN
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

  IF v_had_open_or_closing AND v_period.business_day_id = v_day.id THEN
    v_period_needs_advance := false;
  ELSE
    v_period_needs_advance := true;

    -- O-4.1 — the legacy-rollover UPDATE that used to sit here is DELETED,
    -- not kept as a backstop: reaching this ELSE branch already means
    -- v_had_open_or_closing is false (any true case already returned via the
    -- continuity fast-path above, since every open/closing row has
    -- lifecycle_semantics='operational_service_v1' by construction -- see
    -- this migration's own header for the closed-creation-surface +
    -- immutable-column proof). The IF v_had_open_or_closing THEN guard this
    -- UPDATE sat behind could therefore never once evaluate true.

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

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_resolve_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src LIKE '%rolled_over%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the legacy-rollover UPDATE (rolled_over) was not removed from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src LIKE '%FORGOTTEN_CLOSE_REQUIRED%' OR v_resolve_src LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: F-10/O-3 remnants must stay absent (O-4 invariant regressed)';
  END IF;
  IF v_resolve_src NOT LIKE '%v_had_open_or_closing AND v_period.lifecycle_semantics = ''operational_service_v1'' THEN%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the unconditional continuity fast-path is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%SELECT * INTO v_period FROM public.service_sessions%WHERE business_day_id = v_day.id AND status IN (''open'',''closing'');%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the re-SELECT that used to follow the deleted UPDATE did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%open_operational_service_v1(%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the lazy-open call did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the lunch/dinner classification boundary (17:30) must stay untouched';
  END IF;
  IF v_resolve_src NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the O-1 overnight-floor formula must stay untouched';
  END IF;
  IF v_resolve_src NOT LIKE '%BUSINESS_DAY_POINTER_MISMATCH%' THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: the O-2 pointer-integrity assertion must stay untouched';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'status IN \(''open'',''closing''\) FOR UPDATE', 'g')) <> 1 THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: expected exactly one open/closing FOR UPDATE query, found a different count';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'UPDATE public\.service_sessions', 'g')) <> 0 THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: no UPDATE of service_sessions should remain in this function at all';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: service_role lost EXECUTE on resolve_order_intake_context_v1';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-4.1 post-condition failed: anon/authenticated must never execute resolve_order_intake_context_v1';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-108: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 109, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
