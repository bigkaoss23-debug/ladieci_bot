-- migrations/2026-08-23_n1_mesa_force_close_estado_write_removal.sql
-- N-1 — MESA FORCE-CLOSE NO LONGER WRITES A TERMINAL ESTADO.
--
-- THE FINDING (M-1's own deprecation audit, this session, read-only). The
-- force-close estado value public.mesa_close_session_v1 has written since
-- 2026-08-10 is an operational fact (kitchen never confirmed served), never
-- an economic one -- already fixed reader-side in the prior slice. This
-- migration retires the WRITER: no live code path should keep manufacturing
-- new rows in that estado when the same operational fact is already fully
-- representable without touching ordenes at all.
--
-- WHY IT IS SAFE TO STOP WRITING IT. guard_service_session_closed_v1 (live,
-- unchanged by this migration) already has an exemption for a non-terminal
-- order: it does not block a V3-authorized close when a matching
-- public.service_incidents row exists for that (service_session_id,
-- order_id) pair. v3IncidentPolicy.js's classifyForV3Close() already creates
-- exactly that row for EVERY non-terminal order under the closing service --
-- its loop has no table_session.status filter at all, so an order on an
-- ALREADY-CLOSED table is classified identically to one on a still-open
-- table (proven live by the pre-existing, unchanged Scenario F2 test:
-- "anomaly (non-terminal order) -- classifies + closes"). That exemption
-- (F-3, ledger 87, 2026-08-17) postdates this function's own force-close
-- write (P0-B, 2026-08-10) -- it did not exist when the write was invented,
-- and supersedes the reason it was necessary. public.service_incidents
-- itself cannot be written directly by this RPC (closeout_correlation_id is
-- NOT NULL and only exists once a close attempt is active, which a
-- mid-service table close never has) -- so the correct fix is not "write an
-- incident here instead", it is "write nothing to ordenes at all, and let
-- Finalizar's own, already-proven classification do its job whenever the
-- service actually closes".
--
-- WHAT CHANGES. Exactly one function body, one CTE inside its existing
-- p_force branch. The financial-settlement gate (absolute, never overridden
-- by p_force), the kitchen-completeness gate (the only thing p_force
-- overrides), the table_sessions close, the audit trail, and actor
-- attribution are ALL byte-identical to today's live body -- see the static
-- test paired with this migration for a line-by-line diff proof. The single
-- removed statement is: -- language-guard: allow-legacy CHIUSO_FORZATO is the exact literal this now-removed statement used to write, quoted verbatim to show what changed, not new vocabulary
--   UPDATE public.ordenes o SET estado = 'CHIUSO_FORZATO', updated_at = v_now
--     FROM orphaned t WHERE o.id = t.id RETURNING o.id, t.old_estado
-- The orden_estado_logs INSERT that followed it is KEPT, unabridged in
-- meaning: same event_type ('table_closed_forced'), same actor_type/actor_id
-- ('operator', p_by_actor), same origin ('mesa_close_session_force'), same
-- metadata (table_session_id, reason). Only estado_from/estado_to change
-- shape: both now carry the order's OWN, real, unchanged estado (never a -- language-guard: allow-legacy CHIUSO_FORZATO is the same literal, restated to contrast old vs new behavior, not new vocabulary
-- literal 'CHIUSO_FORZATO') -- estado_to is NOT NULL by schema, so a
-- COALESCE to the ordenes.estado column's own default ('EN_COCINA') covers
-- the theoretical estado IS NULL case without fabricating anything not
-- already this exact function's own established NULL-tolerance convention.
--
-- WHAT DOES NOT CHANGE. ordenes.estado is written NOWHERE by this function
-- after this migration -- a force-closed table's non-terminal orders keep
-- their true kitchen estado forever, exactly as FASE 1's contract requires.
-- No historical row is touched (no UPDATE/DELETE against ordenes or any
-- other business table in this file). No migration history is edited. No
-- backfill. TERMINAL_ORDER_STATES (JS, all 5 backend files + the frontend
-- state machine), the CANCELLED/void-exclusion sets, guard_service_session_
-- closed_v1's own terminal-estado allowlist, and every reader that already -- language-guard: allow-legacy CHIUSO_FORZATO is the same literal, restated to state it is unaffected by this migration, not new vocabulary
-- recognizes CHIUSO_FORZATO as a legacy terminal literal are UNTOUCHED --
-- old rows stay exactly as legacy-readable as they were the moment before
-- this migration, forever. Grants (service_role-only) are restated
-- unchanged, matching this function's own established pattern.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_close_session_v1';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'N-1 refused: public.mesa_close_session_v1 does not exist -- resolve drift first';
  END IF;
  IF v_body NOT LIKE '%estado = ''CHIUSO_FORZATO''%' THEN -- language-guard: allow-legacy CHIUSO_FORZATO is the exact literal this predecessor guard checks for, not new vocabulary
    RAISE EXCEPTION 'N-1 refused: the live function no longer writes the force-close estado -- already patched, resolve drift first';
  END IF;
  IF v_body NOT LIKE '%MESA_TABLE_NOT_SETTLED%' THEN
    RAISE EXCEPTION 'N-1 refused: the pre-existing financial-settlement gate is missing from the live function -- resolve drift first';
  END IF;
  IF v_body NOT LIKE '%MESA_TABLE_HAS_ACTIVE_ORDERS%' THEN
    RAISE EXCEPTION 'N-1 refused: the pre-existing kitchen-completeness gate is missing from the live function -- resolve drift first';
  END IF;
END $$;

BEGIN;

