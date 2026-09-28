-- migrations/2026-09-26_post_close_obligation_resolution_v1_migration_152.sql
-- Paired rollback: 2026-09-26_post_close_obligation_resolution_v1_migration_152.ROLLBACK.sql
--
-- ECONOMY BASE -- POST-ASTRA CORRECTIVE CYCLE, FINDING F1 (HIGH). STAGING CANDIDATE ONLY; not applied by the session that authored it.
-- Evidence: ~/Downloads/ECONOMY_POST_ASTRA_CORRECTIVE_REPORT_2026-09-26.md.
--
-- DEFECT F1 -- POST-CLOSE UNRESOLVABLE EXPOSURE. Migration 151 refuses every obligation revision of an order whose service is no longer
-- open (ORDER_ECONOMIC_SERVICE_CLOSED) and names the remedy: "record a post-close resolution instead". For V3 orders that remedy did not
-- exist (create_archived_order_financial_resolution only covers legacy archived orders -> ARCHIVED_ORDER_NOT_FOUND; no route; no reader).
-- Result, reproduced on the verbatim chain: a delivery that outlives Finalizar (the 139 contract) and then fails, a pickup nobody collected,
-- a complaint refunded after the close -- each left a permanent, false POR_COBRAR that nothing could correct.
--
-- FIX: a POST-CLOSE ECONOMIC RESOLUTION FACT, append-only, instead of a retroactive rewrite:
--   * a new obligation revision source, 'order_post_close_resolution_v1', written ONLY by the new function below. It carries its full
--     provenance (cause, reason, actor, role, client request id + hash) and resolution_service_session_id (the service open when it was
--     recorded, NULL off-service). It stays anchored to the order's own service (the obligation authority of the order), so the order's
--     CURRENT canonical obligation is correct everywhere (order_canonical_obligation_v1, every money writer, Mesa table totals, Cash V1,
--     Pendencias, Economia) while the closed service's FROZEN closeout / snapshot / reconciliation are untouched -- exactly how a payment
--     received after the close already moves the current truth of a closed service and never its closeout (N-8).
--   * public.order_post_close_obligation_resolution_v1: reduction-only; idempotent on (workspace, client_request_id); for the cause
--     'order_cancellation' it also moves estado to the cancel state in the same transaction (the order leaves the board, the money writers
--     refuse it as cancelled). It serves ONLY an order whose service (or obligation anchor) is no longer open: an order of an open service is
--     refused (ORDER_POST_CLOSE_SERVICE_STILL_OPEN) and keeps the 151 path -- this is not a way around the 151 gate.
-- 151 IS NOT WEAKENED: order_economic_service_gate_v1, order_obligation_apply_adjustment_v1 and order_obligation_revision_v1 are unchanged
-- (asserted before and after); the ordinary cancel / adjustment / totale paths keep refusing a closed service.
-- LOCK ORDER: the 151 writers' prefix -- WORKSPACE -> ACTOR -> [TABLE_SESSION] -> ORDER -> pointer (service_session_state) FOR SHARE, held
-- to commit -- so the fact is totally ordered against every close / open; nothing new is locked by a pointer holder.
-- ROLLOUT: 139 -> ... -> 150 -> the backend of the package -> 151 -> 152 -> 153 -> 154 (the backend routes the refused ordinary path here;
-- before 152 it answers that refusal with a typed failure, never a success).
-- ROLLBACK / PONR: function + constraints + column, refused once a post-close resolution fact exists (append-only money-adjacent fact the
-- pre-152 constraints would reject; rewriting it would rewrite history). Reverse order 154 -> 153 -> 152; the backend stays.

