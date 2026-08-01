-- Guarded rollback for V3-H Mesa foundation. STAGING ONLY.
-- Refuses once any operational Mesa evidence exists; financial history is never erased.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.restaurant_tables') IS NULL
     OR to_regclass('public.payment_transactions') IS NULL
  THEN RAISE EXCEPTION 'V3-H rollback refused: forward objects missing'; END IF;

  IF EXISTS (SELECT 1 FROM public.table_sessions)
     OR EXISTS (SELECT 1 FROM public.table_order_lines)
     OR EXISTS (SELECT 1 FROM public.payment_transactions)
     OR EXISTS (SELECT 1 FROM public.payment_allocations)
     OR EXISTS (SELECT 1 FROM public.order_financial_events WHERE payment_transaction_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'V3-H rollback refused: Mesa operational or financial evidence exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.order_financial_events
     WHERE by_actor NOT IN ('owner','operator_primary','operator_backup','rider')
        OR by_role NOT IN ('admin','operator','rider')
  ) THEN
    RAISE EXCEPTION 'V3-H rollback refused: dynamic actor financial evidence exists';
  END IF;
END $$;

DROP TRIGGER IF EXISTS messa_prepare_table_order_v1 ON public.ordenes;
DROP TRIGGER IF EXISTS messa_snapshot_order_lines_v1 ON public.ordenes;
DROP TRIGGER IF EXISTS table_order_lines_append_only_v1 ON public.table_order_lines;
DROP TRIGGER IF EXISTS payment_transactions_append_only_v1 ON public.payment_transactions;
DROP TRIGGER IF EXISTS payment_allocations_append_only_v1 ON public.payment_allocations;

DROP FUNCTION IF EXISTS public.messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb);
DROP FUNCTION IF EXISTS public.messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean);
DROP FUNCTION IF EXISTS public.messa_open_session_v1(uuid,text,uuid,uuid,integer);
DROP FUNCTION IF EXISTS public.messa_snapshot_order_lines_v1();
DROP FUNCTION IF EXISTS public.messa_prepare_table_order_v1();
DROP FUNCTION IF EXISTS public.messa_append_only_v1();

ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_pay_state_transition_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_prev_pay_state_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_new_pay_state_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_by_actor_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_by_role_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_actor_role_map_chk;

ALTER TABLE public.order_financial_events
  ADD CONSTRAINT ofe_prev_pay_state_chk CHECK (prev_pay_state IN ('unpaid','paid','refunded')),
  ADD CONSTRAINT ofe_new_pay_state_chk CHECK (new_pay_state IN ('unpaid','paid','refunded')),
  ADD CONSTRAINT ofe_pay_state_transition_chk CHECK (
    (type='payment' AND prev_pay_state='unpaid' AND new_pay_state='paid')
    OR (type='payment_imported' AND prev_pay_state='unpaid' AND new_pay_state='paid')
    OR (type='refund' AND prev_pay_state='paid' AND new_pay_state='refunded')
    OR (type='void' AND prev_pay_state=new_pay_state)
  ),
  ADD CONSTRAINT ofe_by_actor_chk CHECK (
    by_actor IN ('owner','operator_primary','operator_backup','rider')
  ),
  ADD CONSTRAINT ofe_by_role_chk CHECK (by_role IN ('admin','operator','rider')),
  ADD CONSTRAINT ofe_actor_role_map_chk CHECK (
    (by_actor='owner' AND by_role='admin')
    OR (by_actor='operator_primary' AND by_role='operator')
    OR (by_actor='operator_backup' AND by_role='operator')
    OR (by_actor='rider' AND by_role='rider')
  );

DROP INDEX public.order_financial_events_one_payment_session_uq;
DROP INDEX public.order_financial_events_one_payment_legacy_uq;
ALTER TABLE public.order_financial_events DROP COLUMN payment_transaction_id;
CREATE UNIQUE INDEX order_financial_events_one_payment_session_uq
  ON public.order_financial_events(service_session_id, order_id)
  WHERE service_session_id IS NOT NULL AND type IN ('payment','payment_imported');
CREATE UNIQUE INDEX order_financial_events_one_payment_legacy_uq
  ON public.order_financial_events(order_id)
  WHERE service_session_id IS NULL AND type IN ('payment','payment_imported');

DROP TABLE public.payment_allocations;
DROP TABLE public.payment_transactions;
DROP TABLE public.table_order_lines;

DROP INDEX IF EXISTS public.ordenes_table_command_uq;
DROP INDEX IF EXISTS public.storico_table_command_uq;
DROP INDEX IF EXISTS public.ordenes_table_session_idx;
DROP INDEX IF EXISTS public.storico_table_session_idx;
ALTER TABLE public.ordenes DROP CONSTRAINT ordenes_table_fields_chk;
ALTER TABLE public.storico DROP CONSTRAINT storico_table_fields_chk;
ALTER TABLE public.ordenes
  DROP COLUMN table_command_number,
  DROP COLUMN table_name_snapshot,
  DROP COLUMN table_number_snapshot,
  DROP COLUMN table_session_id;
ALTER TABLE public.storico
  DROP COLUMN table_command_number,
  DROP COLUMN table_name_snapshot,
  DROP COLUMN table_number_snapshot,
  DROP COLUMN table_session_id;

DROP INDEX IF EXISTS public.table_sessions_one_open_per_table_uq;
DROP INDEX IF EXISTS public.table_sessions_service_idx;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_lifecycle_chk;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_status_chk;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_covers_total_chk;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_next_command_number_chk;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_table_id_fkey;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_service_session_id_fkey;
ALTER TABLE public.table_sessions
  DROP COLUMN settled_at,
  DROP COLUMN next_command_number,
  DROP COLUMN covers_total,
  DROP COLUMN service_session_id,
  DROP COLUMN table_id;
ALTER TABLE public.table_sessions
  ADD CONSTRAINT table_sessions_status_check CHECK (status IN ('open','closed')),
  ADD CONSTRAINT table_sessions_closed_at_chk CHECK ((status='closed')=(closed_at IS NOT NULL));

DROP TABLE public.restaurant_tables;

-- Restore the exact pre-V3-H service-close lifecycle body (2026-07-22).
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

COMMIT;
