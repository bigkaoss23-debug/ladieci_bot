'use strict';
// ===============================================================
// G-1 — THE OPERATIONAL CYCLE RESUMES BY ITSELF. Static (source-text) proof
// that the migration says exactly what it claims and nothing more:
//
//   * open_operational_service_v1 gains a THIRD reason and neither relaxes
//     first_open_of_business_day nor reuses explicit_reopen;
//   * resolve_order_intake_context_v1 stops refusing with REOPEN_REQUIRED and
//     routes both openings through the ONE canonical primitive;
//   * ensure_service_session stops calling the idle state an exception and
//     stays read-only;
//   * F-10, F-11 and the frozen Mesa first-seating guard are preserved, with
//     the Mesa bodies pinned by checksum before AND after;
//   * the JS seating path resolves the service through the canonical
//     authority and invents no rule of its own.
//
// Run: node --test tests/g1AutonomousResumeOperationalService.static.test.js
// ===============================================================

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const M = path.join(__dirname, '..', 'migrations', '2026-08-20_g1_autonomous_resume_operational_service.sql');
const R = path.join(__dirname, '..', 'migrations', '2026-08-20_g1_autonomous_resume_operational_service.ROLLBACK.sql');
const MESA_SERVICE = path.join(__dirname, '..', 'src', 'tables', 'mesaService.js');

const raw = (f) => fs.readFileSync(f, 'utf8');
// Executable SQL only. The headers legitimately NAME the refusal being
// removed ("REOPEN_REQUIRED"), so scanning raw text would flag the very
// documentation that explains the fix.
const sql = (f) => raw(f).split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');

const FWD = sql(M);
const RB = sql(R);
const FWD_RAW = raw(M);

// The exact pre-G-1 checksums this slice was written against.
const MD5 = Object.freeze({
  opener: '482e64e22b7f992fd018d02d72a5fc4e',
  resolve: '5aa2042a2a7248bccd5d6309ebc10b45',
  ensure: '7b090dd34016d3fa5741e942498e304f',
  mesaOpen: 'cdf15eb3699a6a86c16519b1dbcd2f1c',
  mesaReservation: '21f6d47a1e911f01933bd4b2e2d8558e',
});

