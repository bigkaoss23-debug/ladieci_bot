-- migrations/2026-08-17_s_c_economic_period_stamping.ROLLBACK.sql
-- Paired rollback for 2026-08-17_s_c_economic_period_stamping.sql.
--
-- Refuses if ANY row anywhere has actually been stamped by the new triggers
-- (a non-NULL value on any of the four new columns) -- once real evidence
-- exists on an append-only table, deleting the COLUMN that carries it is
-- equivalent to deleting the evidence itself, which S-C's own containment
-- discipline (matching S-A/S-B before it) forbids. A same-day rollback with
-- zero writes since apply is always safe; a rollback after any real order/
-- payment/financial-event activity is not, and must refuse.
BEGIN;

DO $$
DECLARE v_stamped bigint;
BEGIN
  SELECT
      (SELECT count(*) FROM public.table_order_lines WHERE economic_period_kind IS NOT NULL)
    + (SELECT count(*) FROM public.payment_transactions WHERE economic_period_kind IS NOT NULL)
    + (SELECT count(*) FROM public.order_financial_events
         WHERE obligation_economic_period_kind IS NOT NULL OR event_economic_period_kind IS NOT NULL)
  INTO v_stamped;

  IF v_stamped > 0 THEN
    RAISE EXCEPTION 'S-C rollback refused: % row(s) already carry a real economic_period_kind stamp -- deleting these append-only columns would destroy evidence', v_stamped;
  END IF;
END $$;

-- order_financial_events: restore the exact pre-S-C trigger body (byte-
-- identical to the function as it existed immediately before this
-- migration), then drop the two new columns/constraints.
CREATE OR REPLACE FUNCTION public.service_session_assign_financial_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session_id     uuid;
  v_table_session  uuid;
  v_candidates     uuid[];
BEGIN
  SELECT o.service_session_id INTO v_session_id
    FROM public.ordenes o WHERE o.id = NEW.order_id;

  IF v_session_id IS NULL AND NEW.payment_transaction_id IS NOT NULL THEN
    SELECT pt.table_session_id INTO v_table_session
      FROM public.payment_transactions pt WHERE pt.id = NEW.payment_transaction_id;

    SELECT array_agg(DISTINCT l.service_session_id) INTO v_candidates
      FROM public.payment_allocations pa
      JOIN public.table_order_lines   l ON l.id = pa.table_order_line_id
     WHERE pa.payment_transaction_id = NEW.payment_transaction_id
       AND l.table_session_id        = v_table_session
       AND l.order_id                = NEW.order_id;

    IF v_candidates IS NOT NULL AND cardinality(v_candidates) > 1 THEN
      RAISE EXCEPTION 'ORDER_OBLIGATION_AMBIGUOUS' USING ERRCODE='P0001',
        DETAIL = format('order=%s table_session=%s candidates=%s',
                        NEW.order_id, v_table_session, v_candidates);
    END IF;
    IF v_candidates IS NOT NULL AND cardinality(v_candidates) = 1 THEN
      v_session_id := v_candidates[1];
    END IF;
  END IF;

  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;

  NEW.service_session_id := v_session_id;
  RETURN NEW;
END $function$;

ALTER TABLE public.order_financial_events DROP CONSTRAINT IF EXISTS order_financial_events_obligation_econ_period_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT IF EXISTS order_financial_events_event_econ_period_chk;
ALTER TABLE public.order_financial_events DROP COLUMN IF EXISTS obligation_economic_period_kind;
ALTER TABLE public.order_financial_events DROP COLUMN IF EXISTS event_economic_period_kind;

DROP TRIGGER IF EXISTS payment_transactions_stamp_economic_period_v1 ON public.payment_transactions;
DROP FUNCTION IF EXISTS public.payment_transactions_stamp_economic_period_v1();
ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_economic_period_kind_chk;
ALTER TABLE public.payment_transactions DROP COLUMN IF EXISTS economic_period_kind;

DROP TRIGGER IF EXISTS table_order_lines_stamp_economic_period_v1 ON public.table_order_lines;
DROP FUNCTION IF EXISTS public.table_order_lines_stamp_economic_period_v1();
ALTER TABLE public.table_order_lines DROP CONSTRAINT IF EXISTS table_order_lines_economic_period_kind_chk;
ALTER TABLE public.table_order_lines DROP COLUMN IF EXISTS economic_period_kind;

DROP FUNCTION IF EXISTS public.classify_economic_period_v1(timestamptz);

-- Post-conditions.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='classify_economic_period_v1'
  ) THEN RAISE EXCEPTION 'S-C rollback post-condition failed: classify_economic_period_v1 still exists'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='table_order_lines' AND column_name='economic_period_kind'
  ) THEN RAISE EXCEPTION 'S-C rollback post-condition failed: table_order_lines.economic_period_kind still exists'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_transactions' AND column_name='economic_period_kind'
  ) THEN RAISE EXCEPTION 'S-C rollback post-condition failed: payment_transactions.economic_period_kind still exists'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_financial_events' AND column_name IN ('obligation_economic_period_kind','event_economic_period_kind')
  ) THEN RAISE EXCEPTION 'S-C rollback post-condition failed: order_financial_events stamp column(s) still exist'; END IF;

  IF (SELECT current_session_id FROM public.service_session_state) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-C rollback post-condition failed: legacy shadow changed unexpectedly'; END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-C rollback post-condition failed: canonical pointer changed unexpectedly'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-C rollback post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.period_consolidations) <> 5 THEN
    RAISE EXCEPTION 'S-C rollback post-condition failed: period_consolidations population changed -- must be exactly 5';
  END IF;
END $$;

COMMIT;
