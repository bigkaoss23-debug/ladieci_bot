-- migrations/2026-08-22_m1_order_delete_financial_evidence_guard.sql
-- M-1 — ORDER HARD-DELETE FINANCIAL EVIDENCE GUARD.
--
-- THE FINDING. public.delete_order_if_not_active(p_order_id) -- the ONE
-- function behind the `eliminaOrdine` action (src/agents/riderTrip.js -- language-guard: allow-legacy eliminaOrdine is the existing action name this migration's guard sits behind, not new vocabulary
-- deleteOrder -> sbRpc('delete_order_if_not_active') -> index.js
-- action==='eliminaOrdine') -- has exactly one guard: an order that is a -- language-guard: allow-legacy eliminaOrdine is the same existing action name, restated for the index.js dispatch site, not new vocabulary
-- member of the active_trip snapshot is refused. It has NEVER checked
-- whether the order carries any persistent financial evidence. There is
-- also no foreign key anywhere in the schema referencing public.ordenes
-- (verified live: zero rows from information_schema for
-- constraint_column_usage.table_name = 'ordenes'), so nothing at the
-- database level stops `DELETE FROM public.ordenes WHERE id = p_order_id`
-- from silently orphaning rows in order_financial_events,
-- payment_allocations (via payment_transactions), table_order_lines and
-- service_incidents that still name that order_id.
--
-- Reproduced live on staging, read-only (no fixture touched): order
-- #999012 (service 4f260f1e-8e1c-46f2-9db5-86f3446ff759, already CLOSED
-- and economically certified by the prior Economía slice) carries 1
-- order_financial_events row, 3 payment_allocations and 3
-- table_order_lines rows -- and, because DRIVER_STATO.active_trip is
-- currently null on staging, the ONLY existing guard would not fire for
-- ANY order right now. Today, calling eliminaOrdine on #999012 destroys -- language-guard: allow-legacy eliminaOrdine is the same existing action name, cited here for the reproduction narrative, not new vocabulary
-- the parent row and leaves that financial evidence dangling with nothing
-- left to join it back to.
--
-- COMPOSITE IDENTITY. order_id is NOT a global identity -- ticket numbers
-- are reused once a prior order with the same id has left `ordenes`
-- (archived or, ironically, hard-deleted). Verified live:
-- order_financial_events alone has order_id values '#001'/'#002'/'#003'/
-- '#369' each spread across TWO OR THREE different service_session_id
-- values, and table_order_lines shows the same pattern for '#001'/'#003'/
-- '#999003'. So every evidence check below matches (order_id AND
-- service_session_id) together, using the CANDIDATE order's own
-- service_session_id (read from `ordenes` inside this same transaction) --
-- never order_id alone -- so a stale evidence row from a different, past
-- service session can never false-positive-block an unrelated order that
-- happens to reuse the same ticket number. A NULL service_session_id on
-- either side (order or evidence row; zero such rows exist today on
-- either, verified live) is treated as "cannot prove it's a different
-- session" and conservatively counted as evidence -- for a money-integrity
-- guard, an unnecessary refusal is a safe failure, a missed refusal is not.
--
-- WHAT COUNTS AS EVIDENCE (the full live audit, not just the tables named
-- in old reports): order_financial_events (order_id + service_session_id,
-- the payment/refund/void ledger), payment_allocations joined through
-- payment_transactions (order_id direct, service_session_id via the
-- transaction -- payment_allocations itself carries no session column),
-- table_order_lines (order_id + service_session_id, Mesa's per-order line/
-- covers detail) and service_incidents (order_id + service_session_id,
-- anomaly/settlement evidence with its own financial_exposure_cents).
-- service_incident_resolutions links only via incident_id, so blocking on
-- its parent service_incidents row already covers it transitively --
-- checking it separately would be redundant, not more correct.
-- archived_order_financial_resolutions was investigated and excluded: its
-- archived_order_id names orders that have ALREADY left `ordenes` for -- language-guard: allow-legacy storico is the existing archive table name this paragraph explains is out of THIS guard's reach, not new vocabulary
-- `storico` (0 rows exist on staging today), a lifecycle stage this
-- function's DELETE FROM public.ordenes can never reach -- adding a check
-- against it would be scope creep onto a different table's lifecycle, not
-- a real gap in THIS guard. service_closeouts/service_closeout_snapshots/
-- service_closeout_attempts/service_closeout_reconciliations are
-- service-session-level, already-taken aggregate snapshots with no
-- per-order column to key on -- out of scope by construction, and
-- untouched by this migration either way.
--
-- WHAT THIS DOES NOT DO. No void/refund/reversal/soft-cancel/write-off/new
-- operator workflow -- those are separate capabilities. This migration
-- only stops the physical DELETE from running when persistent financial
-- evidence exists; an order that genuinely has none, and still passes the
-- pre-existing active-trip check, keeps deleting exactly as before. No new
-- FK is added (the composite-identity nuance above means a naive FK on
-- order_id alone would be actively wrong), no schema redesign, no cleanup
-- of any pre-existing orphan.
--
-- AUTHORITY. The check and the DELETE stay in the exact same PL/pgSQL -- language-guard: allow-legacy eliminaOrdine is the same existing action name, restated for the authority/bypass-resistance narrative, not new vocabulary
-- function body, called once per eliminaOrdine request -- there is no
-- separate JS pre-check, so this cannot be bypassed by any caller that
-- reaches the RPC (only service_role can execute it; anon/authenticated
-- were already revoked by the original S2-1G migration and remain so).
-- The pre-existing active_trip guard, its advisory lock and its row lock
-- on config are byte-identical and unmoved -- this only adds a second,
-- independent guard after it, before the DELETE.
--
-- New typed code ORDER_HAS_FINANCIAL_EVIDENCE follows this file's own
-- existing convention (ACTIVE_TRIP_MEMBER_CONFLICT, MIXED_SERVICE_SESSION_ROWS
-- elsewhere in this codebase) -- SCREAMING_SNAKE_CASE, {ok:false, code}.
-- Mapped to HTTP 409 in src/agents/riderTrip.js's CODE_TO_HTTP, the same
-- status ACTIVE_TRIP_MEMBER_CONFLICT already uses for "hard delete refused".

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_order_if_not_active';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'M-1 refused: public.delete_order_if_not_active does not exist -- resolve drift first';
  END IF;
  IF v_body LIKE '%ORDER_HAS_FINANCIAL_EVIDENCE%' THEN
    RAISE EXCEPTION 'M-1 refused: the financial-evidence guard is already present -- already patched, resolve drift first';
  END IF;
  IF v_body NOT LIKE '%ACTIVE_TRIP_MEMBER_CONFLICT%' THEN
    RAISE EXCEPTION 'M-1 refused: the pre-existing active-trip guard is missing from the live function -- resolve drift first';
  END IF;
