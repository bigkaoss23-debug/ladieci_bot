BEGIN;

REVOKE EXECUTE ON FUNCTION
  public.create_archived_order_financial_resolution(uuid,text,uuid,text,integer,text,text,text,integer,text,uuid,uuid,text)
  FROM service_role;

DROP FUNCTION IF EXISTS public.create_archived_order_financial_resolution(uuid,text,uuid,text,integer,text,text,text,integer,text,uuid,uuid,text);

DROP TRIGGER IF EXISTS archived_order_financial_resolutions_no_update_delete ON public.archived_order_financial_resolutions;
DROP FUNCTION IF EXISTS public.archived_order_financial_resolutions_append_only();

DROP TABLE IF EXISTS public.archived_order_financial_resolutions;

COMMIT;
