-- GIRO AUTHORITY V1 -- Planner wave W3 candidate. DORMANT. NOT A LEDGER MIGRATION YET.
--
-- STATUS
--   PLANNER_NEXT_MIGRATION_CANDIDATE = 130 (a candidate only: NOT reserved, NOT assigned).
--   FINAL_MIGRATION_NUMBER = DEFERRED. Ledger tip is 126; the S workstream holds 127-129
--   (tests/orderInitialPaymentDigestSchemaFixMigration.test.js CASE L still forbids any
--   _migration_127 file) and nothing beyond that is reserved with its owner. This file
--   therefore lives outside migrations/ (same precedent as the F-10 candidate resolver in
--   ci/f10-certification/resolver/) and has no MIGRATION_MANIFEST.md row. Once a number
--   is reserved it moves verbatim into migrations/ together with its manifest row.
--   Certified only on an ephemeral PostgreSQL 17 (ci/giro-authority-certification/harness).
--   Never applied to staging or production by W3.
--
-- WHAT IT CREATES
--   1. Schema giro_authority. Not exposed by PostgREST (staging exposes only
--      public, graphql_public: PGRST106 probe, 2026-09-14) and, independently of that,
--      no USAGE for PUBLIC / anon / authenticated / service_role.
--   2. giro_authority.giro_members: the private membership (order_uid -> giro).
--      For the Authority it replaces ordenes.manual_giro_id, which this file does not
--      touch (retired by W4 CHECK NULL, then W7 DROP).
--   3. giro_authority.giro_intents: one intent per order (TB-1 model 3, TB-1A).
--   4. Three additive nullable columns on public.manual_giros (business_date,
--      anchor_order_uid, dissolved_by). manual_giros stays the canonical giro fact.
--   5. Private helpers and ONE derivation (derive_giros_v1), used by every command and
--      by the projection: there is no second definition of giro state anywhere.
--   6. The capture function giro_authority.capture_giro_intent_v1(). NO trigger is
--      created here; the trigger is the W5 artifact giro_intent_capture_trigger_v1.W5_DORMANT.sql.
--   7. Public entry points, SECURITY DEFINER, owner postgres, EXECUTE for service_role only:
--      giro_authority_create_v1, giro_authority_attach_v1, giro_authority_detach_v1,
--      giro_authority_move_v1, giro_authority_dissolve_v1, giro_authority_set_hora_ref_v1,
--      giro_authority_consume_intent_v1, giro_projection_v1.
--
-- WHAT IT NEVER DOES
--   No write, trigger, column or constraint on public.ordenes. No write of salida_ref,
--   plan_source or computed_at. No persisted giro_state / completed / closed. Nothing
--   added to any publication. No H1B registry entry. No economic table or function
--   touched. The dispatch lock (LA_DIECI_DRIVER_STATO) is never taken.
--
-- DERIVED GIRO STATE (TB-1 section F; nothing below is persisted)
--   member classes: departed = in the ACTIVE trip snapshot or estado EN_ENTREGA;
--   delivered = RETIRADO / COMPLETADO / legacy literal; pre-departure = EN_COCINA or LISTO
--   and not in the active snapshot. Precedence:
--     dissolved_at set                          -> DISSOLVED (EXPLICIT)
--     any departed member, or giro in snapshot  -> IN_TRIP   (effective = departed + delivered)
--     any delivered member                      -> DONE      (effective = delivered)
--     >= 2 pre-departure members in scope       -> PLANNED   (effective = those members)
--     >= 2 pre-departure members, not in scope  -> DISSOLVED (SERVICE_CLOSED)
--     otherwise                                 -> DISSOLVED (BELOW_MIN_MEMBERS)
--   salida = hora_ref (OPERATOR), else the latest service-day forno_out of the effective
--   members (PROXY_MAX_FORNO), else none. Business Day boundary 04:00 (zones.toServiceDayMin).
--
-- LOCK PROTOCOL (every command, always in this order, never the dispatch lock)
--   L1 public.manual_giros rows FOR UPDATE, ascending id    (the serialization point; W4's
--      start_rider_trip must take the same row first, TB-1A amendment 7)
--   L2 per-order advisory xact locks, ascending order_uid, two-int4 key space
--      (disjoint from the single-int8 dispatch key)
--   L3 the intent row FOR UPDATE                             (consume only, CAS)
--   L4 public.ordenes rows of the ENTERING orders FOR SHARE, ascending order_uid
--      (no row version, no trigger, no Realtime event)

BEGIN;

-- 0. Predecessor, drift and data preconditions (D5) ----------------------------------
DO $$
DECLARE
  v_raw_members    bigint;
  v_raw_intents    bigint;
  v_legacy_giros   bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'giro_authority') THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: schema giro_authority already exists -- resolve drift first';
  END IF;
  IF to_regclass('public.manual_giros') IS NULL OR to_regclass('public.order_entities') IS NULL
     OR to_regclass('public.ordenes') IS NULL OR to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.config') IS NULL THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: a predecessor relation is missing -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'manual_giros'
                AND column_name IN ('business_date', 'anchor_order_uid', 'dissolved_by')) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: manual_giros already carries an Authority column -- resolve drift first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ordenes'
                    AND column_name = 'pending_giro_intent' AND data_type = 'jsonb') THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: ordenes.pending_giro_intent (jsonb) is missing -- resolve drift first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication WHERE puballtables) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: a FOR ALL TABLES publication would publish the private relations';
  END IF;

  -- D5: no backfill. Membership held only by the raw column cannot be adopted silently.
  SELECT count(*) INTO v_raw_members FROM public.ordenes WHERE manual_giro_id IS NOT NULL;
  IF v_raw_members > 0 THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: % ordenes rows carry a raw manual_giro_id; an explicit owner-approved copy plan is required first (D5)', v_raw_members;
  END IF;
  SELECT count(*) INTO v_raw_intents FROM public.ordenes WHERE pending_giro_intent IS NOT NULL;
  IF v_raw_intents > 0 THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 refused: % ordenes rows carry a persisted pending_giro_intent; the input must be NULL at rest (D5, TB-1A)', v_raw_intents;
  END IF;
  SELECT count(*) INTO v_legacy_giros FROM public.manual_giros WHERE dissolved_at IS NULL;
  RAISE NOTICE 'GIRO_AUTHORITY_V1 precondition: raw memberships=0, persisted intents=0, legacy undissolved giros=% (memberless: never effective)', v_legacy_giros;
END $$;

-- 1. Private schema ---------------------------------------------------------------------
CREATE SCHEMA giro_authority AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA giro_authority FROM PUBLIC;
REVOKE ALL ON SCHEMA giro_authority FROM anon, authenticated, service_role;
COMMENT ON SCHEMA giro_authority IS
  'Giro Authority private relations and helpers (Planner W3). Not exposed by PostgREST, no USAGE for API roles. Access only through the public giro_authority_*_v1 / giro_projection_v1 SECURITY DEFINER functions.';

-- 2. Giro record: additive columns on the existing fact table ---------------------------
-- giro_day stays the legacy calendar column; for Authority rows it mirrors business_date
-- (CHECK below), so UNIQUE (giro_day, seq) is also unique per Business Day.
ALTER TABLE public.manual_giros
  ADD COLUMN business_date    date NULL,
  ADD COLUMN anchor_order_uid uuid NULL,
  ADD COLUMN dissolved_by     text NULL;
ALTER TABLE public.manual_giros
  ADD CONSTRAINT manual_giros_anchor_order_uid_fkey
    FOREIGN KEY (anchor_order_uid) REFERENCES public.order_entities(order_uid),
  ADD CONSTRAINT manual_giros_business_date_mirror_chk
    CHECK (business_date IS NULL OR giro_day = business_date),
  ADD CONSTRAINT manual_giros_dissolved_by_chk
    CHECK (dissolved_by IS NULL OR dissolved_at IS NOT NULL);
COMMENT ON COLUMN public.manual_giros.business_date IS
  'Business Day (04:00 boundary) of a Giro Authority giro; NULL for legacy JS giros. giro_day mirrors it.';
COMMENT ON COLUMN public.manual_giros.anchor_order_uid IS
  'Audit only: the anchor order of the giro (Planner ANCHOR target or operator choice). Never an input to derived state.';
COMMENT ON COLUMN public.manual_giros.dissolved_by IS
  'Audit only: actor of the explicit dissolve command. dissolved_at/dissolved_by never encode derived dissolution.';

