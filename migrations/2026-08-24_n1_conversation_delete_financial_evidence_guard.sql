-- migrations/2026-08-24_n1_conversation_delete_financial_evidence_guard.sql
-- N-1 — CONVERSATION HARD-DELETE FINANCIAL EVIDENCE GUARD.
--
-- THE FINDING. public.delete_conversation_if_not_active(p_wa_id) -- the ONE
-- function behind the `eliminaConversazione` action (src/agents/riderTrip.js -- language-guard: allow-legacy eliminaConversazione is the existing action name this migration's guard sits behind, not new vocabulary
-- deleteConversation -> sbRpc('delete_conversation_if_not_active') -> index.js
-- action==='eliminaConversazione') -- had exactly one guard: any order among -- language-guard: allow-legacy eliminaConversazione is the same existing action name, restated for the index.js dispatch site, not new vocabulary
-- the wa_id's own orders that is a member of the active_trip snapshot refuses
-- the whole call. It never checked whether ANY order it was about to bulk-
-- delete carried financial evidence, unlike its sibling
-- delete_order_if_not_active, which M-1 (2026-08-22, row 103) already hardened
-- with exactly that guard for the single-order path. One wa_id can own many
-- orders (this function already computes v_order_ids as an array for the
-- active-trip check), and DELETE FROM public.ordenes WHERE wa_id = p_wa_id
-- removes ALL of them unconditionally, silently orphaning any
-- order_financial_events / payment_allocations / table_order_lines /
-- service_incidents rows that still name them -- exactly M-1's finding,
-- multiplied across every order sharing one conversation.
--
-- LEGACY MONEY, NOT JUST LEDGER EVIDENCE. Unlike the pure-ledger-era orders
-- M-1 was written against, some orders reachable through Nuevo Pedido /
-- Barra / Teléfono represent collected money ONLY via the legacy boolean
-- flags directly on `ordenes` (ya_pagado, cobrado), with no
-- order_financial_events row at all. A guard that repeated M-1's four table
-- checks verbatim and stopped there would still let a wa_id bucket containing
-- only such legacy-flagged orders be wiped. This guard adds ya_pagado=true
-- OR cobrado=true as two more protected conditions, on top of M-1's four.
--
-- COMPOSITE IDENTITY -- same reasoning as M-1, restated per-order. order_id is
-- NOT a global identity (ticket numbers are reused once a prior order has
-- left `ordenes`), so every evidence check below matches (order_id AND
-- service_session_id) using THAT SPECIFIC order's own service_session_id --
-- never order_id alone -- so a stale evidence row from a different, past
-- service session can never false-positive-block an unrelated order that
-- happens to reuse the same ticket number. A NULL service_session_id on
-- either side is conservatively treated as "cannot prove it's a different
-- session" and counted as evidence, matching M-1 exactly: for a money-
-- integrity guard, an unnecessary refusal is a safe failure, a missed
-- refusal is not.
--
-- ALL-OR-NOTHING. The evidence check below is one set-based EXISTS over
-- every order belonging to p_wa_id, evaluated BEFORE any DELETE statement
-- runs, inside the same function body/transaction as the pre-existing
-- active-trip guard and the DELETEs themselves. If even one order in the
-- bucket is protected, the function returns immediately and deletes nothing
-- -- no partial cleanup, no deleting WA messages first and discovering an
-- order is protected after the fact.
--
-- BLANK / INVALID WA_ID. `ordenes.wa_id` can be '' (creaOrdine's own -- language-guard: allow-legacy creaOrdine is the existing JS order-creation function name, cited here for context, not new vocabulary
-- default when no wa_id is supplied), which today buckets every such order
-- under one shared identity -- calling this RPC with '' targets that entire
-- shared bucket, not a single real conversation. This migration rejects
-- p_wa_id when it is NULL or contains no non-whitespace character -- BEFORE
-- the advisory lock is even taken -- returning a new typed code instead of
-- silently operating on a catch-all bucket. Caught live in this slice's own
-- verification, not merely theorized: `btrim(p_wa_id) = ''` (the natural
-- first attempt) only strips the space character -- Postgres's default
-- BOTH-side trim set is exactly one character, ' ' -- so a tab/newline-only
-- string (E'\t\n') survives btrim unchanged (length 2) and would have been
-- silently ACCEPTED as "valid", the opposite of this guard's purpose. The
-- regex `p_wa_id !~ '\S'` (no non-whitespace character present) instead
-- correctly rejects space, tab, newline, CR and any mix, and NULL is
-- excluded explicitly first since NULL !~ '\S' evaluates to NULL, not TRUE.
-- This is a DB-level, caller-independent rejection: it holds even if an
-- application-layer check is ever bypassed, forgotten, or has its own bug.
--
-- CHANNEL-AGNOSTIC BY CONSTRUCTION. Nothing below inspects `canal` or any
-- other channel marker -- the evidence check is keyed purely on
-- order_id/service_session_id and the two legacy flags, so it applies
-- identically whether p_wa_id names a real WhatsApp conversation, a
-- Mesa-shaped bucket, a Barra/Teléfono identifier, or anything else that
-- happens to populate `ordenes.wa_id`.
--
-- AUTHORITY -- unchanged from the original: the check and the DELETEs stay in
-- the exact same PL/pgSQL function body, called once per eliminaConversazione -- language-guard: allow-legacy eliminaConversazione is the same existing action name, restated for the authority/bypass-resistance narrative, not new vocabulary
-- request -- there is no separate JS pre-check that could be bypassed by any
-- caller that reaches the RPC directly (only service_role can execute it;
-- anon/authenticated remain revoked, unchanged by this migration). The
-- pre-existing active_trip guard, its advisory lock and its row lock on
-- config are byte-identical and unmoved -- this adds the wa_id-validity
-- check before them and the evidence guard after them, before the DELETEs.
--
-- New typed codes INVALID_WA_ID and CONVERSATION_HAS_FINANCIAL_EVIDENCE
-- follow this codebase's existing convention (ACTIVE_TRIP_MEMBER_CONFLICT,
-- M-1's ORDER_HAS_FINANCIAL_EVIDENCE) -- SCREAMING_SNAKE_CASE, {ok:false,
-- code}. Mapped in src/agents/riderTrip.js's CODE_TO_HTTP: INVALID_WA_ID to
-- HTTP 400 (malformed request), CONVERSATION_HAS_FINANCIAL_EVIDENCE to HTTP
-- 409, the same status ACTIVE_TRIP_MEMBER_CONFLICT and
-- ORDER_HAS_FINANCIAL_EVIDENCE already use for "hard delete refused".
--
-- WHAT THIS DOES NOT DO. No void/refund/reversal/soft-cancel/new operator
-- workflow -- those are separate capabilities, out of this slice's scope. No
-- canonical Nuevo Pedido obligation-at-creation redesign, no money-column
-- immutability, no Economía/closeout changes. This migration only stops the
-- physical DELETE from running when the wa_id is invalid or when persistent
-- financial evidence exists anywhere in the bucket; a wa_id whose orders
-- genuinely carry none, and still passes the pre-existing active-trip check,
-- keeps deleting exactly as before. No new FK is added (the composite-
-- identity nuance means a naive FK on order_id alone would be actively
-- wrong), no schema redesign, no cleanup of any pre-existing orphan.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_conversation_if_not_active';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'N-1 refused: public.delete_conversation_if_not_active does not exist -- resolve drift first';
  END IF;
  IF v_body LIKE '%CONVERSATION_HAS_FINANCIAL_EVIDENCE%' OR v_body LIKE '%INVALID_WA_ID%' THEN
    RAISE EXCEPTION 'N-1 refused: the financial-evidence/invalid-wa_id guard is already present -- already patched, resolve drift first';
  END IF;
  IF v_body NOT LIKE '%ACTIVE_TRIP_MEMBER_CONFLICT%' THEN
    RAISE EXCEPTION 'N-1 refused: the pre-existing active-trip guard is missing from the live function -- resolve drift first';
  END IF;
