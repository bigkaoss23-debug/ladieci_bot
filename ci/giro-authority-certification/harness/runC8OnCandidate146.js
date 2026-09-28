'use strict';
// C8 regression ON THE FINAL ECONOMY CANDIDATE 143 + 144 + 145 + 146: the UNMODIFIED C8 runner (runC8LockOrderFix.js, frozen with migrations 143 / 144) is compiled in
// memory with exactly three edits and run against a POST template that carries 143 + 144 + 145 + 146 (the rollout order). Nothing is written to the repository and neither
// the C8 runner nor runC8OnCandidate145.js is touched.
//
//   W3_PG_NODE_MODULES=<dir with embedded-postgres and pg> [W3_PG_DATA_ROOT=<tmp>] node ci/giro-authority-certification/harness/runC8OnCandidate146.js [phase ...]
//
// Edit 1: the POST template = 143 + 144 + 145 + 146 (the FILES; FB_FWD146 for a mutant).
// Edit 2: as in runC8OnCandidate145.js, the step "KNOWN_SEPARATE_FINDING_A payment x close" (which RECORDED the defect 145 fixes) is not part of the PRE == POST comparison.
// Edit 3: the first-open phase counted a raw 23514 of a refund with NO service open as the "known separate finding B". On this candidate Finding B is FIXED: the same
//         refund is the TYPED 55000 ORDER_REFUND_NO_OPEN_SERVICE. The edit makes that typed refusal the only tolerated outcome -- a raw 23514 is now UNEXPECTED (stricter).
// Default phases: hyp pairs natural regress -- the phases that call the refund writers (the only objects 146 changes: its catalog diff is exactly those two bodies);
// prefix / numbering / parity / serial never call a refund writer and are invariant by construction (they were run on 143 + 144 + 145 by runC8OnCandidate145.js).

const path = require('path');
const fs = require('fs');
const Module = require('module');

const RUNNER = path.join(__dirname, 'runC8LockOrderFix.js');
const MIG = path.join(__dirname, '..', '..', '..', 'migrations');
const F145 = path.join(MIG, '2026-09-24_payment_close_receipt_lock_v1_migration_145.sql');
const F146 = process.env.FB_FWD146 || path.join(MIG, '2026-09-25_refund_close_receipt_lock_v1_migration_146.sql');

let src = fs.readFileSync(RUNNER, 'utf8');
const edit = (from, to) => { if (src.split(from).length !== 2) throw new Error('runC8OnCandidate146: the anchor must occur exactly once: ' + from.slice(0, 70)); src = src.replace(from, () => to); };
edit("post: await buildDerived('post', [F143, F144]),", `post: await buildDerived('post', [F143, F144, ${JSON.stringify(F145)}, ${JSON.stringify(F146)}]),`);
edit("say('KNOWN_SEPARATE_FINDING_A payment x close', {", 'void ({');
edit("f[wname].unexpected = Object.keys(f[wname].other).filter((k) => !/23514/.test(k));", "f[wname].unexpected = Object.keys(f[wname].other).filter((k) => !/^W_REFUND_HIST:55000:ORDER_REFUND_NO_OPEN_SERVICE/.test(k));");

const phases = process.argv.slice(2);
process.argv = [process.argv[0], RUNNER, ...(phases.length ? phases : ['hyp', 'pairs', 'natural', 'regress'])];
const m = new Module(RUNNER, module);
m.filename = RUNNER;
m.paths = Module._nodeModulePaths(path.dirname(RUNNER));
m._compile(src, RUNNER);
