-- Access Control V3 -- V3-H: Mesa floor, dine-in sessions and multi-payment ledger.
-- TARGET PROJECT REF: tdikhfeinufaahagmpjz   ***STAGING ONLY***
-- DRAFT ONLY: do not apply to production. The runtime remains disabled until its
-- backend and frontend feature gates are enabled explicitly on staging.
--
-- Product vocabulary is intentionally "Mesa" (owner-approved Spanish spelling).
-- Existing internal channel BANCO and fulfilment RITIRO remain unchanged so the
-- feature is additive and old kitchen/order consumers keep working.

BEGIN;

-- Staging-positive guard used by the preceding V3 migrations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260710075612'
  ) THEN
    RAISE EXCEPTION 'V3-H refused: staging sentinel migration absent -- wrong database?';
  END IF;
END $$;

-- V3-G is the required predecessor and its table-session foundation must still be
-- dormant. Refuse to invent links for sessions that may already carry real activity.
DO $$
BEGIN
  IF to_regclass('public.table_sessions') IS NULL
     OR to_regprocedure('public.auth_assign_table_session_waiter_v3(uuid,text,uuid,text,text,text,text,text,jsonb)') IS NULL
  THEN
    RAISE EXCEPTION 'V3-H refused: exact V3-G predecessor not found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_sessions) THEN
    RAISE EXCEPTION 'V3-H refused: dormant table_sessions already contains data -- investigate before linking';
  END IF;
END $$;

-- ── Physical floor ─────────────────────────────────────────────────────────
CREATE TABLE public.restaurant_tables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES public.workspaces(id),
  table_number     integer NOT NULL CHECK (table_number BETWEEN 1 AND 999),
  display_name     text NOT NULL CHECK (
    btrim(display_name) <> '' AND length(display_name) <= 80
    AND display_name !~ '[[:cntrl:]]'
  ),
  capacity         integer NULL CHECK (capacity BETWEEN 1 AND 99),
  position_x       numeric(6,3) NOT NULL CHECK (position_x BETWEEN 0 AND 100),
  position_y       numeric(6,3) NOT NULL CHECK (position_y BETWEEN 0 AND 100),
  shape            text NOT NULL DEFAULT 'round' CHECK (shape IN ('round','square','rectangle')),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NULL,
  updated_by       text NULL,
  CONSTRAINT restaurant_tables_workspace_number_uq UNIQUE (workspace_id, table_number),
  CONSTRAINT restaurant_tables_created_by_fkey
    FOREIGN KEY (workspace_id, created_by) REFERENCES public.auth_actors(workspace_id, actor),
  CONSTRAINT restaurant_tables_updated_by_fkey
    FOREIGN KEY (workspace_id, updated_by) REFERENCES public.auth_actors(workspace_id, actor)
);

CREATE INDEX restaurant_tables_workspace_active_idx
  ON public.restaurant_tables(workspace_id, active, table_number);

-- Start every already-provisioned staging workspace with the five requested tables.
INSERT INTO public.restaurant_tables(
  workspace_id, table_number, display_name, capacity, position_x, position_y, shape
)
SELECT w.id, seed.n, 'Mesa ' || seed.n, 4, seed.x, seed.y, seed.shape
FROM public.workspaces w
CROSS JOIN (VALUES
  (1, 15.000::numeric, 18.000::numeric, 'round'),
  (2, 50.000::numeric, 18.000::numeric, 'round'),
  (3, 82.000::numeric, 18.000::numeric, 'round'),
  (4, 30.000::numeric, 62.000::numeric, 'square'),
  (5, 68.000::numeric, 62.000::numeric, 'square')
) AS seed(n, x, y, shape)
ON CONFLICT (workspace_id, table_number) DO NOTHING;

-- ── Operational table session ──────────────────────────────────────────────
ALTER TABLE public.table_sessions
  ADD COLUMN table_id uuid,
  ADD COLUMN service_session_id uuid,
  ADD COLUMN covers_total integer,
  ADD COLUMN next_command_number integer NOT NULL DEFAULT 1,
  ADD COLUMN settled_at timestamptz NULL;

ALTER TABLE public.table_sessions
  ADD CONSTRAINT table_sessions_table_id_fkey
    FOREIGN KEY (table_id) REFERENCES public.restaurant_tables(id) ON DELETE RESTRICT,
  ADD CONSTRAINT table_sessions_service_session_id_fkey
    FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT table_sessions_covers_total_chk CHECK (covers_total BETWEEN 1 AND 99),
  ADD CONSTRAINT table_sessions_next_command_number_chk CHECK (next_command_number >= 1);

ALTER TABLE public.table_sessions
  ALTER COLUMN table_id SET NOT NULL,
  ALTER COLUMN service_session_id SET NOT NULL,
  ALTER COLUMN covers_total SET NOT NULL;

ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_status_check;
ALTER TABLE public.table_sessions DROP CONSTRAINT table_sessions_closed_at_chk;
ALTER TABLE public.table_sessions
  ADD CONSTRAINT table_sessions_status_chk
    CHECK (status IN ('open','closed')),
  ADD CONSTRAINT table_sessions_lifecycle_chk CHECK (
    (status = 'open' AND settled_at IS NULL AND closed_at IS NULL)
    OR
    (status = 'closed' AND settled_at IS NOT NULL AND closed_at IS NOT NULL)
  );

CREATE UNIQUE INDEX table_sessions_one_open_per_table_uq
  ON public.table_sessions(workspace_id, table_id)
  WHERE status = 'open';
CREATE INDEX table_sessions_service_idx
  ON public.table_sessions(service_session_id, status, opened_at);

