-- migrations/2026-07-15_b7_financial_ledger_grant_hardening.sql
-- Access Control V2 / B7A1 — privilege hardening for the immutable ledger.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive/corrective. Overrides Supabase platform-default broad privileges on
-- public.order_financial_events so that service_role has EXACTLY SELECT + INSERT,
-- and removes direct EXECUTE on the append-only trigger function. Changes ONLY
-- privileges: NO schema, data, RLS, policy, trigger or function-body change; NO
-- business RPC; NO GRANT ALL. Touches only the ledger table + its trigger
-- function. Does NOT edit the already-applied B7A1 foundation migration.
--
-- Trigger-function EXECUTE safety: in PostgreSQL a trigger function is invoked by
-- the trigger mechanism and does NOT require EXECUTE privilege on the function
-- (trigger firing performs no EXECUTE permission check). Revoking direct EXECUTE
-- from service_role/PUBLIC/anon/authenticated therefore does NOT disable the
-- append-only trigger; the table owner retains EXECUTE. The trigger definition,
-- SECURITY INVOKER status, search_path and body are left unchanged.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6/B7A1).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B7A1-HARDEN refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Precondition: the B7A1 ledger table must already exist.
DO $$
BEGIN
  IF to_regclass('public.order_financial_events') IS NULL
  THEN RAISE EXCEPTION 'B7A1-HARDEN refused: order_financial_events missing — apply B7A1 foundation first.'; END IF;
END $$;

-- ── table privileges: service_role restricted to SELECT + INSERT ─────────────
REVOKE ALL PRIVILEGES ON TABLE public.order_financial_events FROM service_role;
GRANT SELECT, INSERT ON TABLE public.order_financial_events TO service_role;
-- reconfirm default-deny for the anon/authenticated/PUBLIC roles
REVOKE ALL PRIVILEGES ON TABLE public.order_financial_events FROM PUBLIC, anon, authenticated;

-- ── trigger-function EXECUTE: infrastructure only, not a business API ─────────
-- Safe (see header): trigger firing needs no EXECUTE privilege; owner keeps it.
REVOKE ALL PRIVILEGES ON FUNCTION public.order_financial_events_append_only()
  FROM service_role, PUBLIC, anon, authenticated;

COMMIT;
