'use strict';
// C8 regression ON THE CANDIDATE WITH 145: the UNMODIFIED C8 runner (runC8LockOrderFix.js, frozen with migrations 143 / 144) is compiled in memory with exactly two edits and run
// against a POST template that carries 143 + 144 + 145 (the future rollout order). Nothing is written to the repository and the C8 runner file is not touched.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres and pg> [W3_PG_DATA_ROOT=<tmp>] node ci/giro-authority-certification/harness/runC8OnCandidate145.js [phase ...]
//
// Edit 1: the POST template = 143 + 144 + 145 (the FILE of migration 145, or PCF_FWD145 for a mutant).
// Edit 2: the differential regression records one step, "KNOWN_SEPARATE_FINDING_A payment x close", whose whole point was to RECORD the defect that 145 now fixes: on PRE it is the
//         misattributed receipt, on POST-145 it is the off-service receipt, so it is deliberately no longer part of the PRE == POST comparison (it is asserted by runPaymentCloseFix.js).
// Default phases: prefix hyp pairs natural numbering parity regress serial (apply / drift / rollback are 143 / 144 transitions from PRE: they do not involve 145 and are proved by the
// unmodified C8 run itself, executed separately).

const fs = require('fs');
const path = require('path');
const Module = require('module');

const RUNNER = path.join(__dirname, 'runC8LockOrderFix.js');
const F145 = process.env.PCF_FWD145 || path.join(__dirname, '..', '..', '..', 'migrations', '2026-09-24_payment_close_receipt_lock_v1_migration_145.sql');

let src = fs.readFileSync(RUNNER, 'utf8');
const edit = (from, to) => { if (src.split(from).length !== 2) throw new Error('runC8OnCandidate145: the anchor must occur exactly once: ' + from.slice(0, 70)); src = src.replace(from, () => to); };
edit("post: await buildDerived('post', [F143, F144]),", `post: await buildDerived('post', [F143, F144, ${JSON.stringify(F145)}]),`);
edit("say('KNOWN_SEPARATE_FINDING_A payment x close', {", 'void ({');

const phases = process.argv.slice(2);
process.argv = [process.argv[0], RUNNER, ...(phases.length ? phases : ['prefix', 'hyp', 'pairs', 'natural', 'numbering', 'parity', 'regress', 'serial'])];
const m = new Module(RUNNER, module);
m.filename = RUNNER;
m.paths = Module._nodeModulePaths(path.dirname(RUNNER));
m._compile(src, RUNNER);
