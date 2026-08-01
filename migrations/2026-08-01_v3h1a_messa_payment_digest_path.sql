-- Access Control V3 -- V3-H.1A: make the Mesa payment digest resolvable.
-- TARGET: staging Mesa billing foundation already applied.
--
-- Supabase installs pgcrypto in the `extensions` schema. The V3-H payment RPC
-- intentionally pins its search_path, but the original path omitted that schema;
-- consequently the final ledger digest failed and PostgreSQL rolled the whole
-- payment back. This additive repair changes no rows and no function body.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE name = 'v3h_messa_billing_foundation'
  ) OR to_regprocedure(
    'public.messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb)'
  ) IS NULL THEN
    RAISE EXCEPTION 'V3-H.1A refused: exact Mesa billing predecessor not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pgcrypto' AND n.nspname = 'extensions'
  ) THEN
    RAISE EXCEPTION 'V3-H.1A refused: pgcrypto is not installed in extensions';
  END IF;
END $$;

ALTER FUNCTION public.messa_post_payment_v1(
  uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb
) SET search_path = public, extensions, pg_temp;

COMMIT;
