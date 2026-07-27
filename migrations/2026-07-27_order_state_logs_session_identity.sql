-- migrations/2026-07-27_order_state_logs_session_identity.sql
-- S2-7D6E — session-scoped identity for order state logs.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- Additive + idempotent. DRAFT — NOT APPLIED.
--
-- WHY. orden_estado_logs links history only by `orden_id`, a DERIVED text id ("#723"):
-- agentOrdini.js computes it as max(digits) over the rows currently in `ordenes`, and the
-- close path (servizio.js) deletes those rows after archiving them into `storico`. The log
-- is never swept and has no FK, so ids are recycled and unrelated orders accumulate under
-- one orden_id. Live staging evidence: orden_id '#723' holds SIX `created` events — five
-- from 2026-07-23 belonging to since-deleted orders, plus the 2026-07-26 QA order. Adding
-- the session turns (service_session_id, orden_id) into an identity a close cannot recycle.
--
-- NO BACKFILL. Legacy rows keep service_session_id NULL. Inferring a session from
-- created_at would fabricate provenance for exactly the rows whose provenance is already
-- lost — the merged '#723' cluster. NULL is the honest, queryable answer.
BEGIN;

-- Staging-positive guard (same sentinel as B0/B2/B5/B6A/S2-7D/S2-7D2).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'S2-7D6E refused: staging sentinel migration absent — wrong database?'; END IF;
END $$;

-- Required predecessor: the service-session identity objects must already exist.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='service_session_state')
  THEN RAISE EXCEPTION 'S2-7D6E refused: service_session_state absent — apply the service-session identity migration first'; END IF;
END $$;

-- ── 1) additive, nullable column (legacy rows stay valid and readable) ───────
ALTER TABLE public.orden_estado_logs
  ADD COLUMN IF NOT EXISTS service_session_id uuid
    REFERENCES public.service_sessions(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.orden_estado_logs.service_session_id IS
  'Service session owning this log row. NULL = legacy row written before S2-7D6E; NULL is never backfilled by inference. Assigned on INSERT by orden_estado_logs_assign_service_session when a session is open.';

-- ── 2) indexes ──────────────────────────────────────────────────────────────
-- Primary read path: one order''s history inside one service.
CREATE INDEX IF NOT EXISTS orden_estado_logs_session_order_created_idx
  ON public.orden_estado_logs (service_session_id, orden_id, created_at)
  WHERE service_session_id IS NOT NULL;

-- Whole-session timeline (closeout / audit).
CREATE INDEX IF NOT EXISTS orden_estado_logs_session_created_idx
  ON public.orden_estado_logs (service_session_id, created_at)
  WHERE service_session_id IS NOT NULL;

-- idx_orden_estado_logs_orden_id is intentionally KEPT: legacy NULL-session reads and the
-- existing ops cleanup SQL still filter on orden_id alone.

-- ── 3) soft assignment trigger ──────────────────────────────────────────────
-- Deliberately NOT modelled on service_session_assign_order(), which RAISES when no session
-- is open. State logging is best-effort by contract (orderStateLogger.js swallows insert
-- failures), and logs legitimately fire outside an open session (cancellations, catch-up,
-- close-adjacent writes). A raising trigger would silently drop those rows and turn a
-- logging miss into a blocked state transition. Forgery is still refused: a caller may not
-- name a session other than the currently open one.
CREATE OR REPLACE FUNCTION public.orden_estado_logs_assign_service_session()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_current uuid;
BEGIN
  SELECT s.id INTO v_current
    FROM public.service_session_state st
    JOIN public.service_sessions s ON s.id = st.current_session_id
   WHERE st.singleton = true AND s.status = 'open';

  IF NEW.service_session_id IS NOT NULL THEN
    IF v_current IS NOT NULL AND NEW.service_session_id <> v_current THEN
      RAISE EXCEPTION 'SERVICE_SESSION_FORGERY' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;                          -- explicit and consistent with the open session
  END IF;

  NEW.service_session_id := v_current;   -- NULL when no session is open: allowed
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS orden_estado_logs_assign_service_session ON public.orden_estado_logs;
CREATE TRIGGER orden_estado_logs_assign_service_session
  BEFORE INSERT ON public.orden_estado_logs
  FOR EACH ROW EXECUTE FUNCTION public.orden_estado_logs_assign_service_session();

COMMIT;