COMMENT ON COLUMN public.table_sessions.covers_total IS
  'Total covers seated when the Mesa session opens. Remaining covers are derived from posted payment transactions, never decremented destructively.';

-- The JavaScript pre-scan gives the operator a friendly list, but only the service
-- lifecycle row can close the open-vs-new-table race. This exact-signature revision
-- keeps the predecessor body and adds one locked check before open -> closing.
CREATE OR REPLACE FUNCTION public.begin_service_session_close(
  p_closed_by text,
  p_source text DEFAULT 'backend'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_state public.service_session_state%ROWTYPE;
  v_session public.service_sessions%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));
  SELECT * INTO v_state FROM public.service_session_state WHERE singleton=true FOR UPDATE;
  IF (SELECT count(*) FROM public.service_sessions WHERE status IN ('open','closing')) > 1 THEN
    RETURN jsonb_build_object('ok',false,'code','MULTIPLE_ACTIVE_SERVICE_SESSIONS');
  END IF;
  IF v_state.current_session_id IS NULL THEN
    IF v_state.recent_closed_session_id IS NULL THEN
      RETURN jsonb_build_object('ok',false,'code','NO_SERVICE_SESSION');
    END IF;
    SELECT * INTO v_session FROM public.service_sessions WHERE id=v_state.recent_closed_session_id;
    IF NOT FOUND OR v_session.status <> 'closed' THEN
      RETURN jsonb_build_object('ok',false,'code','INVALID_RECENT_CLOSED_SESSION');
    END IF;
    RETURN jsonb_build_object('ok',true,'code','ALREADY_CLOSED','idempotent',true,'session',to_jsonb(v_session));
  END IF;
  SELECT * INTO v_session FROM public.service_sessions
   WHERE id=v_state.current_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status NOT IN ('open','closing') THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_CURRENT_SERVICE_SESSION');
  END IF;
  IF v_session.status='open' THEN
    PERFORM 1 FROM public.table_sessions
     WHERE service_session_id=v_session.id AND status = 'open'
     ORDER BY id FOR UPDATE;
    IF FOUND THEN
      RETURN jsonb_build_object('ok',false,'code','MESSA_TABLES_NOT_RELEASED');
    END IF;
    UPDATE public.service_sessions
       SET status='closing',closed_by=p_closed_by,close_source=p_source,updated_at=now()
     WHERE id=v_session.id RETURNING * INTO v_session;
    INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
    VALUES(v_session.id,'closing',p_closed_by,p_source);
  END IF;
  RETURN jsonb_build_object('ok',true,'code','CLOSING','session',to_jsonb(v_session));
END
$fn$;

-- ── Link each independent kitchen command to the same table session ─────────
ALTER TABLE public.ordenes
  ADD COLUMN table_session_id uuid NULL REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN table_number_snapshot integer NULL,
  ADD COLUMN table_name_snapshot text NULL,
  ADD COLUMN table_command_number integer NULL;

ALTER TABLE public.storico
  ADD COLUMN table_session_id uuid NULL REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN table_number_snapshot integer NULL,
  ADD COLUMN table_name_snapshot text NULL,
  ADD COLUMN table_command_number integer NULL;

ALTER TABLE public.ordenes ADD CONSTRAINT ordenes_table_fields_chk CHECK (
  (table_session_id IS NULL AND table_number_snapshot IS NULL AND table_name_snapshot IS NULL AND table_command_number IS NULL)
  OR
  (table_session_id IS NOT NULL AND table_number_snapshot BETWEEN 1 AND 999
    AND btrim(table_name_snapshot) <> '' AND table_command_number >= 1
    AND canal = 'BANCO' AND tipo_consegna = 'RITIRO')
);
ALTER TABLE public.storico ADD CONSTRAINT storico_table_fields_chk CHECK (
  (table_session_id IS NULL AND table_number_snapshot IS NULL AND table_name_snapshot IS NULL AND table_command_number IS NULL)
  OR
  (table_session_id IS NOT NULL AND table_number_snapshot BETWEEN 1 AND 999
    AND btrim(table_name_snapshot) <> '' AND table_command_number >= 1
    AND canal = 'BANCO' AND tipo_consegna = 'RITIRO')
);

CREATE UNIQUE INDEX ordenes_table_command_uq
  ON public.ordenes(table_session_id, table_command_number)
  WHERE table_session_id IS NOT NULL;
CREATE UNIQUE INDEX storico_table_command_uq
  ON public.storico(service_session_id, table_session_id, table_command_number)
  WHERE table_session_id IS NOT NULL;
CREATE INDEX ordenes_table_session_idx ON public.ordenes(table_session_id, ts);
CREATE INDEX storico_table_session_idx ON public.storico(table_session_id, ts);

