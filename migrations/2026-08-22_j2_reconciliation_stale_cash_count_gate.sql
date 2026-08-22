-- migrations/2026-08-22_j2_reconciliation_stale_cash_count_gate.sql
-- J-2 — STALE CASH COUNT GATE: a count is a fact at an instant, not a standing
-- claim about the present.
--
-- WHAT WENT WRONG. J-1 (ledger 99) established that a variance may only ever be
-- computed between a cash count and an economic window that are THE SAME
-- WINDOW, and enforced it in two places. That rule is right and is unchanged
-- here. It is simply not sufficient, because the window is a whole Business Day
-- and two moments inside one day are still "the same window".
--
-- Observed live on staging, 2026-08-22:
--
--   13:35  cash_counts 10d61ed6: counted 65.00, recorded 65.00, variance 0.
--          True, and true of that moment.
--   later  51.00 more arrives in cash. The day's recorded cash becomes 116.00.
--   then   Finalizar, opened WITHOUT a new count, reported
--              Efectivo registrado  116.00
--              Conteo fisico         65.00
--              Diferencia           -51.00
--
-- Nothing went missing. 65.00 was the drawer at 13:35 and stopped describing
-- the drawer the moment more cash came in. Reporting the arithmetic difference
-- anyway turns an operator's honest, correct count into what reads, to the
-- person holding the phone, as an accusation. Ledger 99's own note says a scope
-- error "reads exactly like a theft report"; this is the same failure one axis
-- over -- not scope, but TIME.
--
-- WHAT THIS CHANGES. Exactly one function body:
-- create_service_closeout_reconciliation_v1 gains a second refusal beside the
-- window check. A cash count may be attached to a reconciliation only while the
-- ledger figure the count itself stored (recorded_cash_receipts_cents, written
-- at counted_at and immutable ever since) still equals the cash receipts this
-- reconciliation is recording. When they differ, the economy moved after the
-- count and the writer refuses with RECONCILIATION_CASH_COUNT_STALE instead of
-- fossilising a variance that was never real -- and these rows are append-only,
-- so "fossilising" is the exact word: there is no later edit to undo it.
--
-- WHAT THIS DOES NOT CHANGE.
--   * No table, column, constraint, trigger, index or grant is altered. The
--     signature is identical, so no caller needs updating and no drop/recreate
--     of dependent objects occurs.
--   * Closing WITHOUT a count is still entirely normal: p_cash_count_id NULL
--     leaves all three count columns NULL, exactly as before. A cash count has
--     never been a precondition for Finalizar and is not made into one here.
--   * Cash counts remain append-only and are never rewritten. Staleness is a
--     judgement made at READ time about a row that does not change; the fix for
--     a stale count is a NEW count, which is what an operator does anyway.
--   * No lifecycle authority is touched. close_service_session_v3 and
--     open_operational_service_v1 are asserted present and unmodified.
--
-- The JS layer (closeoutReconciliation.js) applies the same rule independently
-- and additionally refuses a count with any cash movement recorded after its
-- counted_at -- the equal-and-opposite case that leaves totals agreeing. The
-- database deliberately checks only the totals it can see on its own rows,
-- which is the half that must never depend on a deployed backend being correct.

BEGIN;

