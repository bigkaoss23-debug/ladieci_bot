'use strict';
// B6B boundary tests. Run: node tests/adminAccessBoundary.static.test.js
// Proves the B6B modules keep transport/auth outside the service, no second
// hasher/policy/ip-hash, no direct table
// write, no frozen-B2 RPC usage, and the B6A migration is not executed by tests.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Strip // comments (B6B source contains no URLs / block comments) so prose like
// "NOT a human-JWT flow" is never matched as behavior.
const stripComments = (s) => s.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
const DAO = stripComments(read('src/auth/adminAccessDao.js'));
const SVC = stripComments(read('src/auth/adminAccessService.js'));
const B6B = DAO + '\n' + SVC;
const INDEX = read('index.js');

// ── wired once through the guarded legacy dispatcher ─────────────────────────
assert('index.js wires adminAccessDao', /adminAccessDao/.test(INDEX));
assert('index.js wires adminAccessService', /adminAccessService/.test(INDEX));
assert('index.js has no auth_admin_ RPC reference', !/auth_admin_/.test(INDEX));

// ── no Express route / HTTP wiring inside B6B ────────────────────────────────
assert('B6B adds no Express route/app/router', !/\b(express|app\.(get|post|put|patch|delete)|router\.)/.test(B6B));
assert('B6B does not parse JWT / enforce fresh-auth', !/jwt|verifyToken|Authorization|Bearer|fresh[_-]?auth/i.test(B6B));
assert('B6B does not import the B4 authorization matrix', !/authorizationContract/.test(B6B));

// ── no second PIN hasher (B1 reused via injection) ───────────────────────────
assert('B6B defines no PIN hasher (no crypto.scrypt)', !/crypto\.scrypt/.test(B6B) && !/function\s+hashPin/.test(B6B));
assert('B6B does not require ./scrypt', !/require\(['"]\.\/scrypt/.test(B6B));

// ── no second PIN policy (B3 reused via injection) ───────────────────────────
assert('B6B defines no PIN policy (no ROLE_PIN_RULES / validatePinFormat def)',
  !/ROLE_PIN_RULES/.test(B6B) && !/function\s+validatePinFormat/.test(B6B));
assert('B6B does not require ./pinPolicy (injected instead)', !/require\(['"]\.\/pinPolicy/.test(B6B));

// ── no second IP-hash algorithm (B3 reused via injection) ────────────────────
assert('B6B computes no IP hash (no createHmac/sha256)', !/createHmac|sha256/i.test(B6B));
assert('B6B does not require ./ipSecurity (injected instead)', !/require\(['"]\.\/ipSecurity/.test(B6B));

// ── no direct auth_actors / auth_audit write ─────────────────────────────────
assert('B6B never PATCH/PUT/DELETE (no direct table write)', !/'PATCH'|'PUT'|'DELETE'/.test(B6B));
assert('B6B never writes auth_audit directly', !/sbRest\([^)]*auth_audit/.test(B6B) && !/POST[^\n]*auth_audit/.test(B6B));
assert('B6B only auth_actors access is a GET read', (() => {
  const gets = (DAO.match(/sbRest\('GET', 'auth_actors'/g) || []).length;
  const others = /sbRest\('(POST|PATCH|PUT|DELETE)', 'auth_actors'/.test(DAO);
  return gets >= 1 && !others;
})());

// ── no frozen B2 RPC usage ───────────────────────────────────────────────────
for (const rpc of ['auth_set_pin_hash', 'auth_bump_session_version', 'auth_set_active', 'auth_reset_failed_attempts']) {
  assert(`B6B does not call frozen B2 RPC ${rpc}`, !new RegExp(rpc).test(B6B));
}
// only the four B6A RPCs are referenced
const rpcRefs = (DAO.match(/auth_admin_[a-z_]+/g) || []);
const EXPECTED = ['auth_admin_set_actor_pin', 'auth_admin_revoke_actor_sessions', 'auth_admin_set_actor_active', 'auth_admin_unlock_actor'];
assert('B6B references exactly the four B6A RPC names', EXPECTED.every((n) => rpcRefs.includes(n)) && rpcRefs.every((n) => EXPECTED.includes(n)));

// ── only index.js imports B6B ────────────────────────────────────────────────
assert('only index.js imports B6B', (() => {
  const roots = ['src', 'index.js'];
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
    if (p.endsWith('.js')) files.push(p);
  };
  for (const r of roots) walk(path.join(__dirname, '..', r));
  const imports = files.filter((f) => !/adminAccessDao\.js$|adminAccessService\.js$/.test(f))
    .filter((f) => /require\(['"]\.[^'"]*adminAccess/.test(fs.readFileSync(f, 'utf8')));
  return imports.length === 1 && imports[0].endsWith('index.js');
})());

// ── B6A migration not applied / executed by tests ────────────────────────────
assert('this test performs no DB call / migration apply', (() => {
  const self = read('tests/adminAccessBoundary.static.test.js');
  return !/require\(['"](pg|postgres|@supabase)/.test(self) && !/\.query\(/.test(self) && !/global\.fetch/.test(self);
})());
assert('B6A forward migration still present and unexecuted (file only)',
  fs.existsSync(path.join(__dirname, '..', 'migrations/2026-07-15_auth_admin_access_management.sql')));

// ── generic external failure shape is stable + carries no oracle ─────────────
assert('service exports a single generic ADMIN_FAIL shape', /ADMIN_FAIL = Object\.freeze\(\{ ok: false, error: 'admin_action_failed' \}\)/.test(SVC));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
