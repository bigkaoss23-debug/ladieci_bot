-- migrations/2026-08-24_n3_canonical_initial_payment.sql
-- N-3 — RETIRE PAY-AT-CREATION LEGACY: canonical initial payment for Nuevo Pedido.
--
-- THE DEFECT. Until now a Nuevo Pedido could be created with `ya_pagado=true` +
-- `metodo_pago='efectivo'` written straight into the `ordenes` INSERT, with ZERO
-- rows in `order_financial_events`. `#999024` (EUR 14.50, ya_pagado=true, zero
-- canonical payment events) is the live proof. Economía and the closeout can only
-- see that money through their legacy-compatibility branch, which has no receipt
-- instant, no actor, no idempotency and no event identity. For NEW orders that is
-- unacceptable: money must be an EVENT, and the ledger that records it already
-- exists.
--
-- THE ATOMICITY CONSTRAINT THAT SHAPED THIS. The forbidden solution is "INSERT the
-- order, COMMIT, then make a second call to record the payment": a failure there
-- leaves the operator believing they created a paid order while the committed row
-- says unpaid. Order creation and initial payment must succeed or fail as ONE
-- operation.
--
-- The `ordenes` INSERT is already exactly that: one PostgREST statement, one
-- transaction, with four triggers on it (service-session assignment, R-DAY2
-- identity, Mesa line snapshot, N-2 obligation anchor). Anything written by a
-- trigger on that INSERT is atomic with the order by construction. So the initial
-- payment is written by a trigger on that same INSERT — if it raises, the order,
-- its identity, its obligation and its payment all roll back together and the
-- operator gets ONE clear failure.
--
-- WHY AN EPHEMERAL INTENT COLUMN, AND WHY NOT THE LEGACY FLAG. The trigger needs
-- to know "the operator declared this paid, by this method, as this verified
-- actor". It cannot read `ya_pagado=true` for that: `_ledger_write_payment`
-- refuses outright when the order already carries `ya_pagado`/`cobrado`
-- (AUTH_LEGACY_IMPORT_REQUIRED), and that guard exists to stop arbitrary
-- legacy-flagged rows becoming silently importable. Weakening it to accommodate
-- this flow would reopen exactly the ambiguity N-3 is closing. So the legacy flags
-- are NOT the input: they become OUTPUT, written only by the canonical payment
-- writer itself, as compatibility mirrors derived from the event.
--
-- The input is a separate, ephemeral, server-only column. This follows an existing
-- precedent on this very table: `table_covers_total_input` is an ephemeral input
-- read by a trigger and nulled back out so it never persists with a value. Only
-- `service_role` can INSERT into `ordenes` (anon/authenticated hold SELECT only,
-- verified live), so a browser can never forge an intent; the backend writes it
-- only from `req.authCtx` — the DB-verified session identity — exactly as
-- `registerOperatorPayment` does for the operator collection path.
--
-- ONE CANONICAL PAYMENT WRITER, NOT TWO. This trigger writes NO ledger row of its
-- own. It calls `public.order_mark_paid`, the same function the operator
-- collection path reaches through `registerOperatorPayment` -> `financialService`
-- -> `financialDao`. That means initial payment inherits, unchanged and unforked:
-- actor existence + active check, session_version freshness, the admin/operator
-- role gate, method validation, meta sanitation, the ip_hash requirement, the
-- server-derived amount (`round(ordenes.totale, 2)` — never a caller-supplied
-- number), the payload digest, and the replay/basis idempotency rules. A second
-- "initial payment writer" with slightly different semantics is precisely what
-- this migration refuses to create.
--
-- THE IDEMPOTENCY KEY IS DELIBERATELY THE SAME ONE. `pay-order-<sanitized id>` is
-- byte-identical to `buildIdemScopeKey` in src/financial/registerOperatorPayment.js.
-- Proven live: after a paid-at-creation order exists, an operator collection on
-- that same order under the same key REPLAYS (`idempotent: true`, no second event)
-- instead of double-charging, and a DIFFERENT method under that key is refused
-- with AUTH_IDEMPOTENCY_CONFLICT. Order-level idempotency is unchanged and
-- upstream of all this: `ordenes_client_req_id_uniq` makes a retried request
-- resolve to the SAME row, so no second INSERT occurs and this trigger cannot fire
-- twice.
--
-- ORDER OF OPERATIONS INSIDE THE ONE TRANSACTION. Postgres fires same-timing
-- triggers in ALPHABETICAL ORDER BY TRIGGER NAME, which is why this one is named
-- `ordenes_paid_at_creation_payment_v1`:
--   BEFORE INSERT  mesa_prepare_table_order_v1
--                  ordenes_assign_service_session      -> service_session_id
--                  ordenes_order_entity_anchor_v1      -> order_uid (R-DAY2)
--   ROW WRITTEN    with its FINAL total: creaOrdine applies the discount BEFORE -- language-guard: allow-legacy creaOrdine is the existing JS order-creation function name being cited, not new vocabulary
--                  the INSERT, so `totale` is already the accepted amount
--   AFTER INSERT   mesa_snapshot_order_lines_v1
--                  ordenes_order_obligation_anchor_v1  -> N-2 obligation rev 1
--                  ordenes_paid_at_creation_payment_v1 -> THIS: canonical payment
-- 'p' sorts after 'o', so the obligation always exists before the payment. The
-- payment amount is therefore always the obligation's own gross, and there is no
-- window in which money is recorded against a total that is still moving.
--
-- N-5 INTERACTION, CHECKED NOT ASSUMED. N-5 (ledger 113) freezes the economic
-- basis of any order that carries payment evidence. Nothing here changes an
-- economic column after the payment: `order_mark_paid` -> `_ledger_write_payment`
-- writes only `ya_pagado`/`cobrado`/`metodo_pago`, and this trigger's own UPDATE
-- writes only `initial_payment_intent`. Neither appears in N-5's
-- `UPDATE OF totale, delivery_fee, descuento_*` list, so the guard does not even
-- fire — and a later economic edit of a paid-at-creation order is correctly
-- refused by it. Verified live: creating a paid order with a EUR 2 discount gives
-- obligation gross 18 == payment amount 18.00, and a subsequent `totale` rewrite
-- is refused.
--
-- SERVICE OWNERSHIP IS INHERITED, NEVER GUESSED. `order_financial_events` already
-- carries a BEFORE INSERT trigger (`financial_event_assign_service_session`) that
-- resolves the session from the ORDER ROW ITSELF
-- (`SELECT o.service_session_id FROM ordenes o WHERE o.id = NEW.order_id`), never
-- from "whatever service is open now". Verified live on a paid-at-creation order:
-- order, obligation and payment all carry the same service_session_id.
--
-- NO BACKFILL. `#999024` and every other historical legacy-paid row is untouched
-- and keeps reading through the unchanged legacy-compatibility branch. No payment
-- timestamp, actor, idempotency key or event identity is fabricated for money that
-- was recorded before this contract existed. Historical import is its own task.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='ordenes'
                AND column_name='initial_payment_intent') THEN
    RAISE EXCEPTION 'N-3 refused: ordenes.initial_payment_intent already exists -- already patched, resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='public' AND p.proname='order_initial_payment_v1') THEN
    RAISE EXCEPTION 'N-3 refused: order_initial_payment_v1 already exists -- already patched, resolve drift first';
  END IF;
  -- The canonical payment authority must be the one this slice delegates to.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_mark_paid') THEN
    RAISE EXCEPTION 'N-3 refused: order_mark_paid (the canonical payment writer) is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='_ledger_write_payment') THEN
    RAISE EXCEPTION 'N-3 refused: _ledger_write_payment is missing -- resolve drift first';
  END IF;
  -- N-2 must be present AND its anchor must sort BEFORE this slice's trigger, or
  -- the payment could be written before the obligation it settles.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1') THEN
    RAISE EXCEPTION 'N-3 refused: the N-2 obligation anchor is missing -- resolve drift first';
  END IF;
  IF NOT ('ordenes_order_obligation_anchor_v1' < 'ordenes_paid_at_creation_payment_v1') THEN
    RAISE EXCEPTION 'N-3 refused: trigger naming would fire the payment before the obligation';
  END IF;
  -- N-5 must be present: this slice deliberately produces orders it will freeze.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-3 refused: the N-5 economic mutation guard is missing -- resolve drift first';
  END IF;
  -- The session-assignment trigger on the ledger is what makes service ownership
  -- inherited rather than guessed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_financial_events'::regclass
                  AND NOT tgisinternal AND tgname='financial_event_assign_service_session') THEN
    RAISE EXCEPTION 'N-3 refused: financial_event_assign_service_session is missing -- resolve drift first';
  END IF;
