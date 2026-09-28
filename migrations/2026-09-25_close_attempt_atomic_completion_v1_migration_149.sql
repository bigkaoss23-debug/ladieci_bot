-- migrations/2026-09-25_close_attempt_atomic_completion_v1_migration_149.sql
-- Paired rollback: 2026-09-25_close_attempt_atomic_completion_v1_migration_149.ROLLBACK.sql
--
-- R4B -- FINALIZAR: TERMINAL CLOSE AND ATTEMPT COMPLETION IN ONE TRANSACTION (DELIVERY x ECONOMIA V1, 2026-09-25). STAGING CANDIDATE ONLY; not
-- applied by the session that authored it. Evidence: ~/Downloads/DELIVERY_ECONOMY_V1_R4B_FINALIZAR_IDENTITY_ATOMIC_2026-09-25.md.
--
-- THE DEFECT. The V3 close ran the terminal transition (close_service_session_v3) and the attempt completion (complete_closeout_attempt) as
-- TWO transactions. A crash, a lost response or a failed call between them left a CLOSED service whose closeout attempt stayed ACTIVE, while
-- Finalizar still answered V3_CLOSED (Phase G was non-fatal). Once the next service opened, nothing ever pointed back at that attempt.
--
-- THE FIX (three objects, no table / column / index / constraint / data change; close_service_session_v3 and complete_closeout_attempt are
-- NOT modified -- the new function calls them, pinned to their certified bodies):
--   1. public.close_service_session_and_complete_attempt_v1(p_service_session_id, p_closeout_correlation_id, p_closed_by, p_source)
--      the ONE terminal step of the V3 close. It refuses (no write) unless the close's own evidence already exists under THIS correlation for
--      THIS service (snapshot + reconciliation), then runs close_service_session_v3 and complete_closeout_attempt in the SAME transaction. If the
--      completion is refused (e.g. the attempt was superseded meanwhile) the close is rolled back with it: the service stays open and the answer
--      is ATTEMPT_COMPLETION_REFUSED. ALREADY_CLOSED is answered as success ONLY when this exact attempt is already completed; a closed service
--      whose attempt is still active (history from before this migration) answers CLOSED_ATTEMPT_NOT_COMPLETED, and the engine's CASE D
--      completes it from its own close facts.
--   2. CONSTRAINT TRIGGER service_sessions_close_attempt_terminal_v1 (service_sessions, AFTER UPDATE OF status, DEFERRABLE INITIALLY DEFERRED):
--      a transaction that moves a service to 'closed' cannot COMMIT while an attempt of that service is still 'active'. Any writer, not only
--      the V3 engine: a close that leaves its attempt active is refused as a whole.
--   3. CONSTRAINT TRIGGER service_closeout_attempts_open_service_v1 (service_closeout_attempts, AFTER INSERT, DEFERRABLE INITIALLY DEFERRED):
--      an ACTIVE attempt cannot be committed for a service that is 'closed' (the second Finalizar racing a close that just completed). It takes
--      FOR SHARE on the service row, so it waits for a concurrent close and judges its committed result.
-- Together 2 + 3 make "service closed AND attempt active" impossible to COMMIT from now on, whoever writes. Rows already in that state before
-- this migration are not touched (no data change): they are completed by the engine's CASE D (R4), from their own close facts.
--
-- LOCK ORDER. Function 1 takes exactly the locks of close_service_session_v3 (lifecycle advisory -> L0 -> service_session_state ->
-- service_sessions -> business_day_lifecycle_state) and THEN the attempt row (complete_closeout_attempt, FOR UPDATE): the same order the
-- previous two-transaction sequence had. Trigger 2 takes no lock. Trigger 3 takes FOR SHARE on one service_sessions row at COMMIT of an
-- attempt INSERT and holds nothing that a close waits for.
--
-- ROLLOUT: 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148 -> 149, then the backend that calls function 1 (the backend of the same package).
-- Between this migration and that deploy, a Finalizar through the previous backend fails CLOSED (trigger 2 rolls its terminal close back; the
-- service stays open) and succeeds on the first retry after the deploy (CASE B resume through function 1). ROLLBACK ORDER: 149 FIRST.
-- DRIFT GUARDS (fail closed): the two functions it calls are the pinned bodies; the chain tip is 148 (order_post_payment_v1 = the 148 body);
-- the tables / columns / active-attempt index it relies on exist; nothing of it exists yet.
-- POST-CONDITIONS: md5 pins of the three new bodies; the two triggers with their exact definition; ACL (service_role only) / SECURITY INVOKER /
-- search_path of function 1; close_service_session_v3 and complete_closeout_attempt unchanged; every other function of every user schema
-- byte-identical.
BEGIN;

