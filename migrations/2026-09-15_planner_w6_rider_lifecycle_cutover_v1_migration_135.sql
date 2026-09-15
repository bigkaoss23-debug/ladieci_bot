-- PLANNER W6.3 + W6.4 -- CANONICAL RIDER LIFECYCLE + GIRO PROJECTION CUTOVER.
-- CANDIDATE for migration 135. Applies ON TOP of the already-applied migrations
-- 130-134 (giro_authority + W5 Packet 01 + W5 Intent Activation + W6.1 lock-order
-- unification + W6.2 Trip Authority foundation).
--
-- WHY THIS MIGRATION MUST LAND BEFORE THE NODE ACTIVATION
--   START_V2_AND_CANONICAL_CLOSE_LIFECYCLE_MUST_NOT_BE_SPLIT_UNSAFELY. Migration 134
--   installed start_rider_trip_v2 dormant, but rider_collect_and_complete_stop and
--   close_rider_trip still resolved membership exclusively from the DRIVER_STATO
--   compatibility blob. Activating v2 first would have produced trips whose canonical
--   membership no function could read. This migration makes the COMPLETE lifecycle
--   (START -> COLLECT/DELIVER -> CLOSE) canonical-aware while remaining fully backward
--   compatible with a legacy, pre-cutover DRIVER_STATO trip, so it is safe to apply
--   while the OLD backend (which still calls start_rider_trip) is live. Only after this
--   is verified does the Node caller move to start_rider_trip_v2.
--
-- WHAT IT CHANGES (exactly five functions + one index + three new helpers)
--   1. public.start_rider_trip_v2 -- three corrections, no rewrite:
--      (a) CANONICAL_GIRO_DEPARTURE_IS_ATOMIC. Migration 134's body narrowed a PLANNED
--          giro's effective membership to the subset that happened to be LISTO right
--          now (`... AND o.estado = 'LISTO'`), which would have allowed a PARTIAL
--          DEPARTURE of a canonical giro. It now freezes the COMPLETE effective member
--          set and lets the already-existing per-member eligibility loop refuse with
--          the already-existing INVALID_STATE code if ANY required member is not LISTO.
--          Zero members transition, zero trip rows are created. No new refusal code is
--          invented. A non-giro order may still depart alone, unchanged.
--      (b) S2-1H SERVICE_CLOSING gate. Legacy start_rider_trip refuses a departure
--          while the crash-safe service-close marker is set; migration 134's v2 did
--          not carry that gate. Activating v2 without it would have silently dropped a
--          live safety guard, so it is restored here verbatim (same existing code).
--      (c) the auth_actors identity read drops FOR UPDATE. A departure writes no money,
--          and L0 -- taken first, and exclusive -- already serializes every trip writer,
--          so a plain read is sufficient. Locking the actor row here as well would only
--          widen the lock footprint the fix in item 2(d) below exists to remove.
--   2. public.rider_collect_and_complete_stop -- membership authority only. When a
--      canonical ACTIVE trip exists, the rider's authority to collect on an order comes
--      from trip_authority.trip_members, not from DRIVER_STATO.active_trip.order_ids.
--      Authentication, actor/session checks, payment handling, money-first sequencing,
--      idempotent replay, RIDER_STOP_LOST_RACE rollback, the order state transition,
--      hora_entrega and every financial/ledger semantic are byte-identical. Stop state
--      is NOT duplicated into trip_members: ordenes.estado/hora_entrega remain the
--      truth. With no canonical trip, the pre-135 legacy path runs unchanged, so an
--      in-flight pre-cutover trip can still be finished safely.
--      (d) MANDATORY FOR ACTIVATION, found by certification, not by inspection: L0 moves
--      up to immediately after the pure input validation (method + session_version) --
--      i.e. before the auth_actors FOR UPDATE, instead of after it. This is exactly the
--      placement migration 133 gave every live Giro Authority command; collect was the
--      one remaining writer still taking a row lock ahead of L0. It matters now because
--      trip_authority.trips.rider_actor carries a FOREIGN KEY to auth_actors, so
--      start_rider_trip_v2's INSERT implicitly takes FOR KEY SHARE on the rider's actor
--      row -- which conflicts with collect's FOR UPDATE. Activating v2 with the old
--      ordering produced a REAL, reproducible ABBA deadlock between a rider's own
--      concurrent collect and departure (16 deadlocks in a 12-round mixed-traffic
--      certification stress; zero after this change). Nothing else about collect moves:
--      the refusal order (method -> session_version -> identity -> membership -> state
--      -> money -> completion), every refusal code, the FOR UPDATE strength itself, and
--      the money sequencing are all preserved exactly. The only observable difference is
--      that an identity refusal now happens while holding the dispatch lock.
--   3. public.close_rider_trip -- canonical-aware. For a canonical trip it resolves the
--      COMPLETE frozen member set from trip_members, refuses EARLY_CLOSE while any
--      member is non-terminal, transitions exactly that trip ACTIVE -> CLOSED with
--      closed_at set once, writes the same DRIVER_STATO compatibility output (active
--      trip cleared, last_closed_trip preserved) and the same delivery_logs row. Replay
--      is idempotent (after a successful close there is no ACTIVE canonical row, so the
--      legacy last_closed_trip branch answers, exactly as today). Legacy fallback is
--      unchanged. Hard invariant enforced by the post-conditions AND by certification:
--      SUCCESSFUL_CANONICAL_CLOSE => count(trips WHERE status='ACTIVE') = 0.
--   4. giro_authority.derive_giros_v1 (W6.4) -- once a canonical trip references a giro,
--      that trip's frozen trip_members IS the giro's effective membership, and stays so
--      while the trip is ACTIVE, while some members are delivered, once every member is
--      delivered, and after the trip is CLOSED. It never reverts to the current
--      giro_members. State: IN_TRIP while the trip is ACTIVE and at least one frozen
--      member is still non-terminal; DONE once every frozen member is terminal OR the
--      linked trip is CLOSED. Progress is derived from ordenes.estado -- members are
--      never removed from the membership fact to obtain DONE. salida becomes the REAL
--      trip.departed_at rendered through the existing HH:MM projection contract, with
--      salida_source = 'DEPARTED'; manual_giros.hora_ref (the operator-planned fact) is
--      read-only here and is never overwritten.
--   5. trip_authority.trip_facts_canonical_v1 -- stops filtering delivered members out
--      of order_ids. Migration 134 used that filter to avoid pinning a giro IN_TRIP
--      forever, but it conflated IMMUTABLE MEMBERSHIP with MEMBERS STILL OUT. Item 4
--      now derives DONE from the canonical trip directly, so the compatibility fact can
--      -- and must -- report the full frozen membership, and "still out" moves to the
--      two places that actually consume it (derive_giros_v1's own ca.n_outstanding, and
--      trip_authority_active_trip_v1's non_terminal_member_count) rather than being
--      published as unused surface. The function's key set is unchanged, so
--      giro_authority.trip_facts_v1 stays byte-identical and its public output shape
--      does not move. This strictly STRENGTHENS the existing order-entry guards: a
--      delivered member of an ACTIVE trip now still reads as DEPARTED instead of
--      becoming re-attachable mid-trip.
--   6. trip_authority.trips gains trips_one_trip_per_giro_v1, a real partial UNIQUE
--      index on non-null giro_id: a canonical giro is a departure unit and may produce
--      at most ONE trip in its lifetime. Created now precisely because staging holds
--      ZERO canonical trip rows, so it can never fail on existing data. Single non-giro
--      trips (giro_id NULL) remain unconstrained.
--
-- NEW HELPERS AND WHY THEY EXIST
--   rider_collect_and_complete_stop and close_rider_trip are SECURITY INVOKER and run
--   as service_role, which deliberately holds NO USAGE on the private trip_authority
--   schema (migration 134's security posture, re-asserted by this migration's own
--   post-conditions). They therefore reach canonical facts only through two narrow
--   public SECURITY DEFINER entry points owned by postgres with a pinned search_path
--   and EXECUTE granted to service_role alone:
--     public.trip_authority_active_trip_v1()            -- read-only active-trip facts
--     public.trip_authority_close_active_trip_v1(uuid)  -- the guarded ACTIVE->CLOSED
--                                                          transition, which re-validates
--                                                          membership completeness and
--                                                          terminality itself rather than
--                                                          being a raw status flip
--   Neither is registered in the H1B resource policy (src/utils/supabaseResourcePolicy.js):
--   no Node caller exists, and the gated sbRpc transport fails closed on an unregistered
--   resource. giro_authority.derive_giros_v1 needs no such wrapper -- every one of its
--   entry paths (the nine public Authority commands, giro_projection_v1,
--   order_effective_giro_v1, target_fingerprint_v1 and the capture trigger) is SECURITY
--   DEFINER owned by postgres, verified against the live catalog before this migration
--   was authored.
--   trip_authority.close_terminal_states_v1() pins the close contract's terminal set to
--   close_rider_trip's own pre-135 literal list, verbatim, so the canonical and legacy
--   close branches cannot drift. It is deliberately NOT the same set as
--   delivered_states_v1() || cancelled_states_v1(), which the W6.4 projection uses for
-- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal, named here only to describe the close-vs-projection divergence, not new vocabulary
--   "terminal progress": CHIUSO_FORZATO / CANCELLED count as terminal progress (the giro
--   reads DONE) but still block a close (EARLY_CLOSE). The divergence is one-directional
--   and fail-safe -- close stays strictly stricter than the projection -- and is
--   preserved on purpose rather than silently widening a certified close contract.
--
-- WHAT IT NEVER DOES
--   Does not modify giro_authority_create_v1 / attach_v1 / move_v1 / set_hora_ref_v1 /
--   create_or_move_v1 / attach_or_move_v1 / detach_v1 / dissolve_v1 / consume_intent_v1,
--   giro_authority.bump_facts_signal_v1 / capture_giro_intent_v1 / scope_valid_v1 /
--   order_facts_v1 / order_effective_giro_v1 / trip_facts_v1 / freeze_members_v1,
--   giro_authority_list_pending_intents_v1, giro_projection_v1, public.start_rider_trip
--   (the legacy v1 RPC, deliberately kept as rollback compatibility until W7),
--   public.trip_projection_v1, public._ledger_write_payment or public.order_mark_paid --
--   all byte-identical, checksummed before/after below. No table is created or dropped,
--   no column added or removed, no trigger added or removed, no grant widened, no money
--   path, economic table, obligation, ledger or fiscal object touched anywhere. No
--   frontend change. No Stage-M adapter, no post-departure ETA, no rider UI, no
--   trip_projection_v1 Node reader.
--
-- LOCK PROTOCOL (no new lock family; one ordering CORRECTION, see item 2(d))
--   Every writer now takes L0 pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'))
--   before any other lock, without exception: close_rider_trip and start_rider_trip_v2
--   as their literal first statement, and rider_collect_and_complete_stop immediately
--   after its pure input validation and ahead of the auth_actors row lock (the W6.1
--   placement, previously the one writer that did not follow it). The two new helpers
--   take no advisory lock and are only
--   ever called from inside a caller that already holds L0, so the canonical trip row
--   lock in trip_authority_close_active_trip_v1 is always the LAST lock acquired in the
--   transaction. L0 being exclusive is what makes the config-row / trips-row acquisition
--   order in start_rider_trip_v2 (trips then config) and close_rider_trip (config then
--   trips) safe: those two can never interleave.

BEGIN;

-- 0. Predecessor, drift and idempotency preconditions ------------------------------------
DO $$
DECLARE
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trip_authority') THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: schema trip_authority is missing -- migration 134 must be applied first';
  END IF;
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL
     OR to_regprocedure('public.trip_projection_v1(uuid[])') IS NULL
     OR to_regprocedure('trip_authority.trip_facts_canonical_v1()') IS NULL
     OR to_regprocedure('trip_authority.freeze_members_v1(uuid,uuid[],text)') IS NULL
     OR to_regprocedure('giro_authority.derive_giros_v1(text[],uuid[],jsonb)') IS NULL
     OR to_regprocedure('giro_authority.delivered_states_v1()') IS NULL
     OR to_regprocedure('giro_authority.cancelled_states_v1()') IS NULL
     OR to_regprocedure('public.close_rider_trip(text)') IS NULL
     OR to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NULL
     OR to_regprocedure('public.start_rider_trip(text)') IS NULL THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: a required migration-130..134 predecessor is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.trip_authority_active_trip_v1()') IS NOT NULL
     OR to_regprocedure('public.trip_authority_close_active_trip_v1(uuid)') IS NOT NULL
     OR to_regprocedure('trip_authority.close_terminal_states_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'trip_authority' AND indexname = 'trips_one_trip_per_giro_v1') THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: already applied -- resolve drift first';
  END IF;

  -- The two lifecycle functions this migration rewrites must still be at their exact
  -- pre-135 shape. Pinned by their own distinctive literals rather than a whole-body
  -- checksum, so the same guard is meaningful on an ephemeral certification fixture and
  -- on staging alike.
  v_src := pg_get_functiondef('public.close_rider_trip(text)'::regprocedure);
  IF v_src ILIKE '%trip_authority%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: close_rider_trip already references trip_authority -- resolve drift first';
  END IF;
  IF v_src NOT LIKE '%INVALID_TRIP_SNAPSHOT%' OR v_src NOT LIKE '%MISSING_TRIP_MEMBER%'
     OR v_src NOT LIKE '%EARLY_CLOSE%' OR v_src NOT LIKE '%last_closed_trip%'
     OR v_src NOT LIKE '%NON_MEMBER_NOOP%'
-- language-guard: allow-legacy COMPLETATO is close_rider_trip's own pre-135 ordenes.estado terminal literal, reproduced verbatim, not new vocabulary
     OR v_src NOT LIKE '%''RETIRADO'',''COMPLETADO'',''COMPLETATO'',''CANCELADO'',''ANULADO''%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: close_rider_trip is not at its expected pre-135 shape -- resolve drift first';
  END IF;

  v_src := pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure);
  IF v_src ILIKE '%trip_authority%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: rider_collect_and_complete_stop already references trip_authority -- resolve drift first';
  END IF;
  IF v_src NOT LIKE '%RIDER_STOP_LOST_RACE%' OR v_src NOT LIKE '%_ledger_write_payment%'
     OR v_src NOT LIKE '%AUTH_LEGACY_IMPORT_REQUIRED%' OR v_src NOT LIKE '%PAYMENT_REFUSED%'
     OR v_src NOT LIKE '%AUTH_FORBIDDEN_ROLE%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: rider_collect_and_complete_stop is not at its expected pre-135 shape -- resolve drift first';
  END IF;

  v_src := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);
  IF v_src NOT LIKE '%o.estado = ''LISTO''%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE refused: start_rider_trip_v2 does not carry the migration-134 partial-departure body this migration corrects -- resolve drift first';
  END IF;
