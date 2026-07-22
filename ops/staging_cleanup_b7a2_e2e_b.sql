-- ============================================================================
-- ops/staging_cleanup_b7a2_e2e_b.sql — S2-6A3B
--
-- STAGING ONLY (tdikhfeinufaahagmpjz). Never run against production.
-- Deliberately NOT part of any migration: this is a one-shot operational script
-- targeting one named synthetic fixture, `B7A2_E2E_B`, classified in S2-6A3A as
-- "A — synthetic fixture" (the row even names itself "… DELETE OK").
--
-- Everything runs inside one DO block, so it is a single atomic statement: every
-- guard is evaluated BEFORE the first DELETE, and any mismatch raises, which
-- aborts the statement and rolls back with nothing deleted.
--
-- THE LEDGER IS NEVER TOUCHED. order_financial_events is append-only (enforced by
-- the order_financial_events_append_only trigger, which this script never disables
-- or circumvents). The two synthetic events are *verified and checksummed*, and the
-- checksum is re-asserted after the deletes — there is deliberately no DELETE
-- against that table anywhere below. The events survive as immutable evidence with
-- service_session_id IS NULL, which is exactly the "legacy order" case the
-- migration is designed for. Deleting the ordenes row only becomes possible after
-- the migration drops ofe_order_id_fk; before that the RESTRICT correctly refuses.
--
-- PRECONDITION: run this only AFTER the session-identity migration is applied and
-- the matching backend is deployed.
--
-- No wildcard is used anywhere: B7A2_E2E_A and B7A2_E2E_C must survive untouched.
-- Backup + verifiable restore: ops/backup/b7a2_e2e_b_backup_2026-07-22.json
--                              ops/backup/b7a2_e2e_b_restore_2026-07-22.sql
-- ============================================================================
BEGIN;

DO $$
DECLARE
  TARGET      constant text := 'B7A2_E2E_B';
  v_ord       public.ordenes%ROWTYPE;
  v_n         integer;
  v_pay       numeric;
  v_ref       numeric;
  v_sib       integer;
  v_del_st    integer;
  v_del_ord   integer;
  v_ledger_pre  text;
  v_ledger_post text;
