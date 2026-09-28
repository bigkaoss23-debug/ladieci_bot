#!/usr/bin/env node
'use strict';
// ECONOMY -- THE ONE CANONICAL DEPLOYMENT PATH: V3 GREENFIELD BASELINE (tip 138) -> 139 -> 140 -> 143 -> 144 -> 145 -> 146 -> 147 -> 148
// -> GUARDED(149 + 150) -> [package backend] -> 151 -> 152 -> 153 -> 154 -> 155 -> 156.   141 / 142 (Fiscal) are not part of it.
// Contract: docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md. Install + bootstrap contract: docs/V3_GREENFIELD_INSTALL_AND_BOOTSTRAP_CONTRACT.md.
//
// Every step is ONE transaction on ONE direct session (no transaction pooler, scripts/lib/migrationTx.js):
//   certified bytes (sha256 of the frozen manifest, PF.CHAIN) -> preflight of the starting mode PASS -> BEGIN -> the file body (the file is
//   `BEGIN; <body> COMMIT;`, proved by txBody) -> its ledger row + its Supabase registry row (statements[1] = the exact file text) -> the
//   full preflight of the TARGET mode evaluated inside the uncommitted transaction -> COMMIT. Any failure rolls the step back entirely.
// 149 and 150 are never applied one by one: the step is scripts/economy149150GuardedStep.js (lifecycle lock, no open service, the pair in
// ONE transaction). Supabase MCP apply_migration / the SQL editor / psql -f are NOT deployment paths for this package: they cannot run the
// pair atomically nor write the ledger in the same transaction.
//
// Commands (connection: PREFLIGHT_DATABASE_URL, or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE; W3_PG_NODE_MODULES as for the preflight):
//   plan                                          the canonical sequence (no connection)
//   status                                        READ-ONLY: which mode the database is at (catalog + ledger), open services, H-1 states
//   install-greenfield [--through N] [--no-registry]
//                                                 EMPTY Supabase database (PLATFORM_PREREQUISITES only) -> baseline -> chain up to N (default 156)
//   next [--no-registry] [--package-backend-deployed]
//                                                 an existing V3 database: exactly ONE step forward (149 + 150 = one step). From BEFORE_151
//                                                 on it refuses unless the package backend is live (--package-backend-deployed), except on a
//                                                 database that has never served (no service, no workspace): nothing can call it yet.
//   rollback-one                                  exactly ONE step back (150 -> 148 = one guarded step); the rollback files carry the points
//                                                 of no return (152: a post-close resolution fact; 139: an off-service receipt)
//   --no-registry: ONLY for an ephemeral certification database without a Supabase registry. Never on staging / production.
// Exit code: 0 done, 1 refused (nothing changed), 2 usage / connection / pooler error.

const fs = require('fs');
const path = require('path');
const PF = require('./economy139to146Preflight.js');
const GS = require('./economy149150GuardedStep.js');
const TX = require('./lib/migrationTx.js');
const BL = require('./v3GreenfieldBaseline.js');

const ROOT = path.join(__dirname, '..');
const PIN_FILE = path.join(ROOT, 'migrations/baseline/v3_greenfield_baseline_tip138.fingerprint.json');
const INSTALL_LOCK_SQL = "hashtext('ladieci_economy_chain_apply')";
const MODE_ORDER = Object.keys(PF.MODES);                                   // PRE_APPLY, BEFORE_140, ..., POST_APPLY
const CHAIN_N = PF.CHAIN.map((c) => c.n);
const link = (n) => PF.CHAIN.find((c) => c.n === n);
const modeWith = (applied) => MODE_ORDER.find((m) => JSON.stringify(PF.MODES[m]) === JSON.stringify(applied));
const nextN = (mode) => CHAIN_N[PF.MODES[mode].length];                       // undefined at POST_APPLY
const prevMode = (mode) => modeWith(PF.MODES[mode].slice(0, -1));
const CATALOG = ['A', 'B', 'D', 'E'];
const passes = (rows, sections) => rows.filter((r) => !sections || sections.includes(r.sec)).every((r) => r.ok === true);
const failing = (rows, sections) => rows.filter((r) => (!sections || sections.includes(r.sec)) && r.ok !== true).map((r) => `[${r.sec}] ${r.k} got=${r.got} want=${r.want}`);
const pfRO = (client, mode, noRegistry) => PF.runSql(client, PF.renderSql(mode, { noRegistry }));
const pfInTx = async (client, mode, noRegistry) => (await client.query(PF.renderSql(mode, { noRegistry }))).rows;

