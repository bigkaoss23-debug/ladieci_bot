-- migrations/2026-08-24_n2_canonical_order_obligation.sql
-- N-2 — CANONICAL ORDER OBLIGATION AT CREATION.
--
-- THE FINDING (design audit, read-only, this session, against the live DB and
-- both repos at FE 9547249 / BE 7f790fa / ledger 111).
--
-- There is NO canonical economic obligation anywhere in this system, for ANY
-- channel. Proven, not assumed:
--   (1) src/closeout/currentServiceCloseout.js's safeTicket -- the ONE shared
--       obligation/collection rule imported by economicSnapshot.js,
--       economiaLedgerAggregate.js and serviceLifecycleEngine.js -- derives a
--       ticket's gross from `order.totale`, full stop. collected is capped by
--       it, unpaid is derived from it.
--   (2) table_order_lines is read by exactly TWO call sites in the entire
--       backend, both in src/tables/mesaDao.js (the Mesa per-item payment
--       picker). ZERO economic readers consult it. It is Mesa's settlement
--       substrate, never anyone's obligation.
--   (3) order_financial_events is a pay-state TRANSITION ledger (payment /
--       refund / void / payment_imported), the RECEIPT side. It records money
--       received, never money owed.
-- So gross -- for Mesa exactly as much as for Nuevo Pedido -- rests entirely
-- on `ordenes.totale`, a mutable column with no immutable anchor behind it.
--
-- WHY A NEW TABLE, NOT A REUSE (the three rejected alternatives).
--   A. REUSE table_order_lines. Rejected twice over. It is not the obligation
--      authority for anyone (see (2) above), and table_session_id /
--      workspace_id / source_line_id / source_line_index / unit_index /
--      product_snapshot are ALL NOT NULL, so every non-table order would need
--      a fabricated table-session -- inventing fake physical-table facts to
--      carry non-table money.
--   B. NEW APPEND-ONLY OBLIGATION LEDGER. Chosen. See below.
--   C. NEW order_financial_events TYPE. Rejected. That table is bound by five
--      interlocking CHECK constraints (ofe_type_chk, ofe_pay_state_transition
--      _chk, ofe_payment_method_chk, ofe_reason_chk, ofe_legacy_chk) plus
--      ofe_by_actor_fk -> auth_actors, all of which encode "this row is a
--      pay-state transition with a payment method". An `obligation` type would
--      require mutating all five on the live, certified payment ledger, and
--      every reader that folds SUM(amount) for COLLECTED would be one missing
--      filter away from counting money owed as money received. Unacceptable
--      blast radius on Mesa's certified payment path, and semantically wrong:
--      an obligation is not a transition between two payment states.
--   D. Any other existing canonical structure. None exists. order_entities
--      (R-DAY2) is identity-only and carries no amount.
--
-- THE SHARED-ABSTRACTION RULE, HONOURED. This does NOT build a second money
-- model beside Mesa's. Every channel -- Mesa included -- creates its orders
-- through the SAME single INSERT path (src/agents/agentOrdini.js:481 -- language-guard: allow-legacy agentOrdini.js is the existing module filename being cited, not new vocabulary
-- sbInsert("ordenes", ...); verified live: it is the ONLY INSERT into ordenes
-- in the entire backend, and Mesa reaches it via mesaService.js's
-- creaOrdine import; Mesa never UPDATEs ordenes at all). One trigger on that -- language-guard: allow-legacy creaOrdine is the existing JS order-creation function name being cited, not new vocabulary
-- one path therefore anchors an obligation for EVERY new order, whatever the
-- channel. The resulting reader precedence is TWO branches, not three:
--     canonical obligation row present -> canonical obligation
--     absent (historical row only)     -> existing legacy `totale` fallback
-- Mesa's own table_order_lines / payment-picker path is untouched by this
-- migration -- not one line of it is read, written or redefined here.
--
-- WHY A REVISION LEDGER AND NOT ONE FROZEN ROW (the Phase-9 gate).
-- `ordenes.totale` IS rewritten after creation, by three reachable writers,
-- all traced live this session: src/agents/agentOrdini.js:682 (modificaOrdine, -- language-guard: allow-legacy agentOrdini.js/modificaOrdine are the existing module and function names being cited, not new vocabulary
-- itself reachable from BOTH the `modificaOrdine` and `updateOrden` actions -- language-guard: allow-legacy modificaOrdine is the same existing action name, restated for the index.js dispatch site, not new vocabulary
-- in index.js), :801 (cambiaStato applying a RETIRADO-time descuento) and -- language-guard: allow-legacy cambiaStato is the existing JS state-change function name being cited, not new vocabulary
-- :989 (aggiungiItems). Their only gate is a BEST-EFFORT kitchen-state check -- language-guard: allow-legacy aggiungiItems is the existing JS add-items function name being cited, not new vocabulary
-- (MODIFICA_TERMINAL_STATES = EN_ENTREGA/RETIRADO/COMPLETADO/COMPLETATO -- language-guard: allow-legacy those four are the existing estado literals cited verbatim from agentOrdini.js:601, not new vocabulary
-- purely operational states) that does not consider payment at all: 12 real
-- staging orders (9 Mesa, 3 non-Mesa, EUR 271.01) are ALREADY paid and still
-- sit in a state those writers would happily edit today.
--
-- So freezing ONE immutable obligation row at creation and having readers
-- prefer it would MANUFACTURE a divergence that does not exist today: the
-- operator edits an order, the ticket/kitchen/receipt move, and the reported
-- economic gross silently stays behind. That is strictly worse than the
-- status quo, and is exactly the "ORDER DISPLAY != CANONICAL OBLIGATION"
-- failure this slice exists to prevent.
--
-- The obligation is therefore an APPEND-ONLY REVISION LEDGER. Revision 1 is
-- written in the order's own INSERT transaction and is permanent -- the exact
-- gross accepted at creation, never rewritten. Every subsequent change to
-- `ordenes.totale` is FORCED, by a second trigger in the same transaction as
-- the UPDATE, to append a new immutable revision. No row is ever updated or
-- deleted (DB-enforced). Current obligation = highest revision. Display and
-- obligation therefore cannot drift, by construction, because the only way to
-- move the money is to leave evidence.
--
-- THIS IS NOT N-5. N-5 is money-column IMMUTABILITY -- forbidding the change.
-- This migration forbids nothing that works today; it makes the change
-- impossible to HIDE, which is the minimum required for N-2 to be internally
-- consistent without regressing the legitimate operator edit workflow. The
-- pre-existing ability to rewrite the total of an ALREADY-PAID order is NOT
-- fixed here (it is N-5's job) -- it is now merely evidenced, per-revision,
-- with actor and timestamp. That exposure is reported, not silently absorbed.
--
-- IDENTITY. Rows are keyed on order_uid -- the permanent identity R-DAY2
-- already mints for EVERY order, whatever the channel, inside
-- order_entity_anchor_v1 (BEFORE INSERT on ordenes: it resolves the workspace,
-- the business-day lineage and an isolated ticket counter, then writes
-- order_entities and stamps NEW.order_uid). Never the recyclable display
-- `#NNN`, which the prior forensic work proved is reused across services.
-- order_id/service_session_id are carried alongside for reader joins, but the
-- uniqueness invariant is on (order_uid, revision).
--
-- IDEMPOTENCY comes free and is structural, not bolted on: creaOrdine's -- language-guard: allow-legacy creaOrdine is the existing JS order-creation function name, cited for the idempotency trace, not new vocabulary
-- retry identity is `ordenes.client_req_id`, protected by the pre-existing
-- UNIQUE partial index ordenes_client_req_id_uniq plus that function's own
-- pre-check and 23505 collision recovery. A retried request resolves to the
-- SAME ordenes row, so no second INSERT occurs, so this trigger cannot fire a
-- second time. Belt and braces at the DB level anyway: UNIQUE(order_uid,
-- revision) makes a duplicate creation obligation structurally impossible.
--
-- NO BACKFILL. Historical rows (e.g. #999024) keep exactly zero obligation
-- rows and stay readable through the untouched legacy `totale` fallback. No
-- timestamp, actor or idempotency fact that never existed is manufactured
-- here. A separate mechanical backfill, if ever wanted, is its own migration.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='public' AND c.relname='order_obligations') THEN
    RAISE EXCEPTION 'N-2 refused: public.order_obligations already exists -- already patched, resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='order_entity_anchor_v1') THEN
    RAISE EXCEPTION 'N-2 refused: order_entity_anchor_v1 (R-DAY2 permanent identity) is missing -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='order_entities') THEN
    RAISE EXCEPTION 'N-2 refused: order_entities is missing -- resolve drift first';
  END IF;
  -- The anchor trigger must still be BEFORE INSERT, otherwise NEW.order_uid is
  -- not populated by the time this slice's own AFTER INSERT trigger runs.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid='public.ordenes'::regclass AND NOT t.tgisinternal
       AND t.tgname='ordenes_order_entity_anchor_v1'
       AND pg_get_triggerdef(t.oid) ILIKE '%BEFORE INSERT%'
  ) THEN
    RAISE EXCEPTION 'N-2 refused: ordenes_order_entity_anchor_v1 is not a BEFORE INSERT trigger -- order_uid would not be available';
  END IF;
