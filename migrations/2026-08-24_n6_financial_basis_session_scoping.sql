-- migrations/2026-08-24_n6_financial_basis_session_scoping.sql
-- N-6 — FINANCIAL BASIS SESSION SCOPING: refund / void / legacy-import hardening.
--
-- THE DEFECT, RE-PROVEN AGAINST THE LIVE FUNCTIONS THIS SESSION (not taken on trust
-- from the earlier audit). `order_refund`, `order_void` and
-- `order_import_legacy_payment` resolve their financial basis with
-- `WHERE order_id = p_order_id` and NOTHING ELSE. Eight queries in total:
--
--   order_refund                 4  (replay lookup; basis inside the replay branch;
--                                    basis on the main path; already-refunded check)
--   order_void                   2  (replay lookup; pay-state derivation)
--   order_import_legacy_payment  2  (replay lookup; AUTH_BASIS_EXISTS check)
--
-- `public._ledger_write_payment` — the payment writer — already gets this right, and
-- its predicate is the reference this migration copies verbatim:
--     AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
--
-- WHY THAT MATTERS: the human-facing `#NNN` is NOT financial identity. It is recycled
-- across service sessions, and this is not theoretical — proven live, read-only, on
-- staging today:
--
--   order_financial_events carrying a display id that belongs to a DIFFERENT service
--   than the order row now bearing it:  7 events across 4 display ids.
--
--   #001  order row lives in service 33174121
--         payment 10.00  service 1cfaabf8   (2026-08-06 17:22)  FOREIGN
--         payment 13.00  service 9fe2f3c1   (2026-08-06 18:20)  FOREIGN
--         payment 16.00  service 33174121   (2026-08-10 09:43)  ITS OWN
--
-- Running the EXACT current basis query against live rows (read-only lateral join)
-- returns, today:
--
--   order   own service   CURRENT (unscoped) basis      CORRECT (scoped) basis
--   #001    33174121      10.00  from 1cfaabf8  WRONG   16.00
--   #002    33174121      10.00  from 9fe2f3c1  WRONG   13.50
--   #003    33174121      14.50  from 9fe2f3c1  WRONG   14.00
--
-- `ORDER BY created_at ASC LIMIT 1` actively selects the OLDEST event sharing the
-- display id, which for a recycled number is precisely the foreign one. A refund of
-- #001 today would refund 10.00 of a stranger's money instead of its own 16.00, with
-- that stranger's payment method, attributed to the wrong economic period.
--
-- NOTHING HAS BEEN CORRUPTED YET, AND THAT IS STATED RATHER THAN ASSUMED: the ledger
-- holds 61 events, ALL of type `payment`. Zero refunds, zero voids, zero imports have
-- ever executed on staging, so no wrong basis has ever been written. The defect is
-- LATENT — but it is not dormant code: AUTH_V2_FINANCIAL_HTTP_ENABLED is `true` on the
-- deployed backend, so /api/financial refund and void are reachable today.
--
-- THE FIX IS THE SMALLEST ONE THAT CLOSES THE INVARIANT. Every one of the eight
-- lookups gains the reference predicate, character for character. No function's
-- authorization, digest, idempotency contract, state machine, amount derivation or
-- return shape is otherwise touched; each body below is the CURRENT live definition
-- with only the scoping clause and the ownership guard added, so none of the prior B7
-- fixes (session_version guard, historical replay fix, void digest fix) is regressed.
--
-- WHY NO SHARED HELPER FUNCTION, DELIBERATELY. Centralising "events belonging to this
-- order" in a set-returning helper was considered and rejected: the reference
-- implementation `_ledger_write_payment` must stay untouched (it is certified and
-- carries live money), so a helper would be used by three functions and not by the
-- fourth — creating exactly the "two subtly different definitions" the invariant is
-- meant to prevent. Instead all four now contain the IDENTICAL predicate text, and
-- tests/n6FinancialBasisSessionScoping.test.js asserts that identity against the LIVE
-- prosrc of all four functions, plus asserts that zero unscoped financial lookups
-- remain. The invariant is centralised in the assertion rather than in an indirection.
--
-- AMBIGUOUS OWNERSHIP FAILS CLOSED. Each function additionally refuses outright when
-- the target order has no service session, because financial ownership then cannot be
-- proven at all. It reuses the EXISTING code `ORDER_WITHOUT_SERVICE_SESSION` already
-- raised by `service_session_assign_financial_event` for the same condition — one
-- vocabulary, not two, and the frontend already renders a Spanish sentence for it.
-- Live today: zero orders and zero events have a NULL service_session_id, so this
-- guard changes nothing that exists; it closes the case for the future.
--
-- EVENT OWNERSHIP NEEDS NO CHANGE HERE, AND THAT WAS VERIFIED. Every new financial
-- event already inherits its session from the ORDER ROW via the BEFORE INSERT trigger
-- `financial_event_assign_service_session`, which does
-- `SELECT o.service_session_id FROM ordenes o WHERE o.id = NEW.order_id` — never a
-- current-service lookup and never a caller guess. This migration keeps that path
-- untouched and the accompanying tests prove the resulting ownership.
--
-- WHY NOT order_uid (N-7 IS OUT OF SCOPE). `order_financial_events` has no order_uid
-- column, so permanent identity cannot scope these lookups without migrating the whole
-- ledger — which is exactly N-7. Composite (order_id, service_session_id) is the
-- strongest invariant available inside the current schema, and it is sufficient: it is
-- what the certified payment writer already uses. Nothing here migrates identity,
-- changes a PK/FK, or rewrites the ledger.
--
-- NO BACKFILL, NO REPAIR. Not one historical row is read for modification. #001/#002/
-- #003 keep every event they have; after this migration their refund/void basis simply
-- resolves to their own session instead of a stranger's. #369 — two events across two
-- services with NO order row at all — continues to raise AUTH_ORDER_NOT_FOUND exactly
-- as it does today, since every one of these functions resolves the order first.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_refund') THEN
    RAISE EXCEPTION 'N-6 refused: order_refund is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_void') THEN
    RAISE EXCEPTION 'N-6 refused: order_void is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_import_legacy_payment') THEN
    RAISE EXCEPTION 'N-6 refused: order_import_legacy_payment is missing -- resolve drift first';
  END IF;

  -- The reference implementation must already carry the predicate this slice copies.
  -- If it does not, the pattern being propagated is not the certified one.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_ledger_write_payment';
  IF v_src IS NULL OR v_src !~ 'service_session_id IS NOT DISTINCT FROM v_ord\.service_session_id' THEN
    RAISE EXCEPTION 'N-6 refused: _ledger_write_payment does not carry the reference scoping predicate -- resolve drift first';
  END IF;

  -- Ownership of NEW events is inherited from the order row by this trigger; the
  -- slice's Phase-9 guarantee depends on it still being installed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_financial_events'::regclass
                  AND NOT tgisinternal AND tgname='financial_event_assign_service_session') THEN
    RAISE EXCEPTION 'N-6 refused: financial_event_assign_service_session is missing -- resolve drift first';
  END IF;

  -- Already patched?
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_refund';
  IF v_src ~ 'service_session_id IS NOT DISTINCT FROM v_ord\.service_session_id' THEN
    RAISE EXCEPTION 'N-6 refused: order_refund is already session-scoped -- already patched, resolve drift first';
  END IF;
