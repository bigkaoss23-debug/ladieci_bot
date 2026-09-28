-- migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.sql
-- C8 LOCK-ORDER FIX, part B (DELIVERY x ECONOMIA V1, 2026-09-24): order_cancel_v1 TAKES THE WORKSPACE FIRST.
--
-- WHY. order_cancel_v1 locks  ACTOR FOR UPDATE -> [TABLE_SESSION FOR UPDATE] -> ORDER FOR UPDATE -> ...  with NO workspace lock, while every other
-- economic writer locks  L -> W FOR UPDATE -> ACTOR -> TABLE_SESSION -> ...  and mesa_open_* takes a service row before the table session. The
-- real-body audit (DELIVERY_ECONOMY_V1_C8_REAL_BODY_DEADLOCK_AUDIT_2026-09-24.md) proved cycles with order_cancel_v1 as one party. The frozen design
-- (DELIVERY_ECONOMY_V1_C8_FIX_DESIGN_CLOSURE_2026-09-24.md, §23, M-C8b) closes them by making the workspace row its FIRST lock:
-- W FOR UPDATE -> ACTOR -> [TABLE_SESSION] -> ORDER -> ...  Two distinct cycles are involved (both measured on the local real-body database by
-- ci/giro-authority-certification/harness/runC8LockOrderFix.js):
--   * H3  order_cancel_v1 x paid-at-creation intake, SAME actor: closed by migration 143 alone (the prelude takes W and the payer actor before the
--         service row); 144 makes order_cancel_v1 conform to the same W-first contract.
--   * H4  order_cancel_v1 (comanda, actor A) x mesa_open_session_v1 (same table, actor B): order_cancel_v1 holds ACTOR(A) + TABLE_SESSION and then needs
--         the service row (KEY SHARE, through the obligation insert) that mesa_open_* holds FOR UPDATE while it waits for that TABLE_SESSION. Migration 143
--         touches neither writer, so H4 still deadlocks with 143 alone; it is closed ONLY by this migration (both writers then queue on W first).
-- The two migrations are independent (either can be applied or rolled back alone) but neither alone closes every cycle: 143 alone leaves H4,
-- 144 alone leaves H1 / H3.
--
-- WHAT. ONE function is re-issued, with EXACTLY ONE inserted block (markers `-- 144:BEGIN w_first` ... `-- 144:END w_first`): after the order and
-- its order_entities row are read (plain SELECTs, no lock), and BEFORE the actor row is locked, the workspace row is locked FOR UPDATE. Removing the
-- block yields the staging body byte for byte (md5(prosrc) d75624fd1393d7dbf94d2155e19626b7). Authorization (actor active + role gate), ownership,
-- table-session lock, order state machine, service attribution of financial events, idempotency, typed errors (ORDER_CANCEL_*), the cancel
-- semantics and the JSON result are untouched; no capability is added; no data, grant, table, column, index or constraint changes.
--
-- DRIFT GUARD (fail closed). The staging text of order_cancel_v1 is LIVE-ONLY (no migration reproduces it; migration 118 carries an older text).
-- This migration therefore refuses unless the function exists with the exact 7-argument signature AND md5(prosrc) = d75624fd1393d7dbf94d2155e19626b7.
-- A divergent body is never overwritten. Owner, SECURITY INVOKER, search_path and the ACL are preserved (asserted before/after, not re-granted).
--
-- ROLLBACK: migrations/2026-09-24_c8_order_cancel_w_first_v1_migration_144.ROLLBACK.sql re-issues the staging body verbatim (md5 d75624fd...),
-- refusing if the current body is not the exact 144 body.
-- STAGING ONLY. NOT applied by the session that authored it.

BEGIN;

DO $guard$
DECLARE
  v_oid oid := to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');
  v_src text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'C8_CANCEL refused: public.order_cancel_v1(text,text,text,text,text,text,jsonb) is missing -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'order_cancel_v1') <> 1 THEN
    RAISE EXCEPTION 'C8_CANCEL refused: order_cancel_v1 has an unexpected overload set -- resolve drift first';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_oid;
  IF md5(v_src) IS DISTINCT FROM 'd75624fd1393d7dbf94d2155e19626b7' THEN
    RAISE EXCEPTION 'C8_CANCEL refused: order_cancel_v1 is not the pinned staging body (md5 mismatch: %) -- resolve drift first; a divergent body is never overwritten', md5(v_src);
  END IF;
  IF to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)') IS NULL
     OR to_regprocedure('public.order_canonical_obligation_v1(uuid)') IS NULL
     OR to_regclass('public.order_entities') IS NULL OR to_regclass('public.workspaces') IS NULL THEN
    RAISE EXCEPTION 'C8_CANCEL refused: a callee or table of order_cancel_v1 is missing -- resolve drift first';
  END IF;
END $guard$;

-- Before-state of the security posture (owner, SECURITY, search_path, ACL) and of every other function of schema public.
CREATE TEMP TABLE c8144_before (k text PRIMARY KEY, prosecdef boolean, proconfig text[], owner name, acl text, proretset boolean, prorettype regtype, args text) ON COMMIT DROP;
INSERT INTO c8144_before
  SELECT 'cancel', p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner), p.proacl::text, p.proretset, p.prorettype::regtype, pg_get_function_arguments(p.oid)
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');
CREATE TEMP TABLE c8144_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c8144_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');

