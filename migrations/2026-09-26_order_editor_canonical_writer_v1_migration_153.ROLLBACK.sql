-- migrations/2026-09-26_order_editor_canonical_writer_v1_migration_153.ROLLBACK.sql
-- Reverses 2026-09-26_order_editor_canonical_writer_v1_migration_153.sql: drops public.order_apply_editor_patch_v1.
-- ORDER: after 154 (reverse order 154 -> 153 -> 152), with the backend of the same package still in place: when the function is gone
-- (PostgREST PGRST202) that backend takes the pre-153 direct PATCH, still classified fail-closed (a refused write is never a success).
-- No data depends on the function (it writes only through the existing ordenes triggers).

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER rollback refused: migration 153 is not applied';
  END IF;
  IF to_regprocedure('public.service_close_day_evidence_digest_v1(timestamptz,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER rollback refused: migration 154 is applied -- roll back in reverse order (154 -> 153 -> 152)';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'order_apply_editor_patch_v1') <> 1 THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER rollback refused: unexpected overload set';
  END IF;
END $guard$;

DROP FUNCTION public.order_apply_editor_patch_v1(text, jsonb, jsonb);

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'order_apply_editor_patch_v1') THEN
    RAISE EXCEPTION 'ORDER_EDITOR_WRITER rollback post-condition failed: function still present';
  END IF;
END $post$;

COMMIT;
