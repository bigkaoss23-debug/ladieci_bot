#!/usr/bin/env node
'use strict';
// ECONOMY 139 -> 156 -- THE GUARDED 149 + 150 STEP (post-final-blind corrective, finding H-1).
//
// WHY. Migration 149 adds a deferred invariant (service_sessions_close_attempt_terminal_v1) that refuses, AT COMMIT, a terminal close whose
// closeout attempt is still active. The previous backend closes a service in SEVEN separate PostgREST transactions: acquire attempt,
// capture snapshot, report incidents, create_service_closeout, create_service_closeout_reconciliation_v1, close_service_session_v3,
// complete attempt. Against a database at 149 (and not yet 150) the first six commit, close_service_session_v3 is rolled back at COMMIT by
// the 149 trigger, and Finalizar answers an error while a closeout, its snapshot, its reconciliation and its incidents are already
// committed for a service that stays OPEN. Once that service keeps trading, the package backend refuses it forever
// (V3_CLOSE_COMMITTED_EVIDENCE_STALE: the closeout is unique per service and append-only) and the next Business Day's intake is blocked
// (PREVIOUS_SERVICE_PENDING). Migration 150 closes the hole from its side (service_closeouts_terminal_close_v1: a closeout commits only
// together with its terminal close), so the dangerous state exists ONLY while the database rests at "149 without 150" with the previous
// backend live -- which the frozen rollout (149 -> 150 -> backend) and rollback (backend back -> 150 -> 149) both allowed.
//
// THE CONTRACT THIS SCRIPT ENFORCES. 149 and 150 are ONE step, in both directions; the database never rests between them:
//   forward   148 --[149 + 150]--> 150     (a database found at "149 without 150" is completed to 150 by the same command)
//   rollback  150 --[rb150 + rb149]--> 148
// and the step runs only under ALL of these, checked while holding the lock:
//   1. the lifecycle lock pg_advisory_lock(hashtext('service_session_lifecycle')) is held by THIS session for the whole step. Every path
//      that opens a service (resolve_order_intake_context_v1, open_operational_service_v1, the order intake prelude of 143) and the
//      terminal close (close_service_session_v3) take that same lock first, so no service can be opened and no close can reach its
//      terminal step while the step runs;
//   2. NO service is open (every service_sessions row is 'closed'): a Finalizar needs an open service, so none can be in flight, and none
//      can start before the step ends (1.);
//   3. no closeout exists for a service that is not closed (the H-1 state itself), and no closeout attempt is active anywhere;
//   4. the files are the certified bytes (sha256 of the frozen manifest), and the database is EXACTLY the expected prefix (the read-only
//      preflight scripts/economy139to146Preflight.js, same SQL, same session).
// Consequence: whichever backend is live (previous or package), no Finalizar can observe the database between 149 and 150, so the
// partial committed close cannot be produced by the supported rollout or rollback. Every other (backend, step) pair of the chain was
// measured fail-closed with no partial close (EVIDENCE: phase3_rollout_rollback_variants.json, phase8 matrix).
// ATOMICITY (greenfield finalization cycle, 2026-09-27). The pair is applied as ONE transaction: the two certified bodies (each file is
// `BEGIN; <body> COMMIT;`, proved by scripts/lib/migrationTx.js txBody), their two ledger rows and their two Supabase registry rows, and the
// full preflight of the target mode evaluated INSIDE that still-uncommitted transaction; only then COMMIT. Nothing of 149 is ever visible to
// any other session without 150 -- not even to a session that bypassed the lifecycle lock -- and any failure (a guard of 150, the ledger, the
// post-check) rolls the whole pair back: the catalog is exactly where it was (148 forward, 150 rollback). The previous "revert 149 in a
// second transaction / hold the lock until an operator repairs" path no longer exists because the half-applied state cannot be committed.
// SESSION. The lifecycle lock is a SESSION advisory lock: the step refuses a transaction-mode pooler (Supabase port 6543), proves that one
// server session answers every statement and owns the lock (scripts/lib/migrationTx.js).
// Usage (connection: PREFLIGHT_DATABASE_URL, or PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE; W3_PG_NODE_MODULES as for the preflight):
//   node scripts/economy149150GuardedStep.js check                              read-only: open services, H-1 states, active attempts, catalog step
//   node scripts/economy149150GuardedStep.js forward  [--lock-wait-seconds N] [--no-registry]
//   node scripts/economy149150GuardedStep.js rollback [--lock-wait-seconds N]
//   --no-registry: ONLY for an ephemeral certification database without a Supabase migration registry (as for the preflight).
// In the canonical rollout this script is invoked by scripts/economyChainApply.js (docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md); calling it
// directly is equivalent. forward writes, in the SAME transaction as the two bodies, the two ledger rows (apply_order 149 / 150, sha256/16 of
// the certified files) and, unless --no-registry, the two Supabase registry rows (statements[1] = the exact file text), and requires the
// full preflight BEFORE_151 to PASS before COMMIT. rollback leaves the ledger untouched (it is immutable) and requires the catalog of
// BEFORE_149 before COMMIT.
// Exit code: 0 = done, 1 = refused (nothing changed: the transaction was rolled back), 2 = usage / connection / pooler error.

