#!/usr/bin/env node
'use strict';
// POST-FREEZE LAYERS -- the ONE lifecycle path for migrations that come AFTER the Economy 139 -> 156 freeze and are NOT part of it.
// Contract: docs/POST_FREEZE_LAYERS_CONTRACT.md. Registry: scripts/lib/postFreezeLayers.js. Exact layer states: scripts/lib/postFreezeLayerChecks.js.
// The Economy chain keeps its own runner (scripts/economyChainApply.js) and its own certification; nothing here applies, rolls back or
// re-certifies an Economy migration, and no Economy file is modified to make this work.
//
// Every mutating step is ONE transaction on ONE direct session (the Economy runner's guarantees, scripts/lib/migrationTx.js: certified bytes,
// `BEGIN; <body> COMMIT;` shape, transaction pooler refused, one server session, a session advisory lock):
//   checks (outside the transaction, read-only) -> BEGIN -> body -> ledger row (kind ddl) + Supabase registry row -> the layer's exact state
//   AND the Economy composite re-checked INSIDE the transaction -> COMMIT. Any failure rolls the whole step back.
//
// ECONOMY COMPOSITE (fail closed). The frozen Economy preflight (scripts/economy139to146Preflight.js, mode POST_APPLY) runs unchanged. Its
// catalog sections (A, B, D, E) must pass. Its ledger section (C) must pass except the two range checks that post-freeze rows make fail
// ("ledger tip max(apply_order)", "ledger rows above 138 = exactly the applied prefix"), and then ONLY if every ledger row above 156 is EXACTLY
// a registered layer (own or external: apply_order + filename + sha256/16). Any unknown row, any other failing check -> refused.
//
// TARGET PROTECTION (before any connection):
//   * the LIVE project ref is refused for EVERY command, read-only ones included;
//   * apply / rollback require --target <id> equal to the target this process would connect to (local:<host>:<port>/<db>,
//     supabase:<project ref>, remote:<host>:<port>/<db>);
//   * a non-local target additionally requires LADIECI_POST_FREEZE_REMOTE_TARGET_ACK=<the same id> in the environment;
//   * after connecting, the server must be the one named (current_database());
//   * the target is read as the pg driver resolves it: a URL without host / port falls back to PGHOST / PGPORT, and a URL whose query
//     string overrides host / hostaddr / port is not classified (refused);
//   * --no-registry is refused for every non-local target (STAGING, LIVE, any Supabase ref, any remote host), for every command, before
//     connecting; after connecting it is refused as well when the database HAS a Supabase registry (supabase_migrations.schema_migrations),
//     so a local-looking path to a real project (tunnel, proxy) cannot skip the registry either.
//
// Commands (connection as scripts/economyChainApply.js: PREFLIGHT_DATABASE_URL, or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE;
// W3_PG_NODE_MODULES for the pg driver):
//   plan                                                  the numbering policy and every registered layer (no connection)
//   verify-files                                          local integrity: own layer files = registry sha256, no unregistered file in
//                                                         migrations/post_freeze, numbers in their domain ranges, Economy 139..156 files
//                                                         = their certified sha256 (no connection)
//   target                                                print the target id this process would connect to (no connection)
//   status                                                READ-ONLY: Economy composite, ledger rows above 156, every own layer's state
//   preflight --layer N                                   READ-ONLY: every check `apply` would make, verdict READY / REFUSED
//   apply --layer N --target <id> [--no-registry]         apply (or re-attach) layer N
//   rollback --layer N --target <id> --ack <ACK> [--no-registry]  the layer's registered rollback (e.g. 170: DETACH, evidence retained)
//   --no-registry: ONLY for an ephemeral LOCAL certification database without a Supabase registry (status / preflight / apply / rollback).
//                  Refused on any non-local target and on any database that has the registry. Never on staging / production.
// Exit code: 0 done (or already in the requested state), 1 refused (nothing changed), 2 usage / target / connection / pooler error.

const fs = require('fs');
const path = require('path');
const PF = require('./economy139to146Preflight.js');
const TX = require('./lib/migrationTx.js');
const REG = require('./lib/postFreezeLayers.js');
const { LAYER_CHECKS } = require('./lib/postFreezeLayerChecks.js');

