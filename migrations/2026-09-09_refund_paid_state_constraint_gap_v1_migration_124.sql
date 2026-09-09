-- migrations/2026-09-09_refund_paid_state_constraint_gap_v1_migration_124.sql
-- REFUND_PAID_STATE_CONSTRAINT_GAP_V1 — widens ofe_pay_state_transition_chk
-- so a canonical refund (payment_transaction_id IS NOT NULL) may legally
-- land the order back in pay-state 'paid', not just
-- 'unpaid'/'partially_paid'/'refunded'.
--
-- ROOT CAUSE (CHECK_CENTRIC_REFUND_INTERNAL_ERROR_AUDIT.md, 2026-09-09,
-- read-only forensic audit against LIVE staging data — order #999041,
-- order_uid 9edf488c-2c2c-48b2-9ce5-3e97e8b06837). order_post_refund_v1
-- (migration 122) computes, correctly:
--
--   v_new_state := CASE
--     WHEN v_new_paid_cents <= 0 THEN 'unpaid'
--     WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'
--     ELSE 'partially_paid' END;
--
-- Refunding an OVER-COLLECTION (netCollected already > currentObligation
-- before the refund, and still >= currentObligation after it) makes this
-- branch produce 'paid' — the order genuinely IS still fully paid, it just
-- gave back the excess. That is not a bug in the writer: it is the correct
-- description of the resulting fact. But the ofe_pay_state_transition_chk
-- language-guard: allow-legacy v3h_messa_billing_foundation.sql is the existing migration filename this comment cites verbatim, not new vocabulary
-- installed by V3-H (2026-08-01_v3h_messa_billing_foundation.sql:322-337)
-- predates over-collection as a representable concept (introduced
-- 2026-08-26, ledger 117) and only ever admits, for a canonical refund
-- (payment_transaction_id IS NOT NULL), new_pay_state IN
-- ('unpaid','partially_paid','refunded') — 'paid' is absent. The resulting
-- INSERT into order_financial_events raises PostgreSQL 23514
-- (check_violation); cashDao.rpc() puts that raw message into
-- AuthDaoError.code; cashHttpHandlers.safeError() only recognises codes
-- matching ^(CASH|ORDER|MESA)_[A-Z0-9_]+$, so the structural DB refusal is
-- flattened to CASH_INTERNAL_ERROR / HTTP 500, with no business meaning
-- surfaced to the operator. Reproduced with the exact live UAT numbers
-- (obligation_cents=1600, paid_before_cents=1900, amount_cents=300 →
-- new_paid_cents=1600 → new_state='paid' → INSERT VIOLATES
-- ofe_pay_state_transition_chk) as a pure read-only SELECT against the
-- deployed function bodies and staging data, and confirmed by a local,
-- network-free reproduction of the error-mapping layer
-- (AuthDaoError('<raw pg message>') → safeError() → {status:500,
-- code:'CASH_INTERNAL_ERROR'}).
--
-- BLAST RADIUS — wider than check-centric. mesa_post_refund_v1
-- (2026-08-26_refund_v1_slice_a_mesa_post_refund.sql) computes new_pay_state
-- with the structurally identical rule
-- (`WHEN v_new_paid_cents >= v_order_total_cents THEN 'paid'`) against the
-- SAME shared table and the SAME constraint. Mesa has simply never hit this
-- because every Mesa refund tested to date left the balance strictly below
-- the total. This migration's widening fixes BOTH writers at once, because
-- the constraint — not either writer — is the wrong layer.
--
-- THE FIX IS A PURE VALIDATION WIDENING, NOT A NEW ACCOUNTING TRUTH. Neither
-- writer is touched by this file. The writers already compute the
-- semantically correct value; the constraint is brought up to date with a
-- fact (over-collection) that became representable four migrations after
-- the constraint was last written. Exactly ONE branch is widened — the
-- canonical-refund (payment_transaction_id IS NOT NULL) new_pay_state set —
-- by inserting 'paid' where 'unpaid'/'partially_paid'/'refunded' already
-- stood. No other branch (payment / payment_imported / legacy refund with
-- payment_transaction_id IS NULL / void) is touched.
--
-- WHAT THIS MIGRATION DOES NOT DO (frozen non-goals):
--   * Does NOT modify order_post_refund_v1, mesa_post_refund_v1,
--     order_post_payment_v1, mesa_post_payment_v1, or any other function.
--   * Does NOT modify cashHttpHandlers.safeError() or any Node file — the
--     500 disappears because the DB no longer raises 23514 for this case,
--     not because the mapping layer was taught to catch it.
--   * Does NOT touch payment_transactions, payment_allocations,
--     order_obligations, order_entities, ordenes, or any other table.
--   * Does NOT add, rename, or drop a column.
--   * Does NOT INSERT, UPDATE, or DELETE a single row anywhere — DDL only.
--   * Does NOT widen the payment / payment_imported / legacy-refund / void
--     branches. Does NOT touch ofe_prev_pay_state_chk or
--     ofe_new_pay_state_chk (both already list 'paid' as a legal state on
--     both sides since V3-H; only the TRANSITION rule was stale).
--   * Does NOT retry the failed UAT refund on order #999041 and does NOT
--     touch that order's data. That order is left exactly as the forensic
--     audit found it (obligation 16.00, net collected 19.00,
--     overCollected 3.00, zero refund rows) — RESUME_A7_SAME_ORDER, not
--     executed by this migration.
--
-- STAGING ONLY. NOT APPLIED IN THIS COMMIT (NO PUSH / NO DEPLOY / NO STAGING
-- DB APPLY). Ledger stays 123 until a separate promotion authorization.
-- Function body style N/A here (no function touched); DO blocks use named
-- tags ($guard$ / $post$), never a bare $$ — house style, see migrations
-- 121/122/123.
--
-- NOT EXECUTED IN THIS SESSION: no direct Postgres connection or
-- DDL-capable local tool was available (no `pg` driver in package.json, no
-- psql/postgres/initdb binary, no Docker, no Supabase CLI, no running local
-- Postgres service — verified in this session, not assumed) — this
-- migration's exact SQL has never been run against any Postgres instance,
-- live or local. Same class of reported tooling limitation this project has
-- documented since ledger row 57 (2026-08-09); not a skipped step.

