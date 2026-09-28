-- migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql
-- Rolls migration 144 back to the EXACT pre-144 state: order_cancel_v1 is re-issued VERBATIM as it is on staging (md5(prosrc)
-- d75624fd1393d7dbf94d2155e19626b7, byte for byte the text this session captured from staging and that migration 144's guard pins).
-- Owner, SECURITY INVOKER, search_path and ACL are preserved (asserted, not re-granted). Nothing else is touched.
--
-- REFUSES (and changes nothing) unless the function is exactly the 144 body (md5 26408ba35e2a43420273a6f4c126083d); a divergent body means someone changed
-- it after 144 -- resolve drift first, never overwrite silently.
-- ORDER: independent of migration 143 (the intake prelude); either can be rolled back first.
-- STAGING ONLY. NOT applied by the session that authored it.

BEGIN;

DO $guard$
DECLARE
  v_oid oid := to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'C8_CANCEL rollback refused: public.order_cancel_v1(text,text,text,text,text,text,jsonb) is missing -- resolve drift first';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM '26408ba35e2a43420273a6f4c126083d' THEN
    RAISE EXCEPTION 'C8_CANCEL rollback refused: order_cancel_v1 is not the exact 144 body (md5 mismatch) -- resolve drift first';
  END IF;
END $guard$;

CREATE TEMP TABLE c8144rb_before (k text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text, proretset boolean, prorettype regtype, args text) ON COMMIT DROP;
INSERT INTO c8144rb_before
  SELECT 'cancel', p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text, p.proretset, p.prorettype::regtype, pg_get_function_arguments(p.oid)
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');
CREATE TEMP TABLE c8144rb_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c8144rb_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');

CREATE OR REPLACE FUNCTION public.order_cancel_v1(p_order_id text, p_by_actor text, p_reason text, p_client_request_id text, p_request_hash text, p_target_estado text DEFAULT 'CANCELADO'::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE; v_peek public.ordenes%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_target text; v_res jsonb; v_net numeric;
  v_current numeric; v_workspace uuid; v_now timestamptz := now();
BEGIN
  IF p_order_id IS NULL OR btrim(p_order_id) = ''
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_CANCEL_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
  v_target := upper(btrim(COALESCE(p_target_estado, 'CANCELADO')));
  IF v_target NOT IN ('CANCELADO','CANCELLED','ANULADO') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_peek FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_CANCEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT oe.workspace_id INTO v_workspace FROM public.order_entities oe WHERE oe.order_uid = v_peek.order_uid;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE actor = p_by_actor AND (v_workspace IS NULL OR workspace_id = v_workspace) FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'ORDER_CANCEL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_peek.table_session_id IS NOT NULL THEN
    PERFORM 1 FROM public.table_sessions WHERE id = v_peek.table_session_id FOR UPDATE; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_CANCEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ord.order_uid IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023'; END IF;
  IF upper(COALESCE(v_ord.estado,'')) = v_target THEN
    v_current := public.order_canonical_obligation_v1(v_ord.order_uid);
    SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0)
      INTO v_net FROM public.order_financial_events e
     WHERE e.order_id = v_ord.id AND e.type IN ('payment','payment_imported','refund')
       AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
      'estado', v_ord.estado, 'currentObligation', round(v_current, 2), 'netCollected', round(v_net, 2),
      'unpaid', GREATEST(0, round(v_current - v_net, 2)), 'overCollected', GREATEST(0, round(v_net - v_current, 2)));
  END IF;
  IF upper(COALESCE(v_ord.estado,'')) NOT IN ('POR_CONFIRMAR','NUEVO','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_STATE_INVALID' USING ERRCODE='22023'; END IF;
  v_res := public.order_obligation_apply_adjustment_v1(
    v_ord.order_uid, 0, 'order_cancellation', p_reason, p_by_actor, v_actor.role,
    p_client_request_id, p_request_hash, NULL);
  UPDATE public.ordenes SET estado = v_target, cancelado_at = v_now WHERE id = v_ord.id;
  SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0)
    INTO v_net FROM public.order_financial_events e
   WHERE e.order_id = v_ord.id AND e.type IN ('payment','payment_imported','refund')
     AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  v_current := (v_res->>'currentObligation')::numeric;
  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
    'prevEstado', v_ord.estado, 'estado', v_target, 'previousObligation', v_res->'previousObligation',
    'currentObligation', round(v_current, 2), 'revision', v_res->'revision', 'bootstrapped', v_res->'bootstrapped',
    'netCollected', round(v_net, 2), 'unpaid', GREATEST(0, round(v_current - v_net, 2)),
    'overCollected', GREATEST(0, round(v_net - v_current, 2)));
END;
$function$;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');
  v_b   c8144rb_before%ROWTYPE;
  v_diff integer;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'C8_CANCEL rollback post-condition failed: function missing'; END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM 'd75624fd1393d7dbf94d2155e19626b7' THEN
    RAISE EXCEPTION 'C8_CANCEL rollback post-condition failed: the restored body is not the staging body (md5 mismatch)';
  END IF;
  SELECT * INTO v_b FROM c8144rb_before WHERE k = 'cancel';
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef IS NOT DISTINCT FROM v_b.prosecdef AND p.proconfig IS NOT DISTINCT FROM v_b.proconfig
                    AND pg_get_userbyid(p.proowner) = v_b.owner AND p.proacl::text IS NOT DISTINCT FROM v_b.acl AND p.proretset = v_b.proretset
                    AND p.prorettype::regtype = v_b.prorettype AND pg_get_function_arguments(p.oid) = v_b.args) THEN
    RAISE EXCEPTION 'C8_CANCEL rollback post-condition failed: signature / owner / SECURITY / search_path / ACL changed';
  END IF;
  SELECT count(*) INTO v_diff FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_oid
     AND NOT EXISTS (SELECT 1 FROM c8144rb_fn_before f WHERE f.sig = p.oid::regprocedure::text AND f.md5 = md5(p.prosrc));
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_CANCEL rollback post-condition failed: % other function(s) of schema public changed', v_diff; END IF;
END $post$;

COMMIT;