-- 3. Private membership -----------------------------------------------------------------
CREATE TABLE giro_authority.giro_members (
  order_uid  uuid        PRIMARY KEY REFERENCES public.order_entities(order_uid),
  giro_id    text        NOT NULL REFERENCES public.manual_giros(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text        NOT NULL CHECK (btrim(created_by) <> '')
);
CREATE INDEX giro_members_giro_id_idx ON giro_authority.giro_members (giro_id);
COMMENT ON TABLE giro_authority.giro_members IS
  'At most one membership row per order (PK). Effective membership is derived by giro_authority.derive_giros_v1 only.';

-- 4. Intent entity (one per order) ------------------------------------------------------
CREATE TABLE giro_authority.giro_intents (
  order_uid          uuid        PRIMARY KEY REFERENCES public.order_entities(order_uid),
  target_kind        text        NULL CHECK (target_kind IN ('GIRO', 'ANCHOR')),
  target_ref         text        NULL,
  target_giro_id     text        NULL REFERENCES public.manual_giros(id),
  target_order_uid   uuid        NULL REFERENCES public.order_entities(order_uid),
  target_fingerprint text        NULL,
  order_context      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  captured_at        timestamptz NOT NULL DEFAULT now(),
  business_date      date        NULL,
  actor              text        NULL,
  sv                 bigint      NULL,
  status             text        NOT NULL CHECK (status IN ('PENDING', 'CONSUMED', 'REJECTED', 'EXPIRED')),
  phase              text        NOT NULL CHECK (phase IN ('CAPTURE', 'CONSUME', 'EXPIRY')),
  resolved_at        timestamptz NULL,
  resolved_by        text        NULL,
  resolution_code    text        NULL,
  resulting_giro_id  text        NULL REFERENCES public.manual_giros(id),
  resolution_detail  jsonb       NULL,
  CONSTRAINT giro_intents_state_shape_chk CHECK (
       (status = 'PENDING' AND phase = 'CAPTURE' AND resolved_at IS NULL AND resolution_code IS NULL
        AND resulting_giro_id IS NULL AND target_fingerprint IS NOT NULL
        AND ((target_kind = 'GIRO'   AND target_giro_id   IS NOT NULL AND target_order_uid IS NULL)
          OR (target_kind = 'ANCHOR' AND target_order_uid IS NOT NULL AND target_giro_id   IS NULL)))
    OR (status = 'CONSUMED' AND phase = 'CONSUME' AND resolved_at IS NOT NULL
        AND resolution_code IN ('ATTACHED', 'GIRO_CREATED') AND resulting_giro_id IS NOT NULL)
    OR (status = 'REJECTED' AND resolved_at IS NOT NULL AND resulting_giro_id IS NULL
        AND ((phase = 'CAPTURE' AND resolution_code IN ('CAPTURE_MALFORMED', 'CAPTURE_UNTRUSTED_SOURCE',
                                                        'CAPTURE_NOT_ELIGIBLE', 'CAPTURE_TARGET_NOT_FOUND',
                                                        'CAPTURE_INTERNAL'))
          OR (phase = 'CONSUME' AND resolution_code IN ('TARGET_CHANGED', 'TARGET_DEPARTED', 'TARGET_GONE',
                                                        'ORDER_CHANGED', 'ORDER_NOT_ELIGIBLE', 'SCOPE_UNAVAILABLE',
                                                        'UNVERIFIABLE'))))
    OR (status = 'EXPIRED' AND phase = 'EXPIRY' AND resolved_at IS NOT NULL
        AND resolution_code = 'SERVICE_CLOSED' AND resulting_giro_id IS NULL)
  )
);
CREATE INDEX giro_intents_business_date_idx ON giro_authority.giro_intents (business_date);
COMMENT ON TABLE giro_authority.giro_intents IS
  'One Planner intent per order. PENDING -> CONSUMED | REJECTED | EXPIRED exactly once (guarded). Capture facts are immutable.';

CREATE FUNCTION giro_authority.giro_intents_one_shot_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'GIRO_INTENT_APPEND_ONLY' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'GIRO_INTENT_ALREADY_RESOLVED' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.order_uid IS DISTINCT FROM OLD.order_uid
     OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
     OR NEW.target_ref IS DISTINCT FROM OLD.target_ref
     OR NEW.target_giro_id IS DISTINCT FROM OLD.target_giro_id
     OR NEW.target_order_uid IS DISTINCT FROM OLD.target_order_uid
     OR NEW.target_fingerprint IS DISTINCT FROM OLD.target_fingerprint
     OR NEW.order_context IS DISTINCT FROM OLD.order_context
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.actor IS DISTINCT FROM OLD.actor
     OR NEW.sv IS DISTINCT FROM OLD.sv THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_FACTS_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER giro_intents_one_shot_guard_v1
  BEFORE UPDATE OR DELETE ON giro_authority.giro_intents
  FOR EACH ROW EXECUTE FUNCTION giro_authority.giro_intents_one_shot_guard_v1();

-- 5. Access to the private relations: none for any API role ------------------------------
ALTER TABLE giro_authority.giro_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE giro_authority.giro_members FORCE ROW LEVEL SECURITY;
ALTER TABLE giro_authority.giro_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE giro_authority.giro_intents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON giro_authority.giro_members FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON giro_authority.giro_intents FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE giro_authority.giro_members OWNER TO postgres;
ALTER TABLE giro_authority.giro_intents OWNER TO postgres;

-- 6. Private helpers ---------------------------------------------------------------------
-- Terminal-state literals live in exactly one place each.
CREATE FUNCTION giro_authority.delivered_states_v1()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  -- language-guard: allow-legacy the legacy terminal-state literal of ordenes.estado (same set as rolloverClassifier.TERMINAL_ORDER_STATES)
  SELECT ARRAY['RETIRADO', 'COMPLETADO', 'COMPLETATO']::text[]
$fn$;

CREATE FUNCTION giro_authority.cancelled_states_v1()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  -- language-guard: allow-legacy the legacy forced-close literal of ordenes.estado (same set as rolloverClassifier.TERMINAL_ORDER_STATES)
  SELECT ARRAY['CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO']::text[]
$fn$;

-- "H:MM" / "HH:MM" 24h -> "HH:MM", anything else -> NULL (manualGiros.isValidHoraRef +
-- normalizeHoraRef parity). plpgsql on purpose: no constant folding of the casts.
CREATE FUNCTION giro_authority.hhmm_norm(p_value text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v text;
  h integer;
  m integer;
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  v := btrim(p_value);
  IF v !~ '^[0-9]{1,2}:[0-9]{2}$' THEN RETURN NULL; END IF;
  h := split_part(v, ':', 1)::integer;
  m := split_part(v, ':', 2)::integer;
  IF h > 23 OR m > 59 THEN RETURN NULL; END IF;
  RETURN lpad(h::text, 2, '0') || ':' || lpad(m::text, 2, '0');
END $fn$;

-- Service-day minutes: Business Day boundary 04:00 (zones.toServiceDayMin parity).
CREATE FUNCTION giro_authority.service_day_minutes(p_value text)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v text := giro_authority.hhmm_norm(p_value);
  h integer;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  h := split_part(v, ':', 1)::integer;
  RETURN h * 60 + split_part(v, ':', 2)::integer + CASE WHEN h < 4 THEN 1440 ELSE 0 END;
END $fn$;

-- Trip authority facts, read-only, no lock. available=false means "cannot verify":
-- commands fail closed (UNVERIFIABLE), the projection reports degraded.
CREATE FUNCTION giro_authority.trip_facts_v1()
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_raw    text;
  v_ds     jsonb;
  v_active jsonb;
  v_giros  jsonb;
BEGIN
  SELECT c.valore INTO v_raw FROM public.config c WHERE c.chiave = 'DRIVER_STATO';
  IF NOT FOUND OR v_raw IS NULL OR btrim(v_raw) = '' THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb);
  END IF;
  BEGIN
    v_ds := v_raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('available', false, 'reason', 'DRIVER_STATO_UNPARSEABLE');
  END;
  IF jsonb_typeof(v_ds) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'DRIVER_STATO_NOT_OBJECT');
  END IF;
  v_active := NULLIF(v_ds->'active_trip', 'null'::jsonb);
  IF v_active IS NULL THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(v_active) <> 'object' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'ACTIVE_TRIP_MALFORMED');
  END IF;
  IF (v_active->>'status') IS DISTINCT FROM 'ACTIVE' THEN
    RETURN jsonb_build_object('available', true, 'active', false, 'order_ids', '[]'::jsonb, 'giro_ids', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(v_active->'order_ids') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'ACTIVE_TRIP_MALFORMED');
  END IF;
  v_giros := COALESCE(NULLIF(v_active->'manual_giro_ids', 'null'::jsonb), '[]'::jsonb);
  IF jsonb_typeof(v_giros) <> 'array' THEN
    RETURN jsonb_build_object('available', false, 'reason', 'ACTIVE_TRIP_MALFORMED');
  END IF;
  RETURN jsonb_build_object('available', true, 'active', true, 'trip_id', v_active->>'trip_id',
                            'order_ids', v_active->'order_ids', 'giro_ids', v_giros);
