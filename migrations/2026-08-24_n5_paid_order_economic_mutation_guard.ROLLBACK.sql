-- migrations/2026-08-24_n5_paid_order_economic_mutation_guard.ROLLBACK.sql
-- Reverses 2026-08-24_n5_paid_order_economic_mutation_guard.sql (ledger 113).
--
-- WHAT COMES BACK. Dropping this guard restores the pre-N-5 world exactly:
-- generic order writers regain the ability to rewrite the economic basis
-- (totale / delivery_fee / descuento_*) of an order that already carries
-- payment evidence. N-2 keeps recording every such change as an immutable
-- obligation revision, so the mutation remains EVIDENCED -- it simply stops
-- being FORBIDDEN. Do not run this without accepting that.
--
-- SAFE AND COMPLETE. This slice created exactly two objects and wrote no data:
-- no table, column, index, constraint or grant on any pre-existing object was
-- altered, and no order, obligation or payment row was inserted, updated or
-- deleted. There is therefore nothing to un-write here -- dropping the trigger
-- and its function is the whole reversal, and it is idempotent.
--
-- ORDERING. The trigger goes first: dropping the function while the trigger
-- still references it would need CASCADE, which is a blunter instrument than
-- this reversal needs.

BEGIN;

DROP TRIGGER IF EXISTS ordenes_paid_order_economic_mutation_guard_v1 ON public.ordenes;
DROP FUNCTION IF EXISTS public.paid_order_economic_mutation_guard_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
              AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-5 rollback failed: the guard trigger is still installed';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-5 rollback failed: the guard function still exists';
  END IF;
  -- N-2 and Mesa must survive the rollback untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_revision_v1') THEN
    RAISE EXCEPTION 'N-5 rollback failed: the N-2 revision trigger was collaterally removed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'N-5 rollback failed: the Mesa line-snapshot trigger was collaterally removed';
  END IF;
END $$;

COMMIT;
