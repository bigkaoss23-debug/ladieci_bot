-- Access Control V3 -- V3-H.1: Mesa foreign-key lookup indexes.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive performance follow-up to the already-applied V3-H Mesa foundation.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE name = 'v3h_messa_billing_foundation'
  ) OR to_regclass('public.restaurant_tables') IS NULL
     OR to_regclass('public.table_order_lines') IS NULL
     OR to_regclass('public.payment_transactions') IS NULL
  THEN
    RAISE EXCEPTION 'V3-H.1 refused: exact V3-H predecessor not found';
  END IF;
END $$;

CREATE INDEX payment_transactions_reversal_fk_idx
  ON public.payment_transactions(reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;

CREATE INDEX restaurant_tables_created_by_fk_idx
  ON public.restaurant_tables(workspace_id, created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX restaurant_tables_updated_by_fk_idx
  ON public.restaurant_tables(workspace_id, updated_by)
  WHERE updated_by IS NOT NULL;

CREATE INDEX table_order_lines_service_fk_idx
  ON public.table_order_lines(service_session_id);

CREATE INDEX table_order_lines_workspace_fk_idx
  ON public.table_order_lines(workspace_id);

CREATE INDEX table_sessions_table_id_fk_idx
  ON public.table_sessions(table_id);

COMMIT;