END $$;

BEGIN;

-- ═══ order_refund ════════════════════════════════════════════════════════
-- Current live body, with: the ownership guard, and the scoping predicate on all
-- FOUR financial lookups. Authorization, digest, replay contract, amount/method
-- derivation and return shape are byte-identical to the pre-N-6 definition.
CREATE OR REPLACE FUNCTION public.order_refund(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_basis public.order_financial_events%ROWTYPE; v_existing public.order_financial_events%ROWTYPE;
  v_existing_refund public.order_financial_events%ROWTYPE; v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- N-6 — financial ownership must be provable before any money is touched.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    SELECT * INTO v_basis FROM public.order_financial_events
      WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
        AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
      ORDER BY created_at ASC LIMIT 1;
    IF NOT FOUND OR v_basis.amount IS DISTINCT FROM v_existing.amount
       OR v_basis.payment_method IS DISTINCT FROM v_existing.payment_method
    THEN RAISE EXCEPTION 'AUTH_REFUND_BASIS_INTEGRITY' USING ERRCODE='22023'; END IF;
    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', v_existing.order_id, 'type', 'refund', 'idem_scope_key', v_existing.idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'basis_event_id', v_basis.id, 'amount', v_existing.amount,
      'payment_method', v_existing.payment_method, 'legacy', v_existing.legacy))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'original_giro_id', v_existing.original_giro_id,
        'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_NO_PAYMENT_BASIS' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing_refund FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund'
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'AUTH_ALREADY_REFUNDED' USING ERRCODE='22023'; END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'refund', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'paid', 'new_pay_state', 'refunded',
    'basis_event_id', v_basis.id, 'amount', v_basis.amount,
    'payment_method', v_basis.payment_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'refund', v_basis.amount, v_basis.payment_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'paid', 'refunded', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET refunded = true WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

