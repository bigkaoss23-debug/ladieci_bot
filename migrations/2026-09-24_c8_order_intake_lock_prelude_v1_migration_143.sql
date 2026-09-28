-- migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.sql
-- C8 LOCK-ORDER FIX, part A (DELIVERY x ECONOMIA V1, 2026-09-24): ORDER INTAKE LOCK PRELUDE.
--
-- WHY. The real-body deadlock audit (DELIVERY_ECONOMY_V1_C8_REAL_BODY_DEADLOCK_AUDIT_2026-09-24.md) proved a REAL_DEADLOCK on the
-- staging function bodies: an order INSERT acquires its locks in an order that inverts the writers' order
--   intake (today):  [TS FOR UPDATE] -> L -> SS FOR UPDATE -> D FOR NO KEY UPDATE -> W (KEY SHARE, FOR UPDATE if paid) -> [actor FOR UPDATE]
--   every writer:    L -> W FOR UPDATE -> ACTOR FOR UPDATE -> TABLE_SESSION -> {ENTITY, ORDER, PT_ORIGINAL} -> service / business-day rows
-- (L = pg_advisory_xact_lock(hashtext('service_session_lifecycle')), W = workspaces row, ACTOR = auth_actors (workspace_id, actor),
-- TS = table_sessions, SS = service_sessions, D = business_days). Nothing here changes an economic rule; the two orders simply disagree, so
-- two concurrent transactions can wait for each other (SQLSTATE 40P01). The design that closes it is frozen in
-- DELIVERY_ECONOMY_V1_C8_FIX_DESIGN_CLOSURE_2026-09-24.md (§23, M-C8a).
--
-- WHAT. ONE new object pair, no existing body touched:
--   * public.order_intake_lock_prelude_v1()  -- trigger function (plpgsql, SECURITY INVOKER, search_path public,pg_temp, owner postgres,
--                                               EXECUTE for service_role only, exactly the posture of every other trigger function of the graph)
--   * TRIGGER a0_order_intake_lock_prelude_v1 BEFORE INSERT ON public.ordenes FOR EACH ROW (no WHEN) -- the name sorts before every other
--     BEFORE INSERT trigger of the table (PostgreSQL fires triggers of the same kind alphabetically), so it runs FIRST: before
--     mesa_prepare_table_order_v1 (TS), ordenes_assign_service_session (resolver: SS/D), ordenes_order_entity_anchor_v1, and
--     ordenes_zz_giro_intent_capture_v1 (which stays LAST, M132 invariant).
-- The prelude takes, in this order and nothing else:
--   1. L                       pg_advisory_xact_lock(hashtext('service_session_lifecycle')) (re-entrant: the resolver takes it again)
--   2. W  FOR UPDATE           the workspace of the order, resolved with the SAME authority as order_entity_anchor_v1: table_sessions.workspace_id
--                              (plain read, no row lock) for a Mesa order, mesa_singleton_workspace_v1() for every other channel. Mode is FOR UPDATE
--                              for ALL intakes (the same mode the writers take); never KEY SHARE, so there is no KEY SHARE -> FOR UPDATE upgrade.
--   3. ACTOR FOR UPDATE        only when initial_payment_intent is present: the row (workspace_id = W, actor = btrim(intent->>'actor')) that
--                              order_initial_payment_v1 -> order_post_payment_v1 will lock later with the identical predicate. Nothing is decided here.
-- The prelude performs no payment, no authorization and no write. It does not mask any typed error: an unresolvable table session takes no
-- W lock and the canonical MESA_SESSION_NOT_FOUND is raised later by mesa_prepare_table_order_v1 exactly as before; an ambiguous singleton
-- (MESA_WORKSPACE_AMBIGUOUS, only when workspaces <> 1) takes no W lock and is raised later by the entity anchor at its usual precedence.
--
-- NOT TOUCHED (frozen): resolve_order_intake_context_v1, mesa_prepare_table_order_v1, order_entity_anchor_v1, order_initial_payment_v1,
-- order_post_payment_v1, mesa_post_payment_v1, refund / commercial-adjustment writers, the rider RPC, operator_confirm_delivery_v1,
-- close_service_session_v3, open_operational_service_v1, order_cancel_v1 (that is migration 144). No data, grant-model, table, column, index,
-- constraint or Fiscal Core change. No dependency on migration 141 / 142.
--
-- DRIFT GUARDS (fail closed, nothing is created if any fails): the prelude aligns with four staging bodies -- order_entity_anchor_v1,
-- mesa_singleton_workspace_v1, mesa_prepare_table_order_v1 and order_initial_payment_v1 are pinned by md5(prosrc); no BEFORE INSERT ROW trigger of
-- public.ordenes may sort at or before the new name; if the M132 capture trigger exists it must still be the LAST BEFORE INSERT trigger afterwards.
-- The resolver is deliberately NOT pinned (a later migration changes it; the prelude does not depend on its text, only on L being re-entrant).
--
-- ROLLBACK: migrations/2026-09-24_c8_order_intake_lock_prelude_v1_migration_143.ROLLBACK.sql (DROP TRIGGER + DROP FUNCTION; no data to restore).
-- STAGING ONLY. NOT applied by the session that authored it.

