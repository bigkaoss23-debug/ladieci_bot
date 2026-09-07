-- migrations/2026-09-07_check_centric_universal_cash_v1_migration_122.sql
-- CHECK-CENTRIC UNIVERSAL CASH V1 — generalize the existing canonical
-- payment ledger (payment_transactions / payment_allocations /
-- order_financial_events) so a non-table order (Servicio / Banco / Retiro)
-- can post a real, refundable, transaction-backed payment through it.
--
-- THIS IS NOT A NEW PAYMENT ENGINE. See
-- REPORT_CHECK_CENTRIC_UNIVERSAL_CASH_V1_CONTRACT_2026-09-07.md and
-- REPORT_SERVICIO_UNIVERSAL_CASH_INTEGRATION_AUDIT_2026-09-07.md (both
-- pre-implementation, read-only) for the full forensic basis. Every
-- decision below is either owner-approved in those reports or explicitly
-- frozen in this slice's brief.
--
-- WHY THIS EXISTS, IN ONE LINE: `payment_transactions.table_session_id`
-- and `payment_allocations.table_order_line_id` are NOT NULL, which makes
-- a canonical transaction-backed payment STRUCTURALLY IMPOSSIBLE for an
-- order that has no table session and no table_order_lines — proven live
-- on #999035 (order_uid 75ba4ced-9b79-4276-a46b-e87a3e24a7e9): obligation
-- 85, a legacy `order_financial_events` payment of +85 efectivo,
-- payment_transaction_id NULL, zero payment_transactions, zero
-- payment_allocations. Refund V1 cannot touch it because there is no
-- original transaction to reverse.
--
-- FROZEN ARCHITECTURAL PRINCIPLE: one ledger, multiple domain adapters.
-- No second payment_transactions/payment_allocations table, no
-- payServicioV2, no duplicated obligation/refund logic. Mesa's own
-- writers (mesa_post_payment_v1, mesa_close_session_v1,
-- mesa_post_commercial_adjustment_v1) are NOT touched by this migration —
-- their bodies are proven byte-identical before and after in the
-- post-condition below. Exactly one line changes in one existing Mesa
-- function (item 6).
--
-- WHAT THIS MIGRATION DOES, AND NOTHING ELSE:
--   1. `payment_transactions.table_session_id` DROP NOT NULL (0 existing
--      NULLs today — metadata-only on PG 17.6) + ADD CHECK
--      `table_session_id IS NOT NULL OR service_session_id IS NOT NULL`
--      (every legitimate transaction has at least one scope; Mesa's is
--      always non-null on table_session_id, check-centric's is always
--      non-null on service_session_id — order_entities.service_session_id
--      is NOT NULL by schema).
--   2. `payment_allocations.table_order_line_id` DROP NOT NULL (0 existing
--      NULLs) + ADD COLUMN `order_uid uuid NULL` + FK to
--      `order_entities(order_uid)` (NOT `ordenes(order_uid)` — that index
--      is PARTIAL and not FK-addressable in PostgreSQL) + ADD CHECK
--      `table_order_line_id IS NOT NULL OR order_uid IS NOT NULL` (OR, not
--      XOR — a future Mesa allocation may legitimately carry both) + a
--      companion UNIQUE INDEX on `(payment_transaction_id, order_uid)
--      WHERE table_order_line_id IS NULL`, because the existing
--      `payment_allocations_transaction_line_uq` treats NULLs as distinct
--      and would silently stop protecting "one allocation per transaction"
--      for check-centric rows without it.
--   3. Three new functions, ALL delegating to or extending the existing
--      canonical ledger — no parallel economic authority:
--        - `order_post_payment_v1`  — the check-centric payment writer,
--          the direct structural analogue of `mesa_post_payment_v1`
--          restricted to `full`/`custom_amount` (no covers, no table
--          lines — Banco/Retiro have neither).
--        - `order_post_refund_v1`   — the check-centric Refund V1
--          adapter. Same frozen invariants as `mesa_post_refund_v1`
--          (exact original transaction, same-tender forced, partial and
--          multiple refunds, remaining-refundable enforced, append-only,
--          no obligation mutation, terminal orders fine) reimplemented
--          against a single order-level allocation instead of Mesa's
--          per-table-order-line reversal loop (mesa_post_refund_v1's own
--          loop joins `table_order_lines`, which does not exist for a
--          check-centric allocation — this is a proven, not incidental,
--          structural difference, so this is a real adapter, not a
--          literal call-through).
--        - `order_apply_commercial_adjustment_v1` — the check-centric
--          "Corregir importe" adapter. A THIN wrapper: it resolves
--          workspace/actor/role and then calls the SAME
--          `order_obligation_apply_adjustment_v1` Mesa's own
--          `mesa_post_commercial_adjustment_v1` wrapper already calls —
--          zero duplicated obligation logic. netCollected/unpaid/
--          overCollected are read from `order_financial_events` (not
--          `payment_allocations`), because a legacy event-only Servicio
--          payment is real money with zero allocations, and computing
--          from allocations would silently under-report it as zero.
--   4. `mesa_post_refund_v1` — ONE line changed (item 6 below). No other
--      byte changes; grants untouched (CREATE OR REPLACE, same signature).
--   5. `auth_audit_event_chk` gains two new allowed event values:
--      `ORDER_PAYMENT_REFUNDED`, `ORDER_COMMERCIAL_ADJUSTMENT` (the
--      check-centric analogues of the existing `MESA_PAYMENT_REFUNDED`
--      / `MESA_COMMERCIAL_ADJUSTMENT`).
--   6. `order_initial_payment_v1` (the AFTER INSERT trigger on `ordenes`
--      that settles a creation-time "ya pagado" order) is repointed from
--      `order_mark_paid` (legacy, event-only, session_version auth) to
--      `order_post_payment_v1` (canonical, transaction-backed, sid_hash
--      auth) — otherwise a brand-new Servicio order created "ya pagado"
--      today would still produce a legacy event-only payment, and the
--      claim "Servicio is canonical" would be false the moment it shipped
--      (§22/§R of the frozen brief). The SAME deterministic
--      `pay-order-<id>` key is reused as `p_client_request_id`, so a
--      replayed order-creation request still replays instead of
--      double-charging — this is the one owner decision (§AC.2 of the
--      contract report) this migration resolves by construction rather
--      than by convention.
--
-- WHAT IS DELIBERATELY NOT DONE (frozen non-goals):
--   * NO migration 123. Everything above ships in this one file.
--   * NO new table. `payment_order_allocations` was considered and
--     rejected (§C/§Y of the contract report) — 0 existing NULLs, every
--     reader is scoped by equality or by transaction id, N-5/EC-F2 already
--     join on `order_id` at order level.
--   * NO backfill of any kind. #999035 stays exactly as it is:
--     `payment_transaction_id` stays NULL forever on that row. Asserted
--     in the post-condition (zero rows with the new nullable columns
--     actually NULL that were not already candidates, row counts
--     unchanged).
--   * NO change to `mesa_post_payment_v1`, `mesa_close_session_v1`,
--     `mesa_post_commercial_adjustment_v1`, `order_obligation_apply_
--     adjustment_v1`, `order_canonical_obligation_v1`,
--     `order_has_economic_evidence_v1`,
--     `paid_order_economic_mutation_guard_v1`,
--     `service_session_assign_financial_event` — all six snapshotted by
--     `md5(prosrc)` in the guard and re-verified byte-identical in the
--     post-condition.
--   * NO change to rider (`_ledger_write_payment`,
--     `rider_collect_and_complete_stop`, `complete_rider_stop`) — none of
--     those functions reference either column this migration relaxes.
--     Rider stays `LEGACY_FAST_FOLLOW`, out of scope, by construction.
--   * NO role widening. `order_post_payment_v1` keeps the EXACT existing
--     Servicio gate (`admin`,`operator` — narrower than Mesa's
--     `PAYMENT_ROLES`); `order_post_refund_v1` /
--     `order_apply_commercial_adjustment_v1` keep `admin`,`owner`,
--     identical to Mesa's `REFUND_ROLES`/`ADJUSTMENT_ROLES`.
--
-- STAGING ONLY. NOT APPLIED IN THIS BLOCK (NO PUSH / NO DEPLOY / NO
-- STAGING DB APPLY). Ledger stays 121 until a separate promotion
-- authorization. Function bodies use $function$...$function$; DO blocks
-- use named tags ($guard$ / $post$), never a bare $$ — house style, see
-- migration 121.

