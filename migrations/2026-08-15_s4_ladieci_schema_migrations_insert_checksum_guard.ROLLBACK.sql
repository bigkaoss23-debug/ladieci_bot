-- ROLLBACK for 2026-08-15_s4_ladieci_schema_migrations_insert_checksum_guard.sql
--
-- Restores the trigger to BEFORE UPDATE OR DELETE only (drops the INSERT
-- guard), and restores the function body to its pre-follow-up form
-- (verbatim, from 2026-08-15_s4_ladieci_schema_migrations_ledger.sql).
-- Refuses if the guard was never applied (nothing to roll back) or if any
-- row has already exercised the INSERT-time check in a way this rollback
-- cannot safely undo -- in practice the guard only ever raises or no-ops,
-- never writes, so there is nothing to reconcile beyond the trigger/function
-- definitions themselves.

DO $$
DECLARE
  v_body text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ladieci_schema_migrations'
  ) THEN
    RAISE EXCEPTION 'S4 follow-up rollback refused: public.ladieci_schema_migrations does not exist';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ladieci_schema_migrations_immutability_v1';
  IF v_body IS NULL OR v_body NOT LIKE '%already recorded with a DIFFERENT checksum%' THEN
    RAISE EXCEPTION 'S4 follow-up rollback refused: the INSERT guard is not currently present -- nothing to roll back';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.ladieci_schema_migrations_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations is append-only: DELETE is forbidden (filename=%)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  IF OLD.filename           IS DISTINCT FROM NEW.filename
     OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
     OR OLD.apply_order     IS DISTINCT FROM NEW.apply_order
     OR OLD.kind            IS DISTINCT FROM NEW.kind
     OR OLD.applied_at      IS DISTINCT FROM NEW.applied_at
     OR OLD.applied_by      IS DISTINCT FROM NEW.applied_by
  THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: immutable fact changed on % (filename/checksum_sha256/apply_order/kind/applied_at/applied_by can never change)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  IF OLD.verification_status = 'verified' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: % is already verified -- no further UPDATE is lawful (regression forbidden)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  IF NEW.verification_status <> 'verified' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: % -- the only lawful UPDATE is bootstrapped_unverified -> verified', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ladieci_schema_migrations_immutable_v1 ON public.ladieci_schema_migrations;
CREATE TRIGGER ladieci_schema_migrations_immutable_v1
  BEFORE UPDATE OR DELETE ON public.ladieci_schema_migrations
  FOR EACH ROW EXECUTE FUNCTION public.ladieci_schema_migrations_immutability_v1();
