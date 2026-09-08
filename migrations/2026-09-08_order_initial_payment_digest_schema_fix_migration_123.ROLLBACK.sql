-- migrations/2026-09-08_order_initial_payment_digest_schema_fix_migration_123.ROLLBACK.sql
-- Reverses 2026-09-08_order_initial_payment_digest_schema_fix_migration_123.sql
-- exactly, and ONLY that -- restores order_initial_payment_v1 to the
-- currently-installed migration-122 body (the unqualified `digest(...)`
-- call), nothing else.
--
-- ROLLBACK_RESTORES_KNOWN_BROKEN_M122_YA_PAGADO_BEHAVIOR
--
-- Running this file puts `order_initial_payment_v1` back into the EXACT
-- state proven broken by the 2026-09-08 forensic audit
-- (FORENSIC_YA_PAGADO_CREATION_FAILURE_M122_2026-09-08.md): every
-- creation-time "ya pagado" order will again fail with SQLSTATE 42883
-- (undefined_function) on the unqualified `digest(...)` call, surfacing to
-- the operator as "No se pudo confirmar el pedido." This is INTENTIONAL and
-- CORRECT rollback behaviour -- exact reversibility of migration history,
-- not a new production recommendation. Do not apply this file to "fix" a
-- future, unrelated problem; it does the opposite of fixing anything.
--
-- Uses CREATE OR REPLACE -- the trigger (`ordenes_paid_at_creation_
-- payment_v1`) and the function itself are never dropped, only the
-- function's body is restored, exactly mirroring how the forward migration
-- applied the fix.

BEGIN;

