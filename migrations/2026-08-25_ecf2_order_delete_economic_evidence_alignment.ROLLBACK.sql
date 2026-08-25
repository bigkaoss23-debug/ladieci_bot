-- migrations/2026-08-25_ecf2_order_delete_economic_evidence_alignment.ROLLBACK.sql
-- Reverses 2026-08-25_ecf2_order_delete_economic_evidence_alignment.sql (ledger 116).
--
-- ── WHAT COMES BACK IS THE DEFECT. READ THIS BEFORE RUNNING IT. ────────────────────
-- Applying this restores the pre-EC-F2 guards, and with them the hard-delete hole that
-- was proven live on staging (rollback-forced probes, this session):
--
--   * a brand-new order carrying an N-2 obligation and zero payments becomes
--     HARD-DELETABLE again -- `{"ok": true, "code": "OK", "deleted": 1}` -- and its
--     append-only order_obligations row is left ORPHANED with no order behind it;
--   * an order whose only economic evidence is `ya_pagado = true` or `cobrado = true`
--     (the #999024 class, 14.50 EUR of legacy-collected money that Economía reports via
--     safeTicket's legacy fallback) becomes HARD-DELETABLE again;
--   * delete_conversation_if_not_active loses the N-2 obligation arm it gained here,
--     returning to its own pre-existing six-branch predicate.
--
-- Do not run this without accepting that money can then disappear from every reader.
--
-- ── IT DELETES NO MONEY ITSELF ─────────────────────────────────────────────────────
-- EC-F2 wrote no data at all: it created one predicate function and redefined two
-- function bodies. There is nothing to un-write. Every order_financial_events row, every
-- order_obligations revision, every service_closeouts snapshot and every ordenes row is
-- untouched by both the migration and this rollback. No backfill was performed, so none
-- is undone. Orders that this guard REFUSED to delete while it was live simply remain --
-- refusing a delete creates no state to reverse.

BEGIN;

-- Restore the pre-EC-F2 single-order guard: four evidence classes, no obligations, no
-- legacy booleans. (This is the defective version. See the header.)
CREATE OR REPLACE FUNCTION public.delete_order_if_not_active(p_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ds           jsonb;
  v_active       jsonb;
  v_deleted      int;
  v_found        boolean;
  v_session      uuid;
  v_has_evidence boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  SELECT true, service_session_id INTO v_found, v_session
    FROM public.ordenes WHERE id = p_order_id;

  IF v_found THEN
    SELECT
      EXISTS (
        SELECT 1 FROM public.order_financial_events e
         WHERE e.order_id = p_order_id
           AND (v_session IS NULL OR e.service_session_id IS NULL OR e.service_session_id = v_session)
      )
      OR EXISTS (
        SELECT 1 FROM public.table_order_lines tol
         WHERE tol.order_id = p_order_id
           AND (v_session IS NULL OR tol.service_session_id = v_session)
      )
      OR EXISTS (
        SELECT 1 FROM public.payment_allocations pa
         JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
         WHERE pa.order_id = p_order_id
           AND (v_session IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = v_session)
      )
      OR EXISTS (
        SELECT 1 FROM public.service_incidents si
         WHERE si.order_id = p_order_id
           AND (v_session IS NULL OR si.service_session_id = v_session)
      )
    INTO v_has_evidence;

    IF v_has_evidence THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_HAS_FINANCIAL_EVIDENCE');
    END IF;
  END IF;

  DELETE FROM public.ordenes WHERE id = p_order_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'deleted', v_deleted);
END;
$fn$;

-- Restore the pre-EC-F2 conversation guard: its own inline six-branch predicate
-- (legacy booleans + four evidence tables), without the N-2 obligation arm.
CREATE OR REPLACE FUNCTION public.delete_conversation_if_not_active(p_wa_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ds          jsonb;
  v_active      jsonb;
  v_order_ids   text[];
  v_protected   boolean;
  v_conv_del    int;
  v_msgs_del    int;
  v_orders_del  int;
BEGIN
  IF p_wa_id IS NULL OR p_wa_id !~ '\S' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_WA_ID');
  END IF;

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

  SELECT EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.wa_id = p_wa_id
       AND (
         o.ya_pagado IS TRUE
         OR o.cobrado IS TRUE
         OR EXISTS (
           SELECT 1 FROM public.order_financial_events e
            WHERE e.order_id = o.id
              AND (o.service_session_id IS NULL OR e.service_session_id IS NULL OR e.service_session_id = o.service_session_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.table_order_lines tol
            WHERE tol.order_id = o.id
              AND (o.service_session_id IS NULL OR tol.service_session_id = o.service_session_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.payment_allocations pa
            JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
            WHERE pa.order_id = o.id
              AND (o.service_session_id IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = o.service_session_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.service_incidents si
            WHERE si.order_id = o.id
              AND (o.service_session_id IS NULL OR si.service_session_id = o.service_session_id)
         )
       )
  ) INTO v_protected;

  IF v_protected THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONVERSATION_HAS_FINANCIAL_EVIDENCE');
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
$fn$;

-- Dropped LAST, once nothing references it any more.
DROP FUNCTION IF EXISTS public.order_has_economic_evidence_v1(text);

DO $post$
DECLARE v_order text; v_conv text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='order_has_economic_evidence_v1') THEN
    RAISE EXCEPTION 'EC-F2 rollback post-condition failed: the shared predicate still exists';
  END IF;
  SELECT prosrc INTO v_order FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_order_if_not_active';
  SELECT prosrc INTO v_conv  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_conversation_if_not_active';
  IF v_order LIKE '%order_has_economic_evidence_v1%' OR v_conv LIKE '%order_has_economic_evidence_v1%' THEN
    RAISE EXCEPTION 'EC-F2 rollback post-condition failed: a guard still delegates to the dropped predicate';
  END IF;
  IF v_order NOT LIKE '%ACTIVE_TRIP_MEMBER_CONFLICT%' OR v_conv NOT LIKE '%ACTIVE_TRIP_MEMBER_CONFLICT%' THEN
    RAISE EXCEPTION 'EC-F2 rollback post-condition failed: active-trip refusal lost';
  END IF;
END
$post$;

COMMIT;
