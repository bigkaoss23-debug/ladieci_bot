-- migrations/2026-08-08_service_closeout_post_close_financial_resolutions.sql
-- SERVICE CLOSEOUT V2 / SLICE 2 — post-close financial resolution ledger.
-- STAGING ONLY. Additive-only: no rename, no drop, no destructive rewrite of
-- any existing table, no behavioural change to service-session rollover or
-- to any existing financial RPC. Establishes storage + one RPC only; nothing
-- here is called by chiudiServizio, ensureServiceSession, order_mark_paid/
-- order_refund/order_void, or any HTTP action yet — see the paired
-- .ROLLBACK.sql. Design note this slice supersedes/implements:
-- docs/SERVICE_CLOSEOUT_V2_SLICE_2_FINANCIAL_RESOLUTION_DESIGN_NOTE.md.
--
-- ── THE GAP THIS CLOSES (Slice 0 finding, confirmed unchanged in Slice 2
--    research) ──────────────────────────────────────────────────────────────
-- Once an order is archived into storico, order_mark_paid/order_refund/
-- order_void/order_import_legacy_payment all fail closed with
-- AUTH_ORDER_NOT_FOUND (SELECT ... FROM ordenes ... FOR UPDATE; IF NOT FOUND)
-- — enforced in SQL, not a JS-layer gap, and this migration does NOT touch
-- that boundary. There is currently no path to record "this archived unpaid
-- balance was later recovered/written off" anywhere in the schema.
--
-- ── IDENTITY: WHY (service_session_id, archived_order_id), NEVER
--    archived_order_id ALONE ────────────────────────────────────────────────
-- storico's own uniqueness is UNIQUE(service_session_id, orden_id) — NOT
-- UNIQUE(orden_id). Order numbers are reused across sessions/days (the old
-- (orden_id, fecha) uniqueness was deliberately dropped in
-- 2026-07-23_storico_drop_legacy_orden_fecha_uniqueness.sql). A design that
-- keyed post-close resolutions on archived_order_id alone would silently
-- collide two unrelated orders from different services that happen to share
-- the same order number. Every lineage in this table is therefore identified
-- by the PAIR (service_session_id, archived_order_id), exactly mirroring
-- storico's own real identity — never the order id in isolation.
--
-- ── WHY A NEW TABLE, NOT order_financial_events, NOT storico ────────────────
-- order_financial_events already dropped its FK to ordenes for the same
-- "financial evidence must survive archival" reason this table needs, but
-- its RPCs (order_mark_paid/order_refund/order_void) all still require the
-- live ordenes row (AUTH_ORDER_NOT_FOUND otherwise) — that boundary is
-- intentional and this migration does not touch it. Overloading its `type`
-- CHECK with a post-archive resolution type would blur "what money moved on
-- the live order" with "what an admin later recorded about an archived
-- order" — different facts, different audiences, and a different unit
-- (order_financial_events.amount is numeric(10,2) decimal euros; this table
-- uses integer cents, matching service_incidents.financial_exposure_cents's
-- existing convention — a deliberate, documented unit difference between the
-- two ledger families, never silently unified in this slice). storico itself
-- has no append-only trigger and is upserted by chiudiServizio on retry
-- within the SAME session — it must stay exactly as-is; this table only ever
-- references it by identity, never writes to it.
--
-- ── SLICE 2.1 HARDENING (applied in place — this migration was never applied
--    to any database, so it is corrected directly rather than compensated) ──
-- Three correctness gaps found in Slice 2 before it ever reached staging:
--
-- 1. ORIGINAL EXPOSURE WAS CALLER-TRUSTED. The first event of a lineage used
--    to accept p_original_exposure_cents directly from the caller — an
--    orchestrator bug could freeze the wrong baseline forever. Fixed:
--    p_original_exposure_cents no longer exists as a parameter at all. The
--    first event's original_exposure_cents is now read server-side from
--    v_incident.financial_exposure_cents (an already-immutable persisted
--    fact — service_incidents' detection facts cannot be UPDATEd, see the
--    Slice 1 migration's service_incidents_immutable_facts trigger), after
--    verifying the incident belongs to the SAME service_session_id, the SAME
--    archived order (order_id), and category='financial'. A caller can no
--    longer choose this value under any code path.
-- 2. related_incident_id WAS OPTIONAL. A post-close financial resolution
--    exists BECAUSE a financial anomaly survived closeout — allowing money
--    to be "recovered" with no incident lineage would mean no persistent
--    admin alarm/review trail for that recovery. Fixed: the column is now
--    NOT NULL, and every event of a lineage must reference the SAME incident
--    (frozen at the first event, exactly like original_exposure_cents) —
--    INCIDENT_LINK_REQUIRED / INCIDENT_NOT_FOUND / INCIDENT_NOT_FINANCIAL /
--    INCIDENT_SERVICE_MISMATCH / INCIDENT_ORDER_MISMATCH / INCIDENT_LINK_MISMATCH
--    below.
-- 3. ORDERING DEPENDED ON created_at. clock_timestamp() (already fixed once
--    during Slice 2's own real-Postgres validation) is still audit metadata,
--    not an accounting primitive. Fixed: a new lineage_sequence integer
--    column, allocated 1, 2, 3, ... per (service_session_id,
--    archived_order_id) while the lineage's advisory lock is held, is now
--    the ONLY thing that determines "the current/latest event of this
--    lineage" (ORDER BY lineage_sequence DESC, never created_at DESC or a
--    uuid tiebreak). A retry of the same action_correlation_id reselects the
--    already-inserted row and allocates nothing; it never consumes a
--    sequence number.
-- 4. RETRY CORRECTNESS WAS ORDER-DEPENDENT (found during THIS slice's own
--    real-Postgres validation, same discovery pattern as Slice 2's
--    clock_timestamp() fix). The RPC previously relied solely on
--    ON CONFLICT (action_correlation_id) DO NOTHING at INSERT time to make a
--    retry a no-op — but every check and the remaining-exposure arithmetic
--    above that INSERT still ran first, against the CURRENT (possibly
--    already-advanced) lineage state. A retry submitted after other
--    legitimate events had since landed on the same lineage could be wrongly
--    rejected (e.g. OVER_RESOLUTION_EXCEEDS_REMAINING) instead of returning
--    the original event — idempotency held only by accident, when nothing
--    else happened to the lineage between the original call and the retry.
--    Fixed: an explicit SELECT ... WHERE action_correlation_id = ... short-
--    circuit runs FIRST, before any state-dependent validation; ON CONFLICT
--    DO NOTHING is kept, unchanged, purely as a genuine-concurrent-race
--    backstop for two callers issuing the identical correlation id at
--    virtually the same instant.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'post-close financial resolutions refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_incidents') IS NULL
     OR to_regclass('public.storico') IS NULL
  THEN RAISE EXCEPTION 'post-close financial resolutions refused: service session / incident / storico foundation missing'; END IF;

  IF to_regclass('public.archived_order_financial_resolutions') IS NOT NULL
  THEN RAISE EXCEPTION 'post-close financial resolutions refused: target object already exists — resolve drift first.'; END IF;
