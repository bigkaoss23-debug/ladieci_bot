-- ===============================================================
-- S2-7D6B — two-service identity (PRANZO / SERA)
--
-- The 2026-07-22 identity migration made a service session a UUID rather than a
-- date. It did NOT record WHICH service a session is, and it left three
-- uniqueness rules keyed on the order id alone. Together those make a real
-- two-service day impossible:
--
--   * order numbering restarts at #001 after every close (ORDER_RESET_TS), so
--     dinner reuses lunch's ids;
--   * order_financial_events enforces one payment / one refund per order_id
--     GLOBALLY and its rows are never deleted, so dinner #001's payment collides
--     with lunch #001's payment — the ledger simply refuses the second service;
--   * archivio_conv is keyed (wa_id, data_servizio), so a customer who orders at
--     lunch and again at dinner loses the lunch conversation archive.
--
-- This migration fixes identity and uniqueness only. It creates no session, and
-- it deletes nothing.
--
-- LEGACY ROWS ARE NEVER GUESSED. docs/SERVICE_SESSION_IDENTITY.md forbids
-- inferring a service from a timestamp, so the two closed smoke sessions and the
-- seven pre-identity financial events keep service_kind / service_session_id
-- NULL and are protected by dedicated legacy indexes.
-- ===============================================================
BEGIN;