END $$;

-- Snapshot every sibling this migration must leave byte-identical.
CREATE TEMP TABLE w6_34_untouched_before (proname text PRIMARY KEY, sig text, checksum text) ON COMMIT DROP;
INSERT INTO w6_34_untouched_before (proname, sig)
VALUES
  ('giro_authority_create_v1',                'public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'),
  ('giro_authority_attach_v1',                'public.giro_authority_attach_v1(text,uuid,text,uuid[])'),
  ('giro_authority_move_v1',                  'public.giro_authority_move_v1(uuid,text,text,uuid[])'),
  ('giro_authority_set_hora_ref_v1',          'public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'),
  ('giro_authority_create_or_move_v1',        'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'),
  ('giro_authority_attach_or_move_v1',        'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'),
  ('giro_authority_detach_v1',                'public.giro_authority_detach_v1(uuid,text,uuid[])'),
  ('giro_authority_dissolve_v1',              'public.giro_authority_dissolve_v1(text,text,uuid[])'),
  ('giro_authority_consume_intent_v1',        'public.giro_authority_consume_intent_v1(uuid,text,uuid[])'),
  ('bump_facts_signal_v1',                    'giro_authority.bump_facts_signal_v1()'),
  ('capture_giro_intent_v1',                  'giro_authority.capture_giro_intent_v1()'),
  ('giro_authority_list_pending_intents_v1',  'public.giro_authority_list_pending_intents_v1(uuid[],integer)'),
  ('giro_projection_v1',                      'public.giro_projection_v1(uuid[])'),
  ('trip_facts_v1',                           'giro_authority.trip_facts_v1()'),
  ('order_facts_v1',                          'giro_authority.order_facts_v1(uuid[],jsonb)'),
  ('order_effective_giro_v1',                 'giro_authority.order_effective_giro_v1(uuid,uuid[],jsonb)'),
  ('scope_valid_v1',                          'giro_authority.scope_valid_v1(uuid[])'),
  ('delivered_states_v1',                     'giro_authority.delivered_states_v1()'),
  ('cancelled_states_v1',                     'giro_authority.cancelled_states_v1()'),
  ('freeze_members_v1',                       'trip_authority.freeze_members_v1(uuid,uuid[],text)'),
  ('trip_members_append_only_v1',             'trip_authority.trip_members_append_only_v1()'),
  ('start_rider_trip',                        'public.start_rider_trip(text)'),
  ('trip_projection_v1',                      'public.trip_projection_v1(uuid[])');
