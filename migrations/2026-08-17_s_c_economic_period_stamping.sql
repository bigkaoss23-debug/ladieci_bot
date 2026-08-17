-- migrations/2026-08-17_s_c_economic_period_stamping.sql
-- S-C — Operational Service repair, slice C: immutable economic-window
-- stamping substrate. NO clock-driven rollover change. NO operational_
-- service_v1 cutover. NO reader retarget. Additive nullable columns only.
--
-- Authority: owner-frozen E1 invariant (this session, S-C task brief):
-- economic classification (PRANZO/SERA) must be frozen at event/write time
-- and must NEVER later be re-derived from mutable schedule configuration.
--
-- PHASE 0/1/2 AUDIT CONCLUSIONS (evidence-based, verified live this session
-- before writing this migration -- not assumed):
--
--  CLASSIFIER AUTHORITY: resolveEconomicPeriod() (src/schedule/serviceSchedule
--  .js) is ALREADY pure and TOTAL -- for every minute of the day it returns
--  exactly PRANZO or SERA, no third state. Its SQL restatement already lives,
--  proven bit-exact via a 5760-minute DST-spanning parity test, inside
--  resolve_order_intake_context_v1() (R-DAY3): `(min >= 240 AND min < 1050)
--  -> PRANZO, else SERA`, Europe/Madrid via `clock_timestamp() AT TIME ZONE
--  'Europe/Madrid'`. This migration extracts that EXACT expression into one
--  new shared function (classify_economic_period_v1) rather than restating
--  it a fourth time -- ONE authoritative write-time classifier, reused by
--  every stamping trigger below.
--
--  QUIET INTERVAL: NOT an undefined economic zone. resolveEconomicPeriod()
--  classifies 17:30-18:00 as SERA (it is only resolveSchedule()'s SEPARATE
--  session-ENSURE-permission state machine that names 17:30-18:00
--  BETWEEN_SERVICES -- an intake-permission concept S-A/S-C do not touch).
--  No architecture decision was needed here; the classifier already answers
--  this deterministically.
--
--  ORDER IDENTITY (order_entities / ordenes): NO stamp. Neither table is
--  ever aggregated for revenue/counts anywhere in the codebase (confirmed:
--  economiaLedgerAggregate.js and currentServiceCloseout.js both key off
--  service_session_id on the FINANCIAL tables, never on order_entities).
--  order_entities.created_at already gives a permanent, immutable per-order
--  timestamp usable to derive economic context on demand wherever it is
--  genuinely needed (see order_financial_events below) without a redundant
--  physical column. ordenes is additionally a strictly worse candidate:
--  mutable and hard-deletable (eliminaOrdine), unlike its append-only
--  order_entities sibling.
--
--  OBLIGATION FACT (table_order_lines): STAMP REQUIRED. Per R-DAY0 §13 this
--  is (with payment_transactions/payment_allocations/order_financial_events)
--  the append-only ledger that IS the recalculation authority. Stamped from
--  its own write-time clock_timestamp() -- the moment the sale/obligation is
--  recorded, never payment time.
--
--  PAYMENT RECEIPT (payment_transactions): STAMP REQUIRED, INDEPENDENTLY of
--  the obligation. The frozen S2 model (2026-08-15_s2_attribution_writers_
--  receipt_service.sql, "the single most validated piece of prior work",
--  cross-period worked example already proven: sales(A)=30,sales(B)=50,
--  cash(A)=0,cash(B)=80) already treats obligation-time and receipt-time as
--  two independently attributable facts at the SESSION level
--  (table_order_lines.service_session_id vs payment_transactions.
--  service_session_id). This migration mirrors that split one level finer,
--  at the economic-window level, for the identical reason: an order placed
--  in PRANZO paid in SERA must keep sales in PRANZO and cash in SERA.
--
--  PAYMENT ALLOCATIONS: NO stamp. payment_allocations has NO service_
--  session_id column at all today (verified live) -- it has never carried
--  independent session/period context, always derived through its parent
--  payment_transaction_id. An allocation is not a separately-timed event; it
--  is the SAME receipt event distributed across obligations in the SAME
--  transaction. Adding a redundant physical stamp here would be exactly the
--  "convenience duplication" this audit was told to reject absent evidence.
--
--  FINANCIAL EVENTS (order_financial_events): STAMP REQUIRED, TWO COLUMNS,
--  mirroring the table's OWN existing, frozen S2 dual-column precedent
--  verbatim (verified live in 2026-08-15_s2_attribution_writers_receipt_
--  service.sql's own header): service_session_id = OBLIGATION service,
--  event_service_session_id = EVENT service (a refund can happen in a LATER
--  period than the original sale). Neither existing column's meaning is
--  touched. The new obligation_economic_period_kind is derived from the
--  LINKED ORDER's OWN creation timestamp (public.ordenes.created_at, joined
--  the exact same way the existing trigger already resolves service_
--  session_id: `WHERE o.id = NEW.order_id`) rather than from table_order_
--  lines -- this is UNIVERSALLY available for every channel (Mesa and non-
--  Mesa alike, since every order has ordenes.created_at regardless of
--  whether it has any table_order_lines rows), deliberately sidestepping
--  R-DAY0 §14's already-documented, already-deferred non-Mesa line-ledger
--  gap rather than reproducing it here. event_economic_period_kind is
--  stamped from this row's own clock_timestamp(), exactly like payment_
--  transactions above.
--
-- CENTRALIZATION: table_order_lines and payment_transactions currently have
-- NO before-insert trigger at all (verified live: only their append-only
-- UPDATE/DELETE-blocking triggers exist) -- roughly a dozen separate RPCs
-- across many migrations INSERT into them directly. Rather than touching
-- every one of those RPC bodies, this migration adds exactly ONE new,
-- narrowly-scoped BEFORE INSERT trigger per table, unconditionally
-- overwriting the new column only (S10's "child-derive" pattern: a forged/
-- client-supplied value can never survive) -- centralizing authority without
-- touching a single existing writer function. order_financial_events
-- ALREADY has a centralizing BEFORE INSERT trigger
-- (service_session_assign_financial_event) -- extended in place, same
-- trigger object, same firing position, two more assignments added to its
-- existing body.
--
-- LEGACY FALLBACK (read-time strategy, not built in this slice -- that is
-- S-E): NULL on any of these four new columns means the row pre-dates S-C;
-- readers resolve historical classification via the existing chain
-- (service_session_id -> service_sessions.service_kind, valid because every
-- economic_period_v1-era session has an immutable, non-null service_kind).
-- A non-NULL value is always authoritative and always wins.
--
-- Explicitly NOT done here: resolve_order_intake_context_v1, roll_service_
-- session_economic_v1, ensure_service_session (frozen S-A), service_session_
-- state shadow, rolled_over writes, current_period_id reinterpretation,
-- period_consolidations, any reader/aggregator retarget (economiaLedgerAggregate
-- .js, currentServiceCloseout.js) -- all untouched, not referenced anywhere
-- in this file's executable statements.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S-C refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='service_session_assign_financial_event'
  ) THEN RAISE EXCEPTION 'S-C refused: service_session_assign_financial_event does not exist -- S2 not applied'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='classify_economic_period_v1'
  ) THEN RAISE EXCEPTION 'S-C refused: classify_economic_period_v1 already exists -- already applied or drifted, resolve first'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='table_order_lines' AND column_name='economic_period_kind'
  ) THEN RAISE EXCEPTION 'S-C refused: table_order_lines.economic_period_kind already exists -- already applied or drifted'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_transactions' AND column_name='economic_period_kind'
  ) THEN RAISE EXCEPTION 'S-C refused: payment_transactions.economic_period_kind already exists -- already applied or drifted'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_financial_events' AND column_name='obligation_economic_period_kind'
  ) THEN RAISE EXCEPTION 'S-C refused: order_financial_events.obligation_economic_period_kind already exists -- already applied or drifted'; END IF;
