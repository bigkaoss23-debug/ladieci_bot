-- migrations/2026-08-09_service_lifecycle_v3_foundation.sql
-- SERVICE LIFECYCLE V3 / SLICE 3.1 — authoritative data foundation.
-- language-guard: allow-legacy chiudiServizio is the existing JS close function (src/utils/servizio.js), named here for audit context, not new vocabulary
-- STAGING ONLY. Schema-first: no close engine, no chiudiServizio call, no new
-- HTTP action, no RPC wiring. Two independent, additive changes bundled in
-- one migration because both are genuinely part of the same "foundation" and
-- splitting them would be proliferation for its own sake:
--
--   PART 1 — fixes a real order-attribution defect found auditing the
--            existing cross-service Mesa contract (see PART 1 header below).
--   PART 2 — creates service_closeouts, the new authoritative frozen result
--            of a successful service close.
--
-- Neither part touches Service Closeout V2's tables (service_closeout_attempts/
-- service_closeout_snapshots/service_incidents/service_incident_resolutions/
-- archived_order_financial_resolutions — all adopted AS-IS, see the V3.1
-- foundation report) or row 56 (2026-08-09_service_closeout_cross_service_
-- table_policy.sql, UNAPPLIED/RETIRED — this migration does not require it
-- and does not depend on anything it would have added).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 foundation refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_closeout_attempts') IS NULL
     OR to_regclass('public.service_closeout_snapshots') IS NULL
     OR to_regclass('public.service_incidents') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 foundation refused: Service Closeout V2 foundation (rows 44/53/54/55) missing — apply those first'; END IF;

  IF to_regprocedure('public.mesa_prepare_table_order_v1()') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 foundation refused: mesa_prepare_table_order_v1 missing — apply V3-J (row 51) first'; END IF;

  IF to_regclass('public.service_closeouts') IS NOT NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 foundation refused: target object already exists — resolve drift first.'; END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — order-attribution fix: a NEW order must belong to the CURRENT