BEGIN
  -- ── Guard 1: the order exists, exactly once, and is the expected one ───────
  SELECT * INTO v_ord FROM public.ordenes WHERE id = TARGET;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'BLOCKED: order % not found', TARGET;
  END IF;

  IF v_ord.estado <> 'EN_COCINA' THEN
    RAISE EXCEPTION 'BLOCKED: unexpected estado %, expected EN_COCINA', v_ord.estado;
  END IF;

  -- ── Guard 2: zero items, no customer data, no lifecycle history ───────────
  IF coalesce(jsonb_array_length(coalesce(v_ord.items, '[]'::jsonb)), 0) <> 0 THEN
    RAISE EXCEPTION 'BLOCKED: order carries items — not an empty fixture';
  END IF;

  IF v_ord.cliente_id IS NOT NULL
     OR coalesce(v_ord.tel, '') <> ''
     OR coalesce(v_ord.wa_id, '') <> ''
     OR v_ord.direccion IS NOT NULL
     OR coalesce(v_ord.nota, '') <> ''
     OR v_ord.zona IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCKED: order carries customer data — refusing to treat it as synthetic';
  END IF;

  IF v_ord.confirmado_at IS NOT NULL OR v_ord.en_cocina_at IS NOT NULL
     OR v_ord.en_entrega_at IS NOT NULL OR v_ord.retirado_at IS NOT NULL
     OR v_ord.completado_at IS NOT NULL OR v_ord.cancelado_at IS NOT NULL
     OR v_ord.updated_at IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCKED: order has lifecycle timestamps — it was really operated';
  END IF;

  -- ── Guard 3: exactly 2 financial events, payment_imported + refund, matched ─
  SELECT count(*) INTO v_n FROM public.order_financial_events WHERE order_id = TARGET;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'BLOCKED: expected exactly 2 financial events, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.order_financial_events
   WHERE order_id = TARGET AND type IN ('payment_imported','refund');
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'BLOCKED: financial events are not exactly {payment_imported, refund}';
  END IF;

  SELECT amount INTO v_pay FROM public.order_financial_events WHERE order_id = TARGET AND type = 'payment_imported';
  SELECT amount INTO v_ref FROM public.order_financial_events WHERE order_id = TARGET AND type = 'refund';
  IF v_pay IS NULL OR v_ref IS NULL OR v_pay <> v_ref OR v_pay <> v_ord.totale THEN
    RAISE EXCEPTION 'BLOCKED: payment %, refund % and order total % are not coherent', v_pay, v_ref, v_ord.totale;
  END IF;

  IF NOT (v_ord.refunded AND v_ord.ya_pagado) THEN
    RAISE EXCEPTION 'BLOCKED: order is not in the already-refunded state the audit recorded';
  END IF;

  -- The order is already refunded: no void, no compensating event, nothing is
  -- written to the ledger by this script either.

  -- ── Guard 3b: ledger fingerprint, taken before any delete ─────────────────
  -- Deliberately excludes service_session_id: the column is added by the migration
  -- and must stay NULL for legacy rows, which is asserted separately below.
  SELECT md5(string_agg(
           concat_ws('|', id::text, order_id, type, amount::text, coalesce(payment_method,''),
                     coalesce(reason,''), legacy::text, by_actor, by_role,
                     coalesce(prev_estado,''), coalesce(new_estado,''),
                     prev_pay_state, new_pay_state, coalesce(original_giro_id,''),
                     coalesce(ip_hash,''), meta::text, idem_scope_key, payload_digest,
                     created_at::text),
           E'\n' ORDER BY created_at))
    INTO v_ledger_pre
    FROM public.order_financial_events WHERE order_id = TARGET;

  IF v_ledger_pre IS NULL THEN
    RAISE EXCEPTION 'BLOCKED: ledger fingerprint could not be computed';
  END IF;

  IF EXISTS (SELECT 1 FROM public.order_financial_events
              WHERE order_id = TARGET AND service_session_id IS NOT NULL) THEN
    RAISE EXCEPTION 'BLOCKED: legacy events must keep service_session_id NULL';
  END IF;

  -- ── Guard 4: exactly 6 CHIUSO_FORZATO archive rows, and nothing else ──────
  SELECT count(*) INTO v_n FROM public.storico WHERE orden_id = TARGET;
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'BLOCKED: expected exactly 6 storico rows, found %', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.storico WHERE orden_id = TARGET AND estado = 'CHIUSO_FORZATO';
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'BLOCKED: not all 6 storico rows are CHIUSO_FORZATO';
  END IF;

  -- ── Guard 5: no rider trip, no manual giro, no operational audit ──────────
  IF v_ord.repartidor IS NOT NULL OR v_ord.manual_giro_id IS NOT NULL
     OR v_ord.hora_salida IS NOT NULL OR v_ord.hora_entrega IS NOT NULL THEN
    RAISE EXCEPTION 'BLOCKED: order shows rider/giro activity';
  END IF;

  SELECT count(*) INTO v_n FROM public.manual_giros WHERE anchor_order_id = TARGET;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'BLOCKED: order anchors % manual giro(s)', v_n;
  END IF;

  SELECT count(*) INTO v_n FROM public.orden_estado_logs WHERE orden_id = TARGET;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'BLOCKED: order has % operational audit row(s)', v_n;
  END IF;

  -- ── Guard 6: the sibling fixtures must be present and are NOT touched ─────
  SELECT count(*) INTO v_sib FROM public.ordenes WHERE id IN ('B7A2_E2E_A','B7A2_E2E_C');
  IF v_sib <> 2 THEN
    RAISE EXCEPTION 'BLOCKED: expected siblings A and C to exist, found %', v_sib;
  END IF;

  -- ── Guard 7: the FK must already be gone, i.e. the migration is applied ──
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ofe_order_id_fk') THEN
    RAISE EXCEPTION 'BLOCKED: ofe_order_id_fk still present — run this only after the session-identity migration';
  END IF;

  -- ── All guards green: archive rows, then the order. NEVER the ledger. ────
  WITH d AS (DELETE FROM public.storico WHERE orden_id = TARGET RETURNING 1)
    SELECT count(*) INTO v_del_st FROM d;
  WITH d AS (DELETE FROM public.ordenes WHERE id = TARGET RETURNING 1)
    SELECT count(*) INTO v_del_ord FROM d;

  IF v_del_st <> 6 OR v_del_ord <> 1 THEN
    RAISE EXCEPTION 'BLOCKED: delete counts wrong (storico %, order %) — rolling back', v_del_st, v_del_ord;
  END IF;

  -- ── Post-conditions inside the same transaction ───────────────────────────
  IF EXISTS (SELECT 1 FROM public.ordenes WHERE id = TARGET)
     OR EXISTS (SELECT 1 FROM public.storico WHERE orden_id = TARGET) THEN
    RAISE EXCEPTION 'BLOCKED: residue survived the delete — rolling back';
  END IF;

  -- The ledger must be bit-for-bit what it was before, still 2 rows, still legacy.
  SELECT md5(string_agg(
           concat_ws('|', id::text, order_id, type, amount::text, coalesce(payment_method,''),
                     coalesce(reason,''), legacy::text, by_actor, by_role,
                     coalesce(prev_estado,''), coalesce(new_estado,''),
                     prev_pay_state, new_pay_state, coalesce(original_giro_id,''),
                     coalesce(ip_hash,''), meta::text, idem_scope_key, payload_digest,
                     created_at::text),
           E'\n' ORDER BY created_at))
    INTO v_ledger_post
    FROM public.order_financial_events WHERE order_id = TARGET;

  IF v_ledger_post IS DISTINCT FROM v_ledger_pre THEN
    RAISE EXCEPTION 'BLOCKED: financial evidence changed (% -> %) — rolling back', v_ledger_pre, v_ledger_post;
  END IF;

  SELECT count(*) INTO v_n FROM public.order_financial_events WHERE order_id = TARGET;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'BLOCKED: expected the 2 ledger events to survive, found % — rolling back', v_n;
  END IF;

  IF EXISTS (SELECT 1 FROM public.order_financial_events
              WHERE order_id = TARGET AND service_session_id IS NOT NULL) THEN
    RAISE EXCEPTION 'BLOCKED: a session was assigned to legacy evidence — rolling back';
  END IF;

  SELECT count(*) INTO v_sib FROM public.ordenes WHERE id IN ('B7A2_E2E_A','B7A2_E2E_C');
  IF v_sib <> 2 THEN
    RAISE EXCEPTION 'BLOCKED: sibling fixtures were affected — rolling back';
  END IF;

  RAISE NOTICE 'CLEANUP OK: % — % storico rows + 1 order removed; 2 ledger events preserved, fingerprint %', TARGET, v_del_st, v_ledger_post;
END $$;

COMMIT;
