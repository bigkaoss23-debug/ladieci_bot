-- migrations/2026-09-11_economic_writer_hardening_v1_migration_126.sql
-- ECONOMIC_WRITER_HARDENING_V1 -- SLICE 1: FENCE + LOCK.
--
-- AUTHORITY: ECONOMIC_WRITER_UNIFICATION_LEGACY_RETIREMENT_AUDIT_V1.md (2026-09-10/11,
-- READ-ONLY forensic against BE 36d5efa / FE 4eaf8a8, staging ledger tip 125). Verdict
-- ECONOMIC_WRITER_UNIFICATION_REQUIRES_TARGETED_HARDENING_PLAN. GLOBAL_WRITER_HARDENING_GO
-- = YES; MESA_CANONICAL_UNPAID_CANDIDATE_VALID = YES; NEW_UAT_CAMPAIGN_GO = NO.
--
-- WHAT THE AUDIT PROVED. The canonical Economic Core already exists and is already shared:
-- one obligation authority (order_obligations via order_canonical_obligation_v1), one
-- adjustment/cancellation core (order_obligation_apply_adjustment_v1), two payment writers
-- with equivalent invariants for their own domain (mesa_post_payment_v1 for tables,
-- order_post_payment_v1 for Servicio/Banco/Retiro). Nothing here is redesigned. The
-- blocker is a SECOND, unfenced money family -- legacy OFE-only writers that skip the
-- canonical obligation, are not workspace-scoped, and are still reachable:
--   * `_ledger_write_payment` (via `order_mark_paid` and the rider RPC) incasses
--     `ordenes.totale`, never the canonical obligation -- overcharges after a commercial
--     adjustment (F-1/F-2) and, on Mesa, races mesa_post_payment_v1 for a double
--     collection (N-5 blocker L-1: Mesa's own payment writer only locks `ordenes` at the
--     very end of its transaction).
--   * `order_void` duplicates `order_cancel_v1`'s cancellation core with a weaker pay-state
--     inference and no Mesa fence.
--   * generic order editors (`modificaOrdine` / `updateOrden` / `cambiaStato` descuento /
--     `aggiungiItems`) can still rewrite `totale`/`items`/`delivery_fee`/`descuento_*` on a
--     Mesa order, on an already-adjusted order (silently erasing the adjustment, F-3a) or on
--     an already-cancelled order (resurrecting the obligation, F-3b).
--   * `complete_rider_stop` is dead code that ledger row 37 already claims (falsely) is
--     dropped -- it is still live on staging (F-6).
--
-- WHAT THIS MIGRATION DOES (all additive/defensive; no redesign, no new table, no backfill,
-- 0 rows in violation today per the audit's own live count):
--   E-1  NEW global fence: a BEFORE UPDATE trigger on `ordenes` that refuses to move the
--        economic basis (totale/items/delivery_fee/descuento_*) when the order is Mesa-
--        owned, already carries a commercial-adjustment/cancellation revision, or is
--        already cancelled/annulled. Ordinary pre-payment, non-Mesa, non-adjusted edits are
--        untouched -- this is a NARROWER sibling of N-5 (2026-08-24), which guards paid
--        orders; this one guards Mesa/adjusted/cancelled orders, on the SAME six columns
--        plus `items` (N-5 deliberately left `items` out for Post-send Editing V2; that
--        decision is untouched for the paid case, but Mesa/adjusted/cancelled orders never
--        legitimately need an item edit at all, so `items` is in scope here).
--   E-2  `_ledger_write_payment` refuses Mesa orders and any order whose canonical
--        obligation has diverged from `ordenes.totale` -- closes F-1/F-2 at the root,
--        because every reachable caller of the legacy family (rider, `order_mark_paid`)
--        goes through this one function.
--   Retirement stubs: `order_mark_paid` and `order_void` no longer do anything -- they
--        raise a typed, stable refusal on every call. Both have zero live FE callers
--        (audit ¬ß9/¬ß23/¬ß26) and a canonical replacement already exists for every reachable
--        path. Neither is DROPped yet (kept for any caller still holding the old contract;
--        Slice 4 deletes them after an observation window).
--   Defense: `order_import_legacy_payment` and `order_refund` refuse Mesa orders (neither
--        has a live caller today; both stay ACTIVE_LEGACY_REQUIRED for historical/OFE-only
--        money per the audit -- this migration only narrows their blast radius).
--   Patch B: `mesa_post_payment_v1` now locks every `ordenes` row of the table session
--        (`ORDER BY id`, deterministic) immediately after the session lock and BEFORE the
--        first obligation/outstanding computation -- closing N-5 blocker L-1 without
--        touching any payment formula, allocation rule, idempotency key or refund path.
--   Defense: `order_post_payment_v1` refuses a cancelled/annulled order before creating any
--        payment_transaction, allocation, OFE row or mirror update.
--   F-6: `complete_rider_stop(text, boolean, text)` is DROPped. Zero runtime callers (not
--        in `supabaseResourcePolicy.js`, no JS/SQL caller, only referenced in comments);
--        ledger row 37 already claims this happened and is registered `bootstrapped_
--        unverified` -- this migration performs the drop for real and is registered as its
--        own new ledger row, not a rewrite of row 37.
--   Hygiene: `order_has_economic_evidence_v1(text)` had EXECUTE granted directly to `anon`
--        and `authenticated` (Supabase's default-privilege ACL grants EXECUTE to those
--        roles on every new function unless explicitly revoked BY NAME -- a prior REVOKE
--        FROM PUBLIC on this same function, migration 116/ledger 116, did not touch it,
--        which is exactly why this migration revokes anon/authenticated explicitly rather
--        than relying on FROM PUBLIC alone). It is a read-only boolean predicate used only
--        by the two delete-guard RPCs (service_role); anon/authenticated never legitimately
--        call it directly.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (frozen non-goals, per the audit's own
-- sequencing -- see ¬ß31 Slice 3/4):
--   * Does NOT touch the rider's writer contract. `rider_collect_and_complete_stop` keeps
--     calling `_ledger_write_payment` exactly as before; E-2 fences the SAME function, so
--     the rider path is narrowed (Mesa/diverged-obligation orders refused) but the normal
--     rider collection (obligation == totale, non-Mesa) is BYTE-FOR-BYTE unchanged. Rider
--     canonicalization (PT-backed, `by_role='rider'`, outstanding-based amount, "ya pagado"
--     completion) is Slice 3 (migration 127), NOT this slice.
--   * Does NOT touch `payment_transactions_by_role_check`, idempotency key derivation
--     (`pay-order-<#NNN>` / `cancel-order-<#NNN>`, F-4/F-4b) or the paid-at-creation lock
--     order (F-5). All Slice 3.
--   * Does NOT DROP `order_mark_paid`, `order_void`, `_ledger_write_payment`,
--     `order_import_legacy_payment` or `order_refund`. Retirement-to-deletion is Slice 4,
--     after an observation window with zero calls.
--   * Does NOT touch `ya_pagado` / `cobrado` / `metodo_pago` mirrors, `order_financial_events`
--     structure, RLS, or any table/column/index. Zero new tables. Zero backfill.
--   * Does NOT change Mesa payment formulas, allocation rules, covers/line selection,
--     idempotency or refund semantics -- Patch B is a LOCK ONLY, inserted before the first
--     read that must not move.
--
-- STAGING ONLY. NOT APPLIED IN THIS COMMIT (NO PUSH / NO DEPLOY / NO STAGING DB APPLY / NO
-- DB WRITE). Ledger stays 125 until a separate promotion authorization. DO blocks use named
-- tags ($guard$ / $post$), never a bare $$ -- house style, see migrations 121-125.
--
-- NOT EXECUTED IN THIS SESSION: this migration's exact SQL has never been run against any
-- Postgres instance, live or local -- same reported tooling limitation this project has
-- carried since ledger row 57 (2026-08-09). Every function body this file installs is
-- reproduced VERBATIM from `pg_get_functiondef` read live against staging
-- (tdikhfeinufaahagmpjz) in this same session, with only the documented insertions added,
-- so it is not a reconstruction from a possibly-drifted repo copy.

BEGIN;

-- ── PRE-CONDITION: baseline + double-apply guard ─────────────────────────────
DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'order_economic_basis_lock_v1') THEN
    RAISE EXCEPTION 'M126 refused: order_economic_basis_lock_v1 already exists -- already patched, resolve drift first';
  END IF;

  IF to_regclass('public.ladieci_schema_migrations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 125) THEN
      RAISE EXCEPTION 'M126 refused: ladieci_schema_migrations has no apply_order=125 row -- baseline is not 125';
    END IF;
    IF EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 126) THEN
      RAISE EXCEPTION 'M126 refused: ladieci_schema_migrations already has an apply_order=126 row -- already applied?';
    END IF;
  END IF;

  -- Every object this migration mutates must already exist -- refuse on drift rather
  -- than silently creating a new one under a changed contract.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = '_ledger_write_payment') THEN
    RAISE EXCEPTION 'M126 refused: _ledger_write_payment is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_mark_paid') THEN
    RAISE EXCEPTION 'M126 refused: order_mark_paid is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_void') THEN
    RAISE EXCEPTION 'M126 refused: order_void is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_import_legacy_payment') THEN
    RAISE EXCEPTION 'M126 refused: order_import_legacy_payment is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_refund') THEN
    RAISE EXCEPTION 'M126 refused: order_refund is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'mesa_post_payment_v1') THEN
    RAISE EXCEPTION 'M126 refused: mesa_post_payment_v1 is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_post_payment_v1') THEN
    RAISE EXCEPTION 'M126 refused: order_post_payment_v1 is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'complete_rider_stop') THEN
    RAISE EXCEPTION 'M126 refused: complete_rider_stop is missing -- already dropped? resolve drift first (do not re-apply row 37)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_has_economic_evidence_v1') THEN
    RAISE EXCEPTION 'M126 refused: order_has_economic_evidence_v1 is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_canonical_obligation_v1') THEN
    RAISE EXCEPTION 'M126 refused: order_canonical_obligation_v1 (N-2) is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname = 'ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'M126 refused: the N-5 guard trigger is missing -- resolve drift first';
  END IF;

  -- Structural snapshot for the post-condition: this migration must leave the PUBLIC
  -- function count, the ordenes trigger count, and every money-table row count exactly as
  -- they are now except for +1 function (order_economic_basis_lock_v1) and -1 function
  -- (complete_rider_stop dropped) -- net zero -- and +1 trigger on ordenes.
  PERFORM set_config('ladieci.m126_public_fn_count',
    (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'), false);
  PERFORM set_config('ladieci.m126_ordenes_trigger_count',
    (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND NOT tgisinternal), false);
  PERFORM set_config('ladieci.m126_ordenes_row_count',
    (SELECT count(*)::text FROM public.ordenes), false);
  PERFORM set_config('ladieci.m126_obligations_row_count',
    (SELECT count(*)::text FROM public.order_obligations), false);
  PERFORM set_config('ladieci.m126_payment_tx_row_count',
    (SELECT count(*)::text FROM public.payment_transactions), false);
  PERFORM set_config('ladieci.m126_ofe_row_count',
    (SELECT count(*)::text FROM public.order_financial_events), false);
END $guard$;

-- ═════════════════════════════════════════════════════════════════════════════
-- E-1 -- GLOBAL ECONOMIC BASIS FENCE (new trigger, additive)
-- ═════════════════════════════════════════════════════════════════════════════
-- Sibling of N-5 (2026-08-24, paid_order_economic_mutation_guard_v1), same shape: fires
-- only when an economic column's VALUE actually moves (IS DISTINCT FROM, never column
-- presence -- so a same-value rewrite, e.g. W1 recomputing totale to the identical number
-- on an hora-only edit, passes untouched), and refuses with a typed, DETAIL-bearing
-- exception. N-5 asks "has this order ever been paid?"; this asks three independent
-- questions, any one of which locks the basis:
--   (a) is this a Mesa order at all (`table_session_id IS NOT NULL`)? Mesa's own economic
--       basis is the immutable per-line snapshot (table_order_lines) plus the canonical
--       adjustment/cancellation core -- a generic column editor must never touch it,
--       whether paid or not (today's W2 gap the audit's ¬ß6/¬ß26 named unfenced).
--   (b) does this order already carry a commercial-adjustment or cancellation revision
--       (`order_obligations.source = 'order_commercial_adjustment_v1'`, cause `manual` or
--       `order_cancellation`)? A later raw edit recomputing `totale` would silently erase
--       the adjustment (F-3a) or resurrect a cancelled order's obligation (F-3b).
--   (c) is the order already CANCELADO/CANCELLED/ANULADO (checked on OLD and NEW, same
--       one-statement hostile case N-5 already defends against)? A cancelled order has
--       nothing left to edit economically.
-- Ordinary, non-Mesa, non-adjusted, non-cancelled edits -- the entire legitimate pre-payment
-- editing surface (Servicio/Banco/Retiro before any adjustment, cancellation or Mesa
-- involvement) -- are completely untouched: none of (a)/(b)/(c) hold, so the function
-- returns NEW immediately without even reading order_obligations.
CREATE OR REPLACE FUNCTION public.order_economic_basis_lock_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_field text;
  v_old   text;
  v_new   text;
BEGIN
  IF NEW.totale IS DISTINCT FROM OLD.totale THEN
    v_field := 'totale'; v_old := OLD.totale::text; v_new := NEW.totale::text;
  ELSIF NEW.items IS DISTINCT FROM OLD.items THEN
    v_field := 'items'; v_old := OLD.items::text; v_new := NEW.items::text;
  ELSIF NEW.delivery_fee IS DISTINCT FROM OLD.delivery_fee THEN
    v_field := 'delivery_fee'; v_old := OLD.delivery_fee::text; v_new := NEW.delivery_fee::text;
  ELSIF NEW.descuento_tipo IS DISTINCT FROM OLD.descuento_tipo THEN
    v_field := 'descuento_tipo'; v_old := OLD.descuento_tipo; v_new := NEW.descuento_tipo;
  ELSIF NEW.descuento_valor IS DISTINCT FROM OLD.descuento_valor THEN
    v_field := 'descuento_valor'; v_old := OLD.descuento_valor::text; v_new := NEW.descuento_valor::text;
  ELSIF NEW.descuento_importe IS DISTINCT FROM OLD.descuento_importe THEN
    v_field := 'descuento_importe'; v_old := OLD.descuento_importe::text; v_new := NEW.descuento_importe::text;
  ELSE
    -- Nothing economic moved: a state-only / metadata-only update, or an identical
    -- rewrite. Never this guard's business -- and no order_obligations read either.
    RETURN NEW;
  END IF;

  IF OLD.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_ECONOMIC_BASIS_LOCKED'
      USING ERRCODE = 'P0001',
            DETAIL  = format('order_id=%s field=%s old=%s new=%s table_session_id=%s',
                             OLD.id, v_field, COALESCE(v_old, '<null>'), COALESCE(v_new, '<null>'), OLD.table_session_id),
            HINT    = 'This is a Mesa order. Its economic basis is owned by the table-session commands and the canonical adjustment/cancellation core, never by a generic editor.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.order_obligations ob
              WHERE ob.order_uid = OLD.order_uid
                AND ob.source = 'order_commercial_adjustment_v1') THEN
    RAISE EXCEPTION 'ORDER_ECONOMIC_BASIS_LOCKED'
      USING ERRCODE = 'P0001',
            DETAIL  = format('order_id=%s field=%s old=%s new=%s order_uid=%s',
                             OLD.id, v_field, COALESCE(v_old, '<null>'), COALESCE(v_new, '<null>'), OLD.order_uid),
            HINT    = 'This order already carries a commercial adjustment or cancellation revision. Its economic basis can only change through that same canonical core, never through a generic editor.';
  END IF;

  IF upper(COALESCE(OLD.estado, '')) IN ('CANCELADO', 'CANCELLED', 'ANULADO')
     OR upper(COALESCE(NEW.estado, '')) IN ('CANCELADO', 'CANCELLED', 'ANULADO')
  THEN
    RAISE EXCEPTION 'ORDER_ECONOMIC_BASIS_LOCKED'
      USING ERRCODE = 'P0001',
            DETAIL  = format('order_id=%s field=%s old=%s new=%s estado=%s',
                             OLD.id, v_field, COALESCE(v_old, '<null>'), COALESCE(v_new, '<null>'), OLD.estado),
            HINT    = 'This order is cancelled/annulled. Its economic basis is frozen at cancellation.';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.order_economic_basis_lock_v1() IS
  'Economic Writer Hardening V1 (E-1, migration 126). Refuses any UPDATE on public.ordenes that MOVES the economic basis (totale, items, delivery_fee, descuento_tipo/valor/importe) when the order is Mesa-owned (table_session_id IS NOT NULL), already carries a commercial-adjustment/cancellation revision (order_obligations.source = order_commercial_adjustment_v1), or is already CANCELADO/CANCELLED/ANULADO (checked on OLD and NEW). Compares OLD vs NEW values, never column presence. Sibling of N-5 (paid_order_economic_mutation_guard_v1), which guards the orthogonal case of an already-PAID order. Ordinary pre-payment, non-Mesa, non-adjusted, non-cancelled edits pass untouched.';

