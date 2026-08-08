-- migrations/2026-08-08_service_closeout_incidents_foundation.sql
-- SERVICE CLOSEOUT V2 / SLICE 1 — persistent closeout snapshots + incident register.
-- STAGING ONLY. Additive-only: no rename, no drop, no destructive rewrite of any
-- existing table, no behavioural change to service-session rollover. This slice
-- establishes storage + RPCs only; nothing here is called by chiudiServizio,
-- ensureServiceSession, or any HTTP action yet — see the paired .ROLLBACK.sql.
--
-- ── STEP 1 REUSE AUDIT (why the three existing append-only systems cannot
--    directly represent the incident lifecycle this slice needs) ────────────
--
-- service_session_audit (2026-07-22_service_session_identity.sql):
--   Fixed 3-value event_type CHECK ('opened','closing','closed') — it is a
--   lifecycle-transition log for service_sessions itself, not a fact table
--   about anomalies found *inside* a session. It has no category/severity/
--   entity/financial-exposure/resolution shape, and widening its CHECK to
--   also carry incident semantics would conflate "the session moved to
--   closing" with "an unpaid balance was found at close" — two different
--   audiences (ops dashboards vs a session-lifecycle regression test) reading
--   the same rows. Reused here only by reference: service_incidents.
--   service_session_id FK's into the sessions this audit already describes.
--
-- orden_estado_logs (2026-06-05_order_state_transition_logs.sql +
--   2026-07-27_order_state_logs_session_identity.sql):
--   Scoped to a single order's estado_from/estado_to state machine. An
--   incident is frequently NOT about one order (EMPTY_TABLE_LEFT_OPEN has no
--   order at all; CLOSEOUT_INTEGRITY_FAILURE is about the session/snapshot
--   itself) and never carries category/severity/financial_exposure_cents/
--   resolution metadata. Forcing incidents through this table would mean
--   inventing a fake orden_id for session- or table-level incidents, which
--   is worse than a dedicated table. Reused here only by convention: the
--   append-only-plus-typed-columns shape of service_incidents deliberately
--   mirrors this table's style rather than inventing a new one.
--
-- order_financial_events (2026-07-15_b7_financial_ledger_foundation.sql):
--   This is the authoritative, immutable financial ledger and Slice 1 does
--   NOT duplicate it. A FINANCIAL incident stores a REFERENCE fact (how much
--   was outstanding when the session closed) via financial_exposure_cents —
--   it never records a payment/refund/void itself, never claims to be a
--   ledger entry, and is not consulted by any payment-state CHECK. The two
--   systems are complementary: order_financial_events is "what money moved",
--   service_incidents is "what anomaly was observed, and is it resolved".
--
-- Conclusion: a dedicated register is justified. Its shape borrows the
-- proven conventions of the three tables above (RLS enabled + zero policies,
-- service_role-only grants, SECURITY INVOKER functions, append-only enforced
-- by trigger, advisory-lock-free single-statement idempotency via a unique
-- index + ON CONFLICT DO NOTHING) rather than inventing new ones.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service closeout incidents foundation refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_state') IS NULL
     OR to_regclass('public.service_session_audit') IS NULL
  THEN RAISE EXCEPTION 'service closeout incidents foundation refused: service session identity foundation missing'; END IF;

  IF to_regclass('public.service_closeout_snapshots') IS NOT NULL
     OR to_regclass('public.service_incidents') IS NOT NULL
     OR to_regclass('public.service_incident_resolutions') IS NOT NULL
  THEN RAISE EXCEPTION 'service closeout incidents foundation refused: target objects already exist — resolve drift first.'; END IF;
END $$;

-- ── STEP 2 — immutable pre-close snapshot store ─────────────────────────────
CREATE TABLE public.service_closeout_snapshots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_session_id      uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  business_date           date NOT NULL,
  service_kind            text NOT NULL CHECK (service_kind IN ('PRANZO','SERA')),
  closeout_correlation_id uuid NOT NULL,
  schema_version          integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  captured_at             timestamptz NOT NULL DEFAULT now(),
  captured_by             text NOT NULL CHECK (btrim(captured_by) <> ''),
  source                  text NOT NULL CHECK (btrim(source) <> ''),
  payload                 jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256          text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_closeout_snapshots_correlation_uq UNIQUE (closeout_correlation_id)
);
CREATE INDEX service_closeout_snapshots_session_idx ON public.service_closeout_snapshots(service_session_id);
CREATE INDEX service_closeout_snapshots_business_date_idx ON public.service_closeout_snapshots(business_date);

