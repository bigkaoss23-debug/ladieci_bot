-- migrations/2026-09-26_post_close_obligation_resolution_v1_migration_152.ROLLBACK.sql
-- Reverses 2026-09-26_post_close_obligation_resolution_v1_migration_152.sql: drops the post-close resolution writer, restores the three
-- order_obligations constraints byte for byte, drops the fourth one and the resolution_service_session_id column.
-- ORDER: after 153 (reverse order 154 -> 153 -> 152), with the backend of the package still in place: a closed-service cancel / adjustment it
-- routes here then fails closed (typed ORDER_POST_CLOSE_WRITE_FAILED), never a success. The backend is rolled back only after 151.
-- POINT OF NO RETURN: refused once ANY post-close resolution fact exists. Those revisions are append-only economic facts that the pre-152
-- constraints would reject, and deleting them would rewrite the current obligation of real orders. Past that point the forward state stays.

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'order_obligations' AND column_name = 'resolution_service_session_id') THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION rollback refused: migration 152 is not applied';
  END IF;
  IF to_regprocedure('public.order_apply_editor_patch_v1(text,jsonb,jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION rollback refused: migration 153 is applied -- roll back in reverse order (154 -> 153 -> 152)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.order_obligations WHERE source = 'order_post_close_resolution_v1' OR resolution_service_session_id IS NOT NULL) THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION rollback refused (point of no return): % post-close resolution fact(s) exist; they are append-only and the pre-152 constraints would reject them',
      (SELECT count(*) FROM public.order_obligations WHERE source = 'order_post_close_resolution_v1');
  END IF;
END $guard$;

DROP FUNCTION public.order_post_close_obligation_resolution_v1(uuid,text,numeric,text,text,text,text,numeric,text,uuid,uuid);
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_post_close_resolution_chk;
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_adjustment_provenance_chk;
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_adjustment_provenance_chk
  CHECK (((source <> 'order_commercial_adjustment_v1'::text) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text) AND (by_actor IS NOT NULL) AND (by_role IS NOT NULL) AND (client_request_id IS NOT NULL) AND (request_hash IS NOT NULL))));
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_cause_presence_chk;
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_cause_presence_chk
  CHECK (((cause IS NOT NULL) = (source = 'order_commercial_adjustment_v1'::text)));
ALTER TABLE public.order_obligations DROP CONSTRAINT order_obligations_source_chk;
ALTER TABLE public.order_obligations ADD CONSTRAINT order_obligations_source_chk
  CHECK ((source = ANY (ARRAY['order_create_v1'::text, 'order_total_revision_v1'::text, 'order_commercial_adjustment_v1'::text])));
ALTER TABLE public.order_obligations DROP COLUMN resolution_service_session_id;

DO $post$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.order_obligations'::regclass AND conname = 'order_obligations_source_chk')
       IS DISTINCT FROM 'CHECK ((source = ANY (ARRAY[''order_create_v1''::text, ''order_total_revision_v1''::text, ''order_commercial_adjustment_v1''::text])))'
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'order_post_close_obligation_resolution_v1') THEN
    RAISE EXCEPTION 'POST_CLOSE_RESOLUTION rollback post-condition failed';
  END IF;
END $post$;

COMMIT;
