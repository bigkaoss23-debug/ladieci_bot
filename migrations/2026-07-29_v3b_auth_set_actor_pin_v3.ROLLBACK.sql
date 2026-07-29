-- migrations/2026-07-29_v3b_auth_set_actor_pin_v3.ROLLBACK.sql
-- Reverts 2026-07-29_v3b_auth_set_actor_pin_v3.sql. STAGING ONLY.
--
-- Drops ONLY the v3 function. Never touches auth_set_actor_pin_v2 (preserved exactly
-- as-is), never touches auth_actors.pin_hash for any actor, never touches
-- auth_actor_pin_fingerprints (that table's own lifecycle belongs to V3-A, not this
-- migration) — this rollback's blast radius is exactly the one function it created.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-B rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── precondition — refuse if removing v3 would strand credential state ────────
-- Any fingerprint row existing is strong evidence a real rotation has already flowed
-- through v3 (nothing else in this codebase writes that table outside a manual/test
-- fixture) — i.e. runtime has already been cut over to V3 in a later phase. Dropping
-- v3 at that point would not lose any pin_hash or fingerprint data (neither is touched
-- here), but it WOULD silently remove the only path currently able to keep both
-- fingerprint versions in sync on a future rotation for those actors — an operational
-- regression, not a safe rollback. Refuse and let a human decide explicitly.
DO $$
DECLARE v_fp_rows int;
BEGIN
  SELECT count(*) INTO v_fp_rows FROM public.auth_actor_pin_fingerprints;
  IF v_fp_rows <> 0 THEN
    RAISE EXCEPTION 'V3-B rollback refused: % row(s) exist in auth_actor_pin_fingerprints — evidence that runtime may already depend on auth_set_actor_pin_v3; removing it would strand that credential-management path, not just schema. Data loss/regression requires an explicit decision, not an automatic rollback.', v_fp_rows
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── drop exactly the one function this migration created ──────────────────────
DROP FUNCTION IF EXISTS public.auth_set_actor_pin_v3(text, text, text, text, jsonb, text, text, text, text, text, uuid, uuid, text, text, jsonb);

-- ── postcondition — v2 must still be present, exactly as before, untouched ─────
DO $$
DECLARE v_v2_found int;
BEGIN
  SELECT count(*) INTO v_v2_found
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='auth_set_actor_pin_v2'
     AND oidvectortypes(p.proargtypes) = 'text, text, text, text, jsonb, text, uuid, uuid, text, text, jsonb';
  IF v_v2_found <> 1 THEN
    RAISE EXCEPTION 'V3-B rollback failed: auth_set_actor_pin_v2 is no longer present with its exact expected signature — this rollback must never have touched it' USING ERRCODE = 'P0001';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
