-- S4 — PROJECT MIGRATION AUTHORITY: public.ladieci_schema_migrations
-- Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S4
-- (§15 "Migration authority and verification semantics", CORRECTION E).
-- S0=PASS, S1=CERTIFIED, S2=APPLIED, S3=CERTIFIED/LIVE under that
-- specification.
--
-- GOAL: a migration authority that is semantically truthful from day one.
-- Recorded => applied. Verified => proven. Only verified rows gate
-- compatibility.
--
-- NAME COLLISION AVOIDED ON PURPOSE. `supabase_migrations.schema_migrations`
-- already exists (written by Supabase MCP apply_migration, confirmed live:
-- 67 rows as of this slice) and is queried by ~12 unrelated migration files.
-- A second `schema_migrations` in `public` would be a search_path accident
-- waiting to happen, so the ledger this project owns is named distinctly:
-- public.ladieci_schema_migrations. That Supabase-owned table is READ-ONLY
-- evidence to this project, inspected but never written -- see the paired
-- bootstrap-seed migration's header for exactly how it was used.
--
-- ONE MIGRATION TRANSACTION for the table + trigger + REVOKE + RLS, per
-- §15 ("table + trigger + REVOKE/RLS in one transaction; bootstrap seeding
-- in a second"). The historical bootstrap seed is a SEPARATE, paired
-- migration file (2026-08-15_s4_ladieci_schema_migrations_bootstrap_seed.sql)
-- so a seeding retry never has to re-run DDL, matching this table's own
-- "IDEMPOTENCY: seeding is INSERT ... ON CONFLICT (filename) DO NOTHING"
-- contract.
--
-- MUTABILITY -- exactly one lawful UPDATE: bootstrapped_unverified =>
-- verified, setting verified_at/verified_by/verification_method, with every
-- other column unchanged. Regression (verified => bootstrapped_unverified),
-- any other immutable-fact change, a checksum change, and DELETE all raise.
-- A changed migration file is a new migration with a new filename -- this
-- table never rewrites history, only appends to it. Enforced below by
-- ladieci_schema_migrations_immutability_v1(), a BEFORE UPDATE OR DELETE
-- trigger; the CHECK constraint alone cannot express the OLD-vs-NEW
-- comparison this requires.
--
-- ACCESS -- service_role only. REVOKE ALL FROM anon, authenticated; RLS
-- enabled with zero policies (RLS blocks every role except one that
-- bypasses it, which is exactly what service_role does in this project --
-- see src/utils/supabase.js / index.js's own SUPABASE_KEY comment).
--
-- ABSOLUTE OWNERSHIP BOUNDARY: this project never INSERTs, UPDATEs,
-- DELETEs, or otherwise mutates supabase_migrations.schema_migrations or
-- any other Supabase-owned migration-history table. That table is
-- inspected read-only where necessary and is never this project's
-- authority.

-- ── Predecessor guard: refuse if the ledger (or a same-named collision)
--    already exists, or if any S5+ object has landed early ─────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ladieci_schema_migrations'
  ) THEN
    RAISE EXCEPTION 'S4 refused: public.ladieci_schema_migrations already exists -- resolve drift first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'schema_migrations'
  ) THEN
    RAISE EXCEPTION 'S4 refused: public.schema_migrations already exists (S4''s own name-collision escalation clause) -- resolve drift first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname IN ('order_entities','table_ledger_adjustments','ledger_adjustment_operations')
  ) THEN
    RAISE EXCEPTION 'S4 refused: an S5+ table already exists -- S4 must not be applied out of order';
  END IF;
END $$;

-- ── The ledger ───────────────────────────────────────────────────────────
CREATE TABLE public.ladieci_schema_migrations (
  filename            text        PRIMARY KEY,
  checksum_sha256     text        NOT NULL,
  apply_order         integer     NOT NULL,
  kind                text        NOT NULL CHECK (kind IN ('ddl','data','repair','bootstrap')),
  verification_status text        NOT NULL CHECK (verification_status IN ('verified','bootstrapped_unverified')),
  applied_at          timestamptz NOT NULL DEFAULT now(),
  applied_by          text        NOT NULL,
  verified_at         timestamptz     NULL,
  verified_by         text            NULL,
  verification_method text            NULL,
  notes               text            NULL,
  CONSTRAINT ladieci_schema_migrations_verified_chk CHECK (
    (verification_status = 'verified'                AND verified_at IS NOT NULL AND verification_method IS NOT NULL)
    OR
    (verification_status = 'bootstrapped_unverified' AND verified_at IS NULL)
  ),
  CONSTRAINT ladieci_schema_migrations_apply_order_uq UNIQUE (apply_order),
  -- Matches this project's existing manifest checksum shape (sha256(file)
  -- truncated to 16 lowercase hex chars) -- "checksum shape/validation
  -- appropriate to the existing manifest format", not a new format.
  CONSTRAINT ladieci_schema_migrations_checksum_shape_chk CHECK (checksum_sha256 ~ '^[0-9a-f]{16}$')
);

REVOKE ALL ON public.ladieci_schema_migrations FROM anon, authenticated;
ALTER TABLE public.ladieci_schema_migrations ENABLE ROW LEVEL SECURITY;  -- no policies: service_role only

-- ── Immutability trigger ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ladieci_schema_migrations_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations is append-only: DELETE is forbidden (filename=%)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  -- TG_OP = 'UPDATE' from here. The only lawful UPDATE is the single
  -- promotion transition bootstrapped_unverified -> verified; every
  -- immutable fact must be byte-identical to OLD.
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

  -- OLD.verification_status = 'bootstrapped_unverified' here (the only
  -- other value the CHECK constraint permits).
  IF NEW.verification_status <> 'verified' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: % -- the only lawful UPDATE is bootstrapped_unverified -> verified', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ladieci_schema_migrations_immutable_v1
  BEFORE UPDATE OR DELETE ON public.ladieci_schema_migrations
  FOR EACH ROW EXECUTE FUNCTION public.ladieci_schema_migrations_immutability_v1();

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ladieci_schema_migrations'
  ) THEN
    RAISE EXCEPTION 'S4 post-condition failed: public.ladieci_schema_migrations was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'ladieci_schema_migrations' AND t.tgname = 'ladieci_schema_migrations_immutable_v1'
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'S4 post-condition failed: immutability trigger missing or disabled';
  END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE relname = 'ladieci_schema_migrations' AND relnamespace = 'public'::regnamespace) IS NOT TRUE THEN
    RAISE EXCEPTION 'S4 post-condition failed: RLS not enabled on ladieci_schema_migrations';
  END IF;
END $$;
