-- migrations/2026-09-26_economic_close_gate_v1_migration_151.sql
-- Paired rollback: 2026-09-26_economic_close_gate_v1_migration_151.ROLLBACK.sql
--
-- ECONOMY BASE -- FINAL CONCURRENCY CORRECTIVE SLICE (DELIVERY x ECONOMIA V1, 2026-09-26). STAGING CANDIDATE ONLY; not applied by the session
-- that authored it. Evidence: ~/Downloads/DELIVERY_ECONOMY_V1_FINAL_CONCURRENCY_FIX_151_2026-09-26.md.
--
-- DEFECT (ECONOMY_150_FINAL_RACE_GATE_FAIL). close_service_session_with_evidence_v1 (150) judges the evidence under the lock prefix
-- lifecycle -> L0 -> service_session_state FOR UPDATE, which excludes payments / refunds (pointer FOR SHARE, 145/146), order intake (lifecycle,
-- 143) and the rider / operator delivery (L0). The obligation writers took none of them: order_cancel_v1, order_apply_commercial_adjustment_v1
-- and mesa_post_commercial_adjustment_v1 (all through the shared core order_obligation_apply_adjustment_v1), and a totale edit of an unpaid
-- order (trigger order_obligation_revision_v1). One of them could commit AFTER the judgement and BEFORE the close commit (the close locks the
-- service row only at its end), and Finalizar returned V3_CLOSED with a stale closeout / reconciliation / UNPAID incident (gated 4/4 per
-- writer, natural 2/42). After the close, the same writers kept rewriting the obligations of the closed service, falsifying its closeout.
-- FIX: ONE helper, public.order_economic_service_gate_v1(order_uid), called by the two functions every obligation revision goes through:
--   1. it takes the canonical gate -- service_session_state FOR SHARE, the SAME primitive at the SAME place as the 145/146 writers (after
--      W -> ACTOR -> TABLE_SESSION -> ORDER, before the first write), held to commit;
--   2. after the gate (fresh snapshot) it re-judges the service: the order's service and the service its obligations are anchored to must be
--      'open', else SQLSTATE 55000 ORDER_ECONOMIC_SERVICE_CLOSED, nothing written. (Existing semantics reused: the order refund is refused the
--      same way when no service is open (146); post-close facts about a closed service go to the post-close resolution ledger.)
--   order_obligation_apply_adjustment_v1 = its current body + ONE block (151:BEGIN economic_close_gate) after the idempotent replay;
--   order_obligation_revision_v1 = its current body + the same block before its INSERT. Removing each block yields the current body byte for byte.
-- LOCK ORDER. Writers: W -> ACTOR -> [TABLE_SESSION] -> ORDER -> POINTER (FOR SHARE) -> service_sessions (FK KEY SHARE). Close / open:
-- lifecycle -> [L0] -> [bd state] -> POINTER (FOR UPDATE) -> service_sessions / bd state / closeout / attempt rows. No pointer holder ever
-- waits on a workspace, actor, table session or order row, so no cycle is possible (the same argument certified for 145/146).
-- ROLLOUT: 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148 -> 149 -> 150 -> 151. The backend of the same package only RECOGNISES the new
-- refusal (typed 409 + message); it works unchanged with or without 151. ROLLBACK: 151 alone, any time (function-only, no data depends on it).
-- DRIFT GUARDS (fail closed): the chain tip is 150; the two replaced bodies, their three callers, the four money writers carrying the gate
-- primitive, and the close / open lock sets are their certified bodies; the trigger is exactly as certified; nothing of 151 exists yet.
-- POST-CONDITIONS: the three pins; the helper posture (SECURITY INVOKER, search_path, service_role-only EXECUTE); each block exactly once; owner /
-- SECURITY / search_path / ACL / signature of the two replaced functions unchanged; the trigger unchanged; every other function byte-identical.
BEGIN;

