-- EPHEMERAL FIXTURE -- a staging-shaped subset for the Giro Authority W3 certification.
-- Never applied anywhere but a throwaway PostgreSQL 17 database. Run as the cluster
-- superuser against a fresh database owned by postgres; roles are created by the harness.
--
-- Faithful to the staging catalog read on 2026-09-14 (SELECT-only):
--   * ordenes: all 68 live columns, FORCE RLS, public read policy, BEFORE INSERT trigger
--     names/order, raw manual_giro_id FK;
--   * manual_giros: live columns and constraints, RLS on (not forced), the residual
--     anon/authenticated ACL left by the default privileges;
--   * order_entities: live shape and ACL; default privileges of owner postgres in public
--     (tables/sequences/functions granted to anon, authenticated, service_role).
-- Deliberate simplifications (documented, not product code): the three BEFORE INSERT
-- functions keep their names, order and contract but not their full bodies
-- (resolve_order_intake_context_v1 is out of scope); economic tables are stubs used only
-- to prove that the Authority never writes them.

SET ROLE postgres;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.workspaces (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'fixture'
);
CREATE TABLE public.business_days (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date      date        NOT NULL UNIQUE,
  opened_at          timestamptz NOT NULL DEFAULT now(),
  opened_by          text        NOT NULL DEFAULT 'fixture',
  open_source        text        NOT NULL DEFAULT 'fixture',
  ticket_epoch       integer     NOT NULL DEFAULT 1,
  next_ticket_number integer     NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.service_sessions (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date              date        NOT NULL,
  opened_at                  timestamptz NOT NULL DEFAULT now(),
  closed_at                  timestamptz NULL,
  status                     text        NOT NULL,
  opened_by                  text        NOT NULL DEFAULT 'fixture',
  closed_by                  text        NULL,
  open_source                text        NOT NULL DEFAULT 'fixture',
  close_source               text        NULL,
  close_reason               text        NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  service_kind               text        NULL,
  next_order_number          integer     NOT NULL DEFAULT 1,
  rollover_source_session_id uuid        NULL,
  rolled_over_at             timestamptz NULL,
  business_day_id            uuid        NOT NULL REFERENCES public.business_days(id),
  lifecycle_semantics        text        NOT NULL DEFAULT 'v3'
);
CREATE TABLE public.table_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id)
);
CREATE TABLE public.order_entities (
  order_uid          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES public.workspaces(id),
  display_order_id   text        NOT NULL,
  service_session_id uuid        NOT NULL REFERENCES public.service_sessions(id),
  table_session_id   uuid        NULL REFERENCES public.table_sessions(id),
  business_day_id    uuid        NOT NULL REFERENCES public.business_days(id),
  ticket_epoch       integer     NULL,
  ticket_number      integer     NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text        NULL
);
CREATE TABLE public.auth_actors (
  actor text PRIMARY KEY
);
CREATE TABLE public.manual_giros (
  id             text        PRIMARY KEY,
  seq            integer     NOT NULL,
  giro_day       date        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text        NULL,
  dissolved_at   timestamptz NULL,
  hora_ref       text        NULL,
  anchor_order_id text       NULL,
  entrega_ref    text        NULL,
  salida_ref     text        NULL,
  plan_source    text        NULL,
  computed_at    timestamptz NULL,
  assigned_actor text        NULL,
  CONSTRAINT manual_giros_day_seq_unique UNIQUE (giro_day, seq),
  CONSTRAINT manual_giros_assigned_actor_chk CHECK (((assigned_actor IS NULL) OR (assigned_actor = 'rider'::text))),
  CONSTRAINT manual_giros_assigned_actor_fkey FOREIGN KEY (assigned_actor) REFERENCES public.auth_actors(actor) ON DELETE RESTRICT,
  CONSTRAINT manual_giros_salida_plan_chk CHECK ((((salida_ref IS NULL) AND (plan_source IS NULL) AND (computed_at IS NULL)) OR ((salida_ref ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text) AND (plan_source = 'proxy_max_forno'::text) AND (computed_at IS NOT NULL))))
);
ALTER TABLE public.auth_actors ADD COLUMN active_manual_giro_id text NULL
  REFERENCES public.manual_giros(id) ON DELETE SET NULL;

