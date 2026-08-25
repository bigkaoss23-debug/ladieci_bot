-- migrations/2026-08-25_ecf2_order_delete_economic_evidence_alignment.sql
-- EC-F2 — SINGLE-ORDER DELETE ECONOMIC GUARD ALIGNMENT.
-- STAGING ONLY. Reader/guard semantics only: no table, column, index or trigger is
-- created or altered, no business DML, no backfill, no historical row is touched.
--
-- ── THE DEFECT, RE-PROVEN LIVE THIS SESSION (rollback-forced probes, zero residue) ──
-- `delete_order_if_not_active` recognised only FOUR kinds of economic evidence:
-- order_financial_events, table_order_lines, payment_allocations, service_incidents.
-- It did NOT recognise the canonical N-2 obligation, nor the legacy paid booleans. Three
-- probes against the LIVE function, each inside a transaction aborted by a terminating
-- RAISE:
--
--   A  a brand-new order (N-2 obligation auto-created, zero payments)
--        -> {"ok": true, "code": "OK", "deleted": 1}       ORDER HARD-DELETED
--        -> its order_obligations row SURVIVED, orphaned    (append-only, by design)
--   B  ya_pagado = true, no obligation, no events
--        -> {"ok": true, "code": "OK", "deleted": 1}       ORDER HARD-DELETED
--   C  cobrado   = true, no obligation, no events
--        -> {"ok": true, "code": "OK", "deleted": 1}       ORDER HARD-DELETED
--
-- A is the serious one and is WIDER than the certification audit recorded: it is not a
-- closed historical class, it is EVERY order created since N-2 landed. An unpaid order
-- carrying an immutable obligation is economically evidenced -- the obligation is the
-- record that the sale was owed -- and hard-deleting it both erases that fact from every
-- order-scoped reader and strands the append-only obligation row with no order behind it.
-- B/C are the `#999024` class: 14.50 EUR of legacy-collected money that Economía reports
-- through safeTicket's legacy fallback and that no guard was protecting.
--
-- ── THE ASYMMETRY THIS CLOSES ──────────────────────────────────────────────────────
-- `delete_conversation_if_not_active` (N-1) ALREADY checked the legacy booleans. So the
-- two hard-delete guards disagreed about what "economically evidenced" means, and the
-- stricter definition was already sitting in the sibling function. Neither knew about
-- N-2 obligations. Rather than copy a seven-branch predicate into two places -- which is
-- exactly how they diverged in the first place -- the predicate becomes ONE function that
-- both call. Divergence is now impossible by construction, not by discipline.
--
-- ── IDENTITY RULES, DELIBERATE AND NOT UNIFORM ─────────────────────────────────────
-- order_obligations is matched on `order_uid`, the PERMANENT identity N-2 keys it by.
-- Everything else keeps the EXISTING composite (order_id, service_session_id) scoping,
-- character-identical to what both guards already carried, because the human-facing
-- `#NNN` is recycled across services (N-6) and must never be trusted alone. The
-- NULL-tolerant arms are preserved verbatim: they bias the guard toward REFUSING, which
-- is the safe direction for a delete gate. This is NOT N-7 -- no lookup is migrated to
-- order_uid beyond the obligations table that is already keyed by it.
--
-- ── RLS NOTE (checked, not assumed) ────────────────────────────────────────────────
-- order_obligations has RLS ENABLED AND FORCED with ZERO policies, so an ordinary role
-- sees no rows at all and this new arm would silently never fire. Both guards are
-- SECURITY INVOKER and are executed by `service_role`, which has rolbypassrls = true and
-- SELECT on the table -- verified in pg_roles/pg_class this session, and re-asserted as a
-- post-condition below. The helper is deliberately SECURITY INVOKER too, so it inherits
-- exactly the caller's visibility and adds no new privilege surface.

BEGIN;