-- 0. Preconditions and drift guards ---------------------------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_pin record;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])', 'a25b330f095ff3441bca034e79e750f7', 'chain tip 150 (terminal step)'),
      ('public.mesa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb,boolean)', '2d6ebfe704559dd5a9a083025fb77057', 'chain tip 150 (Mesa writer, 145 gate)'),
      ('public.close_service_session_v3(uuid,uuid,text,text)', 'a6680181760dd8dabfa29aa43c786906', 'close lock prefix (lifecycle -> L0 -> pointer FOR UPDATE)'),
      ('public.open_operational_service_v1(text,text,text)', '497183409192e9a15c0f3b33c2d336ba', 'open lock set (lifecycle -> bd state -> pointer FOR UPDATE -> service_sessions)'),
      ('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)', 'e1ce2229f2418d6a7f91fe50771564f8', 'Cash payment, 145 gate'),
      ('public.order_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', '687b55f29d69323d54a73111529cebe9', 'order refund, 146 gate'),
      ('public.mesa_post_refund_v1(uuid,text,text,uuid,uuid,text,text,text,numeric,jsonb)', '69629f700425ebf48b88cc659c689992', 'Mesa refund, 146 gate'),
      ('public.order_cancel_v1(text,text,text,text,text,text,jsonb)', '26408ba35e2a43420273a6f4c126083d', 'caller: cancel (144 W-first)'),
      ('public.order_apply_commercial_adjustment_v1(uuid,text,text,uuid,numeric,text,text,text,numeric,jsonb)', 'bfac890abc0e6103466649d37fe92ddf', 'caller: Cash adjustment'),
      ('public.mesa_post_commercial_adjustment_v1(uuid,text,text,uuid,uuid,numeric,text,text,text,numeric,jsonb)', '76c4eb343b741fd1746aebdd738c7cea', 'caller: Mesa adjustment'),
      ('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)', 'b4c358e2a3913ba110d400f07059e8e5', 'the shared obligation core (replaced)'),
      ('public.order_obligation_revision_v1()', '49387a6bf8e0ec66694d7bebe14d3d17', 'the totale revision trigger function (replaced)')
    ) AS x(sig, want, what) LOOP
    IF to_regprocedure(v_pin.sig) IS NULL
       OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE refused: % (%) is missing or is not the certified body % -- the rollout is 139 -> ... -> 150 -> 151; resolve drift first', v_pin.sig, v_pin.what, v_pin.want;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'service_closeouts_terminal_close_v1' AND t.tgrelid = 'public.service_closeouts'::regclass) <> 1 THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE refused: the chain tip is not 150 (service_closeouts_terminal_close_v1 missing)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'ordenes_order_obligation_revision_v1' AND t.tgenabled = 'O'
        AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER ordenes_order_obligation_revision_v1 AFTER UPDATE OF totale ON public.ordenes FOR EACH ROW EXECUTE FUNCTION order_obligation_revision_v1()') <> 1 THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE refused: the totale revision trigger is not installed exactly as certified';
  END IF;
  IF to_regclass('public.service_session_state') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.service_session_state'::regclass AND a.attname = 'singleton' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.service_sessions'::regclass AND a.attname = 'status' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE refused: service_session_state.singleton / service_sessions.status missing';
  END IF;
  IF to_regprocedure('public.order_economic_service_gate_v1(uuid)') IS NOT NULL
     OR position('-- 151:BEGIN ' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)'))) > 0
     OR position('-- 151:BEGIN ' IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_obligation_revision_v1()'))) > 0 THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE refused: already applied (an object of migration 151 already exists)';
  END IF;
END $guard$;

-- Before-state: every function of every user schema, and the posture of the two replaced functions.
CREATE TEMP TABLE c151_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c151_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';
CREATE TEMP TABLE c151_posture_before ON COMMIT DROP AS
  SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proretset,
         p.prorettype::regtype AS rettype, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)'), to_regprocedure('public.order_obligation_revision_v1()'));

