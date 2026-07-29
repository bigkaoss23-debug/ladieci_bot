-- migrations/2026-07-29_v3a_access_control_foundation.ROLLBACK.sql
-- Reverts 2026-07-29_v3a_access_control_foundation.sql. STAGING ONLY.
--
-- Fails closed (refuses) rather than narrowing a CHECK or reverting role data out from
-- under rows that have already moved further into V3 (a real reassignment via V3-C, or a
-- real audit row using a V3-only event, or any dynamic actor-fingerprint data). Rollback
-- is only safe while V3-A's own changes are the ONLY things that happened since it applied.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-A rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── precondition — refuse if anything has moved further into V3 since forward-apply ──
DO $$
DECLARE v_bad_role int; v_bad_event int; v_fp_rows int;
BEGIN
  -- Forward V3-A never changes any row's role value — it only widens the CHECK to a
  -- permissive union. So EVERY V3-only value (all 6: owner, cashier, waiter, kitchen,
  -- shift_manager, legacy_operator — not just the 4 "new business roles") is equally
  -- foreign to a legitimate post-V3-A-forward, pre-V3-C state. Any row holding one of
  -- these six means a LATER migration (V3-C) has already done real per-row conversion;
  -- narrowing the CHECK back to admin/operator/rider would corrupt that row.
  SELECT count(*) INTO v_bad_role FROM public.auth_actors
   WHERE role IN ('owner','cashier','waiter','kitchen','shift_manager','legacy_operator');
  IF v_bad_role <> 0 THEN
    RAISE EXCEPTION 'V3-A rollback refused: % auth_actors row(s) already carry a V3-only role — narrowing would corrupt them', v_bad_role
      USING ERRCODE = 'P0001';
  END IF;

  -- No audit row may use a V3-only event — narrowing auth_audit_event_chk back would
  -- make existing history violate the constraint.
  SELECT count(*) INTO v_bad_event FROM public.auth_audit
   WHERE event IN ('user_created','user_renamed','role_changed','user_deactivated',
                   'user_reactivated','access_denied','credential_cleared',
                   'fingerprint_upgraded','session_invalidated','rate_limit_triggered',
                   'migration_login_used');
  IF v_bad_event <> 0 THEN
    RAISE EXCEPTION 'V3-A rollback refused: % auth_audit row(s) already use a V3-only event — cannot narrow the CHECK', v_bad_event
      USING ERRCODE = 'P0001';
  END IF;

  -- Fingerprint rows existing means direct-PIN login data is live — rolling back the
  -- table would destroy it silently. Refuse; an operator must decide explicitly.
  SELECT count(*) INTO v_fp_rows FROM public.auth_actor_pin_fingerprints;
  IF v_fp_rows <> 0 THEN
    RAISE EXCEPTION 'V3-A rollback refused: % row(s) exist in auth_actor_pin_fingerprints — data loss requires an explicit decision, not an automatic rollback', v_fp_rows
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── auth_audit — narrow the event CHECK back to the pre-V3-A (verified live) set ──
ALTER TABLE public.auth_audit DROP CONSTRAINT IF EXISTS auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled','actor_unlocked'
));

-- ── drop the two new tables (both empty per the precondition above) ──────────
DROP TABLE IF EXISTS public.access_management_idempotency;
DROP TABLE IF EXISTS public.auth_actor_pin_fingerprints;

-- ── auth_actors — revert the CHECK only; there is no role DATA to revert, and
--    auth_actors_actor_role_map was never touched by forward, so it is left alone here
--    too. The precondition above already proved every row's role is still one of
--    admin/operator/rider, so narrowing directly is safe — no transient widening step
--    is needed (that was only ever required to legalize a data revert, and there is none).
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_role_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_role_chk
  CHECK (role IN ('admin','operator','rider'));

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_ws_actor_key;
ALTER TABLE public.auth_actors ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_created_by_chk;

ALTER TABLE public.auth_actors DROP COLUMN IF EXISTS created_by;
ALTER TABLE public.auth_actors DROP COLUMN IF EXISTS created_at;
ALTER TABLE public.auth_actors DROP COLUMN IF EXISTS display_name;

NOTIFY pgrst, 'reload schema';

COMMIT;