-- One immutable settlement charge per ordered unit. A JSON order line with q=3 is
-- expanded to three rows, so the operator can settle exactly 1/2/3 units without
-- ambiguous fractional quantities. source_line_id groups them back in the UI.
CREATE TABLE public.table_order_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES public.workspaces(id),
  table_session_id   uuid NOT NULL REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  service_session_id uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  order_id           text NOT NULL,
  source_line_id     uuid NOT NULL,
  source_line_index  integer NOT NULL CHECK (source_line_index >= 1),
  unit_index         integer NOT NULL CHECK (unit_index >= 1),
  description        text NOT NULL CHECK (btrim(description) <> '' AND length(description) <= 240),
  product_snapshot   jsonb NOT NULL CHECK (jsonb_typeof(product_snapshot) = 'object'),
  gross_amount       numeric(12,2) NOT NULL CHECK (gross_amount >= 0),
  discount_amount    numeric(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  net_amount         numeric(12,2) NOT NULL CHECK (net_amount >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT table_order_lines_amounts_chk CHECK (gross_amount - discount_amount = net_amount),
  CONSTRAINT table_order_lines_source_unit_uq UNIQUE (order_id, source_line_id, unit_index)
);

CREATE INDEX table_order_lines_session_idx
  ON public.table_order_lines(table_session_id, created_at, order_id, source_line_index, unit_index);

-- ── Generic transaction parent + line allocations ──────────────────────────
-- One transaction has exactly one method. A table can therefore settle with any mix
-- of cash/card/Bizum while closeout still reports every method exactly.
CREATE TABLE public.payment_transactions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES public.workspaces(id),
  table_session_id      uuid NOT NULL REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  service_session_id    uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  kind                  text NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','refund')),
  mode                  text NOT NULL CHECK (mode IN ('full','equal_split','item_selection','custom_amount','refund')),
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  payment_method        text NOT NULL CHECK (payment_method IN ('efectivo','tarjeta','bizum')),
  covers_settled        integer NOT NULL DEFAULT 0 CHECK (covers_settled BETWEEN 0 AND 99),
  reverses_transaction_id uuid NULL REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  by_actor              text NOT NULL,
  by_role               text NOT NULL CHECK (by_role IN (
    'admin','operator','owner','cashier','legacy_operator'
  )),
  by_sid_hash           text NOT NULL CHECK (by_sid_hash ~ '^[0-9a-f]{64}$'),
  client_request_id     text NOT NULL CHECK (
    length(client_request_id) BETWEEN 8 AND 128
    AND client_request_id ~ '^[A-Za-z0-9_-]+$'
  ),
  request_hash          text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  meta                  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(meta) = 'object' AND length(meta::text) <= 2048
  ),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_actor_fkey
    FOREIGN KEY (workspace_id, by_actor) REFERENCES public.auth_actors(workspace_id, actor),
  CONSTRAINT payment_transactions_kind_mode_chk CHECK (
    (kind = 'payment' AND mode <> 'refund' AND reverses_transaction_id IS NULL)
    OR (kind = 'refund' AND mode = 'refund' AND reverses_transaction_id IS NOT NULL)
  ),
  CONSTRAINT payment_transactions_idempotency_uq
    UNIQUE (workspace_id, by_actor, by_sid_hash, client_request_id)
);

CREATE TABLE public.payment_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_transaction_id uuid NOT NULL REFERENCES public.payment_transactions(id) ON DELETE RESTRICT,
  table_order_line_id   uuid NOT NULL REFERENCES public.table_order_lines(id) ON DELETE RESTRICT,
  order_id              text NOT NULL,
  amount                numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_allocations_transaction_line_uq UNIQUE (payment_transaction_id, table_order_line_id)
);

CREATE INDEX payment_transactions_table_idx
  ON public.payment_transactions(table_session_id, created_at);
CREATE INDEX payment_transactions_service_method_idx
  ON public.payment_transactions(service_session_id, payment_method, created_at);
CREATE INDEX payment_allocations_line_idx
  ON public.payment_allocations(table_order_line_id, created_at);
CREATE INDEX payment_allocations_order_idx
  ON public.payment_allocations(order_id, created_at);

-- Group the new multi-order/multi-line transaction inside the existing append-only
-- financial ledger. Legacy payment RPCs leave this column NULL and keep their exact
-- one-full-payment behavior.
ALTER TABLE public.order_financial_events
  ADD COLUMN payment_transaction_id uuid NULL
    REFERENCES public.payment_transactions(id) ON DELETE RESTRICT;

DROP INDEX public.order_financial_events_one_payment_session_uq;
DROP INDEX public.order_financial_events_one_payment_legacy_uq;
CREATE UNIQUE INDEX order_financial_events_one_payment_session_uq
  ON public.order_financial_events(service_session_id, order_id)
  WHERE service_session_id IS NOT NULL
    AND type IN ('payment','payment_imported')
    AND payment_transaction_id IS NULL;
CREATE UNIQUE INDEX order_financial_events_one_payment_legacy_uq
  ON public.order_financial_events(order_id)
  WHERE service_session_id IS NULL
    AND type IN ('payment','payment_imported')
    AND payment_transaction_id IS NULL;

ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_prev_pay_state_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_new_pay_state_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_pay_state_transition_chk;
ALTER TABLE public.order_financial_events
  ADD CONSTRAINT ofe_prev_pay_state_chk CHECK (
    prev_pay_state IN ('unpaid','partially_paid','paid','refunded')
  ),
  ADD CONSTRAINT ofe_new_pay_state_chk CHECK (
    new_pay_state IN ('unpaid','partially_paid','paid','refunded')
  ),
  ADD CONSTRAINT ofe_pay_state_transition_chk CHECK (
    (type = 'payment' AND prev_pay_state IN ('unpaid','partially_paid')
      AND new_pay_state IN ('partially_paid','paid'))
    OR
    (type = 'payment_imported' AND payment_transaction_id IS NULL
      AND prev_pay_state = 'unpaid' AND new_pay_state = 'paid')
    OR
    (type = 'refund' AND (
      (payment_transaction_id IS NULL AND prev_pay_state = 'paid' AND new_pay_state = 'refunded')
      OR
      (payment_transaction_id IS NOT NULL AND prev_pay_state IN ('partially_paid','paid')
        AND new_pay_state IN ('unpaid','partially_paid','refunded'))
    ))
    OR
    (type = 'void' AND prev_pay_state = new_pay_state)
  );

