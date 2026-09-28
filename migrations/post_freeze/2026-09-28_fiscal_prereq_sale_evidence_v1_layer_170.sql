-- migrations/post_freeze/2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.sql
-- Paired rollback (DETACH): 2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.ROLLBACK.sql
--
-- POST-FREEZE LAYER 170 -- FISCAL PREREQUISITES V1, SLICE P1: IMMUTABLE ACCEPTED-SALE EVIDENCE FOR GENERIC (DELIVERY / PICKUP) ORDERS.
-- NOT part of the Economy 139 -> 156 freeze. Applied, and detached, ONLY by scripts/postFreezeLayerApply.js (registry
-- scripts/lib/postFreezeLayers.js). Contract: docs/FISCAL_P1_SALE_EVIDENCE_CONTRACT.md.
--
-- PROBLEM. Mesa orders already carry immutable per-unit commercial evidence (public.table_order_lines, written in the order's INSERT
-- transaction, append-only). Generic orders do not: public.ordenes.items is rewritten in place by the canonical editor writer (153) on
-- every accepted edit. A later fiscal document must never be rebuilt from mutable current order state.
--
-- WHAT THIS LAYER DOES. A separate schema, sale_evidence, receives an append-only COMPOSITION REVISION every time the accepted commercial
-- composition of a generic order is created or changes:
--   ordenes_zzz_sale_evidence_capture_ins_v1  AFTER INSERT ON public.ordenes, generic orders only      -> revision 1, ORDER_CREATED
--   ordenes_zzz_sale_evidence_capture_upd_v1  AFTER UPDATE OF the seven basis columns, generic only,
--                                             WHEN at least one of them is DISTINCT               -> revision n+1, ACCEPTED_EDIT
-- The basis columns are exactly the Economy's own EDITOR_BASIS_FIELDS / 153 v_basis: items, totale, delivery_fee, descuento_tipo,
-- descuento_valor, descuento_importe, tipo_consegna.  language-guard: allow-legacy tipo_consegna is the existing ordenes column name
-- Inside the function a revision is written only when the VALUE-level basis digest (numbers compared by value, key order irrelevant,
-- NULL items = empty list, '' text = NULL) differs from the last captured revision of that order (or, for an order with no revision, from
-- the OLD row): a representation-only rewrite, or an UPDATE that sets a basis column to the value it already has, writes nothing.
--
-- ATOMICITY. The capture runs inside the order's own statement, in the same transaction, AFTER every BEFORE trigger accepted the row and
-- AFTER the Economy AFTER triggers of the same event (obligation anchor / revision, paid-at-creation): PostgreSQL fires same-event triggers
-- in name order and every existing AFTER trigger of ordenes sorts before 'ordenes_zzz_' (checked below). A refused edit (paid guard, 126
-- basis lock, 151 gate, 153 compare-and-set) never reaches it; a rolled-back transaction takes the revision with it; an infrastructure
-- failure of the capture raises and aborts the order write (no basis change without evidence). The capture never refuses for CONTENT:
-- an unparseable amount is stored with parse_status = 'INVALID' and a named issue, and the Economy write proceeds.
--
-- LOCKS. The capture takes no row lock and has no foreign key to any Economy table: it only READS order_entities, order_obligations,
-- order_financial_events, payment_allocations / payment_transactions (plain snapshot reads) and writes rows of its own schema. It adds no
-- wait edge to the Economy lock graph. The revision number is max+1 per order_uid: two captures of the same order are serialized by the
-- ordenes row lock their UPDATEs already take; UNIQUE (order_uid, revision) turns any unknown concurrent path into a failure, never a fork.
--
-- HISTORY. Nothing is back-filled. Orders that exist when the layer is attached get NO composition revision; each is registered in
-- sale_evidence.history_gap_markers (reason ORDER_PREDATES_CAPTURE), an explicit statement that no authoritative creation evidence exists.
-- Their later accepted edits ARE captured (chain_origin = CREATION_NOT_CAPTURED). A detach / re-attach cycle (the rollback of this layer)
-- is recorded in sale_evidence.capture_epochs, and the re-attach marks every order whose evidence may be incomplete because of the gap.
--
-- NOT HERE (explicitly): tax rates, tax treatments, invoice numbers, series, QR, hash chain, AEAT, any fiscal document. This is commercial
-- evidence a later fiscal document can reference (by revision id + basis digest); it is not an invoice.
--
-- NO ECONOMY OBJECT IS CHANGED: no ALTER / CREATE OR REPLACE / DROP of any public function, table, constraint, grant or existing trigger.
-- The only new objects outside schema sale_evidence are the two triggers on public.ordenes.
--
-- ROLLBACK: the paired .ROLLBACK.sql DETACHES the capture (drops the two ordenes triggers and the capture function) and keeps every table
-- and every row (commercial evidence is retained). This forward file is also the RE-ATTACH: on a DETACHED layer it re-creates the capture
-- only (every CREATE below is IF NOT EXISTS / OR REPLACE for the retained objects; the runner requires the exact DETACHED state first).
-- Point of no return: the first fiscal document that references a composition revision (future Fiscal Core); from then on the capture must
-- never be detached in production.

BEGIN;

SET LOCAL lock_timeout = '15s';

-- ── quiesce: the ONLY lock this layer takes on an Economy relation, taken FIRST and held to COMMIT ─────────────────────────────────────
-- SHARE ROW EXCLUSIVE on ordenes waits for every in-flight ordenes writer and blocks new ones until COMMIT (plain reads continue). After
-- it is granted this transaction never waits on anything an ordenes writer can hold, so it cannot take part in a deadlock; every order
-- committed before it is visible to the marker query below, and every order written after COMMIT fires the new triggers.
LOCK TABLE public.ordenes IN SHARE ROW EXCLUSIVE MODE;

