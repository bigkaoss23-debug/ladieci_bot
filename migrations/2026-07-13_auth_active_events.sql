-- migrations/2026-07-13_auth_active_events.sql
-- Access Control V2 — B2 closeout correction.  ***STAGING ONLY*** (tdikhfeinufaahagmpjz)
-- Additive/corrective. (1) extends auth_audit.event enum with dedicated actor
-- state events; (2) replaces ONLY auth_set_active to emit them (event decided
-- inside the RPC). Touches no other function/table. SECURITY INVOKER, pinned
-- search_path, grants service_role only.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- (1) extend event enum (drop + recreate CHECK with the two new events)
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event IN (
  'login_ok','login_fail','locked','pin_set','pin_change','revoke','bootstrap','recovery',
  'actor_disabled','actor_enabled'));

-- (2) corrected auth_set_active: internal event; disable bumps sv, enable does not.
CREATE OR REPLACE FUNCTION public.auth_set_active(p_actor text, p_active boolean, p_by text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_sv int; v_event text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;

  v_event := CASE WHEN p_active THEN 'actor_enabled' ELSE 'actor_disabled' END;

  UPDATE public.auth_actors
     SET active = p_active,
         session_version = session_version + (CASE WHEN p_active THEN 0 ELSE 1 END),
         updated_at = now(), updated_by = p_by
   WHERE actor = p_actor RETURNING session_version INTO v_sv;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES (v_event, p_actor, p_by, v_meta || jsonb_build_object('active', p_active));

  RETURN jsonb_build_object('actor', p_actor, 'active', p_active, 'session_version', v_sv, 'event', v_event);
END;
$fn$;

REVOKE ALL ON FUNCTION public.auth_set_active(text, boolean, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_set_active(text, boolean, text, jsonb) TO service_role;

COMMIT;
