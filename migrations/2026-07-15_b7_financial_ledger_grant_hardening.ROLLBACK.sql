-- migrations/2026-07-15_b7_financial_ledger_grant_hardening.ROLLBACK.sql
-- Rollback for the B7A1 ledger privilege hardening.  ***STAGING ONLY***
-- (tdikhfeinufaahagmpjz).
-- WARNING: running this REINTRODUCES the broad Supabase platform-default table
-- privileges (UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) and direct trigger-
-- function EXECUTE for service_role. It is NOT part of a normal B7 rollback and
-- should only be run intentionally. Changes ONLY privileges: it never alters or
-- deletes ledger rows, never drops the table, and never touches schema, triggers,
-- RLS, policies or functions. Affects only order_financial_events + its trigger
-- function. Do NOT run in this phase.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL
  THEN RAISE EXCEPTION 'ROLLBACK REFUSED: order_financial_events missing — unexpected state.'; END IF;
END $$;

-- restore the exact pre-hardening service_role table privilege set (enumerated;
-- no GRANT ALL). anon/authenticated/PUBLIC were already revoked pre-hardening and
-- are intentionally left with no privileges.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.order_financial_events TO service_role;

-- restore direct trigger-function EXECUTE for service_role (platform default)
GRANT EXECUTE ON FUNCTION public.order_financial_events_append_only() TO service_role;

COMMIT;
