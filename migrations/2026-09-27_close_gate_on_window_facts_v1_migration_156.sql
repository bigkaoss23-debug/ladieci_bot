-- migrations/2026-09-27_close_gate_on_window_facts_v1_migration_156.sql
-- Paired rollback: 2026-09-27_close_gate_on_window_facts_v1_migration_156.ROLLBACK.sql
--
-- ECONOMY BASE -- FINAL LIVENESS GATE, BOUNDED F2 RESIDUAL. STAGING CANDIDATE ONLY; not applied by the session that authored it.
-- Evidence: ~/Downloads/ECONOMY_FINAL_LIVENESS_GATE_REPORT_2026-09-27.md.
--
-- DEFECT (bounded F2 residual, reproduced): the terminal close step (154) re-checks the Business Day digest under its lock prefix
-- (lifecycle -> driver -> pointer FOR UPDATE) and persists the reconciliation in the same transaction. Every writer of a digest input is
-- serialized by that prefix EXCEPT two facts: (1) a cash count (cash_counts, inserted by the Economía "Control de Caja" backend with a plain
-- table INSERT) and (2) a legacy financial event (order_financial_events, inserted by the /api/financial legacy import / refund writers,
-- order_import_legacy_payment / order_refund, which take no lifecycle lock; mounted only when AUTH_V2_FINANCIAL_HTTP_ENABLED = 'true').
-- Committed between the re-check and the close commit, each left a permanently stale reconciliation (reproduced: a current cash count
-- committed before the reconciliation but not attached; a legacy refund of 11.00 / a legacy import of 11.00 missing from its receipts).
--
-- FIX (the minimal one: the FACT is serialized, not the digest widened, no writer body changed): ONE trigger function and TWO triggers,
-- BEFORE INSERT on order_financial_events and on cash_counts, that take the canonical close gate -- the pointer row FOR SHARE, the very
-- primitive every money writer already takes (re-entrant for them). Named a0_ so it fires before every other BEFORE INSERT trigger of the
-- table (order_financial_events: before financial_event_assign_service_session, which then reads the pointer under the same lock).
-- Lock order: a writer that did not hold the gate now takes it last (legacy writers: ACTOR -> ORDER -> pointer, the money writers' order);
-- a close / open holds the pointer FOR UPDATE but never waits on an actor / order / workspace row, so no cycle is possible.
-- No table / column / constraint change, no data change; no signature change anywhere (every backend window behaves the same, a cash count
-- or legacy event issued during a close simply waits for it: milliseconds).
-- ROLLOUT: after 155 (chain ... -> 154 -> 155 -> 156). ROLLBACK: drops the two triggers and the function; valid at any time.

BEGIN;

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) IS DISTINCT FROM 'baa7e42e28b15565e93f5da66374a6a9'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])')) IS DISTINCT FROM 'b5823fc5417a92007295efe531a899f0'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])')) IS DISTINCT FROM '4f39a046a0c4f04ef4ea5cc548328f03'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')) IS DISTINCT FROM '2a59a168d43c398d9e34d3ae651d1ea4'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'c57584ba03c40ee940e402188fd40d2d'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.service_close_day_evidence_digest_v1(timestamp with time zone,timestamp with time zone)')) IS DISTINCT FROM 'f637aa2eaa3baec55bf7e88332d3d345' THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT refused: migrations 154 and 155 are not applied with their certified bodies -- the chain is ... -> 154 -> 155 -> 156';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'close_gate_window_fact_insert_v1')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a0_close_gate_window_fact_v1') THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT refused: already applied';
  END IF;
  IF to_regclass('public.order_financial_events') IS NULL OR to_regclass('public.cash_counts') IS NULL OR to_regclass('public.service_session_state') IS NULL THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT refused: a required table is missing';
  END IF;
END $guard$;

CREATE FUNCTION public.close_gate_window_fact_insert_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The canonical close / open gate (145 payments, 146 refunds, 151 obligation revisions): the pointer row held FOR SHARE from here to
  -- commit. A close (close_service_session_with_evidence_v1) holds it FOR UPDATE from before it re-checks the Business Day digest until it
  -- commits, so a new fact of the window can no longer commit between that re-check and the close commit: it commits after the close
  -- (a later fact of the day), or -- if it held the gate first -- before the re-check, which then sees it. Re-entrant for every writer that
  -- already holds it (every money writer), so their behaviour is unchanged.
  PERFORM 1 FROM public.service_session_state WHERE singleton = true FOR SHARE;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.close_gate_window_fact_insert_v1() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.order_financial_events FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1();
CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.cash_counts FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1();

DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_gate_window_fact_insert_v1()')) IS DISTINCT FROM '6ed381c0bcfa60fb48250c5dbb63ef2c'
     OR (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'public.order_financial_events'::regclass AND t.tgname = 'a0_close_gate_window_fact_v1')
        IS DISTINCT FROM 'CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.order_financial_events FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1()'
     OR (SELECT pg_get_triggerdef(t.oid) FROM pg_trigger t WHERE t.tgrelid = 'public.cash_counts'::regclass AND t.tgname = 'a0_close_gate_window_fact_v1')
        IS DISTINCT FROM 'CREATE TRIGGER a0_close_gate_window_fact_v1 BEFORE INSERT ON public.cash_counts FOR EACH ROW EXECUTE FUNCTION close_gate_window_fact_insert_v1()' THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT post-condition failed: function or triggers differ from the certified text';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.start_rider_trip_v2(uuid,text,integer,uuid[])')) IS DISTINCT FROM 'baa7e42e28b15565e93f5da66374a6a9'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_create_or_move_v1(uuid[],text,uuid,text,uuid[])')) IS DISTINCT FROM 'b5823fc5417a92007295efe531a899f0'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_attach_or_move_v1(text,uuid,text,uuid[])')) IS DISTINCT FROM '4f39a046a0c4f04ef4ea5cc548328f03'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.giro_authority_consume_intent_v1(uuid,text,uuid[])')) IS DISTINCT FROM '2a59a168d43c398d9e34d3ae651d1ea4'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.close_service_session_with_evidence_v1(uuid,uuid,text,text,jsonb,jsonb,uuid[])')) IS DISTINCT FROM 'c57584ba03c40ee940e402188fd40d2d'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.service_close_day_evidence_digest_v1(timestamp with time zone,timestamp with time zone)')) IS DISTINCT FROM 'f637aa2eaa3baec55bf7e88332d3d345' THEN
    RAISE EXCEPTION 'CLOSE_GATE_WINDOW_FACT post-condition failed: a 154 / 155 body changed';
  END IF;
END $post$;

COMMIT;
