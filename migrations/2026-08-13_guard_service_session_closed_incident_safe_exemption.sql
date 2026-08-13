-- SERVICE LIFECYCLE RUNTIME AUTHORITY — NATURAL ROLLOVER FINAL PROOF.
--
-- ROOT CAUSE (proven live on staging, 2026-08-13, against the real current
-- 2026-08-12 SERA session 84d9e4f4-7604-4aa4-bde7-b9c8bca81891): the
-- preserveActiveOrders fix (commit 4a439b5) correctly stops the close engine
-- from archiving/deleting a residual non-terminal order — but a SEPARATE,
-- independent guard, guard_service_session_closed_v1 (trigger
-- service_sessions_closed_live_work_guard), unconditionally re-checks for
-- non-terminal orders on every transition to status='closed' and raises
-- SERVICE_ACTIVE_ORDERS_NOT_RESOLVED regardless. That guard already has an
-- exemption clause, but it checks a marker
-- (ladieci.v3_close_authorized_session_id) that only close_service_session_v3
-- ever sets — and close_service_session_v3/serviceLifecycleEngine.js is
-- never require()'d by index.js or anything reachable from it (confirmed by
-- repo-wide grep): the exemption is orphaned, dormant, unreachable from the
-- real runtime. A prior session (P0-C2, 2026-08-10) already hit this same
-- wall building the economic-boundary rollover and worked around it with an
-- entirely separate mechanism (roll_service_session_economic_v1, which
-- avoids status='closed' altogether) rather than touch this guard — see
-- economicBoundaryEngine.js's own header. The practical effect: the close
-- engine's one live automatic caller (incidentSafeRollover.js) can never
-- actually reach status='closed' while preserveActiveOrders leaves a real
-- order behind — proven live: session 84d9e4f4 is stuck in status='closing'
-- right now, order #369 fully intact and untouched (not archived, not
-- deleted, not force-terminalized — that part of the fix is correct), but
-- the close itself cannot finish.
--
-- FIX (purely additive, two functions, one new marker):
--
-- 1. complete_service_session_close gains a new DEFAULT-false parameter,
--    p_preserve_active_orders. When true (and ONLY then), it sets a new,
--    REACHABLE transaction-local marker
--    (ladieci.incident_safe_close_session_id = the session id) before its
--    UPDATE — mirroring the exact set_config pattern close_service_session_v3
--    already established, just wired to the function actually on the live
--    path. Every other call (default false) behaves byte-for-byte as before:
--    no marker set, guard fully strict, unchanged.
--
-- 2. guard_service_session_closed_v1 gains one additional, narrowly-scoped
--    exemption condition, ADDITIVE to its existing checks (nothing removed,
--    nothing weakened for any caller that doesn't set the new marker):
--      - table check: an open table_session is tolerated when the new
--        marker matches this session — same unconditional-for-tables
--        semantics allowOpenTablesAcrossBoundary already has at the JS
--        layer (this codebase's own established product contract: an
--        occupied table crossing a boundary is normal carryover, not an
--        anomaly — see economicBoundaryEngine.js) — this migration is what
--        finally makes that JS-level flag's contract actually reachable at
--        the DB layer too, fixing the identical latent gap
--        allowOpenTablesAcrossBoundary always had, not just
--        preserveActiveOrders's.
--      - order check: a non-terminal order is tolerated ONLY when the new
--        marker matches this session AND that EXACT order already has its
--        own service_incidents row (order_id match) — enforced per-order,
--        not as a blanket session-level bypass. If preserveActiveOrders is
--        set but even one residual order lacks its own incident record
--        (classification never ran, or ran incompletely), the guard still
--        raises SERVICE_ACTIVE_ORDERS_NOT_RESOLVED. This is the DB-level
--        proof that "canonical and incident-backed" is real, not merely
--        asserted by the caller.
--
-- Only the automatic incident-safe rollover (incidentSafeRollover.js) ever
-- sets preserveActiveOrders=true on the close engine, so only that call site
-- will ever cause the new marker to be set. The manual force-close HTTP
-- action and the frozen legacy automatic path never pass it — the guard
-- remains exactly as strict for both as it was before this migration.
--
-- complete_service_session_close's own signature widens (3 args -> 4), and
-- Postgres identifies function overloads by ALL parameter types regardless
-- of defaults -- CREATE OR REPLACE alone would create a SECOND overload
-- alongside the original 3-arg one rather than truly replace it (proven
-- live: this exact mistake was made and caught during this migration's own
-- first apply attempt, confirmed via pg_proc showing both signatures
-- simultaneously). This codebase's own established discipline for a
-- widened signature (see row 61 in MIGRATION_MANIFEST.md) is to DROP the
-- old signature explicitly first. serviceSessionLifecycle.js is the ONLY
-- real caller (confirmed by repo-wide grep) and always sends all 4 named
-- params, so the old 3-arg overload is safe to drop.
--
-- guard_service_session_closed_v1 keeps its original signature (no
-- parameters -- it is a trigger function), so CREATE OR REPLACE there is a
-- true, single-overload replace, no DROP needed.
--
-- Staging-only, no table/column added/dropped, no data touched. Paired
-- .ROLLBACK.sql drops the 4-arg overload and restores the original 3-arg
-- complete_service_session_close plus guard_service_session_closed_v1's
-- pre-fix body, verbatim.

DROP FUNCTION IF EXISTS public.complete_service_session_close(uuid, text, text);

CREATE FUNCTION public.complete_service_session_close(
  p_session_id uuid,
  p_closed_by text,
  p_source text DEFAULT 'backend'::text,
  p_preserve_active_orders boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_state public.service_session_state%ROWTYPE; v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  SELECT * INTO v_session FROM public.service_sessions WHERE id=p_session_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','SESSION_NOT_FOUND'); END IF;
  IF v_session.status='closed' AND v_state.recent_closed_session_id=v_session.id AND v_state.current_session_id IS NULL THEN
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  IF v_state.current_session_id IS DISTINCT FROM v_session.id OR v_session.status <> 'closing' THEN
    RETURN jsonb_build_object('ok',false,'code','SESSION_CLOSE_IDENTITY_MISMATCH');
  END IF;
  -- Marker only ever set here, only when the caller explicitly asked for the
  -- incident-safe exemption. Never persisted beyond this transaction.
  IF p_preserve_active_orders THEN
    PERFORM set_config('ladieci.incident_safe_close_session_id', v_session.id::text, true);
  END IF;
  UPDATE public.service_sessions SET status='closed',closed_at=now(),closed_by=p_closed_by,close_source=p_source,updated_at=now() WHERE id=v_session.id RETURNING * INTO v_session;
  UPDATE public.service_session_state SET current_session_id=NULL,recent_closed_session_id=v_session.id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source) VALUES(v_session.id,'closed',p_closed_by,p_source);
  RETURN jsonb_build_object('ok',true,'code','CLOSED','session',to_jsonb(v_session));
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- COALESCE forces a clean boolean (never NULL): current_setting(...,true)
  -- returns NULL when the marker was never set in this transaction (every
  -- caller except the one incident-safe close site), and NULL propagating
  -- into the OR/NOT below would silently skip the checks entirely for
  -- EVERY caller, not just fail to grant the new exemption. Proven against
  -- the pre-existing v3 clause first: that one is safe today only because
  -- it is AND-ed with service_closeouts EXISTS(), which is always false on
  -- the real (V2) runtime path (V3's own tables are never populated by it)
  -- -- a coincidence this new marker cannot rely on, since it is OR-ed, not
  -- AND-ed, into the table check below.
  v_incident_safe boolean;
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    v_incident_safe := COALESCE(current_setting('ladieci.incident_safe_close_session_id', true), '') = OLD.id::text;

    -- SLICE 3.2.1 EXEMPTION (unchanged, kept verbatim) + the new, actually-
    -- reachable incident-safe exemption (additive OR, nothing removed).
    IF NOT (
      (
        current_setting('ladieci.v3_close_authorized_session_id', true) = OLD.id::text
        AND EXISTS (
          SELECT 1 FROM public.service_closeouts c WHERE c.service_session_id = OLD.id
        )
      )
      OR v_incident_safe
    ) THEN
      IF EXISTS (
        SELECT 1
        FROM public.table_sessions t
        WHERE t.service_session_id = OLD.id
          AND t.status = 'open'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'MESA_TABLES_NOT_RELEASED';
      END IF;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.ordenes o
      WHERE o.service_session_id = OLD.id
        AND (
          o.estado IS NULL
          OR o.estado NOT IN (
            'RETIRADO', 'COMPLETADO', 'COMPLETATO', -- language-guard: allow-legacy COMPLETATO/CHIUSO_FORZATO here and below are the pre-existing terminal-estado literals this guard already enumerated, unchanged by this migration, not new vocabulary
            'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO'
          )
        )
        AND NOT (
          v_incident_safe
          AND EXISTS (
            SELECT 1 FROM public.service_incidents si
            WHERE si.service_session_id = OLD.id
              AND si.order_id = o.id::text
          )
        )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'SERVICE_ACTIVE_ORDERS_NOT_RESOLVED';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;
