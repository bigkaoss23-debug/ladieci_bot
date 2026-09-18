-- migrations/2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137.sql
-- Paired rollback: 2026-09-17_b1_rider_dispatch_operator_parity_v1_migration_137.ROLLBACK.sql
--
-- POST_UAT_BLOCKER_FIX_2026-09-17 / POST_OPUS_REVIEW_REMEDIATION_2026-09-18 — B1 (rider/
-- Planner dispatch AUTH_FORBIDDEN_ROLE), repaired per the independent Opus delta review
-- (POST_UAT_BLOCKER_FIX_OPUS_REVIEW_2026-09-17.md §1) and a subsequent product correction.
--
-- THE FINDING (unchanged from the first draft, source-verified against staging
-- tdikhfeinufaahagmpjz, ledger tip 136):
--   * legacyActionRoles.js (the live authorization source) already grants 'admin',
--     'operator' AND 'rider' the HTTP-level right to call the "marcarEnEntrega" legacy
--     action (it is not in ADMIN_ONLY, so operator is allowed; it is in RIDER_ALLOWED, so
--     rider is allowed; admin may call every valid action).
--   * index.js routes every "marcarEnEntrega" call whose authCtx.rule.tripPrimitive is
--     true (true for this action, unconditionally) through routeRiderTripAction ->
--     riderTrip.startTrip -> this RPC, regardless of the caller's role.
--   * This RPC (migration 135) required v_by.role = 'rider' EXACTLY, so any admin/operator
--     call the HTTP layer had just approved was refused here with AUTH_FORBIDDEN_ROLE — a
--     dead permission grant: the HTTP gate says yes, the canonical authority always says no.
--
-- THE FIX, PART 1 (IDENTITY): start_rider_trip_v2 is byte-identical to migration 135's
-- body except the single IDENTITY check, now accepting the exact role set
-- legacyActionRoles.js already grants for this action (admin, operator, rider) instead of
-- 'rider' alone — the same "role IN (...)" predicate shape already used by the B7
-- financial RPCs. Trip/Giro Authority stays the sole writer: same table, same
-- transaction, same atomic membership/lock discipline — only WHO may call it changes.
--
-- THE FIX, PART 2 (IDENTITY TRUTH — new in this repair). Widening WHO may depart must not
-- silently rename WHAT gets recorded. Before this migration, `rider_actor` was written
-- unconditionally to the caller's own actor id — correct when only a rider could ever
-- call this function, but a data-truth defect the moment an operator can: an
-- operator-initiated departure would record the OPERATOR as `rider_actor`, and the real
-- rider — who today is never selected anywhere in this flow (`asignarRepartidor` only
-- free-texts a display label; no canonical rider-assignment step exists) — would become
-- unrecorded anywhere on the trip. Fix: `trip_authority.trips` gains a new
-- `dispatched_by` column, ALWAYS set to the calling actor (rider, operator, or admin) —
-- the truthful audit fact of who pressed the control. `rider_actor` keeps meaning exactly
-- what its name says: it is set to the caller ONLY when that caller's role is 'rider', and
-- is NULL otherwise, honestly representing "the confirmed rider is not yet known" rather
-- than a false identity claim.
--
-- THE FIX, PART 3 (COMPLETION PATH — product correction, 2026-09-18). Money-collection
-- (`rider_collect_and_complete_stop`, reached from `marcarEntregado`) is explicitly NOT
-- widened here and stays rider-exclusive by design — its own header states "this contract
-- never serves admin/operator", and only the physical rider can know a delivery actually
-- happened. The operator/owner-facing "Delivery" surface (TabEntregas.jsx) is corrected in
-- the same packet to stop calling `marcarEntregado` (which it was doing under the "Driver
-- de vuelta" control, forcing a specific order to RETIRADO) and instead call
-- language-guard: allow-legacy chiudiGiro is the existing legacy-action name for close_rider_trip, cited here for context, not new vocabulary
-- `chiudiGiro`/`close_rider_trip` — an ALREADY-EXISTING, already HTTP-authorized-for-
-- operator, canonical action with no role check of its own, whose own guard
-- (EARLY_CLOSE/MISSING_TRIP_MEMBER) fails closed until every member order is independently
-- terminal. This migration does not touch close_rider_trip; it is documented here because
-- it is the reason "driver returned" and "delivery confirmed" can now be cleanly separated
-- without loosening rider-only money collection anywhere. See
-- POST_OPUS_REVIEW_REMEDIATION_REPORT_2026-09-18.md, Scope A.
--
-- THE FIX, PART 4 (MIGRATION QUALITY — repairs the four defects the Opus review found in
-- the first draft of this file):
-- language-guard: allow-legacy n_ordini is the existing DRIVER_STATO snapshot field name cited here for context, not new vocabulary
--   D-1 (build gate): the ROLLBACK's `n_ordini` occurrence is now allowlisted in
--       scripts/check-domain-language.js, the same treatment migration 135's ROLLBACK
--       already has and for the identical reason (a byte-identical body restoration
--       cannot carry an inline suppression marker without breaking the very byte-identity
--       it exists to prove).
--   D-2 (rollback exactness): the ROLLBACK below restores the migration-135 body
--       byte-identically, comments included — transcribed verbatim from
--       migrations/2026-09-15_planner_w6_rider_lifecycle_cutover_v1_migration_135.sql
--       lines 440-645, not hand-simplified.
--   D-3 (predecessor / drift guard): added below, pinning migration 135's exact installed
--       body by md5(prosrc), mirroring migration 136's established convention. The
--       ROLLBACK carries the matching guard (refuses if not applied, already rolled back,
--       or drifted).
--   D-4 (certification): certified on ephemeral PostgreSQL 17 via
--       ci/giro-authority-certification/harness/runB1RiderDispatchOperatorParity.js,
--       stacked on the same 130-135 candidate chain migration 135's own harness uses.
--       See MIGRATION_MANIFEST.md row 137 for the run summary.

BEGIN;

-- ── Predecessor / drift guard ─────────────────────────────────────────────────────────
-- Refuses to proceed unless the EXACT migration-135 body is installed, and unless this
-- migration has not already applied (dispatched_by absent). Mirrors migration 136's
-- established pattern.
DO $guard$
DECLARE
  v_src text;
BEGIN
  IF to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY refused: public.start_rider_trip_v2 does not exist -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])');
  IF md5(v_src) IS DISTINCT FROM '8787814e8020b6fa4322d42febc3a78a' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY refused: start_rider_trip_v2 body is not the exact ledger-135 body (md5 mismatch) -- resolve drift first';
  END IF;
  IF to_regprocedure('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY refused: public.rider_collect_and_complete_stop does not exist -- resolve drift first';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'trip_authority' AND table_name = 'trips' AND column_name = 'rider_actor'
  ) THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY refused: trip_authority.trips.rider_actor is missing -- resolve drift first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'trip_authority' AND table_name = 'trips' AND column_name = 'dispatched_by'
  ) THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY refused: trip_authority.trips.dispatched_by already exists -- this migration is already applied, resolve drift first';
  END IF;
