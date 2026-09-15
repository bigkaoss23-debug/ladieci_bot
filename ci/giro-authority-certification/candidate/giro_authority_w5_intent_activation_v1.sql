-- W5 INTENT ACTIVATION V1 -- CANDIDATE for migration 132. Applies ON TOP of the
-- already-applied migrations 130 (giro_authority_v1) and 131 (W5 Packet 01).
-- Certified only on ephemeral PostgreSQL (ci/giro-authority-certification/harness).
-- Never applied to staging/production by this session. Producer activation
-- language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
-- (agentOrdini.js pendingGiroIntent) and the reconciler/hook JS all stay
-- feature-branch-only until Phase 2 -- this migration is Phase 1 only.
--
-- WHAT IT ADDS
--   1. ordenes_zz_giro_intent_capture_v1 -- installs the already-certified W5
--      capture trigger verbatim from candidate/giro_intent_capture_trigger_v1.
--      W5_DORMANT.sql (guards, WHEN clause, trigger-ordering post-condition all
--      unchanged). Stays a structural no-op today: the real INSERT boundary
--      language-guard: allow-legacy agentOrdini.js/creaOrdine are the existing file/function names being cited, not new vocabulary
--      (src/agents/agentOrdini.js creaOrdine) still hard-forces
--      pendingGiroIntent = null, so NEW.pending_giro_intent is never non-NULL
--      until the Phase 2 JS deploy flips that one line.
--   2. CREATE OR REPLACE public.giro_authority_consume_intent_v1(...) -- adds
--      exactly two PERFORM giro_authority.bump_facts_signal_v1() calls, each
--      immediately before its corresponding CONSUMED success RETURN (GIRO
--      ATTACHED branch, ANCHOR GIRO_CREATED branch) -- matching the exact
--      placement already proven live in giro_authority_create_or_move_v1 and
--      giro_authority_attach_or_move_v1 (migration 131). The already-member
--      idempotent-replay branch, and every REJECTED/EXPIRED/NO_INTENT/
--      NOT_YET_OPERATIVE/terminal-replay branch, are untouched and never reach
--      a bump call -- signal delta stays exactly 0 for all of them. Every other
--      line of the function body is byte-for-byte identical to the live
--      migration-130 definition.
--   3. public.giro_authority_list_pending_intents_v1(p_operational_session_ids,
--      p_limit) -- NEW, read-only, service_role-only helper. giro_authority is
--      not PostgREST-exposed, so this is the only way the backend reconciler
--      (Phase 2 JS, not part of this migration) can discover bounded PENDING
--      candidates without querying the private schema directly. Bounded to:
--      status = PENDING, order's service_session_id = ANY(the caller's own
--      current operational session ids), order's estado IN (EN_COCINA, LISTO).
--      p_limit is clamped server-side to [1, 200]; returns order_uid only --
--      no Giro business truth. The consume RPC remains the sole authority; this
--      helper only points at candidates.
--   4. CREATE OR REPLACE public.close_service_session_v3(...) -- adds one
--      best-effort sweep step, inside the same transaction, immediately before
--      the function's own final 'V3_CLOSED' RETURN: for every order in the
--      just-closed session still carrying a PENDING giro intent, call
--      giro_authority_consume_intent_v1 with a scope that deliberately excludes
--      every real session (a nil-UUID sentinel), which -- per consume's own
--      existing, already-certified session-membership check -- deterministically
--      resolves every one of them to EXPIRED/SERVICE_CLOSED, never CONSUMED,
--      regardless of the order's own estado (verified against the live body:
--      that check runs before the estado/eligibility branches). Wrapped in its
--      own BEGIN/EXCEPTION so a sweep failure can never block or roll back the
--      close itself -- the close's own writes (service_sessions, service_
--      session_state, business_day_lifecycle_state, service_session_audit) are
--      all still byte-identical and still happen first, exactly as today.
--      language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this correction discusses, not new vocabulary
--      CORRECTION TO THE PRIOR DESIGN AUDIT: that audit assumed CHIUSO_FORZATO
--      was still an active write bypassing cambiaStato(). It is not -- migration
--      2026-08-23_n1_mesa_force_close_estado_write_removal retired that write
--      entirely; a Mesa force-close no longer changes any order's estado. The
--      real reason a close-time sweep is still required is different and still
--      valid: once a session leaves 'open'/'closing', getOperationalSessionIds()
--      excludes it forever, so nothing else (not the Cocina-poll reconciler, not
--      any cambiaStato hook) will ever call consume for its orders again. This
--      sweep is the only backstop for that specific, still-real window.
--
-- WHAT IT NEVER DOES
--   Does not modify giro_authority_create_v1, giro_authority_attach_v1,
--   giro_authority_move_v1, giro_authority_detach_v1, giro_authority_dissolve_v1,
--   giro_authority_set_hora_ref_v1, giro_authority_create_or_move_v1,
--   giro_authority_attach_or_move_v1, giro_authority.bump_facts_signal_v1, or
--   giro_authority.capture_giro_intent_v1 -- all stay byte-identical (checksummed
--   before/after below). Writes no new column, table or constraint. Grants no
--   new privilege to anon/authenticated/PUBLIC. Does not flip the producer and
--   does not wire any JS caller -- those are Phase 2, outside this migration.

