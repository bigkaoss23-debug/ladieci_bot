-- migrations/2026-08-24_n5_paid_order_economic_mutation_guard.sql
-- N-5 — PAID-ORDER ECONOMIC MUTATION SAFETY.
--
-- WHAT N-2 LEFT OPEN, BY DESIGN. N-2 (ledger 112) made every change to an
-- order's accepted total leave an immutable, attributed obligation revision.
-- It deliberately forbade nothing: its own header says so ("THIS IS NOT N-5.
-- N-5 is money-column IMMUTABILITY -- forbidding the change."). So today the
-- total of an ALREADY-PAID order can still be rewritten by generic order
-- writers, producing obligation != collected with no explicit financial
-- adjustment anywhere. This migration closes that, fail-closed, at the DB.
--
-- THE THREE ACTIVE MONEY WRITERS (traced live this session, not assumed):
--   W1 src/agents/agentOrdini.js:756  -- reachable from BOTH the modificaOrdine -- language-guard: allow-legacy agentOrdini.js/modificaOrdine are the existing module and function names being cited, not new vocabulary
--      and updateOrden actions (index.js:856 / :929). Writes items,
--      delivery_fee, totale, descuento_tipo/valor/importe.
--   W2 src/agents/agentOrdini.js:871 (cambiaStato) -- reachable from the -- language-guard: allow-legacy cambiaStato is the existing JS state-change function name being cited, not new vocabulary
--      cambiaStato / updateEstado / marcarEnEntrega / marcarEntregado actions,
--      AND from Mesa (src/tables/mesaService.js imports it). Writes totale +
--      descuento_* whenever a discount is applied at collection time.
--   W3 src/agents/agentOrdini.js:986 (aggiungiItems) -- reachable from the -- language-guard: allow-legacy aggiungiItems is the existing JS add-items function name being cited, not new vocabulary
--      conversational order flow (src/agents/orchestrator.js:241). Writes
--      items, delivery_fee, totale.
-- Their ONLY gate is a best-effort operational-state check (EN_ENTREGA /
-- RETIRADO / COMPLETADO / COMPLETATO) that never consults payment. -- language-guard: allow-legacy those four are the existing estado literals cited verbatim from agentOrdini.js:601, not new vocabulary
--
-- WHY A VALUE COMPARISON AND NOT A COLUMN-PRESENCE CHECK. This is the single
-- most important decision here, and it is forced by the live code, not chosen
-- for elegance:
--   (a) W1 recomputes and re-writes delivery_fee/totale/descuento_* on EVERY
--       edit that touches items, hora, direccion, tipo_consegna or durata -- -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name being cited, not new vocabulary
--       usually to the IDENTICAL value. Blocking because the column appears in
--       the SET list would freeze ordinary non-economic edits on paid orders.
--   (b) The certified payment path itself would break. public.
--       _ledger_write_payment INSERTs the payment event and THEN runs
--       `UPDATE public.ordenes SET ya_pagado, cobrado, metodo_pago` in the SAME
--       transaction -- by which point payment evidence provably exists. It does
--       not touch any economic column, so a value comparison lets it through
--       and a presence check would not. Verified live: of the eight DB
--       functions that UPDATE public.ordenes (_ledger_write_payment,
--       order_import_legacy_payment, order_refund, order_void,
--       mesa_post_payment_v1, complete_rider_stop,
--       rider_collect_and_complete_stop, start_rider_trip), NOT ONE writes
--       totale, delivery_fee or any descuento column.
-- So: fires only when an economic column is in the SET list (UPDATE OF ...),
-- refuses only when its VALUE actually moved. Numeric comparison is scale-
-- insensitive, so a 10 -> 10.00 rewrite is correctly a no-op.
--
-- THE ECONOMIC BASIS GUARDED, AND WHAT IS DELIBERATELY NOT.
--   GUARDED (A -- changing them changes or falsifies the amount owed):
--     totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe.
--   NOT GUARDED (B -- economic SUPPORTING data): `items`. A same-total item
--     swap (Pizza A 10.00 -> Pizza B 10.00) does not move the canonical
--     obligation, which is gross_amount. Every reachable writer co-writes
--     totale whenever an item change moves value (W1 and W3 both recompute it
--     in the same statement), so a value-changing item edit IS caught, through
--     totale. What remains is same-value content drift on a paid order: an
--     order-integrity concern, not an obligation/payment inconsistency. It is
--     recorded for Post-send Order Editing V2 rather than absorbed here.
--
-- THE PAYMENT-EVIDENCE PREDICATE, AND THE M-1 TRAP IT AVOIDS. M-1 (ledger 105)
-- already answers a NEARBY question -- "would a hard DELETE orphan persistent
-- financial evidence?" -- and its predicate includes table_order_lines and
-- service_incidents. Reusing it verbatim here would have been a catastrophe:
-- table_order_lines is written for EVERY Mesa order by the AFTER INSERT
-- trigger mesa_snapshot_order_lines_v1, paid or not. Proven live before
-- writing this file: orders #999026, #999027 and #999028 are Mesa orders with
-- table_order_lines rows and ZERO money -- no ya_pagado, no cobrado, no
-- order_financial_events. M-1's predicate would have frozen them at creation.
-- N-5 therefore asks the narrower, money-only question:
--     "has any money ever been evidenced for THIS order, in ITS own service?"
--   1. legacy ya_pagado / cobrado (checked on OLD *and* NEW -- see below);
--   2. any row in order_financial_events (the pay-state transition ledger:
--      payment / payment_imported / refund / void -- any of them means money
--      has been touched, so all count, fail-closed);
--   3. any payment_allocations row reached through payment_transactions
--      (Mesa's per-item settlement substrate).
-- Sources 2 and 3 are scoped by COMPOSITE identity (order_id, service_session
-- _id), never order_id alone, exactly as M-1 established -- and that is load-
-- bearing, not ceremonial. Proven live: #379's order row was created
-- 2026-08-15 in session d20ee320, while the order_financial_events row and the
-- two payment_allocations rows carrying its display id are from 2026-08-13 in
-- session c9d5aaa7 -- a DIFFERENT order that recycled the same `#NNN`. Same
-- for #370 and #999004. An order_id-only predicate would freeze three orders
-- on the strength of a stranger's money. The `IS NULL` arms are the fail-
-- closed direction: an evidence row with no session counts for any order.
--
-- WHY OLD *AND* NEW ON THE LEGACY FLAGS. The hostile case is one statement
-- that BOTH declares payment and moves the money: `SET ya_pagado = true,
-- totale = 30`. Reading OLD alone would let it through (OLD.ya_pagado is still
-- false). Reading NEW too refuses it. No live writer sets a legacy flag and an
-- economic column in the same statement -- _ledger_write_payment and
-- mesa_post_payment_v1 both write the flags alone -- so this costs nothing
-- legitimate and closes the hole.
--
-- SAME-TRANSACTION PROTECTION IS STRUCTURAL, NOT TIMED. A BEFORE UPDATE
-- trigger sees the transaction's own prior statements. Payment evidence
-- inserted earlier in the same transaction (_ledger_write_payment) or earlier
-- in the same request (index.js registers the payment, THEN transitions) is
-- already visible when the economic UPDATE arrives. There is no "committed
-- history only" blind spot to engineer around.
--
-- ATOMICITY COMES FREE. Raising here aborts the statement, so on a refused
-- edit: the order row is unchanged, N-2's AFTER UPDATE OF totale trigger never
-- runs (no obligation revision is appended), and nothing else in that
-- transaction commits.
--
-- NO BACKFILL, NO REPAIR. Twelve orders (EUR 271.01) sit inside the structural
-- exposure perimeter today; nine of them acquire this protection the moment
-- this migration lands, and #999001 already carries a real divergence
-- (obligation 100.00, collected 50.00 -- a genuine partial payment). Not one
-- historical row is touched, re-priced or reconciled here. Repair, refunds,
-- surcharges and corrections belong to the explicit financial adjustment
-- workflow that N-5 deliberately does NOT implement.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-5 refused: paid_order_economic_mutation_guard_v1 already exists -- already patched, resolve drift first';
  END IF;
  -- N-2 must be in place: this slice is the "forbid" half of the pair whose
  -- "evidence" half is the obligation ledger.
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='order_obligations') THEN
    RAISE EXCEPTION 'N-5 refused: order_obligations (N-2, ledger 112) is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_revision_v1') THEN
    RAISE EXCEPTION 'N-5 refused: the N-2 revision trigger is missing -- resolve drift first';
  END IF;
  -- The three evidence sources must all exist before we depend on them.
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='order_financial_events') THEN
    RAISE EXCEPTION 'N-5 refused: order_financial_events is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='payment_allocations') THEN
    RAISE EXCEPTION 'N-5 refused: payment_allocations is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='payment_transactions') THEN
    RAISE EXCEPTION 'N-5 refused: payment_transactions is missing -- resolve drift first';
  END IF;
