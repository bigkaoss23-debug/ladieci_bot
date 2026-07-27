-- migrations/2026-07-27_s2_7d6e3a_rider_ledger_writer_additive.sql
-- S2-7D6E3 FASE A — the rider stop stops being an accounting authority (additive half).
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- DRAFT — NOT APPLIED.
--
-- THIS IS FASE A OF A TWO-PHASE, SQL-FIRST-SAFE ROLLOUT (split from the original single-file
-- S2-7D6E2 draft after an audit found it coupled DB and backend deploys — see the ROLLOUT
-- note below). Apply THIS file any time, independently of the backend deploy:
--   FASE A (this file)  — purely additive: new functions only, nothing dropped, nothing that
--                         the CURRENTLY DEPLOYED backend calls changes its calling contract.
--                         The legacy `complete_rider_stop(text, boolean, text)` is left in
--                         place untouched, so the old backend keeps working unmodified.
--   FASE B              — deploy the backend commit that repoints
--                         riderTrip.completeStop -> rider_collect_and_complete_stop.
--   FASE C              — smoke-test the rider door-collection flow live.
--   FASE D (separate file, 2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql) — apply ONLY
--                         after FASE C passes: drops the now-unused legacy RPC.
-- No phase requires simultaneity between Railway (backend) and Supabase (DB).
--
-- ONE STATEMENT IN THIS FILE IS NOT ZERO-RISK: `CREATE OR REPLACE FUNCTION order_mark_paid`
-- (section 2 below) live-swaps the body of a function the CURRENTLY DEPLOYED operator
-- payment path already calls on every request. This is deliberate and should NOT be
-- deferred to a later phase: order_mark_paid's body has been unchanged since
-- 2026-07-19_b7_payment_basis_historical_replay_fix.sql, which predates
-- 2026-07-26_two_service_identity.sql's session-scoped unique indexes (APPLIED on
-- staging) — so the function's own pre-INSERT lookup queries never got updated to match
-- and carry the SAME session-scoping bug fixed in this file's writer (see section 1's
-- comment). Applying FASE A therefore also fixes an already-live idempotency gap in the
-- operator payment path, not just prepares the rider feature. The replacement is
-- authorization-preserving (admin/operator gate, session_version check and error
-- precedence are reproduced exactly — see tests/riderDeliveryCollectionMigration.test.js).
--
-- WHY (the rider defect this migration exists for).
-- `complete_rider_stop(text, boolean, text)` wrote
--     cobrado = COALESCE(p_cobrado, true), metodo_pago = COALESCE(p_metodo_pago, '')
-- with no actor, no session_version, no amount and NO row in order_financial_events.
-- Every euro a rider collected at the door was invisible to the ledger and reached the
-- closeout only through the `legacyPaid` fallback in currentServiceCloseout.js — exactly
-- the pre-ledger representation d13aad0 was written to eliminate for the operator. Worse,
-- `p_cobrado` came straight from the browser (api.js hardcoded `true`), so the FRONTEND
-- asserted payment.
--
-- WHAT THIS DOES NOT DO. It does NOT add 'rider' to the generic order_mark_paid role
-- allow-list, and it does NOT let a rider impersonate an operator. Admin/operator keep
-- their existing generic payment authority, byte-unchanged. Instead the rider gets a
-- DEDICATED, deliberately narrow contract that reuses the SAME internal ledger writer.
--
-- THE RIDER CONTRACT (rider_collect_and_complete_stop) enforces, server-side:
--   * authenticated role must be exactly 'rider' (not admin, not operator);
--   * the order must be a member of THAT rider's currently ACTIVE trip;
--   * session, order and amount are DERIVED SERVER-SIDE — never accepted from the client;
--   * only real delivery collection methods (efectivo|tarjeta|bizum);
--   * deterministic, session-scoped idempotency (SQL partitions by service_session_id);
--   * no refunds, no voids, no discounts, no manual amount override — the function can
--     only ever write ONE 'payment' event, by construction;
--   * payment and stop completion are ATOMIC: one transaction, and any refusal from the
--     ledger aborts the stop completely (no "delivered but unpaid", no "paid but not
--     delivered");
--   * the ledger event preserves the RIDER as by_actor/by_role, meta.source='rider_delivery'.
--
-- ONE FINANCIAL AUTHORITY. Money logic (amount derivation, canonical payload, digest,
-- basis check, INSERT, legacy-flag write) lives in exactly ONE place —
-- public._ledger_write_payment — which order_mark_paid now delegates to as well. Neither
-- Node nor the rider RPC derives an amount or builds a digest. This is also what keeps the
-- known numeric-digest replay bug (order_void canonicalised a literal `0` on insert against
-- a `0.00` numeric column on replay) from being reintroduced on a second code path:
-- v_amount is round(totale,2) into a numeric(10,2) on BOTH the insert and the replay side.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6A/S2-7D/S2-7D2/S2-7D6E).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D6E3A refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor: the guarded B7A2D/B7A2E payment authority must already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public' AND p.proname = 'order_mark_paid'
      AND pg_get_function_identity_arguments(p.oid) =
        'p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text')
  THEN RAISE EXCEPTION 'S2-7D6E3A refused: guarded order_mark_paid absent — apply B7A2D/B7A2E first.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='order_financial_events')
  THEN RAISE EXCEPTION 'S2-7D6E3A refused: order_financial_events absent.'; END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE single ledger writer.