END $guard$;

-- ── Schema: preserve rider_actor's truthful meaning ───────────────────────────────────
ALTER TABLE trip_authority.trips ADD COLUMN dispatched_by text NULL REFERENCES public.auth_actors(actor);
UPDATE trip_authority.trips SET dispatched_by = rider_actor WHERE dispatched_by IS NULL;
ALTER TABLE trip_authority.trips ALTER COLUMN dispatched_by SET NOT NULL;
ALTER TABLE trip_authority.trips ALTER COLUMN rider_actor DROP NOT NULL;
COMMENT ON COLUMN trip_authority.trips.dispatched_by IS
  'The actor (rider, operator or admin) who pressed the dispatch control. Always set. An audit/attribution field -- never treat this as "the rider".';
COMMENT ON COLUMN trip_authority.trips.rider_actor IS
  'The CONFIRMED rider, when known. NULL for an operator/admin-initiated departure, honestly, until a canonical rider-assignment step exists (see dispatched_by, and asignarRepartidor which today only free-texts a display label).';

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

  -- IDENTITY (B1, migration 137). The departure is a dispatch/logistics action, not a
  -- money-collection one — legacyActionRoles.js already lets admin/operator call this
  -- legacy action, so the canonical departure gate now matches it exactly. This does
  -- NOT touch rider_collect_and_complete_stop, which stays rider-exclusive on purpose.
  -- W6.3: deliberately NOT "FOR UPDATE". A departure writes no money, and L0 -- taken
  -- first, and exclusive -- already serializes every trip writer, so a plain read is
  -- sufficient here. Note that the INSERT into trip_authority.trips further down still
  -- takes an implicit FOR KEY SHARE on this row through the dispatched_by foreign key
  -- (always populated, unlike rider_actor which may now be NULL); that is precisely why
  -- rider_collect_and_complete_stop's own L0 had to move ahead of ITS auth_actors FOR
  -- UPDATE in migration 135 (header, correction 2(d)) -- the same structural hazard,
  -- now guarded by dispatched_by instead of rider_actor whenever the caller is not a rider.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_actor;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role NOT IN ('rider', 'admin', 'operator') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE');
  END IF;
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
  -- produce at most ONE trip in its lifetime. rider_actor (B1, migration 137) is the
  -- caller ONLY when the caller is actually a rider; dispatched_by is always the caller.
  v_trip_id := gen_random_uuid();
  INSERT INTO trip_authority.trips
    (trip_id, business_date, service_session_id, rider_actor, dispatched_by, anchor_order_uid, giro_id, departed_at, status, seq)
  VALUES
    (v_trip_id, v_dates[1], v_anchor_sess, CASE WHEN v_by.role = 'rider' THEN p_actor ELSE NULL END, p_actor,
     p_anchor_order_uid, v_giro_id, now(), 'ACTIVE', nextval('trip_authority.trips_seq_v1'));
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

