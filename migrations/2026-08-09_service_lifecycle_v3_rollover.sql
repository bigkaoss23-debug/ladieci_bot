-- migrations/2026-08-09_service_lifecycle_v3_rollover.sql
-- SERVICE LIFECYCLE V3 / SLICE 3.4 — next-service opening + carryover
-- completion. STAGING ONLY. Requires row 61 (V3-owned table release) and row
-- 60 (incident policy) applied first — this migration is the last link in
-- the chain 57→58→59→61→60→62 (Gate 0, this session's own report).
--
-- ── WHY A NEW COLUMN, NOT JUST A NEW RPC ────────────────────────────────────
-- The V3.4 engine (src/serviceSessions/serviceLifecycleEngine.js) must be
-- able to resume a crashed rollover WITHOUT re-deriving "what should B be"
-- from the clock a second time — the clock may have crossed a schedule
-- boundary between the original attempt and a retry, and re-deriving would
-- risk a retry silently computing a DIFFERENT B than the one (if any)
-- already created. service_sessions.rollover_source_session_id is the fix:
-- an explicit, permanent provenance fact — "this session was opened as the
-- V3 rollover continuation of that closed session" — set once, at creation,
-- by ensure_next_service_session_v3 below. A retry's FIRST move is always to
-- look this up before ever touching the schedule again (see the RPC's own
-- Step 1). This is the same "explicit lineage over recomputation" discipline
-- row 59's transaction-local marker already established for the close side.
--
-- ── WHY A NEW PARTIAL UNIQUE INDEX ──────────────────────────────────────────
-- service_sessions_date_kind_uq (2026-07-26) already forbids two sessions for
-- the same (business_date, service_kind) — the natural ON CONFLICT target
-- for the INSERT below. rollover_source_session_id gets its OWN partial
-- unique index for a narrower, independent guarantee: at most one B may ever
-- claim to be "the rollover continuation of A", for any A — enforced even if
-- a future bug somehow computed two different (business_date, service_kind)
-- pairs for the same source session across two calls (defense in depth, same
-- posture as every other V3/V2 uniqueness invariant in this schema: DB-
-- enforced, never trusted to application code alone).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 rollover refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 rollover refused: row 58 (close engine) not applied — apply it first'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'close_service_session_v3'
       AND pg_get_functiondef(p.oid) LIKE '%v3_close_authorized_session_id%'
  ) THEN RAISE EXCEPTION 'service lifecycle v3 rollover refused: row 59 (close ownership hardening) not applied — apply it first'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='rollover_source_session_id'
  ) THEN RAISE EXCEPTION 'service lifecycle v3 rollover refused: service_sessions.rollover_source_session_id already exists — resolve drift first.'; END IF;

  IF to_regprocedure('public.ensure_next_service_session_v3(uuid,text,date,text,text)') IS NOT NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 rollover refused: ensure_next_service_session_v3 already exists — resolve drift first.'; END IF;
END $$;

-- ── SCHEMA — one additive, nullable column + its own partial unique index ──
ALTER TABLE public.service_sessions
  ADD COLUMN rollover_source_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX service_sessions_rollover_source_uq
  ON public.service_sessions(rollover_source_session_id)
  WHERE rollover_source_session_id IS NOT NULL;

COMMENT ON COLUMN public.service_sessions.rollover_source_session_id IS
  'SERVICE LIFECYCLE V3.4 — set only by ensure_next_service_session_v3, only for a session opened as the automatic V3 rollover continuation of the session it references. NULL for every other session (manually opened, legacy-opened, or the very first V3 session with no prior). Historical provenance, never rewritten.';

