'use strict';
// B7A1 grant-hardening static tests. Run: node tests/b7FinancialLedgerGrantHardeningMigration.test.js
// NON-EXECUTING: asserts the hardening migration restricts service_role to
// SELECT+INSERT on the ledger (privileges only), touches no other table/schema/
// data, and leaves anon/authenticated/PUBLIC with no access. Comment-stripped
// structural assertions + negative controls. No DB, no apply.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

const MIG_DIR = path.join(__dirname, '..', 'migrations');
const ALL = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql'));
const isRB = (f) => f.endsWith('.ROLLBACK.sql');
const FWD_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.sql$/;
const RB_CONV = /^\d{4}-\d{2}-\d{2}_[a-z0-9_]+\.ROLLBACK\.sql$/;
const FWD = '2026-07-15_b7_financial_ledger_grant_hardening.sql';
const RB = '2026-07-15_b7_financial_ledger_grant_hardening.ROLLBACK.sql';
const B7A1 = '2026-07-15_b7_financial_ledger_foundation.sql';

// (15) filenames match conventions
assert('forward filename matches convention', FWD_CONV.test(FWD) && !isRB(FWD));
assert('rollback filename matches convention', RB_CONV.test(RB));
assert('both files exist', fs.existsSync(path.join(MIG_DIR, FWD)) && fs.existsSync(path.join(MIG_DIR, RB)));
assert('forward discovered as a non-rollback migration', ALL.includes(FWD) && !isRB(FWD));

const SQL = read('migrations/' + FWD);
const RBSQL = read('migrations/' + RB);
const strip = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const S = strip(SQL);
const R = strip(RBSQL);

// (1) does not modify the original B7A1 migration: the B7A1 file still has its
// schema DDL, and the hardening file has NO schema DDL of its own.
const B7A1_SQL = read('migrations/' + B7A1);
assert('original B7A1 migration still present + intact (schema DDL retained)',
  /CREATE TABLE public\.order_financial_events/.test(B7A1_SQL) &&
  /ADD COLUMN refunded boolean NOT NULL DEFAULT false/.test(B7A1_SQL));
assert('hardening migration is a distinct file (not the B7A1 file)', FWD !== B7A1);

// transaction + sentinel + table-exists precondition
assert('wrapped in BEGIN/COMMIT', /^\s*BEGIN;/.test(S) && /COMMIT;\s*$/.test(S.trim() + '\n'));
assert('staging sentinel present', /schema_migrations WHERE version='20260710075612'/.test(S));
assert('verifies ledger table exists', /to_regclass\('public\.order_financial_events'\) IS NULL/.test(S) && /apply B7A1 foundation first/.test(S));

// (3) revoke all table privileges from service_role
assert('revokes ALL table privileges from service_role',
  /REVOKE ALL PRIVILEGES ON TABLE public\.order_financial_events FROM service_role/.test(S));
// (4) grants exactly SELECT, INSERT back
assert('grants exactly SELECT, INSERT to service_role',
  /GRANT SELECT, INSERT ON TABLE public\.order_financial_events TO service_role/.test(S));
// (5-9) grants no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER to service_role
assert('no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER granted to service_role',
  !/GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO service_role/i.test(S));
// (10) no GRANT ALL
assert('no GRANT ALL anywhere', !/GRANT ALL/i.test(S));
// (11) PUBLIC/anon/authenticated remain fully revoked (and never re-granted)
assert('revokes all from PUBLIC/anon/authenticated',
  /REVOKE ALL PRIVILEGES ON TABLE public\.order_financial_events FROM PUBLIC, anon, authenticated/.test(S));
