-- migrations/2026-09-25_close_attempt_atomic_completion_v1_migration_149.ROLLBACK.sql
-- Rollback of migration 149: drops the two deferred constraint triggers and the three functions it created. Nothing else existed before 149 for
-- them to restore (close_service_session_v3 and complete_closeout_attempt were never modified). Refuses unless every 149 object is exactly the
-- certified one. Roll back 149 FIRST (before 148 ...). A backend that calls close_service_session_and_complete_attempt_v1 must be rolled back
-- BEFORE this file runs (after it, that RPC no longer exists and such a backend's Finalizar fails closed: the service stays open).
BEGIN;

DO $guard$
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)')) IS DISTINCT FROM 'f53a677bf72aebdec2ce90eea8a81668'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.service_session_close_attempt_terminal_v1()')) IS DISTINCT FROM 'c3e18316e5375981061e57b25cdf8915'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.service_closeout_attempt_open_service_v1()')) IS DISTINCT FROM 'aff9e7d796c3b4fd19267ac5f946ac31' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC rollback refused: a 149 function is missing or is not the certified 149 body -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND ((t.tgname = 'service_sessions_close_attempt_terminal_v1' AND t.tgrelid = 'public.service_sessions'::regclass
               AND t.tgfoid = to_regprocedure('public.service_session_close_attempt_terminal_v1()'))
           OR (t.tgname = 'service_closeout_attempts_open_service_v1' AND t.tgrelid = 'public.service_closeout_attempts'::regclass
               AND t.tgfoid = to_regprocedure('public.service_closeout_attempt_open_service_v1()')))) <> 2 THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC rollback refused: the two 149 triggers are not both present on their tables -- resolve drift first';
  END IF;
END $guard$;

CREATE TEMP TABLE r149_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO r149_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema';

DROP TRIGGER service_sessions_close_attempt_terminal_v1 ON public.service_sessions;
DROP TRIGGER service_closeout_attempts_open_service_v1 ON public.service_closeout_attempts;
DROP FUNCTION public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text);
DROP FUNCTION public.service_session_close_attempt_terminal_v1();
DROP FUNCTION public.service_closeout_attempt_open_service_v1();

DO $post$
DECLARE
  v_bad text;
BEGIN
  IF to_regprocedure('public.close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)') IS NOT NULL
     OR to_regprocedure('public.service_session_close_attempt_terminal_v1()') IS NOT NULL
     OR to_regprocedure('public.service_closeout_attempt_open_service_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgname IN ('service_sessions_close_attempt_terminal_v1', 'service_closeout_attempts_open_service_v1')) THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC rollback post-condition failed: a 149 object is still present';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)')) IS DISTINCT FROM 'a6680181760dd8dabfa29aa43c786906'
     OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure('public.complete_closeout_attempt(uuid,text)')) IS DISTINCT FROM 'f96adc7871c50751fdd7a4b1aebf3783' THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC rollback post-condition failed: close_service_session_v3 / complete_closeout_attempt changed';
  END IF;
  SELECT string_agg(COALESCE(a.sig, b.sig), ', ') INTO v_bad
    FROM r149_fn_before b
    FULL JOIN (SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema') a ON a.sig = b.sig
   WHERE regexp_replace(COALESCE(a.sig, b.sig), '^public\.', '') NOT IN ('close_service_session_and_complete_attempt_v1(uuid,uuid,text,text)', 'service_session_close_attempt_terminal_v1()', 'service_closeout_attempt_open_service_v1()')
     AND (a.sig IS NULL OR b.sig IS NULL OR a.md5 IS DISTINCT FROM b.md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'CLOSE_ATTEMPT_ATOMIC rollback post-condition failed: other functions changed (%)', v_bad;
  END IF;
END $post$;

COMMIT;