-- Dynamic V3 cashier/owner actor ids must be legal ledger writers. The authoritative
-- payment RPC derives role from the locked auth_actors row; callers never submit it.
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_by_actor_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_by_role_chk;
ALTER TABLE public.order_financial_events DROP CONSTRAINT ofe_actor_role_map_chk;
ALTER TABLE public.order_financial_events
  ADD CONSTRAINT ofe_by_actor_chk CHECK (
    by_actor IN ('owner','operator_primary','operator_backup','rider')
    OR by_actor ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ),
  ADD CONSTRAINT ofe_by_role_chk CHECK (by_role IN (
    'admin','operator','rider','owner','cashier','waiter','kitchen','shift_manager','legacy_operator'
  )),
  ADD CONSTRAINT ofe_actor_role_map_chk CHECK (
    (by_actor = 'owner' AND by_role IN ('admin','owner'))
    OR
    (by_actor <> 'owner' AND by_role IN (
      'operator','rider','cashier','waiter','kitchen','shift_manager','legacy_operator'
    ))
  );

-- ── Atomic order preparation + immutable settlement-line snapshot ──────────
CREATE OR REPLACE FUNCTION public.messa_prepare_table_order_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_source_line_id uuid;
  v_raw_id text;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = NEW.table_session_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = v_session.table_id FOR SHARE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;

  IF jsonb_typeof(NEW.items) <> 'array' OR jsonb_array_length(NEW.items) = 0 THEN
    RAISE EXCEPTION 'MESSA_ITEMS_REQUIRED' USING ERRCODE='22023';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(NEW.items)
  LOOP
    v_raw_id := v_item ->> 'lineId';
    BEGIN
      v_source_line_id := CASE WHEN v_raw_id IS NULL THEN gen_random_uuid() ELSE v_raw_id::uuid END;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'MESSA_LINE_ID_INVALID' USING ERRCODE='22023';
    END;
    v_items := v_items || jsonb_build_array(
      jsonb_set(v_item, '{lineId}', to_jsonb(v_source_line_id::text), true)
    );
  END LOOP;

  NEW.items := v_items;
  NEW.service_session_id := v_session.service_session_id;
  NEW.table_number_snapshot := v_table.table_number;
  NEW.table_name_snapshot := v_table.display_name;
  NEW.table_command_number := v_session.next_command_number;
  NEW.canal := 'BANCO';
  NEW.tipo_consegna := 'RITIRO';
  NEW.delivery_fee := 0;

  UPDATE public.table_sessions
     SET next_command_number = next_command_number + 1,
         updated_at = now()
   WHERE id = v_session.id;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER messa_prepare_table_order_v1
BEFORE INSERT ON public.ordenes
FOR EACH ROW EXECUTE FUNCTION public.messa_prepare_table_order_v1();

CREATE OR REPLACE FUNCTION public.messa_snapshot_order_lines_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_session public.table_sessions%ROWTYPE;
  v_item jsonb;
  v_line_index integer;
  v_quantity integer;
  v_unit_index integer;
  v_total_units integer := 0;
  v_seen_units integer := 0;
  v_source_line_id uuid;
  v_description text;
  v_unit_gross_cents bigint;
  v_total_gross_cents bigint := 0;
  v_gross_remaining_cents bigint;
  v_net_total_cents bigint;
  v_net_remaining_cents bigint;
  v_unit_net_cents bigint;
BEGIN
  IF NEW.table_session_id IS NULL THEN RETURN NEW; END IF;

  SELECT * INTO v_session FROM public.table_sessions WHERE id = NEW.table_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  FOR v_item, v_line_index IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(NEW.items) WITH ORDINALITY
  LOOP
    v_quantity := COALESCE((v_item ->> 'quantity')::integer, (v_item ->> 'q')::integer, 1);
    v_unit_gross_cents := round(COALESCE(
      (v_item ->> 'finalUnitPrice')::numeric,
      (v_item ->> 'p')::numeric
    ) * 100)::bigint;
    IF v_quantity < 1 OR v_unit_gross_cents < 0 THEN
      RAISE EXCEPTION 'MESSA_ITEM_SNAPSHOT_INVALID' USING ERRCODE='22023';
    END IF;
    v_total_units := v_total_units + v_quantity;
    v_total_gross_cents := v_total_gross_cents + (v_quantity * v_unit_gross_cents);
  END LOOP;

  v_net_total_cents := round(COALESCE(NEW.totale, 0) * 100)::bigint;
  IF v_total_units < 1 OR v_total_gross_cents <= 0 OR v_net_total_cents < 0
     OR v_net_total_cents > v_total_gross_cents THEN
    RAISE EXCEPTION 'MESSA_ORDER_TOTAL_INVALID' USING ERRCODE='22023';
  END IF;
  v_net_remaining_cents := v_net_total_cents;
  v_gross_remaining_cents := v_total_gross_cents;

  FOR v_item, v_line_index IN
    SELECT value, ordinality::integer FROM jsonb_array_elements(NEW.items) WITH ORDINALITY
  LOOP
    v_quantity := COALESCE((v_item ->> 'quantity')::integer, (v_item ->> 'q')::integer, 1);
    v_source_line_id := (v_item ->> 'lineId')::uuid;
    v_description := left(COALESCE(NULLIF(v_item ->> 'fantasyName',''), NULLIF(v_item ->> 'n',''), NULLIF(v_item ->> 'classicName',''), 'Producto'), 240);
    v_unit_gross_cents := round(COALESCE(
      (v_item ->> 'finalUnitPrice')::numeric,
      (v_item ->> 'p')::numeric
    ) * 100)::bigint;

    FOR v_unit_index IN 1..v_quantity
    LOOP
      v_seen_units := v_seen_units + 1;
      IF v_seen_units = v_total_units THEN
        v_unit_net_cents := v_net_remaining_cents;
      ELSE
        v_unit_net_cents := floor(
          (v_net_remaining_cents::numeric * v_unit_gross_cents::numeric) / v_gross_remaining_cents::numeric
        )::bigint;
      END IF;
      v_net_remaining_cents := v_net_remaining_cents - v_unit_net_cents;
      v_gross_remaining_cents := v_gross_remaining_cents - v_unit_gross_cents;

      INSERT INTO public.table_order_lines(
        workspace_id, table_session_id, service_session_id, order_id,
        source_line_id, source_line_index, unit_index, description,
        product_snapshot, gross_amount, discount_amount, net_amount
      ) VALUES (
        v_session.workspace_id, v_session.id, v_session.service_session_id, NEW.id,
        v_source_line_id, v_line_index, v_unit_index, v_description,
        v_item, v_unit_gross_cents / 100.0,
        (v_unit_gross_cents - v_unit_net_cents) / 100.0,
        v_unit_net_cents / 100.0
      );
    END LOOP;
  END LOOP;

  RETURN NEW;
