-- migrations/2026-08-17_s_b_service_sessions_lifecycle_semantics.ROLLBACK.sql
-- Reverses 2026-08-17_s_b_service_sessions_lifecycle_semantics.sql exactly.
--
-- REFUSES if any operational_service_v1 row exists: once a row exists under
-- the new semantics, removing the discriminator that gives it meaning would
-- destroy that meaning -- exactly the same "never erase committed evidence"
-- discipline as every other paired rollback in this project (R-DAY4's
-- period_consolidations rollback, R-DAY3's schema-PONR guard). Before S-D,
-- operational_service_v1 row count is expected to be 0, so this rollback
-- remains technically available until that slice ships real rows.
BEGIN;

DO $$
DECLARE
  v_operational integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='lifecycle_semantics'
  ) THEN RAISE EXCEPTION 'S-B rollback refused: lifecycle_semantics does not exist -- nothing to roll back'; END IF;

  SELECT count(*) INTO v_operational FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1';
  IF v_operational > 0 THEN
    RAISE EXCEPTION 'S-B rollback refused: % row(s) carry operational_service_v1 semantics -- this is committed meaning, not erasable schema metadata. Do not roll back once real operational_service_v1 rows exist.', v_operational;
  END IF;
END $$;

ALTER TABLE public.service_sessions
  DROP CONSTRAINT service_sessions_active_kind_chk;

ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_active_kind_chk
  CHECK (((status = 'closed'::text) OR (service_kind IS NOT NULL)));

ALTER TABLE public.service_sessions
  DROP CONSTRAINT service_sessions_lifecycle_semantics_chk;

ALTER TABLE public.service_sessions
  DROP COLUMN lifecycle_semantics;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='lifecycle_semantics'
  ) THEN RAISE EXCEPTION 'S-B rollback post-condition failed: lifecycle_semantics still exists'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.service_sessions'::regclass
       AND conname='service_sessions_active_kind_chk'
       AND pg_get_constraintdef(oid) = 'CHECK (((status = ''closed''::text) OR (service_kind IS NOT NULL)))'
  ) THEN RAISE EXCEPTION 'S-B rollback post-condition failed: pre-S-B service_sessions_active_kind_chk not restored exactly'; END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'S-B rollback post-condition failed: payment_transactions population changed -- must be exactly 20';
  END IF;
END $$;

COMMIT;
