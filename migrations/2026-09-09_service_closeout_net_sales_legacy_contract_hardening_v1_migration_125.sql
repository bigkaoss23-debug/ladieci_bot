-- migrations/2026-09-09_service_closeout_net_sales_legacy_contract_hardening_v1_migration_125.sql
-- SERVICE_CLOSEOUT_NET_SALES_LEGACY_CONTRACT_HARDENING_V1 -- makes the legacy
-- semantics of public.service_closeouts.net_sales_cents self-documenting AT THE
-- SCHEMA, by adding a COMMENT ON COLUMN. Metadata-only: NOT a data change, NOT a
-- schema change, NOT a writer change.
--
-- AUTHORITY: SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md (2026-09-09,
-- READ-ONLY forensic against BE 1ee1a59 / FE 4eaf8a8 / staging ledger 124).
-- Verdict ECONOMIC_FISCAL_CONTRACT_HARDENING_REQUIRED. Proven there:
--   * NET_SALES_WRITER_FORMULA = max(0, gross_sales_cents - total_refunds_cents),
--     where gross_sales_cents is the ORIGINAL ORDER GROSS (Sigma raw
--     ordenes.totale, non-cancelled). Introduced 2026-08-09 (migration 57 /
--     commit 4252241,5152055); formula NEVER changed since (git log -G on the
--     Math.max line = exactly 2 commits, both introduction). 18/18 historical
--     closeouts conform.
--   * COMMERCIAL_ADJUSTMENTS_REFLECTED_IN_NET_SALES_CENTS = NO -- the two writers
--     (serviceLifecycleEngine.js, economicBoundaryEngine.js) deliberately source
--     grossSalesCents from totals.originalGross, NOT totals.gross (which IS the
--     current obligation), so an ajuste 24 -> 19 -> 16 never enters this field.
--   * #999041 (closeout 36826341, 2026-09-09) is the FIRST row in history where
--     net_sales_cents (2100) diverges from BOTH the current obligation (1600)
--     and the net collected (1600). 2400 - 300 = 2100.
--   * BACKEND_RUNTIME_CONSUMERS = 0 (read-influence). FRONTEND_RUNTIME_CONSUMERS
--     = 0. 0 indirect aliases (11 patterns swept). BUT wire exposure = 1:
--     serviceCloseouts.js publicCloseout() mapped it to financial.netSalesCents
--     and index.js res.json(result) shipped it in the service-close HTTP
--     response -- removed in the SAME commit that introduces this migration
--     (src side).
--   * FISCAL_CANDIDATE_NET_SALES_DEPENDENCY = NO today, but the future
--     service_closeout_fiscal_summaries is designed to FK into service_closeouts,
--     so the column MUST carry an unambiguous, schema-visible contract before
--     that table exists.
--
-- WHAT THIS MIGRATION DOES: exactly one statement --
--   COMMENT ON COLUMN public.service_closeouts.net_sales_cents IS '<contract>'.
--
-- WHAT THIS MIGRATION DOES NOT DO (frozen non-goals):
--   * Does NOT ALTER TABLE, ADD/DROP/RENAME/ALTER any column, constraint, index,
--     trigger, function, view, sequence or grant.
--   * Does NOT change net_sales_cents' formula, type, nullability or default.
--   * Does NOT touch the writers (serviceLifecycleEngine.js /
--     economicBoundaryEngine.js / serviceCloseoutCreation.js) -- the RPC
--     create_service_closeout still receives and persists p_net_sales_cents
--     verbatim.
--   * Does NOT INSERT, UPDATE or DELETE a single row anywhere. Zero DML. The
--     append-only trigger service_closeouts_no_update_delete is untouched.
--   * Does NOT backfill. Does NOT reinterpret any historical row. Does NOT add a
--     duplicate accounting field. Does NOT redefine the formula in place (proven
--     UNSAFE in the audit: NOT NULL on 18/18 rows, no epoch discriminator).
--   * Does NOT add a fiscal column and does NOT couple service_closeouts to any
--     fiscal document.
--
-- STAGING ONLY. NOT APPLIED IN THIS COMMIT (NO PUSH / NO DEPLOY / NO STAGING DB
-- APPLY). Ledger stays 124 until a separate promotion authorization.
-- DO blocks use named tags ($guard$ / $post$), never a bare $$ -- house style,
-- see migrations 121/122/123/124.
--
-- NOT EXECUTED IN THIS SESSION: this migration's exact SQL has never been run
-- against any Postgres instance, live or local -- same reported tooling
-- limitation this project has carried since ledger row 57 (2026-08-09).