-- ── guard: role, server, the Economy bodies this layer relies on, trigger ordering, install mode ──────────────────────────────────────
DO $guard$
DECLARE
  v_mode text;
  v_schema boolean := to_regnamespace('sale_evidence') IS NOT NULL;
  v_trg integer;
  v_capture boolean;
  v_last_event text;
  v_bad text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: apply as role postgres (the owner of public.ordenes), not %', current_user;
  END IF;
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: PostgreSQL 17 required';
  END IF;
  IF to_regclass('public.ordenes') IS NULL OR to_regclass('public.order_entities') IS NULL OR to_regclass('public.order_obligations') IS NULL
     OR to_regclass('public.order_financial_events') IS NULL OR to_regclass('public.payment_allocations') IS NULL
     OR to_regclass('public.payment_transactions') IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: a required Economy table or role is missing';
  END IF;
  -- The Economy bodies whose behaviour the capture relies on, exactly as certified at POST_APPLY (Economy 139 -> 156):
  --   entity anchor (order_uid set BEFORE INSERT), obligation anchor + revision (visible to a later AFTER trigger), 153 editor writer (the one
  --   basis writer), N-5 paid guard + 126 basis lock (refusals happen BEFORE the capture), paid-at-creation (fires before the capture).
  SELECT string_agg(x.sig, ', ') INTO v_bad
    FROM (VALUES
      ('public.order_entity_anchor_v1()', '3db9189218204ad2488cff64fd55eb9c'),
      ('public.order_obligation_anchor_v1()', '97bf65b4e31d63a81c4d6d234a45b898'),
      ('public.order_obligation_revision_v1()', 'bfac4ec3f428daa91d5d9505d8b1285a'),
      ('public.order_apply_editor_patch_v1(text,jsonb,jsonb)', 'd5f962866a565fe63eb0842124829cfe'),
      ('public.paid_order_economic_mutation_guard_v1()', 'fcbc86950c285232aaee2b47f20c9ba7'),
      ('public.order_economic_basis_lock_v1()', '2a72a4b53666d539960917685eb90fed'),
      ('public.order_initial_payment_v1()', 'e397b66e3aabe66a123a5356c825f124')) x(sig, want)
   WHERE to_regprocedure(x.sig) IS NULL
      OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.want;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: Economy is not at its certified POST_APPLY bodies (%)', v_bad;
  END IF;
  -- Every existing AFTER INSERT / AFTER UPDATE row trigger of ordenes must fire BEFORE the capture (name order, C collation).
  SELECT string_agg(t.tgname, ', ') INTO v_bad
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
     AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & (4 | 16)) <> 0
     AND t.tgname NOT LIKE 'ordenes\_zzz\_sale\_evidence\_capture\_%'
     AND t.tgname COLLATE "C" >= 'ordenes_zzz_sale_evidence_capture_ins_v1';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: AFTER trigger(s) of ordenes would fire after the capture: %', v_bad;
  END IF;
  -- Every generic order must carry its permanent identity (V3: set by the entity anchor on every INSERT).
  IF EXISTS (SELECT 1 FROM public.ordenes o WHERE o.table_session_id IS NULL AND o.order_uid IS NULL) THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: a generic order without order_uid exists; it could never be linked to evidence';
  END IF;
  -- Install mode: FRESH (nothing of the layer exists) or REATTACH (the exact retained part of a DETACHED layer; the runner has verified
  -- its catalog fingerprint). Anything else (already attached, partial, drifted) is refused.
  SELECT count(*) INTO v_trg FROM pg_trigger t
   WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname LIKE 'ordenes\_zzz\_sale\_evidence\_%';
  v_capture := to_regprocedure('sale_evidence.capture_composition_v1()') IS NOT NULL;
  IF NOT v_schema THEN
    IF v_trg <> 0 OR v_capture THEN RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: capture objects exist without their schema'; END IF;
    v_mode := 'FRESH';
  ELSE
    IF v_trg <> 0 OR v_capture THEN RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: the capture is already attached'; END IF;
    IF to_regclass('sale_evidence.capture_epochs') IS NULL OR to_regclass('sale_evidence.composition_revisions') IS NULL
       OR to_regclass('sale_evidence.composition_lines') IS NULL OR to_regclass('sale_evidence.history_gap_markers') IS NULL THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: schema sale_evidence exists but is not a detached layer 170';
    END IF;
    EXECUTE 'SELECT event FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1' INTO v_last_event;
    IF v_last_event IS DISTINCT FROM 'DETACHED' THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_LAYER refused: the last capture epoch is % (a re-attach requires DETACHED)', COALESCE(v_last_event, '<none>');
    END IF;
    v_mode := 'REATTACH';
  END IF;
  PERFORM set_config('sale_evidence.install_mode', v_mode, true);
END $guard$;

-- ── schema ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS sale_evidence AUTHORIZATION postgres;
COMMENT ON SCHEMA sale_evidence IS 'Post-freeze layer 170 (Fiscal prerequisites V1, P1): immutable accepted-sale composition evidence for generic orders. Append-only. Written only by the capture triggers on public.ordenes. Not an invoice; no tax, numbering or AEAT concept.';