END $$;

-- ── STEP 1 — append-only post-close resolution ledger ───────────────────────
CREATE TABLE public.archived_order_financial_resolutions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity (see header): the lineage this event belongs to is the PAIR
  -- (service_session_id, archived_order_id), matching storico's own real
  -- uniqueness. archived_order_id is storico.orden_id — deliberately WITHOUT
  -- a foreign key, same historical-identity philosophy already established
  -- for order_financial_events.order_id (FK dropped 2026-07-22) and
  -- service_incidents.order_id (FK-less by design): the archived order it
  -- describes is gone from ordenes and must remain describable regardless.
  service_session_id       uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  business_date             date NOT NULL,
  service_kind               text NOT NULL CHECK (service_kind IN ('PRANZO','SERA')),
  archived_order_id        text NOT NULL CHECK (btrim(archived_order_id) <> ''),

  -- SLICE 2.1: mandatory, never optional (see header). A post-close
  -- financial resolution exists because a FINANCIAL incident survived
  -- closeout; every event in a lineage must reference that same incident
  -- (the RPC enforces INCIDENT_LINK_MISMATCH if a later event tries a
  -- different one — this column freezes to the first event's value exactly
  -- like original_exposure_cents does).
  related_incident_id      uuid NOT NULL REFERENCES public.service_incidents(id) ON DELETE RESTRICT,

  -- Idempotency identity (never order_id+amount — see header rationale in
  -- the RPC comment below): caller/orchestrator mints exactly one UUID per
  -- real action; a retry of the SAME action reuses it, a second legitimate
  -- action (even an identical amount) mints a new one. Mirrors the
  -- closeout_correlation_id contract already fixed in Slice 1.1.
  action_correlation_id    uuid NOT NULL,

  resolution_type           text NOT NULL CHECK (resolution_type IN ('recovered_payment','write_off','reversal')),
  -- 'correction' was investigated (plan Step 6) and deliberately folded into
  -- 'reversal' + a fresh correct event rather than kept as a 4th vocabulary
  -- term: a generic "correction" would have needed its own ad hoc semantics
  -- for how it affects remaining exposure, duplicating what reversal (undo
  -- one specific prior event, exactly) already expresses unambiguously. If a
  -- future slice finds a real correction shape reversal cannot express,
  -- extend the vocabulary then, against a real case.
  reversed_event_id        uuid REFERENCES public.archived_order_financial_resolutions(id) ON DELETE RESTRICT,

  -- Amount semantics (plan Step 4): integer cents throughout, never float.
  -- original_exposure_cents is captured ONCE, on the first event of a
  -- lineage — SLICE 2.1: read server-side from the linked incident's
  -- immutable service_incidents.financial_exposure_cents, NEVER supplied by
  -- the caller (the p_original_exposure_cents RPC parameter was removed
  -- entirely; see header) — and every later event in the same lineage must
  -- reuse the identical value (enforced in the RPC, not just documented) —
  -- it is the frozen "Fact A" baseline this lineage resolves against, and is
  -- NEVER the thing a resolution event changes. remaining_exposure_cents is
  -- the running balance AFTER this specific event, computed server-side, so
  -- any reader can get "current remaining exposure" in O(1) from the
  -- highest-lineage_sequence row of a lineage without re-aggregating the
  -- whole history.
  original_exposure_cents  integer NOT NULL CHECK (original_exposure_cents >= 0),
  amount_cents              integer NOT NULL CHECK (amount_cents > 0),
  remaining_exposure_cents integer NOT NULL CHECK (remaining_exposure_cents >= 0),

  -- SLICE 2.1 — the authoritative accounting-order primitive (see header
  -- item 3). Allocated 1, 2, 3, ... per (service_session_id,
  -- archived_order_id) while the lineage's pg_advisory_xact_lock is held.
  -- created_at (below) remains audit metadata only; nothing may ever use it,
  -- or the row's uuid, to decide which event is "current" or "latest" —
  -- enforced by aofr_lineage_idx being the UNIQUE (service_session_id,
  -- archived_order_id, lineage_sequence) index the RPC's lookup relies on.
  lineage_sequence          integer NOT NULL CHECK (lineage_sequence > 0),

  -- Same canonical vocabulary as order_financial_events (efectivo/tarjeta/
  -- bizum), required only for recovered_payment — a write-off or reversal
  -- never pretends cash changed hands (plan Step 7).
  payment_method             text,

  actor                      text NOT NULL CHECK (btrim(actor) <> ''),
  role                       text NOT NULL CHECK (role = 'admin'),
  reason                     text NOT NULL CHECK (btrim(reason) <> ''),
  note                       text,

  -- clock_timestamp(), deliberately NOT now(): now()/transaction_timestamp()
  -- is frozen for the entire enclosing transaction in Postgres, so two
  -- events on the SAME lineage inserted within one transaction (a batch
  -- reconciliation, or simply two RPC calls made back-to-back on one
  -- connection before commit) would get an IDENTICAL created_at, making
  -- "ORDER BY created_at DESC LIMIT 1" (how the RPC below finds the current
  -- state of a lineage) fall back to comparing gen_random_uuid() ids —
  -- effectively random, not insertion order. Caught by real-Postgres
  -- validation: a 3rd event on an already-fully-resolved lineage, created in
  -- the same transaction as the first two, was wrongly compared against a
  -- stale prior row and let an over-resolution through. clock_timestamp()
  -- advances on every call regardless of transaction boundaries, making the
  -- ordering reliable.
  created_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT aofr_correlation_uq UNIQUE (action_correlation_id),
  CONSTRAINT aofr_payment_method_chk CHECK (
    (resolution_type = 'recovered_payment' AND payment_method IN ('efectivo','tarjeta','bizum'))
    OR (resolution_type <> 'recovered_payment' AND payment_method IS NULL)
  ),
  CONSTRAINT aofr_reversal_target_chk CHECK (
    (resolution_type = 'reversal' AND reversed_event_id IS NOT NULL)
    OR (resolution_type <> 'reversal' AND reversed_event_id IS NULL)
  )
);

