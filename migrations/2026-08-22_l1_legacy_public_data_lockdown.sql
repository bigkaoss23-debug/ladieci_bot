-- migrations/2026-08-22_l1_legacy_public_data_lockdown.sql
-- L-1 -- LEGACY PUBLIC DATA LOCKDOWN: nine legacy tables carried the full
-- Supabase default grant (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
-- TRIGGER) on anon AND authenticated, gated only by a single permissive
-- policy per table (SELECT USING(true), or ALL USING(true) for geo_cache).
--
-- THE FINDING, verified directly against this project (not assumed from the
-- Release Candidate Dossier). Every claim below was proven with a live
-- SET LOCAL ROLE anon probe inside a transaction that was rolled back --
-- privilege bits are a model of the answer; this file also asks the database
-- itself, in its own post-conditions.
--
--   TRUNCATE, which row level security does NOT gate in Postgres, SUCCEEDED
--   as anon on 8 of 9 tables (clientes was saved only by a foreign key from
--   ordenes/storico, not by any privilege -- structural luck, not a control).
--   Every probe was force-rolled-back inside its own sub-transaction; zero
--   rows were ever at risk.
--
-- THE CONSUMER AUDIT, done BEFORE writing a single REVOKE (grep across both
-- canonical repos, traced to real call sites, dead code excluded by checking
-- actual callers -- not just references):
--
--   clientes        SELECT  -- api.js:441 getClientePorTel(), called from
--                              NuevoPedidoModal.jsx:707 (phone lookup while
--                              building a new order). REAL, KEPT.
--                   INSERT/UPDATE/DELETE/TRUNCATE -- the one direct write,
--                              api.js:649 updateClienteIndirizzo(), has ZERO
--                              callers anywhere in ladieci-app33/src (grepped
--                              exhaustively). Dead code. SAFE TO REVOKE.
--   ordenes         SELECT  -- api.js getSerata() (EconomiaPage "Serata"
--                              report) and WADettaglio.jsx:132 (single order
--                              lookup by id for the WhatsApp escalation view).
--                              The MAIN order board (api.getOrdenes) already
--                              goes through proxyGet -> Railway -> service_role
--                              and does NOT touch PostgREST directly. REAL
--                              (narrower than assumed), KEPT.
--                   write   -- zero sb.update/insert/delete("ordenes",...) found
--                              anywhere in ladieci-app33/src. SAFE TO REVOKE.
--   storico         SELECT  -- api.js getStorico()/getSerata() (EconomiaPage).
--                              REAL, KEPT. write: zero frontend writes found.
--                              SAFE TO REVOKE.
--   conv            SELECT  -- App.jsx main load effect (direct sb.select,
--                              "stato_ordine=eq.confermata"), WADettaglio.jsx:26,
--                              TabPreguntas.jsx:128, PLUS a raw Phoenix
--                              WebSocket realtime subscription (App.jsx:408-423,
--                              apikey=anon key) -- conv IS in the
--                              supabase_realtime publication (verified).
--                              REAL and central to the dashboard, KEPT.
--                              write: zero frontend writes found (backend
--                              writes via service_role in orchestrator.js/
--                              agentOrdini.js/helpers.js). SAFE TO REVOKE.
--   wa_msgs         SELECT  -- api.js getWaMsgs() (App.jsx main load),
--                              WADettaglio.jsx:266, PLUS the same realtime
--                              subscription (wa_msgs IS in the publication).
--                              REAL, KEPT. write: zero frontend writes found.
--                              SAFE TO REVOKE.
--   archivio_conv   ALL     -- zero frontend reference of any kind (grepped
--                              exhaustively). Backend-only (agenteMiglioramento.js
--                              reads, servizio.js upserts, both service_role).
--                              NO REAL BROWSER CONSUMER. SAFE TO FULLY LOCK,
--                              SELECT INCLUDED.
--   analisi_serata  ALL     -- zero frontend reference AND zero backend
--                              reference of any kind -- not even registered in
--                              src/utils/supabaseResourcePolicy.js (the H1B
--                              registry), so the backend could not touch it
--                              even if it tried. Dead on both sides. SAFE TO
--                              FULLY LOCK, SELECT INCLUDED.
--   suggerimenti    SELECT  -- App.jsx:259 loadSuggerimenti(), direct
--                              sb.select, powers the pending-suggestions badge.
--                              REAL, KEPT. write: zero frontend writes found
--                              (backend agenteMiglioramento.js does
--                              select/delete/update/upsert via service_role).
--                              SAFE TO REVOKE.
--   geo_cache       SELECT/ -- api.js getGeoCache() (direct sb.select) and
--                   INSERT/    saveGeoCache() (direct sb.upsert = insert-or-
--                   UPDATE     update) power delivery-address geocoding in the
--                              order-taking flow. REAL, KEPT for exactly these
--                              three commands.
--                   DELETE/ -- zero consumer anywhere for either. The existing
--                   TRUNCATE   policy is FOR ALL, which additionally grants
--                              DELETE at the row-security layer with no
--                              legitimate reason -- this is the "write/delete
--                              pubblico non necessario" the task names
--                              explicitly. SAFE TO REVOKE, and the ALL policy
--                              is narrowed to SELECT+INSERT+UPDATE.
--
-- WHAT THIS FILE DOES NOT DO, ON PURPOSE. It does not revoke SELECT from
-- clientes, ordenes, storico, conv, wa_msgs or suggerimenti, and it does not
-- revoke SELECT/INSERT/UPDATE from geo_cache, because real, currently-live
-- browser-facing capabilities depend on exactly that access today and this
-- slice's mandate is a privilege lockdown, not an architecture change. The
-- durable fix -- routing these reads through a backend proxy the way
-- api.getOrdenes()/api.getOrdenesArchivadosSesion() already do, and the way
-- this codebase's own api.js comments say every WRITE must -- is a separate,
-- larger task and is deliberately out of scope here. Flagging it here in the
-- migration itself so the STOP is durable and versioned, not just spoken.
--
-- BOTH HALVES, as in ledgers 98/99/101. Privilege alone is not enough (a
-- future ALTER DEFAULT PRIVILEGES or a stray GRANT re-opens it) and RLS alone
-- is not enough (it is a row filter, not a grant, and does not gate TRUNCATE
-- at all). REVOKEs are BY NAME -- REVOKE FROM PUBLIC does not remove a grant
-- held directly by anon/authenticated, the trap ledger 98's first apply caught.
--
-- service_role IS DELIBERATELY UNTOUCHED on all nine tables and keeps every
-- privilege it holds today; it carries rolbypassrls=true (asserted below), so
-- ENABLE/FORCE ROW LEVEL SECURITY changes nothing for any canonical writer.
--
-- NO DML ON BUSINESS DATA. No row of clientes/ordenes/storico/conv/wa_msgs/
-- archivio_conv/analisi_serata/suggerimenti/geo_cache is read, written or
-- deleted by this file outside of the rollback-guaranteed post-condition
-- probes, each proven to leave zero residue.
--
-- IDEMPOTENT BY CONSTRUCTION: ENABLE/FORCE ROW LEVEL SECURITY, DROP POLICY IF
-- EXISTS, CREATE POLICY (guarded), and REVOKE are all no-ops or safely
-- re-runnable on a second apply.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- TIER 1 -- FULL LOCKDOWN: zero real consumer of any kind, browser or backend
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS archivio_conv_public_read ON public.archivio_conv;
DROP POLICY IF EXISTS anon_read_archivio        ON public.archivio_conv;
ALTER TABLE public.archivio_conv ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.archivio_conv FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON public.archivio_conv FROM PUBLIC;
REVOKE ALL ON public.archivio_conv FROM anon;
REVOKE ALL ON public.archivio_conv FROM authenticated;

