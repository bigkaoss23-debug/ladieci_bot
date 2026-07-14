-- migrations/2026-07-13_auth_active_events.ROLLBACK.sql
-- Guarded rollback for the B2 closeout correction.  ***STAGING ONLY***
-- Reverts ONLY: the event-enum extension and auth_set_active. Touches no other
-- function/table. REFUSES if any audit row already uses the new events (the
-- enum could not be narrowed without violating the CHECK). Do NOT run in tests.
BEGIN;
DO $$
DECLARE v_new int;
BEGIN
  IF to_regclass('public.auth_audit') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: auth_audit missing — unexpected state.';
  END IF;
  SELECT count(*) INTO v_new FROM public.auth_audit WHERE event IN ('actor_disabled','actor_enabled');
  IF v_new > 0 THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: % audit rows use the new events; manual review required.', v_new;
  END IF;
END $$;

-- restore the original B0 event enum (8 events)
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery'));

-- restore the previous auth_set_active (audit event = 'revoke', meta op:set_active)
CREATE OR REPLACE FUNCTION public.auth_set_active(p_actor text, p_active boolean, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_sv int; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  UPDATE public.auth_actors SET active = p_active,
    session_version = session_version + (CASE WHEN p_active THEN 0 ELSE 1 END), updated_at = now(), updated_by = p_by
   WHERE actor = p_actor RETURNING session_version INTO v_sv;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES ('revoke', p_actor, p_by, v_meta || jsonb_build_object('op','set_active','active',p_active));
  RETURN jsonb_build_object('actor', p_actor, 'active', p_active, 'session_version', v_sv);
END;
$fn$;
REVOKE ALL ON FUNCTION public.auth_set_active(text, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_active(text, boolean, text, jsonb) TO service_role;

COMMIT;
