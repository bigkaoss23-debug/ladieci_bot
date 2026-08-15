-- migrations/2026-08-15_s1_auth_audit_payment_events.ROLLBACK.sql
-- Reverts ONLY the two-event widening (PAYMENT_REPLAY_DIFFERENT_ACTOR,
-- PAYMENT_DUPLICATE_CONFIRMED). Narrows auth_audit_event_chk back to the
-- pre-existing 22-event allowlist. Touches no other function/table/column/
-- data/RLS/grant. REFUSES if any audit row already uses either new event
-- (the CHECK could not be narrowed without violating it, and audit rows are
-- append-only -- never delete/rewrite them).
--
-- Rolling this back while row 71 (2026-08-15_s1_guard_null_payment_idempotency.sql)
-- remains applied would reopen the exact CHECK-violation gap this migration
-- closes -- only roll back together with row 71 itself, never alone, unless
-- deliberately reintroducing the gap.

DO $$
DECLARE
  v_chk text;
  v_rows integer;
BEGIN
  IF to_regclass('public.auth_audit') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: auth_audit missing -- unexpected state.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_chk
    FROM pg_constraint
   WHERE conrelid = 'public.auth_audit'::regclass AND conname = 'auth_audit_event_chk';
  IF v_chk IS NULL
     OR v_chk NOT LIKE '%PAYMENT_REPLAY_DIFFERENT_ACTOR%'
     OR v_chk NOT LIKE '%PAYMENT_DUPLICATE_CONFIRMED%'
  THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: auth_audit_event_chk does not carry both S1 payment events -- nothing to roll back, or already rolled back';
  END IF;

  SELECT count(*) INTO v_rows FROM public.auth_audit
   WHERE event IN ('PAYMENT_REPLAY_DIFFERENT_ACTOR', 'PAYMENT_DUPLICATE_CONFIRMED');
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % audit row(s) already use PAYMENT_REPLAY_DIFFERENT_ACTOR/PAYMENT_DUPLICATE_CONFIRMED; manual review required.', v_rows;
  END IF;
END $$;

ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled','actor_unlocked',
  'user_created','user_renamed','role_changed','user_deactivated','user_reactivated',
  'access_denied','credential_cleared','fingerprint_upgraded','session_invalidated',
  'rate_limit_triggered','migration_login_used'));
