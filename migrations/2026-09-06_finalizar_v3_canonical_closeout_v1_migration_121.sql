-- migrations/2026-09-06_finalizar_v3_canonical_closeout_v1_migration_121.sql
-- FINALIZAR V3 CANONICAL CLOSEOUT V1 — additive persisted contract for the
-- V3 close engine's economic projection.
--
-- WHY THIS EXISTS, IN ONE LINE: the V3 close engine
-- (src/serviceSessions/serviceLifecycleEngine.js) persisted service_closeouts
-- from a LEGACY-gross derivation — it called
-- src/closeout/currentServiceCloseout.js aggregate() with THREE arguments, so
-- safeTicket() fell back to ordenes.totale instead of the canonical
-- order_obligations revision, writing gross/unpaid off the original order
-- total and never recording over-collection. See
-- REPORT_FINALIZAR_V3_CLOSEOUT_DIVERGENCE_AUDIT_2026-09-06.md
-- (root cause LEGACY_GROSS_CLOSEOUT_WRITER). The proven live fixture is
-- service 42af1de9-8981-4d01-b331-554566bec60a: #999034 obligation 60 after
-- a commercial adjustment from 85, 85 paid, 15 refunded -> canonical unpaid
-- 0 / overCollected 10, but the persisted row carried a false
-- unpaid_exposure_cents contribution of 1500 and a false
-- UNPAID_BALANCE_AT_CLOSE incident.
--
-- OWNER DECISION, FINAL: gross_sales_cents is NOT silently redefined. Its
-- frozen historical meaning stays ORIGINAL ORDER GROSS. Two explicit
-- additive columns carry the canonical facts the writer now computes:
--
--   current_obligation_cents  = the current canonical obligation at close
--                               (Sigma latest order_obligations revision,
--                               non-cancelled) — the number Finalizar's own
--                               preflight already showed the operator as
--                               "Total".
--   over_collected_cents      = Sigma max(0, netCollected - currentObligation)
--                               per order (over-collected audit, frozen
--                               invariant: NEVER netted against unpaid).
--
-- FIELD SEMANTICS AFTER THIS MIGRATION (also recorded in MIGRATION_MANIFEST.md
-- and the slice report):
--   gross_sales_cents        = ORIGINAL ORDER GROSS (order-origin fact,
--                              historical; unchanged meaning and unchanged
--                              writer input — Sigma raw ordenes.totale over
--                              non-cancelled tickets).
--   current_obligation_cents = CURRENT CANONICAL OBLIGATION AT CLOSE. NULL on
--                              every row written before this contract.
--   paid_amount_cents        = NET COLLECTED (payments - refunds). Unchanged.
--   unpaid_exposure_cents    = Sigma max(0, currentObligation - netCollected).
--                              Same column, same formula shape; correct input
--                              now that the writer is obligation-aware.
--   over_collected_cents     = Sigma max(0, netCollected - currentObligation).
--                              NULL on every row written before this contract.
--   total_refunds_cents      = refund money moved out. Unchanged.
--   net_sales_cents          = LEGACY / HISTORICAL FIELD. max(0,
--                              gross_sales_cents - total_refunds_cents). NOT
--                              reinterpreted, NOT a canonical economic
--                              authority, no runtime consumer. Left exactly
--                              as the writer already produces it.
--
-- HISTORICAL EPOCH / NULLABILITY (see MIGRATION_MANIFEST.md row 123 and the
-- slice report section D): the two new columns are NULLABLE with NO DEFAULT.
-- NULL is the epoch signal and it is self-documenting: a service_closeouts
-- row with current_obligation_cents IS NULL predates the canonical-closeout
-- contract (or was written in the window where migration 121 is applied but
-- the obligation-aware backend is not yet deployed) — the reader
-- (src/closeout/closedServiceEconomicTruth.js) keeps its exact pre-existing
-- behaviour for such a row (headline Total stays gross_sales_cents, no
-- overCollected). A canonical row has BOTH columns non-null, enforced by
-- service_closeouts_canonical_obligation_pairing_chk below, so a
-- half-populated row is structurally impossible and NULL never has to be
-- disambiguated between "old contract" and "new contract, genuinely unknown".
-- f4a's lifecycle_semantics is an ERA marker (economic_period_v1 vs
-- operational_service_v1), not a closeout-contract version, so it cannot play
-- this role; a dedicated nullable pair is the minimal correct signal and
-- follows the codebase's own precedent for additive facts that may legitimately
-- be unknown on historical rows (economic_period_kind, settled_at, etc.).
--
-- WHAT THIS MIGRATION DOES, AND NOTHING ELSE:
--   1. ALTER TABLE public.service_closeouts ADD COLUMN current_obligation_cents
--      integer  (nullable, no default) — metadata-only on PG 17.x.
--   2. ALTER TABLE public.service_closeouts ADD COLUMN over_collected_cents
--      integer  (nullable, no default) — metadata-only.
--   3. Three additive CHECK constraints:
--        - current_obligation_cents IS NULL OR >= 0   (NULL-safe, mirrors the
--          existing >= 0 money convention)
--        - over_collected_cents     IS NULL OR >= 0
--        - (current_obligation_cents IS NULL) = (over_collected_cents IS NULL)
--          (the canonical-vs-legacy pairing invariant)
--   4. DROP + CREATE public.create_service_closeout — the ONLY writer of
--      service_closeouts — extended by exactly two trailing parameters
--      (p_current_obligation_cents integer DEFAULT NULL,
--       p_over_collected_cents integer DEFAULT NULL). Body is f4a's verbatim
--      plus: a NULL-pair validation, NULL-safe >= 0 checks, and the two new
--      columns/values in the INSERT (raw, NEVER COALESCEd to 0 — an omitted
--      or explicit NULL stays NULL so a legacy/omitted caller writes a
--      legacy row). DROP-then-CREATE, not CREATE OR REPLACE, because the
--      argument-type list changes (23 -> 25) and CREATE OR REPLACE would
--      install a SECOND overload — exact same discipline row 61
--      (service lifecycle v3 incident policy) used going 18 -> 23. Grants are
--      re-established on the new signature (DROP FUNCTION takes the old
--      grants with it).
--
-- WHAT IS DELIBERATELY NOT DONE (frozen non-goals):
--   * gross_sales_cents is NOT renamed and NOT redefined.
--   * net_sales_cents is NOT dropped, NOT repurposed, NOT recomputed.
--   * NO historical row is UPDATEd. Zero UPDATE statements against
--     service_closeouts anywhere in this file. The append-only trigger
--     service_closeouts_no_update_delete is untouched and stays the guarantee.
--   * NO backfill. Every existing row keeps current_obligation_cents IS NULL
--     / over_collected_cents IS NULL — asserted in the post-condition.
--   * NO change to service_incidents, v3IncidentPolicy, safeTicket's
--     formulas, closeoutReconciliation, or service_closeout_reconciliations
--     (business-day scoped, correct, and deliberately separate).
--   * NO new incident type. Over-collection at service close is an aggregate
--     economic fact in over_collected_cents, never a second incident — the
--     Mesa-level OVER_COLLECTED_AT_CLOSE keeps its own provenance.
--   * NO fiscal column, NO fiscal coupling. service_closeouts remains an
--     immutable projection, not a canonical accounting source.
--
-- STAGING ONLY. NOT YET APPLIED IN THIS BLOCK (NO PUSH / NO DEPLOY / NO
-- STAGING DB APPLY). Ledger stays 120 until a separate promotion
-- authorization. Function bodies use $function$...$function$; DO blocks use
-- named tags ($guard$ / $post$), never a bare $$.

