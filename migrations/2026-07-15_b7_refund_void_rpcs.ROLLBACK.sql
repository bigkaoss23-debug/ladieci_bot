-- migrations/2026-07-15_b7_refund_void_rpcs.ROLLBACK.sql
-- Guarded rollback for the B7A2B refund + void RPCs.  ***STAGING ONLY***
-- (tdikhfeinufaahagmpjz). Drops ONLY the two B7A2B business RPCs. It NEVER
-- deletes financial evidence, never sets ordenes.refunded=false, never rewrites
-- ANULADO, never clears cancellation timestamps, and never alters/drops B7A1 or
-- B7A2A objects, auth/giro schema, or ledger grants. Fail-closed: refuses if any
-- refund/void evidence exists. Do NOT run in tests.
BEGIN;

DO $$
DECLARE n_evt int;
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: order_financial_events missing — unexpected state.';
  END IF;
  SELECT count(*) INTO n_evt FROM public.order_financial_events WHERE type IN ('refund','void');
  IF n_evt > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % refund/void event(s) present — manual review required.', n_evt;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.order_refund(text, text, text, text, jsonb, text);
DROP FUNCTION IF EXISTS public.order_void(text, text, text, text, jsonb, text);

COMMIT;
