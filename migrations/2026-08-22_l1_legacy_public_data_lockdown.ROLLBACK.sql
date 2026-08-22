-- migrations/2026-08-22_l1_legacy_public_data_lockdown.ROLLBACK.sql
-- Restores the exact pre-L-1 state of all nine tables: the Supabase default
-- grant (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) back on
-- anon and authenticated for clientes/ordenes/storico/conv/wa_msgs/
-- archivio_conv/analisi_serata/suggerimenti/geo_cache, the original single
-- permissive policy back on each of the eight SELECT-policy tables, the
-- original FOR ALL policy back on geo_cache, and RLS un-forced (still
-- enabled, matching the pre-L-1 state exactly).
--
-- READ THIS BEFORE RUNNING IT. This does not restore a neutral state. It
-- re-opens: full anon/authenticated write+delete+truncate on clientes,
-- ordenes, storico, conv, wa_msgs, suggerimenti; a full anon/authenticated
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE re-grant plus a live SELECT policy on
-- archivio_conv and analisi_serata (both of which this migration proved have
-- zero real consumers on either side); and DELETE on geo_cache, which nothing
-- has ever used. TRUNCATE was empirically PROVEN to succeed as anon on eight
-- of these nine tables before L-1 -- this rollback restores that.
--
-- There is no legitimate consumer to restore any of the revoked capability
-- for -- verified exhaustively across both repos before L-1 was written. If
-- something appears broken after L-1, the correct response is to find out
-- which real feature was relying on undocumented direct-write access and fix
-- that feature, not to run this file.
--
-- No row of business data is touched in either direction.

BEGIN;

-- ── TIER 1 restore: archivio_conv, analisi_serata ───────────────────────────
ALTER TABLE public.archivio_conv NO FORCE ROW LEVEL SECURITY;
CREATE POLICY anon_read_archivio ON public.archivio_conv FOR SELECT TO public USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.archivio_conv TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.archivio_conv TO authenticated;

ALTER TABLE public.analisi_serata NO FORCE ROW LEVEL SECURITY;
CREATE POLICY analisi_serata_public_read ON public.analisi_serata FOR SELECT TO public USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.analisi_serata TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.analisi_serata TO authenticated;

-- ── TIER 2 restore: clientes, ordenes, storico, conv, wa_msgs, suggerimenti ─
ALTER TABLE public.clientes NO FORCE ROW LEVEL SECURITY;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.clientes TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.clientes TO authenticated;

ALTER TABLE public.ordenes NO FORCE ROW LEVEL SECURITY;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ordenes TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ordenes TO authenticated;

ALTER TABLE public.storico NO FORCE ROW LEVEL SECURITY;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.storico TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.storico TO authenticated;

ALTER TABLE public.conv NO FORCE ROW LEVEL SECURITY;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.conv TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.conv TO authenticated;

ALTER TABLE public.wa_msgs NO FORCE ROW LEVEL SECURITY;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.wa_msgs TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.wa_msgs TO authenticated;

ALTER TABLE public.suggerimenti NO FORCE ROW LEVEL SECURITY;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.suggerimenti TO anon;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.suggerimenti TO authenticated;

-- ── TIER 3 restore: geo_cache ────────────────────────────────────────────────
DROP POLICY IF EXISTS geo_cache_public_select ON public.geo_cache;
DROP POLICY IF EXISTS geo_cache_public_insert ON public.geo_cache;
DROP POLICY IF EXISTS geo_cache_public_update ON public.geo_cache;
CREATE POLICY public_write_geo_cache ON public.geo_cache FOR ALL TO public USING (true) WITH CHECK (true);
ALTER TABLE public.geo_cache NO FORCE ROW LEVEL SECURITY;
GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.geo_cache TO anon;
GRANT DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.geo_cache TO authenticated;

DO $$
BEGIN
  IF NOT (has_table_privilege('anon','public.clientes','INSERT')
          AND has_table_privilege('anon','public.archivio_conv','SELECT')
          AND has_table_privilege('anon','public.geo_cache','DELETE')) THEN
    RAISE EXCEPTION 'L-1 rollback post-condition failed: pre-L-1 grants were not fully restored';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.geo_cache'::regclass) <> 1 THEN
    RAISE EXCEPTION 'L-1 rollback post-condition failed: geo_cache must have exactly its original ALL policy';
  END IF;
  IF NOT (has_table_privilege('service_role','public.clientes','SELECT')
          AND has_table_privilege('service_role','public.geo_cache','UPDATE')) THEN
    RAISE EXCEPTION 'L-1 rollback post-condition failed: service_role lost a canonical-writer privilege';
  END IF;
END $$;

COMMIT;
