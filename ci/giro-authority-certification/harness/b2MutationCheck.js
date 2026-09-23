#!/usr/bin/env node
'use strict';
// DELIVERY_ECONOMY_DECOUPLING_V1 -- CORRECTION B2: MUTATION CHECK of the off-service receipt contract (ephemeral PostgreSQL only).
//
// A green test bench proves nothing until it is shown to FAIL on a wrong migration. This script builds MUTANTS of migration 139
// (forward + rollback), re-computes every md5 / definition pin the mutant would otherwise trip, neutralizes the migration's own
// post-conditions where they would already refuse the mutant, and runs the SAME scenarios against it
// (DED_FWD / DED_RBK -> runDeliveryEconomyDecoupling.js b2OffServiceReceipt). A mutant must be KILLED by a scenario or by an
// assertion of the harness -- never merely refused by its own guard:
//   KILLED    the mutant APPLIED cleanly and the bench reported at least one failing assertion
//   SURVIVED  the mutant applied and the bench stayed green  => the bench has a hole (this script exits 1)
//   INVALID   the mutant did not even apply (its own guard / SQL refused it): not a proof, reported so it is never mistaken for one
// The unmutated pair is run first as the CONTROL (it must be fully green).
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres@17 and pg> [W3_PG_DATA_ROOT=<tmp>] node ci/giro-authority-certification/harness/b2MutationCheck.js [mutantName ...]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const rt = require('./pgRuntime');