END $$;

BEGIN;

-- ── The canonical obligation ledger ─────────────────────────────────────
CREATE TABLE public.order_obligations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Permanent identity (R-DAY2). NOT the recyclable display id.
  order_uid            uuid NOT NULL REFERENCES public.order_entities(order_uid) ON DELETE RESTRICT,
  -- Carried for reader joins only; never the uniqueness key.
  order_id             text NOT NULL,
  service_session_id   uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  workspace_id         uuid NOT NULL,
  revision             integer NOT NULL,
  gross_amount         numeric NOT NULL,
  -- Audit provenance. `canal` at creation; `source` names the writer.
  channel              text,
  source               text NOT NULL,
  -- S-C parity: the obligation's own economic window, stamped write-time from
  -- the order's OWN service session, nullable exactly like its peers.
  economic_period_kind text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_obligations_revision_chk     CHECK (revision >= 1),
  CONSTRAINT order_obligations_gross_chk        CHECK (gross_amount >= 0),
  CONSTRAINT order_obligations_order_id_chk     CHECK (btrim(order_id) <> ''),
  CONSTRAINT order_obligations_source_chk       CHECK (source IN ('order_create_v1','order_total_revision_v1')),
  CONSTRAINT order_obligations_create_rev_chk   CHECK ((source = 'order_create_v1') = (revision = 1)),
  CONSTRAINT order_obligations_econ_period_chk  CHECK (economic_period_kind IS NULL OR economic_period_kind IN ('PRANZO','SERA')), -- language-guard: allow-legacy PRANZO is the existing service_kind enum value mirrored by every S-C peer column, not new vocabulary
  CONSTRAINT order_obligations_uid_revision_uq  UNIQUE (order_uid, revision)
);