BEGIN;

-- The exact contract text this migration installs. Kept apostrophe-free and on
-- one logical line so the paired ROLLBACK's $guard$ and the static test can pin
-- it byte-for-byte.
--   IS $c$LEGACY / HISTORICAL compatibility field. Formula unchanged since migration 57 (2026-08-09): net_sales_cents = max(0, gross_sales_cents - total_refunds_cents), where gross_sales_cents is the ORIGINAL ORDER GROSS (sum of raw ordenes.totale for non-cancelled orders, before any commercial adjustment). Commercial adjustments (order_obligations revisions) are NOT reflected here. This column is NOT the current obligation (use current_obligation_cents), NOT the net collected (use paid_amount_cents), NOT a canonical accounting authority, NOT a taxable base, NOT a fiscal or invoice total. Retained ONLY for historical semantic compatibility of pre-existing rows. New consumers MUST NOT read this column: use the canonical fields gross_sales_cents / current_obligation_cents / paid_amount_cents / total_refunds_cents / unpaid_exposure_cents / over_collected_cents. Ref: SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md.$c$

-- ── PRE-CONDITION: refuse on drift / if already applied ──────────────────────
DO $guard$
DECLARE
  v_existing text;
BEGIN
  -- A. the table and the column must exist.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'service_closeouts'
       AND column_name = 'net_sales_cents'
  ) THEN
    RAISE EXCEPTION 'M125 refused: public.service_closeouts.net_sales_cents missing -- resolve drift first';
  END IF;

  -- B. the column must NOT already carry a comment. Before this migration the
  -- audit proved col_description() is NULL; a non-NULL value means an
  -- unexpected prior edit or a double-apply -- refuse rather than overwrite.
  SELECT col_description('public.service_closeouts'::regclass, ordinal_position::int)
    INTO v_existing
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'service_closeouts'
     AND column_name = 'net_sales_cents';
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'M125 refused: net_sales_cents already has a column comment (found: %) -- resolve drift first, or already applied?', v_existing;
  END IF;

  -- C. ledger baseline is 124, not yet 125 -- checked only if the ledger table
  -- exists (this project's own append-only record, not assumed present).
  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 124) THEN
      RAISE EXCEPTION 'M125 refused: ladieci_schema_migrations has no apply_order=124 row -- baseline is not 124';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 125) THEN
      RAISE EXCEPTION 'M125 refused: ladieci_schema_migrations already has an apply_order=125 row -- already applied?';
    END IF;
  END IF;

  -- Snapshot for the post-condition: this migration must change EXACTLY the one
  -- column comment and NOTHING structural. Column count + constraint count on
  -- service_closeouts, total function count in public, and row count on
  -- service_closeouts.
  PERFORM set_config('ladieci.m125_sc_col_count',
    (SELECT count(*)::text FROM information_schema.columns
      WHERE table_schema='public' AND table_name='service_closeouts'), false);
  PERFORM set_config('ladieci.m125_sc_constraint_count',
    (SELECT count(*)::text FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname='public' AND rel.relname='service_closeouts'), false);
  PERFORM set_config('ladieci.m125_public_fn_count',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'), false);
  PERFORM set_config('ladieci.m125_sc_row_count',
    (SELECT count(*)::text FROM public.service_closeouts), false);
END $guard$;

-- ── THE HARDENING — ONE statement, metadata only. ────────────────────────────
COMMENT ON COLUMN public.service_closeouts.net_sales_cents IS $c$LEGACY / HISTORICAL compatibility field. Formula unchanged since migration 57 (2026-08-09): net_sales_cents = max(0, gross_sales_cents - total_refunds_cents), where gross_sales_cents is the ORIGINAL ORDER GROSS (sum of raw ordenes.totale for non-cancelled orders, before any commercial adjustment). Commercial adjustments (order_obligations revisions) are NOT reflected here. This column is NOT the current obligation (use current_obligation_cents), NOT the net collected (use paid_amount_cents), NOT a canonical accounting authority, NOT a taxable base, NOT a fiscal or invoice total. Retained ONLY for historical semantic compatibility of pre-existing rows. New consumers MUST NOT read this column: use the canonical fields gross_sales_cents / current_obligation_cents / paid_amount_cents / total_refunds_cents / unpaid_exposure_cents / over_collected_cents. Ref: SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md.$c$;

-- ── POST-CONDITION ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_now text;
BEGIN
  -- A. the comment is now byte-exactly the intended contract text.
  SELECT col_description('public.service_closeouts'::regclass, ordinal_position::int)
    INTO v_now
    FROM information_schema.columns
   WHERE table_schema='public' AND table_name='service_closeouts'
     AND column_name='net_sales_cents';
  IF v_now IS DISTINCT FROM $c$LEGACY / HISTORICAL compatibility field. Formula unchanged since migration 57 (2026-08-09): net_sales_cents = max(0, gross_sales_cents - total_refunds_cents), where gross_sales_cents is the ORIGINAL ORDER GROSS (sum of raw ordenes.totale for non-cancelled orders, before any commercial adjustment). Commercial adjustments (order_obligations revisions) are NOT reflected here. This column is NOT the current obligation (use current_obligation_cents), NOT the net collected (use paid_amount_cents), NOT a canonical accounting authority, NOT a taxable base, NOT a fiscal or invoice total. Retained ONLY for historical semantic compatibility of pre-existing rows. New consumers MUST NOT read this column: use the canonical fields gross_sales_cents / current_obligation_cents / paid_amount_cents / total_refunds_cents / unpaid_exposure_cents / over_collected_cents. Ref: SERVICE_CLOSEOUT_NET_SALES_LEGACY_SEMANTICS_V1_AUDIT.md.$c$
  THEN
    RAISE EXCEPTION 'M125 post-condition failed: net_sales_cents comment is not the expected contract text (found: %)', v_now;
  END IF;

  -- B. redundant structural spot-checks: the essential legacy/non-authority
  -- clauses are present (rendering-independent belt-and-braces).
  IF position('LEGACY / HISTORICAL compatibility field' IN v_now) = 0
     OR position('max(0, gross_sales_cents - total_refunds_cents)' IN v_now) = 0
     OR position('ORIGINAL ORDER GROSS' IN v_now) = 0
     OR position('Commercial adjustments (order_obligations revisions) are NOT reflected here' IN v_now) = 0
     OR position('NOT a taxable base' IN v_now) = 0
     OR position('NOT a fiscal or invoice total' IN v_now) = 0
     OR position('New consumers MUST NOT read this column' IN v_now) = 0
  THEN
    RAISE EXCEPTION 'M125 post-condition failed: a required contract clause is missing from the net_sales_cents comment';
  END IF;

  -- C. no sibling column comment was created or changed -- the other two
  -- commented columns (current_obligation_cents / over_collected_cents, from
  -- migration 121) keep their exact text; every other column stays uncommented.
  IF (SELECT count(*) FROM information_schema.columns c
       WHERE c.table_schema='public' AND c.table_name='service_closeouts'
         AND col_description('public.service_closeouts'::regclass, c.ordinal_position::int) IS NOT NULL)
     <> 3
  THEN
    RAISE EXCEPTION 'M125 post-condition failed: expected exactly 3 commented columns on service_closeouts (net_sales_cents + current_obligation_cents + over_collected_cents)';
  END IF;

  -- D. nothing structural changed: column count, constraint count, public
  -- function count and row count are all exactly as snapshotted in $guard$.
  IF (SELECT count(*)::text FROM information_schema.columns
        WHERE table_schema='public' AND table_name='service_closeouts')
     IS DISTINCT FROM current_setting('ladieci.m125_sc_col_count', true)
  THEN RAISE EXCEPTION 'M125 post-condition failed: service_closeouts column count changed'; END IF;

  IF (SELECT count(*)::text FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
       WHERE n.nspname='public' AND rel.relname='service_closeouts')
     IS DISTINCT FROM current_setting('ladieci.m125_sc_constraint_count', true)
  THEN RAISE EXCEPTION 'M125 post-condition failed: service_closeouts constraint count changed'; END IF;

  IF (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
     IS DISTINCT FROM current_setting('ladieci.m125_public_fn_count', true)
  THEN RAISE EXCEPTION 'M125 post-condition failed: public schema function count changed -- this migration must touch zero functions'; END IF;

  -- E. zero rows written anywhere -- metadata only, no DML.
  IF (SELECT count(*)::text FROM public.service_closeouts) IS DISTINCT FROM current_setting('ladieci.m125_sc_row_count', true)
  THEN RAISE EXCEPTION 'M125 post-condition failed: service_closeouts row count changed'; END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-124: registered as a separate statement at apply time -- apply_order 125,
-- kind 'ddl', checksum = this file's sha256, applied_by = the introducing
-- commit. NOT APPLIED in this commit -- ledger stays 124.

COMMIT;
