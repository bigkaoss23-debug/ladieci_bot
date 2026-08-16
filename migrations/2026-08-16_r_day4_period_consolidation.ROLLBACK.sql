-- migrations/2026-08-16_r_day4_period_consolidation.ROLLBACK.sql
-- Reverses 2026-08-16_r_day4_period_consolidation.sql -- and ONLY that
-- migration's own objects (consolidate_period_v1, period_consolidations and
-- its trigger/indexes). Touches nothing else: not business_day_lifecycle_
-- state, not service_sessions, not any R-DAY1-R-DAY3 object, not
-- capture_closeout_snapshot/mesa_singleton_workspace_v1/mesa_append_only_v1
-- (all pre-existing, unowned by this migration).
--
-- REAL POINT OF NO RETURN (see the task's own Phase 18 principle, which this
-- rollback enforces mechanically): once at least one authoritative
-- consolidation checkpoint has been committed, it is a historical economic
-- fact -- proof an operator captured a real economic snapshot at a real
-- server-assigned instant. A CODE/BEHAVIOR rollback (disable new
-- consolidation calls, restore pre-R-DAY4 runtime) is always safe and always
-- available. This script performs the DDL half of that -- it refuses outright
-- the moment any row exists, rather than silently deleting historical
-- evidence to make the rollback "clean". No force flag, no override: the
-- correct action once real rows exist is to stop calling the RPC (a runtime/
-- deploy decision), never to erase what it already recorded.
BEGIN;

DO $$
DECLARE v_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='period_consolidations'
  ) THEN RAISE EXCEPTION 'R-DAY4 rollback refused: period_consolidations does not exist -- nothing to roll back'; END IF;

  SELECT count(*) INTO v_count FROM public.period_consolidations;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'R-DAY4 rollback refused: % real consolidation checkpoint row(s) exist -- this is committed historical economic evidence and must never be deleted. Disable the RPC/action at the runtime layer instead of rolling back the schema.', v_count;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.consolidate_period_v1(uuid,uuid,text,text,text,boolean,text);
DROP TRIGGER IF EXISTS period_consolidations_append_only_v1 ON public.period_consolidations;
DROP TABLE IF EXISTS public.period_consolidations;

-- Post-condition: the pre-R-DAY4 schema shape is restored exactly, and every
-- object this migration never owned is provably untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='period_consolidations'
  ) THEN RAISE EXCEPTION 'R-DAY4 rollback post-condition failed: period_consolidations still exists'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 rollback post-condition failed: consolidate_period_v1 still exists'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 rollback post-condition failed: resolve_order_intake_context_v1 (R-DAY3, not owned by this migration) was unexpectedly removed'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='capture_closeout_snapshot'
  ) THEN RAISE EXCEPTION 'R-DAY4 rollback post-condition failed: capture_closeout_snapshot (pre-existing, not owned by this migration) was unexpectedly removed'; END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY4 rollback post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
END $$;

COMMIT;