const ROOT = path.join(__dirname, '..');
const LOCK_SQL = "hashtext('ladieci_post_freeze_layer_apply')";
const ECON_CATALOG = ['A', 'B', 'D', 'E'];
const LEDGER_RANGE_KEYS = [/^ledger tip max\(apply_order\)/, /^ledger rows above 138 = exactly the applied prefix/];
const FORBIDDEN_REFS = Object.freeze({ wnswassgfuuivmfwjxsf: 'LIVE' });          // never, for any command
const KNOWN_REFS = Object.freeze({ tdikhfeinufaahagmpjz: 'STAGING' });
const REMOTE_ACK_ENV = 'LADIECI_POST_FREEZE_REMOTE_TARGET_ACK';
const ownLayer = (n) => { const l = REG.layerOf(n); return l && l.status === 'OWN' ? l : null; };
const failing = (rows, sections) => rows.filter((r) => (!sections || sections.includes(r.sec)) && r.ok !== true && r.sec !== 'Z').map((r) => `[${r.sec}] ${r.k} got=${r.got} want=${r.want}`);

// ── target ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function describeTarget(env = process.env) {
  const raw = env.PREFLIGHT_DATABASE_URL || '';
  let host = env.PGHOST || ''; let port = String(env.PGPORT || '5432'); let db = env.PGDATABASE || env.PGUSER || ''; let user = env.PGUSER || '';
  if (raw) {
    let u; try { u = new URL(raw); } catch (_) { u = null; }
    if (!u) return { ok: false, reason: 'PREFLIGHT_DATABASE_URL is not a URL (a libpq keyword string cannot be classified: refused)' };
    // the pg driver lets the query string override the authority, and falls back to PGHOST / PGPORT when the URL has none
    const over = ['host', 'hostaddr', 'port'].filter((k) => u.searchParams.has(k));
    if (over.length) return { ok: false, reason: `PREFLIGHT_DATABASE_URL overrides ${over.join(' / ')} in its query string (cannot be classified: refused)` };
    host = u.hostname || env.PGHOST || ''; port = u.port || env.PGPORT || '5432'; db = decodeURIComponent(u.pathname.replace(/^\//, '')) || decodeURIComponent(u.username || ''); user = decodeURIComponent(u.username || '');
  }
  const haystack = [raw, host, user, db, env.PGHOST || '', env.PGUSER || ''].join(' ').toLowerCase();
  for (const [ref, label] of Object.entries(FORBIDDEN_REFS)) if (haystack.includes(ref)) return { ok: false, forbidden: label, reason: `refused: the ${label} project (${ref}) is never a target of this runner` };
  const refM = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(host) || /^postgres\.([a-z0-9]{20})$/.exec(user);
  const local = host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('/');
  if (refM) return { ok: true, kind: 'SUPABASE', id: `supabase:${refM[1]}`, ref: refM[1], known: KNOWN_REFS[refM[1]] || null, host, port, db };
  if (/supabase\.(co|com)$/.test(host)) return { ok: false, reason: `refused: a Supabase host whose project ref cannot be read (${host})` };
  if (local) return { ok: true, kind: 'LOCAL', id: `local:${host || 'socket'}:${port}/${db}`, host, port, db };
  return { ok: true, kind: 'REMOTE', id: `remote:${host}:${port}/${db}`, host, port, db };
}

// Mutating commands: the operator names the target, and a non-local one is acknowledged a second time through the environment.
function checkMutationTarget(target, requested, env = process.env) {
  if (!target.ok) return { code: 2, result: 'REFUSED_TARGET', detail: target.reason };
  if (!requested) return { code: 2, result: 'REFUSED_TARGET_NOT_NAMED', detail: `pass --target ${target.id}` };
  if (requested !== target.id) return { code: 2, result: 'REFUSED_TARGET_MISMATCH', detail: `--target ${requested} but this process would connect to ${target.id}` };
  if (target.kind !== 'LOCAL' && env[REMOTE_ACK_ENV] !== target.id) {
    return { code: 2, result: 'REFUSED_REMOTE_TARGET_NOT_ACKNOWLEDGED', detail: `${target.id}${target.known ? ` (${target.known})` : ''} is not local: set ${REMOTE_ACK_ENV}=${target.id} as well` };
  }
  return null;
}

// --no-registry skips the Supabase registry row and its check: only for an ephemeral LOCAL certification database.
function checkNoRegistryTarget(target) {
  if (!target.ok) return { code: 2, result: 'REFUSED_TARGET', detail: target.reason };
  if (target.kind !== 'LOCAL') return { code: 2, result: 'REFUSED_NO_REGISTRY_NOT_LOCAL', detail: `--no-registry is refused on ${target.id}${target.known ? ` (${target.known})` : ''}: only an ephemeral local database without a Supabase registry` };
  return null;
}

// ... and only when the database really has no registry (a local-looking path to a real project has one). Read-only; before any write.
async function checkNoRegistryDatabase(client) {
  const r = (await client.query("SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL AS present")).rows[0];
  return r.present === true ? { code: 2, result: 'REFUSED_NO_REGISTRY_REGISTRY_PRESENT', detail: 'this database has a Supabase registry (supabase_migrations.schema_migrations): --no-registry is refused' } : null;
}

async function assertConnectedTarget(client, target) {
  const r = (await client.query('SELECT current_database() AS db')).rows[0];
  if (target.kind !== 'SUPABASE' && target.db && r.db !== target.db) throw Object.assign(new Error(`connected to database ${r.db}, target names ${target.db}`), { code: 'TARGET' });
}

// ── local files ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function readCertified(l, rollback = false) {
  const rel = l.dir + '/' + (rollback ? l.file.replace(/\.sql$/, '.ROLLBACK.sql') : l.file);
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (TX.sha256(Buffer.from(text, 'utf8')) !== (rollback ? l.rbkSha : l.sha)) throw Object.assign(new Error(`${rel} is not the certified file`), { code: 'FILE_NOT_CERTIFIED' });
  return { rel, text, body: TX.txBody(text, rel) };
}