UPDATE w6_34_untouched_before SET checksum = md5(pg_get_functiondef(sig::regprocedure));

-- 1. ONE TRIP PER GIRO -------------------------------------------------------------------
-- A canonical giro is a departure unit: at most ONE trip may ever reference it. A real
-- partial UNIQUE index on non-null giro_id, never an application convention. Safe to
-- create unconditionally: trip_authority.trips is empty on every environment this
-- migration can reach (start_rider_trip_v2 is still dormant in Node until the source
-- promotion that follows this apply).
CREATE UNIQUE INDEX trips_one_trip_per_giro_v1 ON trip_authority.trips (giro_id) WHERE giro_id IS NOT NULL;

-- 2. Private helpers ----------------------------------------------------------------------
-- The close contract's terminal set, pinned to close_rider_trip's own pre-135 literal
-- list so the canonical and legacy close branches cannot drift apart. Deliberately NOT
-- delivered_states_v1() || cancelled_states_v1() (see the header): close stays strictly
-- stricter than the W6.4 progress derivation.
CREATE FUNCTION trip_authority.close_terminal_states_v1()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  -- language-guard: allow-legacy these are close_rider_trip's own pre-135 ordenes.estado literals, copied verbatim
  SELECT ARRAY['RETIRADO', 'COMPLETADO', 'COMPLETATO', 'CANCELADO', 'ANULADO']::text[]
$fn$;

-- Terminal for PROGRESS purposes (W6.4 IN_TRIP -> DONE): a member that is delivered or
-- cancelled is no longer "still out". Union of the two existing Giro Authority sets --
-- no new vocabulary is introduced here.
CREATE FUNCTION trip_authority.progress_terminal_states_v1()
RETURNS text[]
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT giro_authority.delivered_states_v1() || giro_authority.cancelled_states_v1()
$fn$;

-- The ONE place a real departure timestamp becomes the projection's HH:MM salida. The
-- Madrid wall clock lives here and nowhere else, so giro_authority.derive_giros_v1 stays
-- free of calendar/clock literals exactly as the W3 contract requires. Same rendering
-- contract as hora_ref / forno_out, which are already local wall-clock HH:MM strings.
CREATE FUNCTION trip_authority.departed_hhmm_v1(p_departed_at timestamptz)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE WHEN p_departed_at IS NULL THEN NULL
              ELSE to_char(p_departed_at AT TIME ZONE 'Europe/Madrid', 'HH24:MI') END
$fn$;

-- 3. trip_authority.trip_facts_canonical_v1 -- immutable membership, unfiltered ------------
-- W6.4: order_ids is now the FULL frozen membership of the ACTIVE canonical trip
-- (delivered members included), and `active` means "a canonical trip is out", not "some
-- member has not been delivered yet". The membership fact is never edited to express
-- progress. The key set is EXACTLY migration 134's, so giro_authority.trip_facts_v1 stays
-- byte-identical (it already strips the single internal key, canonical_trip_exists) and
-- no consumer's shape moves. "Still out" is derived where it is consumed:
-- giro_authority.derive_giros_v1 (ca.n_outstanding) and
-- public.trip_authority_active_trip_v1 (non_terminal_member_count).
CREATE OR REPLACE FUNCTION trip_authority.trip_facts_canonical_v1()
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
  SELECT COALESCE(jsonb_agg(o.id ORDER BY tm.stop_seq) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb)
    INTO v_order_ids
    FROM trip_authority.trip_members tm
    LEFT JOIN public.ordenes o ON o.order_uid = tm.order_uid
   WHERE tm.trip_id = v_trip.trip_id;
  RETURN jsonb_build_object('available', true, 'active', true, 'trip_id', v_trip.trip_id::text,
    'order_ids', v_order_ids,
    'giro_ids', CASE WHEN v_trip.giro_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(v_trip.giro_id) END,
    'canonical_trip_exists', true);
END $fn$;

-- 4. public.trip_authority_active_trip_v1 -- the read boundary for INVOKER callers --------
-- rider_collect_and_complete_stop and close_rider_trip run as service_role, which holds
-- no USAGE on trip_authority. This is their only window onto canonical facts: read-only,
-- owner postgres, pinned search_path, service_role EXECUTE only, no Node caller, not in
-- the H1B resource policy.
CREATE FUNCTION public.trip_authority_active_trip_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip      trip_authority.trips%ROWTYPE;
  v_ids       jsonb;
  v_zones     jsonb;
  v_n         integer;
  v_missing   integer;
  v_nonterm   integer;
  v_anchor_id text;
BEGIN
  SELECT * INTO v_trip FROM trip_authority.trips WHERE status = 'ACTIVE';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false);
  END IF;

  SELECT COALESCE(jsonb_agg(o.id ORDER BY tm.stop_seq) FILTER (WHERE o.id IS NOT NULL), '[]'::jsonb),
         count(*)::integer,
         count(*) FILTER (WHERE o.id IS NULL)::integer,
         count(*) FILTER (WHERE o.id IS NOT NULL
                            AND NOT (o.estado = ANY (trip_authority.close_terminal_states_v1())))::integer
    INTO v_ids, v_n, v_missing, v_nonterm
    FROM trip_authority.trip_members tm
    LEFT JOIN public.ordenes o ON o.order_uid = tm.order_uid
   WHERE tm.trip_id = v_trip.trip_id;

  SELECT COALESCE(jsonb_agg(DISTINCT o.zona) FILTER (WHERE o.zona IS NOT NULL), '[]'::jsonb) INTO v_zones
    FROM trip_authority.trip_members tm
    JOIN public.ordenes o ON o.order_uid = tm.order_uid
   WHERE tm.trip_id = v_trip.trip_id;

  SELECT o.id INTO v_anchor_id FROM public.ordenes o WHERE o.order_uid = v_trip.anchor_order_uid;

  RETURN jsonb_build_object(
    'exists', true,
    'trip_id', v_trip.trip_id,
    'giro_id', v_trip.giro_id,
    'anchor_order_uid', v_trip.anchor_order_uid,
    'anchor_order_id', to_jsonb(v_anchor_id),
    'service_session_id', v_trip.service_session_id,
    'business_date', v_trip.business_date,
    'rider_actor', v_trip.rider_actor,
    'departed_at', v_trip.departed_at,
    'member_order_ids', v_ids,
    'member_count', v_n,
    'missing_member_count', v_missing,
    'non_terminal_member_count', v_nonterm,
    'zone_sequence', v_zones);
