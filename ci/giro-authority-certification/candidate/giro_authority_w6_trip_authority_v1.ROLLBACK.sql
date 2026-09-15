-- PLANNER W6.2 TRIP AUTHORITY FOUNDATION -- ROLLBACK candidate.
-- Restores giro_authority.trip_facts_v1() to its exact pre-134 (migration-130) body,
-- byte-for-byte, drops the two dormant public entry points (start_rider_trip_v2,
-- trip_projection_v1), and drops the entire trip_authority schema (trips, trip_members,
-- their trigger/function, the sequence) cleanly.
--
-- PONR (point of no return): this rollback is only safe while trip_authority.trips is
-- EMPTY. It refuses outright if a single canonical trip row exists -- once a real trip
-- has been recorded canonically, dropping the schema would destroy operational history
-- with no compatibility story, so the rollback path closes here by design rather than
-- attempting a data migration back into DRIVER_STATO.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL
     AND to_regprocedure('public.trip_projection_v1(uuid[])') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority') THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY_ROLLBACK refused: nothing to roll back -- migration 134 is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority')
     AND EXISTS (SELECT 1 FROM trip_authority.trips) THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY_ROLLBACK refused: trip_authority.trips is NOT empty -- this is the PONR, rollback stops here by design (real canonical trip history exists; no destructive path back to DRIVER_STATO is attempted)';
  END IF;
END $$;

-- Exact pre-134 body (migration 130), byte-for-byte.
CREATE OR REPLACE FUNCTION giro_authority.trip_facts_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_raw    text;
  v_ds     jsonb;
  v_active jsonb;
  v_giros  jsonb;
BEGIN
  SELECT c.valore INTO v_raw FROM public.config c WHERE c.chiave = 'DRIVER_STATO';
  IF NOT FOUND OR v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb);
  END IF;
  BEGIN
    v_ds := v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('available', false, 'reason', 'DRIVER_STATO_UNPARSEABLE');
  END;
  IF jsonb_typeof(v_ds) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'DRIVER_STATO_NOT_OBJECT');
  END IF;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);
  IF v_active IS NULL THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(v_active) <> 'object' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'ACTIVE_TRIP_MALFORMED');
  END IF;
  IF (v_active->>'status') IS DISTINCT FROM 'ACTIVE' THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(v_active->'order_ids') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'ACTIVE_TRIP_MALFORMED');
  END IF;
  v_giros := COALESCE(NULLIF(v_active->'manual_giro_ids', 'null'::jsonb), '[]'::jsonb);
  IF jsonb_typeof(v_giros) <> 'array' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'ACTIVE_TRIP_MALFORMED');
  END IF;
  RETURN jsonb_build_object('available', true, 'active', true, 'trip_id', v_active->>'trip_id',
                            'order_ids', v_active->'order_ids', 'giro_ids', v_giros);
END $fn$;

DROP FUNCTION IF EXISTS public.start_rider_trip_v2(uuid, text, integer, uuid[]);
DROP FUNCTION IF EXISTS public.trip_projection_v1(uuid[]);

-- trip_authority.trips is proven empty by the precondition above; trip_members
-- (its FK child) is therefore necessarily empty too. DROP TABLE removes the trigger
-- INSTANCE but not the trigger FUNCTION it calls, so every function created inside
-- the schema must be dropped explicitly too -- deliberately no CASCADE anywhere,
-- matching every other Authority rollback's convention (an explicit, enumerated drop
-- forces this list to stay exhaustive and reviewable, rather than silently taking
-- out an object no one accounted for).
DROP TABLE IF EXISTS trip_authority.trip_members;
DROP TABLE IF EXISTS trip_authority.trips;
DROP FUNCTION IF EXISTS trip_authority.trip_members_append_only_v1();
DROP FUNCTION IF EXISTS trip_authority.freeze_members_v1(uuid, uuid[], text);
DROP FUNCTION IF EXISTS trip_authority.trip_facts_canonical_v1();
DROP SEQUENCE IF EXISTS trip_authority.trips_seq_v1;
DROP SCHEMA IF EXISTS trip_authority;

-- Post-conditions: canonical fallback gone from trip_facts_v1, schema gone, dormant
-- entry points gone.
DO $$
BEGIN
  IF pg_get_functiondef('giro_authority.trip_facts_v1()'::regprocedure) ILIKE '%trip_authority%' THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY_ROLLBACK post-condition failed: trip_facts_v1 still references trip_authority';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority') THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY_ROLLBACK post-condition failed: schema trip_authority still exists';
  END IF;
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NOT NULL
     OR to_regprocedure('public.trip_projection_v1(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY_ROLLBACK post-condition failed: a dormant entry point still exists';
  END IF;
END $$;

COMMIT;