-- ── pure helpers (no table access) ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- A JSON amount (number, or numeric string) -> integer cents. Never raises; the issue says why there is no value.
CREATE OR REPLACE FUNCTION sale_evidence.json_cents_v1(p jsonb, OUT cents bigint, OUT issue text)
 LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  t text;
  v numeric;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) = 'null' THEN issue := 'MISSING'; RETURN; END IF;
  IF jsonb_typeof(p) = 'number' THEN t := p::text;
  ELSIF jsonb_typeof(p) = 'string' THEN t := btrim(p #>> '{}');
  ELSE issue := 'NOT_NUMERIC'; RETURN;
  END IF;
  IF t !~ '^-?[0-9]+(\.[0-9]+)?$' THEN issue := 'NOT_NUMERIC'; RETURN; END IF;
  IF t !~ '^-?[0-9]{1,13}(\.[0-9]{1,12})?$' THEN issue := 'OUT_OF_RANGE'; RETURN; END IF;
  v := t::numeric * 100;
  IF v <> trunc(v) THEN issue := 'NOT_CENT_EXACT'; RETURN; END IF;
  cents := v::bigint;
  IF cents < 0 THEN issue := 'NEGATIVE'; END IF;
END
$fn$;

-- A numeric column -> integer cents, same rules.
CREATE OR REPLACE FUNCTION sale_evidence.numeric_cents_v1(p numeric, OUT cents bigint, OUT issue text)
 LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  v numeric;
BEGIN
  IF p IS NULL THEN issue := 'MISSING'; RETURN; END IF;
  IF abs(p) >= 10000000000000 THEN issue := 'OUT_OF_RANGE'; RETURN; END IF;
  v := p * 100;
  IF v <> trunc(v) THEN issue := 'NOT_CENT_EXACT'; RETURN; END IF;
  cents := v::bigint;
  IF cents < 0 THEN issue := 'NEGATIVE'; END IF;
END
$fn$;

-- A JSON quantity (number or numeric string) -> positive integer, or NULL.
CREATE OR REPLACE FUNCTION sale_evidence.json_positive_int_v1(p jsonb)
 RETURNS integer
 LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  t text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := CASE jsonb_typeof(p) WHEN 'number' THEN p::text WHEN 'string' THEN btrim(p #>> '{}') END;
  IF t IS NULL OR t !~ '^[0-9]{1,6}$' OR t::integer < 1 THEN RETURN NULL; END IF;
  RETURN t::integer;
END
$fn$;

-- Value-level canonical form of a JSON document: every number scale-trimmed (1.50 -> 1.5), objects and arrays rebuilt (jsonb already
-- orders object keys). Two documents that jsonb equality calls equal have the same canonical text.
CREATE OR REPLACE FUNCTION sale_evidence.jsonb_value_canonical_v1(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(p)
    WHEN 'object' THEN
      RETURN COALESCE((SELECT jsonb_object_agg(e.k, sale_evidence.jsonb_value_canonical_v1(e.v)) FROM jsonb_each(p) AS e(k, v)), '{}'::jsonb);
    WHEN 'array' THEN
      RETURN COALESCE((SELECT jsonb_agg(sale_evidence.jsonb_value_canonical_v1(a.v) ORDER BY a.i) FROM jsonb_array_elements(p) WITH ORDINALITY AS a(v, i)), '[]'::jsonb);
    WHEN 'number' THEN
      RETURN to_jsonb(trim_scale(p::text::numeric));
    ELSE
      RETURN p;
  END CASE;
END
$fn$;

-- THE BASIS DIGEST (v1): sha256 over the value-level economic basis of an order, exactly the seven editor basis columns. Recomputable from
-- a live ordenes row (the future Candidate adapter compares it, inside its own snapshot, with the latest revision) and from the raw
-- values stored on every revision (verify_revision_v1).
CREATE OR REPLACE FUNCTION sale_evidence.basis_digest_v1(p_items jsonb, p_totale numeric, p_delivery_fee numeric, p_descuento_tipo text,
                                                         p_descuento_valor numeric, p_descuento_importe numeric, p_tipo_consegna text)  -- language-guard: allow-legacy existing ordenes column name
 RETURNS text
 LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
  SELECT encode(sha256(convert_to(jsonb_build_array(
           'sale_evidence.basis.v1',
           sale_evidence.jsonb_value_canonical_v1(COALESCE(NULLIF(p_items, 'null'::jsonb), '[]'::jsonb)),
           trim_scale(p_totale), trim_scale(p_delivery_fee), NULLIF(p_descuento_tipo, ''),
           trim_scale(p_descuento_valor), trim_scale(p_descuento_importe),
           NULLIF(p_tipo_consegna, ''))::text, 'UTF8')), 'hex')  -- language-guard: allow-legacy p_tipo_consegna mirrors the existing column
$fn$;

-- One item of ordenes.items (canonical snapshot v1, src/menu/menuSnapshot.js normalizeOrderItem) -> the line facts, as recorded.
-- Never looks at the menu. Never raises. parse_issues = blocking for a later fiscal use (parse_status INVALID); observations = facts
-- worth knowing that do not by themselves make the line unusable.
CREATE OR REPLACE FUNCTION sale_evidence.parse_line_v1(p_item jsonb,
  OUT snapshot_version integer, OUT legacy_id text, OUT product_id text, OUT legacy_key text, OUT official_number text,
  OUT custom boolean, OUT custom_base_id text, OUT classic_name text, OUT fantasy_name text, OUT category_label text,
  OUT quantity integer, OUT base_unit_cents bigint, OUT extras_unit_cents bigint, OUT final_unit_cents bigint, OUT line_total_cents bigint,
  OUT extras jsonb, OUT parse_status text, OUT parse_issues text[], OUT observations text[])
 LANGUAGE plpgsql IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  c record;
  m record;
  e record;
  v_q integer;
BEGIN
  parse_issues := ARRAY[]::text[];
  observations := ARRAY[]::text[];
  extras := '[]'::jsonb;
  custom := false;
  IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
    parse_issues := ARRAY['LINE_NOT_OBJECT']; parse_status := 'INVALID';
    RETURN;
  END IF;
  -- identity and description, as recorded on the item (never resolved against the menu)
  snapshot_version := CASE WHEN jsonb_typeof(p_item->'snapshotVersion') = 'number' AND (p_item->>'snapshotVersion') ~ '^[0-9]{1,6}$'
                           THEN (p_item->>'snapshotVersion')::integer END;
  IF snapshot_version IS DISTINCT FROM 1 THEN parse_issues := parse_issues || 'SNAPSHOT_VERSION_UNSUPPORTED'::text; END IF;
  legacy_id := p_item->>'legacyId';
  product_id := p_item->>'productId';
  legacy_key := p_item->>'legacyKey';
  official_number := p_item->>'officialNumber';
  custom := COALESCE(p_item->'custom' = 'true'::jsonb, false);
  custom_base_id := CASE WHEN jsonb_typeof(p_item->'customBase') = 'object' THEN p_item->'customBase'->>'id' END;
  classic_name := p_item->>'classicName';
  fantasy_name := p_item->>'fantasyName';
  category_label := p_item->>'category';
  IF legacy_id IS NULL AND product_id IS NULL AND legacy_key IS NULL AND NOT custom THEN
    observations := observations || 'NO_PRODUCT_IDENTITY'::text;
  END IF;
  -- quantity (canonical) and its legacy mirror q, which is what the Economy total is computed from
  quantity := sale_evidence.json_positive_int_v1(p_item->'quantity');
  IF quantity IS NULL THEN parse_issues := parse_issues || 'QUANTITY_INVALID'::text; END IF;
  IF p_item ? 'q' THEN
    v_q := sale_evidence.json_positive_int_v1(p_item->'q');
    IF v_q IS NULL OR v_q IS DISTINCT FROM quantity THEN parse_issues := parse_issues || 'QUANTITY_MIRROR_MISMATCH'::text; END IF;
  END IF;
  -- amounts (VAT-inclusive commercial values, integer cents)
  SELECT * INTO c FROM sale_evidence.json_cents_v1(p_item->'finalUnitPrice');
  final_unit_cents := c.cents;
  IF c.issue IS NOT NULL THEN parse_issues := parse_issues || ('FINAL_UNIT_AMOUNT_' || c.issue); END IF;
  IF p_item ? 'p' THEN
    SELECT * INTO m FROM sale_evidence.json_cents_v1(p_item->'p');
    IF m.issue IS NOT NULL OR m.cents IS DISTINCT FROM final_unit_cents THEN parse_issues := parse_issues || 'PRICE_MIRROR_MISMATCH'::text; END IF;
  END IF;
  SELECT * INTO c FROM sale_evidence.json_cents_v1(p_item->'lineTotal');
  line_total_cents := c.cents;
  IF c.issue IS NOT NULL THEN parse_issues := parse_issues || ('LINE_TOTAL_AMOUNT_' || c.issue); END IF;
  IF final_unit_cents IS NOT NULL AND quantity IS NOT NULL AND line_total_cents IS NOT NULL
     AND line_total_cents <> final_unit_cents * quantity THEN
    parse_issues := parse_issues || 'LINE_TOTAL_INCONSISTENT'::text;
  END IF;
  SELECT * INTO c FROM sale_evidence.json_cents_v1(p_item->'baseUnitPrice');
  base_unit_cents := c.cents;
  IF c.issue IS NOT NULL THEN parse_issues := parse_issues || ('BASE_UNIT_AMOUNT_' || c.issue); END IF;
  SELECT * INTO c FROM sale_evidence.json_cents_v1(p_item->'extrasUnitTotal');
  extras_unit_cents := c.cents;
  IF c.issue IS NOT NULL THEN parse_issues := parse_issues || ('EXTRAS_UNIT_AMOUNT_' || c.issue); END IF;
  IF base_unit_cents IS NOT NULL AND extras_unit_cents IS NOT NULL AND final_unit_cents IS NOT NULL
     AND base_unit_cents + extras_unit_cents <> final_unit_cents THEN
    observations := observations || 'BASE_PLUS_EXTRAS_NE_FINAL'::text;
  END IF;
  -- extras: [{index, key, name, unitCents, quantity}] (names and prices as recorded)
  IF p_item ? 'extras' AND jsonb_typeof(p_item->'extras') <> 'null' THEN
    IF jsonb_typeof(p_item->'extras') <> 'array' THEN
      parse_issues := parse_issues || 'EXTRAS_NOT_ARRAY'::text;
    ELSE
      FOR e IN SELECT x.v, x.i FROM jsonb_array_elements(p_item->'extras') WITH ORDINALITY AS x(v, i) LOOP
        IF jsonb_typeof(e.v) <> 'object' THEN
          parse_issues := parse_issues || 'EXTRA_NOT_OBJECT'::text;
          CONTINUE;
        END IF;
        SELECT * INTO c FROM sale_evidence.json_cents_v1(e.v->'price');
        IF c.issue IS NOT NULL THEN parse_issues := parse_issues || ('EXTRA_AMOUNT_' || c.issue); END IF;
        v_q := sale_evidence.json_positive_int_v1(e.v->'quantity');
        IF v_q IS NULL THEN parse_issues := parse_issues || 'EXTRA_QUANTITY_INVALID'::text; END IF;
        extras := extras || jsonb_build_array(jsonb_build_object('index', e.i, 'key', e.v->'key', 'name', e.v->'name',
                                                                 'unitCents', c.cents, 'quantity', v_q));
      END LOOP;
    END IF;
  END IF;
  -- the pre-2026 fee pseudo-line must never be read as a product line
  IF p_item->>'n' = 'Entrega a domicilio' OR classic_name = 'Entrega a domicilio' THEN
    parse_issues := parse_issues || 'LEGACY_DELIVERY_FEE_PSEUDO_LINE'::text;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), ARRAY[]::text[]) INTO parse_issues FROM unnest(parse_issues) u;
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), ARRAY[]::text[]) INTO observations FROM unnest(observations) u;
  parse_status := CASE WHEN cardinality(parse_issues) = 0 THEN 'OK' ELSE 'INVALID' END;
END
$fn$;

