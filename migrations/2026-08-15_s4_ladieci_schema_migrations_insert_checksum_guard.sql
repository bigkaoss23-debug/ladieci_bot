-- S4 FOLLOW-UP — INSERT-time checksum-conflict guard for
-- public.ladieci_schema_migrations
-- Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S4,
-- §15: "Required fail-closed behavior: same migration identity + same
-- checksum = idempotent/acceptable... same migration identity + different
-- checksum = FAIL. No silent overwrite."
--
-- GAP FOUND live while validating the just-applied
-- 2026-08-15_s4_ladieci_schema_migrations_ledger.sql +
-- 2026-08-15_s4_ladieci_schema_migrations_bootstrap_seed.sql (same slice,
-- same session -- same self-correction pattern already used for row
-- 71 -> 72 in S1): the immutability trigger installed by the ledger
-- migration only fires BEFORE UPDATE OR DELETE. The bootstrap seed's own
-- `INSERT ... ON CONFLICT (filename) DO NOTHING` is correct for ITS OWN
-- idempotent-replay need, but it means a FUTURE plain INSERT attempting to
-- register an existing filename under a DIFFERENT checksum would be
-- silently dropped by the same ON CONFLICT clause (if the caller uses one)
-- -- satisfying "no bad data gets in" but not "FAIL", and definitely not
-- satisfying "no silent overwrite/no silent anything": the caller gets a
-- quiet 0-rows-affected, never an error.
--
-- Empirically verified before writing this fix (isolated scratch table,
-- dropped immediately after, zero residue in any real table): a BEFORE
-- INSERT ROW trigger fires and can RAISE even when the statement carries
-- ON CONFLICT DO NOTHING -- Postgres evaluates BEFORE ROW triggers ahead of
-- constraint/conflict resolution. This is exactly the mechanism needed:
-- identical-checksum re-insert stays a silent, safe no-op (idempotent);
-- different-checksum re-insert now RAISEs loudly, regardless of whether the
-- caller's own statement used ON CONFLICT or not.
--
-- FIX: CREATE OR REPLACE the same trigger function
-- (ladieci_schema_migrations_immutability_v1) adding the TG_OP = 'INSERT'
-- branch; DROP + CREATE the trigger (Postgres cannot ALTER a trigger's
-- fired-event list in place) so it now fires BEFORE INSERT OR UPDATE OR
-- DELETE. UPDATE/DELETE branches are byte-identical to the ledger
-- migration's original body -- nothing about the promotion/regression/
-- delete rules changes.

-- ── Predecessor guard ────────────────────────────────────────────────────
DO $$
DECLARE
  v_body   text;
  v_events text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'ladieci_schema_migrations'
  ) THEN
    RAISE EXCEPTION 'S4 follow-up refused: public.ladieci_schema_migrations does not exist -- resolve drift first';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ladieci_schema_migrations_immutability_v1';
  IF v_body IS NULL THEN
    RAISE EXCEPTION 'S4 follow-up refused: ladieci_schema_migrations_immutability_v1 not found -- resolve drift first';
  END IF;
  IF v_body LIKE '%already recorded with a DIFFERENT checksum%' THEN
    RAISE EXCEPTION 'S4 follow-up refused: the INSERT guard is already present -- already patched, resolve drift first';
  END IF;

  SELECT array_agg(DISTINCT event_manipulation) INTO v_events
    FROM information_schema.triggers
   WHERE event_object_schema = 'public' AND event_object_table = 'ladieci_schema_migrations'
     AND trigger_name = 'ladieci_schema_migrations_immutable_v1';
  IF v_events IS NULL THEN
    RAISE EXCEPTION 'S4 follow-up refused: ladieci_schema_migrations_immutable_v1 trigger not found -- resolve drift first';
  END IF;
  IF 'INSERT' = ANY(v_events) THEN
    RAISE EXCEPTION 'S4 follow-up refused: trigger already fires on INSERT -- already patched, resolve drift first';
  END IF;
END $$;

-- ── The fix ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ladieci_schema_migrations_immutability_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_existing_checksum text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT checksum_sha256 INTO v_existing_checksum
      FROM public.ladieci_schema_migrations WHERE filename = NEW.filename;
    IF v_existing_checksum IS NOT NULL AND v_existing_checksum <> NEW.checksum_sha256 THEN
      RAISE EXCEPTION 'ladieci_schema_migrations: % already recorded with a DIFFERENT checksum (existing=%, attempted=%) -- a changed migration file must use a new filename, never overwrite', NEW.filename, v_existing_checksum, NEW.checksum_sha256
        USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations is append-only: DELETE is forbidden (filename=%)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  -- TG_OP = 'UPDATE' from here. The only lawful UPDATE is the single
  -- promotion transition bootstrapped_unverified -> verified; every
  -- immutable fact must be byte-identical to OLD.
  IF OLD.filename           IS DISTINCT FROM NEW.filename
     OR OLD.checksum_sha256 IS DISTINCT FROM NEW.checksum_sha256
     OR OLD.apply_order     IS DISTINCT FROM NEW.apply_order
     OR OLD.kind            IS DISTINCT FROM NEW.kind
     OR OLD.applied_at      IS DISTINCT FROM NEW.applied_at
     OR OLD.applied_by      IS DISTINCT FROM NEW.applied_by
  THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: immutable fact changed on % (filename/checksum_sha256/apply_order/kind/applied_at/applied_by can never change)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  IF OLD.verification_status = 'verified' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: % is already verified -- no further UPDATE is lawful (regression forbidden)', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  IF NEW.verification_status <> 'verified' THEN
    RAISE EXCEPTION 'ladieci_schema_migrations: % -- the only lawful UPDATE is bootstrapped_unverified -> verified', OLD.filename
      USING ERRCODE = '0A000';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS ladieci_schema_migrations_immutable_v1 ON public.ladieci_schema_migrations;
CREATE TRIGGER ladieci_schema_migrations_immutable_v1
  BEFORE INSERT OR UPDATE OR DELETE ON public.ladieci_schema_migrations
  FOR EACH ROW EXECUTE FUNCTION public.ladieci_schema_migrations_immutability_v1();

-- ── Post-condition assertions ───────────────────────────────────────────
DO $$
DECLARE
  v_events text[];
  v_total  integer;
BEGIN
  SELECT array_agg(DISTINCT event_manipulation) INTO v_events
    FROM information_schema.triggers
   WHERE event_object_schema = 'public' AND event_object_table = 'ladieci_schema_migrations'
     AND trigger_name = 'ladieci_schema_migrations_immutable_v1';
  IF NOT ('INSERT' = ANY(v_events) AND 'UPDATE' = ANY(v_events) AND 'DELETE' = ANY(v_events)) THEN
    RAISE EXCEPTION 'S4 follow-up post-condition failed: trigger does not fire on all of INSERT/UPDATE/DELETE (found: %)', v_events;
  END IF;

  -- The bootstrap seed's 73 rows must be completely untouched by this
  -- purely-additive fix (no row values changed, only trigger coverage).
  SELECT count(*) INTO v_total FROM public.ladieci_schema_migrations WHERE kind = 'bootstrap';
  IF v_total <> 73 THEN
    RAISE EXCEPTION 'S4 follow-up post-condition failed: bootstrap row count changed unexpectedly (expected 73, found %)', v_total;
  END IF;
END $$;