END $fn$;

-- THE derivation. p_scope NULL = scope-free (capture fingerprints only); commands and
-- the projection always pass the operational scope computed by the backend.
CREATE FUNCTION giro_authority.derive_giros_v1(p_giro_ids text[], p_scope uuid[], p_trip jsonb)
RETURNS TABLE (
  giro_id text, seq integer, business_date date, hora_ref text, anchor_order_uid uuid,
  created_at timestamptz, created_by text, dissolved_at timestamptz, dissolved_by text,
  giro_state text, state_reason text,
  effective_order_uids uuid[], effective_order_ids text[], active_order_uids uuid[],
  salida text, salida_source text
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  WITH trip AS (
    SELECT ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'order_ids') = 'array'
                                                       THEN p_trip->'order_ids' ELSE '[]'::jsonb END)) AS order_ids,
           ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'giro_ids') = 'array'
                                                       THEN p_trip->'giro_ids' ELSE '[]'::jsonb END)) AS giro_ids
  ),
  g AS (
    SELECT mg.id, mg.seq, mg.business_date, mg.hora_ref, mg.anchor_order_uid, mg.created_at,
           mg.created_by, mg.dissolved_at, mg.dissolved_by
      FROM public.manual_giros mg
     WHERE mg.id = ANY (p_giro_ids)
  ),
  k AS (
    SELECT gm.giro_id AS g_id, gm.order_uid AS uid, o.id AS oid, o.estado, o.forno_out,
           (o.id IS NOT NULL) AS present,
           COALESCE(o.id = ANY (t.order_ids), false) AS in_active_trip,
           COALESCE(p_scope IS NULL OR o.service_session_id = ANY (p_scope), false) AS in_scope
      FROM giro_authority.giro_members gm
      CROSS JOIN trip t
      LEFT JOIN public.ordenes o ON o.order_uid = gm.order_uid
     WHERE gm.giro_id = ANY (p_giro_ids)
  ),
  kc AS (
    SELECT k.*,
           (k.present AND (k.in_active_trip OR k.estado = 'EN_ENTREGA')) AS departed_live,
           (k.present AND k.estado = ANY (giro_authority.delivered_states_v1())) AS delivered,
           (k.present AND k.estado IN ('EN_COCINA', 'LISTO') AND NOT k.in_active_trip) AS pre_departure
      FROM k
  ),
  a AS (
    SELECT kc.g_id,
           count(*) FILTER (WHERE kc.departed_live)                  AS n_departed,
           count(*) FILTER (WHERE kc.delivered)                      AS n_delivered,
           count(*) FILTER (WHERE kc.pre_departure AND kc.in_scope)  AS n_pre_scope,
           count(*) FILTER (WHERE kc.pre_departure)                  AS n_pre_any
      FROM kc GROUP BY kc.g_id
  ),
  st AS (
    SELECT g.*,
           CASE WHEN g.dissolved_at IS NOT NULL THEN 'DISSOLVED'
                WHEN COALESCE(a.n_departed, 0) > 0 OR g.id = ANY (t.giro_ids) THEN 'IN_TRIP'
                WHEN COALESCE(a.n_delivered, 0) > 0 THEN 'DONE'
                WHEN COALESCE(a.n_pre_scope, 0) >= 2 THEN 'PLANNED'
                ELSE 'DISSOLVED' END AS g_state,
           CASE WHEN g.dissolved_at IS NOT NULL THEN 'EXPLICIT'
                WHEN COALESCE(a.n_departed, 0) > 0 OR g.id = ANY (t.giro_ids) THEN 'DEPARTED'
                WHEN COALESCE(a.n_delivered, 0) > 0 THEN 'DELIVERED'
                WHEN COALESCE(a.n_pre_scope, 0) >= 2 THEN 'OPERATIVE'
                WHEN COALESCE(a.n_pre_any, 0) >= 2 THEN 'SERVICE_CLOSED'
                ELSE 'BELOW_MIN_MEMBERS' END AS g_reason
      FROM g CROSS JOIN trip t LEFT JOIN a ON a.g_id = g.id
  )
  SELECT st.id, st.seq, st.business_date, st.hora_ref, st.anchor_order_uid, st.created_at,
         st.created_by, st.dissolved_at, st.dissolved_by, st.g_state, st.g_reason,
         COALESCE(eff.uids, '{}'::uuid[]), COALESCE(eff.oids, '{}'::text[]), COALESCE(act.uids, '{}'::uuid[]),
         CASE WHEN st.g_state = 'DISSOLVED' THEN NULL
              WHEN giro_authority.hhmm_norm(st.hora_ref) IS NOT NULL THEN giro_authority.hhmm_norm(st.hora_ref)
              ELSE px.salida END,
         CASE WHEN st.g_state = 'DISSOLVED' THEN 'NONE'
              WHEN giro_authority.hhmm_norm(st.hora_ref) IS NOT NULL THEN 'OPERATOR'
              WHEN px.salida IS NOT NULL THEN 'PROXY_MAX_FORNO'
              ELSE 'NONE' END
    FROM st
    LEFT JOIN LATERAL (
      SELECT array_agg(kc.uid ORDER BY kc.uid) AS uids, array_agg(kc.oid ORDER BY kc.uid) AS oids
        FROM kc
       WHERE kc.g_id = st.id
         AND (   (st.g_state = 'PLANNED' AND kc.pre_departure AND kc.in_scope)
              OR (st.g_state = 'IN_TRIP' AND (kc.departed_live OR kc.delivered))
              OR (st.g_state = 'DONE'    AND kc.delivered))
    ) eff ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(kc.uid ORDER BY kc.uid) AS uids
        FROM kc
       WHERE kc.g_id = st.id AND kc.present AND kc.estado IN ('EN_COCINA', 'LISTO', 'EN_ENTREGA')
    ) act ON true
    LEFT JOIN LATERAL (
      SELECT giro_authority.hhmm_norm(kc.forno_out) AS salida
        FROM kc
       WHERE kc.g_id = st.id AND kc.uid = ANY (COALESCE(eff.uids, '{}'::uuid[]))
         AND giro_authority.service_day_minutes(kc.forno_out) IS NOT NULL
       ORDER BY giro_authority.service_day_minutes(kc.forno_out) DESC
       LIMIT 1
    ) px ON true
$fn$;

-- Current facts of a set of orders (one row per requested uid, present=false if gone).
CREATE FUNCTION giro_authority.order_facts_v1(p_order_uids uuid[], p_trip jsonb)
RETURNS TABLE (
  order_uid uuid, order_id text, present boolean, estado text, delivery_type text,
  table_session_id uuid, service_session_id uuid, business_date date, zona text, hora text,
  in_active_trip boolean
)
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT u.uid, o.id, (o.id IS NOT NULL), o.estado,
         -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name, read-only here
         upper(COALESCE(o.tipo_consegna, '')),
         o.table_session_id, o.service_session_id, ss.business_date, o.zona, o.hora,
         COALESCE(o.id IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(p_trip->'order_ids') = 'array'
                                                                 THEN p_trip->'order_ids' ELSE '[]'::jsonb END)), false)
    FROM unnest(p_order_uids) AS u(uid)
    LEFT JOIN public.ordenes o ON o.order_uid = u.uid
    LEFT JOIN public.service_sessions ss ON ss.id = o.service_session_id
$fn$;

-- The giro in which an order is EFFECTIVE (NULL = single / released).
CREATE FUNCTION giro_authority.order_effective_giro_v1(p_order_uid uuid, p_scope uuid[], p_trip jsonb)
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT d.giro_id
    FROM giro_authority.giro_members gm
    CROSS JOIN LATERAL giro_authority.derive_giros_v1(ARRAY[gm.giro_id], p_scope, p_trip) d
   WHERE gm.order_uid = p_order_uid
     AND p_order_uid = ANY (d.effective_order_uids)
$fn$;

