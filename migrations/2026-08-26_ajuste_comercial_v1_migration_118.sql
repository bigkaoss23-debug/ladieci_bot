-- migrations/2026-08-26_ajuste_comercial_v1_migration_118.sql
-- AJUSTE COMERCIAL V1 -- commercial adjustment, atomic cancellation, canonical
-- obligation reads.
--
-- Contract: REPORT_AJUSTE_COMERCIAL_V1_CONTRACT_2026-08-26.md (verdict
-- AJUSTE_COMERCIAL_V1_CONTRACT_READY), which itself closes the two questions the
-- earlier CANCELLED_ORDER_ALLOCATION_EXPOSURE_AND_OVER_COLLECTED_CONTRACT_2026-08-26.md
-- left open. Over-Collected Slice A (commit 5008e77, no migration) already fixed the
-- READERS; this migration fixes the WRITERS and adds the missing primitive.
--
-- THE MODEL, IN ONE LINE: a commercial adjustment moves what the customer OWES
-- (order_obligations) and never touches money; a refund moves MONEY and never touches
-- the obligation; a cancellation is an operational fact that MUST carry an obligation
-- adjustment to 0 with it, atomically, and must never fabricate a refund.
--
--   netCollected      = SUM(payments) - SUM(refunds)
--   currentObligation = latest order_obligations revision (legacy fallback: ordenes.totale)
--   unpaid            = max(0, currentObligation - netCollected)
--   overCollected     = max(0, netCollected - currentObligation)
--
-- ── WHY order_obligations NEEDED COLUMNS (the earlier audit said it did not) ──
-- order_obligations carries id/order_uid/order_id/service_session_id/workspace_id/
-- revision/gross_amount/channel/source/economic_period_kind/created_at and NOTHING
-- else: no reason, no actor, no role, no idempotency key, no cause. A writer that
-- reduces what the house is owed cannot be built on that. Seven columns are added,
-- ALL nullable or defaulted, so every one of the 6 existing rows and every future
-- anchor/revision row written by the two pre-existing triggers stays valid unchanged.
--
-- ── WHY THE BOOTSTRAP IS "revision 1 = order_create_v1, revision 2 = adjustment" ──
-- order_obligations_create_rev_chk is a BICONDITIONAL:
--     CHECK ((source = 'order_create_v1') = (revision = 1))
-- It forces both directions: a non-create source must be revision >= 2, AND revision 1
-- must be source 'order_create_v1'. So a legacy order (53 of 59 live rows have no
-- obligation row at all) cannot receive an adjustment as its first revision without
-- relaxing that CHECK -- and relaxing it would permanently destroy the invariant
-- "revision 1 is always the creation baseline", which is exactly what Fiscal Core needs
-- to identify the original obligation. THIS MIGRATION DOES NOT TOUCH THAT CHECK. The
-- constraint selects the design: materialize the creation baseline first, then append.
--
-- ── WHY THE BOOTSTRAP BASELINE IS ordenes.totale, NEVER A LINE SUM ──
-- table_order_lines has NO order_uid: it keys on order_id text, the RECYCLED display
-- #NNN. Live, 7 of 42 line-bearing orders "drift" against ordenes.totale purely because
-- foreign-session lines share their display id (#379 sums to 52.50 against a real
-- totale of 27.50; 5 of the 7 have no own-session lines at all). Session-scoping
-- removes the drift entirely, but the safe tuple is the ORDER ROW, which carries the
-- money and the permanent order_uid together. Bootstrapping from a line sum would
-- import Class B identity corruption into an append-only financial ledger.
-- CONSEQUENCE, LOAD-BEARING: the legacy FALLBACK used by the canonical obligation
-- reader is the SAME ordenes.totale, so materializing an order's baseline can never
-- change the obligation that was already being read for it.
--
-- ── WHAT IS DELIBERATELY NOT TOUCHED ──
-- * order_obligations_create_rev_chk -- see above.
-- * paid_order_economic_mutation_guard_v1 -- correct as-is. It fires on UPDATE OF
--   totale/delivery_fee/descuento_*, NOT on estado, so the new cancellation writer
--   changes state on a paid order without tripping it, and no direct economic mutation
--   is re-enabled. Ajuste Comercial exists precisely so those columns stay immutable.
-- * mesa_post_refund_v1 -- Refund V1 semantics frozen (ledger 117). Untouched.
-- * CHIUSO_FORZATO -- operational, never an economic cancellation (N-1 removed its only  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
--   writer). It is REMOVED from the two remaining economic filters in this file, which
--   aligns the writers with the readers Slice A already fixed. All 9 live
--   CHIUSO_FORZATO rows sit in CLOSED table sessions, so this is inert for live  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
--   operation and is an alignment, not a new product call.
-- * Class B (order_uid on table_order_lines / payment_allocations) -- OUT OF SCOPE. The
--   new writers target order_uid and FAIL CLOSED when it is absent.
-- * No backfill. Not one historical row is written by this migration.
--
BEGIN;