BEGIN;

-- 0. Preconditions and drift guards --------------------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_src text;
  v_pin record;
BEGIN
  IF to_regprocedure('public.order_intake_lock_prelude_v1()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'a0_order_intake_lock_prelude_v1') THEN
    RAISE EXCEPTION 'C8_PRELUDE refused: already applied (function or trigger exists) -- resolve drift first';
  END IF;
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.order_entity_anchor_v1()',        '3db9189218204ad2488cff64fd55eb9c'),
      ('public.mesa_singleton_workspace_v1()',   '7f431effcabf52dc541f5456dcdf7f28'),
      ('public.mesa_prepare_table_order_v1()',   '50c48c3083e106b586940f29f9640fab'),
      ('public.order_initial_payment_v1()',      'e397b66e3aabe66a123a5356c825f124')
    ) AS t(sig, want)
  LOOP
    IF to_regprocedure(v_pin.sig) IS NULL THEN
      RAISE EXCEPTION 'C8_PRELUDE refused: % is missing -- resolve drift first', v_pin.sig;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
    IF md5(v_src) IS DISTINCT FROM v_pin.want THEN
      RAISE EXCEPTION 'C8_PRELUDE refused: % is not the pinned staging body (md5 mismatch) -- the prelude must be re-verified against it; resolve drift first', v_pin.sig;
    END IF;
  END LOOP;
  IF to_regclass('public.workspaces') IS NULL OR to_regclass('public.auth_actors') IS NULL OR to_regclass('public.table_sessions') IS NULL THEN
    RAISE EXCEPTION 'C8_PRELUDE refused: workspaces / auth_actors / table_sessions missing -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
                AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
                AND t.tgname <= 'a0_order_intake_lock_prelude_v1'::name) THEN
    RAISE EXCEPTION 'C8_PRELUDE refused: a BEFORE INSERT trigger of public.ordenes already sorts at or before the prelude -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'ordenes_zz_giro_intent_capture_v1')
     AND (SELECT max(t.tgname) FROM pg_trigger t
           WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
             AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4)
        IS DISTINCT FROM 'ordenes_zz_giro_intent_capture_v1'::name THEN
    RAISE EXCEPTION 'C8_PRELUDE refused: the M132 capture trigger is not the last BEFORE INSERT trigger of public.ordenes -- resolve drift first';
  END IF;
END $guard$;

-- Before-state: every trigger of the graph (the post-condition proves the prelude is the ONLY addition) and the pinned bodies.
CREATE TEMP TABLE c8143_trg_before (relname text, tgname name, def text, PRIMARY KEY (relname, tgname)) ON COMMIT DROP;
INSERT INTO c8143_trg_before
  SELECT c.relname::text, t.tgname, pg_get_triggerdef(t.oid)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
     AND c.relname = ANY (ARRAY['ordenes','order_entities','order_obligations','payment_transactions','payment_allocations','order_financial_events',
       'table_sessions','table_order_lines','service_sessions','business_days','business_day_lifecycle_state','service_session_state','auth_actors','workspaces']);
CREATE TEMP TABLE c8143_fn_before (sig text PRIMARY KEY, md5 text) ON COMMIT DROP;
INSERT INTO c8143_fn_before
  SELECT p.oid::regprocedure::text, md5(p.prosrc) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace;

-- 1. The prelude function -------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION public.order_intake_lock_prelude_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_workspace uuid;
  v_actor     text;
BEGIN
  -- L: the lifecycle lock is the first lock of every economic writer; the resolver takes it again later (advisory xact locks are re-entrant).
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  -- W authority: identical to order_entity_anchor_v1 (table session -> its workspace; every other channel -> the singleton workspace).
  -- Nothing is decided and nothing is masked here: an unresolved workspace simply means "no W lock", and the canonical typed error
  -- (MESA_SESSION_NOT_FOUND / MESA_WORKSPACE_AMBIGUOUS) is raised later by the same code that raises it today.
  IF NEW.table_session_id IS NOT NULL THEN
    SELECT ts.workspace_id INTO v_workspace
      FROM public.table_sessions ts WHERE ts.id = NEW.table_session_id;           -- plain read: no row lock on the table session
  ELSE
    BEGIN
      v_workspace := public.mesa_singleton_workspace_v1();
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM IS DISTINCT FROM 'MESA_WORKSPACE_AMBIGUOUS' THEN RAISE; END IF;
      v_workspace := NULL;
    END;
  END IF;
  IF v_workspace IS NULL THEN RETURN NEW; END IF;

  -- W FOR UPDATE for every intake (the mode every writer takes): no KEY SHARE, therefore no KEY SHARE -> FOR UPDATE upgrade later.
  PERFORM 1 FROM public.workspaces WHERE id = v_workspace FOR UPDATE;

  -- ACTOR hoist, only when the order is created already paid: the same row, with the same predicate and expression, that
  -- order_initial_payment_v1 -> order_post_payment_v1 lock later. Authorization is NOT evaluated here; that stays in the payment writer.
  IF NEW.initial_payment_intent IS NOT NULL THEN
    v_actor := btrim(COALESCE(NEW.initial_payment_intent ->> 'actor', ''));
    IF v_actor <> '' THEN
      PERFORM 1 FROM public.auth_actors WHERE workspace_id = v_workspace AND actor = v_actor FOR UPDATE;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.order_intake_lock_prelude_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.order_intake_lock_prelude_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_intake_lock_prelude_v1() TO service_role;