BEGIN;

-- ── PRE-CONDITION: refuse on drift / if already applied ──────────────────────
DO $guard$
DECLARE
  v_old_def text;
BEGIN
  -- A. the table and the constraint must exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public' AND rel.relname = 'order_financial_events'
       AND con.conname = 'ofe_pay_state_transition_chk' AND con.contype = 'c'
  ) THEN
    RAISE EXCEPTION 'M124 refused: public.order_financial_events.ofe_pay_state_transition_chk missing -- resolve drift first';
  END IF;

  -- B. the LIVE constraint definition must be byte-exactly the V3-H epoch
  -- this migration is widening -- not a LIKE, not a substring: an exact
  -- comparison so an unexpected prior edit (this one or any other) refuses
  -- rather than silently double-applying or compounding on drift. Captured
  -- 2026-09-09 via pg_get_constraintdef() against LIVE staging
  -- (tdikhfeinufaahagmpjz) in the read-only forensic audit that precedes
  -- this file, and independently re-derived from the committed V3-H forward
  -- language-guard: allow-legacy v3h_messa_billing_foundation.sql is the existing migration filename this comment cites verbatim, not new vocabulary
  -- migration's own CHECK text (2026-08-01_v3h_messa_billing_foundation.sql
  -- :322-337) -- the two sources agree.
  SELECT pg_get_constraintdef(con.oid) INTO v_old_def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public' AND rel.relname = 'order_financial_events'
     AND con.conname = 'ofe_pay_state_transition_chk';

  IF v_old_def IS DISTINCT FROM $chk$CHECK ((((type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))) OR ((type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)) OR ((type = 'refund'::text) AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)) OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text])) AND (new_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'refunded'::text]))))) OR ((type = 'void'::text) AND (prev_pay_state = new_pay_state))))$chk$
  THEN
    RAISE EXCEPTION 'M124 refused: ofe_pay_state_transition_chk is not the expected V3-H epoch (found: %) -- resolve drift first, or already applied?', v_old_def;
  END IF;

  -- C. ledger baseline is 123, not yet 124 -- checked only if the ledger
  -- table exists (this project's own append-only record, not assumed
  -- present in every environment).
  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 123) THEN
      RAISE EXCEPTION 'M124 refused: ladieci_schema_migrations has no apply_order=123 row -- baseline is not 123';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 124) THEN
      RAISE EXCEPTION 'M124 refused: ladieci_schema_migrations already has an apply_order=124 row -- already applied?';
    END IF;
  END IF;

  -- Snapshot for the post-condition: row counts on every table this
  -- migration's DDL touches or is adjacent to, plus the total constraint
  -- count on order_financial_events (proves exactly the one CHECK is
  -- dropped-and-recreated, not any other object touched) and the total
  -- function count in public (proves zero functions created/dropped/
  -- replaced by this file).
  PERFORM set_config('ladieci.m124_ofe_count', (SELECT count(*)::text FROM public.order_financial_events), false);
  PERFORM set_config('ladieci.m124_pt_count', (SELECT count(*)::text FROM public.payment_transactions), false);
  PERFORM set_config('ladieci.m124_pa_count', (SELECT count(*)::text FROM public.payment_allocations), false);
  PERFORM set_config('ladieci.m124_ordenes_count', (SELECT count(*)::text FROM public.ordenes), false);
  PERFORM set_config('ladieci.m124_ob_count', (SELECT count(*)::text FROM public.order_obligations), false);
  PERFORM set_config('ladieci.m124_ofe_constraint_count',
    (SELECT count(*)::text FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname='public' AND rel.relname='order_financial_events'), false);
  PERFORM set_config('ladieci.m124_public_fn_count',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'), false);
END $guard$;

-- ── THE FIX — ONE constraint, drop + re-add, widened by exactly one
-- state ('paid') in exactly one branch (canonical refund,
-- payment_transaction_id IS NOT NULL). Every other branch is reproduced
-- byte-identical to the V3-H text verified above. ─────────────────────────
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
      -- WIDENED (the one and only semantic change in this migration):
      -- a canonical refund (payment_transaction_id IS NOT NULL) may now
      -- also land on 'paid' -- refunding part or all of an over-collection
      -- can leave the order still fully, exactly paid. Previously only
      -- unpaid/partially_paid/refunded were admitted here.
      (payment_transaction_id IS NOT NULL AND prev_pay_state IN ('partially_paid','paid')
        AND new_pay_state IN ('unpaid','partially_paid','paid','refunded'))
    ))
    OR
    (type = 'void' AND prev_pay_state = new_pay_state)
  );

