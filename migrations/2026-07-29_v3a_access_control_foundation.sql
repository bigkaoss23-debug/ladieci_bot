-- migrations/2026-07-29_v3a_access_control_foundation.sql
-- Access Control V3 — Block V3-A: additive/foundation schema only.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- DRAFT — NOT APPLIED. Additive + idempotent where possible; two explicit, guarded
-- data/constraint changes are described below (both fail closed on drift).
--
-- SCOPE. V3-A widens the DATABASE role vocabulary (a permissive superset) and adds
-- foundation tables. It does NOT:
--   * lift the auth_actors.actor identifier CHECK (still exactly the 4 legacy ids;
--     dynamic actor creation is V3-D);
--   * change the role VALUE of any existing row. The live runtime (jwt.js ROLE_SUB,
--     pinPolicy.ROLE_PIN_RULES, legacyActionRoles.js) still authorizes exclusively
--     against 'admin'/'operator'/'rider' — it has no idea 'owner'/'legacy_operator'
--     exist. Rewriting owner's role to 'owner' or the two operator actors' role to
--     'legacy_operator' in this migration, before any backend deploy teaches the
--     runtime the new vocabulary, would make every one of those actors fail
--     roleSubValid()/ROLE_PIN_RULES lookups on their very next request — a live
--     backward-compatibility break, not a foundation step. A CORRECTED-earlier draft
--     of this migration did exactly that; it is fixed here, not layered around.
--   * auto-map operator_primary -> cashier or operator_backup -> waiter/cashier;
--   * create table_sessions (V3-G);
--   * wire any new runtime authorization decision — the live guard keeps using
--     src/auth/legacyActionRoles.js unchanged; the new registries added alongside
--     this migration (roleRegistry.js / capabilityRegistry.js / actionPolicyRegistry.js)
--     are foundation-only, not yet consulted by any request path.
--
-- WHY the role CHECK still widens even though no row's VALUE changes. The CHECK is
-- widened to the UNION of the legacy vocabulary the runtime still requires
-- ('admin','operator','rider') and the 7 accepted V3 role codes
-- ('owner','cashier','waiter','kitchen','rider','shift_manager','legacy_operator') —
-- 9 distinct values ('rider' is shared, not duplicated). This is a PERMISSIVE
-- database-level allowance, not a statement that 'admin'/'operator' are valid V3 roles
-- (they are not — src/auth/roleRegistry.js's ROLE_CODES is exactly the 7, and
-- 'admin'/'operator' are deliberately absent from it). Real per-row role CONVERSION
-- happens only in V3-C, after the backend is deployed with support for both
-- vocabularies and after an explicit owner decision per actor — never here.
-- pin_hash / session_version / active / failed_count / locked_until / updated_at /
-- updated_by / active_manual_giro_id / role are untouched on every existing row.
BEGIN;

-- Staging-positive guard (same sentinel as every prior auth migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612')
  THEN RAISE EXCEPTION 'V3-A refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- ── 0) precondition — the 4 legacy rows must be exactly where every prior audit
--       found them. Refuse (not guess) if reality has drifted since review time. ──
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM (VALUES
    ('owner','admin'), ('operator_primary','operator'), ('operator_backup','operator'), ('rider','rider')
  ) AS expected(actor, role)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.auth_actors a WHERE a.actor = expected.actor AND a.role = expected.role
  );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'V3-A refused: legacy auth_actors rows do not match the expected pre-V3-A shape — investigate before migrating' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_actors WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'V3-A refused: at least one auth_actors row has no workspace_id — cannot set NOT NULL' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1) auth_actors — additive columns ────────────────────────────────────────
ALTER TABLE public.auth_actors ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.auth_actors ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.auth_actors ADD COLUMN IF NOT EXISTS created_by text;

-- created_by stores an ACTOR IDENTIFIER (same vocabulary as updated_by), never a role
-- or display name. No row was "created by" a human action — all 4 predate V3 and were
-- seeded by the B0 migration itself — so it stays NULL for them, honestly, rather than
-- fabricating an attribution. Mirrors auth_actors_updated_by_chk exactly.
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_created_by_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_created_by_chk
  CHECK (created_by IS NULL OR created_by IN ('owner','operator_primary','operator_backup','rider'));

-- workspace_id becomes mandatory — the precondition above already proved zero NULLs.
ALTER TABLE public.auth_actors ALTER COLUMN workspace_id SET NOT NULL;

