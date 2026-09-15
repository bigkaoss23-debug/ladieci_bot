-- PLANNER W6.1 LOCK-ORDER UNIFICATION -- ROLLBACK candidate.
-- Restores giro_authority_create_or_move_v1, giro_authority_attach_or_move_v1,
-- giro_authority_detach_v1, giro_authority_dissolve_v1 and giro_authority_
-- consume_intent_v1 to their exact pre-133 (migration-131/132) bodies, byte-for-byte,
-- with the L0 advisory-lock acquisition removed and nothing else changed. No table,
-- trigger, column or grant exists to undo -- this migration created none.

BEGIN;

DO $$
BEGIN
  IF pg_get_functiondef('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure) NOT ILIKE '%LA_DIECI_DRIVER_STATO%'
     AND pg_get_functiondef('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure) NOT ILIKE '%LA_DIECI_DRIVER_STATO%'
     AND pg_get_functiondef('public.giro_authority_detach_v1(uuid,text,uuid[])'::regprocedure) NOT ILIKE '%LA_DIECI_DRIVER_STATO%'
     AND pg_get_functiondef('public.giro_authority_dissolve_v1(text,text,uuid[])'::regprocedure) NOT ILIKE '%LA_DIECI_DRIVER_STATO%'
     AND pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure) NOT ILIKE '%LA_DIECI_DRIVER_STATO%' THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER_ROLLBACK refused: nothing to roll back -- migration 133 is not applied';
  END IF;
END $$;

-- Exact pre-133 bodies (migration 131), byte-for-byte, no L0 acquisition.
CREATE OR REPLACE FUNCTION public.giro_authority_create_or_move_v1(
  p_order_uids uuid[], p_hora_ref text, p_anchor_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_uids   uuid[];
  v_hora   text;
  v_trip   jsonb;
  v_reason text;
  v_dates  date[];
  v_id     text;
  v_effs   text[];
  v_moved  text[];
  r        record;
  d        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'actor'));
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  v_uids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_order_uids, '{}'::uuid[])) AS x WHERE x IS NOT NULL ORDER BY 1);
  IF cardinality(v_uids) < 2 THEN
    RETURN giro_authority.refusal_v1('INSUFFICIENT_MEMBERS', NULL);
  END IF;
  IF p_hora_ref IS NOT NULL AND btrim(p_hora_ref) <> '' THEN
    v_hora := giro_authority.hhmm_norm(p_hora_ref);
    IF v_hora IS NULL THEN
      RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'hora_ref'));
    END IF;
  END IF;
  IF p_anchor_order_uid IS NOT NULL AND NOT (p_anchor_order_uid = ANY (v_uids)) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'anchor_order_uid'));
  END IF;

  -- Lock every giro any of these orders currently point to (L1, ascending id),
  -- then the orders themselves (L2 + L4) -- same discipline as every other command.
  PERFORM 1 FROM public.manual_giros mg
    WHERE mg.id IN (SELECT DISTINCT gm.giro_id FROM giro_authority.giro_members gm WHERE gm.order_uid = ANY (v_uids))
    ORDER BY mg.id FOR UPDATE;
  PERFORM giro_authority.lock_orders_v1(v_uids);
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = ANY (v_uids) ORDER BY o.order_uid FOR SHARE;

  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  FOR r IN SELECT * FROM giro_authority.order_facts_v1(v_uids, v_trip) LOOP
    v_reason := giro_authority.member_refusal_v1(r.present, r.estado, r.delivery_type, r.table_session_id,
                                                 r.in_active_trip, r.service_session_id, p_operational_session_ids);
    IF v_reason = 'ORDER_NOT_FOUND' THEN
      RETURN giro_authority.refusal_v1('ORDER_NOT_FOUND', jsonb_build_object('order_uid', r.order_uid));
    ELSIF v_reason IS NOT NULL THEN
      RETURN giro_authority.refusal_v1('ORDER_NOT_ELIGIBLE', jsonb_build_object('order_uid', r.order_uid, 'reason', v_reason));
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT f.business_date) INTO v_dates FROM giro_authority.order_facts_v1(v_uids, v_trip) f;
  IF cardinality(v_dates) <> 1 OR v_dates[1] IS NULL THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;

  -- One computation of each order's current effective giro (or NULL) -- reused below,
  -- never recomputed.
  v_effs := ARRAY(SELECT giro_authority.order_effective_giro_v1(u, p_operational_session_ids, v_trip)
                    FROM unnest(v_uids) AS u);

  -- Idempotent replay: the exact requested set is already the sole effective
  -- membership of one existing giro.
  IF (SELECT count(DISTINCT e) FROM unnest(v_effs) AS e WHERE e IS NOT NULL) = 1
     AND NOT EXISTS (SELECT 1 FROM unnest(v_effs) AS e WHERE e IS NULL) THEN
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_effs[1]], p_operational_session_ids, v_trip);
    IF d.effective_order_uids = v_uids THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', d.giro_id);
    END IF;
  END IF;

  -- Safety invariant shared with detach/move: never silently pull a member out of a
  -- giro whose rider already departed.
  FOR r IN SELECT DISTINCT e AS giro_id FROM unnest(v_effs) AS e WHERE e IS NOT NULL LOOP
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[r.giro_id], p_operational_session_ids, v_trip);
    IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', r.giro_id, 'giro_state', d.giro_state));
    END IF;
  END LOOP;

  v_moved := ARRAY(SELECT DISTINCT e FROM unnest(v_effs) AS e WHERE e IS NOT NULL);
  DELETE FROM giro_authority.giro_members WHERE order_uid = ANY (v_uids);

  v_id := giro_authority.insert_giro_v1(v_dates[1], v_hora, p_anchor_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(u, v_id, p_actor) FROM unnest(v_uids) AS u;
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', v_id, 'business_date', v_dates[1],
                            'order_uids', to_jsonb(v_uids), 'moved_from', to_jsonb(v_moved));
