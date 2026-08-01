-- Guarded rollback for V3-H.1 Mesa lookup indexes. STAGING ONLY.
BEGIN;

DROP INDEX IF EXISTS public.payment_transactions_reversal_fk_idx;
DROP INDEX IF EXISTS public.restaurant_tables_created_by_fk_idx;
DROP INDEX IF EXISTS public.restaurant_tables_updated_by_fk_idx;
DROP INDEX IF EXISTS public.table_order_lines_service_fk_idx;
DROP INDEX IF EXISTS public.table_order_lines_workspace_fk_idx;
DROP INDEX IF EXISTS public.table_sessions_table_id_fk_idx;

COMMIT;