BEGIN;

-- 0. Predecessor, drift and idempotency preconditions ------------------------------------
DO $$
BEGIN
  IF to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])') IS NULL
     OR to_regprocedure('giro_authority.bump_facts_signal_v1()') IS NULL
     OR to_regprocedure('giro_authority.capture_giro_intent_v1()') IS NULL
     OR to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION refused: a migration-130/131 entry point or close_service_session_v3 is missing -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                AND tgname = 'ordenes_zz_giro_intent_capture_v1') THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION refused: the capture trigger already exists';
  END IF;
  IF to_regprocedure('public.giro_authority_list_pending_intents_v1(uuid[],integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION refused: already applied -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
       AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
       AND t.tgname > 'ordenes_zz_giro_intent_capture_v1'::name) > 0 THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION refused: a BEFORE INSERT trigger would fire after the capture';
  END IF;
  IF pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure) ILIKE '%bump_facts_signal_v1%' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION refused: consume_intent_v1 already bumps the signal -- resolve drift first';
  END IF;
  IF pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure) ILIKE '%giro_intent_service_close_sweep%' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION refused: close_service_session_v3 already carries the sweep -- resolve drift first';
  END IF;
END $$;

-- Snapshot every sibling command's checksum so the post-condition block can assert
-- byte-identity on everything this migration does not intend to touch.
CREATE TEMP TABLE w5_ia_untouched_before (proname text PRIMARY KEY, checksum text) ON COMMIT DROP;
INSERT INTO w5_ia_untouched_before
  SELECT 'giro_authority_create_v1', md5(pg_get_functiondef('public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_attach_v1', md5(pg_get_functiondef('public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_move_v1', md5(pg_get_functiondef('public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_detach_v1', md5(pg_get_functiondef('public.giro_authority_detach_v1(uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_dissolve_v1', md5(pg_get_functiondef('public.giro_authority_dissolve_v1(text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_set_hora_ref_v1', md5(pg_get_functiondef('public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_create_or_move_v1', md5(pg_get_functiondef('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'giro_authority_attach_or_move_v1', md5(pg_get_functiondef('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure))
  UNION ALL SELECT 'bump_facts_signal_v1', md5(pg_get_functiondef('giro_authority.bump_facts_signal_v1()'::regprocedure))
  UNION ALL SELECT 'capture_giro_intent_v1', md5(pg_get_functiondef('giro_authority.capture_giro_intent_v1()'::regprocedure));

-- 1. Capture trigger -- verbatim from the already-certified W5_DORMANT candidate --------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
                AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
                AND t.tgname > 'ordenes_zz_giro_intent_capture_v1'::name) THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_V1 refused: a BEFORE INSERT trigger would fire after the capture';
  END IF;
END $$;

CREATE TRIGGER ordenes_zz_giro_intent_capture_v1
  BEFORE INSERT ON public.ordenes
  FOR EACH ROW
  WHEN (NEW.pending_giro_intent IS NOT NULL)
  EXECUTE FUNCTION giro_authority.capture_giro_intent_v1();

DO $$
BEGIN
  IF (SELECT max(t.tgname) FROM pg_trigger t
       WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
         AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4)
     IS DISTINCT FROM 'ordenes_zz_giro_intent_capture_v1'::name THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_V1 post-condition failed: the capture is not the last BEFORE INSERT trigger';
  END IF;
END $$;

-- 2. Consume signal-bump fix -- CREATE OR REPLACE, two inserted PERFORM lines only -------
CREATE OR REPLACE FUNCTION public.giro_authority_consume_intent_v1(p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_row  giro_authority.giro_intents;
  v_trip jsonb;
  v_ctx  jsonb;
  v_cur  text;
  v_new  text;
  v_why  text;
  f      record;
  a      record;
  d      record;
BEGIN
  IF p_order_uid IS NULL OR NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NO_INTENT');
  END IF;
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  IF v_row.target_kind = 'GIRO' THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_row.target_giro_id FOR UPDATE;   -- L1
  END IF;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid, v_row.target_order_uid]);      -- L2
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid FOR UPDATE;  -- L3
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  PERFORM 1 FROM public.ordenes o
   WHERE o.order_uid = ANY (ARRAY[p_order_uid, v_row.target_order_uid])
   ORDER BY o.order_uid FOR SHARE;                                                        -- L4

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'SCOPE_UNAVAILABLE', NULL, p_actor, NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'UNVERIFIABLE', NULL, p_actor,
                                            jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  IF NOT f.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_GONE'));
  END IF;
  IF NOT COALESCE(f.service_session_id = ANY (p_operational_session_ids), false) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'EXPIRED', 'EXPIRY', 'SERVICE_CLOSED', NULL, p_actor, NULL);
  END IF;
  IF f.in_active_trip OR f.estado = 'EN_ENTREGA'
     OR f.estado = ANY (giro_authority.delivered_states_v1())
     OR f.estado = ANY (giro_authority.cancelled_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_STATE', 'estado', f.estado));
  END IF;
  IF f.estado IS NULL OR f.estado NOT IN ('EN_COCINA', 'LISTO') THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NOT_YET_OPERATIVE', 'status', 'PENDING', 'replay', false);
  END IF;
  v_ctx := v_row.order_context;
  IF (v_ctx->>'zona') IS DISTINCT FROM f.zona
     OR (v_ctx->>'hora') IS DISTINCT FROM f.hora
     OR (v_ctx->>'delivery_type') IS DISTINCT FROM f.delivery_type
     OR (v_ctx->>'service_session_id') IS DISTINCT FROM f.service_session_id::text THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor, NULL);
  END IF;
  IF f.delivery_type <> 'DOMICILIO' OR f.table_session_id IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'NOT_DELIVERY'));
  END IF;
  v_cur := giro_authority.order_effective_giro_v1(p_order_uid, p_operational_session_ids, v_trip);

  IF v_row.target_kind = 'GIRO' THEN
    IF v_cur = v_row.target_giro_id THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_cur, p_actor,
                                              jsonb_build_object('already_member', true));
    END IF;
    IF v_cur IS NOT NULL THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                              jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
    END IF;
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_row.target_giro_id], p_operational_session_ids, v_trip);
    IF NOT FOUND THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor, NULL);
    END IF;
    IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor,
                                              jsonb_build_object('giro_state', d.giro_state));
    END IF;
    IF d.giro_state <> 'PLANNED' OR d.business_date IS DISTINCT FROM f.business_date THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                              jsonb_build_object('state_reason', d.state_reason));
    END IF;
    IF giro_authority.target_fingerprint_v1('GIRO', v_row.target_giro_id, NULL) IS DISTINCT FROM v_row.target_fingerprint THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
    END IF;
    PERFORM giro_authority.put_member_v1(p_order_uid, v_row.target_giro_id, p_actor);
    PERFORM giro_authority.bump_facts_signal_v1();
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_row.target_giro_id, p_actor, NULL);
  END IF;

  -- ANCHOR: create {anchor, order}; the anchor must still be a free, operative single.
  IF v_cur IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
  END IF;
  SELECT * INTO a FROM giro_authority.order_facts_v1(ARRAY[v_row.target_order_uid], v_trip);
  IF NOT a.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ANCHOR_GONE'));
  END IF;
  IF a.in_active_trip OR a.estado = 'EN_ENTREGA' OR a.estado = ANY (giro_authority.delivered_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor, NULL);
  END IF;
  v_why := giro_authority.member_refusal_v1(a.present, a.estado, a.delivery_type, a.table_session_id,
                                            a.in_active_trip, a.service_session_id, p_operational_session_ids);
  IF v_why IS NOT NULL OR a.business_date IS DISTINCT FROM f.business_date THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', COALESCE(v_why, 'BUSINESS_DATE')));
  END IF;
  IF giro_authority.order_effective_giro_v1(v_row.target_order_uid, p_operational_session_ids, v_trip) IS NOT NULL
     OR giro_authority.target_fingerprint_v1('ANCHOR', NULL, v_row.target_order_uid) IS DISTINCT FROM v_row.target_fingerprint THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
  END IF;
  v_new := giro_authority.insert_giro_v1(f.business_date, NULL, v_row.target_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(v_row.target_order_uid, v_new, p_actor);
  PERFORM giro_authority.put_member_v1(p_order_uid, v_new, p_actor);
  PERFORM giro_authority.bump_facts_signal_v1();
  RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'GIRO_CREATED', v_new, p_actor, NULL);
