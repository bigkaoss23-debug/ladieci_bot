-- GIRO INTENT CAPTURE TRIGGER V1 -- W5 ACTIVATION ARTIFACT. NOT PART OF W3. NEVER APPLIED BY W3.
--
-- W3 authors and certifies this file only inside the ephemeral PostgreSQL of
-- ci/giro-authority-certification/harness (it is the one object W3 may not install on
-- public.ordenes). It becomes applicable only in W5, after order canonicalization adds
-- the operator-only input builder, and after the Giro Authority V1 candidate is applied.
--
-- TB-1A decision D: ONE BEFORE INSERT trigger, sorting LAST, that captures and nulls the
-- ephemeral input; no UPDATE on ordenes; exceptions contained by the function.
-- Frozen guard (TB-1A "unico rischio di D"): no BEFORE INSERT trigger may sort after it.
-- Rollback: DROP TRIGGER ordenes_zz_giro_intent_capture_v1 ON public.ordenes;

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('giro_authority.capture_giro_intent_v1()') IS NULL THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_V1 refused: Giro Authority V1 is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.ordenes'::regclass
                AND tgname = 'ordenes_zz_giro_intent_capture_v1') THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_V1 refused: the capture trigger already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t
              WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
                AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4
                AND t.tgname > 'ordenes_zz_giro_intent_capture_v1'::name) THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_V1 refused: a BEFORE INSERT trigger would fire after the capture';
  END IF;
END $$;

CREATE TRIGGER ordenes_zz_giro_intent_capture_v1
  BEFORE INSERT ON public.ordenes
  FOR EACH ROW
  WHEN (NEW.pending_giro_intent IS NOT NULL)
  EXECUTE FUNCTION giro_authority.capture_giro_intent_v1();

DO $$
BEGIN
  IF (SELECT max(t.tgname) FROM pg_trigger t
       WHERE t.tgrelid = 'public.ordenes'::regclass AND NOT t.tgisinternal
         AND (t.tgtype & 1) = 1 AND (t.tgtype & 2) = 2 AND (t.tgtype & 4) = 4)
     IS DISTINCT FROM 'ordenes_zz_giro_intent_capture_v1'::name THEN
    RAISE EXCEPTION 'GIRO_INTENT_CAPTURE_V1 post-condition failed: the capture is not the last BEFORE INSERT trigger';
  END IF;
END $$;

COMMIT;