-- 1. The shared gate -------------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.order_economic_service_gate_v1(p_order_uid uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_service uuid;
BEGIN
  -- The canonical close / open gate (145 payments, 146 refunds): the pointer row held FOR SHARE from here to commit. Every close
  -- (close_service_session_v3, close_service_session_with_evidence_v1) and every open holds it FOR UPDATE from before its evidence is judged
  -- to its commit, so this write either commits before that judgement (and is judged) or waits for that commit.
  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;
  -- Re-judged after the gate, on a fresh snapshot: the service whose economic facts this write changes (the order's own service and the
  -- service its obligations are anchored to) must still be open. A closed service's closeout is frozen: changing its obligations would make
  -- it false. Post-close facts about a closed service belong to the post-close resolution ledger, not to its sale facts.
  SELECT ss.id INTO v_service
    FROM public.service_sessions ss
   WHERE ss.id IN ((SELECT o.service_session_id FROM public.ordenes o WHERE o.order_uid = p_order_uid),
                   (SELECT ob.service_session_id FROM public.order_obligations ob WHERE ob.order_uid = p_order_uid ORDER BY ob.revision DESC LIMIT 1))
     AND ss.status IS DISTINCT FROM 'open'
   LIMIT 1;
  IF v_service IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_ECONOMIC_SERVICE_CLOSED' USING ERRCODE = '55000',
      DETAIL = format('order_uid=%s service_session_id=%s', p_order_uid, v_service),
      HINT = 'The service of this order is closed and its closeout is frozen: its obligation can no longer change. Record a post-close resolution instead.';
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.order_economic_service_gate_v1(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_economic_service_gate_v1(uuid) TO service_role;

-- 2. The shared obligation core (cancel, Cash adjustment, Mesa adjustment): its current body + the 151 block -------------------------------------
CREATE OR REPLACE FUNCTION public.order_obligation_apply_adjustment_v1(p_order_uid uuid, p_new_gross numeric, p_cause text, p_reason text, p_by_actor text, p_by_role text, p_client_request_id text, p_request_hash text, p_expected_current_gross numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ord public.ordenes%ROWTYPE; v_prev public.order_obligations%ROWTYPE; v_workspace uuid;
  v_kind text; v_current numeric; v_revision integer; v_new_rev integer;
  v_bootstrap boolean := false; v_reason text; v_session uuid; v_period text;
BEGIN
  IF p_order_uid IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023'; END IF;
  IF p_cause IS NULL OR p_cause NOT IN ('manual','order_cancellation') THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_new_gross IS NULL OR p_new_gross < 0 THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' OR p_by_role IS NULL THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_client_request_id IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ord.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023'; END IF;

  SELECT oe.workspace_id INTO v_workspace FROM public.order_entities oe WHERE oe.order_uid = p_order_uid;
  IF v_workspace IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_prev FROM public.order_obligations
   WHERE workspace_id = v_workspace AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'MESA_ADJUSTMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'changed', true, 'bootstrapped', false,
      'orderUid', v_prev.order_uid, 'revision', v_prev.revision, 'currentObligation', v_prev.gross_amount,
      'previousObligation', (SELECT ob.gross_amount FROM public.order_obligations ob
                              WHERE ob.order_uid = p_order_uid AND ob.revision = v_prev.revision - 1),
      'cause', v_prev.cause);
  END IF;

  -- 151:BEGIN economic_close_gate
  -- The close gate (the 145/146 primitive, through the shared helper): no obligation revision may commit between the Finalizar evidence
  -- judgement and its commit, and none may land on a service that is no longer open (its closeout is frozen). Here: after the caller's
  -- W -> ACTOR -> TABLE_SESSION -> ORDER locks and after the idempotent replay above (which writes nothing), before the first write.
  PERFORM public.order_economic_service_gate_v1(p_order_uid);
  -- 151:END economic_close_gate
  SELECT * INTO v_prev FROM public.order_obligations WHERE order_uid = p_order_uid ORDER BY revision DESC LIMIT 1;
  IF NOT FOUND THEN
    v_bootstrap := true; v_current := COALESCE(v_ord.totale, 0); v_revision := 1; v_session := v_ord.service_session_id;
    SELECT ss.service_kind INTO v_kind FROM public.service_sessions ss WHERE ss.id = v_session;
    v_period := CASE WHEN v_kind IN ('PRANZO','SERA') THEN v_kind ELSE NULL END;
    INSERT INTO public.order_obligations
      (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, channel, source,
       economic_period_kind, created_at, materialized_lazily)
    VALUES (p_order_uid, v_ord.id, v_session, v_workspace, 1, v_current, v_ord.canal, 'order_create_v1',
       v_period, COALESCE(v_ord.created_at, now()), true);
  ELSE
    v_current := v_prev.gross_amount; v_revision := v_prev.revision; v_session := v_prev.service_session_id;
    v_period := v_prev.economic_period_kind;
  END IF;

  IF p_expected_current_gross IS NOT NULL
     AND round(p_expected_current_gross, 2) IS DISTINCT FROM round(v_current, 2) THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_STALE_OBLIGATION' USING ERRCODE='55000'; END IF;
  IF round(p_new_gross, 2) > round(v_current, 2) THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_EXCEEDS_OBLIGATION' USING ERRCODE='22023'; END IF;
  IF round(p_new_gross, 2) = round(v_current, 2) THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'changed', false, 'bootstrapped', v_bootstrap,
      'orderUid', p_order_uid, 'revision', CASE WHEN v_bootstrap THEN 1 ELSE v_revision END,
      'currentObligation', v_current, 'previousObligation', v_current, 'cause', p_cause);
  END IF;

  v_new_rev := CASE WHEN v_bootstrap THEN 2 ELSE v_revision + 1 END;
  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision, gross_amount, channel, source,
     economic_period_kind, created_at, cause, reason, by_actor, by_role, client_request_id, request_hash)
  VALUES (p_order_uid, v_ord.id, v_session, v_workspace, v_new_rev, round(p_new_gross, 2), v_ord.canal,
     'order_commercial_adjustment_v1', v_period, now(), p_cause, v_reason, p_by_actor, p_by_role,
     p_client_request_id, p_request_hash);

  RETURN jsonb_build_object('ok', true, 'idempotent', false, 'changed', true, 'bootstrapped', v_bootstrap,
    'orderUid', p_order_uid, 'revision', v_new_rev, 'previousObligation', v_current,
    'currentObligation', round(p_new_gross, 2), 'cause', p_cause);
