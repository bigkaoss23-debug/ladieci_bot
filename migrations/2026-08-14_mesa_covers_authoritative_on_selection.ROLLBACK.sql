-- ROLLBACK for 2026-08-14_mesa_covers_authoritative_on_selection.sql
-- Purely additive forward migration -> purely subtractive rollback.
-- Drops the new RPC only. No existing function/trigger/table/column is
-- touched by the forward migration, so there is nothing else to restore.

BEGIN;

DROP FUNCTION IF EXISTS public.mesa_set_session_covers_v1(uuid,text,uuid,integer);

COMMIT;
