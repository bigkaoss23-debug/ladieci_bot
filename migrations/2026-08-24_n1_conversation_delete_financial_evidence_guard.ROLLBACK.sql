-- migrations/2026-08-24_n1_conversation_delete_financial_evidence_guard.ROLLBACK.sql
-- Reverts N-1 by restoring delete_conversation_if_not_active's original
-- S2-1H body (migrations/2026-07-20_rider_trip_rpcs.sql) byte-identical:
-- the active-trip guard only, no wa_id-validity check, no financial-evidence
-- check.
--
-- READ THIS BEFORE RUNNING IT. Rolling back does not merely remove two
-- checks -- it restores the ability to (a) target the shared '' (or any
-- blank/whitespace) wa_id bucket, and (b) physically bulk-DELETE every order
-- under a wa_id even when one or more of them carries real, persistent
-- financial evidence (order_financial_events, payment_allocations,
-- table_order_lines, service_incidents) or legacy paid flags (ya_pagado,
-- cobrado), orphaning that evidence with nothing left to join it back to.
-- No table, column, trigger, grant or index is touched in either direction;
-- this file changes ONE function body only.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_conversation_if_not_active(p_wa_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds          jsonb;
  v_active      jsonb;
  v_order_ids   text[];
  v_conv_del    int;
  v_msgs_del    int;
  v_orders_del  int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  SELECT COALESCE(array_agg(id), ARRAY[]::text[]) INTO v_order_ids
  FROM public.ordenes
  WHERE wa_id = p_wa_id;

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND EXISTS (
       SELECT 1
       FROM unnest(v_order_ids) AS oid(order_id)
       WHERE v_active->'order_ids' ? oid.order_id
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  DELETE FROM public.conv WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_conv_del = ROW_COUNT;
  DELETE FROM public.wa_msgs WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_msgs_del = ROW_COUNT;
  DELETE FROM public.ordenes WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_orders_del = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'code', 'OK',
    'deleted', jsonb_build_object('conv', v_conv_del, 'wa_msgs', v_msgs_del, 'ordenes', v_orders_del));
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation_if_not_active(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_conversation_if_not_active(text) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_conversation_if_not_active';
  IF v_src IS NULL OR position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 rollback post-condition failed: the S2-1H active-trip guard was not restored';
  END IF;
  IF position('INVALID_WA_ID' in v_src) <> 0 THEN
    RAISE EXCEPTION 'N-1 rollback post-condition failed: the wa_id-validity guard is still present';
  END IF;
  IF position('CONVERSATION_HAS_FINANCIAL_EVIDENCE' in v_src) <> 0 THEN
    RAISE EXCEPTION 'N-1 rollback post-condition failed: the financial-evidence guard is still present';
  END IF;
END $$;

COMMIT;
