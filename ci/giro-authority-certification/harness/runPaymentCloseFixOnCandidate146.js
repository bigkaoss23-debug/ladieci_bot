'use strict';
// FINDING A (145) regression ON THE FINAL ECONOMY CANDIDATE 143 + 144 + 145 + 146: the UNMODIFIED 145 runner (runPaymentCloseFix.js) is compiled in memory with exactly ONE
// edit -- its POST template becomes BASE + 145 + 146 instead of BASE + 145 -- and run on the phases that exercise the payment x close contract on POST. Nothing is written
// to the repository and runPaymentCloseFix.js is not touched.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres and pg> [W3_PG_DATA_ROOT=<tmp>] node ci/giro-authority-certification/harness/runPaymentCloseFixOnCandidate146.js [phase ...]
//
// Default phases: serialize scenarios sweeps regress stress (apply / drift / rollback are 145 transitions from BASE, where 146 is absent by construction; they are proved
// by the unmodified 145 run and by the 146 rollback-order checks of runFindingBRefundFix.js).

const path = require('path');
const fs = require('fs');
const Module = require('module');

const RUNNER = path.join(__dirname, 'runPaymentCloseFix.js');
const F146 = process.env.FB_FWD146 || path.join(__dirname, '..', '..', '..', 'migrations', '2026-09-25_refund_close_receipt_lock_v1_migration_146.sql');

let src = fs.readFileSync(RUNNER, 'utf8');
const edit = (from, to) => { if (src.split(from).length !== 2) throw new Error('runPaymentCloseFixOnCandidate146: the anchor must occur exactly once: ' + from.slice(0, 70)); src = src.replace(from, () => to); };
edit("env.tpl.post = await buildDerived('post', [F145], env.tpl.base);", `env.tpl.post = await buildDerived('post', [F145, ${JSON.stringify(F146)}], env.tpl.base);`);

const phases = process.argv.slice(2);
process.argv = [process.argv[0], RUNNER, ...(phases.length ? phases : ['serialize', 'scenarios', 'sweeps', 'regress', 'stress'])];
const m = new Module(RUNNER, module);
m.filename = RUNNER;
m.paths = Module._nodeModulePaths(path.dirname(RUNNER));
m._compile(src, RUNNER);
