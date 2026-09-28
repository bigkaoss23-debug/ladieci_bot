-- migrations/2026-09-26_economic_close_gate_v1_migration_151.ROLLBACK.sql
-- Paired forward: 2026-09-26_economic_close_gate_v1_migration_151.sql
--
-- ROLLBACK OF MIGRATION 151. Function-only: restores order_obligation_apply_adjustment_v1 and order_obligation_revision_v1 to their 150-state
-- bodies verbatim and drops order_economic_service_gate_v1. No data is read, written or depends on 151, so this is valid at any time and in any
-- order with the backend (the backend only recognises the refusal). After it the database is exactly the 150 state (certified: catalog
-- byte-equal) -- and the race 151 closes is open again (cancel / adjustments / totale edits vs Finalizar, and post-close obligation rewrites).
-- REFUSES (fail closed) unless every 151 object is exactly the certified one and nothing else calls the helper.
BEGIN;

DO $guard$
DECLARE
  v_pin record;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public.order_economic_service_gate_v1(uuid)', '3c8c4c46dac20285081b85a3313ef576'),
      ('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)', '2c411d98f63545c4a4b7d04fd9beb7fe'),
      ('public.order_obligation_revision_v1()', 'bfac4ec3f428daa91d5d9505d8b1285a')
    ) AS x(sig, want) LOOP
    IF to_regprocedure(v_pin.sig) IS NULL
       OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE rollback refused: % is missing or is not the certified 151 body % -- resolve drift first', v_pin.sig, v_pin.want;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema' AND p.prosrc LIKE '%order_economic_service_gate_v1%'
                AND p.oid NOT IN (to_regprocedure('public.order_economic_service_gate_v1(uuid)'), to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)'), to_regprocedure('public.order_obligation_revision_v1()'))) THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE rollback refused: another function calls order_economic_service_gate_v1 -- roll that back first';
  END IF;
END $guard$;

CREATE TEMP TABLE c151r_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c151r_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';

-- 1. The two obligation writers back to their 150-state bodies, verbatim ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_obligation_apply_adjustment_v1(p_order_uid uuid, p_new_gross numeric, p_cause text, p_reason text, p_by_actor text, p_by_role text, p_client_request_id text, p_request_hash text, p_expected_current_gross numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ord public.ordenes%ROWTYPE; v_prev public.order_obligations%ROWTYPE; v_workspace uuid;
  v_kind text; v_current numeric; v_revision integer; v_new_rev integer;
  v_bootstrap boolean := false; v_reason text; v_session uuid; v_period text;
BEGIN
  IF p_order_uid IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023'; END IF;
  IF p_cause IS NULL OR p_cause NOT IN ('manual','order_cancellation') THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_new_gross IS NULL OR p_new_gross < 0 THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' OR p_by_role IS NULL THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_client_request_id IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ord.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023'; END IF;

  SELECT oe.workspace_id INTO v_workspace FROM public.order_entities oe WHERE oe.order_uid = p_order_uid;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_prev FROM public.order_obligations
   WHERE workspace_id = v_workspace AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'MESA_ADJUSTMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'changed', true, 'bootstrapped', false,
      'orderUid', v_prev.order_uid, 'revision', v_prev.revision, 'currentObligation', v_prev.gross_amount,
      'previousObligation', (SELECT ob.gross_amount FROM public.order_obligations ob
                              WHERE ob.order_uid = p_order_uid AND ob.revision = v_prev.revision - 1),
      'cause', v_prev.cause);
  END IF;

  SELECT * INTO v_prev FROM public.order_obligations WHERE order_uid = p_order_uid ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    v_bootstrap := true; v_current := COALESCE(v_ord.totale, 0); v_revision := 1; v_session := v_ord.service_session_id;
    SELECT ss.service_kind INTO v_kind FROM public.service_sessions ss WHERE ss.id = v_session;
    v_period := CASE WHEN v_kind IN ('PRANZO','SERA') THEN v_kind ELSE NULL END;
    INSERT INTO public.order_obligations
      (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, channel, source,
       economic_period_kind, created_at, materialized_lazily)
    VALUES (p_order_uid, v_ord.id, v_session, v_workspace, 1, v_current, v_ord.canal, 'order_create_v1',
       v_period, COALESCE(v_ord.created_at, now()), true);
  ELSE
    v_current := v_prev.gross_amount; v_revision := v_prev.revision; v_session := v_prev.service_session_id;
    v_period := v_prev.economic_period_kind;
  END IF;

  IF p_expected_current_gross IS NOT NULL
     AND round(p_expected_current_gross, 2) IS DISTINCT FROM round(v_current, 2) THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_STALE_OBLIGATION' USING ERRCODE='55000'; END IF;
  IF round(p_new_gross, 2) > round(v_current, 2) THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_EXCEEDS_OBLIGATION' USING ERRCODE='22023'; END IF;
  IF round(p_new_gross, 2) = round(v_current, 2) THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'changed', false, 'bootstrapped', v_bootstrap,
      'orderUid', p_order_uid, 'revision', CASE WHEN v_bootstrap THEN 1 ELSE v_revision END,
      'currentObligation', v_current, 'previousObligation', v_current, 'cause', p_cause);
  END IF;

  v_new_rev := CASE WHEN v_bootstrap THEN 2 ELSE v_revision + 1 END;
  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, channel, source,
     economic_period_kind, created_at, cause, reason, by_actor, by_role, client_request_id, request_hash)
  VALUES (p_order_uid, v_ord.id, v_session, v_workspace, v_new_rev, round(p_new_gross, 2), v_ord.canal,
     'order_commercial_adjustment_v1', v_period, now(), p_cause, v_reason, p_by_actor, p_by_role,
     p_client_request_id, p_request_hash);

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'changed', true, 'bootstrapped', v_bootstrap,
    'orderUid', p_order_uid, 'revision', v_new_rev, 'previousObligation', v_current,
    'currentObligation', round(p_new_gross, 2), 'cause', p_cause);
END;
$function$;

CREATE OR REPLACE FUNCTION public.order_obligation_revision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prev   public.order_obligations%ROWTYPE;
BEGIN
  IF NEW.totale IS NOT DISTINCT FROM OLD.totale THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_prev FROM public.order_obligations
   WHERE order_uid = NEW.order_uid
   ORDER BY revision DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision,
     gross_amount, channel, source, economic_period_kind, created_at)
  VALUES
    (NEW.order_uid, NEW.id, v_prev.service_session_id, v_prev.workspace_id,
     v_prev.revision + 1, COALESCE(NEW.totale, 0), NEW.canal,
     'order_total_revision_v1', v_prev.economic_period_kind, now());

  RETURN NEW;
END;
$function$;

-- 2. The helper ---------------------------------------------------------------------------------------------------------------------------------------
DROP FUNCTION public.order_economic_service_gate_v1(uuid);

-- 3. Post-conditions -------------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_bad text;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)')) IS DISTINCT FROM 'b4c358e2a3913ba110d400f07059e8e5'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM '49387a6bf8e0ec66694d7bebe14d3d17'
     OR to_regprocedure('public.order_economic_service_gate_v1(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE rollback post-condition failed: the 150-state bodies are not restored exactly';
  END IF;
  SELECT string_agg(COALESCE(a.sig, b.sig), ', ') INTO v_bad
    FROM c151r_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE regexp_replace(COALESCE(a.sig, b.sig), '^public\.', '') NOT IN ('order_economic_service_gate_v1(uuid)',
                                        'order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)', 'order_obligation_revision_v1()')
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE rollback post-condition failed: other functions changed (%)', v_bad;
  END IF;
END $post$;

COMMIT;
