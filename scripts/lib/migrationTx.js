'use strict';
// scripts/lib/migrationTx.js -- shared by scripts/economyChainApply.js and scripts/economy149150GuardedStep.js.
//
// ONE certified migration file = ONE transaction that ALSO writes its migration-ledger row (public.ladieci_schema_migrations) and its
// Supabase registry row (supabase_migrations.schema_migrations, statements[1] = the exact file text, the byte proof the preflight checks).
// Every chain file is `<comment header> BEGIN; <body> COMMIT; <comments>`. txBody() proves that shape and returns <body>, so the caller can
// run several bodies plus the bookkeeping inside ONE transaction of its own: nothing is ever visible half-applied, and a failure anywhere
// rolls everything back. The file bytes themselves are verified against their certified sha256 BEFORE this is called.

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function txBody(text, label) {
  const lines = text.split('\n');
  const idx = (re) => lines.map((l, i) => (re.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const b = idx(/^BEGIN;$/); const c = idx(/^COMMIT;$/);
  if (b.length !== 1 || c.length !== 1 || b[0] > c[0]) throw Object.assign(new Error(`${label}: expected exactly one "BEGIN;" line before exactly one "COMMIT;" line`), { code: 'FILE_SHAPE' });
  const outside = [...lines.slice(0, b[0]), ...lines.slice(c[0] + 1)].filter((l) => l.trim() !== '' && !/^\s*--/.test(l));
  if (outside.length) throw Object.assign(new Error(`${label}: statements outside its BEGIN / COMMIT: ${outside[0].slice(0, 80)}`), { code: 'FILE_SHAPE' });
  const body = lines.slice(b[0] + 1, c[0]).join('\n');
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im.test(body)) throw Object.assign(new Error(`${label}: a transaction statement inside the body`), { code: 'FILE_SHAPE' });
  return body;
}

// Registry versions are the Supabase CLI's 14-digit timestamps; they only have to be unique and increasing.
async function nextRegistryVersion(client, now = new Date()) {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const r = await client.query("SELECT max(version) AS v FROM supabase_migrations.schema_migrations WHERE version ~ '^[0-9]{14}$'");
  const max = r.rows[0] && r.rows[0].v;
  return max && max >= ts ? String(BigInt(max) + 1n) : ts;
}

// Called INSIDE the caller's open transaction.
async function recordApplied(client, { filename, text, applyOrder, kind = 'ddl', appliedBy, method, notes, noRegistry = false }) {
  await client.query(`INSERT INTO public.ladieci_schema_migrations (filename, checksum_sha256, apply_order, kind, verification_status, applied_by, verified_at, verified_by, verification_method, notes)
    VALUES ($1, $2, $3, $4, 'verified', $5, now(), $5, $6, $7)`, [filename, sha256(text).slice(0, 16), applyOrder, kind, appliedBy, method, notes || null]);
  if (!noRegistry) await ensureRegistry(client, { filename, text });
}
// The Supabase registry row of a file (byte proof: sha256(statements[1]) = sha256(file)); idempotent.
async function ensureRegistry(client, { filename, text }) {
  const have = await client.query("SELECT 1 FROM supabase_migrations.schema_migrations WHERE encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') = $1", [sha256(text)]);
  if (have.rows.length) return;
  await client.query('INSERT INTO supabase_migrations.schema_migrations (version, name, statements) VALUES ($1, $2, ARRAY[$3::text])',
    [await nextRegistryVersion(client), filename.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/\.sql$/, ''), text]);
}

// The guarded step holds a SESSION advisory lock across statements. Behind a transaction-mode pooler (Supabase: port 6543) consecutive
// statements may run on different server sessions, so the lock would not protect anything. Refuse such a path up front, and prove on the
// wire that the same server session answers every statement and owns the lock.
function refuseTransactionPooler(connectionString = process.env.PREFLIGHT_DATABASE_URL, env = process.env) {
  let port = env.PGPORT; let host = env.PGHOST || '';
  if (connectionString) { try { const u = new URL(connectionString); port = u.port || '5432'; host = u.hostname; } catch (_) { /* libpq keyword string */ } }
  if (String(port) === '6543') throw Object.assign(new Error('refused: port 6543 is the Supabase TRANSACTION pooler; use the direct connection (db.<ref>.supabase.co:5432) or the session pooler'), { code: 'POOLER' });
  return { host, port };
}
async function assertSameSession(client, samples = 4) {
  const pids = [];
  for (let i = 0; i < samples; i += 1) pids.push((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  if (new Set(pids).size !== 1) throw Object.assign(new Error(`refused: statements ran on different server sessions (${[...new Set(pids)].join(', ')}): transaction pooling`), { code: 'POOLER' });
  return pids[0];
}
async function assertLockOwned(client, lockSql) {
  const r = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
      AND objid = (${lockSql}::bigint & 4294967295)::oid AND classid = ((${lockSql}::bigint >> 32) & 4294967295)::oid) AS ok`);
  if (r.rows[0].ok !== true) throw Object.assign(new Error('refused: the session advisory lock is not held by the server session running the step (pooler?)'), { code: 'POOLER' });
}

module.exports = { sha256, txBody, recordApplied, ensureRegistry, nextRegistryVersion, refuseTransactionPooler, assertSameSession, assertLockOwned };