-- ═══ order_void ══════════════════════════════════════════════════════════
-- Ownership guard + scoping on BOTH lookups. The pay-state derivation is the
-- dangerous one: unscoped, it stamps prev/new_pay_state from a FOREIGN session, so a
-- void could record an order as paid or refunded when its own service holds no money
-- at all.
CREATE OR REPLACE FUNCTION public.order_void(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE; v_pay_event public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_pay_state text; v_canon jsonb; v_digest text; v_replay_digest text; v_now timestamptz := now();
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- N-6 — financial ownership must be provable before any pay-state is stamped.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'void' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'void' OR v_existing.amount <> 0 OR v_existing.payment_method IS NOT NULL
       OR v_existing.legacy IS DISTINCT FROM false OR v_existing.new_estado <> 'ANULADO'
       OR v_existing.prev_pay_state IS DISTINCT FROM v_existing.new_pay_state
    THEN RAISE EXCEPTION 'AUTH_VOID_REPLAY_INTEGRITY' USING ERRCODE='22023'; END IF;
    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', 0, 'payment_method', NULL,
      'original_giro_id', v_existing.original_giro_id, 'legacy', false))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'original_giro_id', v_existing.original_giro_id,
        'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_pay_event FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('refund','payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY CASE WHEN type = 'refund' THEN 1 ELSE 2 END, created_at ASC LIMIT 1;
  IF FOUND AND v_pay_event.type = 'refund' THEN v_pay_state := 'refunded';
  ELSIF FOUND THEN v_pay_state := 'paid';
  ELSE v_pay_state := 'unpaid'; END IF;
  IF v_ord.estado NOT IN ('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'AUTH_VOID_STATE_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', 'ANULADO',
    'prev_pay_state', v_pay_state, 'new_pay_state', v_pay_state,
    'amount', 0, 'payment_method', NULL, 'original_giro_id', v_ord.manual_giro_id,
    'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'void', 0, NULL, v_reason, false, p_by_actor, v_role,
    v_ord.estado, 'ANULADO', v_pay_state, v_pay_state, v_ord.manual_giro_id,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET estado = 'ANULADO', cancelado_at = v_now WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

-- ═══ order_import_legacy_payment ═════════════════════════════════════════
-- Ownership guard + scoping on BOTH lookups. Note the direction of the pre-N-6 bug
-- here is the opposite of refund/void: the unscoped AUTH_BASIS_EXISTS check let a
-- FOREIGN session's payment SUPPRESS a legitimate import (fail-closed, so no wrong
-- money was written) — but the unscoped replay lookup could equally have returned a
-- foreign session's imported event as this order's own. Both are closed. Import
-- authority itself is NOT broadened: the admin role gate, the explicit
-- IMPORT_LEGACY_PAYMENT confirmation and the AUTH_NOT_LEGACY_PAID precondition are
-- untouched.
CREATE OR REPLACE FUNCTION public.order_import_legacy_payment(p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  v_amount := round(p_amount, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  IF p_confirm IS DISTINCT FROM 'IMPORT_LEGACY_PAYMENT' THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- N-6 — financial ownership must be provable before any historical money is imported.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;

  -- Same-scope replay is based on immutable event snapshots plus current request amount/method/reason.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment_imported' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'payment_imported'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM true
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_amount, 'payment_method', v_method, 'legacy', true))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', true);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF NOT (v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE) THEN
    RAISE EXCEPTION 'AUTH_NOT_LEGACY_PAID' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment_imported', v_amount, v_method, v_reason, true, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method
   WHERE id = p_order_id;

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