-- SLICE 2.1: UNIQUE, and keyed on lineage_sequence (never created_at) — this
-- is both the lineage-identity lookup path AND the DB-level guarantee that
-- no two events in the same lineage can ever share a sequence number.
CREATE UNIQUE INDEX aofr_lineage_idx ON public.archived_order_financial_resolutions(service_session_id, archived_order_id, lineage_sequence);
CREATE INDEX aofr_incident_idx ON public.archived_order_financial_resolutions(related_incident_id);
CREATE INDEX aofr_business_date_idx ON public.archived_order_financial_resolutions(business_date);

-- A specific prior event may be reversed at most once — prevents double
-- reversal double-crediting the lineage back above its true original
-- exposure.
CREATE UNIQUE INDEX aofr_one_reversal_per_event_uq ON public.archived_order_financial_resolutions(reversed_event_id) WHERE resolution_type = 'reversal';

COMMENT ON TABLE public.archived_order_financial_resolutions IS
  'SERVICE CLOSEOUT V2 SLICE 2 (hardened in SLICE 2.1) — append-only post-close financial resolution ledger. Records what happened to an archived order''s unpaid balance AFTER service close (recovered payment, write-off, or a reversal of a prior event in the same lineage). Never rewrites storico, serata_summary, service_closeout_snapshots, or service_incidents.financial_exposure_cents — those remain frozen "truth at close" forever. Lineage identity is (service_session_id, archived_order_id), matching storico''s own uniqueness, never archived_order_id alone (order numbers are reused across sessions). related_incident_id is mandatory and frozen per lineage; original_exposure_cents is derived server-side from that incident''s financial_exposure_cents, never caller-supplied. lineage_sequence (not created_at, not row uuid) is the sole authoritative accounting order within a lineage.';