END $fn$;

-- 5. public.trip_authority_close_active_trip_v1 -- the guarded ACTIVE->CLOSED transition --
-- Not a raw status flip: it re-derives membership completeness and terminality from
-- trip_members itself, so a caller cannot close a trip that is not finished even if it
-- reached this function directly. closed_at is set exactly once; replay on an already
-- CLOSED trip is idempotent.
CREATE FUNCTION public.trip_authority_close_active_trip_v1(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip    trip_authority.trips%ROWTYPE;
  v_missing integer;
  v_nonterm integer;
  v_updated integer;
BEGIN
  IF p_trip_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;
  SELECT * INTO v_trip FROM trip_authority.trips WHERE trip_id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;
  IF v_trip.status = 'CLOSED' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'trip_id', p_trip_id);
  END IF;

  SELECT count(*) FILTER (WHERE o.id IS NULL)::integer,
         count(*) FILTER (WHERE o.id IS NOT NULL
                            AND NOT (o.estado = ANY (trip_authority.close_terminal_states_v1())))::integer
    INTO v_missing, v_nonterm
    FROM trip_authority.trip_members tm
    LEFT JOIN public.ordenes o ON o.order_uid = tm.order_uid
   WHERE tm.trip_id = p_trip_id;

  IF v_missing > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MISSING_TRIP_MEMBER');
  END IF;
  IF v_nonterm > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EARLY_CLOSE');
  END IF;

  UPDATE trip_authority.trips
     SET status = 'CLOSED', closed_at = now()
   WHERE trip_id = p_trip_id AND status = 'ACTIVE';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'trip_id', p_trip_id);
END $fn$;

-- 6. public.start_rider_trip_v2 -- atomic canonical giro departure -------------------------
-- Identical to migration 134's body apart from the three corrections listed in the header
-- (atomic giro membership, the restored SERVICE_CLOSING gate, and the auth_actors read
-- losing FOR UPDATE to remove an ABBA deadlock against rider_collect_and_complete_stop).
CREATE OR REPLACE FUNCTION public.start_rider_trip_v2(
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
  v_raw           text;
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
  -- W6.3: deliberately NOT "FOR UPDATE". A departure writes no money, and L0 -- taken
  -- first, and exclusive -- already serializes every trip writer, so a plain read is
  -- sufficient here. Note that the INSERT into trip_authority.trips further down still
  -- takes an implicit FOR KEY SHARE on this row through the rider_actor foreign key;
  -- that is precisely why rider_collect_and_complete_stop's own L0 had to move ahead of
  -- ITS auth_actors FOR UPDATE in this same migration (header, correction 2(d)).
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SCOPE_UNAVAILABLE');
  END IF;

  -- S2-1H crash-safe service-close gate, restored from legacy start_rider_trip: ANY
  -- existing marker blocks a new trip until the exact close_id is explicitly ended.
  -- Activating v2 without this would have silently dropped a live safety guard.
  SELECT c.valore INTO v_raw FROM public.config c WHERE c.chiave = 'DRIVER_STATO';
  IF v_raw IS NOT NULL AND btrim(v_raw) <> '' THEN
    BEGIN
      IF (v_raw::jsonb) ? 'service_closing' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'SERVICE_CLOSING');
      END IF;
    EXCEPTION WHEN others THEN
      RETURN jsonb_build_object('ok', false, 'code', 'UNVERIFIABLE', 'reason', 'DRIVER_STATO_UNPARSEABLE');
    END;
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
      -- W6.3 -- CANONICAL_GIRO_DEPARTURE_IS_ATOMIC. The COMPLETE effective member set
      -- departs, or nothing does. This deliberately does NOT narrow the set to the
      -- members that happen to be LISTO right now (migration 134's body did, which
      -- would have allowed a PARTIAL DEPARTURE of a canonical giro): the eligibility
      -- loop below then refuses the whole departure with the existing INVALID_STATE
      -- code if ANY required member is not LISTO, before a single order transitions
      -- and before any trip row is created. derive_giros_v1 already returns this array
      -- ordered by order_uid, which is exactly the ordering the previous body produced.
      v_uids := d.effective_order_uids;
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
  -- trips_one_trip_per_giro_v1 (W6.3) is the second backstop: a canonical giro can
  -- produce at most ONE trip in its lifetime.
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
  -- (Cocina/Entregas dashboards, delete_order_if_not_active) keep working unmodified
  -- against this row during the W6 compatibility window.
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

