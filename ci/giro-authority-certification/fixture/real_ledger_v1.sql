-- EPHEMERAL FIXTURE -- the REAL economic ledger for the payment-truth proofs (DELIVERY_ECONOMY_DECOUPLING_V1).
-- Never applied anywhere but a throwaway PostgreSQL 17 database. It REPLACES the W3 economic stubs
-- (order_obligations / order_financial_events / payment_transactions and the stub _ledger_write_payment)
-- with the live shapes, so that "the payment is recorded once", "attributed to the original service" and
-- "no second payment" are proven against the real constraints, indexes, triggers and writer bodies.
--
-- Provenance: read from the staging catalog on 2026-09-19 (project tdikhfeinufaahagmpjz), SELECT-only:
--   * table columns, CHECK / FOREIGN KEY / UNIQUE constraints and indexes of order_financial_events,
--     order_obligations, payment_transactions, payment_allocations;
--   * the bodies of the nine helper/trigger functions below, verified by md5(prosrc) in realLedger.js
--     against the live values (a mismatch fails the run);
--   * _ledger_write_payment / order_post_payment_v1 / classify_economic_period_v1 are NOT written here: realLedger.js
--     extracts them verbatim from migrations/ (their md5 equals staging live as well);
--   * (2026-09-20, B2) the live COMMENTs of payment_transactions (table + the two scope columns; there is NO comment on any
--     of its constraints) and the exact pg_get_constraintdef of payment_transactions_scope_chk, so that migration 139's
--     drift guards ("the constraint / comments to replace are exactly staging's") and its rollback fingerprint are proven
--     against a state that is identical to staging's, not to a simplification.
-- Deliberate simplifications (documented, not product code): workspaces / auth_actors / table_sessions keep the
-- fixture shapes; table_order_lines is a bare FK target (the Mesa branch of the writers is out of scope here);
-- RLS is not modeled on these tables (every connection in the harness is service_role or the superuser).

SET ROLE postgres;

DROP FUNCTION IF EXISTS public._ledger_write_payment(text, text, numeric, text, text, text, jsonb, text);
DROP TABLE IF EXISTS public.payment_allocations CASCADE;
DROP TABLE IF EXISTS public.payment_transactions CASCADE;
DROP TABLE IF EXISTS public.order_financial_events CASCADE;
DROP TABLE IF EXISTS public.order_obligations CASCADE;
DROP TABLE IF EXISTS public.fixture_ledger_control CASCADE;

ALTER TABLE public.auth_actors DROP CONSTRAINT IF EXISTS auth_actors_workspace_actor_uq;
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_workspace_actor_uq UNIQUE (workspace_id, actor);

CREATE TABLE IF NOT EXISTS public.table_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_session_id   uuid,
  service_session_id uuid,
  order_id           text
);

-- ── order_obligations ────────────────────────────────────────────────────────────────────────
CREATE TABLE public.order_obligations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_uid            uuid        NOT NULL,
  order_id             text        NOT NULL,
  service_session_id   uuid        NOT NULL,
  workspace_id         uuid        NOT NULL,
  revision             integer     NOT NULL,
  gross_amount         numeric     NOT NULL,
  channel              text,
  source               text        NOT NULL,
  economic_period_kind text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  cause                text,
  reason               text,
  by_actor             text,
  by_role              text,
  client_request_id    text,
  request_hash         text,
  materialized_lazily  boolean     NOT NULL DEFAULT false,
  CONSTRAINT order_obligations_order_uid_fkey FOREIGN KEY (order_uid) REFERENCES public.order_entities(order_uid) ON DELETE RESTRICT,
  CONSTRAINT order_obligations_service_session_id_fkey FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT order_obligations_gross_chk CHECK (gross_amount >= 0),
  CONSTRAINT order_obligations_revision_chk CHECK (revision >= 1),
  CONSTRAINT order_obligations_source_chk CHECK (source = ANY (ARRAY['order_create_v1','order_total_revision_v1','order_commercial_adjustment_v1'])),
  CONSTRAINT order_obligations_create_rev_chk CHECK ((source = 'order_create_v1') = (revision = 1)),
  CONSTRAINT order_obligations_cause_presence_chk CHECK ((cause IS NOT NULL) = (source = 'order_commercial_adjustment_v1')),
  CONSTRAINT order_obligations_econ_period_chk CHECK (economic_period_kind IS NULL OR economic_period_kind = ANY (ARRAY['PRANZO','SERA'])),  -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values reproduced verbatim from the staging catalog, not new vocabulary
  CONSTRAINT order_obligations_uid_revision_uq UNIQUE (order_uid, revision)
);
CREATE INDEX order_obligations_order_rev_idx ON public.order_obligations (order_id, service_session_id, revision DESC);
CREATE INDEX order_obligations_session_idx ON public.order_obligations (service_session_id);
CREATE INDEX order_obligations_uid_rev_idx ON public.order_obligations (order_uid, revision DESC);