END $$;

BEGIN;

-- ── The guard ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.paid_order_economic_mutation_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_field   text;
  v_old     text;
  v_new     text;
  v_session uuid := OLD.service_session_id;
BEGIN
  -- STEP 1 — did the economic basis actually MOVE? Column presence in the SET
  -- list is not a change; only a differing VALUE is. IS DISTINCT FROM is also
  -- NULL-correct on the three nullable descuento columns.
  IF NEW.totale IS DISTINCT FROM OLD.totale THEN
    v_field := 'totale'; v_old := OLD.totale::text; v_new := NEW.totale::text;
  ELSIF NEW.delivery_fee IS DISTINCT FROM OLD.delivery_fee THEN
    v_field := 'delivery_fee'; v_old := OLD.delivery_fee::text; v_new := NEW.delivery_fee::text;
  ELSIF NEW.descuento_tipo IS DISTINCT FROM OLD.descuento_tipo THEN
    v_field := 'descuento_tipo'; v_old := OLD.descuento_tipo; v_new := NEW.descuento_tipo;
  ELSIF NEW.descuento_valor IS DISTINCT FROM OLD.descuento_valor THEN
    v_field := 'descuento_valor'; v_old := OLD.descuento_valor::text; v_new := NEW.descuento_valor::text;
  ELSIF NEW.descuento_importe IS DISTINCT FROM OLD.descuento_importe THEN
    v_field := 'descuento_importe'; v_old := OLD.descuento_importe::text; v_new := NEW.descuento_importe::text;
  ELSE
    -- Nothing economic moved: a state-only / metadata-only update, or an
    -- identical rewrite. Never this guard's business.
    RETURN NEW;
  END IF;

  -- STEP 2 — has any money ever been evidenced for THIS order, in ITS service?
  IF OLD.ya_pagado IS TRUE OR OLD.cobrado IS TRUE
     OR NEW.ya_pagado IS TRUE OR NEW.cobrado IS TRUE
     OR EXISTS (
          SELECT 1 FROM public.order_financial_events e
           WHERE e.order_id = OLD.id
             AND (v_session IS NULL OR e.service_session_id IS NULL OR e.service_session_id = v_session)
        )
     OR EXISTS (
          SELECT 1 FROM public.payment_allocations pa
            JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
           WHERE pa.order_id = OLD.id
             AND (v_session IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = v_session)
        )
  THEN
    RAISE EXCEPTION 'PAID_ORDER_ECONOMIC_MUTATION_FORBIDDEN'
      USING ERRCODE = 'P0001',
            DETAIL  = format('order_id=%s field=%s old=%s new=%s',
                             OLD.id, v_field, COALESCE(v_old, '<null>'), COALESCE(v_new, '<null>')),
            HINT    = 'This order already carries payment evidence. Its economic basis can only be changed through an explicit financial adjustment workflow.';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.paid_order_economic_mutation_guard_v1() IS
  'N-5 fail-closed guard. Refuses any UPDATE on public.ordenes that MOVES the economic basis (totale, delivery_fee, descuento_tipo/valor/importe) once payment evidence exists for that order in its own service session (legacy ya_pagado/cobrado, order_financial_events, or payment_allocations via payment_transactions). Compares OLD vs NEW values, never column presence, so identical rewrites and every state-only transition pass untouched -- including the payment path''s own UPDATE. Before payment, edits stay legal and N-2 appends the obligation revision as before.';