END $function$;

-- 3. NEW: bounded read-only pending-intent helper for the Phase 2 reconciler --------------
CREATE FUNCTION public.giro_authority_list_pending_intents_v1(
  p_operational_session_ids uuid[], p_limit integer DEFAULT 20)
RETURNS TABLE(order_uid uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT gi.order_uid
    FROM giro_authority.giro_intents gi
    JOIN public.ordenes o ON o.order_uid = gi.order_uid
   WHERE gi.status = 'PENDING'
     AND p_operational_session_ids IS NOT NULL
     AND cardinality(p_operational_session_ids) > 0
     AND array_position(p_operational_session_ids, NULL) IS NULL
     AND o.service_session_id = ANY (p_operational_session_ids)
     AND o.estado IN ('EN_COCINA', 'LISTO')
   ORDER BY gi.captured_at ASC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 200)
$fn$;

-- 4. close_service_session_v3 -- one best-effort sweep step inserted, everything else verbatim
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

  SELECT * INTO v_bd_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;
  IF v_bd_state.current_period_id IS NOT NULL AND v_bd_state.current_period_id IS DISTINCT FROM v_session.id THEN
    RETURN jsonb_build_object('ok',false,'code','BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH');
  END IF;

  PERFORM set_config('ladieci.v3_close_authorized_session_id', v_session.id::text, true);

  UPDATE public.service_sessions
     SET status = 'closed', closed_at = now(), closed_by = p_closed_by,
         close_source = p_source, updated_at = now()
   WHERE id = v_session.id
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id = NULL, recent_closed_session_id = v_session.id, updated_at = now()
   WHERE singleton = true;

  IF v_bd_state.current_period_id = v_session.id THEN
    PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
    UPDATE public.business_day_lifecycle_state SET current_period_id = NULL, updated_at = now() WHERE singleton = true;
  END IF;

  INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
  VALUES (v_session.id, 'closed', p_closed_by, p_source);

  -- W5 INTENT ACTIVATION V1 -- giro intent close-sweep. Best-effort, own
  -- exception scope: a failure here must never roll back or block the close
  -- above, which has already fully committed its own writes by this point.
  -- The nil-UUID sentinel scope is deliberately never a real session id, so
  -- consume's own service_session_id membership check (unconditional, runs
  -- before any estado/eligibility branch) forces EXPIRED/SERVICE_CLOSED for
  -- every match -- never CONSUMED, never a Giro attachment.
  BEGIN
    PERFORM public.giro_authority_consume_intent_v1(
      gi.order_uid, 'giro_intent_service_close_sweep',
      ARRAY['00000000-0000-0000-0000-000000000000'::uuid])
    FROM giro_authority.giro_intents gi
    JOIN public.ordenes o ON o.order_uid = gi.order_uid
    WHERE gi.status = 'PENDING' AND o.service_session_id = v_session.id;
  EXCEPTION WHEN others THEN
    NULL;
  END;

  RETURN jsonb_build_object('ok',true,'code','V3_CLOSED','idempotent',false,'session',to_jsonb(v_session));
