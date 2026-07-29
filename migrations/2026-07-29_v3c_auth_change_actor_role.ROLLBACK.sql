-- migrations/2026-07-29_v3c_auth_change_actor_role.ROLLBACK.sql
-- Access Control V3 — Block V3-C rollback. DRAFT ONLY, NOT APPLIED.
--
-- GUARDED, not automatic: refuses rather than guesses. It removes only what the forward
-- migration created (the dormant RPC and the relaxed constraint) and ONLY when it can
-- prove nothing has used them yet:
--   * every auth_actors row's role must still be its exact pre-V3-C value — if any row
--     differs, an explicit, owner-approved role change already happened, and this
--     rollback will NOT attempt to reverse that decision;
--   * zero access_management_idempotency rows may exist for action='change_actor_role' —
--     their presence means the RPC was actually invoked, successfully or as a recorded
--     no-op; "safe deletion" of those records is never assumed, only refused.
-- auth_set_actor_pin_v2, auth_set_actor_pin_v3, every actor, every PIN hash, and every
-- fingerprint row are untouched by this file — nothing below references them.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-C rollback refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── refuse if any explicit role change has already happened ──────────────────────
DO $$
DECLARE v_drifted int;
BEGIN
  SELECT count(*) INTO v_drifted FROM public.auth_actors a
   WHERE NOT EXISTS (
     SELECT 1 FROM (VALUES
       ('owner','admin'), ('operator_primary','operator'), ('operator_backup','operator'), ('rider','rider')
     ) AS expected(actor, role) WHERE expected.actor = a.actor AND expected.role = a.role
   );
  IF v_drifted <> 0 THEN
    RAISE EXCEPTION 'V3-C rollback refused: at least one auth_actors row no longer matches its pre-V3-C role — an explicit role change already happened; this rollback never guesses how to reverse an owner-approved decision' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── refuse if any role-change idempotency record exists ──────────────────────────
DO $$
DECLARE v_idem_count int;
BEGIN
  SELECT count(*) INTO v_idem_count FROM public.access_management_idempotency WHERE action = 'change_actor_role';
  IF v_idem_count <> 0 THEN
    RAISE EXCEPTION 'V3-C rollback refused: % change_actor_role idempotency record(s) exist — safe deletion is not formally proven, refusing rather than guessing', v_idem_count USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── safe to proceed: remove only the dormant RPC, restore the original 1:1 map ───
DROP FUNCTION IF EXISTS public.auth_change_actor_role_v3(uuid, text, text, text, text, text, text, text, jsonb);

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_actor_role_map;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_actor_role_map CHECK (
  (actor='owner'            and role='admin')    or
  (actor='operator_primary' and role='operator') or
  (actor='operator_backup'  and role='operator') or
  (actor='rider'            and role='rider')
);

NOTIFY pgrst, 'reload schema';

COMMIT;
