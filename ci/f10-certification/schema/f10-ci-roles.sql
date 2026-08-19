-- ================================================================
-- F-10.3C CI-ONLY ROLE BOOTSTRAP
-- Implements f10-ci-role-model.json inside the ephemeral CI Postgres.
-- NOT part of the V3 baseline pack. NOT applied anywhere but this
-- disposable CI database. Not a copy of any real Supabase credential.
-- ================================================================

-- PostgREST connects as this role (PGRST_DB_URI). It never itself
-- gets table/function privileges -- it only gets permission to switch
-- into f10_ci_runtime for the duration of a request whose JWT role
-- claim says so, mirroring the authenticator/impersonation pattern.
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE authenticator_login LOGIN NOINHERIT PASSWORD 'ci_only_ephemeral_not_a_secret';
GRANT authenticator TO authenticator_login;

-- The disposable CI-only equivalent of the real backend's service_role
-- authority: LOGIN + BYPASSRLS, scoped to the 20 F-10 tables / 37
-- F-10 functions (plus the CI-only overlap probe below).
CREATE ROLE f10_ci_runtime NOLOGIN NOINHERIT BYPASSRLS;
GRANT f10_ci_runtime TO authenticator;
GRANT f10_ci_runtime TO authenticator_login;

GRANT USAGE ON SCHEMA public TO f10_ci_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO f10_ci_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO f10_ci_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO f10_ci_runtime;