-- Server-computed CAS fingerprint of an intent target. Scope-free and trip-free on
-- purpose: capture has no operational scope, and departure is checked separately.
CREATE FUNCTION giro_authority.target_fingerprint_v1(p_kind text, p_giro_id text, p_anchor_uid uuid)
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT encode(sha256(convert_to(
           CASE p_kind
             WHEN 'GIRO' THEN 'GIRO|' || COALESCE(p_giro_id, '') || '|' ||
               COALESCE((SELECT array_to_string(d.active_order_uids, ',')
                           FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], NULL, '{}'::jsonb) d), 'GONE')
             WHEN 'ANCHOR' THEN 'ANCHOR|' || COALESCE(p_anchor_uid::text, '') || '|' ||
               COALESCE(giro_authority.order_effective_giro_v1(p_anchor_uid, NULL, '{}'::jsonb), 'NONE')
           END, 'UTF8')), 'hex')
$fn$;

-- NULL when the order may enter a giro now, else the refusal reason.
CREATE FUNCTION giro_authority.member_refusal_v1(
  p_present boolean, p_estado text, p_delivery_type text, p_table_session uuid,
  p_in_active_trip boolean, p_session uuid, p_scope uuid[])
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
    WHEN NOT COALESCE(p_present, false) THEN 'ORDER_NOT_FOUND'
    WHEN p_delivery_type IS DISTINCT FROM 'DOMICILIO' THEN 'NOT_DOMICILIO'
    WHEN p_table_session IS NOT NULL THEN 'TABLE_ORDER'
    WHEN COALESCE(p_in_active_trip, false) OR p_estado = 'EN_ENTREGA' THEN 'DEPARTED'
    WHEN p_estado IS NULL OR p_estado NOT IN ('EN_COCINA', 'LISTO') THEN 'NOT_OPERATIVE_STATE'
    WHEN NOT COALESCE(p_session = ANY (p_scope), false) THEN 'OUT_OF_SCOPE'
  END
$fn$;

