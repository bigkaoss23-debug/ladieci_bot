-- migrations/2026-08-21_i1_cash_counts_append_only.sql
-- I-1 — CASH COUNT V1: AN APPEND-ONLY, LIFECYCLE-INDEPENDENT PHYSICAL COUNT.
--
-- WHAT A CASH COUNT IS. An operator opens the drawer, counts the notes and
-- coins, and records what was physically there at that moment. That is all.
-- It is a timestamped, attributable observation — the same kind of durable
-- fact as a payment — and it is recorded here so it can be audited later.
--
-- WHAT A CASH COUNT IS NOT, AND THIS IS THE WHOLE POINT. It is not a close.
-- It does not Finalizar, does not open or close an Operational Service, does
-- not move a lifecycle pointer, does not reset any total, does not consume or
-- archive a single economic fact. The owner of this system already once read
-- a read-only report titled "Cierre del servicio" and reasonably concluded the
-- service had been finalized when it had not (forensic audit of service
-- 480eca89, 2026-08-21). Counting cash must never be able to cause, or look
-- like, that. Nothing in this file references service lifecycle state, and the
-- table has no trigger, no foreign key and no constraint that could couple it
-- to one — service_session_id below is OPTIONAL, nullable PROVENANCE only.
--
-- APPEND-ONLY, ENFORCED TWICE. A count is a historical observation: once
-- written it is what the operator saw, and no later opinion changes that. If
-- the count was wrong, the remedy is a NEW corrective count, never a rewrite.
-- That is enforced (1) by privilege — no role holds UPDATE or DELETE — and
-- (2) by a trigger that raises regardless of privilege, so a future GRANT, a
-- superuser session or a well-meaning migration cannot quietly reopen history.
--
-- HONEST MONEY SEMANTICS. This system models NO opening float, NO deposits,
-- NO withdrawals, NO petty cash, NO drawer transfers and NO tips. It therefore
-- CANNOT know what the drawer should physically contain, and this table must
-- not pretend otherwise. The stored comparison figure is
-- `recorded_cash_receipts_cents` — cash RECEIPTS RECORDED in the selected
-- window — and the column is named that way on purpose. It is deliberately NOT
-- called expected_cash, expected_drawer or anything of the kind: an operator
-- who kept a 100 EUR opening float and made no error would show a +100
-- "variance" against it, and calling that number "expected in the drawer"
-- would be a lie the schema itself was telling. `variance_cents` is the plain
-- arithmetic difference between what was counted and what was recorded, and
-- means only that.
--
-- MONEY IS INTEGER CENTS. Matching service_closeouts, which already stores
-- gross_sales_cents / paid_amount_cents / cash_amount_cents as integers. No
-- float ever touches a stored monetary value.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cash_counts (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHEN the drawer was actually counted, and WHO counted it. Both are
  -- required: an unattributable count is not evidence of anything.
  counted_at                    timestamptz NOT NULL DEFAULT now(),
  actor                         text        NOT NULL,
  actor_role                    text        NOT NULL,
  workspace_id                  text        NOT NULL,

  -- WHAT WAS PHYSICALLY THERE. The one number only a human can supply.
  counted_cash_cents            integer     NOT NULL,

  -- WHAT THE LEDGER RECORDED for the same window. See the honest-semantics
  -- note above: receipts recorded, NOT an expected drawer balance.
  recorded_cash_receipts_cents  integer     NOT NULL,
  variance_cents                integer     NOT NULL,

  -- WHICH WINDOW the operator was looking at. Stored verbatim so the count
  -- stays auditable even if presets are ever redefined.
  window_from                   timestamptz NOT NULL,
  window_to                     timestamptz NOT NULL,
  window_timezone               text        NOT NULL,
  window_preset                 text        NOT NULL,

  -- OPTIONAL PROVENANCE ONLY. A cash count is not owned by, scoped to, or
  -- lifecycle-coupled to a service. Deliberately NOT a foreign key: a count
  -- must remain readable and true even if the service it happened to mention
  -- is later archived, and no FK may ever give the lifecycle a say over it.
  service_session_id            uuid        NULL,

  -- Enough of the snapshot to re-read this count years later without having
  -- to re-derive it: totals, counts, and the reader's own generated_at.
  snapshot_context              jsonb       NOT NULL DEFAULT '{}'::jsonb,

  note                          text        NULL,

  -- Idempotency: a double-tapped Confirmar must record ONE count, not two.
  client_request_id             text        NOT NULL,

  created_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT cash_counts_window_ordered_ck    CHECK (window_to > window_from),
  CONSTRAINT cash_counts_physical_nonneg_ck   CHECK (counted_cash_cents >= 0),
  -- The variance can never disagree with its own operands.
  CONSTRAINT cash_counts_variance_ck          CHECK (variance_cents = counted_cash_cents - recorded_cash_receipts_cents),
  CONSTRAINT cash_counts_note_len_ck          CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT cash_counts_actor_len_ck         CHECK (char_length(actor) BETWEEN 1 AND 200),
  CONSTRAINT cash_counts_request_id_ck        CHECK (client_request_id ~ '^[A-Za-z0-9_-]{8,128}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS cash_counts_client_request_id_uq
  ON public.cash_counts (client_request_id);

-- The history list reads newest-first over a window.
CREATE INDEX IF NOT EXISTS cash_counts_counted_at_idx
  ON public.cash_counts (counted_at DESC);

-- ── APPEND-ONLY (1/2): PRIVILEGE ────────────────────────────────────────────
REVOKE ALL ON public.cash_counts FROM PUBLIC;
REVOKE ALL ON public.cash_counts FROM anon;
REVOKE ALL ON public.cash_counts FROM authenticated;
GRANT SELECT, INSERT ON public.cash_counts TO service_role;

-- RLS on, with no permissive policy for anon/authenticated: the browser holds
-- the publishable key and must never reach this table directly. Every write
-- goes through the backend's own authenticated route, which supplies the
-- actor from the verified token — never from the request body.
ALTER TABLE public.cash_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_counts FORCE ROW LEVEL SECURITY;

-- ── APPEND-ONLY (2/2): TRIGGER ──────────────────────────────────────────────
-- Privilege alone is revocable by anyone who can GRANT. This is not.
CREATE OR REPLACE FUNCTION public.cash_counts_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION
    'cash_counts is append-only: % is not permitted. Record a new corrective count instead.',
    TG_OP
    USING ERRCODE = '0A000';
END;
$fn$;

DROP TRIGGER IF EXISTS cash_counts_append_only_trg ON public.cash_counts;
CREATE TRIGGER cash_counts_append_only_trg
  BEFORE UPDATE OR DELETE ON public.cash_counts
  FOR EACH ROW EXECUTE FUNCTION public.cash_counts_append_only_v1();

-- ── POST-CONDITIONS ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count integer;
  v_names text;
BEGIN
  -- The table exists with every column this slice's reader and writer expect.
  SELECT count(*) INTO v_count FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cash_counts'
     AND column_name IN ('id','counted_at','actor','actor_role','workspace_id',
                         'counted_cash_cents','recorded_cash_receipts_cents','variance_cents',
                         'window_from','window_to','window_timezone','window_preset',
                         'service_session_id','snapshot_context','note','client_request_id','created_at');
  IF v_count <> 17 THEN
    RAISE EXCEPTION 'I-1 post-condition failed: cash_counts has % of the 17 expected columns', v_count;
  END IF;

  -- HONEST SEMANTICS, ENFORCED. No column may ever claim to know an expected
  -- drawer balance while opening float and drawer movements are unmodelled.
  SELECT string_agg(column_name, ', ' ORDER BY column_name) INTO v_names
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='cash_counts'
     AND (column_name LIKE '%expected%' OR column_name LIKE '%esperado%' OR column_name LIKE '%drawer%');
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'I-1 post-condition failed: cash_counts must not claim an expected drawer balance: [%]', v_names;
  END IF;

  -- Append-only, both halves.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='cash_counts'
                   AND t.tgname='cash_counts_append_only_trg' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'I-1 post-condition failed: the append-only trigger is missing';
  END IF;
  IF has_table_privilege('service_role','public.cash_counts','UPDATE')
     OR has_table_privilege('service_role','public.cash_counts','DELETE') THEN
    RAISE EXCEPTION 'I-1 post-condition failed: service_role must hold neither UPDATE nor DELETE on cash_counts';
  END IF;
  IF has_table_privilege('anon','public.cash_counts','SELECT')
     OR has_table_privilege('anon','public.cash_counts','INSERT')
     OR has_table_privilege('authenticated','public.cash_counts','SELECT')
     OR has_table_privilege('authenticated','public.cash_counts','INSERT') THEN
    RAISE EXCEPTION 'I-1 post-condition failed: the browser roles must not reach cash_counts directly';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='cash_counts') THEN
    RAISE EXCEPTION 'I-1 post-condition failed: row level security must be enabled and forced';
  END IF;

  -- LIFECYCLE INDEPENDENCE. This migration must not have created any coupling
  -- between a cash count and the service lifecycle, in either direction.
  IF EXISTS (SELECT 1 FROM pg_constraint con
               JOIN pg_class c ON c.oid=con.conrelid
               JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname='cash_counts' AND con.contype='f') THEN
    RAISE EXCEPTION 'I-1 post-condition failed: cash_counts must carry no foreign key to any lifecycle table';
  END IF;

  -- AND IT TOUCHED NOTHING ELSE. The preserved forensic service is still open,
  -- and no close was attempted by, or as a side effect of, this migration.
  IF (SELECT status FROM public.service_sessions
       WHERE id='480eca89-33cd-43ba-ac7f-5ed0a0473639') IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'I-1 post-condition failed: the preserved forensic service is no longer open';
  END IF;
  IF (SELECT count(*) FROM public.service_closeout_attempts
       WHERE service_session_id='480eca89-33cd-43ba-ac7f-5ed0a0473639') <> 0 THEN
    RAISE EXCEPTION 'I-1 post-condition failed: a closeout was attempted against the preserved service';
  END IF;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) <> 1 THEN
    RAISE EXCEPTION 'I-1 post-condition failed: expected exactly one active Operational Service to be untouched';
  END IF;

  -- A brand-new table starts empty. If it does not, this file has been run
  -- against a database that already had one and the operator must look first.
  IF (SELECT count(*) FROM public.cash_counts) <> 0 THEN
    RAISE EXCEPTION 'I-1 post-condition failed: cash_counts is not empty on first apply';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as G-1
-- (ledger 96) and H-1 (ledger 97): the manifest records this file's own
-- sha256, and embedding that sha in an INSERT inside the file would make the
-- checksum self-referential. The row is registered as a separate statement at
-- apply time: apply_order 98, kind 'ddl', checksum = this file's sha256,
-- applied_by = the commit that introduced it.

COMMIT;
