-- migrations/2026-08-16_r_day2_permanent_order_identity.sql
-- R-DAY2 — PERMANENT ORDER IDENTITY + TICKET-EPOCH INTEGRATION SUBSTRATE.
-- Authority: BUSINESS_DAY_R_DAY_IMPLEMENTATION_PLAN_V1_2026-08-16.md (R-DAY0,
-- approved/frozen) §7-8, absorbing MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md
-- slice S6 in its entirety (S6 is retired as a standalone slice; this migration
-- is its replacement, amended per R-DAY0 §8.3).
--
-- WHAT THIS MIGRATION DOES
--   1. public.mesa_singleton_workspace_v1() — fail-closed single-tenant
--      workspace resolver for orders with no table_session_id (unchanged from
--      the original frozen S6 §18.4 design).
--   2. public.order_entities — the permanent, append-only identity owner.
--      One immutable row per real order, forever. Amended per R-DAY0 §8.3 to
--      carry business_day_id (NOT NULL, derived from the order's own Service
--      Period), ticket_epoch/ticket_number (NULLABLE — real values for every
--      NEW row, NULL for historically backfilled rows with no honest value).
--   3. public.ordenes.order_uid — NULLABLE. Trigger-assigned for every new
--      row (100% coverage going forward, DB-atomic, no cross-deploy gap).
--      Deterministically backfilled for every existing live row (100%
--      coverage achieved in this same transaction, verified below).
--      SET NOT NULL is explicitly NOT this slice's job — the original frozen
--      plan assigns that to S7 (§24: "S7 | ... ordenes.order_uid is NOT
--      NULL"), and R-DAY0 did not override that ownership. Deferred, not
--      because of any safety gap in this design (there is none — the trigger
--      guarantees 100% coverage from the instant this transaction commits),
--      but to respect the slice boundary R-DAY0/S7 already owns.
--   4. public.order_entity_anchor_v1() + trigger ordenes_order_entity_anchor_v1
--      — the sole writer of public.order_entities for every NEW order,
--      BEFORE INSERT on public.ordenes, sorting after ordenes_assign_
--      service_session (needs NEW.service_session_id) and before the AFTER
--      INSERT mesa_snapshot_order_lines_v1 (BEFORE always precedes AFTER
--      regardless of name) — verified live, see the paired static test.
--   5. Deterministic historical backfill of order_entities from every live
-- language-guard: allow-legacy storico is the existing archive table this migration reads from (never renamed), not new vocabulary
--      ordenes row plus every storico row with no live ordenes counterpart —
--      no timestamp-based dedup fragility: ordenes rows are already
-- language-guard: allow-legacy storico is the existing archive table this migration reads from (never renamed), not new vocabulary
--      PK-unique by construction, storico rows are filtered to exactly those
--      with NO corresponding live ordenes row, so the two sources are
--      disjoint by construction and UNION ALL is safe.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (R-DAY2 non-goals)
--   - does NOT read or write public.business_day_lifecycle_state anywhere in
--     this file. Business Day lineage for every anchor — new or historical —
--     is derived exclusively through the order's own immutable Service
--     Period: service_sessions.business_day_id (established by R-DAY1,
--     NOT NULL on every row). The R-DAY1 pointer tuple's own live
--     concurrency proof is still outstanding (deferred to before its first
--     live consumer) — this migration is not that consumer, and never will
--     be, by construction;
--   - does NOT flip order intake to Business Day authority (R-DAY3);
--   - does NOT advance business_days.ticket_epoch, does NOT implement period
--     consolidation, does NOT reset display numbering (R-DAY4);
--   - does NOT implement Business Day SEAL (R-DAY5);
--   - does NOT perform the S8 append-only backfill of table_order_lines /
--     payment_allocations / order_financial_events / service_incidents —
--     those remain S8's sole sanctioned bypass, untouched here;
--   - does NOT apply SET NOT NULL to ordenes.order_uid (S7's job, see above);
--   - does NOT touch any financial table, any payment, any incident, any
--     table_session, any rider/delivery state, any frontend contract.
--
-- WHY THE TICKET UNIQUENESS CONSTRAINT IS SAFE NOW, NOT MERELY DEFERRED
-- order_entities.ticket_number is a brand-new, isolated counter
-- (business_days.next_ticket_number, established inert by R-DAY1, consumed
-- for the first time by THIS migration's own anchor trigger) with zero
-- relationship to ordenes.id/#NNN — the still-live legacy display-ticket
-- language-guard: allow-legacy agentOrdini.js is the existing file path this migration proves it never touches, not new vocabulary
-- mechanism in src/agents/agentOrdini.js is completely untouched by this
-- migration and continues to mint #NNN exactly as it does today. Because
-- order_entities.ticket_number is written by exactly one function
-- (order_entity_anchor_v1, via one atomic UPDATE...RETURNING per row) and
-- read by nothing else in this migration or in any existing runtime code,
-- UNIQUE (business_day_id, ticket_epoch, ticket_number) can never reject a
-- legitimate order under the still-live old numbering system, because the
-- two systems share no column, no table, and no writer. Historical
-- backfilled rows get NULL ticket_epoch/ticket_number (no honest value is
-- knowable for them — never guessed), and Postgres UNIQUE constraints treat
-- every NULL as distinct from every other NULL by default, so any number of
-- historical NULL-ticket rows coexist safely under the same constraint.
-- TRANSITIONAL_TICKET_COLLISION_RISK = PASS (not merely deferred).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY2 refused: staging sentinel migration absent -- wrong database?'; END IF;

  IF to_regclass('public.ladieci_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'R-DAY2 refused: public.ladieci_schema_migrations (S4) is missing -- resolve drift first';
  END IF;

  IF to_regclass('public.business_days') IS NULL
     OR to_regclass('public.business_day_lifecycle_state') IS NULL
  THEN RAISE EXCEPTION 'R-DAY2 refused: R-DAY1 foundation (business_days/business_day_lifecycle_state) missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='business_day_id'
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'R-DAY2 refused: service_sessions.business_day_id (R-DAY1) missing -- resolve drift first';
  END IF;

  IF to_regclass('public.order_entities') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY2 refused: public.order_entities already exists -- already patched, resolve drift first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='ordenes' AND column_name='order_uid'
  ) THEN RAISE EXCEPTION 'R-DAY2 refused: ordenes.order_uid already exists -- already patched, resolve drift first'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='mesa_singleton_workspace_v1'
  ) THEN RAISE EXCEPTION 'R-DAY2 refused: mesa_singleton_workspace_v1 already exists -- already patched, resolve drift first'; END IF;

  IF to_regclass('public.period_consolidations') IS NOT NULL
     OR to_regclass('public.business_day_closeout_attempts') IS NOT NULL
  THEN RAISE EXCEPTION 'R-DAY2 refused: an R-DAY4+ object already exists -- this migration is out of sequence'; END IF;

  -- Deterministic-backfill preconditions: never guess. Zero rows unresolvable
  -- expected on live staging (verified read-only before authoring this file).
  IF EXISTS (SELECT 1 FROM public.ordenes WHERE service_session_id IS NULL) THEN
    RAISE EXCEPTION 'R-DAY2 refused: live ordenes rows exist with service_session_id IS NULL -- unresolvable Business Day lineage, escalate instead of guessing';
  END IF;
  -- language-guard: allow-legacy storico is the existing archive table this predecessor guard reads from, not new vocabulary
  IF EXISTS (SELECT 1 FROM public.storico WHERE service_session_id IS NULL AND orden_id IS NOT NULL) THEN
    -- language-guard: allow-legacy storico is the existing archive table this error message names, not new vocabulary
    RAISE EXCEPTION 'R-DAY2 refused: storico rows exist with service_session_id IS NULL -- unresolvable Business Day lineage, escalate instead of guessing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ordenes WHERE ts IS NULL AND created_at IS NULL) THEN
    RAISE EXCEPTION 'R-DAY2 refused: live ordenes rows exist with no resolvable creation timestamp';
  END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY2 refused: payment_transactions population is % (expected 20) -- financial drift detected, re-verify before proceeding',
      (SELECT count(*) FROM public.payment_transactions);
  END IF;
END $$;

-- PART 1 — mesa_singleton_workspace_v1(): single-tenant fail-closed tripwire.
-- Unchanged from the original frozen S6 §18.4 design. Not a temporary
-- crutch: it raises the day a second workspace appears, forcing an explicit
-- decision rather than a silent mis-attribution.
CREATE OR REPLACE FUNCTION public.mesa_singleton_workspace_v1()
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_id uuid; v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.workspaces;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'MESA_WORKSPACE_AMBIGUOUS' USING ERRCODE='P0001',
      DETAIL = format('workspaces=%s; order_entity_anchor needs an explicit workspace', v_n);
  END IF;
  SELECT id INTO v_id FROM public.workspaces;
  RETURN v_id;
END $function$;

REVOKE ALL ON FUNCTION public.mesa_singleton_workspace_v1() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mesa_singleton_workspace_v1() TO service_role;

-- PART 2 — public.order_entities: the permanent identity owner.
CREATE TABLE public.order_entities (
  order_uid          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES public.workspaces(id),
  display_order_id   text        NOT NULL,
  service_session_id uuid        NOT NULL REFERENCES public.service_sessions(id),
  table_session_id   uuid            NULL REFERENCES public.table_sessions(id),
  business_day_id    uuid        NOT NULL REFERENCES public.business_days(id),
  ticket_epoch       integer         NULL,
  ticket_number      integer         NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text            NULL
);
CREATE INDEX order_entities_display_idx ON public.order_entities (service_session_id, display_order_id);
CREATE INDEX order_entities_business_day_idx ON public.order_entities (business_day_id);
-- Safe now (not merely deferred) -- see the migration header's dedicated
-- explanation. NULLs (all historical rows) are distinct from each other by
-- default Postgres semantics; every real value is minted by one sole writer.
CREATE UNIQUE INDEX order_entities_ticket_uq ON public.order_entities (business_day_id, ticket_epoch, ticket_number);

CREATE TRIGGER order_entities_append_only_v1
  BEFORE UPDATE OR DELETE ON public.order_entities
  FOR EACH ROW EXECUTE FUNCTION public.mesa_append_only_v1();

-- PART 3 — public.ordenes.order_uid. NULLABLE in this slice (see header).
ALTER TABLE public.ordenes
  ADD COLUMN order_uid uuid NULL REFERENCES public.order_entities(order_uid);
CREATE UNIQUE INDEX ordenes_order_uid_uq ON public.ordenes (order_uid) WHERE order_uid IS NOT NULL;

-- PART 4 — the anchor writer. Sole writer of public.order_entities for every
-- NEW order. Business Day lineage derived ONLY through the order's own
-- Service Period (service_sessions.business_day_id) -- never through
-- business_day_lifecycle_state, per this migration's own header and the
-- R-DAY2 hard rule against consuming the still-concurrency-unverified
-- pointer tuple.
CREATE OR REPLACE FUNCTION public.order_entity_anchor_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $function$
DECLARE
  v_workspace       uuid;
  v_business_day    uuid;
  v_epoch           integer;
  v_ticket_number   integer;
  v_uid             uuid;
BEGIN
  IF NEW.service_session_id IS NULL THEN
    RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE='P0001';
  END IF;
  IF NEW.order_uid IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_UID_FORGERY' USING ERRCODE='P0001';   -- callers never supply it
  END IF;

  -- Business Day lineage: deterministic, write-time, immutable -- via the
  -- order's OWN Service Period, established NOT NULL by R-DAY1 for every
  -- live service_sessions row. Fails closed on genuine integrity breakage
  -- only; structurally unreachable in normal operation.
  SELECT business_day_id INTO v_business_day
    FROM public.service_sessions WHERE id = NEW.service_session_id;
  IF v_business_day IS NULL THEN
    RAISE EXCEPTION 'SERVICE_PERIOD_WITHOUT_BUSINESS_DAY' USING ERRCODE='P0001';
  END IF;

  -- Workspace lineage: Mesa orders resolve via their table session (already
  -- workspace_id NOT NULL); every other channel resolves via the singleton
  -- tripwire. Never inferred from client payload.
  IF NEW.table_session_id IS NOT NULL THEN
    SELECT ts.workspace_id INTO v_workspace
      FROM public.table_sessions ts WHERE ts.id = NEW.table_session_id;
    IF v_workspace IS NULL THEN
      RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE='P0002';
    END IF;
  ELSE
    v_workspace := public.mesa_singleton_workspace_v1();
  END IF;

  -- Ticket identity substrate: real values, minted from THIS order's own
  -- Business Day row (resolved above via period lineage, never the
  -- pointer). Isolated counter, no relationship to ordenes.id/#NNN.
  UPDATE public.business_days
     SET next_ticket_number = next_ticket_number + 1, updated_at = now()
   WHERE id = v_business_day
  RETURNING next_ticket_number - 1, ticket_epoch INTO v_ticket_number, v_epoch;

  INSERT INTO public.order_entities
    (workspace_id, display_order_id, service_session_id, table_session_id,
     business_day_id, ticket_epoch, ticket_number, created_at)
  VALUES
    (v_workspace, NEW.id, NEW.service_session_id, NEW.table_session_id,
     v_business_day, v_epoch, v_ticket_number, COALESCE(NEW.created_at, now()))
  RETURNING order_uid INTO v_uid;

  NEW.order_uid := v_uid;
  RETURN NEW;
END $function$;

-- Sorts after ordenes_assign_service_session ('...anchor_v1' > '...service_
-- session' at the first differing character, 'o' vs 'a') so NEW.service_
-- session_id is already assigned; a BEFORE trigger, so it always precedes
-- the AFTER INSERT mesa_snapshot_order_lines_v1 regardless of naming.
-- Verified live -- see the paired static test's trigger-order assertions.
CREATE TRIGGER ordenes_order_entity_anchor_v1
  BEFORE INSERT ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_entity_anchor_v1();

REVOKE ALL ON FUNCTION public.order_entity_anchor_v1() FROM PUBLIC, anon, authenticated;

-- PART 5 — deterministic historical backfill. ordenes rows are already
-- PK-unique (ordenes.id is the physical primary key); no_live_ordenes_counterpart is
-- filtered to rows with NO live ordenes counterpart, so the two sources are
-- disjoint by construction -- UNION ALL is safe, no timestamp-based dedup
-- fragility.
WITH ordenes_source AS (
  SELECT o.id AS display_order_id, o.service_session_id, o.table_session_id,
         COALESCE(o.created_at, to_timestamp(o.ts / 1000.0)) AS created_at
  FROM public.ordenes o
),
no_live_ordenes_counterpart AS (
  SELECT DISTINCT ON (s.service_session_id, s.orden_id)
         s.orden_id AS display_order_id, s.service_session_id, s.table_session_id,
         to_timestamp(s.ts / 1000.0) AS created_at
  -- language-guard: allow-legacy storico is the existing archive table this backfill reads from, not new vocabulary
  FROM public.storico s
  WHERE s.orden_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.ordenes o2
       WHERE o2.service_session_id = s.service_session_id AND o2.id = s.orden_id
    )
  ORDER BY s.service_session_id, s.orden_id, s.ts ASC
),
source AS (
  SELECT * FROM ordenes_source
  UNION ALL
  SELECT * FROM no_live_ordenes_counterpart
)
INSERT INTO public.order_entities
  (workspace_id, display_order_id, service_session_id, table_session_id, business_day_id, created_at)
SELECT
  CASE WHEN d.table_session_id IS NOT NULL
       THEN (SELECT ts.workspace_id FROM public.table_sessions ts WHERE ts.id = d.table_session_id)
       ELSE public.mesa_singleton_workspace_v1()
  END,
  d.display_order_id, d.service_session_id, d.table_session_id,
  ss.business_day_id, d.created_at
FROM source d
JOIN public.service_sessions ss ON ss.id = d.service_session_id;

-- PART 6 — backfill ordenes.order_uid for every existing live row, matched
-- 1:1 against the anchor this same transaction just created for it.
UPDATE public.ordenes o
   SET order_uid = oe.order_uid
  FROM public.order_entities oe
 WHERE oe.service_session_id = o.service_session_id
   AND oe.display_order_id = o.id
   AND o.order_uid IS NULL;

-- PART 7 — RLS / grants, matching order_entities to the same discipline as
-- every other lifecycle/identity table in this codebase.
ALTER TABLE public.order_entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_entities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.order_entities TO service_role;

-- PART 8 — post-condition assertions.
DO $$
DECLARE
  v_live_unmapped         integer;
  v_new_order_gate        integer;
  v_orphan_anchor_check   integer;
BEGIN
  -- NEW_ORDER_WITHOUT_ORDER_ENTITY equivalent for the live population:
  -- every live ordenes row must now carry order_uid.
  SELECT count(*) INTO v_live_unmapped FROM public.ordenes WHERE order_uid IS NULL;
  IF v_live_unmapped <> 0 THEN
    RAISE EXCEPTION 'R-DAY2 post-condition failed: % live ordenes rows failed to backfill order_uid', v_live_unmapped;
  END IF;

  -- Every ordenes.order_uid resolves to exactly one order_entities row
  -- (guaranteed by the FK, re-asserted explicitly for the transaction log).
  SELECT count(*) INTO v_orphan_anchor_check
    FROM public.ordenes o LEFT JOIN public.order_entities oe ON oe.order_uid = o.order_uid
   WHERE o.order_uid IS NOT NULL AND oe.order_uid IS NULL;
  IF v_orphan_anchor_check <> 0 THEN
    RAISE EXCEPTION 'R-DAY2 post-condition failed: % ordenes rows reference a non-existent order_entities row', v_orphan_anchor_check;
  END IF;

  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY2 post-condition failed: payment_transactions population changed during this migration -- must be exactly 20';
  END IF;
END $$;

COMMIT;
