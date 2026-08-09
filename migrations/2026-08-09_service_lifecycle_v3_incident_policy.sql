-- migrations/2026-08-09_service_lifecycle_v3_incident_policy.sql
-- SERVICE LIFECYCLE V3 / SLICE 3.3 — incident/anomaly policy. STAGING ONLY,
-- additive CREATE OR REPLACE only (no new table, no destructive statement).
-- Builds on top of row 59 (close ownership hardening) — requires it applied
-- first — and does NOT modify close_service_session_v3 or
-- guard_service_session_closed_v1 at all (Slice 3.3 does not touch close
-- mechanics, only what happens to a non-hard anomaly before Phase D).
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────
-- service_closeouts (row 57) has always had five aggregate incident-fact
-- columns — kitchen_pending_count, listo_count, delivery_pending_count,
-- incident_count, critical_incident_count — with DEFAULT 0, specifically so
-- "a report doesn't need that join for the two numbers it needs most often"
-- (row 57's own comment). create_service_closeout (row 58) has never
-- accepted them as parameters — nothing before Slice 3.3 had anything
-- non-zero to report (Slice 3.2 was happy-path only: zero non-terminal
-- orders, zero unpaid exposure, by construction). Slice 3.3's engine
-- (src/serviceSessions/serviceLifecycleEngine.js) now classifies and
-- persists real incidents before Phase D, and needs a way to freeze their
-- aggregate counts onto the one authoritative closeout row alongside them.
--
-- p_unpaid_exposure_cents already existed and already accepted a non-zero
-- value (Slice 3.2's own JS caller was the only thing that ever hardcoded 0
-- for it) — no migration is needed for that field; only these five new
-- aggregate count parameters are added here.
--
-- PART 1 — create_service_closeout gets five new trailing parameters, all
--          DEFAULT 0 (matches every other operational-count parameter's own
--          convention — e.g. p_open_orders_at_close, p_occupied_tables_at_
--          close — no new PLPGSQL-level validation beyond what the table's
--          own five pre-existing CHECK constraints, unchanged, already
--          enforce: >= 0 on each, plus critical_incident_count <=
--          incident_count).
--
-- ── WHY THIS IS AN EXPLICIT DROP + CREATE, NOT A BARE CREATE OR REPLACE ────
-- PostgreSQL function identity is (name, input-parameter TYPE list) — never
-- names or defaults. Adding five trailing parameters, even DEFAULT-valued,
-- changes the type list, so `CREATE OR REPLACE FUNCTION` with the new
-- 23-parameter signature does NOT replace row 58's existing 18-parameter
-- function — it silently creates a SECOND, overloaded pg_proc row and
-- leaves the original fully intact and callable. Verified empirically
-- against staging (tdikhfeinufaahagmpjz) with a synthetic scratch function
-- inside BEGIN/ROLLBACK, same shape as this migration (N required params,
-- then a CREATE OR REPLACE adding trailing DEFAULT params): the probe left
-- TWO distinct pg_proc rows, and a call using the OLD parameter count/names
-- (positional OR named — PostgREST's RPC call shape) then failed with
-- `42725: function ... is not unique — Could not choose a best candidate
-- function`, because both overloads accept that same call shape (the new
-- one via its trailing defaults). That is a hard outage for EVERY caller,
-- old or new, the moment this landed — exactly the ambiguous/non-
-- deterministic PostgREST RPC surface this migration must not create.
-- The fix, also verified empirically the same way: explicitly DROP the
-- existing 18-parameter signature (proven present, exact-body-matched, by
-- the predecessor-body guard immediately above) BEFORE creating the
-- 23-parameter one. That leaves exactly one pg_proc row, and every call
-- shape (18 positional args, 18 named args, or the full 23) resolves
-- unambiguously — the two probes below the DROP step confirmed both the
-- old 18-arg call shape (falling through to the new function's defaults)
-- and the new 23-arg call shape resolve correctly with a single overload.
-- The sole real caller in this codebase (src/closeout/
-- serviceCloseoutCreation.js, same commit) already always sends all 23
-- named parameters, so this DROP changes nothing observable for it; audited
-- via `grep -rn create_service_closeout src tests migrations` — no other
-- caller, in JS or SQL, exists anywhere in this repo.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'service lifecycle v3 incident policy refused: staging sentinel migration absent — wrong database?'; END IF;

  IF to_regprocedure('public.close_service_session_v3(uuid,uuid,text,text)') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 incident policy refused: row 58 (close engine) not applied — apply it first'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'close_service_session_v3'
       AND pg_get_functiondef(p.oid) LIKE '%v3_close_authorized_session_id%'
  ) THEN RAISE EXCEPTION 'service lifecycle v3 incident policy refused: row 59 (close ownership hardening) not applied — apply it first'; END IF;

  IF to_regprocedure('public.create_service_incident(uuid,uuid,text,text,text,text,text,text,text,uuid,text,text,integer,uuid,boolean,text,text)') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 incident policy refused: create_service_incident missing — apply 2026-08-08_service_closeout_incidents_foundation first'; END IF;

  IF to_regprocedure('public.mesa_release_empty_session_auto_v1(uuid,uuid)') IS NULL
  THEN RAISE EXCEPTION 'service lifecycle v3 incident policy refused: mesa_release_empty_session_auto_v1 missing — apply 2026-08-09_service_closeout_cross_service_table_policy first'; END IF;
END $$;

-- ── PREDECESSOR-BODY GUARD — refuse to apply over drift or a double-patch ──
DO $$
DECLARE v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_service_closeout'
     AND pg_get_function_identity_arguments(p.oid) = 'p_service_session_id uuid, p_closeout_correlation_id uuid, p_closed_by text, p_source text, p_close_reason text, p_gross_sales_cents integer, p_net_sales_cents integer, p_total_refunds_cents integer, p_total_void_cents integer, p_paid_amount_cents integer, p_unpaid_exposure_cents integer, p_order_count integer, p_cash_amount_cents integer, p_card_amount_cents integer, p_bizum_amount_cents integer, p_other_amount_cents integer, p_open_orders_at_close integer, p_occupied_tables_at_close integer';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'service lifecycle v3 incident policy refused: create_service_closeout body not found (18-parameter row-58 signature expected) — resolve drift first';
  END IF;
  IF v_body NOT LIKE '%p_occupied_tables_at_close, occupied_tables_at_close%' AND v_body NOT LIKE '%occupied_tables_at_close%' THEN
    RAISE EXCEPTION 'service lifecycle v3 incident policy refused: create_service_closeout does not match the expected row-58 body (occupied_tables_at_close not found) — resolve drift first';
  END IF;
  IF v_body LIKE '%p_kitchen_pending_count%' THEN
    RAISE EXCEPTION 'service lifecycle v3 incident policy refused: create_service_closeout already references p_kitchen_pending_count — already patched, resolve drift first';
  END IF;
END $$;

-- Proven present with this exact identity + body by the predecessor-body
-- guard immediately above — DROP first so CREATE below installs the ONLY
-- create_service_closeout overload, never a second one (see header).
DROP FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer
);

CREATE FUNCTION public.create_service_closeout(
  p_service_session_id       uuid,
  p_closeout_correlation_id  uuid,
  p_closed_by                text,
  p_source                   text,
  p_close_reason             text,
  p_gross_sales_cents        integer,
  p_net_sales_cents          integer,
  p_total_refunds_cents      integer,
  p_total_void_cents         integer,
  p_paid_amount_cents        integer,
  p_unpaid_exposure_cents    integer,
  p_order_count              integer,
  p_cash_amount_cents        integer,
  p_card_amount_cents        integer,
  p_bizum_amount_cents       integer,
  p_other_amount_cents       integer,
  p_open_orders_at_close     integer,
  p_occupied_tables_at_close integer,
  p_kitchen_pending_count    integer DEFAULT 0,
  p_listo_count              integer DEFAULT 0,
  p_delivery_pending_count   integer DEFAULT 0,
  p_incident_count           integer DEFAULT 0,
  p_critical_incident_count  integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.service_sessions%ROWTYPE;
  v_attempt public.service_closeout_attempts%ROWTYPE;
  v_row     public.service_closeouts%ROWTYPE;
BEGIN
  IF p_service_session_id IS NULL OR p_closeout_correlation_id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ARGUMENTS');
  END IF;
  IF p_closed_by IS NULL OR btrim(p_closed_by) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_ACTOR');
  END IF;
  IF p_source IS NULL OR btrim(p_source) = '' THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_SOURCE');
  END IF;
  IF p_gross_sales_cents IS NULL OR p_gross_sales_cents < 0
     OR p_net_sales_cents IS NULL OR p_net_sales_cents < 0
     OR p_paid_amount_cents IS NULL OR p_paid_amount_cents < 0
     OR p_unpaid_exposure_cents IS NULL OR p_unpaid_exposure_cents < 0
     OR p_order_count IS NULL OR p_order_count < 0
  THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_FINANCIAL_FIELDS');
  END IF;

  SELECT * INTO v_session FROM public.service_sessions WHERE id = p_service_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_NOT_FOUND');
  END IF;
  IF v_session.service_kind IS NULL THEN
    RETURN jsonb_build_object('ok',false,'code','SERVICE_SESSION_MISSING_KIND');
  END IF;

  SELECT * INTO v_attempt FROM public.service_closeout_attempts
   WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_FOUND');
  END IF;
  IF v_attempt.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_SESSION_MISMATCH');
  END IF;
  IF v_attempt.status <> 'active' THEN
    RETURN jsonb_build_object('ok',false,'code','ATTEMPT_NOT_ACTIVE');
  END IF;

  INSERT INTO public.service_closeouts(
    service_session_id, closeout_correlation_id, business_date, service_kind,
    opened_at, closed_at, close_source, close_reason, closed_by,
    gross_sales_cents, net_sales_cents, total_discounts_cents, total_refunds_cents, total_void_cents,
    paid_amount_cents, unpaid_exposure_cents, order_count,
    cash_amount_cents, card_amount_cents, bizum_amount_cents, other_amount_cents,
    open_orders_at_close, occupied_tables_at_close,
    kitchen_pending_count, listo_count, delivery_pending_count,
    incident_count, critical_incident_count
  ) VALUES (
    v_session.id, p_closeout_correlation_id, v_session.business_date, v_session.service_kind,
    v_session.opened_at, now(), p_source, p_close_reason, p_closed_by,
    p_gross_sales_cents, p_net_sales_cents, 0, COALESCE(p_total_refunds_cents, 0), COALESCE(p_total_void_cents, 0),
    p_paid_amount_cents, p_unpaid_exposure_cents, p_order_count,
    COALESCE(p_cash_amount_cents, 0), COALESCE(p_card_amount_cents, 0), COALESCE(p_bizum_amount_cents, 0), COALESCE(p_other_amount_cents, 0),
    COALESCE(p_open_orders_at_close, 0), COALESCE(p_occupied_tables_at_close, 0),
    COALESCE(p_kitchen_pending_count, 0), COALESCE(p_listo_count, 0), COALESCE(p_delivery_pending_count, 0),
    COALESCE(p_incident_count, 0), COALESCE(p_critical_incident_count, 0)
  )
  ON CONFLICT (closeout_correlation_id) DO NOTHING
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN jsonb_build_object('ok',true,'code','CREATED','created',true,'closeout',to_jsonb(v_row));
  END IF;

  SELECT * INTO v_row FROM public.service_closeouts WHERE closeout_correlation_id = p_closeout_correlation_id;
  IF v_row.service_session_id IS DISTINCT FROM p_service_session_id THEN
    RETURN jsonb_build_object('ok',false,'code','CLOSEOUT_CORRELATION_ID_CONFLICT');
  END IF;
  RETURN jsonb_build_object('ok',true,'code','ALREADY_EXISTS','created',false,'closeout',to_jsonb(v_row));
END;
$fn$;
-- DROP FUNCTION removes the function object and everything granted on it —
-- the row-58 grant does NOT carry over to this new signature (unlike a
-- same-signature CREATE OR REPLACE, e.g. row 59's, which does preserve
-- grants). Re-grant explicitly, identical service_role-only shape as row 58.
REVOKE ALL ON FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_closeout(
  uuid, uuid, text, text, text,
  integer, integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer, integer,
  integer, integer, integer, integer, integer
) TO service_role;

-- No new table, no other RLS/GRANT boilerplate — this migration is a single
-- DROP + CREATE of an existing, already-granted function, re-granted above.

COMMIT;
