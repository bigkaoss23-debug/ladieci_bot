-- ROLLBACK for 2026-08-15_s4_ladieci_schema_migrations_ledger.sql
--
-- Drops the trigger, its function, and the table -- in that order. DROP
-- TABLE cascades away every row the paired bootstrap-seed migration
-- inserted, which is the ONLY way to remove rows from this table: the
-- immutability trigger forbids DELETE unconditionally, by design, with no
-- bypass anywhere in S4 (S4 is not S8 -- there is no sanctioned trigger
-- suspension here). Rolling back the seed in isolation while keeping the
-- schema is therefore not possible under the append-only contract; this
-- single rollback covers both paired forward migrations. See
-- 2026-08-15_s4_ladieci_schema_migrations_bootstrap_seed.ROLLBACK.sql for
-- the seed migration's own (documentation-only) rollback note.
--
-- Refuses if any row has been promoted past bootstrap (verification_status
-- = 'verified' with a verification_method other than the S4 bootstrap
-- seed's own) -- i.e. if a human has already recorded real post-S4
-- verification work on top of this ledger, dropping it would destroy that
-- work, not just the bootstrap.

DO $$
DECLARE
  v_non_bootstrap_verified integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ladieci_schema_migrations'
  ) THEN
    SELECT count(*) INTO v_non_bootstrap_verified
      FROM public.ladieci_schema_migrations
     WHERE verification_status = 'verified'
       AND verification_method <> 'manifest filename slug matched against supabase_migrations.schema_migrations.name';
    IF v_non_bootstrap_verified > 0 THEN
      RAISE EXCEPTION 'S4 rollback refused: % row(s) carry real post-bootstrap verification work -- resolve manually before dropping the ledger', v_non_bootstrap_verified;
    END IF;
  END IF;
END $$;

DROP TRIGGER IF EXISTS ladieci_schema_migrations_immutable_v1 ON public.ladieci_schema_migrations;
DROP FUNCTION IF EXISTS public.ladieci_schema_migrations_immutability_v1();
DROP TABLE IF EXISTS public.ladieci_schema_migrations;
