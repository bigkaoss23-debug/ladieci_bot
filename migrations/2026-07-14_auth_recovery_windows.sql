-- migrations/2026-07-14_auth_recovery_windows.sql
-- Access Control V2 — Block B5 (bootstrap/recovery emergency admin access).
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive. Creates public.auth_recovery_windows + 2 SECURITY INVOKER RPCs
-- (register + atomic consume). Does NOT alter B0/B2 tables or functions. No
-- dynamic SQL. Fully-qualified refs. Pinned search_path. Execute revoked from
-- public/anon/authenticated. Reuses the EXISTING B0 audit events 'bootstrap' /
-- 'recovery' (no allowlist change). NOT APPLIED — unwired, staging-only.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B5 refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── one-shot recovery/bootstrap windows ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.auth_recovery_windows (
  window_id        text primary key
                   constraint arw_window_id_uuid_chk
                     check (window_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  purpose          text not null
                   constraint arw_purpose_chk check (purpose in ('bootstrap','recovery')),
  actor            text not null
                   references public.auth_actors(actor) on delete restrict,
  secret_digest    text not null                          -- sha256 hex of the window secret; NEVER the plaintext
                   constraint arw_secret_digest_chk check (secret_digest ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz,                           -- NULL until the single successful consumption
  consumed_ip_hash text
                   constraint arw_consumed_ip_hash_chk check (consumed_ip_hash is null or length(consumed_ip_hash) <= 64),
  metadata         jsonb not null default '{}'::jsonb     -- NEVER PIN/JWT/secret/API key
                   constraint arw_metadata_obj_chk check (jsonb_typeof(metadata) = 'object'),
  constraint arw_expires_after_created check (expires_at > created_at),
  constraint arw_max_lifetime_15min    check (expires_at <= created_at + interval '15 minutes')
);
create index if not exists auth_recovery_windows_actor_idx on public.auth_recovery_windows (actor);

alter table public.auth_recovery_windows enable row level security;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypasses
-- RLS and reaches the table only through the two SECURITY INVOKER RPCs below.

comment on table public.auth_recovery_windows is
  'Access Control V2 — one-shot bootstrap/recovery windows; secret digest only, never plaintext; service_role-only (B5).';

-- ── register: idempotent, immutable, never reopens a consumed window ──────────
CREATE OR REPLACE FUNCTION public.auth_register_recovery_window(
  p_window_id text, p_purpose text, p_actor text, p_secret_digest text,
  p_expires_at timestamptz, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_meta jsonb := COALESCE(p_meta,'{}'::jsonb); e public.auth_recovery_windows%ROWTYPE; v_now timestamptz := now();
BEGIN
  IF p_purpose NOT IN ('bootstrap','recovery') THEN RAISE EXCEPTION 'AUTH_WINDOW_PURPOSE_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  -- server/db time is authoritative for the lifetime bounds
  IF p_expires_at <= v_now THEN RAISE EXCEPTION 'AUTH_WINDOW_EXPIRED' USING ERRCODE='22023'; END IF;
  IF p_expires_at > v_now + interval '15 minutes' THEN RAISE EXCEPTION 'AUTH_WINDOW_LIFETIME_EXCEEDED' USING ERRCODE='22023'; END IF;

  INSERT INTO public.auth_recovery_windows(window_id, purpose, actor, secret_digest, created_at, expires_at, metadata)
  VALUES (p_window_id, p_purpose, p_actor, p_secret_digest, v_now, p_expires_at, v_meta)
  ON CONFLICT (window_id) DO NOTHING;

  IF FOUND THEN
    RETURN jsonb_build_object('window_id', p_window_id, 'registered', true, 'existed', false, 'consumed', false);
  END IF;

  -- Conflict: the descriptor is immutable. Verify an EXACT match; never reset
  -- consumed_at; never reopen. A restart/second instance re-registering the same
  -- descriptor is a safe no-op; an altered descriptor fails closed.
  SELECT * INTO e FROM public.auth_recovery_windows WHERE window_id = p_window_id;
  IF e.purpose <> p_purpose OR e.actor <> p_actor
     OR e.secret_digest <> p_secret_digest OR e.expires_at <> p_expires_at THEN
    RAISE EXCEPTION 'AUTH_WINDOW_DESCRIPTOR_MISMATCH' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('window_id', p_window_id, 'registered', true, 'existed', true,
                            'consumed', e.consumed_at IS NOT NULL);
END;
$fn$;

-- ── consume: ONE transaction — window one-shot + actor PIN replacement + audit ─
-- Any failure leaves the actor unchanged, the window unconsumed, and writes no
-- success audit row. A second use fails closed with no further actor mutation.
CREATE OR REPLACE FUNCTION public.auth_consume_recovery_window(
  p_window_id text, p_purpose text, p_actor text, p_secret_digest text,
  p_new_hash text, p_ip_hash text DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE w public.auth_recovery_windows%ROWTYPE; a public.auth_actors%ROWTYPE; v_sv int;
        v_meta jsonb := COALESCE(p_meta,'{}'::jsonb); v_now timestamptz := now();
BEGIN
  IF p_purpose NOT IN ('bootstrap','recovery') THEN RAISE EXCEPTION 'AUTH_WINDOW_PURPOSE_INVALID' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  -- shape guard for the pre-hashed PIN (real hashing is B1 in Node; never plaintext here)
  IF p_new_hash IS NULL OR left(p_new_hash, 7) <> 'scrypt$' THEN RAISE EXCEPTION 'AUTH_HASH_INVALID' USING ERRCODE='22023'; END IF;

  -- 1) lock the window row
  SELECT * INTO w FROM public.auth_recovery_windows WHERE window_id = p_window_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_WINDOW_INVALID' USING ERRCODE='P0002'; END IF;
  -- 2) verify descriptor + one-shot + expiry (server time)
  IF w.purpose <> p_purpose OR w.actor <> p_actor OR w.secret_digest <> p_secret_digest THEN
    RAISE EXCEPTION 'AUTH_WINDOW_INVALID' USING ERRCODE='22023'; END IF;
  IF w.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'AUTH_WINDOW_CONSUMED' USING ERRCODE='22023'; END IF;
  IF w.expires_at <= v_now THEN RAISE EXCEPTION 'AUTH_WINDOW_EXPIRED' USING ERRCODE='22023'; END IF;

  -- 3) lock the target actor row
  SELECT * INTO a FROM public.auth_actors WHERE actor = w.actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- 4) stored role must be exactly admin
  IF a.role <> 'admin' THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_ADMIN' USING ERRCODE='22023'; END IF;
  -- 5) pin-presence precondition
  IF p_purpose = 'bootstrap' AND a.pin_hash IS NOT NULL THEN RAISE EXCEPTION 'AUTH_PIN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  IF p_purpose = 'recovery' AND a.pin_hash IS NULL     THEN RAISE EXCEPTION 'AUTH_PIN_STATE_CONFLICT' USING ERRCODE='22023'; END IF;

  -- 6-9) set new hash, reset failed/lock, activate, bump session_version
  UPDATE public.auth_actors
     SET pin_hash = p_new_hash, failed_count = 0, locked_until = NULL, active = true,
         session_version = session_version + 1, updated_at = v_now, updated_by = w.actor
   WHERE actor = w.actor RETURNING session_version INTO v_sv;

  -- 10) mark the window consumed (one-shot)
  UPDATE public.auth_recovery_windows
     SET consumed_at = v_now, consumed_ip_hash = p_ip_hash
   WHERE window_id = p_window_id;

  -- 11) audit in the SAME transaction. event = purpose; by_actor NULL (emergency,
  -- no human JWT). meta carries purpose + window_id only (no secret/hash).
  INSERT INTO public.auth_audit(event, target_actor, by_actor, ip_hash, meta)
  VALUES (p_purpose, w.actor, NULL, p_ip_hash,
          v_meta || jsonb_build_object('purpose', p_purpose, 'window_id', p_window_id));

  RETURN jsonb_build_object('actor', w.actor, 'purpose', p_purpose, 'session_version', v_sv, 'consumed', true);
END;
$fn$;

-- ── grants: service_role only ────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.auth_register_recovery_window(text, text, text, text, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.auth_consume_recovery_window(text, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_register_recovery_window(text, text, text, text, timestamptz, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_consume_recovery_window(text, text, text, text, text, text, jsonb) TO service_role;

COMMIT;