-- 7. public.rider_collect_and_complete_stop -- canonical membership authority ---------------
-- The ONLY change versus the pre-135 body is WHERE membership comes from. Everything
-- else -- method validation, session/actor identity, L0, the DRIVER_STATO FOR UPDATE
-- read, the RETIRADO replay branch, money-first sequencing, the tolerated
-- AUTH_LEGACY_IMPORT_REQUIRED, the operative-only UPDATE, and the RIDER_STOP_LOST_RACE
-- RAISE -- is preserved verbatim, including comments.
CREATE OR REPLACE FUNCTION public.rider_collect_and_complete_stop(
  p_order_id text, p_metodo_pago text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_by       public.auth_actors%ROWTYPE;
  v_ds       jsonb;
  v_active   jsonb;
  v_canon    jsonb;
  v_estado   text;
  v_updated  int;
  v_method   text;
  v_meta     jsonb;
  v_pay      jsonb := NULL;
  v_pay_note text := NULL;
BEGIN
  v_method := lower(btrim(COALESCE(p_metodo_pago, '')));

  -- Only real door-collection methods. Anything else (notably the operator override
  -- "manual", or an empty string for an already-prepaid order) means NO money is claimed:
  -- the stop still completes, but nothing is written to the ledger and no flag is invented.
  IF v_method <> '' AND v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_METHOD_INVALID');
  END IF;

  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- L0 (W6.1 protocol) -- MOVED UP by W6.3, from after the auth_actors row lock to here:
  -- after pure input validation, before EVERY other lock. trip_authority.trips.rider_actor
  -- has a FOREIGN KEY to auth_actors, so start_rider_trip_v2's INSERT implicitly takes
  -- FOR KEY SHARE on the rider's actor row; with the old ordering that was a real ABBA
  -- deadlock against the FOR UPDATE below the moment v2 went live. Nothing else about
  -- this function's ordering, refusal codes or lock strengths changes.
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  -- IDENTITY. Role must be exactly 'rider' — this contract never serves admin/operator,
  -- and never lets a rider borrow their authority.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  -- W6.3 -- ASSIGNMENT. The order must belong to the currently active delivery.
  -- Membership is the rider's authority to collect on it; without this any rider could
  -- pay off any order. When a CANONICAL trip exists, trip_authority.trip_members is that
  -- authority and DRIVER_STATO is only a compatibility projection, so the canonical path
  -- always wins. With no canonical trip the pre-135 legacy path runs unchanged, so an
  -- in-flight pre-cutover DRIVER_STATO trip can still be collected and closed safely.
  -- A display order id that does not resolve to a frozen member is NON_MEMBER on both
  -- paths -- identical to the legacy behaviour for an id absent from the snapshot.
  v_canon := public.trip_authority_active_trip_v1();
  IF COALESCE((v_canon->>'exists')::boolean, false) THEN
    IF NOT (v_canon->'member_order_ids' ? p_order_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
    END IF;
  ELSE
    IF v_active IS NULL OR jsonb_typeof(v_active) <> 'object' OR (v_active->>'status') <> 'ACTIVE' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
    END IF;
    IF NOT (v_active->'order_ids' ? p_order_id) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
    END IF;
  END IF;

  SELECT estado INTO v_estado FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Server-forced provenance. The client cannot claim a different source.
  v_meta := COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', 'rider_delivery');

  IF v_estado = 'RETIRADO' THEN
    -- Operative replay. The collection may still need reconciling: a rider whose first
    -- request completed the stop but died before the money was recorded must be able to
    -- retry. The deterministic key makes an honest retry a digest-identical replay.
    IF v_method <> '' THEN
      BEGIN
        v_pay := public._ledger_write_payment(
          p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
        v_pay_note := SQLERRM;
        IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
        END IF;
      END;
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id,
                              'payment', v_pay, 'payment_note', v_pay_note);
  END IF;

  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  -- MONEY FIRST. A refusal here returns before the stop is completed, and the subtransaction
  -- has already rolled the attempted payment back: nothing half-written either way.
  -- AUTH_LEGACY_IMPORT_REQUIRED is the single tolerated refusal — that money is already on
  -- record in the pre-ledger representation, and re-recording it would double-count.
  IF v_method <> '' THEN
    BEGIN
      v_pay := public._ledger_write_payment(
        p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
      v_pay_note := SQLERRM;
      IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
      END IF;
    END;
  END IF;

  -- OPERATIVE completion ONLY. cobrado / metodo_pago are deliberately absent here:
  -- RETIRADO does not mean paid, and _ledger_write_payment is the sole writer of those
  -- columns. A prepaid or unpaid-on-delivery stop completes with the flags untouched.
  UPDATE public.ordenes
    SET estado       = 'RETIRADO',
        hora_entrega = (extract(epoch FROM now()) * 1000)::bigint
  WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Lost the race after taking the money: ABORT so the recorded payment cannot survive
    -- a stop that did not complete. Must RAISE, never RETURN.
    RAISE EXCEPTION 'RIDER_STOP_LOST_RACE' USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id,
                            'payment', v_pay, 'payment_note', v_pay_note);
END;
$fn$;

-- 8. public.close_rider_trip -- canonical-aware close ----------------------------------------
-- The canonical branch sits in front of the pre-135 body, which is preserved verbatim
-- below it as the legacy fallback. A canonical trip is closed from its own frozen
-- membership; DRIVER_STATO and delivery_logs are written as compatibility output only.
CREATE OR REPLACE FUNCTION public.close_rider_trip(p_trigger_order_id text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ds        jsonb;
  v_active    jsonb;
  v_order_ids      text[];
  v_pending        int;
  v_raw_count      int;
  v_distinct_count int;
  v_snapshot_count int;
  v_found          int;
  v_now       timestamptz := now();
  v_closed    jsonb;
  v_canon     jsonb;
  v_base      jsonb;
  v_res       jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  -- W6.3 CANONICAL CLOSE. Runs BEFORE any DRIVER_STATO shape validation on purpose: the
  -- canonical trip is the authority, and a malformed compatibility blob must not be able
  -- to strand a real trip ACTIVE. Membership is the COMPLETE frozen trip_members set.
  v_canon := public.trip_authority_active_trip_v1();
  IF COALESCE((v_canon->>'exists')::boolean, false) THEN
    IF p_trigger_order_id IS NOT NULL AND NOT (v_canon->'member_order_ids' ? p_trigger_order_id) THEN
      RETURN jsonb_build_object('ok', true, 'code', 'NON_MEMBER_NOOP');
    END IF;
    IF COALESCE((v_canon->>'missing_member_count')::int, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'MISSING_TRIP_MEMBER');
    END IF;
    IF COALESCE((v_canon->>'non_terminal_member_count')::int, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'EARLY_CLOSE');
    END IF;

    -- The transition itself re-validates completeness and terminality independently.
    v_res := public.trip_authority_close_active_trip_v1((v_canon->>'trip_id')::uuid);
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RETURN jsonb_build_object('ok', false, 'code', COALESCE(v_res->>'code', 'INTERNAL'));
    END IF;

    -- COMPATIBILITY OUTPUT ONLY, derived from the canonical facts just committed.
    v_base := CASE WHEN v_active IS NOT NULL AND jsonb_typeof(v_active) = 'object' THEN v_active ELSE '{}'::jsonb END;
    v_closed := v_base || jsonb_build_object(
      'trip_id',         v_canon->>'trip_id',
      'anchor_order_id', v_canon->'anchor_order_id',
      'order_ids',       v_canon->'member_order_ids',
      'manual_giro_ids', CASE WHEN v_canon->>'giro_id' IS NULL THEN '[]'::jsonb
                              ELSE jsonb_build_array(v_canon->>'giro_id') END,
      'zone_sequence',   v_canon->'zone_sequence',
      'n_orders',        COALESCE((v_canon->>'member_count')::int, 0),
      'started_at',      v_canon->'departed_at',
      'trip_version',    1,
      'status',          'CLOSED',
      'closed_at',       to_jsonb(v_now));

    v_ds := COALESCE(v_ds, '{}'::jsonb) || jsonb_build_object(
      'stato',            'LIBERO',
      'rientro_stimato',  to_jsonb(v_now),
      'active_trip',      'null'::jsonb,
      'last_closed_trip', v_closed
    );

    INSERT INTO public.config (chiave, valore) VALUES ('DRIVER_STATO', v_ds::text)
    ON CONFLICT (chiave) DO UPDATE SET valore = EXCLUDED.valore;

-- language-guard: allow-legacy n_ordini is the existing delivery_logs column name written verbatim by close_rider_trip, not new vocabulary
    INSERT INTO public.delivery_logs (zona, n_ordini, partito_alle, ultimo_entregado, rientro_stimato)
    VALUES (
      (v_canon->'zone_sequence'->>0),
      COALESCE(NULLIF((v_canon->>'member_count')::int, 0), 1),
      NULLIF(v_canon->>'departed_at', '')::timestamptz,
      v_now,
      v_now
    );

    RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_closed);
  END IF;

  -- ── LEGACY (DRIVER_STATO-only) PATH, preserved verbatim from the pre-135 body ──
  IF v_active IS NOT NULL AND jsonb_typeof(v_active) <> 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  IF v_active IS NULL OR (v_active->>'status') <> 'ACTIVE' THEN
    IF v_ds ? 'last_closed_trip' AND (v_ds->'last_closed_trip') <> 'null'::jsonb THEN
      RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT',
                                'snapshot', v_ds->'last_closed_trip');
    END IF;
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  IF p_trigger_order_id IS NOT NULL AND NOT (v_active->'order_ids' ? p_trigger_order_id) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NON_MEMBER_NOOP');
  END IF;

  IF jsonb_typeof(v_active->'order_ids') <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  SELECT count(*), count(DISTINCT value::text)
    INTO v_raw_count, v_distinct_count
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  v_snapshot_count := CASE
    WHEN COALESCE(v_active->>'n_orders', '') ~ '^[0-9]+$' THEN (v_active->>'n_orders')::int
    ELSE -1
  END;

  IF v_raw_count <> v_distinct_count OR v_snapshot_count <> v_raw_count THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_TRIP_SNAPSHOT');
  END IF;

  SELECT array_agg(DISTINCT value::text) INTO v_order_ids
  FROM jsonb_array_elements_text(v_active->'order_ids') AS value;

  SELECT count(*) INTO v_found FROM public.ordenes WHERE id = ANY(v_order_ids);
  IF v_found <> v_raw_count THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MISSING_TRIP_MEMBER');
  END IF;

  SELECT count(*) INTO v_pending
  FROM public.ordenes
  WHERE id = ANY(v_order_ids)
-- language-guard: allow-legacy COMPLETATO is close_rider_trip's own pre-135 ordenes.estado terminal literal, reproduced verbatim, not new vocabulary
    AND estado NOT IN ('RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','ANULADO');

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EARLY_CLOSE');
  END IF;

  v_closed := (v_active
    || jsonb_build_object('status', 'CLOSED', 'closed_at', to_jsonb(v_now)));

  v_ds := v_ds || jsonb_build_object(
    'stato',            'LIBERO',
    'rientro_stimato',  to_jsonb(v_now),
    'active_trip',      'null'::jsonb,
    'last_closed_trip', v_closed
  );

  UPDATE public.config SET valore = v_ds::text WHERE chiave = 'DRIVER_STATO';

-- language-guard: allow-legacy n_ordini is the existing delivery_logs column name written verbatim by close_rider_trip, not new vocabulary
  INSERT INTO public.delivery_logs (zona, n_ordini, partito_alle, ultimo_entregado, rientro_stimato)
  VALUES (
    (v_active->'zone_sequence'->>0),
    COALESCE((v_active->>'n_orders')::int, 1),
    NULLIF(v_active->>'started_at', '')::timestamptz,
    v_now,
    v_now
  );

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'snapshot', v_closed);
END;
$fn$;