END;
$function$;

-- 5. Ownership, search_path, grants --------------------------------------------------------
ALTER FUNCTION public.giro_authority_list_pending_intents_v1(uuid[], integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.giro_authority_list_pending_intents_v1(uuid[], integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_list_pending_intents_v1(uuid[], integer) TO service_role;
-- giro_authority_consume_intent_v1 / close_service_session_v3 already carry
-- their correct grants from migrations 130/f4-series (CREATE OR REPLACE
-- preserves existing privileges); nothing to re-grant.

-- 6. Post-conditions --------------------------------------------------------------------------
DO $$
DECLARE
  r      record;
  v_src  text;
BEGIN
  -- The new helper: owner, search_path, PUBLIC/anon/authenticated barred, service_role only.
  SELECT p.oid, pg_get_userbyid(p.proowner) AS owner, p.proconfig INTO r
    FROM pg_proc p WHERE p.oid = 'public.giro_authority_list_pending_intents_v1(uuid[],integer)'::regprocedure;
  IF r.owner <> 'postgres' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: giro_authority_list_pending_intents_v1 must be owned by postgres';
  END IF;
  IF r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: giro_authority_list_pending_intents_v1 must pin search_path=pg_catalog, pg_temp';
  END IF;
  IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: anon/authenticated may execute giro_authority_list_pending_intents_v1';
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode(COALESCE(
               (SELECT p2.proacl FROM pg_proc p2 WHERE p2.oid = r.oid),
               acldefault('f', (SELECT p3.proowner FROM pg_proc p3 WHERE p3.oid = r.oid)))) x
              WHERE x.grantee = 0) THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: PUBLIC may execute giro_authority_list_pending_intents_v1';
  END IF;
  IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: service_role must be able to execute giro_authority_list_pending_intents_v1';
  END IF;

  -- consume_intent_v1 now bumps: exactly two PERFORM bump_facts_signal_v1() call sites.
  v_src := pg_get_functiondef('public.giro_authority_consume_intent_v1(uuid,text,uuid[])'::regprocedure);
  IF (length(v_src) - length(replace(v_src, 'PERFORM giro_authority.bump_facts_signal_v1();', ''))) /
     length('PERFORM giro_authority.bump_facts_signal_v1();') <> 2 THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: consume_intent_v1 must contain exactly 2 bump call sites';
  END IF;
  IF v_src NOT ILIKE '%already_member%' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: consume_intent_v1 lost its already-member idempotent branch';
  END IF;

  -- close_service_session_v3: carries the new sweep marker, still carries its own
  -- pre-existing guard literals untouched (spot-check, not a full checksum since
  -- this migration deliberately modifies it).
  v_src := pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure);
  IF v_src NOT ILIKE '%giro_intent_service_close_sweep%' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: close_service_session_v3 is missing the giro-intent sweep';
  END IF;
  IF v_src NOT ILIKE '%SESSION_CLOSE_IDENTITY_MISMATCH%' OR v_src NOT ILIKE '%BUSINESS_DAY_POINTER_OWNERSHIP_MISMATCH%'
     OR v_src NOT ILIKE '%V3_CLOSED%' THEN
    RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: close_service_session_v3 lost an existing guard/outcome literal';
  END IF;

  -- Every sibling command: byte-identical to its pre-132 checksum.
  FOR r IN SELECT proname, checksum AS before FROM w5_ia_untouched_before LOOP
    DECLARE
      v_sig regprocedure;
      v_now text;
    BEGIN
      v_sig := CASE r.proname
        WHEN 'giro_authority_create_v1' THEN 'public.giro_authority_create_v1(uuid[],text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_attach_v1' THEN 'public.giro_authority_attach_v1(text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_move_v1' THEN 'public.giro_authority_move_v1(uuid,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_detach_v1' THEN 'public.giro_authority_detach_v1(uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_dissolve_v1' THEN 'public.giro_authority_dissolve_v1(text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_set_hora_ref_v1' THEN 'public.giro_authority_set_hora_ref_v1(text,text,text,uuid[])'::regprocedure
        WHEN 'giro_authority_create_or_move_v1' THEN 'public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])'::regprocedure
        WHEN 'giro_authority_attach_or_move_v1' THEN 'public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])'::regprocedure
        WHEN 'bump_facts_signal_v1' THEN 'giro_authority.bump_facts_signal_v1()'::regprocedure
        WHEN 'capture_giro_intent_v1' THEN 'giro_authority.capture_giro_intent_v1()'::regprocedure
      END;
      v_now := md5(pg_get_functiondef(v_sig));
      IF v_now <> r.before THEN
        RAISE EXCEPTION 'W5_INTENT_ACTIVATION post-condition failed: % changed (expected byte-identical to pre-132)', r.proname;
      END IF;
    END;
  END LOOP;

  -- Producer stays hard-forced: no JS in this migration, nothing here can assert
  -- that directly, but the trigger's own WHEN clause is still the only gate and
  -- it is unchanged (checked above via the trigger post-condition).
END $$;

COMMIT;