-- ── Grants ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves existing privileges, but they are restated for the same
-- reason ledger 98 taught: never assume a privilege survived a redefinition.
REVOKE ALL ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_void(text, text, text, integer, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_void(text, text, text, integer, text, jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text) TO service_role;

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY. No business DML runs inside this transaction: not one order,
-- obligation or financial event is inserted, updated or deleted. The behavioural proof
-- (a refund/void/import on an order whose display id also exists in another service
-- sees ONLY its own session's money; the generated event stays in the target service;
-- ambiguous ownership fails closed; idempotency still replays in-session and refuses
-- cross-session) runs separately as rollback-safe probes against real staging -- see
-- this slice's report.
DO $$
DECLARE
  v_src text;
  v_fn  text;
  v_unscoped int;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['order_refund','order_void','order_import_legacy_payment'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname = v_fn;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'N-6 post-condition failed: % disappeared', v_fn;
    END IF;

    -- The ownership guard must be present.
    IF v_src !~ 'ORDER_WITHOUT_SERVICE_SESSION' THEN
      RAISE EXCEPTION 'N-6 post-condition failed: % has no ambiguous-ownership guard', v_fn;
    END IF;

    -- EVERY financial lookup must be scoped. Count the lookups that name
    -- order_financial_events, then count the scoping clauses: they must match.
    SELECT count(*) INTO v_unscoped
      FROM regexp_matches(v_src, 'FROM public\.order_financial_events', 'g');
    IF v_unscoped <> (SELECT count(*) FROM regexp_matches(v_src,
        'service_session_id IS NOT DISTINCT FROM v_ord\.service_session_id', 'g')) THEN
      RAISE EXCEPTION 'N-6 post-condition failed: % has % financial lookup(s) but a different number of scoping clauses', v_fn, v_unscoped;
    END IF;
  END LOOP;

  -- Expected lookup counts, pinned so a future edit that DELETES a lookup (and its
  -- clause, keeping the counts equal) still trips this.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_refund';
  IF (SELECT count(*) FROM regexp_matches(v_src, 'FROM public\.order_financial_events', 'g')) <> 4 THEN
    RAISE EXCEPTION 'N-6 post-condition failed: order_refund must have exactly 4 scoped financial lookups';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_void';
  IF (SELECT count(*) FROM regexp_matches(v_src, 'FROM public\.order_financial_events', 'g')) <> 2 THEN
    RAISE EXCEPTION 'N-6 post-condition failed: order_void must have exactly 2 scoped financial lookups';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_import_legacy_payment';
  IF (SELECT count(*) FROM regexp_matches(v_src, 'FROM public\.order_financial_events', 'g')) <> 2 THEN
    RAISE EXCEPTION 'N-6 post-condition failed: order_import_legacy_payment must have exactly 2 scoped financial lookups';
  END IF;

  -- The reference implementation must be UNCHANGED by this slice.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='_ledger_write_payment';
  IF v_src !~ 'service_session_id IS NOT DISTINCT FROM v_ord\.service_session_id' THEN
    RAISE EXCEPTION 'N-6 post-condition failed: _ledger_write_payment lost its scoping predicate';
  END IF;

  -- Import authority must not have been broadened.
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_import_legacy_payment';
  IF v_src !~ 'IMPORT_LEGACY_PAYMENT' OR v_src !~ 'AUTH_NOT_LEGACY_PAID'
     OR v_src !~ 'AUTH_CONFIRMATION_REQUIRED' THEN
    RAISE EXCEPTION 'N-6 post-condition failed: legacy-import authority was weakened';
  END IF;

  -- Event ownership stays inherited from the order row.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_financial_events'::regclass
                  AND NOT tgisinternal AND tgname='financial_event_assign_service_session') THEN
    RAISE EXCEPTION 'N-6 post-condition failed: financial_event_assign_service_session disappeared';
  END IF;

  -- Grants.
  IF NOT has_function_privilege('service_role', 'public.order_refund(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.order_void(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-6 post-condition failed: service_role lost EXECUTE on a financial RPC';
  END IF;
  IF has_function_privilege('anon', 'public.order_refund(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_refund(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.order_void(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_void(text, text, text, integer, text, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-6 post-condition failed: a browser role holds EXECUTE on a financial RPC';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-114:
-- the manifest records this file's own sha256, and embedding that sha in an INSERT
-- inside the file would make the checksum self-referential. Registered as a separate
-- statement at apply time: apply_order 115, kind 'ddl', checksum = this file's sha256,
-- applied_by = the introducing commit (committed BEFORE this migration is applied --
-- O-1's ledger-immutability lesson, followed again).

COMMIT;