CREATE FUNCTION giro_authority.scope_valid_v1(p_scope uuid[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p_scope IS NOT NULL AND cardinality(p_scope) > 0 AND array_position(p_scope, NULL) IS NULL
$fn$;

CREATE FUNCTION giro_authority.actor_valid_v1(p_actor text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p_actor IS NOT NULL AND btrim(p_actor) <> '' AND length(btrim(p_actor)) <= 128
$fn$;

CREATE FUNCTION giro_authority.refusal_v1(p_code text, p_detail jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT jsonb_build_object('ok', false, 'code', p_code) || COALESCE(p_detail, '{}'::jsonb)
$fn$;

-- L2: per-order advisory xact locks, ascending order_uid, two-int4 key space.
CREATE FUNCTION giro_authority.lock_orders_v1(p_order_uids uuid[])
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_uid uuid;
BEGIN
  FOR v_uid IN SELECT DISTINCT x FROM unnest(p_order_uids) AS x WHERE x IS NOT NULL ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtext('giro_authority.order'), hashtext(v_uid::text));
  END LOOP;
END $fn$;

-- The only INSERT into public.manual_giros made by the Authority. Seq is allocated
-- under a per-Business-Day advisory lock; ON CONFLICT covers a concurrent legacy writer.
CREATE FUNCTION giro_authority.insert_giro_v1(p_business_date date, p_hora_ref text, p_anchor uuid, p_actor text)
RETURNS text
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_seq     integer;
  v_id      text;
  v_attempt integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('giro_authority.seq'), hashtext(p_business_date::text));
  SELECT COALESCE(max(mg.seq), 0) INTO v_seq FROM public.manual_giros mg WHERE mg.giro_day = p_business_date;
  LOOP
    v_attempt := v_attempt + 1;
    v_seq := v_seq + 1;
    v_id := 'mg_' || to_char(p_business_date, 'YYMMDD') || '_' || v_seq::text;
    INSERT INTO public.manual_giros (id, seq, giro_day, business_date, created_by, hora_ref, anchor_order_uid)
    VALUES (v_id, v_seq, p_business_date, p_business_date, btrim(p_actor), p_hora_ref, p_anchor)
    ON CONFLICT DO NOTHING;
    IF FOUND THEN RETURN v_id; END IF;
    IF v_attempt >= 5 THEN
      RAISE EXCEPTION 'GIRO_SEQ_ALLOCATION_FAILED' USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END $fn$;

-- The only membership writer. Callers have proven, under L1/L2, that any existing
-- row for this order is NOT effective (never an implicit move).
CREATE FUNCTION giro_authority.put_member_v1(p_order_uid uuid, p_giro_id text, p_actor text)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $fn$
  INSERT INTO giro_authority.giro_members (order_uid, giro_id, created_by)
  VALUES (p_order_uid, p_giro_id, btrim(p_actor))
  ON CONFLICT (order_uid) DO UPDATE
    SET giro_id = EXCLUDED.giro_id, created_at = now(), created_by = EXCLUDED.created_by
$fn$;

CREATE FUNCTION giro_authority.intent_outcome_v1(p_intent giro_authority.giro_intents, p_replay boolean)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT jsonb_build_object(
    'ok', true, 'code', p_intent.status, 'status', p_intent.status,
    'resolution_code', p_intent.resolution_code, 'resulting_giro_id', p_intent.resulting_giro_id,
    'target_kind', p_intent.target_kind, 'target_ref', p_intent.target_ref,
    'resolved_at', p_intent.resolved_at, 'replay', p_replay)
$fn$;

-- PENDING -> terminal, exactly once (CAS on status; the caller holds the row lock).
CREATE FUNCTION giro_authority.resolve_intent_v1(
  p_order_uid uuid, p_status text, p_phase text, p_code text, p_giro_id text, p_actor text, p_detail jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_row giro_authority.giro_intents;
BEGIN
  UPDATE giro_authority.giro_intents gi
     SET status = p_status, phase = p_phase, resolution_code = p_code, resulting_giro_id = p_giro_id,
         resolved_at = now(), resolved_by = btrim(p_actor), resolution_detail = p_detail
   WHERE gi.order_uid = p_order_uid AND gi.status = 'PENDING'
  RETURNING gi.* INTO v_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAS_LOST' USING ERRCODE = 'P0001';
  END IF;
  RETURN giro_authority.intent_outcome_v1(v_row, false);
END $fn$;

-- 7. Intent capture, DORMANT ---------------------------------------------------------------
-- Destined to be the LAST BEFORE INSERT trigger on public.ordenes (W5). Not installed here.
-- Contract (TB-1A amendment 2, D6): the input is nulled first and never survives in any
-- row version; every input yields at most one record, PENDING or REJECTED CAPTURE_*;
-- no exception ever escapes, so the order is always created. Diagnostic persistence is
-- best effort: if even the CAPTURE_INTERNAL record fails, a WARNING is the only trace.
-- Input v1 (built by the operator HTTP handler from authCtx, never by the bot):
--   {"v":1,"source":"operator_http","actor":"...","sv":N,"target_kind":"GIRO"|"ANCHOR","target_ref":"..."}
--   GIRO   -> target_ref = manual_giros.id of an Authority giro of the same Business Day
--   ANCHOR -> target_ref = ordenes.id of an order of the same service session
CREATE FUNCTION giro_authority.capture_giro_intent_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_in            jsonb := NEW.pending_giro_intent;
  v_code          text;
  v_kind          text;
  v_ref           text;
  v_actor         text;
  v_sv            bigint;
  v_giro_id       text;
  v_anchor_uid    uuid;
  v_business_date date;
  v_fingerprint   text;
  v_delivery_type text;
  v_context       jsonb;
  v_sqlstate      text;
BEGIN
  NEW.pending_giro_intent := NULL;
  IF v_in IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    -- language-guard: allow-legacy tipo_consegna is the existing ordenes column name, read-only here
    v_delivery_type := upper(COALESCE(NEW.tipo_consegna, ''));
    v_context := jsonb_build_object('zona', NEW.zona, 'hora', NEW.hora, 'delivery_type', v_delivery_type,
                                    'service_session_id', NEW.service_session_id);
    SELECT ss.business_date INTO v_business_date
      FROM public.service_sessions ss WHERE ss.id = NEW.service_session_id;

    IF jsonb_typeof(v_in) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_in->'v') IS DISTINCT FROM 'number' OR (v_in->>'v') IS DISTINCT FROM '1'
       OR jsonb_typeof(v_in->'target_kind') IS DISTINCT FROM 'string'
       OR (v_in->>'target_kind') NOT IN ('GIRO', 'ANCHOR')
       OR jsonb_typeof(v_in->'target_ref') IS DISTINCT FROM 'string'
       OR length(btrim(v_in->>'target_ref')) NOT BETWEEN 1 AND 64 THEN
      v_code := 'CAPTURE_MALFORMED';
    ELSE
      v_kind := v_in->>'target_kind';
      v_ref := btrim(v_in->>'target_ref');
      IF (v_in->>'source') IS DISTINCT FROM 'operator_http'
         OR jsonb_typeof(v_in->'source') IS DISTINCT FROM 'string'
         OR jsonb_typeof(v_in->'actor') IS DISTINCT FROM 'string'
         OR NOT giro_authority.actor_valid_v1(v_in->>'actor')
         OR jsonb_typeof(v_in->'sv') IS DISTINCT FROM 'number'
         OR (v_in->>'sv') !~ '^[0-9]{1,18}$' THEN
        v_code := 'CAPTURE_UNTRUSTED_SOURCE';
      ELSE
        v_actor := btrim(v_in->>'actor');
        v_sv := (v_in->>'sv')::bigint;
        IF v_delivery_type <> 'DOMICILIO' OR NEW.table_session_id IS NOT NULL
           OR NEW.service_session_id IS NULL OR v_business_date IS NULL THEN
          v_code := 'CAPTURE_NOT_ELIGIBLE';
        ELSIF v_kind = 'GIRO' THEN
          SELECT mg.id INTO v_giro_id
            FROM public.manual_giros mg
           WHERE mg.id = v_ref AND mg.business_date = v_business_date;
          IF v_giro_id IS NULL THEN v_code := 'CAPTURE_TARGET_NOT_FOUND'; END IF;
        ELSE
          SELECT o.order_uid INTO v_anchor_uid
            FROM public.ordenes o
           WHERE o.id = v_ref AND o.id <> NEW.id
             AND o.service_session_id = NEW.service_session_id AND o.order_uid IS NOT NULL;
          IF v_anchor_uid IS NULL THEN v_code := 'CAPTURE_TARGET_NOT_FOUND'; END IF;
        END IF;
      END IF;
    END IF;

    IF v_code IS NULL THEN
      v_fingerprint := giro_authority.target_fingerprint_v1(v_kind, v_giro_id, v_anchor_uid);
      INSERT INTO giro_authority.giro_intents
        (order_uid, target_kind, target_ref, target_giro_id, target_order_uid, target_fingerprint,
         order_context, business_date, actor, sv, status, phase)
      VALUES (NEW.order_uid, v_kind, v_ref, v_giro_id, v_anchor_uid, v_fingerprint,
              v_context, v_business_date, v_actor, v_sv, 'PENDING', 'CAPTURE');
    ELSE
      INSERT INTO giro_authority.giro_intents
        (order_uid, target_kind, target_ref, order_context, business_date, actor, sv,
         status, phase, resolved_at, resolution_code)
      VALUES (NEW.order_uid, v_kind, v_ref, v_context, v_business_date, v_actor, v_sv,
              'REJECTED', 'CAPTURE', now(), v_code);
    END IF;
  EXCEPTION WHEN others THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    BEGIN
      INSERT INTO giro_authority.giro_intents (order_uid, status, phase, resolved_at, resolution_code, resolution_detail)
      VALUES (NEW.order_uid, 'REJECTED', 'CAPTURE', now(), 'CAPTURE_INTERNAL', jsonb_build_object('sqlstate', v_sqlstate));
    EXCEPTION WHEN others THEN
      RAISE WARNING 'GIRO_INTENT_CAPTURE_DIAGNOSTIC_LOST order_id=% sqlstate=%', NEW.id, v_sqlstate;
    END;
  END;
  RETURN NEW;
END $fn$;

-- 8. Giro Authority commands (public entry points) -----------------------------------------
-- Uniform contract: one transaction per call, jsonb {ok, code, ...}; business refusals
-- never raise. Codes: OK, IDEMPOTENT, INVALID_INPUT, SCOPE_UNAVAILABLE (scope not provided),
-- UNVERIFIABLE (trip facts unreadable), GIRO_NOT_FOUND,
-- GIRO_NOT_PLANNED, GIRO_DEPARTED, ORDER_NOT_FOUND, ORDER_NOT_ELIGIBLE (+reason),
-- ORDER_ALREADY_IN_GIRO, ORDER_NOT_IN_GIRO, SCOPE_MISMATCH, INSUFFICIENT_MEMBERS,
-- CONCURRENT_CHANGE. No capacity limit: none is authoritative today (D18).

CREATE FUNCTION public.giro_authority_create_v1(
  p_order_uids uuid[], p_hora_ref text, p_anchor_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_uids   uuid[];
  v_hora   text;
  v_trip   jsonb;
  v_reason text;
  v_dates  date[];
  v_effs   text[];
  v_id     text;
  r        record;
  d        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'actor'));
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  v_uids := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_order_uids, '{}'::uuid[])) AS x WHERE x IS NOT NULL ORDER BY 1);
  IF cardinality(v_uids) < 2 THEN
    RETURN giro_authority.refusal_v1('INSUFFICIENT_MEMBERS', NULL);
  END IF;
  IF p_hora_ref IS NOT NULL AND btrim(p_hora_ref) <> '' THEN
    v_hora := giro_authority.hhmm_norm(p_hora_ref);
    IF v_hora IS NULL THEN
      RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'hora_ref'));
    END IF;
  END IF;
  IF p_anchor_order_uid IS NOT NULL AND NOT (p_anchor_order_uid = ANY (v_uids)) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'anchor_order_uid'));
  END IF;

  PERFORM giro_authority.lock_orders_v1(v_uids);                                         -- L2
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = ANY (v_uids) ORDER BY o.order_uid FOR SHARE;  -- L4
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  FOR r IN SELECT * FROM giro_authority.order_facts_v1(v_uids, v_trip) LOOP
    v_reason := giro_authority.member_refusal_v1(r.present, r.estado, r.delivery_type, r.table_session_id,
                                                 r.in_active_trip, r.service_session_id, p_operational_session_ids);
    IF v_reason = 'ORDER_NOT_FOUND' THEN
      RETURN giro_authority.refusal_v1('ORDER_NOT_FOUND', jsonb_build_object('order_uid', r.order_uid));
    ELSIF v_reason IS NOT NULL THEN
      RETURN giro_authority.refusal_v1('ORDER_NOT_ELIGIBLE', jsonb_build_object('order_uid', r.order_uid, 'reason', v_reason));
    END IF;
  END LOOP;
  SELECT array_agg(DISTINCT f.business_date) INTO v_dates FROM giro_authority.order_facts_v1(v_uids, v_trip) f;
  IF cardinality(v_dates) <> 1 OR v_dates[1] IS NULL THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;

  -- Never an implicit move: every order must be free. Exact replay -> IDEMPOTENT.
  v_effs := ARRAY(SELECT giro_authority.order_effective_giro_v1(u, p_operational_session_ids, v_trip)
                    FROM unnest(v_uids) AS u);
  IF EXISTS (SELECT 1 FROM unnest(v_effs) AS e WHERE e IS NOT NULL) THEN
    IF (SELECT count(DISTINCT e) FROM unnest(v_effs) AS e) = 1
       AND NOT EXISTS (SELECT 1 FROM unnest(v_effs) AS e WHERE e IS NULL) THEN
      SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_effs[1]], p_operational_session_ids, v_trip);
      IF d.effective_order_uids = v_uids THEN
        RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', d.giro_id);
      END IF;
    END IF;
    RETURN giro_authority.refusal_v1('ORDER_ALREADY_IN_GIRO',
      jsonb_build_object('giro_ids', (SELECT jsonb_agg(DISTINCT e) FROM unnest(v_effs) AS e WHERE e IS NOT NULL)));
  END IF;

  v_id := giro_authority.insert_giro_v1(v_dates[1], v_hora, p_anchor_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(u, v_id, p_actor) FROM unnest(v_uids) AS u;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', v_id, 'business_date', v_dates[1],
                            'order_uids', to_jsonb(v_uids));
END $fn$;

CREATE FUNCTION public.giro_authority_attach_v1(
  p_giro_id text, p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip   jsonb;
  v_reason text;
  v_other  text;
  d        record;
  f        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_giro_id IS NULL OR p_order_uid IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = p_giro_id FOR UPDATE;              -- L1
  IF NOT FOUND THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid]);                              -- L2
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = p_order_uid FOR SHARE;              -- L4
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  IF p_order_uid = ANY (d.effective_order_uids) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_giro_id);
  END IF;
  IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_state', d.giro_state));
  END IF;
  IF d.giro_state <> 'PLANNED' THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_PLANNED', jsonb_build_object('state_reason', d.state_reason));
  END IF;
  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  v_reason := giro_authority.member_refusal_v1(f.present, f.estado, f.delivery_type, f.table_session_id,
                                               f.in_active_trip, f.service_session_id, p_operational_session_ids);
  IF v_reason = 'ORDER_NOT_FOUND' THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_FOUND', NULL);
  ELSIF v_reason IS NOT NULL THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_ELIGIBLE', jsonb_build_object('reason', v_reason));
  END IF;
  IF f.business_date IS DISTINCT FROM d.business_date THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;
  v_other := giro_authority.order_effective_giro_v1(p_order_uid, p_operational_session_ids, v_trip);
  IF v_other IS NOT NULL THEN
    RETURN giro_authority.refusal_v1('ORDER_ALREADY_IN_GIRO', jsonb_build_object('giro_id', v_other));
  END IF;
  PERFORM giro_authority.put_member_v1(p_order_uid, p_giro_id, p_actor);
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id, 'order_uid', p_order_uid);
END $fn$;