const fs = require('fs');
const path = require('path');
const PF = require('./economy139to146Preflight.js');
const TX = require('./lib/migrationTx.js');

const ROOT = path.join(__dirname, '..');
const LIFECYCLE_LOCK_SQL = "hashtext('service_session_lifecycle')";
const CATALOG_SECTIONS = ['A', 'B', 'D'];          // version / isolation, encoding, catalog objects (the ledger, C, is checked separately)
const link = (n) => PF.CHAIN.find((c) => c.n === n);
const fileOf = (n, rollback = false) => 'migrations/' + (rollback ? link(n).file.replace(/\.sql$/, '.ROLLBACK.sql') : link(n).file);

function readCertified(n, rollback = false, readFile = (rel) => fs.readFileSync(path.join(ROOT, rel))) {
  const bytes = readFile(fileOf(n, rollback));
  const want = rollback ? link(n).rbkSha : link(n).sha;
  const got = TX.sha256(bytes);
  if (got !== want) throw Object.assign(new Error(`${fileOf(n, rollback)} is not the certified file (sha256 ${got}, want ${want})`), { code: 'FILE_NOT_CERTIFIED' });
  return bytes.toString('utf8');
}
const certifiedBody = (n, rollback, readFile) => { const text = readCertified(n, rollback, readFile); return { text, body: TX.txBody(text, fileOf(n, rollback)) }; };

// 'open' / 'closing' are the only states close_service_session_v3 transitions (anything else is refused SERVICE_NOT_OPEN), so they are
// exactly the services a Finalizar can be working on, and a closeout on one of them is the H-1 state.
const STATE_SQL = `SELECT
  (SELECT count(*) FROM public.service_sessions WHERE status IN ('open', 'closing'))::int AS open_services,
  (SELECT count(*) FROM public.service_closeouts c JOIN public.service_sessions s ON s.id = c.service_session_id WHERE s.status IN ('open', 'closing'))::int AS h1_states,
  (SELECT count(*) FROM public.service_closeout_attempts WHERE status = 'active')::int AS active_attempts,
  (SELECT count(*) FROM public.service_closeout_attempts a JOIN public.service_sessions s ON s.id = a.service_session_id WHERE a.status = 'active' AND s.status = 'closed')::int AS closed_with_active_attempt`;

async function preflightRows(client, mode, noRegistry) { return PF.runSql(client, PF.renderSql(mode, { noRegistry })); }
// The same SELECT, evaluated inside the caller's OPEN transaction (it sees that transaction's uncommitted catalog).
async function preflightRowsInTx(client, mode, noRegistry) { return (await client.query(PF.renderSql(mode, { noRegistry }))).rows; }
const passes = (rows, sections) => rows.filter((r) => !sections || sections.includes(r.sec)).every((r) => r.ok === true);
const failing = (rows, sections) => rows.filter((r) => (!sections || sections.includes(r.sec)) && r.ok !== true).map((r) => `[${r.sec}] ${r.k} got=${r.got} want=${r.want}`);

async function catalogStep(client) {
  for (const mode of ['BEFORE_149', 'BEFORE_150', 'BEFORE_151']) if (passes(await preflightRows(client, mode, true), CATALOG_SECTIONS)) return mode;
  return 'OTHER';
}
async function inspect(client) {
  const st = (await client.query(STATE_SQL)).rows[0];
  return { ...st, catalog: await catalogStep(client) };
}

async function acquireLock(client, waitMs, log) {
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await client.query(`SELECT pg_try_advisory_lock(${LIFECYCLE_LOCK_SQL}) AS ok`);
    if (r.rows[0].ok === true) { log('lifecycle lock held by this session'); return true; }
    if (Date.now() >= until) return false;
    await new Promise((res) => setTimeout(res, 200));
  }
}
const releaseLock = (client) => client.query(`SELECT pg_advisory_unlock(${LIFECYCLE_LOCK_SQL})`);