BEGIN;

-- ── PRE-CONDITION: refuse on drift / if already applied ──────────────────────
DO $guard$
DECLARE
  v_create text;
  v_idargs text;
BEGIN
  IF to_regclass('public.service_closeouts') IS NULL THEN
    RAISE EXCEPTION 'M121 refused: public.service_closeouts does not exist -- apply the V3 foundation chain first';
  END IF;

  -- The two additive columns must not exist yet.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='service_closeouts'
               AND column_name IN ('current_obligation_cents','over_collected_cents')) THEN
    RAISE EXCEPTION 'M121 refused: service_closeouts already carries current_obligation_cents / over_collected_cents -- already applied?';
  END IF;

  -- create_service_closeout must be exactly the current live 23-parameter
  -- signature (row 61 incident-policy body, later CREATE OR REPLACEd in place
  -- by F-4A). Refuse on anything else so a drifted or already-extended body
  -- is never silently DROPped.
  SELECT pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
    INTO v_create, v_idargs
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_service_closeout';
  IF v_create IS NULL THEN
    RAISE EXCEPTION 'M121 refused: public.create_service_closeout does not exist -- resolve drift first';
  END IF;
  IF v_idargs IS DISTINCT FROM 'p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_close_reason text, p_gross_sales_cents integer, p_net_sales_cents integer, p_total_refunds_cents integer, p_total_void_cents integer, p_paid_amount_cents integer, p_unpaid_exposure_cents integer, p_order_count integer, p_cash_amount_cents integer, p_card_amount_cents integer, p_bizum_amount_cents integer, p_other_amount_cents integer, p_open_orders_at_close integer, p_occupied_tables_at_close integer, p_kitchen_pending_count integer, p_listo_count integer, p_delivery_pending_count integer, p_incident_count integer, p_critical_incident_count integer' THEN
    RAISE EXCEPTION 'M121 refused: create_service_closeout is not the expected 23-parameter signature (got: %) -- resolve drift first', v_idargs;
  END IF;
  IF position('service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics' IN v_create) = 0 THEN
    RAISE EXCEPTION 'M121 refused: create_service_closeout body is not the expected F-4A era-aware shape -- resolve drift first';
  END IF;
  IF position('p_current_obligation_cents' IN v_create) > 0 OR position('over_collected_cents' IN v_create) > 0 THEN
    RAISE EXCEPTION 'M121 refused: create_service_closeout already references the canonical-obligation columns -- already applied?';
  END IF;
  IF position('RAISE EXCEPTION' IN v_create) > 0 THEN
    RAISE EXCEPTION 'M121 refused: create_service_closeout body unexpectedly RAISEs (Convention A violation) -- resolve drift first';
  END IF;

  -- Exactly one overload today (so the DROP below is unambiguous).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='create_service_closeout') <> 1 THEN
    RAISE EXCEPTION 'M121 refused: expected exactly 1 create_service_closeout overload before this migration';
  END IF;

  -- The append-only trigger must be live and stay live.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='service_closeouts'
                   AND t.tgname='service_closeouts_no_update_delete' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'M121 refused: service_closeouts_no_update_delete trigger is missing -- resolve drift first';
  END IF;

  -- Snapshot what this migration must not change (it writes no business row).
  PERFORM set_config('ladieci.m121_closeouts_before',
    (SELECT count(*)::text FROM public.service_closeouts), false);
  PERFORM set_config('ladieci.m121_incidents_before',
    (SELECT count(*)::text FROM public.service_incidents), false);