END $$;

-- ── STEP 1 — the ONE authoritative write-time classifier ───────────────────
-- Verbatim restatement of resolveEconomicPeriod()'s exact expression, already
-- proven bit-exact against the JS module (R-DAY3's own 5760-sample parity
-- test), already live in resolve_order_intake_context_v1(). Extracted here
-- so every stamping trigger below calls the SAME function instead of
-- restating the arithmetic a fourth time.
CREATE OR REPLACE FUNCTION public.classify_economic_period_v1(p_at timestamptz DEFAULT clock_timestamp())
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_madrid timestamp;
  v_minutes_of_day integer;
BEGIN
  IF p_at IS NULL THEN
    RAISE EXCEPTION 'CLASSIFY_ECONOMIC_PERIOD_NULL_TIMESTAMP' USING ERRCODE='P0001';
  END IF;
  v_madrid := p_at AT TIME ZONE 'Europe/Madrid';
  v_minutes_of_day := extract(hour FROM v_madrid)::integer * 60 + extract(minute FROM v_madrid)::integer;
  -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, restated verbatim from resolveEconomicPeriod()'s own already-proven expression, not new vocabulary
  RETURN CASE WHEN v_minutes_of_day >= 240 AND v_minutes_of_day < 1050
              THEN 'PRANZO' ELSE 'SERA' END;
