-- ============================================================================
-- P0 CONTAINMENT — lock public/anon SELECT on sensitive tables
-- Target project ref: wnswassgfuuivmfwjxsf  (PRODUCTION)
-- Prepared: 2026-07-10.  DO NOT APPLY until the proxy-read frontend+backend are
-- deployed and verified (see deployment runbook). Applying this before the new
-- private read path is live will cause an application READ OUTAGE.
--
-- Idempotent. Drops ONLY the positively-identified permissive public SELECT
-- policies recorded from pg_policies on 2026-07-10:
--   storico        anon_read_storico        SELECT {public} USING(true)
--   ordenes        ordenes_public_read      SELECT {public} USING(true)
--   clientes       clientes_public_read     SELECT {public} USING(true)
--   conv           conv_public_read         SELECT {public} USING(true)
--   archivio_conv  anon_read_archivio       SELECT {public} USING(true)
--   wa_msgs        wa_msgs_public_read      SELECT {public} USING(true)
--   suggerimenti   suggerimenti_public_read SELECT {public} USING(true)
--   delivery_logs  (no public policy — RLS already default-deny; guarded no-op)
--
-- Preserves: service_role (bypasses RLS → backend keeps full read access) and
-- ALL write policies (these tables have NO INSERT/UPDATE/DELETE policies; writes
-- are already service_role-only). geo_cache / config are intentionally untouched.
-- ============================================================================

BEGIN;

-- Sanity guard: refuse to run against a database that is not La Dieci.
DO $$
BEGIN
  IF to_regclass('public.storico') IS NULL
     OR to_regclass('public.ordenes') IS NULL
     OR to_regclass('public.clientes') IS NULL
     OR to_regclass('public.archivio_conv') IS NULL THEN
    RAISE EXCEPTION 'Refusing to run: expected La Dieci tables not found (wrong database / project ref?)';
  END IF;
END $$;

-- Keep RLS enabled everywhere (idempotent; all already enabled 2026-07-10).
ALTER TABLE public.storico       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ordenes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conv          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archivio_conv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_msgs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suggerimenti  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_logs ENABLE ROW LEVEL SECURITY;

-- Drop the permissive public SELECT policies (exact names above).
DROP POLICY IF EXISTS anon_read_storico        ON public.storico;
DROP POLICY IF EXISTS ordenes_public_read       ON public.ordenes;
DROP POLICY IF EXISTS clientes_public_read      ON public.clientes;
DROP POLICY IF EXISTS conv_public_read          ON public.conv;
DROP POLICY IF EXISTS anon_read_archivio        ON public.archivio_conv;
DROP POLICY IF EXISTS wa_msgs_public_read       ON public.wa_msgs;
DROP POLICY IF EXISTS suggerimenti_public_read  ON public.suggerimenti;
-- delivery_logs: no public policy exists; guarded no-op for completeness.
DROP POLICY IF EXISTS delivery_logs_public_read ON public.delivery_logs;

COMMIT;

-- ── POST-CHECK (run separately, read-only). Expect ZERO rows: ────────────────
-- SELECT tablename, policyname FROM pg_policies
--  WHERE schemaname='public'
--    AND tablename IN ('storico','ordenes','clientes','conv','archivio_conv',
--                      'wa_msgs','suggerimenti','delivery_logs')
--    AND cmd='SELECT' AND roles='{public}';