-- ── evidence tables (append-only) ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Attach / detach history of the capture. A revision can be written only while the last epoch is ATTACHED.
CREATE TABLE IF NOT EXISTS sale_evidence.capture_epochs (
  epoch_no      integer     NOT NULL PRIMARY KEY CHECK (epoch_no >= 1),
  event         text        NOT NULL CHECK (event IN ('ATTACHED', 'DETACHED')),
  install_mode  text        NULL CHECK (install_mode IN ('FRESH', 'REATTACH')),
  orders_marked integer     NOT NULL DEFAULT 0 CHECK (orders_marked >= 0),
  tx_started_at timestamptz NOT NULL DEFAULT now(),
  recorded_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid          bigint      NOT NULL DEFAULT txid_current(),
  note          text        NOT NULL CHECK (btrim(note) <> ''),
  CONSTRAINT capture_epochs_mode_chk CHECK ((event = 'ATTACHED') = (install_mode IS NOT NULL))
);

-- Orders whose composition history is NOT (fully) proven by this layer. A statement of absence, never evidence.
CREATE TABLE IF NOT EXISTS sale_evidence.history_gap_markers (
  order_uid        uuid        NOT NULL,
  epoch_no         integer     NOT NULL REFERENCES sale_evidence.capture_epochs (epoch_no),
  reason           text        NOT NULL CHECK (reason IN ('ORDER_PREDATES_CAPTURE', 'CREATED_WHILE_DETACHED', 'BASIS_CHANGED_WHILE_DETACHED')),
  display_order_id text        NOT NULL,
  marked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_uid, epoch_no)
);

-- One accepted commercial composition of one generic order. Immutable. id is deterministic: md5('sale_evidence.revision.v1|' || order_uid
-- || '|' || revision)::uuid, so the identity of "revision n of order X" can be recomputed and never collides.
CREATE TABLE IF NOT EXISTS sale_evidence.composition_revisions (
  id                        uuid        NOT NULL PRIMARY KEY,
  order_uid                 uuid        NOT NULL,
  revision                  integer     NOT NULL CHECK (revision >= 1),
  capture_kind              text        NOT NULL CHECK (capture_kind IN ('ORDER_CREATED', 'ACCEPTED_EDIT')),
  chain_origin              text        NOT NULL CHECK (chain_origin IN ('CAPTURED_AT_CREATION', 'CREATION_NOT_CAPTURED')),
  capture_epoch_no          integer     NOT NULL REFERENCES sale_evidence.capture_epochs (epoch_no),
  workspace_id              uuid        NOT NULL,
  sale_service_session_id   uuid        NOT NULL,
  display_order_id          text        NOT NULL,
  channel_raw               text        NULL,
  fulfilment                text        NOT NULL CHECK (fulfilment IN ('RITIRO', 'DOMICILIO', 'UNKNOWN')),  -- language-guard: allow-legacy RITIRO is the persisted ordenes value and the frozen Fiscal Candidate V1 fulfilment vocabulary
  fulfilment_raw            text        NULL,
  items_raw                 jsonb       NULL,
  line_count                integer     NOT NULL CHECK (line_count >= 0),
  lines_total_cents         bigint      NULL,
  delivery_fee_raw          numeric     NULL,
  delivery_fee_cents        bigint      NULL,
  discount_type_raw         text        NULL,
  discount_value_raw        numeric     NULL,
  discount_amount_raw       numeric     NULL,
  discount_cents            bigint      NULL,
  order_total_raw           numeric     NULL,
  order_total_cents         bigint      NULL,
  composition_net_cents     bigint      NULL,
  composition_consistent    boolean     NULL,
  obligation_id             uuid        NULL,
  obligation_revision       integer     NULL,
  obligation_source         text        NULL,
  obligation_gross_cents    bigint      NULL,
  obligation_matches_total  boolean     NULL,
  estado_at_capture         text        NULL,
  paid_evidence_at_capture  boolean     NOT NULL,
  writer_path               text        NOT NULL CHECK (writer_path IN ('ORDER_INSERT', 'ORDER_EDITOR_V1', 'OTHER_UPDATE')),
  request_role              text        NULL,
  tx_started_at             timestamptz NOT NULL DEFAULT now(),
  captured_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid                      bigint      NOT NULL DEFAULT txid_current(),
  basis_digest              text        NOT NULL CHECK (basis_digest ~ '^[0-9a-f]{64}$'),
  evidence_digest           text        NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  parse_status              text        NOT NULL CHECK (parse_status IN ('OK', 'INVALID')),
  parse_issues              text[]      NOT NULL DEFAULT ARRAY[]::text[],
  observations              text[]      NOT NULL DEFAULT ARRAY[]::text[],
  CONSTRAINT composition_revisions_order_revision_uq UNIQUE (order_uid, revision),
  CONSTRAINT composition_revisions_id_chk CHECK (id = md5('sale_evidence.revision.v1|' || order_uid::text || '|' || revision::text)::uuid),
  CONSTRAINT composition_revisions_kind_chk CHECK ((capture_kind = 'ORDER_CREATED' AND revision = 1 AND chain_origin = 'CAPTURED_AT_CREATION')
                                                   OR (capture_kind = 'ACCEPTED_EDIT' AND (revision > 1 OR chain_origin = 'CREATION_NOT_CAPTURED'))),
  CONSTRAINT composition_revisions_status_chk CHECK ((parse_status = 'OK') = (cardinality(parse_issues) = 0))
);

