-- migrations/2026-08-17_f2_v3_next_service_on_conflict_repair.sql
-- F-2 — Finalizar servicio repair, slice 2 ONLY: repair
-- ensure_next_service_session_v3's broken ON CONFLICT arbiter inference
-- (V3-D1). Nothing else changes.
--
-- Authority: owner-frozen F-2 finding (this session, Finalizar architecture
-- challenge, Opus deep-audit pass, empirically reproduced twice -- once
-- during the audit, once again fresh in this slice's own Phase 0). The
-- function's INSERT names an ON CONFLICT arbiter clause,
-- `(business_date, service_kind) WHERE service_kind IS NOT NULL`, that no
-- longer matches ANY live unique index -- R-DAY3 replaced the index this
-- clause was written against with a strictly narrower one,
-- service_sessions_date_kind_active_uq:
--   CREATE UNIQUE INDEX service_sessions_date_kind_active_uq
--     ON public.service_sessions (business_date, service_kind)
--     WHERE (service_kind IS NOT NULL)
--       AND (status = ANY (ARRAY['open'::text, 'closing'::text]));
-- (confirmed live, verbatim, before writing this fix -- not assumed). Since
-- Postgres requires an ON CONFLICT arbiter's WHERE clause to be predicate-
-- equivalent to a real index's own predicate for inference to succeed, and
-- the function's clause omits the status condition entirely, every call
-- that reaches this INSERT fails with 42P10 ("there is no unique or
-- exclusion constraint matching the ON CONFLICT specification") --
-- empirically reproduced, live, in a rolled-back transaction, both before
-- this migration was authored and again immediately before writing it.
--
-- THE FIX, and nothing else: the arbiter clause gains the exact missing
-- status condition, making it predicate-identical to the real index:
--   ON CONFLICT (business_date, service_kind)
--   WHERE service_kind IS NOT NULL AND status = ANY (ARRAY['open','closing'])
-- No other line of the function body changes.
--
-- EXPLICITLY NOT DONE (frozen non-goals, per the F-2 task brief):
--   - service_sessions_date_kind_active_uq itself is NOT touched -- it is
--     already correct (this migration conforms the FUNCTION to the INDEX,
--     never the reverse);
--   - no broader/new uniqueness constraint is added or restored -- historical
--     same-(business_date, service_kind) CLOSED/ROLLED_OVER rows remain
--     legal, exactly as R-DAY3 C2 intended (the real index's own status
--     predicate already excludes them; this migration does not change that
--     property, only stops the function from crashing when referencing it);
--   - guard_service_session_closed_v1 (V3-D2, the order-residue guard's
--     missing GUC check) is untouched -- still open;
--   - the p_service_kind NOT IN ('PRANZO','SERA') validation (V3-D3) is
--     untouched -- still open, zero operational_service_v1 support added;
--   - v3NextServiceIdentity.js / resolveSchedule()-derived successor
--     selection (V3-D5) is untouched -- still open;
--   - complete_service_session_close / close_service_session_v3's F-1
--     canonical-pointer-clear logic is untouched.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=85, MAX(verified)=76 -- matches the exact
--     expected pre-state.
--   - ensure_next_service_session_v3 is the ONLY function in the schema
--     referencing `ON CONFLICT (business_date, service_kind)` (grepped via
--     position() over every function body in pg_proc, not assumed) -- no
--     sibling defect exists elsewhere.
--   - Sole live caller chain: serviceLifecycleV3Transition.js's ensureNext()
--     -> serviceLifecycleEngine.js's closeServiceV3() -- itself confirmed to
--     have ZERO live callers (grepped fresh, only comment references) -- so
--     this migration is DB-only with zero deployed-runtime effect, exactly
--     as F-1 was.
--   - 42P10 reproduced fresh, live, in a rolled-back transaction, using the
--     function's own exact pre-F-2 arbiter clause against a real (unrelated,
--     historical) probe row -- not merely cited from the earlier audit.
BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-2 refused: staging sentinel migration absent -- wrong database?'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_next_service_session_v3';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'F-2 refused: ensure_next_service_session_v3 does not exist';
  END IF;

  -- Predecessor-body guard: the exact pre-F-2 broken arbiter clause must be
  -- present, byte-for-byte, or this migration refuses (already applied,
  -- drifted, or a different body than expected).
  IF position('ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT NULL
  DO NOTHING' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-2 refused: ensure_next_service_session_v3 does not match the expected pre-F-2 body -- already patched or drifted, resolve first';
  END IF;

  -- Drift guard: refuse if the post-F-2 shape is already present.
  IF position('WHERE service_kind IS NOT NULL AND status = ANY (ARRAY[' IN v_def) > 0 THEN
    RAISE EXCEPTION 'F-2 refused: ensure_next_service_session_v3 already shows the post-F-2 arbiter clause -- already applied';
  END IF;

  -- Empirical, not merely asserted: the real live index this migration's fix
  -- targets must exist with exactly the predicate this fix assumes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='service_sessions'
       AND indexname='service_sessions_date_kind_active_uq'
       AND indexdef = 'CREATE UNIQUE INDEX service_sessions_date_kind_active_uq ON public.service_sessions USING btree (business_date, service_kind) WHERE ((service_kind IS NOT NULL) AND (status = ANY (ARRAY[''open''::text, ''closing''::text])))'
  ) THEN
    RAISE EXCEPTION 'F-2 refused: service_sessions_date_kind_active_uq does not match the expected live index definition -- resolve drift before proceeding';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ensure_next_service_session_v3(p_source_session_id uuid, p_service_kind text, p_business_date date, p_opened_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_existing public.service_sessions%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
BEGIN
  IF p_source_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SERVICE_KIND');
  END IF;
  IF p_business_date IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_BUSINESS_DATE');
  END IF;
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  SELECT * INTO v_existing FROM public.service_sessions
   WHERE rollover_source_session_id = p_source_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_existing));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_existing FROM public.service_sessions
   WHERE rollover_source_session_id = p_source_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_existing));
  END IF;

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  IF v_state.recent_closed_session_id IS DISTINCT FROM p_source_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED');
  END IF;

  IF v_state.current_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_ALREADY_SET');
  END IF;

  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 0 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  -- F-2: arbiter clause repaired to be predicate-identical to the REAL live
  -- index (service_sessions_date_kind_active_uq) -- the missing status
  -- condition is the entire fix. No other line in this function changes.
  INSERT INTO public.service_sessions(
    business_date, status, opened_by, open_source, service_kind, rollover_source_session_id
  ) VALUES (
    p_business_date, 'open', p_opened_by, p_source, p_service_kind, p_source_session_id
  )
  ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT NULL AND status = ANY (ARRAY['open','closing'])
  DO NOTHING
  RETURNING * INTO v_session;

  IF FOUND THEN
    UPDATE public.service_session_state
       SET current_session_id = v_session.id, updated_at = now()
     WHERE singleton = true;
    INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
    VALUES (v_session.id, 'opened', p_opened_by, p_source);
    RETURN jsonb_build_object('ok',true,'code','ROLLED_OVER','created',true,'session',to_jsonb(v_session));
  END IF;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE business_date = p_business_date AND service_kind = p_service_kind;
  IF v_session.rollover_source_session_id IS DISTINCT FROM p_source_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','NEXT_SERVICE_IDENTITY_CONFLICT','session',to_jsonb(v_session));
  END IF;
  RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_session));
