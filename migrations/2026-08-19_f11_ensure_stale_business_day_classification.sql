-- migrations/2026-08-19_f11_ensure_stale_business_day_classification.sql
-- F-11 — a STALE canonical Business Day pointer must classify as
-- NO_OPEN_SERVICE, never REOPEN_REQUIRED.
--
-- THE DEFECT (observed live on staging, 2026-08-19). F-7 (row 92) made
-- public.ensure_service_session READ/REUSE ONLY, and its "no active session"
-- ending became a pure DB-derived read:
--     current Business Day has NEVER had a service  -> NO_OPEN_SERVICE
--     current Business Day already has history      -> REOPEN_REQUIRED
-- Both branches trust business_day_lifecycle_state.current_business_day_id
-- AS-IS. That pointer is advanced by exactly ONE runtime writer --
-- resolve_order_intake_context_v1, from inside the ordenes INSERT trigger --
-- plus the dormant/explicit open primitives. Nothing advances it merely
-- because the calendar rolled over. So after a service is finalized, the
-- pointer keeps naming that PAST Business Day for as long as nobody places a
-- real order, and every ensure() call in the meantime answers
-- REOPEN_REQUIRED -- "you must intentionally reopen today's service" -- about
-- a day that is no longer today.
--
-- Reproduced live, not theorised: on 2026-08-19 the pointer still named the
-- 2026-08-16 Business Day (its service closed 2026-08-18 12:51:59Z), no
-- active session existed, and ensure_service_session returned
--     {"ok": false, "code": "REOPEN_REQUIRED", "businessDate": "2026-08-16"}
-- which the operational gate correctly renders as a blocking
-- "reopen the service" panel -- over what is simply a normal, idle new
-- Business Day. REOPEN_REQUIRED exists ONLY to protect an intentional SECOND
-- Operational Service on the SAME canonical Business Day after an explicit
-- Finalizar. Applying it across a day boundary is semantically wrong.
--
-- THE FIX (one branch, nothing else). The REOPEN_REQUIRED branch now also
-- requires that the pointer's Business Day IS the canonically-current one.
-- When it is not, the answer downgrades to NO_OPEN_SERVICE -- the same code,
-- and the same {businessDayId, businessDate} response shape, this function
-- already returns for "this Business Day has never had a service", so no
-- consumer sees a new vocabulary or a new shape on a path it did not already
-- handle. Two additive, purely diagnostic keys (staleBusinessDay,
-- currentBusinessDate) ride along ONLY on the downgraded answer; every
-- existing key keeps its existing meaning.
--
-- CANONICAL DATE AUTHORITY -- REUSED, NEVER RE-DERIVED. The comparison uses
-- public.get_order_intake_context_v1(), the existing zero-argument STABLE
-- function that mirrors resolve_order_intake_context_v1's own Business Day
-- computation constant-for-constant, including the 04:00 Madrid overnight
-- cutoff (before 04:00 belongs to the previous calendar day). It is already
-- the live order-intake preflight authority (src/serviceSessions/
-- orderIntakePolicy.js) AND already the authority F-9.1's own JS stale-
-- pointer guard compares against (src/serviceSessions/
-- explicitReopenServiceSession.js). This migration introduces NO new clock
-- rule, no `= CURRENT_DATE`, and no second calendar: it reuses the one rule
-- the order-intake path actually runs on. open_business_day_v1 was
-- deliberately NOT reused -- its own date computation omits that exact 04:00
-- cutoff, so reusing it would import a second, inconsistent rule (the same
-- conclusion F-9.1 reached and documented).
--
-- STILL READ/REUSE ONLY. get_order_intake_context_v1() is STABLE and derives
-- everything from clock_timestamp(); it writes nothing. This function
-- therefore remains non-mutating exactly as F-7 left it: it does NOT advance
-- current_business_day_id, does NOT create a Business Day, does NOT create a
-- service, does NOT touch ticket_epoch, and does NOT run any
-- rollover/forgotten-close recovery. Classification only. Business Day
-- advancement remains exclusively resolve_order_intake_context_v1's job, on
-- the next real order. The pre-existing advisory lock and FOR UPDATE row
-- locks are preserved verbatim (they are locks, not writes).
--
-- SAME-DAY PROTECTION IS NOT WEAKENED. When the pointer's Business Day IS
-- the canonical current one, the REOPEN_REQUIRED answer is byte-identical to
-- before -- same code, same businessDayId, same businessDate -- so F-9's
-- explicit same-Business-Day reopen (explicitReopenServiceSession.js, the
-- only caller allowed to pass 'explicit_reopen') routes exactly as it does
-- today. Only the cross-day case changes, and it changes from "block the
-- operator" to "nothing is open", which is the truth.
--
-- FAIL DIRECTION: toward the STRONGER protection. The downgrade fires ONLY
-- on positive evidence of staleness -- both dates present AND different. If
-- the canonical date cannot be read, or the pointer's Business Day row has
-- no date (a dangling pointer, an integrity fault this function has never
-- claimed to repair), the answer stays REOPEN_REQUIRED exactly as before.
-- An unreadable clock never silently unlocks a same-day reopen.
--
-- DEFENCE IN DEPTH, NOT A REPLACEMENT. F-9.1's JS guard in
-- explicitReopenServiceSession.js is deliberately left in place and
-- untouched. After this migration a stale pointer reaching that module
-- arrives as NO_OPEN_SERVICE (-> FIRST_OPEN_NOT_REOPENABLE) rather than
-- REOPEN_REQUIRED (-> STALE_BUSINESS_DAY_REOPEN); both are refusals with
-- zero creation and zero mutation, so the module's contract is preserved in
-- substance. Its guard still covers the residual read-then-act window (the
-- canonical date can cross 04:00 between the two calls) and any future
-- caller that reaches the primitive by another route -- it is now a backstop
-- rather than the only line, which is strictly stronger than before.
--
-- NOT IN SCOPE, EXPLICITLY UNTOUCHED: resolve_order_intake_context_v1 and
-- the whole F-10 forgotten-close contract (migration 93) -- byte-identical,
-- not read, not replaced; serviceLifecycleEngine / forgottenCloseRecovery /
-- creaOrdine; open_operational_service_v1; economic reporting and
-- classify_economic_period_v1; every other ensure_service_session branch
-- (INVALID_ACTOR, MULTIPLE_ACTIVE_SERVICE_SESSIONS, the current_session_id
-- REUSED / SERVICE_SESSION_CLOSING / SERVICE_SESSION_STATE_CORRUPT reads,
-- and the no-history NO_OPEN_SERVICE ending) is preserved verbatim.
--
-- Paired rollback: 2026-08-19_f11_ensure_stale_business_day_classification.ROLLBACK.sql
-- restores the exact pre-F-11 body (pg_get_functiondef md5
-- 2c41409d31b3006fa5d01828add45ca6).

