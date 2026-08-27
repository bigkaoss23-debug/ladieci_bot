-- migrations/2026-08-27_mesa_close_over_collected_ack_migration_119.sql
-- OVER-COLLECTED ACKNOWLEDGEMENT AT MESA CLOSE -- backend authority for Ajuste
-- Comercial Frontend Slice C's "Cerrar igualmente" flow.
--
-- Contract: OVER_COLLECTED_AJUSTE_FRONTEND_BACKEND_PREREQUISITES brief (2026-08-27),
-- PREREQUISITE B. Companion of the ledger-118 Ajuste Comercial V1 slice and the
-- ledger-117 Refund V1 slice; those semantics are FROZEN and this migration does not
-- reopen any of them.
--
-- THE GAP THIS CLOSES, IN ONE LINE: mesa_close_session_v1 already DERIVES v_over_cents
-- (ledger 118) and returns it, but never GATES on it -- an over-collected table closes
-- SILENTLY, with no operator decision and no recorded exposure. The frontend added a
-- client-only "Cerrar igualmente" (local commit bba3a31, NOT deployed) which is not
-- authoritative. This migration adds the real backend authority:
--
--   * a new explicit boolean parameter  p_confirm_over_collected  (default false).
--   * first close of an over-collected table with NO acknowledgement now RAISES
--     MESA_CLOSE_OVER_COLLECTED (SQLSTATE 55000, DETAIL 'overCollected=<amount>').
--   * an explicitly acknowledged close is allowed, and records an
--     OVER_COLLECTED_AT_CLOSE financial incident via the EXISTING create_service_incident
--     RPC, in the SAME transaction as the close. No payment, refund, allocation or
--     obligation revision is created -- money stays truthful (brief SS27).
--
-- WHAT IS DELIBERATELY UNCHANGED:
--   * The unpaid-balance block (MESA_TABLE_NOT_SETTLED) still fires FIRST and is never
--     bypassed by p_confirm_over_collected. unpaid and overCollected are mutually
--     exclusive by construction (GREATEST(0, total-paid) vs GREATEST(0, paid-total)),
--     so acknowledging over-collection can never mask an unpaid balance.
--   * The p_force kitchen/order-completeness override is untouched and independent.
--   * MESA_SESSION_NOT_OPEN on a retry after a committed close is preserved verbatim --
--     that is what makes the acknowledged-close path idempotent (a second acknowledged
--     request never reaches the incident write), reinforced by create_service_incident's
--     own ON CONFLICT DO NOTHING dedupe on
--     (closeout_correlation_id, incident_type, entity_type, entity_id).
--   * order_canonical_obligation_v1 as the obligation basis (ledger 118). estado has no
--     economic vote. The operational CHIUSO_FORZATO completeness check is byte-identical.  -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing OPERATIONAL terminal-state literal mesa_close_session_v1 already checks, restated because CREATE requires the full body, not new vocabulary
--   * Refund V1 (mesa_post_refund_v1), Ajuste Comercial V1
--     (mesa_post_commercial_adjustment_v1 / order_cancel_v1 / the shared primitive),
--     mesa_post_payment_v1, create_service_incident -- each md5-asserted untouched below.
--
-- SIGNATURE CHANGE => THIS IS A DROP + CREATE, NOT A CREATE OR REPLACE. Adding a
-- parameter creates a NEW overload and leaves the 4-arg mesa_close_session_v1
-- CALLABLE -- a silent bypass of the whole acknowledgement. The pre-119 4-arg function
-- is therefore DROPPED and the rollback restores it byte-for-byte
-- (md5 c79312cd83db07cb0375f0cc5354d4f8, captured live 2026-08-27).
--
-- ACL (brief SS19, the ledger-118 lesson): this Supabase project's pg_default_acl grants
-- EXECUTE on every freshly CREATEd public function to anon AND authenticated directly, so
-- REVOKE ... FROM PUBLIC alone is NOT enough. The REVOKE below names anon and
-- authenticated explicitly, and a post-condition proves neither holds EXECUTE.
--
-- INCIDENT ARCHITECTURE (brief SS20): no new incident table. service_incidents already
-- carries category='financial', financial_exposure_cents, and a pending/acknowledged/
-- resolved lifecycle; create_service_incident already derives business_date / service_kind
-- / lifecycle_semantics from the service_sessions row and already dedupes. The (category,
-- severity, blocking) triple for OVER_COLLECTED_AT_CLOSE is (financial, warning, false),
-- matching UNPAID_BALANCE_AT_CLOSE's own policy in src/serviceSessions/v3IncidentPolicy.js.
--
-- Live staging state at write time (verified against the runtime, not assumed): backend
-- 926ad0b, frontend 129a951, DB ledger 118. service_incidents / table_sessions untouched
-- by this migration -- post-conditions pin their row counts.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- 0. PRE-CONDITION GUARD -- refuse to run against anything but the exact
--    ledger-118 schema this migration was written against.
-- ══════════════════════════════════════════════════════════════════════════
DO $guard$
DECLARE
  v_args text;
  v_md5  text;
