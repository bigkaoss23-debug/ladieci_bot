-- migrations/2026-08-16_r_day1_business_day_authority_substrate.ROLLBACK.sql
-- Paired rollback for 2026-08-16_r_day1_business_day_authority_substrate.sql.
--
-- GUARDED: refuses if any later R-DAY/S6+ object exists (forward drift),
-- and refuses if the pointer has advanced past R-DAY1's own dormant state
-- (current_period_id/current_ticket_epoch non-NULL would mean a later slice
-- already consumed this substrate for real). Removes only R-DAY1-owned
-- objects. Never touches service_sessions.business_date, .id, .service_kind,
-- or any financial/order table. Never deletes a public.business_days row
-- whose business_date does not also exist in public.service_sessions --
-- there is no such row by construction (PART 3 of the forward migration only
-- ever creates one business_days row per DISTINCT service_sessions.
-- business_date), so DROP TABLE removes deterministic lineage only, nothing
-- guessed and nothing independently created.
BEGIN;

DO $$
DECLARE
  v_period  uuid;
  v_epoch   integer;
BEGIN
  IF to_regclass('public.order_entities') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY1 rollback refused: public.order_entities exists -- R-DAY2/S6 has started, resolve forward-drift first';
  END IF;
  IF to_regclass('public.period_consolidations') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY1 rollback refused: public.period_consolidations exists -- R-DAY4 has started, resolve forward-drift first';
  END IF;
  IF to_regclass('public.business_day_closeout_attempts') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY1 rollback refused: public.business_day_closeout_attempts exists -- R-DAY6 has started, resolve forward-drift first';
  END IF;

  IF to_regclass('public.business_day_lifecycle_state') IS NOT NULL THEN
    SELECT current_period_id, current_ticket_epoch
      INTO v_period, v_epoch
      FROM public.business_day_lifecycle_state WHERE singleton = true;
    IF v_period IS NOT NULL THEN
      RAISE EXCEPTION 'R-DAY1 rollback refused: business_day_lifecycle_state.current_period_id is already set -- a later slice has consumed this substrate for real, resolve forward-drift first';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.open_business_day_v1(text, text);
DROP TRIGGER IF EXISTS business_day_lifecycle_state_guard_v1 ON public.business_day_lifecycle_state;
DROP FUNCTION IF EXISTS public.business_day_lifecycle_state_guard_v1();

DROP TABLE IF EXISTS public.business_day_lifecycle_state;

DROP INDEX IF EXISTS public.service_sessions_business_day_idx;
ALTER TABLE public.service_sessions DROP COLUMN IF EXISTS business_day_id;

DROP TABLE IF EXISTS public.business_day_policy;
DROP TABLE IF EXISTS public.business_days;

COMMIT;