CREATE FUNCTION public.giro_authority_detach_v1(
  p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_giro  text;
  v_again text;
  v_trip  jsonb;
  d       record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_order_uid IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  SELECT gm.giro_id INTO v_giro FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;
  IF v_giro IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'reason', 'NOT_A_MEMBER');
  END IF;
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_giro FOR UPDATE;                  -- L1
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid]);                              -- L2
  SELECT gm.giro_id INTO v_again FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;
  IF v_again IS DISTINCT FROM v_giro THEN
    RETURN giro_authority.refusal_v1('CONCURRENT_CHANGE', NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro], p_operational_session_ids, v_trip);
  IF NOT (p_order_uid = ANY (d.effective_order_uids)) THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'reason', 'NOT_EFFECTIVE');
  END IF;
  IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_state', d.giro_state));
  END IF;
  DELETE FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid AND gm.giro_id = v_giro;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_giro], p_operational_session_ids, v_trip);
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', v_giro, 'giro_state_after', d.giro_state);
END $fn$;

CREATE FUNCTION public.giro_authority_move_v1(
  p_order_uid uuid, p_to_giro_id text, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_from   text;
  v_again  text;
  v_trip   jsonb;
  v_locked integer;
  df       record;
  dt       record;
  f        record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_order_uid IS NULL OR p_to_giro_id IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  SELECT gm.giro_id INTO v_from FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;
  IF v_from IS NULL THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_IN_GIRO', NULL);
  END IF;
  WITH l AS (SELECT mg.id FROM public.manual_giros mg WHERE mg.id IN (v_from, p_to_giro_id) ORDER BY mg.id FOR UPDATE)
  SELECT count(*) INTO v_locked FROM l;                                                  -- L1
  IF v_locked < (CASE WHEN v_from = p_to_giro_id THEN 1 ELSE 2 END) THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid]);                              -- L2
  PERFORM 1 FROM public.ordenes o WHERE o.order_uid = p_order_uid FOR SHARE;              -- L4
  SELECT gm.giro_id INTO v_again FROM giro_authority.giro_members gm WHERE gm.order_uid = p_order_uid;
  IF v_again IS DISTINCT FROM v_from THEN
    RETURN giro_authority.refusal_v1('CONCURRENT_CHANGE', NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;
  SELECT * INTO df FROM giro_authority.derive_giros_v1(ARRAY[v_from], p_operational_session_ids, v_trip);
  IF NOT (p_order_uid = ANY (df.effective_order_uids)) THEN
    RETURN giro_authority.refusal_v1('ORDER_NOT_IN_GIRO', jsonb_build_object('reason', 'NOT_EFFECTIVE'));
  END IF;
  IF v_from = p_to_giro_id THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_to_giro_id);
  END IF;
  IF df.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', v_from));
  END IF;
  SELECT * INTO dt FROM giro_authority.derive_giros_v1(ARRAY[p_to_giro_id], p_operational_session_ids, v_trip);
  IF dt.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_id', p_to_giro_id));
  END IF;
  IF dt.giro_state <> 'PLANNED' THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_PLANNED', jsonb_build_object('giro_id', p_to_giro_id, 'state_reason', dt.state_reason));
  END IF;
  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  IF f.business_date IS DISTINCT FROM dt.business_date THEN
    RETURN giro_authority.refusal_v1('SCOPE_MISMATCH', NULL);
  END IF;
  UPDATE giro_authority.giro_members gm
     SET giro_id = p_to_giro_id, created_at = now(), created_by = btrim(p_actor)
   WHERE gm.order_uid = p_order_uid AND gm.giro_id = v_from;
  SELECT * INTO df FROM giro_authority.derive_giros_v1(ARRAY[v_from], p_operational_session_ids, v_trip);
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'from_giro_id', v_from, 'to_giro_id', p_to_giro_id,
                            'from_giro_state_after', df.giro_state);
END $fn$;

CREATE FUNCTION public.giro_authority_dissolve_v1(
  p_giro_id text, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip jsonb;
  d      record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_giro_id IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = p_giro_id FOR UPDATE;              -- L1
  IF NOT FOUND THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  IF d.dissolved_at IS NOT NULL OR d.giro_state = 'DISSOLVED' THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_giro_id, 'state_reason', d.state_reason);
  END IF;
  IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_state', d.giro_state));
  END IF;
  UPDATE public.manual_giros mg
     SET dissolved_at = now(), dissolved_by = btrim(p_actor)
   WHERE mg.id = p_giro_id AND mg.dissolved_at IS NULL;
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id);
END $fn$;

CREATE FUNCTION public.giro_authority_set_hora_ref_v1(
  p_giro_id text, p_hora_ref text, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hora text;
  v_trip jsonb;
  d      record;
BEGIN
  IF NOT giro_authority.actor_valid_v1(p_actor) OR p_giro_id IS NULL THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.refusal_v1('SCOPE_UNAVAILABLE', NULL);
  END IF;
  IF p_hora_ref IS NOT NULL AND btrim(p_hora_ref) <> '' THEN
    v_hora := giro_authority.hhmm_norm(p_hora_ref);
    IF v_hora IS NULL THEN
      RETURN giro_authority.refusal_v1('INVALID_INPUT', jsonb_build_object('field', 'hora_ref'));
    END IF;
  END IF;
  PERFORM 1 FROM public.manual_giros mg WHERE mg.id = p_giro_id FOR UPDATE;              -- L1
  IF NOT FOUND THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_FOUND', NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.refusal_v1('UNVERIFIABLE', jsonb_build_object('reason', v_trip->>'reason'));
  END IF;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
    RETURN giro_authority.refusal_v1('GIRO_DEPARTED', jsonb_build_object('giro_state', d.giro_state));
  END IF;
  IF d.giro_state <> 'PLANNED' THEN
    RETURN giro_authority.refusal_v1('GIRO_NOT_PLANNED', jsonb_build_object('state_reason', d.state_reason));
  END IF;
  IF d.hora_ref IS NOT DISTINCT FROM v_hora THEN
    RETURN jsonb_build_object('ok', true, 'code', 'IDEMPOTENT', 'giro_id', p_giro_id, 'hora_ref', v_hora);
  END IF;
  UPDATE public.manual_giros mg SET hora_ref = v_hora WHERE mg.id = p_giro_id;
  SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[p_giro_id], p_operational_session_ids, v_trip);
  RETURN jsonb_build_object('ok', true, 'code', 'OK', 'giro_id', p_giro_id, 'hora_ref', v_hora,
                            'salida', d.salida, 'salida_source', d.salida_source);
END $fn$;

