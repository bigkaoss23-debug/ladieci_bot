-- migrations/2026-08-17_f1_canonical_pointer_clear_on_close.sql
-- F-1 — Finalizar servicio repair, slice 1 ONLY: clear the canonical Business
-- Day current-service pointer (business_day_lifecycle_state.current_period_id)
-- on a genuine successful session close, in BOTH close engines. Nothing else.
--
-- Authority: owner-frozen F-1 finding (this session, Finalizar architecture
-- challenge, confirmed independently by both a Sonnet and an Opus pass):
-- complete_service_session_close (legacy) and close_service_session_v3
-- (V3, currently unreachable in live code but audited/patched anyway per the
-- explicit F-1 brief) both correctly null service_session_state.current_
-- session_id on close, but NEITHER touches business_day_lifecycle_state.
-- current_period_id at all -- it stays stale-pointing at the just-closed
-- session until the next real order's resolve_order_intake_context_v1() call
-- happens to re-derive it. That is a real one-authority violation (a closed
-- session must never remain "current" under any name).
--
-- OWNERSHIP RULE (mandatory, per the task brief): the canonical pointer is
-- cleared ONLY when it already points at the exact session being closed (or
-- is already NULL -- the no-op case). If it points at ANY OTHER session, the
-- close is refused with a typed error and ZERO mutation happens -- proven by
-- placing the ownership check BEFORE every mutating statement in both
-- functions (mirroring the existing shadow-identity checks, which already
-- follow this same fail-closed-before-mutation discipline). This is a
-- structural guarantee, not a convention: business_day_lifecycle_state is
-- read FOR UPDATE (locked) in the SAME transaction as service_session_state
-- and service_sessions, under the SAME pre-existing advisory lock
-- (hashtext('service_session_lifecycle')), so no concurrent transaction can
-- change what "the other session" is between the check and the clear.
--
-- WHAT CHANGES, exactly, in each function:
--   1. business_day_lifecycle_state is read FOR UPDATE, once, AFTER the
--      existing shadow-identity check (SESSION_CLOSE_IDENTITY_MISMATCH /
--      CURRENT_SESSION_MISMATCH) and BEFORE any UPDATE/INSERT statement.
--   2. IF current_period_id IS NOT NULL AND IS DISTINCT FROM the session
--      being closed -> return {ok:false, code:'BUSINESS_DAY_POINTER_
--      OWNERSHIP_MISMATCH'} -- no mutation attempted, matching the existing
--      discriminated-result convention (RETURN, never RAISE EXCEPTION, for a
--      business-logic refusal -- RAISE EXCEPTION stays reserved for the
--      guard trigger's own genuine integrity class).
--   3. IF current_period_id = the session being closed -> AFTER the existing
--      service_sessions/service_session_state mutations, authorize via the
--      established set_config('ladieci.business_day_pointer_authorized',
--      'true', true) transaction-local mechanism (business_day_lifecycle_
--      state_guard_v1 already requires this for any change to current_
--      business_day_id/current_period_id/current_ticket_epoch) and clear
--      ONLY current_period_id -- a partial column UPDATE, so current_
--      business_day_id and current_ticket_epoch are structurally untouched
--      (the guard trigger only compares changed columns; unlisted columns
--      equal OLD by construction).
--   4. IF current_period_id IS already NULL -> no-op (already correct,
--      matching "or when the frozen idempotency/replay contract explicitly
--      permits current_period_id already NULL").
--
-- The two idempotent-replay early-return branches (ALREADY_CLOSED in both
-- functions) are left completely BYTE-IDENTICAL -- they return before ever
-- reaching the new logic, so a replay of an already-fully-processed close
-- (canonical pointer already NULL from the first, real call) is unaffected,
-- and no new self-healing/backfill semantic is introduced for historical
-- pre-F-1 closed sessions (none exist live today with this specific drift --
-- the one currently-closed-and-recent session on staging, c9d5aaa7-...,
-- predates the canonical pointer's own existence entirely, R-DAY0/R-DAY1).
--
-- recent_closed_business_day_id (business_day_lifecycle_state) is NOT
-- touched -- neither function ever wrote it before, and F-1 is scoped
-- strictly to the current-service pointer, not the Business Day seal (R-DAY5,
-- explicitly out of scope).
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=84, MAX(verified)=76 -- matches the exact
--     expected pre-state.
--   - Both functions share the IDENTICAL advisory lock name
--     (hashtext('service_session_lifecycle')) -- confirmed byte-for-byte
--     from their own live bodies, not assumed.
--   - business_day_lifecycle_state_guard_v1's exact authorization contract
--     confirmed from its own live body: raises BUSINESS_DAY_POINTER_
--     UNAUTHORIZED_MUTATION unless the GUC is exactly 'true' when
--     current_business_day_id/current_period_id/current_ticket_epoch changes.
--   - close_service_session_v3 has ZERO live callers today (serviceLifecycle
--     Engine.js, its only caller, is itself uncalled from any live entry
--     point) -- patched anyway per the explicit F-1 brief scope, with zero
--     product-visible effect until a later slice wires it.
--   - Live pointer state before this migration: current_business_day_id=
--     c8103dd5-..., current_period_id=5e5777c5-... (the real open session),
--     current_ticket_epoch=2, service_session_state.current_session_id=
--     5e5777c5-... (agrees), recent_closed_session_id=c9d5aaa7-... (an
--     unrelated, already-closed session from before the canonical pointer
--     existed).
BEGIN;

DO $$
DECLARE
  v_def_legacy text;
  v_def_v3 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-1 refused: staging sentinel migration absent -- wrong database?'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_legacy
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_service_session_close';
  IF v_def_legacy IS NULL THEN
    RAISE EXCEPTION 'F-1 refused: complete_service_session_close does not exist';
  END IF;
  -- Predecessor-body guard: the exact pre-F-1 body, byte-for-byte (the two
  -- consecutive UPDATE statements with nothing between them), must be
  -- present, or this migration refuses (already applied, drifted, or a
  -- different body than expected).
  IF position('UPDATE public.service_sessions SET status=''closed'',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.service_session_audit' IN v_def_legacy) = 0 THEN
    RAISE EXCEPTION 'F-1 refused: complete_service_session_close does not match the expected pre-F-1 body -- already patched or drifted, resolve first';
  END IF;
  IF position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_legacy) > 0 THEN
    RAISE EXCEPTION 'F-1 refused: complete_service_session_close already shows the post-F-1 ownership check -- already applied';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_v3
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='close_service_session_v3';
  IF v_def_v3 IS NULL THEN
    RAISE EXCEPTION 'F-1 refused: close_service_session_v3 does not exist';
  END IF;
  IF position('PERFORM set_config(''ladieci.v3_close_authorized_session_id'', v_session.id::text, true);' IN v_def_v3) = 0 THEN
    RAISE EXCEPTION 'F-1 refused: close_service_session_v3 does not match the expected pre-F-1 body -- already patched or drifted, resolve first';
  END IF;
  IF position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_v3) > 0 THEN
    RAISE EXCEPTION 'F-1 refused: close_service_session_v3 already shows the post-F-1 ownership check -- already applied';
  END IF;
END $$;

-- ── complete_service_session_close (legacy engine) ──────────────────────────
CREATE OR REPLACE FUNCTION public.complete_service_session_close(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend'::text, p_preserve_active_orders boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
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
  -- F-1: canonical Business Day pointer ownership, verified BEFORE any
  -- mutation below, mirroring the shadow-identity check just above. A
  -- pointer already NULL, or already pointing at THIS session, is lawful; a
  -- pointer pointing at a DIFFERENT session is refused outright, with zero
  -- mutation attempted -- no cross-session pointer clearing is possible.
  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton=true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;
  IF p_preserve_active_orders THEN
    PERFORM set_config('ladieci.incident_safe_close_session_id', v_session.id::text, true);
  END IF;
  UPDATE public.service_sessions SET status='closed',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  -- F-1: clear the canonical pointer ONLY when it demonstrably owned this
  -- session (proven above, still true here because both singleton rows have
  -- been FOR UPDATE-locked since before that check). current_business_day_id
  -- and current_ticket_epoch are never named in this UPDATE, so they cannot
  -- change -- the guard trigger only reacts to columns that actually differ.
  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id=NULL, updated_at=now() WHERE singleton=true;
  END IF;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closed',p_closed_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','CLOSED','session',to_jsonb(v_session));
END
$function$;

-- ── close_service_session_v3 (V3 engine, currently unreachable in live code) ─
CREATE OR REPLACE FUNCTION public.close_service_session_v3(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_state   public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_bd_state public.business_day_lifecycle_state%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  SELECT * INTO v_session FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  IF v_session.status = 'closed' THEN
    IF v_state.recent_closed_session_id = v_session.id AND v_state.current_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;

  IF v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SESSION_STATUS');
  END IF;

  IF v_state.current_session_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_MISMATCH');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE service_session_id = p_service_session_id
       AND closeout_correlation_id = p_closeout_correlation_id
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_NOT_FOUND');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
       AND status = 'active'
  ) THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  -- F-1: canonical Business Day pointer ownership, verified BEFORE any
  -- mutation, mirroring CURRENT_SESSION_MISMATCH above -- identical
  -- discipline and identical typed refusal code to the legacy engine.
  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;

  -- SLICE 3.2.1 — the trusted-transition marker. Transaction-local
  -- (is_local=true): reverted automatically at commit or rollback, never
  -- visible to any other transaction/request.
  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  -- F-1: same ownership-gated clear as the legacy engine above.
  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id = NULL, updated_at = now() WHERE singleton = true;
  END IF;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

-- Post-conditions.
DO $$
DECLARE
  v_def_legacy text;
  v_def_v3 text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def_legacy
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='complete_service_session_close';
  IF position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_legacy) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: complete_service_session_close missing the ownership check';
  END IF;
  IF position('UPDATE public.business_day_lifecycle_state SET current_period_id=NULL' IN v_def_legacy) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: complete_service_session_close missing the canonical pointer clear';
  END IF;
  -- The clear must never name current_business_day_id/current_ticket_epoch.
  IF position('current_period_id=NULL, updated_at=now() WHERE singleton=true' IN v_def_legacy) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: complete_service_session_close clear touches more than current_period_id';
  END IF;
  IF position('ALREADY_CLOSED' IN v_def_legacy) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: complete_service_session_close lost its idempotent-replay branch';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def_v3
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='close_service_session_v3';
  IF position('BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH' IN v_def_v3) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: close_service_session_v3 missing the ownership check';
  END IF;
  IF position('UPDATE public.business_day_lifecycle_state SET current_period_id = NULL' IN v_def_v3) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: close_service_session_v3 missing the canonical pointer clear';
  END IF;
  IF position('current_period_id = NULL, updated_at = now() WHERE singleton = true' IN v_def_v3) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: close_service_session_v3 clear touches more than current_period_id';
  END IF;
  IF position('CLOSEOUT_NOT_FOUND' IN v_def_v3) = 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: close_service_session_v3 lost its closeout-lineage check';
  END IF;

  -- Nothing else touched: live pointer/shadow/financial invariants unchanged
  -- by this migration itself (a CREATE OR REPLACE performs no data writes,
  -- asserted rather than assumed, matching established discipline).
  IF (SELECT current_business_day_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM 'c8103dd5-b335-4fa8-8ce5-89e95f26c619'::uuid
  THEN RAISE EXCEPTION 'F-1 post-condition failed: current_business_day_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-1 post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_ticket_epoch FROM public.business_day_lifecycle_state WHERE singleton=true) <> 2
  THEN RAISE EXCEPTION 'F-1 post-condition failed: current_ticket_epoch changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-1 post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.service_closeouts) <> 3 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: service_closeouts population changed -- must be exactly 3';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics='operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-1 post-condition failed: real operational_service_v1 rows must remain 0';
  END IF;
END $$;

COMMIT;