END
$fn$;

CREATE TRIGGER messa_snapshot_order_lines_v1
AFTER INSERT ON public.ordenes
FOR EACH ROW EXECUTE FUNCTION public.messa_snapshot_order_lines_v1();

-- ── Authoritative Mesa lifecycle RPCs ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.messa_open_session_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_id uuid,
  p_service_session_id uuid,
  p_covers_total integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
  v_service public.service_sessions%ROWTYPE;
  v_session public.table_sessions%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_table_id IS NULL OR p_service_session_id IS NULL
     OR p_by_actor IS NULL OR btrim(p_by_actor) = ''
     OR p_covers_total IS NULL OR p_covers_total NOT BETWEEN 1 AND 99
  THEN RAISE EXCEPTION 'MESSA_INVALID_REQUEST' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;

  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_ACTOR_UNAVAILABLE' USING ERRCODE='42501';
  END IF;
  IF v_actor.role NOT IN ('admin','operator','owner','cashier','waiter','legacy_operator') THEN
    RAISE EXCEPTION 'MESSA_OPEN_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  SELECT * INTO v_service FROM public.service_sessions
   WHERE id = p_service_session_id FOR UPDATE;
  IF NOT FOUND OR v_service.status <> 'open' THEN
    RAISE EXCEPTION 'MESSA_SERVICE_NOT_OPEN' USING ERRCODE='55000';
  END IF;

  PERFORM 1 FROM public.table_sessions
   WHERE workspace_id = p_workspace_id AND table_id = p_table_id
     AND status = 'open'
   ORDER BY id FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION 'MESSA_TABLE_ACCOUNT_OPEN' USING ERRCODE='23505';
  END IF;

  SELECT * INTO v_table FROM public.restaurant_tables
   WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR v_table.active IS NOT TRUE THEN
    RAISE EXCEPTION 'MESSA_TABLE_UNAVAILABLE' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.table_sessions(
    workspace_id, table_id, service_session_id, table_ref, status,
    covers_total, assigned_waiter_actor, created_by, updated_by
  ) VALUES (
    p_workspace_id, p_table_id, p_service_session_id, v_table.display_name, 'open',
    p_covers_total, CASE WHEN v_actor.role='waiter' THEN p_by_actor ELSE NULL END,
    p_by_actor, p_by_actor
  ) RETURNING * INTO v_session;

  IF v_actor.role='waiter' THEN
    INSERT INTO public.table_session_assignment_history(
      workspace_id, table_session_id, previous_waiter_actor, new_waiter_actor,
      by_actor, action, created_at
    ) VALUES (
      p_workspace_id, v_session.id, NULL, p_by_actor, p_by_actor, 'assigned', now()
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'sessionId', v_session.id,
    'tableId', v_session.table_id,
    'tableNumber', v_table.table_number,
    'displayName', v_table.display_name,
    'coversTotal', v_session.covers_total,
    'status', v_session.status,
    'openedAt', v_session.opened_at
  );
END
$fn$;

-- Owner-only structural editor: create, move, resize metadata or soft-deactivate.
-- Physical DELETE is deliberately absent so historical sessions never lose identity.
CREATE OR REPLACE FUNCTION public.messa_save_table_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_table_id uuid,
  p_table_number integer,
  p_display_name text,
  p_capacity integer,
  p_position_x numeric,
  p_position_y numeric,
  p_shape text,
  p_active boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor public.auth_actors%ROWTYPE;
  v_table public.restaurant_tables%ROWTYPE;
