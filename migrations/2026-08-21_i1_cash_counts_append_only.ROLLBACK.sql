-- migrations/2026-08-21_i1_cash_counts_append_only.ROLLBACK.sql
-- Reverses 2026-08-21_i1_cash_counts_append_only.sql.
--
-- DESTRUCTIVE: dropping cash_counts destroys every recorded physical count,
-- which is audit evidence and cannot be reconstructed from anything else in
-- the schema — no other table records what a human saw in the drawer. Run
-- this only against a database whose counts are known to be disposable (a
-- failed first apply, a test database), and preferably capture the rows first.
--
-- The forward migration creates nothing outside these three objects, so this
-- leaves no residue.

BEGIN;

DROP TRIGGER IF EXISTS cash_counts_append_only_trg ON public.cash_counts;
DROP TABLE IF EXISTS public.cash_counts;
DROP FUNCTION IF EXISTS public.cash_counts_append_only_v1();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='cash_counts') THEN
    RAISE EXCEPTION 'I-1 rollback failed: cash_counts still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='cash_counts_append_only_v1') THEN
    RAISE EXCEPTION 'I-1 rollback failed: the append-only trigger function still exists';
  END IF;
  -- The lifecycle must be exactly as untouched on the way out as on the way in.
  IF (SELECT status FROM public.service_sessions
       WHERE id='480eca89-33cd-43ba-ac7f-5ed0a0473639') IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'I-1 rollback failed: the preserved forensic service is no longer open';
  END IF;
END $$;

COMMIT;
