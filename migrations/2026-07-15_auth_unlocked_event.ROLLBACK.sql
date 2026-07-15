-- migrations/2026-07-15_auth_unlocked_event.ROLLBACK.sql
-- Guarded rollback for the B6 PREREQUISITE actor_unlocked event extension.
-- ***STAGING ONLY*** (tdikhfeinufaahagmpjz)
-- Reverts ONLY the event-enum extension: narrows auth_audit_event_chk back to the
-- previous 10-event allowlist (without actor_unlocked). Touches no other
-- function/table/column/data/RLS/grant. REFUSES if any audit row already uses
-- 'actor_unlocked' (the CHECK could not be narrowed without violating it, and
-- audit rows are append-only — never delete/rewrite them). Do NOT run in tests.
BEGIN;
DO $$
DECLARE v_new int;
BEGIN
  IF to_regclass('public.auth_audit') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: auth_audit missing — unexpected state.';
  END IF;
  SELECT count(*) INTO v_new FROM public.auth_audit WHERE event = 'actor_unlocked';
  IF v_new > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % audit rows use actor_unlocked; manual review required.', v_new;
  END IF;
END $$;

-- restore the previous event enum (10 events; actor_unlocked removed)
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled'));

COMMIT;
