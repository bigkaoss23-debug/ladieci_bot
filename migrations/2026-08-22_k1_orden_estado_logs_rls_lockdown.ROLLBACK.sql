-- migrations/2026-08-22_k1_orden_estado_logs_rls_lockdown.ROLLBACK.sql
-- Restores the exact pre-K-1 state of public.orden_estado_logs: RLS off, and
-- the Supabase default grant (arwdDxtm) back on anon and authenticated.
--
-- READ THIS BEFORE RUNNING IT. This rollback does not restore a neutral state.
-- It re-opens an unauthenticated, internet-reachable write path into an audit
-- log: the staging publishable key is compiled into the browser bundle, so
-- after running this anyone who reads that key out of the page can INSERT,
-- UPDATE, DELETE or TRUNCATE order state history -- including the deleted-order
-- traces that exist nowhere else. Supabase's linter will report the table at
-- ERROR / EXTERNAL again, and it will once more be the only table in the schema
-- with row level security disabled.
--
-- There is no legitimate consumer to restore it for. Verified before K-1: the
-- backend writes as service_role (unaffected by K-1), mesa_close_session_v1
-- runs as service_role, and neither the frontend nor the Netlify functions name
-- this table at all. If something appears to need anon access after K-1, the
-- correct response is to find out what is talking to PostgREST directly, not to
-- run this file.
--
-- No row is touched in either direction.

BEGIN;

ALTER TABLE public.orden_estado_logs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.orden_estado_logs DISABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.orden_estado_logs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.orden_estado_logs TO authenticated;

DO $$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='orden_estado_logs') THEN
    RAISE EXCEPTION 'K-1 rollback post-condition failed: row level security is still enabled';
  END IF;
  IF NOT (has_table_privilege('anon','public.orden_estado_logs','INSERT')
          AND has_table_privilege('authenticated','public.orden_estado_logs','INSERT')) THEN
    RAISE EXCEPTION 'K-1 rollback post-condition failed: the pre-K-1 grants were not restored';
  END IF;
  -- The canonical writer must survive the rollback too.
  IF NOT (has_table_privilege('service_role','public.orden_estado_logs','INSERT')
          AND has_table_privilege('service_role','public.orden_estado_logs','SELECT')) THEN
    RAISE EXCEPTION 'K-1 rollback post-condition failed: service_role lost the canonical writer privileges';
  END IF;
END $$;

COMMIT;