-- ── PRE-CONDITION: refuse unless the current state is exactly what M123
-- forward installed -- never revert an unknown or already-reverted body.
DO $guard$
DECLARE
  v_def text;
  v_search_path text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='order_initial_payment_v1'
       AND p.prorettype = 'trigger'::regtype
  ) THEN
    RAISE EXCEPTION 'M123 ROLLBACK refused: public.order_initial_payment_v1() missing or not a trigger function -- resolve drift first';
  END IF;

  SELECT array_to_string(p.proconfig, ',') INTO v_search_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';
  IF v_search_path IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'M123 ROLLBACK refused: order_initial_payment_v1 search_path is not the expected epoch (found: %) -- resolve drift first', v_search_path;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';

  IF position('PERFORM public.order_post_payment_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK refused: order_initial_payment_v1 does not call order_post_payment_v1 -- not at the expected M123 epoch';
  END IF;

  -- Must currently be the FIXED (schema-qualified) state -- refuses a
  -- double-rollback or reverting a body this migration never installed.
  IF position('v_request_hash := encode(extensions.digest(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK refused: order_initial_payment_v1 does not contain the extensions.digest() request-hash assignment -- already rolled back, or never fixed?';
  END IF;
  IF position('v_request_hash := encode(digest(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK refused: order_initial_payment_v1 already contains the unqualified digest() assignment -- already rolled back?';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='ordenes'
      AND t.tgname='ordenes_paid_at_creation_payment_v1' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A')
      AND t.tgfoid = 'public.order_initial_payment_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'M123 ROLLBACK refused: ordenes_paid_at_creation_payment_v1 is missing, disabled/replica-only, or no longer targets order_initial_payment_v1';
  END IF;

  PERFORM set_config('ladieci.m123rb_fn_oid',
    (SELECT p.oid::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_initial_payment_v1'), false);
  PERFORM set_config('ladieci.m123rb_public_fn_count',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'), false);
  PERFORM set_config('ladieci.m123rb_ordenes_count',
    (SELECT count(*)::text FROM public.ordenes), false);
END $guard$;

-- ── THE REVERT — restore the exact migration-122 body (unqualified digest).
-- Byte-identical to migration 122's installed function except the single
-- extensions.digest(...) -> digest(...) reversal in the request-hash
-- assignment -- the mirror image of the forward file's one-line fix.
CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := NEW.initial_payment_intent;
  v_method text;
  v_actor  text;
  v_sid_hash text;
  v_workspace_id uuid;
  v_client_request_id text;
  v_request_hash text;
BEGIN
  -- Defence in depth: the trigger is already WHEN-scoped to a non-null intent.
  IF v_intent IS NULL THEN
    RETURN NEW;
  END IF;

  -- Mesa settles through its own payment hub (payment_transactions /
  -- payment_allocations / mesa_post_payment_v1). A table order must never take a
  -- second, parallel payment here. The frontend already forbids it; this refuses
  -- it at the boundary rather than trusting that.
  IF NEW.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s table_session=%s', NEW.id, NEW.table_session_id);
  END IF;

  -- The whole point of N-3: legacy-paid authority must NOT precede the canonical
  -- payment. If either flag arrived true, someone is still trying to declare money
  -- with a boolean -- refuse rather than paper over it.
  IF NEW.ya_pagado IS TRUE OR NEW.cobrado IS TRUE THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s ya_pagado=%s cobrado=%s', NEW.id, NEW.ya_pagado, NEW.cobrado);
  END IF;

  v_method   := lower(btrim(COALESCE(v_intent->>'method', '')));
  v_actor    := btrim(COALESCE(v_intent->>'actor', ''));
  v_sid_hash := lower(btrim(COALESCE(v_intent->>'sid_hash', '')));

  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_METHOD_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s method=%s', NEW.id, v_method);
  END IF;
  IF v_actor = '' OR v_sid_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_CONTEXT_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s actor_present=%s sid_hash_valid=%s',
                      NEW.id, (v_actor <> ''), (v_sid_hash ~ '^[0-9a-f]{64}$'));
  END IF;

  SELECT oe.workspace_id INTO v_workspace_id
    FROM public.order_entities oe WHERE oe.order_uid = NEW.order_uid;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_WORKSPACE_UNRESOLVED' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s order_uid=%s', NEW.id, NEW.order_uid);
  END IF;

  -- SAME deterministic per-order key the legacy path always used -- this is what
  -- makes a replayed order-creation request replay instead of double-paying
  -- (§9/§22 of the brief): payment_transactions_idempotency_uq is (workspace_id,
  -- client_request_id), so this key now plays exactly the role
  -- registerOperatorPayment.js's idem_scope_key played for _ledger_write_payment.
  v_client_request_id := 'pay-order-' || regexp_replace(NEW.id, '[^A-Za-z0-9_-]', '', 'g');
  v_request_hash := encode(digest(concat_ws('|', 'initial_payment_at_creation', NEW.id,
    NEW.order_uid::text, v_method), 'sha256'), 'hex');

  -- THE canonical check-centric payment writer -- same authority, server-derived
  -- amount, digest, and legacy mirrors as the operator collection path (§R of the
  -- audit). mode='full': a creation-time "ya pagado" always settles the order's
  -- FULL obligation, exactly like _ledger_write_payment/order_mark_paid did.
  PERFORM public.order_post_payment_v1(
    v_workspace_id, v_actor, v_sid_hash, NEW.order_uid, v_method, 'full', NULL,
    v_client_request_id, v_request_hash,
    jsonb_build_object('source', 'initial_payment_at_creation'), false);

  -- The intent has done its one job. Clearing it here keeps the column NULL at
  -- rest; this UPDATE touches no economic column, so neither N-5's guard nor
  -- N-2's revision trigger fires.
  UPDATE public.ordenes SET initial_payment_intent = NULL WHERE id = NEW.id;

  RETURN NEW;
END;
$function$;

-- ── POST-CONDITION: confirms the exact known-broken M122 epoch is restored.
DO $post$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='order_initial_payment_v1'
       AND p.oid::text = current_setting('ladieci.m123rb_fn_oid', true)
  ) THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 OID changed -- expected an in-place CREATE OR REPLACE';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';

  IF (SELECT array_to_string(p.proconfig, ',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='order_initial_payment_v1')
     IS DISTINCT FROM 'search_path=public, pg_temp' THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 search_path changed -- must stay public, pg_temp';
  END IF;

  -- The unqualified (KNOWN BROKEN) call must be back.
  IF position('v_request_hash := encode(digest(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 does not contain the unqualified digest() request-hash assignment -- revert did not take effect';
  END IF;
  -- The M123 fix must be fully gone.
  IF position('extensions.digest(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 still references extensions.digest -- revert incomplete';
  END IF;

  IF position('PERFORM public.order_post_payment_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 no longer calls order_post_payment_v1';
  END IF;
  IF position('PERFORM public.order_mark_paid(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 must not call order_mark_paid';
  END IF;
  IF position('pay-order-' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 lost the deterministic pay-order-<id> key';
  END IF;
  IF position('INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' IN v_def) = 0
     OR position('INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' IN v_def) = 0
     OR position('INITIAL_PAYMENT_METHOD_INVALID' IN v_def) = 0
     OR position('INITIAL_PAYMENT_CONTEXT_INVALID' IN v_def) = 0
     OR position('INITIAL_PAYMENT_WORKSPACE_UNRESOLVED' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: order_initial_payment_v1 lost an existing guard';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='ordenes'
      AND t.tgname='ordenes_paid_at_creation_payment_v1' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A')
      AND t.tgfoid = 'public.order_initial_payment_v1()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: ordenes_paid_at_creation_payment_v1 missing, disabled, or retargeted';
  END IF;

  IF (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
     IS DISTINCT FROM current_setting('ladieci.m123rb_public_fn_count', true) THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: number of functions in public schema changed';
  END IF;
  IF (SELECT count(*)::text FROM public.ordenes) IS DISTINCT FROM current_setting('ladieci.m123rb_ordenes_count', true) THEN
    RAISE EXCEPTION 'M123 ROLLBACK post-condition failed: ordenes row count changed -- this rollback must write no data';
  END IF;
END $post$;

-- LEDGER: this file does not remove any ladieci_schema_migrations row.
-- Ledger de-registration of apply_order 123 (if it was ever applied), like
-- its registration, is a separate operational step, not part of this SQL.

COMMIT;