END $guard$;

-- ── 1. additive columns — nullable, no default (metadata-only on PG 17.x) ─────
ALTER TABLE public.service_closeouts
  ADD COLUMN current_obligation_cents integer,
  ADD COLUMN over_collected_cents     integer;

-- ── 2. additive CHECK constraints ───────────────────────────────────────────
--  - NULL-safe non-negative, mirroring the table's existing >= 0 money
--    convention (a bare `col >= 0` would evaluate to UNKNOWN, not FALSE, for a
--    NULL and so already permit NULL — spelled out here for intent, exactly as
--    F-4A spelled out its NULL-safe service_kind CHECK).
--  - The pairing invariant: a row is EITHER a canonical closeout (both
--    non-null) OR a pre-contract row (both null). No half-populated row.
ALTER TABLE public.service_closeouts
  ADD CONSTRAINT service_closeouts_current_obligation_cents_nonneg_chk
    CHECK (current_obligation_cents IS NULL OR current_obligation_cents >= 0),
  ADD CONSTRAINT service_closeouts_over_collected_cents_nonneg_chk
    CHECK (over_collected_cents IS NULL OR over_collected_cents >= 0),
  ADD CONSTRAINT service_closeouts_canonical_obligation_pairing_chk
    CHECK ((current_obligation_cents IS NULL) = (over_collected_cents IS NULL));

COMMENT ON COLUMN public.service_closeouts.current_obligation_cents IS
  'FINALIZAR V3 CANONICAL CLOSEOUT V1 (migration 121). The current canonical obligation at close: sum of the latest order_obligations revision for every non-cancelled order in the service (integer cents). NULL on every row written before this contract — see service_closeouts_canonical_obligation_pairing_chk. gross_sales_cents keeps its own, unchanged meaning (ORIGINAL ORDER GROSS).';