-- Scoped with UPDATE OF: a state-only transition never even enters the
-- function. A column absent from the SET list cannot change value, so this
-- narrowing costs no coverage.
CREATE TRIGGER ordenes_paid_order_economic_mutation_guard_v1
  BEFORE UPDATE OF totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe
  ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.paid_order_economic_mutation_guard_v1();

-- ── Grants ──────────────────────────────────────────────────────────────
-- Trigger functions are invoked by the executor, never called directly; the
-- browser roles must not be able to call this one by hand either. Matches the
-- N-2 / L-1 posture: revoke BY NAME, not merely FROM PUBLIC.
REVOKE ALL ON FUNCTION public.paid_order_economic_mutation_guard_v1() FROM PUBLIC, anon, authenticated;

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY. No business DML runs inside this transaction: no order row
-- is touched, no obligation is backfilled, no historical money is reconciled.
-- The behavioural proof (unpaid edit allowed + N-2 revision appended, partial-
-- paid refused, fully-paid refused, legacy-paid refused, identical-value
-- rewrite allowed, state-only transition allowed, same-transaction payment
-- then economic rewrite refused, refused edit leaves zero residue) runs
-- separately as rollback-safe probes against real staging -- see this slice's
-- report.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: the guard function was not created';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: the guard trigger is missing';
  END IF;

  -- It must be BEFORE UPDATE: an AFTER trigger cannot refuse the row, and a
  -- BEFORE INSERT one would block order creation.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1'
                  AND pg_get_triggerdef(oid) ILIKE '%BEFORE UPDATE%') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: the guard must be BEFORE UPDATE';
  END IF;

  -- All five guarded columns must be in the UPDATE OF list, or the guard has a
  -- silent hole exactly where it matters.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid='public.ordenes'::regclass AND NOT t.tgisinternal
       AND t.tgname='ordenes_paid_order_economic_mutation_guard_v1'
       AND (SELECT count(*) FROM unnest(t.tgattr::int2[]) a
             WHERE (SELECT attname FROM pg_attribute
                     WHERE attrelid='public.ordenes'::regclass AND attnum=a)
                   IN ('totale','delivery_fee','descuento_tipo','descuento_valor','descuento_importe')) = 5
  ) THEN
    RAISE EXCEPTION 'N-5 post-condition failed: the guard is not scoped to all five economic-basis columns';
  END IF;

  -- N-2 and Mesa must both be structurally untouched by this migration.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_revision_v1') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: the N-2 revision trigger disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: the N-2 creation anchor disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: Mesa line-snapshot trigger disappeared';
  END IF;

  IF has_function_privilege('anon', 'public.paid_order_economic_mutation_guard_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.paid_order_economic_mutation_guard_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-5 post-condition failed: anon/authenticated must not hold EXECUTE on the guard';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-112: the manifest records this file's own sha256, and embedding that sha
-- in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 113, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
