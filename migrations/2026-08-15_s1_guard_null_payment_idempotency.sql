-- S1 — GUARD NULL FIX + PAYMENT IDEMPOTENCY + DUPLICATE-CANDIDATE PROTECTION
-- Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S1
-- (§19: "Guard NULL fix + payment idempotency key"). S0 is PASS under that
-- specification; S0 §E re-verified 0 duplicate (workspace_id,
-- client_request_id) groups immediately before this migration was written.
--
-- THREE INDEPENDENT FIXES, ONE MIGRATION TRANSACTION.
--
-- A. guard_service_session_closed_v1 — NULL-propagation fail-open hole.
--
--    ROOT CAUSE: the table-open check reads
--      current_setting('ladieci.v3_close_authorized_session_id', true) = OLD.id::text
--    directly, unwrapped. When that session-local setting was never set
--    (the ordinary case for every close path except the legacy, unreachable
--    V3 close engine), current_setting(..., true) returns SQL NULL, not ''.
--    NULL = 'some-uuid' evaluates to NULL, not false. NULL then propagates
--    through the surrounding boolean algebra:
--      NULL AND EXISTS(closeouts)   -> NULL when EXISTS is true, else false
--      NULL OR v_incident_safe      -> NULL when v_incident_safe is false
--      NOT NULL                     -> NULL
--    and PL/pgSQL's IF treats a NULL condition exactly like false: it does
--    NOT enter the branch. The branch being skipped here is the one that
--    performs the open-table EXISTS check and RAISEs MESA_TABLES_NOT_RELEASED
--    -- so whenever a service_closeouts row already exists for the session
--    (true today for any session an economic-boundary or V3-style close
--    engine has touched -- proven live: 33174121 and 9746dfdd both have one)
--    AND the v3 marker is unset AND the session is not in an incident-safe
--    close, the open-table protection is silently skipped, not silently
--    passed. This is exactly the class of defect row 68's own migration
--    header warned about for a different marker ("the pre-existing v3
--    clause happens to be safe today only because it is AND-ed with
--    service_closeouts EXISTS(), which is always false on the real V2
--    runtime path" -- that assumption is what economicBoundaryEngine.js has
--    since made false).
--
--    FIX: the exact same COALESCE-to-clean-boolean discipline row 68 already
--    established for v_incident_safe is applied to the v3-authorized clause
--    too, via a new local variable v_v3_authorized. No new lifecycle
--    exception, no new allow...AcrossBoundary flag -- purely a NULL-safety
--    correction of an existing clause. The AND-with-service_closeouts shape
--    is preserved verbatim; only the left operand of that AND becomes a
--    clean, never-NULL boolean.
--
--    Four-case truth table this fix makes deterministic (previously the
--    starred case silently fell through to "skip the check"):
--      1. setting unset (NULL), closeouts EXISTS=false -> v_v3_authorized=false, clause=false -> table check RUNS
--      2. setting unset (NULL), closeouts EXISTS=true   -> v_v3_authorized=false, clause=false -> table check RUNS  * (previously: NULL, check SILENTLY SKIPPED)
--      3. setting = OLD.id::text, closeouts EXISTS=false -> v_v3_authorized=true, clause=false (AND with false EXISTS) -> table check RUNS
--      4. setting = OLD.id::text, closeouts EXISTS=true   -> v_v3_authorized=true, clause=true -> table check SKIPPED (intended v3-authorized bypass, unchanged)
--
-- B. payment_transactions_idempotency_uq + mesa_post_payment_v1 replay lookup.
--
--    Old key: UNIQUE (workspace_id, by_actor, by_sid_hash, client_request_id)
--    -- a re-login or a second device defeats replay protection for the
--    same logical payment (F-15, forensic audit). New key: UNIQUE
--    (workspace_id, client_request_id) -- exactly-once commit per logical
--    payment intent, regardless of actor/session/device. by_actor, by_role,
--    by_sid_hash remain persisted on the payment row as audit attributes;
--    they are simply no longer part of what makes a payment intent unique.
--    A replay by a different actor than the one who committed the original
--    row still returns idempotent:true (zero new rows, ever) AND appends an
--    auth_audit row naming the replaying identity -- so the event is never
--    silent, even though it is never blocked.
--
-- C. Duplicate-candidate window (mesa_post_payment_v1, new).
--
--    NOT idempotency -- this is about a NEW client_request_id that looks
--    like a just-committed payment (the realistic "response lost, operator
--    re-enters the same charge" case (R-DUP-INTENT), never fully solvable
--    by any idempotency key since a second genuine payment of identical
--    shape is indistinguishable in intent). Before INSERT, the same table
--    session is searched for a payment with the SAME kind/mode/amount/
--    payment_method/covers_settled under a DIFFERENT client_request_id
--    created within the previous 120 seconds. A hit raises
--    MESA_POSSIBLE_DUPLICATE_PAYMENT unless the caller explicitly passes
--    p_confirm_duplicate := true, in which case the payment proceeds (every
--    other gate still applies) and an auth_audit row records the override.
--    This is never returned as idempotent:true -- it is a distinct payment,
--    explicitly confirmed, not a replay.
--
-- Nothing else changes. No table/column added or dropped. No historical
-- payment_transactions row is touched. S2's objects (receipt-service
-- nullability, event_service_session_id, mesa_snapshot_order_lines_v1,
-- service_session_assign_financial_event, order_entities, order_uid, the S8
-- bypass tables, balance semantics, adjustment tables) are untouched by this
-- migration.
--
-- Signature widens 12 args -> 13 for mesa_post_payment_v1 (p_confirm_duplicate
-- appended, DEFAULT false). Postgres identifies overloads by the full
-- parameter type list regardless of defaults, so the old 12-arg overload is
-- DROPped explicitly before the 13-arg CREATE, matching this codebase's own
-- established discipline for every prior widened signature (rows 61, 68, 70).
-- guard_service_session_closed_v1 keeps CREATE OR REPLACE -- it is a trigger
-- function; its own signature never changes.
--
-- Paired .ROLLBACK.sql restores both function bodies verbatim and recreates
-- the original 4-column unique index, refusing if either function has
-- drifted or already carries this migration's changes.