BEGIN
  IF p_table_number IS NULL OR p_table_number NOT BETWEEN 1 AND 999 OR p_display_name IS NULL
     OR btrim(p_display_name) = '' OR length(p_display_name) > 80
     OR p_position_x IS NULL OR p_position_x NOT BETWEEN 0 AND 100
     OR p_position_y IS NULL OR p_position_y NOT BETWEEN 0 AND 100
     OR p_shape NOT IN ('round','square','rectangle')
     OR (p_capacity IS NOT NULL AND p_capacity NOT BETWEEN 1 AND 99)
     OR p_active IS NULL
  THEN RAISE EXCEPTION 'MESSA_TABLE_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE OR v_actor.role NOT IN ('admin','owner') THEN
    RAISE EXCEPTION 'MESSA_LAYOUT_FORBIDDEN' USING ERRCODE='42501';
  END IF;

  IF p_table_id IS NULL THEN
    INSERT INTO public.restaurant_tables(
      workspace_id, table_number, display_name, capacity, position_x, position_y,
      shape, active, created_by, updated_by
    ) VALUES (
      p_workspace_id, p_table_number, btrim(p_display_name), p_capacity,
      p_position_x, p_position_y, p_shape, p_active, p_by_actor, p_by_actor
    ) RETURNING * INTO v_table;
  ELSE
    -- Global lock order for an existing table is session(s) -> physical table,
    -- matching the order-insert trigger. Locking the table first and then asking
    -- whether it had an open session would deadlock with a simultaneous command.
    PERFORM 1 FROM public.table_sessions
     WHERE workspace_id = p_workspace_id AND table_id = p_table_id
       AND status = 'open'
     ORDER BY id FOR UPDATE;
    SELECT * INTO v_table FROM public.restaurant_tables
     WHERE id = p_table_id AND workspace_id = p_workspace_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_TABLE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
    IF p_active IS FALSE AND EXISTS (
      SELECT 1 FROM public.table_sessions
       WHERE workspace_id = p_workspace_id AND table_id = p_table_id AND status = 'open'
    ) THEN
      RAISE EXCEPTION 'MESSA_TABLE_NOT_RELEASED' USING ERRCODE='55000';
    END IF;
    UPDATE public.restaurant_tables
       SET table_number = p_table_number, display_name = btrim(p_display_name),
           capacity = p_capacity, position_x = p_position_x, position_y = p_position_y,
           shape = p_shape, active = p_active, updated_at = now(), updated_by = p_by_actor
     WHERE id = p_table_id RETURNING * INTO v_table;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'tableId', v_table.id, 'tableNumber', v_table.table_number,
    'displayName', v_table.display_name, 'capacity', v_table.capacity,
    'positionX', v_table.position_x, 'positionY', v_table.position_y,
    'shape', v_table.shape, 'active', v_table.active
  );
END
$fn$;