BEGIN
  -- The 4-arg close writer must be present with EXACTLY its ledger-118 identity args.
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_close_session_v1'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean';
  IF v_args IS NULL THEN
    RAISE EXCEPTION 'MESA_119 guard: pre-119 mesa_close_session_v1(uuid,text,uuid,boolean) not found';
  END IF;

  -- ...and its body must be the exact ledger-118 body. Refuse on any drift.
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_close_session_v1'
     AND pg_get_function_identity_arguments(p.oid) =
         'p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean';
  IF v_md5 IS DISTINCT FROM 'c79312cd83db07cb0375f0cc5354d4f8' THEN
    RAISE EXCEPTION 'MESA_119 guard: pre-119 mesa_close_session_v1 body md5 mismatch (got %, expected c79312cd83db07cb0375f0cc5354d4f8)', v_md5;
  END IF;

  -- Not already applied.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'mesa_close_session_v1'
                AND pg_get_function_identity_arguments(p.oid) ~ 'p_confirm_over_collected') THEN
    RAISE EXCEPTION 'MESA_119 guard: already applied (5-arg mesa_close_session_v1 exists)';
  END IF;

  -- The incident machinery this migration composes with.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'create_service_incident'
                    AND pg_get_function_identity_arguments(p.oid) LIKE
                        'p_service_session_id uuid, p_closeout_correlation_id uuid, p_incident_type text, p_category text, p_severity text, p_detected_by text%') THEN
    RAISE EXCEPTION 'MESA_119 guard: create_service_incident missing or unexpected signature';
  END IF;
  IF to_regclass('public.service_incidents') IS NULL THEN
    RAISE EXCEPTION 'MESA_119 guard: service_incidents table missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='service_incidents'
                    AND column_name='financial_exposure_cents') THEN
    RAISE EXCEPTION 'MESA_119 guard: service_incidents.financial_exposure_cents missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
                  AND tablename='service_incidents' AND indexname='service_incidents_dedupe_uq') THEN
    RAISE EXCEPTION 'MESA_119 guard: service_incidents_dedupe_uq missing (incident idempotency depends on it)';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.service_incidents'::regclass
        AND NOT tgisinternal AND tgname IN ('service_incidents_facts_immutable','service_incidents_no_delete')) <> 2 THEN
    RAISE EXCEPTION 'MESA_119 guard: service_incidents append-only triggers missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_canonical_obligation_v1') THEN
    RAISE EXCEPTION 'MESA_119 guard: order_canonical_obligation_v1 (ledger 118) missing';
  END IF;

  -- Capture the bodies of every function this migration must NOT touch, for the
  -- post-condition block. Also capture the row counts nothing here may change.
  PERFORM set_config('ladieci.m119_incident_fn_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='create_service_incident'), true);
  PERFORM set_config('ladieci.m119_payment_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_post_payment_v1'), true);
  PERFORM set_config('ladieci.m119_refund_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1'), true);
  PERFORM set_config('ladieci.m119_adjustment_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_post_commercial_adjustment_v1'), true);
  PERFORM set_config('ladieci.m119_cancel_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_cancel_v1'), true);
  PERFORM set_config('ladieci.m119_incidents_count_before',
    (SELECT count(*)::text FROM public.service_incidents), true);
  PERFORM set_config('ladieci.m119_closed_sessions_before',
    (SELECT count(*)::text FROM public.table_sessions WHERE status = 'closed'), true);
  PERFORM set_config('ladieci.m119_auth_audit_before',
    (SELECT count(*)::text FROM public.auth_audit), true);
END $guard$;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. Drop the pre-119 4-arg overload. A parameter addition would otherwise leave
--    it callable -- a silent bypass of the acknowledgement. The rollback restores
--    it verbatim (md5-pinned).
-- ══════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS public.mesa_close_session_v1(uuid, text, uuid, boolean);

