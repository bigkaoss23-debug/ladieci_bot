-- ===============================================================
-- S2-7D6B ROLLBACK — back to single-service identity.
--
-- REFUSES when two-service data already exists, because the legacy uniqueness
-- rules physically cannot hold it: a business date carrying both a PRANZO and a
-- SERA, or two sessions sharing an order id in the ledger, would collide the
-- moment the global indexes are recreated. Losing that data silently is the one
-- outcome this file exists to prevent.
-- ===============================================================
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_sessions WHERE status IN ('open','closing'))
  THEN RAISE EXCEPTION 'ROLLBACK REFUSED: an active service session exists'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.service_sessions
    WHERE service_kind IS NOT NULL
    GROUP BY business_date HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'ROLLBACK REFUSED: a business date holds two services'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_financial_events
    WHERE type IN ('payment','payment_imported')
    GROUP BY order_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'ROLLBACK REFUSED: an order id holds two payments across services'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_financial_events
    WHERE type = 'refund' GROUP BY order_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'ROLLBACK REFUSED: an order id holds two refunds across services'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.archivio_conv GROUP BY wa_id, data_servizio HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'ROLLBACK REFUSED: a customer holds two archives on one date'; END IF;
END $$;

DROP FUNCTION IF EXISTS public.ensure_service_session(text,text,text);

-- Restore the original kind-less opener verbatim (2026-07-22 identity migration).
CREATE OR REPLACE FUNCTION public.open_service_session(p_opened_by text, p_source text DEFAULT 'backend')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  IF v_state.current_session_id IS NOT NULL OR EXISTS (SELECT 1 FROM public.service_sessions WHERE status IN ('open','closing')) THEN
    RETURN jsonb_build_object('ok',false,'code','ACTIVE_SERVICE_SESSION_EXISTS');
  END IF;
  INSERT INTO public.service_sessions(business_date,status,opened_by,open_source)
  VALUES ((clock_timestamp() AT TIME ZONE 'Europe/Madrid')::date,'open',p_opened_by,p_source) RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'opened',p_opened_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','OPENED','session',to_jsonb(v_session));
END $function$;

-- archivio_conv
DROP INDEX IF EXISTS public.archivio_conv_session_wa_uq;
DROP INDEX IF EXISTS public.archivio_conv_legacy_uq;
DROP INDEX IF EXISTS public.archivio_conv_service_session_idx;
CREATE UNIQUE INDEX archivio_conv_unique ON public.archivio_conv (wa_id, data_servizio);
ALTER TABLE public.archivio_conv DROP COLUMN IF EXISTS service_session_id;

-- financial identity
DROP INDEX IF EXISTS public.order_financial_events_one_payment_session_uq;
DROP INDEX IF EXISTS public.order_financial_events_one_payment_legacy_uq;
DROP INDEX IF EXISTS public.order_financial_events_one_refund_session_uq;
DROP INDEX IF EXISTS public.order_financial_events_one_refund_legacy_uq;
DROP INDEX IF EXISTS public.order_financial_events_scope_session_uq;
DROP INDEX IF EXISTS public.order_financial_events_scope_legacy_uq;
CREATE UNIQUE INDEX order_financial_events_one_payment_uq
  ON public.order_financial_events (order_id) WHERE type IN ('payment','payment_imported');
CREATE UNIQUE INDEX order_financial_events_one_refund_uq
  ON public.order_financial_events (order_id) WHERE type = 'refund';
ALTER TABLE public.order_financial_events
  ADD CONSTRAINT order_financial_events_scope_uq UNIQUE (order_id, type, idem_scope_key);

-- service identity
DROP INDEX IF EXISTS public.service_sessions_date_kind_uq;
ALTER TABLE public.serata_summary DROP CONSTRAINT IF EXISTS serata_summary_kind_chk;
ALTER TABLE public.serata_summary DROP COLUMN IF EXISTS service_kind;
ALTER TABLE public.service_sessions DROP CONSTRAINT IF EXISTS service_sessions_active_kind_chk;
ALTER TABLE public.service_sessions DROP CONSTRAINT IF EXISTS service_sessions_kind_chk;
ALTER TABLE public.service_sessions DROP COLUMN IF EXISTS service_kind;

COMMIT;