END $fn$;

CREATE OR REPLACE FUNCTION public.giro_authority_attach_or_move_v1(
  p_giro_id text, p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_from   text;
  v_trip   jsonb;
  v_reason text;
  d        record;
  dt       record;
  f        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_giro_id IS NULL OR p_order_uid IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;

  SELECT gm.giro_id INTO v_from FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;

  -- L1: target giro + (if different) the order's current giro, ascending id -- same
  -- two-giro lock discipline as move_v1. A nonexistent p_giro_id simply locks zero
  -- rows here; existence is authoritatively checked below via derive_giros_v1.
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = ANY (ARRAY[p_giro_id, v_from]::text[]) ORDER BY mg.id FOR UPDATE;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid]);
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = p_order_uid FOR SHARE;

  -- Re-read membership now that locks are held (may have changed since the unlocked
  -- read above).
  SELECT gm.giro_id INTO v_from FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;

  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO dt FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  IF dt.giro_id IS NULL THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;

  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  v_reason := giro_authority.member_refusal_v1(f.present, f.estado, f.delivery_type, f.table_session_id,
                                               f.in_active_trip, f.service_session_id, p_operational_session_ids);
  IF v_reason = 'ORDER_NOT_FOUND' THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_FOUND', NULL);
  ELSIF v_reason IS NOT NULL THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_ELIGIBLE', jsonb_build_object('reason', v_reason));
  END IF;

  -- Already effectively in the target -> idempotent, regardless of the raw v_from row.
  IF p_order_uid = ANY (dt.effective_order_uids) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_giro_id);
  END IF;

  IF dt.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', p_giro_id, 'giro_state', dt.giro_state));
  END IF;
  IF dt.giro_state <> 'PLANNED' THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_PLANNED', jsonb_build_object('giro_id', p_giro_id, 'state_reason', dt.state_reason));
  END IF;
  IF f.business_date IS DISTINCT FROM dt.business_date THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;

  -- Effectively in ANOTHER giro right now -> safety check, then move.
  IF v_from IS NOT NULL THEN
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_from], p_operational_session_ids, v_trip);
    IF p_order_uid = ANY (d.effective_order_uids) AND d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', v_from, 'giro_state', d.giro_state));
    END IF;
  END IF;

  -- put_member_v1 is itself an upsert (INSERT ... ON CONFLICT (order_uid) DO UPDATE),
  -- so the same call serves the unattached, same-target-already-handled-above, and
  -- other-giro cases uniformly -- no separate insert/update branch needed here.
  PERFORM giro_authority.put_member_v1(p_order_uid, p_giro_id, p_actor);
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id, 'order_uid', p_order_uid, 'moved_from', v_from);
END $fn$;

CREATE OR REPLACE FUNCTION public.giro_authority_detach_v1(
  p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_giro  text;
  v_again text;
  v_trip  jsonb;
  d       record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_order_uid IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  SELECT gm.giro_id INTO v_giro FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;
  IF v_giro IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'reason', 'NOT_A_MEMBER');
  END IF;
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_giro FOR UPDATE;                  -- L1
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid]);                              -- L2
  SELECT gm.giro_id INTO v_again FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;
  IF v_again IS DISTINCT FROM v_giro THEN
    RETURN giro_authority.refusal_v1('CONCURRENT_CHANGE', NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro], p_operational_session_ids, v_trip);
  IF NOT (p_order_uid = ANY (d.effective_order_uids)) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'reason', 'NOT_EFFECTIVE');
  END IF;
  IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_state', d.giro_state));
  END IF;
  DELETE FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid AND gm.giro_id = v_giro;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro], p_operational_session_ids, v_trip);
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', v_giro, 'giro_state_after', d.giro_state);
END $fn$;

CREATE OR REPLACE FUNCTION public.giro_authority_dissolve_v1(
  p_giro_id text, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip jsonb;
  d      record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_giro_id IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = p_giro_id FOR UPDATE;              -- L1
  IF NOT FOUND THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  IF d.dissolved_at IS NOT NULL OR d.giro_state = 'DISSOLVED' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_giro_id, 'state_reason', d.state_reason);
  END IF;
  IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_state', d.giro_state));
  END IF;
  UPDATE public.manual_giros mg
     SET dissolved_at = now(), dissolved_by = btrim(p_actor)
   WHERE mg.id = p_giro_id AND mg.dissolved_at IS NULL;
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id);
END $fn$;

-- Exact pre-133 body (migration 132), byte-for-byte, no L0 acquisition.
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
    PERFORM giro_authority.bump_facts_signal_v1();
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
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'GIRO_CREATED', v_new, p_actor, NULL);
END $function$;

-- Post-conditions: L0 gone from all five, no drift into any sibling.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('giro_authority_create_or_move_v1', 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'),
      ('giro_authority_attach_or_move_v1', 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'),
      ('giro_authority_detach_v1', 'public.giro_authority_detach_v1(uuid,text,uuid[])'),
      ('giro_authority_dissolve_v1', 'public.giro_authority_dissolve_v1(text,text,uuid[])'),
      ('giro_authority_consume_intent_v1', 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])')
    ) AS t(proname, sig)
  LOOP
    IF pg_get_functiondef(r.sig::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%' THEN
      RAISE EXCEPTION 'W6_1_LOCK_ORDER_ROLLBACK post-condition failed: % still carries L0 after rollback', r.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
