-- 2026-07-20_manual_giros_rls_lockdown.sql
-- S2-1B: close the public.manual_giros exposure. Currently RLS is DISABLED and anon +
-- authenticated hold full SELECT/INSERT/UPDATE/DELETE grants (directly exploitable via
-- the public anon key). This enables RLS with ZERO public policies and revokes the DML
-- grants. service_role has BYPASSRLS + retains grants -> backend operation preserved.
-- The published frontend does NOT read manual_giros directly (only via the backend proxy).
--
-- No public policy is added. NOT APPLIED IN S2-1B.

BEGIN;

ALTER TABLE public.manual_giros ENABLE ROW LEVEL SECURITY;

-- Defense-in-depth: remove browser DML grants (RLS with zero policies already denies,
-- this makes the intent explicit and belt-and-suspenders).
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.manual_giros FROM anon;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.manual_giros FROM authenticated;

-- No CREATE POLICY statements: manual_giros is backend-only (service_role).

COMMIT;