COMMENT ON TABLE public.service_closeout_snapshots IS
  'SERVICE CLOSEOUT V2 — immutable pre-close snapshot, one row per real closeout attempt (keyed by closeout_correlation_id). Never updated or deleted by normal runtime flows; incident resolution never rewrites it.';

CREATE OR REPLACE FUNCTION public.service_closeout_snapshots_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'service_closeout_snapshots is append-only' USING ERRCODE='0A000';
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_closeout_snapshots_append_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_closeout_snapshots_no_update_delete
  BEFORE UPDATE OR DELETE ON public.service_closeout_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.service_closeout_snapshots_append_only();

-- ── STEP 3/4 — incident register ────────────────────────────────────────────
CREATE TABLE public.service_incidents (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_session_id        uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  business_date             date NOT NULL,
  service_kind              text NOT NULL CHECK (service_kind IN ('PRANZO','SERA')),
  closeout_correlation_id   uuid NOT NULL,
  snapshot_id               uuid REFERENCES public.service_closeout_snapshots(id) ON DELETE RESTRICT,

  incident_type             text NOT NULL CHECK (btrim(incident_type) <> ''),
  category                  text NOT NULL CHECK (category IN ('informational','operational','financial','integrity','security')),
  severity                  text NOT NULL CHECK (severity IN ('info','warning','critical')),

  -- Historical-identity references, deliberately WITHOUT foreign keys — the
  -- referenced order/table_session/giro/rider may legitimately be archived,
  -- deleted, or otherwise gone by the time this incident is read back, and an
  -- incident describing that must survive it. Same reasoning as
  -- order_financial_events dropping ofe_order_id_fk (2026-07-22 migration)
  -- and manual_giros.original_giro_id ("immutable historical snapshot; NO FK").
  entity_type                text,
  entity_id                  text,
  order_id                   text,
  table_session_id           uuid,
  giro_id                    text,
  rider_id                   text,

  financial_exposure_cents   integer CHECK (financial_exposure_cents IS NULL OR financial_exposure_cents >= 0),

  detected_at                timestamptz NOT NULL DEFAULT now(),
  detected_by                text NOT NULL CHECK (btrim(detected_by) <> ''),

  auto_resolved               boolean NOT NULL DEFAULT false,
  resolution_status           text NOT NULL DEFAULT 'pending' CHECK (resolution_status IN ('pending','acknowledged','resolved')),
  resolution_type             text,
  resolved_at                 timestamptz,
  resolved_by                 text,
  resolution_note              text,

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_incidents_financial_exposure_required_chk
    CHECK (category <> 'financial' OR financial_exposure_cents IS NOT NULL),
  CONSTRAINT service_incidents_resolution_resolved_fields_chk
    CHECK ((resolution_status = 'resolved') = (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution_type IS NOT NULL)),
  CONSTRAINT service_incidents_auto_resolved_status_chk
    CHECK (NOT auto_resolved OR resolution_status = 'resolved')
);

-- Idempotency (STEP 5): same closeout attempt + same incident_type + same
-- entity = the same occurrence, never a new row. COALESCE normalizes NULL
-- entity columns to '' because Postgres treats NULL <> NULL for uniqueness
-- purposes (two NULLs would never collide) — without this, a session-level
-- incident type with no entity (e.g. CLOSEOUT_INTEGRITY_FAILURE) could be
-- inserted without bound on every retry.
CREATE UNIQUE INDEX service_incidents_dedupe_uq ON public.service_incidents (
  closeout_correlation_id, incident_type, COALESCE(entity_type, ''), COALESCE(entity_id, '')
);
CREATE INDEX service_incidents_session_idx ON public.service_incidents(service_session_id);
CREATE INDEX service_incidents_business_date_idx ON public.service_incidents(business_date);
CREATE INDEX service_incidents_category_idx ON public.service_incidents(category);
CREATE INDEX service_incidents_resolution_status_idx ON public.service_incidents(resolution_status);

COMMENT ON TABLE public.service_incidents IS
  'SERVICE CLOSEOUT V2 — persistent incident register. Detection facts (everything except resolution_status/resolution_type/resolved_at/resolved_by/resolution_note/updated_at) are immutable after insert, enforced by service_incidents_immutable_facts. Rows are never deleted by normal resolution.';

