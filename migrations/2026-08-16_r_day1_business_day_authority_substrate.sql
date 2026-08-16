-- migrations/2026-08-16_r_day1_business_day_authority_substrate.sql
-- R-DAY1 — BUSINESS DAY AUTHORITY + ATOMIC POINTER SUBSTRATE.
-- Authority: BUSINESS_DAY_R_DAY_IMPLEMENTATION_PLAN_V1_2026-08-16.md (R-DAY0,
-- approved/frozen), sections 6-10, 15-17.
--
-- WHAT THIS MIGRATION DOES
--   1. public.business_days — the new operational parent. One row per
--      business_date, no status column yet (see below), a ticket-epoch
--      counter that is inert substrate until R-DAY2/R-DAY3 consume it.
--   2. public.business_day_policy — a dedicated, singleton POLICY row.
--      Explicitly NOT the generic public.config key/value table: this is
--      the authority-boundary fix R-DAY0 §9/§16 requires (config may hold
--      policy, config must never again be the current-lifecycle authority).
--   3. public.business_day_lifecycle_state — the single governed pointer row
--      for {current_business_day_id, current_period_id, current_ticket_epoch},
--      guarded so none of the three can be written independently of the one
--      sanctioned transition path (R-DAY0 §6's hard-stop condition).
--   4. public.service_sessions.business_day_id — the deterministic parent
--      link, backfilled from the already-immutable business_date column,
--      then SET NOT NULL in this same transaction (safe here, unlike S6/S7's
--      cross-deployment window, because nothing yet reads or writes this
--      column outside this migration).
--   5. public.open_business_day_v1(...) — a dormant bootstrap RPC. Not
--      called by any committed application code in this slice (R-DAY0 §17:
--      "Dormant -- no intake-gate flip yet"). Exists so R-DAY0's own
--      concurrency requirements are provable against real DB behaviour now,
--      not merely asserted on paper.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO (R-DAY1 non-goals, per the
-- approved execution order)
--   - does not create public.order_entities / order_uid (R-DAY2);
--   - does not touch display-ticket numbering behaviour anywhere (R-DAY2/R-DAY3);
--   - does not rewrite service_session_assign_order() or change any
--     order-intake decision (R-DAY3);
--   - does not implement period consolidation (R-DAY4);
--   - does not implement Business Day SEAL -- no status/sealed_at/seal_source/
--     sealed_by columns exist on business_days yet (R-DAY5 adds them, per
--     R-DAY0 §10's own ALTER TABLE, together with the seal RPC that consumes
--     them -- creating the columns without the RPC here would be exactly the
--     "column with no writer" pattern R-DAY0 §18.5's writer-continuity rule
--     forbids elsewhere in this same plan family);
--   - touches no row of public.config; no legacy lifecycle scalar
--     -- language-guard: allow-legacy ORDER_RESET_TS/LAST_CLOSE_PRANZO/LAST_CLOSE_SERA/LAST_CLOSE_DATE are the exact existing config keys this migration proves it never touches, not new vocabulary
--     (ORDER_RESET_TS, LAST_CLOSE_PRANZO, LAST_CLOSE_SERA, LAST_CLOSE_DATE)
--     is read, written, or referenced anywhere in this file;
--   - touches no table/kitchen/rider/payment operational state -- the
--     deterministic backfill in PART 3 reads only service_sessions.business_date
--     (already immutable, already the sole source of economic-period identity)
--     and service_session_state.current_session_id (already the sole existing
--     "what's current" pointer) -- never table_sessions, ordenes,
--     payment_transactions, or config.DRIVER_STATO.
--
-- WHY business_days HAS NO status COLUMN IN THIS SLICE
-- R-DAY0 §10 introduces status/sealed_at/seal_source/sealed_by together, as
-- one ALTER TABLE, at R-DAY5 -- the slice that also builds the only thing
-- that ever transitions status. "Currency" (which day is the operationally
-- current one) is, exactly as it already is for public.service_sessions
-- today, a fact of the SINGLETON POINTER ROW, never a flag on the child
-- table itself. business_days.business_date UNIQUE plus the pointer's own
-- singleton PK are sufficient to make "two current Business Days" physically
-- unrepresentable without inventing a column this slice has no writer for.
--
-- WHY THE HISTORICAL BACKFILL NEEDS NO GUESSING
-- Every live public.service_sessions row already carries an immutable
-- business_date (2026-07-22 migration onward, never rewritten). One
-- business_days row per DISTINCT business_date is a deterministic join, not
-- an inference -- identical in spirit to S6's own "no historical migration
-- rewrites, no guessing" discipline, applied one layer up.
BEGIN;

DO $$
BEGIN
  -- (1) staging sentinel -- same guard as every migration in this repo.
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version='20260710075612')
  THEN RAISE EXCEPTION 'R-DAY1 refused: staging sentinel migration absent -- wrong database?'; END IF;

  -- (2) S4 migration authority must already be live and healthy -- R-DAY1
  -- registers itself into it as a follow-up step, not inside this file.
  IF to_regclass('public.ladieci_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'R-DAY1 refused: public.ladieci_schema_migrations (S4) is missing -- resolve drift first';
  END IF;

  -- (3) predecessor foundation must exist.
  IF to_regclass('public.service_sessions') IS NULL
     OR to_regclass('public.service_session_state') IS NULL
  THEN RAISE EXCEPTION 'R-DAY1 refused: service_sessions/service_session_state foundation missing'; END IF;

  -- (4) fail-closed on pre-existing target objects -- no silent drift,
  -- matching every migration in this repo's own established discipline.
  IF to_regclass('public.business_days') IS NOT NULL
     OR to_regclass('public.business_day_policy') IS NOT NULL
     OR to_regclass('public.business_day_lifecycle_state') IS NOT NULL
  THEN RAISE EXCEPTION 'R-DAY1 refused: a target object already exists -- already patched, resolve drift first'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='service_sessions' AND column_name='business_day_id'
  ) THEN RAISE EXCEPTION 'R-DAY1 refused: service_sessions.business_day_id already exists -- already patched, resolve drift first'; END IF;

  -- (5) do not run ahead of R-DAY2/S6 -- if order_entities already exists,
  -- R-DAY1 is being applied out of order.
  IF to_regclass('public.order_entities') IS NOT NULL THEN
    RAISE EXCEPTION 'R-DAY1 refused: public.order_entities already exists -- R-DAY2/S6 has already started, this migration is out of sequence';
  END IF;

  -- (6) financial baseline sanity -- R-DAY1 must never run against a
  -- database whose payment population differs from the frozen S0 baseline
  -- plus the known S1/S2 acceptance fixtures (13 historical + 4 TEST-S1 +
  -- 3 TEST-S2 = 20). This is a READ-ONLY assertion; R-DAY1 never writes a
  -- financial row.
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY1 refused: payment_transactions population is % (expected 20) -- financial drift detected, re-verify before proceeding',
      (SELECT count(*) FROM public.payment_transactions);
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — public.business_days
CREATE TABLE public.business_days (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_date       date        NOT NULL,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  opened_by           text        NOT NULL,
  open_source         text        NOT NULL,
  -- Substrate for R-DAY2/R-DAY3's ticket-epoch model (R-DAY0 §8). Inert here:
  -- no writer other than this migration's own backfill/bootstrap touches
  -- these two columns in this slice.
  ticket_epoch        integer     NOT NULL DEFAULT 1 CHECK (ticket_epoch > 0),
  next_ticket_number  integer     NOT NULL DEFAULT 1 CHECK (next_ticket_number > 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_days_business_date_uq UNIQUE (business_date)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — public.business_day_policy (singleton). Policy, never lifecycle
-- truth -- R-DAY0 §9/§16's explicit authority boundary. Nullable
-- auto_seal_local_time: no value is configured yet, and none is guessed;
-- R-DAY5 is the first slice that reads or writes it.
CREATE TABLE public.business_day_policy (
  singleton                              boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  auto_seal_local_time                   time        NULL,
  seal_timezone                          text        NOT NULL DEFAULT 'Europe/Madrid',
  ticket_reset_on_consolidation_default  boolean     NOT NULL DEFAULT true,
  created_at                             timestamptz NOT NULL DEFAULT now(),
  updated_at                             timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.business_day_policy (singleton) VALUES (true);

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — deterministic historical backfill + service_sessions parent link.
-- One business_days row per DISTINCT service_sessions.business_date. No
-- inference: business_date is already the sole, immutable source of
-- economic-period identity for every live row.
INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
SELECT DISTINCT s.business_date, 'r_day1_backfill', 'r_day1_deterministic_backfill', 1, 1
FROM public.service_sessions s
WHERE NOT EXISTS (SELECT 1 FROM public.business_days b WHERE b.business_date = s.business_date);

ALTER TABLE public.service_sessions
  ADD COLUMN business_day_id uuid NULL REFERENCES public.business_days(id) ON DELETE RESTRICT;

UPDATE public.service_sessions s
   SET business_day_id = b.id
  FROM public.business_days b
 WHERE b.business_date = s.business_date
   AND s.business_day_id IS NULL;

DO $$
DECLARE
  v_unmapped integer;
BEGIN
  SELECT count(*) INTO v_unmapped FROM public.service_sessions WHERE business_day_id IS NULL;
  IF v_unmapped <> 0 THEN
    RAISE EXCEPTION 'R-DAY1 refused: % service_sessions rows failed deterministic business_day mapping -- never guess, escalate instead', v_unmapped;
  END IF;
END $$;

-- Safe to enforce inline, in this same transaction: unlike S6/S7's
-- cross-deployment nullable window, no application code anywhere reads or
-- writes this column yet, so there is no live traffic to strand.
ALTER TABLE public.service_sessions ALTER COLUMN business_day_id SET NOT NULL;
CREATE INDEX service_sessions_business_day_idx ON public.service_sessions (business_day_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4 — public.business_day_lifecycle_state: the ONE governed pointer row
-- for {current_business_day_id, current_period_id, current_ticket_epoch}.
-- Same singleton discipline as public.service_session_state (2026-07-22
-- migration), extended by exactly the fields R-DAY0 §6 requires be governed
-- together.
CREATE TABLE public.business_day_lifecycle_state (
  singleton                      boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  current_business_day_id        uuid        REFERENCES public.business_days(id) ON DELETE RESTRICT,
  current_period_id              uuid        REFERENCES public.service_sessions(id) ON DELETE RESTRICT,
  current_ticket_epoch           integer,
  recent_closed_business_day_id  uuid        REFERENCES public.business_days(id) ON DELETE RESTRICT,
  updated_at                     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.business_day_lifecycle_state (singleton) VALUES (true);

-- THE HARD-STOP GUARD (R-DAY0 §6 / R-DAY1 Phase 5's "no independent pointer
-- mutation path"). Any UPDATE that changes ANY of the three governed columns
-- is rejected unless it runs inside a transaction that has first set the
-- session-local flag below -- and the ONLY code path in this migration that
-- ever sets it is open_business_day_v1's own body (PART 5), under
-- pg_advisory_xact_lock(hashtext('service_session_lifecycle')) -- the SAME
-- lock name public.ensure_service_session/open_service_session/
-- begin_service_session_close/roll_service_session_economic_v1 already use,
-- kept deliberately unchanged per R-DAY0 §6 ("renaming buys nothing and
-- risks a stale caller acquiring a different lock during the transition").
-- set_config(..., true) is SET LOCAL semantics: the flag can never leak past
-- the transaction that set it, so there is no "reset" step to forget.
CREATE OR REPLACE FUNCTION public.business_day_lifecycle_state_guard_v1()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $fn$
BEGIN
  IF (NEW.current_business_day_id       IS DISTINCT FROM OLD.current_business_day_id
      OR NEW.current_period_id          IS DISTINCT FROM OLD.current_period_id
      OR NEW.current_ticket_epoch       IS DISTINCT FROM OLD.current_ticket_epoch)
     AND COALESCE(current_setting('ladieci.business_day_pointer_authorized', true), '') <> 'true'
  THEN
    RAISE EXCEPTION 'BUSINESS_DAY_POINTER_UNAUTHORIZED_MUTATION' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER business_day_lifecycle_state_guard_v1
  BEFORE UPDATE ON public.business_day_lifecycle_state
  FOR EACH ROW EXECUTE FUNCTION public.business_day_lifecycle_state_guard_v1();

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5 — public.open_business_day_v1: the ONE sanctioned writer of the
-- pointer's governed columns in this slice. DORMANT: no committed
-- application code calls this RPC in R-DAY1. It exists so R-DAY0's own
-- concurrency contract is provable against real DB behaviour now, and so
-- R-DAY2/R-DAY3 have a working, already-tested primitive to build on rather
-- than a paper design.
--
-- R-DAY1 never resolves a Service Period: current_period_id is always set to
-- NULL here. Wiring resolveEconomicPeriod() into this pointer is R-DAY3's
-- job (the order-intake authority flip), not this slice's.
CREATE OR REPLACE FUNCTION public.open_business_day_v1(
  p_opened_by text,
  p_source    text DEFAULT 'backend'
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_state public.business_day_lifecycle_state%ROWTYPE;
  v_day   public.business_days%ROWTYPE;
  v_date  date;
BEGIN
  IF p_opened_by IS NULL OR btrim(p_opened_by) = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_ACTOR');
  END IF;

  -- Same lifecycle lock namespace as every other service-session/economic-
  -- boundary transition -- see the header comment above PART 4.
  PERFORM pg_advisory_xact_lock(hashtext('service_session_lifecycle'));

  SELECT * INTO v_state FROM public.business_day_lifecycle_state WHERE singleton = true FOR UPDATE;

  -- Conservative same-instant calendar date. R-DAY1 deliberately does not
  -- consume serviceSchedule.js's rolloverMin/businessDateFor() -- that
  -- wiring is R-DAY3's job, so this bootstrap's own idempotency (the only
  -- thing R-DAY1 needs to prove) does not depend on it.
  v_date := (clock_timestamp() AT TIME ZONE 'Europe/Madrid')::date;

  IF v_state.current_business_day_id IS NOT NULL THEN
    SELECT * INTO v_day FROM public.business_days WHERE id = v_state.current_business_day_id;
    IF FOUND AND v_day.business_date = v_date THEN
      RETURN jsonb_build_object('ok', true, 'code', 'REUSED', 'created', false, 'businessDay', to_jsonb(v_day));
    END IF;
    -- A different day is already current. R-DAY1 never transitions it --
    -- that is R-DAY3/R-DAY5's job -- so the dormant bootstrap refuses rather
    -- than silently rolling the pointer over.
    RETURN jsonb_build_object('ok', false, 'code', 'ANOTHER_BUSINESS_DAY_CURRENT', 'businessDay', to_jsonb(v_day));
  END IF;

  SELECT * INTO v_day FROM public.business_days WHERE business_date = v_date;
  IF NOT FOUND THEN
    INSERT INTO public.business_days (business_date, opened_by, open_source, ticket_epoch, next_ticket_number)
    VALUES (v_date, p_opened_by, COALESCE(p_source, 'backend'), 1, 1)
    RETURNING * INTO v_day;
  END IF;

  PERFORM set_config('ladieci.business_day_pointer_authorized', 'true', true);
  UPDATE public.business_day_lifecycle_state
     SET current_business_day_id       = v_day.id,
         current_period_id             = NULL,
         current_ticket_epoch          = v_day.ticket_epoch,
         recent_closed_business_day_id = NULL,
         updated_at                    = now()
   WHERE singleton = true;

  RETURN jsonb_build_object('ok', true, 'code', 'CREATED', 'created', true, 'businessDay', to_jsonb(v_day));
END $function$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 6 — RLS / grants. Same shape as public.service_sessions/
-- service_session_state (2026-07-22 migration): service_role only.
ALTER TABLE public.business_days                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_day_policy          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_day_lifecycle_state ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.business_days, public.business_day_policy, public.business_day_lifecycle_state
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.business_days, public.business_day_policy, public.business_day_lifecycle_state
  TO service_role;

REVOKE ALL ON FUNCTION public.business_day_lifecycle_state_guard_v1() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_business_day_v1(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_business_day_v1(text, text) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 7 — post-condition assertions. Fails loudly rather than committing a
-- migration that silently did not achieve what it claims.
DO $$
DECLARE
  v_days_count       integer;
  v_sessions_total    integer;
  v_sessions_mapped   integer;
  v_distinct_dates    integer;
BEGIN
  SELECT count(*) INTO v_days_count FROM public.business_days;
  SELECT count(*) INTO v_sessions_total FROM public.service_sessions;
  SELECT count(*) INTO v_sessions_mapped FROM public.service_sessions WHERE business_day_id IS NOT NULL;
  SELECT count(DISTINCT business_date) INTO v_distinct_dates FROM public.service_sessions;

  IF v_days_count <> v_distinct_dates THEN
    RAISE EXCEPTION 'R-DAY1 post-condition failed: business_days row count (%) does not equal distinct service_sessions.business_date count (%)', v_days_count, v_distinct_dates;
  END IF;
  IF v_sessions_mapped <> v_sessions_total THEN
    RAISE EXCEPTION 'R-DAY1 post-condition failed: % of % service_sessions rows are unmapped', v_sessions_total - v_sessions_mapped, v_sessions_total;
  END IF;
  IF (SELECT count(*) FROM public.payment_transactions) <> 20 THEN
    RAISE EXCEPTION 'R-DAY1 post-condition failed: payment_transactions population changed during this migration -- must be exactly 20';
  END IF;
END $$;

COMMIT;