END;
$function$;

-- Post-conditions.
DO $$
DECLARE
  v_def text;
  v_probe_business_day uuid;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='ensure_next_service_session_v3';

  IF position('WHERE service_kind IS NOT NULL AND status = ANY (ARRAY[''open'',''closing''])' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: repaired arbiter clause not found';
  END IF;
  IF position('WHERE service_kind IS NOT NULL
  DO NOTHING' IN v_def) > 0 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: stale arbiter clause still present';
  END IF;

  -- Everything else byte-identical: validation order, the two rollover-
  -- source pre-checks, the advisory lock, the singleton/multi-active guards,
  -- the reuse-vs-conflict tail logic.
  IF position('INVALID_SERVICE_KIND' IN v_def) = 0 OR position('ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED' IN v_def) = 0
     OR position('MULTIPLE_ACTIVE_SERVICE_SESSIONS' IN v_def) = 0 OR position('NEXT_SERVICE_IDENTITY_CONFLICT' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: unrelated function logic changed -- out of scope';
  END IF;
  IF position('lifecycle_semantics' IN v_def) > 0 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: lifecycle_semantics referenced -- V3-D3 must remain untouched';
  END IF;

  -- Empirical, not merely asserted: prove the repaired arbiter actually
  -- resolves inference against the real live index, using a harmless
  -- historical probe row far outside any real business date. PL/pgSQL has
  -- no SAVEPOINT/ROLLBACK TO SAVEPOINT statement of its own -- a nested
  -- BEGIN/EXCEPTION/END block already takes an implicit savepoint and rolls
  -- back to it automatically if (and only if) an exception is caught, which
  -- is exactly what proves 42P10 is gone. Since the probe row's own
  -- status='closed' never matches the arbiter's own status predicate, this
  -- INSERT is never itself suppressed by DO NOTHING -- it genuinely commits
  -- a row, so it is explicitly deleted immediately after, regardless of
  -- outcome, before this migration's own COMMIT.
  BEGIN
    INSERT INTO public.service_sessions(business_date, status, opened_by, open_source, service_kind, closed_at, close_source)
    -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, used here only as a harmless historical probe value to empirically re-exercise the arbiter fix, not new vocabulary
    VALUES ('1999-01-01', 'closed', 'f2_migration_probe', 'f2_migration_probe', 'PRANZO', now(), 'f2_migration_probe')
    ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT NULL AND status = ANY (ARRAY['open','closing'])
    DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = '42P10' THEN
      RAISE EXCEPTION 'F-2 post-condition failed: repaired arbiter clause STILL raises 42P10 against the real live index';
    END IF;
    RAISE;
  END;
  DELETE FROM public.service_sessions WHERE business_date='1999-01-01' AND opened_by='f2_migration_probe';

  -- Nothing else touched: pointer/shadow/financial invariants unchanged by
  -- this migration itself (a CREATE OR REPLACE performs no data writes,
  -- asserted rather than assumed, matching established discipline).
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-2 post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-2 post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.service_closeouts) <> 3 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: service_closeouts population changed -- must be exactly 3';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics='operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: real operational_service_v1 rows must remain 0';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions WHERE business_date='1999-01-01') <> 0 THEN
    RAISE EXCEPTION 'F-2 post-condition failed: the inference probe row leaked -- SAVEPOINT rollback did not clean up';
  END IF;
END $$;

COMMIT;
