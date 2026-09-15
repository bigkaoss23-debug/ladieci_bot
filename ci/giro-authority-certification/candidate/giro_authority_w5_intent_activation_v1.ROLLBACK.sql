-- W5 INTENT ACTIVATION V1 -- ROLLBACK candidate.
-- Drops the capture trigger and the new read-only helper, restores
-- giro_authority_consume_intent_v1 and close_service_session_v3 to their exact
-- pre-132 (migration-130/f4-series) bodies. Never touches giro_authority.giro_intents
-- data -- any row already captured by the trigger while it was installed stays
-- exactly as it is; this rollback removes write PATHS, never facts.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.giro_authority_list_pending_intents_v1(uuid[],integer)') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                        AND tgname = 'ordenes_zz_giro_intent_capture_v1')
     AND pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure) NOT ILIKE '%bump_facts_signal_v1%' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION_ROLLBACK refused: nothing to roll back -- packet is not applied';
  END IF;
END $$;

DROP TRIGGER IF EXISTS ordenes_zz_giro_intent_capture_v1 ON public.ordenes;
DROP FUNCTION IF EXISTS public.giro_authority_list_pending_intents_v1(uuid[], integer);

-- Exact pre-132 body (migration 130), byte-for-byte, no bump calls.
CREATE OR REPLACE FUNCTION public.giro_authority_consume_intent_v1(p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_row  giro_authority.giro_intents;
  v_trip jsonb;
  v_ctx  jsonb;
  v_cur  text;
  v_new  text;
  v_why  text;
  f      record;
  a      record;
  d      record;
BEGIN
  IF p_order_uid IS NULL OR NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NO_INTENT');
  END IF;
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  IF v_row.target_kind = 'GIRO' THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_row.target_giro_id FOR UPDATE;   -- L1
  END IF;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid, v_row.target_order_uid]);      -- L2
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid FOR UPDATE;  -- L3
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  PERFORM 1 FROM public.ordenes o
   WHERE o.order_uid = ANY (ARRAY[p_order_uid, v_row.target_order_uid])
   ORDER BY o.order_uid FOR SHARE;                                                        -- L4

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'SCOPE_UNAVAILABLE', NULL, p_actor, NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'UNVERIFIABLE', NULL, p_actor,
                                            jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  IF NOT f.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_GONE'));
  END IF;
  IF NOT COALESCE(f.service_session_id = ANY (p_operational_session_ids), false) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'EXPIRED', 'EXPIRY', 'SERVICE_CLOSED', NULL, p_actor, NULL);
  END IF;
  IF f.in_active_trip OR f.estado = 'EN_ENTREGA'
     OR f.estado = ANY (giro_authority.delivered_states_v1())
     OR f.estado = ANY (giro_authority.cancelled_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_STATE', 'estado', f.estado));
  END IF;
  IF f.estado IS NULL OR f.estado NOT IN ('EN_COCINA', 'LISTO') THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NOT_YET_OPERATIVE', 'status', 'PENDING', 'replay', false);
  END IF;
  v_ctx := v_row.order_context;
  IF (v_ctx->>'zona') IS DISTINCT FROM f.zona
     OR (v_ctx->>'hora') IS DISTINCT FROM f.hora
     OR (v_ctx->>'delivery_type') IS DISTINCT FROM f.delivery_type
     OR (v_ctx->>'service_session_id') IS DISTINCT FROM f.service_session_id::text THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor, NULL);
  END IF;
  IF f.delivery_type <> 'DOMICILIO' OR f.table_session_id IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'NOT_DELIVERY'));
  END IF;
  v_cur := giro_authority.order_effective_giro_v1(p_order_uid, p_operational_session_ids, v_trip);

  IF v_row.target_kind = 'GIRO' THEN
    IF v_cur = v_row.target_giro_id THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_cur, p_actor,
                                              jsonb_build_object('already_member', true));
    END IF;
    IF v_cur IS NOT NULL THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                              jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
    END IF;
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_row.target_giro_id], p_operational_session_ids, v_trip);
    IF NOT FOUND THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor, NULL);
    END IF;
    IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor,
                                              jsonb_build_object('giro_state', d.giro_state));
    END IF;
    IF d.giro_state <> 'PLANNED' OR d.business_date IS DISTINCT FROM f.business_date THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                              jsonb_build_object('state_reason', d.state_reason));
    END IF;
    IF giro_authority.target_fingerprint_v1('GIRO', v_row.target_giro_id, NULL) IS DISTINCT FROM v_row.target_fingerprint THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
    END IF;
    PERFORM giro_authority.put_member_v1(p_order_uid, v_row.target_giro_id, p_actor);
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_row.target_giro_id, p_actor, NULL);
  END IF;

  -- ANCHOR: create {anchor, order}; the anchor must still be a free, operative single.
  IF v_cur IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
  END IF;
  SELECT * INTO a FROM giro_authority.order_facts_v1(ARRAY[v_row.target_order_uid], v_trip);
  IF NOT a.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ANCHOR_GONE'));
  END IF;
  IF a.in_active_trip OR a.estado = 'EN_ENTREGA' OR a.estado = ANY (giro_authority.delivered_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor, NULL);
  END IF;
  v_why := giro_authority.member_refusal_v1(a.present, a.estado, a.delivery_type, a.table_session_id,
                                            a.in_active_trip, a.service_session_id, p_operational_session_ids);
  IF v_why IS NOT NULL OR a.business_date IS DISTINCT FROM f.business_date THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', COALESCE(v_why, 'BUSINESS_DATE')));
  END IF;
  IF giro_authority.order_effective_giro_v1(v_row.target_order_uid, p_operational_session_ids, v_trip) IS NOT NULL
     OR giro_authority.target_fingerprint_v1('ANCHOR', NULL, v_row.target_order_uid) IS DISTINCT FROM v_row.target_fingerprint THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
  END IF;
  v_new := giro_authority.insert_giro_v1(f.business_date, NULL, v_row.target_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(v_row.target_order_uid, v_new, p_actor);
  PERFORM giro_authority.put_member_v1(p_order_uid, v_new, p_actor);
  RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'GIRO_CREATED', v_new, p_actor, NULL);
END $function$;

-- Exact pre-132 body (f4-series/lifecycle-v3), byte-for-byte, no sweep step.
CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
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

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'closed' THEN
    IF v_state.recent_closed_session_id = v_session.id AND v_state.current_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS');
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE service_session_id = p_service_session_id
       AND closeout_correlation_id = p_closeout_correlation_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_NOT_FOUND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
       AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;

  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id = NULL, updated_at = now() WHERE singleton = true;
  END IF;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

COMMIT;
