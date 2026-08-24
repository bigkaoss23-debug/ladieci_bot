-- migrations/2026-08-24_n3_canonical_initial_payment.ROLLBACK.sql
-- Reverses 2026-08-24_n3_canonical_initial_payment.sql (ledger 114).
--
-- WHAT COMES BACK. Dropping this restores the pre-N-3 world: a Nuevo Pedido can
-- again be created with `ya_pagado=true` + `metodo_pago` and NO canonical payment
-- event, visible to Economía only through the legacy-compatibility branch. Do not
-- run this without accepting that.
--
-- DELIBERATELY PARTIAL, AND IT SAYS SO. The trigger, its function and the CHECK are
-- dropped unconditionally -- the slice wrote no data of its own and the intent
-- column is NULL at rest, so there is nothing to un-write there. The COLUMN itself
-- is dropped ONLY when no row carries a value, which is the normal case; a
-- non-empty column would mean an intent was stranded mid-transaction (structurally
-- impossible while the trigger exists) and is preserved for inspection rather than
-- silently discarded.
--
-- WHAT IS NOT REVERSED, AND MUST NOT BE. Every canonical payment this slice caused
-- to be written lives in `order_financial_events` -- real money, recorded by the
-- same canonical writer the operator collection path uses, with its own actor,
-- timestamp, digest and idempotency key. Those rows are NOT touched here, and the
-- legacy mirrors (`ya_pagado`/`cobrado`/`metodo_pago`) that the payment writer set
-- on those orders are NOT reverted either. Deleting evidence of money that was
-- genuinely collected would be strictly worse than the defect this slice fixed.
-- After a rollback those orders simply read as ordinary ledger-paid orders, which
-- is exactly what they are.
--
-- BACKEND ORDERING. Roll the backend back FIRST (or at least concurrently): a
-- deployed N-3 backend attaches `initial_payment_intent` to the INSERT, and once
-- the column is gone PostgREST answers that with PGRST204 (column not found) --
-- a clean, loud failure for paid-at-creation orders, not silent corruption, but a
-- hard outage for that flow until the code is rolled back too.

BEGIN;

DROP TRIGGER IF EXISTS ordenes_paid_at_creation_payment_v1 ON public.ordenes;
DROP FUNCTION IF EXISTS public.order_initial_payment_v1();
ALTER TABLE public.ordenes DROP CONSTRAINT IF EXISTS ordenes_initial_payment_intent_chk;

DO $$
DECLARE
  v_stranded bigint;
BEGIN
  SELECT count(*) INTO v_stranded FROM public.ordenes WHERE initial_payment_intent IS NOT NULL;
  IF v_stranded = 0 THEN
    EXECUTE 'ALTER TABLE public.ordenes DROP COLUMN IF EXISTS initial_payment_intent';
  ELSE
    RAISE WARNING 'N-3 rollback: % order(s) still carry initial_payment_intent -- column PRESERVED for inspection, drop it manually once resolved', v_stranded;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
              AND NOT tgisinternal AND tgname='ordenes_paid_at_creation_payment_v1') THEN
    RAISE EXCEPTION 'N-3 rollback failed: the initial-payment trigger is still installed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='order_initial_payment_v1') THEN
    RAISE EXCEPTION 'N-3 rollback failed: the initial-payment function still exists';
  END IF;
  -- N-2, N-5 and Mesa must survive the rollback untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1') THEN
    RAISE EXCEPTION 'N-3 rollback failed: the N-2 obligation anchor was collaterally removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-3 rollback failed: the N-5 economic mutation guard was collaterally removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'N-3 rollback failed: the Mesa line-snapshot trigger was collaterally removed';
  END IF;
  -- The canonical payment writer must be exactly as it was: this slice never
  -- redefined it, and a rollback must not have either.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_mark_paid') THEN
    RAISE EXCEPTION 'N-3 rollback failed: order_mark_paid disappeared';
  END IF;
END $$;

COMMIT;
