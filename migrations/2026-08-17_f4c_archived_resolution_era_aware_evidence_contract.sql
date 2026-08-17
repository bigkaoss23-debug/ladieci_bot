-- migrations/2026-08-17_f4c_archived_resolution_era_aware_evidence_contract.sql
-- F-4C — Finalizar servicio repair: era-aware archived financial resolution
-- evidence contract (reuses F-4A's exact Evidence Model B). Nothing else
-- changes.
--
-- Authority: owner-frozen F-4C brief, the final known evidence-schema
-- prerequisite before new-era creation work (V3-D3/V3-D5). Fresh
-- architecture audit registered archived_order_financial_resolutions.
-- service_kind as still NOT NULL -- the identical latent shape F-4A already
-- found and fixed on service_closeout_snapshots/service_closeouts/
-- service_incidents, but on the ONE evidence table F-4A's own scope
-- deliberately did not touch (this table is post-close financial-resolution
-- evidence, not close-time evidence -- a distinct table, a distinct writer,
-- registered as a known future defect by F-4A's own header). A future
-- operational_service_v1 (service_kind=NULL) session may legitimately close
-- with unresolved financial exposure and later receive an archived
-- financial resolution; that resolution must not require a fake
-- -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the design goal, not new vocabulary
-- PRANZO/SERA identity.
--
-- PHASE 0 AUDIT (verified live and via full-repo source grep this session,
-- before writing the fix):
--   - archived_order_financial_resolutions genuinely IS post-close
--     unresolved-financial-exposure evidence (confirmed by its own module
--     header, src/closeout/archivedOrderFinancialResolutions.js: "Records
--     what happened to an archived
--     -- language-guard: allow-legacy storico is the existing table this module's own header names, quoted here only for context, not new vocabulary
--     (storico) order's unpaid balance AFTER
--     service close"), so it is the correct target -- not a STOP condition.
--   - Exactly one live function INSERTs into it: create_archived_order_
--     financial_resolution -- confirmed by enumerating every public
--     function whose body matches INSERT\s+INTO\s+public\.
--     archived_order_financial_resolutions (pg_get_functiondef), not
--     migration-file archaeology. Its body carries the IDENTICAL blanket
--     rejection F-4A already fixed on the other three evidence RPCs:
--     `IF v_session.service_kind IS NULL THEN RETURN ...
--     SERVICE_SESSION_MISSING_KIND`. Client cannot supply service_kind or
--     any era -- no p_service_kind/p_lifecycle_semantics parameter exists in
--     its signature; both business_date and service_kind are read
--     server-side from the parent v_session row, exactly like F-4A's three
--     RPCs.
--   - Exactly one functional reader exists: src/closeout/
--     archivedOrderFinancialResolutions.js's publicResolution() mapper,
--     which already passes serviceKind through verbatim (`serviceKind:
--     row.service_kind`, no non-null assumption, no `.toUpperCase()` or
--     similar that would throw on null) -- already nullable-safe, confirmed
--     by direct source read, not assumed by analogy. That module's own
--     header states it is NOT wired into
--     -- language-guard: allow-legacy chiudiServizio is the existing close-engine function that module's own header names, quoted here only for context, not new vocabulary
--     chiudiServizio/order_mark_paid/
--     order_refund/order_void/any HTTP action in this slice -- zero live
--     callers, same containment as the V3 close engine. The only other two
--     repo references (supabaseResourcePolicy.js, rolloverClassifier.js)
--     are prose comments, not code. No runtime JS change is required.
--   - Immutability is ALREADY unconditional: archived_order_financial_
--     resolutions_no_update_delete (BEFORE UPDATE OR DELETE) unconditionally
--     RAISE EXCEPTIONs on ANY update or delete, with no allowlist at all --
--     stricter than F-4A's own tables (which needed an allowlist check on
--     service_incidents). The new lifecycle_semantics column is therefore
--     automatically, unconditionally frozen the instant this migration
--     lands, with zero trigger-function change required.
--   - Historical evidence: 0 existing rows (confirmed fresh, live) -- the
--     "100% of current rows provably legacy-era" requirement is vacuously
--     satisfied; there is no row that could possibly contradict the
--     constant default.
--   - lifecycle_semantics does not exist anywhere in this evidence family
--     yet (confirmed via information_schema.columns) -- this migration
--     introduces it for the first time on this specific table.
--
-- THE FIX, and nothing else, on archived_order_financial_resolutions:
--   1. ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1'
--      -- metadata-only ADD COLUMN (Postgres 17.x, constant default, no
--      table rewrite), vacuously correct for all 0 existing rows, zero
--      UPDATE statement anywhere in this migration.
--   2. service_kind becomes nullable (ALTER COLUMN ... DROP NOT NULL).
--   3. The existing service_kind value-domain CHECK is replaced with an
--      -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe the pre-existing CHECK expression, not new vocabulary
--      explicit NULL-safe version -- `service_kind = ANY(ARRAY['PRANZO',
--      'SERA'])` evaluates to UNKNOWN (not TRUE, but a CHECK only fails on
--      FALSE) for a NULL input, so the ORIGINAL check would silently
--      already permit an unconditional NULL kind the instant NOT NULL is
--      dropped -- the identical latent hazard F-4A found, not a
--      hypothetical here either.
--   4. A NEW era-pairing CHECK, identical shape to F-4A's three tables and
--      to service_sessions_active_kind_chk (S-B): economic_period_v1
--      requires service_kind IS NOT NULL, operational_service_v1 requires
--      service_kind IS NULL, no third legacy state.
--   5. lifecycle_semantics itself gets the identical two-value domain CHECK
--      every other lifecycle_semantics column in this codebase carries.
--   6. create_archived_order_financial_resolution replaces its blanket
--      `IF v_session.service_kind IS NULL THEN REJECT` with the era-aware
--      version -- `IF v_session.lifecycle_semantics = 'economic_period_v1'
--      AND v_session.service_kind IS NULL THEN REJECT` -- and extends its
--      own INSERT column/value list to also copy v_session.lifecycle_
--      semantics verbatim, alongside the v_session.business_date/
--      v_session.service_kind it already copies. No new client-facing
--      parameter for kind or era; both remain always read authoritatively
--      from the parent service_sessions row.
--
-- EXPLICITLY NOT DONE (frozen non-goals, per the F-4C task brief):
--   - no historical evidence row is ever UPDATEd -- zero UPDATE statements
--     anywhere in this migration (also structurally impossible regardless,
--     given the unconditional append-only trigger);
--   - no financial amount or resolution semantics changed -- original_
--     exposure_cents/amount_cents/remaining_exposure_cents/lineage_sequence
--     arithmetic, the mandatory incident linkage, the idempotency contract,
--     and every existing validation are all byte-identical;
--   - no new field added to publicResolution() or any DTO -- confirmed live
--     that the existing reader is already nullable-safe, so no application
--     source change is required in this slice;
--   - V3-D3 (p_service_kind validation) / V3-D5 (schedule-derived
--     successor) remain untouched -- still open, out of F-4C's scope;
--   - service_sessions writers, the resolver's opening semantics, Finalizar
--     routing, forgotten-close/reopen, ticket epoch, and legacy lifecycle
--     retirement are all untouched -- out of scope.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=89, MAX(verified)=76, rows 77-89 all
--     bootstrapped_unverified -- matches the exact expected pre-state.
--   - archived_order_financial_resolutions: 0 rows total.
--   - Canonical pointer/legacy shadow both point at the same real session
--     (5e5777c5-71c8-4b54-aa78-1b1090c4cd04, status=open,
--     lifecycle_semantics=economic_period_v1); payment_transactions count =
--     20; service_sessions total = 13, 0 operational_service_v1.
BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-4C refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='lifecycle_semantics')
  THEN
    RAISE EXCEPTION 'F-4C refused: lifecycle_semantics column already present on archived_order_financial_resolutions -- already applied';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='service_kind' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'F-4C refused: service_kind is already nullable on archived_order_financial_resolutions -- already applied or drifted';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_archived_order_financial_resolution';
  IF v_def IS NULL THEN RAISE EXCEPTION 'F-4C refused: create_archived_order_financial_resolution does not exist'; END IF;
  IF position('IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object(''ok'',false,''code'',''SERVICE_SESSION_MISSING_KIND'');
  END IF;' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-4C refused: create_archived_order_financial_resolution does not match the expected pre-F-4C body -- already patched or drifted, resolve first';
  END IF;
END $$;

-- ============================================================
-- archived_order_financial_resolutions
-- ============================================================
ALTER TABLE public.archived_order_financial_resolutions
  ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';

ALTER TABLE public.archived_order_financial_resolutions
  ADD CONSTRAINT archived_order_financial_resolutions_lifecycle_semantics_chk
  CHECK (lifecycle_semantics = ANY (ARRAY['economic_period_v1'::text, 'operational_service_v1'::text]));

ALTER TABLE public.archived_order_financial_resolutions
  ALTER COLUMN service_kind DROP NOT NULL;

ALTER TABLE public.archived_order_financial_resolutions
  DROP CONSTRAINT archived_order_financial_resolutions_service_kind_check;

ALTER TABLE public.archived_order_financial_resolutions
  ADD CONSTRAINT archived_order_financial_resolutions_service_kind_check
  CHECK (service_kind IS NULL OR service_kind = ANY (ARRAY['PRANZO'::text, 'SERA'::text])); -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, restated verbatim in the new NULL-safe CHECK, not new vocabulary

ALTER TABLE public.archived_order_financial_resolutions
  ADD CONSTRAINT archived_order_financial_resolutions_kind_era_chk
  CHECK (
    (lifecycle_semantics = 'economic_period_v1' AND service_kind IS NOT NULL)
    OR (lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL)
  );

-- ============================================================
-- Canonical writer — create_archived_order_financial_resolution
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_archived_order_financial_resolution(p_service_session_id uuid, p_archived_order_id text, p_related_incident_id uuid, p_action_correlation_id uuid, p_resolution_type text, p_amount_cents integer, p_actor text, p_actor_role text, p_reason text, p_payment_method text DEFAULT NULL::text, p_reversed_event_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  SELECT * INTO v_row FROM public.archived_order_financial_resolutions WHERE action_correlation_id = p_action_correlation_id;
  IF FOUND THEN
    IF v_row.service_session_id IS DISTINCT FROM p_service_session_id
       OR v_row.archived_order_id IS DISTINCT FROM p_archived_order_id
       OR v_row.related_incident_id IS DISTINCT FROM p_related_incident_id
       OR v_row.resolution_type IS DISTINCT FROM p_resolution_type
       OR v_row.amount_cents IS DISTINCT FROM p_amount_cents
       OR v_row.payment_method IS DISTINCT FROM (CASE WHEN p_payment_method IS NULL THEN NULL ELSE lower(btrim(p_payment_method)) END)
       OR v_row.reversed_event_id IS DISTINCT FROM p_reversed_event_id
    THEN
      RETURN jsonb_build_object('ok',false,'code','ACTION_CORRELATION_ID_CONFLICT');
    END IF;
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
  IF v_session.lifecycle_semantics = 'economic_period_v1' AND v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.storico -- language-guard: allow-legacy storico is the existing table this RPC already queried verbatim pre-F-4C, byte-identical here, not new vocabulary
     WHERE service_session_id = p_service_session_id AND orden_id = p_archived_order_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ARCHIVED_ORDER_NOT_FOUND');
  END IF;

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

  PERFORM pg_advisory_xact_lock(hashtext(p_service_session_id::text || ':' || p_archived_order_id));

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
    service_session_id, business_date, service_kind, lifecycle_semantics, archived_order_id, related_incident_id,
    action_correlation_id, resolution_type, reversed_event_id,
    original_exposure_cents, amount_cents, remaining_exposure_cents, lineage_sequence,
    payment_method, actor, role, reason, note
  ) VALUES (
    v_session.id, v_session.business_date, v_session.service_kind, v_session.lifecycle_semantics, p_archived_order_id, p_related_incident_id,
    p_action_correlation_id, p_resolution_type, p_reversed_event_id,
    v_original, p_amount_cents, v_remaining, v_sequence,
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
$function$;

-- ============================================================
-- Post-conditions (structural + empirical historical-integrity proof).
-- ============================================================
DO $$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='lifecycle_semantics' AND is_nullable='NO' AND column_default = '''economic_period_v1''::text') THEN
    RAISE EXCEPTION 'F-4C post-condition failed: archived_order_financial_resolutions.lifecycle_semantics missing or wrong shape';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='archived_order_financial_resolutions' AND column_name='service_kind' AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'F-4C post-condition failed: service_kind still NOT NULL on archived_order_financial_resolutions';
  END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.archived_order_financial_resolutions'::regclass AND conname='archived_order_financial_resolutions_kind_era_chk')
     IS DISTINCT FROM 'CHECK ((((lifecycle_semantics = ''economic_period_v1''::text) AND (service_kind IS NOT NULL)) OR ((lifecycle_semantics = ''operational_service_v1''::text) AND (service_kind IS NULL))))'
  THEN RAISE EXCEPTION 'F-4C post-condition failed: archived_order_financial_resolutions_kind_era_chk missing or wrong shape'; END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.archived_order_financial_resolutions'::regclass AND conname='archived_order_financial_resolutions_service_kind_check')
     IS DISTINCT FROM 'CHECK (((service_kind IS NULL) OR (service_kind = ANY (ARRAY[''PRANZO''::text, ''SERA''::text]))))' -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, quoted verbatim to assert the replaced CHECK's exact shape, not new vocabulary
  THEN RAISE EXCEPTION 'F-4C post-condition failed: archived_order_financial_resolutions_service_kind_check not NULL-safe'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_archived_order_financial_resolution';
  IF position('v_session.lifecycle_semantics = ''economic_period_v1'' AND v_session.service_kind IS NULL' IN v_def) = 0
     OR position('service_session_id, business_date, service_kind, lifecycle_semantics, archived_order_id, related_incident_id' IN v_def) = 0
  THEN RAISE EXCEPTION 'F-4C post-condition failed: create_archived_order_financial_resolution not era-aware'; END IF;

  IF (SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='create_archived_order_financial_resolution') <> 'p_service_session_id uuid, p_archived_order_id text, p_related_incident_id uuid, p_action_correlation_id uuid, p_resolution_type text, p_amount_cents integer, p_actor text, p_actor_role text, p_reason text, p_payment_method text, p_reversed_event_id uuid, p_note text'
  THEN RAISE EXCEPTION 'F-4C post-condition failed: create_archived_order_financial_resolution signature changed'; END IF;

  -- Historical integrity: 0 rows before, 0 rows after (this migration
  -- performs no data writes of its own -- every DML above is DDL/schema
  -- only, and the table itself was empty before this migration ran).
  IF (SELECT count(*) FROM public.archived_order_financial_resolutions) <> 0 THEN
    RAISE EXCEPTION 'F-4C post-condition failed: archived_order_financial_resolutions historical integrity violated -- expected 0 rows';
  END IF;

  -- Zero real new-era rows anywhere.
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-4C post-condition failed: a real operational_service_v1 session exists unexpectedly';
  END IF;

  -- Nothing else touched: pointer/shadow/financial invariants unchanged.
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-4C post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-4C post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-4C post-condition failed: payment_transactions population changed';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions) <> 13 THEN
    RAISE EXCEPTION 'F-4C post-condition failed: service_sessions population changed';
  END IF;
END $$;

COMMIT;
