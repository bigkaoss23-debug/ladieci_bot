-- migrations/2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.ROLLBACK.sql
-- Reverses 2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.sql
-- exactly, and ONLY that -- restores ofe_pay_state_transition_chk to the
-- language-guard: allow-legacy v3h_messa_billing_foundation.sql is the existing migration filename this header cites verbatim, not new vocabulary
-- V3-H epoch (2026-08-01_v3h_messa_billing_foundation.sql:322-337), nothing
-- else.
--
-- ROLLBACK_RESTORES_KNOWN_BROKEN_REFUND_OVERCOLLECTION_BEHAVIOR
--
-- Running this file puts ofe_pay_state_transition_chk back into the EXACT
-- state proven broken by the 2026-09-09 forensic audit
-- (CHECK_CENTRIC_REFUND_INTERNAL_ERROR_AUDIT.md): a canonical refund
-- (order_post_refund_v1 or mesa_post_refund_v1) that leaves netCollected
-- still >= currentObligation will again raise PostgreSQL 23514
-- (check_violation) on the order_financial_events INSERT, surfacing to the
-- operator as CASH_INTERNAL_ERROR / HTTP 500 with the write cleanly rolled
-- back (ZERO_WRITE, proven). This is INTENTIONAL and CORRECT rollback
-- behaviour -- exact reversibility of migration history, not a new
-- production recommendation. Do not apply this file to "fix" a future,
-- unrelated problem; it does the opposite of fixing anything.
--
-- ⚠ NATURAL PROPERTY OF THIS ROLLBACK -- NOT A BUG, NOT WORKED AROUND HERE.
-- If, after the forward migration is applied, ANY refund is ever posted
-- (Servicio or Mesa) whose resulting new_pay_state is 'paid' -- i.e. the
-- exact case this migration exists to allow -- that row now satisfies the
-- WIDENED constraint but would violate the NARROWER one this rollback
-- restores. Re-adding the narrower CHECK against a table that already
-- contains such a row is refused by PostgreSQL itself (the ADD CONSTRAINT
-- validates every existing row): 23514 on THIS rollback's own ALTER TABLE.
-- That is Postgres correctly refusing to let a schema rollback silently
-- misclassify a real, already-recorded financial fact. This file does
-- NOT delete, update, or reinterpret any row to force the rollback
-- through, and never will -- a rollback that requires destroying or
-- rewriting real ledger data is not a rollback, it is data loss wearing a
-- rollback's name. If this refusal is ever hit in practice, the correct
-- response is a decision, not a script: either the widened constraint
-- stays (the refund-paid facts it now legitimately holds are kept), or a
-- SEPARATE, explicitly authorized migration is written to handle those
-- specific rows on their own terms. This file makes no such decision for
-- anyone.
--
-- Uses DROP + ADD CONSTRAINT -- symmetric to how the forward migration
-- applied the widening; no function, table, column, or trigger is touched
-- in either direction.

BEGIN;

-- ── PRE-CONDITION: refuse unless the current state is exactly what M124
-- forward installed -- never revert an unknown or already-reverted state.
DO $guard$
DECLARE
  v_def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'order_financial_events'
       AND con.conname = 'ofe_pay_state_transition_chk' AND con.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'M124 ROLLBACK refused: public.order_financial_events.ofe_pay_state_transition_chk missing -- resolve drift first';
  END IF;

  SELECT pg_get_constraintdef(con.oid) INTO v_def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public' AND rel.relname = 'order_financial_events'
     AND con.conname = 'ofe_pay_state_transition_chk';

  -- Must currently be the WIDENED (M124-forward) state -- refuses a
  -- double-rollback or reverting a definition this migration never
  -- installed.
  IF v_def IS DISTINCT FROM $chk$CHECK ((((type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))) OR ((type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)) OR ((type = 'refund'::text) AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)) OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text])) AND (new_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'paid'::text, 'refunded'::text]))))) OR ((type = 'void'::text) AND (prev_pay_state = new_pay_state))))$chk$
  THEN
    RAISE EXCEPTION 'M124 ROLLBACK refused: ofe_pay_state_transition_chk is not the expected M124-widened text (found: %) -- not at the expected M124 epoch, or already rolled back?', v_def;
  END IF;

  -- Ledger baseline is 124 -- checked only if the ledger table exists.
  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 124) THEN
      RAISE EXCEPTION 'M124 ROLLBACK refused: ladieci_schema_migrations has no apply_order=124 row -- forward migration was never registered as applied';
    END IF;
  END IF;

  PERFORM set_config('ladieci.m124rb_ofe_count', (SELECT count(*)::text FROM public.order_financial_events), false);
  PERFORM set_config('ladieci.m124rb_ofe_constraint_count',
    (SELECT count(*)::text FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname='public' AND rel.relname='order_financial_events'), false);
END $guard$;

-- ── THE REVERSAL — restores the exact V3-H text. If any existing row is
-- now a canonical refund with new_pay_state='paid' (the case M124 forward
-- exists to allow), THIS STATEMENT is where PostgreSQL itself will raise
-- 23514 and stop -- see the header note above. No workaround is provided,
-- deliberately.
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_pay_state_transition_chk;

ALTER TABLE public.order_financial_events
  ADD CONSTRAINT ofe_pay_state_transition_chk CHECK (
    (type = 'payment' AND prev_pay_state IN ('unpaid','partially_paid')
      AND new_pay_state IN ('partially_paid','paid'))
    OR
    (type = 'payment_imported' AND payment_transaction_id IS NULL
      AND prev_pay_state = 'unpaid' AND new_pay_state = 'paid')
    OR
    (type = 'refund' AND (
      (payment_transaction_id IS NULL AND prev_pay_state = 'paid' AND new_pay_state = 'refunded')
      OR
      (payment_transaction_id IS NOT NULL AND prev_pay_state IN ('partially_paid','paid')
        AND new_pay_state IN ('unpaid','partially_paid','refunded'))
    ))
    OR
    (type = 'void' AND prev_pay_state = new_pay_state)
  );

-- ── POST-CONDITION ────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public' AND rel.relname = 'order_financial_events'
     AND con.conname = 'ofe_pay_state_transition_chk';

  IF v_def IS DISTINCT FROM $chk$CHECK ((((type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))) OR ((type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)) OR ((type = 'refund'::text) AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)) OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text])) AND (new_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'refunded'::text]))))) OR ((type = 'void'::text) AND (prev_pay_state = new_pay_state))))$chk$
  THEN
    RAISE EXCEPTION 'M124 ROLLBACK post-condition failed: ofe_pay_state_transition_chk is not the restored V3-H text (found: %)', v_def;
  END IF;

  IF (SELECT count(*)::text FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname='public' AND rel.relname='order_financial_events')
     IS DISTINCT FROM current_setting('ladieci.m124rb_ofe_constraint_count', true)
  THEN RAISE EXCEPTION 'M124 ROLLBACK post-condition failed: order_financial_events constraint count changed'; END IF;

  IF (SELECT count(*)::text FROM public.order_financial_events) IS DISTINCT FROM current_setting('ladieci.m124rb_ofe_count', true)
  THEN RAISE EXCEPTION 'M124 ROLLBACK post-condition failed: order_financial_events row count changed -- this rollback must write no data'; END IF;
END $post$;

COMMIT;