function verifyFiles() {
  const problems = [];
  const seen = new Set();
  for (const l of REG.POST_FREEZE_LAYERS) {
    if (seen.has(l.n)) problems.push(`number ${l.n} registered twice`);
    seen.add(l.n);
    if (l.n <= REG.ECONOMY_FROZEN_TIP) problems.push(`layer ${l.n} is inside the frozen Economy range`);
    const d = REG.domainOf(l.n);
    if (!d || d.domain !== l.domain) problems.push(`layer ${l.n} (${l.domain}) is outside its domain range`);
    if (!new RegExp(`_(layer|migration)_${l.n}\\.sql$`).test(l.file)) problems.push(`layer ${l.n}: file name ${l.file} does not carry its number`);
    if (l.status === 'OWN') {
      for (const rb of [false, true]) { try { readCertified(l, rb); } catch (e) { problems.push(e.message); } }
      if (!LAYER_CHECKS[l.n]) problems.push(`layer ${l.n} has no state check`);
      if (!l.rollback || !l.applyFrom) problems.push(`layer ${l.n} has no rollback / applyFrom policy`);
    }
  }
  if (new Set(REG.POST_FREEZE_LAYERS.map((l) => l.file)).size !== REG.POST_FREEZE_LAYERS.length) problems.push('a file name is registered twice');
  const dir = path.join(ROOT, 'migrations/post_freeze');
  const own = new Set(REG.POST_FREEZE_LAYERS.filter((l) => l.status === 'OWN').flatMap((l) => [l.file, l.file.replace(/\.sql$/, '.ROLLBACK.sql')]));
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (f.endsWith('.sql') && !own.has(f)) problems.push(`migrations/post_freeze/${f} is not a registered OWN layer file`);
  for (const c of PF.CHAIN) {
    for (const [f, want] of [[c.file, c.sha], [c.file.replace(/\.sql$/, '.ROLLBACK.sql'), c.rbkSha]]) {
      const got = TX.sha256(fs.readFileSync(path.join(ROOT, 'migrations', f)));
      if (got !== want) problems.push(`Economy file migrations/${f} is not its certified bytes`);
    }
  }
  return { code: problems.length ? 1 : 0, result: problems.length ? 'FILES_NOT_CERTIFIED' : 'FILES_CERTIFIED', problems,
    economyFiles: PF.CHAIN.length * 2, ownLayers: REG.POST_FREEZE_LAYERS.filter((l) => l.status === 'OWN').map((l) => l.n) };
}

// ── database checks ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function ledgerAbove(client) {
  return (await client.query('SELECT apply_order, filename, checksum_sha256 FROM public.ladieci_schema_migrations WHERE apply_order > $1 ORDER BY apply_order', [REG.ECONOMY_FROZEN_TIP])).rows;
}

