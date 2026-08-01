-- Emergency rollback only: restores the original V3-H function path and also
-- restores its known payment failure. It changes no data.
BEGIN;

ALTER FUNCTION public.messa_post_payment_v1(
  uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb
) SET search_path = public, pg_temp;

COMMIT;
