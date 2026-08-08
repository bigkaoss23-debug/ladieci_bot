-- migrations/2026-08-08_service_closeout_attempt_ownership.sql
-- SERVICE CLOSEOUT V2 / SLICE 3.1 — persistent closeout ATTEMPT ownership,
-- hardened in place by SLICE 3.2 (never applied to any database — same
-- in-place-hardening precedent as SLICE 2.1 on the post-close-financial-
-- resolutions migration).
-- STAGING ONLY. Additive-only at the SCHEMA level: no existing table/RPC's
-- DDL from Slice 1 (foundation) or the (unwired, JS-only) Slice 3
-- orchestrator is altered here. SLICE 3.2's supersede_closeout_attempt DOES
-- now also WRITE rows in the existing service_incidents table (an ordinary
-- RPC-body UPDATE using privileges Slice 1 already granted service_role —
-- not a DDL change) — see "SLICE 3.2" below.
--
-- ── SLICE 3.2 — snapshot-winner race + superseded-incident disposition ─────
-- Two defects found auditing 3.1: (a) two callers that BOTH acquire the SAME
-- active attempt (legitimate — that's the whole point of the active-uq
-- invariant) can still race on their FIRST capture: both read/classify
-- before either has captured, one wins snapshot_correlation_uq, the loser's
-- capture() call returns created:false + the WINNER's row. The orchestrator
-- (incidentSafeRollover.js) now checks `created` and, on a loss, discards its
-- own locally-derived classification and uses the persisted winner's
-- (embedded in the snapshot's payload) instead — the same discipline already
-- applied to a same-attempt RETRY, just also applied to the very first
-- capture. (b) an attempt's still-pending/acknowledged incidents must not
-- keep reading as ordinary actionable alarms forever after that attempt is
-- superseded (e.g. the operator paid the exact balance the incident was
-- about, then a fresh attempt captured a clean state) — but the facts must
-- never be deleted or rewritten. supersede_closeout_attempt() now
-- ATOMICALLY (same function body = same implicit transaction as the status
-- transition — a crash between the two statements is impossible, both
-- commit or neither does) also transitions every still-pending/acknowledged
-- service_incidents row for that closeout_correlation_id to the new
-- resolution_status='superseded' (added to service_incidents' CHECK
-- vocabulary by the SLICE 3.2 HARDENING note in
-- 2026-08-08_service_closeout_incidents_foundation.sql), stamped
-- resolution_type='closeout_attempt_superseded', resolved_by=the actor who
-- triggered the supersession, resolved_at=now(). Every original detection
-- fact (financial_exposure_cents, entity, severity, snapshot_id...) is
-- immutable and untouched — only the resolution-summary columns move,
-- exactly the same allow-list resolve_service_incident() already uses.
-- 'superseded' is NEVER settable through resolve_service_incident() (that
-- RPC's own vocabulary check is unchanged) — it means something categorically
-- different from a human resolving something, and only this RPC ever writes
-- it.
--
-- ── WHY THIS EXISTS (audit finding from Slice 3 recovery) ──────────────────
-- Slice 3's incidentSafeRollover.js discovered "the current closeout attempt
-- for a session" by SELECTing service_closeout_snapshots newest-first and
-- reusing whatever it found, forever — there was no persisted concept of an
-- attempt being ACTIVE vs COMPLETED vs abandoned, and two truly concurrent
-- callers with no existing snapshot yet could each mint their own
-- closeout_correlation_id and both succeed at capture_closeout_snapshot
-- (idempotent only on THEIR OWN id, not on service_session_id), producing two
-- snapshots for one session. This migration adds the missing authoritative
-- ledger: service_closeout_attempts, with a database-enforced invariant that
-- at most one ACTIVE attempt can exist per service session at any time.
--
-- Deliberately NOT storing a `superseded_by` forward pointer: the full
-- lineage of every attempt a session ever had is already reconstructable from
-- (service_session_id, started_at) without it — adding a second field to
-- keep in sync for the same fact would be schema for its own sake.
--
-- No business_date/service_kind duplication either — service_sessions rows
-- are never deleted (ON DELETE RESTRICT everywhere they're referenced), so a
-- join is always safe and this table stays a pure attempt-ownership ledger,
-- not a second reporting surface.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'closeout attempt ownership refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_closeout_snapshots') IS NULL
     OR to_regclass('public.service_incidents') IS NULL
  THEN RAISE EXCEPTION 'closeout attempt ownership refused: service session / closeout snapshot / incident foundation missing (apply Slice 1 first)'; END IF;

  IF to_regclass('public.service_closeout_attempts') IS NOT NULL
  THEN RAISE EXCEPTION 'closeout attempt ownership refused: target object already exists — resolve drift first.'; END IF;
END $$;

-- ── STEP 1 — the attempt-ownership ledger ───────────────────────────────────
CREATE TABLE public.service_closeout_attempts (
  closeout_correlation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_session_id       uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,

  -- 'active': the ONE attempt currently owning this session's closeout work.
  -- 'completed': chiudiServizio succeeded under this attempt; terminal.
  -- 'superseded': this attempt's frozen snapshot no longer describes live
  --   state (see the fingerprint-comparison contract in rolloverClassifier.js
  --   / incidentSafeRollover.js) and a fresh attempt took over; terminal.
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','superseded')),

  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  superseded_at         timestamptz,
  supersession_reason   text,

  created_by    text NOT NULL CHECK (btrim(created_by) <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT service_closeout_attempts_completed_fields_chk
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT service_closeout_attempts_superseded_fields_chk
    CHECK ((status = 'superseded') = (superseded_at IS NOT NULL))
);

CREATE INDEX service_closeout_attempts_session_idx
  ON public.service_closeout_attempts(service_session_id, started_at);

-- THE invariant (plan STEP 3): at most one ACTIVE attempt per service
-- session, enforced by the database, not by application code. Two
-- concurrent acquire_closeout_attempt() calls for the same session race on
-- this exact index; Postgres serializes the conflicting INSERTs and the
-- loser's ON CONFLICT DO NOTHING (see the RPC below) simply finds and
-- returns the winner's row.
CREATE UNIQUE INDEX service_closeout_attempts_active_uq
  ON public.service_closeout_attempts(service_session_id) WHERE status = 'active';

COMMENT ON TABLE public.service_closeout_attempts IS
  'SERVICE CLOSEOUT V2 — persistent closeout ATTEMPT ownership. One row per real closeout attempt for a service session; at most one may be status=''active'' at a time (DB-enforced). Never deleted. Full attempt lineage for a session = every row for that service_session_id ordered by started_at.';

-- Rows are never deleted (audit trail).
CREATE OR REPLACE FUNCTION public.service_closeout_attempts_no_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'service_closeout_attempts rows cannot be deleted' USING ERRCODE='0A000';
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_closeout_attempts_no_delete() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_closeout_attempts_no_delete
  BEFORE DELETE ON public.service_closeout_attempts
  FOR EACH ROW EXECUTE FUNCTION public.service_closeout_attempts_no_delete();

-- Identity/origin facts (closeout_correlation_id, service_session_id,
-- created_by, started_at, created_at) are immutable after insert. Only the
-- lifecycle-transition columns below may ever change, and only through the
-- RPCs in this migration. DENY-BY-DEFAULT (same pattern as
-- service_incidents_immutable_facts, 2026-08-08 Slice 1): compares the full
-- row minus an explicit allow-list, so a column added to this table in the
-- future is immutable by default without touching this function again.
CREATE OR REPLACE FUNCTION public.service_closeout_attempts_guarded_transitions()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_mutable_keys text[] := ARRAY['status','completed_at','superseded_at','supersession_reason','updated_at'];
BEGIN
  IF (to_jsonb(OLD) - v_mutable_keys) IS DISTINCT FROM (to_jsonb(NEW) - v_mutable_keys) THEN
    RAISE EXCEPTION 'SERVICE_CLOSEOUT_ATTEMPT_IDENTITY_IMMUTABLE' USING ERRCODE='P0001';
  END IF;
  -- Terminal statuses never transition again, not even to another terminal
  -- status — completed and superseded are both dead ends, enforced here so
  -- the RPCs below can treat "already terminal" as safely idempotent without
  -- also having to re-derive this rule themselves.
  IF OLD.status IN ('completed','superseded') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'SERVICE_CLOSEOUT_ATTEMPT_ALREADY_TERMINAL' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.service_closeout_attempts_guarded_transitions() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER service_closeout_attempts_guarded_transitions
  BEFORE UPDATE ON public.service_closeout_attempts
  FOR EACH ROW EXECUTE FUNCTION public.service_closeout_attempts_guarded_transitions();

-- ── STEP 2 — RPCs ────────────────────────────────────────────────────────
-- acquire_closeout_attempt (plan STEP 4) — THE only place a
-- closeout_correlation_id is ever minted for a session. No JS caller
-- generates one independently.
--   no active attempt exists  -> creates one, created:true
--   an active attempt exists  -> returns it unchanged, created:false
-- Race-safe: relies entirely on service_closeout_attempts_active_uq: two
-- concurrent callers' INSERTs serialize at the database, the loser's ON
-- CONFLICT DO NOTHING finds nothing to return and falls through to the
-- SELECT, which the invariant guarantees will find the winner's row.
CREATE OR REPLACE FUNCTION public.acquire_closeout_attempt(
  p_service_session_id uuid,
  p_actor              text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_row public.service_closeout_attempts%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_sessions WHERE id = p_service_session_id) THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;

  INSERT INTO public.service_closeout_attempts(service_session_id, status, created_by)
  VALUES (p_service_session_id, 'active', p_actor)
  ON CONFLICT (service_session_id) WHERE status = 'active' DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','ACQUIRED','created',true,'attempt',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_attempts
   WHERE service_session_id = p_service_session_id AND status = 'active';
  IF NOT FOUND THEN
    -- Cannot happen under the active-uq invariant (a losing INSERT means a
    -- winner's active row exists) — reported distinctly rather than silently
    -- treated as INVALID_ARGUMENTS if it somehow ever does.
    RETURN jsonb_build_object('ok',false,'code','ACQUIRE_RACE_UNRESOLVED');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_ACTIVE','created',false,'attempt',to_jsonb(v_row));
END;
$fn$;

-- supersede_closeout_attempt (plan STEP 6/7) — called ONLY when the caller
-- has proved (by comparing a fresh state fingerprint against the frozen
-- snapshot's payload_sha256 — see rolloverClassifier.js computeStateFingerprint)
-- that this active attempt's frozen classification no longer describes live
-- state. Idempotent: a caller that races to supersede an already-superseded
-- attempt gets the same successful outcome, not an error — both callers
-- wanted the same end state and will each separately acquire the fresh
-- attempt that replaces it.
CREATE OR REPLACE FUNCTION public.supersede_closeout_attempt(
  p_closeout_correlation_id uuid,
  p_actor                   text,
  p_reason                  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_row public.service_closeout_attempts%ROWTYPE;
BEGIN
  IF p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;

  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object('ok',false,'code','CANNOT_SUPERSEDE_COMPLETED_ATTEMPT');
  END IF;
  IF v_row.status = 'superseded' THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_SUPERSEDED','idempotent',true,'attempt',to_jsonb(v_row));
  END IF;

  UPDATE public.service_closeout_attempts
     SET status = 'superseded', superseded_at = now(), supersession_reason = p_reason, updated_at = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
  RETURNING * INTO v_row;

  -- SLICE 3.2 — same transaction as the status flip above (this whole
  -- function body IS one implicit transaction; nothing between here and the
  -- UPDATE above can partially commit). Every immutable detection fact is
  -- untouched; only the resolution-summary columns move, via the SAME
  -- allow-list resolve_service_incident() already uses. Rows already
  -- 'resolved' (including auto-resolved ones) or already 'superseded' are
  -- deliberately excluded — this never re-litigates a real resolution.
  UPDATE public.service_incidents
     SET resolution_status = 'superseded',
         resolution_type   = 'closeout_attempt_superseded',
         resolved_by       = p_actor,
         resolved_at       = now(),
         updated_at        = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
     AND resolution_status IN ('pending','acknowledged');

  RETURN jsonb_build_object('ok',true,'code','SUPERSEDED','idempotent',false,'attempt',to_jsonb(v_row));
END;
$fn$;

-- complete_closeout_attempt (plan STEP 5) — called ONLY after chiudiServizio
-- has actually succeeded for the session this attempt owns. Idempotent on an
-- already-completed attempt for the same reason as supersede above.
CREATE OR REPLACE FUNCTION public.complete_closeout_attempt(
  p_closeout_correlation_id uuid,
  p_actor                   text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_row public.service_closeout_attempts%ROWTYPE;
BEGIN
  IF p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  SELECT * INTO v_row FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;

  IF v_row.status = 'superseded' THEN
    RETURN jsonb_build_object('ok',false,'code','CANNOT_COMPLETE_SUPERSEDED_ATTEMPT');
  END IF;
  IF v_row.status = 'completed' THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_COMPLETED','idempotent',true,'attempt',to_jsonb(v_row));
  END IF;

  UPDATE public.service_closeout_attempts
     SET status = 'completed', completed_at = now(), updated_at = now()
   WHERE closeout_correlation_id = p_closeout_correlation_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok',true,'code','COMPLETED','idempotent',false,'attempt',to_jsonb(v_row));
END;
$fn$;

-- ── STEP 3 — access control (same discipline as Slice 1) ───────────────────
ALTER TABLE public.service_closeout_attempts ENABLE ROW LEVEL SECURITY;
-- ZERO CREATE POLICY -> default-deny for anon & authenticated; service_role bypass.

REVOKE ALL ON public.service_closeout_attempts FROM PUBLIC, anon, authenticated, service_role;
-- acquire/supersede/complete only ever SELECT, INSERT and UPDATE the
-- lifecycle-transition columns (guarded independently by the trigger above).
-- No RPC ever DELETEs a row (also enforced independently by the no-delete
-- trigger above) and no sequence exists (uuid PK, gen_random_uuid()).
GRANT SELECT, INSERT, UPDATE ON public.service_closeout_attempts TO service_role;

REVOKE ALL ON FUNCTION
  public.service_closeout_attempts_no_delete(),
  public.service_closeout_attempts_guarded_transitions()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.acquire_closeout_attempt(uuid,text),
  public.supersede_closeout_attempt(uuid,text,text),
  public.complete_closeout_attempt(uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.acquire_closeout_attempt(uuid,text),
  public.supersede_closeout_attempt(uuid,text,text),
  public.complete_closeout_attempt(uuid,text)
  TO service_role;

-- No wiring in this migration file itself: application wiring (JS calling
-- these three RPCs from incidentSafeRollover.js) ships in the same commit as
-- this migration but is a separate, reviewable concern — this file only
-- proves the storage/RPC/concurrency contract, exactly like Slice 1 did for
-- service_closeout_snapshots/service_incidents.
COMMIT;
