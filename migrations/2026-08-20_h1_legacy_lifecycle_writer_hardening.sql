-- migrations/2026-08-20_h1_legacy_lifecycle_writer_hardening.sql
-- H-1 — ZERO REACHABLE LEGACY LIFECYCLE WRITERS, ENFORCED BY THE DATABASE.
--
-- THE PROBLEM. After G-1 (ledger 96) the Operational Service lifecycle has
-- exactly one legitimate opener (open_operational_service_v1) and exactly one
-- legitimate closer (close_service_session_v3). Everything else that can still
-- create or terminate a service is legacy. None of it was reachable in
-- practice -- but only because of environment variables and absent callers:
--
--   LEGACY_AUTOMATIC_LIFECYCLE_ENABLED=false   held back the close-tick, the
--                                              boot catch-up, the external
--                                              cron action and (until this
--                                              slice) the page-load ensure
--   ECONOMIC_PERIOD_ROLLOVER_ENABLED unset     held back the period rollover
--   "no caller since F-5"                      held back the V3 successor opener
--
-- An environment variable is not an invariant. Unset one on one deploy and a
-- page load can close a live service again, or an operator action can mint a
-- legacy-era session and drag the whole system back to economic_period_v1
-- semantics. This migration converts every one of those from "currently
-- unreachable" into "structurally incapable", at the only layer that cannot be
-- reconfigured from outside: the database.
--
-- WHAT IS RETIRED, AND WHY EACH IS SAFE.
--
--   begin_service_session_close / complete_service_session_close
--     The legacy close pair. Called from exactly one place in the whole
--     backend -- serviceSessionLifecycle.js's beginClose/completeClose, which
--     language-guard: allow-legacy servizio.js is the existing legacy close engine's own filename, cited here only to identify it, not new vocabulary
--     only the legacy close engine (src/utils/servizio.js) calls. EVERY legacy
--     close path funnels through them: the close-tick, the boot catch-up, the
--     external-cron action, the retired page-load pre-check, and the legacy
--     era-branch of the operator Finalizar action. Retiring the pair kills all
--     of them at once, from one place.
--     The canonical V3 close does NOT use them -- it uses
--     close_service_session_v3 (serviceLifecycleV3Transition.js), which this
--     migration asserts is untouched, before and after. Operator Finalizar and
--     F-10 forgotten-close both continue to work unchanged.
--     Safety pre-condition: refuses if ANY service is currently 'closing',
--     because that is the one state where the completing half is genuinely
--     mid-flight and retiring it would strand the row.
--
--   roll_service_session_economic_v1
--     Creates a service AND flips its predecessor to 'rolled_over'. It inserts
--     without naming lifecycle_semantics, so the column default applies and it
--     language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, named here only to describe what this retired writer used to mint, not new vocabulary
--     mints an economic_period_v1 row with a PRANZO/SERA identity -- i.e. one
--     successful call would put the live current service back into the legacy
--     era that S-D/F-7/G-1 spent six slices leaving. Contained today only by an
--     unset env var at the HTTP boundary.
--
--   ensure_next_service_session_v3
--     The V3 successor opener. Same era problem, and it has had zero callers
--     since F-5 retired the engine step that used it.
--
-- GRANT HARDENING. complete_service_session_close additionally carried EXECUTE
-- for PUBLIC, anon and authenticated -- the only lifecycle RPC in the schema
-- that did. Any browser holding the publishable key could finish a close that
-- an operator had started, with an arbitrary p_closed_by and with
-- p_preserve_active_orders => true, bypassing the incident-safe guard. The
-- body is fail-closed below, so the grant is already inert; it is revoked
-- anyway, because defence in depth is the whole point of this slice and a
-- future body change must not silently re-expose it.
--
-- WHAT IS DELIBERATELY NOT TOUCHED.
--   * close_service_session_v3, open_operational_service_v1,
--     resolve_order_intake_context_v1, ensure_service_session -- the canonical
--     four. All asserted byte-identical before and after.
--   * F-10's FORGOTTEN_CLOSE_REQUIRED raise and F-11's stale-Business-Day
--     downgrade -- both live inside the canonical four, so both are covered by
--     those same assertions.
--   * mesa_open_session_v1 / mesa_open_reservation_v1 -- the frozen
--     first-seating guard, checksum-pinned before and after.
--   * consolidate_period_v1 -- it writes the Business Day pointer but neither
--     creates nor closes a service, is env-disabled at the HTTP boundary, and
--     is outside this slice's stated scope. Named here so its survival is a
--     recorded decision rather than an oversight.
--   * No data is read, written, or migrated. No service is opened or closed by
--     this migration. The G-1 acceptance service stays exactly as it is.
--
-- SIGNATURES ARE PRESERVED, BODIES ARE NOT. Each retired function keeps its
-- exact signature and returns a typed refusal, matching the precedent already
-- set by open_service_session (which has returned SERVICE_KIND_REQUIRED since
-- F-7). A stale caller fails loudly and legibly instead of hitting a missing
-- function, and the refusal names the replacement.
--
-- The retired bodies carry NO comments, on purpose: the post-conditions below
-- scan pg_proc.prosrc, prosrc includes comments, and G-1's first apply failed
-- precisely because a body comment named a token an absence-check forbade.
--
-- Paired rollback: 2026-08-20_h1_legacy_lifecycle_writer_hardening.ROLLBACK.sql