CREATE OR REPLACE FUNCTION public.mesa_close_session_v1(p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_total_cents bigint;
  v_paid_cents bigint;
  v_outstanding_cents bigint;
  v_now timestamptz := now();
  v_forced_count integer := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
  THEN RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- Same eligible roles as mesa_release_empty_session_v1 -- closing a table
  -- (financial safety aside) is an operational floor action, not a
  -- financial one; a waiter who has been serving the table can close it.
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'MESA_CLOSE_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Idempotent-safe, not idempotent-graceful, matching
  -- mesa_release_empty_session_v1's own established precedent: a retry
  -- after success lands here and fails closed before any mutation is
  -- possible -- no duplicate close, no duplicate audit row.
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  -- FINANCIAL SAFETY — absolute, never overridden by p_force. A table must
  -- never become free/available for new guests while money is still owed.
  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this pre-existing exclusion filter already named, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents > 0 THEN
    RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000';
  END IF;

  -- KITCHEN/ORDER COMPLETENESS — the only thing p_force overrides.
  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this pre-existing completeness check already named, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
       ))
  ) THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000';
    END IF;

    -- N-1 — explicit, operator-intentional force close. The order's OWN
    -- estado is left exactly as it genuinely is: this RPC has never had any
    -- authority to certify a kitchen outcome it never observed, and now it
    -- no longer claims one. Finalizar already classifies any order still
    -- non-terminal at that point into a service_incidents row
    -- (v3IncidentPolicy.js, table-status-agnostic) and guard_service_
    -- session_closed_v1's own V3-authorized exemption lets the service
    -- close over it -- the exact same safety net a still-open table's
    -- stranded order already relies on. Only the audit trail is written
    -- here; no row in `ordenes` is touched by this branch at all.
    WITH orphaned AS (
      SELECT o.id, o.estado AS current_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated verbatim for the same reason
         ))
       FOR UPDATE OF o
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs( -- language-guard: allow-legacy numero_ordine below is the existing orden_estado_logs column name, restated verbatim because this INSERT is byte-identical to the pre-N-1 body, not new vocabulary
        orden_id, numero_ordine, estado_from, estado_to, event_type,
        actor_type, actor_id, origin, metadata
      )
      SELECT t.id, t.id, t.current_estado, COALESCE(t.current_estado, 'EN_COCINA'), 'table_closed_forced',
        'operator', p_by_actor, 'mesa_close_session_force',
        jsonb_build_object(
          'table_session_id', v_session.id,
          'reason', 'operator_forced_close_with_pending_kitchen_work'
        )
      FROM orphaned t
      RETURNING 1
    )
    SELECT count(*) INTO v_forced_count FROM logged;
  END IF;

  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_session.id;

  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_session.table_id, 'status', 'closed',
    'forced', v_forced_count > 0, 'forcedOrderCount', v_forced_count
  );
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean) TO service_role;

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY -- this migration performs no business DML (no INSERT,
-- UPDATE or DELETE against ordenes/table_sessions/orden_estado_logs/any
-- other business table). The behavioral proof (a paid-but-kitchen-active
-- table still force-closes, the order's estado is provably unchanged, the
-- audit row still lands, a genuinely unsettled table is still refused) is
-- run separately as a standalone, unconditionally-rolled-back probe against
-- real staging data -- see this slice's own report for the exact queries
-- and results.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_close_session_v1';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'N-1 post-condition failed: mesa_close_session_v1 is missing after CREATE OR REPLACE';
  END IF;
  -- THE removal, proven directly against the live body: no assignment of
  -- the force-close estado to ordenes.estado survives anywhere in this
  -- function. The literal itself may still appear (in the two pre-existing
  -- exclusion-filter IN-lists, restated verbatim above) -- only the
  -- assignment form is forbidden.
  IF v_src LIKE '%estado = ''CHIUSO_FORZATO''%' THEN -- language-guard: allow-legacy CHIUSO_FORZATO is the exact literal this post-condition proves is no longer assigned, not new vocabulary
    RAISE EXCEPTION 'N-1 post-condition failed: the live function still assigns the force-close estado literal';
  END IF;
  IF v_src NOT LIKE '%MESA_TABLE_NOT_SETTLED%' THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the financial-settlement gate did not survive the replace';
  END IF;
  IF v_src NOT LIKE '%MESA_TABLE_HAS_ACTIVE_ORDERS%' THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the kitchen-completeness gate did not survive the replace';
  END IF;
  IF v_src NOT LIKE '%table_sessions SET%status = ''closed''%' THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the table-close write did not survive the replace';
  END IF;
  IF v_src NOT LIKE '%INSERT INTO public.orden_estado_logs%' THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the audit-log write did not survive the replace';
  END IF;
  IF v_src NOT LIKE '%''operator'', p_by_actor, ''mesa_close_session_force''%' THEN
    RAISE EXCEPTION 'N-1 post-condition failed: actor attribution on the audit row did not survive the replace';
  END IF;
  -- Guard ordering unchanged: financial safety strictly precedes the
  -- force-override branch.
  IF position('MESA_TABLE_NOT_SETTLED' in v_src) > position('IF NOT p_force THEN' in v_src) THEN
    RAISE EXCEPTION 'N-1 post-condition failed: guard ordering changed -- financial settlement must still be checked before the force branch';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.mesa_close_session_v1(uuid, text, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-1 post-condition failed: service_role lost EXECUTE on mesa_close_session_v1';
  END IF;
  IF has_function_privilege('anon', 'public.mesa_close_session_v1(uuid, text, uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mesa_close_session_v1(uuid, text, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-1 post-condition failed: anon/authenticated must never execute mesa_close_session_v1';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-103: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 104, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit.

COMMIT;
