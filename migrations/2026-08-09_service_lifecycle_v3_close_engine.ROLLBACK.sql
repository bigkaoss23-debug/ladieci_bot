BEGIN;

-- ── PART 3 rollback — restore guard_service_session_closed_v1's exact live
--    pre-change body (unconditional MESA_TABLES_NOT_RELEASED, no exemption) ──
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
        MESSAGE = 'MESA_TABLES_NOT_RELEASED';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            -- language-guard: allow-legacy COMPLETATO is the existing terminal-state literal restored verbatim from the live pre-change body, not new vocabulary
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restored verbatim for the same reason
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

-- ── PART 1/2 rollback — drop the two new RPCs ───────────────────────────────
DROP FUNCTION IF EXISTS public.create_service_closeout(uuid,uuid,text,text,text,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer,integer);
DROP FUNCTION IF EXISTS public.close_service_session_v3(uuid,uuid,text,text);

COMMIT;
