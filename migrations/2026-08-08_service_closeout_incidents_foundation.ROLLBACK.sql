BEGIN;

REVOKE EXECUTE ON FUNCTION
  public.capture_closeout_snapshot(uuid,uuid,text,text,jsonb,integer,text),
  public.create_service_incident(uuid,uuid,text,text,text,text,text,text,text,uuid,text,text,integer,uuid,boolean,text,text),
  public.resolve_service_incident(uuid,text,text,text,text,text)
  FROM service_role;

DROP FUNCTION IF EXISTS public.capture_closeout_snapshot(uuid,uuid,text,text,jsonb,integer,text);
DROP FUNCTION IF EXISTS public.create_service_incident(uuid,uuid,text,text,text,text,text,text,text,uuid,text,text,integer,uuid,boolean,text,text);
DROP FUNCTION IF EXISTS public.resolve_service_incident(uuid,text,text,text,text,text);

DROP TRIGGER IF EXISTS service_incident_resolutions_no_update_delete ON public.service_incident_resolutions;
DROP FUNCTION IF EXISTS public.service_incident_resolutions_append_only();

DROP TRIGGER IF EXISTS service_incidents_no_delete ON public.service_incidents;
DROP FUNCTION IF EXISTS public.service_incidents_no_delete();

DROP TRIGGER IF EXISTS service_incidents_facts_immutable ON public.service_incidents;
DROP FUNCTION IF EXISTS public.service_incidents_immutable_facts();

DROP TRIGGER IF EXISTS service_closeout_snapshots_no_update_delete ON public.service_closeout_snapshots;
DROP FUNCTION IF EXISTS public.service_closeout_snapshots_append_only();

DROP TABLE IF EXISTS public.service_incident_resolutions;
DROP TABLE IF EXISTS public.service_incidents;
DROP TABLE IF EXISTS public.service_closeout_snapshots;

COMMIT;