function readCertified(n, rollback = false) {
  const rel = 'migrations/' + (rollback ? link(n).file.replace(/\.sql$/, '.ROLLBACK.sql') : link(n).file);
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const want = rollback ? link(n).rbkSha : link(n).sha;
  if (TX.sha256(Buffer.from(text, 'utf8')) !== want) throw Object.assign(new Error(`${rel} is not the certified file`), { code: 'FILE_NOT_CERTIFIED' });
  return { rel, text, body: TX.txBody(text, rel) };
}

// The pinned baseline: the committed file is exactly what the committed catalog generates, and both match the pin.
function certifiedBaseline() {
  const pin = JSON.parse(fs.readFileSync(PIN_FILE, 'utf8'));
  const text = BL.baselineText();
  const cat = BL.load(BL.CATALOG_DIR);
  const problems = [];
  if (BL.generate(cat) !== text) problems.push('the baseline file is not what the catalog generates (run: node scripts/v3GreenfieldBaseline.js verify)');
  if (TX.sha256(Buffer.from(text, 'utf8')) !== pin.baseline_sha256) problems.push('baseline sha256 differs from the pin');
  if (BL.fingerprint(cat).sha256 !== pin.catalog_fingerprint_sha256) problems.push('catalog fingerprint differs from the pin');
  if (problems.length) throw Object.assign(new Error('baseline not certified: ' + problems.join('; ')), { code: 'FILE_NOT_CERTIFIED' });
  return { pin, text, body: TX.txBody(text, BL.BASELINE_FILE), cat };
}

// Current position. Catalog = sections A, B, D, E of each mode; ledger = section C. The first mode whose catalog passes is the position.
async function position(client, noRegistry = true) {
  for (const mode of MODE_ORDER) {
    const rows = await pfRO(client, mode, noRegistry);
    if (passes(rows, CATALOG)) return { mode, ledgerOk: passes(rows, ['C']), ledgerAheadOnly: !passes(rows, ['C']) && (await GS.acceptableLedgerAhead(client, rows)), ledgerDetail: failing(rows, ['C']), rows };
  }
  return { mode: 'OTHER', ledgerOk: false, ledgerDetail: [] };
}
const neverServed = async (client) => (await client.query('SELECT (SELECT count(*) FROM public.service_sessions) = 0 AND (SELECT count(*) FROM public.workspaces) = 0 AS ok')).rows[0].ok === true;

async function applyOne(client, n, { noRegistry, log }) {
  const f = readCertified(n);
  const from = modeWith(CHAIN_N.slice(0, CHAIN_N.indexOf(n)));
  const to = modeWith(CHAIN_N.slice(0, CHAIN_N.indexOf(n) + 1));
  const pre = await pfRO(client, from, noRegistry);
  if (!(await GS.passesOrLedgerAhead(client, pre))) return { code: 1, result: `REFUSED_PREFLIGHT_${from}`, detail: failing(pre) };
  await client.query('BEGIN');
  try {
    await client.query(f.body);
    const has = (await client.query('SELECT checksum_sha256 FROM public.ladieci_schema_migrations WHERE apply_order = $1 AND filename = $2', [n, link(n).file])).rows;
    if (!has.length) {
      await TX.recordApplied(client, { filename: link(n).file, text: f.text, applyOrder: n, appliedBy: 'economyChainApply', noRegistry,
        method: `certified sha256 + preflight ${from} PASS + preflight ${to} PASS inside the same transaction (scripts/economyChainApply.js)` });
    } else if (!noRegistry) await TX.ensureRegistry(client, { filename: link(n).file, text: f.text });   // re-forward after a rollback: the ledger row is immutable
    const post = await pfInTx(client, to, noRegistry);
    if (!(await GS.passesOrLedgerAhead(client, post))) throw Object.assign(new Error(`preflight ${to} fails inside the step`), { detail: failing(post) });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { code: 1, result: `REFUSED_${n}_ROLLED_BACK`, detail: e.detail || e.message };
  }
  log(`${n} committed (${from} -> ${to})`);
  return { code: 0, result: `APPLIED_${n}`, mode: to };
}