-- ── ensure_next_service_session_v3 — the ONE V3-owned "open B" primitive ───
-- Convention A throughout (never RAISEs for an expected/business outcome).
-- p_service_kind/p_business_date are SERVER-TRUSTED-CALLER-COMPUTED: this RPC
-- is service_role-only, never HTTP-exposed (see resource-policy registration,
-- same commit) — its only caller is serviceLifecycleEngine.js, which derives
-- both values from src/serviceSessions/v3NextServiceIdentity.js (itself a
-- thin, pure wrapper over src/schedule/serviceSchedule.js's resolveSchedule()
-- — THE single schedule authority, not duplicated here). This mirrors every
-- other V3 RPC's division of labour exactly: business/calendar logic in JS
-- (DI-testable, no DB access), atomicity/uniqueness/persistence in SQL.
CREATE FUNCTION public.ensure_next_service_session_v3(
  p_source_session_id uuid,
  p_service_kind       text,
  p_business_date      date,
  p_opened_by          text,
  p_source             text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state    public.service_session_state%ROWTYPE;
  v_existing public.service_sessions%ROWTYPE;
  v_session  public.service_sessions%ROWTYPE;
BEGIN
  IF p_source_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  -- language-guard: allow-legacy PRANZO is the existing service_kind enum value already defined on service_sessions (2026-07-26_two_service_identity.sql), not new vocabulary
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SERVICE_KIND');
  END IF;
  IF p_business_date IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_BUSINESS_DATE');
  END IF;
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;

  -- STEP 1 — idempotent reuse, BEFORE touching the lock/schedule at all: has
  -- B already been ensured for THIS exact source session, by an earlier,
  -- possibly-crashed attempt? If so, this retry must reuse it regardless of
  -- what the clock says right now.
  SELECT * INTO v_existing FROM public.service_sessions
   WHERE rollover_source_session_id = p_source_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_existing));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  -- Re-check under the lock — another concurrent caller may have just
  -- created it between the unlocked check above and acquiring the lock.
  SELECT * INTO v_existing FROM public.service_sessions
   WHERE rollover_source_session_id = p_source_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_existing));
  END IF;

  SELECT * INTO v_state FROM public.service_session_state WHERE singleton = true FOR UPDATE;

  -- STEP 2 — the unforgeable lineage proof: A must be THE most recently
  -- V3-closed session (close_service_session_v3 is the only writer of
  -- recent_closed_session_id). Never inferred from order counts, never from
  -- caller-supplied trust — same discipline as row 59's marker, adapted for
  -- a check that spans two separate committed transactions (close, then
  -- ensure) rather than one.
  IF v_state.recent_closed_session_id IS DISTINCT FROM p_source_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ROLLOVER_SOURCE_NOT_RECENTLY_CLOSED');
  END IF;

  -- STEP 3 — current pointer must genuinely be empty. close_service_session_v3
  -- always nulls it; anything else is a real, unexpected conflict — never
  -- silently overwritten (Test L: wrong/conflicting current service).
  IF v_state.current_session_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',false,'code','CURRENT_SESSION_ALREADY_SET');
  END IF;

  -- Defensive backstop mirroring ensure_service_session's own check — should
  -- be structurally impossible given service_sessions_single_active_uq, but
  -- fail loudly rather than silently trust the invariant from a distance.
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 0 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  INSERT INTO public.service_sessions(
    business_date, status, opened_by, open_source, service_kind, rollover_source_session_id
  ) VALUES (
    p_business_date, 'open', p_opened_by, p_source, p_service_kind, p_source_session_id
  )
  ON CONFLICT (business_date, service_kind) WHERE service_kind IS NOT NULL
  DO NOTHING
  RETURNING * INTO v_session;

  IF FOUND THEN
    UPDATE public.service_session_state
       SET current_session_id = v_session.id, updated_at = now()
     WHERE singleton = true;
    INSERT INTO public.service_session_audit(service_session_id, event_type, by_actor, source)
    VALUES (v_session.id, 'opened', p_opened_by, p_source);
    RETURN jsonb_build_object('ok',true,'code','ROLLED_OVER','created',true,'session',to_jsonb(v_session));
  END IF;

  -- Lost the ON CONFLICT race (or, more likely here given the advisory lock
  -- already serializes callers, some UNRELATED session legitimately already
  -- occupies this exact business_date+kind slot — e.g. a manual open). Never
  -- silently claim an unrelated row as "the same B".
  SELECT * INTO v_session FROM public.service_sessions
   WHERE business_date = p_business_date AND service_kind = p_service_kind;
  IF v_session.rollover_source_session_id IS DISTINCT FROM p_source_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','NEXT_SERVICE_IDENTITY_CONFLICT','session',to_jsonb(v_session));
  END IF;
  RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_session));
END;
$fn$;

REVOKE ALL ON FUNCTION public.ensure_next_service_session_v3(uuid,text,date,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_next_service_session_v3(uuid,text,date,text,text) TO service_role;

COMMIT;
