'use strict';
// ===============================================================
// LEGACY WRITER HARDENING (H-1) — ZERO REACHABLE LEGACY LIFECYCLE WRITERS.
//
// Every invariant below used to hold only because of an environment variable
// or an absent caller:
//
//   LEGACY_AUTOMATIC_LIFECYCLE_ENABLED=false  the close-tick, the boot
//                                             catch-up, the external cron
//                                             action, the page-load pre-check
//   ECONOMIC_PERIOD_ROLLOVER_ENABLED unset    the period rollover
//   "no caller since F-5"                     the V3 successor opener
//   "no frontend button since 3eeb24d"        the manual reopen
//
// An env var is not an invariant. This file asserts the STRUCTURAL versions:
// the JS call sites are gone, the HTTP surfaces refuse unconditionally, and
// the DB migration fail-closes the four legacy RPCs and revokes the one
// accidental grant.
//
// Run: node --test tests/legacyWriterHardening.static.test.js
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const root = (...p) => path.join(__dirname, '..', ...p);
const raw = (f) => fs.readFileSync(root(f), 'utf8');
// Executable code only: these files legitimately NAME the things they retire.
const code = (f) => raw(f)
  .split(/\r?\n/)
  .map((l) => l.replace(/\/\/.*$/, ''))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const sqlCode = (f) => raw(f).split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');

const MIGRATION = 'migrations/2026-08-20_h1_legacy_lifecycle_writer_hardening.sql';
const ROLLBACK = 'migrations/2026-08-20_h1_legacy_lifecycle_writer_hardening.ROLLBACK.sql';
const FWD = sqlCode(MIGRATION);
const RB = sqlCode(ROLLBACK);
const INDEX = code('index.js');
const ENSURE = code('src/serviceSessions/ensureServiceSession.js');

