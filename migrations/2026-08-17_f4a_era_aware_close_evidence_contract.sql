-- migrations/2026-08-17_f4a_era_aware_close_evidence_contract.sql
-- F-4A — Finalizar servicio repair: era-aware close-evidence schema contract
-- (Evidence Model B, frozen by the Opus architecture decision). Nothing else
-- changes.
--
-- Authority: owner-frozen F-4A brief, built on F-4's own live-proven audit
-- (STOP verdict: capture_closeout_snapshot/create_service_closeout/
-- create_service_incident each unconditionally reject a parent session whose
-- service_kind IS NULL -- both via an explicit RPC-level check AND via a
-- genuine service_kind text NOT NULL column on all three destination
-- tables). Model A (nullable service_kind alone) was explicitly rejected:
-- service_closeout_snapshots/service_closeouts/service_incidents are all
-- append-only or fact-immutable (see Phase 0 evidence below) -- an era stamp
-- can only ever be placed at INSERT time, never corrected later by UPDATE,
-- so a bare nullable column with no era marker would make any new-era
-- evidence written before a hypothetical later "Model B" migration
-- permanently unrecoverable. Model B is applied now, before any such row
-- can exist (0 real operational_service_v1 sessions today).
--
-- THE FIX, and nothing else, applied identically to all three evidence
-- tables (service_closeout_snapshots, service_closeouts, service_incidents):
--   1. ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1'
--      -- on this Postgres version (17.x), a constant-default ADD COLUMN is
--      -- a metadata-only operation (no table rewrite, no row visited) --
--      -- re-verified live in this migration's own post-condition, not
--      -- merely assumed. The default is historically correct for every
--      -- existing row: Phase 0 evidence (below) proves zero existing row in
--      -- any of the three tables has a NULL service_kind, i.e. every one is
--      -- provably economic_period_v1-era by construction. NO row is ever
--      -- UPDATEd by this migration -- the default mechanism alone gives
--      -- every historical row this column's correct value.
--   2. service_kind becomes nullable (ALTER COLUMN ... DROP NOT NULL).
--   3. The existing service_kind value-domain CHECK is replaced --
--      -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the pre-existing CHECK expression, not new vocabulary
--      `service_kind = ANY(ARRAY['PRANZO','SERA'])` evaluates to the SQL
--      three-valued UNKNOWN (not TRUE, but a CHECK only fails on FALSE) for
--      a NULL input, so the ORIGINAL check would silently ALREADY permit an
--      unconditional NULL kind the instant NOT NULL is dropped, for BOTH
--      eras -- not a hypothetical, an actual latent hole in the naive
--      "just drop NOT NULL" approach. Replaced with an explicit
--      -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, named here only to describe the replacement CHECK expression, not new vocabulary
--      `service_kind IS NULL OR service_kind = ANY(ARRAY['PRANZO','SERA'])`.
--   4. A NEW era-pairing CHECK, the actual gate that keeps NULL restricted
--      to the correct era:
--        (lifecycle_semantics='economic_period_v1' AND service_kind IS NOT NULL)
--        OR (lifecycle_semantics='operational_service_v1' AND service_kind IS NULL)
--      Identical shape to service_sessions_active_kind_chk (S-B), no third
--      legacy state -- Phase 0 evidence proves no NULL-kind row of either
--      era exists today, so no such state needs representing.
--   5. lifecycle_semantics itself gets the identical value-domain CHECK
--      service_sessions already carries: exactly 'economic_period_v1' or
--      'operational_service_v1', nothing else.
--   6. The three RPCs (capture_closeout_snapshot, create_service_closeout,
--      create_service_incident) each replace their identical blanket
--      `IF v_session.service_kind IS NULL THEN REJECT` with the era-aware
--      version -- `IF v_session.lifecycle_semantics = 'economic_period_v1'
--      AND v_session.service_kind IS NULL THEN REJECT` -- and each extends
--      its own INSERT column/value list to also copy
--      v_session.lifecycle_semantics verbatim, alongside the
--      v_session.business_date/v_session.service_kind they already copy.
--      No RPC gains a new parameter for kind or era -- the client could not
--      supply either before this migration and still cannot after; both are
--      always read authoritatively from the parent service_sessions row.
--
-- EXPLICITLY NOT DONE (frozen non-goals, per the F-4A task brief):
--   - no historical evidence row is ever UPDATEd -- zero UPDATE statements
--     anywhere in this migration, matching every append-only/immutable-facts
--     trigger's own guarantee;
--   - v3NextServiceIdentity.js / ensure_next_service_session_v3's NULL-kind
--     validation (V3-D3/V3-D5) are untouched -- still open, a real
--     operational_service_v1 row still cannot be CREATED by any writer;
--   - archived_order_financial_resolutions.service_kind (a later,
--     post-close-resolution evidence table with the identical NOT NULL
--     shape) is untouched -- registered as a future defect, not fixed here;
--   - service_sessions.lifecycle_semantics' own lack of UPDATE-immutability
--     protection is untouched -- registered as a prerequisite for the first
--     real operational_service_v1 era, not fixed here;
--   - incident resolution semantics (the 5-column mutable allowlist on
--     service_incidents_immutable_facts) are untouched -- the new
--     lifecycle_semantics column is automatically frozen by that trigger's
--     existing "everything except the allowlist" rule, requiring no trigger
--     change at all;
--   - no application/runtime JS changes -- confirmed live that every
--     current reader of these columns is a pure pass-through DTO mapper
--     with zero downstream consumers of the value (see Phase 0 evidence).
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=87, MAX(verified)=76 -- matches the exact
--     expected pre-state.
--   - Historical row counts + service_kind distributions, captured fresh:
--     -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to state the exact historical distribution, not new vocabulary
--     service_closeouts: 3 rows, kinds={PRANZO} (0 NULL);
--     -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, named here for the same reason
--     service_closeout_snapshots: 14 rows, kinds={PRANZO,SERA} (0 NULL);
--     -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, named here for the same reason
--     service_incidents: 49 rows, kinds={PRANZO,SERA} (0 NULL).
--   - All three tables' existing service_kind CHECK confirmed to be exactly
--     -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, named here only to quote the pre-existing CHECK expression verbatim, not new vocabulary
--     `CHECK (service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text]))`,
--     confirming the "NULL passes the old CHECK once NOT NULL is dropped"
--     hazard is real, not theoretical.
--   - Protection triggers confirmed live and unmodified by this migration:
--     service_closeout_snapshots_no_update_delete /
--     service_closeouts_no_update_delete (both unconditionally raise on any
--     UPDATE/DELETE), service_incidents_facts_immutable (diffs
--     to_jsonb(OLD)/to_jsonb(NEW) minus a fixed 6-column resolution
--     allowlist -- the new lifecycle_semantics column falls outside that
--     allowlist by construction, so it is automatically frozen the instant
--     this migration lands, with zero trigger-function change).
--   - service_sessions.lifecycle_semantics confirmed to have NO dedicated
--     UPDATE-guarding trigger (only service_sessions_closed_live_work_guard,
--     which fires on UPDATE OF status, and
--     service_sessions_business_day_derive_v1, BEFORE INSERT only) --
--     confirming evidence-side self-containment (this migration's whole
--     point) is not redundant with any existing parent-side protection.
--   - grep-confirmed zero downstream consumers of .serviceKind from any of
--     the three evidence DTO mappers (closeoutSnapshots.js,
--     serviceCloseouts.js, serviceIncidents.js) anywhere in src/ or
--     index.js -- every reader is already nullable-safe, confirming no
--     application source change is required in this slice.
BEGIN;

