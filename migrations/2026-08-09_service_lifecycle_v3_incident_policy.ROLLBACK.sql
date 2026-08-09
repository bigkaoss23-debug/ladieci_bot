-- migrations/2026-08-09_service_lifecycle_v3_incident_policy.ROLLBACK.sql
-- Reverts 2026-08-09_service_lifecycle_v3_incident_policy.sql: drops the
-- 23-parameter create_service_closeout and restores row 58's exact original
-- 18-parameter function (identical body — no incident-aggregate columns in
-- the INSERT list) and its original service_role-only grant.
--
-- Mirrors the forward migration's own DROP + CREATE discipline: a bare
-- CREATE OR REPLACE with the 18-parameter signature would NOT undo the
-- overload — the 23-parameter function would simply remain as a second,
-- still-ambiguous-with-partial-calls overload. DROP the 23-parameter
-- signature explicitly first.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 incident policy rollback refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regprocedure('public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer)') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 incident policy rollback refused: 23-parameter create_service_closeout not found — nothing to roll back, or already rolled back'; END IF;
END $$;

DROP FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
);

CREATE FUNCTION public.create_service_closeout(
  p_service_session_id       uuid,
  p_closeout_correlation_id  uuid,
  p_closed_by                text,
  p_source                   text,
  p_close_reason             text,
  p_gross_sales_cents        integer,
  p_net_sales_cents          integer,
  p_total_refunds_cents      integer,
  p_total_void_cents         integer,
  p_paid_amount_cents        integer,
  p_unpaid_exposure_cents    integer,
  p_order_count              integer,
  p_cash_amount_cents        integer,
  p_card_amount_cents        integer,
  p_bizum_amount_cents       integer,
  p_other_amount_cents       integer,
  p_open_orders_at_close     integer,
  p_occupied_tables_at_close integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_attempt public.service_closeout_attempts%ROWTYPE;
  v_row     public.service_closeouts%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  IF p_gross_sales_cents IS NULL OR p_gross_sales_cents < 0
     OR p_net_sales_cents IS NULL OR p_net_sales_cents < 0
     OR p_paid_amount_cents IS NULL OR p_paid_amount_cents < 0
     OR p_unpaid_exposure_cents IS NULL OR p_unpaid_exposure_cents < 0
     OR p_order_count IS NULL OR p_order_count < 0
  THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_FINANCIAL_FIELDS');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  SELECT * INTO v_attempt FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;
  IF v_attempt.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_SESSION_MISMATCH');
  END IF;
  IF v_attempt.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  INSERT INTO public.service_closeouts(
    service_session_id, closeout_correlation_id, business_date, service_kind,
    opened_at, closed_at, close_source, close_reason, closed_by,
    gross_sales_cents, net_sales_cents, total_discounts_cents, total_refunds_cents, total_void_cents,
    paid_amount_cents, unpaid_exposure_cents, order_count,
    cash_amount_cents, card_amount_cents, bizum_amount_cents, other_amount_cents,
    open_orders_at_close, occupied_tables_at_close
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0)
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,'closeout',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeouts WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_EXISTS','created',false,'closeout',to_jsonb(v_row));
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_service_closeout(
  uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_closeout(
  uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer
) TO service_role;

-- This rollback does not touch service_incidents, service_closeout_snapshots,
-- mesa_release_empty_session_auto_v1, or any other object — this migration's
-- forward side only ever changed create_service_closeout.
COMMIT;