-- Detection facts are immutable; only the resolution summary columns (kept
-- flat for queryability — "smallest schema that satisfies the contract
-- without destroying queryability") may change, and only via
-- resolve_service_incident(), which also appends a
-- service_incident_resolutions row in the same transaction. See that
-- function's header for the append-only-events-vs-overwrite trade-off.
--
-- DENY-BY-DEFAULT (Slice 1.1 — fixes a Slice-1 bug): a prior version of this
-- function listed each immutable fact column explicitly (an ALLOW-list of
-- what to protect). That is backwards for an audit table — a future column
-- added to service_incidents and forgotten here would silently become
-- mutable. Instead this compares the FULL row as jsonb, minus an explicit
-- allowlist of the columns permitted to change (the resolution-summary
-- columns). Any column NOT in v_mutable_keys — including one that does not
-- exist yet at the time this comment is read — is immutable by construction,
-- because to_jsonb(NEW)/to_jsonb(OLD) always reflects every column the row
-- currently has.
CREATE OR REPLACE FUNCTION public.service_incidents_immutable_facts()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  -- Only these columns may ever change via UPDATE, and only through
  -- resolve_service_incident(). Every other column — present now or added to
  -- this table in the future — is immutable by default; nothing needs to be
  -- added here to protect a new fact column.
  v_mutable_keys text[] := ARRAY['resolution_status','resolution_type','resolved_at','resolved_by','resolution_note','updated_at'];
BEGIN
  IF (to_jsonb(OLD) - v_mutable_keys) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable_keys) THEN
    RAISE EXCEPTION 'SERVICE_INCIDENT_FACTS_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_incidents_immutable_facts() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_incidents_facts_immutable
  BEFORE UPDATE ON public.service_incidents
  FOR EACH ROW EXECUTE FUNCTION public.service_incidents_immutable_facts();

-- Normal resolution must never DELETE an incident (plan §6) — enforced, not
-- just documented.
CREATE OR REPLACE FUNCTION public.service_incidents_no_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'service_incidents rows cannot be deleted' USING ERRCODE='0A000';
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_incidents_no_delete() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_incidents_no_delete
  BEFORE DELETE ON public.service_incidents
  FOR EACH ROW EXECUTE FUNCTION public.service_incidents_no_delete();

-- ── STEP 6 — append-only resolution EVENTS (chosen over overwrite-only) ─────
-- Trade-off, decided explicitly: service_incidents keeps flat resolution_*
-- columns for cheap, join-free queries ("show pending financial incidents"),
-- but every call to resolve_service_incident() ALSO appends an immutable
-- event row here. This gives the same durability guarantee the rest of the
-- codebase already relies on (order_financial_events, service_session_audit,
-- orden_estado_logs are all append-only-only, zero UPDATE anywhere) for the
-- part that actually matters for audit: WHO acknowledged/resolved WHEN, in
-- what order, even if an incident is acknowledged and later resolved by a
-- different actor. The flat columns are a cache of "current state", never
-- the source of historical truth.
CREATE TABLE public.service_incident_resolutions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id       uuid NOT NULL REFERENCES public.service_incidents(id) ON DELETE RESTRICT,
  resolution_status text NOT NULL CHECK (resolution_status IN ('acknowledged','resolved')),
  resolution_type   text NOT NULL CHECK (btrim(resolution_type) <> ''),
  resolution_note   text,
  actor             text NOT NULL CHECK (btrim(actor) <> ''),
  role              text NOT NULL CHECK (role = 'admin'),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX service_incident_resolutions_incident_idx ON public.service_incident_resolutions(incident_id);

COMMENT ON TABLE public.service_incident_resolutions IS
  'SERVICE CLOSEOUT V2 — append-only resolution event log. One row per resolve_service_incident() call. Source of historical truth; service_incidents.resolution_* columns are a queryable cache of the latest state.';

CREATE OR REPLACE FUNCTION public.service_incident_resolutions_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'service_incident_resolutions is append-only' USING ERRCODE='0A000';
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_incident_resolutions_append_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_incident_resolutions_no_update_delete
  BEFORE UPDATE OR DELETE ON public.service_incident_resolutions
  FOR EACH ROW EXECUTE FUNCTION public.service_incident_resolutions_append_only();