-- 9. giro_authority.derive_giros_v1 -- W6.4 frozen membership after departure ----------------
-- Identical to migration 130's body except for the canonical branch: three new CTEs
-- (ct / ctm / ca) sourced from trip_authority, a canonical arm in the state and reason
-- expressions, a canonical arm in the effective-membership LATERAL, and a canonical arm
-- in salida / salida_source. The legacy (no canonical trip) behaviour is byte-for-byte
-- the pre-135 behaviour. Reading trip_authority here is safe because every entry path
-- into this function is SECURITY DEFINER owned by postgres (the nine public Authority
-- commands, giro_projection_v1, order_effective_giro_v1, target_fingerprint_v1 and the
-- capture trigger) -- verified against the live catalog.
CREATE OR REPLACE FUNCTION giro_authority.derive_giros_v1(p_giro_ids text[], p_scope uuid[], p_trip jsonb)
RETURNS TABLE (
  giro_id text, seq integer, business_date date, hora_ref text, anchor_order_uid uuid,
  created_at timestamptz, created_by text, dissolved_at timestamptz, dissolved_by text,
  giro_state text, state_reason text,
  effective_order_uids uuid[], effective_order_ids text[], active_order_uids uuid[],
  salida text, salida_source text
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH trip AS (
    SELECT ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'order_ids') = 'array'
                                                       THEN p_trip->'order_ids' ELSE '[]'::jsonb END)) AS order_ids,
           ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'giro_ids') = 'array'
                                                       THEN p_trip->'giro_ids' ELSE '[]'::jsonb END)) AS giro_ids
  ),
  g AS (
    SELECT mg.id, mg.seq, mg.business_date, mg.hora_ref, mg.anchor_order_uid, mg.created_at,
           mg.created_by, mg.dissolved_at, mg.dissolved_by
      FROM public.manual_giros mg
     WHERE mg.id = ANY (p_giro_ids)
  ),
  -- W6.4: the canonical trip (at most one, enforced by trips_one_trip_per_giro_v1) that
  -- this giro departed as. Its existence -- not its status -- is what makes Trip
  -- Authority the membership authority from here on.
  ct AS (
    SELECT t.giro_id AS g_id, t.trip_id, t.status AS trip_status, t.departed_at
      FROM trip_authority.trips t
     WHERE t.giro_id = ANY (p_giro_ids)
  ),
  -- The immutable frozen membership. Never filtered by delivery state: progress is a
  -- separate derivation (ca.n_outstanding below), never a deletion from this set.
  ctm AS (
    SELECT ct.g_id, ct.trip_id, tm.order_uid AS uid, tm.stop_seq, o.id AS oid, o.estado,
           (o.id IS NOT NULL AND NOT (o.estado = ANY (trip_authority.progress_terminal_states_v1()))) AS still_out
      FROM ct
      JOIN trip_authority.trip_members tm ON tm.trip_id = ct.trip_id
      LEFT JOIN public.ordenes o ON o.order_uid = tm.order_uid
  ),
  ca AS (
    SELECT ctm.g_id, count(*) AS n_members, count(*) FILTER (WHERE ctm.still_out) AS n_outstanding
      FROM ctm GROUP BY ctm.g_id
  ),
  k AS (
    SELECT gm.giro_id AS g_id, gm.order_uid AS uid, o.id AS oid, o.estado, o.forno_out,
           (o.id IS NOT NULL) AS present,
           COALESCE(o.id = ANY (t.order_ids), false) AS in_active_trip,
           COALESCE(p_scope IS NULL OR o.service_session_id = ANY (p_scope), false) AS in_scope
      FROM giro_authority.giro_members gm
      CROSS JOIN trip t
      LEFT JOIN public.ordenes o ON o.order_uid = gm.order_uid
     WHERE gm.giro_id = ANY (p_giro_ids)
  ),
  kc AS (
    SELECT k.*,
           (k.present AND (k.in_active_trip OR k.estado = 'EN_ENTREGA')) AS departed_live,
           (k.present AND k.estado = ANY (giro_authority.delivered_states_v1())) AS delivered,
           (k.present AND k.estado IN ('EN_COCINA', 'LISTO') AND NOT k.in_active_trip) AS pre_departure
      FROM k
  ),
  a AS (
    SELECT kc.g_id,
           count(*) FILTER (WHERE kc.departed_live)                  AS n_departed,
           count(*) FILTER (WHERE kc.delivered)                      AS n_delivered,
           count(*) FILTER (WHERE kc.pre_departure AND kc.in_scope)  AS n_pre_scope,
           count(*) FILTER (WHERE kc.pre_departure)                  AS n_pre_any
      FROM kc GROUP BY kc.g_id
  ),
  st AS (
    SELECT g.*, ct.trip_id AS ct_trip_id, ct.trip_status AS ct_status, ct.departed_at AS ct_departed_at,
           CASE WHEN g.dissolved_at IS NOT NULL THEN 'DISSOLVED'
                -- W6.4 canonical arm: IN_TRIP while the linked trip is ACTIVE and at
                -- least one frozen member is still non-terminal; DONE once every frozen
                -- member is terminal OR the linked trip is CLOSED. Never reverts to the
                -- current giro_members, in any of those phases.
                WHEN ct.trip_id IS NOT NULL THEN
                  CASE WHEN ct.trip_status = 'ACTIVE' AND COALESCE(ca.n_outstanding, 0) > 0
                       THEN 'IN_TRIP' ELSE 'DONE' END
                WHEN COALESCE(a.n_departed, 0) > 0 OR g.id = ANY (t.giro_ids) THEN 'IN_TRIP'
                WHEN COALESCE(a.n_delivered, 0) > 0 THEN 'DONE'
                WHEN COALESCE(a.n_pre_scope, 0) >= 2 THEN 'PLANNED'
                ELSE 'DISSOLVED' END AS g_state,
           CASE WHEN g.dissolved_at IS NOT NULL THEN 'EXPLICIT'
                WHEN ct.trip_id IS NOT NULL THEN
                  CASE WHEN ct.trip_status = 'ACTIVE' AND COALESCE(ca.n_outstanding, 0) > 0
                       THEN 'DEPARTED' ELSE 'DELIVERED' END
                WHEN COALESCE(a.n_departed, 0) > 0 OR g.id = ANY (t.giro_ids) THEN 'DEPARTED'
                WHEN COALESCE(a.n_delivered, 0) > 0 THEN 'DELIVERED'
                WHEN COALESCE(a.n_pre_scope, 0) >= 2 THEN 'OPERATIVE'
                WHEN COALESCE(a.n_pre_any, 0) >= 2 THEN 'SERVICE_CLOSED'
                ELSE 'BELOW_MIN_MEMBERS' END AS g_reason
      FROM g CROSS JOIN trip t
      LEFT JOIN a ON a.g_id = g.id
      LEFT JOIN ct ON ct.g_id = g.id
      LEFT JOIN ca ON ca.g_id = g.id
  )
  SELECT st.id, st.seq, st.business_date, st.hora_ref, st.anchor_order_uid, st.created_at,
         st.created_by, st.dissolved_at, st.dissolved_by, st.g_state, st.g_reason,
         COALESCE(eff.uids, '{}'::uuid[]), COALESCE(eff.oids, '{}'::text[]), COALESCE(act.uids, '{}'::uuid[]),
         CASE WHEN st.g_state = 'DISSOLVED' THEN NULL
              -- W6.4: the REAL departure replaces the planned salida once the giro has
              -- departed. hora_ref (the operator-planned fact) is read-only here and is
              -- never overwritten -- it keeps flowing out on its own column.
              WHEN st.ct_trip_id IS NOT NULL THEN trip_authority.departed_hhmm_v1(st.ct_departed_at)
              WHEN giro_authority.hhmm_norm(st.hora_ref) IS NOT NULL THEN giro_authority.hhmm_norm(st.hora_ref)
              ELSE px.salida END,
         CASE WHEN st.g_state = 'DISSOLVED' THEN 'NONE'
              WHEN st.ct_trip_id IS NOT NULL THEN 'DEPARTED'
              WHEN giro_authority.hhmm_norm(st.hora_ref) IS NOT NULL THEN 'OPERATOR'
              WHEN px.salida IS NOT NULL THEN 'PROXY_MAX_FORNO'
              ELSE 'NONE' END
    FROM st
    LEFT JOIN LATERAL (
      SELECT array_agg(e.uid ORDER BY e.uid) AS uids, array_agg(e.oid ORDER BY e.uid) AS oids
        FROM (
          -- Canonical: the exact immutable frozen membership, every phase, unfiltered.
          SELECT ctm.uid, ctm.oid FROM ctm
           WHERE st.ct_trip_id IS NOT NULL AND ctm.g_id = st.id
          UNION ALL
          -- Legacy (no canonical trip): the pre-135 derivation, unchanged.
          SELECT kc.uid, kc.oid FROM kc
           WHERE st.ct_trip_id IS NULL AND kc.g_id = st.id
             AND (   (st.g_state = 'PLANNED' AND kc.pre_departure AND kc.in_scope)
                  OR (st.g_state = 'IN_TRIP' AND (kc.departed_live OR kc.delivered))
                  OR (st.g_state = 'DONE'    AND kc.delivered))
        ) AS e
    ) eff ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(kc.uid ORDER BY kc.uid) AS uids
        FROM kc
       WHERE kc.g_id = st.id AND kc.present AND kc.estado IN ('EN_COCINA', 'LISTO', 'EN_ENTREGA')
    ) act ON true
    LEFT JOIN LATERAL (
      SELECT giro_authority.hhmm_norm(kc.forno_out) AS salida
        FROM kc
       WHERE kc.g_id = st.id AND kc.uid = ANY (COALESCE(eff.uids, '{}'::uuid[]))
         AND giro_authority.service_day_minutes(kc.forno_out) IS NOT NULL
       ORDER BY giro_authority.service_day_minutes(kc.forno_out) DESC
       LIMIT 1
    ) px ON true
