-- migrations/2026-08-16_r_day2_hotfix_service_sessions_business_day_derive.ROLLBACK.sql
-- Paired rollback. Restores the exact pre-hotfix state: service_sessions.
-- business_day_id NOT NULL with no writer other than the manual R-DAY1
-- backfill (i.e. restores the original bug -- this rollback is only safe if
-- ensure_service_session/roll_service_session_economic_v1 are ALSO reverted
-- to a state that doesn't reach their own INSERT, or if R-DAY0/R-DAY3
-- has since given service_sessions a different, intentional business_day_id
-- writer). Refuses if any service_sessions row's business_day_id could only
-- have been produced by this trigger and would become orphaned truth with
-- no explanation. Never deletes a real business_days row.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname='service_sessions' AND t.tgname='service_sessions_business_day_derive_v1'
  ) THEN RAISE EXCEPTION 'R-DAY2 hotfix rollback refused: trigger does not exist -- nothing to roll back, or already rolled back'; END IF;
END $$;

DROP TRIGGER IF EXISTS service_sessions_business_day_derive_v1 ON public.service_sessions;
DROP FUNCTION IF EXISTS public.service_session_business_day_derive_v1();

COMMIT;
