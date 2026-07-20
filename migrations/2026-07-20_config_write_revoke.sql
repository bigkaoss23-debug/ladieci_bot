-- 2026-07-20_config_write_revoke.sql
-- S2-1B defense-in-depth: revoke browser write access to public.config while KEEPING
-- the existing public read policy (staging FE reads REPARTIDORES / AI flags / DRIVER_STATO
-- directly via the anon key). Writes are already blocked by RLS (only a SELECT policy
-- exists), but the anon/authenticated table GRANTs remain — this removes them explicitly.
-- The read policy `public_read_non_sensitive` is left UNTOUCHED. Backend uses service_role.
--
-- NOT APPLIED IN S2-1B. Review + apply happens in the controlled SQL phase.

BEGIN;

-- Keep RLS enabled and the existing public read policy intact. Only remove write grants.
REVOKE INSERT, UPDATE, DELETE ON public.config FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.config FROM authenticated;

-- service_role retains full access (backend operation), unchanged.

COMMIT;