END;
$function$;

-- 3. The totale revision trigger function: its current body + the 151 block -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_obligation_revision_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_prev   public.order_obligations%ROWTYPE;
BEGIN
  IF NEW.totale IS NOT DISTINCT FROM OLD.totale THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_prev FROM public.order_obligations
   WHERE order_uid = NEW.order_uid
   ORDER BY revision DESC LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- 151:BEGIN economic_close_gate
  -- A totale edit that moves the obligation is an economic writer too: same gate, after the ORDER row lock this UPDATE already holds.
  PERFORM public.order_economic_service_gate_v1(NEW.order_uid);
  -- 151:END economic_close_gate

  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision,
     gross_amount, channel, source, economic_period_kind, created_at)
  VALUES
    (NEW.order_uid, NEW.id, v_prev.service_session_id, v_prev.workspace_id,
     v_prev.revision + 1, COALESCE(NEW.totale, 0), NEW.canal,
     'order_total_revision_v1', v_prev.economic_period_kind, now());

  RETURN NEW;
END;
$function$;

-- 4. Post-conditions -----------------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_pin record;
  v_src text;
  v_bad text;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
      ('public.order_economic_service_gate_v1(uuid)', '3c8c4c46dac20285081b85a3313ef576'),
      ('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)', '2c411d98f63545c4a4b7d04fd9beb7fe'),
      ('public.order_obligation_revision_v1()', 'bfac4ec3f428daa91d5d9505d8b1285a')
    ) AS x(sig, want) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig)) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE post-condition failed: % is not the expected body %', v_pin.sig, v_pin.want;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_economic_service_gate_v1(uuid)')
              AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
                   OR has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
                   OR NOT has_function_privilege('service_role', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE post-condition failed: the helper must be SECURITY INVOKER, search_path public, pg_temp, EXECUTE for service_role only';
  END IF;
  FOR v_pin IN SELECT * FROM (VALUES ('public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)'), ('public.order_obligation_revision_v1()')) AS x(sig) LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
    IF (length(v_src) - length(replace(v_src, '-- 151:BEGIN economic_close_gate', ''))) / length('-- 151:BEGIN economic_close_gate') <> 1
       OR (length(v_src) - length(replace(v_src, '-- 151:END economic_close_gate', ''))) / length('-- 151:END economic_close_gate') <> 1 THEN
      RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE post-condition failed: % must carry the 151 block exactly once', v_pin.sig;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM c151_posture_before b, pg_proc p WHERE p.oid = to_regprocedure(b.sig)
              AND (p.prosecdef IS DISTINCT FROM b.prosecdef OR p.proconfig IS DISTINCT FROM b.proconfig OR pg_get_userbyid(p.proowner) IS DISTINCT FROM b.owner
                   OR p.proacl::text IS DISTINCT FROM b.acl OR p.proretset IS DISTINCT FROM b.proretset OR p.prorettype::regtype IS DISTINCT FROM b.rettype
                   OR pg_get_function_arguments(p.oid) IS DISTINCT FROM b.args)) THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE post-condition failed: owner / SECURITY / search_path / ACL / signature / return of a replaced function changed';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'ordenes_order_obligation_revision_v1' AND t.tgenabled = 'O'
        AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER ordenes_order_obligation_revision_v1 AFTER UPDATE OF totale ON public.ordenes FOR EACH ROW EXECUTE FUNCTION order_obligation_revision_v1()') <> 1 THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE post-condition failed: the totale revision trigger changed';
  END IF;
  SELECT string_agg(COALESCE(a.sig, b.sig), ', ') INTO v_bad
    FROM c151_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE regexp_replace(COALESCE(a.sig, b.sig), '^public\.', '') NOT IN ('order_economic_service_gate_v1(uuid)',
                                        'order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric)', 'order_obligation_revision_v1()')
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ECONOMIC_CLOSE_GATE post-condition failed: other functions changed (%)', v_bad;
  END IF;
END $post$;

COMMIT;