BEGIN;

DO $$
DECLARE
  v_def_ensure text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-11 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF (SELECT max(apply_order) FROM public.ladieci_schema_migrations) <> 93 THEN
    RAISE EXCEPTION 'F-11 refused: ledger head is % (expected 93) -- registration drift, re-verify before proceeding',
      (SELECT max(apply_order) FROM public.ladieci_schema_migrations);
  END IF;

  -- The canonical Business Day authority this migration reuses must already
  -- exist; F-11 never defines a clock rule of its own.
  IF to_regprocedure('public.get_order_intake_context_v1()') IS NULL THEN
    RAISE EXCEPTION 'F-11 refused: get_order_intake_context_v1() does not exist -- the canonical Business Day authority this migration reuses is absent';
  END IF;

  -- F-7's 2-arg read/reuse-only signature is the only shape F-11 patches.
  IF to_regprocedure('public.ensure_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-11 refused: ensure_service_session(text,text) not found -- F-7 not applied, or drifted';
  END IF;

  SELECT md5(pg_get_functiondef(p.oid)) INTO v_def_ensure
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'ensure_service_session';

  IF v_def_ensure IS DISTINCT FROM '2c41409d31b3006fa5d01828add45ca6' THEN
    RAISE EXCEPTION
      'F-11 refused: installed ensure_service_session does not match the exact body this migration was written against (expected md5 2c41409d31b3006fa5d01828add45ca6, found %). Refusing to apply over drifted state -- re-derive this migration against the CURRENT installed body before retrying.',
      COALESCE(v_def_ensure, 'NULL (function not found)');
  END IF;

  -- F-10 (migration 93) must be intact and is never touched by F-11.
  IF to_regprocedure('public.resolve_order_intake_context_v1(text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-11 refused: resolve_order_intake_context_v1 does not exist -- unexpected pre-state';
  END IF;
END $$;

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
    -- writes nothing.
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

    RETURN jsonb_build_object('ok', false, 'code', 'REOPEN_REQUIRED',
      'businessDayId', v_bd_state.current_business_day_id,
      'businessDate', v_pointer_business_date);
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'NO_OPEN_SERVICE',
    'businessDayId', v_bd_state.current_business_day_id,
    'businessDate', (SELECT business_date FROM public.business_days WHERE id = v_bd_state.current_business_day_id));
END;
$function$;

DO $$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.ensure_service_session(text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-11 post-condition failed: ensure_service_session(text,text) missing after replace';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='ensure_service_session') <> 1 THEN
    RAISE EXCEPTION 'F-11 post-condition failed: expected exactly one ensure_service_session overload';
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='ensure_service_session';

  IF v_src NOT LIKE '%get_order_intake_context_v1%' THEN
    RAISE EXCEPTION 'F-11 post-condition failed: the canonical Business Day authority is not referenced by the new body';
  END IF;
  IF v_src NOT LIKE '%staleBusinessDay%' THEN
    RAISE EXCEPTION 'F-11 post-condition failed: the stale downgrade branch is absent from the new body';
  END IF;

  -- Read/reuse-only must survive this change: no writer may have crept in.
  IF v_src ~* '(INSERT INTO|UPDATE\s+public\.|DELETE FROM)' THEN
    RAISE EXCEPTION 'F-11 post-condition failed: ensure_service_session must remain non-mutating, but a write statement is present';
  END IF;

  -- F-10 must be untouched by this migration.
  IF to_regprocedure('public.resolve_order_intake_context_v1(text,text)') IS NULL THEN
    RAISE EXCEPTION 'F-11 post-condition failed: resolve_order_intake_context_v1 disappeared';
  END IF;
END $$;

COMMIT;
