-- migrations/2026-08-22_m1_order_delete_financial_evidence_guard.ROLLBACK.sql
-- Reverts M-1 by restoring delete_order_if_not_active's original S2-1G body
-- (migrations/2026-07-20_rider_trip_rpcs.sql) byte-identical: the active-trip
-- guard only, no financial-evidence check.
--
-- READ THIS BEFORE RUNNING IT. Rolling back does not merely remove a check --
-- it restores the ability to physically DELETE an order that carries real,
-- persistent financial evidence (order_financial_events, payment_allocations,
-- table_order_lines, service_incidents), orphaning those rows with nothing
-- left to join them back to. No table, column, trigger, grant or index is
-- touched in either direction; this file changes ONE function body only.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_order_if_not_active(p_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds      jsonb;
  v_active  jsonb;
  v_deleted int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  DELETE FROM public.ordenes WHERE id = p_order_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_order_if_not_active(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_order_if_not_active(text) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_order_if_not_active';
  IF v_src IS NULL OR position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) = 0 THEN
    RAISE EXCEPTION 'M-1 rollback post-condition failed: the S2-1G active-trip guard was not restored';
  END IF;
  IF position('ORDER_HAS_FINANCIAL_EVIDENCE' in v_src) <> 0 THEN
    RAISE EXCEPTION 'M-1 rollback post-condition failed: the financial-evidence guard is still present';
  END IF;
END $$;

COMMIT;
