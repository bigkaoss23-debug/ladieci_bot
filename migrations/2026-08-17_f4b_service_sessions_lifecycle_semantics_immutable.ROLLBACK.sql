-- migrations/2026-08-17_f4b_service_sessions_lifecycle_semantics_immutable.ROLLBACK.sql
-- Paired rollback for 2026-08-17_f4b_service_sessions_lifecycle_semantics_immutable.sql.
--
-- PONR (point of no return): F-4B itself creates no new immutable business
-- evidence -- the guard trigger is pure schema, zero data written. But the
-- INVARIANT it enforces (a service_sessions row's era can never change after
-- INSERT) is exactly the guarantee F-4A's evidence tables were built to rely
-- on, and the guarantee any future writer of a real operational_service_v1
-- row would be entitled to assume already holds. The honest PONR is
-- therefore not "a row this migration wrote" but "the first moment a real
-- operational_service_v1 service_sessions row exists at all" -- once that
-- happens, removing this guard would let a row silently claim a different
-- era than the one under which any evidence already referencing it was
-- captured, corrupting the provenance guarantee retroactively for however
-- long the guard is absent. This rollback refuses outright the instant any
-- such row exists, checked first, before any DDL runs -- no fabricated
-- reversibility guarantee.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1')
  THEN
    RAISE EXCEPTION 'F-4B rollback refused: PONR reached -- a real operational_service_v1 service_sessions row exists; removing the era-immutability guard now would let it (or any future row) silently change era after evidence referencing it may already exist';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='service_sessions_lifecycle_semantics_immutable_guard' AND tgrelid='public.service_sessions'::regclass) THEN
    RAISE EXCEPTION 'F-4B rollback refused: guard trigger not present -- not applied, or already drifted';
  END IF;
END $$;

DROP TRIGGER service_sessions_lifecycle_semantics_immutable_guard ON public.service_sessions;
DROP FUNCTION public.guard_service_sessions_lifecycle_semantics_immutable_v1();

-- ============================================================
-- Post-condition.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='service_sessions_lifecycle_semantics_immutable_guard' AND tgrelid='public.service_sessions'::regclass) THEN
    RAISE EXCEPTION 'F-4B rollback post-condition failed: guard trigger still present';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_service_sessions_lifecycle_semantics_immutable_v1') THEN
    RAISE EXCEPTION 'F-4B rollback post-condition failed: guard function still present';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions) <> 13
     OR (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0
  THEN RAISE EXCEPTION 'F-4B rollback post-condition failed: service_sessions historical integrity violated'; END IF;
END $$;

COMMIT;