-- ── THE ONE ECONOMIC-EVIDENCE PREDICATE ────────────────────────────────────────────
-- TRUE when this order carries any economic or audit evidence and therefore must never
-- be physically deleted. Returns FALSE for an order id that does not exist, which is what
-- preserves delete_order_if_not_active's pre-existing idempotent-retry behaviour: a
-- already-deleted / never-existed id falls straight through to the no-op DELETE instead
-- of being evaluated against evidence it cannot own.
CREATE OR REPLACE FUNCTION public.order_has_economic_evidence_v1(p_order_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.id = p_order_id
       AND (
         -- LEGACY economic evidence. Pre-ledger orders declared money with these two
         -- booleans and Economía still reports them through safeTicket's legacy
         -- fallback, so they are money and they block a delete.
         o.ya_pagado IS TRUE
         OR o.cobrado IS TRUE
         -- N-2 CANONICAL OBLIGATION, on the permanent identity. An unpaid order with an
         -- obligation is evidenced: the obligation records what was owed. Matching on
         -- order_uid means a recycled #NNN can never borrow another order's obligation;
         -- an order with a NULL order_uid yields no match, and by the anchor trigger's
         -- own fail-closed contract such an order cannot have an obligation anyway.
         OR EXISTS (
           SELECT 1 FROM public.order_obligations ob
            WHERE ob.order_uid = o.order_uid
         )
         -- CANONICAL PAYMENT/REFUND/VOID evidence, session-scoped exactly as before.
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
         -- AUDIT evidence. An incident is a record that something happened to this order.
         OR EXISTS (
           SELECT 1 FROM public.service_incidents si
            WHERE si.order_id = o.id
              AND (o.service_session_id IS NULL OR si.service_session_id = o.service_session_id)
         )
       )
  );
$fn$;

COMMENT ON FUNCTION public.order_has_economic_evidence_v1(text) IS
  'EC-F2 — the ONE definition of "this order carries economic or audit evidence and must not be hard-deleted". Used by delete_order_if_not_active and delete_conversation_if_not_active so the two can never diverge. FALSE for a non-existent order id, which preserves idempotent-retry deletes.';

