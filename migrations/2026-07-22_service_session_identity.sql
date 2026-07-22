BEGIN;

CREATE TABLE public.service_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date date NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  status text NOT NULL CHECK (status IN ('open','closing','closed')),
  opened_by text NOT NULL,
  closed_by text,
  open_source text NOT NULL,
  close_source text,
  close_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

-- A constant-expression partial unique index makes split-brain open/closing
-- lifecycle state physically impossible, independently of application code.
CREATE UNIQUE INDEX service_sessions_single_active_uq
  ON public.service_sessions ((true)) WHERE status IN ('open','closing');

CREATE TABLE public.service_session_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  current_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  recent_closed_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.service_session_state(singleton) VALUES (true);

CREATE TABLE public.service_session_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_session_id uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('opened','closing','closed')),
  by_actor text NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ordenes ADD COLUMN service_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.storico ADD COLUMN service_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.serata_summary ADD COLUMN id uuid DEFAULT gen_random_uuid();
ALTER TABLE public.serata_summary ADD COLUMN service_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.order_financial_events ADD COLUMN service_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
-- Financial evidence must survive archival/deletion of the live order. Insert
-- validity is retained by the assignment trigger below; the immutable event keeps
-- both order_id and service_session_id as its historical snapshot.
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_order_id_fk;

ALTER TABLE public.serata_summary DROP CONSTRAINT serata_summary_pkey;
ALTER TABLE public.serata_summary ADD CONSTRAINT serata_summary_pkey PRIMARY KEY (id);
ALTER TABLE public.storico DROP CONSTRAINT storico_orden_id_fecha_key;
CREATE UNIQUE INDEX serata_summary_session_uq ON public.serata_summary(service_session_id) WHERE service_session_id IS NOT NULL;
CREATE UNIQUE INDEX storico_session_order_uq ON public.storico(service_session_id, orden_id) WHERE service_session_id IS NOT NULL;
CREATE INDEX ordenes_service_session_idx ON public.ordenes(service_session_id);
CREATE INDEX storico_service_session_idx ON public.storico(service_session_id);
CREATE INDEX financial_events_service_session_idx ON public.order_financial_events(service_session_id);

CREATE OR REPLACE FUNCTION public.service_session_assign_order()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;
  IF v_state.current_session_id IS NULL THEN RAISE EXCEPTION 'NO_OPEN_SERVICE_SESSION' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.current_session_id FOR SHARE;
  IF NOT FOUND OR v_session.status <> 'open' THEN RAISE EXCEPTION 'INVALID_OPEN_SERVICE_SESSION' USING ERRCODE='P0001'; END IF;
  IF NEW.service_session_id IS NOT NULL AND NEW.service_session_id <> v_session.id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_FORGERY' USING ERRCODE='P0001';
  END IF;
  NEW.service_session_id := v_session.id;
  RETURN NEW;
END $$;

CREATE TRIGGER ordenes_assign_service_session
BEFORE INSERT ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.service_session_assign_order();

CREATE OR REPLACE FUNCTION public.service_session_immutable_order()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.service_session_id IS DISTINCT FROM OLD.service_session_id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ordenes_service_session_immutable BEFORE UPDATE ON public.ordenes FOR EACH ROW EXECUTE FUNCTION public.service_session_immutable_order();

CREATE OR REPLACE FUNCTION public.service_session_validate_archive()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_session_id uuid;
BEGIN
  SELECT o.service_session_id INTO v_session_id FROM public.ordenes o WHERE o.id=NEW.orden_id;
  IF v_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001'; END IF;
  IF NEW.service_session_id IS NOT NULL AND NEW.service_session_id <> v_session_id THEN RAISE EXCEPTION 'ARCHIVE_SESSION_MISMATCH' USING ERRCODE='P0001'; END IF;
  NEW.service_session_id := v_session_id;
  RETURN NEW;
END $$;
CREATE TRIGGER storico_validate_service_session BEFORE INSERT ON public.storico FOR EACH ROW EXECUTE FUNCTION public.service_session_validate_archive();