-- 2. The trigger: first BEFORE INSERT trigger of ordenes ------------------------------------------------------------------------------------
CREATE TRIGGER a0_order_intake_lock_prelude_v1
  BEFORE INSERT ON public.ordenes
  FOR EACH ROW
  EXECUTE FUNCTION public.order_intake_lock_prelude_v1();

-- 3. Post-conditions --------------------------------------------------------------------------------------------------------------------------
DO $post$
DECLARE
  v_fn     oid := to_regprocedure('public.order_intake_lock_prelude_v1()');
  v_first  name;
  v_before integer;
  v_after  integer;
  v_diff   integer;
BEGIN
  IF v_fn IS NULL THEN RAISE EXCEPTION 'C8_PRELUDE post-condition failed: function missing'; END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM '067a9127b4ab4b5435c40ecd4c32f476' THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: prelude body md5 mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = v_fn AND p.pronamespace = 'public'::regnamespace AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
                    AND p.prorettype = 'trigger'::regtype AND p.prosecdef IS FALSE AND p.proowner = 'postgres'::regrole
                    AND p.proconfig = ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: function posture (language / trigger / SECURITY INVOKER / owner / search_path) wrong';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid = v_fn AND a.grantee = 0) THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: EXECUTE must be granted to service_role only';
  END IF;
  -- trigger shape: BEFORE INSERT, FOR EACH ROW, no WHEN, enabled, calls the prelude
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname = 'a0_order_intake_lock_prelude_v1'
                    AND t.tgfoid = v_fn AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4 AND (t.tgtype & 8) = 0
                    AND (t.tgtype & 16) = 0 AND (t.tgtype & 32) = 0 AND t.tgqual IS NULL AND t.tgenabled = 'O' AND NOT t.tgisinternal
                    AND t.tgattr::text = '' AND t.tgnargs = 0) THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: trigger shape wrong (must be BEFORE INSERT FOR EACH ROW, no WHEN, enabled)';
  END IF;
  -- it is the FIRST BEFORE INSERT ROW trigger of ordenes (the order PostgreSQL fires them in is by name)
  SELECT min(t.tgname) INTO v_first FROM pg_trigger t
   WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4;
  IF v_first IS DISTINCT FROM 'a0_order_intake_lock_prelude_v1'::name THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: the prelude is not the first BEFORE INSERT trigger of public.ordenes (first is %)', v_first;
  END IF;
  -- M132: the capture trigger, when present, is still the LAST BEFORE INSERT trigger
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND tgname = 'ordenes_zz_giro_intent_capture_v1')
     AND (SELECT max(t.tgname) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
            AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4) IS DISTINCT FROM 'ordenes_zz_giro_intent_capture_v1'::name THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: the M132 capture trigger is no longer the last BEFORE INSERT trigger';
  END IF;
  -- the prelude is the ONLY trigger added and no existing trigger changed
  SELECT count(*) INTO v_before FROM c8143_trg_before;
  SELECT count(*) INTO v_after FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND NOT t.tgisinternal
     AND c.relname = ANY (ARRAY['ordenes','order_entities','order_obligations','payment_transactions','payment_allocations','order_financial_events',
       'table_sessions','table_order_lines','service_sessions','business_days','business_day_lifecycle_state','service_session_state','auth_actors','workspaces']);
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: trigger count % -> % (expected +1)', v_before, v_after;
  END IF;
  SELECT count(*) INTO v_diff FROM c8143_trg_before b
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                      WHERE c.relname::text = b.relname AND t.tgname = b.tgname AND pg_get_triggerdef(t.oid) = b.def AND t.tgenabled = 'O');
  IF v_diff <> 0 THEN
    RAISE EXCEPTION 'C8_PRELUDE post-condition failed: % pre-existing trigger(s) changed or disabled', v_diff;
  END IF;
  -- no other function of schema public changed (the only new one is the prelude)
  SELECT count(*) INTO v_diff FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.oid <> v_fn
     AND NOT EXISTS (SELECT 1 FROM c8143_fn_before f WHERE f.sig = p.oid::regprocedure::text AND f.md5 = md5(p.prosrc));
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_PRELUDE post-condition failed: % other function(s) of schema public changed', v_diff; END IF;
  SELECT count(*) INTO v_diff FROM c8143_fn_before f
   WHERE NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid::regprocedure::text = f.sig);
  IF v_diff <> 0 THEN RAISE EXCEPTION 'C8_PRELUDE post-condition failed: % function(s) of schema public disappeared', v_diff; END IF;
END $post$;

COMMIT;
