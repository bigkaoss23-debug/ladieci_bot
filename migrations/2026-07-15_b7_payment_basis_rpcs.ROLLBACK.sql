-- migrations/2026-07-15_b7_payment_basis_rpcs.ROLLBACK.sql
-- Guarded rollback for the B7A2A payment-basis RPCs.  ***STAGING ONLY***
-- (tdikhfeinufaahagmpjz). Drops ONLY the two B7A2A business RPCs. It NEVER
-- alters/drops the ledger table, B7A1 columns/constraints/indexes/grants, order
-- data, or B6/auth objects; it NEVER deletes financial events. Fail-closed:
-- refuses if any payment-basis evidence (type='payment' OR 'payment_imported')
-- exists, since dropping the RPCs while a basis exists would orphan the code that
-- produced immutable evidence. Do NOT run in tests.
BEGIN;

DO $$
DECLARE n_basis int;
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: order_financial_events missing — unexpected state.';
  END IF;
  SELECT count(*) INTO n_basis FROM public.order_financial_events
   WHERE type IN ('payment','payment_imported');
  IF n_basis > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % payment-basis event(s) present — manual review required.', n_basis;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.order_mark_paid(text, text, text, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.order_import_legacy_payment(text, numeric, text, text, text, text, jsonb, text, text);

COMMIT;