$fn$;

-- 10. Ownership, search_path, grants -- least privilege ---------------------------------------
ALTER FUNCTION trip_authority.close_terminal_states_v1() OWNER TO postgres;
ALTER FUNCTION trip_authority.progress_terminal_states_v1() OWNER TO postgres;
ALTER FUNCTION trip_authority.departed_hhmm_v1(timestamptz) OWNER TO postgres;
ALTER FUNCTION public.trip_authority_active_trip_v1() OWNER TO postgres;
ALTER FUNCTION public.trip_authority_close_active_trip_v1(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION trip_authority.close_terminal_states_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION trip_authority.progress_terminal_states_v1() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION trip_authority.departed_hhmm_v1(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.trip_authority_active_trip_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trip_authority_close_active_trip_v1(uuid) FROM PUBLIC, anon, authenticated;
-- service_role only: rider_collect_and_complete_stop and close_rider_trip are SECURITY
-- INVOKER and run as service_role, so they need EXECUTE here. Neither helper is
-- registered in the H1B resource policy, so Node's gated sbRpc transport still cannot
-- reach either of them.
GRANT EXECUTE ON FUNCTION public.trip_authority_active_trip_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.trip_authority_close_active_trip_v1(uuid) TO service_role;
-- start_rider_trip_v2, rider_collect_and_complete_stop, close_rider_trip,
-- trip_facts_canonical_v1 and derive_giros_v1 keep the grants they already carry
-- (CREATE OR REPLACE preserves existing privileges); nothing to re-grant.

-- 11. Post-conditions ---------------------------------------------------------------------------
DO $$
DECLARE
  r     record;
  v_src text;
  v_keys text[];
BEGIN
  -- Schema security posture is unchanged: trip_authority is still unreachable directly
  -- by every API role (this is why the two public SECURITY DEFINER helpers exist).
  IF has_schema_privilege('anon', 'trip_authority', 'USAGE') OR has_schema_privilege('authenticated', 'trip_authority', 'USAGE')
     OR has_schema_privilege('service_role', 'trip_authority', 'USAGE') THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: an API role holds USAGE on schema trip_authority';
  END IF;
  FOR r IN SELECT * FROM (VALUES ('trips'), ('trip_members')) AS t(relname) LOOP
    IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
             WHERE relnamespace = 'trip_authority'::regnamespace AND relname = r.relname) THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: trip_authority.% is not RLS-enabled+forced', r.relname;
    END IF;
  END LOOP;

  -- ONE TRIP PER GIRO is a real index, not a convention, and is partial on non-null giro_id
  -- so single non-giro trips stay unconstrained.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'trip_authority' AND tablename = 'trips'
                   AND indexname = 'trips_one_trip_per_giro_v1' AND indexdef ILIKE '%WHERE (giro_id IS NOT NULL)%') THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: trips_one_trip_per_giro_v1 partial unique index missing or not partial';
  END IF;
  -- Migration 134's own invariants survive.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'trip_authority' AND tablename = 'trips'
                   AND indexname = 'trips_one_active_v1') THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: trips_one_active_v1 disappeared';
  END IF;

  -- PARTIAL_GIRO_DEPARTURE_FORBIDDEN: start_rider_trip_v2 no longer narrows a canonical
  -- giro's membership to the LISTO subset, and freezes the complete effective set.
  v_src := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);
  IF v_src LIKE '%o.estado = ''LISTO''%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: start_rider_trip_v2 still narrows giro membership to the LISTO subset';
  END IF;
  IF v_src NOT LIKE '%v_uids := d.effective_order_uids;%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: start_rider_trip_v2 does not freeze the complete effective member set';
  END IF;
  IF v_src NOT LIKE '%SERVICE_CLOSING%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: start_rider_trip_v2 lost the S2-1H service-close gate';
  END IF;
  IF v_src LIKE '%public.auth_actors WHERE actor = p_actor FOR UPDATE%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: start_rider_trip_v2 still locks auth_actors after L0 (ABBA deadlock with rider_collect_and_complete_stop)';
  END IF;
  -- L0 must still be the literal first executable statement: it precedes the identity
  -- read, every giro/order lock and the DRIVER_STATO row lock. (Compared against the
  -- identity SELECT, not the bare table name -- auth_actors also appears in DECLARE.)
  IF position('LA_DIECI_DRIVER_STATO' IN v_src) = 0
     OR position('LA_DIECI_DRIVER_STATO' IN v_src) > position('WHERE actor = p_actor' IN v_src)
     OR position('LA_DIECI_DRIVER_STATO' IN v_src) > position('FROM public.manual_giros mg' IN v_src)
     OR position('LA_DIECI_DRIVER_STATO' IN v_src) > position('lock_orders_v1' IN v_src) THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: start_rider_trip_v2 no longer takes L0 first';
  END IF;

  -- CANONICAL_COLLECT_LIVE: membership authority is trip_members, and every certified
  -- money/auth/race literal is still present.
  v_src := pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure);
  IF v_src NOT LIKE '%trip_authority_active_trip_v1%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: rider_collect_and_complete_stop is not canonical-aware';
  END IF;
  IF v_src NOT LIKE '%member_order_ids%' OR v_src NOT LIKE '%v_active->''order_ids'' ? p_order_id%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: rider_collect_and_complete_stop lost either the canonical or the legacy membership path';
  END IF;
  IF v_src NOT LIKE '%RIDER_STOP_LOST_RACE%' OR v_src NOT LIKE '%ERRCODE=''40001''%'
     OR v_src NOT LIKE '%AUTH_LEGACY_IMPORT_REQUIRED%' OR v_src NOT LIKE '%PAYMENT_REFUSED%'
     OR v_src NOT LIKE '%AUTH_FORBIDDEN_ROLE%' OR v_src NOT LIKE '%AUTH_METHOD_INVALID%'
     OR v_src NOT LIKE '%hora_entrega%' OR v_src NOT LIKE '%estado = ''EN_ENTREGA''%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: rider_collect_and_complete_stop lost a certified auth/money/transition literal';
  END IF;
  -- The money block must still be BEFORE the operative completion (money-first), and the
  -- ledger writer must still be the only money writer on this path.
  IF position('_ledger_write_payment' IN v_src) = 0
     OR position('_ledger_write_payment' IN v_src) > position('SET estado       = ''RETIRADO''' IN v_src) THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: rider_collect_and_complete_stop lost money-first sequencing';
  END IF;
  -- W6.1 protocol, now without exception: L0 precedes EVERY other lock this function
  -- takes (the auth_actors row lock and the DRIVER_STATO config row lock alike).
  IF position('LA_DIECI_DRIVER_STATO' IN v_src) = 0
     OR position('LA_DIECI_DRIVER_STATO' IN v_src) > position('WHERE actor = p_by_actor FOR UPDATE' IN v_src)
     OR position('LA_DIECI_DRIVER_STATO' IN v_src) > position('WHERE chiave = ''DRIVER_STATO'' FOR UPDATE' IN v_src) THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: rider_collect_and_complete_stop does not take L0 before every other lock';
  END IF;
  IF v_src ILIKE '%INSERT INTO public.order_financial_events%' OR v_src ILIKE '%INSERT INTO public.payment_transactions%'
     OR v_src ILIKE '%SET cobrado%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: rider_collect_and_complete_stop gained a direct money writer';
  END IF;
  -- Security posture of the two rewritten lifecycle functions is unchanged: still
  -- SECURITY INVOKER with their original search_path.
  FOR r IN SELECT * FROM (VALUES
      ('rider_collect_and_complete_stop', 'public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'),
      ('close_rider_trip', 'public.close_rider_trip(text)')
    ) AS t(proname, sig)
  LOOP
    IF (SELECT prosecdef FROM pg_proc WHERE oid = r.sig::regprocedure) THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: % must stay SECURITY INVOKER', r.proname;
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = r.sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: % must keep search_path=public, pg_temp', r.proname;
    END IF;
  END LOOP;

  -- CANONICAL_CLOSE_LIVE + LEGACY_INFLIGHT_FALLBACK.
  v_src := pg_get_functiondef('public.close_rider_trip(text)'::regprocedure);
  IF v_src NOT LIKE '%trip_authority_active_trip_v1%' OR v_src NOT LIKE '%trip_authority_close_active_trip_v1%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: close_rider_trip is not canonical-aware';
  END IF;
  IF v_src NOT LIKE '%INVALID_TRIP_SNAPSHOT%' OR v_src NOT LIKE '%last_closed_trip%'
     OR v_src NOT LIKE '%NON_MEMBER_NOOP%' OR v_src NOT LIKE '%EARLY_CLOSE%'
     OR v_src NOT LIKE '%MISSING_TRIP_MEMBER%' OR v_src NOT LIKE '%delivery_logs%'