-- ── THE ONLY WRITER, with one refusal added ─────────────────────────────────
-- Reproduced in full from ledger 99 because CREATE OR REPLACE replaces the
-- whole body; the ONLY difference from the applied J-1 version is the stale
-- check below, marked J-2.
CREATE OR REPLACE FUNCTION public.create_service_closeout_reconciliation_v1(
  p_service_session_id      uuid,
  p_closeout_correlation_id uuid,
  p_window_from             timestamptz,
  p_window_to               timestamptz,
  p_window_timezone         text,
  p_window_preset           text,
  p_business_date           date,
  p_gross_cents             integer,
  p_collected_cents         integer,
  p_unpaid_cents            integer,
  p_voided_cents            integer,
  p_refunded_cents          integer,
  p_cash_receipts_cents     integer,
  p_card_receipts_cents     integer,
  p_bizum_receipts_cents    integer,
  p_other_receipts_cents    integer,
  p_order_count             integer,
  p_service_count           integer,
  p_actor                   text,
  p_cash_count_id           uuid    DEFAULT NULL,
  p_counted_cash_cents      integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row      public.service_closeout_reconciliations;
  v_variance integer;
  v_recorded_at_count integer;
BEGIN
  -- LINEAGE. The V3 engine persists the closeout (Phase D) before calling
  -- this, so the row must already exist. Refusing otherwise makes an orphan
  -- reconciliation -- context for a close that never happened -- structurally
  -- impossible, rather than merely unlikely.
  IF NOT EXISTS (
    SELECT 1 FROM public.service_closeouts
     WHERE closeout_correlation_id = p_closeout_correlation_id
       AND service_session_id = p_service_session_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_CLOSEOUT_NOT_FOUND');
  END IF;

  -- IDEMPOTENT. A Finalizar retry resumes the SAME correlation id, so the
  -- existing context is returned untouched rather than duplicated.
  SELECT * INTO v_row FROM public.service_closeout_reconciliations
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'created', false, 'reconciliation', to_jsonb(v_row));
  END IF;

  -- THE WINDOW-MATCH RULE, ENFORCED IN THE DATABASE. A cash count may only be
  -- attached when its OWN stored window is byte-identical to this
  -- reconciliation's. Comparing a whole-day count against one service's cash
  -- would invent a discrepancy out of a scope error, so the only way to
  -- reference a count is to prove the windows are the same first.
  IF p_cash_count_id IS NOT NULL THEN
    SELECT c.recorded_cash_receipts_cents INTO v_recorded_at_count
      FROM public.cash_counts c
     WHERE c.id = p_cash_count_id
       AND c.window_from = p_window_from
       AND c.window_to = p_window_to
       AND c.window_timezone = p_window_timezone;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH');
    END IF;
    IF p_counted_cash_cents IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_COUNTED_CASH_REQUIRED');
    END IF;

    -- J-2 — THE FRESHNESS RULE. Same window is necessary, not sufficient: a
    -- count taken at 13:35 and a close pressed at 20:00 share a Business Day.
    -- The count stored the ledger figure it was taken against, and that figure
    -- is immutable, so any drift between it and the receipts being recorded
    -- here is real cash movement AFTER the operator counted. 65.00 counted
    -- against 65.00 recorded does not become a 51.00 shortfall because 51.00
    -- arrived afterwards -- it just stops describing the present. Refuse rather
    -- than write: this row is append-only and there is no later edit.
    IF v_recorded_at_count IS DISTINCT FROM p_cash_receipts_cents THEN
      RETURN jsonb_build_object(
        'ok', false,
        'code', 'RECONCILIATION_CASH_COUNT_STALE',
        'recorded_cash_receipts_at_count', v_recorded_at_count,
        'recorded_cash_receipts_now', p_cash_receipts_cents);
    END IF;

    v_variance := p_counted_cash_cents - p_cash_receipts_cents;
  ELSE
    v_variance := NULL;
  END IF;

  INSERT INTO public.service_closeout_reconciliations (
    service_session_id, closeout_correlation_id,
    window_from, window_to, window_timezone, window_preset, business_date,
    gross_cents, collected_cents, unpaid_cents, voided_cents, refunded_cents,
    cash_receipts_cents, card_receipts_cents, bizum_receipts_cents, other_receipts_cents,
    order_count, service_count,
    cash_count_id, counted_cash_cents, variance_cents, actor
  ) VALUES (
    p_service_session_id, p_closeout_correlation_id,
    p_window_from, p_window_to, p_window_timezone, p_window_preset, p_business_date,
    p_gross_cents, p_collected_cents, p_unpaid_cents, p_voided_cents, p_refunded_cents,
    p_cash_receipts_cents, p_card_receipts_cents, p_bizum_receipts_cents, p_other_receipts_cents,
    p_order_count, p_service_count,
    p_cash_count_id, CASE WHEN p_cash_count_id IS NULL THEN NULL ELSE p_counted_cash_cents END, v_variance, p_actor
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'created', true, 'reconciliation', to_jsonb(v_row));
END;
$fn$;

-- Re-asserted, not assumed: CREATE OR REPLACE preserves existing privileges,
-- but Supabase's ALTER DEFAULT PRIVILEGES has surprised this project twice
-- (ledgers 98 and 99), so the intended grant is restated rather than trusted.
REVOKE ALL ON FUNCTION public.create_service_closeout_reconciliation_v1(
  uuid, uuid, timestamptz, timestamptz, text, text, date,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_closeout_reconciliation_v1(
  uuid, uuid, timestamptz, timestamptz, text, text, date,
  integer, integer, integer, integer, integer, integer, integer, integer, integer,
  integer, integer, text, uuid, integer) TO service_role;

-- ── POST-CONDITIONS ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_src text;
  v_count integer;
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_service_closeout_reconciliation_v1';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'J-2 post-condition failed: the reconciliation writer is missing';
  END IF;

  -- The new refusal is present...
  IF position('RECONCILIATION_CASH_COUNT_STALE' in v_src) = 0 THEN
    RAISE EXCEPTION 'J-2 post-condition failed: the staleness refusal is not in the writer body';
  END IF;
  -- ...and J-1's rules survived the replace. CREATE OR REPLACE swaps the WHOLE
  -- body, so a copy-paste that silently dropped one of these would be invisible
  -- without asserting it here.
  IF position('RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH' in v_src) = 0
     OR position('RECONCILIATION_CLOSEOUT_NOT_FOUND' in v_src) = 0
     OR position('RECONCILIATION_COUNTED_CASH_REQUIRED' in v_src) = 0 THEN
    RAISE EXCEPTION 'J-2 post-condition failed: a J-1 refusal was lost in the replace';
  END IF;

  -- Exactly one overload. A second signature would mean PostgREST could pick
  -- the ungated one.
  SELECT count(*) INTO v_count FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_service_closeout_reconciliation_v1';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'J-2 post-condition failed: expected exactly 1 writer overload, found %', v_count;
  END IF;

  -- Reachable only by the backend, still SECURITY DEFINER with a pinned path.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'create_service_closeout_reconciliation_v1'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'J-2 post-condition failed: the writer must not be executable by browser roles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='create_service_closeout_reconciliation_v1'
                    AND p.prosecdef AND p.proconfig::text LIKE '%search_path=public, pg_temp%') THEN
    RAISE EXCEPTION 'J-2 post-condition failed: the writer lost SECURITY DEFINER or its pinned search_path';
  END IF;

  -- THE TABLE IS UNTOUCHED. This migration replaces a function body and
  -- nothing else; 24 columns and the append-only trigger are ledger 99's.
  SELECT count(*) INTO v_count FROM information_schema.columns
   WHERE table_schema='public' AND table_name='service_closeout_reconciliations';
  IF v_count <> 24 THEN
    RAISE EXCEPTION 'J-2 post-condition failed: expected 24 columns, found %', v_count;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='service_closeout_reconciliations'
                   AND t.tgname='scr_no_update_delete' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'J-2 post-condition failed: the append-only trigger is missing';
  END IF;
  IF has_table_privilege('service_role','public.service_closeout_reconciliations','UPDATE')
     OR has_table_privilege('service_role','public.service_closeout_reconciliations','DELETE')
     OR has_table_privilege('service_role','public.service_closeout_reconciliations','INSERT') THEN
    RAISE EXCEPTION 'J-2 post-condition failed: service_role must hold SELECT only -- the RPC is the sole writer';
  END IF;

  -- CASH COUNTS STAY APPEND-ONLY. Staleness is decided on read; nothing here
  -- may have opened a way to rewrite the history it judges.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='cash_counts' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'J-2 post-condition failed: the cash_counts append-only trigger is missing';
  END IF;
  IF has_table_privilege('service_role','public.cash_counts','UPDATE')
     OR has_table_privilege('service_role','public.cash_counts','DELETE') THEN
    RAISE EXCEPTION 'J-2 post-condition failed: cash_counts stopped being append-only';
  END IF;

  -- THIS IS NOT A LIFECYCLE CHANGE. Both authorities H-1 (ledger 97) pinned
  -- must still be exactly where they were.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='close_service_session_v3') THEN
    RAISE EXCEPTION 'J-2 post-condition failed: close_service_session_v3 is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='open_operational_service_v1') THEN
    RAISE EXCEPTION 'J-2 post-condition failed: open_operational_service_v1 is missing';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96/97/98/99: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 100, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit.

COMMIT;