-- ── POST-CONDITION ────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_new_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_new_def
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public' AND rel.relname = 'order_financial_events'
     AND con.conname = 'ofe_pay_state_transition_chk';

  -- A. the new definition is byte-exactly the widened text -- proves the
  -- ADD CONSTRAINT produced precisely the intended expression, not
  -- something Postgres's own canonicalizer reshaped differently.
  IF v_new_def IS DISTINCT FROM $chk$CHECK ((((type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))) OR ((type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)) OR ((type = 'refund'::text) AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)) OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text])) AND (new_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text, 'paid'::text, 'refunded'::text]))))) OR ((type = 'void'::text) AND (prev_pay_state = new_pay_state))))$chk$
  THEN
    RAISE EXCEPTION 'M124 post-condition failed: ofe_pay_state_transition_chk is not the expected widened text (found: %)', v_new_def;
  END IF;

  -- B. structural, rendering-independent redundant proof (belt-and-braces
  -- alongside A, in the same spirit as M122's own move from rendered-text
  -- to structural checks after a search_path-dependent rendering surprise
  -- on a TRIGGER definition -- CHECK constraints are not known to share
  -- that specific hazard, but a second, narrower proof costs nothing and
  -- catches a different class of mistake than A would).
  IF NOT (
    position('unpaid''::text, ''partially_paid''::text, ''paid''::text, ''refunded''::text' IN v_new_def) > 0
  ) THEN
    RAISE EXCEPTION 'M124 post-condition failed: widened new_pay_state array not found in canonical-refund branch';
  END IF;
  IF position('unpaid''::text, ''partially_paid''::text, ''refunded''::text]' IN v_new_def) > 0 THEN
    RAISE EXCEPTION 'M124 post-condition failed: the OLD (narrower) new_pay_state array is still present -- widening did not take effect';
  END IF;

  -- C. no other branch changed: payment / payment_imported / legacy-refund
  -- (payment_transaction_id IS NULL) / void text is present verbatim.
  IF position($frag$(type = 'payment'::text) AND (prev_pay_state = ANY (ARRAY['unpaid'::text, 'partially_paid'::text])) AND (new_pay_state = ANY (ARRAY['partially_paid'::text, 'paid'::text]))$frag$ IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'M124 post-condition failed: the payment branch changed -- must be untouched';
  END IF;
  IF position($frag$(type = 'payment_imported'::text) AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid'::text) AND (new_pay_state = 'paid'::text)$frag$ IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'M124 post-condition failed: the payment_imported branch changed -- must be untouched';
  END IF;
  IF position($frag$(payment_transaction_id IS NULL) AND (prev_pay_state = 'paid'::text) AND (new_pay_state = 'refunded'::text)$frag$ IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'M124 post-condition failed: the legacy (payment_transaction_id IS NULL) refund branch changed -- must be untouched';
  END IF;
  IF position($frag$(type = 'void'::text) AND (prev_pay_state = new_pay_state)$frag$ IN v_new_def) = 0 THEN
    RAISE EXCEPTION 'M124 post-condition failed: the void branch changed -- must be untouched';
  END IF;

  -- D. ofe_prev_pay_state_chk / ofe_new_pay_state_chk are untouched by this
  -- migration (this file contains no DROP/ADD CONSTRAINT for either).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=rel.relnamespace
     WHERE n.nspname='public' AND rel.relname='order_financial_events' AND con.conname='ofe_prev_pay_state_chk')
  THEN RAISE EXCEPTION 'M124 post-condition failed: ofe_prev_pay_state_chk missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=rel.relnamespace
     WHERE n.nspname='public' AND rel.relname='order_financial_events' AND con.conname='ofe_new_pay_state_chk')
  THEN RAISE EXCEPTION 'M124 post-condition failed: ofe_new_pay_state_chk missing'; END IF;

  -- E. exactly the same NUMBER of constraints on order_financial_events as
  -- before this migration ran -- proves one DROP + one ADD, nothing else.
  IF (SELECT count(*)::text FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname='public' AND rel.relname='order_financial_events')
     IS DISTINCT FROM current_setting('ladieci.m124_ofe_constraint_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: order_financial_events constraint count changed -- scope must be exactly one CHECK replaced'; END IF;

  -- F. zero functions created, dropped, or replaced anywhere in public.
  IF (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
     IS DISTINCT FROM current_setting('ladieci.m124_public_fn_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: number of functions in public schema changed -- this migration must touch zero functions'; END IF;

  -- G. zero rows written anywhere -- DDL only, no DML.
  IF (SELECT count(*)::text FROM public.order_financial_events) IS DISTINCT FROM current_setting('ladieci.m124_ofe_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: order_financial_events row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.payment_transactions) IS DISTINCT FROM current_setting('ladieci.m124_pt_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: payment_transactions row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.payment_allocations) IS DISTINCT FROM current_setting('ladieci.m124_pa_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: payment_allocations row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.ordenes) IS DISTINCT FROM current_setting('ladieci.m124_ordenes_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: ordenes row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.order_obligations) IS DISTINCT FROM current_setting('ladieci.m124_ob_count', true)
  THEN RAISE EXCEPTION 'M124 post-condition failed: order_obligations row count changed'; END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-123: registered as a separate statement at apply time -- apply_order
-- 124, kind 'ddl', checksum = this file's sha256, applied_by = the
-- introducing commit (committed BEFORE this migration is applied). NOT
-- APPLIED in this commit -- ledger stays 123.

COMMIT;