BEGIN;

-- ── PRE-CONDITION: refuse on drift / if already applied ──────────────────────
DO $guard$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('public.payment_transactions') IS NULL
     OR to_regclass('public.payment_allocations') IS NULL
     OR to_regclass('public.order_entities') IS NULL THEN
    RAISE EXCEPTION 'M122 refused: payment_transactions / payment_allocations / order_entities missing -- apply the V3H/R-DAY2 foundation chain first';
  END IF;

  -- The two columns this migration relaxes must still be NOT NULL today.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='payment_transactions'
                AND column_name='table_session_id' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'M122 refused: payment_transactions.table_session_id is already nullable -- already applied?';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='payment_allocations'
                AND column_name='table_order_line_id' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'M122 refused: payment_allocations.table_order_line_id is already nullable -- already applied?';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='payment_allocations'
                AND column_name='order_uid') THEN
    RAISE EXCEPTION 'M122 refused: payment_allocations.order_uid already exists -- already applied?';
  END IF;

  -- Live pre-contract evidence this migration is non-destructive: zero rows
  -- already sit in the "would need a NULL" state.
  IF (SELECT count(*) FROM public.payment_transactions WHERE table_session_id IS NULL) <> 0 THEN
    RAISE EXCEPTION 'M122 refused: payment_transactions already has NULL table_session_id rows -- unexpected pre-state';
  END IF;
  IF (SELECT count(*) FROM public.payment_allocations WHERE table_order_line_id IS NULL) <> 0 THEN
    RAISE EXCEPTION 'M122 refused: payment_allocations already has NULL table_order_line_id rows -- unexpected pre-state';
  END IF;

  -- The three new functions must not exist yet.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname IN
                ('order_post_payment_v1','order_post_refund_v1','order_apply_commercial_adjustment_v1')) THEN
    RAISE EXCEPTION 'M122 refused: a check-centric writer already exists -- already applied?';
  END IF;

  -- mesa_post_refund_v1 must still carry the pre-fix comparison, and not the
  -- fixed one -- refuses a double-apply or a drifted body.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'M122 refused: mesa_post_refund_v1 does not exist -- resolve drift first';
  END IF;
  IF position('v_original.table_session_id <> p_table_session_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M122 refused: mesa_post_refund_v1 does not contain the expected pre-fix comparison -- resolve drift first';
  END IF;
  IF position('v_original.table_session_id IS DISTINCT FROM p_table_session_id' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M122 refused: mesa_post_refund_v1 already carries the IS DISTINCT FROM fix -- already applied?';
  END IF;

  -- order_initial_payment_v1 must still call the legacy writer.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'M122 refused: order_initial_payment_v1 does not exist -- resolve drift first';
  END IF;
  IF position('order_mark_paid' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M122 refused: order_initial_payment_v1 no longer calls order_mark_paid -- resolve drift first';
  END IF;
  IF position('order_post_payment_v1' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M122 refused: order_initial_payment_v1 already calls order_post_payment_v1 -- already applied?';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.auth_audit'::regclass
                   AND conname='auth_audit_event_chk') THEN
    RAISE EXCEPTION 'M122 refused: auth_audit_event_chk missing -- resolve drift first';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.auth_audit'::regclass AND conname='auth_audit_event_chk')
     LIKE '%ORDER_PAYMENT_REFUNDED%' THEN
    RAISE EXCEPTION 'M122 refused: auth_audit_event_chk already carries ORDER_PAYMENT_REFUNDED -- already applied?';
  END IF;

  -- Append-only triggers must be live and stay live.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='payment_transactions'
                   AND t.tgname='payment_transactions_append_only_v1' AND NOT t.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='payment_allocations'
                   AND t.tgname='payment_allocations_append_only_v1' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'M122 refused: an append-only trigger is missing -- resolve drift first';
  END IF;

  -- Snapshot everything this migration must leave byte-identical or
  -- numerically unchanged.
  PERFORM set_config('ladieci.m122_pt_count',      (SELECT count(*)::text FROM public.payment_transactions), false);
  PERFORM set_config('ladieci.m122_pa_count',       (SELECT count(*)::text FROM public.payment_allocations), false);
  PERFORM set_config('ladieci.m122_ordenes_count',  (SELECT count(*)::text FROM public.ordenes), false);
  PERFORM set_config('ladieci.m122_ofe_count',      (SELECT count(*)::text FROM public.order_financial_events), false);
  PERFORM set_config('ladieci.m122_mesa_pay_md5',       (SELECT md5(prosrc) FROM pg_proc WHERE proname='mesa_post_payment_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_mesa_close_md5',     (SELECT md5(prosrc) FROM pg_proc WHERE proname='mesa_close_session_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_mesa_adj_md5',       (SELECT md5(prosrc) FROM pg_proc WHERE proname='mesa_post_commercial_adjustment_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_obl_adj_md5',        (SELECT md5(prosrc) FROM pg_proc WHERE proname='order_obligation_apply_adjustment_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_canon_obl_md5',      (SELECT md5(prosrc) FROM pg_proc WHERE proname='order_canonical_obligation_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_has_evidence_md5',   (SELECT md5(prosrc) FROM pg_proc WHERE proname='order_has_economic_evidence_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_paid_guard_md5',     (SELECT md5(prosrc) FROM pg_proc WHERE proname='paid_order_economic_mutation_guard_v1' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_assign_fe_md5',      (SELECT md5(prosrc) FROM pg_proc WHERE proname='service_session_assign_financial_event' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_ledger_write_md5',   (SELECT md5(prosrc) FROM pg_proc WHERE proname='_ledger_write_payment' AND pronamespace='public'::regnamespace), false);
  PERFORM set_config('ladieci.m122_order_mark_paid_md5',(SELECT md5(prosrc) FROM pg_proc WHERE proname='order_mark_paid' AND pronamespace='public'::regnamespace), false);
END $guard$;

-- ── 1. payment_transactions.table_session_id -> nullable + scope CHECK ───────
ALTER TABLE public.payment_transactions ALTER COLUMN table_session_id DROP NOT NULL;
ALTER TABLE public.payment_transactions
  ADD CONSTRAINT payment_transactions_scope_chk
    CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL);

COMMENT ON COLUMN public.payment_transactions.table_session_id IS
  'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction always carries at least one scope (table_session_id for Mesa, service_session_id for check-centric).';

-- ── 2. payment_allocations.table_order_line_id -> nullable + order_uid ───────
ALTER TABLE public.payment_allocations ALTER COLUMN table_order_line_id DROP NOT NULL;
ALTER TABLE public.payment_allocations ADD COLUMN order_uid uuid;

ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_order_uid_fkey
    FOREIGN KEY (order_uid) REFERENCES public.order_entities(order_uid);

ALTER TABLE public.payment_allocations
  ADD CONSTRAINT payment_allocations_target_chk
    CHECK (table_order_line_id IS NOT NULL OR order_uid IS NOT NULL);

-- Closes the hazard the contract report proved: payment_allocations_transaction_line_uq
-- treats NULLs as distinct, so once table_order_line_id is nullable, "one allocation
-- per transaction" silently stops being enforced for check-centric rows without this
-- companion partial unique index.
CREATE UNIQUE INDEX payment_allocations_transaction_order_uq
  ON public.payment_allocations (payment_transaction_id, order_uid)
  WHERE table_order_line_id IS NULL;

CREATE INDEX payment_allocations_order_uid_idx
  ON public.payment_allocations (order_uid, created_at)
  WHERE order_uid IS NOT NULL;

COMMENT ON COLUMN public.payment_allocations.table_order_line_id IS
  'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric allocation, whose target is order_uid instead. See payment_allocations_target_chk (OR, not XOR) and payment_allocations_transaction_order_uq.';
COMMENT ON COLUMN public.payment_allocations.order_uid IS
  'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). The permanent order identity a check-centric allocation is imputed to (order_entities is the FK-addressable identity registry -- ordenes.order_uid sits behind a PARTIAL unique index and cannot be an FK target). NULL for every pre-existing Mesa allocation; no backfill.';

-- ── 3. auth_audit_event_chk -- two new check-centric audit events ────────────
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event = ANY (ARRAY[
  'login_ok'::text, 'login_fail'::text, 'locked'::text, 'pin_set'::text, 'pin_change'::text, 'revoke'::text,
  'bootstrap'::text, 'recovery'::text, 'actor_disabled'::text, 'actor_enabled'::text, 'actor_unlocked'::text,
  'user_created'::text, 'user_renamed'::text, 'role_changed'::text, 'user_deactivated'::text, 'user_reactivated'::text,
  'access_denied'::text, 'credential_cleared'::text, 'fingerprint_upgraded'::text, 'session_invalidated'::text,
  'rate_limit_triggered'::text, 'migration_login_used'::text, 'PAYMENT_REPLAY_DIFFERENT_ACTOR'::text,
  'PAYMENT_DUPLICATE_CONFIRMED'::text, 'MESA_PAYMENT_REFUNDED'::text, 'MESA_COMMERCIAL_ADJUSTMENT'::text,
  'ORDER_CANCELLED'::text, 'ORDER_PAYMENT_REFUNDED'::text, 'ORDER_COMMERCIAL_ADJUSTMENT'::text
]));

-- ── 4. order_post_payment_v1 — the check-centric payment writer ──────────────
-- Direct structural analogue of mesa_post_payment_v1, restricted to the two
-- modes that make sense with no covers and no table_order_lines: full,
-- custom_amount. Preserves EXACTLY the existing Servicio payment gate
-- (admin, operator -- narrower than Mesa's PAYMENT_ROLES; §25, no widening).
CREATE FUNCTION public.order_post_payment_v1(
  p_workspace_id       uuid,
  p_by_actor           text,
  p_by_sid_hash        text,
  p_order_uid          uuid,
  p_payment_method     text,
  p_mode               text,
  p_amount             numeric,
  p_client_request_id  text,
  p_request_hash       text,
  p_meta               jsonb,
  p_confirm_duplicate  boolean DEFAULT false
)
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

REVOKE ALL ON FUNCTION public.order_post_payment_v1(
  uuid, text, text, uuid, text, text, numeric, text, text, jsonb, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_post_payment_v1(
  uuid, text, text, uuid, text, text, numeric, text, text, jsonb, boolean
) TO service_role;

-- ── 5. order_post_refund_v1 — the check-centric Refund V1 adapter ────────────
-- Same frozen invariants as mesa_post_refund_v1, reimplemented against a
-- single order-level allocation (mesa_post_refund_v1's own reversal loop
-- joins table_order_lines, which a check-centric allocation never has --
-- a proven structural difference, not an incidental one; see contract
-- report §L). REFUND_ROLES identical to Mesa: admin, owner only.
CREATE FUNCTION public.order_post_refund_v1(
  p_workspace_id            uuid,
  p_by_actor                text,
  p_by_sid_hash             text,
  p_order_uid               uuid,
  p_original_transaction_id uuid,
  p_reason                  text,
  p_client_request_id       text,
  p_request_hash            text,
  p_amount                  numeric,
  p_meta                    jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_entity public.order_entities%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_original public.payment_transactions%ROWTYPE;
  v_alloc public.payment_allocations%ROWTYPE;
  v_refund_tx public.payment_transactions%ROWTYPE;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_reason text;
  v_remaining_cents bigint;
  v_amount_cents bigint;
  v_remaining_after_cents bigint;
  v_receipt_service_id uuid;
  v_settlement text;
  v_obligation_cents bigint;
  v_paid_before_cents bigint;
  v_new_paid_cents bigint;
  v_prev_state text;
  v_new_state text;
  v_scope text;
  v_method_count integer;
  v_method_max text;
  v_is_paid boolean;
  v_method_projection text;
  v_audit_id bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_order_uid IS NULL OR p_original_transaction_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_REFUND_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ORDER_REFUND_REASON_REQUIRED' USING ERRCODE='22023'; END IF;
  v_reason := btrim(p_reason);

  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RAISE EXCEPTION 'ORDER_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'ORDER_REFUND_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- REFUND_ROLES, identical to Mesa: admin/owner only (§25, no widening --
  -- the role that takes money is deliberately not the one that returns it).
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'ORDER_REFUND_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'ORDER_REFUND_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505'; END IF;
    IF p_by_actor <> v_existing.by_actor THEN
      INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
      VALUES ('PAYMENT_REPLAY_DIFFERENT_ACTOR', v_existing.by_actor, p_by_actor,
        jsonb_build_object('transactionId', v_existing.id, 'clientRequestId', p_client_request_id,
          'originalBySidHash', v_existing.by_sid_hash, 'replayingBySidHash', p_by_sid_hash,
          'replayingRole', v_actor.role));
    END IF;
    SELECT round(pt.amount*100)::bigint - COALESCE((
        SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
         WHERE r.kind='refund' AND r.reverses_transaction_id = pt.id
      ),0) INTO v_remaining_after_cents
      FROM public.payment_transactions pt WHERE pt.id = v_existing.reverses_transaction_id;
    RETURN jsonb_build_object('ok', true, 'idempotent', true,
      'refundTransactionId', v_existing.id, 'reversesTransactionId', v_existing.reverses_transaction_id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'refundableRemainingOnOriginal', COALESCE(v_remaining_after_cents,0) / 100.0,
      'orderUid', p_order_uid);
  END IF;

  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_entity.workspace_id <> p_workspace_id THEN
    RAISE EXCEPTION 'ORDER_REFUND_WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Lock the ORIGINAL transaction -- serialises concurrent over-refund
  -- attempts exactly like mesa_post_refund_v1.
  SELECT * INTO v_original FROM public.payment_transactions
   WHERE id = p_original_transaction_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_REFUND_TRANSACTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_original.kind <> 'payment' THEN RAISE EXCEPTION 'ORDER_REFUND_NOT_REFUNDABLE' USING ERRCODE='55000'; END IF;
  -- A Mesa (table-bound) transaction can never be refunded through this
  -- check-centric route -- symmetric to the null-safe guard mesa_post_
  -- refund_v1 now carries (§28 of the brief).
  IF v_original.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_REFUND_NOT_CHECK_CENTRIC' USING ERRCODE='55000'; END IF;

  SELECT * INTO v_alloc FROM public.payment_allocations
   WHERE payment_transaction_id = v_original.id AND table_order_line_id IS NULL;
  IF NOT FOUND OR v_alloc.order_uid IS DISTINCT FROM p_order_uid THEN
    RAISE EXCEPTION 'ORDER_REFUND_TRANSACTION_MISMATCH' USING ERRCODE='55000'; END IF;

  SELECT round(v_original.amount*100)::bigint - COALESCE((
      SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
       WHERE r.kind='refund' AND r.reverses_transaction_id = v_original.id
    ),0) INTO v_remaining_cents;
  IF v_remaining_cents <= 0 THEN RAISE EXCEPTION 'ORDER_REFUND_ALREADY_FULL' USING ERRCODE='55000'; END IF;

  v_amount_cents := CASE WHEN p_amount IS NULL THEN v_remaining_cents ELSE round(p_amount*100)::bigint END;
  IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'ORDER_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount_cents > v_remaining_cents THEN RAISE EXCEPTION 'ORDER_REFUND_EXCEEDS_REMAINING' USING ERRCODE='55000'; END IF;

  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;

  -- §H.4 -- record, don't claim: tarjeta/bizum note that La Dieci is
  -- RECORDING an externally executed return, never that it executed a
  -- bank/POS operation. Identical language to mesa_post_refund_v1.
  v_settlement := CASE WHEN v_original.payment_method = 'efectivo' THEN 'drawer' ELSE 'external' END;

  -- The refund's payment_method is FORCED from the original -- same-tender
  -- invariant, no caller-supplied method exists in this signature.
  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, reverses_transaction_id, by_actor, by_role,
    by_sid_hash, client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, NULL, v_receipt_service_id, 'refund', 'refund',
    v_amount_cents / 100.0, v_original.payment_method, 0, v_original.id,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id, p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_refund_tx;

  INSERT INTO public.payment_allocations(
    payment_transaction_id, table_order_line_id, order_id, order_uid, amount, created_at
  ) VALUES (v_refund_tx.id, NULL, v_alloc.order_id, p_order_uid, v_amount_cents / 100.0, v_now);

  v_obligation_cents := round(public.order_canonical_obligation_v1(p_order_uid) * 100)::bigint;
  SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END) * 100), 0)::bigint
    INTO v_paid_before_cents
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund');
  v_prev_state := CASE
    WHEN v_paid_before_cents <= 0 THEN 'unpaid'
    WHEN v_paid_before_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_new_paid_cents := v_paid_before_cents - v_amount_cents;
  v_new_state := CASE
    WHEN v_new_paid_cents <= 0 THEN 'unpaid'
    WHEN v_new_paid_cents >= v_obligation_cents THEN 'paid'
    ELSE 'partially_paid' END;
  v_scope := 'order_' || replace(v_refund_tx.id::text, '-', '');

  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
    event_service_session_id, payment_transaction_id, created_at
  )
  SELECT o.id, 'refund', v_amount_cents / 100.0, v_original.payment_method,
    v_reason, false, p_by_actor, v_actor.role, o.estado, o.estado,
    v_prev_state, v_new_state, NULL, NULL,
    jsonb_build_object('source','order','mode','refund','transaction_id',v_refund_tx.id,
      'reverses_transaction_id', v_original.id, 'settlement', v_settlement),
    v_scope,
    encode(digest(concat_ws('|', o.id, v_refund_tx.id::text, v_amount_cents::text,
      v_original.payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
    o.service_session_id, v_receipt_service_id, v_refund_tx.id, v_now
  FROM public.ordenes o WHERE o.order_uid = p_order_uid;

  SELECT count(DISTINCT e.payment_method), max(e.payment_method)
    INTO v_method_count, v_method_max
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported');
  v_is_paid := CASE WHEN v_obligation_cents <= 0 THEN v_new_paid_cents > 0
                     ELSE v_new_paid_cents >= v_obligation_cents END;
  v_method_projection := CASE WHEN v_method_count > 1 THEN 'MIXTO' ELSE v_method_max END;

  -- ordenes.refunded is deliberately never set here -- it means "fully
  -- refunded" in the LEGACY sense and would misstate a partial reversal
  -- (identical reasoning to mesa_post_refund_v1).
  UPDATE public.ordenes SET
    cobrado = v_is_paid, ya_pagado = v_is_paid,
    metodo_pago = CASE WHEN v_is_paid THEN v_method_projection ELSE COALESCE(metodo_pago,'') END
  WHERE order_uid = p_order_uid;

  v_remaining_after_cents := v_remaining_cents - v_amount_cents;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES ('ORDER_PAYMENT_REFUNDED', v_original.by_actor, p_by_actor,
    jsonb_build_object('orderUid', p_order_uid, 'originalTransactionId', v_original.id,
      'refundTransactionId', v_refund_tx.id, 'amount', v_amount_cents / 100.0,
      'paymentMethod', v_original.payment_method, 'reason', v_reason,
      'clientRequestId', p_client_request_id,
      'refundableRemainingAfter', v_remaining_after_cents / 100.0)
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false,
    'refundTransactionId', v_refund_tx.id, 'reversesTransactionId', v_original.id,
    'amount', v_refund_tx.amount, 'paymentMethod', v_refund_tx.payment_method,
    'originalAmount', v_original.amount,
    'refundedTotalOnOriginal', (round(v_original.amount*100)::bigint - v_remaining_after_cents) / 100.0,
    'refundableRemainingOnOriginal', v_remaining_after_cents / 100.0,
    'orderUid', p_order_uid,
    'currentObligation', v_obligation_cents / 100.0,
    'netCollectedAfter', v_new_paid_cents / 100.0,
    'unpaidAfter', GREATEST(0, v_obligation_cents - v_new_paid_cents) / 100.0,
    'overCollectedAfter', GREATEST(0, v_new_paid_cents - v_obligation_cents) / 100.0,
    'auditId', v_audit_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.order_post_refund_v1(
  uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_post_refund_v1(
  uuid, text, text, uuid, uuid, text, text, text, numeric, jsonb
) TO service_role;

-- ── 6. order_apply_commercial_adjustment_v1 — thin check-centric adapter ─────
-- Delegates entirely to the SAME order_obligation_apply_adjustment_v1 core
-- Mesa's own wrapper calls -- zero duplicated obligation logic (§15).
-- ADJUSTMENT_ROLES identical to Mesa: admin, owner only.
CREATE FUNCTION public.order_apply_commercial_adjustment_v1(
  p_workspace_id            uuid,
  p_by_actor                text,
  p_by_sid_hash             text,
  p_order_uid               uuid,
  p_new_gross               numeric,
  p_reason                  text,
  p_client_request_id       text,
  p_request_hash            text,
  p_expected_current_gross  numeric,
  p_meta                    jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_entity public.order_entities%ROWTYPE;
  v_ord public.ordenes%ROWTYPE;
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_res jsonb;
  v_net numeric;
  v_current numeric;
BEGIN
  IF p_workspace_id IS NULL OR p_order_uid IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'ORDER_ADJUSTMENT_META_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ORDER_ADJUSTMENT_REASON_REQUIRED' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_ADJUSTMENT_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- ADJUSTMENT_ROLES, identical to Mesa: admin/owner only (§25, no widening).
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'ORDER_ADJUSTMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_entity FROM public.order_entities WHERE order_uid = p_order_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_ADJUSTMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_entity.workspace_id <> p_workspace_id THEN
    RAISE EXCEPTION 'ORDER_ADJUSTMENT_WORKSPACE_MISMATCH' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_ADJUSTMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Delegates to the SAME shared core Mesa's own wrapper calls -- no
  -- duplicated obligation logic (§15). Any MESA_ADJUSTMENT_* exception
  -- below is this shared core's own vocabulary, unchanged, not renamed by
  -- this adapter.
  v_res := public.order_obligation_apply_adjustment_v1(
    p_order_uid, p_new_gross, 'manual', p_reason,
    p_by_actor, v_actor.role, p_client_request_id, p_request_hash, p_expected_current_gross);
  IF (v_res->>'changed')::boolean IS NOT TRUE AND (v_res->>'idempotent')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'ORDER_ADJUSTMENT_NO_CHANGE' USING ERRCODE='55000'; END IF;
  IF (v_res->>'idempotent')::boolean IS NOT TRUE THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('ORDER_COMMERCIAL_ADJUSTMENT', NULL, p_by_actor, jsonb_build_object(
      'orderUid', p_order_uid, 'orderId', v_ord.id,
      'previousObligation', v_res->'previousObligation', 'currentObligation', v_res->'currentObligation',
      'revision', v_res->'revision', 'cause', 'manual', 'bootstrapped', v_res->'bootstrapped',
      'clientRequestId', p_client_request_id, 'bySidHash', p_by_sid_hash, 'byRole', v_actor.role));
  END IF;

  -- netCollected from order_financial_events, NOT payment_allocations: a
  -- legacy event-only Servicio payment (payment_transaction_id NULL, zero
  -- allocations) is still real money and must still count here, or the
  -- overCollected WARN (§17 of the brief) would silently under-report it.
  SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END), 2), 0)
    INTO v_net
    FROM public.order_financial_events e
   WHERE e.service_session_id = v_ord.service_session_id AND e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund');
  v_current := (v_res->>'currentObligation')::numeric;
  RETURN v_res || jsonb_build_object(
    'orderId', v_ord.id, 'orderUid', p_order_uid, 'netCollected', round(v_net, 2),
    'unpaid', GREATEST(0, round(v_current - v_net, 2)),
    'overCollected', GREATEST(0, round(v_net - v_current, 2)));
END;
$function$;

REVOKE ALL ON FUNCTION public.order_apply_commercial_adjustment_v1(
  uuid, text, text, uuid, numeric, text, text, text, numeric, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_apply_commercial_adjustment_v1(
  uuid, text, text, uuid, numeric, text, text, text, numeric, jsonb
) TO service_role;

-- ── 7. mesa_post_refund_v1 — ONE line, the owner-approved NULL-safe fix ──────
-- With table_session_id now nullable, `<>` against a NULL LEFT side
-- evaluates to NULL (not TRUE), so the scope-mismatch guard would silently
-- fail to fire for a check-centric transaction routed here by mistake.
-- IS DISTINCT FROM is NULL-safe and, for every existing (always non-null)
-- Mesa transaction, behaviorally identical to the old `<>` (§5/§28 of the
-- brief; owner-approved, not a Mesa business-semantic redesign). This is
-- CREATE OR REPLACE, not DROP+CREATE: the signature is unchanged, so
-- existing grants (service_role-only) carry over untouched.
-- PARAMETER-DEFAULT FAST-FOLLOW -- a byte-exact apply attempt against live
-- STAGING failed with PostgreSQL 42P13 ("cannot remove parameter defaults
-- from existing function"): the live signature carries `p_amount numeric
-- DEFAULT NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb`, and CREATE OR
-- REPLACE refuses to silently drop existing defaults (unlike ordinary
-- CREATE OR REPLACE body/logic changes, a default is part of what the
-- command must reproduce verbatim to be accepted as a replace rather than
-- a signature change). "The signature is unchanged" above refers to
-- parameter identity (types/order/count) for pg_get_function_identity_
-- arguments purposes, which is genuinely untouched and is why grants still
-- carry over -- but the DEFAULT clauses are a separate PostgreSQL rule and
-- must be reproduced exactly, which this declaration now does.
CREATE OR REPLACE FUNCTION public.mesa_post_refund_v1(p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_original_transaction_id uuid, p_reason text, p_client_request_id text, p_request_hash text, p_amount numeric DEFAULT NULL::numeric, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_existing public.payment_transactions%ROWTYPE;
  v_original public.payment_transactions%ROWTYPE;
  v_refund_tx public.payment_transactions%ROWTYPE;
  v_alloc record;
  v_order record;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_reason text;
  v_remaining_cents bigint;
  v_amount_cents bigint;
  v_to_reverse_cents bigint;
  v_take_cents bigint;
  v_order_total_cents bigint;
  v_order_paid_before_cents bigint;
  v_order_allocation_cents bigint;
  v_new_paid_cents bigint;
  v_prev_state text;
  v_new_state text;
  v_scope text;
  v_settlement text;
  v_receipt_service_id uuid;
  v_table_total_cents bigint;
  v_table_paid_cents bigint;
  v_table_outstanding_cents bigint;
  v_remaining_after_cents bigint;
  v_reversed_allocations jsonb;
  v_affected_orders jsonb;
  v_order_ids jsonb;
  v_audit_id bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL OR p_original_transaction_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_client_request_id IS NULL OR length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'MESA_REFUND_INVALID' USING ERRCODE='22023'; END IF;

  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'MESA_REFUND_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  v_reason := btrim(p_reason);

  IF p_amount IS NOT NULL AND p_amount <= 0 THEN
    RAISE EXCEPTION 'MESA_REFUND_AMOUNT_INVALID' USING ERRCODE='22023';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESA_REFUND_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  -- REFUND_ROLES -- narrower than PAYMENT_ROLES on purpose: the role that takes
  -- money should not be the one that can silently return it (admin/owner only).
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'MESA_REFUND_FORBIDDEN' USING ERRCODE='42501'; END IF;

  -- Idempotency -- reuses payment_transactions_idempotency_uq (workspace_id,
  -- client_request_id) verbatim; refunds and payments share the same table and the
  -- same identity rule.
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESA_REFUND_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
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
    SELECT (round(pt.amount*100)::bigint - COALESCE((
        SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
         WHERE r.kind='refund' AND r.reverses_transaction_id = pt.id
      ),0)) INTO v_remaining_after_cents
      FROM public.payment_transactions pt WHERE pt.id = v_existing.reverses_transaction_id;
    SELECT jsonb_agg(jsonb_build_object('tableOrderLineId', a.table_order_line_id,
        'orderId', a.order_id, 'amount', a.amount) ORDER BY a.created_at, a.id)
      INTO v_reversed_allocations
      FROM public.payment_allocations a WHERE a.payment_transaction_id = v_existing.id;
    SELECT jsonb_agg(jsonb_build_object('orderId', e.order_id, 'amount', e.amount,
        'prevPayState', e.prev_pay_state, 'newPayState', e.new_pay_state) ORDER BY e.order_id)
      INTO v_affected_orders
      FROM public.order_financial_events e WHERE e.payment_transaction_id = v_existing.id;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true,
      'refundTransactionId', v_existing.id, 'reversesTransactionId', v_existing.reverses_transaction_id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'refundableRemainingOnOriginal', COALESCE(v_remaining_after_cents,0) / 100.0,
      'reversedAllocations', COALESCE(v_reversed_allocations, '[]'::jsonb),
      'affectedOrders', COALESCE(v_affected_orders, '[]'::jsonb)
    );
  END IF;

  -- Closed tables are accepted deliberately (§J.2 of the contract): a refund never
  -- reopens a table session, never touches status/settled_at/closed_at.
  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Lock the ORIGINAL transaction -- this is what makes concurrent over-refund
  -- attempts serialise and the second recompute a now-lower remaining balance.
  SELECT * INTO v_original FROM public.payment_transactions
   WHERE id = p_original_transaction_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_TRANSACTION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_original.kind <> 'payment' THEN RAISE EXCEPTION 'MESA_REFUND_NOT_REFUNDABLE' USING ERRCODE='55000'; END IF;
  -- CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122) -- NULL-safe fix, owner-approved
  -- (§5/§28 of the brief). table_session_id is nullable as of this migration; the old
  -- `<>` evaluated to NULL (never TRUE) when the LEFT side was NULL, so a check-centric
  -- transaction (table_session_id IS NULL) could slip past this scope assertion. For
  -- every existing Mesa transaction (table_session_id always non-null) this is
  -- behaviorally IDENTICAL to the old comparison -- not a Mesa semantic change.
  IF v_original.table_session_id IS DISTINCT FROM p_table_session_id THEN
    RAISE EXCEPTION 'MESA_REFUND_TRANSACTION_MISMATCH' USING ERRCODE='55000';
  END IF;

  SELECT round(v_original.amount*100)::bigint - COALESCE((
      SELECT sum(round(r.amount*100))::bigint FROM public.payment_transactions r
       WHERE r.kind='refund' AND r.reverses_transaction_id = v_original.id
    ),0) INTO v_remaining_cents;
  IF v_remaining_cents <= 0 THEN RAISE EXCEPTION 'MESA_REFUND_ALREADY_FULL' USING ERRCODE='55000'; END IF;

  v_amount_cents := CASE WHEN p_amount IS NULL THEN v_remaining_cents ELSE round(p_amount*100)::bigint END;
  IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'MESA_REFUND_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  IF v_amount_cents > v_remaining_cents THEN RAISE EXCEPTION 'MESA_REFUND_EXCEEDS_REMAINING' USING ERRCODE='55000'; END IF;

  SELECT ss.id INTO v_receipt_service_id
    FROM public.service_session_state sst
    JOIN public.service_sessions ss ON ss.id = sst.current_session_id AND ss.status = 'open'
   WHERE sst.singleton = true;

  -- §H.4 -- record, don't claim: tarjeta/bizum note that La Dieci is RECORDING an
  -- externally executed return, never that it executed a bank/POS operation.
  v_settlement := CASE WHEN v_original.payment_method = 'efectivo' THEN 'drawer' ELSE 'external' END;

  -- The refund's payment_method is FORCED from the original -- no caller-supplied
  -- method exists in this signature (§9 of the brief, frozen for V1).
  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, reverses_transaction_id, by_actor, by_role,
    by_sid_hash, client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_session.service_session_id, 'refund', 'refund',
    v_amount_cents / 100.0, v_original.payment_method, 0, v_original.id,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id, p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_refund_tx;

  -- Reversal allocation loop -- reverses PT-A's OWN allocations, in
  -- mesa_post_payment_v1's own deterministic line order, capped per (PT-A, line) by
  -- what PT-A itself put there minus what prior refunds against PT-A already took.
  -- The operator never chooses lines; this loop is not a fresh allocation.
  v_to_reverse_cents := v_amount_cents;
  FOR v_alloc IN
    SELECT a.id, a.table_order_line_id, a.order_id, a.amount,
      round(a.amount * 100)::bigint - COALESCE((
        SELECT sum(round(ra.amount * 100))::bigint
          FROM public.payment_allocations ra
          JOIN public.payment_transactions rt ON rt.id = ra.payment_transaction_id
         WHERE rt.kind = 'refund' AND rt.reverses_transaction_id = v_original.id
           AND ra.table_order_line_id = a.table_order_line_id
      ), 0) AS reversible_cents
    FROM public.payment_allocations a
    JOIN public.table_order_lines l ON l.id = a.table_order_line_id
    WHERE a.payment_transaction_id = v_original.id
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_reverse_cents <= 0;
    CONTINUE WHEN v_alloc.reversible_cents <= 0;
    v_take_cents := LEAST(v_to_reverse_cents, v_alloc.reversible_cents);
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_refund_tx.id, v_alloc.table_order_line_id, v_alloc.order_id, v_take_cents / 100.0, v_now);
    v_to_reverse_cents := v_to_reverse_cents - v_take_cents;
  END LOOP;
  IF v_to_reverse_cents <> 0 THEN RAISE EXCEPTION 'MESA_REFUND_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  -- One order_financial_events row per order that actually received a reversal
  -- allocation -- never zero-amount rows, never an order untouched by this refund.
  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents,
      o.service_session_id AS obligation_service_session_id, o.estado
      FROM public.payment_allocations a
      JOIN public.ordenes o ON o.id = a.order_id
     WHERE a.payment_transaction_id = v_refund_tx.id
     GROUP BY a.order_id, o.service_session_id, o.estado ORDER BY a.order_id
  LOOP
    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents
      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;
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
    v_new_paid_cents := v_order_paid_before_cents - v_order_allocation_cents;
    v_new_state := CASE
      WHEN v_new_paid_cents <= 0 THEN 'unpaid'
      WHEN v_new_paid_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_scope := 'mesa_' || replace(v_refund_tx.id::text, '-', '');

    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      event_service_session_id, payment_transaction_id, created_at
    )
    SELECT o.id, 'refund', v_order_allocation_cents / 100.0, v_original.payment_method,
      v_reason, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','mesa','mode','refund','transaction_id',v_refund_tx.id,
        'reverses_transaction_id', v_original.id, 'settlement', v_settlement),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_refund_tx.id::text, v_order_allocation_cents::text,
        v_original.payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_receipt_service_id, v_refund_tx.id, v_now
    FROM public.ordenes o WHERE o.id=v_order.order_id AND o.table_session_id=v_session.id;
  END LOOP;

  -- Same projection expression mesa_post_payment_v1 uses -- one source of truth,
  -- copied verbatim rather than reimplemented. cobrado/ya_pagado/metodo_pago only;
  -- ordenes.refunded is never set (it means "fully refunded" in the LEGACY sense
  -- and would misstate a partial reversal).
  UPDATE public.ordenes o SET
    cobrado = calc.is_paid,
    ya_pagado = calc.is_paid,
    metodo_pago = CASE WHEN calc.is_paid THEN calc.method_projection ELSE COALESCE(o.metodo_pago,'') END
  FROM (
    SELECT l.order_id,
      COALESCE(sum(l.net_amount),0) <= COALESCE((
        SELECT sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)
          FROM public.order_financial_events e
         WHERE e.service_session_id=l.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported','refund')
      ),0) AS is_paid,
      CASE WHEN (
        SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=l.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) > 1 THEN 'MIXTO' ELSE (
        SELECT max(e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=l.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) END AS method_projection
    FROM public.table_order_lines l WHERE l.table_session_id=v_session.id GROUP BY l.order_id, l.service_session_id
  ) calc
  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;

  v_remaining_after_cents := v_remaining_cents - v_amount_cents;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_table_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO'); -- language-guard: allow-legacy CHIUSO_FORZATO is the pre-existing terminal-estado literal mesa_post_payment_v1 already filters on, reproduced verbatim in this new writer's own table-outstanding query, not new vocabulary
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_table_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_table_outstanding_cents := GREATEST(0, v_table_total_cents - v_table_paid_cents);

  SELECT jsonb_agg(jsonb_build_object('tableOrderLineId', a.table_order_line_id,
      'orderId', a.order_id, 'amount', a.amount) ORDER BY a.created_at, a.id)
    INTO v_reversed_allocations
    FROM public.payment_allocations a WHERE a.payment_transaction_id = v_refund_tx.id;
  SELECT jsonb_agg(jsonb_build_object('orderId', e.order_id, 'amount', e.amount,
      'prevPayState', e.prev_pay_state, 'newPayState', e.new_pay_state) ORDER BY e.order_id)
    INTO v_affected_orders
    FROM public.order_financial_events e WHERE e.payment_transaction_id = v_refund_tx.id;
  SELECT jsonb_agg(DISTINCT a.order_id) INTO v_order_ids
    FROM public.payment_allocations a WHERE a.payment_transaction_id = v_refund_tx.id;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES (
    'MESA_PAYMENT_REFUNDED',
    v_original.by_actor,
    p_by_actor,
    jsonb_build_object(
      'tableSessionId', v_session.id, 'originalTransactionId', v_original.id,
      'refundTransactionId', v_refund_tx.id, 'amount', v_amount_cents / 100.0,
      'paymentMethod', v_original.payment_method, 'reason', v_reason,
      'clientRequestId', p_client_request_id,
      'orderIds', COALESCE(v_order_ids, '[]'::jsonb),
      'refundableRemainingAfter', v_remaining_after_cents / 100.0
    )
  ) RETURNING id INTO v_audit_id;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false,
    'refundTransactionId', v_refund_tx.id, 'reversesTransactionId', v_original.id,
    'amount', v_refund_tx.amount, 'paymentMethod', v_refund_tx.payment_method,
    'originalAmount', v_original.amount,
    'refundedTotalOnOriginal', (round(v_original.amount*100)::bigint - v_remaining_after_cents) / 100.0,
    'refundableRemainingOnOriginal', v_remaining_after_cents / 100.0,
    'reversedAllocations', COALESCE(v_reversed_allocations, '[]'::jsonb),
    'affectedOrders', COALESCE(v_affected_orders, '[]'::jsonb),
    'tableTotal', v_table_total_cents / 100.0,
    'tableOutstandingAfter', v_table_outstanding_cents / 100.0,
    'tableStatus', v_session.status,
    'auditId', v_audit_id
  );
END
$function$;

-- ── 8. order_initial_payment_v1 — repoint creation-time payment to canonical ──
-- Same trigger, same guards, same idempotency KEY (`pay-order-<id>`) -- only
-- the WRITER changes, from the legacy event-only order_mark_paid to the
-- canonical order_post_payment_v1. Requires the intent to now also carry
-- `sid_hash` (computed server-side from the same JWT `sid` field Mesa
-- already hashes -- see src/auth/sidHash.js; backend wiring in this same
-- slice). `sv`/`ip_hash` stay in the intent shape unused by this trigger
-- (kept, not removed, to minimise blast radius on other intent consumers).
CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := NEW.initial_payment_intent;
  v_method text;
  v_actor  text;
  v_sid_hash text;
  v_workspace_id uuid;
  v_client_request_id text;
  v_request_hash text;
BEGIN
  -- Defence in depth: the trigger is already WHEN-scoped to a non-null intent.
  IF v_intent IS NULL THEN
    RETURN NEW;
  END IF;

  -- Mesa settles through its own payment hub (payment_transactions /
  -- payment_allocations / mesa_post_payment_v1). A table order must never take a
  -- second, parallel payment here. The frontend already forbids it; this refuses
  -- it at the boundary rather than trusting that.
  IF NEW.table_session_id IS NOT NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s table_session=%s', NEW.id, NEW.table_session_id);
  END IF;

  -- The whole point of N-3: legacy-paid authority must NOT precede the canonical
  -- payment. If either flag arrived true, someone is still trying to declare money
  -- with a boolean -- refuse rather than paper over it.
  IF NEW.ya_pagado IS TRUE OR NEW.cobrado IS TRUE THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s ya_pagado=%s cobrado=%s', NEW.id, NEW.ya_pagado, NEW.cobrado);
  END IF;

  v_method   := lower(btrim(COALESCE(v_intent->>'method', '')));
  v_actor    := btrim(COALESCE(v_intent->>'actor', ''));
  v_sid_hash := lower(btrim(COALESCE(v_intent->>'sid_hash', '')));

  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_METHOD_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s method=%s', NEW.id, v_method);
  END IF;
  IF v_actor = '' OR v_sid_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_CONTEXT_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s actor_present=%s sid_hash_valid=%s',
                      NEW.id, (v_actor <> ''), (v_sid_hash ~ '^[0-9a-f]{64}$'));
  END IF;

  SELECT oe.workspace_id INTO v_workspace_id
    FROM public.order_entities oe WHERE oe.order_uid = NEW.order_uid;
  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_WORKSPACE_UNRESOLVED' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s order_uid=%s', NEW.id, NEW.order_uid);
  END IF;

  -- SAME deterministic per-order key the legacy path always used -- this is what
  -- makes a replayed order-creation request replay instead of double-paying
  -- (§9/§22 of the brief): payment_transactions_idempotency_uq is (workspace_id,
  -- client_request_id), so this key now plays exactly the role
  -- registerOperatorPayment.js's idem_scope_key played for _ledger_write_payment.
  v_client_request_id := 'pay-order-' || regexp_replace(NEW.id, '[^A-Za-z0-9_-]', '', 'g');
  v_request_hash := encode(digest(concat_ws('|', 'initial_payment_at_creation', NEW.id,
    NEW.order_uid::text, v_method), 'sha256'), 'hex');

  -- THE canonical check-centric payment writer -- same authority, server-derived
  -- amount, digest, and legacy mirrors as the operator collection path (§R of the
  -- audit). mode='full': a creation-time "ya pagado" always settles the order's
  -- FULL obligation, exactly like _ledger_write_payment/order_mark_paid did.
  PERFORM public.order_post_payment_v1(
    v_workspace_id, v_actor, v_sid_hash, NEW.order_uid, v_method, 'full', NULL,
    v_client_request_id, v_request_hash,
    jsonb_build_object('source', 'initial_payment_at_creation'), false);

  -- The intent has done its one job. Clearing it here keeps the column NULL at
  -- rest; this UPDATE touches no economic column, so neither N-5's guard nor
  -- N-2's revision trigger fires.
  UPDATE public.ordenes SET initial_payment_intent = NULL WHERE id = NEW.id;

  RETURN NEW;
END;
$function$;

-- ── POST-CONDITION: contract shape present, Mesa untouched, no backfill ──────
DO $post$
DECLARE
  v_def text;
  v_n integer;
BEGIN
  -- 1. payment_transactions.table_session_id nullable + scope CHECK exact shape.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='payment_transactions'
                    AND column_name='table_session_id' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_transactions.table_session_id is not nullable';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.payment_transactions'::regclass AND conname='payment_transactions_scope_chk')
     IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))' THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_transactions_scope_chk missing or wrong shape';
  END IF;

  -- 2. payment_allocations shape.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='payment_allocations'
                    AND column_name='table_order_line_id' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations.table_order_line_id is not nullable';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='payment_allocations'
                    AND column_name='order_uid' AND data_type='uuid' AND is_nullable='YES') THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations.order_uid missing or wrong shape';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.payment_allocations'::regclass AND conname='payment_allocations_target_chk')
     IS DISTINCT FROM 'CHECK (((table_order_line_id IS NOT NULL) OR (order_uid IS NOT NULL)))' THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations_target_chk missing or wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.payment_allocations'::regclass
                   AND conname='payment_allocations_order_uid_fkey' AND contype='f') THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations_order_uid_fkey missing';
  END IF;
  IF (SELECT confrelid FROM pg_constraint WHERE conrelid='public.payment_allocations'::regclass
        AND conname='payment_allocations_order_uid_fkey') <> 'public.order_entities'::regclass THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations_order_uid_fkey does not target order_entities';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='payment_allocations'
                   AND indexname='payment_allocations_transaction_order_uq'
                   AND indexdef LIKE '%UNIQUE INDEX%(payment_transaction_id, order_uid)%WHERE (table_order_line_id IS NULL)%') THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations_transaction_order_uq missing or wrong shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='payment_allocations'
                   AND indexname='payment_allocations_order_uid_idx') THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations_order_uid_idx missing';
  END IF;

  -- 3. auth_audit_event_chk carries the two new values.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.auth_audit'::regclass AND conname='auth_audit_event_chk')
     NOT LIKE '%ORDER_PAYMENT_REFUNDED%'
     OR (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid='public.auth_audit'::regclass AND conname='auth_audit_event_chk')
     NOT LIKE '%ORDER_COMMERCIAL_ADJUSTMENT%' THEN
    RAISE EXCEPTION 'M122 post-condition failed: auth_audit_event_chk missing a new event value';
  END IF;

  -- 4. Exactly one overload of each new function, service_role-only.
  FOR v_def IN SELECT unnest(ARRAY['order_post_payment_v1','order_post_refund_v1','order_apply_commercial_adjustment_v1'])
  LOOP
    SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_def;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'M122 post-condition failed: expected exactly 1 overload of %, found %', v_def, v_n;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='public' AND p.proname=v_def
                  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
                       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
      RAISE EXCEPTION 'M122 post-condition failed: % is executable by a browser role', v_def;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname=v_def
                      AND has_function_privilege('service_role', p.oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'M122 post-condition failed: service_role lacks EXECUTE on %', v_def;
    END IF;
  END LOOP;

  -- 5. mesa_post_refund_v1 carries the fix and only the fix.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1';
  IF position('v_original.table_session_id <> p_table_session_id' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: mesa_post_refund_v1 still uses the NULL-unsafe comparison';
  END IF;
  IF position('v_original.table_session_id IS DISTINCT FROM p_table_session_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: mesa_post_refund_v1 is missing the IS DISTINCT FROM fix';
  END IF;

  -- 6. Mesa/shared core untouched -- byte-identical to the guard's snapshot.
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='mesa_post_payment_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_mesa_pay_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: mesa_post_payment_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='mesa_close_session_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_mesa_close_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: mesa_close_session_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='mesa_post_commercial_adjustment_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_mesa_adj_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: mesa_post_commercial_adjustment_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='order_obligation_apply_adjustment_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_obl_adj_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_obligation_apply_adjustment_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='order_canonical_obligation_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_canon_obl_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_canonical_obligation_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='order_has_economic_evidence_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_has_evidence_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_has_economic_evidence_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='paid_order_economic_mutation_guard_v1' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_paid_guard_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: paid_order_economic_mutation_guard_v1 body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='service_session_assign_financial_event' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_assign_fe_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: service_session_assign_financial_event body changed';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='_ledger_write_payment' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_ledger_write_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: _ledger_write_payment body changed -- rider must stay untouched';
  END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE proname='order_mark_paid' AND pronamespace='public'::regnamespace))
     IS DISTINCT FROM current_setting('ladieci.m122_order_mark_paid_md5', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_mark_paid body changed';
  END IF;

  -- 7. order_initial_payment_v1 now calls the canonical writer, not the legacy one.
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_initial_payment_v1';
  -- COMMENT-SAFE FAST-FOLLOW -- a real byte-exact STAGING apply attempt proved
  -- this check false-positives: pg_get_functiondef() returns prosrc verbatim,
  -- comments included (Postgres never strips them from the stored source), and
  -- this very function's body explains itself with a comment naming BOTH
  -- writers for historical context ("...exactly like _ledger_write_payment/
  -- order_mark_paid did." -- see the item-6 comment above this trigger). A bare
  -- substring search on either function name is therefore unsound in BOTH
  -- directions: it can wrongly REJECT a correct migration (the bug this fixes,
  -- caught live) or wrongly ACCEPT a broken one where the real call was
  -- removed but a comment mentioning the name was left behind. The fix
  -- asserts the actual PL/pgSQL CALL STATEMENT shape this codebase already
  -- uses for this exact trigger -- schema-qualified, immediately followed by
  -- an opening paren, matching both the legacy call this trigger used before
  -- this migration (`PERFORM public.order_mark_paid(`, see
  -- 2026-08-24_n3_canonical_initial_payment.sql) and the canonical call it
  -- uses now (`PERFORM public.order_post_payment_v1(`, item 6 above) -- a
  -- prose mention can never accidentally reproduce this exact shape.
  IF position('PERFORM public.order_post_payment_v1(' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_initial_payment_v1 does not call order_post_payment_v1';
  END IF;
  IF position('PERFORM public.order_mark_paid(' IN v_def) > 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_initial_payment_v1 still references order_mark_paid';
  END IF;
  IF position('pay-order-' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_initial_payment_v1 lost the deterministic pay-order-<id> key';
  END IF;
  IF position('INITIAL_PAYMENT_NOT_FOR_TABLE_ORDER' IN v_def) = 0
     OR position('INITIAL_PAYMENT_LEGACY_FLAG_PRESENT' IN v_def) = 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_initial_payment_v1 lost an existing N-3 guard';
  END IF;

  -- 8. NO backfill: row counts unchanged, zero NULLs beyond the pre-existing zero.
  IF (SELECT count(*)::text FROM public.payment_transactions) IS DISTINCT FROM current_setting('ladieci.m122_pt_count', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_transactions row count changed';
  END IF;
  IF (SELECT count(*)::text FROM public.payment_allocations) IS DISTINCT FROM current_setting('ladieci.m122_pa_count', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations row count changed';
  END IF;
  IF (SELECT count(*)::text FROM public.ordenes) IS DISTINCT FROM current_setting('ladieci.m122_ordenes_count', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: ordenes row count changed';
  END IF;
  IF (SELECT count(*)::text FROM public.order_financial_events) IS DISTINCT FROM current_setting('ladieci.m122_ofe_count', true) THEN
    RAISE EXCEPTION 'M122 post-condition failed: order_financial_events row count changed';
  END IF;
  IF (SELECT count(*) FROM public.payment_transactions WHERE table_session_id IS NULL) <> 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: a payment_transactions row was backfilled with a NULL table_session_id';
  END IF;
  IF (SELECT count(*) FROM public.payment_allocations WHERE table_order_line_id IS NULL OR order_uid IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: a payment_allocations row was backfilled as check-centric';
  END IF;

  -- 9. Append-only triggers still live.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='payment_transactions'
                   AND t.tgname='payment_transactions_append_only_v1' AND NOT t.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                  JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.relname='payment_allocations'
                   AND t.tgname='payment_allocations_append_only_v1' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'M122 post-condition failed: an append-only trigger disappeared';
  END IF;
  -- APPEND-ONLY ENFORCEMENT FAST-FOLLOW -- a real byte-exact STAGING apply
  -- attempt proved the check above (has_table_privilege) false: it asserted
  -- an invariant this system has never actually had. The historical
  -- foundation migration (2026-08-01_v3h_messa_billing_foundation.sql) -- language-guard: allow-legacy existing filename cited verbatim, not new vocabulary
  -- GRANTs service_role only SELECT, INSERT on both tables -- UPDATE/DELETE
  -- were never explicitly granted here, but were never explicitly REVOKEd
  -- either, and Supabase's own platform-level default privileges for
  -- service_role include UPDATE/DELETE on every public-schema table
  -- regardless of what any migration in this repo grants (independently
  -- confirmed live: has_table_privilege('service_role', ..., 'UPDATE'/
  -- 'DELETE') is TRUE on both tables today, on a database with zero
  -- REVOKE of either privilege anywhere in its migration history). The
  -- REAL, and only ever intended, enforcement is the trigger: both
  -- payment_transactions_append_only_v1 and payment_allocations_
  -- append_only_v1 fire BEFORE DELETE OR UPDATE and unconditionally RAISE
  -- via mesa_append_only_v1() -- confirmed by that function's own live body
  -- (`BEGIN RAISE EXCEPTION 'MESA_APPEND_ONLY' ...; END`), which blocks the
  -- mutation regardless of what table-level grants exist. No REVOKE is
  -- introduced anywhere in this migration; that is a deliberately separate,
  -- deferred decision (see FINANCIAL_LEDGER_SERVICE_ROLE_PRIVILEGE_
  -- HARDENING_REVIEW in the slice report) -- this fast-follow is a
  -- verification-contract correction only.
  --
  -- ROBUSTNESS FAST-FOLLOW -- the FIRST version of this check (above
  -- history) compared pg_get_triggerdef()'s RENDERED text against a
  -- hard-coded string ending "...EXECUTE FUNCTION mesa_append_only_v1()".
  -- That is search_path-dependent: Postgres only omits the schema
  -- qualifier from the rendered EXECUTE FUNCTION clause when the function's
  -- schema is resolvable via the CURRENT session's search_path at render
  -- time. Verified live, read-only, both ways in the same session: with
  -- search_path including 'public' (the ordinary case) it renders
  -- "EXECUTE FUNCTION mesa_append_only_v1()"; with
  -- `SET LOCAL search_path = pg_catalog` it renders "EXECUTE FUNCTION
  -- public.mesa_append_only_v1()" -- a byte-for-byte different string for
  -- the IDENTICAL trigger, which would have made this exact check spuriously
  -- refuse a correct migration under nothing more than a different session
  -- environment. Replaced with catalog IDENTITY instead of catalog TEXT:
  --   - t.tgfoid = 'public.mesa_append_only_v1()'::regprocedure -- OID
  --     equality, not name text. The comparison's OWN literal is explicitly
  --     schema-qualified, so the cast resolves the SAME function regardless
  --     of the executing session's search_path (independently re-verified
  --     live under `SET LOCAL search_path = pg_catalog`: identical TRUE).
  --   - t.tgtype -- Postgres does not expose named boolean accessors for
  --     trigger timing/events, only this bitmask column, so the specific
  --     bits were derived from LIVE catalog evidence (not memory) by cross-
  --     referencing every non-internal public-schema trigger's tgtype
  --     against its own pg_get_triggerdef() text and solving the resulting
  --     system: AFTER INSERT ROW=5, BEFORE INSERT ROW=7 (so BEFORE=2),
  --     BEFORE DELETE ROW=11, AFTER UPDATE ROW=17, BEFORE UPDATE ROW=19,
  --     AFTER INSERT-OR-UPDATE ROW=21, BEFORE INSERT-OR-UPDATE ROW=23,
  --     AFTER DELETE-OR-UPDATE ROW=25 -- twelve independent real examples,
  --     every one consistent with exactly one solution: ROW=1, BEFORE=2,
  --     INSERT=4, DELETE=8, UPDATE=16 (matching PostgreSQL's own documented
  --     TRIGGER_TYPE_* bit layout, confirmed rather than assumed). The
  --     historically-installed trigger's own tgtype is 27 = ROW+BEFORE+
  --     DELETE+UPDATE (1+2+8+16) -- exactly "BEFORE DELETE OR UPDATE ...
  --     FOR EACH ROW", verified against FIVE other real triggers in this
  --     same database sharing that identical tgtype=27 (order_entities_
  --     append_only_v1 among them, also on mesa_append_only_v1() itself).
  --     Asserting the exact value therefore proves BEFORE (not AFTER),
  --     both UPDATE and DELETE (not one alone), and ROW-level (not
  --     STATEMENT) all at once, with no rendered-text/search_path exposure.
  --   - t.tgenabled IN ('O','A') -- 'O' (origin/normal) is the frozen live
  --     state; 'A' (always) is likewise active under every
  --     session_replication_role and so equally protects ordinary writes.
  --     'R' (replica-only) is deliberately REJECTED here even though it is
  --     not literally "disabled": a replica-only trigger does not fire for
  --     ordinary application sessions (session_replication_role='origin'),
  --     so it would NOT protect the writes this invariant actually cares
  --     about -- the prior `<> 'D'` form wrongly accepted it. 'D'
  --     (disabled) is rejected as before.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='payment_transactions'
      AND t.tgname='payment_transactions_append_only_v1' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A')
      AND t.tgfoid = 'public.mesa_append_only_v1()'::regprocedure
      AND t.tgtype = 27  -- ROW(1) + BEFORE(2) + DELETE(8) + UPDATE(16), empirically derived above
  ) THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_transactions_append_only_v1 is missing, disabled/replica-only, targets the wrong function, or no longer covers BEFORE ROW DELETE-OR-UPDATE';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='payment_allocations'
      AND t.tgname='payment_allocations_append_only_v1' AND NOT t.tgisinternal
      AND t.tgenabled IN ('O','A')
      AND t.tgfoid = 'public.mesa_append_only_v1()'::regprocedure
      AND t.tgtype = 27  -- ROW(1) + BEFORE(2) + DELETE(8) + UPDATE(16), empirically derived above
  ) THEN
    RAISE EXCEPTION 'M122 post-condition failed: payment_allocations_append_only_v1 is missing, disabled/replica-only, targets the wrong function, or no longer covers BEFORE ROW DELETE-OR-UPDATE';
  END IF;
  IF position('RAISE EXCEPTION' IN (SELECT prosrc FROM pg_proc WHERE proname='mesa_append_only_v1' AND pronamespace='public'::regnamespace)) = 0 THEN
    RAISE EXCEPTION 'M122 post-condition failed: mesa_append_only_v1 no longer unconditionally raises -- append-only enforcement silently defanged';
  END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-121: registered as a separate statement at apply time -- apply_order 122,
-- kind 'ddl', checksum = this file's sha256, applied_by = the introducing
-- commit (committed BEFORE this migration is applied). NOT APPLIED in this
-- block -- ledger stays 121.

COMMIT;
