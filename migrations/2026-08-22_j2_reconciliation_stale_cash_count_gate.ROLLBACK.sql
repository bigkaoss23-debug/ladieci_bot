-- migrations/2026-08-22_j2_reconciliation_stale_cash_count_gate.ROLLBACK.sql
-- Reverts J-2 by restoring ledger 99's writer body verbatim: the window gate,
-- the lineage gate and the counted-cash gate, WITHOUT the staleness gate.
--
-- READ THIS BEFORE RUNNING IT. Rolling back does not merely remove a check --
-- it re-enables writing a variance computed from a cash count that no longer
-- describes the economy being closed, into a table that is append-only. A row
-- written after this rollback claiming "counted 65.00, recorded 116.00,
-- variance -51.00" cannot afterwards be corrected, only annotated by a newer
-- row. The J-2 backend refuses to send such a count on its own, so this
-- rollback is only meaningful alongside a backend rolled back past J-2.
--
-- No table, column, trigger, grant or index is touched in either direction.

BEGIN;

CREATE OR REPLACE FUNCTION public.create_service_closeout_reconciliation_v1(
  p_service_session_id      uuid,
  p_closeout_correlation_id uuid,
  p_window_from             timestamptz,
  p_window_to               timestamptz,
  p_window_timezone         text,
  p_window_preset           text,
  p_business_date           date,
  p_gross_cents             integer,
  p_collected_cents         integer,
  p_unpaid_cents            integer,
  p_voided_cents            integer,
  p_refunded_cents          integer,
  p_cash_receipts_cents     integer,
  p_card_receipts_cents     integer,
  p_bizum_receipts_cents    integer,
  p_other_receipts_cents    integer,
  p_order_count             integer,
  p_service_count           integer,
  p_actor                   text,
  p_cash_count_id           uuid    DEFAULT NULL,
  p_counted_cash_cents      integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row      public.service_closeout_reconciliations;
  v_variance integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_CLOSEOUT_NOT_FOUND');
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_reconciliations
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'created', false, 'reconciliation', to_jsonb(v_row));
  END IF;

  IF p_cash_count_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_counts c
       WHERE c.id = p_cash_count_id
         AND c.window_from = p_window_from
         AND c.window_to = p_window_to
         AND c.window_timezone = p_window_timezone
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH');
    END IF;
    IF p_counted_cash_cents IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_COUNTED_CASH_REQUIRED');
    END IF;
    v_variance := p_counted_cash_cents - p_cash_receipts_cents;
  ELSE
    v_variance := NULL;
  END IF;

  INSERT INTO public.service_closeout_reconciliations (
    service_session_id, closeout_correlation_id,
    window_from, window_to, window_timezone, window_preset, business_date,
    gross_cents, collected_cents, unpaid_cents, voided_cents, refunded_cents,
    cash_receipts_cents, card_receipts_cents, bizum_receipts_cents, other_receipts_cents,
    order_count, service_count,
    cash_count_id, counted_cash_cents, variance_cents, actor
  ) VALUES (
    p_service_session_id, p_closeout_correlation_id,
    p_window_from, p_window_to, p_window_timezone, p_window_preset, p_business_date,
    p_gross_cents, p_collected_cents, p_unpaid_cents, p_voided_cents, p_refunded_cents,
    p_cash_receipts_cents, p_card_receipts_cents, p_bizum_receipts_cents, p_other_receipts_cents,
    p_order_count, p_service_count,
    p_cash_count_id, CASE WHEN p_cash_count_id IS NULL THEN NULL ELSE p_counted_cash_cents END, v_variance, p_actor
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'created', true, 'reconciliation', to_jsonb(v_row));
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_service_closeout_reconciliation_v1(
  uuid, uuid, timestamptz, timestamptz, text, text, date,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_closeout_reconciliation_v1(
  uuid, uuid, timestamptz, timestamptz, text, text, date,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, integer) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_service_closeout_reconciliation_v1';
  IF v_src IS NULL OR position('RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH' in v_src) = 0 THEN
    RAISE EXCEPTION 'J-2 rollback post-condition failed: the ledger-99 writer was not restored';
  END IF;
  IF position('RECONCILIATION_CASH_COUNT_STALE' in v_src) <> 0 THEN
    RAISE EXCEPTION 'J-2 rollback post-condition failed: the staleness gate is still present';
  END IF;
END $$;

COMMIT;
