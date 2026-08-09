'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.4 — pure contract for
// src/serviceSessions/v3NextServiceIdentity.js. No DB, no engine — a thin
// wrapper over src/schedule/serviceSchedule.js's resolveSchedule(), so these
// tests mostly prove the TRANSLATION (resolveSchedule's six booleans -> this
// module's shouldEnsure/serviceKind/businessDate shape) is correct at every
// window boundary, not re-litigate resolveSchedule's own already-tested
// window math.
// language-guard: allow-legacy PRANZO is the existing service_kind enum value / SCHEDULE_STATE literal already defined by serviceSchedule.js, exercised here verbatim throughout, not new vocabulary

const { deriveNextServiceIdentity } = require('../src/serviceSessions/v3NextServiceIdentity');
const { DEFAULT_SCHEDULE } = require('../src/schedule/serviceSchedule');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// Madrid wall-clock helper — builds a UTC Date that lands on the given
// Madrid local time on a fixed, non-DST-ambiguous date (2026-08-09, CEST,
// UTC+2), matching this session's own "today" for readability.
const madrid = (h, m = 0) => new Date(Date.UTC(2026, 7, 9, h - 2, m));

console.log('\n== v3NextServiceIdentity.js — next-service derivation ==\n');

// language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised here verbatim, not new vocabulary
console.log('\n── PRANZO window (08:00-17:30): shouldEnsure true, PRANZO ──');
{
  const r = deriveNextServiceIdentity(madrid(12, 0), DEFAULT_SCHEDULE);
  assert('shouldEnsure true', r.shouldEnsure === true);
  // language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised here verbatim, not new vocabulary
  assert('serviceKind PRANZO', r.serviceKind === 'PRANZO');
  assert('businessDate is today', r.businessDate === '2026-08-09', r.businessDate);
}

console.log('\n── BETWEEN_SERVICES buffer (17:30-18:00): shouldEnsure false, serviceKind null ──');
{
  const r = deriveNextServiceIdentity(madrid(17, 45), DEFAULT_SCHEDULE);
  assert('shouldEnsure false', r.shouldEnsure === false);
  assert('serviceKind is null', r.serviceKind === null);
  assert('businessDate is still populated (schedule always knows the date)', r.businessDate === '2026-08-09', r.businessDate);
}

console.log('\n── SERA window (18:00-24:00): shouldEnsure true, SERA ──');
{
  const r = deriveNextServiceIdentity(madrid(20, 0), DEFAULT_SCHEDULE);
  assert('shouldEnsure true', r.shouldEnsure === true);
  assert('serviceKind SERA', r.serviceKind === 'SERA');
}

console.log('\n── AFTER_ORDER_CUTOFF (00:00-04:00, belongs to the PRIOR day\'s dinner): shouldEnsure false ──');
{
  const r = deriveNextServiceIdentity(madrid(1, 0), DEFAULT_SCHEDULE);
  assert('shouldEnsure false', r.shouldEnsure === false);
  assert('serviceKind is null', r.serviceKind === null);
  assert('businessDate rolls back to the prior calendar day (still before the 04:00 rollover)', r.businessDate === '2026-08-08', r.businessDate);
}

console.log('\n── OUTSIDE_WINDOWS (04:00-08:00, escalation span): shouldEnsure false ──');
{
  const r = deriveNextServiceIdentity(madrid(5, 30), DEFAULT_SCHEDULE);
  assert('shouldEnsure false', r.shouldEnsure === false);
  assert('serviceKind is null', r.serviceKind === null);
  assert('businessDate is today (past the 04:00 rollover)', r.businessDate === '2026-08-09', r.businessDate);
}

console.log('\n── boundary edges — half-open intervals, exact minute ──');
{
  const atLunchStart = deriveNextServiceIdentity(madrid(8, 0), DEFAULT_SCHEDULE);
  // language-guard: allow-legacy PRANZO/PRANZO_WINDOW are the existing service_kind enum value / SCHEDULE_STATE literal, exercised here verbatim, not new vocabulary
  assert('08:00 exactly is already PRANZO_WINDOW (inclusive start)', atLunchStart.shouldEnsure === true && atLunchStart.serviceKind === 'PRANZO');

  const justBeforeLunchBoundary = deriveNextServiceIdentity(new Date(madrid(17, 30).getTime() - 60000), DEFAULT_SCHEDULE);
  // language-guard: allow-legacy PRANZO/PRANZO_WINDOW are the existing service_kind enum value / SCHEDULE_STATE literal, exercised here verbatim, not new vocabulary
  assert('17:29 is still PRANZO_WINDOW', justBeforeLunchBoundary.shouldEnsure === true && justBeforeLunchBoundary.serviceKind === 'PRANZO');

  const atLunchBoundary = deriveNextServiceIdentity(madrid(17, 30), DEFAULT_SCHEDULE);
  assert('17:30 exactly is already the buffer (exclusive end for lunch)', atLunchBoundary.shouldEnsure === false);

  const atDinnerStart = deriveNextServiceIdentity(madrid(18, 0), DEFAULT_SCHEDULE);
  assert('18:00 exactly is already SERA_WINDOW (inclusive start)', atDinnerStart.shouldEnsure === true && atDinnerStart.serviceKind === 'SERA');

  const atRollover = deriveNextServiceIdentity(madrid(4, 0), DEFAULT_SCHEDULE);
  assert('04:00 exactly is already OUTSIDE_WINDOWS, today\'s date', atRollover.shouldEnsure === false && atRollover.businessDate === '2026-08-09');

  const justBeforeRollover = deriveNextServiceIdentity(new Date(madrid(4, 0).getTime() - 60000), DEFAULT_SCHEDULE);
  assert('03:59 is still AFTER_ORDER_CUTOFF, yesterday\'s date', justBeforeRollover.shouldEnsure === false && justBeforeRollover.businessDate === '2026-08-08');
}

console.log('\n── determinism — same input, same output ──');
{
  const t = madrid(13, 15);
  const r1 = deriveNextServiceIdentity(t, DEFAULT_SCHEDULE);
  const r2 = deriveNextServiceIdentity(t, DEFAULT_SCHEDULE);
  assert('two calls with the identical Date produce identical results', JSON.stringify(r1) === JSON.stringify(r2));
}

console.log('\n── defaults — no schedule argument uses DEFAULT_SCHEDULE ──');
{
  const withDefault = deriveNextServiceIdentity(madrid(12, 0));
  // language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised here verbatim, not new vocabulary
  assert('defaults to DEFAULT_SCHEDULE (PRANZO at noon)', withDefault.shouldEnsure === true && withDefault.serviceKind === 'PRANZO');
}

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
