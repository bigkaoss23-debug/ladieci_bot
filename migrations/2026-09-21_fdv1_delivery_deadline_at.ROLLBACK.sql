-- migrations/2026-09-21_fdv1_delivery_deadline_at.ROLLBACK.sql
-- ORDER: roll back the backend FIRST (1d581d8 does not read the column), then run this file.
-- Drops only the FDV1 deadline column (loses the deadlines of the orders currently in ordenes; storico never had it).
BEGIN;
ALTER TABLE public.ordenes DROP COLUMN IF EXISTS delivery_deadline_at;
NOTIFY pgrst, 'reload schema';
COMMIT;
