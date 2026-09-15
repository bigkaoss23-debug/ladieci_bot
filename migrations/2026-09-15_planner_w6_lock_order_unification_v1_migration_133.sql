-- PLANNER W6.1 LOCK-ORDER UNIFICATION -- CANDIDATE for migration 133. Applies ON TOP of
-- the already-applied migrations 130 (giro_authority_v1), 131 (W5 Packet 01) and 132
-- (W5 Intent Activation). Certified only on ephemeral PostgreSQL (ci/giro-authority-
-- certification/harness). Never applied to staging/production by this session.
--
-- WHAT IT ADDS
--   Exactly one inserted statement -- PERFORM pg_advisory_xact_lock(hashtext(
--   'LA_DIECI_DRIVER_STATO')); -- in each of the five LIVE Giro Authority commands:
--     1. giro_authority_create_or_move_v1
--     2. giro_authority_attach_or_move_v1
--     3. giro_authority_detach_v1
--     4. giro_authority_dissolve_v1
--     5. giro_authority_consume_intent_v1
--   In every one of the five, the new statement is placed AFTER pure input validation
--   (actor/scope/shape checks that touch no shared state) and BEFORE the first Giro L1
--   lock (public.manual_giros ... FOR UPDATE, conditional in consume_intent_v1's GIRO
--   branch) and before every call to giro_authority.trip_facts_v1() -- both hard
--   requirements are satisfied by the same single insertion point in each function,
--   verified below by a textual-position post-condition against every live command's
--   own pg_get_functiondef() output.
--
-- WHY (the race this closes)
--   public.start_rider_trip (2026-07-20_rider_trip_rpcs.sql) and
--   public.rider_collect_and_complete_stop (2026-07-27_s2_7d6e3a_rider_ledger_writer_
--   additive.sql) each already take pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_
--   STATO')) as their own first substantive step, before touching public.ordenes or
--   public.config's DRIVER_STATO row. Migration 130's own header recorded this
--   explicitly: "The dispatch lock (LA_DIECI_DRIVER_STATO) is never taken" by any Giro
--   Authority command -- true through 132. Because neither side of the pairing took the
--   SAME lock, a Giro Authority command (e.g. detach_v1) could read giro_authority.
--   trip_facts_v1() (unlocked, STABLE, reflects public.config at read time) and derive
--   membership/state from it, while a concurrent start_rider_trip committed a trip start
--   (updating DRIVER_STATO and the member orders' estado to EN_ENTREGA) in between --
--   a classic TOCTOU: the command's derived state could go stale between its read and
--   its own commit, with no lock relationship between the two transactions forcing an
--   ordering. Verified on the live checksums above (2026-09-15): both real functions
--   already carry the lock; this migration is the missing other half.
--
-- WHAT IT NEVER DOES
--   Does not modify giro_authority_create_v1, giro_authority_attach_v1,
--   giro_authority_move_v1, giro_authority_set_hora_ref_v1, giro_authority.
--   bump_facts_signal_v1, giro_authority.capture_giro_intent_v1,
--   giro_authority_list_pending_intents_v1, or giro_projection_v1 -- all stay
--   byte-identical (checksummed before/after below). Does not touch public.
--   rider_collect_and_complete_stop, public.start_rider_trip, public.close_rider_trip,
--   public._ledger_write_payment or public.order_mark_paid -- none of them need a
--   change: rider_collect_and_complete_stop and start_rider_trip already take L0 first
--   and neither ever locks public.manual_giros FOR UPDATE, so there is no inversion to
--   fix on their side (verified against the live staging checksums quoted above, both
--   byte-identical to their migrations/ source; this migration only checksums-and-
--   re-asserts that invariant rather than re-declaring either function). Writes no new
--   column, table, trigger or constraint. Grants no new privilege -- every touched
--   function is CREATE OR REPLACE on an existing signature, so ownership and EXECUTE
--   grants (postgres / service_role-only, set in migration 130/131/132) are preserved
--   automatically; nothing to re-grant. Changes no outcome/refusal code, no money
--   sequencing, no membership rule, no derived-state precedence -- same inputs still
--   produce the same jsonb outcome for every call that was not itself blocked on the
--   new lock while a concurrent departure/collection held it.
--
-- UPDATED LOCK PROTOCOL (every one of the five live commands, always in this order)
--   L0 pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'))    -- NEW (this migration)
--      the same single global lock start_rider_trip and rider_collect_and_complete_stop
--      already take first; whichever side acquires it first now fully serializes
--      against the other for the remainder of its transaction.
--   L1 public.manual_giros rows FOR UPDATE, ascending id (unchanged, conditional in
--      consume_intent_v1's GIRO branch)
--   L2 per-order advisory xact locks, ascending order_uid (unchanged)
--   L3 the intent row FOR UPDATE (consume only, CAS; unchanged)
--   L4 public.ordenes rows of the entering orders FOR SHARE (unchanged)
--   trip_facts_v1() reads (unchanged position relative to L1-L4; now always after L0)

BEGIN;

-- 0. Predecessor, drift and idempotency preconditions ------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_detach_v1(uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_dissolve_v1(text,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_attach_v1(text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_move_v1(uuid,text,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])') IS NULL
     OR to_regprocedure('giro_authority.bump_facts_signal_v1()') IS NULL
     OR to_regprocedure('giro_authority.capture_giro_intent_v1()') IS NULL
     OR to_regprocedure('public.giro_authority_list_pending_intents_v1(uuid[],integer)') IS NULL
     OR to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NULL
     OR to_regprocedure('public.start_rider_trip(text)') IS NULL THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER refused: a migration-130/131/132 entry point or a required predecessor RPC is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.giro_projection_v1(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER refused: giro_projection_v1 is missing -- resolve drift first';
  END IF;
  IF pg_get_functiondef('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%'
     OR pg_get_functiondef('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%'
     OR pg_get_functiondef('public.giro_authority_detach_v1(uuid,text,uuid[])'::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%'
     OR pg_get_functiondef('public.giro_authority_dissolve_v1(text,text,uuid[])'::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%'
     OR pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure) ILIKE '%LA_DIECI_DRIVER_STATO%' THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER refused: at least one target command already carries the L0 lock -- resolve drift first';
  END IF;
END $$;

-- Snapshot every sibling this migration must leave byte-identical.
CREATE TEMP TABLE w6_1_untouched_before (proname text PRIMARY KEY, checksum text) ON COMMIT DROP;
INSERT INTO w6_1_untouched_before
  SELECT 'giro_authority_create_v1', md5(pg_get_functiondef('public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_attach_v1', md5(pg_get_functiondef('public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_move_v1', md5(pg_get_functiondef('public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_set_hora_ref_v1', md5(pg_get_functiondef('public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'bump_facts_signal_v1', md5(pg_get_functiondef('giro_authority.bump_facts_signal_v1()'::regprocedure))
  UNION ALL SELECT 'capture_giro_intent_v1', md5(pg_get_functiondef('giro_authority.capture_giro_intent_v1()'::regprocedure))
  UNION ALL SELECT 'giro_authority_list_pending_intents_v1', md5(pg_get_functiondef('public.giro_authority_list_pending_intents_v1(uuid[],integer)'::regprocedure))
  UNION ALL SELECT 'giro_projection_v1', md5(pg_get_functiondef('public.giro_projection_v1(uuid[])'::regprocedure))
  UNION ALL SELECT 'rider_collect_and_complete_stop', md5(pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure))
  UNION ALL SELECT 'start_rider_trip', md5(pg_get_functiondef('public.start_rider_trip(text)'::regprocedure));

-- 1. giro_authority_create_or_move_v1 -- verbatim migration-131 body + L0 inserted -------
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

  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

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

-- 2. giro_authority_attach_or_move_v1 -- verbatim migration-131 body + L0 inserted -------
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

  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

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

-- 3. giro_authority_detach_v1 -- verbatim migration-131 body + L0 inserted --------------
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
  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
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

-- 4. giro_authority_dissolve_v1 -- verbatim migration-131 body + L0 inserted ------------
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
  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
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

-- 5. giro_authority_consume_intent_v1 -- verbatim migration-132 body + L0 inserted ------
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
  -- L0 (W6.1): the same dispatch lock start_rider_trip/rider_collect_and_complete_stop
  -- already take first -- must precede every Giro lock and trip-facts read below,
  -- including the conditional L1 acquisition (GIRO target) two lines down.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
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

-- 6. Ownership, search_path, grants -------------------------------------------------------
-- Every function above is CREATE OR REPLACE on an existing public entry point signature;
-- PostgreSQL preserves ownership (postgres) and existing EXECUTE grants (service_role
-- only, PUBLIC/anon/authenticated barred -- set in migrations 130/131/132) automatically.
-- Nothing to re-grant.

-- 7. Post-conditions --------------------------------------------------------------------------
DO $$
DECLARE
  r       record;
  v_src   text;
  v_l0    integer;
  v_trip  integer;
BEGIN
  -- Each of the five live commands: owner/search_path/grants unchanged (CREATE OR
  -- REPLACE never alters these), AND now carries exactly one L0 acquisition, AND that
  -- acquisition textually precedes the function's own first trip_facts_v1() call --
  -- the static proof that L0 precedes every Giro L1/L2/L3/L4 lock and every trip-facts
  -- read in each of the five (trip_facts_v1() is called downstream of L1 in every one
  -- of them, verified by inspection when this migration was authored).
  FOR r IN SELECT * FROM (VALUES
      ('giro_authority_create_or_move_v1', 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'),
      ('giro_authority_attach_or_move_v1', 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'),
      ('giro_authority_detach_v1', 'public.giro_authority_detach_v1(uuid,text,uuid[])'),
      ('giro_authority_dissolve_v1', 'public.giro_authority_dissolve_v1(text,text,uuid[])'),
      ('giro_authority_consume_intent_v1', 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])')
    ) AS t(proname, sig)
  LOOP
    v_src := pg_get_functiondef(r.sig::regprocedure);
    IF (length(v_src) - length(replace(v_src, 'pg_advisory_xact_lock(hashtext(''LA_DIECI_DRIVER_STATO''))', ''))) /
       length('pg_advisory_xact_lock(hashtext(''LA_DIECI_DRIVER_STATO''))') <> 1 THEN
      RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: % must contain exactly one L0 acquisition', r.proname;
    END IF;
    v_l0 := position('LA_DIECI_DRIVER_STATO' IN v_src);
    v_trip := position('trip_facts_v1(' IN v_src);
    IF v_l0 = 0 OR v_trip = 0 OR v_l0 > v_trip THEN
      RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: % must acquire L0 before its first trip_facts_v1() call', r.proname;
    END IF;
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = r.sig::regprocedure)) <> 'postgres' THEN
      RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: % must stay owned by postgres', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('anon', r.sig::regprocedure, 'EXECUTE')
       OR has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: % grants must stay service_role-only', r.proname;
    END IF;
  END LOOP;

  -- rider_collect_and_complete_stop and start_rider_trip: untouched by this migration
  -- (checksum below), and independently re-verified here to already satisfy the same
  -- invariant this migration establishes for the five Giro commands -- L0 acquired, and
  -- (for rider_collect_and_complete_stop specifically) no FOR UPDATE lock ever taken on
  -- public.manual_giros, so there is no path in either function that could acquire L1
  -- and only later reach L0.
  v_src := pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure);
  IF v_src NOT ILIKE '%LA_DIECI_DRIVER_STATO%' THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: rider_collect_and_complete_stop no longer takes L0';
  END IF;
  IF v_src ILIKE '%manual_giros%' THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: rider_collect_and_complete_stop now references manual_giros -- lock-order compatibility assumption broken, this migration must be revisited';
  END IF;
  v_src := pg_get_functiondef('public.start_rider_trip(text)'::regprocedure);
  IF v_src NOT ILIKE '%LA_DIECI_DRIVER_STATO%' THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: start_rider_trip no longer takes L0';
  END IF;
  IF position('LA_DIECI_DRIVER_STATO' IN v_src) > NULLIF(position('manual_giros' IN v_src), 0) THEN
    RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: start_rider_trip references manual_giros before acquiring L0';
  END IF;

  -- Every sibling this migration does not intend to touch: byte-identical to its
  -- pre-133 checksum.
  FOR r IN SELECT proname, checksum AS before FROM w6_1_untouched_before LOOP
    DECLARE
      v_sig regprocedure;
      v_now text;
    BEGIN
      v_sig := CASE r.proname
        WHEN 'giro_authority_create_v1' THEN 'public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_attach_v1' THEN 'public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_move_v1' THEN 'public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_set_hora_ref_v1' THEN 'public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure
        WHEN 'bump_facts_signal_v1' THEN 'giro_authority.bump_facts_signal_v1()'::regprocedure
        WHEN 'capture_giro_intent_v1' THEN 'giro_authority.capture_giro_intent_v1()'::regprocedure
        WHEN 'giro_authority_list_pending_intents_v1' THEN 'public.giro_authority_list_pending_intents_v1(uuid[],integer)'::regprocedure
        WHEN 'giro_projection_v1' THEN 'public.giro_projection_v1(uuid[])'::regprocedure
        WHEN 'rider_collect_and_complete_stop' THEN 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure
        WHEN 'start_rider_trip' THEN 'public.start_rider_trip(text)'::regprocedure
      END;
      v_now := md5(pg_get_functiondef(v_sig));
      IF v_now <> r.before THEN
        RAISE EXCEPTION 'W6_1_LOCK_ORDER post-condition failed: % changed (expected byte-identical to pre-133)', r.proname;
      END IF;
    END;
  END LOOP;
END $$;

COMMIT;