-- The lines of one revision. id is deterministic: md5('sale_evidence.line.v1|' || order_uid || '|' || revision || '|' || line_index)::uuid
-- -- the immutable line identity inside that evidence version (generic items carry no line id of their own; none is invented on the item).
CREATE TABLE IF NOT EXISTS sale_evidence.composition_lines (
  id                uuid    NOT NULL PRIMARY KEY,
  revision_id       uuid    NOT NULL,
  order_uid         uuid    NOT NULL,
  revision          integer NOT NULL CHECK (revision >= 1),
  line_index        integer NOT NULL CHECK (line_index >= 1),
  item_raw          jsonb   NOT NULL,
  snapshot_version  integer NULL,
  legacy_id         text    NULL,
  product_id        text    NULL,
  legacy_key        text    NULL,
  official_number   text    NULL,
  custom            boolean NOT NULL,
  custom_base_id    text    NULL,
  classic_name      text    NULL,
  fantasy_name      text    NULL,
  category_label    text    NULL,
  quantity          integer NULL,
  base_unit_cents   bigint  NULL,
  extras_unit_cents bigint  NULL,
  final_unit_cents  bigint  NULL,
  line_total_cents  bigint  NULL,
  extras            jsonb   NOT NULL DEFAULT '[]'::jsonb,
  parse_status      text    NOT NULL CHECK (parse_status IN ('OK', 'INVALID')),
  parse_issues      text[]  NOT NULL DEFAULT ARRAY[]::text[],
  observations      text[]  NOT NULL DEFAULT ARRAY[]::text[],
  CONSTRAINT composition_lines_revision_line_uq UNIQUE (revision_id, line_index),
  CONSTRAINT composition_lines_id_chk CHECK (id = md5('sale_evidence.line.v1|' || order_uid::text || '|' || revision::text || '|' || line_index::text)::uuid),
  CONSTRAINT composition_lines_revision_id_chk CHECK (revision_id = md5('sale_evidence.revision.v1|' || order_uid::text || '|' || revision::text)::uuid),
  CONSTRAINT composition_lines_status_chk CHECK ((parse_status = 'OK') = (cardinality(parse_issues) = 0)),
  -- lines are written before their revision (the revision's digest covers them): the reference is checked at COMMIT
  CONSTRAINT composition_lines_revision_fk FOREIGN KEY (revision_id) REFERENCES sale_evidence.composition_revisions (id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS composition_lines_order_uid_idx ON sale_evidence.composition_lines (order_uid, revision);
CREATE INDEX IF NOT EXISTS history_gap_markers_epoch_idx ON sale_evidence.history_gap_markers (epoch_no);

COMMENT ON TABLE sale_evidence.composition_revisions IS 'Layer 170: one immutable accepted commercial composition of a generic order (revision 1 = creation, n+1 = accepted edit). Append-only; written only by sale_evidence.capture_composition_v1. basis_digest = sale_evidence.basis_digest_v1 of the seven basis columns; evidence_digest = sale_evidence.evidence_digest_v1 of the stored revision and its lines.';
COMMENT ON TABLE sale_evidence.composition_lines IS 'Layer 170: the lines of one composition revision, parsed from the item as recorded (never from the menu). id = deterministic line identity inside that revision.';
COMMENT ON TABLE sale_evidence.capture_epochs IS 'Layer 170: attach / detach history of the capture triggers (a detach = the rollback of the layer; the evidence is retained).';
COMMENT ON TABLE sale_evidence.history_gap_markers IS 'Layer 170: orders whose composition history this layer does NOT prove (created before the capture, or touched while it was detached). A statement of absence; never evidence.';

-- The evidence digest of a stored revision (its columns + its stored lines), recomputable at any time (verify_revision_v1).
CREATE OR REPLACE FUNCTION sale_evidence.evidence_digest_v1(r sale_evidence.composition_revisions)
 RETURNS text
 LANGUAGE sql STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    'sale_evidence.revision.v1', r.id, r.order_uid, r.revision, r.capture_kind, r.chain_origin, r.capture_epoch_no,
    r.workspace_id, r.sale_service_session_id, r.display_order_id, r.channel_raw, r.fulfilment, r.fulfilment_raw,
    r.items_raw, r.line_count, r.lines_total_cents, trim_scale(r.delivery_fee_raw), r.delivery_fee_cents,
    r.discount_type_raw, trim_scale(r.discount_value_raw), trim_scale(r.discount_amount_raw), r.discount_cents,
    trim_scale(r.order_total_raw), r.order_total_cents, r.composition_net_cents, r.composition_consistent,
    r.obligation_id, r.obligation_revision, r.obligation_source, r.obligation_gross_cents, r.obligation_matches_total,
    r.estado_at_capture, r.paid_evidence_at_capture, r.writer_path, r.request_role,
    to_char(r.tx_started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(r.captured_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    r.txid, r.basis_digest, r.parse_status, to_jsonb(r.parse_issues), to_jsonb(r.observations),
    COALESCE((SELECT jsonb_agg(jsonb_build_array(l.id, l.line_index, l.item_raw, l.snapshot_version, l.legacy_id, l.product_id,
                     l.legacy_key, l.official_number, l.custom, l.custom_base_id, l.classic_name, l.fantasy_name, l.category_label,
                     l.quantity, l.base_unit_cents, l.extras_unit_cents, l.final_unit_cents, l.line_total_cents, l.extras,
                     l.parse_status, to_jsonb(l.parse_issues), to_jsonb(l.observations)) ORDER BY l.line_index)
                FROM sale_evidence.composition_lines l WHERE l.revision_id = r.id), '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
$fn$;

-- Integrity check of one stored revision: evidence digest, basis digest (from the raw values it stored), and its lines re-parsed from
-- items_raw. Read-only.
CREATE OR REPLACE FUNCTION sale_evidence.verify_revision_v1(p_revision_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  r sale_evidence.composition_revisions;
  v_lines_ok boolean;
  v_count integer;
BEGIN
  SELECT * INTO r FROM sale_evidence.composition_revisions WHERE id = p_revision_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', false); END IF;
  SELECT count(*) INTO v_count FROM sale_evidence.composition_lines WHERE revision_id = r.id;
  SELECT COALESCE(bool_and(l.id IS NOT NULL AND l.item_raw = x.v
           AND l.snapshot_version IS NOT DISTINCT FROM p.snapshot_version AND l.legacy_id IS NOT DISTINCT FROM p.legacy_id
           AND l.product_id IS NOT DISTINCT FROM p.product_id AND l.legacy_key IS NOT DISTINCT FROM p.legacy_key
           AND l.official_number IS NOT DISTINCT FROM p.official_number AND l.custom = p.custom
           AND l.custom_base_id IS NOT DISTINCT FROM p.custom_base_id AND l.classic_name IS NOT DISTINCT FROM p.classic_name
           AND l.fantasy_name IS NOT DISTINCT FROM p.fantasy_name AND l.category_label IS NOT DISTINCT FROM p.category_label
           AND l.quantity IS NOT DISTINCT FROM p.quantity AND l.base_unit_cents IS NOT DISTINCT FROM p.base_unit_cents
           AND l.extras_unit_cents IS NOT DISTINCT FROM p.extras_unit_cents AND l.final_unit_cents IS NOT DISTINCT FROM p.final_unit_cents
           AND l.line_total_cents IS NOT DISTINCT FROM p.line_total_cents AND l.extras = p.extras
           AND l.parse_status = p.parse_status AND l.parse_issues = p.parse_issues AND l.observations = p.observations), true)
    INTO v_lines_ok
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.items_raw) = 'array' THEN r.items_raw ELSE '[]'::jsonb END) WITH ORDINALITY AS x(v, i)
    CROSS JOIN LATERAL sale_evidence.parse_line_v1(x.v) p
    LEFT JOIN sale_evidence.composition_lines l ON l.revision_id = r.id AND l.line_index = x.i;
  RETURN jsonb_build_object(
    'found', true,
    'evidence_digest_ok', sale_evidence.evidence_digest_v1(r) = r.evidence_digest,
    'basis_digest_ok', sale_evidence.basis_digest_v1(r.items_raw, r.order_total_raw, r.delivery_fee_raw, r.discount_type_raw,
                                                     r.discount_value_raw, r.discount_amount_raw, r.fulfilment_raw) = r.basis_digest,
    'lines_ok', v_lines_ok AND v_count = r.line_count
                AND v_count = CASE WHEN jsonb_typeof(r.items_raw) = 'array' THEN jsonb_array_length(r.items_raw) ELSE 0 END);
END
$fn$;

-- ── guard triggers (the tables are append-only for every role, the owner included) ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sale_evidence.append_only_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
BEGIN
  RAISE EXCEPTION 'SALE_EVIDENCE_APPEND_ONLY: % on %.% is forbidden (evidence is immutable)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END
$fn$;

-- Revisions and lines are written ONLY from inside the capture trigger (trigger depth >= 2), in the capturing transaction, while attached.
CREATE OR REPLACE FUNCTION sale_evidence.capture_write_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  v_event text;
  v_epoch integer;
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DIRECT_WRITE_FORBIDDEN: %.% is written only by the capture trigger', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_TABLE_NAME = 'composition_revisions' THEN
    SELECT epoch_no, event INTO v_epoch, v_event FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1;
    IF v_event IS DISTINCT FROM 'ATTACHED' OR NEW.capture_epoch_no IS DISTINCT FROM v_epoch OR NEW.txid IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_DIRECT_WRITE_FORBIDDEN: revision outside the attached capture epoch' USING ERRCODE = 'P0001';
    END IF;
    NEW.evidence_digest := sale_evidence.evidence_digest_v1(NEW);   -- over the revision and the lines already written for it
  END IF;
  RETURN NEW;
END
$fn$;

-- Epochs alternate ATTACHED / DETACHED from 1; markers only in the transaction that records an ATTACHED epoch.
CREATE OR REPLACE FUNCTION sale_evidence.epoch_write_guard_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  v_last record;
BEGIN
  SELECT epoch_no, event, txid INTO v_last FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1;
  IF TG_TABLE_NAME = 'capture_epochs' THEN
    IF NEW.epoch_no IS DISTINCT FROM COALESCE(v_last.epoch_no, 0) + 1
       OR NEW.event = COALESCE(v_last.event, 'DETACHED')
       OR NEW.txid IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_EPOCH_SEQUENCE: epoch % % does not follow %', NEW.epoch_no, NEW.event, COALESCE(v_last.event, '<none>')
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF v_last.event IS DISTINCT FROM 'ATTACHED' OR v_last.txid IS DISTINCT FROM txid_current() OR NEW.epoch_no IS DISTINCT FROM v_last.epoch_no THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_MARKER_OUTSIDE_ATTACH: history gap markers are written only by the attach transaction'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE TRIGGER composition_revisions_append_only_v1 BEFORE UPDATE OR DELETE ON sale_evidence.composition_revisions
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER composition_revisions_no_truncate_v1 BEFORE TRUNCATE ON sale_evidence.composition_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER composition_revisions_write_guard_v1 BEFORE INSERT ON sale_evidence.composition_revisions
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.capture_write_guard_v1();
CREATE OR REPLACE TRIGGER composition_lines_append_only_v1 BEFORE UPDATE OR DELETE ON sale_evidence.composition_lines
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER composition_lines_no_truncate_v1 BEFORE TRUNCATE ON sale_evidence.composition_lines
  FOR EACH STATEMENT EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER composition_lines_write_guard_v1 BEFORE INSERT ON sale_evidence.composition_lines
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.capture_write_guard_v1();
CREATE OR REPLACE TRIGGER capture_epochs_append_only_v1 BEFORE UPDATE OR DELETE ON sale_evidence.capture_epochs
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER capture_epochs_no_truncate_v1 BEFORE TRUNCATE ON sale_evidence.capture_epochs
  FOR EACH STATEMENT EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER capture_epochs_write_guard_v1 BEFORE INSERT ON sale_evidence.capture_epochs
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.epoch_write_guard_v1();
CREATE OR REPLACE TRIGGER history_gap_markers_append_only_v1 BEFORE UPDATE OR DELETE ON sale_evidence.history_gap_markers
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER history_gap_markers_no_truncate_v1 BEFORE TRUNCATE ON sale_evidence.history_gap_markers
  FOR EACH STATEMENT EXECUTE FUNCTION sale_evidence.append_only_guard_v1();
CREATE OR REPLACE TRIGGER history_gap_markers_write_guard_v1 BEFORE INSERT ON sale_evidence.history_gap_markers
  FOR EACH ROW EXECUTE FUNCTION sale_evidence.epoch_write_guard_v1();

-- ── privileges: RLS on with no policy; service_role reads; nobody writes through a grant ───────────────────────────────────────────────
ALTER TABLE sale_evidence.capture_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_evidence.history_gap_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_evidence.composition_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_evidence.composition_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA sale_evidence FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA sale_evidence TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA sale_evidence FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA sale_evidence TO service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sale_evidence FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION sale_evidence.json_cents_v1(jsonb), sale_evidence.numeric_cents_v1(numeric), sale_evidence.json_positive_int_v1(jsonb),
  sale_evidence.jsonb_value_canonical_v1(jsonb), sale_evidence.basis_digest_v1(jsonb, numeric, numeric, text, numeric, numeric, text),
  sale_evidence.parse_line_v1(jsonb), sale_evidence.evidence_digest_v1(sale_evidence.composition_revisions),
  sale_evidence.verify_revision_v1(uuid) TO service_role;

-- ── the capture ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER (owner postgres, search_path pinned, every name qualified): the only writer of revisions and lines. Returns NULL (an
-- AFTER trigger cannot change the order row) and never updates ordenes (no recursion).
-- language-guard: allow-legacy the function reads the existing ordenes columns tipo_consegna / nota_cucina by their names
CREATE OR REPLACE FUNCTION sale_evidence.capture_composition_v1()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $fn$
DECLARE
  v_digest text;
  v_ref text;
  v_has_latest boolean;
  v_latest record;
  v_rev integer;
  v_kind text;
  v_origin text;
  v_writer text;
  v_epoch integer;
  v_epoch_event text;
  v_ent record;
  v_obl record;
  v_rev_id uuid;
  v_items jsonb;
  v_lines record;
  v_tot record;
  v_fee record;
  v_dsc record;
  v_issues text[] := ARRAY[]::text[];
  v_obs text[] := ARRAY[]::text[];
  v_fulfilment text;
  v_net bigint;
  v_paid boolean;
BEGIN
  IF NEW.table_session_id IS NOT NULL THEN RETURN NULL; END IF;       -- Mesa: table_order_lines is its evidence (the WHEN clause excludes it)
  IF NEW.order_uid IS NULL THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_ORDER_WITHOUT_IDENTITY: order % has no order_uid', NEW.id USING ERRCODE = 'P0001';
  END IF;
  -- language-guard: allow-legacy NEW.tipo_consegna is the existing ordenes column
  v_digest := sale_evidence.basis_digest_v1(NEW.items, NEW.totale, NEW.delivery_fee, NEW.descuento_tipo, NEW.descuento_valor, NEW.descuento_importe, NEW.tipo_consegna);
  SELECT r.revision, r.basis_digest, r.chain_origin INTO v_latest
    FROM sale_evidence.composition_revisions r WHERE r.order_uid = NEW.order_uid ORDER BY r.revision DESC LIMIT 1;
  v_has_latest := FOUND;
  IF TG_OP = 'INSERT' THEN
    IF v_has_latest THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_INTEGRITY: order % already has composition revisions at creation', NEW.order_uid USING ERRCODE = 'P0001';
    END IF;
    v_rev := 1; v_kind := 'ORDER_CREATED'; v_origin := 'CAPTURED_AT_CREATION'; v_writer := 'ORDER_INSERT';
  ELSE
    v_ref := CASE WHEN v_has_latest THEN v_latest.basis_digest
                  ELSE sale_evidence.basis_digest_v1(OLD.items, OLD.totale, OLD.delivery_fee, OLD.descuento_tipo, OLD.descuento_valor, OLD.descuento_importe, OLD.tipo_consegna) END;  -- language-guard: allow-legacy existing ordenes column name
    IF v_digest = v_ref THEN RETURN NULL; END IF;                         -- value-level no-op: nothing was accepted
    v_rev := CASE WHEN v_has_latest THEN v_latest.revision + 1 ELSE 1 END;
    v_kind := 'ACCEPTED_EDIT';
    v_origin := CASE WHEN v_has_latest THEN v_latest.chain_origin ELSE 'CREATION_NOT_CAPTURED' END;
    v_writer := CASE WHEN current_query() ~ 'order_apply_editor_patch_v1' THEN 'ORDER_EDITOR_V1' ELSE 'OTHER_UPDATE' END;
  END IF;

  SELECT e.epoch_no, e.event INTO v_epoch, v_epoch_event FROM sale_evidence.capture_epochs e ORDER BY e.epoch_no DESC LIMIT 1;
  IF v_epoch_event IS DISTINCT FROM 'ATTACHED' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_INTEGRITY: capture fired while the last epoch is %', COALESCE(v_epoch_event, '<none>') USING ERRCODE = 'P0001';
  END IF;
  SELECT oe.workspace_id, oe.service_session_id INTO v_ent FROM public.order_entities oe WHERE oe.order_uid = NEW.order_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_INTEGRITY: no order entity for %', NEW.order_uid USING ERRCODE = 'P0001';
  END IF;
  -- the canonical obligation state visible in this transaction (the obligation triggers of this same statement have already run)
  SELECT ob.id, ob.revision, ob.source, ob.gross_amount INTO v_obl
    FROM public.order_obligations ob WHERE ob.order_uid = NEW.order_uid ORDER BY ob.revision DESC LIMIT 1;
  -- the N-5 paid-guard predicate, informational (money evidenced for this order in its service)
  v_paid := NEW.ya_pagado IS TRUE OR NEW.cobrado IS TRUE
    OR EXISTS (SELECT 1 FROM public.order_financial_events fe WHERE fe.order_id = NEW.id
                 AND (NEW.service_session_id IS NULL OR fe.service_session_id IS NULL OR fe.service_session_id = NEW.service_session_id))
    OR EXISTS (SELECT 1 FROM public.payment_allocations pa JOIN public.payment_transactions pt ON pt.id = pa.payment_transaction_id
                WHERE pa.order_id = NEW.id
                  AND (NEW.service_session_id IS NULL OR pt.service_session_id IS NULL OR pt.service_session_id = NEW.service_session_id));

  v_rev_id := md5('sale_evidence.revision.v1|' || NEW.order_uid::text || '|' || v_rev::text)::uuid;
  v_items := NEW.items;
  IF v_items IS NULL OR jsonb_typeof(v_items) = 'null' THEN
    v_obs := v_obs || 'ITEMS_NULL_TREATED_AS_EMPTY'::text;
  ELSIF jsonb_typeof(v_items) <> 'array' THEN
    v_issues := v_issues || 'ITEMS_NOT_ARRAY'::text;
  END IF;

  -- the lines first (their revision's digest covers them; the reference to the revision is checked at COMMIT)
  INSERT INTO sale_evidence.composition_lines (id, revision_id, order_uid, revision, line_index, item_raw, snapshot_version, legacy_id,
      product_id, legacy_key, official_number, custom, custom_base_id, classic_name, fantasy_name, category_label, quantity,
      base_unit_cents, extras_unit_cents, final_unit_cents, line_total_cents, extras, parse_status, parse_issues, observations)
  SELECT md5('sale_evidence.line.v1|' || NEW.order_uid::text || '|' || v_rev::text || '|' || x.i::text)::uuid, v_rev_id, NEW.order_uid, v_rev,
         x.i, x.v, p.snapshot_version, p.legacy_id, p.product_id, p.legacy_key, p.official_number, p.custom, p.custom_base_id,
         p.classic_name, p.fantasy_name, p.category_label, p.quantity, p.base_unit_cents, p.extras_unit_cents, p.final_unit_cents,
         p.line_total_cents, p.extras, p.parse_status, p.parse_issues, p.observations
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_items) = 'array' THEN v_items ELSE '[]'::jsonb END) WITH ORDINALITY AS x(v, i)
    CROSS JOIN LATERAL sale_evidence.parse_line_v1(x.v) p;
  SELECT count(*)::integer AS n, bool_or(l.parse_status = 'INVALID') AS any_invalid,
         CASE WHEN bool_and(l.line_total_cents IS NOT NULL) OR count(*) = 0 THEN COALESCE(sum(l.line_total_cents), 0)::bigint END AS total
    INTO v_lines FROM sale_evidence.composition_lines l WHERE l.revision_id = v_rev_id;
  IF v_lines.any_invalid THEN v_issues := v_issues || 'LINE_INVALID'::text; END IF;

  -- order-level facts, as stored on the order row
  SELECT * INTO v_tot FROM sale_evidence.numeric_cents_v1(NEW.totale);
  IF v_tot.issue IS NOT NULL THEN v_issues := v_issues || ('ORDER_TOTAL_AMOUNT_' || v_tot.issue); END IF;
  SELECT * INTO v_fee FROM sale_evidence.numeric_cents_v1(NEW.delivery_fee);
  IF v_fee.issue IS NOT NULL THEN v_issues := v_issues || ('DELIVERY_FEE_AMOUNT_' || v_fee.issue); END IF;
  IF NEW.descuento_importe IS NULL THEN
    SELECT 0::bigint AS cents, NULL::text AS issue INTO v_dsc;
  ELSE
    SELECT * INTO v_dsc FROM sale_evidence.numeric_cents_v1(NEW.descuento_importe);
    IF v_dsc.issue IS NOT NULL THEN v_issues := v_issues || ('DISCOUNT_AMOUNT_' || v_dsc.issue); END IF;
  END IF;
  IF (NULLIF(NEW.descuento_tipo, '') IS NULL) <> (NEW.descuento_importe IS NULL OR NEW.descuento_importe = 0) THEN
    v_obs := v_obs || 'DISCOUNT_FACTS_INCOMPLETE'::text;
  END IF;
  -- language-guard: allow-legacy RITIRO / tipo_consegna are the persisted ordenes vocabulary and the frozen Candidate V1 fulfilment values
  v_fulfilment := CASE NEW.tipo_consegna WHEN 'RITIRO' THEN 'RITIRO' WHEN 'DOMICILIO' THEN 'DOMICILIO' ELSE 'UNKNOWN' END;
  IF v_fulfilment = 'UNKNOWN' THEN v_issues := v_issues || 'FULFILMENT_UNKNOWN'::text; END IF;
  -- language-guard: allow-legacy RITIRO is the persisted ordenes.tipo_consegna value
  IF v_fulfilment = 'RITIRO' AND COALESCE(v_fee.cents, 0) <> 0 THEN v_obs := v_obs || 'DELIVERY_FEE_ON_PICKUP'::text; END IF;
  v_net := CASE WHEN v_lines.total IS NOT NULL AND v_fee.cents IS NOT NULL AND v_dsc.cents IS NOT NULL
                THEN v_lines.total + v_fee.cents - v_dsc.cents END;
  IF v_net IS NOT NULL AND v_tot.cents IS NOT NULL AND v_net <> v_tot.cents THEN
    v_issues := v_issues || 'COMPOSITION_TOTAL_MISMATCH'::text;
  END IF;
  IF v_obl.id IS NULL THEN
    v_obs := v_obs || 'NO_OBLIGATION_AT_CAPTURE'::text;
  ELSIF round(v_obl.gross_amount * 100) IS DISTINCT FROM v_tot.cents THEN
    v_obs := v_obs || 'OBLIGATION_NE_ORDER_TOTAL'::text;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), ARRAY[]::text[]) INTO v_issues FROM unnest(v_issues) u;
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), ARRAY[]::text[]) INTO v_obs FROM unnest(v_obs) u;

  INSERT INTO sale_evidence.composition_revisions (id, order_uid, revision, capture_kind, chain_origin, capture_epoch_no, workspace_id,
      sale_service_session_id, display_order_id, channel_raw, fulfilment, fulfilment_raw, items_raw, line_count, lines_total_cents,
      delivery_fee_raw, delivery_fee_cents, discount_type_raw, discount_value_raw, discount_amount_raw, discount_cents,
      order_total_raw, order_total_cents, composition_net_cents, composition_consistent,
      obligation_id, obligation_revision, obligation_source, obligation_gross_cents, obligation_matches_total,
      estado_at_capture, paid_evidence_at_capture, writer_path, request_role, basis_digest, evidence_digest,
      parse_status, parse_issues, observations)
  VALUES (v_rev_id, NEW.order_uid, v_rev, v_kind, v_origin, v_epoch, v_ent.workspace_id,
      v_ent.service_session_id, NEW.id, NEW.canal, v_fulfilment, NEW.tipo_consegna, NEW.items, v_lines.n, v_lines.total,  -- language-guard: allow-legacy existing ordenes column
      NEW.delivery_fee, v_fee.cents, NEW.descuento_tipo, NEW.descuento_valor, NEW.descuento_importe, CASE WHEN NEW.descuento_importe IS NULL THEN NULL ELSE v_dsc.cents END,
      NEW.totale, v_tot.cents, v_net, CASE WHEN v_net IS NULL OR v_tot.cents IS NULL THEN NULL ELSE v_net = v_tot.cents END,
      v_obl.id, v_obl.revision, v_obl.source, CASE WHEN v_obl.id IS NULL THEN NULL ELSE round(v_obl.gross_amount * 100)::bigint END,
      CASE WHEN v_obl.id IS NULL OR v_tot.cents IS NULL THEN NULL ELSE round(v_obl.gross_amount * 100) = v_tot.cents END,
      NEW.estado, v_paid, v_writer, NULLIF(current_setting('role', true), 'none'), v_digest, repeat('0', 64),
      CASE WHEN cardinality(v_issues) = 0 THEN 'OK' ELSE 'INVALID' END, v_issues, v_obs);
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION sale_evidence.capture_composition_v1() FROM PUBLIC, anon, authenticated, service_role;