// ── 1. shape ──────────────────────────────────────────────────────────────
test('1: the migration is one transaction and replaces exactly the three intended functions', () => {
  assert.match(FWD, /^\s*BEGIN;/m);
  assert.match(FWD, /COMMIT;\s*$/);
  for (const fn of ['open_operational_service_v1', 'resolve_order_intake_context_v1', 'ensure_service_session']) {
    const hits = FWD.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`, 'g')) || [];
    assert.equal(hits.length, 1, `${fn} is replaced exactly once`);
  }
  // Nothing else may be redefined, dropped, or re-granted by this slice.
  const created = [...FWD.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(created, ['ensure_service_session', 'open_operational_service_v1', 'resolve_order_intake_context_v1']);
  assert.doesNotMatch(FWD, /\bDROP\s+(FUNCTION|TABLE|TRIGGER|INDEX)\b/i);
  assert.doesNotMatch(FWD, /\b(GRANT|REVOKE)\b/i);
  assert.doesNotMatch(FWD, /\bALTER\s+TABLE\b/i);
});

test('2: it is DDL only — no product row is written, updated or deleted', () => {
  // Statements INSIDE the replaced function bodies are the functions' own
  // pre-existing logic; what must not appear is a top-level DML statement.
  const topLevel = FWD.split(/AS \$function\$[\s\S]*?\$function\$;/).join('\n');
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.(service_sessions|ordenes|business_days|payment_transactions)/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM\s+public\./i);
  assert.doesNotMatch(topLevel, /UPDATE\s+public\.(service_sessions|ordenes|business_days)/i);
});

// ── 2. pre-conditions: refuse over drift ──────────────────────────────────
test('3: it refuses unless the database is the exact one it was written against', () => {
  assert.match(FWD, /supabase_migrations\.schema_migrations WHERE version='20260710075612'/);
  assert.match(FWD, /max\(apply_order\) FROM public\.ladieci_schema_migrations\) <> 95/);
  for (const [name, sum] of Object.entries(MD5)) {
    assert.ok(FWD.includes(sum), `the ${name} checksum ${sum} is pinned in the forward migration`);
  }
});

test('4: F-10 is asserted present BEFORE the replaces, so the post-condition is not vacuous', () => {
  const pre = FWD.slice(0, FWD.indexOf('CREATE OR REPLACE FUNCTION public.open_operational_service_v1'));
  assert.match(pre, /FORGOTTEN_CLOSE_REQUIRED/);
  assert.match(pre, /G-1 refused: F-10 raise absent/);
});

// ── 3. PART 1 — the third reason ──────────────────────────────────────────
const openerBody = FWD.slice(
  FWD.indexOf('CREATE OR REPLACE FUNCTION public.open_operational_service_v1'),
  FWD.indexOf('CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1'),
);

test('5: the opener accepts exactly three reasons, the new one included', () => {
  assert.match(openerBody,
    /p_open_reason NOT IN \('first_open_of_business_day', 'next_service_of_business_day', 'explicit_reopen'\)/);
  assert.match(openerBody, /'INVALID_OPEN_REASON'/);
});

test('6: first_open_of_business_day is NOT relaxed — its has-any refusal is intact', () => {
  assert.match(openerBody,
    /IF p_open_reason = 'first_open_of_business_day' THEN\s*IF v_has_any THEN\s*RETURN jsonb_build_object\('ok', false, 'code', 'SERVICE_REOPEN_REQUIRED'\);/);
});

test('7: explicit_reopen is NOT reused — the subsequent-service branch still demands prior history', () => {
  assert.match(openerBody, /IF NOT v_has_any THEN\s*RETURN jsonb_build_object\('ok', false, 'code', 'NO_PRIOR_SERVICE_TO_REOPEN'\);/);
});

test('8: every other opener invariant survives verbatim', () => {
  for (const re of [
    /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/,
    /ACTIVE_SERVICE_BUSINESS_DAY_MISMATCH/,
    /'code', 'REUSED'/,
    /'operational_service_v1'/,
    /OPEN_OPERATIONAL_SERVICE_BUSINESS_DAY_DERIVE_MISMATCH/,
    /OPEN_OPERATIONAL_SERVICE_POINTER_MISMATCH/,
    /OPEN_OPERATIONAL_SERVICE_SHADOW_MISMATCH/,
    /service_session_audit/,
  ]) assert.match(openerBody, re);
  // The new era never carries a lunch/dinner identity: the insert still pins
  // service_kind to NULL, which the table's own CHECK also enforces.
  assert.match(openerBody, /VALUES \(\s*v_day\.business_date, 'open', p_opened_by, p_source, NULL, 'operational_service_v1'\s*\)/);
});

// ── 4. PART 2 — resume instead of refuse ──────────────────────────────────
const resolveBody = FWD.slice(
  FWD.indexOf('CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1'),
  FWD.indexOf('CREATE OR REPLACE FUNCTION public.ensure_service_session'),
);

test('9: the resolver no longer refuses with REOPEN_REQUIRED anywhere', () => {
  assert.doesNotMatch(resolveBody, /REOPEN_REQUIRED/);
});

test('10: it selects between the two openings and delegates both to the ONE canonical primitive', () => {
  assert.match(resolveBody, /v_open_reason := 'next_service_of_business_day';/);
  assert.match(resolveBody, /v_open_reason := 'first_open_of_business_day';/);
  // Exactly one call site, taking the chosen reason — never two divergent calls.
  const calls = resolveBody.match(/public\.open_operational_service_v1\(/g) || [];
  assert.equal(calls.length, 1, 'a single delegation, parameterised by the reason');
  assert.match(resolveBody, /public\.open_operational_service_v1\(\s*COALESCE\(p_actor, 'system'\), v_open_reason, v_open_source\s*\)/);
});

test('11: the resume is durably distinguishable in open_source, and first-open sources are unchanged', () => {
  assert.match(resolveBody, /v_open_source := COALESCE\(p_source, 'order_intake'\) \|\| '_next_service';/);
  assert.match(resolveBody, /v_open_source := COALESCE\(p_source, 'order_intake'\);/);
});

test('12: F-10 is preserved exactly — same code, same SQLSTATE, same DETAIL payload', () => {
  assert.match(resolveBody,
    /IF v_period\.lifecycle_semantics = 'operational_service_v1' THEN\s*RAISE EXCEPTION 'FORGOTTEN_CLOSE_REQUIRED'\s*USING ERRCODE = 'P0001', DETAIL = v_period\.id::text;/);
});

test('13: every other resolver invariant survives', () => {
  for (const re of [
    /ORDER_INTAKE_CLOSED/,                                   // the intake window
    /v_can_create_order := \(v_minutes_of_day >= 480 AND v_minutes_of_day < 1050\)\s*OR \(v_minutes_of_day >= 1080\)/,
    /pg_advisory_xact_lock\(hashtext\('service_session_lifecycle'\)\)/,
    /INSERT INTO public\.business_days/,                     // Business Day creation
    /SET current_business_day_id = v_day\.id/,               // pointer advance, BEFORE the open
    /status = 'rolled_over'/,                                // legacy-era rollover
    /BUSINESS_DAY_POINTER_MISMATCH/,
    /TICKET_EPOCH_MIRROR_MISMATCH/,
    /BUSINESS_DAY_UNRESOLVED/,
  ]) assert.match(resolveBody, re);
});

test('14: the pointer is still written BEFORE the primitive is called — the primitive trusts it as sole authority', () => {
  const pointerAt = resolveBody.indexOf('SET current_business_day_id = v_day.id');
  const openAt = resolveBody.indexOf('public.open_operational_service_v1(');
  assert.ok(pointerAt > -1 && openAt > -1 && pointerAt < openAt,
    'the canonical Business Day pointer write precedes the opening call');
});

test('15: the resolver still never creates a service_sessions row itself', () => {
  assert.doesNotMatch(resolveBody, /INSERT\s+INTO\s+public\.service_sessions/i);
});

// ── 5. PART 3 — idle is not an exception ──────────────────────────────────
const ensureBody = FWD.slice(FWD.indexOf('CREATE OR REPLACE FUNCTION public.ensure_service_session'));

test('16: ensure_service_session no longer answers REOPEN_REQUIRED', () => {
  const body = ensureBody.slice(0, ensureBody.indexOf('DO $$'));
  assert.doesNotMatch(body, /REOPEN_REQUIRED/);
});

test('17: the same-day-with-history state is NO_OPEN_SERVICE plus one additive diagnostic key', () => {
  assert.match(ensureBody,
    /RETURN jsonb_build_object\('ok', false, 'code', 'NO_OPEN_SERVICE',\s*'businessDayId', v_bd_state\.current_business_day_id,\s*'businessDate', v_pointer_business_date,\s*'hadPriorServiceToday', true\)/);
});

test('18: F-11 stale-Business-Day classification is preserved verbatim', () => {
  assert.match(ensureBody, /v_canonical_business_date :=\s*NULLIF\(public\.get_order_intake_context_v1\(\) ->> 'businessDate', ''\)::date;/);
  assert.match(ensureBody, /'staleBusinessDay', true,\s*'currentBusinessDate', v_canonical_business_date/);
  // The downgrade still fires ONLY on positive evidence of staleness.
  assert.match(ensureBody,
    /IF v_pointer_business_date IS NOT NULL\s*AND v_canonical_business_date IS NOT NULL\s*AND v_pointer_business_date <> v_canonical_business_date/);
});

test('19: ensure_service_session remains incapable of writing anything', () => {
  const body = ensureBody.slice(0, ensureBody.indexOf('DO $$'));
  assert.doesNotMatch(body, /INSERT INTO/i);
  assert.doesNotMatch(body, /UPDATE\s+public\./i);
  assert.doesNotMatch(body, /DELETE FROM/i);
  // ...and the migration asserts it too, not just this test.
  assert.match(FWD, /ensure_service_session must remain non-mutating/);
});

// ── 6. post-conditions ────────────────────────────────────────────────────
test('20: the migration proves its own claims before committing', () => {
  const post = FWD.slice(FWD.lastIndexOf('DO $$'));
  for (const re of [
    /the new open reason is absent from open_operational_service_v1/,
    /explicit_reopen was dropped/,
    /the first_open_of_business_day guard was weakened or removed/,
    /still refuses with REOPEN_REQUIRED/,
    /F-10 forgotten-close raise is missing or altered/,
    /F-11 stale-Business-Day classification is missing or altered/,
    /the frozen Mesa first-seating guard bodies changed/,
    /creation surface is % functions \(expected exactly 3\)/,
  ]) assert.match(post, re);
});

test('21: the frozen Mesa guard is checksum-pinned on BOTH sides of the replaces', () => {
  const firstMesa = FWD.indexOf(MD5.mesaOpen);
  const lastMesa = FWD.lastIndexOf(MD5.mesaOpen);
  const firstReplace = FWD.indexOf('CREATE OR REPLACE FUNCTION');
  assert.ok(firstMesa > -1 && firstMesa < firstReplace, 'pinned before any replace runs');
  assert.ok(lastMesa > firstReplace, 'and re-pinned after every replace');
  assert.ok(FWD.includes(MD5.mesaReservation), 'the reservation primitive is pinned too');
  // Neither Mesa function may be redefined here.
  assert.doesNotMatch(FWD, /CREATE OR REPLACE FUNCTION public\.mesa_open_(session|reservation)_v1/);
});

// ── 7. rollback ───────────────────────────────────────────────────────────
test('22: the rollback restores all three bodies byte-identically and proves it', () => {
  for (const fn of ['open_operational_service_v1', 'resolve_order_intake_context_v1', 'ensure_service_session']) {
    assert.match(RB, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
  }
  for (const sum of [MD5.opener, MD5.resolve, MD5.ensure]) {
    assert.ok(RB.includes(sum), `the rollback asserts the restored checksum ${sum}`);
  }
  assert.match(RB, /was not restored byte-identically/);
});

test('23: the rollback re-installs the pre-G-1 refusals (it is a true inverse, not a partial one)', () => {
  const rbResolve = RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1'),
                             RB.indexOf('CREATE OR REPLACE FUNCTION public.ensure_service_session'));
  assert.match(rbResolve, /'code', 'REOPEN_REQUIRED'/);
  assert.match(rbResolve, /'first_open_of_business_day'/);
  assert.doesNotMatch(rbResolve, /next_service_of_business_day/);

  const rbOpener = RB.slice(RB.indexOf('CREATE OR REPLACE FUNCTION public.open_operational_service_v1'),
                            RB.indexOf('CREATE OR REPLACE FUNCTION public.resolve_order_intake_context_v1'));
  assert.match(rbOpener, /p_open_reason NOT IN \('first_open_of_business_day', 'explicit_reopen'\)/);
});

test('24: the rollback refuses on a database that never had G-1, and never touches product rows', () => {
  assert.match(RB, /G-1 rollback refused: G-1 does not appear to be applied/);
  assert.match(RB, /supabase_migrations\.schema_migrations WHERE version='20260710075612'/);
  const topLevel = RB.split(/AS \$function\$[\s\S]*?\$function\$;/).join('\n');
  assert.doesNotMatch(topLevel, /INSERT\s+INTO\s+public\.service_sessions/i);
  assert.doesNotMatch(topLevel, /UPDATE\s+public\.service_sessions/i);
  assert.doesNotMatch(topLevel, /DELETE\s+FROM/i);
  // It surfaces, rather than silently undoing, the services the resume opened.
  assert.match(RB, /open_source LIKE/);
});

test('25: the rollback re-pins the frozen Mesa guard as well', () => {
  assert.ok(RB.includes(MD5.mesaOpen) && RB.includes(MD5.mesaReservation));
  assert.doesNotMatch(RB, /CREATE OR REPLACE FUNCTION public\.mesa_open_(session|reservation)_v1/);
});

// ── 8. the JS seating path ────────────────────────────────────────────────
const MESA = fs.readFileSync(MESA_SERVICE, 'utf8');

test('26: seating resolves the service through the canonical authority when nothing is open', () => {
  assert.match(MESA, /const resolved = await lifecycle\.resolveOperationalContext\(\{ actor, source \}\);/);
  assert.match(MESA, /typeof resolved\.periodId !== 'string'/);
  assert.match(MESA, /throw new MesaServiceError\('MESA_SERVICE_NOT_OPEN', 409\)/);
  // The seat is pinned to the resolver's verdict, never to a re-read pointer.
  assert.match(MESA, /return await seat\(serviceSessionId\);/);
});

// Scoped to the seating helper itself: the rest of the file legitimately
// formats a Madrid wall-clock time for an order's `hora` display, which is a
// presentation value and not a lifecycle rule.
const SEAT_HELPER = MESA.slice(
  MESA.indexOf('async function seatWithStaleServiceRecovery('),
  MESA.indexOf('return Object.freeze({'),
);

test('27: the seating path still invents no lifecycle rule of its own', () => {
  assert.ok(SEAT_HELPER.length > 0, 'the seating helper was located');
  // It never opens a service itself: it asks the canonical resolver.
  assert.doesNotMatch(SEAT_HELPER, /open_operational_service_v1|openOperational\(/);
  // No clock, no calendar, no business-date arithmetic of its own.
  assert.doesNotMatch(SEAT_HELPER, /new Date\(|Date\.now\(|Europe\/Madrid|CURRENT_DATE|businessDate/);
  // No second staleness verdict: the DB decides, this only reacts.
  assert.doesNotMatch(SEAT_HELPER, /business_date|stale\s*=|isStale/);
  // And Mesa never reaches the close engine directly (F-8's invariant).
  assert.doesNotMatch(MESA, /serviceLifecycleEngine/);
});

test('28: both seating entry points share the one path — table and reservation alike', () => {
  // One declaration, exactly two call sites: nothing seats around it.
  const declarations = MESA.match(/async function seatWithStaleServiceRecovery\(/g) || [];
  const callSites = MESA.match(/return seatWithStaleServiceRecovery\(\{/g) || [];
  assert.equal(declarations.length, 1, 'exactly one seating helper');
  assert.equal(callSites.length, 2, 'open() and openReservation() both go through it');
  assert.match(MESA, /seat: \(serviceSessionId\) => dao\.openSession\(\{/);
  assert.match(MESA, /seat: \(serviceSessionId\) => dao\.openReservation\(\{/);
  // Neither entry point may call the DAO seat primitives directly.
  const directOpen = MESA.match(/^\s*(await\s+)?dao\.openSession\(/gm) || [];
  const directResv = MESA.match(/^\s*(await\s+)?dao\.openReservation\(/gm) || [];
  assert.equal(directOpen.length + directResv.length, 0, 'no seating bypasses the helper');
});

test('29: the frozen stale-service recovery budget is untouched — one recovery, one retry', () => {
  assert.match(MESA, /parseForgottenCloseRequired\(error && error\.pgError\)/);
  assert.match(MESA, /if \(!forgotten\) throw error;/);
  assert.match(MESA, /MESA_SERVICE_STALE_UNRESOLVED/);
  const recoveries = MESA.match(/recoverForgottenService\(\{/g) || [];
  assert.equal(recoveries.length, 1, 'still exactly one recovery call site');
});

// ── 8b. PROSRC REALITY CHECK ──────────────────────────────────────────────
// Every other assertion in this file reads comment-stripped SQL, which is the
// right lens for "what does the code do". The migration's own post-conditions
// do NOT: they scan pg_proc.prosrc, and prosrc keeps the comments. A body
// comment that merely NAMES a retired code therefore trips an
// absence-post-condition and makes the whole migration refuse itself.
//
// That is not hypothetical: the first real apply of this migration failed on
// exactly that, because the resolver and ensure bodies documented the
// REOPEN_REQUIRED refusal they replace. The DB caught it and rolled back. This
// section is the cheap gate that catches it before the DB has to.
const RAW_BODIES = (() => {
  const out = {};
  const names = ['open_operational_service_v1', 'resolve_order_intake_context_v1', 'ensure_service_session'];
  const re = /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$;/g;
  let m;
  while ((m = re.exec(FWD_RAW))) if (names.includes(m[1])) out[m[1]] = m[2];
  return out;
})();

test('31: all three bodies were located for the prosrc check', () => {
  assert.equal(Object.keys(RAW_BODIES).length, 3, Object.keys(RAW_BODIES).join(','));
  for (const [n, b] of Object.entries(RAW_BODIES)) assert.ok(b.length > 500, `${n} body looks truncated`);
});

test('32: prosrc absence post-conditions hold on the REAL bodies, comments included', () => {
  // resolve_order_intake_context_v1: the migration refuses if prosrc still
  // mentions the retired refusal ANYWHERE, code or comment.
  assert.doesNotMatch(RAW_BODIES.resolve_order_intake_context_v1, /REOPEN_REQUIRED/,
    'the resolver body (incl. comments) must not name the retired code — the migration post-condition scans prosrc');
  assert.doesNotMatch(RAW_BODIES.resolve_order_intake_context_v1, /INSERT\s+INTO\s+public\.service_sessions/i);

  // ensure_service_session: same, plus it must stay non-mutating by the same
  // comment-inclusive scan the migration performs.
  assert.doesNotMatch(RAW_BODIES.ensure_service_session, /REOPEN_REQUIRED/,
    'the ensure body (incl. comments) must not name the retired code');
  assert.doesNotMatch(RAW_BODIES.ensure_service_session, /INSERT INTO/i);
  assert.doesNotMatch(RAW_BODIES.ensure_service_session, /UPDATE\s+public\./i);
  assert.doesNotMatch(RAW_BODIES.ensure_service_session, /DELETE FROM/i);
});

test('33: prosrc presence post-conditions hold on the REAL bodies too', () => {
  const o = RAW_BODIES.open_operational_service_v1;
  assert.match(o, /next_service_of_business_day/);
  assert.match(o, /explicit_reopen/);
  assert.match(o, /SERVICE_REOPEN_REQUIRED/);
  assert.match(o, /NO_PRIOR_SERVICE_TO_REOPEN/);
  assert.match(o, /IF p_open_reason = 'first_open_of_business_day' THEN/);

  const r = RAW_BODIES.resolve_order_intake_context_v1;
  for (const re of [/next_service_of_business_day/, /first_open_of_business_day/, /FORGOTTEN_CLOSE_REQUIRED/,
                    /DETAIL = v_period\.id::text/, /'rolled_over'/, /BUSINESS_DAY_POINTER_MISMATCH/,
                    /TICKET_EPOCH_MIRROR_MISMATCH/, /ORDER_INTAKE_CLOSED/]) assert.match(r, re);

  const e = RAW_BODIES.ensure_service_session;
  for (const re of [/hadPriorServiceToday/, /staleBusinessDay/, /currentBusinessDate/,
                    /get_order_intake_context_v1/]) assert.match(e, re);
});

// ── 9. the header must not oversell ───────────────────────────────────────
test('30: the migration documents what it does NOT touch', () => {
  for (const re of [/F-10/, /F-11/, /Mesa first-seating/, /single_active_uq/]) {
    assert.match(FWD_RAW, re);
  }
});