CREATE TRIGGER ordenes_order_economic_basis_lock_v1
  BEFORE UPDATE OF totale, items, delivery_fee, descuento_tipo, descuento_valor, descuento_importe
  ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_economic_basis_lock_v1();

REVOKE ALL ON FUNCTION public.order_economic_basis_lock_v1() FROM PUBLIC, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- E-2 -- LEGACY MONEY FENCE on _ledger_write_payment
-- ═════════════════════════════════════════════════════════════════════════════
-- Body reproduced verbatim from the live catalog (tdikhfeinufaahagmpjz, this session),
-- with exactly one insertion: the two typed refusals below, placed immediately after the
-- order row is fetched and locked, before anything else (including the idempotency replay
-- lookup) is even considered. Every other line -- validation order, replay digest,
-- canonical digest, the INSERT, the mirror UPDATE -- is untouched byte-for-byte.
CREATE OR REPLACE FUNCTION public._ledger_write_payment(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_by_role text, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text := p_by_role; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NOT NULL AND btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := CASE WHEN p_reason IS NULL THEN NULL ELSE btrim(p_reason) END;

  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_role IS NULL OR btrim(v_role) = '' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- E-2 (Economic Writer Hardening V1, migration 126). This legacy family is the only
  -- payment authority that incasses ordenes.totale instead of the canonical obligation
  -- (F-1/F-2 of the audit). Refuse BEFORE the idempotency replay lookup or anything else:
  --   (a) Mesa orders have their own canonical, per-line writer (mesa_post_payment_v1) and
  --       must never be reachable by an unfenced legacy path (N-5 blocker L-1);
  --   (b) any order whose canonical obligation has diverged from totale (a commercial
  --       adjustment or a cancellation happened) would be over- or under-charged by a
  --       totale-based collection.
  -- The normal, still-required rider path (non-Mesa, obligation == totale, no adjustment)
  -- is completely unaffected: both conditions below are false for it.
  IF v_ord.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_COLLECTION_NOT_ALLOWED' USING ERRCODE='22023',
      DETAIL = format('order_id=%s is Mesa-owned (table_session_id=%s) -- legacy OFE-only collection is not permitted on table orders', p_order_id, v_ord.table_session_id);
  END IF;
  IF round(public.order_canonical_obligation_v1(v_ord.order_uid), 2) IS DISTINCT FROM round(v_ord.totale, 2) THEN
    RAISE EXCEPTION 'LEGACY_COLLECTION_NOT_ALLOWED' USING ERRCODE='22023',
      DETAIL = format('order_id=%s canonical_obligation=%s totale=%s -- legacy collection refused: the canonical obligation has diverged from the order total',
                       p_order_id, round(public.order_canonical_obligation_v1(v_ord.order_uid), 2), round(v_ord.totale, 2));
  END IF;

  -- Same-scope replay is based on immutable event snapshots, not mutable order fields.
  -- Scoped by service_session_id (IS NOT DISTINCT FROM handles the legacy NULL-session
  -- case) to match the partitioned unique indexes from 2026-07-26_two_service_identity.sql
  -- (order_financial_events_one_payment_session_uq / _legacy_uq): an order id/number
  -- recycled into a LATER service session must never match an EARLIER session's event.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'payment'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM false
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_existing.amount, 'payment_method', v_method, 'legacy', false))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    -- A different actor/role/amount under the same key is a genuine conflict, never a
    -- silent second charge. This is what refuses a rider collection followed by an
    -- operator one on the same order.
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  -- SERVER-DERIVED amount. No caller — Node, rider or operator — can supply or override it.
  v_amount := round(v_ord.totale, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  -- Key order and value types are byte-significant: the digest is sha256 over the jsonb
  -- text. Reproduced EXACTLY as in 2026-07-19_b7_payment_basis_historical_replay_fix.sql.
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  -- Same session-scoping as the replay check above: one basis per order PER SESSION, so a
  -- recycled order id/number starts a fresh basis in a later session instead of colliding
  -- with a since-archived one.
  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE THEN
    RAISE EXCEPTION 'AUTH_LEGACY_IMPORT_REQUIRED' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment', v_amount, v_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method
   WHERE id = p_order_id;

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

-- ═════════════════════════════════════════════════════════════════════════════
-- RETIREMENT STUBS -- order_mark_paid, order_void
-- ═════════════════════════════════════════════════════════════════════════════
-- Signature, parameter names, defaults (none on either function) and grants are all
-- unchanged -- CREATE OR REPLACE on the identical signature preserves every existing
-- grant. Neither function is DROPped: Slice 4 removes them after an observation window.
CREATE OR REPLACE FUNCTION public.order_mark_paid(p_order_id text, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- RETIREMENT STUB (Economic Writer Hardening V1, migration 126). order_mark_paid
  -- delegated to _ledger_write_payment -- the same OFE-only, totale-based legacy authority
  -- E-2 above just fenced. Zero live FE callers (audit: DORMANT_BUT_REACHABLE, and
  -- dangerous on Mesa -- N-5 blocker L-1); a canonical replacement already exists for every
  -- reachable path (order_post_payment_v1 via Cash V1, mesa_post_payment_v1 via Mesa API).
  -- This function creates NO money under any input, unconditionally.
  RAISE EXCEPTION 'LEGACY_OPERATOR_COLLECTION_RETIRED' USING ERRCODE='22023',
    DETAIL = format('order_id=%s -- order_mark_paid is retired and creates no money', p_order_id),
    HINT = 'Use the canonical cash path: order_post_payment_v1 (Cash V1 API) or mesa_post_payment_v1 (Mesa API).';
END;
$function$;

CREATE OR REPLACE FUNCTION public.order_void(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- RETIREMENT STUB (Economic Writer Hardening V1, migration 126). order_void duplicated
  -- order_cancel_v1's cancellation core with a weaker pay-state inference (first event
  -- wins) and no Mesa fence -- a race hazard the audit classed DORMANT_BUT_REACHABLE with
  -- zero live events. This function changes NO order's state or obligation, unconditionally.
  RAISE EXCEPTION 'LEGACY_VOID_RETIRED_USE_ORDER_CANCEL' USING ERRCODE='22023',
    DETAIL = format('order_id=%s -- order_void is retired', p_order_id),
    HINT = 'Cancel through order_cancel_v1 (updateEstado / cambiaStato with estado=CANCELADO), the canonical cancellation core shared by Mesa and Nuevo Pedido.';
END;
$function$;

-- ═════════════════════════════════════════════════════════════════════════════
-- IMPORT / REFUND MESA FENCE -- order_import_legacy_payment, order_refund
-- ═════════════════════════════════════════════════════════════════════════════
-- Both stay ACTIVE_LEGACY_REQUIRED (historical OFE-only money, per the audit) -- only a
-- Mesa-order refusal is added, in the same place both functions already fetch+lock the
-- order row. Every other line is reproduced verbatim from the live catalog.
CREATE OR REPLACE FUNCTION public.order_import_legacy_payment(p_order_id text, p_amount numeric, p_payment_method text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text, p_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by public.auth_actors%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE;
  v_existing_basis public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_method text; v_reason text; v_amount numeric(10,2);
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  v_method := lower(btrim(COALESCE(p_payment_method, '')));
  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN RAISE EXCEPTION 'AUTH_METHOD_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  v_amount := round(p_amount, 2);
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'AUTH_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  IF p_confirm IS DISTINCT FROM 'IMPORT_LEGACY_PAYMENT' THEN RAISE EXCEPTION 'AUTH_CONFIRMATION_REQUIRED' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Economic Writer Hardening V1 (migration 126) -- Mesa orders are settled exclusively
  -- through mesa_post_payment_v1/mesa_post_refund_v1; there is no legacy pre-ledger money
  -- to import on a table order (0 live cases), and importing one would create a second,
  -- unfenced money fact beside the canonical per-line ledger.
  IF v_ord.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'AUTH_MESA_ORDER_NOT_ALLOWED' USING ERRCODE='22023',
      DETAIL = format('order_id=%s is Mesa-owned (table_session_id=%s) -- legacy import is not permitted on table orders', p_order_id, v_ord.table_session_id);
  END IF;

  -- N-6 — financial ownership must be provable before any historical money is imported.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;

  -- Same-scope replay is based on immutable event snapshots plus current request amount/method/reason.
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'payment_imported' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'payment_imported'
       OR v_existing.amount IS NULL OR v_existing.amount <= 0
       OR v_existing.payment_method NOT IN ('efectivo','tarjeta','bizum')
       OR v_existing.legacy IS DISTINCT FROM true
       OR v_existing.prev_pay_state <> 'unpaid' OR v_existing.new_pay_state <> 'paid'
       OR v_existing.prev_estado IS DISTINCT FROM v_existing.new_estado
       OR v_existing.original_giro_id IS NOT NULL
    THEN RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;

    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', v_amount, 'payment_method', v_method, 'legacy', true))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;

  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'payment_imported', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'unpaid', 'new_pay_state', 'paid',
    'amount', v_amount, 'payment_method', v_method, 'legacy', true);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));

  SELECT * INTO v_existing_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AUTH_BASIS_EXISTS' USING ERRCODE='22023';
  END IF;

  IF NOT (v_ord.ya_pagado IS TRUE OR v_ord.cobrado IS TRUE) THEN
    RAISE EXCEPTION 'AUTH_NOT_LEGACY_PAID' USING ERRCODE='22023';
  END IF;

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'payment_imported', v_amount, v_method, v_reason, true, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'unpaid', 'paid', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  UPDATE public.ordenes SET ya_pagado = true, cobrado = true, metodo_pago = v_method
   WHERE id = p_order_id;

  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.order_refund(p_order_id text, p_reason text, p_by_actor text, p_session_version integer, p_ip_hash text, p_meta jsonb, p_idem_scope_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_basis public.order_financial_events%ROWTYPE; v_existing public.order_financial_events%ROWTYPE;
  v_existing_refund public.order_financial_events%ROWTYPE; v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_canon jsonb; v_digest text; v_replay_digest text;
BEGIN
  IF jsonb_typeof(v_meta) <> 'object' THEN RAISE EXCEPTION 'AUTH_META_INVALID' USING ERRCODE='22023'; END IF;
  IF length(v_meta::text) > 2048 THEN RAISE EXCEPTION 'AUTH_META_TOO_LARGE' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
       'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
       'recovery_secret','authorization','api_key','apikey','bearer','cookie','raw_ip','confirmation']))
  THEN RAISE EXCEPTION 'AUTH_META_SENSITIVE_KEY' USING ERRCODE='22023'; END IF;
  IF p_ip_hash IS NULL OR btrim(p_ip_hash) = '' THEN RAISE EXCEPTION 'AUTH_IP_HASH_REQUIRED' USING ERRCODE='22023'; END IF;
  IF length(p_ip_hash) > 64 THEN RAISE EXCEPTION 'AUTH_IP_HASH_TOO_LONG' USING ERRCODE='22023'; END IF;
  IF p_idem_scope_key IS NULL OR char_length(p_idem_scope_key) < 8 OR char_length(p_idem_scope_key) > 128
     OR p_idem_scope_key !~ '^[A-Za-z0-9_-]+$'
  THEN RAISE EXCEPTION 'AUTH_IDEM_KEY_INVALID' USING ERRCODE='22023'; END IF;
  IF p_session_version IS NULL OR p_session_version < 1 THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'AUTH_REASON_BLANK' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);
  SELECT * INTO v_by FROM public.auth_actors WHERE actor = p_by_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ACTOR_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_by.active <> true THEN RAISE EXCEPTION 'AUTH_INITIATOR_INACTIVE' USING ERRCODE='22023'; END IF;
  v_role := v_by.role;
  IF v_role <> 'admin' THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Economic Writer Hardening V1 (migration 126) -- Mesa orders are refunded exclusively
  -- through mesa_post_refund_v1 (a reversal of an exact payment_transaction). This legacy
  -- "first basis" refund has no way to name a transaction and must never touch a table
  -- order's per-line settlement.
  IF v_ord.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'AUTH_MESA_ORDER_NOT_ALLOWED' USING ERRCODE='22023',
      DETAIL = format('order_id=%s is Mesa-owned (table_session_id=%s) -- legacy refund is not permitted on table orders, use mesa_post_refund_v1', p_order_id, v_ord.table_session_id);
  END IF;

  -- N-6 — financial ownership must be provable before any money is touched.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;
  -- REFUND V1 §J.1 — refuse, never delegate. order_refund has no amount parameter
  -- and no way to name a transaction, so delegating to mesa_post_refund_v1 would
  -- mean GUESSING which payment and how much — the exact defect this closes.
  -- Keyed on transaction-backed EVIDENCE, not on table_session_id: a non-Mesa order
  -- can never carry a payment_transaction_id, so this changes nothing for legacy
  -- non-Mesa orders.
  IF EXISTS (SELECT 1 FROM public.order_financial_events e
              WHERE e.order_id = p_order_id
                AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
                AND e.payment_transaction_id IS NOT NULL)
  THEN RAISE EXCEPTION 'AUTH_REFUND_TRANSACTION_BACKED' USING ERRCODE='22023',
    DETAIL = format('order_id=%s settled through payment_transactions -- use mesa_post_refund_v1', p_order_id);
  END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    SELECT * INTO v_basis FROM public.order_financial_events
      WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
        AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
      ORDER BY created_at ASC LIMIT 1;
    IF NOT FOUND OR v_basis.amount IS DISTINCT FROM v_existing.amount
       OR v_basis.payment_method IS DISTINCT FROM v_existing.payment_method
    THEN RAISE EXCEPTION 'AUTH_REFUND_BASIS_INTEGRITY' USING ERRCODE='22023'; END IF;
    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', v_existing.order_id, 'type', 'refund', 'idem_scope_key', v_existing.idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'basis_event_id', v_basis.id, 'amount', v_existing.amount,
      'payment_method', v_existing.payment_method, 'legacy', v_existing.legacy))::text, 'UTF8')), 'hex'));
    IF v_existing.payload_digest = v_replay_digest THEN
      RETURN jsonb_build_object('event_id', v_existing.id, 'order_id', v_existing.order_id,
        'type', v_existing.type, 'amount', v_existing.amount, 'payment_method', v_existing.payment_method,
        'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
        'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
        'legacy', v_existing.legacy, 'original_giro_id', v_existing.original_giro_id,
        'idempotent', true, 'created_at', v_existing.created_at);
    END IF;
    RAISE EXCEPTION 'AUTH_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_basis FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_NO_PAYMENT_BASIS' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_existing_refund FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'refund'
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY created_at ASC LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION 'AUTH_ALREADY_REFUNDED' USING ERRCODE='22023'; END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'refund', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', v_ord.estado,
    'prev_pay_state', 'paid', 'new_pay_state', 'refunded',
    'basis_event_id', v_basis.id, 'amount', v_basis.amount,
    'payment_method', v_basis.payment_method, 'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'refund', v_basis.amount, v_basis.payment_method, v_reason, false, p_by_actor, v_role,
    v_ord.estado, v_ord.estado, 'paid', 'refunded', NULL,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;
  UPDATE public.ordenes SET refunded = true WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$function$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PATCH B -- mesa_post_payment_v1 EARLY ORDER LOCK (closes N-5 blocker L-1)
