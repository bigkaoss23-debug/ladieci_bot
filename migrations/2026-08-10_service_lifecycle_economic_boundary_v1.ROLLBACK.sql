-- migrations/2026-08-10_service_lifecycle_economic_boundary_v1.ROLLBACK.sql
-- Reverts 2026-08-10_service_lifecycle_economic_boundary_v1.sql exactly:
-- drops roll_service_session_economic_v1, drops rolled_over_at, restores the
-- original 3-value status CHECK. Refuses if any real 'rolled_over' row exists
-- — reverting the CHECK constraint under a live 'rolled_over' row would leave
-- that row violating the restored constraint (or require rewriting real
-- session history to a different status, which this rollback will never do
-- silently). Resolve those rows first (a deliberate, separate decision) if
-- this ever needs to run against a database that actually used the primitive.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_sessions WHERE status = 'rolled_over') THEN
    RAISE EXCEPTION 'economic boundary v1 rollback refused: at least one service_sessions row is still status=rolled_over — resolve those rows first, this rollback will not silently rewrite real session history.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date);

ALTER TABLE public.service_sessions
  DROP CONSTRAINT service_sessions_status_check;
ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_status_check
  CHECK (status = ANY (ARRAY['open','closing','closed']));

ALTER TABLE public.service_sessions
  DROP COLUMN IF EXISTS rolled_over_at;

COMMIT;