-- A NEW, non-partial UNIQUE constraint on (workspace_id, actor). The existing
-- auth_actors_ws_actor_uq (from S2-7D) is a PARTIAL index ("WHERE workspace_id IS NOT
-- NULL") and Postgres cannot use a partial index as a foreign-key target even once the
-- predicate is vacuously true — a composite FK requires a genuine UNIQUE constraint.
-- Safe to add: 4 rows, 4 distinct actor ids, one workspace.
--
-- CREATE-ONLY, never DROP+ADD: this migration itself creates auth_actor_pin_fingerprints
-- with a composite FK that REFERENCES this constraint (below). Once that FK exists, a
-- subsequent re-apply's "DROP CONSTRAINT IF EXISTS auth_actors_ws_actor_key" fails with
-- "cannot drop constraint ... because other objects depend on it" — proven by an actual
-- disposable-Postgres idempotent-re-apply rehearsal, not assumed. The constraint's
-- definition never needs to change, so existence-checked create-only is the correct
-- fix, not a workaround: there is nothing to redefine, only something to create once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_actors_ws_actor_key') THEN
    ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_ws_actor_key UNIQUE (workspace_id, actor);
  END IF;
END $$;

-- ── 2) role vocabulary — CHECK widened to a permissive union; NO row's role VALUE
--       changes. auth_actors_actor_role_map is left COMPLETELY UNTOUCHED: it already
--       correctly requires (owner,admin)/(operator_primary,operator)/
--       (operator_backup,operator)/(rider,rider), and since no row's role changes in
--       this migration, that existing constraint keeps holding without modification. ──
UPDATE public.auth_actors SET display_name = 'Propietario'                    WHERE actor = 'owner'            AND display_name IS NULL;
UPDATE public.auth_actors SET display_name = 'Operador principal heredado'    WHERE actor = 'operator_primary'  AND display_name IS NULL;
UPDATE public.auth_actors SET display_name = 'Operador de apoyo heredado'     WHERE actor = 'operator_backup'   AND display_name IS NULL;
UPDATE public.auth_actors SET display_name = 'Repartidor'                     WHERE actor = 'rider'             AND display_name IS NULL;

-- Transitional union: the 3 legacy values the runtime still requires, PLUS the 7
-- accepted V3 codes (roleRegistry.ROLE_CODES) — 9 distinct values total ('rider' is
-- shared). No existing row uses any of the 6 new-only values yet; V3-C introduces them
-- per-row, only after the backend understands both vocabularies.
ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_role_chk;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_role_chk
  CHECK (role IN ('admin','operator','rider','owner','cashier','waiter','kitchen','shift_manager','legacy_operator'));

-- ── 3) auth_actor_pin_fingerprints — normalized, workspace-wide, key-versioned ──
CREATE TABLE IF NOT EXISTS public.auth_actor_pin_fingerprints (
  actor        text NOT NULL,
  key_id       text NOT NULL CHECK (key_id ~ '^k[0-9]+$'),
  workspace_id uuid NOT NULL,
  fingerprint  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor, key_id),
  FOREIGN KEY (workspace_id, actor) REFERENCES public.auth_actors (workspace_id, actor)
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_actor_pin_fp_ws_key_fp_uq
  ON public.auth_actor_pin_fingerprints (workspace_id, key_id, fingerprint);

ALTER TABLE public.auth_actor_pin_fingerprints ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypasses RLS
-- (identical discipline to auth_actors / auth_audit in the B0 migration).

REVOKE ALL ON public.auth_actor_pin_fingerprints FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.auth_actor_pin_fingerprints TO service_role;

COMMENT ON TABLE public.auth_actor_pin_fingerprints IS
  'Access Control V3 — HMAC-keyed PIN fingerprints for O(1) direct-PIN login lookup. '
  'NOT backfilled from existing pin_hash values (plaintext PINs are unavailable) — '
  'populated only on next successful login (compatibility path) or PIN provisioning '
  '(setAccessUserPin). Never contains a PIN, hash, or the HMAC secret itself.';

-- ── 4) access_management_idempotency — additive, INERT until the V3-D API cutover ──
-- No runtime code reads or writes this table in V3-A. Created now because its shape is
-- fully decided (session-bound: workspace_id + by_actor + by_sid_hash + action +
-- client_request_id, per the frozen idempotency design) and creating it later would be
-- no safer — but nothing calls it yet, so it stays completely inert.
CREATE TABLE IF NOT EXISTS public.access_management_idempotency (
  workspace_id       uuid NOT NULL REFERENCES public.workspaces(id),
  by_actor           text NOT NULL,
  by_sid_hash        text NOT NULL,
  action             text NOT NULL,
  client_request_id  text NOT NULL,
  request_hash       text NOT NULL,
  response_status    integer NOT NULL,
  response_body      jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, by_actor, by_sid_hash, action, client_request_id)
);

ALTER TABLE public.access_management_idempotency ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypasses RLS.

REVOKE ALL ON public.access_management_idempotency FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.access_management_idempotency TO service_role;

COMMENT ON TABLE public.access_management_idempotency IS
  'Access Control V3 — idempotency records for access-management writes (V3-D). '
  'by_sid_hash is sha256(sid), never the raw session id. Never contains a token, '
  'step-up proof, PIN, hash, or fingerprint. Inert in V3-A: no runtime path uses it yet.';

-- ── 5) auth_audit — widen event vocabulary (verified against the LIVE constraint,
--       not the original B0 file — auth_active_events/auth_unlocked_event already
--       added actor_disabled/actor_enabled/actor_unlocked since B0) ──────────────
ALTER TABLE public.auth_audit DROP CONSTRAINT IF EXISTS auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  -- pre-existing (verified live, 11 values)
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled','actor_unlocked',
  -- new V3 vocabulary (11 values)
  'user_created','user_renamed','role_changed','user_deactivated','user_reactivated',
  'access_denied','credential_cleared','fingerprint_upgraded','session_invalidated',
  'rate_limit_triggered','migration_login_used'
));

NOTIFY pgrst, 'reload schema';

COMMIT;
