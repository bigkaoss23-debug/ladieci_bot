-- migrations/2026-08-22_k1_orden_estado_logs_rls_lockdown.sql
-- K-1 — ORDEN_ESTADO_LOGS RLS LOCKDOWN: an audit log that anyone can rewrite is
-- not an audit log.
--
-- THE FINDING. public.orden_estado_logs was the ONE table in this schema with
-- row level security never enabled, while `anon` and `authenticated` each held
-- the full Supabase default grant (arwdDxtm: SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER). Every other table in the schema has RLS on,
-- so with no policy the browser roles are denied by default; this one had
-- neither gate. Supabase's own linter reports it at ERROR / EXTERNAL
-- (rls_disabled_in_public), and it is the only table it reports.
--
-- It is reachable. The staging publishable key is compiled into the browser
-- bundle (ladieci-app33/netlify.toml), so the write path is PostgREST + a key
-- anyone can read out of the page. Verified directly before this migration:
-- SET ROLE anon, then INSERT / UPDATE / DELETE -- all three ALLOWED (probe run
-- inside a transaction that was aborted; zero rows persisted).
--
-- What is at stake is evidence. This table holds order state-transition
-- history, including the only surviving trace of orders that were later
-- deleted -- for the frozen Nuevo Pedido audit, order #999025 exists nowhere
-- else but as its `created` row here. Audit value depends entirely on the log
-- being append-only from outside and unforgeable.
--
-- THE FIX, and why it is only two lines of privilege. Nothing outside
-- service_role needs this table at all:
--
--   * The backend writes it through src/utils/orderStateLogger.js using
--     SUPABASE_KEY (service_role), and its H1B resource-policy entry permits
--     POST only -- it never reads the table over PostgREST.
--   * public.mesa_close_session_v1 INSERTs the forced-close transitions. It is
--     SECURITY INVOKER, so it runs with the CALLER's privileges, and the only
--     roles that may execute it are postgres and service_role. Its semantics
--     are not touched here, and service_role's grants are deliberately left
--     exactly as they are so that it keeps working unchanged.
--   * The frontend never names this table -- not in src/, not in the Netlify
--     functions, which proxy to Railway rather than to PostgREST.
--
-- So `anon` and `authenticated` are revoked in full, SELECT included: least
-- privilege, not "least mutation". There are no dependent views, no foreign
-- keys in either direction and no triggers on the table, so REFERENCES and
-- TRIGGER have nothing legitimate to serve either.
--
-- NO COMPENSATING POLICY IS CREATED. Enabling RLS with zero policies is the
-- point: the browser roles are denied by default, and a permissive policy
-- added "to make it work again" would hand back exactly what this migration
-- removes. A post-condition asserts the policy count stays zero.
--
-- BOTH HALVES, as in ledgers 98 and 99. Privilege alone is not enough (a
-- future ALTER DEFAULT PRIVILEGES or a stray GRANT re-opens it) and RLS alone
-- is not enough (it is a row filter, not a grant). Together, a browser role
-- must pass a grant check it no longer holds AND a policy that does not exist.
--
-- WHY service_role IS UNAFFECTED BY THE RLS HALF: service_role and postgres
-- both carry rolbypassrls = true, verified before writing this file, so
-- neither ENABLE nor FORCE changes anything for the canonical writer. FORCE is
-- included to match cash_counts (ledger 98) and to keep the guarantee if the
-- table ever acquires a non-bypassing owner.
--
-- IDEMPOTENT BY CONSTRUCTION: ENABLE/FORCE ROW LEVEL SECURITY and REVOKE are
-- all no-ops on a second run. This file contains no DML, no DDL on any other
-- object, and changes not one row of the 274 it protects.

BEGIN;

-- ── HALF 1: ROW LEVEL SECURITY ──────────────────────────────────────────────
ALTER TABLE public.orden_estado_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orden_estado_logs FORCE ROW LEVEL SECURITY;

-- ── HALF 2: PRIVILEGE ───────────────────────────────────────────────────────
-- BY NAME, every role that must not reach this table. A blanket REVOKE FROM
-- PUBLIC does not remove a grant held directly by a named role, which is the
-- trap ledger 98's first apply caught with service_role.
-- service_role is deliberately NOT revoked: it is the canonical writer, both
-- directly (orderStateLogger.js) and as the invoker of mesa_close_session_v1.
REVOKE ALL ON public.orden_estado_logs FROM PUBLIC;
REVOKE ALL ON public.orden_estado_logs FROM anon;
REVOKE ALL ON public.orden_estado_logs FROM authenticated;

