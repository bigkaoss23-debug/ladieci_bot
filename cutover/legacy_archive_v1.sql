-- cutover/legacy_archive_v1.sql
-- LEGACY_ARCHIVE + COMMERCIAL_HISTORY -- the two NON-V3 domains of the legacy -> V3 cutover (docs/LEGACY_IMPORT_CONTRACT.md).
-- NOT part of the Economy chain and NOT part of the V3 schema baseline: applied once, by the cutover operator, on the new V3 production
-- database AFTER scripts/economyChainApply.js install-greenfield and scripts/v3BusinessBootstrap.js, BEFORE the first V3 order.
--
-- Guarantees (by construction, tested by scripts/cutover/legacyImport.js verify-inert and the cutover dry-run):
--   * economically and fiscally INERT: no column, key or foreign key refers to any V3 table (ordenes, order_*, payment_*, service_*,
--     cash_counts, storico); no trigger on any V3 table; no V3 function reads these schemas (static test legacyImportInertness);
--   * append-only: UPDATE / DELETE / TRUNCATE refused by trigger (the importer only INSERTs);
--   * not exposed: no USAGE on either schema for anon / authenticated / service_role, nothing granted to them; neither schema is in the
--     PostgREST db-schemas list. Reads are operator / admin-report reads over a direct connection (future admin surface: a dedicated,
--     read-only, service-role endpoint, labelled HISTORICAL · LEGACY · PRE-CUTOVER, never summed with V3 figures);
--   * legacy money is DECLARED, never collected: amounts are informational (`declared_*`, `informational_total`); no payment status
--     column exists in commercial_history.
BEGIN;
SET LOCAL search_path = pg_catalog;

DO $guard$ BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'LEGACY_ARCHIVE refused: apply as role postgres'; END IF;
  IF to_regclass('public.ladieci_schema_migrations') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.ladieci_schema_migrations WHERE apply_order = 156) THEN
    RAISE EXCEPTION 'LEGACY_ARCHIVE refused: the V3 database must be at POST_APPLY (Economy 156) first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('legacy_archive', 'commercial_history')) THEN
    RAISE EXCEPTION 'LEGACY_ARCHIVE refused: the archive schemas already exist';
  END IF;
END $guard$;

CREATE SCHEMA legacy_archive;
CREATE SCHEMA commercial_history;
COMMENT ON SCHEMA legacy_archive IS 'LEGACY_ARCHIVE: immutable copy of the legacy (pre-V3) database at CUTOVER_AT. Read-only history. Never economic or fiscal authority; never read by a V3 economic surface.';
COMMENT ON SCHEMA commercial_history IS 'COMMERCIAL_HISTORY: customer-facing commercial facts derived from the legacy archive (what a customer ordered, when). No money authority, no payment status, no V3 key.';

-- ── LEGACY_ARCHIVE ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Every legacy row as it was read, versioned by content: a row changed between the initial import and the final delta is archived twice.
CREATE TABLE legacy_archive.source_rows (
  source_table text NOT NULL,
  legacy_key   text NOT NULL,
  row_sha256   text NOT NULL CHECK (row_sha256 ~ '^[0-9a-f]{64}$'),
  row_data     jsonb NOT NULL,
  batch_id     uuid NOT NULL,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, legacy_key, row_sha256)
);
CREATE INDEX source_rows_batch_idx ON legacy_archive.source_rows (batch_id);

-- One row per import batch (initial import, final delta): counts and content hashes of what was read.
CREATE TABLE legacy_archive.import_batches (
  batch_id        uuid PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('initial', 'delta', 'final_delta')),
  legacy_source   text NOT NULL,
  read_started_at timestamptz NOT NULL,
  read_ended_at   timestamptz NOT NULL,
  table_counts    jsonb NOT NULL,
  table_sha256    jsonb NOT NULL,
  secrets_redacted jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The admin historical view: one row per legacy business date, computed once from the archive (declared amounts, not accounting).
CREATE TABLE legacy_archive.admin_daily_snapshot (
  business_date          date PRIMARY KEY,
  orders                 integer NOT NULL,
  declared_total         numeric(12,2) NOT NULL,
  declared_by_method     jsonb NOT NULL,
  delivery_orders        integer NOT NULL,
  pickup_orders          integer NOT NULL,
  declared_delivery_fees numeric(12,2) NOT NULL,
  serata_summary_cassa_totale numeric(12,2),
  coherence              text NOT NULL CHECK (coherence IN ('EQUAL', 'DIFFERENT', 'STORICO_ONLY', 'SUMMARY_ONLY')),
  label                  text NOT NULL DEFAULT 'HISTORICAL · LEGACY · PRE-CUTOVER — declared amounts, not accounting' ,
  computed_from_batch    uuid NOT NULL REFERENCES legacy_archive.import_batches (batch_id)
);

