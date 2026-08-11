-- migrations/2026-08-11_service_lifecycle_economic_boundary_v1_audit_fix.sql
-- SERVICE LIFECYCLE / P0-C2 — HOTFIX for row 65
-- (2026-08-10_service_lifecycle_economic_boundary_v1.sql).
--
-- ── WHAT BROKE ───────────────────────────────────────────────────────────
-- roll_service_session_economic_v1 (row 65) writes two service_session_audit
-- rows per call: event_type='rolled_over_economic' for session A and
-- event_type='opened' for session B. service_session_audit_event_type_check
-- (pre-existing, predates row 65, untouched by it) only allows
-- ('opened','closing','closed') — 'rolled_over_economic' is a genuinely new
-- event type row 65 introduced without widening this constraint. First real
-- invocation (the 76c44f7d controlled-recovery attempt against the actual
-- language-guard: allow-legacy PRANZO is the existing service_kind enum value, named here only to identify which real stuck session surfaced this bug, not new vocabulary
-- stuck 2026-08-10 PRANZO) failed closed with a Postgres CHECK violation
-- inside the function body, which rolled back the ENTIRE transaction
-- atomically (session A's status update, B's creation, and the
-- current_session_id pointer flip all rolled back together — confirmed via
-- direct query afterward: session A was still status='closing',
-- rolled_over_at NULL, no B row existed). No partial mutation occurred; this
-- is a pure schema gap, not a logic bug in the rollover itself, and not a
-- data-integrity incident.
--
-- ── WHY THIS WASN'T CAUGHT EARLIER ──────────────────────────────────────
-- Row 65's own shadow-schema validation (p0c2_shadow, 16/16 checks) and this
-- slice's unit tests never sent a real INSERT through the actual
-- service_session_audit_event_type_check constraint: the unit tests mock the
-- `rpc` dependency (never touch SQL at all), and the real-Postgres tests
-- exercise the RPC's own controlled jsonb-error paths, not a full run to the
-- audit INSERT with the live table's real constraint attached. Closed by
-- tests/serviceLifecycleEconomicBoundaryAuditFix.test.js below, which runs
-- this exact ALTER against a shadow copy of the real constraint and proves
-- both directions (accepts 'rolled_over_economic', still rejects an
-- arbitrary bogus value).
--
-- ── WHAT THIS MIGRATION DOES ────────────────────────────────────────────
-- Widens service_session_audit_event_type_check by exactly one value.
-- Nothing else: no other constraint, column, function, or trigger touched.
-- Forward-only — row 65's own file is not edited or reapplied.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'audit fix refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regprocedure('public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)') IS NULL THEN
    RAISE EXCEPTION 'audit fix refused: roll_service_session_economic_v1 does not exist — apply row 65 first.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_session_audit_event_type_check'
      AND pg_get_constraintdef(oid) LIKE '%rolled_over_economic%'
  ) THEN
    RAISE EXCEPTION 'audit fix refused: service_session_audit_event_type_check already allows rolled_over_economic — already patched, resolve drift first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_session_audit_event_type_check'
      AND pg_get_constraintdef(oid) = 'CHECK ((event_type = ANY (ARRAY[''opened''::text, ''closing''::text, ''closed''::text])))'
  ) THEN
    RAISE EXCEPTION 'audit fix refused: service_session_audit_event_type_check is not the expected 3-value definition — resolve drift first.';
  END IF;
END $$;

ALTER TABLE public.service_session_audit
  DROP CONSTRAINT service_session_audit_event_type_check;
ALTER TABLE public.service_session_audit
  ADD CONSTRAINT service_session_audit_event_type_check
  CHECK (event_type = ANY (ARRAY['opened','closing','closed','rolled_over_economic']));

COMMIT;
