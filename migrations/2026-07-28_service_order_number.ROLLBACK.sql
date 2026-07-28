BEGIN;

-- Operational rollback requires the previous backend to be active first.
-- Existing assigned numbers are retained until this explicit schema rollback.
DROP INDEX IF EXISTS public.ordenes_service_order_number_uq;
ALTER TABLE public.ordenes
  DROP CONSTRAINT IF EXISTS ordenes_service_order_number_chk,
  DROP COLUMN IF EXISTS service_order_number;
ALTER TABLE public.service_sessions
  DROP CONSTRAINT IF EXISTS service_sessions_next_order_number_chk,
  DROP COLUMN IF EXISTS next_order_number;

-- Restore the pre-numbering assignment contract.
CREATE OR REPLACE FUNCTION public.service_session_assign_order()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_state FROM public.service_session_state
   WHERE singleton = true FOR UPDATE;
  IF v_state.current_session_id IS NULL THEN
    RAISE EXCEPTION 'NO_OPEN_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO v_session FROM public.service_sessions
   WHERE id=v_state.current_session_id FOR SHARE;
  IF NOT FOUND OR v_session.status <> 'open' THEN
    RAISE EXCEPTION 'INVALID_OPEN_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;
  IF NEW.service_session_id IS NOT NULL
     AND NEW.service_session_id <> v_session.id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_FORGERY' USING ERRCODE='P0001';
  END IF;
  NEW.service_session_id := v_session.id;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.service_session_immutable_order()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.service_session_id IS DISTINCT FROM OLD.service_session_id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