END;
$function$;

REVOKE ALL ON FUNCTION public.classify_economic_period_v1(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.classify_economic_period_v1(timestamptz) TO service_role;

-- ── STEP 2 — table_order_lines: OBLIGATION window ───────────────────────────
ALTER TABLE public.table_order_lines
  ADD COLUMN economic_period_kind text NULL;
ALTER TABLE public.table_order_lines
  ADD CONSTRAINT table_order_lines_economic_period_kind_chk
  CHECK (economic_period_kind IS NULL OR economic_period_kind = ANY (ARRAY['PRANZO','SERA']));

CREATE OR REPLACE FUNCTION public.table_order_lines_stamp_economic_period_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Unconditional overwrite: a client-supplied value (forged or otherwise)
  -- can never survive, matching S10's own child-derive discipline.
  NEW.economic_period_kind := public.classify_economic_period_v1(clock_timestamp());
  RETURN NEW;
END;
$function$;

CREATE TRIGGER table_order_lines_stamp_economic_period_v1
  BEFORE INSERT ON public.table_order_lines
  FOR EACH ROW EXECUTE FUNCTION public.table_order_lines_stamp_economic_period_v1();

REVOKE ALL ON FUNCTION public.table_order_lines_stamp_economic_period_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.table_order_lines_stamp_economic_period_v1() TO service_role;

-- ── STEP 3 — payment_transactions: RECEIPT window (independent of obligation) ─
ALTER TABLE public.payment_transactions
  ADD COLUMN economic_period_kind text NULL;
ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_economic_period_kind_chk
  CHECK (economic_period_kind IS NULL OR economic_period_kind = ANY (ARRAY['PRANZO','SERA']));

CREATE OR REPLACE FUNCTION public.payment_transactions_stamp_economic_period_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.economic_period_kind := public.classify_economic_period_v1(clock_timestamp());
  RETURN NEW;
END;
$function$;

CREATE TRIGGER payment_transactions_stamp_economic_period_v1
  BEFORE INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payment_transactions_stamp_economic_period_v1();

REVOKE ALL ON FUNCTION public.payment_transactions_stamp_economic_period_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_transactions_stamp_economic_period_v1() TO service_role;

-- ── STEP 4 — order_financial_events: OBLIGATION + EVENT windows, mirroring
-- the table's own existing service_session_id / event_service_session_id
-- split exactly. Extends the EXISTING trigger function in place (same
-- object, same firing position) -- no new trigger, body otherwise untouched
-- verbatim except the two new assignments. ─────────────────────────────────
ALTER TABLE public.order_financial_events
  ADD COLUMN obligation_economic_period_kind text NULL,
  ADD COLUMN event_economic_period_kind      text NULL;
ALTER TABLE public.order_financial_events
  ADD CONSTRAINT order_financial_events_obligation_econ_period_chk
  CHECK (obligation_economic_period_kind IS NULL OR obligation_economic_period_kind = ANY (ARRAY['PRANZO','SERA']));
ALTER TABLE public.order_financial_events
  ADD CONSTRAINT order_financial_events_event_econ_period_chk
  CHECK (event_economic_period_kind IS NULL OR event_economic_period_kind = ANY (ARRAY['PRANZO','SERA']));

CREATE OR REPLACE FUNCTION public.service_session_assign_financial_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session_id     uuid;
  v_table_session  uuid;
  v_candidates     uuid[];
  v_order_created_at timestamptz;
BEGIN
  SELECT o.service_session_id, o.created_at INTO v_session_id, v_order_created_at
    FROM public.ordenes o WHERE o.id = NEW.order_id;

  IF v_session_id IS NULL AND NEW.payment_transaction_id IS NOT NULL THEN
    SELECT pt.table_session_id INTO v_table_session
      FROM public.payment_transactions pt WHERE pt.id = NEW.payment_transaction_id;

    SELECT array_agg(DISTINCT l.service_session_id) INTO v_candidates
      FROM public.payment_allocations pa
      JOIN public.table_order_lines   l ON l.id = pa.table_order_line_id
     WHERE pa.payment_transaction_id = NEW.payment_transaction_id
       AND l.table_session_id        = v_table_session
       AND l.order_id                = NEW.order_id;

    IF v_candidates IS NOT NULL AND cardinality(v_candidates) > 1 THEN
      RAISE EXCEPTION 'ORDER_OBLIGATION_AMBIGUOUS' USING ERRCODE='P0001',
        DETAIL = format('order=%s table_session=%s candidates=%s',
                        NEW.order_id, v_table_session, v_candidates);
    END IF;
    IF v_candidates IS NOT NULL AND cardinality(v_candidates) = 1 THEN
      v_session_id := v_candidates[1];
    END IF;
  END IF;

  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;

  NEW.service_session_id := v_session_id;

  -- S-C: immutable economic-window stamps, additive alongside the existing
  -- session-lineage assignment above (untouched). Obligation window is
  -- derived from the ORDER's own creation instant (universal across every
  -- channel, sidesteps the Mesa-only table_order_lines gap); event window is
  -- this row's own write-time instant -- unconditional overwrite, same
  -- discipline as service_session_id above.
  NEW.obligation_economic_period_kind := CASE WHEN v_order_created_at IS NOT NULL
    THEN public.classify_economic_period_v1(v_order_created_at) ELSE NULL END;
  NEW.event_economic_period_kind := public.classify_economic_period_v1(clock_timestamp());

  RETURN NEW;