-- ═════════════════════════════════════════════════════════════════════════════
-- Body reproduced verbatim from the live catalog, with exactly one insertion: a
-- deterministic FOR UPDATE lock on every ordenes row of the table session, placed
-- immediately after the covers_total check and BEFORE the first obligation/outstanding
-- computation (v_total_cents). No payment formula, allocation rule, mode, idempotency key,
-- duplicate-candidate window or refund/mirror semantic is touched.
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_covers_settled integer DEFAULT NULL::integer, p_line_ids uuid[] DEFAULT NULL::uuid[], p_meta jsonb DEFAULT '{}'::jsonb, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE; v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE; v_tx public.payment_transactions%ROWTYPE;
  v_line record; v_order record; v_total_cents bigint; v_paid_cents bigint; v_outstanding_cents bigint;
  v_amount_cents bigint; v_to_allocate_cents bigint; v_line_remaining_cents bigint; v_allocation_cents bigint;
  v_remaining_covers integer; v_covers_settled integer; v_selected_count integer; v_selected_distinct integer;
  v_selected_matched integer; v_scope text; v_prev_state text; v_new_state text; v_order_total_cents bigint;
  v_order_paid_before_cents bigint; v_order_allocation_cents bigint; v_table_remaining_cents bigint;
  v_order_caps jsonb := '{}'::jsonb; v_order_cap_cents bigint; v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb); v_duplicate_candidate boolean; v_receipt_service_id uuid;
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
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled);
  END IF;
  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;
  IF v_session.covers_total IS NULL THEN RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000'; END IF;

  -- PATCH B (Economic Writer Hardening V1, migration 126; closes N-5 blocker L-1). Lock
  -- every ordenes row of this table session BEFORE the first obligation/outstanding
  -- computation below, in the SAME deterministic order (id) every lock-ordering analysis
  -- in this codebase relies on, so the economic anchor cannot move between this snapshot
  -- and the allocation loop later in this function. Previously this writer only locked
  -- table_sessions and left `ordenes` unlocked until its own final UPDATE at the very end
  -- of the transaction -- exactly the race the legacy writer (E-2) and a raw editor (E-1)
  -- could win against. No payment formula, allocation rule, mode, idempotency key or
  -- refund/mirror semantic changes below this line.
  PERFORM 1 FROM public.ordenes o
   WHERE o.table_session_id = v_session.id
   ORDER BY o.id
   FOR UPDATE;

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
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'MESA_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;
  SELECT v_session.covers_total - COALESCE(sum(
    CASE WHEN kind='payment' THEN covers_settled ELSE -covers_settled END
  ), 0)::integer INTO v_remaining_covers
    FROM public.payment_transactions WHERE table_session_id = v_session.id;
  v_remaining_covers := GREATEST(0, v_remaining_covers);
  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents; v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023'; END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED');
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESA_LINE_SELECTION_INVALID' USING ERRCODE='22023'; END IF;
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
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
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
  IF v_amount_cents = v_outstanding_cents THEN v_covers_settled := v_remaining_covers; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions pt
     WHERE pt.table_session_id = v_session.id
       AND pt.client_request_id <> p_client_request_id
       AND pt.kind = 'payment' AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0) AND pt.payment_method = p_payment_method
       AND pt.covers_settled = v_covers_settled
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;
  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'MESA_POSSIBLE_DUPLICATE_PAYMENT' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('PAYMENT_DUPLICATE_CONFIRMED', NULL, p_by_actor,
      jsonb_build_object('tableSessionId', v_session.id, 'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0, 'mode', p_mode, 'paymentMethod', p_payment_method,
        'coversSettled', v_covers_settled));
  END IF;
  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;
  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_receipt_service_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, v_covers_settled,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;
  v_to_allocate_cents := v_amount_cents;
  FOR v_line IN
    SELECT l.id, l.order_id, l.net_amount, o.order_uid,
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
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED')
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_allocate_cents <= 0;
    v_line_remaining_cents := v_line.remaining_cents;
    IF v_line_remaining_cents <= 0 THEN CONTINUE; END IF;
    IF NOT (v_order_caps ? v_line.order_id) THEN
      v_order_cap_cents := GREATEST(0,
        round(public.order_canonical_obligation_v1(v_line.order_uid) * 100)::bigint
        - COALESCE((
            SELECT sum(CASE WHEN t.kind='refund' THEN -round(a.amount*100)::bigint
                            ELSE round(a.amount*100)::bigint END)
              FROM public.payment_allocations a
              JOIN public.payment_transactions t ON t.id=a.payment_transaction_id
             WHERE a.order_id = v_line.order_id AND t.table_session_id = v_session.id
          ), 0));
      v_order_caps := v_order_caps || jsonb_build_object(v_line.order_id, v_order_cap_cents);
    END IF;
    v_order_cap_cents := (v_order_caps->>v_line.order_id)::bigint;
    IF v_order_cap_cents <= 0 THEN CONTINUE; END IF;
    v_allocation_cents := LEAST(v_to_allocate_cents, v_line_remaining_cents, v_order_cap_cents);
    IF v_allocation_cents <= 0 THEN CONTINUE; END IF;
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_tx.id, v_line.id, v_line.order_id, v_allocation_cents / 100.0, v_now);
    v_to_allocate_cents := v_to_allocate_cents - v_allocation_cents;
    v_order_caps := jsonb_set(v_order_caps, ARRAY[v_line.order_id],
                              to_jsonb(v_order_cap_cents - v_allocation_cents));
  END LOOP;
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;
  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents,
      o.service_session_id AS obligation_service_session_id, o.order_uid
      FROM public.payment_allocations a
      JOIN public.ordenes o ON o.id = a.order_id AND o.table_session_id = v_session.id
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id, o.service_session_id, o.order_uid ORDER BY a.order_id
  LOOP
    v_order_total_cents := round(public.order_canonical_obligation_v1(v_order.order_uid) * 100)::bigint;
    SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100),0)::bigint
      INTO v_order_paid_before_cents
      FROM public.order_financial_events e
     WHERE e.service_session_id=v_order.obligation_service_session_id AND e.order_id=v_order.order_id
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
      event_service_session_id, payment_transaction_id, created_at
    )
    SELECT o.id, 'payment', v_order_allocation_cents / 100.0, p_payment_method,
      NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','mesa','mode',p_mode,'transaction_id',v_tx.id),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_tx.id::text, v_order_allocation_cents::text,
        p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_receipt_service_id, v_tx.id, v_now
    FROM public.ordenes o WHERE o.id=v_order.order_id AND o.table_session_id=v_session.id;
  END LOOP;
  UPDATE public.ordenes o SET
    cobrado = calc.is_paid, ya_pagado = calc.is_paid,
    metodo_pago = CASE WHEN calc.is_paid THEN calc.method_projection ELSE COALESCE(o.metodo_pago,'') END
  FROM (
    SELECT src.id AS order_id,
      CASE WHEN src.obligation_cents <= 0 THEN src.collected_cents > 0
           ELSE src.collected_cents >= src.obligation_cents END AS is_paid,
      CASE WHEN src.method_count > 1 THEN 'MIXTO' ELSE src.method_max END AS method_projection
    FROM (
      SELECT o2.id,
        round(public.order_canonical_obligation_v1(o2.order_uid) * 100)::bigint AS obligation_cents,
        COALESCE((SELECT round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100)
                    FROM public.order_financial_events e
                   WHERE e.service_session_id=o2.service_session_id AND e.order_id=o2.id
                     AND e.type IN ('payment','payment_imported','refund')),0)::bigint AS collected_cents,
        (SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
          WHERE e.service_session_id=o2.service_session_id AND e.order_id=o2.id
            AND e.type IN ('payment','payment_imported')) AS method_count,
        (SELECT max(e.payment_method) FROM public.order_financial_events e
          WHERE e.service_session_id=o2.service_session_id AND e.order_id=o2.id
            AND e.type IN ('payment','payment_imported')) AS method_max
      FROM public.ordenes o2
      WHERE o2.table_session_id = v_session.id AND o2.order_uid IS NOT NULL
    ) src
  ) calc
  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;
  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;
  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    'overCollected', GREATEST(0, (v_paid_cents + v_amount_cents - v_total_cents)) / 100.0,
    'tableStatus', 'open'
  );
