-- migrations/2026-07-30_v3e_access_user_lifecycle.ROLLBACK.sql
-- Access Control V3 -- Block V3-E rollback. DRAFT ONLY, NOT APPLIED.
--
-- GUARDED, not automatic: refuses rather than guesses. The forward migration added
-- NOTHING but two functions -- it widened no constraint and created no table, because
-- every audit event V3-E needed ('user_deactivated', 'user_reactivated',
-- 'credential_cleared', 'session_invalidated') was already reserved on
-- auth_audit_event_chk by V3-A. So this rollback has nothing to restore beyond dropping
-- those two functions, and ONLY when it can prove neither was ever actually used:
--   * zero access_management_idempotency rows for
--     deactivate_access_user_v3/reactivate_access_user_v3/
--     clear_access_user_credential_v3 -- their presence means an RPC actually ran;
--   * zero auth_audit rows for user_deactivated/user_reactivated/credential_cleared --
--     their presence means a real lifecycle decision was made and produced attributable
--     history this rollback will not erase or reinterpret.
-- Every actor, every PIN hash, every fingerprint row, and every prior V2/V3-B/V3-C/V3-D
-- writer is untouched by this file -- nothing below references or deletes them, and
-- this rollback NEVER reactivates a user, recreates a cleared credential, or
-- synthesizes a missing fingerprint to make itself pass.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-E rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── refuse if any lifecycle idempotency record exists ────────────────────────────
DO $$
DECLARE v_idem_count int;
BEGIN
  SELECT count(*) INTO v_idem_count FROM public.access_management_idempotency
   WHERE action IN ('deactivate_access_user_v3', 'reactivate_access_user_v3', 'clear_access_user_credential_v3');
  IF v_idem_count <> 0 THEN
    RAISE EXCEPTION 'V3-E rollback refused: % lifecycle idempotency record(s) exist — safe deletion is not formally proven, refusing rather than guessing', v_idem_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── refuse if any real lifecycle decision has already happened ───────────────────
DO $$
DECLARE v_audit_count int;
BEGIN
  SELECT count(*) INTO v_audit_count FROM public.auth_audit
   WHERE event IN ('user_deactivated', 'user_reactivated', 'credential_cleared');
  IF v_audit_count <> 0 THEN
    RAISE EXCEPTION 'V3-E rollback refused: % user_deactivated/user_reactivated/credential_cleared audit row(s) exist — this rollback never reverses a human lifecycle decision', v_audit_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── safe to proceed: remove only the two dormant RPCs ─────────────────────────────
DROP FUNCTION IF EXISTS public.auth_set_access_user_active_v3(uuid, text, text, boolean, boolean, text, text, text, jsonb);
DROP FUNCTION IF EXISTS public.auth_clear_access_user_credential_v3(uuid, text, text, int, text, text, text, jsonb);

NOTIFY pgrst, 'reload schema';

COMMIT;
