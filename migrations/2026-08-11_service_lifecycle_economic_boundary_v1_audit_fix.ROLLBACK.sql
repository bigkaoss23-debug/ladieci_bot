-- migrations/2026-08-11_service_lifecycle_economic_boundary_v1_audit_fix.ROLLBACK.sql
-- Reverts 2026-08-11_service_lifecycle_economic_boundary_v1_audit_fix.sql
-- exactly: restores service_session_audit_event_type_check to its original
-- 3-value definition. Refuses if any real 'rolled_over_economic' audit row
-- exists — reverting under a live row would leave it violating the restored
-- constraint, and this rollback will never silently rewrite real audit
-- history. Resolve those rows first (a deliberate, separate decision) if
-- this ever needs to run against a database that actually used row 65.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_session_audit WHERE event_type = 'rolled_over_economic') THEN
    RAISE EXCEPTION 'audit fix rollback refused: at least one service_session_audit row is event_type=rolled_over_economic — resolve those rows first, this rollback will not silently rewrite real audit history.';
  END IF;
END $$;

ALTER TABLE public.service_session_audit
  DROP CONSTRAINT service_session_audit_event_type_check;
ALTER TABLE public.service_session_audit
  ADD CONSTRAINT service_session_audit_event_type_check
  CHECK (event_type = ANY (ARRAY['opened','closing','closed']));

COMMIT;