-- Reader indexes: the closeout/Economía readers fetch per service session and
-- resolve the latest revision per order.
CREATE INDEX order_obligations_session_idx    ON public.order_obligations (service_session_id);
CREATE INDEX order_obligations_order_rev_idx  ON public.order_obligations (order_id, service_session_id, revision DESC);
CREATE INDEX order_obligations_uid_rev_idx    ON public.order_obligations (order_uid, revision DESC);

COMMENT ON TABLE public.order_obligations IS
  'N-2 canonical economic obligation ledger. Append-only, one row per order revision, keyed on the permanent order_uid. Revision 1 is written in the order''s own INSERT transaction; every later change to ordenes.totale appends a new revision in the same transaction as that UPDATE. Current obligation = highest revision. Orders created before N-2 have no rows here and are read through the legacy ordenes.totale fallback.';

-- ── Append-only enforcement ─────────────────────────────────────────────
-- Mirrors the ladieci_schema_migrations immutability precedent: UPDATE and
-- DELETE are both refused unconditionally at the row level, so no caller --
-- service_role included -- can revise or erase an obligation after the fact.
CREATE OR REPLACE FUNCTION public.order_obligations_append_only_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'order_obligations is append-only: UPDATE is forbidden (order_uid=%, revision=%)', OLD.order_uid, OLD.revision
      USING ERRCODE = '0A000';
  END IF;
  RAISE EXCEPTION 'order_obligations is append-only: DELETE is forbidden (order_uid=%, revision=%)', OLD.order_uid, OLD.revision
    USING ERRCODE = '0A000';