async function economyComposite(client, { noRegistry = false, inTx = false } = {}) {
  const sql = PF.renderSql('POST_APPLY', { noRegistry });
  const rows = inTx ? (await client.query(sql)).rows : await PF.runSql(client, sql);
  const catalogOk = rows.filter((r) => ECON_CATALOG.includes(r.sec)).every((r) => r.ok === true);
  const ledgerBad = rows.filter((r) => r.sec === 'C' && r.ok !== true);
  const led = await ledgerAbove(client);
  const unknownRows = led.filter((r) => !REG.isCertifiedPostFreezeRow(r)).map((r) => `${r.apply_order} ${r.filename} ${r.checksum_sha256}`);
  const onlyRangeChecks = ledgerBad.every((r) => LEDGER_RANGE_KEYS.some((re) => re.test(r.k)));
  const ok = catalogOk && unknownRows.length === 0 && (ledgerBad.length === 0 || (led.length > 0 && onlyRangeChecks));
  return { ok, economyMode: 'POST_APPLY', catalogOk, postFreezeLedgerRows: led.map((r) => r.apply_order), unknownPostFreezeRows: unknownRows,
    ledgerRangeChecksExplainedByPostFreezeRows: ledgerBad.length ? onlyRangeChecks : null, detail: ok ? [] : failing(rows) };
}

async function layerState(client, l) {
  const chk = LAYER_CHECKS[l.n];
  const s = await chk.read(client);
  return { ...s, state: chk.classify(s) };
}

// Collisions: a ledger row with this number but another file, or this file under another number.
async function ledgerCollision(client, l) {
  const rows = (await client.query('SELECT apply_order, filename, checksum_sha256 FROM public.ladieci_schema_migrations WHERE apply_order = $1 OR filename = $2', [l.n, l.file])).rows;
  const bad = rows.filter((r) => !(r.apply_order === l.n && r.filename === l.file && r.checksum_sha256 === l.sha.slice(0, 16)));
  return { present: rows.length === 1 && bad.length === 0, collisions: bad.map((r) => `${r.apply_order} ${r.filename} ${r.checksum_sha256}`) };
}

async function withLock(client, fn) {
  const r = await client.query(`SELECT pg_try_advisory_lock(${LOCK_SQL}) AS ok`);
  if (r.rows[0].ok !== true) return { code: 1, result: 'RUNNER_BUSY' };
  try { await TX.assertLockOwned(client, LOCK_SQL); return await fn(); } finally { await client.query(`SELECT pg_advisory_unlock(${LOCK_SQL})`).catch(() => {}); }
}

// Everything `apply` checks before BEGIN; also the READ-ONLY `preflight`.
async function applyChecks(client, l, { noRegistry = false, inTx = false } = {}) {
  const reasons = [];
  const econ = await economyComposite(client, { noRegistry, inTx });
  if (!econ.ok) reasons.push({ code: 'ECONOMY_NOT_POST_APPLY_OR_UNKNOWN_LEDGER', detail: econ });
  const col = await ledgerCollision(client, l);
  if (col.collisions.length) reasons.push({ code: 'LEDGER_NUMBER_OR_FILE_COLLISION', detail: col.collisions });
  for (const req of l.requires || []) {
    const rl = ownLayer(req);
    const st = rl ? (await layerState(client, rl)).state : ((await ledgerCollision(client, REG.layerOf(req))).present ? 'LEDGER_ONLY' : 'ABSENT');
    if (st !== 'APPLIED' && st !== 'LEDGER_ONLY') reasons.push({ code: 'REQUIRED_LAYER_MISSING', detail: `${req}: ${st}` });
  }
  const before = await layerState(client, l);
  if (before.state === 'DRIFT') reasons.push({ code: 'LAYER_DRIFT', detail: before });
  else if (before.state !== 'APPLIED' && !l.applyFrom.includes(before.state)) reasons.push({ code: 'LAYER_STATE_NOT_APPLICABLE', detail: before.state });
  if (before.state === 'APPLIED' && !col.present) reasons.push({ code: 'APPLIED_WITHOUT_LEDGER_ROW', detail: 'the layer objects exist but its ledger row does not' });
  if (before.state === 'ABSENT' && col.present) reasons.push({ code: 'LEDGER_ROW_WITHOUT_LAYER', detail: 'a ledger row exists for a layer whose objects are absent' });
  return { reasons, econ, ledgerRowPresent: col.present, before };
}

