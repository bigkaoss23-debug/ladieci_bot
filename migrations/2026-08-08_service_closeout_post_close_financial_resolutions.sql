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
  related_incident_id      uuid REFERENCES public.service_incidents(id) ON DELETE RESTRICT,

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
  -- lineage (the caller supplies it — typically read from the linked
  -- incident's immutable financial_exposure_cents, or from a closeout/
  -- reconciliation read path when no incident row exists yet) and every
  -- later event in the same lineage must reuse the identical value
  -- (enforced in the RPC, not just documented) — it is the frozen "Fact A"
  -- baseline this lineage resolves against, and is NEVER the thing a
  -- resolution event changes. remaining_exposure_cents is the running
  -- balance AFTER this specific event, computed server-side, so any reader
  -- can get "current remaining exposure" in O(1) from the latest row of a
  -- lineage without re-aggregating the whole history.
  original_exposure_cents  integer NOT NULL CHECK (original_exposure_cents >= 0),
  amount_cents              integer NOT NULL CHECK (amount_cents > 0),
  remaining_exposure_cents integer NOT NULL CHECK (remaining_exposure_cents >= 0),

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

CREATE INDEX aofr_lineage_idx ON public.archived_order_financial_resolutions(service_session_id, archived_order_id, created_at);
CREATE INDEX aofr_incident_idx ON public.archived_order_financial_resolutions(related_incident_id);
CREATE INDEX aofr_business_date_idx ON public.archived_order_financial_resolutions(business_date);

-- A specific prior event may be reversed at most once — prevents double
-- reversal double-crediting the lineage back above its true original
-- exposure.
CREATE UNIQUE INDEX aofr_one_reversal_per_event_uq ON public.archived_order_financial_resolutions(reversed_event_id) WHERE resolution_type = 'reversal';

COMMENT ON TABLE public.archived_order_financial_resolutions IS
  'SERVICE CLOSEOUT V2 SLICE 2 — append-only post-close financial resolution ledger. Records what happened to an archived order''s unpaid balance AFTER service close (recovered payment, write-off, or a reversal of a prior event in the same lineage). Never rewrites storico, serata_summary, service_closeout_snapshots, or service_incidents.financial_exposure_cents — those remain frozen "truth at close" forever. Lineage identity is (service_session_id, archived_order_id), matching storico''s own uniqueness, never archived_order_id alone (order numbers are reused across sessions).';

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
-- (2026-07-26_two_service_identity.sql) and driver-state writes.
CREATE OR REPLACE FUNCTION public.create_archived_order_financial_resolution(
  p_service_session_id      uuid,
  p_archived_order_id       text,
  p_action_correlation_id   uuid,
  p_resolution_type         text,
  p_amount_cents            integer,
  p_actor                   text,
  p_actor_role              text,
  p_reason                  text,
  p_original_exposure_cents integer DEFAULT NULL,
  p_payment_method          text DEFAULT NULL,
  p_reversed_event_id       uuid DEFAULT NULL,
  p_related_incident_id     uuid DEFAULT NULL,
  p_note                    text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_session  public.service_sessions%ROWTYPE;
  v_prior    public.archived_order_financial_resolutions%ROWTYPE;
  v_reversed public.archived_order_financial_resolutions%ROWTYPE;
  v_row      public.archived_order_financial_resolutions%ROWTYPE;
  v_method   text;
  v_original integer;
  v_remaining integer;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok',false,'code','FINANCIAL_RESOLUTION_FORBIDDEN');
  END IF;
  IF p_service_session_id IS NULL OR p_archived_order_id IS NULL OR btrim(p_archived_order_id) = '' OR p_action_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
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

  IF p_related_incident_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_incidents WHERE id = p_related_incident_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_NOT_FOUND');
  END IF;

  -- Serialize every writer for this lineage (see header) before reading it.
  PERFORM pg_advisory_xact_lock(hashtext(p_service_session_id::text || ':' || p_archived_order_id));

  SELECT * INTO v_prior FROM public.archived_order_financial_resolutions
   WHERE service_session_id = p_service_session_id AND archived_order_id = p_archived_order_id
   ORDER BY created_at DESC, id DESC
   LIMIT 1;

  IF FOUND THEN
    v_original := v_prior.original_exposure_cents;
    IF p_original_exposure_cents IS NOT NULL AND p_original_exposure_cents IS DISTINCT FROM v_original THEN
      RETURN jsonb_build_object('ok',false,'code','ORIGINAL_EXPOSURE_MISMATCH');
    END IF;
  ELSE
    IF p_original_exposure_cents IS NULL OR p_original_exposure_cents < 0 THEN
      RETURN jsonb_build_object('ok',false,'code','ORIGINAL_EXPOSURE_REQUIRED');
    END IF;
    v_original := p_original_exposure_cents;
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
    original_exposure_cents, amount_cents, remaining_exposure_cents,
    payment_method, actor, role, reason, note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_archived_order_id, p_related_incident_id,
    p_action_correlation_id, p_resolution_type, p_reversed_event_id,
    v_original, p_amount_cents, v_remaining,
    v_method, p_actor, p_actor_role, p_reason, p_note
  )
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
  public.create_archived_order_financial_resolution(uuid,text,uuid,text,integer,text,text,text,integer,text,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.create_archived_order_financial_resolution(uuid,text,uuid,text,integer,text,text,text,integer,text,uuid,uuid,text)
  TO service_role;

-- No wiring: nothing in this migration is called by any existing trigger,
-- RPC, chiudiServizio, order_mark_paid/order_refund/order_void, or HTTP
-- action. storico/serata_summary/order_financial_events/
-- service_closeout_snapshots/service_incidents are read-only referenced by
-- identity (or not at all) — none is written to by this migration.
COMMIT;
