-- migrations/2026-08-23_n1_mesa_force_close_estado_write_removal.ROLLBACK.sql
-- Reverts N-1 by restoring mesa_close_session_v1's pre-N-1 body byte-
-- identical (migrations/2026-08-10_mesa_decouple_payment_from_close.sql):
-- the force-close branch writes ordenes.estado to the legacy literal again.
--
-- READ THIS BEFORE RUNNING IT. Rolling back does not merely restore a
-- behavior -- it resumes manufacturing new rows in a state this project's
-- own deprecation audit found to be legacy-only and safe to stop writing.
-- No table, column, trigger, grant or index is touched in either direction;
-- this file changes ONE function body only.

BEGIN;

CREATE OR REPLACE FUNCTION public.mesa_close_session_v1(p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_total_cents bigint;
  v_paid_cents bigint;
  v_outstanding_cents bigint;
  v_now timestamptz := now();
  v_forced_count integer := 0;
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

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the exact pre-N-1 literal this rollback restores verbatim, not new vocabulary
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents > 0 THEN
    RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the exact pre-N-1 literal this rollback restores verbatim, not new vocabulary
       ))
  ) THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000';
    END IF;

    WITH orphaned AS (
      SELECT o.id, o.estado AS old_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the exact pre-N-1 literal this rollback restores verbatim, not new vocabulary
         ))
       FOR UPDATE OF o
    ),
    closed_orphans AS (
      UPDATE public.ordenes o SET estado = 'CHIUSO_FORZATO', updated_at = v_now -- language-guard: allow-legacy CHIUSO_FORZATO is the exact pre-N-1 literal this rollback restores verbatim, not new vocabulary
      FROM orphaned t WHERE o.id = t.id
      RETURNING o.id, t.old_estado
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs( -- language-guard: allow-legacy numero_ordine below is the existing orden_estado_logs column name, restated verbatim because this rollback restores the pre-N-1 body byte-identical, not new vocabulary
        orden_id, numero_ordine, estado_from, estado_to, event_type,
        actor_type, actor_id, origin, metadata
      )
      SELECT c.id, c.id, c.old_estado, 'CHIUSO_FORZATO', 'table_closed_forced', -- language-guard: allow-legacy CHIUSO_FORZATO is the exact pre-N-1 literal this rollback restores verbatim, not new vocabulary
        'operator', p_by_actor, 'mesa_close_session_force',
        jsonb_build_object(
          'table_session_id', v_session.id,
          'reason', 'operator_forced_close_with_pending_kitchen_work'
        )
      FROM closed_orphans c
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
    'forced', v_forced_count > 0, 'forcedOrderCount', v_forced_count
  );
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_close_session_v1(uuid, text, uuid, boolean) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_close_session_v1';
  IF v_src IS NULL OR position('estado = ''CHIUSO_FORZATO''' in v_src) = 0 THEN -- language-guard: allow-legacy CHIUSO_FORZATO is the exact literal this rollback post-condition proves was restored, not new vocabulary
    RAISE EXCEPTION 'N-1 rollback post-condition failed: the pre-N-1 force-close estado write was not restored';
  END IF;
END $$;

COMMIT;
