-- migrations/2026-08-27_mesa_close_over_collected_ack_migration_119.ROLLBACK.sql
-- Reverses 2026-08-27_mesa_close_over_collected_ack_migration_119.sql.
--
-- Drops the ledger-119 5-arg mesa_close_session_v1 and restores the pre-119 4-arg
-- writer BYTE-FOR-BYTE (md5 c79312cd83db07cb0375f0cc5354d4f8, captured live from
-- pg_proc.prosrc on 2026-08-27). After this, an over-collected table closes SILENTLY
-- again, exactly as it did under ledger 118.
--
-- PARTIAL BY NATURE, and honest about it: any OVER_COLLECTED_AT_CLOSE rows that a
-- ledger-119 acknowledged close already wrote into public.service_incidents are REAL
-- financial facts in an append-only, no-delete table. This rollback does NOT and CANNOT
-- remove them. They stay queryable with resolution_status='pending' on their (now
-- closed) table sessions and are harmless -- a later Refund V1 or a manual incident
-- resolution reconciles them. A NOTICE below names how many exist.

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_close_session_v1'
        AND pg_get_function_identity_arguments(p.oid) =
            'p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean, p_confirm_over_collected boolean')
  THEN RAISE EXCEPTION 'MESA_119 rollback: the ledger-119 5-arg mesa_close_session_v1 is not present -- nothing to roll back'; END IF;

  RAISE NOTICE 'MESA_119 rollback: % OVER_COLLECTED_AT_CLOSE incident row(s) already recorded and RETAINED (append-only, not removable by rollback)',
    (SELECT count(*) FROM public.service_incidents WHERE incident_type = 'OVER_COLLECTED_AT_CLOSE');
END $guard$;

DROP FUNCTION IF EXISTS public.mesa_close_session_v1(uuid, text, uuid, boolean, boolean);

CREATE FUNCTION public.mesa_close_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_session_id uuid,
  p_force boolean DEFAULT false
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
  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'  -- language-guard: allow-legacy COMPLETATO / CHIUSO_FORZATO are the pre-existing OPERATIONAL terminal-state literals of the pre-119 mesa_close_session_v1 body, restored verbatim, not new vocabulary
       ))
  ) THEN
    IF NOT p_force THEN RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000'; END IF;
    WITH orphaned AS (
      SELECT o.id, o.estado AS current_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO'  -- language-guard: allow-legacy COMPLETATO / CHIUSO_FORZATO are the same pre-existing OPERATIONAL terminal-state literals, restored verbatim for the same reason
         ))
       FOR UPDATE OF o
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs(
        orden_id, numero_ordine, estado_from, estado_to, event_type,  -- language-guard: allow-legacy numero_ordine is the existing orden_estado_logs column name in the pre-119 body, restored verbatim, not new vocabulary
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
  UPDATE public.table_sessions SET
    status = 'closed', settled_at = v_now, closed_at = v_now,
    updated_at = v_now, updated_by = p_by_actor
  WHERE id = v_session.id;
  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_session.table_id, 'status', 'closed',
    'forced', v_forced_count > 0, 'forcedOrderCount', v_forced_count,
    'obligation', v_total_cents / 100.0, 'netCollected', v_paid_cents / 100.0,
    'unpaid', v_unpaid_cents / 100.0, 'overCollected', v_over_cents / 100.0
  );
END
$fn$;

-- Restore the exact pre-119 privilege posture: postgres + service_role only.
REVOKE ALL ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean) TO service_role;

DO $post$
DECLARE
  v_md5 text;
BEGIN
  -- The 5-arg overload is gone; exactly one mesa_close_session_v1 remains.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_close_session_v1'
        AND pg_get_function_identity_arguments(p.oid) ~ 'p_confirm_over_collected')
  THEN RAISE EXCEPTION 'MESA_119 rollback post-condition failed: the 5-arg overload survived'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='mesa_close_session_v1') <> 1
  THEN RAISE EXCEPTION 'MESA_119 rollback post-condition failed: expected exactly one mesa_close_session_v1 overload'; END IF;

  -- The restored body is BYTE-IDENTICAL to the pre-119 ledger-118 body (md5 captured
  -- live from pg_proc.prosrc, which is comment-free -- language-guard tails are
  -- normalised out here so the pin holds whether or not they were applied).
  SELECT md5(regexp_replace(prosrc, '[ \t]*--[ \t]*language-guard:[^\n]*', '', 'g')) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_close_session_v1';
  IF v_md5 IS DISTINCT FROM 'c79312cd83db07cb0375f0cc5354d4f8' THEN
    RAISE EXCEPTION 'MESA_119 rollback post-condition failed: restored body md5 mismatch (got %, expected c79312cd83db07cb0375f0cc5354d4f8)', v_md5;
  END IF;

  -- Privileges back to pre-119.
  IF has_function_privilege('anon', 'public.mesa_close_session_v1(uuid,text,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mesa_close_session_v1(uuid,text,uuid,boolean)', 'EXECUTE')
  THEN RAISE EXCEPTION 'MESA_119 rollback post-condition failed: a browser role holds EXECUTE on the restored function'; END IF;
  IF NOT has_function_privilege('service_role', 'public.mesa_close_session_v1(uuid,text,uuid,boolean)', 'EXECUTE')
  THEN RAISE EXCEPTION 'MESA_119 rollback post-condition failed: service_role cannot execute the restored function'; END IF;
END $post$;

COMMIT;