assert('never grants any table privilege to PUBLIC/anon/authenticated',
  !/GRANT[\s\S]*?ON TABLE public\.order_financial_events[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(S));

// (2) targets ONLY the ledger table (no other table appears in a grant/revoke)
assert('targets only order_financial_events (no other table in grants/revokes)',
  !/ON TABLE public\.(ordenes|manual_giros|auth_actors|auth_audit)\b/i.test(S));

// trigger-function EXECUTE hardening (infrastructure only)
assert('revokes direct EXECUTE on the append-only function from service_role/PUBLIC/anon/authenticated',
  /REVOKE ALL PRIVILEGES ON FUNCTION public\.order_financial_events_append_only\(\)[\s\S]*?FROM service_role, PUBLIC, anon, authenticated/.test(S));
assert('does not re-grant EXECUTE to service_role in forward', !/GRANT EXECUTE[\s\S]*?TO service_role/.test(S));

// (12) no schema/RLS/policy/trigger/business-function creation
assert('no schema/table/column creation', !/CREATE TABLE|ALTER TABLE|ADD COLUMN|DROP COLUMN|ALTER COLUMN/i.test(S));
assert('no RLS/policy change', !/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY/i.test(S));
assert('no trigger/function creation or drop', !/CREATE TRIGGER|DROP TRIGGER|CREATE OR REPLACE FUNCTION|DROP FUNCTION|CREATE FUNCTION/i.test(S));
assert('creates no business RPC', !/public\.order_(create|mark_paid|rider_deliver|void|refund|import)/i.test(S));
// (13) no data statement
assert('no data mutation statement', !/\b(INSERT|UPDATE|DELETE|TRUNCATE)\s+(INTO\s+)?public\./i.test(S) && !/\bTRUNCATE TABLE\b/i.test(S));

// (14) rollback changes privileges only
assert('rollback is privileges-only (GRANT/REVOKE only)',
  !/CREATE |DROP |ALTER TABLE|ADD COLUMN|INSERT |UPDATE |DELETE |TRUNCATE |ROW LEVEL SECURITY|CREATE POLICY/i.test(R));
assert('rollback restores broad service_role table privileges (labelled, enumerated, no GRANT ALL)',
  /GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s*ON TABLE public\.order_financial_events TO service_role/.test(R) &&
  !/GRANT ALL/i.test(R));
assert('rollback never touches data/schema/another table',
  !/ON TABLE public\.(ordenes|manual_giros|auth_actors|auth_audit)\b/i.test(R) && !/DROP TABLE|DELETE FROM/i.test(R));

// (16) tests execute no SQL
assert('test executes no SQL / DB', (() => { const self = read('tests/b7FinancialLedgerGrantHardeningMigration.test.js');
  return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self); })());

// ── NEGATIVE CONTROLS ────────────────────────────────────────────────────────
(function nc() {
  const withUpdate = S.replace('GRANT SELECT, INSERT ON TABLE public.order_financial_events TO service_role',
    'GRANT SELECT, INSERT, UPDATE ON TABLE public.order_financial_events TO service_role');
  assert('NC1: detector catches UPDATE granted to service_role',
    /GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b[^;]*TO service_role/i.test(withUpdate));
  const withAll = S.replace('GRANT SELECT, INSERT ON TABLE public.order_financial_events TO service_role',
    'GRANT ALL ON TABLE public.order_financial_events TO service_role');
  assert('NC2: detector catches GRANT ALL', /GRANT ALL/i.test(withAll));
  const missingRevoke = S.replace(/REVOKE ALL PRIVILEGES ON TABLE public\.order_financial_events FROM service_role;?/, '');
  assert('NC3: detector catches missing service_role REVOKE',
    !/REVOKE ALL PRIVILEGES ON TABLE public\.order_financial_events FROM service_role/.test(missingRevoke));
  const grantsAnon = S.replace('REVOKE ALL PRIVILEGES ON TABLE public.order_financial_events FROM PUBLIC, anon, authenticated',
    'GRANT SELECT ON TABLE public.order_financial_events TO authenticated');
  assert('NC4: detector catches a grant leaking to authenticated',
    /GRANT[\s\S]*?ON TABLE public\.order_financial_events[\s\S]*?TO (PUBLIC|anon|authenticated)\b/i.test(grantsAnon));
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
