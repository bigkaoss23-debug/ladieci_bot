-- migrations/2026-08-23_o4_forgotten_close_dead_code_purge.sql
-- O-4 — POST O-3 LIFECYCLE DEAD-CODE PURGE.
--
-- THIS SLICE CHANGES NO CONTRACT. O-3 (ledger 107) already made the rule
-- FINAL: an Operational Service ends only with an explicit Finalizar, never
-- a clock or a Business Day boundary crossing. This migration exists solely
-- to delete DB-side scaffolding that O-3 left behind and that this session's
-- global sweep proved has zero reachable modern emitters and zero consumers.
--
-- WHAT WAS AUDITED (Phase 1-4, this session, read-only against the live DB
-- before any change). A live `pg_proc.prosrc LIKE '%FORGOTTEN_CLOSE_REQUIRED%'`
-- scan across every function in the public schema found exactly ONE hit:
-- resolve_order_intake_context_v1. mesa_open_session_v1 / mesa_open_
-- reservation_v1 no longer contain the literal at all -- O-3 already removed
-- their own copy of the raise, replacing it with MESA_SERVICE_NOT_CURRENT
-- scoped to non-operational_service_v1 semantics. The service_session_
-- assign_order trigger (ordenes_assign_service_session) merely calls
-- resolve_order_intake_context_v1() and lets whatever it raises propagate;
-- it holds no exception logic of its own naming FORGOTTEN_CLOSE_REQUIRED.
--
-- THE ONE REMAINING RAISE IS STRUCTURALLY UNREACHABLE, PROVEN BY CONTROL
-- FLOW, NOT BY "it doesn't happen today". Inside resolve_order_intake_
-- context_v1, the raise sits behind `IF v_period.lifecycle_semantics =
-- 'operational_service_v1' THEN RAISE ... END IF`, itself only reachable
-- when v_had_open_or_closing is true. But O-3's own continuity fast path,
-- textually ABOVE this branch, already returns unconditionally the moment
-- `v_had_open_or_closing AND v_period.lifecycle_semantics =
-- 'operational_service_v1'` is true. So by the time control could reach the
-- raise's guard, v_period.lifecycle_semantics = 'operational_service_v1' is
-- already known FALSE (the fast path would have returned otherwise) -- and
-- the raise's own guard re-checks the identical condition. A branch guarded
-- by a condition already proven false by an earlier branch in the SAME
-- execution can never run. ACTIVE MODERN EMITTERS = 0, permanently, by
-- construction, not by today's data.
--
-- WHY THIS TIME IT IS DELETED, NOT KEPT AS A BACKSTOP. O-3's own header
-- reasoned this raise should stay "as F-10's recovery machinery for a FUTURE
-- manual/late-finalization path". That future capability does not exist yet
-- (no warning, no operator action, no declared effective close time, no
-- mandatory reason, no cash count, no audit attribution) and a future
-- capability is not a current caller. Both DOWNSTREAM consumers this raise
-- fed are deleted in this same slice: forgottenCloseRecovery.js (the sole
-- executor) and its two callers in mesaService.js / agentOrdini.js, so an -- language-guard: allow-legacy agentOrdini.js is the existing module filename being cross-referenced, not new vocabulary
-- unreachable raise kept "just in case" would have zero code left that could
-- even receive it. When a future recovery capability is designed, it will
-- name the state it recovers from explicitly, not resurrect this literal.
--
-- crossesBusinessDay (O-3's own additive signal on the continuity fast path)
-- is deleted for the identical reason: this session's sweep found the field
-- has exactly one producer (this function) and zero consumers anywhere in
-- the application -- no JS reads it, no log line writes it, no table
-- persists it, no test asserts its value. Unused metadata kept "in case a
-- future UI wants it" is exactly what this slice exists to remove; a future
-- recovery UX will define whatever signal it actually needs when it is built.
--
-- WHAT CHANGES: resolve_order_intake_context_v1 ONLY, two deletions inside
-- its existing body, no new branch, no new field, no schema change, no
-- grant-signature change (REVOKE/GRANT restated with the exact same
-- service_role-only split), no business DML, no backfill, no historical row
-- touched.
--   1. The continuity fast path's RETURN drops the 'crossesBusinessDay' key.
--      businessDayId/businessDate/periodId/serviceKind/ticketEpoch/advanced
--      are all untouched.
--   2. The `IF v_period.lifecycle_semantics = 'operational_service_v1' THEN
--      RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED' ... END IF;` block is
--      deleted from the legacy-rollover branch. The UPDATE ... SET status =
--      'rolled_over' immediately below it is KEPT and now runs unconditionally
--      for that branch -- exactly the plain rollover this branch always had
--      before F-10 existed, itself unreachable today for the identical
--      reason (G-1/H-1, ledger 96/97, made creating any session with
--      lifecycle_semantics <> 'operational_service_v1' structurally
--      impossible), kept only because deleting the UPDATE itself would
--      change this slice's scope from dead-code removal to redesigning 1:N
--      Business Day rollover semantics, which O-4 does not touch.
--
-- WHAT DOES NOT CHANGE: O-1's overnight-floor formula, O-2's continuity
-- derivation and BUSINESS_DAY_POINTER_MISMATCH integrity check, O-3's
-- continuity fast path's own trigger condition and RESOLVED response shape
-- (minus crossesBusinessDay), the 17:30 lunch/dinner classification
-- boundary, the lazy-open call to open_operational_service_v1, the advisory
-- lock, get_order_intake_context_v1, mesa_open_session_v1, mesa_open_
-- reservation_v1, ensure_service_session, Finalizar, service_closeouts
-- semantics, Cash Count, Economía, order ownership, payment attribution, -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal, named here only to state what this migration does not touch, not new vocabulary
-- CHIUSO_FORZATO historical compatibility, the catalog/editor, reservas UI.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_resolve text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_resolve
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve IS NULL THEN
    RAISE EXCEPTION 'O-4 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%''crossesBusinessDay'', v_period.business_date IS DISTINCT FROM v_business_date%' THEN
    RAISE EXCEPTION 'O-4 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-4 (post-O-3) crossesBusinessDay shape -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%IF v_period.lifecycle_semantics = ''operational_service_v1'' THEN%RAISE EXCEPTION ''FORGOTTEN_CLOSE_REQUIRED''%' THEN
    RAISE EXCEPTION 'O-4 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-4 (post-O-3) legacy-rollover raise -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve, 'FORGOTTEN_CLOSE_REQUIRED', 'g')) <> 1 THEN
    RAISE EXCEPTION 'O-4 refused: expected exactly one FORGOTTEN_CLOSE_REQUIRED occurrence in the pre-O-4 body -- resolve drift first';
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

  -- O-4 (was F-10B) — an Operational Service ends only with an explicit
  -- Finalizar. Any open/closing operational_service_v1 row is unconditional
  -- continuity: no business_date comparison, no business_days work, no
  -- pointer write, no successor. The row is returned exactly as it already
  -- was. crossesBusinessDay (O-3) is REMOVED here, not merely left unread:
  -- this session's global sweep proved it has zero consumers anywhere in the
  -- application, so it was dead producer code, not a kept-for-later signal.
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

  -- O-2's continuity flag is now decided entirely by the O-3 branch above
  -- (an operational_service_v1 row never reaches this point). What remains
  -- here is the ORIGINAL, byte-identical gate/lazy-open/legacy-rollover
  -- logic for the "nothing operational_service_v1 is open" case.
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
    IF v_had_open_or_closing THEN
      -- O-4 (was F-10B) — the FORGOTTEN_CLOSE_REQUIRED raise that used to sit
      -- here is DELETED, not kept as a backstop: reaching this branch at all
      -- already requires v_period.lifecycle_semantics <> 'operational_
      -- service_v1' (any operational_service_v1 row returns unconditionally
      -- from the fast path above, before this branch can ever run), and
      -- G-1/H-1 (ledger 96/97) made creating a session with any OTHER
      -- lifecycle_semantics structurally impossible -- so the raise's own
      -- guard condition could never once evaluate true. What remains is the
      -- plain rollover this branch always had for a legacy row, itself
      -- unreachable today for the identical reason, kept only because
      -- deleting the UPDATE itself would change 1:N Business Day rollover
      -- semantics, which this slice does not touch.
      UPDATE public.service_sessions
         SET status = 'rolled_over', rolled_over_at = now(), updated_at = now()
       WHERE id = v_period.id;
    END IF;

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
    RAISE EXCEPTION 'O-4 post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src LIKE '%crossesBusinessDay%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: crossesBusinessDay was not removed from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the FORGOTTEN_CLOSE_REQUIRED raise was not removed from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%v_had_open_or_closing AND v_period.lifecycle_semantics = ''operational_service_v1'' THEN%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the unconditional continuity fast-path is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%''advanced'', false%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the continuity fast-path no longer reports advanced:false';
  END IF;
  IF v_resolve_src NOT LIKE '%SET status = ''rolled_over'', rolled_over_at = now(), updated_at = now()%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the legacy-rollover UPDATE did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%open_operational_service_v1(%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the lazy-open call did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the lunch/dinner classification boundary (17:30) must stay untouched';
  END IF;
  IF v_resolve_src NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the O-1 overnight-floor formula must stay untouched';
  END IF;
  IF v_resolve_src NOT LIKE '%BUSINESS_DAY_POINTER_MISMATCH%' THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the O-2 pointer-integrity assertion must stay untouched';
  END IF;
  -- The continuity fast-path must still be reachable BEFORE the intake-window gate.
  IF position('v_had_open_or_closing AND v_period.lifecycle_semantics' in v_resolve_src)
     > position('IF NOT v_can_create_order AND NOT v_continuity THEN' in v_resolve_src) THEN
    RAISE EXCEPTION 'O-4 post-condition failed: the continuity fast-path must precede the intake-window gate';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'status IN \(''open'',''closing''\) FOR UPDATE', 'g')) <> 1 THEN
    RAISE EXCEPTION 'O-4 post-condition failed: expected exactly one open/closing FOR UPDATE query, found a different count';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-4 post-condition failed: service_role lost EXECUTE on resolve_order_intake_context_v1';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-4 post-condition failed: anon/authenticated must never execute resolve_order_intake_context_v1';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-107: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 108, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