-- ── Predecessor guard: refuse over drift or a re-patch ───────────────────────
DO $$
DECLARE
  v_guard_body text;
  v_payment_body text;
  v_dup_groups integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_guard_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_service_session_closed_v1';
  IF v_guard_body IS NULL THEN
    RAISE EXCEPTION 'S1 refused: guard_service_session_closed_v1 not found -- resolve drift first';
  END IF;
  IF v_guard_body NOT LIKE '%v_incident_safe := COALESCE(current_setting(''ladieci.incident_safe_close_session_id'', true), '''')%' THEN
    RAISE EXCEPTION 'S1 refused: guard_service_session_closed_v1 does not match the expected row-68 post-incident-safe-exemption shape -- resolve drift first';
  END IF;
  IF v_guard_body LIKE '%v_v3_authorized%' THEN
    RAISE EXCEPTION 'S1 refused: guard_service_session_closed_v1 already references v_v3_authorized -- already patched, resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_payment_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1'
     AND pg_get_function_identity_arguments(p.oid) =
       'p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric, p_covers_settled integer, p_line_ids uuid[], p_meta jsonb';
  IF v_payment_body IS NULL THEN
    RAISE EXCEPTION 'S1 refused: expected 12-arg mesa_post_payment_v1 not found -- resolve drift first';
  END IF;
  IF v_payment_body LIKE '%p_confirm_duplicate%' THEN
    RAISE EXCEPTION 'S1 refused: mesa_post_payment_v1 already references p_confirm_duplicate -- already patched, resolve drift first';
  END IF;
  IF v_payment_body NOT LIKE '%WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor%AND by_sid_hash = p_by_sid_hash AND client_request_id = p_client_request_id%' THEN
    RAISE EXCEPTION 'S1 refused: mesa_post_payment_v1 replay lookup does not match the expected pre-S1 4-column shape -- resolve drift first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'payment_transactions_idempotency_uq'
  ) THEN
    RAISE EXCEPTION 'S1 refused: payment_transactions_idempotency_uq not found -- resolve drift first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'payment_transactions_idempotency_v2_uq'
  ) THEN
    RAISE EXCEPTION 'S1 refused: payment_transactions_idempotency_v2_uq already exists -- already patched, resolve drift first';
  END IF;

  -- PRE-INDEX SAFETY CHECK (S0 §E, re-verified in-transaction): no duplicate
  -- (workspace_id, client_request_id) group may exist before the unique
  -- index is narrowed to that key. Never deduplicate, never delete, never
  -- choose a winner here -- a positive count is a hard STOP.
  SELECT count(*) INTO v_dup_groups FROM (
    SELECT 1 FROM public.payment_transactions
     GROUP BY workspace_id, client_request_id
    HAVING count(*) > 1
  ) dup;
  IF v_dup_groups > 0 THEN
    RAISE EXCEPTION 'S1 refused: % duplicate (workspace_id, client_request_id) group(s) exist -- narrowing the unique index would be unsafe; resolve before retrying', v_dup_groups;
  END IF;
END $$;

-- ── A. guard_service_session_closed_v1 — NULL-safe v3-authorized clause ─────
CREATE OR REPLACE FUNCTION public.guard_service_session_closed_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_incident_safe boolean;
  v_v3_authorized boolean;
BEGIN
  IF NEW.status = 'closed' AND OLD.status IS DISTINCT FROM 'closed' THEN
    v_incident_safe := COALESCE(current_setting('ladieci.incident_safe_close_session_id', true), '') = OLD.id::text;
    -- S1 FIX: COALESCE-wrapped exactly like v_incident_safe above, so this
    -- is always a clean boolean and can never propagate NULL through the
    -- AND/OR/NOT chain below and silently skip the open-table check.
    v_v3_authorized := COALESCE(current_setting('ladieci.v3_close_authorized_session_id', true), '') = OLD.id::text;

    IF NOT (
      (
        v_v3_authorized
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

-- ── B. payment idempotency constraint — narrow without ever dropping protection ──
-- payment_transactions_idempotency_uq is a genuine UNIQUE table CONSTRAINT
-- (contype='u'), not a bare index -- confirmed live: `DROP INDEX` on it fails
-- with 2BP01 ("constraint ... requires it"). Constraint-level DDL used
-- throughout, matching that reality.
--
-- Explicit lock, documented: within this one migration transaction, DDL on
-- payment_transactions already holds its lock until COMMIT, and a plain
-- (non-CONCURRENT) ADD CONSTRAINT ... UNIQUE blocks concurrent writers for
-- its own duration -- so no payment can be inserted anywhere inside this
-- migration, making an unsafe concurrent window structurally impossible. The
-- explicit LOCK below makes that guarantee visible in the migration text.
LOCK TABLE public.payment_transactions IN SHARE ROW EXCLUSIVE MODE;

-- New constraint added BEFORE the old one is dropped: at every instant
-- inside this transaction, payment_transactions has at least one active
-- uniqueness guard (never a bare interval with zero idempotency protection).
ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_idempotency_v2_uq UNIQUE (workspace_id, client_request_id);

ALTER TABLE public.payment_transactions
  DROP CONSTRAINT payment_transactions_idempotency_uq;

ALTER TABLE public.payment_transactions
  RENAME CONSTRAINT payment_transactions_idempotency_v2_uq TO payment_transactions_idempotency_uq;

-- ── B+C. mesa_post_payment_v1 — narrowed replay key + duplicate-candidate ───
DROP FUNCTION public.mesa_post_payment_v1(
  uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid[], jsonb
);

CREATE FUNCTION public.mesa_post_payment_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_by_sid_hash text,
  p_table_session_id uuid,
  p_payment_method text,
  p_mode text,
  p_client_request_id text,
  p_request_hash text,
  p_amount numeric DEFAULT NULL::numeric,
  p_covers_settled integer DEFAULT NULL::integer,
  p_line_ids uuid[] DEFAULT NULL::uuid[],
  p_meta jsonb DEFAULT '{}'::jsonb,
  p_confirm_duplicate boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_tx public.payment_transactions%ROWTYPE;
  v_line record;
  v_order record;
  v_total_cents bigint;
  v_paid_cents bigint;
  v_outstanding_cents bigint;
  v_amount_cents bigint;
  v_to_allocate_cents bigint;
  v_line_remaining_cents bigint;
  v_allocation_cents bigint;
  v_remaining_covers integer;
  v_covers_settled integer;
  v_selected_count integer;
  v_selected_distinct integer;
  v_selected_matched integer;
  v_scope text;
  v_prev_state text;
  v_new_state text;
  v_order_total_cents bigint;
  v_order_paid_before_cents bigint;
  v_order_allocation_cents bigint;
  v_table_remaining_cents bigint;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_duplicate_candidate boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_payment_method NOT IN ('efectivo','tarjeta','bizum')
     OR p_mode NOT IN ('full','equal_split','item_selection','custom_amount')
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'MESA_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESA_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','legacy_operator')
  THEN RAISE EXCEPTION 'MESA_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  -- S1: idempotency key narrowed to (workspace_id, client_request_id) --
  -- exactly-once commit per logical payment intent, regardless of actor,
  -- session id, re-login or device. Replay is still checked before the
  -- account-open guard: an exact retry must return the committed
  -- transaction instead of looking like a new payment.
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    -- Same key, same hash: a genuine replay. Actor/role/sid attribution on
    -- the ORIGINAL row is never touched. A replay by a different identity
    -- than the one who committed the original row is never blocked, but is
    -- never silent either -- it leaves an audit trace naming both.
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES (
        'PAYMENT_REPLAY_DIFFERENT_ACTOR',
        v_existing.by_actor,
        p_by_actor,
        jsonb_build_object(
          'transactionId', v_existing.id,
          'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash,
          'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role
        )
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled
    );
  END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  -- A Mesa with no comanda yet has nothing to charge and no real covers to settle.
  IF v_session.covers_total IS NULL THEN
    RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000';
  END IF;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal mesa_post_payment_v1 already filtered on, reproduced verbatim because DROP+CREATE requires the full function body, not new vocabulary
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'MESA_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;

  SELECT v_session.covers_total - COALESCE(sum(
    CASE WHEN kind='payment' THEN covers_settled ELSE -covers_settled END
  ), 0)::integer INTO v_remaining_covers
    FROM public.payment_transactions WHERE table_session_id = v_session.id;
  v_remaining_covers := GREATEST(0, v_remaining_covers);

  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents;
    v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
    END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, reproduced verbatim for the same reason
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
    END IF;
    SELECT COALESCE(sum(remaining_cents),0)::bigint INTO v_amount_cents FROM (
      SELECT GREATEST(0,
        round(l.net_amount * 100)::bigint - COALESCE(sum(
          CASE WHEN t.kind='refund' THEN -round(a.amount * 100)::bigint ELSE round(a.amount * 100)::bigint END
        ),0)
      ) AS remaining_cents
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
      LEFT JOIN public.payment_allocations a ON a.table_order_line_id = l.id
      LEFT JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
      WHERE l.table_session_id = v_session.id AND l.id = ANY(p_line_ids)
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO') -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, reproduced verbatim for the same reason
      GROUP BY l.id, l.net_amount
    ) selected;
    IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'MESA_LINE_SELECTION_SETTLED' USING ERRCODE='55000'; END IF;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  END IF;

  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents
     OR v_covers_settled < 0 OR v_covers_settled > v_remaining_covers
  THEN RAISE EXCEPTION 'MESA_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  -- Paying the final cent always settles every remaining cover.
  IF v_amount_cents = v_outstanding_cents THEN v_covers_settled := v_remaining_covers; END IF;

  -- S1-C: duplicate-candidate window. NOT idempotency -- a genuinely new
  -- client_request_id whose shape matches a payment that just committed on
  -- the SAME table session, within the previous 120 seconds. Matching shape
  -- is exactly: table_session_id, kind ('payment' -- the only kind this
  -- function ever inserts), mode, amount, payment_method, covers_settled.
  -- No fuzzy matching, no wider window, no new intent lifecycle.
  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions pt
     WHERE pt.table_session_id = v_session.id
       AND pt.client_request_id <> p_client_request_id
       AND pt.kind = 'payment'
       AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0)
       AND pt.payment_method = p_payment_method
       AND pt.covers_settled = v_covers_settled
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;

  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'MESA_POSSIBLE_DUPLICATE_PAYMENT' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    -- Explicit override of a real detected candidate: proceed (every other
    -- gate above already passed), but never silently -- this is a distinct,
    -- confirmed payment, never returned as idempotent:true.
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES (
      'PAYMENT_DUPLICATE_CONFIRMED',
      NULL,
      p_by_actor,
      jsonb_build_object(
        'tableSessionId', v_session.id,
        'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0,
        'mode', p_mode,
        'paymentMethod', p_payment_method,
        'coversSettled', v_covers_settled
      )
    );
  END IF;

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_session.service_session_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, v_covers_settled,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;

  v_to_allocate_cents := v_amount_cents;
  FOR v_line IN
    SELECT l.id, l.order_id, l.net_amount,
      GREATEST(0, round(l.net_amount * 100)::bigint - COALESCE((
        SELECT sum(CASE WHEN t.kind='refund' THEN -round(a.amount*100)::bigint ELSE round(a.amount*100)::bigint END)
          FROM public.payment_allocations a
          JOIN public.payment_transactions t ON t.id=a.payment_transaction_id
         WHERE a.table_order_line_id=l.id
      ),0)) AS remaining_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
    WHERE l.table_session_id = v_session.id
      AND (p_mode <> 'item_selection' OR l.id = ANY(p_line_ids))
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO') -- language-guard: allow-legacy CHIUSO_FORZATO is the same pre-existing terminal-estado literal, reproduced verbatim for the same reason
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_allocate_cents <= 0;
    v_line_remaining_cents := v_line.remaining_cents;
    IF v_line_remaining_cents <= 0 THEN CONTINUE; END IF;
    v_allocation_cents := LEAST(v_to_allocate_cents, v_line_remaining_cents);
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_tx.id, v_line.id, v_line.order_id, v_allocation_cents / 100.0, v_now);
    v_to_allocate_cents := v_to_allocate_cents - v_allocation_cents;
  END LOOP;
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  -- Mirror one event per affected kitchen command into the canonical closeout ledger.
  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents
      FROM public.payment_allocations a
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id ORDER BY a.order_id
  LOOP
    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents
      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;
    SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100),0)::bigint
      INTO v_order_paid_before_cents
      FROM public.order_financial_events e
     WHERE e.service_session_id=v_session.service_session_id AND e.order_id=v_order.order_id
       AND e.type IN ('payment','payment_imported','refund');
    v_order_allocation_cents := v_order.allocated_cents;
    v_prev_state := CASE
      WHEN v_order_paid_before_cents <= 0 THEN 'unpaid'
      WHEN v_order_paid_before_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_new_state := CASE
      WHEN v_order_paid_before_cents + v_order_allocation_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_scope := 'mesa_' || replace(v_tx.id::text, '-', '');

    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      payment_transaction_id, created_at
    )
    SELECT o.id, 'payment', v_order_allocation_cents / 100.0, p_payment_method,
      NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','mesa','mode',p_mode,'transaction_id',v_tx.id),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_tx.id::text, v_order_allocation_cents::text,
        p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_tx.id, v_now
    FROM public.ordenes o WHERE o.id=v_order.order_id AND o.table_session_id=v_session.id;
  END LOOP;

  -- Legacy booleans remain compatibility projections only. Ledger events above are truth.
  UPDATE public.ordenes o SET
    cobrado = calc.is_paid,
    ya_pagado = calc.is_paid,
    metodo_pago = CASE WHEN calc.is_paid THEN calc.method_projection ELSE COALESCE(o.metodo_pago,'') END
  FROM (
    SELECT l.order_id,
      COALESCE(sum(l.net_amount),0) <= COALESCE((
        SELECT sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)
          FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported','refund')
      ),0) AS is_paid,
      CASE WHEN (
        SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) > 1 THEN 'MIXTO' ELSE (
        SELECT max(e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) END AS method_projection
    FROM public.table_order_lines l WHERE l.table_session_id=v_session.id GROUP BY l.order_id
  ) calc
  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;

  -- P0-B.1 — payment ends here. No table_sessions write, no ordenes.estado
  -- write, ever, in this function, again.
  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    'tableStatus', 'open'
  );
END
$function$;

REVOKE ALL ON FUNCTION public.mesa_post_payment_v1(
  uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid[], jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_post_payment_v1(
  uuid, text, text, uuid, text, text, text, text, numeric, integer, uuid[], jsonb, boolean
) TO service_role;
