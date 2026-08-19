-- ================================================================
-- F-10.3C CI-ONLY OVERLAP CONTROL PROBE (Phase 11)
-- Proves two real Node OS processes -> HTTP -> PostgREST -> Postgres
-- lock contention, BEFORE any lifecycle concurrency scenario is trusted.
-- CI-only. Not part of the V3 baseline pack. Dropped implicitly with the
-- ephemeral database's own teardown -- see harness/README note.
-- Uses a distinct, clearly CI-only advisory-lock key text so it can
-- never collide with (or be mistaken for) any real production lock.
-- ================================================================

CREATE OR REPLACE FUNCTION public.f10_cert_overlap_probe_v1(p_hold_seconds numeric DEFAULT 3, p_label text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_acquired timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('f10_cert_overlap_probe_v1'));
  v_acquired := clock_timestamp();
  IF p_hold_seconds > 0 THEN
    PERFORM pg_sleep(p_hold_seconds);
  END IF;
  RETURN jsonb_build_object(
    'label', p_label,
    'acquired_at', to_char(v_acquired, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'released_at', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.f10_cert_overlap_probe_v1(numeric, text) TO f10_ci_runtime;