-- service at creation time, never to the table's origin service.
--
-- ── THE BUG (found auditing the accepted cross-service Mesa contract) ──────
-- table_sessions.service_session_id is correctly immutable "where this table
-- account was opened" (V3-H ALTER TABLE, never rewritten — ae4c3f9's
-- language-guard: allow-legacy chiudiServizio is the existing JS close function, named here for audit context, not new vocabulary
-- chiudiServizio change confirms this explicitly: "an occupied table's
-- service_session_id is historical metadata, never rewritten at close").
-- Every new order is SUPPOSED to instead get the CURRENT service at creation
-- time via ordenes_assign_service_session (service_session_assign_order(),
-- 2026-07-22, redefined 2026-07-28 for order numbering — unchanged by this
-- migration), which reads service_session_state.current_session_id and
-- REJECTS a caller-supplied service_session_id that disagrees
-- (SERVICE_SESSION_FORGERY) — by design, this is the ONE place "current
-- service" is decided for every order, Mesa or not.
--
-- mesa_prepare_table_order_v1 (BEFORE INSERT, V3-H/V3-J) independently sets
-- NEW.service_session_id := v_session.service_session_id — the TABLE's
-- origin session, not current — for every Mesa order. Postgres fires
-- same-event BEFORE triggers on one table in ALPHABETICAL ORDER BY TRIGGER
-- NAME (documented engine behaviour, not implementation-defined):
-- "mesa_prepare_table_order_v1" < "ordenes_assign_service_session", so the
-- Mesa trigger runs FIRST and hands ordenes_assign_service_session a non-NULL
-- value. The two disagree exactly when a table_session survives a service
-- boundary (the accepted, supported case) and a NEW order is then placed on
-- it: ordenes_assign_service_session sees a caller-supplied value that
-- differs from the now-current session and raises SERVICE_SESSION_FORGERY —
-- the insert fails closed (no misattribution, no silent corruption) but the
-- order cannot be taken at all. mesaDao.js/mesaService.js never send
-- service_session_id themselves (confirmed by reading createOrder's payload
-- in src/tables/mesaService.js) — the conflict is entirely internal to these
-- two triggers.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
-- mesa_prepare_table_order_v1 stops setting NEW.service_session_id at all.
-- table_session_id already carries "which table account" (and, via that
-- row's own FK, "which service this table account was opened under" for
-- billing/reporting); ordenes.service_session_id is a SEPARATE fact —
-- "which service was current when this specific order/comanda was created"
-- — and belongs entirely to ordenes_assign_service_session, uniformly for
-- Mesa and non-Mesa orders alike. table_order_lines/payment_transactions/
-- payment_allocations are UNCHANGED by this fix — they continue to snapshot
-- v_session.service_session_id (the table's account/billing service),
-- which is the correct axis for economic aggregation per table account.
-- Every other line of mesa_prepare_table_order_v1 is byte-for-byte
-- unchanged (covers-deferred logic, line-id normalization, snapshot
-- columns, next_command_number advance).
--
-- Guard below proves this migration is replacing the EXACT expected
-- predecessor body (the one still containing the line being removed) before
-- touching it — same discipline as V3-G/V3-I's exact-signature predecessor
-- checks — so a drifted or already-patched function never gets silently
-- clobbered.
DO $$
DECLARE v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_prepare_table_order_v1' AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'service lifecycle v3 foundation refused: mesa_prepare_table_order_v1 body not found';
  END IF;
  IF v_body NOT LIKE '%NEW.service_session_id := v_session.service_session_id;%' THEN
    RAISE EXCEPTION 'service lifecycle v3 foundation refused: mesa_prepare_table_order_v1 does not match the expected pre-fix body — resolve drift first (already fixed, or a different version, than this migration expects)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.mesa_prepare_table_order_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_source_line_id uuid;
  v_raw_id text;
  v_covers_total integer;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = NEW.table_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  -- First comanda on a walk-in Mesa: require and lock in the real covers count.
  -- Any later comanda already has v_session.covers_total set, so this is a no-op
  -- and a stray table_covers_total_input value on that request is simply ignored.
  v_covers_total := v_session.covers_total;
  IF v_covers_total IS NULL THEN
    IF NEW.table_covers_total_input IS NULL
       OR NEW.table_covers_total_input NOT BETWEEN 1 AND 99
    THEN RAISE EXCEPTION 'MESA_COVERS_REQUIRED' USING ERRCODE='22023'; END IF;
    v_covers_total := NEW.table_covers_total_input;
  END IF;
  NEW.table_covers_total_input := NULL;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_session.table_id FOR SHARE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  IF jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
    RAISE EXCEPTION 'MESA_ITEMS_REQUIRED' USING ERRCODE='22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.items)
  LOOP
    v_raw_id := v_item ->> 'lineId';
    BEGIN
      v_source_line_id := CASE WHEN v_raw_id IS NULL THEN gen_random_uuid() ELSE v_raw_id::uuid END;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'MESA_LINE_ID_INVALID' USING ERRCODE='22023';
    END;
    v_items := v_items || jsonb_build_array(
      jsonb_set(v_item, '{lineId}', to_jsonb(v_source_line_id::text), true)
    );
  END LOOP;

  NEW.items := v_items;
  -- SLICE 3.1 FIX — removed: NEW.service_session_id := v_session.service_session_id;
  -- ordenes_assign_service_session (fires next, alphabetically) is now the
  -- SOLE writer of ordenes.service_session_id for every order, Mesa or not —
  -- see PART 1 header above for the full rationale.
  NEW.table_number_snapshot := v_table.table_number;
  NEW.table_name_snapshot := v_table.display_name;
  NEW.table_command_number := v_session.next_command_number;
  NEW.canal := 'BANCO';
  -- language-guard: allow-legacy tipo_consegna/RITIRO are the existing column assignment and value from mesa_prepare_table_order_v1's pre-3.1 body, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
  NEW.tipo_consegna := 'RITIRO';
  NEW.delivery_fee := 0;

  -- Single UPDATE: covers (first comanda only) and the command-number advance
  -- commit together with the rest of this same INSERT statement/transaction.
  UPDATE public.table_sessions
     SET covers_total = v_covers_total,
         next_command_number = next_command_number + 1,
         updated_at = now()
   WHERE id = v_session.id;

  RETURN NEW;
END
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — service_closeouts: the ONE authoritative frozen result of a
-- SUCCESSFUL service close. Not the attempt (process/idempotency — see
-- service_closeout_attempts), not the raw snapshot (pre-close diagnostic
-- evidence — see service_closeout_snapshots), not the incident list (see
-- service_incidents — original rows stay canonical; only aggregate counts
-- language-guard: allow-legacy serata_summary and storico are pre-existing structures named here only to explain what this new table is NOT, not new vocabulary
-- are duplicated here), not serata_summary, not storico. Reachable only via
-- closeout_correlation_id, the single join key back to the attempt that
-- produced it, its snapshot (UNIQUE on that same id), and every incident
-- detected under it.
--
-- Schema-only in this slice: no RPC. The two UNIQUE constraints below
-- (service_session_id, closeout_correlation_id) already make "at most one
-- successful closeout per session/attempt" a database invariant on a bare
-- INSERT — there is no check-then-act race for a future RPC to close that a
-- plain INSERT can't already handle atomically, and there is no orchestration
-- logic yet to encapsulate (computing the financial/operational totals below
-- is V3.2's job, once a real close engine exists to call it). See the V3.1
-- foundation report, "V3.2 first task", for what that RPC will need to do.
--
-- EXTENSION POINTS (documented, not implemented — do not populate fake data):
--   FISCAL — no canonical fiscal source exists today. A future
--     service_closeout_fiscal_summaries table can FK into
--     service_closeouts(id) (or closeout_correlation_id) without touching
--     this table at all; no column is added here for it.
--   CASH DRAWER — same treatment. A future cash_sessions table (expected
--     cash / counted cash / variance) can FK into service_closeouts(id)
--     directly; the stable uuid PK below is already sufficient as that
--     future relation's target.
CREATE TABLE public.service_closeouts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity — exactly one successful closeout per session AND per attempt,
  -- enforced by the two UNIQUE constraints below, not by application code.
  service_session_id      uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  closeout_correlation_id uuid NOT NULL REFERENCES public.service_closeout_attempts(closeout_correlation_id) ON DELETE RESTRICT,
  business_date            date NOT NULL,
  -- language-guard: allow-legacy PRANZO is the existing service_kind enum value already defined on service_sessions (2026-07-26_two_service_identity.sql), not new vocabulary — service_closeouts intentionally mirrors it
  service_kind              text NOT NULL CHECK (service_kind IN ('PRANZO','SERA')),
  opened_at                 timestamptz NOT NULL,
  closed_at                 timestamptz NOT NULL,
  close_source              text NOT NULL CHECK (btrim(close_source) <> ''),
  close_reason              text,
  closed_by                 text NOT NULL CHECK (btrim(closed_by) <> ''),

  -- Financial frozen truth (integer cents throughout — matches
  -- service_incidents.financial_exposure_cents / archived_order_financial_
  -- resolutions' existing convention, deliberately not order_financial_
  -- events' numeric(10,2) euro column). unpaid_exposure_cents in particular
  -- is the canonical worked example from the V3.1 plan: frozen here forever,
  -- never adjusted by a later archived_order_financial_resolutions recovery
  -- event — that table records what happened AFTER close as new, separate,
  -- language-guard: allow-legacy storico is a pre-existing table named here only for comparison, not new vocabulary
  -- append-only facts layered on top, exactly as it already does for storico.
  gross_sales_cents         integer NOT NULL CHECK (gross_sales_cents >= 0),
  net_sales_cents           integer NOT NULL CHECK (net_sales_cents >= 0),
  total_discounts_cents     integer NOT NULL DEFAULT 0 CHECK (total_discounts_cents >= 0),
  total_refunds_cents       integer NOT NULL DEFAULT 0 CHECK (total_refunds_cents >= 0),
  total_void_cents          integer NOT NULL DEFAULT 0 CHECK (total_void_cents >= 0),
  paid_amount_cents         integer NOT NULL CHECK (paid_amount_cents >= 0),
  unpaid_exposure_cents     integer NOT NULL CHECK (unpaid_exposure_cents >= 0),
  order_count               integer NOT NULL CHECK (order_count >= 0),

  -- Payment-method breakdown — the exact vocabulary already computed today
  -- language-guard: allow-legacy serata_summary is a pre-existing computed structure (buildCloseSummaryMsg, index.js) named here to justify the payment-method vocabulary below, not new vocabulary
  -- by buildCloseSummaryMsg (index.js) from serata_summary: efectivo/
  -- tarjeta/bizum/non-specificato. Not fabricated: this is the real
  -- distinction current canonical data already draws.
  cash_amount_cents         integer NOT NULL DEFAULT 0 CHECK (cash_amount_cents >= 0),
  card_amount_cents         integer NOT NULL DEFAULT 0 CHECK (card_amount_cents >= 0),
  bizum_amount_cents        integer NOT NULL DEFAULT 0 CHECK (bizum_amount_cents >= 0),
  other_amount_cents        integer NOT NULL DEFAULT 0 CHECK (other_amount_cents >= 0),

  -- Operational facts at close.
  open_orders_at_close       integer NOT NULL DEFAULT 0 CHECK (open_orders_at_close >= 0),
  occupied_tables_at_close   integer NOT NULL DEFAULT 0 CHECK (occupied_tables_at_close >= 0),
  kitchen_pending_count      integer NOT NULL DEFAULT 0 CHECK (kitchen_pending_count >= 0),
  listo_count                integer NOT NULL DEFAULT 0 CHECK (listo_count >= 0),
  delivery_pending_count     integer NOT NULL DEFAULT 0 CHECK (delivery_pending_count >= 0),

  -- Incident aggregates only — original service_incidents rows (queryable by
  -- this same closeout_correlation_id) remain the canonical incident truth;
  -- these two columns exist purely so a report doesn't need that join for
  -- the two numbers it needs most often.
  incident_count             integer NOT NULL DEFAULT 0 CHECK (incident_count >= 0),
  critical_incident_count    integer NOT NULL DEFAULT 0 CHECK (critical_incident_count >= 0),

  created_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_closeouts_session_uq UNIQUE (service_session_id),
  CONSTRAINT service_closeouts_correlation_uq UNIQUE (closeout_correlation_id),
  CONSTRAINT service_closeouts_payment_breakdown_chk
    CHECK (cash_amount_cents + card_amount_cents + bizum_amount_cents + other_amount_cents = paid_amount_cents),
  CONSTRAINT service_closeouts_critical_le_total_chk
    CHECK (critical_incident_count <= incident_count),
  CONSTRAINT service_closeouts_closed_after_opened_chk
    CHECK (closed_at >= opened_at)
);

CREATE INDEX service_closeouts_business_date_idx ON public.service_closeouts(business_date);
CREATE INDEX service_closeouts_service_kind_idx ON public.service_closeouts(service_kind);

COMMENT ON TABLE public.service_closeouts IS
  -- language-guard: allow-legacy storico and serata_summary are pre-existing structures named here only to clarify what this new table is NOT, not new vocabulary
  'SERVICE LIFECYCLE V3 — the ONE authoritative, immutable, structured result of a SUCCESSFUL service close. Not the attempt (service_closeout_attempts), not the raw snapshot (service_closeout_snapshots), not the incident list (service_incidents — original rows stay canonical), not serata_summary, not storico. Frozen forever on insert: a later archived_order_financial_resolutions recovery/write-off event never rewrites unpaid_exposure_cents here. Schema-only in Slice 3.1 — no RPC yet, no runtime caller; see MIGRATION_MANIFEST.md / the V3.1 foundation report for what V3.2''s close engine needs to compute before inserting a row.';

-- Pure append-only — a closeout has no legitimate post-insert mutation of
-- any kind (unlike service_incidents, which has a real resolution workflow;
-- a closeout's numbers are frozen truth "as of close", full stop).
CREATE OR REPLACE FUNCTION public.service_closeouts_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'service_closeouts is append-only' USING ERRCODE='0A000';
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_closeouts_append_only() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_closeouts_no_update_delete
  BEFORE UPDATE OR DELETE ON public.service_closeouts
  FOR EACH ROW EXECUTE FUNCTION public.service_closeouts_append_only();

-- ── access control (Slice 1.3 discipline — REVOKE ALL FROM service_role
--    FIRST, defeating the project's ambient ALTER DEFAULT PRIVILEGES grant,
--    then grant back only SELECT+INSERT; no UPDATE/DELETE/TRUNCATE ever) ───
ALTER TABLE public.service_closeouts ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypass.

REVOKE ALL ON public.service_closeouts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.service_closeouts TO service_role;

-- No sequences: id is uuid DEFAULT gen_random_uuid(), never serial/bigserial.

COMMIT;