END $$;

BEGIN;

-- ── The ephemeral intent ────────────────────────────────────────────────
-- NULL at rest, always. Written only by the backend from the verified auth
-- context, read once by the trigger below, then cleared in the same transaction.
-- It is NOT an economic field and NOT an audit record: the canonical event in
-- order_financial_events is the only record of the payment.
ALTER TABLE public.ordenes ADD COLUMN initial_payment_intent jsonb;

COMMENT ON COLUMN public.ordenes.initial_payment_intent IS
  'N-3 ephemeral, server-only initial-payment intent {method, actor, sv, ip_hash}. Written by the backend from the verified auth context on the order INSERT, consumed by ordenes_paid_at_creation_payment_v1 in that same transaction and cleared, so it is NULL at rest. Never an economic field, never the payment record -- the canonical event in order_financial_events is. Same ephemeral-input pattern as table_covers_total_input.';

ALTER TABLE public.ordenes
  ADD CONSTRAINT ordenes_initial_payment_intent_chk CHECK (
    initial_payment_intent IS NULL OR (
      jsonb_typeof(initial_payment_intent) = 'object'
      AND initial_payment_intent ? 'method'
      AND initial_payment_intent ? 'actor'
      AND initial_payment_intent ? 'sv'
      AND initial_payment_intent ? 'ip_hash'
      AND initial_payment_intent->>'method' IN ('efectivo','tarjeta','bizum')
      AND length(initial_payment_intent::text) <= 512
    )
  );

