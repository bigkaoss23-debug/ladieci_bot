'use strict';
// MESA / SALA — S4 SHADOW FIX. Behavioral proof for §15's SHADOW clause:
// "the boot check logs both heads for one full service before /status
// reports on them." SHADOW_SEMANTICS = A (established by the prior
// read-only conformity check): /status must not EXPOSE head_verified /
// head_recorded / unverified_count / missing_required / checksum_mismatches,
// and migration authority must not influence /status's overall level, until
// a genuine post-boot service has closed.
//
// OFFLINE: global.fetch is stubbed -- no network, no real DB, no mutation of
// live service-lifecycle data (per the task's own "do not manufacture a
// service completion" / "do not mutate service lifecycle data merely to
// test this locally" constraints). The mock applies the SAME filter clauses
// the real code sends (opened_at=gt.<bootTime>, status=eq.closed,
// open_source=neq.test_fixture) against an in-memory fake service_sessions
// table per scenario, so both URL construction and response handling are
// exercised, not just a trivially-true stub.
//
// One test in section A calls getMigrationStatusForStatusEndpoint, a
// function that does not exist at all on the pre-fix commit
// (53e289c8c297f9336c8e06909b9da9a4c7562ad2) -- its absence there is exactly
// how the defect manifested (no gating layer, /status always called
// getMigrationStatus() directly and exposed the real heads immediately).
// That test therefore fails on the pre-fix commit (require() finds no such
// export) and passes only after this fix lands.
//
// Authority: MESA_REMEDIATION_PLAN_FINAL_V2_1_2_2026-08-15.md, slice S4
// SHADOW FIX.

process.env.SUPABASE_URL = 'http://mock.local';
process.env.SUPABASE_KEY = 'mock-service-role-shadow';

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
};

// ── Fake PostgREST layer ────────────────────────────────────────────────
// `sessionsFixture` is set per test before calling into migrationAuthority.
// The mock parses the real query string the code sends and applies the
// same three clauses a real PostgREST server would, against the fixture.
let sessionsFixture = [];
let ladieciFixture = [];
let lastServiceSessionsUrl = null;

global.fetch = async (url, init) => {
  const u = String(url);
  const method = (init && init.method) || 'GET';
  if (u.includes('/service_sessions')) {
    lastServiceSessionsUrl = u;
    const qs = u.split('?')[1] || '';
    const params = new URLSearchParams(qs);
    let rows = sessionsFixture;
    const statusEq = params.get('status');
    if (statusEq && statusEq.startsWith('eq.')) {
      const want = statusEq.slice(3);
      rows = rows.filter(r => r.status === want);
    }
    const openSourceNeq = params.get('open_source');
    if (openSourceNeq && openSourceNeq.startsWith('neq.')) {
      const not = openSourceNeq.slice(4);
      rows = rows.filter(r => r.open_source !== not);
    }
    const openedAtGt = params.get('opened_at');
    if (openedAtGt && openedAtGt.startsWith('gt.')) {
      const threshold = new Date(decodeURIComponent(openedAtGt.slice(3))).getTime();
      rows = rows.filter(r => new Date(r.opened_at).getTime() > threshold);
    }
    const limit = params.get('limit');
    if (limit) rows = rows.slice(0, Number(limit));
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  }
  if (u.includes('/ladieci_schema_migrations')) {
    return { ok: true, status: 200, text: async () => JSON.stringify(ladieciFixture) };
  }
  return { ok: true, status: 200, text: async () => '[]' };
};

delete require.cache[require.resolve('../src/utils/migrationAuthority')];
const authority = require('../src/utils/migrationAuthority');

const BOOT = '2026-08-16T00:00:00.000Z';
const beforeBoot = '2026-08-15T20:00:00.000Z';
const afterBoot1 = '2026-08-16T01:00:00.000Z';
const afterBoot2 = '2026-08-16T02:00:00.000Z';

function resetLatch() {
  authority._resetShadowWindowForTests();
  sessionsFixture = [];
}

