-- migrations/2026-08-17_f4b_service_sessions_lifecycle_semantics_immutable.sql
-- F-4B — Finalizar servicio repair: service_sessions.lifecycle_semantics
-- becomes immutable after INSERT. Nothing else changes.
--
-- Authority: owner-frozen F-4B brief, built directly on S-B (which added
-- lifecycle_semantics and its era-pairing CHECK) and F-4A (which copies this
-- exact column, by value, into three immutable evidence tables at INSERT
-- time). Fresh Phase-0 audit (this session, before writing this fix) found
-- lifecycle_semantics has NO dedicated UPDATE-guarding trigger today -- the
-- gap F-4A's own header already registered as a known prerequisite. That gap
-- is unacceptable before the first real operational_service_v1 row can ever
-- exist: without this guard, a row could in principle be INSERTed as one era
-- and silently reassigned to the other later, after evidence referencing its
-- ORIGINAL era has already been captured (F-4A evidence is a point-in-time
-- copy, not a live join) -- parent and evidence would then disagree about
-- which era actually produced that evidence, with no DB-level guarantee
-- either way was ever true.
--
-- PHASE 0 AUDIT (verified live and via full-repo source grep this session,
-- before writing the fix):
--   - Exactly two live triggers exist on service_sessions today:
--     service_sessions_business_day_derive_v1 (BEFORE INSERT only, cannot
--     fire on UPDATE) and service_sessions_closed_live_work_guard (BEFORE
--     UPDATE OF status only, does not reference lifecycle_semantics or
--     service_kind at all). Neither is touched by this migration.
--   - Every LIVE function that performs any UPDATE against service_sessions
--     was enumerated (pg_get_functiondef on every public function whose body
--     matches UPDATE\s+public\.service_sessions): begin_service_session_close,
--     close_service_session_v3, complete_service_session_close,
--     resolve_order_intake_context_v1, roll_service_session_economic_v1,
--     service_session_assign_order (trigger). Their SET clauses were read in
--     full: the only columns any of them ever assign are status, closed_at,
--     closed_by, close_source, updated_at, rolled_over_at, and
--     next_order_number. None sets lifecycle_semantics. None sets
--     service_kind either -- SERVICE_KIND_POST_INSERT_MUTATION_WRITERS is
--     also empty, confirmed by the same enumeration, not merely assumed by
--     analogy with lifecycle_semantics.
--   - Zero application-level (JS) writer exists for either column: no
--     `.from('service_sessions')` call anywhere in src/ or index.js, and a
--     repo-wide grep for lifecycle_semantics/lifecycleSemantics in src/ and
--     index.js returns a single unrelated comment, zero writes.
--   - roll_service_session_economic_v1 (the ONLY function that performs an
--     economic-era transition) already implements the target design exactly:
--     it UPDATEs the OLD session's status to 'rolled_over' (status/
--     rolled_over_at/updated_at only) and INSERTs a brand-new row for the
--     next era -- it never reassigns the old row's own lifecycle_semantics
--     or service_kind. Era transition already happens only by creating a NEW
--     service_session; this migration makes that the ONLY possible path,
--     database-enforced, rather than merely the only path anyone happens to
--     have written so far.
--   - Conclusion: zero legitimate writer of lifecycle_semantics exists
--     anywhere, confirmed at both the DB-function and application-source
--     level, not assumed. service_kind is left OUT of this migration's scope
--     entirely, per the task brief's explicit instruction not to broaden
--     casually -- it has zero live writers today (so it is *currently*
--     effectively immutable in practice) but gains no new DATABASE-level
--     enforcement here; that remains a separate, future decision.
--
-- THE FIX, and nothing else:
--   1. A new trigger function, guard_service_sessions_lifecycle_semantics_
--      immutable_v1(), rejecting any UPDATE where
--      NEW.lifecycle_semantics IS DISTINCT FROM OLD.lifecycle_semantics,
--      with a typed error (SERVICE_SESSION_LIFECYCLE_SEMANTICS_IMMUTABLE)
--      via the same RAISE EXCEPTION ... USING ERRCODE='P0001' idiom already
--      used throughout this codebase (e.g. resolve_order_intake_context_v1's
--      BUSINESS_DAY_POINTER_MISMATCH).
--   2. A new trigger, service_sessions_lifecycle_semantics_immutable_guard,
--      BEFORE UPDATE OF lifecycle_semantics ON service_sessions -- fires only
--      when a statement's own SET list names this column at all, matching
--      the existing service_sessions_closed_live_work_guard's own scoping
--      idiom (BEFORE UPDATE OF status).
--   IS DISTINCT FROM (not <>) means a same-value UPDATE (SET
--   lifecycle_semantics = lifecycle_semantics, or any UPDATE that happens to
--   name the column while leaving its value unchanged) is a harmless no-op,
--   never rejected -- per the task brief's own stated preference.
--
-- EXPLICITLY NOT DONE (frozen non-goals, per the F-4B task brief):
--   - service_kind gains NO new protection in this migration -- confirmed
--     zero live writers today, but that is a fact about current code, not a
--     database-enforced guarantee; left as a separate, distinct future
--     decision, not broadened into here;
--   - no lifecycle-semantics "conversion" RPC is introduced -- the ONLY way
--     to move to a new era remains creating a brand-new service_sessions row
--     (already how roll_service_session_economic_v1 works);
--   - no historical row is ever UPDATEd by this migration itself -- this is
--     a pure schema/trigger addition, zero DML;
--   - S-B's era-pairing CHECK (service_sessions_active_kind_chk) is
--     untouched -- it governs INSERT and the (status, service_kind) shape,
--     entirely orthogonal to this migration's post-INSERT UPDATE guard;
--   - F-4A's evidence-copy behavior (capture_closeout_snapshot/
--     create_service_closeout/create_service_incident) is untouched -- those
--     RPCs only ever READ v_session.lifecycle_semantics, never write to
--     service_sessions;
--   - V3-D3 (p_service_kind validation) and V3-D5 (schedule-derived
--     successor) remain untouched -- still open, out of F-4B's scope;
--   - no application/runtime JS change -- zero JS writer existed to change.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=88, MAX(verified)=76, rows 77-88 all
--     bootstrapped_unverified -- matches the exact expected pre-state.
--   - service_sessions: 13 rows total, 0 operational_service_v1, 0 rows of
--     any lifecycle_semantics value other than the two CHECK-permitted ones.
--   - Canonical pointer/legacy shadow both point at the same real session
--     (5e5777c5-71c8-4b54-aa78-1b1090c4cd04, lifecycle_semantics=
--     economic_period_v1); payment_transactions count = 20.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-4B refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='service_sessions_lifecycle_semantics_immutable_guard' AND tgrelid='public.service_sessions'::regclass)
  THEN
    RAISE EXCEPTION 'F-4B refused: service_sessions_lifecycle_semantics_immutable_guard already exists -- already applied';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_service_sessions_lifecycle_semantics_immutable_v1')
  THEN
    RAISE EXCEPTION 'F-4B refused: guard_service_sessions_lifecycle_semantics_immutable_v1 already exists -- already applied or name collision';
  END IF;