-- ── payment_transactions ─────────────────────────────────────────────────────────────────────
CREATE TABLE public.payment_transactions (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid        NOT NULL,
  table_session_id        uuid,
  service_session_id      uuid,
  kind                    text        NOT NULL DEFAULT 'payment',
  mode                    text        NOT NULL,
  amount                  numeric     NOT NULL,
  payment_method          text        NOT NULL,
  covers_settled          integer     NOT NULL DEFAULT 0,
  reverses_transaction_id uuid,
  by_actor                text        NOT NULL,
  by_role                 text        NOT NULL,
  by_sid_hash             text        NOT NULL,
  client_request_id       text        NOT NULL,
  request_hash            text        NOT NULL,
  meta                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  economic_period_kind    text,
  CONSTRAINT payment_transactions_actor_fkey FOREIGN KEY (workspace_id, by_actor) REFERENCES public.auth_actors(workspace_id, actor),
  CONSTRAINT payment_transactions_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id),
  CONSTRAINT payment_transactions_service_session_id_fkey FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_table_session_id_fkey FOREIGN KEY (table_session_id) REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_reverses_transaction_id_fkey FOREIGN KEY (reverses_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_amount_check CHECK (amount > 0),
  CONSTRAINT payment_transactions_by_role_check CHECK (by_role = ANY (ARRAY['admin','operator','owner','cashier','legacy_operator'])),
  CONSTRAINT payment_transactions_by_sid_hash_check CHECK (by_sid_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_transactions_client_request_id_check CHECK (length(client_request_id) >= 8 AND length(client_request_id) <= 128 AND client_request_id ~ '^[A-Za-z0-9_-]+$'),
  CONSTRAINT payment_transactions_covers_settled_check CHECK (covers_settled >= 0 AND covers_settled <= 99),
  CONSTRAINT payment_transactions_economic_period_kind_chk CHECK (economic_period_kind IS NULL OR economic_period_kind = ANY (ARRAY['PRANZO','SERA'])),  -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values reproduced verbatim from the staging catalog, not new vocabulary
  CONSTRAINT payment_transactions_idempotency_uq UNIQUE (workspace_id, client_request_id),
  CONSTRAINT payment_transactions_kind_check CHECK (kind = ANY (ARRAY['payment','refund'])),
  CONSTRAINT payment_transactions_kind_mode_chk CHECK ((kind = 'payment' AND mode <> 'refund' AND reverses_transaction_id IS NULL) OR (kind = 'refund' AND mode = 'refund' AND reverses_transaction_id IS NOT NULL)),
  CONSTRAINT payment_transactions_meta_check CHECK (jsonb_typeof(meta) = 'object' AND length(meta::text) <= 2048),
  CONSTRAINT payment_transactions_mode_check CHECK (mode = ANY (ARRAY['full','equal_split','item_selection','custom_amount','refund'])),
  CONSTRAINT payment_transactions_payment_method_check CHECK (payment_method = ANY (ARRAY['efectivo','tarjeta','bizum'])),
  CONSTRAINT payment_transactions_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT payment_transactions_scope_chk CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL)
);
CREATE INDEX payment_transactions_service_method_idx ON public.payment_transactions (service_session_id, payment_method, created_at);
CREATE INDEX payment_transactions_table_idx ON public.payment_transactions (table_session_id, created_at);
-- Live comments (staging catalog, SELECT-only, 2026-09-20). Verbatim: the texts are the S2 / migration-122 ones.
COMMENT ON TABLE public.payment_transactions IS
  'Append-only money movements. One method per transaction; mixed-method table totals are the sum of transactions.';
