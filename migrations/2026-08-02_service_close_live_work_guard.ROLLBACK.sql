BEGIN;

DROP TRIGGER IF EXISTS service_sessions_closed_live_work_guard
  ON public.service_sessions;
DROP FUNCTION IF EXISTS public.guard_service_session_closed_v1();

COMMIT;