CREATE TABLE public.ordenes (
  id text PRIMARY KEY, nombre text, tel text, wa_id text, canal text, items jsonb, nota text,
  -- language-guard: allow-legacy nota_cucina/cucina_check are existing ordenes column names reproduced verbatim from the staging catalog
  nota_cucina text, hora text DEFAULT ''::text, estado text DEFAULT 'EN_COCINA'::text, ts bigint,
  llegado boolean, created_at timestamptz DEFAULT now(),
  -- language-guard: allow-legacy cucina_check and tipo_consegna (default RITIRO) are existing ordenes columns reproduced verbatim
  cucina_check jsonb, tipo_consegna text DEFAULT 'RITIRO'::text,
  direccion text, direccion_note text, repartidor text, hora_salida bigint, hora_entrega bigint,
  cobrado boolean, zona text, zona_lat double precision, zona_lon double precision,
  zona_manuale boolean, ya_pagado boolean, metodo_pago text, delivery_fee numeric, totale numeric,
  forzado boolean, durata_andata_min integer, geo_source text, durata_google_min integer,
  durata_haversine_min integer, client_req_id text, cliente_id bigint, forno_out text,
  ui_offset_min integer, descuento_tipo text, descuento_valor numeric, descuento_importe numeric,
  listo_origin text, listo_actor text, listo_at timestamptz,
  manual_giro_id text NULL REFERENCES public.manual_giros(id) ON DELETE SET NULL,
  salida_driver_estimada text, entrega_estimada text, retraso_estimado_min integer,
  conflicto_driver boolean, updated_at timestamptz, confirmado_at timestamptz,
  en_cocina_at timestamptz, en_entrega_at timestamptz, retirado_at timestamptz,
  completado_at timestamptz, cancelado_at timestamptz, pending_giro_intent jsonb,
  refunded boolean, service_session_id uuid, service_order_number integer,
  table_session_id uuid, table_number_snapshot integer, table_name_snapshot text,
  table_command_number integer, table_covers_total_input integer,
  order_uid uuid NULL REFERENCES public.order_entities(order_uid),
  initial_payment_intent jsonb
);
CREATE UNIQUE INDEX ordenes_order_uid_uq ON public.ordenes (order_uid) WHERE order_uid IS NOT NULL;