-- Pure append-only (no allowlist needed — unlike service_incidents, no
-- column on this table is ever legitimately mutable; every fact, including
-- "current remaining exposure as of this event", is frozen the moment the
-- row is written).
CREATE OR REPLACE FUNCTION public.archived_order_financial_resolutions_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'archived_order_financial_resolutions is append-only' USING ERRCODE='0A000';
END;
$fn$;
REVOKE ALL ON FUNCTION public.archived_order_financial_resolutions_append_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER archived_order_financial_resolutions_no_update_delete
  BEFORE UPDATE OR DELETE ON public.archived_order_financial_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.archived_order_financial_resolutions_append_only();

-- ── STEP 2 — RPC ─────────────────────────────────────────────────────────
-- create_archived_order_financial_resolution — idempotent on
-- action_correlation_id (ON CONFLICT DO NOTHING + reselect, same shape as
-- capture_closeout_snapshot/create_service_incident). Deliberately NOT
-- idempotent on (archived_order_id, amount_cents): the same amount may
-- legitimately be recovered twice across two separate partial payments, and
-- deduping on amount would silently drop the second one.
--
-- TRUST BOUNDARY (matches the Slice 1.1 rule exactly): p_actor_role='admin'
-- is caller-supplied text, checked here as defense-in-depth, NOT proof of
-- identity. This function is granted to service_role ONLY and, as of this
-- slice, is not invoked by any HTTP action — see
-- tests/serviceCloseoutIncidentsFoundation.static.test.js §10/§11 for the
-- pattern this reuses and
-- tests/archivedOrderFinancialResolutionsFoundation.static.test.js for this
-- table's own no-public-path check. A future admin HTTP action MUST derive
-- p_actor_role/p_actor from a verified JWT (src/auth/jwt.js), never from a
-- request body field.
--
-- CONCURRENCY: a single pg_advisory_xact_lock keyed on
-- (service_session_id, archived_order_id) serializes every writer touching
-- the same lineage — including the very first event, where there is no row
-- yet to SELECT ... FOR UPDATE. Without it, two concurrent "first events" on
-- a brand-new lineage could both read "no prior row" and both succeed,
-- producing two independent, inconsistent original/remaining chains. Same
-- idiom already used for service-session identity
-- (2026-07-26_two_service_identity.sql) and driver-state writes. SLICE 2.1:
-- lineage_sequence allocation (v_sequence below) happens strictly after this
-- lock is taken, for the same reason — two concurrent first events must not
-- both compute sequence 1.
--
-- SLICE 2.1 AUTHORITATIVE-EXPOSURE / MANDATORY-INCIDENT CONTRACT (see file
-- header): p_original_exposure_cents no longer exists as a parameter.
-- p_related_incident_id is now required (was optional) and must reference a
-- service_incidents row that (a) exists, (b) belongs to this exact
-- service_session_id, (c) has category='financial', (d) has order_id equal
-- to this exact archived_order_id. On the FIRST event of a lineage,
-- v_incident.financial_exposure_cents — an immutable, already-persisted fact
-- — becomes original_exposure_cents; a caller cannot supply or influence
-- this value. Every later event in the same lineage must reference the
-- IDENTICAL incident (INCIDENT_LINK_MISMATCH otherwise), mirroring how
-- original_exposure_cents itself is frozen.
CREATE OR REPLACE FUNCTION public.create_archived_order_financial_resolution(
  p_service_session_id      uuid,
  p_archived_order_id       text,
  p_related_incident_id     uuid,
  p_action_correlation_id   uuid,
  p_resolution_type         text,
  p_amount_cents            integer,
  p_actor                   text,
  p_actor_role              text,
  p_reason                  text,
  p_payment_method          text DEFAULT NULL,
  p_reversed_event_id       uuid DEFAULT NULL,
  p_note                    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_session  public.service_sessions%ROWTYPE;
  v_incident public.service_incidents%ROWTYPE;
  v_prior    public.archived_order_financial_resolutions%ROWTYPE;
  v_reversed public.archived_order_financial_resolutions%ROWTYPE;
  v_row      public.archived_order_financial_resolutions%ROWTYPE;
  v_method   text;
  v_original integer;
  v_remaining integer;
  v_sequence integer;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok',false,'code','FINANCIAL_RESOLUTION_FORBIDDEN');
  END IF;
  IF p_service_session_id IS NULL OR p_archived_order_id IS NULL OR btrim(p_archived_order_id) = '' OR p_action_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  -- SLICE 2.1 — idempotency short-circuit BEFORE any state-dependent
  -- validation/arithmetic below. Real-Postgres validation caught a genuine
  -- defect here: without this, a retry submitted AFTER other legitimate
  -- events have since landed on the same lineage was NOT recognized as
  -- "already recorded" — it fell through to the stateful remaining-exposure
  -- arithmetic against the CURRENT (already-advanced) lineage state and
  -- could be wrongly rejected with OVER_RESOLUTION_EXCEEDS_REMAINING instead
  -- of returning the original event. ON CONFLICT DO NOTHING at INSERT time
  -- (kept below, unchanged, as a genuine-concurrent-race backstop) is not
  -- sufficient on its own because everything between here and the INSERT
  -- runs first and can itself reject the call. This makes "a retry of the
  -- same action_correlation_id returns the original event and never
  -- consumes a new lineage_sequence" unconditionally true, not just true
  -- when nothing else happened to the lineage in between.
  SELECT * INTO v_row FROM public.archived_order_financial_resolutions WHERE action_correlation_id = p_action_correlation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_RECORDED','created',false,'resolution',to_jsonb(v_row));
  END IF;

  IF p_related_incident_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_LINK_REQUIRED');
  END IF;
  IF p_resolution_type IS NULL OR p_resolution_type NOT IN ('recovered_payment','write_off','reversal') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_RESOLUTION_TYPE');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_AMOUNT');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_REASON');
  END IF;

  IF p_resolution_type = 'recovered_payment' THEN
    v_method := lower(btrim(COALESCE(p_payment_method, '')));
    IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
      RETURN jsonb_build_object('ok',false,'code','INVALID_PAYMENT_METHOD');
    END IF;
  ELSE
    IF p_payment_method IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'code','PAYMENT_METHOD_NOT_ALLOWED');
    END IF;
    v_method := NULL;
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  -- SLICE 2.1 — the archived order this lineage describes must actually
  -- exist in storico, identified by the same (service_session_id, orden_id)
  -- pair storico itself is keyed on (never orden_id alone — order numbers
  -- are reused across sessions/days, see file header).
  IF NOT EXISTS (
    SELECT 1 FROM public.storico
     WHERE service_session_id = p_service_session_id AND orden_id = p_archived_order_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ARCHIVED_ORDER_NOT_FOUND');
  END IF;

  -- SLICE 2.1 — mandatory incident linkage, validated against every
  -- dimension that could otherwise let a caller anchor a resolution to the
  -- wrong (or no) real anomaly: existence, same service, financial category,
  -- same order. financial_exposure_cents is guaranteed NOT NULL for a
  -- 'financial' category row by service_incidents_financial_exposure_required_chk
  -- (Slice 1), but this is checked again defensively — this RPC must never
  -- silently treat a NULL as a valid 0/absent exposure.
  SELECT * INTO v_incident FROM public.service_incidents WHERE id = p_related_incident_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_NOT_FOUND');
  END IF;
  IF v_incident.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_SERVICE_MISMATCH');
  END IF;
  IF v_incident.category <> 'financial' THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_NOT_FINANCIAL');
  END IF;
  IF v_incident.order_id IS DISTINCT FROM p_archived_order_id THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_ORDER_MISMATCH');
  END IF;
  IF v_incident.financial_exposure_cents IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_MISSING_EXPOSURE');
  END IF;

  -- Serialize every writer for this lineage (see header) before reading it.
  PERFORM pg_advisory_xact_lock(hashtext(p_service_session_id::text || ':' || p_archived_order_id));

  -- SLICE 2.1 — authoritative accounting order: lineage_sequence, NEVER
  -- created_at/uuid (see header item 3).
  SELECT * INTO v_prior FROM public.archived_order_financial_resolutions
   WHERE service_session_id = p_service_session_id AND archived_order_id = p_archived_order_id
   ORDER BY lineage_sequence DESC
   LIMIT 1;

  IF FOUND THEN
    v_original := v_prior.original_exposure_cents;
    v_sequence := v_prior.lineage_sequence + 1;
    IF p_related_incident_id IS DISTINCT FROM v_prior.related_incident_id THEN
      RETURN jsonb_build_object('ok',false,'code','INCIDENT_LINK_MISMATCH');
    END IF;
  ELSE
    -- First event of the lineage: original exposure is derived from the
    -- immutable, already-persisted incident fact, never caller-supplied.
    v_original := v_incident.financial_exposure_cents;
    v_sequence := 1;
  END IF;

  IF p_resolution_type = 'reversal' THEN
    IF p_reversed_event_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSED_EVENT_REQUIRED');
    END IF;
    SELECT * INTO v_reversed FROM public.archived_order_financial_resolutions
     WHERE id = p_reversed_event_id
       AND service_session_id = p_service_session_id
       AND archived_order_id = p_archived_order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSED_EVENT_NOT_FOUND');
    END IF;
    IF v_reversed.resolution_type NOT IN ('recovered_payment','write_off') THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSED_EVENT_NOT_REVERSIBLE');
    END IF;
    IF p_amount_cents IS DISTINCT FROM v_reversed.amount_cents THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSAL_AMOUNT_MISMATCH');
    END IF;
    IF EXISTS (SELECT 1 FROM public.archived_order_financial_resolutions WHERE reversed_event_id = p_reversed_event_id) THEN
      RETURN jsonb_build_object('ok',false,'code','EVENT_ALREADY_REVERSED');
    END IF;
    v_remaining := COALESCE(v_prior.remaining_exposure_cents, v_original) + p_amount_cents;
    IF v_remaining > v_original THEN
      RETURN jsonb_build_object('ok',false,'code','REVERSAL_EXCEEDS_ORIGINAL');
    END IF;
  ELSE
    v_remaining := COALESCE(v_prior.remaining_exposure_cents, v_original) - p_amount_cents;
    IF v_remaining < 0 THEN
      RETURN jsonb_build_object('ok',false,'code','OVER_RESOLUTION_EXCEEDS_REMAINING');
    END IF;
  END IF;

  INSERT INTO public.archived_order_financial_resolutions(
    service_session_id, business_date, service_kind, archived_order_id, related_incident_id,
    action_correlation_id, resolution_type, reversed_event_id,
    original_exposure_cents, amount_cents, remaining_exposure_cents, lineage_sequence,
    payment_method, actor, role, reason, note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_archived_order_id, p_related_incident_id,
    p_action_correlation_id, p_resolution_type, p_reversed_event_id,
    v_original, p_amount_cents, v_remaining, v_sequence,
    v_method, p_actor, p_actor_role, p_reason, p_note
  )
  -- SLICE 2.1: ON CONFLICT DO NOTHING means a retry that hits this branch
  -- never inserts a second row, so v_sequence (computed above from the
  -- pre-retry lineage state) is simply discarded on a retry — no sequence
  -- number is ever consumed by an action that does not produce a new row.
  ON CONFLICT (action_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','RECORDED','created',true,'resolution',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.archived_order_financial_resolutions WHERE action_correlation_id = p_action_correlation_id;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_RECORDED','created',false,'resolution',to_jsonb(v_row));
END;
$fn$;

-- ── STEP 3 — deterministic minimal privileges (Slice 1.3 discipline) ───────
ALTER TABLE public.archived_order_financial_resolutions ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypass.

-- REVOKE ALL FROM service_role FIRST (this project's ALTER DEFAULT
-- PRIVILEGES rule grants service_role ALL at CREATE TABLE time — see the
-- Slice 1.3 fix this migration reuses verbatim), then grant back only what
-- the RPC body above concretely uses: it only ever SELECTs and INSERTs, so
-- only SELECT/INSERT are granted. No UPDATE (nothing here is ever
-- legitimately mutated), no DELETE, no TRUNCATE, no REFERENCES, no TRIGGER.
REVOKE ALL ON public.archived_order_financial_resolutions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.archived_order_financial_resolutions TO service_role;

-- No sequences: id is uuid DEFAULT gen_random_uuid(), never serial/bigserial.

REVOKE ALL ON FUNCTION
  public.create_archived_order_financial_resolution(uuid,text,uuid,uuid,text,integer,text,text,text,text,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.create_archived_order_financial_resolution(uuid,text,uuid,uuid,text,integer,text,text,text,text,uuid,text)
  TO service_role;

-- No wiring: nothing in this migration is called by any existing trigger,
-- RPC, chiudiServizio, order_mark_paid/order_refund/order_void, or HTTP
-- action. storico/serata_summary/order_financial_events/
-- service_closeout_snapshots/service_incidents are read-only referenced by
-- identity (or not at all) — none is written to by this migration.
COMMIT;