-- ── the epoch and the history markers of this attach (no evidence is fabricated for any existing order) ───────────────────────────────
CREATE TEMP TABLE sale_evidence_layer170_marks ON COMMIT DROP AS
SELECT o.order_uid, o.id AS display_order_id,
       CASE WHEN lr.basis_digest IS NOT NULL THEN 'BASIS_CHANGED_WHILE_DETACHED'
            WHEN current_setting('sale_evidence.install_mode') = 'FRESH' THEN 'ORDER_PREDATES_CAPTURE'
            ELSE 'CREATED_WHILE_DETACHED' END AS reason
  FROM public.ordenes o
  LEFT JOIN LATERAL (SELECT r.basis_digest FROM sale_evidence.composition_revisions r
                      WHERE r.order_uid = o.order_uid ORDER BY r.revision DESC LIMIT 1) lr ON true
 WHERE o.table_session_id IS NULL AND o.order_uid IS NOT NULL
   AND ((lr.basis_digest IS NULL AND NOT EXISTS (SELECT 1 FROM sale_evidence.history_gap_markers m WHERE m.order_uid = o.order_uid))
     -- language-guard: allow-legacy o.tipo_consegna is the existing ordenes column
     OR (lr.basis_digest IS NOT NULL AND lr.basis_digest <> sale_evidence.basis_digest_v1(o.items, o.totale, o.delivery_fee, o.descuento_tipo, o.descuento_valor, o.descuento_importe, o.tipo_consegna)));

