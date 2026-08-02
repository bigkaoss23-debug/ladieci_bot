BEGIN;

-- A service may become closed only after every live order and every open Mesa
-- account has been resolved. The application performs a friendly preflight,
-- but this trigger is the last-line invariant for recovery scripts and any
-- future service_role caller that updates service_sessions directly.
--
-- Concurrency: service_session_assign_order() takes a share lock on the service
-- row before inserting an order. This BEFORE UPDATE trigger already owns the
-- conflicting row lock, so an order cannot race in between these checks and the
-- status transition.
CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    IF EXISTS (
      SELECT 1
      FROM public.table_sessions t
      WHERE t.service_session_id = OLD.id
        AND t.status = 'open'
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'MESSA_TABLES_NOT_RELEASED';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED';
    END IF;
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS service_sessions_closed_live_work_guard
  ON public.service_sessions;
CREATE TRIGGER service_sessions_closed_live_work_guard
BEFORE UPDATE OF status ON public.service_sessions
FOR EACH ROW
EXECUTE FUNCTION public.guard_service_session_closed_v1();

REVOKE ALL ON FUNCTION public.guard_service_session_closed_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_service_session_closed_v1() TO service_role;

COMMIT;
