BEGIN;

REVOKE EXECUTE ON FUNCTION
  public.acquire_closeout_attempt(uuid,text),
  public.supersede_closeout_attempt(uuid,text,text),
  public.complete_closeout_attempt(uuid,text)
  FROM service_role;

DROP FUNCTION IF EXISTS public.acquire_closeout_attempt(uuid,text);
DROP FUNCTION IF EXISTS public.supersede_closeout_attempt(uuid,text,text);
DROP FUNCTION IF EXISTS public.complete_closeout_attempt(uuid,text);

DROP TRIGGER IF EXISTS service_closeout_attempts_guarded_transitions ON public.service_closeout_attempts;
DROP FUNCTION IF EXISTS public.service_closeout_attempts_guarded_transitions();

DROP TRIGGER IF EXISTS service_closeout_attempts_no_delete ON public.service_closeout_attempts;
DROP FUNCTION IF EXISTS public.service_closeout_attempts_no_delete();

DROP TABLE IF EXISTS public.service_closeout_attempts;

COMMIT;
