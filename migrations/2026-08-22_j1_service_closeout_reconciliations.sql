-- migrations/2026-08-22_j1_service_closeout_reconciliations.sql
-- J-1 — FINAL RECONCILIATION V1: the economic context a close was made under.
--
-- WHAT THIS IS FOR. Finalizar closes exactly ONE Operational Service, and the
-- service_closeouts row it writes is that service's own financial truth: for
-- 480eca89, 5 tickets / 262.50 gross / 85.00 cash. That is correct and it is
-- not being changed here.
--
-- But an operator counting the drawer is not counting one service. They are
-- counting a DAY. On 2026-08-20 that day held two Operational Services, and
-- its cash receipts were 157.50 — not 85.00. Both figures are right; they
-- answer different questions over different windows. This table records the
-- second one, next to the first, so a close can show both without either
-- pretending to be the other.
--
-- THE RULE THIS TABLE EXISTS TO ENFORCE. A variance may only ever be computed
-- between a cash count and an economic window that are THE SAME WINDOW.
-- Comparing a whole-day physical count against one service's cash would
-- manufacture a 65.00 EUR discrepancy out of nothing but a scope error. So the
-- window is stored explicitly on every row — from, to, timezone — and the
-- cash count is referenced only when its own stored window matches exactly.
--
-- IT OWNS NO MONEY. Nothing here creates a payment, a refund, an adjustment or
-- a cancellation; nothing here changes an order, an event, a cash count or a
-- service_closeouts total. A variance is an observation about two numbers, and
-- recording it changes neither of them.
--
-- APPEND-ONLY, exactly like service_closeouts (trigger
-- service_closeouts_no_update_delete + no UPDATE/DELETE grant) and like
-- cash_counts (ledger 98). A close's reconciliation context is what was true
-- at that close; a later opinion is a new fact, never an edit to this one.
--
-- SUPABASE DEFAULT PRIVILEGES: ALTER DEFAULT PRIVILEGES for schema public
-- grants arwdDxtm -- ALL, including UPDATE and DELETE -- to anon,
-- authenticated AND service_role on every newly created table, before any
-- statement here runs. Every one of the four must therefore be revoked BY NAME
-- or the privilege half of "append-only" is vacuous. Ledger 98's first apply
-- refused itself on exactly that; the revokes below are not redundant.

BEGIN;