// ── commands ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function status(client, { noRegistry = false } = {}) {
  if (noRegistry) { const g = await checkNoRegistryDatabase(client); if (g) return g; }
  const econ = await economyComposite(client, { noRegistry });
  const layers = [];
  for (const l of REG.POST_FREEZE_LAYERS) {
    const col = await ledgerCollision(client, l);
    const entry = { n: l.n, domain: l.domain, name: l.name, status: l.status, ledgerRow: col.present, collisions: col.collisions };
    if (l.status === 'OWN') { const s = await layerState(client, l); entry.state = s.state; entry.detail = s; }
    layers.push(entry);
  }
  return { code: 0, economy: econ, layers };
}

async function preflight(client, n, { noRegistry = false } = {}) {
  const l = ownLayer(n);
  if (!l) return { code: 2, result: 'USAGE', detail: `layer ${n} is not an OWN registered layer` };
  try { readCertified(l); readCertified(l, true); } catch (e) { return { code: 1, result: 'REFUSED_FILE_NOT_CERTIFIED', detail: e.message }; }
  if (noRegistry) { const g = await checkNoRegistryDatabase(client); if (g) return g; }
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    const c = await applyChecks(client, l, { noRegistry, inTx: true });
    const verdict = c.before.state === 'APPLIED' && !c.reasons.length ? 'ALREADY_APPLIED' : c.reasons.length ? 'REFUSED' : 'READY';
    return { code: verdict === 'REFUSED' ? 1 : 0, result: verdict, layer: n, state: c.before.state, reasons: c.reasons, economy: { ok: c.econ.ok, postFreezeLedgerRows: c.econ.postFreezeLedgerRows } };
  } finally { await client.query('ROLLBACK').catch(() => {}); }
}

async function apply(client, n, { noRegistry = false, log = console.error } = {}) {
  const l = ownLayer(n);
  if (!l) return { code: 2, result: 'USAGE', detail: `layer ${n} is not an OWN registered layer` };
  let f; try { f = readCertified(l); readCertified(l, true); } catch (e) { return { code: 1, result: 'REFUSED_FILE_NOT_CERTIFIED', detail: e.message }; }
  if (noRegistry) { const g = await checkNoRegistryDatabase(client); if (g) return g; }
  return withLock(client, async () => {
    const c = await applyChecks(client, l, { noRegistry });
    if (c.before.state === 'APPLIED' && !c.reasons.length) return { code: 0, result: 'ALREADY_APPLIED', layer: n };
    if (c.reasons.length) return { code: 1, result: 'REFUSED', layer: n, reasons: c.reasons };
    await client.query('BEGIN');
    try {
      await client.query(f.body);
      if (!c.ledgerRowPresent) {
        await TX.recordApplied(client, { filename: l.file, text: f.text, applyOrder: l.n, appliedBy: 'postFreezeLayerApply', noRegistry,
          method: `post-freeze layer ${l.n} (${l.domain}): certified sha256; Economy POST_APPLY composite + exact layer state re-checked inside the same transaction (scripts/postFreezeLayerApply.js)`,
          notes: `NOT part of the Economy 139-156 freeze (docs/POST_FREEZE_LAYERS_CONTRACT.md; ${l.contract || ''})` });
      } else if (!noRegistry) await TX.ensureRegistry(client, { filename: l.file, text: f.text });   // re-apply after a rollback: the ledger row is immutable
      const after = await layerState(client, l);
      if (after.state !== 'APPLIED') throw Object.assign(new Error('layer state is not APPLIED inside the transaction'), { detail: after });
      const econ2 = await economyComposite(client, { noRegistry, inTx: true });
      if (!econ2.ok) throw Object.assign(new Error('Economy composite fails inside the transaction'), { detail: econ2 });
      await client.query('COMMIT');
      log(`layer ${l.n} ${l.name} committed (${c.before.state} -> APPLIED)`);
      return { code: 0, result: `APPLIED_${l.n}`, from: c.before.state, to: 'APPLIED' };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { code: 1, result: 'REFUSED_ROLLED_BACK', layer: n, detail: e.detail || e.message };
    }
  });
}