// ── 1. the page-load ensure cannot mutate, by construction ────────────────
test('1: ensureServiceSession has ZERO rollover call sites and no flag to re-enable one', () => {
  assert.doesNotMatch(ENSURE, /performRollover\(/);
  assert.doesNotMatch(ENSURE, /automaticLifecycleEnabled/);
  assert.doesNotMatch(ENSURE, /incidentSafeRollover/);
  assert.doesNotMatch(ENSURE, /isRolloverDue|classifySessionForRollover/);
});

test('2: it still performs its read-only job', () => {
  assert.match(ENSURE, /sessionLifecycle\.currentCloseout\(\)/);
  assert.match(ENSURE, /sessionLifecycle\.ensure\(\{ actor, source \}\)/);
  for (const c of ['REUSED', 'NO_OPEN_SERVICE', 'SERVICE_SESSION_CLOSING', 'INVALID_ACTOR']) {
    assert.match(ENSURE, new RegExp(c));
  }
});

// ── 2. the manual reopen HTTP surface is gone ─────────────────────────────
test('3: openServiceSession refuses unconditionally, with no env flag and no engine call', () => {
  assert.match(INDEX, /MANUAL_SERVICE_OPEN_RETIRED/);
  assert.match(INDEX, /status\(410\)/);
  // The action must not reach the reopen module at all any more.
  assert.doesNotMatch(INDEX, /explicitReopenServiceSession\(/);
  assert.doesNotMatch(INDEX, /require\(["'].*explicitReopenServiceSession["']\)/);
});

test('4: the refusal is not conditional on anything', () => {
  const block = INDEX.slice(INDEX.indexOf('if (action === "openServiceSession")'),
                            INDEX.indexOf('} else if (action === "rollEconomicPeriod")'));
  assert.ok(block.length > 0, 'openServiceSession block located');
  assert.doesNotMatch(block, /process\.env/);
  assert.doesNotMatch(block, /LEGACY_AUTOMATIC_LIFECYCLE_ENABLED/);
  assert.match(block, /return res\.status\(410\)/);
});

// ── 3. the migration retires exactly the four legacy RPCs ─────────────────
test('5: the migration replaces exactly the four legacy writers and nothing else', () => {
  const replaced = [...FWD.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(replaced, [
    'begin_service_session_close',
    'complete_service_session_close',
    'ensure_next_service_session_v3',
    'roll_service_session_economic_v1',
  ]);
  assert.doesNotMatch(FWD, /\bDROP\s+FUNCTION\b/i);
});

test('6: each retired body is inert and names its replacement', () => {
  const bodies = [...FWD.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/g)];
  assert.equal(bodies.length, 4);
  for (const [, name, body] of bodies) {
    assert.doesNotMatch(body, /INSERT\s+INTO/i, `${name} must not insert`);
    assert.doesNotMatch(body, /UPDATE\s+public\./i, `${name} must not update`);
    assert.doesNotMatch(body, /DELETE\s+FROM/i, `${name} must not delete`);
    assert.match(body, /_RETIRED/, `${name} must return a typed refusal`);
    assert.match(body, /'use',/, `${name} must name its replacement`);
  }
});

test('7: the accidental anon/authenticated grant is revoked', () => {
  for (const role of ['PUBLIC', 'anon', 'authenticated']) {
    assert.match(FWD, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.complete_service_session_close\\(uuid,text,text,boolean\\) FROM ${role};`));
  }
});

// ── 4. the migration proves the resulting surfaces ────────────────────────
test('8: post-conditions pin the creation surface to exactly one function', () => {
  assert.match(FWD, /expected exactly open_operational_service_v1/);
  assert.match(FWD, /v_creators <> 1/);
});

test('9: post-conditions pin the close surface to exactly one function', () => {
  assert.match(FWD, /expected exactly close_service_session_v3/);
  assert.match(FWD, /v_closers <> 1/);
});

test('10: post-conditions assert no lifecycle RPC is reachable by anon/authenticated', () => {
  assert.match(FWD, /still executable by anon\/authenticated/);
  assert.match(FWD, /has_function_privilege\('anon'/);
  assert.match(FWD, /has_function_privilege\('authenticated'/);
});

test('11: G-1, F-10 and F-11 are asserted preserved, by checksum AND by content', () => {
  // checksums of the canonical four
  for (const sum of ['9a23c0e3e5e49199a14fbc9bff602e4d', '78b9cb458ea9d9ab37056f34f32d52e7',
                     'd8811ef0990e038d2b56a2e66c191770', '5c1155299e0f052b6c74ddc0b9fedfa7']) {
    assert.ok(FWD.includes(sum), `canonical checksum ${sum} pinned`);
  }
  // and by content, so a checksum typo cannot make the check vacuous
  assert.match(FWD, /F-10 forgotten-close raise is missing/);
  assert.match(FWD, /F-11 stale-Business-Day classification is missing/);
});

test('12: the frozen Mesa first-seating guard is pinned before AND after', () => {
  const first = FWD.indexOf('cdf15eb3699a6a86c16519b1dbcd2f1c');
  const last = FWD.lastIndexOf('cdf15eb3699a6a86c16519b1dbcd2f1c');
  const firstReplace = FWD.indexOf('CREATE OR REPLACE FUNCTION');
  assert.ok(first > -1 && first < firstReplace, 'pinned before any replace');
  assert.ok(last > firstReplace, 'and re-pinned after');
  assert.doesNotMatch(FWD, /CREATE OR REPLACE FUNCTION public\.mesa_open_(session|reservation)_v1/);
});

test('13: it refuses if any service is mid-close — the one unsafe state', () => {
  assert.match(FWD, /status = 'closing'/);
  assert.match(FWD, /are mid-close; finish or recover them/);
});

test('14: it opens and closes nothing, and touches no product data', () => {
  const topLevel = FWD.split(/AS \$function\$[\s\S]*?\$function\$;/).join('\n');
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.(service_sessions|ordenes|table_sessions|payment_transactions)/i);
  assert.doesNotMatch(topLevel, /UPDATE\s+public\.(service_sessions|ordenes|table_sessions)/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM\s+public\./i);
  assert.match(FWD, /expected exactly one active Operational Service to be untouched/);
});

// ── 5. the rollback is a true inverse, with one documented asymmetry ──────
test('15: the rollback restores all four bodies and proves each byte-identically', () => {
  const restored = [...RB.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(restored, [
    'begin_service_session_close',
    'complete_service_session_close',
    'ensure_next_service_session_v3',
    'roll_service_session_economic_v1',
  ]);
  for (const sum of ['02b815682c9ba6c3353a2c5d93726046', '2cc17d5d2463528fdf8ad3372e9bd712',
                     '70609253b1ee62c737f263a4ef340dcf', '9c9516afae8655353301071aa3548b74']) {
    assert.ok(RB.includes(sum), `restore checksum ${sum} asserted`);
  }
  assert.match(RB, /not restored byte-identically/);
});

test('16: the rollback deliberately does NOT re-create the accidental grant', () => {
  assert.doesNotMatch(RB, /GRANT\s+EXECUTE/i);
  assert.match(RB, /must stay revoked/);
});

test('17: the rollback refuses on a database that never had H-1, and touches no data', () => {
  assert.match(RB, /H-1 rollback refused: H-1 does not appear to be applied/);
  const topLevel = RB.split(/AS \$function\$[\s\S]*?\$function\$;/).join('\n');
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.service_sessions/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM/i);
});

// ── 6. prosrc reality check (the G-1 lesson) ──────────────────────────────
test('18: no retired body NAMES a token its own post-condition forbids', () => {
  // prosrc keeps comments. G-1's first apply failed on exactly this. The
  // retired bodies are comment-free by design; assert it rather than trust it.
  const bodies = [...raw(MIGRATION).matchAll(/CREATE OR REPLACE FUNCTION public\.[a-z0-9_]+\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/g)]
    .map((m) => m[1]);
  assert.equal(bodies.length, 4);
  for (const b of bodies) {
    assert.doesNotMatch(b, /--/, 'retired bodies must carry no SQL comments at all');
    assert.doesNotMatch(b, /INSERT INTO|UPDATE public\.|DELETE FROM/i);
  }
});
