-- PLANNER W5 PACKET 01 — Single-Writer Giro Mutation + Cross-Tablet Facts Signal.
-- CANDIDATE for migration 131. Applies ON TOP of the already-certified/applied
-- migration 130 (giro_authority_v1). Certified only on ephemeral PostgreSQL
-- (ci/giro-authority-certification/harness). Never applied to staging/production
-- by this session.
--
-- WHAT IT ADDS
--   1. giro_authority.bump_facts_signal_v1() -- private helper, atomically
--      increments public.config.GIRO_FACTS_SIGNAL (version + updated_at) via a
--      single row-locked UPSERT. Called ONLY from within already-SECURITY-DEFINER
--      Authority commands -- itself stays a plain (non-DEFINER) private function,
--      executing with whatever privilege is already active (mirrors every other
--      giro_authority.*_v1 helper in migration 130).
--   2. public.giro_authority_create_or_move_v1(...) -- NEW command. Legacy
--      createManualGiro's silent-move-on-conflict semantics, expressed as ONE
--      atomic transaction (lock, validate, resolve existing membership, move
--      internally where required, create, write final memberships, bump the
--      signal once, return). Does NOT touch giro_authority_create_v1's own body
--      or its W3-N04 "no implicit move" invariant -- fully additive.
--   3. public.giro_authority_attach_or_move_v1(...) -- NEW command. One atomic
--      transaction handling unattached->attach, same-target->IDEMPOTENT, and
--      other-giro->move, decided entirely under DB lock. move_v1 alone refuses
--      ORDER_NOT_IN_GIRO for the unattached case (verified in its real body) so
--      cannot serve this by itself.
--   4. CREATE OR REPLACE giro_authority_detach_v1 / giro_authority_dissolve_v1 --
--      each body reproduced verbatim from the live migration-130 catalog with
--      exactly ONE inserted line (a bump call on the OK success path only, never
--      on IDEMPOTENT/refusal paths).
--   5. One config seed row: chiave='GIRO_FACTS_SIGNAL', valore = the JSON text
--      '{"version":0,"updated_at":"<now>"}'. Signal contains ONLY invalidation
--      metadata -- never order ids, giro ids, membership, state or salida.
--
-- WHAT IT NEVER DOES
--   Does not modify giro_authority_create_v1, giro_authority_attach_v1,
--   giro_authority_move_v1, giro_authority_set_hora_ref_v1,
--   giro_authority_consume_intent_v1, or giro_authority.capture_giro_intent_v1 --
--   all five stay byte-identical (checksummed before/after below). Installs no
--   trigger, column or constraint on public.ordenes. Writes no order/giro/
--   membership fact into public.config. No economic table or function touched.
--
-- LOCK PROTOCOL (identical discipline to migration 130's own commands)
--   giro row(s) first (L1, ascending id) -- including every giro any input order
--   currently, even staleley, points to -- then per-order advisory locks (L2,
--   ascending order_uid), then the entering orders FOR SHARE (L4). Never the
--   dispatch lock.

BEGIN;

-- 0. Predecessor, drift and idempotency preconditions ------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'giro_authority') THEN
    RAISE EXCEPTION 'W5_PACKET01 refused: schema giro_authority is missing -- migration 130 must be applied first';
  END IF;
  IF to_regprocedure('public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_attach_v1(text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_detach_v1(uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_move_v1(uuid,text,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_dissolve_v1(text,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'W5_PACKET01 refused: a migration-130 entry point is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NOT NULL
     OR to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])') IS NOT NULL
     OR to_regprocedure('giro_authority.bump_facts_signal_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'W5_PACKET01 refused: already applied -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL') THEN
    RAISE EXCEPTION 'W5_PACKET01 refused: public.config already carries GIRO_FACTS_SIGNAL -- resolve drift first';
  END IF;
END $$;

-- Snapshot the five untouched commands' checksums into a session temp table (plain
-- top-level SQL -- CREATE TEMP TABLE cannot run as a bare statement inside a DO
-- block's body) so the post-condition block below can assert byte-identity.
CREATE TEMP TABLE w5_packet01_untouched_before (proname text PRIMARY KEY, checksum text) ON COMMIT DROP;
INSERT INTO w5_packet01_untouched_before
  SELECT 'giro_authority_create_v1', md5(pg_get_functiondef('public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_attach_v1', md5(pg_get_functiondef('public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_move_v1', md5(pg_get_functiondef('public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_set_hora_ref_v1', md5(pg_get_functiondef('public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_consume_intent_v1', md5(pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'capture_giro_intent_v1', md5(pg_get_functiondef('giro_authority.capture_giro_intent_v1()'::regprocedure));

-- 1. Private signal-bump helper ------------------------------------------------------------
-- Atomic, lost-update-safe: a single UPDATE...SET valore = <computed from valore> takes
-- the row lock itself; a concurrent second bump blocks until the first commits, then
-- recomputes against the now-current row -- the standard safe UPDATE t SET x = x + 1
-- pattern, not a read-then-write race. Seeded once by this same migration (section 6),
-- so the ON CONFLICT branch is the one exercised by every real mutation.
CREATE FUNCTION giro_authority.bump_facts_signal_v1()
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.config (chiave, valore)
    VALUES ('GIRO_FACTS_SIGNAL', jsonb_build_object('version', 1, 'updated_at', now())::text)
  ON CONFLICT (chiave) DO UPDATE
    SET valore = jsonb_build_object(
          'version', COALESCE((public.config.valore::jsonb->>'version')::bigint, 0) + 1,
          'updated_at', now()
        )::text;
END $fn$;

-- 2. NEW: create_or_move -- legacy silent-move-on-create, atomically -----------------------
CREATE FUNCTION public.giro_authority_create_or_move_v1(
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

-- 3. NEW: attach_or_move -- unattached/same-target/other-giro, one atomic decision ----------
CREATE FUNCTION public.giro_authority_attach_or_move_v1(
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

-- 4. detach_v1 / dissolve_v1 -- verbatim migration-130 bodies + one bump insertion each ----
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

-- 5. Ownership, search_path, grants --------------------------------------------------------
ALTER FUNCTION giro_authority.bump_facts_signal_v1() OWNER TO postgres;
ALTER FUNCTION public.giro_authority_create_or_move_v1(uuid[], text, uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_attach_or_move_v1(text, uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_detach_v1(uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_dissolve_v1(text, text, uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION giro_authority.bump_facts_signal_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.giro_authority_create_or_move_v1(uuid[], text, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.giro_authority_attach_or_move_v1(text, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_create_or_move_v1(uuid[], text, uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_attach_or_move_v1(text, uuid, text, uuid[]) TO service_role;
-- detach_v1/dissolve_v1 already carry the correct grants from migration 130
-- (CREATE OR REPLACE preserves existing privileges); nothing to re-grant.

-- 6. Signal seed ----------------------------------------------------------------------------
INSERT INTO public.config (chiave, valore)
  VALUES ('GIRO_FACTS_SIGNAL', jsonb_build_object('version', 0, 'updated_at', now())::text);

-- 7. Post-conditions --------------------------------------------------------------------------
DO $$
DECLARE
  r      record;
  v_role text;
BEGIN
  -- The two new commands + the helper: owner, search_path, PUBLIC/anon/authenticated barred.
  FOR r IN SELECT p.oid, p.proname, p.pronamespace, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
             FROM pg_proc p
            WHERE p.oid IN ('giro_authority.bump_facts_signal_v1()'::regprocedure,
                            'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure,
                            'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure) LOOP
    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'W5_PACKET01 post-condition failed: % must be owned by postgres', r.proname;
    END IF;
    IF r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'W5_PACKET01 post-condition failed: % must pin search_path=pg_catalog, pg_temp', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'W5_PACKET01 post-condition failed: anon/authenticated may execute %', r.proname;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(COALESCE(
                 (SELECT p2.proacl FROM pg_proc p2 WHERE p2.oid = r.oid),
                 acldefault('f', (SELECT p3.proowner FROM pg_proc p3 WHERE p3.oid = r.oid)))) x
                WHERE x.grantee = 0) THEN
      RAISE EXCEPTION 'W5_PACKET01 post-condition failed: PUBLIC may execute %', r.proname;
    END IF;
    IF r.pronamespace = 'public'::regnamespace THEN
      IF NOT r.prosecdef OR NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'W5_PACKET01 post-condition failed: entry point % must be SECURITY DEFINER and executable by service_role', r.proname;
      END IF;
    ELSIF has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'W5_PACKET01 post-condition failed: service_role may execute private helper %', r.proname;
    END IF;
  END LOOP;

  -- The five untouched commands: byte-identical to their pre-apply checksum.
  FOR r IN SELECT proname, checksum AS before FROM w5_packet01_untouched_before LOOP
    DECLARE
      v_sig  regprocedure;
      v_now  text;
    BEGIN
      v_sig := CASE r.proname
        WHEN 'giro_authority_create_v1' THEN 'public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_attach_v1' THEN 'public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_move_v1' THEN 'public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_set_hora_ref_v1' THEN 'public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_consume_intent_v1' THEN 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure
        WHEN 'capture_giro_intent_v1' THEN 'giro_authority.capture_giro_intent_v1()'::regprocedure
      END;
      v_now := md5(pg_get_functiondef(v_sig));
      IF v_now <> r.before THEN
        RAISE EXCEPTION 'W5_PACKET01 post-condition failed: % changed (expected byte-identical to pre-131)', r.proname;
      END IF;
    END;
  END LOOP;

  -- Signal seed: exactly one row, version 0.
  IF (SELECT count(*) FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL') <> 1 THEN
    RAISE EXCEPTION 'W5_PACKET01 post-condition failed: GIRO_FACTS_SIGNAL must be exactly one config row';
  END IF;
  IF ((SELECT valore FROM public.config WHERE chiave = 'GIRO_FACTS_SIGNAL')::jsonb->>'version')::bigint <> 0 THEN
    RAISE EXCEPTION 'W5_PACKET01 post-condition failed: GIRO_FACTS_SIGNAL must seed at version 0';
  END IF;

  -- Still fully dormant: no trigger on ordenes references the Authority (capture is
  -- a separate, still-not-installed W5 artifact).
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE t.tgrelid = 'public.ordenes'::regclass AND p.pronamespace = 'giro_authority'::regnamespace) THEN
    RAISE EXCEPTION 'W5_PACKET01 post-condition failed: a trigger on ordenes uses the Authority (still not this packet''s job)';
  END IF;
END $$;

COMMIT;