INSERT INTO sale_evidence.capture_epochs (epoch_no, event, install_mode, orders_marked, note)
SELECT COALESCE((SELECT max(epoch_no) FROM sale_evidence.capture_epochs), 0) + 1, 'ATTACHED', current_setting('sale_evidence.install_mode'),
       (SELECT count(*) FROM pg_temp.sale_evidence_layer170_marks),
       'layer 170 attached by migrations/post_freeze/2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.sql';

INSERT INTO sale_evidence.history_gap_markers (order_uid, epoch_no, reason, display_order_id)
SELECT m.order_uid, (SELECT max(epoch_no) FROM sale_evidence.capture_epochs), m.reason, m.display_order_id
  FROM pg_temp.sale_evidence_layer170_marks m ORDER BY m.order_uid;

-- ── the two capture triggers (the only objects outside schema sale_evidence) ───────────────────────────────────────────────────────────
CREATE TRIGGER ordenes_zzz_sale_evidence_capture_ins_v1
  AFTER INSERT ON public.ordenes
  FOR EACH ROW WHEN (NEW.table_session_id IS NULL)
  EXECUTE FUNCTION sale_evidence.capture_composition_v1();

CREATE TRIGGER ordenes_zzz_sale_evidence_capture_upd_v1
  AFTER UPDATE OF items, totale, delivery_fee, descuento_tipo, descuento_valor, descuento_importe, tipo_consegna ON public.ordenes  -- language-guard: allow-legacy existing ordenes column name
  FOR EACH ROW WHEN (NEW.table_session_id IS NULL AND (
       OLD.items IS DISTINCT FROM NEW.items OR OLD.totale IS DISTINCT FROM NEW.totale
    OR OLD.delivery_fee IS DISTINCT FROM NEW.delivery_fee OR OLD.descuento_tipo IS DISTINCT FROM NEW.descuento_tipo
    OR OLD.descuento_valor IS DISTINCT FROM NEW.descuento_valor OR OLD.descuento_importe IS DISTINCT FROM NEW.descuento_importe
    OR OLD.tipo_consegna IS DISTINCT FROM NEW.tipo_consegna))  -- language-guard: allow-legacy existing ordenes column
  EXECUTE FUNCTION sale_evidence.capture_composition_v1();