-- ── RPCs ─────────────────────────────────────────────────────────────────
-- capture_closeout_snapshot — idempotent on closeout_correlation_id. A retry
-- with the same correlation id returns the existing row (created:false),
-- never a duplicate. business_date/service_kind are derived from
-- service_sessions server-side, never trusted from the caller.
CREATE OR REPLACE FUNCTION public.capture_closeout_snapshot(
  p_service_session_id      uuid,
  p_closeout_correlation_id uuid,
  p_captured_by             text,
  p_source                  text,
  p_payload                 jsonb,
  p_schema_version          integer DEFAULT 1,
  p_payload_sha256          text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_row     public.service_closeout_snapshots%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_captured_by IS NULL OR btrim(p_captured_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SNAPSHOT_PAYLOAD');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  INSERT INTO public.service_closeout_snapshots(
    service_session_id, business_date, service_kind, closeout_correlation_id,
    schema_version, captured_by, source, payload, payload_sha256
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_closeout_correlation_id,
    COALESCE(p_schema_version, 1), p_captured_by, p_source, p_payload, p_payload_sha256
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CAPTURED','created',true,'snapshot',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_snapshots WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_CAPTURED','created',false,'snapshot',to_jsonb(v_row));
END;
$fn$;

-- create_service_incident — idempotent on
-- (closeout_correlation_id, incident_type, entity_type, entity_id). A retry
-- describing the SAME factual occurrence returns the existing row
-- (created:false); a different entity or a different closeout attempt always
-- creates a new, separate incident.
CREATE OR REPLACE FUNCTION public.create_service_incident(
  p_service_session_id       uuid,
  p_closeout_correlation_id  uuid,
  p_incident_type            text,
  p_category                 text,
  p_severity                 text,
  p_detected_by              text,
  p_entity_type              text DEFAULT NULL,
  p_entity_id                text DEFAULT NULL,
  p_order_id                 text DEFAULT NULL,
  p_table_session_id         uuid DEFAULT NULL,
  p_giro_id                  text DEFAULT NULL,
  p_rider_id                 text DEFAULT NULL,
  p_financial_exposure_cents integer DEFAULT NULL,
  p_snapshot_id              uuid DEFAULT NULL,
  p_auto_resolve             boolean DEFAULT false,
  p_auto_resolution_type     text DEFAULT NULL,
  p_auto_resolution_note     text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_row     public.service_incidents%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_incident_type IS NULL OR btrim(p_incident_type) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_INCIDENT_TYPE');
  END IF;
  IF p_category NOT IN ('informational','operational','financial','integrity','security') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CATEGORY');
  END IF;
  IF p_severity NOT IN ('info','warning','critical') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SEVERITY');
  END IF;
  IF p_detected_by IS NULL OR btrim(p_detected_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_category = 'financial' AND p_financial_exposure_cents IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','FINANCIAL_EXPOSURE_REQUIRED');
  END IF;
  IF p_auto_resolve AND (p_auto_resolution_type IS NULL OR btrim(p_auto_resolution_type) = '') THEN
    RETURN jsonb_build_object('ok',false,'code','AUTO_RESOLUTION_TYPE_REQUIRED');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  IF p_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_closeout_snapshots WHERE id = p_snapshot_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','SNAPSHOT_NOT_FOUND');
  END IF;

  INSERT INTO public.service_incidents(
    service_session_id, business_date, service_kind, closeout_correlation_id, snapshot_id,
    incident_type, category, severity,
    entity_type, entity_id, order_id, table_session_id, giro_id, rider_id,
    financial_exposure_cents, detected_by,
    auto_resolved, resolution_status, resolution_type, resolved_at, resolved_by, resolution_note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, p_closeout_correlation_id, p_snapshot_id,
    p_incident_type, p_category, p_severity,
    p_entity_type, p_entity_id, p_order_id, p_table_session_id, p_giro_id, p_rider_id,
    p_financial_exposure_cents, p_detected_by,
    p_auto_resolve,
    CASE WHEN p_auto_resolve THEN 'resolved' ELSE 'pending' END,
    CASE WHEN p_auto_resolve THEN p_auto_resolution_type ELSE NULL END,
    CASE WHEN p_auto_resolve THEN now() ELSE NULL END,
    CASE WHEN p_auto_resolve THEN 'system' ELSE NULL END,
    CASE WHEN p_auto_resolve THEN p_auto_resolution_note ELSE NULL END
  )
  ON CONFLICT (closeout_correlation_id, incident_type, COALESCE(entity_type, ''), COALESCE(entity_id, ''))
  DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','RECORDED','created',true,'incident',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_incidents
   WHERE closeout_correlation_id = p_closeout_correlation_id
     AND incident_type = p_incident_type
     AND COALESCE(entity_type,'') = COALESCE(p_entity_type,'')
     AND COALESCE(entity_id,'')   = COALESCE(p_entity_id,'');
  RETURN jsonb_build_object('ok',true,'code','ALREADY_RECORDED','created',false,'incident',to_jsonb(v_row));
END;
$fn$;

-- resolve_service_incident — idempotent once an incident reaches 'resolved'
-- (terminal); re-acknowledging before resolution appends a new event each
-- time (that is a real, distinct fact: "acknowledged again"), only the
-- terminal 'resolved' state short-circuits further writes.
--
-- TRUST BOUNDARY (Slice 1.1 — makes explicit what Slice 1 left implicit):
-- the `p_actor_role IS DISTINCT FROM 'admin'` check below is defense-in-depth,
-- NOT the security boundary, and p_actor_role is NOT proof of anything by
-- itself — it is caller-supplied plpgsql text, and a caller who can invoke
-- this function at all could pass the literal string 'admin' regardless of
-- who they actually are. The real boundary is that this function is granted
-- to service_role ONLY (REVOKE ALL ... FROM PUBLIC, anon, authenticated
-- below) and, as of this slice, is not invoked by any HTTP action/route —
-- see tests/serviceCloseoutIncidentsFoundation.static.test.js
-- ("no public HTTP resolution endpoint yet") and
-- tests/serviceIncidents.test.js for the checks that keep that true.
--
-- When a future slice wires a real admin-resolution HTTP action, p_actor_role
-- (and p_resolved_by) MUST be derived server-side from an already-verified
-- actor identity — the SAME pattern already used everywhere else in this
-- backend: a role claim taken from a verified JWT (src/auth/jwt.js: "role
-- claim is SERVER-DERIVED only, never read from the request body") and
-- checked against the action's allowed principal set (src/auth/
-- authorizationContract.js). It must NEVER be copied straight through from a
-- request body field (e.g. `req.body.role`) — that would let any caller who
-- can reach the endpoint self-declare 'admin' and resolve any incident.
CREATE OR REPLACE FUNCTION public.resolve_service_incident(
  p_incident_id       uuid,
  p_resolved_by       text,
  p_actor_role              text,
  p_resolution_type   text,
  p_resolution_status text DEFAULT 'resolved',
  p_resolution_note   text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_row public.service_incidents%ROWTYPE;
BEGIN
  IF p_actor_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_RESOLUTION_FORBIDDEN');
  END IF;
  IF p_resolved_by IS NULL OR btrim(p_resolved_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_resolution_status NOT IN ('acknowledged','resolved') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_RESOLUTION_STATUS');
  END IF;
  IF p_resolution_type IS NULL OR btrim(p_resolution_type) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_RESOLUTION_TYPE');
  END IF;

  SELECT * INTO v_row FROM public.service_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','INCIDENT_NOT_FOUND');
  END IF;

  IF v_row.resolution_status = 'resolved' THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_RESOLVED','idempotent',true,'incident',to_jsonb(v_row));
  END IF;

  UPDATE public.service_incidents SET
    resolution_status = p_resolution_status,
    resolution_type   = p_resolution_type,
    resolution_note   = p_resolution_note,
    resolved_by       = CASE WHEN p_resolution_status = 'resolved' THEN p_resolved_by ELSE resolved_by END,
    resolved_at        = CASE WHEN p_resolution_status = 'resolved' THEN now() ELSE resolved_at END,
    updated_at         = now()
  WHERE id = p_incident_id
  RETURNING * INTO v_row;

  INSERT INTO public.service_incident_resolutions(
    incident_id, resolution_status, resolution_type, resolution_note, actor, role
  ) VALUES (
    p_incident_id, p_resolution_status, p_resolution_type, p_resolution_note, p_resolved_by, p_actor_role
  );

  RETURN jsonb_build_object(
    'ok',true,
    'code', CASE WHEN p_resolution_status = 'resolved' THEN 'RESOLVED' ELSE 'ACKNOWLEDGED' END,
    'incident', to_jsonb(v_row)
  );
END;
$fn$;

-- ── STEP 7 — access control ─────────────────────────────────────────────────
ALTER TABLE public.service_closeout_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_incident_resolutions ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypass.

-- DETERMINISTIC PRIVILEGE FLOOR (Slice 1.3 — fixes a Slice-1/1.2-discovered
-- defect): this project's ALTER DEFAULT PRIVILEGES rule grants service_role
-- ALL table privileges automatically at CREATE TABLE time, independent of
-- anything below. Slice 1.2's real-Postgres validation proved service_role
-- silently inherited DELETE/TRUNCATE/REFERENCES/TRIGGER on all three tables
-- this way — never explicitly granted, never intended. TRUNCATE in
-- particular is NOT caught by the append-only/immutable-facts triggers
-- (BEFORE UPDATE/DELETE triggers never fire for TRUNCATE), so an ambient
-- default grant of TRUNCATE would let normal runtime privileges destroy
-- immutable closeout/incident/resolution history outright. REVOKE ALL FROM
-- service_role FIRST, then grant back only the exact privileges the three
-- RPC bodies above actually use, so this migration — not the project's
-- ambient defaults — is the sole source of truth for the final privilege
-- surface. See tests/serviceCloseoutIncidentsFoundation.static.test.js §11
-- for the check that keeps this true.
REVOKE ALL ON public.service_closeout_snapshots, public.service_incidents, public.service_incident_resolutions
  FROM PUBLIC, anon, authenticated, service_role;

-- service_closeout_snapshots: capture_closeout_snapshot() only ever SELECTs
-- (session/conflict lookups) and INSERTs (ON CONFLICT DO NOTHING never
-- requires UPDATE privilege). No RPC ever UPDATEs or DELETEs a snapshot row.
GRANT SELECT, INSERT ON public.service_closeout_snapshots TO service_role;

-- service_incidents: create_service_incident() SELECTs + INSERTs (ON
-- CONFLICT DO NOTHING); resolve_service_incident() additionally UPDATEs the
-- resolution-summary columns (narrowed further, independently, by
-- service_incidents_facts_immutable). No RPC ever DELETEs an incident.
GRANT SELECT, INSERT, UPDATE ON public.service_incidents TO service_role;

-- service_incident_resolutions: resolve_service_incident() INSERTs one
-- append-only event row per call. No RPC currently SELECTs this table, but
-- SELECT is retained — read-only, non-destructive — to match its documented
-- purpose as the queryable source of historical resolution truth (see
-- COMMENT ON TABLE above). UPDATE/DELETE/TRUNCATE remain withheld, enforced
-- twice over (no grant + the append-only trigger).
GRANT SELECT, INSERT ON public.service_incident_resolutions TO service_role;

-- No sequences: every id/PK on these three tables is
-- `uuid PRIMARY KEY DEFAULT gen_random_uuid()`, never serial/bigserial, so no
-- sequence objects exist here and no sequence-level USAGE/SELECT grant is
-- needed (verified in tests/serviceCloseoutIncidentsFoundation.static.test.js
-- §11 and confirmed against pg_sequences during Slice 1.3 real-Postgres
-- revalidation).

REVOKE ALL ON FUNCTION
  public.service_closeout_snapshots_append_only(),
  public.service_incidents_immutable_facts(),
  public.service_incidents_no_delete(),
  public.service_incident_resolutions_append_only()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.capture_closeout_snapshot(uuid,uuid,text,text,jsonb,integer,text),
  public.create_service_incident(uuid,uuid,text,text,text,text,text,text,text,uuid,text,text,integer,uuid,boolean,text,text),
  public.resolve_service_incident(uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.capture_closeout_snapshot(uuid,uuid,text,text,jsonb,integer,text),
  public.create_service_incident(uuid,uuid,text,text,text,text,text,text,text,uuid,text,text,integer,uuid,boolean,text,text),
  public.resolve_service_incident(uuid,text,text,text,text,text)
  TO service_role;

-- No wiring: nothing in this migration is called by any existing trigger,
-- RPC, or application code path. Service-session rollover behaviour is
-- unchanged by this migration.
COMMIT;
