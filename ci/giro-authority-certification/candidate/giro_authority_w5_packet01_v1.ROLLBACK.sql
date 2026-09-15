-- PLANNER W5 PACKET 01 -- ROLLBACK candidate.
-- Drops the two new composite commands and the private signal-bump helper, restores
-- giro_authority_detach_v1/dissolve_v1 to their exact pre-131 (migration-130) bodies,
-- and removes the GIRO_FACTS_SIGNAL config row ONLY if it is still exactly at the
-- seeded state (version 0, never bumped by a real mutation) -- no blind destructive
-- rollback of data a real mutation may have produced.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NULL
     AND to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])') IS NULL
     AND to_regprocedure('giro_authority.bump_facts_signal_v1()') IS NULL THEN
    RAISE EXCEPTION 'W5_PACKET01_ROLLBACK refused: nothing to roll back -- packet is not applied';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.giro_authority_create_or_move_v1(uuid[], text, uuid, text, uuid[]);
DROP FUNCTION IF EXISTS public.giro_authority_attach_or_move_v1(text, uuid, text, uuid[]);

-- Exact pre-131 bodies (migration 130), byte-for-byte, no bump call.
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
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id);
END $fn$;

DROP FUNCTION IF EXISTS giro_authority.bump_facts_signal_v1();

-- Signal seed: remove ONLY if still untouched (version 0) since this packet's own
-- seed -- never destroy a version a real mutation produced.
DO $$
DECLARE
  v_version bigint;
BEGIN
  SELECT (valore::jsonb->>'version')::bigint INTO v_version FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL';
  IF v_version IS NULL THEN
    NULL; -- already absent, nothing to do
  ELSIF v_version = 0 THEN
    DELETE FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL';
  ELSE
    RAISE NOTICE 'W5_PACKET01_ROLLBACK: GIRO_FACTS_SIGNAL is at version % (bumped by a real mutation) -- left in place, not deleted', v_version;
  END IF;
END $$;

COMMIT;