-- ══════════════════════════════════════════════════════════════════════════
-- 2. The close writer, ledger-119. Body is the exact ledger-118 body plus three
--    additive blocks:
--      a. DECLARE  v_incident jsonb;
--      b. after the unpaid gate: RAISE MESA_CLOSE_OVER_COLLECTED unless acknowledged.
--      c. after the p_force block and BEFORE the table_sessions UPDATE: record the
--         OVER_COLLECTED_AT_CLOSE incident, in this same transaction, and RAISE
--         MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED if it cannot be recorded (fail closed:
--         an acknowledged close that leaves no exposure record must not commit).
--    The RETURN gains overCollectedAcknowledged + incidentId. Nothing else changes:
--    no comment is added inside the body (the applied prosrc is comment-free, exactly
--    like the pre-119 body), so md5(prosrc) is deterministic and pinned below.
-- ══════════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.mesa_close_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_session_id uuid,
  p_force boolean DEFAULT false,
  p_confirm_over_collected boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE; v_session public.table_sessions%ROWTYPE;
  v_total_cents bigint; v_paid_cents bigint; v_unpaid_cents bigint; v_over_cents bigint;
  v_now timestamptz := now(); v_forced_count integer := 0;
  v_incident jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
  THEN RAISE EXCEPTION 'MESA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'MESA_CLOSE_FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  SELECT COALESCE(round(sum(
      CASE WHEN EXISTS (SELECT 1 FROM public.order_obligations ob WHERE ob.order_uid = o.order_uid)
                OR EXISTS (SELECT 1 FROM public.table_order_lines l
                            WHERE l.table_session_id = v_session.id AND l.order_id = o.id)
           THEN public.order_canonical_obligation_v1(o.order_uid)
           ELSE 0::numeric END) * 100), 0)::bigint
    INTO v_total_cents
    FROM public.ordenes o
   WHERE o.table_session_id = v_session.id AND o.order_uid IS NOT NULL;
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_unpaid_cents := GREATEST(0, v_total_cents - v_paid_cents);
  v_over_cents   := GREATEST(0, v_paid_cents - v_total_cents);
  IF v_unpaid_cents > 0 THEN RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000'; END IF;
  IF v_over_cents > 0 AND NOT COALESCE(p_confirm_over_collected, false) THEN
    RAISE EXCEPTION 'MESA_CLOSE_OVER_COLLECTED' USING ERRCODE='55000',
      DETAIL = format('overCollected=%s', v_over_cents / 100.0);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'  -- language-guard: allow-legacy COMPLETATO / CHIUSO_FORZATO are the pre-existing OPERATIONAL terminal-state literals mesa_close_session_v1 already checks; CREATE needs the whole body, restated verbatim, not new vocabulary
       ))
  ) THEN
    IF NOT p_force THEN RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000'; END IF;
    WITH orphaned AS (
      SELECT o.id, o.estado AS current_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'  -- language-guard: allow-legacy COMPLETATO / CHIUSO_FORZATO are the same pre-existing OPERATIONAL terminal-state literals, restated verbatim for the same reason
         ))
       FOR UPDATE OF o
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs(
        orden_id, numero_ordine, estado_from, estado_to, event_type,  -- language-guard: allow-legacy numero_ordine is the existing orden_estado_logs column name; CREATE needs the whole body, restated verbatim, not new vocabulary
        actor_type, actor_id, origin, metadata
      )
      SELECT t.id, t.id, t.current_estado, COALESCE(t.current_estado, 'EN_COCINA'), 'table_closed_forced',
        'operator', p_by_actor, 'mesa_close_session_force',
        jsonb_build_object('table_session_id', v_session.id,
          'reason', 'operator_forced_close_with_pending_kitchen_work')
      FROM orphaned t
      RETURNING 1
    )
    SELECT count(*) INTO v_forced_count FROM logged;
  END IF;
  IF v_over_cents > 0 THEN
    v_incident := public.create_service_incident(
      p_service_session_id => v_session.service_session_id,
      p_closeout_correlation_id => md5('mesa_close_over_collected:' || v_session.id::text)::uuid,
      p_incident_type => 'OVER_COLLECTED_AT_CLOSE',
      p_category => 'financial',
      p_severity => 'warning',
      p_detected_by => p_by_actor,
      p_entity_type => 'table_session',
      p_entity_id => v_session.id::text,
      p_table_session_id => v_session.id,
      p_financial_exposure_cents => v_over_cents::integer);
    IF COALESCE((v_incident->>'ok')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED' USING ERRCODE='55000',
        DETAIL = format('create_service_incident=%s', COALESCE(v_incident->>'code', '<null>'));
    END IF;
  END IF;
  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_session.id;
  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_session.table_id, 'status', 'closed',
    'forced', v_forced_count > 0, 'forcedOrderCount', v_forced_count,
    'obligation', v_total_cents / 100.0, 'netCollected', v_paid_cents / 100.0,
    'unpaid', v_unpaid_cents / 100.0, 'overCollected', v_over_cents / 100.0,
    'overCollectedAcknowledged', (v_over_cents > 0 AND COALESCE(p_confirm_over_collected, false)),
    'incidentId', CASE WHEN v_over_cents > 0 THEN v_incident->'incident'->>'id' ELSE NULL END
  );