// Re-applying after a supported rollback: the ledger is immutable, so the rows of every migration applied earlier and rolled back since are
// still there, and the preflight's ledger section (C) reports them (the tip, the "rows above 138" list, the "not applied yet" rows). That --
// and nothing else -- is accepted: every other section passes, every failing check is one of those three ledger checks, and every ledger row
// above 138 is exactly the certified row (filename, sha256/16) of its chain member. The registry byte proofs of the applied prefix, and its
// own ledger rows, must still pass.
const LEDGER_AHEAD_KEYS = [/^ledger tip max\(apply_order\)/, /^ledger rows above 138 = exactly the applied prefix/, /^ledger row \d+ ABSENT \(not applied yet\)/];
async function acceptableLedgerAhead(client, rows) {
  const bad = rows.filter((r) => r.ok !== true && r.sec !== 'Z');
  if (!bad.length) return true;
  if (bad.some((r) => r.sec !== 'C' || !LEDGER_AHEAD_KEYS.some((re) => re.test(r.k)))) return false;
  const led = (await client.query('SELECT filename, checksum_sha256, apply_order FROM public.ladieci_schema_migrations WHERE apply_order > 138')).rows;
  return led.every((r) => { const c = link(r.apply_order); return c && c.file === r.filename && c.sha.slice(0, 16) === r.checksum_sha256; });
}
const passesOrLedgerAhead = async (client, rows) => passes(rows) || acceptableLedgerAhead(client, rows);

function preconditionFailures(st) {
  const out = [];
  if (st.open_services !== 0) out.push(`${st.open_services} service(s) not closed: Finalizar every service first (the step needs a database with no open service)`);
  if (st.h1_states !== 0) out.push(`${st.h1_states} closeout(s) committed for a service that is not closed (H-1 state): resolve them first (docs/ECONOMY_139_156_ROLLOUT_CONTRACT.md, runbook R1)`);
  if (st.active_attempts !== 0) out.push(`${st.active_attempts} active closeout attempt(s)${st.closed_with_active_attempt ? ` (${st.closed_with_active_attempt} on a closed service: scripts/r4bHistoricalCloseAttemptRecovery.js)` : ''}: no Finalizar may be in flight`);
  return out;
}

// Inside the open transaction: the ledger rows of 149 / 150 that are not there yet (a re-forward after a guarded rollback finds both), and
// their registry rows.
async function recordPair(client, texts, noRegistry) {
  for (const n of [149, 150]) {
    const c = link(n);
    const has = (await client.query('SELECT filename, checksum_sha256 FROM public.ladieci_schema_migrations WHERE filename = $1 OR apply_order = $2', [c.file, n])).rows;
    if (has.length && !(has.length === 1 && has[0].filename === c.file && has[0].checksum_sha256 === c.sha.slice(0, 16))) throw new Error(`ledger row ${n} is not the certified one`);
    if (!has.length) {
      await TX.recordApplied(client, { filename: c.file, text: texts[n], applyOrder: n, appliedBy: 'economy149150GuardedStep', noRegistry,
        method: 'guarded 149+150 step: certified sha256, ONE transaction with the pair, full preflight BEFORE_151 inside it, lifecycle lock held, no open service',
        notes: 'applied together with ' + (n === 149 ? 150 : 149) + ' in ONE transaction (economy greenfield finalization contract)' });
    } else if (!noRegistry) {
      const reg = await client.query("SELECT 1 FROM supabase_migrations.schema_migrations WHERE encode(sha256(convert_to(statements[1], 'UTF8')), 'hex') = $1", [c.sha]);
      if (!reg.rows.length) throw new Error(`ledger row ${n} present but its registry byte proof is missing`);
    }
  }
}

async function guardSession(client, verifySession) {
  if (!verifySession) return;
  TX.refuseTransactionPooler();
  await TX.assertSameSession(client);
}

async function runForward({ client, noRegistry = false, lockWaitMs = 30000, log = console.log, readFile, verifySession = true } = {}) {
  const p149 = certifiedBody(149, false, readFile); const p150 = certifiedBody(150, false, readFile);
  certifiedBody(149, true, readFile); certifiedBody(150, true, readFile);   // the pair's rollback must be certified before going forward
  await guardSession(client, verifySession);
  if (!(await acquireLock(client, lockWaitMs, log))) return { code: 1, result: 'LOCK_NOT_ACQUIRED', detail: 'the lifecycle lock stayed busy; retry' };
  try {
    if (verifySession) await TX.assertLockOwned(client, LIFECYCLE_LOCK_SQL);
    const start = await catalogStep(client);
    const st = (await client.query(STATE_SQL)).rows[0];
    const pre = preconditionFailures(st);
    if (pre.length) return { code: 1, result: 'REFUSED_PRECONDITION', detail: pre };
    if (start === 'BEFORE_151') return { code: 1, result: 'ALREADY_AT_150', detail: 'nothing to do' };
    let bodies;
    if (start === 'BEFORE_149') {
      const pf = await preflightRows(client, 'BEFORE_149', noRegistry);
      if (!(await passesOrLedgerAhead(client, pf))) return { code: 1, result: 'REFUSED_PREFLIGHT_BEFORE_149', detail: failing(pf) };
      bodies = [p149.body, p150.body];
    } else if (start === 'BEFORE_150') {
      log('the database rests at "149 without 150" (an interrupted or bypassed step): completing it with 150 under the same guard');
      bodies = [p150.body];
    } else {
      return { code: 1, result: 'REFUSED_CATALOG', detail: 'the catalog is neither BEFORE_149 nor BEFORE_150: run the preflight' };
    }
    await client.query('BEGIN');
    try {
      for (const b of bodies) await client.query(b);
      await recordPair(client, { 149: p149.text, 150: p150.text }, noRegistry);
      const post = await preflightRowsInTx(client, 'BEFORE_151', noRegistry);
      if (!(await passesOrLedgerAhead(client, post))) throw Object.assign(new Error('preflight BEFORE_151 fails inside the step'), { detail: failing(post) });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { code: 1, result: 'REFUSED_STEP_ROLLED_BACK', detail: e.detail || e.message, catalog: await catalogStep(client) };
    }
    log('149 + 150 committed together');
    return { code: 0, result: 'APPLIED_149_150', detail: 'ONE transaction; preflight BEFORE_151 PASS before COMMIT' };
  } finally {
    await releaseLock(client).catch(() => {});
  }
}