CREATE TABLE IF NOT EXISTS public.service_closeout_reconciliations (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The close this context belongs to. closeout_correlation_id is the key the
  -- V3 engine already threads through attempt -> snapshot -> incidents ->
  -- closeout, so reusing it keeps one lineage rather than inventing a second.
  service_session_id            uuid        NOT NULL,
  closeout_correlation_id       uuid        NOT NULL,

  -- THE WINDOW. Stored verbatim, never re-derived on read: a preset's
  -- definition could change, but what this reconciliation actually covered
  -- cannot. This is also the only thing that makes the cash-count comparison
  -- below legitimate.
  window_from                   timestamptz NOT NULL,
  window_to                     timestamptz NOT NULL,
  window_timezone               text        NOT NULL,
  window_preset                 text        NOT NULL,
  -- The service's OWN business_date, which the default window derives from --
  -- never "today". Closing a stale service must reconcile the day it belongs
  -- to, not the day someone happened to press the button.
  business_date                 date        NOT NULL,

  -- The economic snapshot over that window, in integer cents (matching
  -- service_closeouts and cash_counts; no float ever touches stored money).
  gross_cents                   integer     NOT NULL,
  collected_cents               integer     NOT NULL,
  unpaid_cents                  integer     NOT NULL,
  voided_cents                  integer     NOT NULL,
  refunded_cents                integer     NOT NULL,
  cash_receipts_cents           integer     NOT NULL,
  card_receipts_cents           integer     NOT NULL,
  bizum_receipts_cents          integer     NOT NULL,
  other_receipts_cents          integer     NOT NULL,
  order_count                   integer     NOT NULL,
  -- How many distinct Operational Services the window actually spanned. Not
  -- decoration: it is the number that explains to a reader why this row's
  -- cash can legitimately exceed the closeout's.
  service_count                 integer     NOT NULL,

  -- THE PHYSICAL COUNT, when a compatible one exists. All three are NULL
  -- together when none does -- a reconciliation without a count is a normal,
  -- fully valid outcome, never a blocked one, and never a zero.
  cash_count_id                 uuid        NULL REFERENCES public.cash_counts(id),
  counted_cash_cents            integer     NULL,
  variance_cents                integer     NULL,

  actor                         text        NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),

  -- ONE reconciliation per close. This is what makes a Finalizar retry
  -- idempotent rather than duplicating context.
  CONSTRAINT scr_correlation_uq UNIQUE (closeout_correlation_id),

  CONSTRAINT scr_window_ordered_ck CHECK (window_to > window_from),
  -- The three count-derived columns stand or fall together: a variance
  -- without a count, or a count without a variance, would be a half-truth.
  CONSTRAINT scr_count_triplet_ck CHECK (
    (cash_count_id IS NULL AND counted_cash_cents IS NULL AND variance_cents IS NULL)
    OR (cash_count_id IS NOT NULL AND counted_cash_cents IS NOT NULL AND variance_cents IS NOT NULL)
  ),
  -- SIGN CONVENTION, PINNED: variance = counted - recorded. A physical count
  -- BELOW the recorded receipts is NEGATIVE. This matches cash_counts'
  -- own CHECK (ledger 98) exactly, and matches the certified UAT row
  -- (150.00 counted - 157.50 recorded = -7.50). One convention, two tables.
  CONSTRAINT scr_variance_ck CHECK (
    variance_cents IS NULL OR variance_cents = counted_cash_cents - cash_receipts_cents
  ),
  CONSTRAINT scr_counted_nonneg_ck CHECK (counted_cash_cents IS NULL OR counted_cash_cents >= 0),
  CONSTRAINT scr_actor_len_ck CHECK (char_length(actor) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS scr_service_session_idx
  ON public.service_closeout_reconciliations (service_session_id);

-- ── APPEND-ONLY (1/2): PRIVILEGE ────────────────────────────────────────────
REVOKE ALL ON public.service_closeout_reconciliations FROM PUBLIC;
REVOKE ALL ON public.service_closeout_reconciliations FROM anon;
REVOKE ALL ON public.service_closeout_reconciliations FROM authenticated;
REVOKE ALL ON public.service_closeout_reconciliations FROM service_role;
GRANT SELECT ON public.service_closeout_reconciliations TO service_role;

ALTER TABLE public.service_closeout_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_closeout_reconciliations FORCE ROW LEVEL SECURITY;

-- ── APPEND-ONLY (2/2): TRIGGER ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.service_closeout_reconciliations_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION
    'service_closeout_reconciliations is append-only: % is not permitted.',
    TG_OP
    USING ERRCODE = '0A000';
END;
$fn$;

DROP TRIGGER IF EXISTS scr_no_update_delete ON public.service_closeout_reconciliations;
CREATE TRIGGER scr_no_update_delete
  BEFORE UPDATE OR DELETE ON public.service_closeout_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.service_closeout_reconciliations_append_only_v1();

-- ── THE ONLY WRITER ─────────────────────────────────────────────────────────
-- Mirrors create_service_closeout: an RPC is the sole INSERT path (the table
-- itself grants only SELECT), it is idempotent on closeout_correlation_id, and
-- it refuses to write context for a close that does not exist.
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
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_counts c
       WHERE c.id = p_cash_count_id
         AND c.window_from = p_window_from
         AND c.window_to = p_window_to
         AND c.window_timezone = p_window_timezone
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_CASH_COUNT_WINDOW_MISMATCH');
    END IF;
    IF p_counted_cash_cents IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'RECONCILIATION_COUNTED_CASH_REQUIRED');
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
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM information_schema.columns
   WHERE table_schema='public' AND table_name='service_closeout_reconciliations';
  IF v_count <> 24 THEN
    RAISE EXCEPTION 'J-1 post-condition failed: expected 24 columns, found %', v_count;
  END IF;

  -- Append-only, both halves, all four roles.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='service_closeout_reconciliations'
                   AND t.tgname='scr_no_update_delete' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the append-only trigger is missing';
  END IF;
  IF has_table_privilege('service_role','public.service_closeout_reconciliations','UPDATE')
     OR has_table_privilege('service_role','public.service_closeout_reconciliations','DELETE')
     OR has_table_privilege('service_role','public.service_closeout_reconciliations','INSERT') THEN
    RAISE EXCEPTION 'J-1 post-condition failed: service_role must hold SELECT only -- the RPC is the sole writer';
  END IF;
  IF has_table_privilege('anon','public.service_closeout_reconciliations','SELECT')
     OR has_table_privilege('authenticated','public.service_closeout_reconciliations','SELECT') THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the browser roles must not reach this table';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='service_closeout_reconciliations') THEN
    RAISE EXCEPTION 'J-1 post-condition failed: row level security must be enabled and forced';
  END IF;

  -- The writer exists and is reachable only by the backend.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='create_service_closeout_reconciliation_v1') THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the reconciliation writer is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='create_service_closeout_reconciliation_v1'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                     OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the reconciliation writer must not be executable by browser roles';
  END IF;

  -- THIS MIGRATION IS NOT A LIFECYCLE CHANGE. The canonical close surface must
  -- be exactly what H-1 (ledger 97) left it, and this file must not have
  -- opened, closed or touched a single service.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='close_service_session_v3') THEN
    RAISE EXCEPTION 'J-1 post-condition failed: close_service_session_v3 is missing';
  END IF;
  IF (SELECT status FROM public.service_sessions
       WHERE id='480eca89-33cd-43ba-ac7f-5ed0a0473639') IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the preserved forensic service is no longer open';
  END IF;
  IF (SELECT count(*) FROM public.service_closeout_attempts
       WHERE service_session_id='480eca89-33cd-43ba-ac7f-5ed0a0473639') <> 0 THEN
    RAISE EXCEPTION 'J-1 post-condition failed: a closeout was attempted against the preserved service';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) <> 1 THEN
    RAISE EXCEPTION 'J-1 post-condition failed: expected exactly one active Operational Service to be untouched';
  END IF;
  -- The certified cash count is audit evidence and must be exactly as ledger
  -- 98 left it: one row, -750 cents.
  IF (SELECT count(*) FROM public.cash_counts) <> 1
     OR (SELECT variance_cents FROM public.cash_counts LIMIT 1) <> -750 THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the certified UAT cash count changed';
  END IF;
  IF (SELECT count(*) FROM public.service_closeout_reconciliations) <> 0 THEN
    RAISE EXCEPTION 'J-1 post-condition failed: the table is not empty on first apply';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96/97/98: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 99, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit.

COMMIT;
