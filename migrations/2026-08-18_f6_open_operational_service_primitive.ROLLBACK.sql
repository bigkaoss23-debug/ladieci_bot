-- migrations/2026-08-18_f6_open_operational_service_primitive.ROLLBACK.sql
-- Paired rollback for 2026-08-18_f6_open_operational_service_primitive.sql.
--
-- GUARDED: F-6 is dormant substrate -- this rollback is straightforward
-- (adds no table/column, so nothing to DROP TABLE/DROP COLUMN), but is still
-- PONR-guarded against real activation, exactly like every other dormant-
-- primitive rollback in this repo (see 2026-08-16_r_day1_business_day_
-- authority_substrate.ROLLBACK.sql's own current_period_id guard). PONR is
-- NOT reached by merely installing the function: it refuses only if a real
-- operational_service_v1 service_sessions row exists anywhere (proof that a
-- later slice has already consumed this substrate for real, matching the
-- lawful use of this primitive), or if a later F-7+ slice has wired an
-- actual caller (grepped fresh: zero references to
-- open_operational_service_v1 outside this migration/its own tests as of
-- F-6, checked again immediately before rollback).
BEGIN;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1') <> 0 THEN
    RAISE EXCEPTION 'F-6 rollback refused: a real operational_service_v1 session exists -- this substrate has been consumed for real, resolve forward-drift first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.open_operational_service_v1(text, text, text);

COMMIT;
