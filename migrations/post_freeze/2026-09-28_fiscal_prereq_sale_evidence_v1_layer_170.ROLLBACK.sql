-- migrations/post_freeze/2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.ROLLBACK.sql
-- Paired forward: 2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.sql
--
-- ROLLBACK OF POST-FREEZE LAYER 170 = DETACH THE CAPTURE. Applied ONLY by scripts/postFreezeLayerApply.js rollback --layer 170, which sets
-- the acknowledgement below inside the transaction. Contract: docs/FISCAL_P1_SALE_EVIDENCE_CONTRACT.md.
--
-- What it does, in ONE transaction:
--   * drops the two capture triggers on public.ordenes and sale_evidence.capture_composition_v1() -- after COMMIT the Economy writes
--     exactly as before the layer (no object of the layer is on any Economy write path any more);
--   * records a DETACHED epoch in sale_evidence.capture_epochs, so the gap in the evidence is itself on record;
--   * KEEPS every table and every row of schema sale_evidence (commercial evidence is retained; it is never deleted by a rollback).
-- A later re-apply of the forward file re-attaches the capture and marks every order the gap may have left without complete evidence.
--
-- Refused unless: the layer is attached exactly (two triggers, capture function, last epoch ATTACHED), the role is postgres, and the
-- transaction carries ladieci.fp1_detach_ack = 'DETACH_SALE_EVIDENCE_CAPTURE_ACCEPT_EVIDENCE_GAP'.
-- PRODUCTION: prohibited once any fiscal document references a composition revision (future Fiscal Core); until then it is safe and
-- restores exact Economy behaviour, at the price of a recorded evidence gap.

BEGIN;

SET LOCAL lock_timeout = '15s';

-- the capture triggers go away: take ordenes exclusively FIRST (DROP TRIGGER needs it), before anything else, and hold it to COMMIT
LOCK TABLE public.ordenes IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE
  v_last text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH refused: run as role postgres, not %', current_user;
  END IF;
  IF current_setting('ladieci.fp1_detach_ack', true) IS DISTINCT FROM 'DETACH_SALE_EVIDENCE_CAPTURE_ACCEPT_EVIDENCE_GAP' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH refused: acknowledgement missing (ladieci.fp1_detach_ack); a detach leaves an evidence gap';
  END IF;
  IF to_regnamespace('sale_evidence') IS NULL OR to_regclass('sale_evidence.capture_epochs') IS NULL
     OR to_regprocedure('sale_evidence.capture_composition_v1()') IS NULL
     OR (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass
          AND t.tgname IN ('ordenes_zzz_sale_evidence_capture_ins_v1', 'ordenes_zzz_sale_evidence_capture_upd_v1')
          AND t.tgfoid = to_regprocedure('sale_evidence.capture_composition_v1()')) <> 2 THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH refused: layer 170 is not attached';
  END IF;
  EXECUTE 'SELECT event FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1' INTO v_last;
  IF v_last IS DISTINCT FROM 'ATTACHED' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH refused: last capture epoch is %', COALESCE(v_last, '<none>');
  END IF;
END $guard$;

INSERT INTO sale_evidence.capture_epochs (epoch_no, event, install_mode, orders_marked, note)
SELECT max(epoch_no) + 1, 'DETACHED', NULL, 0,
       'layer 170 detached by migrations/post_freeze/2026-09-28_fiscal_prereq_sale_evidence_v1_layer_170.ROLLBACK.sql (evidence retained; gap starts here)'
  FROM sale_evidence.capture_epochs;

DROP TRIGGER ordenes_zzz_sale_evidence_capture_upd_v1 ON public.ordenes;
DROP TRIGGER ordenes_zzz_sale_evidence_capture_ins_v1 ON public.ordenes;
DROP FUNCTION sale_evidence.capture_composition_v1();

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.ordenes'::regclass AND t.tgname LIKE 'ordenes\_zzz\_sale\_evidence\_%')
     OR to_regprocedure('sale_evidence.capture_composition_v1()') IS NOT NULL THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH post-condition: the capture is still attached';
  END IF;
  IF to_regclass('sale_evidence.composition_revisions') IS NULL OR to_regclass('sale_evidence.composition_lines') IS NULL
     OR to_regclass('sale_evidence.history_gap_markers') IS NULL THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH post-condition: evidence tables must be retained';
  END IF;
  IF (SELECT event FROM sale_evidence.capture_epochs ORDER BY epoch_no DESC LIMIT 1) <> 'DETACHED' THEN
    RAISE EXCEPTION 'SALE_EVIDENCE_DETACH post-condition: the DETACHED epoch is not recorded';
  END IF;
END $post$;

COMMIT;