async function applyBaseline(client, { noRegistry, log }) {
  const b = certifiedBaseline();
  if ((await client.query('SELECT current_user AS u')).rows[0].u !== 'postgres') return { code: 1, result: 'REFUSED_ROLE', detail: 'install as role postgres (the object owner)' };
  await client.query('BEGIN');
  try {
    await client.query(b.body);                                                  // its own guard refuses a non-greenfield database
    await TX.recordApplied(client, { filename: path.basename(BL.BASELINE_FILE), text: b.text, applyOrder: 138, kind: 'bootstrap', appliedBy: 'economyChainApply', noRegistry,
      method: 'V3 greenfield baseline: structural catalog fingerprint = the pinned staging tip-138 fingerprint, checked inside this transaction (scripts/v3GreenfieldBaseline.js)',
      notes: 'stands for ledger history 1..138 (never replayed file by file); structure only, no business data' });
    // catalog parity INSIDE the transaction: extract with the staging deparse search_path, compare with the pinned catalog
    await client.query(`SET LOCAL search_path = "$user", public, extensions`);
    const got = {};
    for (const [k, q, col] of [['functions', BL.SQL.functions, 'functions'], ['structure', BL.SQL.structure, 'catalog'], ['extras', BL.SQL.extras, 'extras']]) got[k] = (await client.query(q)).rows[0][col];
    const diffs = BL.compare(b.cat, got);
    if (diffs.length) throw Object.assign(new Error('installed catalog differs from the pinned tip-138 catalog'), { detail: diffs.slice(0, 20) });
    const sys = BL.systemRowsProblems((await client.query(BL.SQL.system_rows)).rows[0].system_rows);
    if (sys.length) throw Object.assign(new Error('structural singletons'), { detail: sys });
    const pre = await pfInTx(client, 'PRE_APPLY', noRegistry);
    if (!passes(pre)) throw Object.assign(new Error('preflight PRE_APPLY fails inside the baseline transaction'), { detail: failing(pre) });
    await client.query('COMMIT');
    log(`baseline committed (catalog fingerprint ${BL.fingerprint(got).sha256.slice(0, 16)}..., PRE_APPLY PASS)`);
    return { code: 0, result: 'APPLIED_BASELINE', fingerprint: BL.fingerprint(got).sha256 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { code: 1, result: 'REFUSED_BASELINE_ROLLED_BACK', detail: e.detail || e.message };
  }
}

async function step(client, { noRegistry, backendDeployed, log }) {
  const pos = await position(client, noRegistry);
  if (pos.mode === 'OTHER') return { code: 1, result: 'REFUSED_UNKNOWN_POSITION', detail: 'the catalog is no mode of the chain: run the preflight' };
  if (pos.mode === 'POST_APPLY') return { code: 0, result: 'AT_POST_APPLY', mode: 'POST_APPLY' };
  // "149 without 150" (an interrupted or bypassed step): only the guarded step completes it (it writes the missing ledger / registry rows).
  if (pos.mode !== 'BEFORE_150' && !(await GS.passesOrLedgerAhead(client, pos.rows))) return { code: 1, result: 'REFUSED_LEDGER', detail: pos.ledgerDetail };
  const n = pos.mode === 'BEFORE_150' ? 150 : nextN(pos.mode);
  if (n === 149 || n === 150) {
    const r = await GS.runForward({ client, noRegistry, log });
    return { ...r, mode: r.code === 0 ? 'BEFORE_151' : pos.mode };
  }
  if (n === 151 && !backendDeployed && !(await neverServed(client))) {
    return { code: 1, result: 'REFUSED_BACKEND_POSITION', detail: 'the package backend must be live before 151 (an older backend must never meet the 151 refusals): deploy it, then re-run with --package-backend-deployed' };
  }
  return applyOne(client, n, { noRegistry, log });
}

async function rollbackOne(client, { log = console.error } = {}) {
  const pos = await position(client, true);
  if (pos.mode === 'OTHER' || pos.mode === 'PRE_APPLY') return { code: 1, result: 'REFUSED_NOTHING_TO_ROLL_BACK', detail: pos.mode };
  const applied = PF.MODES[pos.mode] || [];
  const n = pos.mode === 'BEFORE_150' ? 149 : applied[applied.length - 1];
  if (n === 150 || n === 149) {
    const r = await GS.runRollback({ client, log });
    return { ...r, mode: r.code === 0 ? 'BEFORE_149' : pos.mode };
  }
  const f = readCertified(n, true);
  const to = prevMode(pos.mode);
  await client.query('BEGIN');
  try {
    await client.query(f.body);                                                  // the file's own guards: drift, order, point of no return
    const after = await pfInTx(client, to, true);
    if (!passes(after, CATALOG)) throw Object.assign(new Error(`catalog is not ${to} inside the rollback step`), { detail: failing(after, CATALOG) });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { code: 1, result: `REFUSED_RB${n}_ROLLED_BACK`, detail: e.detail || e.message };
  }
  log(`rollback ${n} committed (${pos.mode} -> ${to}); the ledger keeps its row (immutable)`);
  return { code: 0, result: `ROLLED_BACK_${n}`, mode: to };
}

async function withInstallLock(client, fn) {
  const r = await client.query(`SELECT pg_try_advisory_lock(${INSTALL_LOCK_SQL}) AS ok`);
  if (r.rows[0].ok !== true) return { code: 1, result: 'INSTALLER_BUSY', detail: 'another economyChainApply session holds the installer lock' };
  try { await TX.assertLockOwned(client, INSTALL_LOCK_SQL); return await fn(); } finally { await client.query(`SELECT pg_advisory_unlock(${INSTALL_LOCK_SQL})`).catch(() => {}); }
}

async function installGreenfield(client, { through = 156, noRegistry = false, log = console.error } = {}) {
  if (!CHAIN_N.includes(through)) return { code: 2, result: 'USAGE', detail: `--through must be one of ${CHAIN_N.join(', ')}` };
  return withInstallLock(client, async () => {
    const steps = [];
    const b = await applyBaseline(client, { noRegistry, log }); steps.push(b);
    if (b.code) return { ...b, steps };
    for (;;) {
      const pos = await position(client, noRegistry);
      const applied = PF.MODES[pos.mode] || [];
      if (applied.includes(through) || pos.mode === 'POST_APPLY') break;
      if (!(await neverServed(client))) return { code: 1, result: 'REFUSED_TRAFFIC_DURING_INSTALL', detail: 'a service or workspace appeared during the greenfield install', steps };
      const r = await step(client, { noRegistry, backendDeployed: false, log }); steps.push(r);
      if (r.code) return { ...r, steps };
    }
    const endMode = (await position(client, noRegistry)).mode;
    const fin = await pfRO(client, endMode, noRegistry);   // a greenfield install never has a ledger ahead of its catalog: strict
    return { code: passes(fin) ? 0 : 1, result: passes(fin) ? 'INSTALLED' : 'INSTALLED_BUT_PREFLIGHT_FAILS', mode: endMode, detail: failing(fin), steps: steps.map((s) => s.result) };
  });
}

async function connect() {
  TX.refuseTransactionPooler();
  const base = process.env.W3_PG_NODE_MODULES;
  const pg = base ? require(path.join(base, 'pg')) : require('pg');
  const client = process.env.PREFLIGHT_DATABASE_URL ? new pg.Client({ connectionString: process.env.PREFLIGHT_DATABASE_URL }) : new pg.Client();
  await client.connect();
  await client.query("SET client_encoding = 'UTF8'");
  await TX.assertSameSession(client);
  return client;
}

const PLAN = [
  'PLATFORM_PREREQUISITES (Supabase: roles, extensions.pgcrypto, auth.users, supabase_realtime, supabase_migrations, default privileges)',
  'V3 GREENFIELD BASELINE tip 138 (migrations/baseline/2026-09-27_v3_greenfield_baseline_tip138.sql, ledger row 138 kind bootstrap)',
  ...[139, 140, 143, 144, 145, 146, 147, 148].map((n) => `${n}  ${link(n).file}`),
  'GUARDED(149 + 150)  scripts/economy149150GuardedStep.js forward -- ONE transaction, lifecycle lock, no open service',
  '[package backend deployed here on a database that serves; nothing to do on a never-served greenfield database]',
  ...[151, 152, 153, 154, 155, 156].map((n) => `${n}  ${link(n).file}`),
  'BUSINESS BOOTSTRAP (scripts/v3BusinessBootstrap.js): owner claim -> workspace -> canonical actors -> owner PIN -> tables / menu / config',
];

module.exports = { installGreenfield, step, rollbackOne, position, applyBaseline, applyOne, certifiedBaseline, connect, PLAN, MODE_ORDER };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const noRegistry = rest.includes('--no-registry');
    if (cmd === 'plan') { PLAN.forEach((l, i) => console.log(`${String(i + 1).padStart(2)}. ${l}`)); return; }
    if (!['status', 'install-greenfield', 'next', 'rollback-one'].includes(cmd)) {
      console.error('usage: economyChainApply.js plan | status | install-greenfield [--through N] [--no-registry] | next [--no-registry] [--package-backend-deployed] | rollback-one');
      process.exit(2);
    }
    let client;
    try { client = await connect(); } catch (e) { console.error('connection error: ' + e.message); process.exit(2); }
    try {
      let r;
      if (cmd === 'status') {
        const p = await position(client, noRegistry);
        r = { code: 0, mode: p.mode, ledger_consistent: p.ledgerOk, ledger_ahead_of_catalog_only: p.ledgerAheadOnly, ledger_detail: p.ledgerDetail, ...(p.mode !== 'OTHER' ? (await client.query(GS.STATE_SQL)).rows[0] : {}) };
      } else if (cmd === 'install-greenfield') r = await installGreenfield(client, { through: Number(opt('--through') || 156), noRegistry });
      else if (cmd === 'next') r = await withInstallLock(client, () => step(client, { noRegistry, backendDeployed: rest.includes('--package-backend-deployed'), log: console.error }));
      else r = await withInstallLock(client, () => rollbackOne(client, { log: console.error }));
      console.log(JSON.stringify(r, null, 1));
      process.exit(r.code);
    } finally { await client.end().catch(() => {}); }
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