-- ── POST-CONDITIONS ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_probe text := 'not_run';
BEGIN
  -- RLS, both halves.
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname='public' AND c.relname='orden_estado_logs') THEN
    RAISE EXCEPTION 'K-1 post-condition failed: row level security must be enabled AND forced';
  END IF;

  -- No compensating policy. Zero is the contract, not an accident.
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.orden_estado_logs'::regclass) <> 0 THEN
    RAISE EXCEPTION 'K-1 post-condition failed: a policy exists -- RLS with no policy IS the lockdown';
  END IF;

  -- The browser roles hold NOTHING. Named individually so a failure says which.
  IF has_table_privilege('anon','public.orden_estado_logs','INSERT')
     OR has_table_privilege('anon','public.orden_estado_logs','UPDATE')
     OR has_table_privilege('anon','public.orden_estado_logs','DELETE')
     OR has_table_privilege('anon','public.orden_estado_logs','TRUNCATE')
     OR has_table_privilege('anon','public.orden_estado_logs','SELECT')
     OR has_table_privilege('anon','public.orden_estado_logs','REFERENCES')
     OR has_table_privilege('anon','public.orden_estado_logs','TRIGGER') THEN
    RAISE EXCEPTION 'K-1 post-condition failed: anon still holds a privilege on the audit log';
  END IF;
  IF has_table_privilege('authenticated','public.orden_estado_logs','INSERT')
     OR has_table_privilege('authenticated','public.orden_estado_logs','UPDATE')
     OR has_table_privilege('authenticated','public.orden_estado_logs','DELETE')
     OR has_table_privilege('authenticated','public.orden_estado_logs','TRUNCATE')
     OR has_table_privilege('authenticated','public.orden_estado_logs','SELECT')
     OR has_table_privilege('authenticated','public.orden_estado_logs','REFERENCES')
     OR has_table_privilege('authenticated','public.orden_estado_logs','TRIGGER') THEN
    RAISE EXCEPTION 'K-1 post-condition failed: authenticated still holds a privilege on the audit log';
  END IF;

  -- THE CANONICAL WRITER STILL WORKS. This is the half that makes the lockdown
  -- safe rather than merely strict: orderStateLogger.js POSTs the row and reads
  -- it back (PostgREST return=representation), so SELECT and INSERT are both
  -- load-bearing, and mesa_close_session_v1 INSERTs as the invoker.
  IF NOT (has_table_privilege('service_role','public.orden_estado_logs','INSERT')
          AND has_table_privilege('service_role','public.orden_estado_logs','SELECT')) THEN
    RAISE EXCEPTION 'K-1 post-condition failed: service_role lost the privileges the canonical writer needs';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'K-1 post-condition failed: service_role no longer bypasses RLS, so ENABLE/FORCE would block the writer';
  END IF;

  -- THE FORCED-CLOSE WRITER IS UNTOUCHED, and still unreachable from a browser.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='mesa_close_session_v1') THEN
    RAISE EXCEPTION 'K-1 post-condition failed: mesa_close_session_v1 is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='mesa_close_session_v1'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'K-1 post-condition failed: the forced-close writer became reachable from a browser role';
  END IF;

  -- THE REAL QUESTION, ASKED OF THE DATABASE ITSELF. Privilege bits are a
  -- model of the answer; this is the answer. An INSERT attempted AS anon must
  -- be refused. If it is somehow permitted, the exception below aborts the
  -- whole migration and the row goes with it.
  BEGIN
    SET LOCAL ROLE anon;
    INSERT INTO public.orden_estado_logs (orden_id, estado_to, event_type)
    VALUES ('__K1_POSTCONDITION_PROBE__', 'PROBE', 'probe');
    v_probe := 'ALLOWED';
  EXCEPTION
    WHEN insufficient_privilege THEN v_probe := 'DENIED';
    WHEN others THEN v_probe := 'UNEXPECTED:' || SQLSTATE;
  END;
  RESET ROLE;
  IF v_probe <> 'DENIED' THEN
    RAISE EXCEPTION 'K-1 post-condition failed: anon INSERT was % , expected DENIED', v_probe;
  END IF;

  -- Nothing this file did could have created a row, and the probe proved it
  -- cannot either -- but assert it rather than assume it.
  IF EXISTS (SELECT 1 FROM public.orden_estado_logs WHERE orden_id = '__K1_POSTCONDITION_PROBE__') THEN
    RAISE EXCEPTION 'K-1 post-condition failed: the probe left a row behind';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96/97/98/99/100: the manifest records this file's own sha256, and embedding
-- that sha in an INSERT inside the file would make the checksum
-- self-referential. Registered as a separate statement at apply time:
-- apply_order 101, kind 'ddl', checksum = this file's sha256, applied_by = the
-- introducing commit.

COMMIT;