-- CUTOVER_AT: one immutable row, written when the final delta is imported (the boundary between the two worlds).
CREATE TABLE legacy_archive.cutover_manifest (
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cutover_at         timestamptz NOT NULL,
  legacy_last_fecha  date NOT NULL,
  final_batch_id     uuid NOT NULL REFERENCES legacy_archive.import_batches (batch_id),
  legacy_system      text NOT NULL,
  v3_candidate       text NOT NULL,
  archive_sha256     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── COMMERCIAL_HISTORY ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- What each customer ordered in the legacy era. NO payment status, NO service, NO order_uid, NO FK to ordenes / storico.
CREATE TABLE commercial_history.customer_orders (
  legacy_storico_id   bigint PRIMARY KEY,
  business_date       date,
  customer_key        text,                     -- E.164 phone, or NULL when the legacy row had none
  items               jsonb NOT NULL DEFAULT '[]'::jsonb,
  channel             text,
  tipo_consegna       text,
  zona                text,
  informational_total numeric(12,2),            -- as declared by the legacy system; NEVER an obligation or a receipt
  source_row_sha256   text NOT NULL,
  batch_id            uuid NOT NULL
);
CREATE INDEX customer_orders_customer_idx ON commercial_history.customer_orders (customer_key, business_date);

CREATE TABLE commercial_history.customer_stats (      -- a full, regenerable snapshot per batch; readers take the latest batch
  customer_key     text NOT NULL,
  orders_count     integer NOT NULL,
  first_order_date date,
  last_order_date  date,
  delivery_share   numeric(5,4),
  top_items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  batch_id         uuid NOT NULL,
  PRIMARY KEY (batch_id, customer_key)
);

-- Provenance of every V3 row the commercial import wrote (public.clientes / public.geo_cache): lineage lives HERE, never in V3 tables.
CREATE TABLE commercial_history.import_lineage (
  batch_id        uuid NOT NULL,
  source_table    text NOT NULL,
  legacy_key      text NOT NULL,
  source_sha256   text NOT NULL,
  target_table    text NOT NULL CHECK (target_table IN ('public.clientes', 'public.geo_cache')),
  target_key      text NOT NULL,
  target_sha256   text NOT NULL,              -- fingerprint of the V3 row as the import left it (a later V3 edit changes it: V3 wins)
  outcome         text NOT NULL CHECK (outcome IN ('INSERTED', 'UPDATED', 'SKIPPED_V3_WINS', 'SKIPPED_INVALID', 'SKIPPED_DUPLICATE')),
  detail          text,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, source_table, legacy_key)
);

-- ── append-only + not exposed ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION legacy_archive.append_only_v1() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $f$
BEGIN
  RAISE EXCEPTION 'LEGACY_ARCHIVE_APPEND_ONLY: % on %.% refused (the legacy archive and the commercial history are immutable)', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = '0A000';
END $f$;
DO $t$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('legacy_archive', 'commercial_history') AND c.relkind = 'r' LOOP
    -- statement level: refused even when the statement would touch zero rows
    EXECUTE format('CREATE TRIGGER zz_append_only_v1 BEFORE UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION legacy_archive.append_only_v1()', r.nspname, r.relname);
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated, service_role', r.nspname, r.relname);
  END LOOP;
END $t$;
REVOKE ALL ON SCHEMA legacy_archive, commercial_history FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION legacy_archive.append_only_v1() FROM PUBLIC, anon, authenticated, service_role;

-- post-conditions: no reference into V3, nothing granted to API roles
DO $post$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint co JOIN pg_namespace n ON n.oid = co.connamespace
              WHERE n.nspname IN ('legacy_archive', 'commercial_history') AND co.contype = 'f'
                AND co.confrelid::regclass::text NOT LIKE 'legacy_archive.%') THEN
    RAISE EXCEPTION 'LEGACY_ARCHIVE post-condition: a foreign key leaves the archive domains';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE table_schema IN ('legacy_archive', 'commercial_history')
              AND grantee IN ('anon', 'authenticated', 'service_role', 'PUBLIC')) THEN
    RAISE EXCEPTION 'LEGACY_ARCHIVE post-condition: an API role holds a privilege';
  END IF;
END $post$;
COMMIT;
