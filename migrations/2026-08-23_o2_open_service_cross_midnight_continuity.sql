-- migrations/2026-08-23_o2_open_service_cross_midnight_continuity.sql
-- O-2 — OPEN SERVICE CROSS-MIDNIGHT CONTINUITY.
--
-- THE GAP (cross-midnight audit, same-day prior session, read-only). O-1
-- removed the 17:30-18:00 blackout for order intake, but the SEPARATE
-- 00:00-08:00 overnight floor still blocked NEW ORDER CREATION uncondition-
-- ally -- including for an Operational Service that was already legitimately
-- open and continuing (e.g. opened 23:00, still open at 00:05). The audit
-- proved payments/deliveries of EXISTING orders were never affected (they
-- never touch this trigger), order ownership is immutable, and late-payment
-- attribution is correct -- the ONLY gap was new-order intake for an
-- ALREADY-RUNNING service across midnight.
--
-- THE CONTRACT. A valid Operational Service for the CURRENT business date
-- (04:00 Madrid rollover -- unchanged, unrelated to midnight) may keep
-- taking orders straight through 00:00-08:00. A restaurant with NO open
-- service may still not start one in that window -- that policy is
-- deliberately UNCHANGED. A service from a PRIOR business date still marked
-- open gets NO bypass: F-10's FORGOTTEN_CLOSE_REQUIRED is untouched.
--
-- THE FIX, ONE authority, no race. Both functions gain a continuity check
-- performed under the SAME advisory lock (resolve_order_intake_context_v1)
-- or as a read-only preflight peek (get_order_intake_context_v1) that
-- already governed every other lifecycle decision here -- no second SELECT
-- outside the lock, no decide-then-act gap between a peek and the INSERT.
--
-- resolve_order_intake_context_v1 (DB-canonical, under the advisory lock):
--   - The service_sessions lookup (`status IN ('open','closing') FOR UPDATE`)
--     that already existed lower in this function is simply performed BEFORE
--     the intake-window gate instead of after it -- same query, byte-
--     identical, just relocated. Its result is reused, never re-queried.
--   - v_continuity := that row was found AND its business_date = today's
--     v_business_date (the SAME comparison mesa_open_session_v1 already uses
--     for staleness -- no new concept, no second authority).
--   - The gate becomes `IF NOT v_can_create_order AND NOT v_continuity`:
--     unattended overnight blackout stays exactly as strict as before when
--     there is no matching service; a continuing one is let through.
--   - Below the gate, the ORIGINAL reuse/rollover/lazy-open branching is
--     UNCHANGED except it consumes the already-fetched row instead of
--     re-selecting it. A v_continuity=true row whose business_day_id turns
--     out to disagree with the freshly resolved v_day (should be
--     structurally impossible, since business_date and business_day_id are
--     always written together by open_operational_service_v1) fails loudly
--     with the SAME BUSINESS_DAY_POINTER_MISMATCH this function already
--     raises elsewhere, rather than silently guessing.
--   - A STALE prior-business-date service (business_date mismatch) is NOT
--     continuity: it falls through to the exact original stale-detection
--     re-query and FORGOTTEN_CLOSE_REQUIRED raise, untouched. Because that
--     re-query only runs once v_can_create_order is true (unchanged from
--     today), F-10 still does not fire during 00:00-08:00 -- identical to
--     current behaviour, not a new gap this migration introduces.
--
-- get_order_intake_context_v1 (read-only JS-preflight mirror, STABLE, no
-- lock -- advisory only): adds `hasValidCurrentService`, a lock-free
-- `EXISTS (... status IN ('open','closing') AND business_date = today ...)`
-- peek. It does NOT redefine canCreateNewOrder (kept as the pure clock
-- fact) -- the caller (orderIntakePolicy.js, this same migration) combines
-- the two. This preflight can race a real close between the peek and the
-- INSERT; that is fine and unchanged in kind from every other preflight
-- race in this codebase, because resolve_order_intake_context_v1 above,
-- under its own lock, is the sole final authority -- if the state changed,
-- the DB decides, never the preflight.
--
-- WHAT DOES NOT CHANGE. open_operational_service_v1, mesa_open_session_v1
-- (never read canCreateNewOrder to begin with -- already continuity-correct,
-- reconfirmed by this migration's own tests), mesa_close_session_v1,
-- mesa_post_payment_v1, Finalizar, service_closeouts semantics, Cash Count,
-- command numbering, order ownership, F-10's raise condition and DETAIL
-- contract, the 04:00 business-date rollover formula, and the lunch/dinner
-- classification boundary (17:30). No schema change, no business-data DML,
-- no backfill.

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
    RAISE EXCEPTION 'O-2 refused: public.resolve_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-2 refused: resolve_order_intake_context_v1 does not carry the expected pre-O-2 (post-O-1) formula -- resolve drift first';
  END IF;
  IF v_resolve NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'O-2 refused: the F-10 forgotten-close raise is missing from the live function -- resolve drift first';
  END IF;
  IF v_resolve LIKE '%hasValidCurrentService%' OR v_resolve LIKE '%v_continuity%' THEN
    RAISE EXCEPTION 'O-2 refused: resolve_order_intake_context_v1 already carries an O-2-shaped continuity concept -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_get
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get IS NULL THEN
    RAISE EXCEPTION 'O-2 refused: public.get_order_intake_context_v1 does not exist -- resolve drift first';
  END IF;
  IF v_get NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-2 refused: get_order_intake_context_v1 does not carry the expected pre-O-2 (post-O-1) formula -- resolve drift first';
  END IF;
  IF v_get LIKE '%hasValidCurrentService%' THEN
    RAISE EXCEPTION 'O-2 refused: get_order_intake_context_v1 already carries hasValidCurrentService -- resolve drift first';
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
BEGIN
  v_madrid := clock_timestamp() AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;

  v_business_date := CASE WHEN v_minutes_of_day < 240
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;
  v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  -- O-2 — the advisory lock now covers the continuity check too: this is the
  -- SAME lock every other lifecycle decision in this function already
  -- serializes under, acquired before any decision is made, so there is no
  -- window for a concurrent close/rollover to invalidate a peek taken
  -- outside it.
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  -- O-2 — the ORIGINAL open/closing lookup (previously only reached after
  -- the intake gate below), relocated verbatim, reused rather than re-run.
  SELECT * INTO v_period FROM public.service_sessions WHERE status IN ('open','closing') FOR UPDATE;
  v_had_open_or_closing := FOUND;
  -- Continuity means a service is open FOR TODAY'S business date -- the
  -- exact comparison mesa_open_session_v1 already uses for staleness. A
  -- service from a PRIOR business date is not continuity; it is F-10's
  -- territory below, unchanged.
  v_continuity := v_had_open_or_closing AND v_period.business_date = v_business_date;

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
    -- O-2 integrity check: business_date and business_day_id are always
    -- written together by open_operational_service_v1, so a v_continuity
    -- peek that matched by business_date must also match by business_day_id
    -- here. Structurally should never fire; fails loudly rather than
    -- silently trusting a mismatch if it ever did.
    IF v_continuity IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'BUSINESS_DAY_POINTER_MISMATCH' USING ERRCODE='P0001';
    END IF;
  ELSE
    v_period_needs_advance := true;
    IF v_had_open_or_closing THEN
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
                          THEN 'PRANZO' ELSE 'SERA' END; -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, preserved verbatim from the installed body for economic classification (S-C), not new vocabulary
  v_can_create_order := (v_minutes_of_day >= 480);

  -- O-2 — advisory-only continuity peek (STABLE, no lock, no write): mirrors
  -- resolve_order_intake_context_v1's own comparison (business_date = TODAY,
  -- same 04:00-rollover formula mesa_open_session_v1 already uses) so a
  -- legitimate continuing service is not false-negative-rejected by this
  -- preflight before the DB-canonical resolver is ever reached. This can
  -- race a real close between this read and the eventual INSERT; that is
  -- fine and by design -- the DB resolver, under its own lock, is the sole
  -- final authority and re-decides from scratch.
  SELECT EXISTS (
    SELECT 1 FROM public.service_sessions
     WHERE status IN ('open','closing') AND business_date = v_business_date
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

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_resolve_src text;
  v_get_src text;
BEGIN
  SELECT p.prosrc INTO v_resolve_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'resolve_order_intake_context_v1';
  IF v_resolve_src IS NULL THEN
    RAISE EXCEPTION 'O-2 post-condition failed: resolve_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_resolve_src NOT LIKE '%v_continuity := v_had_open_or_closing AND v_period.business_date = v_business_date;%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: the continuity derivation is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%IF NOT v_can_create_order AND NOT v_continuity THEN%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: the relaxed intake gate is missing from resolve_order_intake_context_v1';
  END IF;
  IF v_resolve_src NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: the F-10 forgotten-close raise did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%open_operational_service_v1(%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: the lazy-open call did not survive the replace';
  END IF;
  IF v_resolve_src NOT LIKE '%v_service_kind  := CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: the lunch/dinner classification boundary (17:30) must stay untouched';
  END IF;
  -- The continuity peek must run under the advisory lock, not before it:
  -- assert lock-acquisition text precedes the continuity derivation.
  IF position('pg_advisory_xact_lock' in v_resolve_src) > position('v_continuity := v_had_open_or_closing' in v_resolve_src) THEN
    RAISE EXCEPTION 'O-2 post-condition failed: continuity is derived before the advisory lock is held';
  END IF;
  -- Exactly ONE query against service_sessions for open/closing status in
  -- the continuity/gate path -- the relocated original, not a duplicate.
  IF (SELECT count(*) FROM regexp_matches(v_resolve_src, 'status IN \(''open'',''closing''\) FOR UPDATE', 'g')) <> 1 THEN
    RAISE EXCEPTION 'O-2 post-condition failed: expected exactly one relocated open/closing FOR UPDATE query, found a different count';
  END IF;

  SELECT p.prosrc INTO v_get_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_order_intake_context_v1';
  IF v_get_src IS NULL THEN
    RAISE EXCEPTION 'O-2 post-condition failed: get_order_intake_context_v1 is missing after CREATE OR REPLACE';
  END IF;
  IF v_get_src NOT LIKE '%hasValidCurrentService%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: hasValidCurrentService is missing from get_order_intake_context_v1';
  END IF;
  IF v_get_src NOT LIKE '%v_can_create_order := (v_minutes_of_day >= 480);%' THEN
    RAISE EXCEPTION 'O-2 post-condition failed: the base clock formula must stay untouched in get_order_intake_context_v1';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_order_intake_context_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-2 post-condition failed: service_role lost EXECUTE on one of the intake functions';
  END IF;
  IF has_function_privilege('anon', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_order_intake_context_v1(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_intake_context_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_order_intake_context_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'O-2 post-condition failed: anon/authenticated must never execute the intake functions';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-105: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 106, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied, so the real short hash is
-- known up front -- see the O-1 ledger-immutability lesson in this slice's
-- own report).

COMMIT;