END $$;

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_order_if_not_active(p_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds           jsonb;
  v_active       jsonb;
  v_deleted      int;
  v_found        boolean;
  v_session      uuid;
  v_has_evidence boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  -- M-1 — financial-evidence guard. v_found stays NULL/false when the order
  -- no longer exists (already deleted / never existed), which preserves the
  -- pre-existing idempotent-retry behavior below: a not-found id skips
  -- straight to the no-op DELETE instead of being evaluated against
  -- evidence it cannot possibly own.
  SELECT true, service_session_id INTO v_found, v_session
    FROM public.ordenes WHERE id = p_order_id;

  IF v_found THEN
    SELECT
      EXISTS (
        SELECT 1 FROM public.order_financial_events e
         WHERE e.order_id = p_order_id
           AND (v_session IS NULL OR e.service_session_id IS NULL OR e.service_session_id = v_session)
      )
      OR EXISTS (
        SELECT 1 FROM public.table_order_lines tol
         WHERE tol.order_id = p_order_id
           AND (v_session IS NULL OR tol.service_session_id = v_session)
      )
      OR EXISTS (
        SELECT 1 FROM public.payment_allocations pa
         JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
         WHERE pa.order_id = p_order_id
           AND (v_session IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = v_session)
      )
      OR EXISTS (
        SELECT 1 FROM public.service_incidents si
         WHERE si.order_id = p_order_id
           AND (v_session IS NULL OR si.service_session_id = v_session)
      )
    INTO v_has_evidence;

    IF v_has_evidence THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_HAS_FINANCIAL_EVIDENCE');
    END IF;
  END IF;

  DELETE FROM public.ordenes WHERE id = p_order_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_order_if_not_active(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_order_if_not_active(text) TO service_role;

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY -- this migration performs no business DML (no INSERT,
-- UPDATE or DELETE against ordenes/order_financial_events/any other
-- business table), per this slice's own no-DML-business constraint. The
-- behavioral proof (an evidenced order refused, an evidence-free order
-- still deletable, zero cross-service false positives, the rider-trip
-- guard still firing first, a refused attempt mutating nothing) is run
-- separately as a standalone, unconditionally-rolled-back probe against
-- real staging data -- see this slice's report for the exact queries and
-- their results. Here we only confirm the function DEFINITION is correct.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_order_if_not_active';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'M-1 post-condition failed: delete_order_if_not_active is missing after CREATE OR REPLACE';
  END IF;
  IF position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) = 0 THEN
    RAISE EXCEPTION 'M-1 post-condition failed: the pre-existing active-trip guard did not survive the replace';
  END IF;
  IF position('ORDER_HAS_FINANCIAL_EVIDENCE' in v_src) = 0 THEN
    RAISE EXCEPTION 'M-1 post-condition failed: the new financial-evidence guard is missing';
  END IF;
  -- Guard ordering: the active-trip RETURN must textually precede the new
  -- evidence check, matching "preserve existing guards, add after them".
  IF position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) > position('ORDER_HAS_FINANCIAL_EVIDENCE' in v_src) THEN
    RAISE EXCEPTION 'M-1 post-condition failed: guard ordering changed -- active-trip must still be checked first';
  END IF;
  -- Composite identity: every evidence subquery must be scoped by
  -- service_session_id, never by order_id alone.
  IF position('order_financial_events e' in v_src) = 0 OR position('table_order_lines tol' in v_src) = 0
     OR position('payment_allocations pa' in v_src) = 0 OR position('service_incidents si' in v_src) = 0 THEN
    RAISE EXCEPTION 'M-1 post-condition failed: not all four evidence sources are present in the guard';
  END IF;
  IF (length(v_src) - length(replace(v_src, 'v_session', ''))) / length('v_session') < 8 THEN
    RAISE EXCEPTION 'M-1 post-condition failed: composite service_session_id scoping looks incomplete';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.delete_order_if_not_active(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M-1 post-condition failed: service_role lost EXECUTE on delete_order_if_not_active';
  END IF;
  IF has_function_privilege('anon', 'public.delete_order_if_not_active(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.delete_order_if_not_active(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M-1 post-condition failed: anon/authenticated must never execute delete_order_if_not_active';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-102: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 103, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit.

COMMIT;