END $$;

-- ============================================================
-- Guard trigger function + trigger.
-- ============================================================
CREATE FUNCTION public.guard_service_sessions_lifecycle_semantics_immutable_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.lifecycle_semantics IS DISTINCT FROM OLD.lifecycle_semantics THEN
    RAISE EXCEPTION 'SERVICE_SESSION_LIFECYCLE_SEMANTICS_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER service_sessions_lifecycle_semantics_immutable_guard
  BEFORE UPDATE OF lifecycle_semantics ON public.service_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_service_sessions_lifecycle_semantics_immutable_v1();

-- ============================================================
-- Post-conditions (structural + real empirical proof, matching established
-- discipline -- not merely a shape assertion).
-- ============================================================
DO $$
DECLARE
  v_target_id uuid;
  v_before_updated_at timestamptz;
BEGIN
  -- Structural: trigger + function exist, correctly scoped.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='service_sessions_lifecycle_semantics_immutable_guard' AND tgrelid='public.service_sessions'::regclass) THEN
    RAISE EXCEPTION 'F-4B post-condition failed: guard trigger missing';
  END IF;
  IF (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='service_sessions_lifecycle_semantics_immutable_guard' AND tgrelid='public.service_sessions'::regclass)
     NOT LIKE '%BEFORE UPDATE OF lifecycle_semantics ON public.service_sessions%'
  THEN RAISE EXCEPTION 'F-4B post-condition failed: guard trigger not scoped to BEFORE UPDATE OF lifecycle_semantics'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_service_sessions_lifecycle_semantics_immutable_v1') THEN
    RAISE EXCEPTION 'F-4B post-condition failed: guard function missing';
  END IF;

  -- Real empirical negative probe against the REAL current session: a
  -- genuine cross-era UPDATE must be rejected, caught here via the standard
  -- PL/pgSQL nested-block savepoint idiom (no literal SAVEPOINT statement --
  -- PL/pgSQL has none), zero residue since the statement itself never
  -- commits any change.
  SELECT id, updated_at INTO v_target_id, v_before_updated_at FROM public.service_sessions ORDER BY created_at DESC LIMIT 1;
  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'F-4B post-condition failed: no service_sessions row exists to probe against';
  END IF;

  BEGIN
    UPDATE public.service_sessions SET lifecycle_semantics = 'operational_service_v1' WHERE id = v_target_id;
    RAISE EXCEPTION 'F-4B post-condition failed: cross-era UPDATE of lifecycle_semantics was NOT rejected by the new guard';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'SERVICE_SESSION_LIFECYCLE_SEMANTICS_IMMUTABLE' THEN
      RAISE EXCEPTION 'F-4B post-condition failed: negative probe raised an unexpected error: %', SQLERRM;
    END IF;
  END;

  -- Real empirical positive probe: a same-value UPDATE (column named in SET,
  -- value unchanged) must remain a harmless no-op, per the task brief's own
  -- stated preference. NOTE: now() is transaction-stable in Postgres (frozen
  -- at transaction start, not per-statement), so it cannot be used to prove
  -- "this UPDATE did something" within one transaction -- this probe relies
  -- only on lifecycle_semantics/updated_at staying byte-identical afterward,
  -- never on a clock value changing.
  UPDATE public.service_sessions SET lifecycle_semantics = lifecycle_semantics WHERE id = v_target_id;

  -- Neither probe left any residue: value and updated_at both unchanged
  -- (the negative probe's failed statement never committed; the positive
  -- probe is a genuine no-op -- it does not even bump updated_at, since it
  -- names no other column and the guard trigger never touches NEW itself).
  IF (SELECT lifecycle_semantics FROM public.service_sessions WHERE id = v_target_id) <> 'economic_period_v1' THEN
    RAISE EXCEPTION 'F-4B post-condition failed: probe residue -- real session lifecycle_semantics changed';
  END IF;
  IF (SELECT updated_at FROM public.service_sessions WHERE id = v_target_id) IS DISTINCT FROM v_before_updated_at THEN
    RAISE EXCEPTION 'F-4B post-condition failed: probe residue -- real session updated_at changed, same-value UPDATE was not a true no-op';
  END IF;

  -- Historical integrity: same row count, same era distribution, zero row
  -- ever UPDATEd by this migration itself (it performs no DML of its own --
  -- the two probes above are self-contained and self-reverting/no-op).
  IF (SELECT count(*) FROM public.service_sessions) <> 13
     OR (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0
  THEN RAISE EXCEPTION 'F-4B post-condition failed: service_sessions historical integrity violated'; END IF;

  -- Nothing else touched: pointer/shadow/financial invariants unchanged.
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-4B post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-4B post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-4B post-condition failed: payment_transactions population changed';
  END IF;
END $$;

COMMIT;
