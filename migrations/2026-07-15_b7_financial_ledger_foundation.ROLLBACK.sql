-- migrations/2026-07-15_b7_financial_ledger_foundation.ROLLBACK.sql
-- Guarded rollback for B7A1 financial-ledger foundation.  ***STAGING ONLY***
-- (tdikhfeinufaahagmpjz). Removes ONLY the B7A1 schema objects. Fails CLOSED and
-- makes NO destructive change if any B7A1 feature already carries meaningful data.
-- Never deletes ledger rows, resets refunded, clears giro ownership/pointers, or
-- rewrites order states. Removal of ANULADO from orderStateMachine.js is a
-- SEPARATE git revert (and must not happen while an ANULADO order exists — guarded
-- here too). Do NOT run in tests.
BEGIN;

-- ── five-condition fail-closed guard ─────────────────────────────────────────
DO $$
DECLARE n_events int; n_refunded int; n_assigned int; n_pointer int; n_anulado int;
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: order_financial_events missing — unexpected state.';
  END IF;
  SELECT count(*) INTO n_events   FROM public.order_financial_events;
  SELECT count(*) INTO n_refunded FROM public.ordenes       WHERE refunded = true;
  SELECT count(*) INTO n_assigned FROM public.manual_giros  WHERE assigned_actor IS NOT NULL;
  SELECT count(*) INTO n_pointer  FROM public.auth_actors   WHERE active_manual_giro_id IS NOT NULL;
  SELECT count(*) INTO n_anulado  FROM public.ordenes       WHERE estado = 'ANULADO';
  IF n_events > 0 OR n_refunded > 0 OR n_assigned > 0 OR n_pointer > 0 OR n_anulado > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: B7A1 data present (events=%, refunded=%, assigned=%, pointer=%, anulado=%) — manual review required.',
      n_events, n_refunded, n_assigned, n_pointer, n_anulado;
  END IF;
END $$;

-- ── dependency-safe teardown (only reached when all five guards are clean) ───
DROP TRIGGER IF EXISTS order_financial_events_no_update_delete ON public.order_financial_events;
DROP TABLE   IF EXISTS public.order_financial_events;                       -- drops its indexes/constraints
DROP FUNCTION IF EXISTS public.order_financial_events_append_only();

DROP INDEX IF EXISTS public.manual_giros_assigned_actor_active_uq;
ALTER TABLE public.manual_giros DROP CONSTRAINT IF EXISTS manual_giros_assigned_actor_chk;
ALTER TABLE public.manual_giros DROP COLUMN IF EXISTS assigned_actor;       -- drops its FK

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_active_giro_role_chk;
ALTER TABLE public.auth_actors DROP COLUMN IF EXISTS active_manual_giro_id; -- drops its FK

ALTER TABLE public.ordenes DROP COLUMN IF EXISTS refunded;

COMMIT;
