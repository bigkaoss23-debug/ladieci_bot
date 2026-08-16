-- migrations/2026-08-16_r_day4_period_consolidation.sql
-- R-DAY4 — Service Period consolidation: an explicit, immutable, append-only
-- economic checkpoint, structurally independent of Service Period currency.
--
-- Authority: BUSINESS_DAY_R_DAY_IMPLEMENTATION_PLAN_V1_2026-08-16.md (R-DAY0,
-- frozen) §9 (exact DDL/RPC contract), §6 (the ONE lock), §13 (checkpoint is
-- evidence, never the recalculation authority), STOP condition 2 (§20:
-- consolidation must never block/delay/reject order intake, directly or
-- indirectly) and the FINAL REPORT's own explicit line: "the two [period
-- ASSIGNMENT via resolveEconomicPeriod() and period CONSOLIDATION via this
-- migration] are structurally incapable of being fused."
--
-- OWNER CORRECTION (2026-08-16, this session): an earlier R-DAY4 execution
-- brief assumed consolidating the CURRENT period must create/select a
-- successor period and advance business_day_lifecycle_state.current_period_id
-- / service_session_state.current_session_id. That assumption contradicts
-- R-DAY0 §9 step 7 verbatim ("Nothing else. No table is touched. No order is
-- touched. No payment is touched.") and was corrected by the owner before any
-- code was written: consolidate_period_v1() NEVER touches the pointer, the
-- legacy shadow, or service_sessions.status, on the current period or any
-- other. A period may be consolidated while still current; later orders may
-- still be attributed to it via the unchanged, unaffected
-- resolveEconomicPeriod() -- exactly per §9/§13/the FINAL REPORT.
--
-- WHAT THIS MIGRATION DOES, exactly, and nothing else:
--  1. CREATE TABLE public.period_consolidations -- R-DAY0 §9's exact DDL,
--     append-only (reuses the existing generic public.mesa_append_only_v1()
--     trigger function, unchanged, same discipline as order_entities).
--  2. CREATE FUNCTION public.consolidate_period_v1(...) -- the literal 7-step
--     R-DAY0 §9 body: acquire the EXISTING service_session_lifecycle lock
--     (§6, name unchanged, shared with resolve_order_intake_context_v1) ->
--     idempotency check on (workspace_id, client_request_id) -> server-
--     assigned cutoff_at := clock_timestamp() (never a parameter -- STOP
--     condition 3) -> capture the checkpoint via the EXISTING, unchanged
--     public.capture_closeout_snapshot() RPC (2026-08-08_service_closeout_
--     incidents_foundation.sql), scoped to this one period -> insert one
--     period_consolidations row -> IF explicitly requested, advance
--     business_days.ticket_epoch/reset next_ticket_number atomically in the
--     SAME transaction, mirroring business_day_lifecycle_state.
--     current_ticket_epoch only when this period's business day happens to
--     be the currently-pointed one. Nothing else.
--
-- Workspace resolution is fail-closed via the EXISTING, unchanged
-- public.mesa_singleton_workspace_v1() (2026-08-16_r_day2_permanent_order_
-- identity.sql) -- the caller-supplied p_workspace_id is verified against it,
-- never trusted blindly, matching the same discipline order_entity_anchor_v1
-- already uses for non-table orders.
--
-- Checkpoint payload reuses the EXACT existing shape already captured by the
-- one live, reachable economic-boundary caller of capture_closeout_snapshot
-- (src/serviceSessions/economicBoundaryEngine.js: {session, orders,
-- tableSessions, financialEvents}, filtered by service_session_id = the
-- period), not a new invention. Known limitation, carried forward unchanged
-- from R-DAY0 §14: non-Mesa product-line facts inside `orders[].items` are
-- not yet canonical government-grade truth pending R-DAY7's all-channel line
-- ledger; this snapshot captures exactly what is canonically available today,
-- same as every other closeout snapshot already in production.
--
-- Monotonicity (R-DAY0 §9): enforced procedurally inside consolidate_period_v1
-- itself (the sole sanctioned writer) rather than as a DB CHECK constraint,
-- because Postgres CHECK constraints cannot reference other rows. cutoff_at
-- is clock_timestamp() under the shared lock, so in ordinary operation this
-- can never actually fire (real time only moves forward); the guard exists as
-- defense-in-depth, not because a real ordering violation is reachable.
-- business_days.sealed_at does not exist yet (R-DAY5 not started) so that
-- half of §9's monotonicity clause is not yet expressible and is not added
-- here -- R-DAY5's own migration will extend this guard when the column
-- exists, not before.
--
-- DETERMINISTIC PRIVILEGE FLOOR (same defect class as Slice 1.3, service_
-- closeout_snapshots): this project's ALTER DEFAULT PRIVILEGES rule grants
-- service_role ALL privileges (including DELETE/TRUNCATE) at CREATE TABLE
-- time, independent of anything else. REVOKE ALL FROM service_role FIRST,
-- then grant back only SELECT, INSERT -- the only privileges
-- consolidate_period_v1's body actually uses. No RPC ever UPDATEs or DELETEs
-- a period_consolidations row.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY4 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='business_day_lifecycle_state'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: business_day_lifecycle_state does not exist -- R-DAY1 not yet applied'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: resolve_order_intake_context_v1 does not exist -- R-DAY3 not yet applied'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='capture_closeout_snapshot'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: capture_closeout_snapshot does not exist -- S-slice closeout foundation missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='mesa_singleton_workspace_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: mesa_singleton_workspace_v1 does not exist -- R-DAY2 not yet applied'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='mesa_append_only_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: mesa_append_only_v1 does not exist'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='period_consolidations'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: period_consolidations already exists -- already applied or drifted, resolve first'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
  ) THEN RAISE EXCEPTION 'R-DAY4 refused: consolidate_period_v1 already exists -- already applied or drifted, resolve first'; END IF;