END $function$;

-- ── Post-conditions ──────────────────────────────────────────────────────
DO $$
DECLARE v_ptr record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='classify_economic_period_v1'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: classify_economic_period_v1 was not created'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='table_order_lines' AND column_name='economic_period_kind' AND is_nullable='YES'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: table_order_lines.economic_period_kind wrong shape'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_transactions' AND column_name='economic_period_kind' AND is_nullable='YES'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: payment_transactions.economic_period_kind wrong shape'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_financial_events' AND column_name='obligation_economic_period_kind' AND is_nullable='YES'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: order_financial_events.obligation_economic_period_kind wrong shape'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_financial_events' AND column_name='event_economic_period_kind' AND is_nullable='YES'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: order_financial_events.event_economic_period_kind wrong shape'; END IF;

  -- Every EXISTING row in all three tables must remain NULL on the new
  -- columns -- no historical backfill, no append-only bypass.
  IF (SELECT count(*) FROM public.table_order_lines WHERE economic_period_kind IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'S-C post-condition failed: table_order_lines has non-NULL economic_period_kind rows -- historical backfill is forbidden';
  END IF;
  IF (SELECT count(*) FROM public.payment_transactions WHERE economic_period_kind IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'S-C post-condition failed: payment_transactions has non-NULL economic_period_kind rows -- historical backfill is forbidden';
  END IF;
  IF (SELECT count(*) FROM public.order_financial_events WHERE obligation_economic_period_kind IS NOT NULL OR event_economic_period_kind IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'S-C post-condition failed: order_financial_events has non-NULL stamp rows -- historical backfill is forbidden';
  END IF;

  -- payment_allocations/order_entities/ordenes must NOT have been touched.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='payment_allocations' AND column_name LIKE '%economic_period%'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: payment_allocations must not carry an economic-period stamp'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='order_entities' AND column_name LIKE '%economic_period%'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: order_entities must not carry an economic-period stamp'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ordenes' AND column_name LIKE '%economic_period%'
  ) THEN RAISE EXCEPTION 'S-C post-condition failed: ordenes must not carry an economic-period stamp'; END IF;

  -- Nothing else touched: pointer, shadow, S-A, S-B, financial invariants.
  IF (SELECT current_session_id FROM public.service_session_state) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-C post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-C post-condition failed: canonical pointer changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-C post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT round(sum(amount)::numeric,2) FROM public.payment_transactions) <> (SELECT round(sum(amount)::numeric,2) FROM public.payment_allocations) THEN
    RAISE EXCEPTION 'S-C post-condition failed: payment_transactions/payment_allocations sums diverged';
  END IF;
  IF (SELECT count(*) FROM public.period_consolidations) <> 5 THEN
    RAISE EXCEPTION 'S-C post-condition failed: period_consolidations population changed -- must be exactly 5';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics='operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'S-C post-condition failed: real operational_service_v1 rows must remain 0';
  END IF;
END $$;

COMMIT;
