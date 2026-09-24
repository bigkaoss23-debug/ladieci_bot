#!/usr/bin/env node
'use strict';
// B-RID-1 (migration 140) -- MUTATION CHECK of the rider canonical-payment contract (ephemeral PostgreSQL only).
//
// Builds MUTANTS of migration 140 (forward + rollback), re-computes every md5 pin the mutant would otherwise trip, neutralizes the
// migration's own post-conditions where they would already refuse the mutant (so the mutant APPLIES), and runs the B-RID-1
// behavioural group against it (BRID_FWD / BRID_RBK -> runRiderCanonicalPayment.js bRid1RiderCanonicalPayment):
//   KILLED    the mutant applied and at least one assertion failed (KILLED* = only by apply/pin-type assertions, no scenario)
//   SURVIVED  the mutant applied and the bench stayed green  => the bench has a hole (exit 1)
//   INVALID   the mutant did not apply: not a proof, reported so it is never mistaken for one
// The unmutated pair runs first as the CONTROL (must be fully green).
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres@17 and pg> [W3_PG_DATA_ROOT=<tmp>] [BRID_MUT_PARALLEL=3] \
//     node ci/giro-authority-certification/harness/bRid1MutationCheck.js [mutantName ...]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const FWD_PATH = path.join(ROOT, 'migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.sql');
const RBK_PATH = path.join(ROOT, 'migrations/2026-09-23_b_rid_1_rider_canonical_payment_lineage_v1_migration_140.ROLLBACK.sql');
const RUNNER = path.join(__dirname, 'runRiderCanonicalPayment.js');
const FWD = fs.readFileSync(FWD_PATH, 'utf8');
const RBK = fs.readFileSync(RBK_PATH, 'utf8');
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function sub(text, from, to, label, times = 1) {
  const n = text.split(from).length - 1;
  if (n !== times) throw new Error(`mutation anchor "${label}" found ${n} times (expected ${times})`);
  return text.split(from).join(to);
}
function bodyOf(sql, marker) {
  const i = sql.indexOf(marker);
  const open = /AS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(i));
  const s = i + open.index + open[0].length;
  return sql.slice(s, sql.indexOf(open[1], s));
}
const RIDER = 'CREATE FUNCTION public.rider_collect_and_complete_stop(';
const WRITER = 'CREATE OR REPLACE FUNCTION public.order_post_payment_v1(';
// Mutate ONE function body of the forward, then move its md5 pin (forward post-condition + rollback guard).
function bodyMutant(f, r, marker, mutate) {
  const old = bodyOf(f, marker);
  const neu = mutate(old);
  if (neu === old) throw new Error('mutation changed nothing');
  f = sub(f, old, neu, 'body');
  f = sub(f, `'${md5(old)}'`, `'${md5(neu)}'`, 'forward md5 pin');
  r = sub(r, `'${md5(old)}'`, `'${md5(neu)}'`, 'rollback md5 pin');
  return { f, r };
}
// Turn the condition of the post-condition whose RAISE carries `msg` into `false` (so the mutant applies).
function neutralize(sql, msg) {
  const k = sql.indexOf(msg);
  if (k < 0) throw new Error(`post-condition not found: ${msg}`);
  const ifAt = sql.lastIndexOf('\n  IF ', k) + 3;
  const thenAt = sql.lastIndexOf(' THEN\n', k);
  return sql.slice(0, ifAt + 3) + 'false' + sql.slice(thenAt);
}
const CALL = `v_pay := public.order_post_payment_v1(
          v_by.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid, v_method, 'full', NULL,
          v_request_id, v_request_hash, v_meta, false);`;
const CALL2 = `v_pay := public.order_post_payment_v1(
        v_by.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid, v_method, 'full', NULL,
        v_request_id, v_request_hash, v_meta, false);`;
const GUARD_RE = /^ +IF COALESCE\(\(v_pay->>'idempotent'\)::boolean, false\) IS NOT TRUE\n[\s\S]*?END IF;\n/gm;
const RIDER_CONTRACT = "rider_collect_and_complete_stop lost a contract element";
const RIDER_NO_ID = "rider_collect_and_complete_stop must write no ledger row itself";
const WRITER_GUARD = "order_post_payment_v1 lost a canonical guard or the attestation block";

