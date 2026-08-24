-- migrations/2026-08-24_o4c_resolver_dead_control_flow_simplification.sql
-- O-4.2 — FINAL RESOLVER CONTROL-FLOW SIMPLIFICATION.
--
-- THIS SLICE CHANGES NO CONTRACT AND NO LIFECYCLE BEHAVIOUR. O-4.1's own
-- report flagged that resolve_order_intake_context_v1's outer
-- `IF (v_had_open_or_closing AND v_period.business_day_id = v_day.id)`
-- branch is structurally unreachable and left it as an explicit FOLLOW-UP,
-- out of that slice's scope. This slice traces both variables that branch
-- touches, re-proves the finding, and removes exactly what is proven dead.
--
-- THE TRACE. Two variables, three total uses beyond their own declarations:
--   v_had_open_or_closing
--     (1) definition:  v_had_open_or_closing := FOUND;  right after the
--         global `SELECT ... WHERE status IN ('open','closing') FOR UPDATE`.
--     (2) use #1 (LIVE): the O-3/O-4 continuity fast-path --
--         `IF v_had_open_or_closing AND v_period.lifecycle_semantics =
--         'operational_service_v1' THEN ... RETURN ... END IF`.
--     (3) use #2 (the one under review): the outer slow-path branch --
--         `IF v_had_open_or_closing AND v_period.business_day_id = v_day.id
--         THEN v_period_needs_advance := false; ELSE ... END IF`.
--   v_period_needs_advance
--     (1) assigned false inside use #2's TRUE arm.
--     (2) assigned true inside use #2's ELSE arm (the only other arm).
--     (3) read exactly once, at the very end, in the slow path's own
--         RETURN: `'advanced', v_period_needs_advance`.
--
-- THE RE-PROOF (control flow, not "no data today" -- reconfirmed against
-- the live DB this session, same two structural closures O-4.1 established:
-- open_operational_service_v1 is the sole creator and hardcodes
-- lifecycle_semantics='operational_service_v1' on every INSERT; that column
-- is immutable post-insert via guard_service_sessions_lifecycle_semantics_
-- immutable_v1). Use #2 is reached only after use #1's IF did NOT return.
-- Since v_had_open_or_closing implies lifecycle_semantics=
-- 'operational_service_v1' by construction (proven, unconditionally),
-- "not (A AND B)" where "A implies B" is logically equivalent to "not A" --
-- so by the time use #2 runs, v_had_open_or_closing is PROVABLY, ALWAYS
-- false. Its outer IF condition (`v_had_open_or_closing AND ...`) can
-- therefore never evaluate true: the TRUE arm (v_period_needs_advance :=
-- false) is dead, and the ELSE arm (v_period_needs_advance := true) is the
-- ONLY value this variable could ever hold on the slow path -- a compile-
-- time constant wearing a runtime variable's clothes, not a real decision.
--
-- WHAT CHANGES: resolve_order_intake_context_v1 ONLY.
--   1. The outer `IF (v_had_open_or_closing AND v_period.business_day_id =
--      v_day.id) THEN v_period_needs_advance := false; ELSE
--      v_period_needs_advance := true; ... END IF` wrapper is removed. The
--      body of its ELSE arm -- the re-SELECT for business_day_id=v_day.id
--      AND status IN ('open','closing'), the IF NOT FOUND lazy-open call,
--      all byte-identical -- now simply runs unconditionally, unwrapped,
--      exactly where the ELSE arm's statements already were.
--   2. v_period_needs_advance is deleted: its DECLARE line, both
--      assignments (removed along with the wrapper), and its one read site,
--      which becomes the literal `'advanced', true` -- the only value it
--      could ever have carried to that point. Byte-semantically identical
--      output for every reachable input.
--   3. v_had_open_or_closing is KEPT, unchanged, at its definition site and
--      its use #1 (the fast-path condition) -- that use remains real,
--      necessary, and live. Only its second, dead use (use #2, deleted
--      along with the wrapper above) goes away.
--
-- WHAT DOES NOT CHANGE, DELIBERATELY (no redesign, per this slice's own
-- scope, matching O-4.1's own "no redesign" discipline). The re-SELECT +
-- IF NOT FOUND + lazy-open block that was already the ELSE arm's body is
-- preserved byte-for-byte, in place, unconditionally reachable now instead
-- of conditionally reachable -- its own internal logic is untouched. Note,
-- as a FOLLOW-UP observation only (not acted on here, exactly as O-4.1's
-- own equivalent finding was not acted on until asked): the same closed-
-- creation-surface proof implies the global `service_sessions_single_
-- active_uq` constraint (at most one open/closing row in the entire table)
-- makes the business-day-scoped re-SELECT provably always NOT FOUND too
-- whenever this code runs, since the unscoped global SELECT already found
-- nothing to get here -- meaning the lazy-open call is now provably always
-- taken as well. This slice does not touch that: the user's own scope was
-- v_had_open_or_closing and v_period_needs_advance, and "NON cambiare...
-- lazy-open semantics" was explicit. Also unchanged: the lifecycle
-- contract, explicit-Finalizar semantics, Business Day reporting,
-- multi-service (1:N) behaviour, economics, service_closeouts, Cash Count,
-- Economía, order ownership, payment attribution, the O-1 overnight floor,
-- the O-2 pointer-integrity check, the O-3/O-4 continuity fast-path and its
-- RESOLVED response shape, the 17:30 boundary, mesa_open_session_v1/mesa_
-- open_reservation_v1/ensure_service_session/open_operational_service_v1,
-- the 'rolled_over' status value and its historical rows/readers, and every
-- HISTORICAL migration file (F-7, F-10, mesa_first_seating_stale_service_
-- guard, O-1/O-2/O-3/O-4/O-4.1) -- none edited, all immutable. No table,
-- column, index, trigger or grant-signature change, no business DML, no
-- backfill, no historical row touched.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_resolve text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'O-4.2 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve LIKE '%FORGOTTEN_CLOSE_REQUIRED%' OR v_resolve LIKE '%crossesBusinessDay%' OR v_resolve LIKE '%rolled_over%' THEN
    RAISE EXCEPTION 'O-4.2 refused: resolve_order_intake_context_v1 does not carry the expected post-O-4.1 shape (earlier dead-code remnants still present) -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%v_period_needs_advance boolean;%' THEN
    RAISE EXCEPTION 'O-4.2 refused: resolve_order_intake_context_v1 does not declare v_period_needs_advance -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%IF v_had_open_or_closing AND v_period.business_day_id = v_day.id THEN%v_period_needs_advance := false;%ELSE%v_period_needs_advance := true;%' THEN
    RAISE EXCEPTION 'O-4.2 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-4.2 outer branch -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve, 'v_had_open_or_closing', 'g')) <> 4 THEN
    RAISE EXCEPTION 'O-4.2 refused: expected exactly four v_had_open_or_closing occurrences (DECLARE + assignment + two conditions) in the pre-O-4.2 body -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve, 'v_period_needs_advance', 'g')) <> 4 THEN
    RAISE EXCEPTION 'O-4.2 refused: expected exactly four v_period_needs_advance occurrences (declare + 2 assignments + 1 read) in the pre-O-4.2 body -- resolve drift first';
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

  -- O-4.2 — the outer same-business-day-reuse branch and its dedicated
  -- advancement flag are DELETED, not merely dormant: the earlier slice
  -- already proved that branch's own guard condition is provably always
  -- false by this point (every open/closing row shares the modern
  -- lifecycle semantics, which the fast-path above already caught and
  -- returned from), so its TRUE arm could never fire, and its ELSE arm was
  -- therefore the ONLY value ever reachable -- a constant, not a decision.
  -- What remains below is that ELSE arm's own body, byte-identical, now
  -- unconditional.
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

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_resolve_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src LIKE '%v_period_needs_advance%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: v_period_needs_advance was not fully removed from resolve_order_intake_context_v1';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'v_had_open_or_closing', 'g')) <> 3 THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: expected exactly three v_had_open_or_closing occurrences (DECLARE + assignment + the live fast-path use), found a different count';
  END IF;
  IF v_resolve_src LIKE '%rolled_over%' OR v_resolve_src LIKE '%FORGOTTEN_CLOSE_REQUIRED%' OR v_resolve_src LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: earlier dead-code invariants (O-4/O-4.1) must stay absent';
  END IF;
  IF v_resolve_src NOT LIKE '%v_had_open_or_closing AND v_period.lifecycle_semantics = ''operational_service_v1'' THEN%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the unconditional continuity fast-path is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%''advanced'', true%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the slow-path RETURN no longer reports advanced:true';
  END IF;
  IF v_resolve_src NOT LIKE '%SELECT * INTO v_period FROM public.service_sessions%WHERE business_day_id = v_day.id AND status IN (''open'',''closing'');%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the re-SELECT that used to sit inside the deleted wrapper did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%open_operational_service_v1(%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the lazy-open call did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the lunch/dinner classification boundary (17:30) must stay untouched';
  END IF;
  IF v_resolve_src NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the O-1 overnight-floor formula must stay untouched';
  END IF;
  IF v_resolve_src NOT LIKE '%BUSINESS_DAY_POINTER_MISMATCH%' THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: the O-2 pointer-integrity assertion must stay untouched';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'status IN \(''open'',''closing''\) FOR UPDATE', 'g')) <> 1 THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: expected exactly one open/closing FOR UPDATE query, found a different count';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'UPDATE public\.service_sessions', 'g')) <> 0 THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: no UPDATE of service_sessions should exist in this function';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: service_role lost EXECUTE on resolve_order_intake_context_v1';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-4.2 post-condition failed: anon/authenticated must never execute resolve_order_intake_context_v1';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-109: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 110, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