END;
$fn$;

CREATE TRIGGER order_obligations_append_only_v1
  BEFORE UPDATE OR DELETE ON public.order_obligations
  FOR EACH ROW EXECUTE FUNCTION public.order_obligations_append_only_v1();

-- ── Writer 1: revision 1, in the order's own INSERT transaction ─────────
-- AFTER INSERT, deliberately: order_entity_anchor_v1 runs BEFORE INSERT and is
-- what stamps NEW.order_uid and writes the order_entities parent row, so the
-- FK above is satisfiable only from AFTER. Same transaction either way -- if
-- this raises, the order INSERT itself rolls back, so "order committed but
-- obligation did not" is structurally impossible.
CREATE OR REPLACE FUNCTION public.order_obligation_anchor_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_workspace uuid;
  v_kind      text;
BEGIN
  IF NEW.order_uid IS NULL THEN
    RAISE EXCEPTION 'ORDER_OBLIGATION_WITHOUT_IDENTITY' USING ERRCODE='P0001';
  END IF;
  IF NEW.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_OBLIGATION_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;

  -- Workspace + economic window are read from the order's OWN already-written
  -- identity/lineage rows, never from client payload.
  SELECT oe.workspace_id INTO v_workspace
    FROM public.order_entities oe WHERE oe.order_uid = NEW.order_uid;
  IF v_workspace IS NULL THEN
    RAISE EXCEPTION 'ORDER_OBLIGATION_WITHOUT_WORKSPACE' USING ERRCODE='P0001';
  END IF;

  SELECT ss.service_kind INTO v_kind
    FROM public.service_sessions ss WHERE ss.id = NEW.service_session_id;

  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision,
     gross_amount, channel, source, economic_period_kind, created_at)
  VALUES
    (NEW.order_uid, NEW.id, NEW.service_session_id, v_workspace, 1,
     COALESCE(NEW.totale, 0), NEW.canal, 'order_create_v1',
     CASE WHEN v_kind IN ('PRANZO','SERA') THEN v_kind ELSE NULL END, -- language-guard: allow-legacy PRANZO is the existing service_kind enum value being matched verbatim, not new vocabulary
     COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ordenes_order_obligation_anchor_v1
  AFTER INSERT ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_obligation_anchor_v1();

-- ── Writer 2: a new revision whenever the accepted total moves ──────────
-- Same transaction as the UPDATE that moved it. An order created before N-2
-- (no revision 1) is deliberately left alone: appending a lone revision to a
-- historical order would fabricate an obligation that never existed and would
-- silently flip that order from the legacy fallback onto the canonical
-- reader mid-life. Those orders stay legacy, permanently.
CREATE OR REPLACE FUNCTION public.order_obligation_revision_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_prev   public.order_obligations%ROWTYPE;
BEGIN
  IF NEW.totale IS NOT DISTINCT FROM OLD.totale THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_prev FROM public.order_obligations
   WHERE order_uid = NEW.order_uid
   ORDER BY revision DESC LIMIT 1;

  -- Pre-N-2 order: no canonical obligation exists, and this slice does not
  -- retro-fit one. It keeps reading through the legacy fallback.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.order_obligations
    (order_uid, order_id, service_session_id, workspace_id, revision,
     gross_amount, channel, source, economic_period_kind, created_at)
  VALUES
    (NEW.order_uid, NEW.id, v_prev.service_session_id, v_prev.workspace_id,
     v_prev.revision + 1, COALESCE(NEW.totale, 0), NEW.canal,
     'order_total_revision_v1', v_prev.economic_period_kind, now());

  RETURN NEW;
END;
$fn$;

CREATE TRIGGER ordenes_order_obligation_revision_v1
  AFTER UPDATE OF totale ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_obligation_revision_v1();

-- ── Grants / RLS ────────────────────────────────────────────────────────
-- Financial truth is never writable (nor readable) from a browser client.
-- Matches the L-1 lockdown posture: revoke BY NAME, not merely FROM PUBLIC.
--
-- service_role IS REVOKED FIRST, DELIBERATELY, and this was caught by this
-- migration's OWN post-condition on the first apply attempt rather than
-- assumed: this project's Supabase carries ALTER DEFAULT PRIVILEGES granting
-- arwdDxtm (ALL) on every new public table to postgres, anon, authenticated
-- AND service_role. So a freshly CREATEd table starts with full UPDATE/DELETE
-- for all four, and a bare `GRANT SELECT, INSERT TO service_role` is purely
-- additive -- it would have left UPDATE and DELETE in place on an append-only
-- financial ledger. Same family as ledger 98's own lesson (a REVOKE FROM
-- PUBLIC does not remove a privilege held directly by a named role), now
-- proven to apply to service_role too. The append-only trigger above already
-- refuses both operations at row level; this is the second, independent lock.
ALTER TABLE public.order_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_obligations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_obligations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.order_obligations TO service_role;

