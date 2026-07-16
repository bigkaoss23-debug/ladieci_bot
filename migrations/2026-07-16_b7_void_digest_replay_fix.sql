-- migrations/2026-07-16_b7_void_digest_replay_fix.sql
-- Access Control V2 / B7A2B corrective — order_void idempotent-replay digest fix.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Narrow correction of ONE defect found by the controlled B7A2 staging E2E:
-- the same-key void replay could NEVER return idempotent=true. Root cause was a
-- numeric-scale canonicalization asymmetry — the fresh-insert canon serializes the
-- void amount as the JSON literal 0 (`{"amount": 0}`), but the replay-reconstruction
-- canon used v_existing.amount, a numeric(10,2) column that serializes as 0.00
-- (`{"amount": 0.00}`). `jsonb 0 <> jsonb 0.00` in ::text, so the SHA-256 differed
-- and every same-key void replay raised AUTH_IDEMPOTENCY_CONFLICT.
--
-- FIX (SQL-only, order_void ONLY):
--   * The fresh-insert digest is UNCHANGED (the stored staging void event already
--     matches literal JSON zero). Do NOT touch the insert canon.
--   * The replay-reconstruction canon serializes the void amount as the same
--     scale-independent literal 0, method as literal NULL, legacy as literal false —
--     matching the fresh canon exactly — while still sourcing the immutable state
--     snapshots (prev/new estado, prev/new pay_state, original_giro_id) from the
--     EXISTING event, never from the already-ANULADO current order.
--   * Before returning an existing-event replay, fail CLOSED unless that immutable
--     event is a genuine void shape: type='void', amount=0, payment_method IS NULL,
--     legacy=false, new_estado='ANULADO', prev_pay_state = new_pay_state
--     (AUTH_VOID_REPLAY_INTEGRITY otherwise).
--
-- Everything else is byte-for-byte the committed order_void: exact signature,
-- SECURITY INVOKER, pinned search_path, actor+order FOR UPDATE locks, plain ledger
-- SELECTs (no row locks), all role/meta/ip/idem/state validation, amount=0/method
-- NULL/giro snapshot on the new event, atomic insert+update. Creates NO new RPC;
-- alters NO table/constraint/index/RLS policy/ledger privilege. No dynamic SQL.
-- Does NOT edit or reapply the original B7A2A/B7A2B migrations.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6/B7A1/B7A2A/B7A2B).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B7A2B void-fix refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Preconditions: B7A1 ledger + the committed order_void must already exist (this is
-- a corrective replace, never a first install).
DO $$
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL
  THEN RAISE EXCEPTION 'B7A2B void-fix refused: order_financial_events missing — apply B7A1 foundation first.'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='order_void'
      AND pg_get_function_identity_arguments(p.oid)='p_order_id text, p_reason text, p_by_actor text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text')
  THEN RAISE EXCEPTION 'B7A2B void-fix refused: committed public.order_void(text,text,text,text,jsonb,text) not found — apply B7A2B first.'; END IF;
END $$;

-- ── order_void (operational void → ANULADO) — replay digest corrected ─────────
-- Admin/operator. New void only from POR_CONFIRMAR/EN_COCINA/LISTO/EN_ENTREGA.
-- Pay state derived from the ledger only. No auto-refund; giro snapshot retained.
CREATE OR REPLACE FUNCTION public.order_void(
  p_order_id text, p_reason text, p_by_actor text,
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

  -- reason mandatory, trimmed non-empty
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  -- lock initiator; active admin/operator (rider denied)
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;

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

-- ── grants: service_role only (business authority is the stored actor role) ──
-- Reassert (idempotent) — order_refund grants are untouched by this corrective.
REVOKE ALL ON FUNCTION public.order_void(text, text, text, text, jsonb, text)   FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_void(text, text, text, text, jsonb, text)   TO service_role;

COMMIT;
