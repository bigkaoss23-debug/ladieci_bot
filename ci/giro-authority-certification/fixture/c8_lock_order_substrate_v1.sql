-- C8 real-body harness substrate: adapts the frozen-tree fixture DB so the REAL intake / Mesa / close bodies can run.
-- Table shapes below are read from the staging catalog (SELECT-only catalog reads on staging, see DELIVERY_ECONOMY_V1_C8_REAL_BODY_DEADLOCK_AUDIT_2026-09-24.md) -- nothing here is a product function.
SET ROLE postgres;

CREATE TABLE IF NOT EXISTS public.auth_audit (
  id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), event text NOT NULL, target_actor text, by_actor text, ip_hash text, meta jsonb NOT NULL DEFAULT '{}'::jsonb);

-- table_sessions: two-column fixture stub -> live shape
ALTER TABLE public.table_sessions
  ADD COLUMN IF NOT EXISTS table_ref text, ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS assigned_waiter_actor text, ADD COLUMN IF NOT EXISTS opened_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS closed_at timestamptz, ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS created_by text, ADD COLUMN IF NOT EXISTS updated_by text,
  ADD COLUMN IF NOT EXISTS table_id uuid, ADD COLUMN IF NOT EXISTS service_session_id uuid REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS covers_total integer, ADD COLUMN IF NOT EXISTS next_command_number integer NOT NULL DEFAULT 1, ADD COLUMN IF NOT EXISTS settled_at timestamptz;

-- table_order_lines: bare FK target -> live shape
ALTER TABLE public.table_order_lines
  ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id), ADD COLUMN IF NOT EXISTS source_line_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS source_line_index integer NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS unit_index integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT 'fixture line', ADD COLUMN IF NOT EXISTS product_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS gross_amount numeric NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS discount_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_amount numeric NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN IF NOT EXISTS economic_period_kind text;
UPDATE public.table_order_lines SET workspace_id = (SELECT id FROM public.workspaces LIMIT 1) WHERE workspace_id IS NULL;

-- business_day_lifecycle_state / service_session_state: live shape + live FKs (SC4)
ALTER TABLE public.business_day_lifecycle_state
  ADD COLUMN IF NOT EXISTS current_business_day_id uuid REFERENCES public.business_days(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS current_ticket_epoch integer,
  ADD COLUMN IF NOT EXISTS recent_closed_business_day_id uuid REFERENCES public.business_days(id) ON DELETE RESTRICT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_day_lifecycle_state_current_period_id_fkey') THEN
    ALTER TABLE public.business_day_lifecycle_state ADD CONSTRAINT business_day_lifecycle_state_current_period_id_fkey FOREIGN KEY (current_period_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_session_state_current_session_id_fkey') THEN
    ALTER TABLE public.service_session_state ADD CONSTRAINT service_session_state_current_session_id_fkey FOREIGN KEY (current_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_session_audit_service_session_id_fkey') THEN
    ALTER TABLE public.service_session_audit ADD CONSTRAINT service_session_audit_service_session_id_fkey FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ordenes_service_session_id_fkey') THEN
    ALTER TABLE public.ordenes ADD CONSTRAINT ordenes_service_session_id_fkey FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ordenes_table_session_id_fkey') THEN
    ALTER TABLE public.ordenes ADD CONSTRAINT ordenes_table_session_id_fkey FOREIGN KEY (table_session_id) REFERENCES public.table_sessions(id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.restaurant_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id), name text, table_number integer, display_name text, active boolean NOT NULL DEFAULT true, capacity integer,
  created_by text, updated_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.table_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE RESTRICT, table_session_id uuid REFERENCES public.table_sessions(id) ON DELETE RESTRICT,
  status text, updated_at timestamptz);
CREATE TABLE IF NOT EXISTS public.service_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), service_session_id uuid NOT NULL REFERENCES public.service_sessions(id) ON DELETE RESTRICT, order_id text, status text, created_at timestamptz NOT NULL DEFAULT now());
-- FKs the fixture omitted vs the staging catalog (SC4): implicit FOR KEY SHARE locks must be the live ones
ALTER TABLE public.auth_actors ADD CONSTRAINT auth_actors_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE RESTRICT;
ALTER TABLE public.service_session_state ADD CONSTRAINT service_session_state_recent_closed_session_id_fkey FOREIGN KEY (recent_closed_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.service_sessions ADD CONSTRAINT service_sessions_rollover_source_session_id_fkey FOREIGN KEY (rollover_source_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.table_order_lines ADD CONSTRAINT table_order_lines_service_session_id_fkey FOREIGN KEY (service_session_id) REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT table_order_lines_table_session_id_fkey FOREIGN KEY (table_session_id) REFERENCES public.table_sessions(id) ON DELETE RESTRICT;
ALTER TABLE public.service_sessions DROP CONSTRAINT service_sessions_business_day_id_fkey;
ALTER TABLE public.service_sessions ADD CONSTRAINT service_sessions_business_day_id_fkey FOREIGN KEY (business_day_id) REFERENCES public.business_days(id) ON DELETE RESTRICT;
-- harness-only statement-level write-audit triggers of the frozen fixture: NOT on staging; removed so nothing but the live triggers exists
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['ordenes','order_entities','order_obligations','order_financial_events','payment_transactions','config'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS zz_fixture_write_audit ON public.%I', t); END LOOP; END $$;
RESET ROLE;
