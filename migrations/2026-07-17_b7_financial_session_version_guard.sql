-- migrations/2026-07-17_b7_financial_session_version_guard.sql
-- Access Control V2 / B7A2D — atomic session-version guard for the four financial RPCs.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Closes a time-of-check/time-of-use gap: the B7A3 HTTP middleware validates the JWT
-- claim `sv` against auth_actors.session_version BEFORE the RPC, but the RPCs received
-- only p_by_actor. A session revocation (session_version bump via PIN change / logout-all
-- / deactivate) between the middleware read and the RPC's actor lock was invisible to the
-- RPC, so a just-revoked token could still win the mutation. This migration makes the
-- session check ATOMIC with the mutation: every RPC now takes p_session_version and, while
-- holding the actor FOR UPDATE lock, compares it to the locked auth_actors.session_version
-- BEFORE locking the order or touching the ledger. Mismatch/absent/invalid → AUTH_SESSION_STALE.
--
-- Because a function's argument list is part of its identity, the OLD unguarded signatures
-- are REVOKEd and DROPped in the SAME transaction and the guarded signatures created — so no
-- unguarded overload remains callable (PostgREST exposes only the guarded ones). p_session_version
-- is placed immediately after p_by_actor. EXECUTE granted only to service_role (owner retains).
--
-- Preserves every accepted correction through commit fd7c7b9: SECURITY INVOKER, pinned
-- search_path, actor+order FOR UPDATE locks, plain ledger SELECTs (no row locks), all
-- payment/refund/void semantics, and the canonical-zero void replay fix (literal 0 / NULL /
-- false in BOTH fresh and replay void canons + AUTH_VOID_REPLAY_INTEGRITY). Changes NO ledger
-- table/event/index/constraint/RLS policy/table privilege; inserts/rewrites NO financial event;
-- updates NO order during migration. No dynamic SQL.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6/B7A1/B7A2A/B7A2B).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B7A2D refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Preconditions: B7A1 ledger present; the FOUR accepted UNGUARDED signatures exist; no guarded
-- overload already present. Fail-closed on drift.
DO $$
DECLARE n int;
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL
  THEN RAISE EXCEPTION 'B7A2D refused: order_financial_events missing — apply B7A1 first.'; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND (
    (p.proname='order_mark_paid'             AND pg_get_function_identity_arguments(p.oid)='p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text') OR
    (p.proname='order_import_legacy_payment' AND pg_get_function_identity_arguments(p.oid)='p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text') OR
    (p.proname='order_refund'                AND pg_get_function_identity_arguments(p.oid)='p_order_id text, p_reason text, p_by_actor text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text') OR
    (p.proname='order_void'                  AND pg_get_function_identity_arguments(p.oid)='p_order_id text, p_reason text, p_by_actor text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text'));
  IF n <> 4 THEN RAISE EXCEPTION 'B7A2D refused: expected 4 accepted unguarded financial RPCs, found %.', n; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname IN ('order_mark_paid','order_import_legacy_payment','order_refund','order_void')
    AND pg_get_function_identity_arguments(p.oid) LIKE '%p_session_version integer%';
  IF n <> 0 THEN RAISE EXCEPTION 'B7A2D refused: guarded signature already present — resolve drift first.'; END IF;
END $$;

-- ── remove the OLD unguarded signatures (revoke then drop, same transaction) ─────────
REVOKE ALL ON FUNCTION public.order_mark_paid(text, text, text, text, text, jsonb, text)                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_refund(text, text, text, text, jsonb, text)                                    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.order_void(text, text, text, text, jsonb, text)                                      FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.order_mark_paid(text, text, text, text, text, jsonb, text);
DROP FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, text, jsonb, text, text);
DROP FUNCTION public.order_refund(text, text, text, text, jsonb, text);
DROP FUNCTION public.order_void(text, text, text, text, jsonb, text);

