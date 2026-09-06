-- migrations/2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.ROLLBACK.sql
-- Reverses FINALIZAR V3 CANONICAL CLOSEOUT V1 (migration 121):
--   * restores public.create_service_closeout to its exact pre-121
--     (23-parameter, F-4A era-aware) body and grants;
--   * drops the three additive CHECK constraints;
--   * drops columns current_obligation_cents / over_collected_cents.
--
-- HARD REFUSAL: if ANY service_closeouts row already carries a non-null
-- current_obligation_cents, this rollback aborts. Those columns hold IMMUTABLE
-- close facts (service_closeouts_no_update_delete) and DROP COLUMN would
-- destroy them silently. Resolving that is a deliberate manual decision, never
-- a side effect of a rollback.
--
-- WARNING: after this rollback the V3 close engine, if still running the
-- obligation-aware build, will call create_service_closeout with two extra
-- arguments the 23-parameter signature does not accept (PGRST202 /
-- function-not-found) — roll the backend back to the pre-canonical build in
-- the same window.

BEGIN;

DO $guard$
DECLARE
  v_idargs text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_idargs
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_service_closeout';
  IF v_idargs IS NULL OR v_idargs NOT LIKE '%p_current_obligation_cents integer, p_over_collected_cents integer' THEN
    RAISE EXCEPTION 'M121 ROLLBACK refused: create_service_closeout is not the 25-parameter M121 signature -- nothing to roll back, or drift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='service_closeouts'
                   AND column_name='current_obligation_cents') THEN
    RAISE EXCEPTION 'M121 ROLLBACK refused: current_obligation_cents column already absent';
  END IF;
  IF EXISTS (SELECT 1 FROM public.service_closeouts WHERE current_obligation_cents IS NOT NULL) THEN
    RAISE EXCEPTION 'M121 ROLLBACK refused: canonical-obligation closeout rows exist -- DROP COLUMN would destroy immutable close facts; resolve manually';
  END IF;
END $guard$;

DROP FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer,
  integer, integer
);

-- Verbatim pre-121 body (F-4A era-aware, 23-parameter).
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
  p_occupied_tables_at_close integer,
  p_kitchen_pending_count    integer DEFAULT 0,
  p_listo_count              integer DEFAULT 0,
  p_delivery_pending_count   integer DEFAULT 0,
  p_incident_count           integer DEFAULT 0,
  p_critical_incident_count  integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF v_session.lifecycle_semantics = 'economic_period_v1' AND v_session.service_kind IS NULL THEN
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
    service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics,
    opened_at, closed_at, close_source, close_reason, closed_by,
    gross_sales_cents, net_sales_cents, total_discounts_cents, total_refunds_cents, total_void_cents,
    paid_amount_cents, unpaid_exposure_cents, order_count,
    cash_amount_cents, card_amount_cents, bizum_amount_cents, other_amount_cents,
    open_orders_at_close, occupied_tables_at_close,
    kitchen_pending_count, listo_count, delivery_pending_count,
    incident_count, critical_incident_count
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind, v_session.lifecycle_semantics,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0),
    COALESCE(p_kitchen_pending_count, 0), COALESCE(p_listo_count, 0), COALESCE(p_delivery_pending_count, 0),
    COALESCE(p_incident_count, 0), COALESCE(p_critical_incident_count, 0)
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
$function$;

REVOKE ALL ON FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) TO service_role;

ALTER TABLE public.service_closeouts
  DROP CONSTRAINT IF EXISTS service_closeouts_canonical_obligation_pairing_chk,
  DROP CONSTRAINT IF EXISTS service_closeouts_current_obligation_cents_nonneg_chk,
  DROP CONSTRAINT IF EXISTS service_closeouts_over_collected_cents_nonneg_chk;

ALTER TABLE public.service_closeouts
  DROP COLUMN IF EXISTS current_obligation_cents,
  DROP COLUMN IF EXISTS over_collected_cents;

DO $post$
DECLARE
  v_n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='service_closeouts'
               AND column_name IN ('current_obligation_cents','over_collected_cents')) THEN
    RAISE EXCEPTION 'M121 ROLLBACK post-condition failed: a canonical-obligation column survived';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_service_closeout';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'M121 ROLLBACK post-condition failed: expected exactly 1 create_service_closeout overload, found %', v_n;
  END IF;
  IF (SELECT pg_get_function_identity_arguments(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='create_service_closeout')
     LIKE '%p_current_obligation_cents%' THEN
    RAISE EXCEPTION 'M121 ROLLBACK post-condition failed: create_service_closeout still carries the M121 parameters';
  END IF;
END $post$;

COMMIT;
