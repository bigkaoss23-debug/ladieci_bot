-- migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql
-- Rolls migration 143 back to the EXACT pre-143 state: the trigger a0_order_intake_lock_prelude_v1 and the function
-- public.order_intake_lock_prelude_v1() are dropped. The migration created no data and changed no other object, so there is nothing else to
-- restore; the post-condition proves the trigger set and every function body of schema public are exactly what they were before 143.
--
-- REFUSES (and changes nothing) unless the object being dropped is exactly the one migration 143 created: the trigger is the expected
-- BEFORE INSERT FOR EACH ROW trigger calling the prelude, and the prelude body is the pinned 143 body (a divergent body means somebody
-- changed it after 143 -- resolve drift first, never drop silently).
-- ORDER: independent of migration 144 (order_cancel_v1 W-first); either can be rolled back first.
-- STAGING ONLY. NOT applied by the session that authored it.

BEGIN;

DO $guard$
DECLARE
  v_fn oid := to_regprocedure('public.order_intake_lock_prelude_v1()');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'C8_PRELUDE rollback refused: public.order_intake_lock_prelude_v1() does not exist (migration 143 not applied?) -- resolve drift first';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM '067a9127b4ab4b5435c40ecd4c32f476' THEN
    RAISE EXCEPTION 'C8_PRELUDE rollback refused: the prelude body is not the exact 143 body (md5 mismatch) -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname = 'a0_order_intake_lock_prelude_v1'
                    AND t.tgfoid = v_fn AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 0
                    AND (t.tgtype & 16) = 0 AND (t.tgtype & 32) = 0 AND t.tgqual IS NULL AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'C8_PRELUDE rollback refused: trigger a0_order_intake_lock_prelude_v1 is missing or is not the expected BEFORE INSERT FOR EACH ROW trigger -- resolve drift first';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_fn) <> 1 THEN
    RAISE EXCEPTION 'C8_PRELUDE rollback refused: the prelude function is used by a trigger other than the expected one -- resolve drift first';
  END IF;
END $guard$;

CREATE TEMP TABLE c8143rb_trg_before (relname text, tgname name, def text, PRIMARY KEY (relname, tgname)) ON COMMIT DROP;
INSERT INTO c8143rb_trg_before
  SELECT c.relname::text, t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgname <> 'a0_order_intake_lock_prelude_v1'
     AND c.relname = ANY (ARRAY['ordenes','order_entities','order_obligations','payment_transactions','payment_allocations','order_financial_events',
       'table_sessions','table_order_lines','service_sessions','business_days','business_day_lifecycle_state','service_session_state','auth_actors','workspaces']);
CREATE TEMP TABLE c8143rb_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c8143rb_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> to_regprocedure('public.order_intake_lock_prelude_v1()');

DROP TRIGGER a0_order_intake_lock_prelude_v1 ON public.ordenes;
DROP FUNCTION public.order_intake_lock_prelude_v1();

DO $post$
DECLARE
  v_diff integer;
BEGIN
  IF to_regprocedure('public.order_intake_lock_prelude_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'a0_order_intake_lock_prelude_v1') THEN
    RAISE EXCEPTION 'C8_PRELUDE rollback post-condition failed: the prelude function or trigger still exists';
  END IF;
  SELECT count(*) INTO v_diff FROM (
    SELECT relname, tgname, def FROM c8143rb_trg_before
    EXCEPT
    SELECT c.relname::text, t.tgname, pg_get_triggerdef(t.oid)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND t.tgenabled = 'O'
  ) x;
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_PRELUDE rollback post-condition failed: % trigger(s) changed', v_diff; END IF;
  SELECT count(*) INTO v_diff FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND NOT EXISTS (SELECT 1 FROM c8143rb_fn_before f WHERE f.sig = p.oid::regprocedure::text AND f.md5 = md5(p.prosrc));
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_PRELUDE rollback post-condition failed: % function(s) of schema public differ from the before-state', v_diff; END IF;
  -- the pre-143 BEFORE INSERT order is back: the M132 capture (when present) is again the last one, mesa_prepare/assign/anchor keep their order
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'ordenes_zz_giro_intent_capture_v1')
     AND (SELECT max(t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
            AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4) IS DISTINCT FROM 'ordenes_zz_giro_intent_capture_v1'::name THEN
    RAISE EXCEPTION 'C8_PRELUDE rollback post-condition failed: the M132 capture trigger is not the last BEFORE INSERT trigger';
  END IF;
END $post$;

COMMIT;
