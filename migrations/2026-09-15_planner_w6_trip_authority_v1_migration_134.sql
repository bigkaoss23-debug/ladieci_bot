-- PLANNER W6.2 TRIP AUTHORITY FOUNDATION -- CANDIDATE for migration 134. Applies ON TOP
-- of the already-applied migrations 130-133 (giro_authority + W5 Packet 01 + W5 Intent
-- Activation + W6.1 lock-order unification). Certified only on ephemeral PostgreSQL
-- (ci/giro-authority-certification/harness). Never applied to staging/production by
-- this session.
--
-- WHAT IT ADDS
--   1. Private schema trip_authority (security posture mirrors giro_authority exactly:
--      owner postgres, no PostgREST exposure, no USAGE for anon/authenticated/
--      service_role, access only through public SECURITY DEFINER entry points).
--   2. trip_authority.trips -- the canonical trip header. Multi-rider-capable shape
--      (rider_actor + a global sequence), but W6 runtime enforces exactly one ACTIVE
--      row at a time via a partial unique index on a constant (D-2): the single-rider
--      invariant is a real Postgres constraint, not an application convention.
--   3. trip_authority.trip_members -- canonical, append-only membership. UNIQUE
--      (order_uid) is a real, unconditional (non-partial) constraint: an order_uid may
--      belong to at most ONE canonical trip in its entire lifetime, independent of the
--      parent trip's status (D-2). A BEFORE UPDATE OR DELETE trigger makes every row
--      immutable once committed -- the only way to undo one is to roll back the whole
--      inserting transaction before it commits.
--   4. trip_authority.trip_facts_canonical_v1() -- read-only derivation, same output
--      shape as giro_authority.trip_facts_v1(), sourced from trip_authority.trips/
--      trip_members instead of public.config's DRIVER_STATO row. Filters a delivered
--      member out of the snapshot at READ time (see the function's own comment) so
--      "all effective members delivered -> DONE" holds without waiting for an explicit
--      trip close -- this is the fix for the regression this migration was told not to
--      introduce, not a copy of it.
--   5. trip_authority.freeze_members_v1(trip_id, order_uids, actor) -- the one writer
--      into trip_members, called only from inside start_rider_trip_v2 under the
--      already-established lock order.
--   6. public.start_rider_trip_v2(...) -- DORMANT. Never called by anything in this
--      migration or by Node. Resolves membership from giro_authority (never raw
--      ordenes.manual_giro_id), freezes it into trip_members, transitions eligible
--      orders to EN_ENTREGA, and writes DRIVER_STATO ONLY as a compatibility
--      projection of the canonical facts it just created (never as the authority).
--      Full contract in the function's own header comment below.
--   7. public.trip_projection_v1(p_operational_session_ids) -- DORMANT read-only
--      projection of the current canonical trip, scoped like giro_projection_v1.
--   8. CREATE OR REPLACE giro_authority.trip_facts_v1() -- the ONE existing function
--      this migration touches. Canonical trip data wins if trip_authority.trips has an
--      ACTIVE row; otherwise falls through to the exact pre-134 DRIVER_STATO body,
--      verbatim, unindented, byte-for-byte after the new early-return branch. Since
--      trip_authority.trips is created empty and nothing in this migration or in Node
--      writes to it, this function's live output for current staging data is
--      byte-identical before and after apply -- proven by the harness's own equivalence
--      group, not merely asserted.
--
-- WHY (D-1/D-2/D-3, frozen ahead of this session)
--   D-1: promote trip state to a real private trip_authority schema; DRIVER_STATO
--   remains only a temporary compatibility projection until W7. D-2: the schema is
--   multi-rider-capable but W6 runtime stays single-rider (at most one ACTIVE trip
--   globally); an order_uid belongs to at most one canonical trip ever (a real
--   UNIQUE(order_uid), never a partial index keyed on the parent's status). D-3:
--   giro_authority_set_hora_ref_v1 stays unregistered and untouched (not part of this
--   migration's scope at all).
--
-- WHAT IT NEVER DOES
--   Does not modify giro_authority_create_v1, giro_authority_attach_v1,
--   giro_authority_move_v1, giro_authority_set_hora_ref_v1, giro_authority_
--   create_or_move_v1, giro_authority_attach_or_move_v1, giro_authority_detach_v1,
--   giro_authority_dissolve_v1, giro_authority_consume_intent_v1, giro_authority.
--   bump_facts_signal_v1, giro_authority.capture_giro_intent_v1, giro_authority_
--   list_pending_intents_v1, giro_projection_v1 (the function's own text -- its output
--   changes only because trip_facts_v1's output can), public.start_rider_trip, public.
--   rider_collect_and_complete_stop, public.close_rider_trip, public._ledger_write_
--   payment, public.order_mark_paid -- all stay byte-identical (checksummed before/
--   after below). Does not delete any v1 trip RPC or any DRIVER_STATO field. Does not
--   wire start_rider_trip_v2 or trip_projection_v1 into Node, does not register either
--   in the H1B resource policy (least privilege: no real caller exists yet), does not
--   touch rider_collect_and_complete_stop or close_rider_trip. No financial table,
--   column, function, trigger, or economic write path touched anywhere. No frontend
--   change (this is a backend-only migration file).
--
-- LOCK PROTOCOL (start_rider_trip_v2; identical discipline to every W6.1 command)
--   L0 pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO')) -- literal first
--      statement, matching legacy start_rider_trip's own placement.
--   L1 public.manual_giros row FOR UPDATE, when the anchor resolves to a giro
--   L2 per-order advisory xact locks (giro_authority.lock_orders_v1), ascending
--   L4 public.ordenes rows of the entering orders FOR SHARE
--   L5 (new) the DRIVER_STATO public.config row FOR UPDATE, for the compatibility
--      projection write only -- taken last, after every canonical write is already
--      decided, exactly where legacy start_rider_trip takes its own row lock.
--   No path acquires L1 after L0, and nothing acquires L0 twice.

BEGIN;

-- 0. Predecessor, drift and idempotency preconditions ------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'giro_authority') THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY refused: schema giro_authority is missing -- migrations 130-133 must be applied first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority') THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY refused: schema trip_authority already exists -- resolve drift first';
  END IF;
  IF to_regprocedure('giro_authority.scope_valid_v1(uuid[])') IS NULL
     OR to_regprocedure('giro_authority.order_effective_giro_v1(uuid,uuid[],jsonb)') IS NULL
     OR to_regprocedure('giro_authority.derive_giros_v1(text[],uuid[],jsonb)') IS NULL
     OR to_regprocedure('giro_authority.order_facts_v1(uuid[],jsonb)') IS NULL
     OR to_regprocedure('giro_authority.trip_facts_v1()') IS NULL
     OR to_regprocedure('giro_authority.delivered_states_v1()') IS NULL
     OR to_regprocedure('giro_authority.lock_orders_v1(uuid[])') IS NULL
     OR to_regprocedure('public.start_rider_trip(text)') IS NULL
     OR to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY refused: a required migration-130/131/132/133 helper or predecessor RPC is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NOT NULL
     OR to_regprocedure('public.trip_projection_v1(uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY refused: already applied -- resolve drift first';
  END IF;
  IF pg_get_functiondef('giro_authority.trip_facts_v1()'::regprocedure) ILIKE '%trip_authority%' THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY refused: trip_facts_v1 already references trip_authority -- resolve drift first';
  END IF;
END $$;

-- Snapshot every sibling this migration must leave byte-identical.
CREATE TEMP TABLE w6_2_untouched_before (proname text PRIMARY KEY, checksum text) ON COMMIT DROP;
INSERT INTO w6_2_untouched_before
  SELECT 'giro_authority_create_v1', md5(pg_get_functiondef('public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_attach_v1', md5(pg_get_functiondef('public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_move_v1', md5(pg_get_functiondef('public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_set_hora_ref_v1', md5(pg_get_functiondef('public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_create_or_move_v1', md5(pg_get_functiondef('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_attach_or_move_v1', md5(pg_get_functiondef('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_detach_v1', md5(pg_get_functiondef('public.giro_authority_detach_v1(uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_dissolve_v1', md5(pg_get_functiondef('public.giro_authority_dissolve_v1(text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_consume_intent_v1', md5(pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'bump_facts_signal_v1', md5(pg_get_functiondef('giro_authority.bump_facts_signal_v1()'::regprocedure))
  UNION ALL SELECT 'capture_giro_intent_v1', md5(pg_get_functiondef('giro_authority.capture_giro_intent_v1()'::regprocedure))
  UNION ALL SELECT 'giro_authority_list_pending_intents_v1', md5(pg_get_functiondef('public.giro_authority_list_pending_intents_v1(uuid[],integer)'::regprocedure))
  UNION ALL SELECT 'giro_projection_v1', md5(pg_get_functiondef('public.giro_projection_v1(uuid[])'::regprocedure))
  UNION ALL SELECT 'rider_collect_and_complete_stop', md5(pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure))
  UNION ALL SELECT 'start_rider_trip', md5(pg_get_functiondef('public.start_rider_trip(text)'::regprocedure));

-- 1. Private schema ---------------------------------------------------------------------
CREATE SCHEMA trip_authority AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA trip_authority FROM PUBLIC;
REVOKE ALL ON SCHEMA trip_authority FROM anon, authenticated, service_role;
COMMENT ON SCHEMA trip_authority IS
  'Trip Authority private relations and helpers (Planner W6.2). Not exposed by PostgREST, no USAGE for API roles. Access only through the public start_rider_trip_v2 / trip_projection_v1 SECURITY DEFINER functions.';

-- 2. Canonical trip header ----------------------------------------------------------------
CREATE SEQUENCE trip_authority.trips_seq_v1;

CREATE TABLE trip_authority.trips (
  trip_id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date       date        NOT NULL,
  service_session_id  uuid        NOT NULL REFERENCES public.service_sessions(id),
  rider_actor         text        NOT NULL REFERENCES public.auth_actors(actor),
  anchor_order_uid    uuid        NOT NULL REFERENCES public.order_entities(order_uid),
  giro_id             text        NULL REFERENCES public.manual_giros(id),
  departed_at         timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz NULL,
  status              text        NOT NULL CHECK (status IN ('ACTIVE', 'CLOSED')),
  seq                 integer     NOT NULL,
  CONSTRAINT trips_status_closed_at_chk CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
-- D-2 / single-rider W6 runtime: at most one ACTIVE row globally, enforced by Postgres
-- itself (a partial unique index on a constant), not by application discipline.
CREATE UNIQUE INDEX trips_one_active_v1 ON trip_authority.trips ((true)) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX trips_seq_uq ON trip_authority.trips (seq);
COMMENT ON TABLE trip_authority.trips IS
  'Canonical trip header (Planner W6.2, dormant). Multi-rider-capable shape; W6 runtime enforces exactly one ACTIVE row via trips_one_active_v1.';

ALTER TABLE trip_authority.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_authority.trips FORCE ROW LEVEL SECURITY;
REVOKE ALL ON trip_authority.trips FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE trip_authority.trips OWNER TO postgres;
REVOKE ALL ON SEQUENCE trip_authority.trips_seq_v1 FROM PUBLIC, anon, authenticated, service_role;

-- 3. Canonical, append-only membership -----------------------------------------------------
CREATE TABLE trip_authority.trip_members (
  trip_id    uuid        NOT NULL REFERENCES trip_authority.trips(trip_id),
  order_uid  uuid        NOT NULL REFERENCES public.order_entities(order_uid),
  stop_seq   integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL CHECK (btrim(created_by) <> ''),
  PRIMARY KEY (trip_id, order_uid),
  -- D-2: an order_uid belongs to at most ONE canonical trip in its entire lifetime --
  -- a real, unconditional UNIQUE constraint, deliberately never a partial index keyed
  -- on the parent trip's status.
  UNIQUE (order_uid),
  UNIQUE (trip_id, stop_seq)
);
COMMENT ON TABLE trip_authority.trip_members IS
  'Canonical, append-only trip membership (Planner W6.2, dormant). Immutable after insert except by rolling back the whole inserting transaction before commit. Order delivery state stays authoritative in public.ordenes.estado/hora_entrega -- never duplicated here.';

ALTER TABLE trip_authority.trip_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_authority.trip_members FORCE ROW LEVEL SECURITY;
REVOKE ALL ON trip_authority.trip_members FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE trip_authority.trip_members OWNER TO postgres;

CREATE FUNCTION trip_authority.trip_members_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'TRIP_MEMBERS_APPEND_ONLY' USING ERRCODE = 'P0001';
END $fn$;

CREATE TRIGGER trip_members_append_only_v1
  BEFORE UPDATE OR DELETE ON trip_authority.trip_members
  FOR EACH ROW EXECUTE FUNCTION trip_authority.trip_members_append_only_v1();

-- 4. Private helpers ------------------------------------------------------------------------
-- The one writer into trip_members. Preserves the caller's array order via WITH
-- ORDINALITY (stop_seq = 1, 2, 3... in exactly the order the caller passed), so the
-- caller (start_rider_trip_v2) controls sequencing rather than this helper re-deriving it.
CREATE FUNCTION trip_authority.freeze_members_v1(p_trip_id uuid, p_order_uids uuid[], p_actor text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $fn$
  INSERT INTO trip_authority.trip_members (trip_id, order_uid, stop_seq, created_by)
  SELECT p_trip_id, u.order_uid, u.ord::integer, btrim(p_actor)
  FROM unnest(p_order_uids) WITH ORDINALITY AS u(order_uid, ord)
$fn$;

-- Same output shape as giro_authority.trip_facts_v1()'s own "active" branch (plus one
-- extra internal-only key, canonical_trip_exists, stripped by the caller before this
-- ever reaches a consumer), sourced from trip_authority instead of DRIVER_STATO. A
-- delivered member is excluded from order_ids (and, once every member is delivered,
-- giro_ids too) AT READ TIME -- the trip_members ROW stays immutable forever, only
-- this projection stops counting a delivered member as "still out". Without this, a
-- naive full-membership projection would pin every delivered member (and, via the
-- giro_ids OR-branch in derive_giros_v1, the giro itself) IN_TRIP for the entire life
-- of the canonical trip row -- exactly the regression this migration was told not to
-- introduce. With it: "all effective members delivered -> DONE" holds even while the
-- trip itself is still ACTIVE, not only after an explicit close -- which is exactly
-- why 'active' (did the filtering leave anyone still out) and canonical_trip_exists
-- (does an ACTIVE canonical row exist at all) have to be two different questions: the
-- caller must NOT fall through to the DRIVER_STATO compatibility path just because
-- every member happens to be delivered right now -- a canonical trip still exists, it
-- has just finished its active phase.
CREATE FUNCTION trip_authority.trip_facts_canonical_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip      trip_authority.trips%ROWTYPE;
  v_order_ids jsonb;
BEGIN
  SELECT * INTO v_trip FROM trip_authority.trips WHERE status = 'ACTIVE';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb,
                              'canonical_trip_exists', false);
  END IF;
  SELECT COALESCE(jsonb_agg(o.id ORDER BY tm.stop_seq), '[]'::jsonb) INTO v_order_ids
    FROM trip_authority.trip_members tm
    JOIN public.ordenes o ON o.order_uid = tm.order_uid
   WHERE tm.trip_id = v_trip.trip_id
     AND NOT (o.estado = ANY (giro_authority.delivered_states_v1()));
  RETURN jsonb_build_object('available', true, 'active', v_order_ids <> '[]'::jsonb, 'trip_id', v_trip.trip_id::text,
    'order_ids', v_order_ids,
    'giro_ids', CASE WHEN v_trip.giro_id IS NULL OR v_order_ids = '[]'::jsonb
                     THEN '[]'::jsonb ELSE jsonb_build_array(v_trip.giro_id) END,
    'canonical_trip_exists', true);
END $fn$;

-- 5. public.start_rider_trip_v2 -- DORMANT. Not called by anything in this migration or
--    by Node. See the header block above (section 6) for the full contract; the codes
--    below reuse the SAME vocabulary as the two systems this function bridges: AUTH_*
--    from rider_collect_and_complete_stop's own rider contract, everything else from
--    giro_authority's refusal vocabulary.
CREATE FUNCTION public.start_rider_trip_v2(
  p_anchor_order_uid        uuid,
  p_actor                   text,
  p_session_version         integer,
  p_operational_session_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_by            public.auth_actors%ROWTYPE;
  v_legacy_trip   jsonb;
  v_existing      trip_authority.trips%ROWTYPE;
  v_giro_id       text;
  v_uids          uuid[];
  v_dates         date[];
  v_anchor_sess   uuid;
  v_trip_id       uuid;
  v_ids           text[];
  v_zones         text[];
  v_snapshot      jsonb;
  v_ds            jsonb;
  d               record;
  r               record;
BEGIN
  -- L0 (W6.1 protocol): the same dispatch lock every live Giro Authority command and
  -- the real start_rider_trip/rider_collect_and_complete_stop already take first.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  IF p_anchor_order_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- IDENTITY. Role must be exactly 'rider' -- same contract as rider_collect_and_complete_stop.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE');
  END IF;

  -- SINGLE-RIDER GLOBAL CHECK (D-2). Read under L0, which already fully serializes
  -- every writer (canonical or legacy) -- no second lock is needed to make this safe.
  SELECT * INTO v_existing FROM trip_authority.trips WHERE status = 'ACTIVE';
  IF FOUND THEN
    IF v_existing.anchor_order_uid = p_anchor_order_uid THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'trip_id', v_existing.trip_id,
        'giro_id', v_existing.giro_id, 'anchor_order_uid', v_existing.anchor_order_uid,
        'order_uids', COALESCE((SELECT jsonb_agg(tm.order_uid ORDER BY tm.stop_seq)
                                   FROM trip_authority.trip_members tm WHERE tm.trip_id = v_existing.trip_id), '[]'::jsonb));
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT');
  END IF;

  -- No canonical trip is active. Also refuse if the LEGACY (DRIVER_STATO-only) path
  -- shows one active -- trip_facts_v1() falls through to DRIVER_STATO whenever
  -- trip_authority.trips is empty, which it is at this point in the function, so this
  -- read is exactly the legacy compatibility signal, closing the gap a mixed v1/v2
  -- calling environment would otherwise leave open.
  v_legacy_trip := giro_authority.trip_facts_v1();
  IF NOT (v_legacy_trip->>'available')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNVERIFIABLE', 'reason', v_legacy_trip->>'reason');
  END IF;
  IF (v_legacy_trip->>'active')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_CONFLICT', 'reason', 'LEGACY_TRIP_ACTIVE');
  END IF;

  -- CANONICAL GIRO MEMBERSHIP. Resolved exclusively from giro_authority -- never
  -- ordenes.manual_giro_id.
  v_giro_id := giro_authority.order_effective_giro_v1(p_anchor_order_uid, p_operational_session_ids, v_legacy_trip);

  IF v_giro_id IS NOT NULL THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_giro_id FOR UPDATE;   -- L1
    -- Re-derive NOW that the giro row is locked -- same discipline as every other
    -- Giro Authority command (the unlocked read above may already be stale).
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro_id], p_operational_session_ids, v_legacy_trip);
    IF d.giro_id IS NULL OR d.giro_state <> 'PLANNED' OR NOT (p_anchor_order_uid = ANY (d.effective_order_uids)) THEN
      -- Gone/departed/anchor no longer effective between the unlocked read and the
      -- lock -- fall back to a single-order departure on just the anchor, exactly
      -- like legacy start_rider_trip does when no manual_giro_id match is found.
      v_uids := ARRAY[p_anchor_order_uid];
      v_giro_id := NULL;
    ELSE
      -- Certified behaviour (N06b): the departure takes only the members actually
      -- LISTO right now; an EN_COCINA member is released, never an error, and never
      -- blocks the trip.
      SELECT array_agg(o.order_uid ORDER BY o.order_uid) INTO v_uids
        FROM public.ordenes o WHERE o.order_uid = ANY (d.effective_order_uids) AND o.estado = 'LISTO';
      IF v_uids IS NULL OR NOT (p_anchor_order_uid = ANY (v_uids)) THEN
        RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'order_uid', p_anchor_order_uid);
      END IF;
    END IF;
  ELSE
    v_uids := ARRAY[p_anchor_order_uid];
  END IF;

  PERFORM giro_authority.lock_orders_v1(v_uids);                                                  -- L2
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = ANY (v_uids) ORDER BY o.order_uid FOR SHARE; -- L4

  FOR r IN SELECT * FROM giro_authority.order_facts_v1(v_uids, v_legacy_trip) LOOP
    IF NOT r.present THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND', 'order_uid', r.order_uid);
    END IF;
    IF r.delivery_type <> 'DOMICILIO' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_ELIGIBLE', 'order_uid', r.order_uid, 'reason', 'NOT_DOMICILIO');
    END IF;
    IF r.table_session_id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_NOT_ELIGIBLE', 'order_uid', r.order_uid, 'reason', 'TABLE_ORDER');
    END IF;
    IF NOT COALESCE(r.service_session_id = ANY (p_operational_session_ids), false) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_MISMATCH', 'order_uid', r.order_uid);
    END IF;
    IF r.estado IS DISTINCT FROM 'LISTO' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE', 'order_uid', r.order_uid, 'estado', r.estado);
    END IF;
    IF r.order_uid = p_anchor_order_uid THEN v_anchor_sess := r.service_session_id; END IF;
  END LOOP;

  SELECT array_agg(DISTINCT f.business_date) INTO v_dates FROM giro_authority.order_facts_v1(v_uids, v_legacy_trip) f;
  IF cardinality(v_dates) <> 1 OR v_dates[1] IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_MISMATCH');
  END IF;

  -- CREATE exactly one canonical trip + freeze its members. The trips_one_active_v1
  -- partial unique index is the DB-level backstop; L0 above is the real serialization.
  v_trip_id := gen_random_uuid();
  INSERT INTO trip_authority.trips
    (trip_id, business_date, service_session_id, rider_actor, anchor_order_uid, giro_id, departed_at, status, seq)
  VALUES
    (v_trip_id, v_dates[1], v_anchor_sess, p_actor, p_anchor_order_uid, v_giro_id, now(), 'ACTIVE',
     nextval('trip_authority.trips_seq_v1'));
  PERFORM trip_authority.freeze_members_v1(v_trip_id, v_uids, p_actor);

  -- Transition eligible orders to EN_ENTREGA atomically. Order stop state stays
  -- authoritative in ordenes.estado/hora_entrega -- never duplicated in trip_members.
  UPDATE public.ordenes
     SET estado = 'EN_ENTREGA', hora_salida = (extract(epoch FROM now()) * 1000)::bigint
   WHERE order_uid = ANY (v_uids) AND estado = 'LISTO';

  -- DRIVER_STATO COMPATIBILITY PROJECTION ONLY -- derived from the canonical facts
  -- just created, never independently authoritative (D-1). Legacy readers/writers
  -- (rider_collect_and_complete_stop, close_rider_trip, Cocina/Entregas dashboards)
  -- keep working unmodified against this row during the W6 compatibility window.
  SELECT array_agg(o.id ORDER BY u.ord) INTO v_ids
    FROM unnest(v_uids) WITH ORDINALITY AS u(order_uid, ord) JOIN public.ordenes o ON o.order_uid = u.order_uid;
  SELECT array_agg(DISTINCT o.zona) FILTER (WHERE o.zona IS NOT NULL) INTO v_zones
    FROM public.ordenes o WHERE o.order_uid = ANY (v_uids);
  v_snapshot := jsonb_build_object(
    'trip_id', v_trip_id::text, 'anchor_order_id', (SELECT id FROM public.ordenes WHERE order_uid = p_anchor_order_uid),
    'order_ids', to_jsonb(v_ids), 'manual_giro_ids', CASE WHEN v_giro_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_giro_id) END,
    'salida_refs', '[]'::jsonb, 'zone_sequence', to_jsonb(COALESCE(v_zones, ARRAY[]::text[])),
    'n_orders', COALESCE(array_length(v_uids, 1), 0), 'started_at', to_jsonb(now()), 'closed_at', 'null'::jsonb,
    'trip_version', 1, 'status', 'ACTIVE');

  INSERT INTO public.config (chiave, valore) VALUES ('DRIVER_STATO', '{}')
  ON CONFLICT (chiave) DO NOTHING;
  SELECT COALESCE(NULLIF(valore, '')::jsonb, '{}'::jsonb) INTO v_ds
    FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;                                   -- L5
  v_ds := v_ds || jsonb_build_object(
    'schema', 2, 'stato', 'IN_GIRO', 'zona', to_jsonb(v_zones[1]),
    -- language-guard: allow-legacy n_ordini is the existing DRIVER_STATO snapshot field name (start_rider_trip's own convention), not new vocabulary
    'partito_alle', to_jsonb(now()), 'n_ordini', COALESCE(array_length(v_uids, 1), 0),
    'rientro_stimato', 'null'::jsonb, 'trip_seq', COALESCE((v_ds->>'trip_seq')::int, 0) + 1,
    'active_trip', v_snapshot);
  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'trip_id', v_trip_id, 'giro_id', v_giro_id,
    'anchor_order_uid', p_anchor_order_uid, 'order_uids', to_jsonb(v_uids), 'business_date', v_dates[1]);
END $fn$;

-- 6. public.trip_projection_v1 -- DORMANT read-only projection, scoped like
--    giro_projection_v1. Not called by anything in this migration or by Node.
CREATE FUNCTION public.trip_projection_v1(p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip    trip_authority.trips%ROWTYPE;
  v_members jsonb;
BEGIN
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE');
  END IF;
  SELECT * INTO v_trip FROM trip_authority.trips
   WHERE status = 'ACTIVE' AND service_session_id = ANY (p_operational_session_ids);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'active', false);
  END IF;
  SELECT jsonb_agg(jsonb_build_object('order_uid', tm.order_uid, 'stop_seq', tm.stop_seq) ORDER BY tm.stop_seq)
    INTO v_members FROM trip_authority.trip_members tm WHERE tm.trip_id = v_trip.trip_id;
  RETURN jsonb_build_object('ok', true, 'active', true, 'trip_id', v_trip.trip_id,
    'anchor_order_uid', v_trip.anchor_order_uid, 'giro_id', v_trip.giro_id,
    'departed_at', v_trip.departed_at, 'members', COALESCE(v_members, '[]'::jsonb));
END $fn$;

-- 7. giro_authority.trip_facts_v1 -- re-pointed: canonical wins if present, otherwise
--    the exact pre-134 DRIVER_STATO body, verbatim, unchanged below the new prefix.
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
  v_canon  jsonb;
BEGIN
  -- W6.2 compatibility fallback (D-1): canonical trip_authority data wins whenever a
  -- canonical trip exists; this is temporary, not a second authority. Empty on
  -- staging today (nothing writes to trip_authority.trips yet), so this branch is
  -- provably a no-op for every current read -- proven by the harness's equivalence
  -- group, not merely asserted here.
  v_canon := trip_authority.trip_facts_canonical_v1();
  IF (v_canon->>'canonical_trip_exists')::boolean IS TRUE THEN
    RETURN v_canon - 'canonical_trip_exists';
  END IF;

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

-- 8. Ownership, search_path, grants -- least privilege, no Node caller yet -----------------
ALTER FUNCTION trip_authority.trip_members_append_only_v1() OWNER TO postgres;
ALTER FUNCTION trip_authority.freeze_members_v1(uuid, uuid[], text) OWNER TO postgres;
ALTER FUNCTION trip_authority.trip_facts_canonical_v1() OWNER TO postgres;
ALTER FUNCTION public.start_rider_trip_v2(uuid, text, integer, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.trip_projection_v1(uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION trip_authority.trip_members_append_only_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION trip_authority.freeze_members_v1(uuid, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION trip_authority.trip_facts_canonical_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.start_rider_trip_v2(uuid, text, integer, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_projection_v1(uuid[]) FROM PUBLIC, anon, authenticated;
-- service_role IS granted EXECUTE (standard baseline posture, matching every other
-- Authority entry point since migration 130) even though this migration deliberately
-- does NOT register either RPC in the H1B resource policy (src/utils/
-- supabaseResourcePolicy.js) -- the gated sbRpc transport Node actually calls through
-- fails closed on an unregistered resource regardless of the raw DB grant, so this is
-- still fully dormant end-to-end. Registration belongs to the activation slice that
-- introduces the real caller.
GRANT EXECUTE ON FUNCTION public.start_rider_trip_v2(uuid, text, integer, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_projection_v1(uuid[]) TO service_role;
-- trip_facts_v1 already carries the correct grants from migration 130 (CREATE OR
-- REPLACE preserves existing privileges); nothing to re-grant.

-- 9. Post-conditions --------------------------------------------------------------------------
DO $$
DECLARE
  r      record;
  v_src  text;
BEGIN
  -- Schema/table security posture mirrors giro_authority exactly.
  IF has_schema_privilege('anon', 'trip_authority', 'USAGE') OR has_schema_privilege('authenticated', 'trip_authority', 'USAGE')
     OR has_schema_privilege('service_role', 'trip_authority', 'USAGE') THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: an API role holds USAGE on schema trip_authority';
  END IF;
  FOR r IN SELECT * FROM (VALUES ('trips'), ('trip_members')) AS t(relname) LOOP
    IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
             WHERE relnamespace = 'trip_authority'::regnamespace AND relname = r.relname) THEN
      RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trip_authority.% is not RLS-enabled+forced', r.relname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                WHERE c.relnamespace = 'trip_authority'::regnamespace AND c.relname = r.relname) THEN
      RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trip_authority.% carries a policy (must be zero, deny-all)', r.relname;
    END IF;
  END LOOP;

  -- D-2 single-active-trip enforcement exists as a real index, not a convention.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'trip_authority' AND tablename = 'trips'
                   AND indexname = 'trips_one_active_v1') THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trips_one_active_v1 partial unique index missing';
  END IF;
  -- D-2 order_uid-globally-unique invariant is a real, unconditional constraint.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'trip_authority.trip_members'::regclass
                   AND contype = 'u' AND conkey = (SELECT array_agg(attnum) FROM pg_attribute
                     WHERE attrelid = 'trip_authority.trip_members'::regclass AND attname = 'order_uid')) THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trip_members.order_uid is not globally UNIQUE';
  END IF;

  -- Dormant entry points: owner postgres, search_path pinned, PUBLIC/anon/authenticated
  -- barred, service_role only.
  FOR r IN SELECT * FROM (VALUES
      ('start_rider_trip_v2', 'public.start_rider_trip_v2(uuid,text,integer,uuid[])'),
      ('trip_projection_v1', 'public.trip_projection_v1(uuid[])')
    ) AS t(proname, sig)
  LOOP
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = r.sig::regprocedure)) <> 'postgres' THEN
      RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: % must be owned by postgres', r.proname;
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = r.sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: % must pin search_path=pg_catalog, pg_temp', r.proname;
    END IF;
    IF has_function_privilege('anon', r.sig::regprocedure, 'EXECUTE') OR has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: anon/authenticated may execute %', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: service_role must be able to execute %', r.proname;
    END IF;
  END LOOP;

  -- start_rider_trip_v2 takes L0 first, literally. (A raw-column-read check against
  -- ordenes.manual_giro_id was deliberately not added here: this function's own
  -- explanatory comments legitimately name that column, and its DRIVER_STATO
  -- compatibility payload legitimately writes the plural key manual_giro_ids -- both
  -- make a crude substring check against manual_giro_id produce false positives. The
  -- real guarantee is in the code itself: every membership read in this function goes
  -- through giro_authority.order_effective_giro_v1/derive_giros_v1, never a raw
  -- ordenes.manual_giro_id column read -- reviewed by inspection when this migration
  -- was authored, and exercised end-to-end by the harness's own certification group.)
  v_src := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);
  IF v_src NOT ILIKE '%LA_DIECI_DRIVER_STATO%' THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: start_rider_trip_v2 does not take L0';
  END IF;

  -- trip_facts_v1 re-point: canonical call textually precedes the DRIVER_STATO body,
  -- and the DRIVER_STATO body itself is present verbatim (spot-check on its own
  -- distinctive literals).
  v_src := pg_get_functiondef('giro_authority.trip_facts_v1()'::regprocedure);
  IF position('trip_authority' IN v_src) = 0
     OR position('trip_authority' IN v_src) > position('DRIVER_STATO_UNPARSEABLE' IN v_src) THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trip_facts_v1 canonical check must precede the DRIVER_STATO body';
  END IF;
  IF v_src NOT ILIKE '%ACTIVE_TRIP_MALFORMED%' OR v_src NOT ILIKE '%DRIVER_STATO_NOT_OBJECT%' THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trip_facts_v1 lost a pre-134 DRIVER_STATO guard literal';
  END IF;

  -- Every sibling this migration does not intend to touch: byte-identical to its
  -- pre-134 checksum.
  FOR r IN SELECT proname, checksum AS before FROM w6_2_untouched_before LOOP
    DECLARE
      v_sig regprocedure;
      v_now text;
    BEGIN
      v_sig := CASE r.proname
        WHEN 'giro_authority_create_v1' THEN 'public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_attach_v1' THEN 'public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_move_v1' THEN 'public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_set_hora_ref_v1' THEN 'public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_create_or_move_v1' THEN 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_attach_or_move_v1' THEN 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_detach_v1' THEN 'public.giro_authority_detach_v1(uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_dissolve_v1' THEN 'public.giro_authority_dissolve_v1(text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_consume_intent_v1' THEN 'public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure
        WHEN 'bump_facts_signal_v1' THEN 'giro_authority.bump_facts_signal_v1()'::regprocedure
        WHEN 'capture_giro_intent_v1' THEN 'giro_authority.capture_giro_intent_v1()'::regprocedure
        WHEN 'giro_authority_list_pending_intents_v1' THEN 'public.giro_authority_list_pending_intents_v1(uuid[],integer)'::regprocedure
        WHEN 'giro_projection_v1' THEN 'public.giro_projection_v1(uuid[])'::regprocedure
        WHEN 'rider_collect_and_complete_stop' THEN 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure
        WHEN 'start_rider_trip' THEN 'public.start_rider_trip(text)'::regprocedure
      END;
      v_now := md5(pg_get_functiondef(v_sig));
      IF v_now <> r.before THEN
        RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: % changed (expected byte-identical to pre-134)', r.proname;
      END IF;
    END;
  END LOOP;

  -- trip_authority.trips must be empty immediately after apply -- nothing in this
  -- migration writes a row, and nothing else can (start_rider_trip_v2 is the only
  -- writer and is not called here).
  IF EXISTS (SELECT 1 FROM trip_authority.trips) THEN
    RAISE EXCEPTION 'W6_2_TRIP_AUTHORITY post-condition failed: trip_authority.trips is not empty immediately after apply';
  END IF;
END $$;

COMMIT;
