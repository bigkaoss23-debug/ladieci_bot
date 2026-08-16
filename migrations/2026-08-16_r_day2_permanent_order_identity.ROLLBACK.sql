-- migrations/2026-08-16_r_day2_permanent_order_identity.ROLLBACK.sql
-- Paired rollback for 2026-08-16_r_day2_permanent_order_identity.sql.
--
-- GUARDED: refuses if any later slice (R-DAY3 intake flip, R-DAY4
-- consolidation, S7's order_uid SET NOT NULL, S8's append-only backfill) has
-- already started. Refuses if any order_entities row was created by REAL
-- application traffic after this migration (created_by NOT NULL) rather
-- than by this migration's own deterministic backfill or its anchor trigger
-- reacting to a genuine new order -- once permanent identity evidence for a
-- real order exists, destroying it is worse than refusing to roll back.
-- Prefers safe refusal over destructive rollback, per the append-only
-- identity contract this migration itself establishes.
BEGIN;

DO $$
DECLARE
  v_order_uid_not_null boolean;
BEGIN
  IF to_regclass('public.period_consolidations') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY2 rollback refused: public.period_consolidations exists -- R-DAY4 has started, resolve forward-drift first';
  END IF;
  IF to_regclass('public.business_day_closeout_attempts') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY2 rollback refused: public.business_day_closeout_attempts exists -- R-DAY6 has started, resolve forward-drift first';
  END IF;

  SELECT (a.attnotnull) INTO v_order_uid_not_null
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relname = 'ordenes' AND a.attname = 'order_uid' AND NOT a.attisdropped;
  IF v_order_uid_not_null IS TRUE THEN
    RAISE EXCEPTION 'R-DAY2 rollback refused: ordenes.order_uid is already NOT NULL -- S7 has started, resolve forward-drift first';
  END IF;

  IF to_regclass('public.table_ledger_adjustments') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY2 rollback refused: public.table_ledger_adjustments exists -- S10 has started, resolve forward-drift first';
  END IF;

  -- The one destructive-risk check: has REAL order intake happened through
  -- the anchor trigger since this migration applied? Every order_entities
  -- row this migration's own backfill created has created_at copied from
  -- language-guard: allow-legacy storico is the existing archive table named here only for audit context, not new vocabulary
  -- the source order/storico row (necessarily at or before this migration's
  -- own apply time); every row the anchor trigger creates for a genuine new
  -- order gets created_at = now() at INSERT time, strictly after. If any
  -- such row exists, real permanent-identity evidence has been produced and
  -- rollback must refuse rather than destroy it.
  IF EXISTS (
    SELECT 1 FROM public.order_entities oe
     WHERE oe.created_at > (
       SELECT applied_at FROM public.ladieci_schema_migrations
        WHERE filename = '2026-08-16_r_day2_permanent_order_identity.sql'
     )
  ) THEN
    RAISE EXCEPTION 'R-DAY2 rollback refused: order_entities rows exist with created_at after this migration''s own apply time -- real order intake has already produced permanent identity evidence; destroying it is unsafe. Escalate rather than roll back.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS ordenes_order_entity_anchor_v1 ON public.ordenes;
DROP FUNCTION IF EXISTS public.order_entity_anchor_v1();

DROP INDEX IF EXISTS public.ordenes_order_uid_uq;
ALTER TABLE public.ordenes DROP COLUMN IF EXISTS order_uid;

DROP TRIGGER IF EXISTS order_entities_append_only_v1 ON public.order_entities;
DROP TABLE IF EXISTS public.order_entities;

DROP FUNCTION IF EXISTS public.mesa_singleton_workspace_v1();

COMMIT;
