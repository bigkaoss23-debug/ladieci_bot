-- migrations/2026-08-17_f3_v3_order_residue_guard_repair.ROLLBACK.sql
-- Paired rollback for 2026-08-17_f3_v3_order_residue_guard_repair.sql.
--
-- Restores the exact byte-captured pre-F-3 guard_service_session_closed_v1
-- body (order-residue block legacy-only, no V3 branch). Touches no data --
-- a pure function redefinition, no append-only evidence to protect (this
-- guard only ever raises an exception or returns NEW; it never itself
-- writes a row).
BEGIN;

DO $$
DECLARE
  v_def text;
  v_v3_count int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='guard_service_session_closed_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'F-3 rollback refused: guard_service_session_closed_v1 does not exist';
  END IF;

  v_v3_count := (length(v_def) - length(replace(v_def, 'v_v3_authorized', ''))) / length('v_v3_authorized');
  IF v_v3_count <> 4 THEN
    RAISE EXCEPTION 'F-3 rollback refused: guard_service_session_closed_v1 does not show the post-F-3 shape (expected 4 occurrences of v_v3_authorized, found %) -- not applied, or already drifted', v_v3_count;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_incident_safe boolean;
  v_v3_authorized boolean;
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    v_incident_safe := COALESCE(current_setting('ladieci.incident_safe_close_session_id', true), '') = OLD.id::text;
    v_v3_authorized := COALESCE(current_setting('ladieci.v3_close_authorized_session_id', true), '') = OLD.id::text;

    IF NOT (
      (
        v_v3_authorized
        AND EXISTS (
          SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
        )
      )
      OR v_incident_safe
    ) THEN
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
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            -- language-guard: allow-legacy COMPLETATO is the existing terminal-state literal restored verbatim from the pre-F-3 body, not new vocabulary
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restored verbatim for the same reason
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
        AND NOT (
          v_incident_safe
          AND EXISTS (
            SELECT 1 FROM public.service_incidents si
            WHERE si.service_session_id = OLD.id
              AND si.order_id = o.id::text
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
$function$;

-- Post-condition.
DO $$
DECLARE
  v_def text;
  v_v3_count int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='guard_service_session_closed_v1';
  v_v3_count := (length(v_def) - length(replace(v_def, 'v_v3_authorized', ''))) / length('v_v3_authorized');
  IF v_v3_count <> 3 THEN
    RAISE EXCEPTION 'F-3 rollback post-condition failed: expected exactly 3 occurrences of v_v3_authorized after rollback (found %), the post-F-3 order-residue V3 branch may still be present', v_v3_count;
  END IF;
END $$;

COMMIT;