END $$;

-- ── STEP 1 — the immutable consolidation fact (R-DAY0 §9 exact DDL) ────────
CREATE TABLE public.period_consolidations (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid        NOT NULL REFERENCES public.workspaces(id),
  business_day_id           uuid        NOT NULL REFERENCES public.business_days(id),
  period_id                 uuid        NOT NULL REFERENCES public.service_sessions(id),
  cutoff_at                 timestamptz NOT NULL,
  reset_ticket_sequence     boolean     NOT NULL,
  new_ticket_epoch          integer         NULL,
  snapshot_id               uuid        NOT NULL REFERENCES public.service_closeout_snapshots(id),
  by_actor                  text        NOT NULL,
  by_role                   text        NOT NULL,
  by_sid_hash               text        NOT NULL,
  client_request_id         text        NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_consolidations_idempotency_uq UNIQUE (workspace_id, client_request_id),
  CONSTRAINT period_consolidations_reset_epoch_chk
    CHECK ((reset_ticket_sequence = true AND new_ticket_epoch IS NOT NULL)
        OR (reset_ticket_sequence = false AND new_ticket_epoch IS NULL))
);
CREATE INDEX period_consolidations_period_idx ON public.period_consolidations (period_id);
CREATE INDEX period_consolidations_business_day_idx ON public.period_consolidations (business_day_id, cutoff_at);

CREATE TRIGGER period_consolidations_append_only_v1
  BEFORE UPDATE OR DELETE ON public.period_consolidations
  FOR EACH ROW EXECUTE FUNCTION public.mesa_append_only_v1();

-- ── STEP 2 — access control (same deterministic-privilege-floor discipline
-- as service_closeout_snapshots, Slice 1.3) ────────────────────────────────
ALTER TABLE public.period_consolidations ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypass.
REVOKE ALL ON public.period_consolidations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.period_consolidations TO service_role;

