'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const forward = fs.readFileSync(path.join(root,
  'migrations/2026-08-01_v3h1a_messa_payment_digest_path.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root,
  'migrations/2026-08-01_v3h1a_messa_payment_digest_path.ROLLBACK.sql'), 'utf8');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}`); }
}

const signature = /messa_post_payment_v1\(\s*uuid,text,text,uuid,text,text,text,text,numeric,integer,uuid\[\],jsonb\s*\)/;

test('forward proves the exact V3-H predecessor',
  /name = 'v3h_messa_billing_foundation'/.test(forward) && /to_regprocedure/.test(forward));
test('forward proves pgcrypto is in the extensions schema',
  /e\.extname = 'pgcrypto'/.test(forward) && /n\.nspname = 'extensions'/.test(forward));
test('forward changes only the exact payment RPC search path',
  signature.test(forward)
  && /SET search_path = public, extensions, pg_temp/.test(forward)
  && !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(forward));
test('forward is transactional', /^\s*--[\s\S]*?\bBEGIN;[\s\S]*\bCOMMIT;\s*$/.test(forward));
test('rollback targets the same exact function and restores the prior path',
  signature.test(rollback) && /SET search_path = public, pg_temp/.test(rollback));
test('rollback rewrites no data', !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(rollback));

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
