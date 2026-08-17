-- migrations/2026-08-17_s_b_service_sessions_lifecycle_semantics.sql
-- S-B — Operational Service repair, slice B ONLY: add the explicit semantic
-- discriminator that makes mixed historical/future service_sessions
-- semantics deterministic. NO behavior cutover. NO real operational_
-- service_v1 row is created by this migration.
--
-- Authority: owner-frozen architecture (this session, S-B task brief,
-- immediately after S-A): legacy service_sessions rows carry
-- economic_period_v1 semantics; future rows (S-D's cutover, not this slice)
-- will carry operational_service_v1 semantics. The two contracts must never
-- be inferred from business_date/migration timestamp/service_kind IS NULL/
-- status/rolled_over_at/row-id ordering -- none of those are stable semantic
-- identifiers. The row must say which contract it follows.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Every INSERT INTO service_sessions across every migration in this repo
--     (11 call sites, grepped fresh) uses an explicit column list -- zero
--     positional-VALUES risk from adding a new column.
--   - No generated TypeScript/schema type files exist in this project (plain
--     JS + PostgREST; every consumer reads named JSON keys, never positional
--     tuples) -- confirmed via a repo-wide search.
--   - No application code does strict Object.keys()/shape comparison on a
--     session row -- confirmed via a repo-wide grep.
--   - Current live rows: 13 total, ALL with service_kind NOT NULL (4 closed
--     PRANZO, 4 closed SERA, 1 open SERA, 3 rolled_over PRANZO, 1 rolled_over
--     SERA) -- every existing row already satisfies today's
--     service_sessions_active_kind_chk, so every one of them trivially
--     satisfies the new era-aware CHECK's economic_period_v1 branch (which is
--     byte-identical to today's rule), proven empirically below, not merely
--     asserted.
--
-- WHAT THIS MIGRATION DOES, exactly, and nothing else:
--  1. ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1'
--     -- metadata/default operation, not a historical rewrite. Every existing
--     row becomes explicitly economic_period_v1 via the column default, with
--     no per-row UPDATE statement anywhere in this migration.
--  2. CHECK constraint restricting the column to exactly the two known
--     values (service_sessions_lifecycle_semantics_chk) -- same style as the
--     existing service_sessions_kind_chk.
--  3. REPLACE service_sessions_active_kind_chk with an era-aware version:
--     economic_period_v1 rows keep today's EXACT rule
--     ((status='closed') OR (service_kind IS NOT NULL)); operational_
--     service_v1 rows require service_kind IS NULL, unconditionally. Cannot
--     coexist as two separate constraints -- the old rule alone would reject
--     any future open operational_service_v1+NULL-kind row, so it is
--     replaced under the same name (a real behavioral change to the
--     constraint, kept under its existing name to signal "this replaces the
--     prior rule", not a new, disconnected one).
--
-- EXPLICITLY NOT DONE (belongs to later slices, per the frozen S-B scope):
--   - no INSERT writer is changed to emit operational_service_v1 (S-D);
--   - no event-time economic-period stamping columns anywhere (S-C);
--   - resolve_order_intake_context_v1, roll_service_session_economic_v1,
--     economicBoundaryEngine.js, ensure_service_session (frozen by S-A),
--     current pointers, legacy shadow, rolled_over behavior, service_kind
--     computation -- all untouched, not redefined anywhere in this file.
BEGIN;

DO $$
DECLARE
  v_would_violate integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S-B refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='service_sessions'
  ) THEN RAISE EXCEPTION 'S-B refused: service_sessions does not exist'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='lifecycle_semantics'
  ) THEN RAISE EXCEPTION 'S-B refused: lifecycle_semantics already exists -- already applied or drifted, resolve first'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.service_sessions'::regclass
       AND conname='service_sessions_active_kind_chk'
       AND pg_get_constraintdef(oid) = 'CHECK (((status = ''closed''::text) OR (service_kind IS NOT NULL)))'
  ) THEN RAISE EXCEPTION 'S-B refused: service_sessions_active_kind_chk does not match the expected pre-S-B shape -- already patched or drifted, resolve first'; END IF;

  -- Empirical, not merely asserted: every CURRENT row, evaluated against the
  -- proposed era-aware expression assuming lifecycle_semantics defaults to
  -- economic_period_v1, must already pass. Zero existing rows may become
  -- invalid (frozen requirement).
  SELECT count(*) INTO v_would_violate FROM public.service_sessions
   WHERE NOT ( (status = 'closed') OR (service_kind IS NOT NULL) );
  IF v_would_violate > 0 THEN
    RAISE EXCEPTION 'S-B refused: % existing row(s) would violate the era-aware CHECK under the economic_period_v1 default -- investigate before proceeding', v_would_violate;
  END IF;
END $$;

ALTER TABLE public.service_sessions
  ADD COLUMN lifecycle_semantics text NOT NULL DEFAULT 'economic_period_v1';

ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_lifecycle_semantics_chk
  CHECK (lifecycle_semantics = ANY (ARRAY['economic_period_v1', 'operational_service_v1']));

ALTER TABLE public.service_sessions
  DROP CONSTRAINT service_sessions_active_kind_chk;

ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_active_kind_chk
  CHECK (
    (lifecycle_semantics = 'economic_period_v1' AND (status = 'closed' OR service_kind IS NOT NULL))
    OR
    (lifecycle_semantics = 'operational_service_v1' AND service_kind IS NULL)
  );

-- Post-conditions.
DO $$
DECLARE
  v_non_economic integer;
  v_operational integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='lifecycle_semantics'
       AND is_nullable='NO' AND column_default LIKE '%economic_period_v1%'
  ) THEN RAISE EXCEPTION 'S-B post-condition failed: lifecycle_semantics column shape wrong (must be NOT NULL DEFAULT economic_period_v1)'; END IF;

  SELECT count(*) INTO v_non_economic FROM public.service_sessions WHERE lifecycle_semantics <> 'economic_period_v1';
  IF v_non_economic <> 0 THEN
    RAISE EXCEPTION 'S-B post-condition failed: % existing row(s) are not economic_period_v1 -- this migration must not create/convert any row', v_non_economic;
  END IF;

  SELECT count(*) INTO v_operational FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1';
  IF v_operational <> 0 THEN
    RAISE EXCEPTION 'S-B post-condition failed: % real operational_service_v1 row(s) exist -- S-B must create zero', v_operational;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.service_sessions'::regclass
       AND conname='service_sessions_lifecycle_semantics_chk'
  ) THEN RAISE EXCEPTION 'S-B post-condition failed: lifecycle_semantics CHECK missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.service_sessions'::regclass
       AND conname='service_sessions_active_kind_chk'
       AND pg_get_constraintdef(oid) LIKE '%operational_service_v1%'
  ) THEN RAISE EXCEPTION 'S-B post-condition failed: era-aware service_sessions_active_kind_chk missing/wrong'; END IF;

  -- Nothing else in this migration touches ANY other table, function,
  -- pointer, or shadow. Confirmed unchanged.
  IF (SELECT current_session_id FROM public.service_session_state) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-B post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'S-B post-condition failed: canonical pointer changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-B post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.period_consolidations) <> 5 THEN
    RAISE EXCEPTION 'S-B post-condition failed: period_consolidations population changed -- must be exactly 5';
  END IF;
END $$;

COMMIT;
