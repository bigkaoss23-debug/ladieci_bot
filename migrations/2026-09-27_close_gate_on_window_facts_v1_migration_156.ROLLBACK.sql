-- migrations/2026-09-27_close_gate_on_window_facts_v1_migration_156.ROLLBACK.sql
-- Reverses 2026-09-27_close_gate_on_window_facts_v1_migration_156.sql: drops the two a0_close_gate_window_fact_v1 triggers and public.close_gate_window_fact_insert_v1().
-- Valid at any time (no data depends on it); after it, the bounded F2 residual is open again (a cash count or a legacy financial event can
-- commit between the close's digest re-check and its commit).

BEGIN;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_gate_window_fact_insert_v1()')) IS DISTINCT FROM '6ed381c0bcfa60fb48250c5dbb63ef2c'
     OR (SELECT count(*) FROM pg_trigger WHERE tgname = 'a0_close_gate_window_fact_v1') <> 2 THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT rollback refused: migration 156 is not applied with its certified objects';
  END IF;
END $guard$;

DROP TRIGGER a0_close_gate_window_fact_v1 ON public.order_financial_events;
DROP TRIGGER a0_close_gate_window_fact_v1 ON public.cash_counts;
DROP FUNCTION public.close_gate_window_fact_insert_v1();

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a0_close_gate_window_fact_v1')
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'close_gate_window_fact_insert_v1') THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT rollback post-condition failed';
  END IF;
END $post$;

COMMIT;
