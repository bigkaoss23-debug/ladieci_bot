-- GIRO AUTHORITY V1 -- ROLLBACK of the W3 candidate (giro_authority_v1.sql). UNNUMBERED.
-- Exact reversal, explicit drops only (no CASCADE), refused when it would lose data or
-- orphan the W5 trigger. Roll W5 (giro_intent_capture_trigger_v1) back first.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'giro_authority') THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 rollback refused: schema giro_authority not found -- nothing to roll back';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
              WHERE t.tgrelid = 'public.ordenes'::regclass AND p.pronamespace = 'giro_authority'::regnamespace) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 rollback refused: the W5 capture trigger is installed on ordenes -- roll W5 back first';
  END IF;
  IF EXISTS (SELECT 1 FROM giro_authority.giro_members) OR EXISTS (SELECT 1 FROM giro_authority.giro_intents)
     OR EXISTS (SELECT 1 FROM public.manual_giros
                 WHERE business_date IS NOT NULL OR anchor_order_uid IS NOT NULL OR dissolved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 rollback refused: Giro Authority data exists -- an explicit data plan is required first';
  END IF;
END $$;

DROP FUNCTION public.giro_projection_v1(uuid[]);
DROP FUNCTION public.giro_authority_consume_intent_v1(uuid, text, uuid[]);
DROP FUNCTION public.giro_authority_set_hora_ref_v1(text, text, text, uuid[]);
DROP FUNCTION public.giro_authority_dissolve_v1(text, text, uuid[]);
DROP FUNCTION public.giro_authority_move_v1(uuid, text, text, uuid[]);
DROP FUNCTION public.giro_authority_detach_v1(uuid, text, uuid[]);
DROP FUNCTION public.giro_authority_attach_v1(text, uuid, text, uuid[]);
DROP FUNCTION public.giro_authority_create_v1(uuid[], text, uuid, text, uuid[]);

DROP FUNCTION giro_authority.capture_giro_intent_v1();
DROP FUNCTION giro_authority.resolve_intent_v1(uuid, text, text, text, text, text, jsonb);
DROP FUNCTION giro_authority.intent_outcome_v1(giro_authority.giro_intents, boolean);
DROP FUNCTION giro_authority.put_member_v1(uuid, text, text);
DROP FUNCTION giro_authority.insert_giro_v1(date, text, uuid, text);
DROP FUNCTION giro_authority.lock_orders_v1(uuid[]);
DROP FUNCTION giro_authority.refusal_v1(text, jsonb);
DROP FUNCTION giro_authority.actor_valid_v1(text);
DROP FUNCTION giro_authority.scope_valid_v1(uuid[]);
DROP FUNCTION giro_authority.member_refusal_v1(boolean, text, text, uuid, boolean, uuid, uuid[]);
DROP FUNCTION giro_authority.target_fingerprint_v1(text, text, uuid);
DROP FUNCTION giro_authority.order_effective_giro_v1(uuid, uuid[], jsonb);
DROP FUNCTION giro_authority.order_facts_v1(uuid[], jsonb);
DROP FUNCTION giro_authority.derive_giros_v1(text[], uuid[], jsonb);
DROP FUNCTION giro_authority.trip_facts_v1();
DROP FUNCTION giro_authority.service_day_minutes(text);
DROP FUNCTION giro_authority.hhmm_norm(text);
DROP FUNCTION giro_authority.cancelled_states_v1();
DROP FUNCTION giro_authority.delivered_states_v1();

DROP TRIGGER giro_intents_one_shot_guard_v1 ON giro_authority.giro_intents;
DROP FUNCTION giro_authority.giro_intents_one_shot_guard_v1();
DROP TABLE giro_authority.giro_intents;
DROP TABLE giro_authority.giro_members;
DROP SCHEMA giro_authority;

ALTER TABLE public.manual_giros
  DROP CONSTRAINT manual_giros_dissolved_by_chk,
  DROP CONSTRAINT manual_giros_business_date_mirror_chk,
  DROP CONSTRAINT manual_giros_anchor_order_uid_fkey;
ALTER TABLE public.manual_giros
  DROP COLUMN dissolved_by,
  DROP COLUMN anchor_order_uid,
  DROP COLUMN business_date;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'giro_authority')
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
                  AND (proname LIKE 'giro\_authority\_%' OR proname = 'giro_projection_v1'))
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'manual_giros'
                  AND column_name IN ('business_date', 'anchor_order_uid', 'dissolved_by')) THEN
    RAISE EXCEPTION 'GIRO_AUTHORITY_V1 rollback post-condition failed: an Authority object survived';
  END IF;
END $$;

COMMIT;
