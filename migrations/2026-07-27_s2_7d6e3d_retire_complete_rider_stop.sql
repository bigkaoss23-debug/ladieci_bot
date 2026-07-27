-- migrations/2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql
-- S2-7D6E3 FASE D — retire the ledger-less rider RPC. CLEANUP, NOT ADDITIVE.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- DRAFT — NOT APPLIED.
--
-- APPLY THIS ONLY AFTER:
--   FASE A (2026-07-27_s2_7d6e3a_rider_ledger_writer_additive.sql) is applied, AND
--   FASE B (the backend commit repointing riderTrip.completeStop to
--           rider_collect_and_complete_stop) is deployed, AND
--   FASE C (a live smoke test of the rider door-collection flow) has passed.
--
-- Until all three have happened, `complete_rider_stop(text, boolean, text)` must stay in
-- place — it is the only path a not-yet-repointed backend can use to complete a rider
-- stop. Applying this file first would 404/500 every rider "marcarEntregado" call on
-- whatever backend is currently deployed.
--
-- DROP (not CREATE OR REPLACE) so no caller can ever again reach the old
-- `cobrado = COALESCE(p_cobrado, true)` write — the defect S2-7D6E3 exists to eliminate.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D6E3D refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor: FASE A must already have shipped the rider ledger contract this
-- retirement assumes is now the only path in use.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'rider_collect_and_complete_stop')
  THEN RAISE EXCEPTION 'S2-7D6E3D refused: rider_collect_and_complete_stop absent — apply FASE A and deploy FASE B first.'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.complete_rider_stop(text, boolean, text);

COMMIT;