-- ── STEP 3 — consolidate_period_v1(): the literal R-DAY0 §9 seven-step body ─
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

  -- Fail-closed workspace resolution, same discipline as order_entity_anchor_v1
  -- for non-table orders. Never trusts the caller's p_workspace_id blindly.
  IF p_workspace_id IS DISTINCT FROM public.mesa_singleton_workspace_v1() THEN
    RETURN jsonb_build_object('ok',false,'code','WORKSPACE_MISMATCH');
  END IF;

  -- R-DAY0 §9 step 1 / §6: the ONE lock, name unchanged, shared with the
  -- intake resolver -- this is the sole source of atomicity/serialization.
  -- It does NOT make consolidation an intake gate (STOP condition 2): it
  -- only means a concurrent order and a concurrent consolidation serialize
  -- against each other for the duration of whichever transaction got there
  -- first, exactly like any other write under this lock already does.
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  -- R-DAY0 §9 step 2: idempotency check. A replay of the SAME
  -- (workspace_id, client_request_id) returns the existing row verbatim --
  -- no new snapshot, no new ticket-epoch advance, ever.
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

  -- R-DAY0 §9 step 3 / STOP condition 3: server-assigned, inside the lock,
  -- never a parameter. There is no p_cutoff_at anywhere in this signature.
  v_cutoff := clock_timestamp();

  -- Monotonicity (§9), procedural (see migration header for why not a CHECK).
  IF EXISTS (
    SELECT 1 FROM public.period_consolidations
     WHERE business_day_id = v_period.business_day_id AND cutoff_at > v_cutoff
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CONSOLIDATION_CUTOFF_NOT_MONOTONIC');
  END IF;

  -- R-DAY0 §9 step 4: capture the checkpoint via the EXISTING, unchanged
  -- capture_closeout_snapshot() mechanism, scoped to this one period. Payload
  -- shape mirrors the one live reachable caller (economicBoundaryEngine.js)
  -- exactly: {session, orders, tableSessions, financialEvents}. Naturally
  -- cutoff-bounded: this SELECT executes at v_cutoff (now, inside this same
  -- transaction), so it can only see facts that existed at or before cutoff --
  -- nothing committed after this transaction can be visible here.
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

  -- R-DAY0 §9 step 6: optional, explicit, atomic ticket-epoch advance --
  -- same transaction, same lock, retry-safe by construction (a retry never
  -- reaches this far -- it returns at the idempotency check above). Mirrors
  -- business_day_lifecycle_state.current_ticket_epoch ONLY when this
  -- period's business day happens to be the currently-pointed one; a
  -- consolidation of a past day's period never touches the live pointer.
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

  -- R-DAY0 §9 step 5: insert one immutable fact. Step 7: nothing else --
  -- no table/order/payment touched, no pointer, no shadow, no period status.
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

-- ── Post-conditions ──────────────────────────────────────────────────────
DO $$
DECLARE v_ptr record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='period_consolidations'
  ) THEN RAISE EXCEPTION 'R-DAY4 post-condition failed: period_consolidations was not created'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname='period_consolidations' AND t.tgname='period_consolidations_append_only_v1' AND t.tgenabled='O'
  ) THEN RAISE EXCEPTION 'R-DAY4 post-condition failed: append-only trigger missing or disabled'; END IF;

  IF (SELECT relrowsecurity FROM pg_class WHERE relname='period_consolidations' AND relnamespace='public'::regnamespace) IS NOT TRUE THEN
    RAISE EXCEPTION 'R-DAY4 post-condition failed: RLS not enabled on period_consolidations';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND p.prosrc LIKE '%pg_advisory_xact_lock(hashtext(%service_session_lifecycle%))%'
  ) THEN RAISE EXCEPTION 'R-DAY4 post-condition failed: consolidate_period_v1 does not acquire the shared lifecycle lock'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='consolidate_period_v1'
       AND (p.prosrc LIKE '%current_period_id =%' OR p.prosrc LIKE '%current_session_id =%'
         OR p.prosrc LIKE '%SET status%')
  ) THEN RAISE EXCEPTION 'R-DAY4 post-condition failed: consolidate_period_v1 appears to write the pointer, shadow, or period status -- violates the frozen non-fusion contract'; END IF;

  -- This migration must not itself mutate any existing operational/financial
  -- state, nor the live pointer. Zero orders/payments touched, per §9 step 7.
  SELECT current_business_day_id, current_period_id, current_ticket_epoch
    INTO v_ptr FROM public.business_day_lifecycle_state WHERE singleton = true;
  IF v_ptr.current_business_day_id IS DISTINCT FROM 'c8103dd5-b335-4fa8-8ce5-89e95f26c619'::uuid
     OR v_ptr.current_period_id IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
     OR v_ptr.current_ticket_epoch IS DISTINCT FROM 1
  THEN RAISE EXCEPTION 'R-DAY4 post-condition failed: canonical pointer changed unexpectedly by this migration'; END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY4 post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.period_consolidations) <> 0 THEN
    RAISE EXCEPTION 'R-DAY4 post-condition failed: this migration must create the table empty, never seed a row';
  END IF;
END $$;

COMMIT;
