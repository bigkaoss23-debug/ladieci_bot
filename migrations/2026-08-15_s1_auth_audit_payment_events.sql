-- migrations/2026-08-15_s1_auth_audit_payment_events.sql
-- MESA REMEDIATION S1 — auth_audit.event CHECK widening for the two new
-- payment-audit events row 71 (2026-08-15_s1_guard_null_payment_idempotency.sql)
-- already inserts: PAYMENT_REPLAY_DIFFERENT_ACTOR (replay-by-different-actor,
-- mesa_post_payment_v1) and PAYMENT_DUPLICATE_CONFIRMED (p_confirm_duplicate
-- override, mesa_post_payment_v1). Row 71 was applied to STAGING before this
-- gap was found live: any payment that hits either audit path aborted the
-- WHOLE payment with a CHECK violation on auth_audit_event_chk, because
-- neither literal was ever added to the allowed event list. Authority:
-- MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S1 (§19 IDEMPOTENCY:
-- "appends an auth_audit row naming the replaying actor"; MIGRATION_MANIFEST.md
-- row 71 header, fixes B and C).
--
-- Same widen-never-narrow discipline as every prior auth_audit_event_chk
-- migration (2026-07-13_auth_active_events, 2026-07-15_auth_unlocked_event,
-- 2026-07-29_v3a_access_control_foundation): DROP + ADD CONSTRAINT, preserving
-- every currently allowed event verbatim, adding exactly these two. Additive
-- only -- no table/column/function/RLS/grant/data change. Row 71's own DB
-- objects (guard_service_session_closed_v1, payment_transactions_idempotency_uq,
-- mesa_post_payment_v1) are NOT touched here -- this closes the CHECK-constraint
-- gap row 71 left open, as its OWN migration, because row 71 is already applied
-- to STAGING and its file must not be rewritten after the fact (would
-- misrepresent applied history / desync its recorded checksum).
--
-- Deliberately does NOT touch src/auth/audit.js's Node-side ALLOWED_EVENTS:
-- mesa_post_payment_v1 writes auth_audit directly via SQL, inside the Postgres
-- function, and never calls Node's assertEvent -- ALLOWED_EVENTS has zero
-- bearing on whether this insert succeeds. Widening it would also force an
-- edit to tests/authDao.test.js's unrelated hardcoded ALLOWED_EVENTS.length
-- === 8+3+11 assertion for a different subsystem, outside this fix's scope.
--
-- Casing note: every pre-existing event is lower_snake_case; these two are
-- UPPER_SNAKE_CASE. That mismatch is intentional continuity, not a new
-- convention chosen here -- it reproduces literally what row 71's own
-- already-applied function body inserts (mesa_post_payment_v1, verified live
-- against pg_get_functiondef: 'PAYMENT_REPLAY_DIFFERENT_ACTOR',
-- 'PAYMENT_DUPLICATE_CONFIRMED'), and what MIGRATION_MANIFEST.md row 71's own
-- header already documents in the same casing. Changing the casing here would
-- require re-patching row 71's live function bodies, out of scope for closing
-- this CHECK gap.
--
-- Paired .ROLLBACK.sql narrows the CHECK back to the pre-existing 22-event
-- set; refuses if any auth_audit row already uses either new event (audit
-- rows are append-only -- never delete/rewrite them).

DO $$
DECLARE
  v_chk text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_chk
    FROM pg_constraint
   WHERE conrelid = 'public.auth_audit'::regclass AND conname = 'auth_audit_event_chk';
  IF v_chk IS NULL THEN
    RAISE EXCEPTION 'S1 auth_audit widen refused: auth_audit_event_chk not found -- resolve drift first';
  END IF;
  IF v_chk LIKE '%PAYMENT_REPLAY_DIFFERENT_ACTOR%' OR v_chk LIKE '%PAYMENT_DUPLICATE_CONFIRMED%' THEN
    RAISE EXCEPTION 'S1 auth_audit widen refused: auth_audit_event_chk already carries one or both new events -- already patched, resolve drift first';
  END IF;
  IF v_chk NOT LIKE '%migration_login_used%' THEN
    RAISE EXCEPTION 'S1 auth_audit widen refused: auth_audit_event_chk does not carry the expected pre-widen 22-event set (missing migration_login_used) -- resolve drift first';
  END IF;
END $$;

ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled','actor_unlocked',
  'user_created','user_renamed','role_changed','user_deactivated','user_reactivated',
  'access_denied','credential_cleared','fingerprint_upgraded','session_invalidated',
  'rate_limit_triggered','migration_login_used',
  'PAYMENT_REPLAY_DIFFERENT_ACTOR','PAYMENT_DUPLICATE_CONFIRMED'));
