-- V3-H.2 rollback: schema-only removal is allowed only before any reservation exists.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.table_reservations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.table_reservations)
  THEN
    RAISE EXCEPTION 'V3-H.2 rollback refused: Mesa reservation evidence exists';
  END IF;
END $$;

DROP TRIGGER IF EXISTS messa_guard_reserved_table_v1 ON public.restaurant_tables;
DROP FUNCTION IF EXISTS public.messa_guard_reserved_table_v1();
DROP TRIGGER IF EXISTS messa_complete_reservation_v1 ON public.table_sessions;
DROP FUNCTION IF EXISTS public.messa_complete_reservation_v1();
DROP FUNCTION IF EXISTS public.messa_open_reservation_v1(uuid,text,uuid,integer,uuid);
DROP FUNCTION IF EXISTS public.messa_set_reservation_status_v1(uuid,text,uuid,integer,text);
DROP FUNCTION IF EXISTS public.messa_save_reservation_v1(uuid,text,uuid,uuid,text,text,integer,text,text,text,integer);
DROP TABLE IF EXISTS public.table_reservations;

COMMIT;
