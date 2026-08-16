-- migrations/2026-08-16_r_day2_hotfix_service_sessions_business_day_derive.sql
-- R-DAY2 HOTFIX — service_sessions.business_day_id auto-derivation.
--
-- ROOT CAUSE, discovered live during R-DAY2's own verification pass (not
-- part of R-DAY0's own written spec, and not caught by R-DAY1's test suite
-- because that suite only exercises the NEW dormant open_business_day_v1
-- bootstrap, never the two OLD, pre-existing RPCs that also INSERT into
-- service_sessions): R-DAY1 (2026-08-16_r_day1_business_day_authority_
-- substrate.sql) applied `ALTER TABLE service_sessions ALTER COLUMN
-- business_day_id SET NOT NULL` with no default. Neither
-- public.ensure_service_session(...) nor public.roll_service_session_
-- economic_v1(...) -- both pre-existing, unmodified by any R-DAY slice --
-- ever supply business_day_id in their own INSERT statements. Reproduced
-- live, in a rolled-back transaction, before authoring this fix:
--   INSERT INTO service_sessions(business_date,status,opened_by,open_source,
--     service_kind) VALUES ('2099-01-01','open','probe_test','probe_test',
--     'SERA');
--   -> 23502: null value in column "business_day_id" ... violates not-null
--      constraint
--
-- BLAST RADIUS. Inert right now (a session is currently open, so both RPCs'
-- own "session already current" branches return before ever reaching their
-- INSERT), but load-bearing the next time either RPC genuinely needs to
-- open a NEW session -- i.e. the next real service-period rollover on this
-- staging database. LEGACY_AUTOMATIC_LIFECYCLE_ENABLED=false means nothing
-- triggers that automatically, but a human operator or a real order-intake
-- self-heal path reaching that code today would hit a raw, un-typed 23502
-- instead of the RPC's own clean {ok:false,code:...} contract -- a genuine
-- regression, not a hypothetical one.
--
-- FIX. A BEFORE INSERT trigger on service_sessions that derives
-- business_day_id from NEW.business_date whenever it is NULL, find-or-
-- creating the business_days row deterministically (identical logic to
-- R-DAY1's own historical backfill and to open_business_day_v1's own
-- find-or-create: one row per business_date, business_days_business_date_uq
-- as the concurrency backstop). Neither ensure_service_session nor
-- roll_service_session_economic_v1 is modified -- both continue to work
-- completely unaware this column exists, exactly as they do today. Does
-- NOT touch business_day_lifecycle_state (no consumption of the still-
-- concurrency-unverified pointer tuple, same discipline as R-DAY2's own
-- anchor writer). If a future caller ever explicitly supplies
-- business_day_id, it is overwritten from business_date -- "derivation
-- beats validation", the same established pattern S10's own child-derive
-- trigger already uses elsewhere in this plan family, so a forged value can
-- never survive.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY2 hotfix refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='business_day_id'
  ) THEN RAISE EXCEPTION 'R-DAY2 hotfix refused: service_sessions.business_day_id (R-DAY1) missing -- resolve drift first'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname='service_sessions' AND t.tgname='service_sessions_business_day_derive_v1'
  ) THEN RAISE EXCEPTION 'R-DAY2 hotfix refused: trigger already exists -- already patched, resolve drift first'; END IF;

  -- Reconfirm the exact defect this migration fixes still exists (fail
  -- closed rather than applying a fix for a problem already resolved a
  -- different way).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions'
       AND column_name='business_day_id' AND column_default IS NOT NULL
  ) THEN RAISE EXCEPTION 'R-DAY2 hotfix refused: service_sessions.business_day_id already has a default -- resolve drift first'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.service_session_business_day_derive_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_business_day uuid;
BEGIN
  SELECT id INTO v_business_day FROM public.business_days WHERE business_date = NEW.business_date;
  IF v_business_day IS NULL THEN
    INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
    VALUES (NEW.business_date, COALESCE(NEW.opened_by, 'service_session_business_day_derive_v1'), 'service_session_insert', 1, 1)
    ON CONFLICT (business_date) DO NOTHING
    RETURNING id INTO v_business_day;
    IF v_business_day IS NULL THEN
      -- A concurrent INSERT for the same business_date won the race;
      -- business_days_business_date_uq is the actual serialization
      -- primitive here, this re-read just resolves the loser's own value.
      SELECT id INTO v_business_day FROM public.business_days WHERE business_date = NEW.business_date;
    END IF;
  END IF;
  NEW.business_day_id := v_business_day;
  RETURN NEW;
END $function$;

-- Alphabetically before ordenes_assign_service_session's own concerns are
-- irrelevant here (different table); ordering relative to any other
-- service_sessions trigger doesn't matter because no other trigger reads
-- or writes business_day_id.
CREATE TRIGGER service_sessions_business_day_derive_v1
  BEFORE INSERT ON public.service_sessions
  FOR EACH ROW EXECUTE FUNCTION public.service_session_business_day_derive_v1();

REVOKE ALL ON FUNCTION public.service_session_business_day_derive_v1() FROM PUBLIC, anon, authenticated;

-- Post-condition: reproduce the exact failing probe from this file's own
-- header and assert it now succeeds. Uses status='rolled_over', not 'open'
-- -- a real 'open' session (d20ee320) already exists on this database, and
-- service_sessions_single_active_uq (UNIQUE ((true)) WHERE status IN
-- ('open','closing')) would otherwise collide with it. 'rolled_over' is a
-- legitimate, unconstrained-elsewhere status (unlike 'closed', which the
-- table's own CHECK ties to closed_at IS NOT NULL) and exercises the exact
-- same INSERT column list / NOT NULL path the real bug was in.
DO $$
DECLARE
  v_new_id uuid;
BEGIN
  INSERT INTO public.service_sessions(business_date,status,opened_by,open_source,service_kind)
  VALUES ('2099-01-01','rolled_over','r_day2_hotfix_postcondition_probe','r_day2_hotfix_postcondition_probe','SERA')
  RETURNING id INTO v_new_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_sessions s WHERE s.id = v_new_id AND s.business_day_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'R-DAY2 hotfix post-condition failed: probe row has no business_day_id';
  END IF;

  -- Clean up the probe row and its business_days side effect completely --
  -- this is verification residue, not real lineage, and must not survive
  -- the migration.
  DELETE FROM public.service_sessions WHERE id = v_new_id;
  DELETE FROM public.business_days WHERE business_date = '2099-01-01';
END $$;

COMMIT;