const MUTANTS = {
  // ── the mandate's list ─────────────────────────────────────────────────────────────────────────────────────────────
  'M01-rider-back-to-event-only (legacy writer kept and called)': (f, r) => {
    let x = bodyMutant(f, r, RIDER, (b) => sub(sub(b, CALL, "v_pay := public._ledger_write_payment(p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);", 'call 1'),
      CALL2, "v_pay := public._ledger_write_payment(p_order_id, v_method, NULL, p_by_actor, v_by.role, p_ip_hash, v_meta, p_idem_scope_key);", 'call 2'));
    x.f = sub(x.f, 'DROP FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text);\n', '', 'drop');
    for (const m of ['_ledger_write_payment still exists', 'a function body still calls _ledger_write_payment', RIDER_CONTRACT, RIDER_NO_ID]) x.f = neutralize(x.f, m);
    x.r = sub(x.r, "     OR to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)') IS NOT NULL THEN", ' THEN', 'rbk exists guard');
    return x;
  },
  'M02-payment-transaction-missing (rider branch writes the event without a transaction)': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => {
      b = sub(b, '  INSERT INTO public.payment_transactions(', "  IF v_actor.role <> 'rider' THEN\n  INSERT INTO public.payment_transactions(", 'pt open');
      b = sub(b, '  ) RETURNING * INTO v_tx;\n', '  ) RETURNING * INTO v_tx;\n  END IF;\n', 'pt close');
      b = sub(b, "  ) VALUES (v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now);\n",
        "  ) SELECT v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now WHERE v_tx.id IS NOT NULL;\n", 'alloc');
      return b;
    });
    x.f = neutralize(x.f, WRITER_GUARD);
    return x;
  },
  'M03-allocation-missing (rider payment without allocation)': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(b, "  ) VALUES (v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now);\n",
      "  ) SELECT v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now WHERE v_actor.role <> 'rider';\n", 'alloc'));
    return x;
  },
  'M04-actor-operator-instead-of-rider (impersonation)': (f, r) => {
    const IMP = "(SELECT a.actor FROM public.auth_actors a WHERE a.workspace_id = v_by.workspace_id AND a.role = 'operator' AND a.active ORDER BY a.actor LIMIT 1)";
    const x = bodyMutant(f, r, RIDER, (b) => sub(b, 'v_by.workspace_id, p_by_actor, p_by_sid_hash, v_order_uid', `v_by.workspace_id, ${IMP}, p_by_sid_hash, v_order_uid`, 'actor', 2));
    x.f = neutralize(neutralize(x.f, RIDER_CONTRACT), RIDER_NO_ID);
    return x;
  },
  'M05-fake-receipt-A-after-close (order service used as receipt)': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(sub(b, "p_workspace_id, NULL, v_receipt_service_id, 'payment', p_mode,", "p_workspace_id, NULL, COALESCE(v_receipt_service_id, v_ord.service_session_id), 'payment', p_mode,", 'tx'),
      'o.service_session_id, v_receipt_service_id, v_tx.id, v_now', 'o.service_session_id, COALESCE(v_receipt_service_id, o.service_session_id), v_tx.id, v_now', 'ev'));
    x.f = neutralize(x.f, WRITER_GUARD);
    return x;
  },
  'M06-B-open-but-receipt-NULL': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(b, "  v_meta := v_meta - 'off_service_receipt';\n",
      "  v_meta := v_meta - 'off_service_receipt';\n  IF v_receipt_service_id IS DISTINCT FROM v_ord.service_session_id THEN v_receipt_service_id := NULL; END IF;\n", 'null B'));
    return x;
  },
  'M07-no-service-but-receipt-A': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(b, "  v_meta := v_meta - 'off_service_receipt';\n",
      "  v_meta := v_meta - 'off_service_receipt';\n  IF v_receipt_service_id IS NULL THEN v_receipt_service_id := v_ord.service_session_id; END IF;\n", 'fake A'));
    return x;
  },
  'M08-double-transaction-on-retry (non-deterministic request id)': (f, r) => bodyMutant(f, r, RIDER, (b) => sub(b,
    "v_request_id   := 'rider-delivery-' || replace(v_order_uid::text, '-', '');", "v_request_id   := 'rider-delivery-' || replace(gen_random_uuid()::text, '-', '');", 'request id')),
  'M09-payment-committed-but-delivery-failed (lost race RETURNs instead of RAISE)': (f, r) => {
    const x = bodyMutant(f, r, RIDER, (b) => sub(b, "RAISE EXCEPTION 'RIDER_STOP_LOST_RACE' USING ERRCODE='40001';", "RETURN jsonb_build_object('ok', false, 'code', 'RIDER_STOP_LOST_RACE');", 'raise'));
    x.f = neutralize(x.f, RIDER_CONTRACT);
    return x;
  },
  'M10-legacy-writer-still-reachable (not dropped)': (f, r) => {
    let x = { f: sub(f, 'DROP FUNCTION public._ledger_write_payment(text, text, text, text, text, text, jsonb, text);\n', '', 'drop'), r };
    x.f = neutralize(x.f, '_ledger_write_payment still exists');
    x.r = sub(x.r, "     OR to_regprocedure('public._ledger_write_payment(text,text,text,text,text,text,jsonb,text)') IS NOT NULL THEN", ' THEN', 'rbk exists guard');
    return x;
  },
  // M02 dies by a raw NOT NULL crash; this one does NOT crash: the rider branch skips the transaction, the allocation AND the event,
  // still answers success (amount from the cents) and updates the mirror -- only the behavioural "the money fact exists" can kill it.
  'M02b-rider-success-with-NO-ledger-rows-and-no-crash (transaction + allocation + event all skipped)': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => {
      b = sub(b, '  INSERT INTO public.payment_transactions(', "  IF v_actor.role <> 'rider' THEN\n  INSERT INTO public.payment_transactions(", 'pt open');
      b = sub(b, '  ) RETURNING * INTO v_tx;\n', '  ) RETURNING * INTO v_tx;\n  END IF;\n', 'pt close');
      b = sub(b, "  ) VALUES (v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now);\n",
        "  ) SELECT v_tx.id, NULL, v_ord.id, p_order_uid, v_amount_cents / 100.0, v_now WHERE v_tx.id IS NOT NULL;\n", 'alloc');
      b = sub(b, "  FROM public.ordenes o WHERE o.order_uid = p_order_uid;\n\n  -- Same compatibility-mirror", "  FROM public.ordenes o WHERE o.order_uid = p_order_uid AND v_tx.id IS NOT NULL;\n\n  -- Same compatibility-mirror", 'event');
      b = sub(b, "'ok', true, 'idempotent', false, 'transactionId', v_tx.id,\n    'amount', v_tx.amount,", "'ok', true, 'idempotent', false, 'transactionId', v_tx.id,\n    'amount', v_amount_cents / 100.0,", 'return amount');
      return b;
    });
    x.f = neutralize(x.f, WRITER_GUARD);
    return x;
  },
  // ── B1 amount parity (independent review) ─────────────────────────────────────────────────────────────────────────────
  'M19-amount-guard-removed (rider records whatever the writer recorded)': (f, r) => {
    const x = bodyMutant(f, r, RIDER, (b) => b.replace(GUARD_RE, ''));
    x.f = neutralize(x.f, RIDER_CONTRACT);
    return x;
  },
  'M20-amount-guard-inverted (IS DISTINCT FROM -> IS NOT DISTINCT FROM)': (f, r) =>
    bodyMutant(f, r, RIDER, (b) => sub(b, 'IS DISTINCT FROM (SELECT round(o.totale, 2)', 'IS NOT DISTINCT FROM (SELECT round(o.totale, 2)', 'invert', 2)),
  'M21-residual-zero-treated-as-mismatch (ALREADY_SETTLED refuses the delivery)': (f, r) => {
    const x = bodyMutant(f, r, RIDER, (b) => sub(b, 'v_pay_note := SQLERRM;',
      "v_pay_note := CASE WHEN SQLERRM = 'ORDER_PAYMENT_ALREADY_SETTLED' THEN 'RIDER_PAYMENT_AMOUNT_MISMATCH' ELSE SQLERRM END;", 'settled->mismatch', 2));
    x.f = neutralize(x.f, RIDER_CONTRACT);
    return x;
  },
  'M22-mismatch-still-completes-the-delivery (mismatch tolerated like ALREADY_SETTLED)': (f, r) => {
    const x = bodyMutant(f, r, RIDER, (b) => sub(b, "IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN",
      "IF v_pay_note NOT IN ('ORDER_PAYMENT_ALREADY_SETTLED', 'RIDER_PAYMENT_AMOUNT_MISMATCH') THEN", 'tolerate mismatch', 2));
    x.f = neutralize(x.f, RIDER_CONTRACT);
    return x;
  },
  'M23-mismatch-refuses-but-the-payment-stays-written (RETURN instead of RAISE: no subtransaction rollback)': (f, r) =>
    bodyMutant(f, r, RIDER, (b) => sub(b, "RAISE EXCEPTION 'RIDER_PAYMENT_AMOUNT_MISMATCH' USING ERRCODE='55000';",
      "RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_REFUSED', 'payment_code', 'RIDER_PAYMENT_AMOUNT_MISMATCH');", 'return', 2)),
  // ── the bounds of the rider's authority ────────────────────────────────────────────────────────────────────────────
  'M11-attestation-not-bound-to-the-order': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(b, "IS NOT DISTINCT FROM (p_by_actor || '|' || p_order_uid::text)", "LIKE (p_by_actor || '|%')", 'bind'));
    x.f = neutralize(x.f, WRITER_GUARD);
    return x;
  },
  'M12-attestation-ignored (any active rider admitted by the writer)': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(b, "\n                  AND current_setting('ladieci.rider_payment_attestation', true) IS NOT DISTINCT FROM (p_by_actor || '|' || p_order_uid::text)", '', 'drop attestation'));
    x.f = neutralize(x.f, WRITER_GUARD);
    return x;
  },
  'M13-rider-partial-payment-admitted': (f, r) => {
    const x = bodyMutant(f, r, WRITER, (b) => sub(b, "v_actor.role = 'rider' AND p_mode = 'full' AND ", "v_actor.role = 'rider' AND ", 'mode'));
    x.f = neutralize(x.f, WRITER_GUARD);
    return x;
  },
  'M14-role-constraint-admits-rider-generically': (f, r) => {
    const OLD = /ALTER TABLE public\.payment_transactions ADD CONSTRAINT payment_transactions_by_role_check CHECK \([\s\S]*?\n\);\n/.exec(f)[0];
    let x = { f: sub(f, OLD, "ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_by_role_check CHECK (by_role IN ('admin', 'operator', 'owner', 'cashier', 'legacy_operator', 'rider'));\n", 'constraint'), r };
    x.f = neutralize(x.f, 'payment_transactions_by_role_check is not the exact 140 constraint');
    x.r = neutralizeRbk(x.r, 'payment_transactions_by_role_check is not the exact 140 constraint -- resolve drift first');
    return x;
  },
  'M15-rollback-does-not-refuse-rider-money': (f, r) => ({ f, r: sub(r, '  IF v_n > 0 THEN\n    RAISE EXCEPTION \'B_RID_1 rollback refused: % payment transaction(s) authored by a rider exist',
    '  IF false THEN\n    RAISE EXCEPTION \'B_RID_1 rollback refused: % payment transaction(s) authored by a rider exist', 'refusal') }),
  'M16-rider-tolerates-every-writer-refusal': (f, r) => {
    const x = bodyMutant(f, r, RIDER, (b) => sub(b, "IF v_pay_note <> 'ORDER_PAYMENT_ALREADY_SETTLED' THEN", 'IF false THEN', 'tolerance', 2));
    return x;
  },
  'M17-attestation-not-cleared-after-the-call': (f, r) => bodyMutant(f, r, RIDER, (b) => sub(b, "PERFORM set_config('ladieci.rider_payment_attestation', '', true);", 'NULL;', 'clear', 2)),
  'M18-session-proof-not-required': (f, r) => bodyMutant(f, r, RIDER, (b) => sub(b, "    IF p_by_sid_hash IS NULL OR p_by_sid_hash !~ '^[0-9a-f]{64}$' THEN\n      RETURN jsonb_build_object('ok', false, 'code', 'PAYMENT_CONTEXT_UNAVAILABLE');\n    END IF;\n", '', 'proof')),
};
function neutralizeRbk(sql, msg) {
  const k = sql.indexOf(msg);
  if (k < 0) throw new Error(`rollback guard not found: ${msg}`);
  const ifAt = sql.lastIndexOf('\n  IF ', k) + 3;
  const thenAt = sql.lastIndexOf(' THEN\n', k);
  return sql.slice(0, ifAt + 3) + 'false' + sql.slice(thenAt);
}

