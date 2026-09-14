'use strict';
// Ephemeral PostgreSQL for the Giro Authority W3 certification. Never points at staging
// or production: it either starts a throwaway embedded cluster or uses an explicitly
// provided throwaway server (CI service container).
//
//   Local: W3_PG_NODE_MODULES=<dir with embedded-postgres@17 and pg>  [W3_PG_DATA_ROOT=<tmp dir>]
//   CI:    PGHOST/PGPORT/PGUSER/PGPASSWORD of a disposable postgres:17 whose bootstrap
//          superuser is NOT named "postgres" (e.g. POSTGRES_USER=supabase_admin), because
//          "postgres" must be the non-superuser BYPASSRLS owner role, as on Supabase.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const REPO = path.join(__dirname, '..', '..', '..');
const CERT = path.join(__dirname, '..');
const PASSWORD = 'ci_only_ephemeral_not_a_secret';

let pgModule = null;
function loadPg() {
  if (pgModule) return pgModule;
  const base = process.env.W3_PG_NODE_MODULES;
  pgModule = base ? require(path.join(base, 'pg')) : require('pg');
  // DATE (oid 1082) stays the literal 'YYYY-MM-DD': a JS Date would shift it by the host TZ.
  pgModule.types.setTypeParser(1082, (v) => v);
  return pgModule;
}

async function loadEmbedded() {
  const base = process.env.W3_PG_NODE_MODULES;
  const entry = base ? pathToFileURL(path.join(base, 'embedded-postgres', 'dist', 'index.js')).href : 'embedded-postgres';
  const mod = await import(entry);
  return mod.default || mod;
}

async function startCluster() {
  if (process.env.PGHOST) {
    return {
      mode: 'external', host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER, password: process.env.PGPASSWORD || '', stop: async () => {},
    };
  }
  const EmbeddedPostgres = await loadEmbedded();
  const root = process.env.W3_PG_DATA_ROOT || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, 'w3-giro-pg-'));
  const port = 56000 + Math.floor(Math.random() * 2000);
  const server = new EmbeddedPostgres({
    databaseDir: dir, port, user: 'supabase_admin', password: PASSWORD, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-c', 'wal_level=logical', '-c', 'max_replication_slots=8', '-c', 'max_wal_senders=8',
      '-c', 'fsync=off', '-c', 'max_connections=120'],
    onLog: () => {},
    onError: (e) => { if (process.env.W3_PG_VERBOSE) console.error(e); },
  });
  await server.initialise();
  await server.start();
  return { mode: 'embedded', host: 'localhost', port, user: 'supabase_admin', password: PASSWORD, dir,
    stop: async () => { await server.stop(); } };
}

async function connect(cl, database, { role = null, name = 'w3' } = {}) {
  const { Client } = loadPg();
  const c = new Client({ host: cl.host, port: cl.port, user: cl.user, password: cl.password, database, application_name: name });
  c.notices = [];
  c.on('notice', (n) => c.notices.push(n));
  await c.connect();
  if (role) await c.query(`SET ROLE ${role}`);
  return c;
}

const ROLES_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    CREATE ROLE postgres LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER CREATEDB CREATEROLE BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN PASSWORD '${PASSWORD}' NOINHERIT;
  END IF;
END $$;
GRANT anon, authenticated, service_role TO authenticator;
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
`;

async function ensureRoles(admin) {
  await admin.query(ROLES_SQL);
  const r = await admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'postgres'");
  if (!r.rows[0] || r.rows[0].rolsuper || !r.rows[0].rolbypassrls) {
    throw new Error('role "postgres" must exist as NOSUPERUSER BYPASSRLS (Supabase shape); use a different bootstrap superuser');
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const readCert = (rel) => fs.readFileSync(path.join(CERT, rel), 'utf8');

// Verbatim function text from a repo migration: CREATE OR REPLACE FUNCTION ... AS $$ ... $$;
function extractFunction(sql, name) {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (i < 0) throw new Error(`function ${name} not found`);
  const j = sql.indexOf('AS $$', i);
  const k = sql.indexOf('$$;', j + 5);
  return sql.slice(i, k + 3);
}

// Live trip RPC definitions: start_rider_trip is defined once (manifest row 23);
// close_rider_trip's latest definition is manifest row 25.
const TRIP_SOURCES = [
  { name: 'start_rider_trip', sig: 'public.start_rider_trip(text)', file: 'migrations/2026-07-20_rider_trip_rpcs.sql' },
  { name: 'close_rider_trip', sig: 'public.close_rider_trip(text)', file: 'migrations/2026-07-21_fix_rider_trip_json_null_idempotency.sql' },
];

async function buildFixtureDb(cl, admin, dbName) {
  await admin.query(`CREATE DATABASE ${dbName} OWNER postgres`);
  const su = await connect(cl, dbName, { name: `w3-su-${dbName}` });
  await su.query(readCert('fixture/staging_shape_v1.sql'));
  const tripEvidence = [];
  await su.query('SET ROLE postgres');
  for (const t of TRIP_SOURCES) {
    const text = extractFunction(readRepo(t.file), t.name);
    tripEvidence.push({ name: t.name, file: t.file, sha256: sha256(text) });
    await su.query(text);
    await su.query(`REVOKE EXECUTE ON FUNCTION ${t.sig} FROM PUBLIC, anon, authenticated; GRANT EXECUTE ON FUNCTION ${t.sig} TO service_role;`);
  }
  await su.query('RESET ROLE');
  return { su, tripEvidence };
}

// Runs a candidate SQL file as role postgres (the Supabase migration role).
async function applyAsPostgres(su, relFile) {
  await su.query('SET ROLE postgres');
  try {
    await su.query(readCert(relFile));
  } catch (e) {
    // The candidate files carry their own BEGIN: a refusal leaves the block aborted.
    await su.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await su.query('RESET ROLE').catch(() => {});
  }
}

async function cloneDb(admin, template, name) {
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template} OWNER postgres`);
}

module.exports = {
  REPO, CERT, startCluster, connect, ensureRoles, buildFixtureDb, applyAsPostgres, cloneDb,
  extractFunction, readRepo, readCert, sha256,
};