REVOKE ALL ON FUNCTION public.order_obligation_anchor_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_obligation_revision_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_obligations_append_only_v1() FROM PUBLIC, anon, authenticated;

-- ── Post-condition assertions ───────────────────────────────────────────
-- STRUCTURAL ONLY. No business DML runs inside this transaction: no existing
-- ordenes row is touched, no obligation is backfilled, no historical row is
-- rewritten. The behavioural proof (creation writes exactly one revision-1,
-- a totale UPDATE appends revision 2, UPDATE/DELETE on the ledger are
-- refused, a pre-N-2 order stays legacy) runs separately as rollback-safe
-- probes against real staging data -- see this slice's report.
DO $$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname='order_obligations') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: order_obligations was not created';
  END IF;

  -- The ledger must start empty: this migration backfills nothing.
  SELECT count(*) INTO v_n FROM public.order_obligations;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'N-2 post-condition failed: order_obligations must start empty (no backfill), found % rows', v_n;
  END IF;

  -- Both writers and the append-only guard must be installed.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: the creation-anchor trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_revision_v1'
                  AND pg_get_triggerdef(oid) ILIKE '%UPDATE OF totale%') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: the totale-revision trigger is missing or not scoped to totale';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.order_obligations'::regclass
                  AND NOT tgisinternal AND tgname='order_obligations_append_only_v1') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: the append-only guard is missing';
  END IF;

  -- The anchor must be AFTER INSERT (order_uid is stamped by the BEFORE trigger).
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_obligation_anchor_v1'
                  AND pg_get_triggerdef(oid) ILIKE '%AFTER INSERT%') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: the creation anchor must be AFTER INSERT';
  END IF;

  -- Identity invariant: uniqueness is on (order_uid, revision), never order_id.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.order_obligations'::regclass
                  AND conname='order_obligations_uid_revision_uq' AND contype='u') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: UNIQUE(order_uid, revision) is missing';
  END IF;

  -- Mesa must be structurally untouched by this migration.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='mesa_snapshot_order_lines_v1') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: Mesa line-snapshot trigger disappeared';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordenes'::regclass
                  AND NOT tgisinternal AND tgname='ordenes_order_entity_anchor_v1') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: R-DAY2 identity anchor disappeared';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.order_obligations', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.order_obligations', 'SELECT') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: service_role must hold SELECT+INSERT on order_obligations';
  END IF;
  IF has_table_privilege('service_role', 'public.order_obligations', 'UPDATE')
     OR has_table_privilege('service_role', 'public.order_obligations', 'DELETE') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: not even service_role may hold UPDATE/DELETE on the obligation ledger';
  END IF;
  IF has_table_privilege('anon', 'public.order_obligations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.order_obligations', 'SELECT') THEN
    RAISE EXCEPTION 'N-2 post-condition failed: anon/authenticated must never read the obligation ledger';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.order_obligations'::regclass) THEN
    RAISE EXCEPTION 'N-2 post-condition failed: RLS must be enabled AND forced on order_obligations';
  END IF;
END $$;

-- LEDGER REGISTRATION IS DELIBERATELY NOT IN THIS FILE, exactly as ledgers
-- 96-111: the manifest records this file's own sha256, and embedding that sha
-- in an INSERT inside the file would make the checksum self-referential.
-- Registered as a separate statement at apply time: apply_order 112, kind
-- 'ddl', checksum = this file's sha256, applied_by = the introducing commit
-- (committed BEFORE this migration is applied -- O-1's ledger-immutability
-- lesson, followed again).

COMMIT;