const PIN_TYPE = /^(the REAL ledger|pre-140 |CALLER GRAPH|migration 140 applies|the 7-argument rider RPC is GONE|order_post_payment_v1 is the exact 140|ZERO REACHABILITY|the 8-argument rider RPC carries|order_post_payment_v1 kept|only service_role|B1 |double apply|rollback without|140 on a database|forward apply against|\.\.\.and the refused|rollback proof|rollback applies|RB: |forward 140 re-applies|re-applied bodies|the 139 rollback is REFUSED)/;

function runBench(fwdPath, rbkPath) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (fwdPath) env.BRID_FWD = fwdPath; else delete env.BRID_FWD;
    if (rbkPath) env.BRID_RBK = rbkPath; else delete env.BRID_RBK;
    const t0 = Date.now();
    const p = cp.spawn('node', [RUNNER, 'bRid1RiderCanonicalPayment'], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', () => {
      const result = /RESULT: (\d+) passed, (\d+) failed/.exec(out);
      const fails = [...out.matchAll(/^\s+FAIL\s+(.*)$/gm)].map((m) => m[1].slice(0, 170));
      resolve({ pass: result ? +result[1] : null, fail: result ? +result[2] : null, fails,
        applied: !/FAIL\s+migration 140 applies cleanly/.test(out), secs: Math.round((Date.now() - t0) / 1000), tail: out.split('\n').slice(-6).join('\n') });
    });
  });
}

