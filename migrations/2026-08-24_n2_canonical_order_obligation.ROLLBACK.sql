-- migrations/2026-08-24_n2_canonical_order_obligation.ROLLBACK.sql
-- Reverts N-2's WRITERS. Deliberately PARTIAL, and partial by design.
--
-- READ THIS BEFORE RUNNING IT.
--
-- This rollback removes the two `ordenes` triggers and their functions, so no
-- NEW canonical obligation is recorded and no further revision is appended
-- when a total moves. That returns order creation to its exact pre-N-2
-- behaviour.
--
-- It deliberately DOES NOT drop public.order_obligations when that table holds
-- any row. Those rows are real financial obligations for real orders created
-- after rollout; dropping the table would destroy economic evidence that
-- exists nowhere else, which is precisely the class of loss this whole N
-- series exists to prevent. The append-only guard is therefore left installed
-- too, so the surviving rows stay immutable even while the writers are gone.
--
-- The table IS dropped, cleanly, when it is still empty -- i.e. when N-2 is
-- being rolled back before it ever recorded anything. That is the only case
-- where a full structural revert is economically safe.
--
-- CONSEQUENCE OF A PARTIAL ROLLBACK (know this before choosing it): orders
-- created between apply and rollback keep their obligation rows, so any reader
-- still carrying the N-2 precedence rule will keep reading them canonically,
-- while orders created after the rollback will have none and fall back to
-- `ordenes.totale`. Both paths report the same number today (the revision
-- ledger tracks the accepted total by construction), so this is a provenance
-- split, not a money split -- but roll the backend commit back alongside this
-- file to keep code and data telling one story.
--
-- No `ordenes` row, no order_entities row, no Mesa object and no historical
-- row is touched in either direction.

BEGIN;

-- ── Stop the writers ────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS ordenes_order_obligation_anchor_v1   ON public.ordenes;
DROP TRIGGER IF EXISTS ordenes_order_obligation_revision_v1 ON public.ordenes;
DROP FUNCTION IF EXISTS public.order_obligation_anchor_v1();
DROP FUNCTION IF EXISTS public.order_obligation_revision_v1();

-- ── Drop the ledger ONLY if it never recorded anything ──────────────────
DO $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='order_obligations') THEN
    RETURN;  -- already absent; nothing to decide
  END IF;

  SELECT count(*) INTO v_n FROM public.order_obligations;

  IF v_n = 0 THEN
    DROP TRIGGER IF EXISTS order_obligations_append_only_v1 ON public.order_obligations;
    DROP TABLE public.order_obligations;
    DROP FUNCTION IF EXISTS public.order_obligations_append_only_v1();
    RAISE NOTICE 'N-2 rollback: order_obligations was empty -- full structural revert done.';
  ELSE
    RAISE NOTICE 'N-2 rollback: order_obligations holds % real obligation row(s) -- table, data and append-only guard DELIBERATELY PRESERVED. Writers removed. Drop it manually only if you have independently confirmed those obligations are economically worthless.', v_n;
  END IF;
END $$;

-- ── Post-condition ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_exists boolean;
  v_n      integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass AND NOT tgisinternal
              AND tgname IN ('ordenes_order_obligation_anchor_v1','ordenes_order_obligation_revision_v1')) THEN
    RAISE EXCEPTION 'N-2 rollback post-condition failed: an obligation writer trigger survived';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname IN ('order_obligation_anchor_v1','order_obligation_revision_v1')) THEN
    RAISE EXCEPTION 'N-2 rollback post-condition failed: an obligation writer function survived';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='order_obligations') INTO v_exists;
  IF v_exists THEN
    SELECT count(*) INTO v_n FROM public.order_obligations;
    IF v_n = 0 THEN
      RAISE EXCEPTION 'N-2 rollback post-condition failed: an empty order_obligations should have been dropped';
    END IF;
    -- Surviving evidence must still be immutable.
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_obligations'::regclass
                    AND NOT tgisinternal AND tgname='order_obligations_append_only_v1') THEN
      RAISE EXCEPTION 'N-2 rollback post-condition failed: preserved obligations lost their append-only guard';
    END IF;
  END IF;

  -- Mesa and the R-DAY2 identity anchor are untouched in either direction.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass AND NOT tgisinternal
                  AND tgname='ordenes_order_entity_anchor_v1') THEN
    RAISE EXCEPTION 'N-2 rollback post-condition failed: R-DAY2 identity anchor disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass AND NOT tgisinternal
                  AND tgname='mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'N-2 rollback post-condition failed: Mesa line-snapshot trigger disappeared';
  END IF;
END $$;

COMMIT;
