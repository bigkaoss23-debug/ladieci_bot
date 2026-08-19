-- ================================================================
-- STAGING_RUNTIME_SCHEMA_BASELINE -- V3 SYNTHETIC BOOTSTRAP SEED
-- Apply AFTER staging-schema-head-92-2026-08-19.v3.bootstrap.sql.
-- 3 rows, zero real STAGING data, zero sensitive values. Verbatim from
-- V2 SECTION 9 (which already existed as live executable SQL in V2 --
-- this file only extracts it into its own artifact, byte-identical).
-- ================================================================

INSERT INTO public.business_day_lifecycle_state (singleton) VALUES (true);
INSERT INTO public.service_session_state (singleton) VALUES (true);
INSERT INTO public.workspaces (slug, display_name) VALUES ('f10-ci', 'F-10 CI Workspace');