-- Post-condition: the widened role predicate is present, the previously-single-role
-- literal is gone, the money-collection contract was NOT touched, and the
-- dispatched_by/rider_actor schema correctly preserves identity truth.
DO $$
DECLARE
  v_src text;
  v_col record;
BEGIN
  v_src := pg_get_functiondef('public.start_rider_trip_v2(uuid,text,integer,uuid[])'::regprocedure);
  IF v_src NOT LIKE '%v_by.role NOT IN (''rider'', ''admin'', ''operator'')%' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY post-condition failed: widened role predicate missing from start_rider_trip_v2';
  END IF;
  IF v_src LIKE '%v_by.role <> ''rider''%' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY post-condition failed: old rider-only literal still present in start_rider_trip_v2';
  END IF;
  IF v_src NOT LIKE '%CASE WHEN v_by.role = ''rider'' THEN p_actor ELSE NULL END%' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY post-condition failed: rider_actor is no longer conditionally NULLed for a non-rider dispatcher';
  END IF;
  v_src := pg_get_functiondef('public.rider_collect_and_complete_stop(text,text,text,integer,text,jsonb,text)'::regprocedure);
  IF v_src NOT LIKE '%v_by.role <> ''rider''%' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY post-condition failed: rider_collect_and_complete_stop must stay rider-exclusive, unchanged by this migration';
  END IF;

  SELECT is_nullable, column_default INTO v_col FROM information_schema.columns
   WHERE table_schema = 'trip_authority' AND table_name = 'trips' AND column_name = 'dispatched_by';
  IF NOT FOUND OR v_col.is_nullable <> 'NO' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY post-condition failed: trip_authority.trips.dispatched_by must exist and be NOT NULL';
  END IF;
  SELECT is_nullable INTO v_col FROM information_schema.columns
   WHERE table_schema = 'trip_authority' AND table_name = 'trips' AND column_name = 'rider_actor';
  IF NOT FOUND OR v_col.is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'B1_RIDER_DISPATCH_OPERATOR_PARITY post-condition failed: trip_authority.trips.rider_actor must now be nullable';
  END IF;
END $$;

COMMIT;
