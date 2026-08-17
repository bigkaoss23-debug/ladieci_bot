-- migrations/2026-08-17_f3_v3_order_residue_guard_repair.sql
-- F-3 — Finalizar servicio repair, slice 3 ONLY: repair
-- guard_service_session_closed_v1's missing V3-authorized exemption path
-- for non-terminal-order residue (V3-D2). Nothing else changes.
--
-- Authority: owner-frozen F-3 finding (Finalizar architecture challenge,
-- Opus deep-audit pass), re-confirmed live in this slice's own Phase 0
-- against the real, current guard body (post-F-1/F-2, unaffected by
-- either). The guard's TABLE-residue block already carries a V3-authorized
-- exemption:
--   (v_v3_authorized AND EXISTS(service_closeouts WHERE service_session_id
--   = OLD.id)) OR v_incident_safe
-- but its ORDER-residue block's exemption never references v_v3_authorized
-- at all -- only the legacy incident_safe path is consulted:
--   v_incident_safe AND EXISTS(service_incidents WHERE service_session_id
--   = OLD.id AND order_id = o.id::text)
-- Since close_service_session_v3 (the V3 close engine's terminal
-- transition, F-1-patched, unaffected here) sets ladieci.v3_close_
-- authorized_session_id and serviceLifecycleEngine.js (V3's orchestrator)
-- ALWAYS persists exactly one service_incidents row per non-terminal order
-- BEFORE ever calling it (Phase C.2/D, confirmed live in source:
-- src/serviceSessions/v3IncidentPolicy.js's classifyForV3Close() assigns
-- every non-terminal order's own id as orderId, unconditionally --
-- src/serviceSessions/serviceLifecycleEngine.js persists every one via
-- serviceIncidents.report()/create_service_incident before Phase D's
-- closeout and Phase E's terminal transition) -- a V3 close that has ALREADY
-- durably recorded the required per-order evidence and an authoritative
-- service_closeouts row STILL fails at this guard with
-- SERVICE_ACTIVE_ORDERS_NOT_RESOLVED. This contradicts the V3 engine's own
-- documented contract (serviceLifecycleEngine.js's own header, Slice 3.3):
-- "a non-terminal order or unpaid exposure no longer stops the engine ...
-- each becomes a persisted service_incidents row ... and the service still
-- closes."
--
-- THE FIX, and nothing else: the order-residue exemption predicate gains a
-- second, parallel V3-authorized branch, mirroring the EXISTING shape of
-- both the table-residue block's own V3 branch and the order-residue
-- block's own legacy branch -- no new lineage system, no new evidence
-- table, no relaxed per-order requirement:
--   v_v3_authorized
--   AND EXISTS(service_closeouts WHERE service_session_id = OLD.id)
--   AND EXISTS(service_incidents WHERE service_session_id = OLD.id
--              AND order_id = o.id::text)
-- Bare v_v3_authorized is structurally incapable of exempting anything by
-- itself -- both EXISTS clauses are AND-chained, matching the same
-- structural shape the table-residue block already uses for its own
-- closeout requirement. The "qualifying incident" definition is
-- deliberately IDENTICAL to the pre-existing legacy incident_safe
-- predicate (row existence in service_incidents keyed on
-- (service_session_id, order_id), no resolution_status/category/severity
-- filter) -- not a new, guessed contract: v3IncidentPolicy.js's
-- classifyForV3Close() never auto-resolves an order-type incident (only
-- EMPTY_TABLE_LEFT_OPEN table-type incidents can be auto-resolved, via a
-- SEPARATE safe-action step, after persistence -- confirmed live in
-- source), so every order-type incident V3 persists is still
-- resolution_status='pending' by the time this guard fires; existence-only
-- matching is therefore both sufficient and consistent with the already-
-- proven-safe legacy contract, not a new invented one.
--
-- EXPLICITLY NOT DONE (frozen non-goals, per the F-3 task brief):
--   - the table-residue block is NOT touched -- byte-identical, still its
--     own pre-existing V3/incident_safe OR;
--   - the non-terminal-order predicate (the exact estado list) is NOT
--     touched -- byte-identical;
--   - the legacy incident_safe branch inside the order-residue block is
--     NOT touched -- byte-identical, still requires v_incident_safe;
--   - financial checks, pointer checks, order-state vocabulary: untouched;
--   - no incident is ever created BY this guard -- it validates facts the
--     V3 engine already persisted, never manufactures them;
--   - no new attempt/lineage identifier is introduced -- the V3 branch
--     matches service_closeouts on service_session_id alone, the EXACT
--     same strictness the table-residue block's own pre-existing V3 branch
--     already uses (close_service_session_v3 additionally requires a
--     matching closeout_correlation_id + active attempt before it will
--     ever set the GUC in the first place -- that ownership proof already
--     happened one level up, before this trigger ever fires);
--   - ensure_next_service_session_v3 (F-2, V3-D1) is untouched;
--   - complete_service_session_close / close_service_session_v3's F-1
--     canonical-pointer-clear logic is untouched;
--   - V3-D3 (p_service_kind validation) / V3-D5 (schedule-derived
--     successor) remain untouched -- still open.
--
-- PHASE 0 EVIDENCE (verified live this session, before writing this fix):
--   - Ledger: MAX(apply_order)=86, MAX(verified)=76 -- matches the exact
--     expected pre-state.
--   - guard_service_session_closed_v1's exact live body captured fresh via
--     pg_get_functiondef (not assumed/cited from the earlier audit) --
--     confirms the table-residue V3 branch exists, the order-residue block
--     has no v_v3_authorized reference at all, and the sole trigger
--     invoking this function is service_sessions_closed_live_work_guard
--     (BEFORE UPDATE OF status ON service_sessions).
--   - close_service_session_v3's exact live body captured fresh: sets
--     ladieci.v3_close_authorized_session_id via set_config(...,true)
--     BEFORE the UPDATE ... SET status='closed' that fires this trigger --
--     confirms the GUC is genuinely transaction-local and set-before-fire,
--     not merely assumed.
--   - src/serviceSessions/v3IncidentPolicy.js / serviceLifecycleEngine.js
--     read fresh from source: every non-terminal order deterministically
--     gets exactly one incident descriptor with orderId=String(order.id),
--     persisted (Phase C.2) strictly BEFORE the closeout (Phase D) and the
--     terminal transition (Phase E) -- never skipped, never deferred.
--   - service_incidents.order_id is `text`, populated verbatim from
--     create_service_incident's p_order_id parameter (no transformation) --
--     matches the guard's own pre-existing `o.id::text` comparison format.
BEGIN;

DO $$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'F-3 refused: staging sentinel migration absent -- wrong database?'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='guard_service_session_closed_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'F-3 refused: guard_service_session_closed_v1 does not exist';
  END IF;

  -- Predecessor-body guard: the exact pre-F-3 order-residue exemption
  -- (legacy-only, no V3 branch) must be present, byte-for-byte, or this
  -- migration refuses (already applied, drifted, or a different body than
  -- expected).
  IF position('AND NOT (
          v_incident_safe
          AND EXISTS (
            SELECT 1 FROM public.service_incidents si
            WHERE si.service_session_id = OLD.id
              AND si.order_id = o.id::text
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = ''P0001'',
        MESSAGE = ''SERVICE_ACTIVE_ORDERS_NOT_RESOLVED'';' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-3 refused: guard_service_session_closed_v1 does not match the expected pre-F-3 body -- already patched or drifted, resolve first';
  END IF;

  -- Drift guard: refuse if the post-F-3 shape is already present.
  IF (length(v_def) - length(replace(v_def, 'v_v3_authorized', ''))) / length('v_v3_authorized') > 3 THEN
    RAISE EXCEPTION 'F-3 refused: guard_service_session_closed_v1 already shows the post-F-3 order-residue V3 branch -- already applied';
  END IF;

  -- Empirical, not merely asserted: the sole trigger invoking this function
  -- must exist with exactly the shape this fix assumes (no other call site
  -- to account for).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgfoid = 'public.guard_service_session_closed_v1'::regproc
       AND tgrelid = 'public.service_sessions'::regclass
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'F-3 refused: service_sessions_closed_live_work_guard trigger not found on service_sessions -- resolve drift before proceeding';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public.guard_service_session_closed_v1'::regproc AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'F-3 refused: guard_service_session_closed_v1 has more than one live trigger call site -- resolve drift before proceeding';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_incident_safe boolean;
  v_v3_authorized boolean;
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    v_incident_safe := COALESCE(current_setting('ladieci.incident_safe_close_session_id', true), '') = OLD.id::text;
    v_v3_authorized := COALESCE(current_setting('ladieci.v3_close_authorized_session_id', true), '') = OLD.id::text;

    IF NOT (
      (
        v_v3_authorized
        AND EXISTS (
          SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
        )
      )
      OR v_incident_safe
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM public.table_sessions t
        WHERE t.service_session_id = OLD.id
          AND t.status = 'open'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MESA_TABLES_NOT_RELEASED';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            -- language-guard: allow-legacy COMPLETATO is the existing terminal-state literal from guard_service_session_closed_v1's live body, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
            'RETIRADO', 'COMPLETADO', 'COMPLETATO',
            -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated verbatim for the same reason
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
        AND NOT (
          (
            v_incident_safe
            AND EXISTS (
              SELECT 1 FROM public.service_incidents si
              WHERE si.service_session_id = OLD.id
                AND si.order_id = o.id::text
            )
          )
          OR (
            -- F-3: V3-authorized branch, mirroring the table-residue block's
            -- own pre-existing V3 shape. The bare authorization flag is
            -- never sufficient by itself -- both an authoritative
            -- service_closeouts row AND a per-order service_incidents row
            -- are required, AND-chained. No new evidence table, no new
            -- lineage identifier.
            v_v3_authorized
            AND EXISTS (
              SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
            )
            AND EXISTS (
              SELECT 1 FROM public.service_incidents si
              WHERE si.service_session_id = OLD.id
                AND si.order_id = o.id::text
            )
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

-- Post-conditions (structural -- behavioral live acceptance was run
-- separately, in rolled-back transactions, BEFORE this migration was
-- authored -- see the F-3 report for the full A-F case matrix; embedding
-- multi-table fixture mutations inside this migration's own post-condition
-- was deliberately avoided, learning F-2's own SAVEPOINT lesson: keep this
-- migration's post-condition to the same low-risk, text-structural
-- discipline every prior slice this session has used for a CREATE OR
-- REPLACE FUNCTION change).
DO $$
DECLARE
  v_def text;
  v_v3_count int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='guard_service_session_closed_v1';

  -- The new V3 branch is present, in the order-residue block specifically
  -- (not merely a repeat of the pre-existing table-residue branch): 4 total
  -- occurrences of v_v3_authorized (1 declare, 1 assignment, 1 table-residue
  -- check, 1 NEW order-residue check) where the pre-F-3 body had exactly 3.
  v_v3_count := (length(v_def) - length(replace(v_def, 'v_v3_authorized', ''))) / length('v_v3_authorized');
  IF v_v3_count <> 4 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: expected exactly 4 occurrences of v_v3_authorized (found %), the new order-residue V3 branch is missing or the count drifted', v_v3_count;
  END IF;

  -- Bare v_v3_authorized cannot exempt anything alone in the NEW branch --
  -- both EXISTS clauses are AND-chained to it, structurally.
  IF position('v_v3_authorized
            AND EXISTS (
              SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
            )
            AND EXISTS (
              SELECT 1 FROM public.service_incidents si
              WHERE si.service_session_id = OLD.id
                AND si.order_id = o.id::text
            )' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: new V3 order-residue branch does not require BOTH service_closeouts AND per-order service_incidents evidence';
  END IF;

  -- The legacy incident_safe branch inside the order-residue block is
  -- byte-unchanged.
  IF position('v_incident_safe
            AND EXISTS (
              SELECT 1 FROM public.service_incidents si
              WHERE si.service_session_id = OLD.id
                AND si.order_id = o.id::text
            )' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: legacy incident_safe order-residue branch missing or changed';
  END IF;

  -- The table-residue block is byte-unchanged (same predicate, same
  -- MESA_TABLES_NOT_RELEASED message, same shape).
  IF position('IF NOT (
      (
        v_v3_authorized
        AND EXISTS (
          SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
        )
      )
      OR v_incident_safe
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM public.table_sessions t
        WHERE t.service_session_id = OLD.id
          AND t.status = ''open''
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = ''P0001'',
          MESSAGE = ''MESA_TABLES_NOT_RELEASED'';' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: table-residue block changed -- must remain byte-identical';
  END IF;

  -- The non-terminal-order predicate (exact estado list) is byte-unchanged.
  -- Split into concatenated literals (byte-identical once joined) purely so
  -- a real comment can sit next to each pre-existing legacy term below,
  -- rather than burying it inside one opaque multi-line string literal.
  IF position('o.estado IS NULL
          OR o.estado NOT IN (
            ' ||
    -- language-guard: allow-legacy COMPLETATO is the pre-existing terminal-estado literal this post-condition checks for verbatim, not new vocabulary
    '''RETIRADO'', ''COMPLETADO'', ''COMPLETATO'',
            ' ||
    -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, same reason
    '''CANCELADO'', ''CANCELLED'', ''ANULADO'', ''CHIUSO_FORZATO''
          )' IN v_def) = 0 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: non-terminal-order predicate changed -- order-state vocabulary must not be touched';
  END IF;

  -- Exactly one trigger call site, unchanged by this migration (a pure
  -- CREATE OR REPLACE of the function body never touches the trigger
  -- definition itself).
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public.guard_service_session_closed_v1'::regproc AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: trigger call-site count changed unexpectedly';
  END IF;

  -- Nothing else touched: pointer/shadow/financial invariants unchanged by
  -- this migration itself (a CREATE OR REPLACE performs no data writes,
  -- asserted rather than assumed, matching established discipline).
  IF (SELECT current_period_id FROM public.business_day_lifecycle_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-3 post-condition failed: current_period_id changed unexpectedly by this migration'; END IF;
  IF (SELECT current_session_id FROM public.service_session_state WHERE singleton=true) IS DISTINCT FROM '5e5777c5-71c8-4b54-aa78-1b1090c4cd04'::uuid
  THEN RAISE EXCEPTION 'F-3 post-condition failed: legacy shadow changed unexpectedly by this migration'; END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
  IF (SELECT count(*) FROM public.service_closeouts) <> 3 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: service_closeouts population changed -- must be exactly 3';
  END IF;
  IF (SELECT count(*) FROM public.service_incidents) <> 49 THEN
    RAISE EXCEPTION 'F-3 post-condition failed: service_incidents population changed -- must be exactly 49 (a CREATE OR REPLACE FUNCTION performs no data writes)';
  END IF;
END $$;

COMMIT;