COMMENT ON COLUMN public.service_closeouts.over_collected_cents IS
  'FINALIZAR V3 CANONICAL CLOSEOUT V1 (migration 121). Aggregate over-collection at close: sum of max(0, netCollected - currentObligation) per order (integer cents). NEVER netted against unpaid_exposure_cents (over-collected audit, frozen invariant). NULL on every row written before this contract. Not an incident — the Mesa-level OVER_COLLECTED_AT_CLOSE keeps its own provenance.';

-- ── 3. create_service_closeout — the ONLY writer, extended by two trailing
--       nullable parameters. DROP + CREATE (not CREATE OR REPLACE): the
--       argument-type list changes 23 -> 25, so REPLACE would install a
--       second overload. Same discipline row 61 used 18 -> 23. ────────────────
DROP FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
);

CREATE FUNCTION public.create_service_closeout(
  p_service_session_id       uuid,
  p_closeout_correlation_id  uuid,
  p_closed_by                text,
  p_source                   text,
  p_close_reason             text,
  p_gross_sales_cents        integer,
  p_net_sales_cents          integer,
  p_total_refunds_cents      integer,
  p_total_void_cents         integer,
  p_paid_amount_cents        integer,
  p_unpaid_exposure_cents    integer,
  p_order_count              integer,
  p_cash_amount_cents        integer,
  p_card_amount_cents        integer,
  p_bizum_amount_cents       integer,
  p_other_amount_cents       integer,
  p_open_orders_at_close     integer,
  p_occupied_tables_at_close integer,
  p_kitchen_pending_count    integer DEFAULT 0,
  p_listo_count              integer DEFAULT 0,
  p_delivery_pending_count   integer DEFAULT 0,
  p_incident_count           integer DEFAULT 0,
  p_critical_incident_count  integer DEFAULT 0,
  -- FINALIZAR V3 CANONICAL CLOSEOUT V1 — the two canonical-obligation facts.
  -- DEFAULT NULL so a legacy/omitted caller writes a legacy row (both NULL);
  -- the obligation-aware V3 engine always supplies both, non-null.
  p_current_obligation_cents integer DEFAULT NULL,
  p_over_collected_cents     integer DEFAULT NULL
)
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
  -- FINALIZAR V3 CANONICAL CLOSEOUT V1 — the canonical-obligation pair is
  -- all-or-nothing (mirrors service_closeouts_canonical_obligation_pairing_chk)
  -- and non-negative when present.
  IF (p_current_obligation_cents IS NULL) <> (p_over_collected_cents IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CANONICAL_OBLIGATION_PAIR');
  END IF;
  IF (p_current_obligation_cents IS NOT NULL AND p_current_obligation_cents < 0)
     OR (p_over_collected_cents IS NOT NULL AND p_over_collected_cents < 0)
  THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CANONICAL_OBLIGATION_FIELDS');
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
    incident_count, critical_incident_count,
    current_obligation_cents, over_collected_cents
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind, v_session.lifecycle_semantics,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0),
    COALESCE(p_kitchen_pending_count, 0), COALESCE(p_listo_count, 0), COALESCE(p_delivery_pending_count, 0),
    COALESCE(p_incident_count, 0), COALESCE(p_critical_incident_count, 0),
    -- Raw, never COALESCEd: NULL is the pre-canonical-contract epoch signal.
    p_current_obligation_cents, p_over_collected_cents
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

-- DROP FUNCTION removed the object and its grants; the 23-parameter grant does
-- NOT carry to this new signature. Re-grant explicitly, identical
-- service_role-only shape as row 61.
REVOKE ALL ON FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer,
  integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer,
  integer, integer
) TO service_role;

-- ── POST-CONDITION: additive shape present, historical rows untouched ────────
DO $post$
DECLARE
  v_create text;
  v_idargs text;
  v_n      integer;