BEGIN;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)')) IS DISTINCT FROM '2c411d98f63545c4a4b7d04fd9beb7fe'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM 'bfac4ec3f428daa91d5d9505d8b1285a' THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION refused: migration 151 is not applied with its certified bodies -- the chain is 139 -> ... -> 151 -> 152';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'order_post_close_obligation_resolution_v1')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_obligations' AND column_name = 'resolution_service_session_id') THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION refused: already applied';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.order_obligations'::regclass AND conname = 'order_obligations_source_chk')
       IS DISTINCT FROM 'CHECK ((source = ANY (ARRAY[''order_create_v1''::text, ''order_total_revision_v1''::text, ''order_commercial_adjustment_v1''::text])))'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.order_obligations'::regclass AND conname = 'order_obligations_cause_presence_chk')
       IS DISTINCT FROM 'CHECK (((cause IS NOT NULL) = (source = ''order_commercial_adjustment_v1''::text)))'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.order_obligations'::regclass AND conname = 'order_obligations_adjustment_provenance_chk')
       IS DISTINCT FROM 'CHECK (((source <> ''order_commercial_adjustment_v1''::text) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''''::text) AND (by_actor IS NOT NULL) AND (by_role IS NOT NULL) AND (client_request_id IS NOT NULL) AND (request_hash IS NOT NULL))))' THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION refused: order_obligations constraints drifted -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'order_obligations_client_request_uq') THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION refused: the (workspace, client_request_id) idempotency index is missing';
  END IF;
END $guard$;

-- 1. The fact's own column and constraints (existing rows all satisfy them).
ALTER TABLE public.order_obligations
  ADD COLUMN resolution_service_session_id uuid NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_source_chk;
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_source_chk
  CHECK (source = ANY (ARRAY['order_create_v1'::text, 'order_total_revision_v1'::text, 'order_commercial_adjustment_v1'::text, 'order_post_close_resolution_v1'::text]));
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_cause_presence_chk;
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_cause_presence_chk
  CHECK ((cause IS NOT NULL) = (source = ANY (ARRAY['order_commercial_adjustment_v1'::text, 'order_post_close_resolution_v1'::text])));
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_adjustment_provenance_chk;
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_adjustment_provenance_chk
  CHECK ((source <> ALL (ARRAY['order_commercial_adjustment_v1'::text, 'order_post_close_resolution_v1'::text]))
         OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text) AND (by_actor IS NOT NULL) AND (by_role IS NOT NULL)
             AND (client_request_id IS NOT NULL) AND (request_hash IS NOT NULL)));
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_post_close_resolution_chk
  CHECK ((resolution_service_session_id IS NULL) OR (source = 'order_post_close_resolution_v1'::text));
COMMENT ON COLUMN public.order_obligations.resolution_service_session_id IS
  'Migration 152: for source order_post_close_resolution_v1 only -- the service that was open when the post-close resolution was recorded (NULL off-service). service_session_id stays the order''s own obligation anchor.';

-- 2. The one writer of the fact.
CREATE FUNCTION public.order_post_close_obligation_resolution_v1(
  p_order_uid uuid, p_by_actor text, p_new_gross numeric, p_cause text, p_reason text,
  p_client_request_id text, p_request_hash text,
  p_expected_current_gross numeric DEFAULT NULL::numeric, p_target_estado text DEFAULT NULL::text,
  p_table_session_id uuid DEFAULT NULL::uuid, p_workspace_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_entity public.order_entities%ROWTYPE;
  v_actor public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_prev public.order_obligations%ROWTYPE;
  v_new public.order_obligations%ROWTYPE;
  v_reason text; v_target text; v_anchor uuid; v_order_status text; v_anchor_status text;
  v_resolution_service uuid; v_current numeric; v_revision integer; v_period text; v_kind text;
  v_bootstrap boolean := false; v_inserted boolean := false; v_net numeric;
BEGIN
  IF p_order_uid IS NULL OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_cause IS NULL OR p_cause NOT IN ('manual', 'order_cancellation')
     OR p_new_gross IS NULL OR p_new_gross < 0
     OR p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 8 AND 128 OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'ORDER_POST_CLOSE_REASON_REQUIRED' USING ERRCODE = '22023'; END IF;
  v_reason := btrim(p_reason);
  IF p_cause = 'order_cancellation' THEN
    v_target := upper(btrim(COALESCE(p_target_estado, '')));
    IF v_target NOT IN ('CANCELADO', 'CANCELLED', 'ANULADO') OR round(p_new_gross, 2) <> 0 THEN
      RAISE EXCEPTION 'ORDER_POST_CLOSE_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSIF p_target_estado IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_POST_CLOSE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_workspace_id IS NOT NULL AND p_workspace_id <> v_entity.workspace_id THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_WORKSPACE_MISMATCH' USING ERRCODE = '22023';
  END IF;

  -- The 151 writers' prefix: WORKSPACE -> ACTOR -> [TABLE_SESSION] -> ORDER.
  PERFORM 1 FROM public.workspaces WHERE id = v_entity.workspace_id FOR UPDATE;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = v_entity.workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR (p_cause = 'order_cancellation' AND v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator'))
     OR (p_cause = 'manual' AND v_actor.role NOT IN ('admin','owner')) THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF v_entity.table_session_id IS NOT NULL THEN
    IF p_table_session_id IS NOT NULL AND p_table_session_id <> v_entity.table_session_id THEN
      RAISE EXCEPTION 'ORDER_POST_CLOSE_ORDER_MISMATCH' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.table_sessions WHERE id = v_entity.table_session_id FOR UPDATE;
  ELSIF p_table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_ORDER_MISMATCH' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_POST_CLOSE_ORDER_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_ord.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE = '22023'; END IF;

  -- Idempotent replay (the same key the refused ordinary path carried): never a second fact.
  SELECT * INTO v_prev FROM public.order_obligations
   WHERE workspace_id = v_entity.workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM p_request_hash OR v_prev.order_uid IS DISTINCT FROM p_order_uid THEN
      RAISE EXCEPTION 'ORDER_POST_CLOSE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'postClose', v_prev.source = 'order_post_close_resolution_v1',
      'orderId', v_ord.id, 'orderUid', p_order_uid, 'revision', v_prev.revision, 'currentObligation', v_prev.gross_amount,
      'cause', v_prev.cause, 'estado', v_ord.estado);
  END IF;

  -- The close gate primitive (145/146/151): the pointer held FOR SHARE to commit, then the service re-judged on a fresh snapshot.
  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;
  SELECT * INTO v_prev FROM public.order_obligations WHERE order_uid = p_order_uid ORDER BY revision DESC LIMIT 1;
  v_anchor := COALESCE(v_prev.service_session_id, v_ord.service_session_id);
  SELECT status INTO v_order_status FROM public.service_sessions WHERE id = v_ord.service_session_id;
  SELECT status INTO v_anchor_status FROM public.service_sessions WHERE id = v_anchor;
  IF v_order_status = 'open' AND v_anchor_status = 'open' THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_SERVICE_STILL_OPEN' USING ERRCODE = '55000',
      HINT = 'The service of this order is open: use the ordinary cancel / adjustment path.';
  END IF;
  SELECT ss.id INTO v_resolution_service
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;

  IF v_prev.id IS NULL THEN
    -- A legacy order without any revision: its baseline is materialized first (the same rule as the adjustment core).
    v_bootstrap := true; v_current := COALESCE(v_ord.totale, 0); v_revision := 1;
    SELECT ss.service_kind INTO v_kind FROM public.service_sessions ss WHERE ss.id = v_anchor;
    v_period := CASE WHEN v_kind IN ('PRANZO','SERA') THEN v_kind ELSE NULL END;  -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values matched verbatim
  ELSE
    v_current := v_prev.gross_amount; v_revision := v_prev.revision; v_period := v_prev.economic_period_kind;
  END IF;
  IF p_expected_current_gross IS NOT NULL AND round(p_expected_current_gross, 2) IS DISTINCT FROM round(v_current, 2) THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_STALE_OBLIGATION' USING ERRCODE = '55000';
  END IF;
  IF round(p_new_gross, 2) > round(v_current, 2) THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_EXCEEDS_OBLIGATION' USING ERRCODE = '22023';
  END IF;
  IF p_cause = 'order_cancellation' AND upper(COALESCE(v_ord.estado, '')) NOT IN ('POR_CONFIRMAR','NUEVO','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_STATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_cause = 'manual' AND round(p_new_gross, 2) = round(v_current, 2) THEN
    RAISE EXCEPTION 'ORDER_POST_CLOSE_NO_CHANGE' USING ERRCODE = '55000';
  END IF;

  IF round(p_new_gross, 2) <> round(v_current, 2) THEN
    IF v_bootstrap THEN
      INSERT INTO public.order_obligations
        (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, channel, source,
         economic_period_kind, created_at, materialized_lazily)
      VALUES (p_order_uid, v_ord.id, v_anchor, v_entity.workspace_id, 1, v_current, v_ord.canal, 'order_create_v1',
         v_period, COALESCE(v_ord.created_at, now()), true);
    END IF;
    INSERT INTO public.order_obligations
      (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, channel, source, economic_period_kind,
       created_at, cause, reason, by_actor, by_role, client_request_id, request_hash, resolution_service_session_id)
    VALUES (p_order_uid, v_ord.id, v_anchor, v_entity.workspace_id, v_revision + 1, round(p_new_gross, 2), v_ord.canal,
       'order_post_close_resolution_v1', v_period, now(), p_cause, v_reason, p_by_actor, v_actor.role,
       p_client_request_id, p_request_hash, v_resolution_service)
    RETURNING * INTO v_new;
    v_inserted := true;
  END IF;

  IF p_cause = 'order_cancellation' THEN
    UPDATE public.ordenes SET estado = v_target, cancelado_at = now() WHERE order_uid = p_order_uid;
  END IF;

  SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0) INTO v_net
    FROM public.order_financial_events e
   WHERE e.order_id = v_ord.id AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
     AND e.type IN ('payment','payment_imported','refund');
  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'postClose', true, 'changed', v_inserted,
    'orderId', v_ord.id, 'orderUid', p_order_uid,
    'revision', CASE WHEN v_inserted THEN v_new.revision ELSE v_revision END,
    'previousObligation', round(v_current, 2), 'currentObligation', round(p_new_gross, 2), 'cause', p_cause,
    'estado', CASE WHEN p_cause = 'order_cancellation' THEN v_target ELSE v_ord.estado END,
    'resolutionServiceSessionId', v_resolution_service,
    'netCollected', round(v_net, 2),
    'unpaid', GREATEST(0, round(p_new_gross - v_net, 2)), 'overCollected', GREATEST(0, round(v_net - p_new_gross, 2)));
END;
$function$;

REVOKE ALL ON FUNCTION public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid) TO service_role;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)');
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'POST_CLOSE_RESOLUTION post-condition failed: function missing'; END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION post-condition failed: posture (SECURITY INVOKER, pinned search_path)';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION post-condition failed: EXECUTE must be service_role only';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')) IS DISTINCT FROM '3c8c4c46dac20285081b85a3313ef576'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)')) IS DISTINCT FROM '2c411d98f63545c4a4b7d04fd9beb7fe'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.order_obligation_revision_v1()')) IS DISTINCT FROM 'bfac4ec3f428daa91d5d9505d8b1285a' THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION post-condition failed: a 151 body changed (the gate must stay untouched)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.order_obligations'::regclass AND conname = 'order_obligations_post_close_resolution_chk' AND convalidated) THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION post-condition failed: constraint missing';
  END IF;
END $post$;

COMMIT;