-- One atomic money movement. The table-session row serializes concurrent operators;
-- all amounts are allocated to immutable unit charges and mirrored into the existing
-- append-only order_financial_events ledger for one-source closeout accounting.
CREATE OR REPLACE FUNCTION public.messa_post_payment_v1(
  p_workspace_id uuid,
  p_by_actor text,
  p_by_sid_hash text,
  p_table_session_id uuid,
  p_payment_method text,
  p_mode text,
  p_client_request_id text,
  p_request_hash text,
  p_amount numeric DEFAULT NULL,
  p_covers_settled integer DEFAULT NULL,
  p_line_ids uuid[] DEFAULT NULL,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
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
  v_now timestamptz := now();
  v_meta jsonb := COALESCE(p_meta, '{}'::jsonb);
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
  THEN RAISE EXCEPTION 'MESSA_PAYMENT_INVALID' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE lower(k) = ANY (ARRAY[
    'pin','pin_hash','password','token','access_token','refresh_token','jwt','secret',
    'authorization','api_key','apikey','bearer','cookie','raw_ip','sid','proof'
  ])) THEN RAISE EXCEPTION 'MESSA_PAYMENT_META_INVALID' USING ERRCODE='22023'; END IF;

  PERFORM 1 FROM public.workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_WORKSPACE_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_actor FROM public.auth_actors
   WHERE workspace_id = p_workspace_id AND actor = p_by_actor FOR UPDATE;
  IF NOT FOUND OR v_actor.active IS NOT TRUE
     OR v_actor.role NOT IN ('admin','operator','owner','cashier','legacy_operator')
  THEN RAISE EXCEPTION 'MESSA_PAYMENT_FORBIDDEN' USING ERRCODE='42501'; END IF;

  -- Replay is checked before the account-open guard. A final payment closes the
  -- account atomically; if its response was lost, the exact retry must still return
  -- the committed transaction instead of looking like a new payment on a closed ID.
  SELECT * INTO v_existing FROM public.payment_transactions
   WHERE workspace_id = p_workspace_id AND by_actor = p_by_actor
     AND by_sid_hash = p_by_sid_hash AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RAISE EXCEPTION 'MESSA_PAYMENT_IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent', true, 'transactionId', v_existing.id,
      'amount', v_existing.amount, 'paymentMethod', v_existing.payment_method,
      'mode', v_existing.mode, 'coversSettled', v_existing.covers_settled
    );
  END IF;

  SELECT * INTO v_session FROM public.table_sessions
   WHERE id = p_table_session_id AND workspace_id = p_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_FOUND' USING ERRCODE='P0002'; END IF;
  IF v_session.status <> 'open' THEN RAISE EXCEPTION 'MESSA_SESSION_NOT_OPEN' USING ERRCODE='55000'; END IF;

  SELECT COALESCE(round(sum(l.net_amount) * 100), 0)::bigint INTO v_total_cents
    FROM public.table_order_lines l
    JOIN public.ordenes o ON o.id = l.order_id AND o.table_session_id = l.table_session_id
   WHERE l.table_session_id = v_session.id
     AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');
  SELECT COALESCE(round(sum(CASE WHEN t.kind='refund' THEN -a.amount ELSE a.amount END) * 100), 0)::bigint
    INTO v_paid_cents
    FROM public.payment_allocations a
    JOIN public.payment_transactions t ON t.id = a.payment_transaction_id
   WHERE t.table_session_id = v_session.id;
  v_outstanding_cents := GREATEST(0, v_total_cents - v_paid_cents);
  IF v_outstanding_cents <= 0 THEN RAISE EXCEPTION 'MESSA_ALREADY_SETTLED' USING ERRCODE='55000'; END IF;

  SELECT v_session.covers_total - COALESCE(sum(
    CASE WHEN kind='payment' THEN covers_settled ELSE -covers_settled END
  ), 0)::integer INTO v_remaining_covers
    FROM public.payment_transactions WHERE table_session_id = v_session.id;
  v_remaining_covers := GREATEST(0, v_remaining_covers);

  IF p_mode = 'full' THEN
    v_amount_cents := v_outstanding_cents;
    v_covers_settled := v_remaining_covers;
  ELSIF p_mode = 'equal_split' THEN
    IF v_remaining_covers < 1 THEN RAISE EXCEPTION 'MESSA_NO_COVERS_REMAINING' USING ERRCODE='55000'; END IF;
    v_amount_cents := ceil(v_outstanding_cents::numeric / v_remaining_covers)::bigint;
    v_covers_settled := 1;
  ELSIF p_mode = 'item_selection' THEN
    SELECT count(*), count(DISTINCT line_id) INTO v_selected_count, v_selected_distinct
      FROM unnest(COALESCE(p_line_ids, ARRAY[]::uuid[])) AS selected(line_id);
    IF v_selected_count < 1 OR v_selected_count <> v_selected_distinct THEN
      RAISE EXCEPTION 'MESSA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
    END IF;
    SELECT count(*) INTO v_selected_matched
      FROM public.table_order_lines l
      JOIN public.ordenes o ON o.id=l.order_id AND o.table_session_id=l.table_session_id
     WHERE l.table_session_id=v_session.id AND l.id=ANY(p_line_ids)
       AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO');
    IF v_selected_matched <> v_selected_count THEN
      RAISE EXCEPTION 'MESSA_LINE_SELECTION_INVALID' USING ERRCODE='22023';
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
        AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')
      GROUP BY l.id, l.net_amount
    ) selected;
    IF v_amount_cents <= 0 THEN RAISE EXCEPTION 'MESSA_LINE_SELECTION_SETTLED' USING ERRCODE='55000'; END IF;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  ELSE
    v_amount_cents := round(COALESCE(p_amount, 0) * 100)::bigint;
    v_covers_settled := COALESCE(p_covers_settled, 1);
  END IF;

  IF v_amount_cents <= 0 OR v_amount_cents > v_outstanding_cents
     OR v_covers_settled < 0 OR v_covers_settled > v_remaining_covers
  THEN RAISE EXCEPTION 'MESSA_PAYMENT_AMOUNT_INVALID' USING ERRCODE='22023'; END IF;
  -- Paying the final cent always settles every remaining cover.
  IF v_amount_cents = v_outstanding_cents THEN v_covers_settled := v_remaining_covers; END IF;

  INSERT INTO public.payment_transactions(
    workspace_id, table_session_id, service_session_id, kind, mode, amount,
    payment_method, covers_settled, by_actor, by_role, by_sid_hash,
    client_request_id, request_hash, meta, created_at
  ) VALUES (
    p_workspace_id, v_session.id, v_session.service_session_id, 'payment', p_mode,
    v_amount_cents / 100.0, p_payment_method, v_covers_settled,
    p_by_actor, v_actor.role, p_by_sid_hash, p_client_request_id,
    p_request_hash, v_meta, v_now
  ) RETURNING * INTO v_tx;

  v_to_allocate_cents := v_amount_cents;
  FOR v_line IN
    SELECT l.id, l.order_id, l.net_amount,
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
      AND upper(COALESCE(o.estado,'')) NOT IN ('ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO')
    ORDER BY l.created_at, l.order_id, l.source_line_index, l.unit_index, l.id
  LOOP
    EXIT WHEN v_to_allocate_cents <= 0;
    v_line_remaining_cents := v_line.remaining_cents;
    IF v_line_remaining_cents <= 0 THEN CONTINUE; END IF;
    v_allocation_cents := LEAST(v_to_allocate_cents, v_line_remaining_cents);
    INSERT INTO public.payment_allocations(
      payment_transaction_id, table_order_line_id, order_id, amount, created_at
    ) VALUES (v_tx.id, v_line.id, v_line.order_id, v_allocation_cents / 100.0, v_now);
    v_to_allocate_cents := v_to_allocate_cents - v_allocation_cents;
  END LOOP;
  IF v_to_allocate_cents <> 0 THEN RAISE EXCEPTION 'MESSA_ALLOCATION_MISMATCH' USING ERRCODE='23514'; END IF;

  -- Mirror one event per affected kitchen command into the canonical closeout ledger.
  FOR v_order IN
    SELECT a.order_id, round(sum(a.amount) * 100)::bigint AS allocated_cents
      FROM public.payment_allocations a
     WHERE a.payment_transaction_id = v_tx.id
     GROUP BY a.order_id ORDER BY a.order_id
  LOOP
    SELECT COALESCE(round(sum(net_amount)*100),0)::bigint INTO v_order_total_cents
      FROM public.table_order_lines WHERE table_session_id=v_session.id AND order_id=v_order.order_id;
    SELECT COALESCE(round(sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)*100),0)::bigint
      INTO v_order_paid_before_cents
      FROM public.order_financial_events e
     WHERE e.service_session_id=v_session.service_session_id AND e.order_id=v_order.order_id
       AND e.type IN ('payment','payment_imported','refund');
    v_order_allocation_cents := v_order.allocated_cents;
    v_prev_state := CASE
      WHEN v_order_paid_before_cents <= 0 THEN 'unpaid'
      WHEN v_order_paid_before_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_new_state := CASE
      WHEN v_order_paid_before_cents + v_order_allocation_cents >= v_order_total_cents THEN 'paid'
      ELSE 'partially_paid' END;
    v_scope := 'messa_' || replace(v_tx.id::text, '-', '');

    INSERT INTO public.order_financial_events(
      order_id, type, amount, payment_method, reason, legacy, by_actor, by_role,
      prev_estado, new_estado, prev_pay_state, new_pay_state, original_giro_id,
      ip_hash, meta, idem_scope_key, payload_digest, service_session_id,
      payment_transaction_id, created_at
    )
    SELECT o.id, 'payment', v_order_allocation_cents / 100.0, p_payment_method,
      NULL, false, p_by_actor, v_actor.role, o.estado, o.estado,
      v_prev_state, v_new_state, NULL, NULL,
      jsonb_build_object('source','messa','mode',p_mode,'transaction_id',v_tx.id),
      v_scope,
      encode(digest(concat_ws('|', o.id, v_tx.id::text, v_order_allocation_cents::text,
        p_payment_method, p_by_actor, p_request_hash), 'sha256'), 'hex'),
      v_session.service_session_id, v_tx.id, v_now
    FROM public.ordenes o WHERE o.id=v_order.order_id AND o.table_session_id=v_session.id;
  END LOOP;

  -- Legacy booleans remain compatibility projections only. Ledger events above are truth.
  UPDATE public.ordenes o SET
    cobrado = calc.is_paid,
    ya_pagado = calc.is_paid,
    metodo_pago = CASE WHEN calc.is_paid THEN calc.method_projection ELSE COALESCE(o.metodo_pago,'') END
  FROM (
    SELECT l.order_id,
      COALESCE(sum(l.net_amount),0) <= COALESCE((
        SELECT sum(CASE WHEN e.type='refund' THEN -e.amount ELSE e.amount END)
          FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported','refund')
      ),0) AS is_paid,
      CASE WHEN (
        SELECT count(DISTINCT e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) > 1 THEN 'MIXTO' ELSE (
        SELECT max(e.payment_method) FROM public.order_financial_events e
         WHERE e.service_session_id=v_session.service_session_id AND e.order_id=l.order_id
           AND e.type IN ('payment','payment_imported')
      ) END AS method_projection
    FROM public.table_order_lines l WHERE l.table_session_id=v_session.id GROUP BY l.order_id
  ) calc
  WHERE o.id=calc.order_id AND o.table_session_id=v_session.id;

  v_table_remaining_cents := v_outstanding_cents - v_amount_cents;
  IF v_table_remaining_cents = 0 THEN
    UPDATE public.table_sessions SET
      status='closed', settled_at=v_now, closed_at=v_now,
      updated_at=v_now, updated_by=p_by_actor
    WHERE id=v_session.id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'idempotent', false, 'transactionId', v_tx.id,
    'amount', v_tx.amount, 'paymentMethod', v_tx.payment_method, 'mode', v_tx.mode,
    'coversSettled', v_tx.covers_settled,
    'coversRemaining', GREATEST(0, v_remaining_covers - v_tx.covers_settled),
    'tableTotal', v_total_cents / 100.0,
    'outstandingBefore', v_outstanding_cents / 100.0,
    'outstandingAfter', v_table_remaining_cents / 100.0,
    'tableStatus', CASE WHEN v_table_remaining_cents=0 THEN 'free' ELSE 'open' END
  );
