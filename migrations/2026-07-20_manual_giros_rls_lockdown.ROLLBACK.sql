-- 2026-07-20_manual_giros_rls_lockdown.ROLLBACK.sql
-- Restores the prior (pre-lockdown) staging access shape: RLS disabled and anon +
-- authenticated DML grants. MUST NOT be executed during S2-1B.

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_giros TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.manual_giros TO authenticated;

ALTER TABLE public.manual_giros DISABLE ROW LEVEL SECURITY;

COMMIT;