REVOKE ALL ON FUNCTION public.order_has_economic_evidence_v1(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_has_economic_evidence_v1(text) TO service_role;

-- ── SINGLE-ORDER DELETE GUARD ──────────────────────────────────────────────────────
-- Byte-for-byte the previous body except that the four-branch inline predicate is
-- replaced by the shared seven-branch one. The advisory lock, the DRIVER_STATO
-- active-trip refusal, the v_found idempotent-retry behaviour, the refusal code and the
-- return shape are all unchanged.
CREATE OR REPLACE FUNCTION public.delete_order_if_not_active(p_order_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ds           jsonb;
  v_active       jsonb;
  v_deleted      int;
  v_found        boolean;
  v_has_evidence boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('LA_DIECI_DRIVER_STATO'));
  SELECT COALESCE(NULLIF(valore,'')::jsonb, '{}'::jsonb) INTO v_ds
  FROM public.config WHERE chiave = 'DRIVER_STATO' FOR UPDATE;
  v_active := v_ds->'active_trip';

  -- Operational safety first, and independent of economics: an active-trip member is
  -- refused whether or not it carries money.
  IF v_active IS NOT NULL AND (v_active->>'status') = 'ACTIVE'
     AND (v_active->'order_ids' ? p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ACTIVE_TRIP_MEMBER_CONFLICT');
  END IF;

  -- M-1 / EC-F2 — financial-evidence guard. v_found stays NULL/false when the order no
  -- longer exists (already deleted / never existed), which preserves the pre-existing
  -- idempotent-retry behavior below.
  SELECT true INTO v_found FROM public.ordenes WHERE id = p_order_id;

  IF v_found THEN
    v_has_evidence := public.order_has_economic_evidence_v1(p_order_id);
    IF v_has_evidence THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ORDER_HAS_FINANCIAL_EVIDENCE');
    END IF;
  END IF;

  DELETE FROM public.ordenes WHERE id = p_order_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'deleted', v_deleted);
END;
$fn$;

-- ── CONVERSATION DELETE GUARD (N-1) ────────────────────────────────────────────────
-- Same body as before; its inline per-order predicate now delegates to the shared one,
-- which STRENGTHENS it (it gains the N-2 obligation arm it also lacked) and can never
-- weaken it: every branch it already had is present in the helper, unchanged.
CREATE OR REPLACE FUNCTION public.delete_conversation_if_not_active(p_wa_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ds          jsonb;
  v_active      jsonb;
  v_order_ids   text[];
  v_protected   boolean;
  v_conv_del    int;
  v_msgs_del    int;
  v_orders_del  int;
BEGIN
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

  SELECT EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.wa_id = p_wa_id
       AND public.order_has_economic_evidence_v1(o.id)
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
$fn$;

-- ── POST-CONDITIONS ────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_helper text;
  v_order  text;
  v_conv   text;
BEGIN
  SELECT prosrc INTO v_helper FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_has_economic_evidence_v1';
  SELECT prosrc INTO v_order  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_order_if_not_active';
  SELECT prosrc INTO v_conv   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='delete_conversation_if_not_active';

  IF v_helper IS NULL THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: order_has_economic_evidence_v1 was not created';
  END IF;

  -- All SEVEN evidence classes present in the ONE predicate.
  IF v_helper NOT LIKE '%order_obligations%'
     OR v_helper NOT LIKE '%order_financial_events%'
     OR v_helper NOT LIKE '%table_order_lines%'
     OR v_helper NOT LIKE '%payment_allocations%'
     OR v_helper NOT LIKE '%service_incidents%'
     OR v_helper NOT LIKE '%ya_pagado%'
     OR v_helper NOT LIKE '%cobrado%'
  THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: the evidence predicate lost one of its seven classes';
  END IF;

  -- Obligations matched on the PERMANENT identity, never the display id.
  IF v_helper NOT LIKE '%ob.order_uid = o.order_uid%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: obligation lookup is not keyed on order_uid';
  END IF;

  -- N-6 composite scoping preserved on every display-id lookup (4 lookups, 4 clauses).
  IF (length(v_helper) - length(replace(v_helper, 'o.service_session_id IS NULL OR', ''))) / length('o.service_session_id IS NULL OR') <> 4 THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: expected exactly 4 session-scoped display-id lookups';
  END IF;

  -- Both guards delegate; neither keeps a private copy of the predicate.
  IF v_order NOT LIKE '%order_has_economic_evidence_v1%'
     OR v_conv NOT LIKE '%order_has_economic_evidence_v1%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: a delete guard does not delegate to the shared predicate';
  END IF;
  IF v_order LIKE '%order_financial_events%' OR v_conv LIKE '%order_financial_events%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: a delete guard still carries its own inline evidence predicate';
  END IF;

  -- Pre-existing protections untouched.
  IF v_order NOT LIKE '%ACTIVE_TRIP_MEMBER_CONFLICT%' OR v_conv NOT LIKE '%ACTIVE_TRIP_MEMBER_CONFLICT%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: active-trip refusal lost';
  END IF;
  IF v_order NOT LIKE '%ORDER_HAS_FINANCIAL_EVIDENCE%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: single-order refusal code changed';
  END IF;
  IF v_conv NOT LIKE '%CONVERSATION_HAS_FINANCIAL_EVIDENCE%' OR v_conv NOT LIKE '%INVALID_WA_ID%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: conversation refusal codes changed';
  END IF;
  IF v_order NOT LIKE '%pg_advisory_xact_lock%' OR v_conv NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: advisory lock lost';
  END IF;

  -- The runtime role must actually be able to see obligations, or the new arm is inert.
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: service_role does not bypass RLS, the obligation arm would never fire under forced RLS';
  END IF;
  IF NOT has_table_privilege('service_role','public.order_obligations','SELECT') THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: service_role cannot SELECT order_obligations';
  END IF;
  IF NOT has_function_privilege('service_role','public.order_has_economic_evidence_v1(text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.delete_order_if_not_active(text)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.delete_conversation_if_not_active(text)','EXECUTE')
  THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: service_role EXECUTE grant missing';
  END IF;

  -- No table/trigger was touched by this slice.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_obligations'::regclass
                  AND NOT tgisinternal AND tgname='order_obligations_append_only_v1') THEN
    RAISE EXCEPTION 'EC-F2 post-condition failed: order_obligations append-only trigger disappeared';
  END IF;
END
$post$;

COMMIT;
