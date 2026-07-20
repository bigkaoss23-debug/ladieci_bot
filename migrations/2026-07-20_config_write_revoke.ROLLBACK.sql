-- 2026-07-20_config_write_revoke.ROLLBACK.sql
-- Restores the prior staging access shape for public.config (anon/authenticated write
-- grants). MUST NOT be executed during S2-1B. The read policy was never changed.

BEGIN;

GRANT INSERT, UPDATE, DELETE ON public.config TO anon;
GRANT INSERT, UPDATE, DELETE ON public.config TO authenticated;

COMMIT;