-- Consume: called post-commit after the FIRST operative entry into EN_COCINA (W5 wiring).
-- Idempotent per order_uid: a resolved intent returns its stored outcome (replay=true).
-- Fail-closed on unverifiable Giro/Trip facts (REJECTED UNVERIFIABLE). Business outcomes
-- never raise, so the caller's transition can never be failed by the Planner.
CREATE FUNCTION public.giro_authority_consume_intent_v1(
  p_order_uid uuid, p_actor text, p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_row  giro_authority.giro_intents;
  v_trip jsonb;
  v_ctx  jsonb;
  v_cur  text;
  v_new  text;
  v_why  text;
  f      record;
  a      record;
  d      record;
BEGIN
  IF p_order_uid IS NULL OR NOT giro_authority.actor_valid_v1(p_actor) THEN
    RETURN giro_authority.refusal_v1('INVALID_INPUT', NULL);
  END IF;
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'code', 'NO_INTENT');
  END IF;
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  IF v_row.target_kind = 'GIRO' THEN
    PERFORM 1 FROM public.manual_giros mg WHERE mg.id = v_row.target_giro_id FOR UPDATE;   -- L1
  END IF;
  PERFORM giro_authority.lock_orders_v1(ARRAY[p_order_uid, v_row.target_order_uid]);      -- L2
  SELECT * INTO v_row FROM giro_authority.giro_intents gi WHERE gi.order_uid = p_order_uid FOR UPDATE;  -- L3
  IF v_row.status <> 'PENDING' THEN
    RETURN giro_authority.intent_outcome_v1(v_row, true);
  END IF;
  PERFORM 1 FROM public.ordenes o
   WHERE o.order_uid = ANY (ARRAY[p_order_uid, v_row.target_order_uid])
   ORDER BY o.order_uid FOR SHARE;                                                        -- L4

  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'SCOPE_UNAVAILABLE', NULL, p_actor, NULL);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  IF NOT (v_trip->>'available')::boolean THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'UNVERIFIABLE', NULL, p_actor,
                                            jsonb_build_object('reason', v_trip->>'reason'));
  END IF;

  SELECT * INTO f FROM giro_authority.order_facts_v1(ARRAY[p_order_uid], v_trip);
  IF NOT f.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_GONE'));
  END IF;
  IF NOT COALESCE(f.service_session_id = ANY (p_operational_session_ids), false) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'EXPIRED', 'EXPIRY', 'SERVICE_CLOSED', NULL, p_actor, NULL);
  END IF;
  IF f.in_active_trip OR f.estado = 'EN_ENTREGA'
     OR f.estado = ANY (giro_authority.delivered_states_v1())
     OR f.estado = ANY (giro_authority.cancelled_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_STATE', 'estado', f.estado));
  END IF;
  IF f.estado IS NULL OR f.estado NOT IN ('EN_COCINA', 'LISTO') THEN
    -- Called before the first kitchen entry: not a decision, the intent stays PENDING.
    RETURN jsonb_build_object('ok', true, 'code', 'NOT_YET_OPERATIVE', 'status', 'PENDING', 'replay', false);
  END IF;
  v_ctx := v_row.order_context;
  IF (v_ctx->>'zona') IS DISTINCT FROM f.zona
     OR (v_ctx->>'hora') IS DISTINCT FROM f.hora
     OR (v_ctx->>'delivery_type') IS DISTINCT FROM f.delivery_type
     OR (v_ctx->>'service_session_id') IS DISTINCT FROM f.service_session_id::text THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor, NULL);
  END IF;
  IF f.delivery_type <> 'DOMICILIO' OR f.table_session_id IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_NOT_ELIGIBLE', NULL, p_actor,
                                            jsonb_build_object('reason', 'NOT_DELIVERY'));
  END IF;
  v_cur := giro_authority.order_effective_giro_v1(p_order_uid, p_operational_session_ids, v_trip);

  IF v_row.target_kind = 'GIRO' THEN
    IF v_cur = v_row.target_giro_id THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_cur, p_actor,
                                              jsonb_build_object('already_member', true));
    END IF;
    IF v_cur IS NOT NULL THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                              jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
    END IF;
    SELECT * INTO d FROM giro_authority.derive_giros_v1(ARRAY[v_row.target_giro_id], p_operational_session_ids, v_trip);
    IF NOT FOUND THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor, NULL);
    END IF;
    IF d.giro_state IN ('IN_TRIP', 'DONE') THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor,
                                              jsonb_build_object('giro_state', d.giro_state));
    END IF;
    IF d.giro_state <> 'PLANNED' OR d.business_date IS DISTINCT FROM f.business_date THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                              jsonb_build_object('state_reason', d.state_reason));
    END IF;
    IF giro_authority.target_fingerprint_v1('GIRO', v_row.target_giro_id, NULL) IS DISTINCT FROM v_row.target_fingerprint THEN
      RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
    END IF;
    PERFORM giro_authority.put_member_v1(p_order_uid, v_row.target_giro_id, p_actor);
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'ATTACHED', v_row.target_giro_id, p_actor, NULL);
  END IF;

  -- ANCHOR: create {anchor, order}; the anchor must still be a free, operative single.
  IF v_cur IS NOT NULL THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'ORDER_CHANGED', NULL, p_actor,
                                            jsonb_build_object('reason', 'ORDER_IN_OTHER_GIRO', 'giro_id', v_cur));
  END IF;
  SELECT * INTO a FROM giro_authority.order_facts_v1(ARRAY[v_row.target_order_uid], v_trip);
  IF NOT a.present THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', 'ANCHOR_GONE'));
  END IF;
  IF a.in_active_trip OR a.estado = 'EN_ENTREGA' OR a.estado = ANY (giro_authority.delivered_states_v1()) THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_DEPARTED', NULL, p_actor, NULL);
  END IF;
  v_why := giro_authority.member_refusal_v1(a.present, a.estado, a.delivery_type, a.table_session_id,
                                            a.in_active_trip, a.service_session_id, p_operational_session_ids);
  IF v_why IS NOT NULL OR a.business_date IS DISTINCT FROM f.business_date THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_GONE', NULL, p_actor,
                                            jsonb_build_object('reason', COALESCE(v_why, 'BUSINESS_DATE')));
  END IF;
  IF giro_authority.order_effective_giro_v1(v_row.target_order_uid, p_operational_session_ids, v_trip) IS NOT NULL
     OR giro_authority.target_fingerprint_v1('ANCHOR', NULL, v_row.target_order_uid) IS DISTINCT FROM v_row.target_fingerprint THEN
    RETURN giro_authority.resolve_intent_v1(p_order_uid, 'REJECTED', 'CONSUME', 'TARGET_CHANGED', NULL, p_actor, NULL);
  END IF;
  v_new := giro_authority.insert_giro_v1(f.business_date, NULL, v_row.target_order_uid, p_actor);
  PERFORM giro_authority.put_member_v1(v_row.target_order_uid, v_new, p_actor);
  PERFORM giro_authority.put_member_v1(p_order_uid, v_new, p_actor);
  RETURN giro_authority.resolve_intent_v1(p_order_uid, 'CONSUMED', 'CONSUME', 'GIRO_CREATED', v_new, p_actor, NULL);
END $fn$;

-- 9. The ONE projection (read-only). Scope comes from the backend (getOperationalSessionIds).
-- Exposes effective fields only: never manual_giro_id, never pending_giro_intent, never
-- a non-effective membership, never the capture fingerprint/context/actor.
CREATE FUNCTION public.giro_projection_v1(p_operational_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_trip  jsonb;
  v_dates date[];
  v_giros text[];
  v_ok    boolean;
BEGIN
  IF NOT giro_authority.scope_valid_v1(p_operational_session_ids) THEN
    RETURN jsonb_build_object('contract', 'giro_projection_v1', 'scope_valid', false, 'degraded', true,
                              'reasons', jsonb_build_array('SCOPE_UNAVAILABLE'),
                              'giros', '[]'::jsonb, 'orders', '[]'::jsonb, 'intents', '[]'::jsonb);
  END IF;
  v_trip := giro_authority.trip_facts_v1();
  v_ok := COALESCE((v_trip->>'available')::boolean, false);
  SELECT array_agg(DISTINCT ss.business_date) INTO v_dates
    FROM public.service_sessions ss WHERE ss.id = ANY (p_operational_session_ids);
  SELECT array_agg(DISTINCT x.id) INTO v_giros FROM (
    SELECT mg.id FROM public.manual_giros mg WHERE mg.business_date = ANY (COALESCE(v_dates, '{}'::date[]))
    UNION
    SELECT gm.giro_id FROM giro_authority.giro_members gm
      JOIN public.ordenes o ON o.order_uid = gm.order_uid
     WHERE o.service_session_id = ANY (p_operational_session_ids)
  ) AS x;

  RETURN (
    WITH d AS (
      SELECT * FROM giro_authority.derive_giros_v1(COALESCE(v_giros, '{}'::text[]), p_operational_session_ids,
                                                   CASE WHEN v_ok THEN v_trip ELSE '{}'::jsonb END)
    )
    SELECT jsonb_build_object(
      'contract', 'giro_projection_v1',
      'scope_valid', true,
      'scope_session_ids', to_jsonb(p_operational_session_ids),
      'trip_facts_available', v_ok,
      'degraded', NOT v_ok,
      'reasons', CASE WHEN v_ok THEN '[]'::jsonb ELSE jsonb_build_array('TRIP_FACTS_UNAVAILABLE') END,
      'giros', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'giro_id', d.giro_id, 'seq', d.seq, 'business_date', d.business_date,
                 'giro_state', d.giro_state, 'state_reason', d.state_reason,
                 'hora_ref', d.hora_ref, 'salida', d.salida, 'salida_source', d.salida_source,
                 'effective_members', COALESCE((
                   SELECT jsonb_agg(jsonb_build_object('order_uid', e.u, 'order_id', e.oid) ORDER BY e.u)
                     FROM unnest(d.effective_order_uids, d.effective_order_ids) AS e(u, oid)), '[]'::jsonb),
                 'anchor_order_uid', d.anchor_order_uid, 'created_at', d.created_at, 'created_by', d.created_by,
                 'dissolved_at', d.dissolved_at, 'dissolved_by', d.dissolved_by)
               ORDER BY d.business_date, d.seq)
          FROM d), '[]'::jsonb),
      'orders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('order_uid', e.u, 'order_id', e.oid, 'effective_giro_id', d.giro_id)
                         ORDER BY e.u)
          FROM d CROSS JOIN LATERAL unnest(d.effective_order_uids, d.effective_order_ids) AS e(u, oid)), '[]'::jsonb),
      'intents', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'order_uid', gi.order_uid, 'order_id', o.id, 'stored_status', gi.status,
                 'effective_status', CASE WHEN gi.status <> 'PENDING' THEN gi.status
                                          WHEN o.id IS NULL THEN 'REJECTED'
                                          WHEN NOT COALESCE(o.service_session_id = ANY (p_operational_session_ids), false) THEN 'EXPIRED'
                                          ELSE 'PENDING' END,
                 'effective_code', CASE WHEN gi.status <> 'PENDING' THEN gi.resolution_code
                                        WHEN o.id IS NULL THEN 'ORDER_NOT_ELIGIBLE'
                                        WHEN NOT COALESCE(o.service_session_id = ANY (p_operational_session_ids), false) THEN 'SERVICE_CLOSED'
                                        ELSE NULL END,
                 'target_kind', gi.target_kind, 'target_ref', gi.target_ref,
                 'resulting_giro_id', gi.resulting_giro_id,
                 'captured_at', gi.captured_at, 'resolved_at', gi.resolved_at)
               ORDER BY gi.captured_at, gi.order_uid)
          FROM giro_authority.giro_intents gi
          LEFT JOIN public.ordenes o ON o.order_uid = gi.order_uid
         WHERE o.service_session_id = ANY (p_operational_session_ids)
            OR gi.business_date = ANY (COALESCE(v_dates, '{}'::date[]))), '[]'::jsonb)
    ) FROM (SELECT 1) AS one
  );
