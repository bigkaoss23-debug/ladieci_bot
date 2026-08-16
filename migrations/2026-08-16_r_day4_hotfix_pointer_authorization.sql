-- migrations/2026-08-16_r_day4_hotfix_pointer_authorization.sql
-- R-DAY4 HOTFIX — consolidate_period_v1()'s conditional ticket-epoch mirror
-- write to business_day_lifecycle_state omitted the GUC authorization every
-- OTHER writer of that table's three governed columns already sets.
--
-- ROOT CAUSE. business_day_lifecycle_state_guard_v1() (R-DAY1,
-- 2026-08-16_r_day1_business_day_authority_substrate.sql) rejects any write
-- to current_business_day_id/current_period_id/current_ticket_epoch unless
-- current_setting('ladieci.business_day_pointer_authorized', true) = 'true'
-- for that transaction. resolve_order_intake_context_v1() (R-DAY3) already
-- does this correctly: PERFORM set_config('ladieci.business_day_pointer_
-- authorized', 'true', true) immediately before its own UPDATE. R-DAY4's
-- consolidate_period_v1(), when p_reset_tickets=true and the target period's
-- business day happens to be the currently-pointed one, updates
-- business_day_lifecycle_state.current_ticket_epoch to mirror the new epoch
-- -- but never calls set_config first.
--
-- Reproduced live, for real, on staging (tdikhfeinufaahagmpjz), during this
-- slice's own acceptance testing (acceptance case C -- consolidate the
-- CURRENT period with p_reset_tickets=true), BEFORE authoring this fix:
--   SELECT consolidate_period_v1(..., true, 'rday4-accept-C-current-reset-1')
--   -> ERROR P0001: BUSINESS_DAY_POINTER_UNAUTHORIZED_MUTATION
--      (raised by business_day_lifecycle_state_guard_v1(), from inside
--       consolidate_period_v1's own UPDATE statement)
-- The whole transaction rolled back atomically -- zero residue: no
-- period_consolidations row, business_days.ticket_epoch and
-- business_day_lifecycle_state.current_ticket_epoch both unchanged,
-- reconfirmed live immediately after the failure.
--
-- BLAST RADIUS. Every reset_tickets=true consolidation of the CURRENT day's
-- period would hit this, unconditionally -- not a corner case. Consolidating
-- a NON-current period, or reset_tickets=false on any period, is unaffected
-- (neither path reaches this UPDATE): acceptance cases A, B, and D (already
-- proven live before this bug was found) are untouched by this fix.
--
-- FIX. Add the identical PERFORM set_config('ladieci.business_day_pointer_
-- authorized', 'true', true) call resolve_order_intake_context_v1 already
-- uses, immediately before the business_day_lifecycle_state UPDATE. No other
-- line of consolidate_period_v1 changes. Still does not touch
-- current_business_day_id or current_period_id -- only current_ticket_epoch,
-- exactly as before; the owner-corrected non-fusion contract (period
-- consolidation never advances the pointer/shadow/period status) is
-- unaffected by this fix, which only unblocks a write the function already
-- intended to make.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY4 hotfix refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix refused: consolidate_period_v1 does not exist -- R-DAY4 main migration not yet applied'; END IF;

  -- Reconfirm the exact defect still exists (fail closed rather than
  -- applying a fix for a problem already resolved a different way): the
  -- live function body must still lack the authorization call immediately
  -- before the business_day_lifecycle_state UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND p.prosrc LIKE '%IF p_reset_tickets THEN%UPDATE public.business_day_lifecycle_state%'
       AND p.prosrc NOT LIKE '%set_config(%ladieci.business_day_pointer_authorized%''true''%'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix refused: consolidate_period_v1 body does not match the expected pre-hotfix (missing-authorization) shape -- already patched or drifted, resolve first'; END IF;
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

    -- HOTFIX: business_day_lifecycle_state_guard_v1() rejects any write to
    -- its three governed columns unless this transaction-local GUC is set
    -- first -- identical to resolve_order_intake_context_v1's own usage.
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
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

-- Post-condition: structural only. Deliberately does NOT call the real RPC
-- with p_reset_tickets=true here -- doing so would perform a genuine,
-- uncontrolled ticket-epoch advance on whatever the current day happens to
-- be at apply time. The real live proof (acceptance case C, replayed) runs
-- as its own separate, deliberate step immediately after apply.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND p.prosrc LIKE '%set_config(%ladieci.business_day_pointer_authorized%''true''%'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix post-condition failed: authorization call not found in the corrected function body'; END IF;

  -- The authorization call must appear BEFORE the UPDATE it protects.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND p.prosrc LIKE '%set_config(%ladieci.business_day_pointer_authorized%''true''%UPDATE public.business_day_lifecycle_state%'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix post-condition failed: authorization call is not positioned immediately before the guarded UPDATE'; END IF;

  -- Still never ASSIGNS current_business_day_id/current_period_id (a WHERE-
  -- clause READ comparison against current_business_day_id is expected and
  -- correct -- the epoch-mirror guard this hotfix itself adds -- so this
  -- checks for SET assignment specifically, not bare substring presence).
  -- The owner-corrected non-fusion contract survives this fix unconditionally.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND (p.prosrc LIKE '%SET current_period_id%' OR p.prosrc LIKE '%SET current_business_day_id%'
         OR p.prosrc LIKE '%current_session_id =%' OR p.prosrc LIKE '%SET status%')
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix post-condition failed: consolidate_period_v1 appears to write the pointer/shadow/period-status beyond the epoch mirror -- violates the frozen non-fusion contract'; END IF;

  -- period_consolidations DDL/trigger/grants are untouched by this migration.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname='period_consolidations' AND t.tgname='period_consolidations_append_only_v1' AND t.tgenabled='O'
  ) THEN RAISE EXCEPTION 'R-DAY4 hotfix post-condition failed: period_consolidations append-only trigger missing or disabled'; END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY4 hotfix post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
END $$;

COMMIT;