-- 0. Preconditions and drift guards ---------------------------------------------------------------------------------------------------------------
DO $guard$
BEGIN
  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)')) IS DISTINCT FROM 'a6680181760dd8dabfa29aa43c786906' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: close_service_session_v3 is not the 139 body a6680181760dd8dabfa29aa43c786906 -- resolve drift first';
  END IF;
  IF to_regprocedure('public.complete_closeout_attempt(uuid,text)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.complete_closeout_attempt(uuid,text)')) IS DISTINCT FROM 'f96adc7871c50751fdd7a4b1aebf3783' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: complete_closeout_attempt is not the certified body f96adc7871c50751fdd7a4b1aebf3783 -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('close_service_session_v3', 'complete_closeout_attempt')) <> 2 THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: close_service_session_v3 / complete_closeout_attempt have an unexpected overload set -- resolve drift first';
  END IF;
  IF to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)') IS NULL
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.order_post_payment_v1(uuid,text,text,uuid,text,text,numeric,text,text,jsonb,boolean)')) IS DISTINCT FROM 'e1ce2229f2418d6a7f91fe50771564f8' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: the chain tip is not 148 (order_post_payment_v1 is not the 148 body e1ce2229f2418d6a7f91fe50771564f8) -- the rollout is 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148 -> 149';
  END IF;
  IF to_regclass('public.service_sessions') IS NULL OR to_regclass('public.service_closeout_attempts') IS NULL
     OR to_regclass('public.service_closeout_snapshots') IS NULL OR to_regclass('public.service_closeout_reconciliations') IS NULL
     OR to_regclass('public.service_closeout_attempts_active_uq') IS NULL THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: the closeout substrate (service_sessions, service_closeout_attempts + its active index, snapshots, reconciliations) is incomplete -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE NOT a.attisdropped AND a.attnum > 0
         AND ((a.attrelid = 'public.service_closeout_snapshots'::regclass AND a.attname IN ('closeout_correlation_id', 'service_session_id'))
           OR (a.attrelid = 'public.service_closeout_reconciliations'::regclass AND a.attname IN ('closeout_correlation_id', 'service_session_id'))
           OR (a.attrelid = 'public.service_closeout_attempts'::regclass AND a.attname IN ('closeout_correlation_id', 'service_session_id', 'status'))
           OR (a.attrelid = 'public.service_sessions'::regclass AND a.attname IN ('id', 'status')))) <> 9 THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: a column this migration reads is missing -- resolve drift first';
  END IF;
  IF to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.service_session_close_attempt_terminal_v1()') IS NOT NULL
     OR to_regprocedure('public.service_closeout_attempt_open_service_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname IN ('service_sessions_close_attempt_terminal_v1', 'service_closeout_attempts_open_service_v1')) THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC refused: already applied (an object of migration 149 already exists)';
  END IF;
END $guard$;

-- Before-state: every function of every user schema (the post-conditions prove nothing else moved).
CREATE TEMP TABLE c149_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c149_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';

-- 1. The terminal step: close + attempt completion, one transaction ----------------------------------------------------------------------------
CREATE FUNCTION public.close_service_session_and_complete_attempt_v1(p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_close   jsonb;
  v_done    jsonb;
  v_attempt public.service_closeout_attempts%ROWTYPE;
  v_missing text[] := ARRAY[]::text[];
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

  -- The close's own evidence must already exist under THIS correlation for THIS service. Both rows are append-only, so the check cannot be
  -- invalidated before the close below; it guarantees that every service closed from now on can be proven from its own facts.
  IF NOT EXISTS (SELECT 1 FROM public.service_closeout_snapshots
                  WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id) THEN
    v_missing := v_missing || 'snapshot'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_closeout_reconciliations
                  WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id) THEN
    v_missing := v_missing || 'reconciliation'::text;
  END IF;
  IF cardinality(v_missing) > 0 THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSE_EVIDENCE_INCOMPLETE','missing',to_jsonb(v_missing));
  END IF;

  BEGIN
    v_close := public.close_service_session_v3(p_service_session_id, p_closeout_correlation_id, p_closed_by, p_source);
    IF (v_close->>'ok') = 'true' AND (v_close->>'code') = 'V3_CLOSED' THEN
      v_done := public.complete_closeout_attempt(p_closeout_correlation_id, p_closed_by);
      IF (v_done->>'ok') IS DISTINCT FROM 'true' OR (v_done->>'code') IS DISTINCT FROM 'COMPLETED' THEN
        RAISE EXCEPTION 'close attempt completion refused' USING ERRCODE = 'LD149';
      END IF;
    END IF;
  EXCEPTION WHEN SQLSTATE 'LD149' THEN
    -- the close above is rolled back with it: the service stays open, the attempt keeps its state
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_COMPLETION_REFUSED','completion',v_done);
  END;

  IF (v_close->>'ok') IS DISTINCT FROM 'true' THEN
    RETURN v_close;
  END IF;

  IF (v_close->>'code') = 'ALREADY_CLOSED' THEN
    SELECT * INTO v_attempt FROM public.service_closeout_attempts
     WHERE closeout_correlation_id = p_closeout_correlation_id AND service_session_id = p_service_session_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
    END IF;
    IF v_attempt.status <> 'completed' THEN
      RETURN jsonb_build_object('ok',false,'code','CLOSED_ATTEMPT_NOT_COMPLETED','attempt',to_jsonb(v_attempt));
    END IF;
    RETURN v_close || jsonb_build_object('attemptCompleted',true,'attempt',to_jsonb(v_attempt));
  END IF;

  RETURN v_close || jsonb_build_object('attemptCompleted',true,'attempt',v_done->'attempt');
END;
$function$;

-- 2. A service cannot be committed 'closed' while an attempt of it is still 'active' -----------------------------------------------------------
CREATE FUNCTION public.service_session_close_attempt_terminal_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM public.service_closeout_attempts a WHERE a.service_session_id = NEW.id AND a.status = 'active') THEN
    RAISE EXCEPTION 'SERVICE_CLOSED_WITH_ACTIVE_CLOSEOUT_ATTEMPT' USING ERRCODE = 'P0001',
      DETAIL = 'service ' || NEW.id::text || ' cannot be committed closed while one of its closeout attempts is still active';
  END IF;
  RETURN NULL;
