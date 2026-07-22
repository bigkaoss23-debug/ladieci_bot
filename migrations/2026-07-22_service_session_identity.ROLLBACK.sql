BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.serata_summary GROUP BY fecha HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.storico GROUP BY orden_id,fecha HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM public.order_financial_events e LEFT JOIN public.ordenes o ON o.id=e.order_id WHERE o.id IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: multi-service data cannot fit legacy date identity';
  END IF;
END $$;
DROP TRIGGER IF EXISTS financial_event_assign_service_session ON public.order_financial_events;
DROP TRIGGER IF EXISTS serata_summary_validate_service_session ON public.serata_summary;
DROP TRIGGER IF EXISTS storico_validate_service_session ON public.storico;
DROP TRIGGER IF EXISTS ordenes_service_session_immutable ON public.ordenes;
DROP TRIGGER IF EXISTS ordenes_assign_service_session ON public.ordenes;
DROP FUNCTION IF EXISTS public.get_current_service_closeout_session();
DROP FUNCTION IF EXISTS public.complete_service_session_close(uuid,text,text);
DROP FUNCTION IF EXISTS public.begin_service_session_close(text,text);
DROP FUNCTION IF EXISTS public.open_service_session(text,text);
DROP FUNCTION IF EXISTS public.service_session_assign_financial_event();
DROP FUNCTION IF EXISTS public.service_session_validate_summary();
DROP FUNCTION IF EXISTS public.service_session_validate_archive();
DROP FUNCTION IF EXISTS public.service_session_immutable_order();
DROP FUNCTION IF EXISTS public.service_session_assign_order();
DROP INDEX IF EXISTS public.financial_events_service_session_idx;
DROP INDEX IF EXISTS public.storico_service_session_idx;
DROP INDEX IF EXISTS public.ordenes_service_session_idx;
DROP INDEX IF EXISTS public.storico_session_order_uq;
DROP INDEX IF EXISTS public.serata_summary_session_uq;
ALTER TABLE public.serata_summary DROP CONSTRAINT IF EXISTS serata_summary_pkey;
ALTER TABLE public.serata_summary ADD CONSTRAINT serata_summary_pkey PRIMARY KEY (fecha);
ALTER TABLE public.storico ADD CONSTRAINT storico_orden_id_fecha_key UNIQUE (orden_id,fecha);
ALTER TABLE public.order_financial_events DROP COLUMN IF EXISTS service_session_id;
ALTER TABLE public.order_financial_events ADD CONSTRAINT ofe_order_id_fk FOREIGN KEY (order_id) REFERENCES public.ordenes(id) ON DELETE RESTRICT;
ALTER TABLE public.serata_summary DROP COLUMN IF EXISTS service_session_id;
ALTER TABLE public.serata_summary DROP COLUMN IF EXISTS id;
ALTER TABLE public.storico DROP COLUMN IF EXISTS service_session_id;
ALTER TABLE public.ordenes DROP COLUMN IF EXISTS service_session_id;
DROP TABLE IF EXISTS public.service_session_audit;
DROP TABLE IF EXISTS public.service_session_state;
DROP TABLE IF EXISTS public.service_sessions;
COMMIT;