-- ── The canonical initial payment ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.order_initial_payment_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_intent jsonb := NEW.initial_payment_intent;
  v_method text;
  v_actor  text;
  v_sv     integer;
  v_ip     text;
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

  v_method := lower(btrim(COALESCE(v_intent->>'method', '')));
  v_actor  := btrim(COALESCE(v_intent->>'actor', ''));
  v_sv     := NULLIF(v_intent->>'sv', '')::integer;
  v_ip     := btrim(COALESCE(v_intent->>'ip_hash', ''));

  IF v_method NOT IN ('efectivo','tarjeta','bizum') THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_METHOD_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s method=%s', NEW.id, v_method);
  END IF;
  IF v_actor = '' OR v_sv IS NULL OR v_ip = '' THEN
    RAISE EXCEPTION 'INITIAL_PAYMENT_CONTEXT_INVALID' USING ERRCODE = 'P0001',
      DETAIL = format('order_id=%s actor_present=%s sv_present=%s ip_present=%s',
                      NEW.id, (v_actor <> ''), (v_sv IS NOT NULL), (v_ip <> ''));
  END IF;

  -- THE canonical payment writer. Everything that matters -- authorization, the
  -- server-derived amount, the digest, replay/basis idempotency, the legacy
  -- mirrors -- happens in there, identically to the operator collection path.
  -- The idempotency key is the SAME deterministic per-order key that path uses,
  -- so a later collection on this order replays instead of charging twice.
  PERFORM public.order_mark_paid(
    NEW.id,
    v_method,
    NULL,
    v_actor,
    v_sv,
    v_ip,
    jsonb_build_object('source', 'initial_payment_at_creation'),
    'pay-order-' || regexp_replace(NEW.id, '[^A-Za-z0-9_-]', '', 'g')
  );

  -- The intent has done its one job. Clearing it here keeps the column NULL at
  -- rest; this UPDATE touches no economic column, so neither N-5's guard nor
  -- N-2's revision trigger fires.
  UPDATE public.ordenes SET initial_payment_intent = NULL WHERE id = NEW.id;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.order_initial_payment_v1() IS
  'N-3 canonical initial payment. Fires on the order INSERT itself when the backend attached a verified initial_payment_intent, so order + obligation + payment are one atomic operation: if the payment is refused, the order never exists. Writes no ledger row of its own -- it delegates to order_mark_paid, the same authority the operator collection path uses, with the same per-order idempotency key. Refuses table orders (Mesa has its own hub) and refuses any order that already carries a legacy paid flag.';

-- Alphabetically AFTER ordenes_order_obligation_anchor_v1, so N-2's revision 1
-- always exists before the payment that settles it. WHEN-scoped, so every order
-- created without an intent -- Mesa, the conversational flow, and every unpaid
-- Nuevo Pedido -- does not enter this function at all.
CREATE TRIGGER ordenes_paid_at_creation_payment_v1
  AFTER INSERT ON public.ordenes
  FOR EACH ROW
  WHEN (NEW.initial_payment_intent IS NOT NULL)
  EXECUTE FUNCTION public.order_initial_payment_v1();