-- ── RPC 1 — order_mark_paid (guarded) ───────────────────────────────────────────────
CREATE FUNCTION public.order_mark_paid(
  p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text;
BEGIN
  -- input guards
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
  -- session version must be structurally present/valid (final atomic check is under the actor lock)
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  -- canonical payment method (normalize then exact-match)
  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  -- reason: optional; NULL or trimmed non-empty; blank rejected
  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;

  -- lock initiator; active admin/operator (rider denied); role + session_version from locked row
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  -- ATOMIC session-version guard: trusted claim must equal the LOCKED DB session_version
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  -- lock order (serializes concurrent basis attempts)
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- server-derived amount from authoritative totale; caller cannot override
  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  -- canonical digest (deterministic jsonb; excludes ip_hash/meta/created_at)
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  -- (A) same-scope idempotency check BEFORE generic already-paid rejection
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    IF v_existing.payload_digest = v_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  -- (B) one payment basis per order (payment OR payment_imported)
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  -- (C) legacy-paid flags require the controlled import RPC (no silent payment)
  IF v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE='22023';
  END IF;

  -- immutable basis event + order compatibility mirrors (one transaction)
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment', v_amount, v_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method
   WHERE id = p_order_id;   -- estado/refunded/manual_giro_id/pricing preserved (not in SET)

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$fn$;

-- ── RPC 2 — order_import_legacy_payment (guarded) ────────────────────────────────────
CREATE FUNCTION public.order_import_legacy_payment(
  p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text;
BEGIN
  -- input guards
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

  -- canonical payment method
  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  -- reason mandatory, trimmed non-empty
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  -- explicit amount (historical), rounded to numeric(10,2); > 0
  v_amount := round(p_amount, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  -- exact confirmation (no normalization); never stored/returned/logged
  IF p_confirm IS DISTINCT FROM 'IMPORT_LEGACY_PAYMENT' THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;

  -- lock initiator; active ADMIN only (operator + rider denied)
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  -- ATOMIC session-version guard under the actor lock
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  -- lock order
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- canonical digest (payment_imported, legacy=true)
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', true);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  -- (A) same-scope idempotency BEFORE generic basis rejection
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment_imported' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    IF v_existing.payload_digest = v_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  -- (B) one basis per order
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  -- (C) legacy import requires existing legacy paid evidence
  IF NOT (v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE) THEN
    RAISE EXCEPTION 'AUTH_NOT_LEGACY_PAID' USING ERRCODE='22023';   -- caller must use order_mark_paid
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
   WHERE id = p_order_id;   -- estado/refunded/manual_giro_id/pricing preserved

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$fn$;

-- ── RPC 3 — order_refund (guarded) ───────────────────────────────────────────────────
CREATE FUNCTION public.order_refund(
  p_order_id text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_basis public.order_financial_events%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_refund public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  -- input guards
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

  -- reason mandatory, trimmed non-empty
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  -- lock initiator; active ADMIN only (operator + rider denied)
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  -- ATOMIC session-version guard under the actor lock
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  -- lock order (serialization point for all financial ops on this order)
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- (A) same-scope idempotency FIRST. If present, fetch the immutable payment
  -- basis with a plain SELECT so the replay digest includes the original basis
  -- identity; never use metadata, request input, or mutable order fields.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund' AND idem_scope_key = p_idem_scope_key;
  IF FOUND THEN
    SELECT * INTO v_basis FROM public.order_financial_events
      WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
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

  -- immutable payment basis (authoritative amount + method); one per order
  SELECT * INTO v_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
    ORDER BY created_at ASC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_NO_PAYMENT_BASIS' USING ERRCODE='22023'; END IF;

  -- (B) already refunded under a DIFFERENT key (ledger authority;
  -- ordenes.refunded is written as a mirror but NEVER consulted as authority)
  SELECT * INTO v_existing_refund FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund'
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_ALREADY_REFUNDED' USING ERRCODE='22023';
  END IF;

  -- (C) NEW refund: derive fresh snapshots from current trusted state + basis
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

  UPDATE public.ordenes SET refunded = true
   WHERE id = p_order_id;   -- estado/pay-flags/metodo_pago/manual_giro_id/pricing/cancel-ts preserved

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$fn$;

-- ── RPC 4 — order_void (guarded; canonical-zero replay fix preserved) ────────────────
CREATE FUNCTION public.order_void(
  p_order_id text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_pay_event public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_pay_state text; v_canon jsonb; v_digest text; v_replay_digest text; v_now timestamptz := now();
BEGIN
  -- input guards
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

  -- reason mandatory, trimmed non-empty
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  -- lock initiator; active admin/operator (rider denied)
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  -- ATOMIC session-version guard under the actor lock
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  -- lock order
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- (A) same-scope idempotency FIRST — reconstruct the candidate digest from the
  -- EXISTING void event's IMMUTABLE snapshots so a committed void replays cleanly
  -- even though the order is already ANULADO (before the state rejection below).
  -- The void amount/method/legacy are canonical constants (literal 0 / NULL / false),
  -- serialized identically to the fresh-insert canon so numeric column scale (0.00)
  -- can never diverge the digest. Fail closed unless the existing row is a genuine
  -- void shape.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'void' AND idem_scope_key = p_idem_scope_key;
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

  -- (B) pay state derived ONLY from the ledger (never mutable order flags):
  -- refund wins, else basis, else no row = unpaid.
  SELECT * INTO v_pay_event FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('refund','payment','payment_imported')
    ORDER BY CASE WHEN type = 'refund' THEN 1 ELSE 2 END, created_at ASC
    LIMIT 1;
  IF FOUND AND v_pay_event.type = 'refund' THEN
    v_pay_state := 'refunded';
  ELSIF FOUND THEN
    v_pay_state := 'paid';
  ELSE
    v_pay_state := 'unpaid';
  END IF;

  -- (C) NEW void allowed only from the four active states (grammar-consistent)
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

  -- one immutable void event + order state transition (one transaction)
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'void', 0, NULL, v_reason, false, p_by_actor, v_role,
    v_ord.estado, 'ANULADO', v_pay_state, v_pay_state, v_ord.manual_giro_id,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET estado = 'ANULADO', cancelado_at = v_now
   WHERE id = p_order_id;   -- manual_giro_id/pay-flags/metodo_pago/refunded/pricing/delivery retained

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$fn$;

-- ── grants: service_role only (owner retains); guarded signatures ─────────────────────
REVOKE ALL ON FUNCTION public.order_mark_paid(text, text, text, text, integer, text, jsonb, text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text)                                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_void(text, text, text, integer, text, jsonb, text)                                      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_mark_paid(text, text, text, text, integer, text, jsonb, text)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.order_import_legacy_payment(text, numeric, text, text, text, integer, text, jsonb, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_refund(text, text, text, integer, text, jsonb, text)                                    TO service_role;
GRANT EXECUTE ON FUNCTION public.order_void(text, text, text, integer, text, jsonb, text)                                      TO service_role;

COMMIT;