CREATE TABLE public.config (chiave text PRIMARY KEY, valore text);
CREATE TABLE public.delivery_logs (
  -- language-guard: allow-legacy n_ordini is the existing delivery_logs column written verbatim by the live close_rider_trip
  id bigserial PRIMARY KEY, zona text, n_ordini integer, partito_alle text,
  ultimo_entregado text, rientro_stimato text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.conv    (id bigserial PRIMARY KEY, wa_id text);
CREATE TABLE public.wa_msgs (id bigserial PRIMARY KEY, wa_id text);

-- Economic stubs: only here so N14 can prove the Authority never writes them.
CREATE TABLE public.order_obligations      (id bigserial PRIMARY KEY, order_uid uuid, amount_cents bigint, source text);
CREATE TABLE public.order_financial_events (id bigserial PRIMARY KEY, order_id text, kind text, amount numeric);
CREATE TABLE public.payment_transactions   (id bigserial PRIMARY KEY, order_uid uuid, amount_cents bigint);

-- Staging-equivalent ACL residue and RLS.
REVOKE ALL ON public.ordenes FROM anon, authenticated;
GRANT SELECT ON public.ordenes TO anon, authenticated;
ALTER TABLE public.ordenes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ordenes FORCE ROW LEVEL SECURITY;
CREATE POLICY ordenes_public_read_fixture ON public.ordenes FOR SELECT TO anon, authenticated USING (true);
ALTER TABLE public.manual_giros ENABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.manual_giros FROM anon, authenticated;
REVOKE ALL ON public.order_entities FROM PUBLIC, anon, authenticated;
ALTER TABLE public.order_entities ENABLE ROW LEVEL SECURITY;

-- Singleton workspace + the BEFORE INSERT chain (names and order as on staging).
INSERT INTO public.workspaces (name) VALUES ('fixture-singleton');

CREATE FUNCTION public.mesa_singleton_workspace_v1() RETURNS uuid
LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT id FROM public.workspaces ORDER BY name LIMIT 1 $function$;

CREATE FUNCTION public.mesa_prepare_table_order_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$ BEGIN NEW.table_covers_total_input := NULL; RETURN NEW; END $function$;

-- Fixture deviation: an explicit service_session_id is accepted (tests need several
-- sessions); staging derives it from the intake context and refuses a mismatch.
CREATE FUNCTION public.service_session_assign_order() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.service_session_id IS NULL THEN
    SELECT id INTO NEW.service_session_id FROM public.service_sessions WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1;
    IF NEW.service_session_id IS NULL THEN
      RAISE EXCEPTION 'ORDER_INTAKE_REJECTED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  UPDATE public.service_sessions SET next_order_number = next_order_number + 1, updated_at = now()
   WHERE id = NEW.service_session_id
  RETURNING next_order_number - 1 INTO NEW.service_order_number;
  RETURN NEW;
END $function$;

CREATE FUNCTION public.order_entity_anchor_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_workspace uuid; v_business_day uuid; v_epoch integer; v_ticket integer; v_uid uuid;
BEGIN
  IF NEW.service_session_id IS NULL THEN RAISE EXCEPTION 'ORDER_WITHOUT_SERVICE_SESSION' USING ERRCODE = 'P0001'; END IF;
  IF NEW.order_uid IS NOT NULL THEN RAISE EXCEPTION 'ORDER_UID_FORGERY' USING ERRCODE = 'P0001'; END IF;
  SELECT business_day_id INTO v_business_day FROM public.service_sessions WHERE id = NEW.service_session_id;
  IF v_business_day IS NULL THEN RAISE EXCEPTION 'SERVICE_PERIOD_WITHOUT_BUSINESS_DAY' USING ERRCODE = 'P0001'; END IF;
  IF NEW.table_session_id IS NOT NULL THEN
    SELECT workspace_id INTO v_workspace FROM public.table_sessions WHERE id = NEW.table_session_id;
    IF v_workspace IS NULL THEN RAISE EXCEPTION 'MESA_SESSION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  ELSE
    v_workspace := public.mesa_singleton_workspace_v1();
  END IF;
  UPDATE public.business_days SET next_ticket_number = next_ticket_number + 1, updated_at = now()
   WHERE id = v_business_day RETURNING next_ticket_number - 1, ticket_epoch INTO v_ticket, v_epoch;
  INSERT INTO public.order_entities (workspace_id, display_order_id, service_session_id, table_session_id,
                                     business_day_id, ticket_epoch, ticket_number, created_at)
  VALUES (v_workspace, NEW.id, NEW.service_session_id, NEW.table_session_id, v_business_day, v_epoch, v_ticket,
          COALESCE(NEW.created_at, now()))
  RETURNING order_uid INTO v_uid;
  NEW.order_uid := v_uid;
  RETURN NEW;
END $function$;

CREATE FUNCTION public.order_obligation_anchor_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.order_obligations (order_uid, amount_cents, source)
  VALUES (NEW.order_uid, COALESCE((NEW.totale * 100)::bigint, 0), 'order_creation_fixture');
  RETURN NULL;
END $function$;

CREATE FUNCTION public.service_session_immutable_order() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.service_session_id IS DISTINCT FROM OLD.service_session_id THEN
    RAISE EXCEPTION 'SERVICE_SESSION_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $function$;

CREATE TRIGGER mesa_prepare_table_order_v1 BEFORE INSERT ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.mesa_prepare_table_order_v1();
CREATE TRIGGER ordenes_assign_service_session BEFORE INSERT ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.service_session_assign_order();
CREATE TRIGGER ordenes_order_entity_anchor_v1 BEFORE INSERT ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_entity_anchor_v1();
CREATE TRIGGER ordenes_order_obligation_anchor_v1 AFTER INSERT ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.order_obligation_anchor_v1();
CREATE TRIGGER ordenes_service_session_immutable BEFORE UPDATE ON public.ordenes
  FOR EACH ROW EXECUTE FUNCTION public.service_session_immutable_order();

REVOKE ALL ON FUNCTION public.order_entity_anchor_v1() FROM PUBLIC, anon, authenticated;

CREATE PUBLICATION supabase_realtime FOR TABLE public.ordenes, public.conv, public.wa_msgs;

RESET ROLE;

-- Write audit (superuser-owned, outside public): statement-level, fires even for
-- zero-row statements, so any Authority statement against these tables is visible.
CREATE SCHEMA fixture_audit;
CREATE TABLE fixture_audit.writes (
  id bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL,
  txid bigint NOT NULL DEFAULT txid_current(), at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION fixture_audit.record_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO fixture_audit.writes (tbl, op) VALUES (TG_TABLE_NAME, TG_OP);
  RETURN NULL;
END $function$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ordenes', 'order_obligations', 'order_financial_events', 'payment_transactions', 'config', 'order_entities'] LOOP
    EXECUTE format('CREATE TRIGGER zz_fixture_write_audit AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION fixture_audit.record_write()', t);
  END LOOP;
END $$;