async function main() {
  const only = process.argv.slice(2);
  const dir = fs.mkdtempSync(path.join(process.env.W3_PG_DATA_ROOT || os.tmpdir(), 'bridmut-'));
  console.log('CONTROL (the real migration pair, no mutation)');
  const control = await runBench(null, null);
  console.log(`  ${control.fail === 0 ? 'GREEN' : 'NOT GREEN'}: ${control.pass} passed, ${control.fail} failed (${control.secs}s)`);
  if (control.fail !== 0) { console.log(control.fails.join('\n')); process.exit(2); }
  const jobs = [];
  for (const [name, build] of Object.entries(MUTANTS)) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    let built;
    try { built = build(FWD, RBK); } catch (e) { jobs.push({ name, error: e.message }); continue; }
    const id = name.split('-')[0];
    const f = path.join(dir, `${id}.140.sql`); const r = path.join(dir, `${id}.140.ROLLBACK.sql`);
    fs.writeFileSync(f, built.f); fs.writeFileSync(r, built.r);
    jobs.push({ name, f, r });
  }
  const rows = [];
  const par = Math.max(1, Number(process.env.BRID_MUT_PARALLEL || 3));
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const j = jobs[next++];
      if (j.error) { rows.push({ name: j.name, verdict: 'ERROR', note: j.error }); console.log(`ERROR    ${j.name}: ${j.error}`); continue; }
      const res = await runBench(j.f, j.r);
      const failed = res.fail === null ? res.fails.length : res.fail;
      const verdict = !res.applied ? 'INVALID' : (failed > 0 ? 'KILLED' : (res.fail === null ? 'INVALID' : 'SURVIVED'));
      const scenario = res.fails.filter((x) => !PIN_TYPE.test(x));
      const label = verdict === 'KILLED' && scenario.length === 0 ? 'KILLED*' : verdict;
      rows.push({ name: j.name, verdict: label, fail: failed, scenarioFails: scenario.length, first: scenario.slice(0, 2), secs: res.secs });
      console.log(`${label.padEnd(8)} ${j.name}  (${failed} failing assertion(s), ${scenario.length} SCENARIO, ${res.secs}s)`);
      for (const x of scenario.slice(0, 2)) console.log(`           scenario: ${x}`);
      if (scenario.length === 0) for (const x of res.fails.slice(0, 2)) console.log(`           pin-type: ${x}`);
      if (verdict === 'INVALID') console.log(res.tail);
    }
  }
  await Promise.all(Array.from({ length: par }, worker));
  if (!process.env.BRID_KEEP_MUTANTS) fs.rmSync(dir, { recursive: true, force: true });
  const survived = rows.filter((x) => !x.verdict.startsWith('KILLED'));
  console.log(`\nSUMMARY: ${rows.filter((x) => x.verdict.startsWith('KILLED')).length}/${rows.length} mutants KILLED (${rows.filter((x) => x.verdict === 'KILLED').length} by at least one SCENARIO, ${rows.filter((x) => x.verdict === 'KILLED*').length} by pin-type assertions only)`
    + (survived.length ? `; NOT killed: ${survived.map((x) => `${x.name}=${x.verdict}`).join(', ')}` : ''));
  process.exit(survived.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
