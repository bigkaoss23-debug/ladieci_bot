'use strict';
// S2-7D6E3 FASE D — static contract of
// migrations/2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql.
//
// This is the CLEANUP half of the split rider rollout: it must (a) actually drop the
// ledger-less complete_rider_stop, (b) refuse to run unless FASE A's
// rider_collect_and_complete_stop already exists (so it can never be applied before the
// rider path it retires has a replacement), and (c) contain no CREATE/INSERT of its own —
// a cleanup migration that quietly does something additive is not a cleanup migration.
//
// Run: node tests/riderRetireCompleteRiderStopMigration.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

const MIG = path.join(__dirname, '..', 'migrations');
const FILE = '2026-07-27_s2_7d6e3d_retire_complete_rider_stop.sql';
const sql = fs.readFileSync(path.join(MIG, FILE), 'utf8');
const rollback = fs.readFileSync(path.join(MIG, FILE.replace('.sql', '.ROLLBACK.sql')), 'utf8');

console.log('\n[transaction + guards]');
check('wrapped in a single transaction', /^BEGIN;/m.test(sql) && /COMMIT;\s*$/.test(sql.trim()));
check('staging sentinel guard present', sql.includes("version='20260710075612'"));
check('refuses to run unless FASE A (rider_collect_and_complete_stop) already exists',
  /S2-7D6E3D refused: rider_collect_and_complete_stop absent/.test(sql));

console.log('\n[this is a cleanup migration, not an additive one]');
check('drops complete_rider_stop(text, boolean, text)',
  /DROP FUNCTION IF EXISTS public\.complete_rider_stop\(text, boolean, text\);/.test(sql));
check('contains no CREATE FUNCTION of its own', !/CREATE (OR REPLACE )?FUNCTION/.test(sql));
check('contains no INSERT/UPDATE (state-changing DML has no place in a function-retirement migration)',
  !/\bINSERT INTO\b|\bUPDATE public\./.test(sql));

console.log('\n[rollback]');
check('rollback exists and is transactional', /^BEGIN;/m.test(rollback) && /COMMIT;\s*$/.test(rollback.trim()));
check('rollback restores complete_rider_stop verbatim (ledger-less, cobrado-writing — a genuine step backward, documented as such)',
  /CREATE OR REPLACE FUNCTION public\.complete_rider_stop\(/.test(rollback)
  && /cobrado\s*=\s*COALESCE\(p_cobrado, true\)/.test(rollback));
check('rollback re-grants execute to service_role only',
  /GRANT {2}EXECUTE ON FUNCTION public\.complete_rider_stop\(text, boolean, text\) TO service_role/.test(rollback));

console.log('');
console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