COMMENT ON COLUMN public.payment_transactions.service_session_id IS
  'RECEIPT SERVICE: the service session open at the moment the money was received. NULL = off-service receipt (no session open). NEVER the table''s origin service. Physical rename to receipt_service_session_id lands in S14.';
COMMENT ON COLUMN public.payment_transactions.table_session_id IS
  'CHECK-CENTRIC UNIVERSAL CASH V1 (migration 122). Nullable: NULL for a check-centric (non-table) payment/refund. See payment_transactions_scope_chk -- a transaction always carries at least one scope (table_session_id for Mesa, service_session_id for check-centric).';

-- ── payment_allocations ──────────────────────────────────────────────────────────────────────
CREATE TABLE public.payment_allocations (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_transaction_id uuid        NOT NULL,
  table_order_line_id    uuid,
  order_id               text        NOT NULL,
  amount                 numeric     NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  order_uid              uuid,
  CONSTRAINT payment_allocations_amount_check CHECK (amount > 0),
  CONSTRAINT payment_allocations_order_uid_fkey FOREIGN KEY (order_uid) REFERENCES public.order_entities(order_uid),
  CONSTRAINT payment_allocations_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_table_order_line_id_fkey FOREIGN KEY (table_order_line_id) REFERENCES public.table_order_lines(id) ON DELETE RESTRICT,
  CONSTRAINT payment_allocations_target_chk CHECK (table_order_line_id IS NOT NULL OR order_uid IS NOT NULL),
  CONSTRAINT payment_allocations_transaction_line_uq UNIQUE (payment_transaction_id, table_order_line_id)
);
CREATE UNIQUE INDEX payment_allocations_transaction_order_uq ON public.payment_allocations (payment_transaction_id, order_uid) WHERE (table_order_line_id IS NULL);
CREATE INDEX payment_allocations_order_idx ON public.payment_allocations (order_id, created_at);
CREATE INDEX payment_allocations_order_uid_idx ON public.payment_allocations (order_uid, created_at) WHERE (order_uid IS NOT NULL);