END
$fn$;

COMMENT ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean, boolean) IS
  'Ledger 119. Closes an OCCUPIED Mesa table session. p_force overrides only the '
  'kitchen/order-completeness check. The unpaid-balance block (MESA_TABLE_NOT_SETTLED) is '
  'absolute. p_confirm_over_collected is the operator''s explicit acknowledgement that the '
  'table collected more than it owes: without it an over-collected table RAISEs '
  'MESA_CLOSE_OVER_COLLECTED; with it the close is allowed and an OVER_COLLECTED_AT_CLOSE '
  'financial incident is recorded in the same transaction. No payment/refund/adjustment is '
  'ever created here.';

-- ══════════════════════════════════════════════════════════════════════════
-- 3. PRIVILEGES -- fail closed. A fresh CREATE re-triggers this project's default ACL
--    (anon + authenticated get EXECUTE directly), so REVOKE names them explicitly.
-- ══════════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean, boolean) TO service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 4. STRUCTURAL POST-CONDITIONS -- inside this same transaction. Any failure rolls
--    the whole migration back with zero residue.
-- ══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_src text;
  v_lit text;
  v_unpaid_pos int;
  v_over_pos int;
BEGIN
  -- ── the 5-arg writer exists with the exact identity args ──
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_close_session_v1'
        AND pg_get_function_identity_arguments(p.oid) =
            'p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean, p_confirm_over_collected boolean')
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: 5-arg mesa_close_session_v1 signature wrong or missing'; END IF;

  -- ── the pre-119 4-arg overload is GONE (no silent bypass) ──
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_close_session_v1'
        AND pg_get_function_identity_arguments(p.oid) =
            'p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean')
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: the 4-arg mesa_close_session_v1 overload still exists'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='mesa_close_session_v1') <> 1
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: expected exactly one mesa_close_session_v1 overload'; END IF;

  -- ── the applied body is EXACTLY what this file installs (transcription drift = abort).
  --    language-guard comment tails are normalised out first, so the pin holds whether
  --    the migration was applied with or without those linter comments -- the same
  --    stripGuard discipline ajusteComercialV1.test.js already uses for its rollback md5s. ──
  SELECT regexp_replace(prosrc, '[ \t]*--[ \t]*language-guard:[^\n]*', '', 'g') INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_close_session_v1';
  IF md5(v_src) IS DISTINCT FROM '1e4525aa3fc4e571f7df1acb3a6a59d4' THEN
    RAISE EXCEPTION 'MESA_119 post-condition failed: mesa_close_session_v1 body md5 (language-guard-stripped) mismatch (got %, expected 1e4525aa3fc4e571f7df1acb3a6a59d4)', md5(v_src);
  END IF;

  -- ── readable markers (redundant with the md5 pin, but name the failure) ──
  FOREACH v_lit IN ARRAY ARRAY[
    'p_confirm_over_collected', 'MESA_CLOSE_OVER_COLLECTED', 'OVER_COLLECTED_AT_CLOSE',
    'create_service_incident', 'MESA_CLOSE_INCIDENT_PERSISTENCE_FAILED',
    'MESA_TABLE_NOT_SETTLED', 'order_canonical_obligation_v1', 'MESA_TABLE_HAS_ACTIVE_ORDERS',
    'CHIUSO_FORZATO', 'overCollectedAcknowledged'  -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing OPERATIONAL terminal-state literal the close body already checks, asserted here as evidence it SURVIVED, not new vocabulary
  ] LOOP
    IF position(v_lit IN v_src) = 0 THEN
      RAISE EXCEPTION 'MESA_119 post-condition failed: close body lost marker %', v_lit;
    END IF;
  END LOOP;

  -- ── the unpaid gate still fires BEFORE the over-collected gate ──
  v_unpaid_pos := position('MESA_TABLE_NOT_SETTLED' IN v_src);
  v_over_pos   := position('MESA_CLOSE_OVER_COLLECTED' IN v_src);
  IF v_unpaid_pos = 0 OR v_over_pos = 0 OR v_unpaid_pos >= v_over_pos THEN
    RAISE EXCEPTION 'MESA_119 post-condition failed: unpaid gate must precede the over-collected gate';
  END IF;
  -- ── ...and the unpaid gate itself is the unconditional one-liner, NOT relaxed by the
  --    acknowledgement (asserting the exact statement, not a slice that would also span
  --    the over-collected gate's own p_confirm_over_collected condition) ──
  IF position(
    'IF v_unpaid_cents > 0 THEN RAISE EXCEPTION ' || chr(39) || 'MESA_TABLE_NOT_SETTLED' || chr(39)
    || ' USING ERRCODE=' || chr(39) || '55000' || chr(39) || '; END IF;' IN v_src) = 0
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: the unpaid gate is not the unconditional pre-119 statement'; END IF;

  -- ── SS27 -- the close writer creates NO money and NO obligation revision, for any tender ──
  IF v_src ~ 'INSERT INTO public\.payment_transactions' OR v_src ~ 'INSERT INTO public\.payment_allocations'
     OR v_src ~ 'INSERT INTO public\.order_financial_events' OR v_src ~ 'INSERT INTO public\.order_obligations'
     OR v_src ~ 'mesa_post_refund_v1' OR v_src ~ 'mesa_post_commercial_adjustment_v1'
     OR v_src ~ 'order_cancel_v1' OR v_src ~ 'order_obligation_apply_adjustment_v1'
     OR v_src ~ 'reverses_transaction_id'
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: close writer fabricates money or an obligation revision'; END IF;

  -- ── privileges: anon/authenticated cannot execute the new writer; service_role can ──
  IF has_function_privilege('anon', 'public.mesa_close_session_v1(uuid,text,uuid,boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mesa_close_session_v1(uuid,text,uuid,boolean,boolean)', 'EXECUTE')
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: a browser role holds EXECUTE on mesa_close_session_v1'; END IF;
  IF NOT has_function_privilege('service_role', 'public.mesa_close_session_v1(uuid,text,uuid,boolean,boolean)', 'EXECUTE')
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: service_role cannot execute mesa_close_session_v1'; END IF;

  -- ── things that MUST NOT have changed (md5-pinned from the guard block) ──
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='create_service_incident';
  IF v_src IS DISTINCT FROM current_setting('ladieci.m119_incident_fn_md5_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: create_service_incident was modified'; END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_payment_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.m119_payment_md5_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: mesa_post_payment_v1 was modified'; END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.m119_refund_md5_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: Refund V1 semantics were modified'; END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_commercial_adjustment_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.m119_adjustment_md5_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: mesa_post_commercial_adjustment_v1 was modified'; END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_cancel_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.m119_cancel_md5_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: order_cancel_v1 was modified'; END IF;

  -- ── service_incidents append-only guarantees intact ──
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.service_incidents'::regclass
        AND NOT tgisinternal AND tgname IN ('service_incidents_facts_immutable','service_incidents_no_delete')) <> 2
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: a service_incidents append-only trigger disappeared'; END IF;

  -- ── NO BACKFILL. This migration writes not one business row. ──
  IF (SELECT count(*)::text FROM public.service_incidents)
       IS DISTINCT FROM current_setting('ladieci.m119_incidents_count_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: service_incidents row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.table_sessions WHERE status = 'closed')
       IS DISTINCT FROM current_setting('ladieci.m119_closed_sessions_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: a table_session was closed by the migration'; END IF;
  IF (SELECT count(*)::text FROM public.auth_audit)
       IS DISTINCT FROM current_setting('ladieci.m119_auth_audit_before', true)
  THEN RAISE EXCEPTION 'MESA_119 post-condition failed: the migration emitted an auth_audit row'; END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-118:
-- registered as a separate statement at apply time -- apply_order 119, kind 'ddl',
-- checksum = this file's sha256, applied_by = the introducing commit (committed BEFORE
-- this migration is applied). The manifest (MIGRATION_MANIFEST.md, narrative row 121)
-- carries this file's own sha256(:16) for the git-history trail.

COMMIT;