BEGIN;

DO $$
DECLARE
  v_closing int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'H-1 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF (SELECT max(apply_order) FROM public.ladieci_schema_migrations) <> 96 THEN
    RAISE EXCEPTION 'H-1 refused: ledger head is % (expected 96 -- G-1 must be applied first)',
      (SELECT max(apply_order) FROM public.ladieci_schema_migrations);
  END IF;

  -- The four bodies being retired must be exactly the ones this was written
  -- against. Refusing over drift is cheaper than reasoning about it.
  IF md5(pg_get_functiondef('public.begin_service_session_close(text,text,boolean)'::regprocedure))
       IS DISTINCT FROM '02b815682c9ba6c3353a2c5d93726046'
     OR md5(pg_get_functiondef('public.complete_service_session_close(uuid,text,text,boolean)'::regprocedure))
       IS DISTINCT FROM '2cc17d5d2463528fdf8ad3372e9bd712'
     OR md5(pg_get_functiondef('public.roll_service_session_economic_v1(uuid,uuid,text,text,text,date)'::regprocedure))
       IS DISTINCT FROM '70609253b1ee62c737f263a4ef340dcf'
     OR md5(pg_get_functiondef('public.ensure_next_service_session_v3(uuid,text,date,text,text)'::regprocedure))
       IS DISTINCT FROM '9c9516afae8655353301071aa3548b74'
  THEN
    RAISE EXCEPTION 'H-1 refused: one of the four legacy writers does not match the body this migration was written against';
  END IF;

  -- The canonical four must be exactly G-1's, so the post-conditions below are
  -- genuine preservation checks and not vacuous ones.
  IF md5(pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure))
       IS DISTINCT FROM '9a23c0e3e5e49199a14fbc9bff602e4d'
     OR md5(pg_get_functiondef('public.open_operational_service_v1(text,text,text)'::regprocedure))
       IS DISTINCT FROM '78b9cb458ea9d9ab37056f34f32d52e7'
     OR md5(pg_get_functiondef('public.resolve_order_intake_context_v1(text,text)'::regprocedure))
       IS DISTINCT FROM 'd8811ef0990e038d2b56a2e66c191770'
     OR md5(pg_get_functiondef('public.ensure_service_session(text,text)'::regprocedure))
       IS DISTINCT FROM '5c1155299e0f052b6c74ddc0b9fedfa7'
  THEN
    RAISE EXCEPTION 'H-1 refused: the canonical G-1 lifecycle functions are not in their expected post-G-1 state';
  END IF;

  IF md5(pg_get_functiondef('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'::regprocedure))
       IS DISTINCT FROM 'cdf15eb3699a6a86c16519b1dbcd2f1c'
     OR md5(pg_get_functiondef('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)'::regprocedure))
       IS DISTINCT FROM '21f6d47a1e911f01933bd4b2e2d8558e'
  THEN
    RAISE EXCEPTION 'H-1 refused: the frozen Mesa first-seating guard bodies differ from their pinned checksums';
  END IF;

  -- THE ONE STATE THAT MAKES THIS UNSAFE. complete_service_session_close is
  -- the completing half of a two-phase legacy close. If any service is sitting
  -- in 'closing' right now, retiring it would strand that row with no way to
  -- finish through its own engine.
  SELECT count(*) INTO v_closing FROM public.service_sessions WHERE status = 'closing';
  IF v_closing <> 0 THEN
    RAISE EXCEPTION 'H-1 refused: % service session(s) are mid-close; finish or recover them before retiring the legacy close pair', v_closing;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — the legacy close pair
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.begin_service_session_close(p_closed_by text, p_source text DEFAULT 'backend'::text, p_preserve_active_orders boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('ok', false, 'code', 'LEGACY_CLOSE_ENGINE_RETIRED',
    'use', 'close_service_session_v3');
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_service_session_close(p_session_id uuid, p_closed_by text, p_source text DEFAULT 'backend'::text, p_preserve_active_orders boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('ok', false, 'code', 'LEGACY_CLOSE_ENGINE_RETIRED',
    'use', 'close_service_session_v3');
END
$function$;

REVOKE EXECUTE ON FUNCTION public.complete_service_session_close(uuid,text,text,boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.complete_service_session_close(uuid,text,text,boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.complete_service_session_close(uuid,text,text,boolean) FROM authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — the two legacy service creators
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.roll_service_session_economic_v1(p_service_session_id uuid, p_closeout_correlation_id uuid, p_actor text, p_source text, p_next_service_kind text, p_next_business_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('ok', false, 'code', 'LEGACY_PERIOD_ROLLOVER_RETIRED',
    'use', 'open_operational_service_v1');
END
$function$;

CREATE OR REPLACE FUNCTION public.ensure_next_service_session_v3(p_source_session_id uuid, p_service_kind text, p_business_date date, p_opened_by text, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('ok', false, 'code', 'LEGACY_SUCCESSOR_OPENER_RETIRED',
    'use', 'open_operational_service_v1');
END
$function$;

DO $$
DECLARE
  v_creators int;
  v_closers  int;
  v_names    text;
BEGIN
  -- ── the four retired bodies are inert ───────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('begin_service_session_close','complete_service_session_close',
                         'roll_service_session_economic_v1','ensure_next_service_session_v3')
       AND p.prosrc ~* '(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM)'
  ) THEN
    RAISE EXCEPTION 'H-1 post-condition failed: a retired writer still contains a mutating statement';
  END IF;

  -- ── the creation surface is now exactly ONE function ────────────────────
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_creators, v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
     AND p.prosrc ~* 'INSERT\s+INTO\s+public\.service_sessions';
  IF v_creators <> 1 OR v_names IS DISTINCT FROM 'open_operational_service_v1' THEN
    RAISE EXCEPTION 'H-1 post-condition failed: service_sessions creation surface is [%] (expected exactly open_operational_service_v1)', v_names;
  END IF;

  -- ── the terminal-transition surface is now exactly ONE function ─────────
  -- Scoped to functions that actually UPDATE public.service_sessions to
  -- 'closed'. A bare "mentions status = 'closed'" scan is wrong and was
  -- caught by this migration refusing itself on the first apply: it also
  -- matches mesa_close_session_v1 / mesa_release_empty_session_v1 /
  -- mesa_release_empty_session_auto_v1 / mesa_complete_reservation_v1, which
  -- close a TABLE session (a different table entirely), and
  -- guard_service_session_closed_v1, which only compares the value. None of
  -- those can terminate an Operational Service.
  SELECT count(*), string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_closers, v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')
     AND p.prosrc ~* 'UPDATE\s+public\.service_sessions'
     AND p.prosrc ~* 'status\s*=\s*''closed''';
  IF v_closers <> 1 OR v_names IS DISTINCT FROM 'close_service_session_v3' THEN
    RAISE EXCEPTION 'H-1 post-condition failed: service close surface is [%] (expected exactly close_service_session_v3)', v_names;
  END IF;

  -- ── the canonical four are byte-identical ───────────────────────────────
  IF md5(pg_get_functiondef('public.close_service_session_v3(uuid,uuid,text,text)'::regprocedure))
       IS DISTINCT FROM '9a23c0e3e5e49199a14fbc9bff602e4d'
     OR md5(pg_get_functiondef('public.open_operational_service_v1(text,text,text)'::regprocedure))
       IS DISTINCT FROM '78b9cb458ea9d9ab37056f34f32d52e7'
     OR md5(pg_get_functiondef('public.resolve_order_intake_context_v1(text,text)'::regprocedure))
       IS DISTINCT FROM 'd8811ef0990e038d2b56a2e66c191770'
     OR md5(pg_get_functiondef('public.ensure_service_session(text,text)'::regprocedure))
       IS DISTINCT FROM '5c1155299e0f052b6c74ddc0b9fedfa7'
  THEN
    RAISE EXCEPTION 'H-1 post-condition failed: a canonical G-1 lifecycle function changed';
  END IF;

  -- ── F-10 and F-11 explicitly, by content and not only by checksum ───────
  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='resolve_order_intake_context_v1')
     NOT LIKE '%FORGOTTEN_CLOSE_REQUIRED%' THEN
    RAISE EXCEPTION 'H-1 post-condition failed: F-10 forgotten-close raise is missing';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='ensure_service_session')
     NOT LIKE '%staleBusinessDay%' THEN
    RAISE EXCEPTION 'H-1 post-condition failed: F-11 stale-Business-Day classification is missing';
  END IF;

  -- ── the frozen Mesa guard ───────────────────────────────────────────────
  IF md5(pg_get_functiondef('public.mesa_open_session_v1(uuid,text,uuid,uuid,integer)'::regprocedure))
       IS DISTINCT FROM 'cdf15eb3699a6a86c16519b1dbcd2f1c'
     OR md5(pg_get_functiondef('public.mesa_open_reservation_v1(uuid,text,uuid,integer,uuid)'::regprocedure))
       IS DISTINCT FROM '21f6d47a1e911f01933bd4b2e2d8558e'
  THEN
    RAISE EXCEPTION 'H-1 post-condition failed: the frozen Mesa first-seating guard bodies changed';
  END IF;

  -- ── no lifecycle RPC is reachable by anon/authenticated/PUBLIC ──────────
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f'
     AND p.proname IN ('begin_service_session_close','complete_service_session_close',
                       'close_service_session_v3','open_operational_service_v1',
                       'ensure_service_session','resolve_order_intake_context_v1',
                       'roll_service_session_economic_v1','ensure_next_service_session_v3',
                       'open_service_session','open_business_day_v1','consolidate_period_v1')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'H-1 post-condition failed: lifecycle RPCs still executable by anon/authenticated: [%]', v_names;
  END IF;

  -- ── nothing was opened or closed by this migration ──────────────────────
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) <> 1 THEN
    RAISE EXCEPTION 'H-1 post-condition failed: expected exactly one active Operational Service to be untouched';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE.
-- The manifest records this file's own sha256; embedding that sha in an
-- INSERT inside the file would make the checksum self-referential. The row is
-- registered as a separate statement at apply time, exactly as G-1 (ledger 96)
-- was: apply_order 97, kind 'ddl', checksum = this file's sha256 (16),
-- applied_by = the commit that introduced it.

COMMIT;