-- ── order_financial_events ───────────────────────────────────────────────────────────────────
CREATE TABLE public.order_financial_events (
  id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                        text        NOT NULL,
  type                            text        NOT NULL,
  amount                          numeric     NOT NULL,
  payment_method                  text,
  reason                          text,
  legacy                          boolean     NOT NULL DEFAULT false,
  by_actor                        text        NOT NULL,
  by_role                         text        NOT NULL,
  prev_estado                     text,
  new_estado                      text,
  prev_pay_state                  text        NOT NULL,
  new_pay_state                   text        NOT NULL,
  original_giro_id                text,
  ip_hash                         text,
  meta                            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  idem_scope_key                  text        NOT NULL,
  payload_digest                  text        NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  service_session_id              uuid,
  payment_transaction_id          uuid,
  event_service_session_id        uuid,
  obligation_economic_period_kind text,
  event_economic_period_kind      text,
  CONSTRAINT ofe_actor_role_map_chk CHECK (((by_actor = 'owner') AND (by_role = ANY (ARRAY['admin','owner']))) OR ((by_actor <> 'owner') AND (by_role = ANY (ARRAY['operator','rider','cashier','waiter','kitchen','shift_manager','legacy_operator'])))),
  CONSTRAINT ofe_amount_chk CHECK (((type = 'void') AND (amount = 0)) OR ((type <> 'void') AND (amount > 0))),
  CONSTRAINT ofe_by_actor_chk CHECK ((by_actor = ANY (ARRAY['owner','operator_primary','operator_backup','rider'])) OR (by_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
  CONSTRAINT ofe_by_actor_fk FOREIGN KEY (by_actor) REFERENCES public.auth_actors(actor) ON DELETE RESTRICT,
  CONSTRAINT ofe_by_role_chk CHECK (by_role = ANY (ARRAY['admin','operator','rider','owner','cashier','waiter','kitchen','shift_manager','legacy_operator'])),
  CONSTRAINT ofe_idem_scope_key_chk CHECK ((char_length(idem_scope_key) >= 8) AND (char_length(idem_scope_key) <= 128) AND (idem_scope_key ~ '^[A-Za-z0-9_-]+$')),
  CONSTRAINT ofe_ip_hash_chk CHECK ((ip_hash IS NULL) OR ((btrim(ip_hash) <> '') AND (length(ip_hash) <= 64))),
  CONSTRAINT ofe_legacy_chk CHECK (((type = 'payment_imported') AND (legacy = true)) OR ((type <> 'payment_imported') AND (legacy = false))),
  CONSTRAINT ofe_meta_chk CHECK ((jsonb_typeof(meta) = 'object') AND (length(meta::text) <= 2048)),
  CONSTRAINT ofe_new_pay_state_chk CHECK (new_pay_state = ANY (ARRAY['unpaid','partially_paid','paid','refunded'])),
  CONSTRAINT ofe_original_giro_chk CHECK ((type = 'void') OR (original_giro_id IS NULL)),
  CONSTRAINT ofe_pay_state_transition_chk CHECK (
    ((type = 'payment') AND (prev_pay_state = ANY (ARRAY['unpaid','partially_paid'])) AND (new_pay_state = ANY (ARRAY['partially_paid','paid'])))
    OR ((type = 'payment_imported') AND (payment_transaction_id IS NULL) AND (prev_pay_state = 'unpaid') AND (new_pay_state = 'paid'))
    OR ((type = 'refund') AND (((payment_transaction_id IS NULL) AND (prev_pay_state = 'paid') AND (new_pay_state = 'refunded'))
         OR ((payment_transaction_id IS NOT NULL) AND (prev_pay_state = ANY (ARRAY['partially_paid','paid'])) AND (new_pay_state = ANY (ARRAY['unpaid','partially_paid','paid','refunded'])))))
    OR ((type = 'void') AND (prev_pay_state = new_pay_state))),
  CONSTRAINT ofe_payload_digest_chk CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ofe_payment_method_chk CHECK (((type = 'void') AND (payment_method IS NULL)) OR ((type = ANY (ARRAY['payment','payment_imported','refund'])) AND (payment_method = ANY (ARRAY['efectivo','tarjeta','bizum'])))),
  CONSTRAINT ofe_prev_pay_state_chk CHECK (prev_pay_state = ANY (ARRAY['unpaid','partially_paid','paid','refunded'])),
  CONSTRAINT ofe_reason_chk CHECK (((type = 'payment') AND ((reason IS NULL) OR (btrim(reason) <> ''))) OR ((type = ANY (ARRAY['refund','void','payment_imported'])) AND (reason IS NOT NULL) AND (btrim(reason) <> ''))),
  CONSTRAINT ofe_type_chk CHECK (type = ANY (ARRAY['payment','refund','void','payment_imported'])),
  CONSTRAINT order_financial_events_event_econ_period_chk CHECK ((event_economic_period_kind IS NULL) OR (event_economic_period_kind = ANY (ARRAY['PRANZO','SERA']))),  -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values reproduced verbatim from the staging catalog, not new vocabulary
  CONSTRAINT order_financial_events_event_service_session_id_fkey FOREIGN KEY (event_service_session_id) REFERENCES public.service_sessions(id),
  CONSTRAINT order_financial_events_obligation_econ_period_chk CHECK ((obligation_economic_period_kind IS NULL) OR (obligation_economic_period_kind = ANY (ARRAY['PRANZO','SERA']))),  -- language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values reproduced verbatim from the staging catalog, not new vocabulary
  CONSTRAINT order_financial_events_payment_transaction_id_fkey FOREIGN KEY (payment_transaction_id) REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT order_financial_events_service_session_id_fkey FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT
);
CREATE INDEX financial_events_service_session_idx ON public.order_financial_events (service_session_id);
CREATE INDEX order_financial_events_order_created_idx ON public.order_financial_events (order_id, created_at);
CREATE UNIQUE INDEX order_financial_events_one_payment_legacy_uq ON public.order_financial_events (order_id) WHERE ((service_session_id IS NULL) AND (type = ANY (ARRAY['payment','payment_imported'])) AND (payment_transaction_id IS NULL));
CREATE UNIQUE INDEX order_financial_events_one_payment_session_uq ON public.order_financial_events (service_session_id, order_id) WHERE ((service_session_id IS NOT NULL) AND (type = ANY (ARRAY['payment','payment_imported'])) AND (payment_transaction_id IS NULL));
CREATE UNIQUE INDEX order_financial_events_one_refund_legacy_uq ON public.order_financial_events (order_id) WHERE ((service_session_id IS NULL) AND (type = 'refund') AND (payment_transaction_id IS NULL));
CREATE UNIQUE INDEX order_financial_events_one_refund_session_uq ON public.order_financial_events (service_session_id, order_id) WHERE ((service_session_id IS NOT NULL) AND (type = 'refund') AND (payment_transaction_id IS NULL));
CREATE UNIQUE INDEX order_financial_events_scope_legacy_uq ON public.order_financial_events (order_id, type, idem_scope_key) WHERE (service_session_id IS NULL);
CREATE UNIQUE INDEX order_financial_events_scope_session_uq ON public.order_financial_events (service_session_id, order_id, type, idem_scope_key) WHERE (service_session_id IS NOT NULL);

-- NOTE: the nine helper/trigger function bodies live in real_ledger_functions_v1.sql.txt (a verbatim dump of the live
-- catalog; its extension keeps it out of the domain-language lint, which would otherwise force a comment INSIDE a body
-- and change its md5). realLedger.js installs them BEFORE this file (check_function_bodies off: they name tables that
-- this file creates).

-- ── triggers (names as on staging) ───────────────────────────────────────────────────────────
CREATE TRIGGER financial_event_assign_service_session BEFORE INSERT ON public.order_financial_events
  FOR EACH ROW EXECUTE FUNCTION public.service_session_assign_financial_event();
CREATE TRIGGER order_financial_events_no_update_delete BEFORE DELETE OR UPDATE ON public.order_financial_events
  FOR EACH ROW EXECUTE FUNCTION public.order_financial_events_append_only();
CREATE TRIGGER order_obligations_append_only_v1 BEFORE DELETE OR UPDATE ON public.order_obligations
  FOR EACH ROW EXECUTE FUNCTION public.order_obligations_append_only_v1();
CREATE TRIGGER payment_allocations_append_only_v1 BEFORE DELETE OR UPDATE ON public.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.mesa_append_only_v1();
CREATE TRIGGER payment_transactions_append_only_v1 BEFORE DELETE OR UPDATE ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.mesa_append_only_v1();
CREATE TRIGGER payment_transactions_stamp_economic_period_v1 BEFORE INSERT ON public.payment_transactions
  FOR EACH ROW EXECUTE FUNCTION public.payment_transactions_stamp_economic_period_v1();
CREATE TRIGGER ordenes_order_obligation_revision_v1 AFTER UPDATE OF totale ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_obligation_revision_v1();

RESET ROLE;