CREATE OR REPLACE FUNCTION public.order_cancel_v1(p_order_id text, p_by_actor text, p_reason text, p_client_request_id text, p_request_hash text, p_target_estado text DEFAULT 'CANCELADO'::text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE; v_peek public.ordenes%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_target text; v_res jsonb; v_net numeric;
  v_current numeric; v_workspace uuid; v_now timestamptz := now();
BEGIN
  IF p_order_id IS NULL OR btrim(p_order_id) = ''
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_CANCEL_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
  v_target := upper(btrim(COALESCE(p_target_estado, 'CANCELADO')));
  IF v_target NOT IN ('CANCELADO','CANCELLED','ANULADO') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_peek FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_CANCEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT oe.workspace_id INTO v_workspace FROM public.order_entities oe WHERE oe.order_uid = v_peek.order_uid;
  -- 144:BEGIN w_first
  -- C8 (migration 144): the workspace row is the FIRST lock of the function, taken FOR UPDATE before the actor, exactly as every other economic
  -- writer does (L -> W -> ACTOR -> TABLE_SESSION -> ORDER). The workspace comes from the immutable order_entities row read above with a plain
  -- SELECT (append-only by trigger), so no lock is needed to know which W to take. No W lock when the order has no entity (unchanged behaviour:
  -- the typed errors below are raised as before).
  IF v_workspace IS NOT NULL THEN
    PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;
  END IF;
  -- 144:END w_first
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE actor = p_by_actor AND (v_workspace IS NULL OR workspace_id = v_workspace) FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'ORDER_CANCEL_FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF v_peek.table_session_id IS NOT NULL THEN
    PERFORM 1 FROM public.table_sessions WHERE id = v_peek.table_session_id FOR UPDATE; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_CANCEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ord.order_uid IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023'; END IF;
  IF upper(COALESCE(v_ord.estado,'')) = v_target THEN
    v_current := public.order_canonical_obligation_v1(v_ord.order_uid);
    SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0)
      INTO v_net FROM public.order_financial_events e
     WHERE e.order_id = v_ord.id AND e.type IN ('payment','payment_imported','refund')
       AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
      'estado', v_ord.estado, 'currentObligation', round(v_current, 2), 'netCollected', round(v_net, 2),
      'unpaid', GREATEST(0, round(v_current - v_net, 2)), 'overCollected', GREATEST(0, round(v_net - v_current, 2)));
  END IF;
  IF upper(COALESCE(v_ord.estado,'')) NOT IN ('POR_CONFIRMAR','NUEVO','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_STATE_INVALID' USING ERRCODE='22023'; END IF;
  v_res := public.order_obligation_apply_adjustment_v1(
    v_ord.order_uid, 0, 'order_cancellation', p_reason, p_by_actor, v_actor.role,
    p_client_request_id, p_request_hash, NULL);
  UPDATE public.ordenes SET estado = v_target, cancelado_at = v_now WHERE id = v_ord.id;
  SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0)
    INTO v_net FROM public.order_financial_events e
   WHERE e.order_id = v_ord.id AND e.type IN ('payment','payment_imported','refund')
     AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  v_current := (v_res->>'currentObligation')::numeric;
  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
    'prevEstado', v_ord.estado, 'estado', v_target, 'previousObligation', v_res->'previousObligation',
    'currentObligation', round(v_current, 2), 'revision', v_res->'revision', 'bootstrapped', v_res->'bootstrapped',
    'netCollected', round(v_net, 2), 'unpaid', GREATEST(0, round(v_current - v_net, 2)),
    'overCollected', GREATEST(0, round(v_net - v_current, 2)));
END;
$function$;


DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.order_cancel_v1(text,text,text,text,text,text,jsonb)');
  v_b   c8144_before%ROWTYPE;
  v_diff integer;
BEGIN
  IF v_oid IS NULL THEN RAISE EXCEPTION 'C8_CANCEL post-condition failed: function missing'; END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM '26408ba35e2a43420273a6f4c126083d' THEN
    RAISE EXCEPTION 'C8_CANCEL post-condition failed: body md5 is not the 144 body';
  END IF;
  SELECT * INTO v_b FROM c8144_before WHERE k = 'cancel';
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_oid AND p.prosecdef IS NOT DISTINCT FROM v_b.prosecdef AND p.proconfig IS NOT DISTINCT FROM v_b.proconfig
                    AND pg_get_userbyid(p.proowner) = v_b.owner AND p.proacl::text IS NOT DISTINCT FROM v_b.acl AND p.proretset = v_b.proretset
                    AND p.prorettype::regtype = v_b.prorettype AND pg_get_function_arguments(p.oid) = v_b.args) THEN
    RAISE EXCEPTION 'C8_CANCEL post-condition failed: signature / owner / SECURITY / search_path / ACL changed';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE') OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'C8_CANCEL post-condition failed: EXECUTE must stay service_role-only';
  END IF;
  -- the inserted block sits BEFORE the actor lock (the whole point of the migration)
  IF position('-- 144:BEGIN w_first' IN (SELECT prosrc FROM pg_proc WHERE oid = v_oid)) = 0
     OR position('FROM public.workspaces WHERE id = v_workspace FOR UPDATE' IN (SELECT prosrc FROM pg_proc WHERE oid = v_oid))
        > position('FROM public.auth_actors' IN (SELECT prosrc FROM pg_proc WHERE oid = v_oid)) THEN
    RAISE EXCEPTION 'C8_CANCEL post-condition failed: the workspace lock is not taken before the actor lock';
  END IF;
  SELECT count(*) INTO v_diff FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_oid
     AND NOT EXISTS (SELECT 1 FROM c8144_fn_before f WHERE f.sig = p.oid::regprocedure::text AND f.md5 = md5(p.prosrc));
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_CANCEL post-condition failed: % other function(s) of schema public changed', v_diff; END IF;
  SELECT count(*) INTO v_diff FROM c8144_fn_before f WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid::regprocedure::text = f.sig);
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_CANCEL post-condition failed: % function(s) disappeared', v_diff; END IF;
END $post$;

COMMIT;
