-- ============================================================================
-- ROLLBACK for 2026-07-10_p0_lock_sensitive_reads.sql
-- Target project ref: wnswassgfuuivmfwjxsf (PRODUCTION)
--
-- Re-creates the EXACT permissive public SELECT policies that were dropped,
-- restoring the pre-migration read behavior. Use ONLY if the migrated frontend
-- cannot read required data after lockdown and you need to restore service fast.
-- (delivery_logs had no public policy pre-migration → nothing to restore.)
-- Idempotent: DROP IF EXISTS before CREATE so re-runs don't error on duplicates.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS anon_read_storico ON public.storico;
CREATE POLICY anon_read_storico ON public.storico
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS ordenes_public_read ON public.ordenes;
CREATE POLICY ordenes_public_read ON public.ordenes
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS clientes_public_read ON public.clientes;
CREATE POLICY clientes_public_read ON public.clientes
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS conv_public_read ON public.conv;
CREATE POLICY conv_public_read ON public.conv
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS anon_read_archivio ON public.archivio_conv;
CREATE POLICY anon_read_archivio ON public.archivio_conv
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS wa_msgs_public_read ON public.wa_msgs;
CREATE POLICY wa_msgs_public_read ON public.wa_msgs
  FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS suggerimenti_public_read ON public.suggerimenti;
CREATE POLICY suggerimenti_public_read ON public.suggerimenti
  FOR SELECT TO public USING (true);

COMMIT;
