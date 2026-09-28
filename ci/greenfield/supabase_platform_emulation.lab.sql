-- ci/greenfield/supabase_platform_emulation.lab.sql
--
-- PLATFORM_PREREQUISITES -- LAB EMULATION ONLY. NEVER RUN ON A SUPABASE PROJECT (every Supabase project already provides all of this).
--
-- The V3 greenfield baseline (migrations/baseline/2026-09-27_v3_greenfield_baseline_tip138.sql, LA_DIECI_V3_SCHEMA) is written for a
-- Supabase PostgreSQL 17 database. On a plain PostgreSQL 17 cluster this file stands in for the parts of the Supabase platform the
-- application schema depends on, reproducing the platform state measured read-only on staging (tdikhfeinufaahagmpjz, 2026-09-27):
--   roles       anon / authenticated (NOLOGIN, INHERIT), service_role (NOLOGIN, INHERIT, BYPASSRLS), authenticator (LOGIN, NOINHERIT),
--               postgres (LOGIN, NOT superuser, BYPASSRLS, member of the three API roles), supabase_auth_admin (owner of auth);
--               role settings: anon statement_timeout 3s, authenticated 8s, postgres search_path "\$user", public, extensions
--   schema      public (owner pg_database_owner, USAGE for postgres + the three API roles)
--   extensions  schema extensions: pgcrypto 1.3 (the only extension the application uses: extensions.digest)
--   auth        auth.users (the columns the application touches: id) + auth.uid() / auth.role() / auth.jwt()
--   realtime    publication supabase_realtime (owner postgres, empty: the baseline adds the three application tables)
--   registry    supabase_migrations.schema_migrations (version, name, statements) -- the Supabase migration registry
--   defaults    ALTER DEFAULT PRIVILEGES in schema public for roles postgres and supabase_admin: ALL on tables / sequences / functions to
--               postgres, anon, authenticated, service_role (exactly the six staging entries for schema public; no global entries exist)
-- NOT emulated (not used by the application schema): uuid-ossp, pg_cron (no jobs), pg_stat_statements, supabase_vault, storage, graphql, realtime
-- messages publication, supautils / safeupdate preload, authenticator timeouts.
--
-- Usage (as the cluster superuser, supabase_admin in the lab), on an EMPTY database owned by postgres:
--   psql -U supabase_admin -d <db> -v ON_ERROR_STOP=1 -1 -f ci/greenfield/supabase_platform_emulation.lab.sql
-- The role part is cluster-global and idempotent; the database part refuses a database that already has it.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN NOSUPERUSER INHERIT CREATEDB CREATEROLE BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN INHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN INHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN INHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT; END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'platform emulation: role postgres must NOT be a superuser (Supabase semantics); initialise the lab cluster with -U supabase_admin';
  END IF;
END $roles$;
GRANT anon, authenticated, service_role TO authenticator;
GRANT anon, authenticated, service_role TO postgres;
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE postgres SET search_path = "\$user", public, extensions;

DO $db$
BEGIN
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> 'postgres' THEN
    RAISE EXCEPTION 'platform emulation: the database must be owned by postgres (CREATE DATABASE ... OWNER postgres)';
  END IF;
  IF to_regnamespace('auth') IS NOT NULL OR to_regnamespace('extensions') IS NOT NULL OR to_regnamespace('supabase_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'platform emulation: this database already has platform schemas';
  END IF;
END $db$;

-- public: Supabase keeps the PostgreSQL 15+ owner (pg_database_owner) and adds USAGE for postgres and the API roles.
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;

-- extensions
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions VERSION '1.3';
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- auth (owned by the auth admin; postgres holds ALL on its tables, as on Supabase)
CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
CREATE TABLE auth.users (
  instance_id uuid, id uuid PRIMARY KEY, aud varchar(255), role varchar(255), email varchar(255), encrypted_password varchar(255),
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), phone text, is_anonymous boolean NOT NULL DEFAULT false
);
ALTER TABLE auth.users OWNER TO supabase_auth_admin;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''), (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $f$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $f$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
  $f$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim', true), ''), NULLIF(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.jwt() OWNER TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO postgres, anon, authenticated, service_role;

-- realtime publication (empty; application tables are added by the application baseline)
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime OWNER TO postgres;

-- Supabase migration registry (the table the Supabase CLI / MCP apply_migration writes)
CREATE SCHEMA supabase_migrations AUTHORIZATION postgres;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
ALTER TABLE supabase_migrations.schema_migrations OWNER TO postgres;

-- default privileges of schema public (the six staging entries)
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