-- ══════════════════════════════════════════════════════════════════════════
-- 0. PREDECESSOR GUARD -- refuse to run against an unexpected schema.
-- ══════════════════════════════════════════════════════════════════════════
DO $guard$
DECLARE v_def text;
BEGIN
  IF to_regclass('public.order_obligations') IS NULL THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: order_obligations missing (N-2 / ledger 112 not applied)';
  END IF;

  -- The biconditional this whole design depends on must be present, verbatim.
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid='public.order_obligations'::regclass AND conname='order_obligations_create_rev_chk';
  IF v_def IS NULL OR v_def !~ 'order_create_v1' OR v_def !~ 'revision = 1' THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: order_obligations_create_rev_chk missing or unrecognised (got: %)', COALESCE(v_def,'<null>');
  END IF;

  -- Not already applied.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='order_obligations' AND column_name='cause') THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: already applied (order_obligations.cause exists)';
  END IF;

  -- Predecessors whose behaviour this migration composes with.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_obligations'::regclass
                  AND NOT tgisinternal AND tgname='order_obligations_append_only_v1') THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: order_obligations append-only trigger missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: N-5 economic mutation guard missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1') THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: N-2 obligation anchor missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1') THEN
    RAISE EXCEPTION 'AJUSTE_118 guard: Refund V1 (ledger 117) not applied';
  END IF;

  -- Capture the refund writer's body so a post-condition can prove we never touched it.
  PERFORM set_config('ladieci.aj118_refund_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1'), true);
  PERFORM set_config('ladieci.aj118_n5guard_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='paid_order_economic_mutation_guard_v1'), true);
  PERFORM set_config('ladieci.aj118_anchor_md5_before',
    (SELECT md5(prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_obligation_anchor_v1'), true);
END $guard$;

-- ══════════════════════════════════════════════════════════════════════════
-- 1. order_obligations -- provenance, attribution and idempotency columns.
--    All additive. Existing rows remain valid without being rewritten.
-- ══════════════════════════════════════════════════════════════════════════
ALTER TABLE public.order_obligations
  ADD COLUMN cause               text,
  ADD COLUMN reason              text,
  ADD COLUMN by_actor            text,
  ADD COLUMN by_role             text,
  ADD COLUMN client_request_id   text,
  ADD COLUMN request_hash        text,
  ADD COLUMN materialized_lazily boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.order_obligations.cause IS
  'Why this revision exists. NOT NULL exactly for source=order_commercial_adjustment_v1. '
  '''manual'' = an admin deliberately chose the new obligation. ''order_cancellation'' = the '
  'writer derived it from a cancellation; the actor never chose the amount.';
COMMENT ON COLUMN public.order_obligations.materialized_lazily IS
  'true when this creation baseline was materialized on first adjustment rather than written '
  'by ordenes_order_obligation_anchor_v1 at creation time. The gross_amount and created_at are '
  'exactly what the anchor would have written; this flag records the PROVENANCE difference so a '
  'later audit is never misled about when the row was physically inserted.';

-- Only a creation baseline can be lazily materialized.
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_lazy_baseline_chk
  CHECK (materialized_lazily = false OR source = 'order_create_v1');

-- cause vocabulary, and cause present exactly for adjustment revisions.
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_cause_chk
  CHECK (cause IS NULL OR cause = ANY (ARRAY['manual'::text, 'order_cancellation'::text]));
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_cause_presence_chk
  CHECK ((cause IS NOT NULL) = (source = 'order_commercial_adjustment_v1'));

-- An adjustment revision MUST carry full provenance. Other sources are unconstrained,
-- which is what keeps the 6 pre-existing rows and every future anchor row valid.
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_adjustment_provenance_chk
  CHECK (
    source <> 'order_commercial_adjustment_v1'
    OR (reason IS NOT NULL AND btrim(reason) <> ''
        AND by_actor IS NOT NULL AND by_role IS NOT NULL
        AND client_request_id IS NOT NULL AND request_hash IS NOT NULL)
  );

-- Actor/role vocabulary mirrored VERBATIM from order_financial_events so the obligation
-- ledger and the money ledger can never disagree about who an actor is.
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_by_role_chk
  CHECK (by_role IS NULL OR by_role = ANY (ARRAY['admin'::text,'operator'::text,'rider'::text,
    'owner'::text,'cashier'::text,'waiter'::text,'kitchen'::text,'shift_manager'::text,
    'legacy_operator'::text]));
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_by_actor_chk
  CHECK (by_actor IS NULL
    OR by_actor = ANY (ARRAY['owner'::text,'operator_primary'::text,'operator_backup'::text,'rider'::text])
    OR by_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_actor_role_map_chk
  CHECK (by_actor IS NULL OR by_role IS NULL
    OR ((by_actor = 'owner' AND by_role = ANY (ARRAY['admin'::text,'owner'::text]))
     OR (by_actor <> 'owner' AND by_role = ANY (ARRAY['operator'::text,'rider'::text,'cashier'::text,
         'waiter'::text,'kitchen'::text,'shift_manager'::text,'legacy_operator'::text]))));

-- Idempotency pair: both or neither, and the same formats mesa_post_payment_v1 enforces.
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_request_pair_chk
  CHECK ((client_request_id IS NULL) = (request_hash IS NULL));
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_client_request_id_chk
  CHECK (client_request_id IS NULL
    OR (char_length(client_request_id) BETWEEN 8 AND 128 AND client_request_id ~ '^[A-Za-z0-9_-]+$'));
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_request_hash_chk
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');

-- 2. Source widening -- the ONLY change to the source vocabulary. Both pre-existing
--    literals kept verbatim.
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_source_chk;
ALTER TABLE public.order_obligations
  ADD CONSTRAINT order_obligations_source_chk
  CHECK (source = ANY (ARRAY['order_create_v1'::text, 'order_total_revision_v1'::text,
                             'order_commercial_adjustment_v1'::text]));

-- 3. Idempotency index -- one logical adjustment request writes at most one revision.
CREATE UNIQUE INDEX order_obligations_client_request_uq
  ON public.order_obligations (workspace_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

-- 4. auth_audit -- two new event literals, additive only (ledger 117's lesson: a new
--    financial action whose audit INSERT is not in this CHECK aborts the writer AFTER
--    it has already moved the ledger).
ALTER TABLE public.auth_audit DROP CONSTRAINT auth_audit_event_chk;
ALTER TABLE public.auth_audit ADD CONSTRAINT auth_audit_event_chk CHECK (event = ANY (ARRAY[
  'login_ok'::text, 'login_fail'::text, 'locked'::text, 'pin_set'::text, 'pin_change'::text,
  'revoke'::text, 'bootstrap'::text, 'recovery'::text, 'actor_disabled'::text,
  'actor_enabled'::text, 'actor_unlocked'::text, 'user_created'::text, 'user_renamed'::text,
  'role_changed'::text, 'user_deactivated'::text, 'user_reactivated'::text, 'access_denied'::text,
  'credential_cleared'::text, 'fingerprint_upgraded'::text, 'session_invalidated'::text,
  'rate_limit_triggered'::text, 'migration_login_used'::text,
  'PAYMENT_REPLAY_DIFFERENT_ACTOR'::text, 'PAYMENT_DUPLICATE_CONFIRMED'::text,
  'MESA_PAYMENT_REFUNDED'::text,
  'MESA_COMMERCIAL_ADJUSTMENT'::text, 'ORDER_CANCELLED'::text]));

-- ══════════════════════════════════════════════════════════════════════════
-- 5. CANONICAL OBLIGATION READER -- the single definition of "what is owed".
--
--    Precedence, exactly N-2's documented rule: canonical revision if one exists,
--    else the legacy order total. NEVER a mutable estado filter on top of a
--    canonical revision -- once an order has revisions, estado has no economic vote
--    at all, which is the entire point of this slice.
--
--    THE LEGACY FALLBACK IS ordenes.totale, NOT A LINE SUM, and that is load-bearing:
--    it is the SAME source order_obligation_apply_adjustment_v1 bootstraps from, so
--    materializing an order's baseline cannot change the number that was already
--    being read for it. A line sum would also be keyed on the recycled display id
--    (table_order_lines has no order_uid) -- see the header.
--
--    CHIUSO_FORZATO is deliberately ABSENT from the fallback's cancelled set: it is  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
--    operational, not economic (Slice A / N-1).
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.order_canonical_obligation_v1(p_order_uid uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT COALESCE(
    (SELECT ob.gross_amount FROM public.order_obligations ob
      WHERE ob.order_uid = p_order_uid
      ORDER BY ob.revision DESC LIMIT 1),
    (SELECT CASE
              WHEN upper(COALESCE(o.estado,'')) IN ('ANULADO','CANCELADO','CANCELLED') THEN 0::numeric
              ELSE COALESCE(o.totale, 0)
            END
       FROM public.ordenes o WHERE o.order_uid = p_order_uid),
    0::numeric);
$fn$;

COMMENT ON FUNCTION public.order_canonical_obligation_v1(uuid) IS
  'Current obligation for one permanent order identity. Canonical revision if present, '
  'else legacy ordenes.totale (zeroed for a genuinely cancelled legacy order). The single '
  'reader used by mesa_post_payment_v1 and mesa_close_session_v1 after Ajuste Comercial V1.';

-- ══════════════════════════════════════════════════════════════════════════
-- 6. THE SHARED PRIMITIVE -- bootstrap + append, one implementation.
--
--    Both the manual adjustment writer and the cancellation writer call this, so the
--    bootstrap rule exists exactly once. It never writes money, never writes estado,
--    never touches table_order_lines, payment_transactions or payment_allocations.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.order_obligation_apply_adjustment_v1(
  p_order_uid uuid,
  p_new_gross numeric,
  p_cause text,
  p_reason text,
  p_by_actor text,
  p_by_role text,
  p_client_request_id text,
  p_request_hash text,
  p_expected_current_gross numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ord        public.ordenes%ROWTYPE;
  v_prev       public.order_obligations%ROWTYPE;
  v_workspace  uuid;
  v_kind       text;
  v_current    numeric;
  v_revision   integer;
  v_new_rev    integer;
  v_bootstrap  boolean := false;
  v_reason     text;
  v_session    uuid;
  v_period     text;
BEGIN
  -- ── input contract ───────────────────────────────────────────────────
  IF p_order_uid IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023';
  END IF;
  IF p_cause IS NULL OR p_cause NOT IN ('manual','order_cancellation') THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_new_gross IS NULL OR p_new_gross < 0 THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;
  v_reason := btrim(p_reason);
  IF p_by_actor IS NULL OR btrim(p_by_actor) = '' OR p_by_role IS NULL THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_client_request_id IS NULL OR p_request_hash IS NULL THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023';
  END IF;

  -- ── the authoritative row. FOR UPDATE here is what serialises two devices
  --    racing to materialize the same first baseline: the loser blocks, and when
  --    it proceeds it sees revision 1 already present and simply appends. ──
  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002';
  END IF;
  -- N-6 — financial ownership must be provable, never inferred.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023';
  END IF;

  SELECT oe.workspace_id INTO v_workspace
    FROM public.order_entities oe WHERE oe.order_uid = p_order_uid;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023';
  END IF;

  -- ── idempotent replay, checked BEFORE any write so a retry can never see a
  --    half-bootstrapped state. Keyed exactly like mesa_post_payment_v1. ──
  SELECT * INTO v_prev FROM public.order_obligations
   WHERE workspace_id = v_workspace AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_prev.request_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'MESA_ADJUSTMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'changed', true, 'bootstrapped', false,
      'orderUid', v_prev.order_uid, 'revision', v_prev.revision,
      'currentObligation', v_prev.gross_amount,
      'previousObligation', (SELECT ob.gross_amount FROM public.order_obligations ob
                              WHERE ob.order_uid = p_order_uid AND ob.revision = v_prev.revision - 1),
      'cause', v_prev.cause);
  END IF;

  -- ── resolve the current obligation, materializing the creation baseline if the
  --    order predates universal obligation rows. ──
  SELECT * INTO v_prev FROM public.order_obligations
   WHERE order_uid = p_order_uid ORDER BY revision DESC LIMIT 1;

  IF NOT FOUND THEN
    v_bootstrap := true;
    v_current   := COALESCE(v_ord.totale, 0);
    v_revision  := 1;
    v_session   := v_ord.service_session_id;
    SELECT ss.service_kind INTO v_kind FROM public.service_sessions ss WHERE ss.id = v_session;
    v_period := CASE WHEN v_kind IN ('PRANZO','SERA') THEN v_kind ELSE NULL END;  -- language-guard: allow-legacy PRANZO is the existing service_kind enum value the N-2 anchor already derives, restated verbatim, not new vocabulary

    -- Byte-for-byte what ordenes_order_obligation_anchor_v1 would have written at
    -- creation time -- same gross source, same created_at source, same channel, same
    -- period derivation -- plus materialized_lazily so the PROVENANCE difference is
    -- recorded rather than hidden. Nothing here is inferred: gross comes from the
    -- order row locked two statements above.
    INSERT INTO public.order_obligations
      (order_uid, order_id, service_session_id, workspace_id, revision,
       gross_amount, channel, source, economic_period_kind, created_at,
       materialized_lazily)
    VALUES
      (p_order_uid, v_ord.id, v_session, v_workspace, 1,
       v_current, v_ord.canal, 'order_create_v1', v_period,
       COALESCE(v_ord.created_at, now()), true);
  ELSE
    v_current  := v_prev.gross_amount;
    v_revision := v_prev.revision;
    v_session  := v_prev.service_session_id;
    v_period   := v_prev.economic_period_kind;
  END IF;

  -- ── optimistic concurrency: the operator approved a reduction FROM a number they
  --    saw. If the basis moved underneath them, refuse rather than silently apply the
  --    adjustment to a different sale. ──
  IF p_expected_current_gross IS NOT NULL
     AND round(p_expected_current_gross, 2) IS DISTINCT FROM round(v_current, 2) THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_STALE_OBLIGATION' USING ERRCODE='55000',
      DETAIL = format('expected=%s current=%s', p_expected_current_gross, v_current);
  END IF;

  -- ── V1 is reduction-only. An INCREASE is a new sale, and adding a comanda already
  --    expresses that with line-level evidence; a second, weaker path to charging a
  --    guest is exactly what must not exist. ──
  IF round(p_new_gross, 2) > round(v_current, 2) THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_EXCEEDS_OBLIGATION' USING ERRCODE='22023',
      DETAIL = format('current=%s requested=%s', v_current, p_new_gross);
  END IF;

  -- ── nothing to move. Deliberately NOT an error here: a cancellation of an order
  --    whose obligation is already 0 is legitimate and must still cancel. The manual
  --    writer turns this into MESA_ADJUSTMENT_NO_CHANGE itself. No revision is
  --    appended, so a replay can never grow the ledger. ──
  IF round(p_new_gross, 2) = round(v_current, 2) THEN
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', false, 'changed', false, 'bootstrapped', v_bootstrap,
      'orderUid', p_order_uid, 'revision', CASE WHEN v_bootstrap THEN 1 ELSE v_revision END,
      'currentObligation', v_current, 'previousObligation', v_current, 'cause', p_cause);
  END IF;

  v_new_rev := CASE WHEN v_bootstrap THEN 2 ELSE v_revision + 1 END;

  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision,
     gross_amount, channel, source, economic_period_kind, created_at,
     cause, reason, by_actor, by_role, client_request_id, request_hash)
  VALUES
    (p_order_uid, v_ord.id, v_session, v_workspace, v_new_rev,
     round(p_new_gross, 2), v_ord.canal, 'order_commercial_adjustment_v1', v_period, now(),
     p_cause, v_reason, p_by_actor, p_by_role, p_client_request_id, p_request_hash);

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'changed', true, 'bootstrapped', v_bootstrap,
    'orderUid', p_order_uid, 'revision', v_new_rev,
    'previousObligation', v_current, 'currentObligation', round(p_new_gross, 2),
    'cause', p_cause);
END;
$fn$;

COMMENT ON FUNCTION public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric) IS
  'Shared Ajuste Comercial primitive: lazily materializes the creation baseline for a legacy '
  'order (revision 1, source order_create_v1, gross = the locked ordenes.totale) and appends the '
  'adjustment revision, in ONE transaction. Never writes money, estado, or lines.';

-- ══════════════════════════════════════════════════════════════════════════
-- 7. MANUAL AJUSTE COMERCIAL -- an admin deliberately chooses the new obligation.
--
--    Lock order is the canonical Mesa financial prefix, VERBATIM:
--       workspaces -> auth_actors -> table_sessions -> ordenes
--    mesa_post_payment_v1 and mesa_post_refund_v1 take the first three in exactly this
--    order and neither locks `ordenes` explicitly, so appending `ordenes` at the tail
--    cannot create a cycle: no existing writer holds an ordenes lock while waiting for
--    a table_sessions lock.
--
--    ROLE: admin/owner only -- strictly narrower than PAYMENT_ROLES and identical to
--    REFUND_ROLES. Reducing what the house is owed is at least as sensitive as
--    returning money. NOTE the structural fact behind the pair: auth_actors_actor_role_map
--    makes role 'owner' unreachable (actor='owner' <=> role='admin'), so this set is
--    really the single `owner` actor; 'owner' is kept for symmetry with the refund gate,
--    not because a second tier exists.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mesa_post_commercial_adjustment_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_by_sid_hash text,
  p_table_session_id uuid,
  p_order_uid uuid,
  p_new_gross numeric,
  p_reason text,
  p_client_request_id text,
  p_request_hash text,
  p_expected_current_gross numeric DEFAULT NULL,
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor    public.auth_actors%ROWTYPE;
  v_session  public.table_sessions%ROWTYPE;
  v_ord      public.ordenes%ROWTYPE;
  v_meta     jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_res      jsonb;
  v_net      numeric;
  v_current  numeric;
BEGIN
  IF p_workspace_id IS NULL OR p_table_session_id IS NULL OR p_order_uid IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$'
     OR p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_META_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner')
  THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- Target by permanent identity and prove it belongs to the named table session.
  -- A bare recycled #NNN is never accepted -- half the exposure this whole workstream
  -- exists to close came from display-id collisions.
  SELECT * INTO v_ord FROM public.ordenes WHERE order_uid = p_order_uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_ADJUSTMENT_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_ord.table_session_id IS DISTINCT FROM v_session.id THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_ORDER_MISMATCH' USING ERRCODE='22023';
  END IF;

  v_res := public.order_obligation_apply_adjustment_v1(
    p_order_uid, p_new_gross, 'manual', p_reason,
    p_by_actor, v_actor.role, p_client_request_id, p_request_hash, p_expected_current_gross);

  -- A manual adjustment that moves nothing is an operator mistake, not a silent success.
  IF (v_res->>'changed')::boolean IS NOT TRUE AND (v_res->>'idempotent')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'MESA_ADJUSTMENT_NO_CHANGE' USING ERRCODE='55000';
  END IF;

  IF (v_res->>'idempotent')::boolean IS NOT TRUE THEN
    INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
    VALUES ('MESA_COMMERCIAL_ADJUSTMENT', NULL, p_by_actor, jsonb_build_object(
      'orderUid', p_order_uid, 'orderId', v_ord.id, 'tableSessionId', v_session.id,
      'previousObligation', v_res->'previousObligation',
      'currentObligation', v_res->'currentObligation',
      'revision', v_res->'revision', 'cause', 'manual',
      'bootstrapped', v_res->'bootstrapped',
      'clientRequestId', p_client_request_id, 'bySidHash', p_by_sid_hash,
      'byRole', v_actor.role));
  END IF;

  -- Money is READ here, never written. This writer contains no INSERT into
  -- payment_transactions / payment_allocations / order_financial_events at all.
  SELECT COALESCE(sum(CASE WHEN t.kind = 'refund' THEN -a.amount ELSE a.amount END), 0)
    INTO v_net
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE a.order_id = v_ord.id AND t.table_session_id = v_session.id;

  v_current := (v_res->>'currentObligation')::numeric;

  RETURN v_res || jsonb_build_object(
    'orderId', v_ord.id, 'tableSessionId', v_session.id,
    'netCollected', round(v_net, 2),
    'unpaid', GREATEST(0, round(v_current - v_net, 2)),
    'overCollected', GREATEST(0, round(v_net - v_current, 2)));
END;
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- 8. CANONICAL ATOMIC CANCELLATION.
--
--    Before this, a genuine economic cancellation was a bare PostgREST PATCH from
--    agentOrdini.cambiaStato -- one row update, its own implicit transaction, no  -- language-guard: allow-legacy agentOrdini is the existing module filename being cross-referenced, not new vocabulary
--    obligation consequence at all. There was no cancellation DB writer to upgrade, so
--    this creates the missing authority rather than inventing a parallel framework:
--    the JS orchestration (transition log, giro dissolve, DRIVER_STATO reconciliation)
--    is unchanged and still runs around it; only the STATE WRITE moves in here, where
--    it becomes atomic with the obligation revision.
--
--    THE AUTHORITY DISTINCTION, load-bearing: the caller may not choose the resulting
--    obligation. There is deliberately NO p_new_gross parameter -- the server derives 0
--    from the cancellation itself. This is narrower than manual adjustment by
--    construction, not by validation, so an operator authorised to cancel never gains
--    the power to pick an arbitrary number.
--
--    Lock order: auth_actors -> table_sessions (when the order is on a table) -> ordenes.
--    A strict subsequence of the Mesa prefix, so it composes without a cycle. `workspaces`
--    is deliberately not locked, matching order_void's existing posture.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.order_cancel_v1(
  p_order_id text,
  p_by_actor text,
  p_reason text,
  p_client_request_id text,
  p_request_hash text,
  p_target_estado text DEFAULT 'CANCELADO',
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor    public.auth_actors%ROWTYPE;
  v_peek     public.ordenes%ROWTYPE;
  v_ord      public.ordenes%ROWTYPE;
  v_meta     jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_target    text;
  v_res       jsonb;
  v_net       numeric;
  v_current   numeric;
  v_workspace uuid;
  v_now       timestamptz := now();
BEGIN
  IF p_order_id IS NULL OR btrim(p_order_id) = ''
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_client_request_id IS NULL OR char_length(p_client_request_id) NOT BETWEEN 8 AND 128
     OR p_client_request_id !~ '^[A-Za-z0-9_-]+$'
     OR p_request_hash IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
     OR jsonb_typeof(v_meta) <> 'object' OR length(v_meta::text) > 2048
  THEN RAISE EXCEPTION 'ORDER_CANCEL_INVALID' USING ERRCODE='22023'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'ORDER_CANCEL_REASON_REQUIRED' USING ERRCODE='22023';
  END IF;

  v_target := upper(btrim(COALESCE(p_target_estado, 'CANCELADO')));
  IF v_target NOT IN ('CANCELADO','CANCELLED','ANULADO') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_INVALID' USING ERRCODE='22023';
  END IF;

  -- Unlocked peek purely to resolve which rows to lock, in the canonical order.
  -- Every value it produces is re-read under lock below.
  SELECT * INTO v_peek FROM public.ordenes WHERE id = p_order_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_CANCEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- `ordenes` carries no workspace_id: the workspace lives on order_entities, keyed by
  -- the permanent order_uid, never by the recycled display id.
  SELECT oe.workspace_id INTO v_workspace
    FROM public.order_entities oe WHERE oe.order_uid = v_peek.order_uid;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE actor = p_by_actor
     AND (v_workspace IS NULL OR workspace_id = v_workspace)
   FOR UPDATE;
  -- Same eligible roles as mesa_close_session_v1: whoever may free a table may cancel
  -- an order on it. This makes an EXISTING ungated capability explicit; it grants
  -- nothing that cambiaStato did not already allow.
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'ORDER_CANCEL_FORBIDDEN' USING ERRCODE='42501'; END IF;

  IF v_peek.table_session_id IS NOT NULL THEN
    PERFORM 1 FROM public.table_sessions WHERE id = v_peek.table_session_id FOR UPDATE;
  END IF;

  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_CANCEL_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  -- CLASS B FAIL-CLOSED. Without a permanent identity there is no honest place to put
  -- the obligation revision, and guessing from the recycled display id is exactly the
  -- defect this workstream exists to stop.
  IF v_ord.order_uid IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_STABLE_IDENTITY' USING ERRCODE='22023';
  END IF;

  -- Replay anchor: an already-cancelled order is a no-op, never a second revision.
  -- Matches validateTransition's own CANCELADO->CANCELADO noop semantics.
  IF upper(COALESCE(v_ord.estado,'')) = v_target THEN
    v_current := public.order_canonical_obligation_v1(v_ord.order_uid);
    -- order_financial_events, scoped by service_session_id, is the universal bridge
    -- ledger BOTH channels write into (mesa_post_payment_v1/mesa_post_refund_v1 bridge
    -- every Mesa allocation here too; _ledger_write_payment/order_refund never touch
    -- payment_allocations at all). The predicate is N-6's, verbatim: order_id alone is
    -- the RECYCLED display number, never financial identity on its own.
    SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0)
      INTO v_net FROM public.order_financial_events e
     WHERE e.order_id = v_ord.id
       AND e.type IN ('payment','payment_imported','refund')
       AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
      'estado', v_ord.estado, 'currentObligation', round(v_current, 2),
      'netCollected', round(v_net, 2),
      'unpaid', GREATEST(0, round(v_current - v_net, 2)),
      'overCollected', GREATEST(0, round(v_net - v_current, 2)));
  END IF;

  -- Cancellable-from set, mirroring utils/orderStateMachine.js CANCELLABLE_FROM.
  IF upper(COALESCE(v_ord.estado,'')) NOT IN ('POR_CONFIRMAR','NUEVO','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'ORDER_CANCEL_STATE_INVALID' USING ERRCODE='22023',
      DETAIL = format('order_id=%s estado=%s', v_ord.id, COALESCE(v_ord.estado,'<null>'));
  END IF;

  -- OBLIGATION FIRST, STATE SECOND, ONE TRANSACTION. The server derives 0; the caller
  -- never supplied an amount. If this raises, the state write below never happens and
  -- nothing is externally visible.
  v_res := public.order_obligation_apply_adjustment_v1(
    v_ord.order_uid, 0, 'order_cancellation', p_reason,
    p_by_actor, v_actor.role, p_client_request_id, p_request_hash, NULL);

  -- estado is NOT in paid_order_economic_mutation_guard_v1's UPDATE OF list
  -- (totale/delivery_fee/descuento_*), so a fully paid order cancels here without the
  -- guard firing and without any economic column being touched.
  UPDATE public.ordenes SET estado = v_target, cancelado_at = v_now WHERE id = v_ord.id;

  INSERT INTO public.auth_audit(event, target_actor, by_actor, meta)
  VALUES ('ORDER_CANCELLED', NULL, p_by_actor, jsonb_build_object(
    'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
    'tableSessionId', v_ord.table_session_id, 'serviceSessionId', v_ord.service_session_id,
    'prevEstado', v_ord.estado, 'newEstado', v_target,
    'previousObligation', v_res->'previousObligation',
    'currentObligation', v_res->'currentObligation',
    'revision', v_res->'revision', 'bootstrapped', v_res->'bootstrapped',
    'reason', btrim(p_reason), 'byRole', v_actor.role,
    'clientRequestId', p_client_request_id));

  -- Same universal-ledger source as the replay branch above -- see that comment.
  SELECT COALESCE(sum(CASE WHEN e.type = 'refund' THEN -e.amount ELSE e.amount END), 0)
    INTO v_net FROM public.order_financial_events e
   WHERE e.order_id = v_ord.id
     AND e.type IN ('payment','payment_imported','refund')
     AND e.service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;

  v_current := (v_res->>'currentObligation')::numeric;

  -- NO REFUND IS CREATED HERE, for any tender, ever. La Dieci controls no settlement
  -- rail; a fabricated payment_transactions row would assert a bank event that never
  -- happened, into an append-only table. The over-collection is NAMED instead, and a
  -- real refund stays a separate, deliberate operation.
  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'orderId', v_ord.id, 'orderUid', v_ord.order_uid,
    'prevEstado', v_ord.estado, 'estado', v_target,
    'previousObligation', v_res->'previousObligation',
    'currentObligation', round(v_current, 2), 'revision', v_res->'revision',
    'bootstrapped', v_res->'bootstrapped',
    'netCollected', round(v_net, 2),
    'unpaid', GREATEST(0, round(v_current - v_net, 2)),
    'overCollected', GREATEST(0, round(v_net - v_current, 2)));
END;
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- 9. order_void -- ANULADO is a genuine economic cancellation, so it must now carry
--    an obligation revision to 0 too. Everything else in this function is byte-for-byte
--    its ledger-115 body: same guards, same replay integrity, same digest, same role
--    gate, same OFE row. ONE call is inserted before the state write.
--
--    The zero-amount OFE 'void' marker is KEPT: ofe_amount_chk forces amount=0 for
--    type='void', so it is an audit breadcrumb and never a money mover. The reduced
--    obligation is expressed where it belongs -- order_obligations -- and never as fake
--    negative cash.
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.order_void(
  p_order_id text, p_reason text, p_by_actor text, p_session_version integer,
  p_ip_hash text, p_meta jsonb, p_idem_scope_key text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_by public.auth_actors%ROWTYPE; v_ord public.ordenes%ROWTYPE;
  v_existing public.order_financial_events%ROWTYPE; v_pay_event public.order_financial_events%ROWTYPE;
  v_new public.order_financial_events%ROWTYPE;
  v_role text; v_reason text; v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_pay_state text; v_canon jsonb; v_digest text; v_replay_digest text; v_now timestamptz := now();
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
  IF v_role NOT IN ('admin','operator') THEN RAISE EXCEPTION 'AUTH_FORBIDDEN_ROLE' USING ERRCODE='22023'; END IF;
  IF p_session_version <> v_by.session_version THEN RAISE EXCEPTION 'AUTH_SESSION_STALE' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_ord FROM public.ordenes WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AUTH_ORDER_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- N-6 — financial ownership must be provable before any pay-state is stamped.
  IF v_ord.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='22023',
      DETAIL = format('order_id=%s has no service session -- financial ownership cannot be proven', p_order_id);
  END IF;
  SELECT * INTO v_existing FROM public.order_financial_events
    WHERE order_id = p_order_id AND type = 'void' AND idem_scope_key = p_idem_scope_key
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id;
  IF FOUND THEN
    IF v_existing.type <> 'void' OR v_existing.amount <> 0 OR v_existing.payment_method IS NOT NULL
       OR v_existing.legacy IS DISTINCT FROM false OR v_existing.new_estado <> 'ANULADO'
       OR v_existing.prev_pay_state IS DISTINCT FROM v_existing.new_pay_state
    THEN RAISE EXCEPTION 'AUTH_VOID_REPLAY_INTEGRITY' USING ERRCODE='22023'; END IF;
    v_replay_digest := lower(encode(sha256(convert_to((jsonb_build_object(
      'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
      'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
      'prev_estado', v_existing.prev_estado, 'new_estado', v_existing.new_estado,
      'prev_pay_state', v_existing.prev_pay_state, 'new_pay_state', v_existing.new_pay_state,
      'amount', 0, 'payment_method', NULL,
      'original_giro_id', v_existing.original_giro_id, 'legacy', false))::text, 'UTF8')), 'hex'));
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
  SELECT * INTO v_pay_event FROM public.order_financial_events
    WHERE order_id = p_order_id AND type IN ('refund','payment','payment_imported')
      AND service_session_id IS NOT DISTINCT FROM v_ord.service_session_id
    ORDER BY CASE WHEN type = 'refund' THEN 1 ELSE 2 END, created_at ASC LIMIT 1;
  IF FOUND AND v_pay_event.type = 'refund' THEN v_pay_state := 'refunded';
  ELSIF FOUND THEN v_pay_state := 'paid';
  ELSE v_pay_state := 'unpaid'; END IF;
  IF v_ord.estado NOT IN ('POR_CONFIRMAR','EN_COCINA','LISTO','EN_ENTREGA') THEN
    RAISE EXCEPTION 'AUTH_VOID_STATE_FORBIDDEN' USING ERRCODE='22023';
  END IF;
  v_canon := jsonb_build_object(
    'order_id', p_order_id, 'type', 'void', 'idem_scope_key', p_idem_scope_key,
    'by_actor', p_by_actor, 'by_role', v_role, 'reason', v_reason,
    'prev_estado', v_ord.estado, 'new_estado', 'ANULADO',
    'prev_pay_state', v_pay_state, 'new_pay_state', v_pay_state,
    'amount', 0, 'payment_method', NULL, 'original_giro_id', v_ord.manual_giro_id,
    'legacy', false);
  v_digest := lower(encode(sha256(convert_to(v_canon::text, 'UTF8')), 'hex'));
  INSERT INTO public.order_financial_events(
    order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
    prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
    ip_hash, meta, idem_scope_key, payload_digest)
  VALUES (p_order_id, 'void', 0, NULL, v_reason, false, p_by_actor, v_role,
    v_ord.estado, 'ANULADO', v_pay_state, v_pay_state, v_ord.manual_giro_id,
    p_ip_hash, v_meta, p_idem_scope_key, v_digest)
  RETURNING * INTO v_new;

  -- AJUSTE COMERCIAL V1 — a void is an economic cancellation, so the obligation must
  -- fall to 0 with it, in this same transaction. The amount is derived by the server,
  -- never supplied. The client_request_id is derived from the PERMANENT order identity
  -- (one void per order is structurally guaranteed by the state gate above), so it
  -- cannot collide with a Mesa adjustment key in the same workspace.
  PERFORM public.order_obligation_apply_adjustment_v1(
    v_ord.order_uid, 0, 'order_cancellation', v_reason,
    p_by_actor, v_role,
    'voidadj-' || replace(v_ord.order_uid::text, '-', ''), v_digest, NULL);

  UPDATE public.ordenes SET estado = 'ANULADO', cancelado_at = v_now WHERE id = p_order_id;
  RETURN jsonb_build_object('event_id', v_new.id, 'order_id', v_new.order_id,
    'type', v_new.type, 'amount', v_new.amount, 'payment_method', v_new.payment_method,
    'prev_estado', v_new.prev_estado, 'new_estado', v_new.new_estado,
    'prev_pay_state', v_new.prev_pay_state, 'new_pay_state', v_new.new_pay_state,
    'legacy', v_new.legacy, 'original_giro_id', v_new.original_giro_id,
    'idempotent', false, 'created_at', v_new.created_at);
END;
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- 10. mesa_post_payment_v1 -- LOAD-BEARING. Stop using mutable estado as economic
--     authority; derive what is payable from the canonical obligation.
--
--     THE DEFECT THIS CLOSES: the writer computed the table total as the estado-filtered
--     line sum. Over-Collected Slice A fixed the READERS only, so after a partial
--     adjustment (30 -> 20) the writer would still have accepted a payment of 30. For a
--     full cancellation the estado filter happened to give the same answer, which is
--     exactly why this was invisible.
--
--     THREE CHANGES, nothing else:
--       (a) the table total, the per-order total and the ya_pagado/cobrado projection all
--           read public.order_canonical_obligation_v1;
--       (b) CHIUSO_FORZATO is removed from the remaining line filters -- it is operational,  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
--           never an economic void (Slice A / N-1). All 9 live rows are in CLOSED table
--           sessions and this writer only ever runs on an OPEN one, so this is inert
--           today and simply stops the writer from contradicting the readers;
--       (c) each order's allocation is now additionally capped by ITS OWN remaining
--           obligation, so a reduced order cannot absorb a neighbour's money. When
--           obligation = line sum (every order today) the cap never binds and the
--           allocation is byte-identical to the pre-118 behaviour.
--
--     An order that has neither an obligation revision nor a line in this table session
--     contributes 0, exactly as before -- the fallback is never used to invent a total
--     the pre-118 writer did not already see. (Live: zero such orders exist.)
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mesa_post_payment_v1(
  p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid,
  p_payment_method text, p_mode text, p_client_request_id text, p_request_hash text,
  p_amount numeric DEFAULT NULL, p_covers_settled integer DEFAULT NULL,
  p_line_ids uuid[] DEFAULT NULL, p_meta jsonb DEFAULT '{}'::jsonb,
  p_confirm_duplicate boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $fn$
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
  v_order_caps jsonb := '{}'::jsonb;
  v_order_cap_cents bigint;
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
  v_duplicate_candidate boolean;
  v_receipt_service_id uuid;
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
      RAISE EXCEPTION 'MESA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
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
  IF v_session.covers_total IS NULL THEN
    RAISE EXCEPTION 'MESA_COVERS_NOT_SET' USING ERRCODE='55000';
  END IF;

  -- AJUSTE COMERCIAL V1 — canonical obligation, not the estado-filtered line sum.
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
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED');
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

    -- AJUSTE COMERCIAL V1 — per-order obligation cap, resolved once per order.
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
    cobrado = calc.is_paid,
    ya_pagado = calc.is_paid,
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
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- 11. mesa_close_session_v1 -- the DDL half deferred from Over-Collected Slice A.
--
--     The close writer paired a cancel-filtered obligation with a cancel-blind
--     collection and then clamped the difference to zero with GREATEST(0, ...), so an
--     over-collected table looked exactly like a settled one. It now reasons from the
--     canonical obligation and publishes BOTH sides of the divergence.
--
--     THE CLAMP IS STILL THERE and that is correct -- what changes is that the value it
--     discards is now published under its own name in the same object. MESA_TABLE_NOT_SETTLED
--     still gates on `unpaid` only: over-collection must never trap a table.
--
--     The kitchen/order COMPLETENESS check below is operational, not economic, so its
--     CHIUSO_FORZATO literals are preserved verbatim -- only the economic filter moved.  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
-- ══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.mesa_close_session_v1(
  p_workspace_id uuid, p_by_actor text, p_table_session_id uuid, p_force boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
  v_total_cents bigint;
  v_paid_cents bigint;
  v_unpaid_cents bigint;
  v_over_cents bigint;
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
  -- Same eligible roles as mesa_release_empty_session_v1 -- closing a table
  -- (financial safety aside) is an operational floor action, not a
  -- financial one; a waiter who has been serving the table can close it.
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator')
  THEN RAISE EXCEPTION 'MESA_CLOSE_FORBIDDEN' USING ERRCODE='42501'; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  -- Idempotent-safe, not idempotent-graceful, matching
  -- mesa_release_empty_session_v1's own established precedent: a retry
  -- after success lands here and fails closed before any mutation is
  -- possible -- no duplicate close, no duplicate audit row.
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  -- FINANCIAL SAFETY — absolute, never overridden by p_force. A table must
  -- never become free/available for new guests while money is still owed.
  -- AJUSTE COMERCIAL V1 — obligation is canonical, estado has no economic vote.
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

  -- Both sides of the divergence, derived BEFORE either is clamped.
  v_unpaid_cents := GREATEST(0, v_total_cents - v_paid_cents);
  v_over_cents   := GREATEST(0, v_paid_cents - v_total_cents);

  -- Gated on `unpaid` ONLY. An over-collected table is a real exposure, but it is money
  -- the house is HOLDING, not money it is owed: refusing to close would strand a table
  -- whose guest has already left, and the resolution (a deliberate refund) works equally
  -- well on a closed table -- mesa_post_refund_v1 accepts status IN ('open','closed') and
  -- never reopens one.
  IF v_unpaid_cents > 0 THEN
    RAISE EXCEPTION 'MESA_TABLE_NOT_SETTLED' USING ERRCODE='55000';
  END IF;

  -- KITCHEN/ORDER COMPLETENESS — the only thing p_force overrides.
  IF EXISTS (
    SELECT 1 FROM public.ordenes o
     WHERE o.table_session_id = v_session.id
       AND (o.estado IS NULL OR upper(o.estado) NOT IN (
         'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this pre-existing OPERATIONAL completeness check already named, restated verbatim because CREATE OR REPLACE requires the full function body, not new vocabulary
       ))
  ) THEN
    IF NOT p_force THEN
      RAISE EXCEPTION 'MESA_TABLE_HAS_ACTIVE_ORDERS' USING ERRCODE='55000';
    END IF;

    -- N-1 — explicit, operator-intentional force close. The order's OWN
    -- estado is left exactly as it genuinely is: this RPC has never had any
    -- authority to certify a kitchen outcome it never observed, and now it
    -- no longer claims one. AJUSTE COMERCIAL V1 changes nothing here: a force
    -- close is OPERATIONAL, so it must NOT be routed through the commercial
    -- adjustment writer and must NOT move any obligation.
    WITH orphaned AS (
      SELECT o.id, o.estado AS current_estado
        FROM public.ordenes o
       WHERE o.table_session_id = v_session.id
         AND (o.estado IS NULL OR upper(o.estado) NOT IN (
           'RETIRADO','COMPLETADO','COMPLETATO','CANCELADO','CANCELLED','ANULADO','CHIUSO_FORZATO' -- language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, restated verbatim for the same reason
         ))
       FOR UPDATE OF o
    ),
    logged AS (
      INSERT INTO public.orden_estado_logs( -- language-guard: allow-legacy numero_ordine below is the existing orden_estado_logs column name, restated verbatim because this INSERT is byte-identical to the pre-N-1 body, not new vocabulary
        orden_id, numero_ordine, estado_from, estado_to, event_type,
        actor_type, actor_id, origin, metadata
      )
      SELECT t.id, t.id, t.current_estado, COALESCE(t.current_estado, 'EN_COCINA'), 'table_closed_forced',
        'operator', p_by_actor, 'mesa_close_session_force',
        jsonb_build_object(
          'table_session_id', v_session.id,
          'reason', 'operator_forced_close_with_pending_kitchen_work'
        )
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
    'obligation', v_total_cents / 100.0,
    'netCollected', v_paid_cents / 100.0,
    'unpaid', v_unpaid_cents / 100.0,
    'overCollected', v_over_cents / 100.0
  );
END
$fn$;

-- ══════════════════════════════════════════════════════════════════════════
-- 12. PRIVILEGES -- fail closed. Same posture as mesa_post_payment_v1 /
--     mesa_post_refund_v1: nothing for PUBLIC, EXECUTE for service_role only. anon and
--     authenticated must never reach a financial writer directly.
-- ══════════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION public.order_canonical_obligation_v1(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_canonical_obligation_v1(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_obligation_apply_adjustment_v1(uuid,numeric,text,text,text,text,text,text,numeric) TO service_role;

REVOKE ALL ON FUNCTION public.mesa_post_commercial_adjustment_v1(uuid,text,text,uuid,uuid,numeric,text,text,text,numeric,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mesa_post_commercial_adjustment_v1(uuid,text,text,uuid,uuid,numeric,text,text,text,numeric,jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.order_cancel_v1(text,text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.order_cancel_v1(text,text,text,text,text,text,jsonb) TO service_role;

-- ══════════════════════════════════════════════════════════════════════════
-- 13. STRUCTURAL POST-CONDITIONS -- inside this same transaction. Anything that fails
--     here rolls the whole migration back.
-- ══════════════════════════════════════════════════════════════════════════
DO $post$
DECLARE
  v_def text;
  v_src text;
  v_lit text;
BEGIN
  -- ── the seven additive columns ──
  FOREACH v_lit IN ARRAY ARRAY['cause','reason','by_actor','by_role','client_request_id',
                               'request_hash','materialized_lazily'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='order_obligations' AND column_name=v_lit)
    THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_obligations.% missing', v_lit; END IF;
  END LOOP;
  -- Every new attribution column must be NULLABLE so the 6 pre-existing rows and every
  -- future anchor/revision row written by the two untouched triggers stay valid.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='order_obligations'
                AND column_name IN ('cause','reason','by_actor','by_role','client_request_id','request_hash')
                AND is_nullable = 'NO')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: an attribution column is NOT NULL'; END IF;

  -- ── THE INVARIANT THIS WHOLE DESIGN RESTS ON: create_rev_chk is untouched. ──
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid='public.order_obligations'::regclass AND conname='order_obligations_create_rev_chk';
  IF v_def IS DISTINCT FROM 'CHECK ((((source = ''order_create_v1''::text) = (revision = 1))))' THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: create_rev_chk was modified (now: %)', COALESCE(v_def,'<null>');
  END IF;

  -- ── source widening is additive: all three literals, nothing lost ──
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid='public.order_obligations'::regclass AND conname='order_obligations_source_chk';
  FOREACH v_lit IN ARRAY ARRAY['order_create_v1','order_total_revision_v1','order_commercial_adjustment_v1'] LOOP
    IF v_def IS NULL OR v_def !~ ('''' || v_lit || '''') THEN
      RAISE EXCEPTION 'AJUSTE_118 post-condition failed: source_chk missing literal %', v_lit;
    END IF;
  END LOOP;

  -- ── idempotency index exists AND is partial (a full index would forbid the NULLs
  --    every anchor/revision row carries) ──
  SELECT indexdef INTO v_def FROM pg_indexes
   WHERE schemaname='public' AND tablename='order_obligations' AND indexname='order_obligations_client_request_uq';
  IF v_def IS NULL OR v_def !~ 'UNIQUE' OR v_def !~ 'WHERE \(client_request_id IS NOT NULL\)' THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: idempotency index missing or not partial (%)', COALESCE(v_def,'<null>');
  END IF;

  -- ── auth_audit widening additive: both new literals present, every prior one kept ──
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid='public.auth_audit'::regclass AND conname='auth_audit_event_chk';
  FOREACH v_lit IN ARRAY ARRAY['MESA_COMMERCIAL_ADJUSTMENT','ORDER_CANCELLED','MESA_PAYMENT_REFUNDED',
      'PAYMENT_REPLAY_DIFFERENT_ACTOR','PAYMENT_DUPLICATE_CONFIRMED','login_ok','pin_set','revoke',
      'bootstrap','recovery','actor_disabled','user_created','role_changed','access_denied',
      'session_invalidated','rate_limit_triggered','migration_login_used'] LOOP
    IF v_def IS NULL OR v_def !~ ('''' || v_lit || '''') THEN
      RAISE EXCEPTION 'AJUSTE_118 post-condition failed: auth_audit_event_chk missing literal %', v_lit;
    END IF;
  END LOOP;

  -- ── the four functions exist with the exact identity arguments callers will use ──
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='mesa_post_commercial_adjustment_v1'
        AND pg_get_function_identity_arguments(p.oid) =
            'p_workspace_id uuid, p_by_actor text, p_by_sid_hash text, p_table_session_id uuid, p_order_uid uuid, p_new_gross numeric, p_reason text, p_client_request_id text, p_request_hash text, p_expected_current_gross numeric, p_meta jsonb')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: mesa_post_commercial_adjustment_v1 signature wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_cancel_v1'
        AND pg_get_function_identity_arguments(p.oid) =
            'p_order_id text, p_by_actor text, p_reason text, p_client_request_id text, p_request_hash text, p_target_estado text, p_meta jsonb')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_cancel_v1 signature wrong'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_obligation_apply_adjustment_v1')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: primitive missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='order_canonical_obligation_v1')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: canonical obligation reader missing'; END IF;

  -- ── fail closed: anon/authenticated hold EXECUTE on none of the new functions ──
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname IN ('mesa_post_commercial_adjustment_v1','order_cancel_v1',
                         'order_obligation_apply_adjustment_v1','order_canonical_obligation_v1')
       AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: anon/authenticated can execute a new writer'; END IF;
  IF NOT (has_function_privilege('service_role',
            'public.mesa_post_commercial_adjustment_v1(uuid,text,text,uuid,uuid,numeric,text,text,text,numeric,jsonb)', 'EXECUTE')
      AND has_function_privilege('service_role', 'public.order_cancel_v1(text,text,text,text,text,text,jsonb)', 'EXECUTE'))
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: service_role cannot execute a new writer'; END IF;

  -- ── the adjustment writers move OBLIGATION ONLY. Money tables are read, never written. ──
  FOREACH v_lit IN ARRAY ARRAY['mesa_post_commercial_adjustment_v1','order_obligation_apply_adjustment_v1'] LOOP
    SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname=v_lit;
    IF v_src ~ 'INSERT INTO public\.payment_' OR v_src ~ 'INSERT INTO public\.order_financial_events'
       OR v_src ~ 'UPDATE public\.payment_' OR v_src ~ 'UPDATE public\.ordenes'
       OR v_src ~ 'INSERT INTO public\.table_order_lines'
    THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: % writes money or order state', v_lit; END IF;
  END LOOP;

  -- ── cancellation NEVER fabricates a refund, for any tender. ──
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_cancel_v1';
  IF v_src ~ 'INSERT INTO public\.payment_transactions' OR v_src ~ 'INSERT INTO public\.payment_allocations'
     OR v_src ~ '''refund''' OR v_src ~ 'reverses_transaction_id'
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_cancel_v1 can create a refund'; END IF;
  -- ...and it never chooses an amount: there is no new-gross parameter at all.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='order_cancel_v1'
                AND pg_get_function_identity_arguments(p.oid) ~ 'gross')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_cancel_v1 exposes an amount parameter'; END IF;

  -- ── CHIUSO_FORZATO is gone from both writers' ECONOMIC filters. It legitimately  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
  --    survives in mesa_close_session_v1's OPERATIONAL completeness check. ──
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_payment_v1';
  IF v_src ~ 'CHIUSO_FORZATO' THEN  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: mesa_post_payment_v1 still filters on CHIUSO_FORZATO';  -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this slice deliberately keeps OUT of every economic filter, named here as evidence, not new vocabulary
  END IF;
  IF v_src !~ 'order_canonical_obligation_v1' THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: mesa_post_payment_v1 does not read the canonical obligation';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_close_session_v1';
  IF v_src !~ 'order_canonical_obligation_v1' OR v_src !~ 'overCollected' THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: mesa_close_session_v1 not converted';
  END IF;

  -- ── things that MUST NOT have changed ──
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='mesa_post_refund_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.aj118_refund_md5_before', true) THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: Refund V1 semantics were modified';
  END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='paid_order_economic_mutation_guard_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.aj118_n5guard_md5_before', true) THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: the N-5 guard was weakened';
  END IF;
  SELECT md5(prosrc) INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='order_obligation_anchor_v1';
  IF v_src IS DISTINCT FROM current_setting('ladieci.aj118_anchor_md5_before', true) THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: the N-2 anchor was modified';
  END IF;

  -- ── append-only guarantees intact on all five money tables ──
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.order_obligations'::regclass
        AND NOT tgisinternal AND tgname='order_obligations_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.payment_transactions'::regclass
        AND NOT tgisinternal AND tgname='payment_transactions_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.payment_allocations'::regclass
        AND NOT tgisinternal AND tgname='payment_allocations_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.table_order_lines'::regclass
        AND NOT tgisinternal AND tgname='table_order_lines_append_only_v1') <> 1
     OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.order_financial_events'::regclass
        AND NOT tgisinternal AND tgname='order_financial_events_no_update_delete') <> 1
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: an append-only trigger disappeared'; END IF;
  -- The two pre-existing obligation writers are still wired.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_revision_v1')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: an ordenes trigger disappeared'; END IF;

  -- ── the ledger stays forced-RLS and write-restricted (N-2's service_role default-
  --    privilege trap: a freshly ALTERed table can silently regain grants) ──
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.order_obligations'::regclass)
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_obligations lost forced RLS'; END IF;
  IF has_table_privilege('anon','public.order_obligations','UPDATE')
     OR has_table_privilege('anon','public.order_obligations','DELETE')
     OR has_table_privilege('authenticated','public.order_obligations','UPDATE')
     OR has_table_privilege('authenticated','public.order_obligations','DELETE')
     OR has_table_privilege('service_role','public.order_obligations','UPDATE')
     OR has_table_privilege('service_role','public.order_obligations','DELETE')
  THEN RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_obligations regained UPDATE/DELETE'; END IF;

  -- ── NO BACKFILL. This migration writes not one business row. ──
  IF (SELECT count(*) FROM public.order_obligations) <> 6 THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: order_obligations row count changed (expected 6, got %)',
      (SELECT count(*) FROM public.order_obligations);
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_obligations WHERE cause IS NOT NULL OR materialized_lazily) THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: a historical obligation row was written';
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_audit WHERE event IN ('MESA_COMMERCIAL_ADJUSTMENT','ORDER_CANCELLED')) THEN
    RAISE EXCEPTION 'AJUSTE_118 post-condition failed: the migration itself emitted an audit event';
  END IF;
END $post$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-117:
-- the manifest records this file's own sha256, and embedding that sha in an INSERT
-- inside the file would make the checksum self-referential. Registered as a separate
-- statement at apply time: apply_order 118, kind 'ddl', checksum = this file's sha256,
-- applied_by = the introducing commit (committed BEFORE this migration is applied --
-- O-1's ledger-immutability lesson, followed again).

COMMIT;