END $fn$;

-- 10. Ownership and EXECUTE (explicit: defeats the public-schema default privileges that
-- grant every new function to anon/authenticated/service_role, and the built-in PUBLIC grant).
ALTER FUNCTION giro_authority.giro_intents_one_shot_guard_v1() OWNER TO postgres;
ALTER FUNCTION giro_authority.delivered_states_v1() OWNER TO postgres;
ALTER FUNCTION giro_authority.cancelled_states_v1() OWNER TO postgres;
ALTER FUNCTION giro_authority.hhmm_norm(text) OWNER TO postgres;
ALTER FUNCTION giro_authority.service_day_minutes(text) OWNER TO postgres;
ALTER FUNCTION giro_authority.trip_facts_v1() OWNER TO postgres;
ALTER FUNCTION giro_authority.derive_giros_v1(text[], uuid[], jsonb) OWNER TO postgres;
ALTER FUNCTION giro_authority.order_facts_v1(uuid[], jsonb) OWNER TO postgres;
ALTER FUNCTION giro_authority.order_effective_giro_v1(uuid, uuid[], jsonb) OWNER TO postgres;
ALTER FUNCTION giro_authority.target_fingerprint_v1(text, text, uuid) OWNER TO postgres;
ALTER FUNCTION giro_authority.member_refusal_v1(boolean, text, text, uuid, boolean, uuid, uuid[]) OWNER TO postgres;
ALTER FUNCTION giro_authority.scope_valid_v1(uuid[]) OWNER TO postgres;
ALTER FUNCTION giro_authority.actor_valid_v1(text) OWNER TO postgres;
ALTER FUNCTION giro_authority.refusal_v1(text, jsonb) OWNER TO postgres;
ALTER FUNCTION giro_authority.lock_orders_v1(uuid[]) OWNER TO postgres;
ALTER FUNCTION giro_authority.insert_giro_v1(date, text, uuid, text) OWNER TO postgres;
ALTER FUNCTION giro_authority.put_member_v1(uuid, text, text) OWNER TO postgres;
ALTER FUNCTION giro_authority.intent_outcome_v1(giro_authority.giro_intents, boolean) OWNER TO postgres;
ALTER FUNCTION giro_authority.resolve_intent_v1(uuid, text, text, text, text, text, jsonb) OWNER TO postgres;
ALTER FUNCTION giro_authority.capture_giro_intent_v1() OWNER TO postgres;
ALTER FUNCTION public.giro_authority_create_v1(uuid[], text, uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_attach_v1(text, uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_detach_v1(uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_move_v1(uuid, text, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_dissolve_v1(text, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_set_hora_ref_v1(text, text, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_authority_consume_intent_v1(uuid, text, uuid[]) OWNER TO postgres;
ALTER FUNCTION public.giro_projection_v1(uuid[]) OWNER TO postgres;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p
            WHERE p.pronamespace = 'giro_authority'::regnamespace
               OR (p.pronamespace = 'public'::regnamespace
                   AND (p.proname LIKE 'giro\_authority\_%\_v1' OR p.proname = 'giro_projection_v1')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.sig);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.giro_authority_create_v1(uuid[], text, uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_attach_v1(text, uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_detach_v1(uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_move_v1(uuid, text, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_dissolve_v1(text, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_set_hora_ref_v1(text, text, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_authority_consume_intent_v1(uuid, text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.giro_projection_v1(uuid[]) TO service_role;

-- 11. Post-conditions ------------------------------------------------------------------------
DO $$
DECLARE
  r        record;
  v_public integer := 0;
  v_role   text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_schema_privilege(v_role, 'giro_authority', 'USAGE') OR has_schema_privilege(v_role, 'giro_authority', 'CREATE') THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % holds a privilege on schema giro_authority', v_role;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) x
              WHERE n.nspname = 'giro_authority' AND x.grantee = 0) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: PUBLIC holds a privilege on schema giro_authority';
  END IF;

  FOR r IN SELECT c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner
             FROM pg_class c WHERE c.relnamespace = 'giro_authority'::regnamespace AND c.relkind = 'r' LOOP
    IF NOT (r.relrowsecurity AND r.relforcerowsecurity) THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % must have RLS enabled and forced', r.relname;
    END IF;
    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % must be owned by postgres', r.relname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = r.oid) THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % must have zero policies', r.relname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_publication_rel pr WHERE pr.prrelid = r.oid) THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % must not be published', r.relname;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_table_privilege(v_role, r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
        RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % holds a privilege on %', v_role, r.relname;
      END IF;
    END LOOP;
  END LOOP;

  FOR r IN SELECT p.oid, p.proname, p.pronamespace, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
             FROM pg_proc p
            WHERE p.pronamespace = 'giro_authority'::regnamespace
               OR (p.pronamespace = 'public'::regnamespace
                   AND (p.proname LIKE 'giro\_authority\_%\_v1' OR p.proname = 'giro_projection_v1')) LOOP
    IF r.owner <> 'postgres' THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % must be owned by postgres', r.proname;
    END IF;
    IF r.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: % must pin search_path=pg_catalog, pg_temp', r.proname;
    END IF;
    IF EXISTS (SELECT 1 FROM aclexplode(COALESCE(
                 (SELECT p2.proacl FROM pg_proc p2 WHERE p2.oid = r.oid),
                 acldefault('f', (SELECT p3.proowner FROM pg_proc p3 WHERE p3.oid = r.oid)))) x
                WHERE x.grantee = 0) THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: PUBLIC may execute %', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: anon/authenticated may execute %', r.proname;
    END IF;
    IF r.pronamespace = 'public'::regnamespace THEN
      v_public := v_public + 1;
      IF NOT r.prosecdef OR NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: entry point % must be SECURITY DEFINER and executable by service_role', r.proname;
      END IF;
    ELSIF has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: service_role may execute private helper %', r.proname;
    END IF;
  END LOOP;
  IF v_public <> 8 THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: expected 8 public entry points, found %', v_public;
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'giro_authority.capture_giro_intent_v1()'::regprocedure) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: the capture function must be SECURITY DEFINER';
  END IF;

  -- Dormancy: nothing on ordenes references the Authority.
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE t.tgrelid = 'public.ordenes'::regclass AND p.pronamespace = 'giro_authority'::regnamespace) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: a trigger on ordenes uses the Authority (W5 only)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_publication_tables pt WHERE pt.schemaname = 'giro_authority') THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 post-condition failed: a giro_authority relation is published';
  END IF;
END $$;

COMMIT;