END;
$function$;

-- 3. An active attempt cannot be committed for a 'closed' service ------------------------------------------------------------------------------
CREATE FUNCTION public.service_closeout_attempt_open_service_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT s.status INTO v_status FROM public.service_sessions s WHERE s.id = NEW.service_session_id FOR SHARE;
  IF v_status = 'closed' AND EXISTS (SELECT 1 FROM public.service_closeout_attempts a
                                      WHERE a.closeout_correlation_id = NEW.closeout_correlation_id AND a.status = 'active') THEN
    RAISE EXCEPTION 'CLOSEOUT_ATTEMPT_FOR_CLOSED_SERVICE' USING ERRCODE = 'P0001',
      DETAIL = 'an active closeout attempt cannot be committed for the closed service ' || NEW.service_session_id::text;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER service_sessions_close_attempt_terminal_v1
  AFTER UPDATE OF status ON public.service_sessions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed')
  EXECUTE FUNCTION public.service_session_close_attempt_terminal_v1();

CREATE CONSTRAINT TRIGGER service_closeout_attempts_open_service_v1
  AFTER INSERT ON public.service_closeout_attempts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'active')
  EXECUTE FUNCTION public.service_closeout_attempt_open_service_v1();

REVOKE ALL ON FUNCTION public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.service_session_close_attempt_terminal_v1(), public.service_closeout_attempt_open_service_v1() FROM PUBLIC, anon, authenticated;

-- 4. Post-conditions --------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_bad text;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)')) IS DISTINCT FROM 'f53a677bf72aebdec2ce90eea8a81668'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.service_session_close_attempt_terminal_v1()')) IS DISTINCT FROM 'c3e18316e5375981061e57b25cdf8915'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.service_closeout_attempt_open_service_v1()')) IS DISTINCT FROM 'aff9e7d796c3b4fd19267ac5f946ac31' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC post-condition failed: a 149 function body is not the certified one';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)')) IS DISTINCT FROM 'a6680181760dd8dabfa29aa43c786906'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.complete_closeout_attempt(uuid,text)')) IS DISTINCT FROM 'f96adc7871c50751fdd7a4b1aebf3783' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC post-condition failed: close_service_session_v3 / complete_closeout_attempt changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)')
                  AND NOT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
                  AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
                  AND has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC post-condition failed: close_service_session_and_complete_attempt_v1 must be SECURITY INVOKER, search_path public, pg_temp, EXECUTE for service_role only';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled = 'O'
         AND ((t.tgname = 'service_sessions_close_attempt_terminal_v1' AND t.tgrelid = 'public.service_sessions'::regclass
               AND t.tgfoid = to_regprocedure('public.service_session_close_attempt_terminal_v1()')
               AND pg_get_triggerdef(t.oid) = 'CREATE CONSTRAINT TRIGGER service_sessions_close_attempt_terminal_v1 AFTER UPDATE OF status ON public.service_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.status = ''closed''::text) AND (old.status IS DISTINCT FROM ''closed''::text))) EXECUTE FUNCTION service_session_close_attempt_terminal_v1()')
           OR (t.tgname = 'service_closeout_attempts_open_service_v1' AND t.tgrelid = 'public.service_closeout_attempts'::regclass
               AND t.tgfoid = to_regprocedure('public.service_closeout_attempt_open_service_v1()')
               AND pg_get_triggerdef(t.oid) = 'CREATE CONSTRAINT TRIGGER service_closeout_attempts_open_service_v1 AFTER INSERT ON public.service_closeout_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.status = ''active''::text)) EXECUTE FUNCTION service_closeout_attempt_open_service_v1()'))) <> 2 THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC post-condition failed: the two deferred constraint triggers are not installed exactly as certified';
  END IF;
  SELECT string_agg(COALESCE(a.sig, b.sig), ', ') INTO v_bad
    FROM c149_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE regexp_replace(COALESCE(a.sig, b.sig), '^public\.', '') NOT IN ('close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)', 'service_session_close_attempt_terminal_v1()', 'service_closeout_attempt_open_service_v1()')
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC post-condition failed: other functions changed (%)', v_bad;
  END IF;
END $post$;

COMMIT;