-- language-guard: allow-legacy COMPLETATO is close_rider_trip's own pre-135 ordenes.estado terminal literal, reproduced verbatim, not new vocabulary
     OR v_src NOT LIKE '%''RETIRADO'',''COMPLETADO'',''COMPLETATO'',''CANCELADO'',''ANULADO''%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: close_rider_trip lost a certified legacy-path literal';
  END IF;
  IF position('LA_DIECI_DRIVER_STATO' IN v_src) = 0
     OR position('LA_DIECI_DRIVER_STATO' IN v_src) > position('trip_authority_active_trip_v1' IN v_src) THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: close_rider_trip no longer takes L0 before reading canonical facts';
  END IF;

  -- The two new helpers: owner postgres, pinned search_path, API roles barred,
  -- service_role only.
  FOR r IN SELECT * FROM (VALUES
      ('trip_authority_active_trip_v1', 'public.trip_authority_active_trip_v1()'),
      ('trip_authority_close_active_trip_v1', 'public.trip_authority_close_active_trip_v1(uuid)')
    ) AS t(proname, sig)
  LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = r.sig::regprocedure) THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: % must be SECURITY DEFINER', r.proname;
    END IF;
    IF pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = r.sig::regprocedure)) <> 'postgres' THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: % must be owned by postgres', r.proname;
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = r.sig::regprocedure) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: % must pin search_path=pg_catalog, pg_temp', r.proname;
    END IF;
    IF has_function_privilege('anon', r.sig::regprocedure, 'EXECUTE') OR has_function_privilege('authenticated', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: anon/authenticated may execute %', r.proname;
    END IF;
    IF NOT has_function_privilege('service_role', r.sig::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: service_role must be able to execute %', r.proname;
    END IF;
  END LOOP;

  -- W6.4: the canonical membership fact is no longer filtered by delivery state, its key
  -- set is unchanged (so trip_facts_v1 stays byte-identical), and derive_giros_v1 carries
  -- the canonical arms.
  v_src := pg_get_functiondef('trip_authority.trip_facts_canonical_v1()'::regprocedure);
  IF v_src ILIKE '%delivered_states_v1%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: trip_facts_canonical_v1 still filters delivered members out of the membership fact';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(trip_authority.trip_facts_canonical_v1()) AS k;
  IF v_keys IS DISTINCT FROM ARRAY['active', 'available', 'canonical_trip_exists', 'giro_ids', 'order_ids'] THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: trip_facts_canonical_v1 key set moved (got %)', v_keys;
  END IF;
  v_src := pg_get_functiondef('giro_authority.derive_giros_v1(text[],uuid[],jsonb)'::regprocedure);
  IF v_src NOT LIKE '%trip_authority.trip_members%' OR v_src NOT LIKE '%trip_authority.trips%'
     OR v_src NOT LIKE '%''DEPARTED''%' OR v_src NOT LIKE '%departed_hhmm_v1%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: derive_giros_v1 is not canonical-aware';
  END IF;
  -- The W3 contract still holds for this function: no raw manual_giro_id read, no
  -- calendar-day or Madrid-clock literal in its own body (that lives in
  -- trip_authority.departed_hhmm_v1 alone), and hora_ref is still read-only.
  IF v_src ILIKE '%manual_giro_id%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: derive_giros_v1 reads a raw manual_giro_id column';
  END IF;
  IF v_src ~* 'CURRENT_DATE|AT\s+TIME\s+ZONE|Europe/Madrid|now\(\)\s*::\s*date' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: derive_giros_v1 gained calendar-day / wall-clock logic of its own';
  END IF;
  IF v_src ILIKE '%UPDATE public.manual_giros%' OR v_src ILIKE '%INSERT INTO%' OR v_src ILIKE '%DELETE FROM%' THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: derive_giros_v1 is no longer read-only';
  END IF;

  -- trip_facts_v1's public output shape is unchanged: it still strips the one internal key.
  SELECT array_agg(k ORDER BY k) INTO v_keys FROM jsonb_object_keys(giro_authority.trip_facts_v1()) AS k;
  IF 'canonical_trip_exists' = ANY (v_keys) THEN
    RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: trip_facts_v1 leaks canonical_trip_exists';
  END IF;

  -- Every sibling this migration does not intend to touch: byte-identical.
  FOR r IN SELECT proname, sig, checksum AS before FROM w6_34_untouched_before LOOP
    IF md5(pg_get_functiondef(r.sig::regprocedure)) <> r.before THEN
      RAISE EXCEPTION 'W6_3_4_RIDER_LIFECYCLE post-condition failed: % changed (expected byte-identical to pre-135)', r.proname;
    END IF;
  END LOOP;
END $$;

COMMIT;