async function runRollback({ client, lockWaitMs = 30000, log = console.log, readFile, verifySession = true } = {}) {
  const r150 = certifiedBody(150, true, readFile); const r149 = certifiedBody(149, true, readFile);
  certifiedBody(150, false, readFile); certifiedBody(149, false, readFile);
  await guardSession(client, verifySession);
  if (!(await acquireLock(client, lockWaitMs, log))) return { code: 1, result: 'LOCK_NOT_ACQUIRED', detail: 'the lifecycle lock stayed busy; retry' };
  try {
    if (verifySession) await TX.assertLockOwned(client, LIFECYCLE_LOCK_SQL);
    const st = (await client.query(STATE_SQL)).rows[0];
    const pre = preconditionFailures(st);
    if (pre.length) return { code: 1, result: 'REFUSED_PRECONDITION', detail: pre };
    const cat = await preflightRows(client, 'BEFORE_151', true);
    if (!passes(cat, CATALOG_SECTIONS)) return { code: 1, result: 'REFUSED_NOT_AT_150', detail: failing(cat, CATALOG_SECTIONS) };
    await client.query('BEGIN');
    try {
      await client.query(r150.body);
      await client.query(r149.body);
      const after = await preflightRowsInTx(client, 'BEFORE_149', true);
      if (!passes(after, CATALOG_SECTIONS)) throw Object.assign(new Error('catalog is not BEFORE_149 inside the rollback step'), { detail: failing(after, CATALOG_SECTIONS) });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return { code: 1, result: 'REFUSED_ROLLBACK_ROLLED_BACK', detail: e.detail || e.message, catalog: await catalogStep(client) };
    }
    log('rb150 + rb149 committed together');
    return { code: 0, result: 'ROLLED_BACK_150_149', detail: 'ONE transaction; catalog BEFORE_149 before COMMIT (the ledger keeps its 149 / 150 rows: it is immutable)' };
  } finally {
    await releaseLock(client).catch(() => {});
  }
}

async function connect() {
  const base = process.env.W3_PG_NODE_MODULES;
  const pg = base ? require(path.join(base, 'pg')) : require('pg');
  const client = process.env.PREFLIGHT_DATABASE_URL ? new pg.Client({ connectionString: process.env.PREFLIGHT_DATABASE_URL }) : new pg.Client();
  await client.connect();
  return client;
}

module.exports = { runForward, runRollback, inspect, preconditionFailures, readCertified, certifiedBody, catalogStep, acceptableLedgerAhead, passesOrLedgerAhead, STATE_SQL, LIFECYCLE_LOCK_SQL, CATALOG_SECTIONS };

if (require.main === module) {
  (async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
    const lockWaitMs = Number(opt('--lock-wait-seconds') || 30) * 1000;
    if (!['check', 'forward', 'rollback'].includes(cmd)) {
      console.error('usage: economy149150GuardedStep.js check | forward [--lock-wait-seconds N] [--no-registry] | rollback [--lock-wait-seconds N]');
      process.exit(2);
    }
    let client;
    try { client = await connect(); } catch (e) { console.error('connection error: ' + e.message); process.exit(2); }
    try {
      if (cmd === 'check') { const r = await inspect(client); console.log(JSON.stringify(r, null, 1)); process.exit(preconditionFailures(r).length ? 1 : 0); }
      const r = cmd === 'forward' ? await runForward({ client, noRegistry: rest.includes('--no-registry'), lockWaitMs }) : await runRollback({ client, lockWaitMs });
      console.log(JSON.stringify(r, null, 1));
      process.exit(r.code);
    } finally { await client.end().catch(() => {}); }
  })().catch((e) => { console.error(e.message); process.exit(2); });
}