BEGIN
  -- Columns present, nullable, integer, NO default.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='service_closeouts'
                   AND column_name='current_obligation_cents'
                   AND data_type='integer' AND is_nullable='YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'M121 post-condition failed: current_obligation_cents missing or wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='service_closeouts'
                   AND column_name='over_collected_cents'
                   AND data_type='integer' AND is_nullable='YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'M121 post-condition failed: over_collected_cents missing or wrong shape';
  END IF;

  -- The three CHECK constraints, exact shape.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.service_closeouts'::regclass
         AND conname='service_closeouts_canonical_obligation_pairing_chk')
     IS DISTINCT FROM 'CHECK (((current_obligation_cents IS NULL) = (over_collected_cents IS NULL)))' THEN
    RAISE EXCEPTION 'M121 post-condition failed: pairing CHECK missing or wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.service_closeouts'::regclass
                   AND conname='service_closeouts_current_obligation_cents_nonneg_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.service_closeouts'::regclass
                   AND conname='service_closeouts_over_collected_cents_nonneg_chk') THEN
    RAISE EXCEPTION 'M121 post-condition failed: a non-negative CHECK is missing';
  END IF;

  -- Exactly ONE create_service_closeout overload, now 25-parameter, era-aware,
  -- carrying the new columns and the pair guard, still never RAISEs.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_service_closeout';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'M121 post-condition failed: expected exactly 1 create_service_closeout overload, found %', v_n;
  END IF;
  SELECT pg_get_functiondef(p.oid), pg_get_function_identity_arguments(p.oid)
    INTO v_create, v_idargs
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_service_closeout';
  IF v_idargs NOT LIKE '%p_critical_incident_count integer, p_current_obligation_cents integer, p_over_collected_cents integer' THEN
    RAISE EXCEPTION 'M121 post-condition failed: create_service_closeout does not end with the two new parameters (got: %)', v_idargs;
  END IF;
  IF position('current_obligation_cents, over_collected_cents' IN v_create) = 0
     OR position('INVALID_CANONICAL_OBLIGATION_PAIR' IN v_create) = 0
     OR position('service_session_id, closeout_correlation_id, business_date, service_kind, lifecycle_semantics' IN v_create) = 0 THEN
    RAISE EXCEPTION 'M121 post-condition failed: create_service_closeout body missing the canonical-obligation extension or lost the F-4A shape';
  END IF;
  IF position('RAISE EXCEPTION' IN v_create) > 0 THEN
    RAISE EXCEPTION 'M121 post-condition failed: create_service_closeout body now RAISEs (Convention A violation)';
  END IF;

  -- Grants: service_role only.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='create_service_closeout'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'M121 post-condition failed: create_service_closeout is executable by a browser role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='create_service_closeout'
                    AND has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'M121 post-condition failed: service_role lost EXECUTE on create_service_closeout';
  END IF;

  -- The append-only trigger is untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='service_closeouts'
                   AND t.tgname='service_closeouts_no_update_delete' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'M121 post-condition failed: service_closeouts_no_update_delete trigger disappeared';
  END IF;
  IF has_table_privilege('service_role','public.service_closeouts','UPDATE')
     OR has_table_privilege('service_role','public.service_closeouts','DELETE') THEN
    RAISE EXCEPTION 'M121 post-condition failed: service_closeouts stopped being append-only';
  END IF;

  -- NO backfill, NO row written or removed.
  IF (SELECT count(*) FROM public.service_closeouts WHERE current_obligation_cents IS NOT NULL
                                                       OR over_collected_cents IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'M121 post-condition failed: a historical row was backfilled with a canonical-obligation value';
  END IF;
  IF (SELECT count(*)::text FROM public.service_closeouts)
       IS DISTINCT FROM current_setting('ladieci.m121_closeouts_before', true) THEN
    RAISE EXCEPTION 'M121 post-condition failed: service_closeouts row count changed';
  END IF;
  IF (SELECT count(*)::text FROM public.service_incidents)
       IS DISTINCT FROM current_setting('ladieci.m121_incidents_before', true) THEN
    RAISE EXCEPTION 'M121 post-condition failed: service_incidents row count changed';
  END IF;

  -- F-4A's era stamp is undisturbed.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='service_closeouts'
                   AND column_name='lifecycle_semantics' AND is_nullable='NO') THEN
    RAISE EXCEPTION 'M121 post-condition failed: service_closeouts.lifecycle_semantics shape changed';
  END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-120: registered as a separate statement at apply time -- apply_order 121,
-- kind 'ddl', checksum = this file's sha256, applied_by = the introducing
-- commit (committed BEFORE this migration is applied). The manifest
-- (MIGRATION_MANIFEST.md row 123) carries this file's own sha256(:16) for the
-- git-history trail. NOT APPLIED in this block -- ledger stays 120.

COMMIT;