--
-- Extracted from order_mark_paid (2026-07-19_b7_payment_basis_historical_replay_fix.sql
-- lines 88-160) so the canonical payload and digest are byte-identical to every event
-- already recorded on staging — existing replays keep matching. The two pre-INSERT lookup
-- queries are NOT verbatim: the 2026-07-19 source predates
-- 2026-07-26_two_service_identity.sql's session-scoped unique indexes, and copying its
-- order_id-only WHERE clauses here would let an order id/number recycled into a later
-- service session collide with an earlier session's event (false replay of a different
-- day's payment, or a spurious AUTH_IDEMPOTENCY_CONFLICT). Both lookups add
-- `service_session_id IS NOT DISTINCT FROM v_ord.service_session_id` to match the
-- partitioned indexes exactly.
--
-- The caller is responsible for AUTHORIZATION (who may pay). This function is responsible
-- for ACCOUNTING (what gets recorded). It re-validates its own inputs so a second caller
-- cannot weaken them, and takes by_role from the caller because the caller has already
-- locked and read auth_actors.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._ledger_write_payment(
  p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_by_role text,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text := p_by_role; v_method text; v_reason text; v_amount numeric(10,2);
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

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;

  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_role IS NULL OR btrim(v_role) = '' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Same-scope replay is based on immutable event snapshots, not mutable order fields.
  -- Scoped by service_session_id (IS NOT DISTINCT FROM handles the legacy NULL-session
  -- case) to match the partitioned unique indexes from 2026-07-26_two_service_identity.sql
  -- (order_financial_events_one_payment_session_uq / _legacy_uq): an order id/number
  -- recycled into a LATER service session must never match an EARLIER session's event.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'payment'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM false
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_existing.amount, 'payment_method', v_method, 'legacy', false))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    -- A different actor/role/amount under the same key is a genuine conflict, never a
    -- silent second charge. This is what refuses a rider collection followed by an
    -- operator one on the same order.
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  -- SERVER-DERIVED amount. No caller — Node, rider or operator — can supply or override it.
  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  -- Key order and value types are byte-significant: the digest is sha256 over the jsonb
  -- text. Reproduced EXACTLY as in 2026-07-19_b7_payment_basis_historical_replay_fix.sql.
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  -- Same session-scoping as the replay check above: one basis per order PER SESSION, so a
  -- recycled order id/number starts a fresh basis in a later session instead of colliding
  -- with a since-archived one.
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment', v_amount, v_method, v_reason, false, p_by_actor, v_role,
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
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. order_mark_paid — AUTHORIZATION UNCHANGED, accounting delegated.
--
-- The admin/operator gate, the session_version check and the validation ORDER are
-- reproduced exactly as before, so operator behaviour and error precedence do not drift.
-- Only the money tail is now the shared writer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_mark_paid(
  p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_role text; v_method text;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
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

  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  -- Generic payment authority: admin/operator ONLY. A rider never reaches this function;
  -- it has its own narrower contract (rider_collect_and_complete_stop).
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  RETURN public._ledger_write_payment(
    p_order_id, v_method, p_reason, p_by_actor, v_role, p_ip_hash, v_meta, p_idem_scope_key);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. rider_collect_and_complete_stop — the dedicated rider contract.
--
-- Payment FIRST, stop completion second, one transaction. A ledger refusal RAISEs and
-- takes the stop completion with it; there is no partial outcome to reconcile by hand.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rider_collect_and_complete_stop(
  p_order_id        text,
  p_metodo_pago     text,
  p_by_actor        text,
  p_session_version integer,
  p_ip_hash         text,
  p_meta            jsonb,
  p_idem_scope_key  text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by       public.auth_actors%ROWTYPE;
  v_ds       jsonb;
  v_active   jsonb;
  v_estado   text;
  v_updated  int;
  v_method   text;
  v_meta     jsonb;
  v_pay      jsonb := NULL;
  v_pay_note text := NULL;
BEGIN
  v_method := lower(btrim(COALESCE(p_metodo_pago, '')));

  -- Only real door-collection methods. Anything else (notably the operator override
  -- "manual", or an empty string for an already-prepaid order) means NO money is claimed:
  -- the stop still completes, but nothing is written to the ledger and no flag is invented.
  IF v_method <> '' AND v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_METHOD_INVALID');
  END IF;

  IF p_session_version IS NULL OR p_session_version < 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  -- IDENTITY. Role must be exactly 'rider' — this contract never serves admin/operator,
  -- and never lets a rider borrow their authority.
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_ACTOR_NOT_FOUND'); END IF;
  IF v_by.active <> true THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_INITIATOR_INACTIVE'); END IF;
  IF v_by.role <> 'rider' THEN RETURN jsonb_build_object('ok', false, 'code', 'AUTH_FORBIDDEN_ROLE'); END IF;
  IF p_session_version <> v_by.session_version THEN
    RETURN jsonb_build_object('ok', false, 'code', 'AUTH_SESSION_STALE');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));

  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);

  IF v_active IS NULL OR jsonb_typeof(v_active) <> 'object' OR (v_active->>'status') <> 'ACTIVE' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ACTIVE_TRIP');
  END IF;

  -- ASSIGNMENT. The order must belong to the currently active delivery. Membership is the
  -- rider's authority to collect on it; without this any rider could pay off any order.
  IF NOT (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NON_MEMBER');
  END IF;

  SELECT estado INTO v_estado FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  -- Server-forced provenance. The client cannot claim a different source.
  v_meta := COALESCE(p_meta, '{}'::jsonb) || jsonb_build_object('source', 'rider_delivery');

  IF v_estado = 'RETIRADO' THEN
    -- Operative replay. The collection may still need reconciling: a rider whose first
    -- request completed the stop but died before the money was recorded must be able to
    -- retry. The deterministic key makes an honest retry a digest-identical replay.
    IF v_method <> '' THEN
      BEGIN
        v_pay := public._ledger_write_payment(
          p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
      EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
        v_pay_note := SQLERRM;
        IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
          RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
        END IF;
      END;
    END IF;
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'order_id', p_order_id,
                              'payment', v_pay, 'payment_note', v_pay_note);
  END IF;

  IF v_estado <> 'EN_ENTREGA' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_STATE');
  END IF;

  -- MONEY FIRST. A refusal here returns before the stop is completed, and the subtransaction
  -- has already rolled the attempted payment back: nothing half-written either way.
  -- AUTH_LEGACY_IMPORT_REQUIRED is the single tolerated refusal — that money is already on
  -- record in the pre-ledger representation, and re-recording it would double-count.
  IF v_method <> '' THEN
    BEGIN
      v_pay := public._ledger_write_payment(
        p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE 'P0002' THEN
      v_pay_note := SQLERRM;
      IF v_pay_note <> 'AUTH_LEGACY_IMPORT_REQUIRED' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', v_pay_note);
      END IF;
    END;
  END IF;

  -- OPERATIVE completion ONLY. cobrado / metodo_pago are deliberately absent here:
  -- RETIRADO does not mean paid, and _ledger_write_payment is the sole writer of those
  -- columns. A prepaid or unpaid-on-delivery stop completes with the flags untouched.
  UPDATE public.ordenes
    SET estado       = 'RETIRADO',
        hora_entrega = (extract(epoch FROM now()) * 1000)::bigint
  WHERE id = p_order_id AND estado = 'EN_ENTREGA';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated = 0 THEN
    -- Lost the race after taking the money: ABORT so the recorded payment cannot survive
    -- a stop that did not complete. Must RAISE, never RETURN.
    RAISE EXCEPTION 'RIDER_STOP_LOST_RACE' USING ERRCODE='40001';
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'order_id', p_order_id,
                            'payment', v_pay, 'payment_note', v_pay_note);
END;
$fn$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The old ledger-less `complete_rider_stop(text, boolean, text)` is DELIBERATELY LEFT
--    IN PLACE here — it is NOT dropped by FASE A. Dropping it is a separate, later
--    migration (2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql) applied ONLY after
--    FASE B (backend repointed to rider_collect_and_complete_stop) has deployed and FASE C
--    (live smoke test) has passed. Until then the old function is simply unused dead code
--    from the DB's point of view — nothing in this file's DDL removes a caller's ability to
--    reach it, so a currently-deployed OLD backend keeps working unmodified if FASE A is
--    applied before FASE B ships.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rider_collect_and_complete_stop(text, text, text, integer, text, jsonb, text)
  TO service_role;

COMMIT;