END
$fn$;

-- Append-only evidence. Corrections are compensating refund transactions, never edits.
CREATE OR REPLACE FUNCTION public.messa_append_only_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'MESSA_APPEND_ONLY' USING ERRCODE='55000';
END
$fn$;

CREATE TRIGGER table_order_lines_append_only_v1
BEFORE UPDATE OR DELETE ON public.table_order_lines
FOR EACH ROW EXECUTE FUNCTION public.messa_append_only_v1();
CREATE TRIGGER payment_transactions_append_only_v1
BEFORE UPDATE OR DELETE ON public.payment_transactions
FOR EACH ROW EXECUTE FUNCTION public.messa_append_only_v1();
CREATE TRIGGER payment_allocations_append_only_v1
BEFORE UPDATE OR DELETE ON public.payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.messa_append_only_v1();

-- ── RLS/default-deny + server-only grants ──────────────────────────────────
ALTER TABLE public.restaurant_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.table_order_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.restaurant_tables, public.table_order_lines,
  public.payment_transactions, public.payment_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.restaurant_tables TO service_role;
GRANT SELECT, INSERT ON public.table_order_lines, public.payment_transactions,
  public.payment_allocations TO service_role;

REVOKE ALL ON FUNCTION public.messa_prepare_table_order_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_snapshot_order_lines_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_append_only_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_open_session_v1(uuid,text,uuid,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.messa_prepare_table_order_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_snapshot_order_lines_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_append_only_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_open_session_v1(uuid,text,uuid,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_save_table_v1(uuid,text,uuid,integer,text,integer,numeric,numeric,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.messa_post_payment_v1(uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid[],jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.begin_service_session_close(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_service_session_close(text,text) TO service_role;

COMMENT ON TABLE public.restaurant_tables IS
  'Mesa floor configuration. A Mesa is free whenever it has no open account session.';
COMMENT ON TABLE public.table_sessions IS
  'Immutable Mesa account lifecycle. Full payment closes the account and frees the Mesa immediately; any later order opens a new session id.';
COMMENT ON TABLE public.table_order_lines IS
  'Immutable per-unit settlement snapshot generated atomically with every table command.';
COMMENT ON TABLE public.payment_transactions IS
  'Append-only money movements. One method per transaction; mixed-method table totals are the sum of transactions.';
COMMENT ON TABLE public.payment_allocations IS
  'Append-only distribution of a transaction across immutable per-unit table charges.';

COMMIT;