async function rollback(client, n, { ack = null, noRegistry = false, log = console.error } = {}) {
  const l = ownLayer(n);
  if (!l || !l.rollback) return { code: 2, result: 'USAGE', detail: `layer ${n} has no registered rollback` };
  if (ack !== l.rollback.ack) return { code: 1, result: 'REFUSED_ACK', detail: `rollback of ${n} (${l.rollback.kind}: ${l.rollback.meaning}) requires --ack ${l.rollback.ack}` };
  let f; try { f = readCertified(l, true); readCertified(l); } catch (e) { return { code: 1, result: 'REFUSED_FILE_NOT_CERTIFIED', detail: e.message }; }
  if (noRegistry) { const g = await checkNoRegistryDatabase(client); if (g) return g; }
  return withLock(client, async () => {
    const econ = await economyComposite(client, { noRegistry });
    if (!econ.ok) return { code: 1, result: 'REFUSED_ECONOMY_NOT_POST_APPLY_OR_UNKNOWN_LEDGER', detail: econ };
    const before = await layerState(client, l);
    if (before.state !== 'APPLIED') return { code: 1, result: 'REFUSED_NOT_APPLIED', detail: before };
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', [l.rollback.ackGuc, ack]);
      await client.query(f.body);                                                   // its own guard: acknowledgement, exact attached state
      const after = await layerState(client, l);
      if (after.state !== l.rollback.to) throw Object.assign(new Error(`state is not ${l.rollback.to} inside the transaction`), { detail: after });
      const econ2 = await economyComposite(client, { noRegistry, inTx: true });
      if (!econ2.catalogOk) throw Object.assign(new Error('Economy catalog changed'), { detail: econ2 });
      await client.query('COMMIT');
      log(`rollback (${l.rollback.kind}) of layer ${l.n} committed: ${l.rollback.meaning}; the ledger keeps row ${l.n}`);
      return { code: 0, result: `ROLLED_BACK_${l.n}`, kind: l.rollback.kind, from: 'APPLIED', to: l.rollback.to };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { code: 1, result: 'REFUSED_ROLLED_BACK', layer: n, detail: e.detail || e.message };
    }
  });
}

function plan() {
  return { code: 0, economy: `139 .. ${REG.ECONOMY_FROZEN_TIP} frozen (141 / 142 void)`, domains: REG.DOMAINS,
    layers: REG.POST_FREEZE_LAYERS.map((l) => ({ n: l.n, domain: l.domain, status: l.status, name: l.name, file: `${l.dir}/${l.file}`, requires: l.requires || [], rollback: l.rollback ? l.rollback.kind : null })) };
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

module.exports = { describeTarget, checkMutationTarget, checkNoRegistryTarget, checkNoRegistryDatabase, verifyFiles, readCertified, economyComposite, layerState, applyChecks, status, preflight, apply, rollback, plan, connect,
  FORBIDDEN_REFS, KNOWN_REFS, REMOTE_ACK_ENV };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const out = (r) => { console.log(JSON.stringify(r, null, 1)); process.exit(r.code); };
    const usage = 'usage: postFreezeLayerApply.js plan | verify-files | target | status | preflight --layer N | apply --layer N --target <id> [--no-registry] | rollback --layer N --target <id> --ack <ACK> [--no-registry]';
    if (!['plan', 'verify-files', 'target', 'status', 'preflight', 'apply', 'rollback'].includes(cmd)) { console.error(usage); process.exit(2); }
    if (cmd === 'plan') out(plan());
    if (cmd === 'verify-files') out(verifyFiles());
    const target = describeTarget();
    if (cmd === 'target') out({ code: target.ok ? 0 : 2, target });
    if (!target.ok) out({ code: 2, result: 'REFUSED_TARGET', detail: target.reason });
    const n = Number(opt('--layer'));
    if (['preflight', 'apply', 'rollback'].includes(cmd) && !Number.isInteger(n)) { console.error(usage); process.exit(2); }
    const noRegistry = rest.includes('--no-registry');
    if (noRegistry) { const t = checkNoRegistryTarget(target); if (t) out(t); }
    if (cmd === 'apply' || cmd === 'rollback') { const t = checkMutationTarget(target, opt('--target')); if (t) out(t); }
    let client;
    try { client = await connect(); await assertConnectedTarget(client, target); } catch (e) { console.error('connection error: ' + e.message); process.exit(2); }
    try {
      const r = cmd === 'status' ? await status(client, { noRegistry })
        : cmd === 'preflight' ? await preflight(client, n, { noRegistry })
          : cmd === 'apply' ? await apply(client, n, { noRegistry })
            : await rollback(client, n, { ack: opt('--ack') || null, noRegistry });
      console.log(JSON.stringify({ target: target.id, ...r }, null, 1)); process.exit(r.code);
    } finally { await client.end().catch(() => {}); }
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
