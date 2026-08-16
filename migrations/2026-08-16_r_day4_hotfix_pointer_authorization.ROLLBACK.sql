-- migrations/2026-08-16_r_day4_hotfix_pointer_authorization.ROLLBACK.sql
-- Restores the exact byte-captured pre-hotfix (buggy) body of
-- consolidate_period_v1 -- only ever use together with the R-DAY4 main
-- migration's own full rollback, never in isolation (matching the R-DAY3
-- hotfix rollback's own documented convention). Reintroduces the missing-
-- authorization defect this hotfix fixed: any reset_tickets=true
-- consolidation of the CURRENT day's period will again raise
-- BUSINESS_DAY_POINTER_UNAUTHORIZED_MUTATION. Does not touch
-- period_consolidations data, grants, or any other object.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix rollback refused: consolidate_period_v1 does not exist'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.consolidate_period_v1(
  p_workspace_id      uuid,
  p_period_id         uuid,
  p_by_actor          text,
  p_by_role           text,
  p_by_sid_hash       text,
  p_reset_tickets     boolean,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing     public.period_consolidations%ROWTYPE;
  v_period       public.service_sessions%ROWTYPE;
  v_day          public.business_days%ROWTYPE;
  v_cutoff       timestamptz;
  v_correlation  uuid;
  v_payload      jsonb;
  v_capture      jsonb;
  v_snapshot_id  uuid;
  v_new_epoch    integer;
  v_row          public.period_consolidations%ROWTYPE;
BEGIN
  IF p_period_id IS NULL THEN RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS'); END IF;
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR'); END IF;
  IF p_by_role IS NULL OR btrim(p_by_role) = '' THEN RETURN jsonb_build_object('ok',false,'code','INVALID_ROLE'); END IF;
  IF p_client_request_id IS NULL OR btrim(p_client_request_id) = '' THEN RETURN jsonb_build_object('ok',false,'code','INVALID_CLIENT_REQUEST_ID'); END IF;
  IF p_reset_tickets IS NULL THEN RETURN jsonb_build_object('ok',false,'code','INVALID_RESET_FLAG'); END IF;

  IF p_workspace_id IS DISTINCT FROM public.mesa_singleton_workspace_v1() THEN
    RETURN jsonb_build_object('ok',false,'code','WORKSPACE_MISMATCH');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_existing FROM public.period_consolidations
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'code', 'ALREADY_CONSOLIDATED', 'idempotent', true,
      'consolidationId', v_existing.id, 'periodId', v_existing.period_id,
      'businessDayId', v_existing.business_day_id, 'cutoffAt', v_existing.cutoff_at,
      'resetTicketSequence', v_existing.reset_ticket_sequence,
      'newTicketEpoch', v_existing.new_ticket_epoch, 'snapshotId', v_existing.snapshot_id
    );
  END IF;

  SELECT * INTO v_period FROM public.service_sessions WHERE id = p_period_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_PERIOD_NOT_FOUND');
  END IF;
  IF v_period.business_day_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_PERIOD_LINEAGE_INVALID');
  END IF;
  SELECT * INTO v_day FROM public.business_days WHERE id = v_period.business_day_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_LINEAGE_INVALID');
  END IF;

  v_cutoff := clock_timestamp();

  IF EXISTS (
    SELECT 1 FROM public.period_consolidations
     WHERE business_day_id = v_period.business_day_id AND cutoff_at > v_cutoff
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CONSOLIDATION_CUTOFF_NOT_MONOTONIC');
  END IF;

  v_correlation := gen_random_uuid();
  SELECT jsonb_build_object(
    'session', to_jsonb(v_period),
    'orders', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM public.ordenes o WHERE o.service_session_id = p_period_id), '[]'::jsonb),
    'tableSessions', COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.table_sessions t WHERE t.service_session_id = p_period_id), '[]'::jsonb),
    'financialEvents', COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM public.order_financial_events f WHERE f.event_service_session_id = p_period_id), '[]'::jsonb)
  ) INTO v_payload;

  v_capture := public.capture_closeout_snapshot(
    p_period_id, v_correlation, p_by_actor, 'consolidate_period_v1', v_payload
  );
  IF (v_capture->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok',false,'code','CONSOLIDATION_SNAPSHOT_FAILED','detail',v_capture);
  END IF;
  v_snapshot_id := ((v_capture->'snapshot')->>'id')::uuid;
  IF v_snapshot_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','CONSOLIDATION_SNAPSHOT_ID_MISSING','detail',v_capture);
  END IF;

  v_new_epoch := NULL;
  IF p_reset_tickets THEN
    UPDATE public.business_days
       SET ticket_epoch = ticket_epoch + 1, next_ticket_number = 1
     WHERE id = v_period.business_day_id
     RETURNING ticket_epoch INTO v_new_epoch;

    UPDATE public.business_day_lifecycle_state
       SET current_ticket_epoch = v_new_epoch, updated_at = now()
     WHERE singleton = true AND current_business_day_id = v_period.business_day_id;
  END IF;

  INSERT INTO public.period_consolidations
    (workspace_id, business_day_id, period_id, cutoff_at, reset_ticket_sequence,
     new_ticket_epoch, snapshot_id, by_actor, by_role, by_sid_hash, client_request_id)
  VALUES
    (p_workspace_id, v_period.business_day_id, p_period_id, v_cutoff, p_reset_tickets,
     v_new_epoch, v_snapshot_id, p_by_actor, p_by_role, p_by_sid_hash, p_client_request_id)
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true, 'code', 'CONSOLIDATED', 'idempotent', false,
    'consolidationId', v_row.id, 'periodId', v_row.period_id,
    'businessDayId', v_row.business_day_id, 'cutoffAt', v_row.cutoff_at,
    'resetTicketSequence', v_row.reset_ticket_sequence,
    'newTicketEpoch', v_row.new_ticket_epoch, 'snapshotId', v_row.snapshot_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.consolidate_period_v1(uuid,uuid,text,text,text,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consolidate_period_v1(uuid,uuid,text,text,text,boolean,text) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND p.prosrc LIKE '%IF p_reset_tickets THEN%UPDATE public.business_day_lifecycle_state%'
       AND p.prosrc NOT LIKE '%set_config(%ladieci.business_day_pointer_authorized%''true''%'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix rollback post-condition failed: pre-hotfix (buggy) body not restored exactly'; END IF;
END $$;

COMMIT;