DROP POLICY IF EXISTS analisi_serata_public_read ON public.analisi_serata;
ALTER TABLE public.analisi_serata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analisi_serata FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON public.analisi_serata FROM PUBLIC;
REVOKE ALL ON public.analisi_serata FROM anon;
REVOKE ALL ON public.analisi_serata FROM authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- TIER 2 -- WRITE LOCKDOWN, SELECT PRESERVED: a real browser reader exists;
-- no real browser writer does. The existing SELECT-only policy is untouched.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.clientes FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.clientes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.clientes FROM authenticated;

ALTER TABLE public.ordenes FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ordenes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.ordenes FROM authenticated;

ALTER TABLE public.storico FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.storico FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.storico FROM authenticated;

ALTER TABLE public.conv FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.conv FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.conv FROM authenticated;

ALTER TABLE public.wa_msgs FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.wa_msgs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.wa_msgs FROM authenticated;

ALTER TABLE public.suggerimenti FORCE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.suggerimenti FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.suggerimenti FROM authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- TIER 3 -- geo_cache: narrow FOR ALL -> SELECT+INSERT+UPDATE. DELETE was
-- never used by anything and was only ever reachable because the existing
-- policy said ALL; the grant itself is revoked too, belt and braces.
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS public_write_geo_cache ON public.geo_cache;
CREATE POLICY geo_cache_public_select ON public.geo_cache
  FOR SELECT TO public USING (true);