-- ── Grants ──────────────────────────────────────────────────────────────
-- Trigger functions are invoked by the executor; the browser roles must not be
-- able to call this one by hand. Revoke BY NAME, per the N-2/N-5/L-1 posture.
REVOKE ALL ON FUNCTION public.order_initial_payment_v1() FROM PUBLIC, anon, authenticated;

-- The new column must not widen what a browser can read or write on `ordenes`.
-- anon/authenticated hold SELECT only and column-level grants are not in use
-- here, so nothing to add -- asserted below rather than assumed.

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY. No business DML runs inside this transaction: no order row is
-- touched, no payment is backfilled, no historical legacy-paid row is converted.
-- The behavioural proof (paid-at-creation writes exactly one canonical payment
-- equal to the obligation; unpaid creation writes none; efectivo/tarjeta/bizum;
-- discount ordering; retry idempotency; a refused payment rolls the whole order
-- back; Mesa and legacy-flag refusals; N-5 still freezes the result) runs
-- separately as rollback-safe probes against real staging -- see this slice's
-- report.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='ordenes'
                    AND column_name='initial_payment_intent' AND data_type='jsonb') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: ordenes.initial_payment_intent (jsonb) was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid='public.ordenes'::regclass
                    AND conname='ordenes_initial_payment_intent_chk') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the intent shape CHECK is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_initial_payment_v1') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the initial-payment function was not created';
  END IF;

  -- It must be AFTER INSERT: a BEFORE trigger would run before the order row (and
  -- its obligation) exists, and the payment writer would not find the order.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_at_creation_payment_v1'
                  AND pg_get_triggerdef(oid) ILIKE '%AFTER INSERT%') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the initial-payment trigger must be AFTER INSERT';
  END IF;

  -- WHEN-scoped, so an order created without an intent never enters the function.
  -- Postgres renders the clause with doubled parentheses -- matched loosely on the
  -- predicate itself rather than on exactly one paren depth.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_at_creation_payment_v1'
                  AND pg_get_triggerdef(oid) ILIKE '%WHEN %'
                  AND pg_get_triggerdef(oid) ILIKE '%initial_payment_intent IS NOT NULL%') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the initial-payment trigger is not WHEN-scoped to a non-null intent';
  END IF;

  -- Firing order: alphabetical, so the obligation anchor must sort first.
  IF NOT ('ordenes_order_obligation_anchor_v1' < 'ordenes_paid_at_creation_payment_v1') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the payment trigger would fire before the obligation anchor';
  END IF;

  -- It must delegate, never write the ledger itself.
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='order_initial_payment_v1')
     !~ 'order_mark_paid' THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the trigger must delegate to order_mark_paid';
  END IF;
  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='order_initial_payment_v1')
     ~* 'INSERT\s+INTO\s+public\.order_financial_events' THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the trigger must not write order_financial_events directly';
  END IF;

  -- Everything N-2/N-5/Mesa must survive untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the N-2 obligation anchor disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_paid_order_economic_mutation_guard_v1') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the N-5 economic mutation guard disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: the Mesa line-snapshot trigger disappeared';
  END IF;

  -- No historical row may have been converted by this migration.
  IF EXISTS (SELECT 1 FROM public.ordenes WHERE initial_payment_intent IS NOT NULL) THEN
    RAISE EXCEPTION 'N-3 post-condition failed: no existing order may carry an intent';
  END IF;

  IF has_function_privilege('anon', 'public.order_initial_payment_v1()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.order_initial_payment_v1()', 'EXECUTE') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: anon/authenticated must not hold EXECUTE on the trigger function';
  END IF;
  -- The browser must still be read-only on orders: the new column changes nothing.
  IF has_table_privilege('anon', 'public.ordenes', 'INSERT')
     OR has_table_privilege('anon', 'public.ordenes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.ordenes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.ordenes', 'UPDATE') THEN
    RAISE EXCEPTION 'N-3 post-condition failed: anon/authenticated must not be able to write orders';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers 96-113:
-- the manifest records this file's own sha256, and embedding that sha in an INSERT
-- inside the file would make the checksum self-referential. Registered as a
-- separate statement at apply time: apply_order 114, kind 'ddl', checksum = this
-- file's sha256, applied_by = the introducing commit (committed BEFORE this
-- migration is applied -- O-1's ledger-immutability lesson, followed again).

COMMIT;