DO $$
BEGIN
  -- (1) staging sentinel — same guard as every S2 migration.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D6B refused: staging sentinel migration absent — wrong database?'; END IF;

  -- (2) the 2026-07-22 identity foundation must already be in place.
  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_state') IS NULL
     OR to_regclass('public.service_session_audit') IS NULL
  THEN RAISE EXCEPTION 'S2-7D6B refused: service session identity foundation missing'; END IF;

  -- (3) refuse if an active session already exists: adding a NOT NULL-ish kind
  -- invariant underneath a live service would strand it.
  IF EXISTS (SELECT 1 FROM public.service_sessions WHERE status IN ('open','closing'))
  THEN RAISE EXCEPTION 'S2-7D6B refused: an active service session exists — close it first'; END IF;

  -- (4) refuse if legacy data already violates the new session-scoped ledger
  -- uniqueness (would fail the index build with an opaque error).
  IF EXISTS (
    SELECT 1 FROM public.order_financial_events
    WHERE service_session_id IS NOT NULL AND type IN ('payment','payment_imported')
    GROUP BY service_session_id, order_id HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'S2-7D6B refused: duplicate session-scoped payments present'; END IF;
END $$;

-- ── 1. SERVICE IDENTITY ─────────────────────────────────────────────────────
ALTER TABLE public.service_sessions
  ADD COLUMN IF NOT EXISTS service_kind text;

-- Enum. NULL stays legal only for rows that are already closed (legacy).
ALTER TABLE public.service_sessions
  DROP CONSTRAINT IF EXISTS service_sessions_kind_chk;
ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_kind_chk
  CHECK (service_kind IS NULL OR service_kind IN ('PRANZO','SERA'));

-- Every session that is (or becomes) active MUST carry a kind. Legacy closed
-- rows are exempt; nothing can go open/closing without one ever again.
ALTER TABLE public.service_sessions
  DROP CONSTRAINT IF EXISTS service_sessions_active_kind_chk;
ALTER TABLE public.service_sessions
  ADD CONSTRAINT service_sessions_active_kind_chk
  CHECK (status = 'closed' OR service_kind IS NOT NULL);

-- Exactly one PRANZO and one SERA per business date. This deliberately also
-- forbids REOPENING a service of the same kind on the same day: a second lunch
-- on one date is an accounting error, not a recovery. Recovery reopens are
-- therefore a different business date or a different kind, by design.
CREATE UNIQUE INDEX IF NOT EXISTS service_sessions_date_kind_uq
  ON public.service_sessions (business_date, service_kind)
  WHERE service_kind IS NOT NULL;

-- The pre-existing single-active guard is UNTOUCHED and still authoritative:
-- lunch and dinner remain strictly sequential, never concurrent.
--   service_sessions_single_active_uq UNIQUE ((true)) WHERE status IN ('open','closing')

-- Denormalised onto the summary so per-service reporting never has to join.
ALTER TABLE public.serata_summary
  ADD COLUMN IF NOT EXISTS service_kind text;
ALTER TABLE public.serata_summary
  DROP CONSTRAINT IF EXISTS serata_summary_kind_chk;
ALTER TABLE public.serata_summary
  ADD CONSTRAINT serata_summary_kind_chk
  CHECK (service_kind IS NULL OR service_kind IN ('PRANZO','SERA'));

-- ── 2. FINANCIAL IDENTITY ───────────────────────────────────────────────────
-- Session-scoped for every new row; the old global rule survives verbatim for
-- pre-identity rows, so legacy safety is not weakened anywhere.
DROP INDEX IF EXISTS public.order_financial_events_one_payment_uq;
DROP INDEX IF EXISTS public.order_financial_events_one_refund_uq;
ALTER TABLE public.order_financial_events
  DROP CONSTRAINT IF EXISTS order_financial_events_scope_uq;

CREATE UNIQUE INDEX order_financial_events_one_payment_session_uq
  ON public.order_financial_events (service_session_id, order_id)
  WHERE service_session_id IS NOT NULL AND type IN ('payment','payment_imported');
CREATE UNIQUE INDEX order_financial_events_one_payment_legacy_uq
  ON public.order_financial_events (order_id)
  WHERE service_session_id IS NULL AND type IN ('payment','payment_imported');

CREATE UNIQUE INDEX order_financial_events_one_refund_session_uq
  ON public.order_financial_events (service_session_id, order_id)
  WHERE service_session_id IS NOT NULL AND type = 'refund';
CREATE UNIQUE INDEX order_financial_events_one_refund_legacy_uq
  ON public.order_financial_events (order_id)
  WHERE service_session_id IS NULL AND type = 'refund';

CREATE UNIQUE INDEX order_financial_events_scope_session_uq
  ON public.order_financial_events (service_session_id, order_id, type, idem_scope_key)
  WHERE service_session_id IS NOT NULL;
CREATE UNIQUE INDEX order_financial_events_scope_legacy_uq
  ON public.order_financial_events (order_id, type, idem_scope_key)
  WHERE service_session_id IS NULL;

-- ── 3. CONVERSATION ARCHIVE IDENTITY ────────────────────────────────────────
ALTER TABLE public.archivio_conv
  ADD COLUMN IF NOT EXISTS service_session_id uuid
  REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS archivio_conv_service_session_idx
  ON public.archivio_conv (service_session_id);

DROP INDEX IF EXISTS public.archivio_conv_unique;
CREATE UNIQUE INDEX archivio_conv_session_wa_uq
  ON public.archivio_conv (service_session_id, wa_id)
  WHERE service_session_id IS NOT NULL;
CREATE UNIQUE INDEX archivio_conv_legacy_uq
  ON public.archivio_conv (wa_id, data_servizio)
  WHERE service_session_id IS NULL;

-- ── 4. THE ENSURE RPC ───────────────────────────────────────────────────────
-- Idempotent by contract. The KIND IS AN ARGUMENT, resolved by the backend from
-- the authoritative schedule module and never by the client: the HTTP layer does
-- not read it from the request body. This function only validates the enum and
-- the invariants — it deliberately holds no schedule of its own, so there is one
-- source of truth for opening hours and it lives in Node.
--
-- business_date uses the 04:00 operational rollover, so a dinner ensured at
-- 01:30 correctly belongs to the day it opened on.
CREATE OR REPLACE FUNCTION public.ensure_service_session(
  p_opened_by text,
  p_service_kind text,
  p_source text DEFAULT 'auto_entry'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
  v_madrid timestamp;
  v_business_date date;
BEGIN
  IF p_service_kind IS NULL OR p_service_kind NOT IN ('PRANZO','SERA') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SERVICE_KIND');
  END IF;
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;

  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;

  -- An active session exists → this is the idempotent path.
  IF v_state.current_session_id IS NOT NULL THEN
    SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.current_session_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_STATE_CORRUPT'); END IF;
    IF v_session.status = 'closing' THEN
      RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_CLOSING','session',to_jsonb(v_session));
    END IF;
    IF v_session.service_kind IS DISTINCT FROM p_service_kind THEN
      -- Lunch still open at the dinner boundary is the one boundary that must
      -- interrupt the operator: opening dinner over it would split one service's
      -- takings across two sessions.
      RETURN jsonb_build_object(
        'ok',false,
        'code', CASE WHEN v_session.service_kind='PRANZO'
                     THEN 'LUNCH_SESSION_STILL_ACTIVE'
                     ELSE 'OTHER_SERVICE_STILL_ACTIVE' END,
        'session',to_jsonb(v_session));
    END IF;
    RETURN jsonb_build_object('ok',true,'code','REUSED','created',false,'session',to_jsonb(v_session));
  END IF;

  v_madrid := (clock_timestamp() AT TIME ZONE 'Europe/Madrid');
  v_business_date := CASE WHEN v_madrid::time < TIME '04:00'
                          THEN (v_madrid::date - 1) ELSE v_madrid::date END;

  IF EXISTS (SELECT 1 FROM public.service_sessions
             WHERE business_date=v_business_date AND service_kind=p_service_kind) THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_ALREADY_COMPLETED_TODAY',
                              'businessDate',v_business_date,'serviceKind',p_service_kind);
  END IF;

  INSERT INTO public.service_sessions(business_date,status,opened_by,open_source,service_kind)
  VALUES (v_business_date,'open',p_opened_by,COALESCE(p_source,'auto_entry'),p_service_kind)
  RETURNING * INTO v_session;

  UPDATE public.service_session_state
     SET current_session_id=v_session.id, updated_at=now()
   WHERE singleton=true;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
  VALUES (v_session.id,'opened',p_opened_by,COALESCE(p_source,'auto_entry'));

  RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,'session',to_jsonb(v_session));
END $function$;

-- The kind-less opener is retired: it could only ever create a session that
-- violates service_sessions_active_kind_chk. It is kept as a fail-closed stub so
-- any stale backend instance fails loudly here instead of writing a session with
-- no service identity.
CREATE OR REPLACE FUNCTION public.open_service_session(p_opened_by text, p_source text DEFAULT 'backend')
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  RETURN jsonb_build_object('ok',false,'code','SERVICE_KIND_REQUIRED');
END $function$;

REVOKE ALL ON FUNCTION public.ensure_service_session(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_service_session(text,text,text) TO service_role;

COMMIT;