CREATE OR REPLACE FUNCTION public.service_session_validate_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_session public.service_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_session FROM public.service_sessions WHERE id=NEW.service_session_id FOR SHARE;
  IF NOT FOUND OR v_session.status <> 'closing' OR v_session.business_date <> NEW.fecha THEN
    RAISE EXCEPTION 'SUMMARY_SESSION_MISMATCH' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER serata_summary_validate_service_session BEFORE INSERT OR UPDATE ON public.serata_summary FOR EACH ROW EXECUTE FUNCTION public.service_session_validate_summary();

CREATE OR REPLACE FUNCTION public.service_session_assign_financial_event()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
BEGIN
  SELECT o.service_session_id INTO NEW.service_session_id FROM public.ordenes o WHERE o.id=NEW.order_id;
  IF NEW.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_event_assign_service_session BEFORE INSERT ON public.order_financial_events FOR EACH ROW EXECUTE FUNCTION public.service_session_assign_financial_event();

CREATE OR REPLACE FUNCTION public.open_service_session(p_opened_by text, p_source text DEFAULT 'backend')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.begin_service_session_close(p_closed_by text, p_source text DEFAULT 'backend')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;
  IF v_state.current_session_id IS NULL THEN
    IF v_state.recent_closed_session_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NO_SERVICE_SESSION'); END IF;
    SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.recent_closed_session_id;
    IF NOT FOUND OR v_session.status <> 'closed' THEN RETURN jsonb_build_object('ok',false,'code','INVALID_RECENT_CLOSED_SESSION'); END IF;
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.current_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status NOT IN ('open','closing') THEN RETURN jsonb_build_object('ok',false,'code','INVALID_CURRENT_SERVICE_SESSION'); END IF;
  IF v_session.status='open' THEN
    UPDATE public.service_sessions SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
    INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closing',p_closed_by,p_source);
  END IF;
  RETURN jsonb_build_object('ok',true,'code','CLOSING','session',to_jsonb(v_session));
END $$;

CREATE OR REPLACE FUNCTION public.complete_service_session_close(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  SELECT * INTO v_session FROM public.service_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','SESSION_NOT_FOUND'); END IF;
  IF v_session.status='closed' AND v_state.recent_closed_session_id=v_session.id AND v_state.current_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  IF v_state.current_session_id IS DISTINCT FROM v_session.id OR v_session.status <> 'closing' THEN
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;
  UPDATE public.service_sessions SET status='closed',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closed',p_closed_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','CLOSED','session',to_jsonb(v_session));
END $$;

CREATE OR REPLACE FUNCTION public.get_current_service_closeout_session()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp STABLE AS $$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS'); END IF;
  IF v_state.current_session_id IS NOT NULL THEN SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.current_session_id;
  ELSIF v_state.recent_closed_session_id IS NOT NULL THEN SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.recent_closed_session_id;
  ELSE RETURN jsonb_build_object('ok',true,'code','NO_SERVICE_SESSION'); END IF;
  IF NOT FOUND OR (v_state.current_session_id IS NOT NULL AND v_session.status NOT IN ('open','closing')) OR
     (v_state.current_session_id IS NULL AND v_session.status <> 'closed') THEN RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_STATE_CORRUPT'); END IF;
  RETURN jsonb_build_object('ok',true,'code','OK','session',to_jsonb(v_session));
END $$;

ALTER TABLE public.service_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_session_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_session_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_sessions, public.service_session_state, public.service_session_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.service_sessions, public.service_session_state, public.service_session_audit TO service_role;
REVOKE ALL ON FUNCTION public.service_session_assign_order(), public.service_session_immutable_order(), public.service_session_validate_archive(), public.service_session_validate_summary(), public.service_session_assign_financial_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_service_session(text,text), public.begin_service_session_close(text,text), public.complete_service_session_close(uuid,text,text), public.get_current_service_closeout_session() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_service_session(text,text), public.begin_service_session_close(text,text), public.complete_service_session_close(uuid,text,text), public.get_current_service_closeout_session() TO service_role;

-- No backfill: pre-identity rows intentionally remain NULL and therefore legacy/unassigned.
COMMIT;
