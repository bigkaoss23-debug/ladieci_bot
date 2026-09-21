-- migrations/2026-09-21_fdv1_delivery_deadline_at.sql
-- Paired rollback: 2026-09-21_fdv1_delivery_deadline_at.ROLLBACK.sql
--
-- FDV1 P1 — canonical DOMICILIO deadline (delivered-by), persisted once at creation by the backend:
--   delivery_deadline_at = ordenes.ts (server creation stamp) + 55 min. Never rewritten (giro, ±, kitchen, rider).
-- ADDITIVE ONLY: one nullable column, no default, no backfill (legacy rows stay NULL and are read fail-safe
-- from hora + ts), no constraint, no trigger, no index. Economy / payment / fiscal tables untouched.
-- storico: buildStoricoPayload is a whitelist -> the new column never reaches closing.
BEGIN;
ALTER TABLE public.ordenes ADD COLUMN IF NOT EXISTS delivery_deadline_at timestamptz NULL;
COMMENT ON COLUMN public.ordenes.delivery_deadline_at IS 'FDV1: DOMICILIO delivered-by deadline = ts + 55 min, set once by the backend at creation; immutable.';
NOTIFY pgrst, 'reload schema';
COMMIT;
