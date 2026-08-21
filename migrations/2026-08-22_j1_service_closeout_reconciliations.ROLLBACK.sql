-- migrations/2026-08-22_j1_service_closeout_reconciliations.ROLLBACK.sql
-- Reverses 2026-08-22_j1_service_closeout_reconciliations.sql.
--
-- DESTRUCTIVE: dropping the table destroys the economic context every close
-- was made under -- which window the operator was shown, and which physical
-- cash count (if any) they confirmed against. That cannot be reconstructed
-- from service_closeouts, which is service-scoped by definition and knows
-- nothing about the Business Day window. Capture the rows first if any close
-- has already used this.
--
-- The forward migration touches nothing pre-existing, so this leaves no
-- residue: two objects out, nothing else altered.
--
-- PONR GUARD: refuses once any real reconciliation exists. Rolling back after
-- a close would leave that close permanently missing the context this slice
-- promised it would carry.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='service_closeout_reconciliations')
     AND (SELECT count(*) FROM public.service_closeout_reconciliations) > 0 THEN
    RAISE EXCEPTION 'J-1 rollback refused: % reconciliation row(s) exist -- a closed service would lose the economic context it was closed under',
      (SELECT count(*) FROM public.service_closeout_reconciliations);
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.create_service_closeout_reconciliation_v1(
  uuid, uuid, timestamptz, timestamptz, text, text, date,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, integer);
DROP TRIGGER IF EXISTS scr_no_update_delete ON public.service_closeout_reconciliations;
DROP TABLE IF EXISTS public.service_closeout_reconciliations;
DROP FUNCTION IF EXISTS public.service_closeout_reconciliations_append_only_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='service_closeout_reconciliations') THEN
    RAISE EXCEPTION 'J-1 rollback failed: the table still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='create_service_closeout_reconciliation_v1') THEN
    RAISE EXCEPTION 'J-1 rollback failed: the writer still exists';
  END IF;
  -- The lifecycle and the certified evidence must be exactly as untouched on
  -- the way out as on the way in.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='close_service_session_v3') THEN
    RAISE EXCEPTION 'J-1 rollback failed: close_service_session_v3 is missing';
  END IF;
  IF (SELECT count(*) FROM public.cash_counts) <> 1 THEN
    RAISE EXCEPTION 'J-1 rollback failed: the certified UAT cash count changed';
  END IF;
END $$;

COMMIT;