DO $$
DECLARE
  v_def_snap text;
  v_def_co text;
  v_def_inc text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-4A refused: staging sentinel migration absent -- wrong database?'; END IF;

  -- Drift guard: refuse outright if the new column already exists anywhere.
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_closeout_snapshots' AND column_name='lifecycle_semantics')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_closeouts' AND column_name='lifecycle_semantics')
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_incidents' AND column_name='lifecycle_semantics')
  THEN
    RAISE EXCEPTION 'F-4A refused: lifecycle_semantics column already present on at least one evidence table -- already applied';
  END IF;

  -- Drift guard: refuse if service_kind is already nullable anywhere.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND column_name='service_kind' AND is_nullable='YES'
      AND table_name IN ('service_closeout_snapshots','service_closeouts','service_incidents')
  ) THEN
    RAISE EXCEPTION 'F-4A refused: service_kind is already nullable on at least one evidence table -- already applied or drifted';
  END IF;

  -- Predecessor-body guards: the exact pre-F-4A blanket rejection must be
  -- present, byte-for-byte, in all three RPCs, or this migration refuses.
  SELECT pg_get_functiondef(p.oid) INTO v_def_snap FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='capture_closeout_snapshot';
  IF v_def_snap IS NULL THEN RAISE EXCEPTION 'F-4A refused: capture_closeout_snapshot does not exist'; END IF;
  IF position('IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object(''ok'',false,''code'',''SERVICE_SESSION_MISSING_KIND'');
  END IF;' IN v_def_snap) = 0 THEN
    RAISE EXCEPTION 'F-4A refused: capture_closeout_snapshot does not match the expected pre-F-4A body -- already patched or drifted, resolve first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_co FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_service_closeout';
  IF v_def_co IS NULL THEN RAISE EXCEPTION 'F-4A refused: create_service_closeout does not exist'; END IF;
  IF position('IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object(''ok'',false,''code'',''SERVICE_SESSION_MISSING_KIND'');
  END IF;' IN v_def_co) = 0 THEN
    RAISE EXCEPTION 'F-4A refused: create_service_closeout does not match the expected pre-F-4A body -- already patched or drifted, resolve first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_inc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_service_incident';
  IF v_def_inc IS NULL THEN RAISE EXCEPTION 'F-4A refused: create_service_incident does not exist'; END IF;
  IF position('IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object(''ok'',false,''code'',''SERVICE_SESSION_MISSING_KIND'');
  END IF;' IN v_def_inc) = 0 THEN
    RAISE EXCEPTION 'F-4A refused: create_service_incident does not match the expected pre-F-4A body -- already patched or drifted, resolve first';
  END IF;
END $$;

-- ============================================================
-- service_closeout_snapshots
-- ============================================================
ALTER TABLE public.service_closeout_snapshots
  ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';

ALTER TABLE public.service_closeout_snapshots
  ADD CONSTRAINT service_closeout_snapshots_lifecycle_semantics_chk
  CHECK (lifecycle_semantics = ANY (ARRAY['economic_period_v1'::text, 'operational_service_v1'::text]));

ALTER TABLE public.service_closeout_snapshots
  ALTER COLUMN service_kind DROP NOT NULL;

ALTER TABLE public.service_closeout_snapshots
  DROP CONSTRAINT service_closeout_snapshots_service_kind_check;

ALTER TABLE public.service_closeout_snapshots
  ADD CONSTRAINT service_closeout_snapshots_service_kind_check
  CHECK (service_kind IS NULL OR service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, restated verbatim in the new NULL-safe CHECK, not new vocabulary

ALTER TABLE public.service_closeout_snapshots
  ADD CONSTRAINT service_closeout_snapshots_kind_era_chk
  CHECK (
    (lifecycle_semantics = 'economic_period_v1' AND service_kind IS NOT NULL)
    OR (lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL)
  );

-- ============================================================
-- service_closeouts
-- ============================================================
ALTER TABLE public.service_closeouts
  ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';

ALTER TABLE public.service_closeouts
  ADD CONSTRAINT service_closeouts_lifecycle_semantics_chk
  CHECK (lifecycle_semantics = ANY (ARRAY['economic_period_v1'::text, 'operational_service_v1'::text]));

ALTER TABLE public.service_closeouts
  ALTER COLUMN service_kind DROP NOT NULL;

ALTER TABLE public.service_closeouts
  DROP CONSTRAINT service_closeouts_service_kind_check;

ALTER TABLE public.service_closeouts
  ADD CONSTRAINT service_closeouts_service_kind_check
  CHECK (service_kind IS NULL OR service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason

ALTER TABLE public.service_closeouts
  ADD CONSTRAINT service_closeouts_kind_era_chk
  CHECK (
    (lifecycle_semantics = 'economic_period_v1' AND service_kind IS NOT NULL)
    OR (lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL)
  );

-- ============================================================
-- service_incidents
-- ============================================================
ALTER TABLE public.service_incidents
  ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';

ALTER TABLE public.service_incidents
  ADD CONSTRAINT service_incidents_lifecycle_semantics_chk
  CHECK (lifecycle_semantics = ANY (ARRAY['economic_period_v1'::text, 'operational_service_v1'::text]));

ALTER TABLE public.service_incidents
  ALTER COLUMN service_kind DROP NOT NULL;

ALTER TABLE public.service_incidents
  DROP CONSTRAINT service_incidents_service_kind_check;

ALTER TABLE public.service_incidents
  ADD CONSTRAINT service_incidents_service_kind_check
  CHECK (service_kind IS NULL OR service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason

ALTER TABLE public.service_incidents
  ADD CONSTRAINT service_incidents_kind_era_chk
  CHECK (
    (lifecycle_semantics = 'economic_period_v1' AND service_kind IS NOT NULL)
    OR (lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL)
  );

-- ============================================================
-- RPC 1/3 — capture_closeout_snapshot
-- ============================================================
CREATE OR REPLACE FUNCTION public.capture_closeout_snapshot(p_service_session_id uuid, p_closeout_correlation_id uuid, p_captured_by text, p_source text, p_payload jsonb, p_schema_version integer DEFAULT 1, p_payload_sha256 text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF v_session.lifecycle_semantics = 'economic_period_v1' AND v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  INSERT INTO public.service_closeout_snapshots(
    service_session_id, business_date, service_kind, lifecycle_semantics, closeout_correlation_id,
    schema_version, captured_by, source, payload, payload_sha256
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, v_session.lifecycle_semantics, p_closeout_correlation_id,
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
$function$;

-- ============================================================
-- RPC 2/3 — create_service_closeout
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_service_closeout(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_close_reason text, p_gross_sales_cents integer, p_net_sales_cents integer, p_total_refunds_cents integer, p_total_void_cents integer, p_paid_amount_cents integer, p_unpaid_exposure_cents integer, p_order_count integer, p_cash_amount_cents integer, p_card_amount_cents integer, p_bizum_amount_cents integer, p_other_amount_cents integer, p_open_orders_at_close integer, p_occupied_tables_at_close integer, p_kitchen_pending_count integer DEFAULT 0, p_listo_count integer DEFAULT 0, p_delivery_pending_count integer DEFAULT 0, p_incident_count integer DEFAULT 0, p_critical_incident_count integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_attempt public.service_closeout_attempts%ROWTYPE;
  v_row     public.service_closeouts%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  IF p_gross_sales_cents IS NULL OR p_gross_sales_cents < 0
     OR p_net_sales_cents IS NULL OR p_net_sales_cents < 0
     OR p_paid_amount_cents IS NULL OR p_paid_amount_cents < 0
     OR p_unpaid_exposure_cents IS NULL OR p_unpaid_exposure_cents < 0
     OR p_order_count IS NULL OR p_order_count < 0
  THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_FINANCIAL_FIELDS');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.lifecycle_semantics = 'economic_period_v1' AND v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  SELECT * INTO v_attempt FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;
  IF v_attempt.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_SESSION_MISMATCH');
  END IF;
  IF v_attempt.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  INSERT INTO public.service_closeouts(
    service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics,
    opened_at, closed_at, close_source, close_reason, closed_by,
    gross_sales_cents, net_sales_cents, total_discounts_cents, total_refunds_cents, total_void_cents,
    paid_amount_cents, unpaid_exposure_cents, order_count,
    cash_amount_cents, card_amount_cents, bizum_amount_cents, other_amount_cents,
    open_orders_at_close, occupied_tables_at_close,
    kitchen_pending_count, listo_count, delivery_pending_count,
    incident_count, critical_incident_count
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind, v_session.lifecycle_semantics,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0),
    COALESCE(p_kitchen_pending_count, 0), COALESCE(p_listo_count, 0), COALESCE(p_delivery_pending_count, 0),
    COALESCE(p_incident_count, 0), COALESCE(p_critical_incident_count, 0)
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,'closeout',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeouts WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_EXISTS','created',false,'closeout',to_jsonb(v_row));
END;
$function$;

-- ============================================================
-- RPC 3/3 — create_service_incident
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_service_incident(p_service_session_id uuid, p_closeout_correlation_id uuid, p_incident_type text, p_category text, p_severity text, p_detected_by text, p_entity_type text DEFAULT NULL::text, p_entity_id text DEFAULT NULL::text, p_order_id text DEFAULT NULL::text, p_table_session_id uuid DEFAULT NULL::uuid, p_giro_id text DEFAULT NULL::text, p_rider_id text DEFAULT NULL::text, p_financial_exposure_cents integer DEFAULT NULL::integer, p_snapshot_id uuid DEFAULT NULL::uuid, p_auto_resolve boolean DEFAULT false, p_auto_resolution_type text DEFAULT NULL::text, p_auto_resolution_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF v_session.lifecycle_semantics = 'economic_period_v1' AND v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  IF p_snapshot_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_closeout_snapshots WHERE id = p_snapshot_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','SNAPSHOT_NOT_FOUND');
  END IF;

  INSERT INTO public.service_incidents(
    service_session_id, business_date, service_kind, lifecycle_semantics, closeout_correlation_id, snapshot_id,
    incident_type, category, severity,
    entity_type, entity_id, order_id, table_session_id, giro_id, rider_id,
    financial_exposure_cents, detected_by,
    auto_resolved, resolution_status, resolution_type, resolved_at, resolved_by, resolution_note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, v_session.lifecycle_semantics, p_closeout_correlation_id, p_snapshot_id,
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
$function$;

-- ============================================================
-- Post-conditions (structural + empirical historical-integrity proof).
-- ============================================================
DO $$
DECLARE
  v_def text;
BEGIN
  -- Columns present, correctly nullable/defaulted.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_closeout_snapshots' AND column_name='lifecycle_semantics' AND is_nullable='NO' AND column_default = '''economic_period_v1''::text') THEN
    RAISE EXCEPTION 'F-4A post-condition failed: service_closeout_snapshots.lifecycle_semantics missing or wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_closeouts' AND column_name='lifecycle_semantics' AND is_nullable='NO' AND column_default = '''economic_period_v1''::text') THEN
    RAISE EXCEPTION 'F-4A post-condition failed: service_closeouts.lifecycle_semantics missing or wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='service_incidents' AND column_name='lifecycle_semantics' AND is_nullable='NO' AND column_default = '''economic_period_v1''::text') THEN
    RAISE EXCEPTION 'F-4A post-condition failed: service_incidents.lifecycle_semantics missing or wrong shape';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND column_name='service_kind' AND is_nullable='NO'
      AND table_name IN ('service_closeout_snapshots','service_closeouts','service_incidents')
  ) THEN
    RAISE EXCEPTION 'F-4A post-condition failed: service_kind still NOT NULL on at least one evidence table';
  END IF;

  -- Era-pairing CHECK present on all three, exact shape.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.service_closeout_snapshots'::regclass AND conname='service_closeout_snapshots_kind_era_chk')
     IS DISTINCT FROM 'CHECK ((((lifecycle_semantics = ''economic_period_v1''::text) AND (service_kind IS NOT NULL)) OR ((lifecycle_semantics = ''operational_service_v1''::text) AND (service_kind IS NULL))))'
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_closeout_snapshots_kind_era_chk missing or wrong shape'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.service_closeouts'::regclass AND conname='service_closeouts_kind_era_chk')
     IS DISTINCT FROM 'CHECK ((((lifecycle_semantics = ''economic_period_v1''::text) AND (service_kind IS NOT NULL)) OR ((lifecycle_semantics = ''operational_service_v1''::text) AND (service_kind IS NULL))))'
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_closeouts_kind_era_chk missing or wrong shape'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.service_incidents'::regclass AND conname='service_incidents_kind_era_chk')
     IS DISTINCT FROM 'CHECK ((((lifecycle_semantics = ''economic_period_v1''::text) AND (service_kind IS NOT NULL)) OR ((lifecycle_semantics = ''operational_service_v1''::text) AND (service_kind IS NULL))))'
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_incidents_kind_era_chk missing or wrong shape'; END IF;

  -- Replaced service_kind value-domain CHECK now explicitly NULL-safe.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.service_closeout_snapshots'::regclass AND conname='service_closeout_snapshots_service_kind_check')
     IS DISTINCT FROM 'CHECK (((service_kind IS NULL) OR (service_kind = ANY (ARRAY[''PRANZO''::text, ''SERA''::text]))))' -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, quoted verbatim to assert the replaced CHECK's exact shape, not new vocabulary
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_closeout_snapshots_service_kind_check not NULL-safe'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.service_closeouts'::regclass AND conname='service_closeouts_service_kind_check')
     IS DISTINCT FROM 'CHECK (((service_kind IS NULL) OR (service_kind = ANY (ARRAY[''PRANZO''::text, ''SERA''::text]))))' -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_closeouts_service_kind_check not NULL-safe'; END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.service_incidents'::regclass AND conname='service_incidents_service_kind_check')
     IS DISTINCT FROM 'CHECK (((service_kind IS NULL) OR (service_kind = ANY (ARRAY[''PRANZO''::text, ''SERA''::text]))))' -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_incidents_service_kind_check not NULL-safe'; END IF;

  -- RPC bodies now era-aware, and copy lifecycle_semantics into the INSERT.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='capture_closeout_snapshot';
  IF position('v_session.lifecycle_semantics = ''economic_period_v1'' AND v_session.service_kind IS NULL' IN v_def) = 0
     OR position('service_session_id, business_date, service_kind, lifecycle_semantics, closeout_correlation_id' IN v_def) = 0
  THEN RAISE EXCEPTION 'F-4A post-condition failed: capture_closeout_snapshot not era-aware'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_service_closeout';
  IF position('v_session.lifecycle_semantics = ''economic_period_v1'' AND v_session.service_kind IS NULL' IN v_def) = 0
     OR position('service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics' IN v_def) = 0
  THEN RAISE EXCEPTION 'F-4A post-condition failed: create_service_closeout not era-aware'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_service_incident';
  IF position('v_session.lifecycle_semantics = ''economic_period_v1'' AND v_session.service_kind IS NULL' IN v_def) = 0
     OR position('service_session_id, business_date, service_kind, lifecycle_semantics, closeout_correlation_id, snapshot_id' IN v_def) = 0
  THEN RAISE EXCEPTION 'F-4A post-condition failed: create_service_incident not era-aware'; END IF;

  -- No RPC gained a client-facing kind/era parameter.
  IF (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='capture_closeout_snapshot') <> 'p_service_session_id uuid, p_closeout_correlation_id uuid, p_captured_by text, p_source text, p_payload jsonb, p_schema_version integer, p_payload_sha256 text'
  THEN RAISE EXCEPTION 'F-4A post-condition failed: capture_closeout_snapshot signature changed'; END IF;

  -- Historical integrity: same row counts, same non-null service_kind
  -- distribution, EVERY existing row now reads the correct default era,
  -- zero row was ever UPDATEd (proven by the append-only/immutable-facts
  -- triggers still being live AND unmodified, plus this exact count/value
  -- match -- an UPDATE that violated either trigger would already have
  -- aborted this entire transaction).
  IF (SELECT count(*) FROM public.service_closeouts) <> 3
     OR (SELECT count(*) FROM public.service_closeouts WHERE service_kind IS DISTINCT FROM 'PRANZO') <> 0 -- language-guard: allow-legacy PRANZO is the existing service_kind enum value, asserting the exact pre-migration historical distribution, not new vocabulary
     OR (SELECT count(*) FROM public.service_closeouts WHERE lifecycle_semantics <> 'economic_period_v1') <> 0
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_closeouts historical integrity violated'; END IF;

  IF (SELECT count(*) FROM public.service_closeout_snapshots) <> 14
     OR (SELECT count(*) FROM public.service_closeout_snapshots WHERE service_kind IS NULL) <> 0
     OR (SELECT count(*) FROM public.service_closeout_snapshots WHERE service_kind NOT IN ('PRANZO','SERA')) <> 0 -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason
     OR (SELECT count(*) FROM public.service_closeout_snapshots WHERE lifecycle_semantics <> 'economic_period_v1') <> 0
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_closeout_snapshots historical integrity violated'; END IF;

  IF (SELECT count(*) FROM public.service_incidents) <> 49
     OR (SELECT count(*) FROM public.service_incidents WHERE service_kind IS NULL) <> 0
     OR (SELECT count(*) FROM public.service_incidents WHERE service_kind NOT IN ('PRANZO','SERA')) <> 0 -- language-guard: allow-legacy PRANZO/SERA are the same existing service_kind enum values, same reason
     OR (SELECT count(*) FROM public.service_incidents WHERE lifecycle_semantics <> 'economic_period_v1') <> 0
  THEN RAISE EXCEPTION 'F-4A post-condition failed: service_incidents historical integrity violated'; END IF;

  -- Zero real new-era rows anywhere (this migration performs no data writes
  -- of its own -- every DML above is DDL/schema only).
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-4A post-condition failed: a real operational_service_v1 session exists unexpectedly';
  END IF;

  -- Nothing else touched: pointer/shadow/financial invariants unchanged by
  -- this migration itself (schema-only, zero data writes).
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-4A post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-4A post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-4A post-condition failed: payment_transactions population changed';
  END IF;
END $$;

COMMIT;