const ROOT = path.join(__dirname, '..', '..', '..');
const FWD_PATH = path.join(ROOT, 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.sql');
const RBK_PATH = path.join(ROOT, 'migrations/2026-09-19_delivery_economy_decoupling_v1_migration_139.ROLLBACK.sql');
const RUNNER = path.join(__dirname, 'runDeliveryEconomyDecoupling.js');
const FWD = fs.readFileSync(FWD_PATH, 'utf8');
const RBK = fs.readFileSync(RBK_PATH, 'utf8');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sq = (s) => s.replace(/'/g, "''");

const NEW_DEF = "CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL) OR ((table_session_id IS NULL) AND (service_session_id IS NULL) AND (kind = 'payment'::text) AND (mode = ANY (ARRAY['full'::text, 'custom_amount'::text])) AND (covers_settled = 0) AND COALESCE(((meta -> 'off_service_receipt'::text) = 'true'::jsonb), false))))";
const CONSTRAINT_BLOCK = `ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk CHECK (
  table_session_id IS NOT NULL
  OR service_session_id IS NOT NULL
  OR (
        table_session_id IS NULL
    AND service_session_id IS NULL
    AND kind = 'payment'
    AND mode IN ('full', 'custom_amount')
    AND covers_settled = 0
    AND COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)
  )
);`;

function writerBody(sql) {
  const i = sql.indexOf('CREATE OR REPLACE FUNCTION public.order_post_payment_v1(');
  const o = sql.indexOf('AS $function$', i) + '$function$'.length + 3;
  return sql.slice(o, sql.indexOf('$function$;', o));
}
// Exactly-one replacement: a mutation whose anchor is missing (or ambiguous) must fail loudly, never run an unmutated file.
function sub(text, from, to, label) {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`mutation anchor "${label}" found ${n} times (expected exactly 1)`);
  return text.replace(from, () => to);
}

let probe = null;
async function normalizedDef(expr) {                       // pg_get_constraintdef of a candidate CHECK on the real column types
  if (!probe) {
    const cl = await rt.startCluster();
    const su = await rt.connect(cl, 'postgres', { name: 'b2-mut-probe' });
    await su.query(`CREATE TABLE payment_transactions (table_session_id uuid, service_session_id uuid, kind text NOT NULL DEFAULT 'payment', mode text NOT NULL DEFAULT 'full',
                     covers_settled integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}')`);
    probe = { cl, su };
  }
  await probe.su.query('ALTER TABLE payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_scope_chk');
  await probe.su.query(`ALTER TABLE payment_transactions ADD CONSTRAINT payment_transactions_scope_chk CHECK (${expr})`);
  return (await probe.su.query(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'payment_transactions_scope_chk'`)).rows[0].d;
}

// ── building blocks ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A constraint mutant: replace the ADD CONSTRAINT expression, then move the definition pin (forward post-condition + rollback guard).
async function constraintMutant(f, r, mutateBlock) {
  const block = mutateBlock(CONSTRAINT_BLOCK);
  const expr = block.slice(block.indexOf('CHECK (') + 7, block.lastIndexOf(');'));   // everything between CHECK ( and the closing ) of the CHECK
  const def = await normalizedDef(expr);
  f = sub(f, CONSTRAINT_BLOCK, block, 'constraint block');
  f = sub(f, `IS DISTINCT FROM '${sq(NEW_DEF)}' THEN\n    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: payment_transactions_scope_chk is not the exact 139 constraint'`,
    `IS DISTINCT FROM '${sq(def)}' THEN\n    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING post-condition failed: payment_transactions_scope_chk is not the exact 139 constraint'`, 'forward def pin');
  r = sub(r, `IS DISTINCT FROM '${sq(NEW_DEF)}' THEN\n    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: payment_transactions_scope_chk is not the exact 139 constraint`,
    `IS DISTINCT FROM '${sq(def)}' THEN\n    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: payment_transactions_scope_chk is not the exact 139 constraint`, 'rollback def pin');
  return { f, r };
}
// A writer mutant: replace inside the order writer body, re-pin its md5 (forward post-condition + rollback guard), and neutralize the
// post-condition that pins the contract text itself (so that the migration APPLIES and only the scenarios can kill it).
function writerMutant(f, r, mutateBody) {
  const oldBody = writerBody(f);
  const newBody = mutateBody(oldBody);
  if (newBody === oldBody) throw new Error('writer mutation changed nothing');
  f = sub(f, oldBody, newBody, 'writer body');
  const oldMd5 = md5(oldBody); const newMd5 = md5(newBody);
  f = sub(f, `'${oldMd5}'`, `'${newMd5}'`, 'forward writer md5 pin');
  r = sub(r, `'${oldMd5}'`, `'${newMd5}'`, 'rollback writer md5 pin');
  f = f.replace(/IF v_opp NOT LIKE '%p_workspace_id, NULL, v_receipt_service_id[\s\S]*?THEN/, 'IF false THEN');
  return { f, r };
}

const MUTANTS = {
  // ── the two mutants the mandate names ──────────────────────────────────────────────────────────────────────────────
  'MA-anchor-order-service-in-tx-receipt': (f, r) => writerMutant(f, r, (b) => sub(b, "p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,", "p_workspace_id, NULL, COALESCE(v_receipt_service_id,v_ord.service_session_id), 'payment', p_mode,", 'tx insert')),
  'MB-null-allowed-without-the-flag': (f, r) => constraintMutant(f, r, (b) => sub(b, "    AND COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)\n", '', 'flag condition')),
  // ── the trap a literal copy of the suggested expression falls into ─────────────────────────────────────────────────
  'MB1-blind-copy-of-the-suggested-expression': (f, r) => constraintMutant(f, r, (b) => sub(sub(sub(sub(b,
    "    AND kind = 'payment'\n", '', 'kind'), "    AND mode IN ('full', 'custom_amount')\n", '', 'mode'), "    AND covers_settled = 0\n", '', 'covers'),
    "COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)", "(meta->>'off_service_receipt') = 'true'", 'flag expr')),
  'MB4-no-COALESCE-null-trap': (f, r) => constraintMutant(f, r, (b) => sub(b, "COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)", "(meta -> 'off_service_receipt') = 'true'::jsonb", 'coalesce')),
  // ── the constraint admits more than a payment receipt ──────────────────────────────────────────────────────────────
  'MB3-refund-may-be-scope-less': (f, r) => constraintMutant(f, r, (b) => sub(b, "    AND kind = 'payment'\n", '', 'kind')),
  'MB5-mesa-modes-may-be-scope-less': (f, r) => constraintMutant(f, r, (b) => sub(b, "    AND mode IN ('full', 'custom_amount')\n", '', 'mode')),
  'MB6-covers-may-be-scope-less': (f, r) => constraintMutant(f, r, (b) => sub(b, "    AND covers_settled = 0\n", '', 'covers')),
  'MB7-flag-may-be-a-string': (f, r) => constraintMutant(f, r, (b) => sub(b, "COALESCE((meta -> 'off_service_receipt') = 'true'::jsonb, false)", "COALESCE((meta ->> 'off_service_receipt') = 'true', false)", 'flag string')),
  // ── the writer ─────────────────────────────────────────────────────────────────────────────────────────────────────
  'MC-writer-trusts-the-caller-flag': (f, r) => writerMutant(f, r, (b) => sub(b, "  v_meta := v_meta - 'off_service_receipt';\n", '', 'strip')),
  'MG-writer-refuses-off-service-again': (f, r) => writerMutant(f, r, (b) => sub(b, "    v_meta := v_meta || jsonb_build_object('off_service_receipt', true);\n", "    RAISE EXCEPTION 'ORDER_PAYMENT_NO_OPEN_SERVICE' USING ERRCODE='55000';\n", 'refuse again')),
  'MH-writer-fallback-inside-the-event-too': (f, r) => writerMutant(f, r, (b) => sub(b, 'o.service_session_id, v_receipt_service_id, v_tx.id, v_now', 'o.service_session_id, COALESCE(v_receipt_service_id,o.service_session_id), v_tx.id, v_now', 'event insert')),
  // ── the comment ────────────────────────────────────────────────────────────────────────────────────────────────────
  'MJ-comment-redefines-the-column-as-a-scope-anchor': (f, r) => {
    const m = /COMMENT ON COLUMN public\.payment_transactions\.service_session_id IS\s*\n\s*'((?:[^']|'')*)';/.exec(f);
    const oldComment = m[1].replace(/''/g, "'");
    const newComment = oldComment.replace("NEVER the table's origin service and NEVER the order's own service: it is a receipt attribute, not a scope anchor.", "the table's origin service, or the order's own service when no service is open (a scope anchor).");
    if (newComment === oldComment) throw new Error('comment mutation changed nothing');
    f = f.replace(m[1], sq(newComment));
    f = sub(f, `'${md5(oldComment)}'`, `'${md5(newComment)}'`, 'forward comment md5');
    r = sub(r, `'${md5(oldComment)}'`, `'${md5(newComment)}'`, 'rollback comment md5');
    return { f, r };
  },
  // ── the rollback ───────────────────────────────────────────────────────────────────────────────────────────────────
  'ME-rollback-leaves-the-139-constraint': (f, r) => {
    r = sub(r, `ALTER TABLE public.payment_transactions DROP CONSTRAINT payment_transactions_scope_chk;
ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_scope_chk
  CHECK (table_session_id IS NOT NULL OR service_session_id IS NOT NULL);
`, '', 'restore constraint');
    r = sub(r, `IS DISTINCT FROM 'CHECK (((table_session_id IS NOT NULL) OR (service_session_id IS NOT NULL)))' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: payment_transactions_scope_chk is not the exact migration-122 constraint';`,
    `IS DISTINCT FROM '${sq(NEW_DEF)}' THEN
    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback post-condition failed: payment_transactions_scope_chk is not the exact migration-122 constraint';`, 'rollback post def');
    r = sub(r, "IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.payment_transactions'::regclass AND obj_description(c.oid, 'pg_constraint') IS NOT NULL) THEN", "IF false THEN", 'rollback comment post');
    return { f, r };
  },
  'MF-rollback-does-not-refuse-existing-receipts': (f, r) => {
    r = sub(r, "  IF v_n > 0 THEN\n    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: % off-service payment receipt(s)", "  IF false THEN\n    RAISE EXCEPTION 'DELIVERY_ECONOMY_DECOUPLING rollback refused: % off-service payment receipt(s)", 'refusal');
    return { f, r };
  },
  'MK-rollback-forgets-the-column-comments': (f, r) => {
    r = sub(r, `COMMENT ON COLUMN public.payment_transactions.service_session_id IS
  'RECEIPT SERVICE: the service session open at the moment the money was received. '
  'NULL = off-service receipt (no session open). NEVER the table''s origin service. '
  'Physical rename to receipt_service_session_id lands in S14.';
`, '', 'restore service comment');
    r = r.replace(/IF col_description\('public\.payment_transactions'::regclass, \(SELECT a\.attnum FROM pg_attribute a WHERE a\.attrelid = 'public\.payment_transactions'::regclass AND a\.attname = 'service_session_id'\)\)\n\s+IS DISTINCT FROM 'RECEIPT SERVICE[^\n]*\n\s+OR /, 'IF ');
    return { f, r };
  },
};

function runBench(fwdPath, rbkPath) {
  const env = { ...process.env };
  if (fwdPath) env.DED_FWD = fwdPath; else delete env.DED_FWD;
  if (rbkPath) env.DED_RBK = rbkPath; else delete env.DED_RBK;
  const t0 = Date.now();
  const p = cp.spawnSync('node', [RUNNER, 'b2OffServiceReceipt'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const out = `${p.stdout || ''}\n${p.stderr || ''}`;
  const result = /RESULT: (\d+) passed, (\d+) failed/.exec(out);
  const fails = [...out.matchAll(/^\s+FAIL\s+(.*)$/gm)].map((m) => m[1].slice(0, 170));
  return { pass: result ? +result[1] : null, fail: result ? +result[2] : null, fails, applied: !/FAIL\s+(migration 139 applies cleanly|rollback candidate applies cleanly)/.test(out), secs: Math.round((Date.now() - t0) / 1000), tail: out.split('\n').slice(-6).join('\n') };
}

async function main() {
  const only = process.argv.slice(2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2mut-'));
  const rows = [];
  console.log('CONTROL (the real migration pair, no mutation)');
  const control = runBench(null, null);
  console.log(`  ${control.fail === 0 ? 'GREEN' : 'NOT GREEN'}: ${control.pass} passed, ${control.fail} failed (${control.secs}s)`);
  if (control.fail !== 0) { console.log(control.fails.join('\n')); process.exit(2); }

  for (const [name, build] of Object.entries(MUTANTS)) {
    if (only.length && !only.includes(name)) continue;
    let built;
    try { built = await build(FWD, RBK); } catch (e) { rows.push({ name, verdict: 'ERROR', note: e.message }); console.log(`${name}: ERROR ${e.message}`); continue; }
    const f = path.join(dir, `${name}.139.sql`); const r = path.join(dir, `${name}.139.ROLLBACK.sql`);
    fs.writeFileSync(f, built.f); fs.writeFileSync(r, built.r);
    const res = runBench(f, r);
    // a group that dies mid-run is recorded by the runner as a FAILED assertion ("completed without an unexpected exception"), so recorded failures = KILLED even when no RESULT line is printed; no failure AND no RESULT = the run itself crashed: never a proof
    const failed = res.fail === null ? res.fails.length : res.fail;
    const verdict = !res.applied ? 'INVALID' : (failed > 0 ? 'KILLED' : (res.fail === null ? 'INVALID' : 'SURVIVED'));
    // "pin-type" assertions compare a DEFINITION / fingerprint (K0, P1 pins, the catalog fingerprint, drift refusals); everything else is a SCENARIO
    // (a real INSERT, a real payment, a real rollback against data). A mutant killed by pin-type assertions only would be reported as such.
    const PIN_TYPE = /^(K0:|P1 (pre-state|catalog fingerprint|after 139)|L: |rollback proof pre-condition|forward apply against|\.\.\.and the refused forward)/;
    const scenario = res.fails.filter((x) => !PIN_TYPE.test(x));
    const label = verdict === 'KILLED' && scenario.length === 0 ? 'KILLED*' : verdict;
    rows.push({ name, verdict: label, fail: failed, scenarioFails: scenario.length, first: scenario.slice(0, 2), secs: res.secs });
    console.log(`${label.padEnd(8)} ${name}  (${failed} failing assertion(s), ${scenario.length} of them SCENARIOS${res.fail === null ? ', the run crashed after recording them' : ''}, ${res.secs}s)`);
    for (const x of scenario.slice(0, 2)) console.log(`           scenario: ${x}`);
    if (scenario.length === 0) for (const x of res.fails.slice(0, 2)) console.log(`           pin-type: ${x}`);
    if (verdict === 'INVALID') console.log(res.tail);
    if (process.env.B2_KEEP_MUTANTS) console.log(`           (kept: ${f} , ${r})`);
  }
  if (probe) { await probe.su.end().catch(() => {}); await probe.cl.stop().catch(() => {}); }
  if (!process.env.B2_KEEP_MUTANTS) fs.rmSync(dir, { recursive: true, force: true });
  const survived = rows.filter((x) => x.verdict !== 'KILLED' && x.verdict !== 'KILLED*');
  console.log(`\nSUMMARY: ${rows.filter((x) => x.verdict.startsWith('KILLED')).length}/${rows.length} mutants KILLED by the bench (${rows.filter((x) => x.verdict === 'KILLED').length} by at least one SCENARIO, ${rows.filter((x) => x.verdict === 'KILLED*').length} by pin-type assertions only)` + (survived.length ? `; NOT killed: ${survived.map((x) => `${x.name}=${x.verdict}`).join(', ')}` : ''));
  process.exit(survived.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