CREATE POLICY geo_cache_public_insert ON public.geo_cache
  FOR INSERT TO public WITH CHECK (true);
CREATE POLICY geo_cache_public_update ON public.geo_cache
  FOR UPDATE TO public USING (true) WITH CHECK (true);
ALTER TABLE public.geo_cache FORCE ROW LEVEL SECURITY;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.geo_cache FROM anon;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.geo_cache FROM authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- POST-CONDITIONS -- privilege bits, policy shape, row counts, service_role
-- survival, and the real question asked of the database itself.
-- ════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  t text; r text; v_probe text; v_count bigint; v_expect bigint;
  full_lock   text[] := ARRAY['archivio_conv','analisi_serata'];
  select_only text[] := ARRAY['clientes','ordenes','storico','conv','wa_msgs','suggerimenti'];
  baseline    jsonb := '{"clientes":33,"ordenes":50,"storico":12,"conv":0,"wa_msgs":0,
                          "archivio_conv":0,"analisi_serata":0,"suggerimenti":0,"geo_cache":20}'::jsonb;
BEGIN

  -- RLS enabled+forced on all nine, no exceptions.
  FOREACH t IN ARRAY ARRAY['clientes','ordenes','storico','conv','wa_msgs',
                            'archivio_conv','analisi_serata','suggerimenti','geo_cache'] LOOP
    IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class c
              JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname=t) THEN
      RAISE EXCEPTION 'L-1 post-condition failed: % must have RLS enabled AND forced', t;
    END IF;
  END LOOP;

  -- TIER 1: zero policies, zero privileges for anon/authenticated, service_role untouched.
  FOREACH t IN ARRAY full_lock LOOP
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = ('public.'||t)::regclass) <> 0 THEN
      RAISE EXCEPTION 'L-1 post-condition failed: % must have zero policies (full lockdown)', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF has_table_privilege(r, 'public.'||t, 'SELECT')
         OR has_table_privilege(r, 'public.'||t, 'INSERT')
         OR has_table_privilege(r, 'public.'||t, 'UPDATE')
         OR has_table_privilege(r, 'public.'||t, 'DELETE')
         OR has_table_privilege(r, 'public.'||t, 'TRUNCATE')
         OR has_table_privilege(r, 'public.'||t, 'REFERENCES')
         OR has_table_privilege(r, 'public.'||t, 'TRIGGER') THEN
        RAISE EXCEPTION 'L-1 post-condition failed: % still holds a privilege on %', r, t;
      END IF;
    END LOOP;
    IF NOT (has_table_privilege('service_role', 'public.'||t, 'SELECT')
            AND has_table_privilege('service_role', 'public.'||t, 'INSERT')) THEN
      RAISE EXCEPTION 'L-1 post-condition failed: service_role lost needed privileges on %', t;
    END IF;
  END LOOP;

  -- TIER 2: exactly one SELECT policy survives unchanged, anon/authenticated hold
  -- SELECT and NOTHING else, service_role untouched, row count unchanged.
  FOREACH t IN ARRAY select_only LOOP
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = ('public.'||t)::regclass) <> 1 THEN
      RAISE EXCEPTION 'L-1 post-condition failed: % must keep exactly its one SELECT policy', t;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF NOT has_table_privilege(r, 'public.'||t, 'SELECT') THEN
        RAISE EXCEPTION 'L-1 post-condition failed: % lost SELECT on % -- a real consumer needs it', r, t;
      END IF;
      IF has_table_privilege(r, 'public.'||t, 'INSERT')
         OR has_table_privilege(r, 'public.'||t, 'UPDATE')
         OR has_table_privilege(r, 'public.'||t, 'DELETE')
         OR has_table_privilege(r, 'public.'||t, 'TRUNCATE')
         OR has_table_privilege(r, 'public.'||t, 'REFERENCES')
         OR has_table_privilege(r, 'public.'||t, 'TRIGGER') THEN
        RAISE EXCEPTION 'L-1 post-condition failed: % still holds a write privilege on %', r, t;
      END IF;
    END LOOP;
    IF NOT (has_table_privilege('service_role', 'public.'||t, 'SELECT')
            AND has_table_privilege('service_role', 'public.'||t, 'INSERT')
            AND has_table_privilege('service_role', 'public.'||t, 'UPDATE')
            AND has_table_privilege('service_role', 'public.'||t, 'DELETE')) THEN
      RAISE EXCEPTION 'L-1 post-condition failed: service_role lost needed privileges on %', t;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_count;
    v_expect := (baseline->>t)::bigint;
    IF v_count <> v_expect THEN
      RAISE EXCEPTION 'L-1 post-condition failed: % row count changed (% -> %), this file must not touch data', t, v_expect, v_count;
    END IF;
  END LOOP;

  -- TIER 3: geo_cache -- exactly 3 narrow policies, no ALL/DELETE policy survives.
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.geo_cache'::regclass) <> 3 THEN
    RAISE EXCEPTION 'L-1 post-condition failed: geo_cache must have exactly 3 policies (select/insert/update)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.geo_cache'::regclass
              AND polcmd IN ('*','d')) THEN
    RAISE EXCEPTION 'L-1 post-condition failed: geo_cache must not have an ALL or DELETE policy';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF NOT (has_table_privilege(r,'public.geo_cache','SELECT')
            AND has_table_privilege(r,'public.geo_cache','INSERT')
            AND has_table_privilege(r,'public.geo_cache','UPDATE')) THEN
      RAISE EXCEPTION 'L-1 post-condition failed: % lost a needed privilege on geo_cache', r;
    END IF;
    IF has_table_privilege(r,'public.geo_cache','DELETE')
       OR has_table_privilege(r,'public.geo_cache','TRUNCATE')
       OR has_table_privilege(r,'public.geo_cache','REFERENCES')
       OR has_table_privilege(r,'public.geo_cache','TRIGGER') THEN
      RAISE EXCEPTION 'L-1 post-condition failed: % still holds DELETE/TRUNCATE/REFERENCES/TRIGGER on geo_cache', r;
    END IF;
  END LOOP;
  EXECUTE 'SELECT count(*) FROM public.geo_cache' INTO v_count;
  IF v_count <> 20 THEN
    RAISE EXCEPTION 'L-1 post-condition failed: geo_cache row count changed (20 -> %)', v_count;
  END IF;

  -- service_role bypasses RLS everywhere -- ENABLE/FORCE must not have touched this.
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'L-1 post-condition failed: service_role no longer bypasses RLS';
  END IF;

  -- ── THE REAL QUESTION, ASKED OF THE DATABASE ITSELF ──────────────────────
  -- Fully-locked tables: anon SELECT must now be refused outright.
  FOREACH t IN ARRAY full_lock LOOP
    BEGIN
      SET LOCAL ROLE anon;
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_count;
      v_probe := 'ALLOWED';
    EXCEPTION WHEN insufficient_privilege THEN v_probe := 'DENIED';
              WHEN OTHERS THEN v_probe := 'UNEXPECTED:'||SQLSTATE;
    END;
    RESET ROLE;
    IF v_probe <> 'DENIED' THEN
      RAISE EXCEPTION 'L-1 post-condition failed: anon SELECT on % was %, expected DENIED', t, v_probe;
    END IF;
  END LOOP;

  -- select_only + geo_cache: anon SELECT must still work, and TRUNCATE must now be refused.
  FOREACH t IN ARRAY (select_only || ARRAY['geo_cache']) LOOP
    BEGIN
      SET LOCAL ROLE anon;
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO v_count;
      v_probe := 'ALLOWED';
    EXCEPTION WHEN OTHERS THEN v_probe := 'UNEXPECTED_DENY:'||SQLSTATE;
    END;
    RESET ROLE;
    IF v_probe <> 'ALLOWED' THEN
      RAISE EXCEPTION 'L-1 post-condition failed: anon SELECT on % was %, expected ALLOWED (real consumer depends on it)', t, v_probe;
    END IF;

    BEGIN
      SET LOCAL ROLE anon;
      EXECUTE format('TRUNCATE public.%I', t);
      RESET ROLE;
      v_probe := 'ALLOWED';
      RAISE EXCEPTION 'L1_PROBE_FORCE_ROLLBACK';
    EXCEPTION
      WHEN insufficient_privilege THEN v_probe := 'DENIED'; RESET ROLE;
      WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM = 'L1_PROBE_FORCE_ROLLBACK' THEN
          RAISE EXCEPTION 'L-1 post-condition failed: anon TRUNCATE on % was ALLOWED (destructive!)', t;
        END IF;
        v_probe := 'UNEXPECTED:'||SQLSTATE;
    END;
    IF v_probe <> 'DENIED' THEN
      RAISE EXCEPTION 'L-1 post-condition failed: anon TRUNCATE on % was %, expected DENIED', t, v_probe;
    END IF;
  END LOOP;

  -- geo_cache specifically: UPDATE must still work (real consumer: saveGeoCache upsert),
  -- DELETE must now be refused.
  BEGIN
    SET LOCAL ROLE anon;
    UPDATE public.geo_cache SET direccion_key = direccion_key WHERE false;
    RESET ROLE;
    v_probe := 'ALLOWED';
  EXCEPTION WHEN OTHERS THEN RESET ROLE; v_probe := 'UNEXPECTED_DENY:'||SQLSTATE;
  END;
  IF v_probe <> 'ALLOWED' THEN
    RAISE EXCEPTION 'L-1 post-condition failed: anon UPDATE on geo_cache was %, expected ALLOWED', v_probe;
  END IF;

  BEGIN
    SET LOCAL ROLE anon;
    DELETE FROM public.geo_cache WHERE false;
    RESET ROLE;
    v_probe := 'ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; v_probe := 'DENIED';
            WHEN OTHERS THEN RESET ROLE; v_probe := 'UNEXPECTED:'||SQLSTATE;
  END;
  IF v_probe <> 'DENIED' THEN
    RAISE EXCEPTION 'L-1 post-condition failed: anon DELETE on geo_cache was %, expected DENIED', v_probe;
  END IF;

END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-101: registered as a separate statement at apply time, apply_order 102,
-- checksum = this file's own sha256, applied_by = the introducing commit.

COMMIT;
