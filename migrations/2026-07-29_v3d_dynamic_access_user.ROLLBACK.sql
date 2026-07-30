-- migrations/2026-07-29_v3d_dynamic_access_user.ROLLBACK.sql
-- Access Control V3 -- Block V3-D rollback. DRAFT ONLY, NOT APPLIED.
--
-- GUARDED, not automatic: refuses rather than guesses. It removes only what the forward
-- migration created (the two dormant RPCs and the widened identity/display-name
-- constraints) and ONLY when it can prove nothing has used the new capability yet:
--   * zero UUID-shaped auth_actors rows may exist -- their presence means a dynamic user
--     was actually created, and reverting the identity CHECK back to the closed 4-value
--     form would make that row's own id fail validation on any future re-check;
--   * zero user_created/user_renamed audit rows may exist -- their presence means the
--     RPCs actually ran and produced attributable history this rollback will not erase
--     or reinterpret;
--   * zero create_access_user_v3/rename_access_user_v3 idempotency records may exist --
--     "safe deletion" of those records is never assumed, only refused;
--   * (redundant, explicit) zero auth_actor_pin_fingerprints rows may reference a
--     non-legacy actor -- structurally implied by the first check (fingerprints FK to
--     auth_actors) but verified directly rather than trusted.
-- auth_set_actor_pin_v2, auth_set_actor_pin_v3, auth_change_actor_role_v3, every legacy
-- actor, every PIN hash, and every fingerprint row are untouched by this file -- nothing
-- below references or deletes them, and this rollback NEVER deletes a dynamic user to
-- make itself pass.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-D rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── refuse if any dynamic (UUID) actor has actually been created ─────────────────
DO $$
DECLARE v_dynamic_count int;
BEGIN
  SELECT count(*) INTO v_dynamic_count FROM public.auth_actors
   WHERE actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  IF v_dynamic_count <> 0 THEN
    RAISE EXCEPTION 'V3-D rollback refused: % dynamic (UUID) auth_actors row(s) exist — this rollback never deletes a dynamic user or guesses how to convert its identity', v_dynamic_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── refuse if any V3-D audit history exists ───────────────────────────────────────
DO $$
DECLARE v_audit_count int;
BEGIN
  SELECT count(*) INTO v_audit_count FROM public.auth_audit WHERE event IN ('user_created', 'user_renamed');
  IF v_audit_count <> 0 THEN
    RAISE EXCEPTION 'V3-D rollback refused: % user_created/user_renamed audit row(s) exist — this rollback never rewrites historical audit attribution', v_audit_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── refuse if any create/rename idempotency record exists ────────────────────────
DO $$
DECLARE v_idem_count int;
BEGIN
  SELECT count(*) INTO v_idem_count FROM public.access_management_idempotency
   WHERE action IN ('create_access_user_v3', 'rename_access_user_v3');
  IF v_idem_count <> 0 THEN
    RAISE EXCEPTION 'V3-D rollback refused: % create/rename access-user idempotency record(s) exist — safe deletion is not formally proven, refusing rather than guessing', v_idem_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── redundant, explicit: refuse if any fingerprint row references a non-legacy actor ──
DO $$
DECLARE v_fp_count int;
BEGIN
  SELECT count(*) INTO v_fp_count FROM public.auth_actor_pin_fingerprints
   WHERE actor NOT IN ('owner', 'operator_primary', 'operator_backup', 'rider');
  IF v_fp_count <> 0 THEN
    RAISE EXCEPTION 'V3-D rollback refused: % fingerprint row(s) reference a non-legacy actor', v_fp_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── safe to proceed: remove only what this migration added ───────────────────────
DROP FUNCTION IF EXISTS public.auth_create_access_user_v3(uuid, text, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_rename_access_user_v3(uuid, text, text, text, text, text, text, jsonb);

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_display_name_chk;

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_actor_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_actor_chk
  CHECK (actor IN ('owner', 'operator_primary', 'operator_backup', 'rider'));

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_created_by_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_created_by_chk
  CHECK (created_by IS NULL OR created_by IN ('owner', 'operator_primary', 'operator_backup', 'rider'));

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_updated_by_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_updated_by_chk
  CHECK (updated_by IS NULL OR updated_by IN ('owner', 'operator_primary', 'operator_backup', 'rider'));

ALTER TABLE public.auth_audit DROP CONSTRAINT IF EXISTS auth_audit_target_actor_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_target_actor_chk
  CHECK (target_actor IS NULL OR target_actor IN ('owner', 'operator_primary', 'operator_backup', 'rider'));

ALTER TABLE public.auth_audit DROP CONSTRAINT IF EXISTS auth_audit_by_actor_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_by_actor_chk
  CHECK (by_actor IS NULL OR by_actor IN ('owner', 'operator_primary', 'operator_backup', 'rider'));

NOTIFY pgrst, 'reload schema';

COMMIT;