(async () => {
  // ── A. Fresh boot, no qualifying service yet ────────────────────────────
  console.log('\n== A. Fresh boot, no service opened after boot ==');
  resetLatch();
  {
    const r = await authority.getMigrationStatusForStatusEndpoint(BOOT);
    assert('A1: shadow marker returned, not the real heads', r.phase === 'shadow' && r.headVerified === undefined && r.level === undefined);
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('A2: hasShadowWindowElapsed() is false', elapsed === false);
  }

  // ── B. Service already open before boot, closes after boot -- must NOT count ──
  console.log('\n== B. Pre-boot-open service closing after boot does not count ==');
  resetLatch();
  sessionsFixture = [
    { id: 's1', status: 'closed', opened_at: beforeBoot, closed_at: afterBoot1, open_source: 'auto_entry' },
  ];
  {
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('B1: does not satisfy the gate (opened_at <= BOOT_TIME)', elapsed === false);
    assert('B2: the sent query filters on opened_at=gt.<boot>, not closed_at', /opened_at=gt\./.test(lastServiceSessionsUrl || ''));
  }

  // ── C. Service opens after boot but remains open ─────────────────────────
  console.log('\n== C. Post-boot service still open ==');
  resetLatch();
  sessionsFixture = [
    { id: 's2', status: 'open', opened_at: afterBoot1, closed_at: null, open_source: 'auto_entry' },
  ];
  {
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('C1: does not satisfy the gate (status=open, not closed)', elapsed === false);
    const r = await authority.getMigrationStatusForStatusEndpoint(BOOT);
    assert('C2: /status still shows only the shadow marker', r.phase === 'shadow');
  }

  // ── D. Service opens after boot AND legitimately closes after boot ──────
  console.log('\n== D. Genuine post-boot service closes -> shadow completes ==');
  resetLatch();
  sessionsFixture = [
    { id: 's3', status: 'closed', opened_at: afterBoot1, closed_at: afterBoot2, open_source: 'auto_entry' },
  ];
  ladieciFixture = [
    { filename: 'a.sql', checksum_sha256: 'aaaa000000000000', apply_order: 1, kind: 'bootstrap', verification_status: 'verified' },
    { filename: 'b.sql', checksum_sha256: 'bbbb000000000000', apply_order: 2, kind: 'bootstrap', verification_status: 'bootstrapped_unverified' },
  ];
  {
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('D1: satisfies the gate', elapsed === true);
    const r = await authority.getMigrationStatusForStatusEndpoint(BOOT);
    assert('D2: the FULL migrations block is now returned (not the shadow marker)', r.phase === undefined && r.headVerified === 1 && r.headRecorded === 2 && r.unverifiedCount === 1);
    assert('D3: latch is sticky -- a second call does not re-query the DB', await authority.hasShadowWindowElapsed(BOOT) === true);
  }

  // ── E. Synthetic/test fixture does not satisfy the gate ──────────────────
  console.log('\n== E. Synthetic TEST fixture excluded ==');
  resetLatch();
  sessionsFixture = [
    { id: 's4', status: 'closed', opened_at: afterBoot1, closed_at: afterBoot2, open_source: 'test_fixture' },
  ];
  {
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('E1: a test_fixture row does not satisfy the gate', elapsed === false);
  }

  // ── F. Historical closed service from before boot does not satisfy the gate ──
  console.log('\n== F. Historical (fully pre-boot) closed service excluded ==');
  resetLatch();
  sessionsFixture = [
    { id: 's5', status: 'closed', opened_at: beforeBoot, closed_at: beforeBoot, open_source: 'cron_dinner' },
  ];
  {
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('F1: a fully-historical closed session does not satisfy the gate', elapsed === false);
  }

  // ── G. rolled_over does NOT satisfy the gate (only status='closed' does) ──
  console.log('\n== G. rolled_over is a different terminal outcome, not counted ==');
  resetLatch();
  sessionsFixture = [
    { id: 's6', status: 'rolled_over', opened_at: afterBoot1, closed_at: null, open_source: 'auto_entry' },
  ];
  {
    const elapsed = await authority.hasShadowWindowElapsed(BOOT);
    assert('G1: rolled_over alone does not satisfy the gate (deliberate, narrower reading)', elapsed === false);
  }

  // ── H. Post-shadow behavior matches getMigrationStatus() exactly ─────────
  console.log('\n== H. Post-shadow output identical to the unconditional getMigrationStatus() ==');
  resetLatch();
  sessionsFixture = [
    { id: 's7', status: 'closed', opened_at: afterBoot1, closed_at: afterBoot2, open_source: 'auto_entry' },
  ];
  ladieciFixture = [
    { filename: 'req.sql', checksum_sha256: 'cccc000000000000', apply_order: 5, kind: 'ddl', verification_status: 'verified' },
  ];
  {
    await authority.hasShadowWindowElapsed(BOOT); // complete the gate
    const gated = await authority.getMigrationStatusForStatusEndpoint(BOOT);
    const direct = await authority.getMigrationStatus();
    assert('H1: gated result equals the direct getMigrationStatus() result once shadow has completed',
      JSON.stringify(gated) === JSON.stringify(direct));
  }

  // ── I. The boot log's own call path is never gated ───────────────────────
  console.log('\n== I. Boot log path (getMigrationStatus) is unconditional ==');
  resetLatch();
  sessionsFixture = []; // no qualifying service anywhere -- shadow NOT complete
  ladieciFixture = [
    { filename: 'x.sql', checksum_sha256: 'dddd000000000000', apply_order: 9, kind: 'bootstrap', verification_status: 'verified' },
  ];
  {
    const bootLogResult = await authority.getMigrationStatus();
    assert('I1: getMigrationStatus() (the boot log\'s own call) returns the real heads even though shadow has not completed',
      bootLogResult.headVerified === 9 && bootLogResult.phase === undefined);
    const statusResult = await authority.getMigrationStatusForStatusEndpoint(BOOT);
    assert('I2: meanwhile /status\'s own path still shows only the shadow marker', statusResult.phase === 'shadow');
  }

  // ── J. Defect reproduction: getMigrationStatusForStatusEndpoint did not exist pre-fix ──
  console.log('\n== J. Defect reproduction ==');
  assert('J1: getMigrationStatusForStatusEndpoint is exported (absent on 53e289c8 -- this is exactly how the defect manifested: /status called getMigrationStatus() directly, with no gating layer at all, so heads were always visible immediately from first boot)',
    typeof authority.getMigrationStatusForStatusEndpoint === 'function');

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
})();
