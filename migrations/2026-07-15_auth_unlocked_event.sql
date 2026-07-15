-- migrations/2026-07-15_auth_unlocked_event.sql
-- Access Control V2 — B6 PREREQUISITE (actor_unlocked audit event extension).
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive/corrective. Extends ONLY auth_audit.event enum with the dedicated
-- 'actor_unlocked' event required by the future B6A auth_admin_unlock_actor RPC.
-- Touches NO table column, NO data, NO RLS, NO grant, NO function/RPC. Preserves
-- every currently allowed event exactly. NOT APPLIED — unwired, staging-only.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'B6-PRE refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Extend the event enum: drop + recreate the CHECK preserving all 10 existing
-- events (B0 + B2 actor_disabled/actor_enabled) and adding exactly actor_unlocked.
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled','actor_unlocked'));

COMMIT;
