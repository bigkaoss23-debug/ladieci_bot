-- migrations/2026-09-09_service_closeout_net_sales_legacy_contract_hardening_v1_migration_125.ROLLBACK.sql
-- Reverses 2026-09-09_service_closeout_net_sales_legacy_contract_hardening_v1_migration_125.sql
-- exactly, and ONLY that.
--
-- Before migration 125 the column public.service_closeouts.net_sales_cents had
-- NO comment (col_description() was NULL -- proven in
-- SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md). This rollback
-- restores exactly that state:
--
--   COMMENT ON COLUMN public.service_closeouts.net_sales_cents IS NULL;
--
-- ROLLBACK_RESTORES_UNDOCUMENTED_LEGACY_COLUMN. Running this file removes the
-- schema-visible contract that migration 125 added; the column, its data, its
-- formula, its type, its nullability and its writers are all unchanged (M125
-- never touched them). This is exact reversibility of migration history, not a
-- recommendation -- an undocumented net_sales_cents is precisely the state the
-- audit exists to close.
--
-- Uses COMMENT ON COLUMN only -- symmetric to the forward migration. No
-- ALTER TABLE, no column/constraint/index/trigger/function change, no DML in
-- either direction.

BEGIN;

-- ── PRE-CONDITION: refuse unless the current state is exactly what M125
-- forward installed -- never revert an unknown or already-reverted state.
DO $guard$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'service_closeouts'
       AND column_name = 'net_sales_cents'
  ) THEN
    RAISE EXCEPTION 'M125 ROLLBACK refused: public.service_closeouts.net_sales_cents missing -- resolve drift first';
  END IF;

  SELECT col_description('public.service_closeouts'::regclass, ordinal_position::int)
    INTO v_def
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='service_closeouts'
     AND column_name='net_sales_cents';

  -- Must currently be the exact M125-forward contract text -- refuses a
  -- double-rollback or reverting a comment this migration never installed.
  IF v_def IS DISTINCT FROM $c$LEGACY / HISTORICAL compatibility field. Formula unchanged since migration 57 (2026-08-09): net_sales_cents = max(0, gross_sales_cents - total_refunds_cents), where gross_sales_cents is the ORIGINAL ORDER GROSS (sum of raw ordenes.totale for non-cancelled orders, before any commercial adjustment). Commercial adjustments (order_obligations revisions) are NOT reflected here. This column is NOT the current obligation (use current_obligation_cents), NOT the net collected (use paid_amount_cents), NOT a canonical accounting authority, NOT a taxable base, NOT a fiscal or invoice total. Retained ONLY for historical semantic compatibility of pre-existing rows. New consumers MUST NOT read this column: use the canonical fields gross_sales_cents / current_obligation_cents / paid_amount_cents / total_refunds_cents / unpaid_exposure_cents / over_collected_cents. Ref: SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md.$c$
  THEN
    RAISE EXCEPTION 'M125 ROLLBACK refused: net_sales_cents comment is not the expected M125 contract text (found: %) -- not at the expected M125 epoch, or already rolled back?', v_def;
  END IF;

  -- Ledger baseline is 125 -- checked only if the ledger table exists.
  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 125) THEN
      RAISE EXCEPTION 'M125 ROLLBACK refused: ladieci_schema_migrations has no apply_order=125 row -- forward migration was never registered as applied';
    END IF;
  END IF;

  PERFORM set_config('ladieci.m125rb_sc_col_count',
    (SELECT count(*)::text FROM information_schema.columns
      WHERE table_schema='public' AND table_name='service_closeouts'), false);
  PERFORM set_config('ladieci.m125rb_sc_row_count',
    (SELECT count(*)::text FROM public.service_closeouts), false);
END $guard$;

-- ── THE REVERSAL — restore the exact pre-M125 state: no comment. ─────────────
COMMENT ON COLUMN public.service_closeouts.net_sales_cents IS NULL;

-- ── POST-CONDITION ─────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def text;
BEGIN
  SELECT col_description('public.service_closeouts'::regclass, ordinal_position::int)
    INTO v_def
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='service_closeouts'
     AND column_name='net_sales_cents';

  IF v_def IS NOT NULL THEN
    RAISE EXCEPTION 'M125 ROLLBACK post-condition failed: net_sales_cents still carries a comment (found: %)', v_def;
  END IF;

  -- The other two commented columns (current_obligation_cents /
  -- over_collected_cents, migration 121) are untouched -- exactly 2 commented
  -- columns remain on service_closeouts.
  IF (SELECT count(*) FROM information_schema.columns c
       WHERE c.table_schema='public' AND c.table_name='service_closeouts'
         AND col_description('public.service_closeouts'::regclass, c.ordinal_position::int) IS NOT NULL)
     <> 2
  THEN
    RAISE EXCEPTION 'M125 ROLLBACK post-condition failed: expected exactly 2 commented columns on service_closeouts after reverting (current_obligation_cents + over_collected_cents)';
  END IF;

  IF (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='service_closeouts')
     IS DISTINCT FROM current_setting('ladieci.m125rb_sc_col_count', true)
  THEN RAISE EXCEPTION 'M125 ROLLBACK post-condition failed: service_closeouts column count changed'; END IF;

  IF (SELECT count(*)::text FROM public.service_closeouts) IS DISTINCT FROM current_setting('ladieci.m125rb_sc_row_count', true)
  THEN RAISE EXCEPTION 'M125 ROLLBACK post-condition failed: service_closeouts row count changed -- this rollback must write no data'; END IF;
END $post$;

COMMIT;