END $$;

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_conversation_if_not_active(p_wa_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ds          jsonb;
  v_active      jsonb;
  v_order_ids   text[];
  v_protected   boolean;
  v_conv_del    int;
  v_msgs_del    int;
  v_orders_del  int;
BEGIN
  -- N-1 — wa_id validity guard. Rejected BEFORE the advisory lock: a request
  -- naming no real conversation should never contend for the driver-state
  -- lock or be evaluated against evidence it cannot legitimately own.
  IF p_wa_id IS NULL OR p_wa_id !~ '\S' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_WA_ID');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  SELECT COALESCE(array_agg(id), ARRAY[]::text[]) INTO v_order_ids
  FROM public.ordenes
  WHERE wa_id = p_wa_id;

  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND EXISTS (
       SELECT 1
       FROM unnest(v_order_ids) AS oid(order_id)
       WHERE v_active->'order_ids' ? oid.order_id
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  -- N-1 — financial-evidence guard, all-or-nothing across every order this
  -- wa_id owns. Evaluated as one set-based EXISTS, entirely before any
  -- DELETE below runs: if ANY order in the bucket is protected, the whole
  -- call is refused and NOTHING is deleted. Six protected conditions per
  -- order: the same four M-1 already proved for delete_order_if_not_active
  -- (order_financial_events, table_order_lines, payment_allocations via
  -- payment_transactions, service_incidents -- each scoped by THAT order's
  -- own service_session_id, composite identity, never order_id alone), plus
  -- two legacy money flags M-1 did not need to cover: ya_pagado and cobrado.
  SELECT EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.wa_id = p_wa_id
       AND (
         o.ya_pagado IS TRUE
         OR o.cobrado IS TRUE
         OR EXISTS (
           SELECT 1 FROM public.order_financial_events e
            WHERE e.order_id = o.id
              AND (o.service_session_id IS NULL OR e.service_session_id IS NULL OR e.service_session_id = o.service_session_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.table_order_lines tol
            WHERE tol.order_id = o.id
              AND (o.service_session_id IS NULL OR tol.service_session_id = o.service_session_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.payment_allocations pa
            JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
            WHERE pa.order_id = o.id
              AND (o.service_session_id IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = o.service_session_id)
         )
         OR EXISTS (
           SELECT 1 FROM public.service_incidents si
            WHERE si.order_id = o.id
              AND (o.service_session_id IS NULL OR si.service_session_id = o.service_session_id)
         )
       )
  ) INTO v_protected;

  IF v_protected THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CONVERSATION_HAS_FINANCIAL_EVIDENCE');
  END IF;

  DELETE FROM public.conv WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_conv_del = ROW_COUNT;
  DELETE FROM public.wa_msgs WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_msgs_del = ROW_COUNT;
  DELETE FROM public.ordenes WHERE wa_id = p_wa_id;
  GET DIAGNOSTICS v_orders_del = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'code', 'OK',
    'deleted', jsonb_build_object('conv', v_conv_del, 'wa_msgs', v_msgs_del, 'ordenes', v_orders_del));
END;
$$;

REVOKE ALL ON FUNCTION public.delete_conversation_if_not_active(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_conversation_if_not_active(text) TO service_role;

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY -- this migration performs no business DML (no INSERT,
-- UPDATE or DELETE against ordenes/conv/wa_msgs/order_financial_events/any
-- other business table). The behavioral proof (an invalid wa_id refused, a
-- financially-evidenced bucket refused atomically with zero rows changed, a
-- clean bucket still deletable, the active-trip guard still firing first) is
-- run separately as read-only/rollback-safe probes against real staging
-- data -- see this slice's report for the exact queries and their results.
-- Here we only confirm the function DEFINITION is correct.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_conversation_if_not_active';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'N-1 post-condition failed: delete_conversation_if_not_active is missing after CREATE OR REPLACE';
  END IF;
  IF position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the pre-existing active-trip guard did not survive the replace';
  END IF;
  IF position('INVALID_WA_ID' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the new wa_id-validity guard is missing';
  END IF;
  IF position('CONVERSATION_HAS_FINANCIAL_EVIDENCE' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the new financial-evidence guard is missing';
  END IF;
  -- Guard ordering: wa_id validity first, then active-trip, then the new
  -- evidence guard, matching "preserve existing guards, validate first, add
  -- the new guard after them, before any DELETE".
  IF position('INVALID_WA_ID' in v_src) > position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) THEN
    RAISE EXCEPTION 'N-1 post-condition failed: guard ordering changed -- wa_id validity must be checked first';
  END IF;
  IF position('ACTIVE_TRIP_MEMBER_CONFLICT' in v_src) > position('CONVERSATION_HAS_FINANCIAL_EVIDENCE' in v_src) THEN
    RAISE EXCEPTION 'N-1 post-condition failed: guard ordering changed -- active-trip must still be checked before the evidence guard';
  END IF;
  IF position('CONVERSATION_HAS_FINANCIAL_EVIDENCE' in v_src) > position('DELETE FROM public.conv' in v_src) THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the evidence guard does not precede the DELETEs';
  END IF;
  -- Composite identity + all four M-1 evidence sources, restated per-order.
  IF position('order_financial_events e' in v_src) = 0 OR position('table_order_lines tol' in v_src) = 0
     OR position('payment_allocations pa' in v_src) = 0 OR position('service_incidents si' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: not all four M-1 evidence sources are present in the guard';
  END IF;
  IF position('o.service_session_id' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: composite service_session_id scoping looks missing';
  END IF;
  -- Legacy money flags, N-1's own addition beyond M-1.
  IF position('o.ya_pagado IS TRUE' in v_src) = 0 OR position('o.cobrado IS TRUE' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: legacy ya_pagado/cobrado coverage is missing';
  END IF;
  -- All-or-nothing: exactly one evidence EXISTS wrapping the whole bucket,
  -- not a per-order loop with a partial DELETE in between.
  IF (SELECT count(*) FROM regexp_matches(v_src, 'DELETE FROM public\.(conv|wa_msgs|ordenes)', 'g')) <> 3 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: expected exactly the three original DELETE statements, found a different count -- no partial-deletion path may exist';
  END IF;
  -- The original three DELETEs are still present, unchanged, still keyed on wa_id alone.
  IF position('DELETE FROM public.conv WHERE wa_id = p_wa_id;' in v_src) = 0
     OR position('DELETE FROM public.wa_msgs WHERE wa_id = p_wa_id;' in v_src) = 0
     OR position('DELETE FROM public.ordenes WHERE wa_id = p_wa_id;' in v_src) = 0 THEN
    RAISE EXCEPTION 'N-1 post-condition failed: the original DELETE statements did not survive the replace unchanged';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_function_privilege('service_role', 'public.delete_conversation_if_not_active(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-1 post-condition failed: service_role lost EXECUTE on delete_conversation_if_not_active';
  END IF;
  IF has_function_privilege('anon', 'public.delete_conversation_if_not_active(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.delete_conversation_if_not_active(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-1 post-condition failed: anon/authenticated must never execute delete_conversation_if_not_active';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-110: the manifest records this file's own sha256, and embedding that
-- sha in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 111, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