-- ── post-conditions (inside the same transaction) ──────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_fn oid := to_regprocedure('sale_evidence.capture_composition_v1()');
  v_bad text;
  v_rel text;
BEGIN
  IF v_fn IS NULL OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn)
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = v_fn)) <> 'postgres' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: the capture must be SECURITY DEFINER, owned by postgres, search_path pinned';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: nobody may call the capture function directly';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgfoid = v_fn) <> 2
     OR (SELECT count(*) FROM pg_trigger t WHERE t.tgfoid = v_fn) <> 2 THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: exactly the two capture triggers on public.ordenes';
  END IF;
  -- still the LAST AFTER INSERT / AFTER UPDATE row triggers of ordenes
  IF (SELECT max(t.tgname COLLATE "C") FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
        AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 4) = 4) <> 'ordenes_zzz_sale_evidence_capture_ins_v1'
     OR (SELECT max(t.tgname COLLATE "C") FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
        AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 0 AND (t.tgtype & 16) = 16) <> 'ordenes_zzz_sale_evidence_capture_upd_v1' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: the capture triggers must fire after every other AFTER trigger of ordenes';
  END IF;
  FOREACH v_rel IN ARRAY ARRAY['sale_evidence.capture_epochs', 'sale_evidence.history_gap_markers', 'sale_evidence.composition_revisions', 'sale_evidence.composition_lines'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_rel::regclass)
       OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'sale_evidence')
       OR has_table_privilege('anon', v_rel, 'SELECT') OR has_table_privilege('authenticated', v_rel, 'SELECT')
       OR NOT has_table_privilege('service_role', v_rel, 'SELECT')
       OR has_table_privilege('service_role', v_rel, 'INSERT') OR has_table_privilege('service_role', v_rel, 'UPDATE')
       OR has_table_privilege('service_role', v_rel, 'DELETE') OR has_table_privilege('service_role', v_rel, 'TRUNCATE')
       OR has_table_privilege('anon', v_rel, 'INSERT') OR has_table_privilege('authenticated', v_rel, 'INSERT') THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: privileges of % (RLS on, no policy, service_role SELECT only)', v_rel;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication_rel pr WHERE pr.prrelid = v_rel::regclass) THEN
      RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: % must not be published (realtime)', v_rel;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE puballtables) THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: a FOR ALL TABLES publication would expose the evidence';
  END IF;
  IF has_schema_privilege('anon', 'sale_evidence', 'USAGE') OR has_schema_privilege('authenticated', 'sale_evidence', 'USAGE') THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: schema sale_evidence must not be usable by anon / authenticated';
  END IF;
  -- the Economy bodies are untouched by this transaction
  SELECT string_agg(x.sig, ', ') INTO v_bad
    FROM (VALUES
      ('public.order_entity_anchor_v1()', '3db9189218204ad2488cff64fd55eb9c'),
      ('public.order_obligation_anchor_v1()', '97bf65b4e31d63a81c4d6d234a45b898'),
      ('public.order_obligation_revision_v1()', 'bfac4ec3f428daa91d5d9505d8b1285a'),
      ('public.order_apply_editor_patch_v1(text,jsonb,jsonb)', 'd5f962866a565fe63eb0842124829cfe'),
      ('public.paid_order_economic_mutation_guard_v1()', 'fcbc86950c285232aaee2b47f20c9ba7'),
      ('public.order_economic_basis_lock_v1()', '2a72a4b53666d539960917685eb90fed'),
      ('public.order_initial_payment_v1()', 'e397b66e3aabe66a123a5356c825f124')) x(sig, want)
   WHERE (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(x.sig)) IS DISTINCT FROM x.want;
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: Economy body changed (%)', v_bad; END IF;
  -- exactly one new ATTACHED epoch, recorded by this transaction; no revision of any existing order was fabricated
  IF (SELECT event FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1) <> 'ATTACHED'
     OR (SELECT txid FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1) <> txid_current()
     OR EXISTS (SELECT 1 FROM sale_evidence.composition_revisions r WHERE r.txid = txid_current()) THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_LAYER post-condition: attach epoch / no-backfill';
  END IF;
END $post$;

COMMIT;