END
$function$;

-- ═════════════════════════════════════════════════════════════════════════════
-- CANCELLED-ORDER PAYMENT DEFENSE -- order_post_payment_v1
-- ═════════════════════════════════════════════════════════════════════════════
-- Body reproduced verbatim from the live catalog, with exactly one insertion: a refusal
-- for a cancelled/annulled order, placed immediately after the order row is fetched and
-- BEFORE the first obligation computation, so no payment_transaction, allocation, OFE row
-- or mirror update is ever created for one.
CREATE OR REPLACE FUNCTION public.order_post_payment_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_order_uid uuid, p_payment_method text, p_mode text, p_amount numeric, p_client_request_id text, p_request_hash text, p_meta jsonb, p_confirm_duplicate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_entity public.order_entities%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_tx public.payment_transactions%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_now timestamptz := now();
  v_obligation_cents bigint;
  v_paid_before_cents bigint;
  v_outstanding_cents bigint;
  v_amount_cents bigint;
  v_receipt_service_id uuid;
  v_duplicate_candidate boolean;
  v_prev_state text;
  v_new_state text;
  v_new_paid_cents bigint;
  v_scope text;
  v_method_count integer;
  v_method_max text;
  v_is_paid boolean;
  v_method_projection text;
BEGIN
  IF p_workspace_id IS NULL OR p_order_uid IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_payment_method NOT IN ('efectivo','tarjeta','bizum')
     OR p_mode NOT IN ('full','custom_amount')
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'ORDER_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- Preserve the existing Servicio payment gate exactly (order_mark_paid):
  -- admin/operator ONLY. Do NOT widen to Mesa's broader PAYMENT_ROLES
  -- (owner/cashier/legacy_operator) -- an authorization change this slice
  -- does not own (frozen brief §25).
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','operator')
  THEN RAISE EXCEPTION 'ORDER_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'ORDER_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method, 'mode', v_existing.mode,
      'orderUid', p_order_uid);
  END IF;

  -- The permanent identity anchor -- resolves workspace/service/display id
  -- without trusting the client. A Mesa order's entity carries a non-null
  -- table_session_id; refuse it here so a table order can never bypass
  -- mesa_post_payment_v1's covers/line authority through this route.
  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_entity.workspace_id <> p_workspace_id THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;
  IF v_entity.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE='22023',
      DETAIL = format('order_uid=%s table_session=%s', p_order_uid, v_entity.table_session_id);
  END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Economic Writer Hardening V1 (migration 126) — refuse a cancelled/annulled order
  -- BEFORE any money fact is created. order_cancel_v1 already revises the obligation to 0,
  -- so ORDER_PAYMENT_ALREADY_SETTLED would eventually catch a zero-outstanding order too --
  -- but a cancelled order predating N-2 (fallback totale, no obligation row) or one
  -- cancelled while still carrying an outstanding balance must never be allowed to look
  -- like an ordinary payment. No payment_transaction, allocation, OFE row or mirror update
  -- happens.
  IF upper(COALESCE(v_ord.estado, '')) IN ('CANCELADO', 'CANCELLED', 'ANULADO') THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_ORDER_CANCELLED' USING ERRCODE='22023',
      DETAIL = format('order_uid=%s estado=%s -- payment refused on a cancelled/annulled order', p_order_uid, v_ord.estado);
  END IF;

  v_obligation_cents := round(public.order_canonical_obligation_v1(p_order_uid) * 100)::bigint;
  SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100), 0)::bigint
    INTO v_paid_before_cents
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund');
  v_outstanding_cents := GREATEST(0, v_obligation_cents - v_paid_before_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'ORDER_PAYMENT_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;

  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents;
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
  END IF;
  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.payment_transactions pt
    JOIN public.payment_allocations pa ON pa.payment_transaction_id = pt.id
     WHERE pa.order_uid = p_order_uid
       AND pt.client_request_id <> p_client_request_id
       AND pt.kind = 'payment' AND pt.mode = p_mode
       AND pt.amount = (v_amount_cents / 100.0) AND pt.payment_method = p_payment_method
       AND pt.created_at > (v_now - interval '120 seconds')
  ) INTO v_duplicate_candidate;
  IF v_duplicate_candidate AND NOT p_confirm_duplicate THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_POSSIBLE_DUPLICATE' USING ERRCODE='55000';
  ELSIF v_duplicate_candidate AND p_confirm_duplicate THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('PAYMENT_DUPLICATE_CONFIRMED', NULL, p_by_actor,
      jsonb_build_object('orderUid', p_order_uid, 'clientRequestId', p_client_request_id,
        'amount', v_amount_cents / 100.0, 'mode', p_mode, 'paymentMethod', p_payment_method));
  END IF;

  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;
  IF v_receipt_service_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000'; END IF;

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, 0,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;

  -- ONE allocation, order_uid-targeted -- the check-centric invariant (§8/§11/
  -- §28 of the brief): one payment_transactions row = one physical money
  -- movement; for a check, that movement is imputed to exactly one order.
  INSERT INTO public.payment_allocations(
    payment_transaction_id, table_order_line_id, order_id, order_uid, amount, created_at
  ) VALUES (v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now);

  v_new_paid_cents := v_paid_before_cents + v_amount_cents;
  v_prev_state := CASE
    WHEN v_paid_before_cents <= 0 THEN 'unpaid'
    WHEN v_paid_before_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_new_state := CASE
    WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_scope := 'order_' || replace(v_tx.id::text, '-', '');

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
    event_service_session_id, payment_transaction_id, created_at
  )
  SELECT o.id, 'payment', v_amount_cents / 100.0, p_payment_method,
    NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
    v_prev_state, v_new_state, NULL, NULL,
    jsonb_build_object('source','order','mode',p_mode,'transaction_id',v_tx.id),
    v_scope,
    encode(digest(concat_ws('|', o.id, v_tx.id::text, v_amount_cents::text,
      p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
    o.service_session_id, v_receipt_service_id, v_tx.id, v_now
  FROM public.ordenes o WHERE o.order_uid = p_order_uid;

  -- Same compatibility-mirror projection mesa_post_payment_v1 uses (§12 of
  -- the brief): 'MIXTO' on mixed tender, computed from order_financial_events
  -- so a legacy event-only collection is never lost from the projection.
  SELECT count(DISTINCT e.payment_method), max(e.payment_method)
    INTO v_method_count, v_method_max
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported');
  v_is_paid := CASE WHEN v_obligation_cents <= 0 THEN v_new_paid_cents > 0
                     ELSE v_new_paid_cents >= v_obligation_cents END;
  v_method_projection := CASE WHEN v_method_count > 1 THEN 'MIXTO' ELSE v_method_max END;

  UPDATE public.ordenes SET
    cobrado = v_is_paid, ya_pagado = v_is_paid,
    metodo_pago = CASE WHEN v_is_paid THEN v_method_projection ELSE COALESCE(metodo_pago,'') END
  WHERE order_uid = p_order_uid;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'orderUid', p_order_uid, 'displayOrderId', v_entity.display_order_id,
    'currentObligation', v_obligation_cents / 100.0,
    'netCollectedBefore', v_paid_before_cents / 100.0,
    'netCollectedAfter', v_new_paid_cents / 100.0,
    'unpaid', GREATEST(0, v_obligation_cents - v_new_paid_cents) / 100.0,
    'overCollected', GREATEST(0, v_new_paid_cents - v_obligation_cents) / 100.0,
    'serviceSessionId', v_receipt_service_id
  );
END;
$function$;

-- ═════════════════════════════════════════════════════════════════════════════
-- F-6 -- DROP complete_rider_stop (dead code; ledger row 37 wrongly claims this)
-- ═════════════════════════════════════════════════════════════════════════════
-- Zero runtime callers: not registered in supabaseResourcePolicy.js, no JS/SQL caller
-- anywhere (only referenced in comments in riderTrip.js/driverTelemetry.js/supabase.js),
-- and its own EXECUTE grant was already restricted to postgres/service_role (no anon/
-- authenticated exposure). This does NOT re-run or edit migration
-- 2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql or ledger row 37 -- that file's own
-- guard already refuses a second execution, and row 37 stays exactly as recorded
-- (bootstrapped_unverified). This migration performs the drop for real, as its own new
-- ledger fact.
DROP FUNCTION public.complete_rider_stop(text, boolean, text);

-- ═════════════════════════════════════════════════════════════════════════════
-- PRIVILEGE HYGIENE -- order_has_economic_evidence_v1
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration 116 (EC-F2) already issued `REVOKE ALL ... FROM PUBLIC`, but Supabase's
-- default-privilege ACL grants EXECUTE on every NEW function directly to `anon` and
-- `authenticated` (not through the PUBLIC pseudo-role), so that revoke never touched them
-- -- confirmed live in this session (has_function_privilege('anon', ..., 'EXECUTE') = true
-- immediately before this statement). This predicate is read-only and used only by the two
-- delete-guard RPCs, both service_role; anon/authenticated never need to call it directly.
REVOKE ALL ON FUNCTION public.order_has_economic_evidence_v1(text) FROM PUBLIC, anon, authenticated;

-- ── POST-CONDITION ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_mesa_prosrc text;
  v_mesa_clean  text;
  v_mesa_exec   text;
  v_marker_pos  int;
BEGIN
  -- E-1: function, comment, trigger, grants.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'order_economic_basis_lock_v1') THEN
    RAISE EXCEPTION 'M126 post-condition failed: order_economic_basis_lock_v1 was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname = 'ordenes_order_economic_basis_lock_v1'
                  AND pg_get_triggerdef(oid) ILIKE '%BEFORE UPDATE%') THEN
    RAISE EXCEPTION 'M126 post-condition failed: the E-1 trigger is missing or not BEFORE UPDATE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
       AND t.tgname = 'ordenes_order_economic_basis_lock_v1'
       AND (SELECT count(*) FROM unnest(t.tgattr::int2[]) a
             WHERE (SELECT attname FROM pg_attribute
                     WHERE attrelid = 'public.ordenes'::regclass AND attnum = a)
                   IN ('totale','items','delivery_fee','descuento_tipo','descuento_valor','descuento_importe')) = 6
  ) THEN
    RAISE EXCEPTION 'M126 post-condition failed: the E-1 trigger is not scoped to all six economic-basis columns';
  END IF;
  IF has_function_privilege('anon', 'public.order_economic_basis_lock_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_economic_basis_lock_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'M126 post-condition failed: anon/authenticated must not hold EXECUTE on the E-1 guard';
  END IF;
  -- N-5 and Mesa's own structural triggers must both survive untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname = 'ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'M126 post-condition failed: the N-5 guard trigger disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname = 'mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'M126 post-condition failed: Mesa line-snapshot trigger disappeared';
  END IF;

  -- E-2: the two typed refusals are present in the installed body.
  IF (SELECT prosrc FROM pg_proc WHERE proname = '_ledger_write_payment' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%LEGACY_COLLECTION_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 post-condition failed: _ledger_write_payment does not carry the E-2 fence'; END IF;

  -- Retirement stubs.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_mark_paid' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%LEGACY_OPERATOR_COLLECTION_RETIRED%'
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_mark_paid is not retired'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_void' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%LEGACY_VOID_RETIRED_USE_ORDER_CANCEL%'
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_void is not retired'; END IF;

  -- Import/refund Mesa fences.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_import_legacy_payment' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%AUTH_MESA_ORDER_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_import_legacy_payment does not carry the Mesa fence'; END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_refund' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%AUTH_MESA_ORDER_NOT_ALLOWED%'
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_refund does not carry the Mesa fence'; END IF;

  -- Patch B: the lock statement is present, and it is textually BEFORE the first
  -- obligation computation (v_total_cents), measured over the EXECUTABLE body only.
  -- B-1 fix (ECONOMIC_WRITER_HARDENING_REVIEW_FAIL_FIX_REQUIRED): the previous check took
  -- position('v_total_cents' IN prosrc) -- the FIRST occurrence of that name anywhere in
  -- the source, which is its own DECLARE line, and DECLARE always precedes BEGIN. That made
  -- the captured prefix end before any executable statement at all, so this guard failed
  -- unconditionally no matter where the real lock sat. Fixed structurally, not by picking a
  -- different fragile symbol:
  --   (1) strip `--` and `/* */` comments first, so neither hides nor fakes a keyword;
  --   (2) cut at the function's single top-level BEGIN (word-bounded \m/\M) to drop the
  --       DECLARE section entirely -- mesa_post_payment_v1 has exactly one BEGIN/END block
  --       and no nested one, so this reliably isolates the executable body;
  --   (3) only THEN take the first occurrence of v_total_cents as the "before" cutoff --
  --       now necessarily its actual computation, since nothing reads or writes it earlier
  --       in executable code.
  SELECT prosrc INTO v_mesa_prosrc FROM pg_proc
   WHERE proname = 'mesa_post_payment_v1' AND pronamespace = 'public'::regnamespace;
  IF v_mesa_prosrc IS NULL THEN
    RAISE EXCEPTION 'M126 post-condition failed: mesa_post_payment_v1 body could not be read';
  END IF;

  v_mesa_clean := regexp_replace(v_mesa_prosrc, '/\*.*?\*/', '', 'gs');
  v_mesa_clean := regexp_replace(v_mesa_clean, '--[^\n]*', '', 'g');
  v_mesa_exec  := substring(v_mesa_clean FROM '(?s)\mBEGIN\M(.*)');
  IF v_mesa_exec IS NULL THEN
    RAISE EXCEPTION 'M126 post-condition failed: mesa_post_payment_v1 has no top-level BEGIN -- cannot isolate its executable body';
  END IF;

  v_marker_pos := position('v_total_cents' IN v_mesa_exec);
  IF v_marker_pos = 0 THEN
    RAISE EXCEPTION 'M126 post-condition failed: mesa_post_payment_v1 no longer computes v_total_cents in its executable body';
  END IF;

  -- B-1 round-2 strengthening (NB-1, independent review of 826a9b0): mesa_post_payment_v1
  -- already takes THREE other FOR UPDATE locks earlier in the same function (workspaces,
  -- auth_actors, table_sessions) -- all unconditionally present before the marker
  -- regardless of Patch B. Checking "does FOR UPDATE occur anywhere before the marker?" and
  -- "does ORDER BY o.id occur anywhere before the marker?" as two INDEPENDENT conditions was
  -- therefore vacuous on the FOR UPDATE half: removing ONLY Patch B's own FOR UPDATE (while
  -- leaving its ORDER BY o.id, and leaving the three earlier locks untouched) still passed
  -- (review's M4 case). Replaced with a single match on PATCH B'S OWN STATEMENT AS ONE
  -- CONTIGUOUS UNIT, so an unrelated earlier lock can no longer stand in for it.
  IF substring(v_mesa_exec FROM 1 FOR v_marker_pos)
       !~ 'PERFORM 1 FROM public\.ordenes o\s+WHERE o\.table_session_id = v_session\.id\s+ORDER BY o\.id\s+FOR UPDATE'
  THEN RAISE EXCEPTION 'M126 post-condition failed: Patch B lock is missing or not before the first obligation computation'; END IF;

  -- Cancelled-order payment defense.
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'order_post_payment_v1' AND pronamespace = 'public'::regnamespace)
       NOT LIKE '%ORDER_PAYMENT_ORDER_CANCELLED%'
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_post_payment_v1 does not carry the cancelled-order defense'; END IF;

  -- F-6: complete_rider_stop is really gone this time.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'complete_rider_stop') THEN
    RAISE EXCEPTION 'M126 post-condition failed: complete_rider_stop was not dropped';
  END IF;

  -- Privilege hygiene.
  IF has_function_privilege('anon', 'public.order_has_economic_evidence_v1(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_has_economic_evidence_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M126 post-condition failed: anon/authenticated must not hold EXECUTE on order_has_economic_evidence_v1';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.order_has_economic_evidence_v1(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M126 post-condition failed: service_role lost EXECUTE on order_has_economic_evidence_v1';
  END IF;

  -- Structural snapshot: net function count unchanged (+1 new, -1 dropped), ordenes gains
  -- exactly one trigger, and every money-table row count is untouched (zero DML anywhere).
  IF (SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
     IS DISTINCT FROM current_setting('ladieci.m126_public_fn_count', true)
  THEN RAISE EXCEPTION 'M126 post-condition failed: public schema function count changed (expected net zero)'; END IF;

  IF (SELECT count(*)::text FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass AND NOT tgisinternal)
     IS DISTINCT FROM (current_setting('ladieci.m126_ordenes_trigger_count', true)::int + 1)::text
  THEN RAISE EXCEPTION 'M126 post-condition failed: ordenes trigger count did not increase by exactly 1'; END IF;

  IF (SELECT count(*)::text FROM public.ordenes) IS DISTINCT FROM current_setting('ladieci.m126_ordenes_row_count', true)
  THEN RAISE EXCEPTION 'M126 post-condition failed: ordenes row count changed -- this migration must write zero rows'; END IF;
  IF (SELECT count(*)::text FROM public.order_obligations) IS DISTINCT FROM current_setting('ladieci.m126_obligations_row_count', true)
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_obligations row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.payment_transactions) IS DISTINCT FROM current_setting('ladieci.m126_payment_tx_row_count', true)
  THEN RAISE EXCEPTION 'M126 post-condition failed: payment_transactions row count changed'; END IF;
  IF (SELECT count(*)::text FROM public.order_financial_events) IS DISTINCT FROM current_setting('ladieci.m126_ofe_row_count', true)
  THEN RAISE EXCEPTION 'M126 post-condition failed: order_financial_events row count changed'; END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-125: the
-- manifest records this file's own sha256, and embedding that sha in an INSERT inside the
-- file would make the checksum self-referential. Registered as a separate statement at
-- apply time: apply_order 126, kind 'ddl', checksum = this file's sha256, applied_by = the
-- introducing commit (committed BEFORE this migration is applied). NOT APPLIED in this
-- commit -- ledger stays 125.

COMMIT;
