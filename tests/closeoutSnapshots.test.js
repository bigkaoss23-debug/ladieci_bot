'use strict';
// SERVICE CLOSEOUT V2 / Slice 1 — behavioural contract test for
// src/closeout/closeoutSnapshots.js, against a fake rpc/select pair that
// reproduces the specific semantics written into
// migrations/2026-08-08_service_closeout_incidents_foundation.sql's
// capture_closeout_snapshot() (idempotent on closeout_correlation_id,
// business_date/service_kind derived server-side, never caller-trusted).
// True DB-level trigger enforcement (append-only) is verified separately,
// statically, in tests/serviceCloseoutIncidentsFoundation.static.test.js —
// this file cannot run real Postgres and does not claim to.

const { createCloseoutSnapshots } = require('../src/closeout/closeoutSnapshots');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

function fakeDb({ sessions = {} } = {}) {
  const rows = [];
  let nextId = 1;

  async function rpc(name, args) {
    if (name !== 'capture_closeout_snapshot') throw new Error('unexpected rpc ' + name);

    if (!args.p_service_session_id || !args.p_closeout_correlation_id) {
      return { ok: true, body: { ok: false, code: 'INVALID_ARGUMENTS' } };
    }
    if (!args.p_captured_by || !String(args.p_captured_by).trim()) {
      return { ok: true, body: { ok: false, code: 'INVALID_ACTOR' } };
    }
    if (!args.p_payload || typeof args.p_payload !== 'object' || Array.isArray(args.p_payload)) {
      return { ok: true, body: { ok: false, code: 'INVALID_SNAPSHOT_PAYLOAD' } };
    }
    const session = sessions[args.p_service_session_id];
    if (!session) return { ok: true, body: { ok: false, code: 'SERVICE_SESSION_NOT_FOUND' } };
    if (!session.service_kind) return { ok: true, body: { ok: false, code: 'SERVICE_SESSION_MISSING_KIND' } };

    const existing = rows.find((r) => r.closeout_correlation_id === args.p_closeout_correlation_id);
    if (existing) {
      if (existing.service_session_id !== args.p_service_session_id) {
        return { ok: true, body: { ok: false, code: 'CLOSEOUT_CORRELATION_ID_CONFLICT' } };
      }
      return { ok: true, body: { ok: true, code: 'ALREADY_CAPTURED', created: false, snapshot: existing } };
    }

    const row = Object.freeze({
      id: 'snap-' + nextId++,
      service_session_id: args.p_service_session_id,
      business_date: session.business_date,
      service_kind: session.service_kind,
      closeout_correlation_id: args.p_closeout_correlation_id,
      schema_version: args.p_schema_version || 1,
      captured_at: new Date(Date.now() + nextId).toISOString(),
      captured_by: args.p_captured_by,
      source: args.p_source,
      payload: args.p_payload,
      payload_sha256: args.p_payload_sha256 || null,
    });
    rows.push(row);
    return { ok: true, body: { ok: true, code: 'CAPTURED', created: true, snapshot: row } };
  }

  async function select(table, query) {
    if (table !== 'service_closeout_snapshots') throw new Error('unexpected table ' + table);
    const m = query.match(/service_session_id=eq\.([^&]+)/);
    const sid = m ? decodeURIComponent(m[1]) : null;
    return rows.filter((r) => r.service_session_id === sid).slice().sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1));
  }

  return { rpc, select, rows };
}

(async () => {
  console.log('\n== closeoutSnapshots.js — behavioural contract ==\n');

  const SESSIONS = {
    's1': { business_date: '2026-08-08', service_kind: 'PRANZO' },
    's2': { business_date: '2026-08-08', service_kind: 'SERA' },
    's3-no-kind': { business_date: '2026-08-08', service_kind: null },
  };

  console.log('\n── 1. create + fetch by service session ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const snapshots = createCloseoutSnapshots(db);
    const r = await snapshots.capture({
      serviceSessionId: 's1', capturedBy: 'system', source: 'manual_close',
      payload: { orders: [{ id: 'o1' }], anomalies: [] },
    });
    assert('1a: capture succeeds and is created:true', r.success === true && r.created === true, JSON.stringify(r));
    assert('1b: closeoutCorrelationId defaulted to serviceSessionId', r.snapshot.closeoutCorrelationId === 's1');
    assert('1c: payload round-trips unchanged', JSON.stringify(r.snapshot.payload) === JSON.stringify({ orders: [{ id: 'o1' }], anomalies: [] }));
    assert('1d: business_date/service_kind derived from the session, not the caller', r.snapshot.businessDate === '2026-08-08' && r.snapshot.serviceKind === 'PRANZO');

    const list = await snapshots.listBySession({ serviceSessionId: 's1' });
    assert('1e: queryable by service_session_id', list.length === 1 && list[0].id === r.snapshot.id, JSON.stringify(list));
  }

  console.log('\n── 2. retry/idempotency — same correlation id never duplicates ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const snapshots = createCloseoutSnapshots(db);
    const first = await snapshots.capture({ serviceSessionId: 's1', capturedBy: 'system', source: 'auto_close', payload: { n: 1 } });
    const retry = await snapshots.capture({ serviceSessionId: 's1', capturedBy: 'system', source: 'auto_close', payload: { n: 1 } });
    assert('2a: first attempt created:true', first.created === true);
    assert('2b: retry returns created:false', retry.success === true && retry.created === false && retry.code === 'ALREADY_CAPTURED', JSON.stringify(retry));
    assert('2c: retry returns the SAME snapshot id, no duplicate row', retry.snapshot.id === first.snapshot.id);
    assert('2d: exactly one row exists in the store', db.rows.length === 1, String(db.rows.length));
  }

  console.log('\n── 3. a correlation id reused across two DIFFERENT sessions is rejected, not merged ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const snapshots = createCloseoutSnapshots(db);
    await snapshots.capture({ serviceSessionId: 's1', closeoutCorrelationId: 'shared-id', capturedBy: 'system', source: 'x', payload: {} });
    const conflict = await snapshots.capture({ serviceSessionId: 's2', closeoutCorrelationId: 'shared-id', capturedBy: 'system', source: 'x', payload: {} });
    assert('3: cross-session correlation id conflict is a typed failure, not a silent merge', conflict.success === false && conflict.code === 'CLOSEOUT_CORRELATION_ID_CONFLICT', JSON.stringify(conflict));
  }

  console.log('\n── 4. immutability (structural — see the static test for the real DB-trigger proof) ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const snapshots = createCloseoutSnapshots(db);
    const r = await snapshots.capture({ serviceSessionId: 's1', capturedBy: 'system', source: 'x', payload: { totalCents: 6250 } });
    let threw = false;
    try { r.snapshot.payload = { totalCents: 0 }; } catch (_) { threw = true; }
    // publicSnapshot() returns a fresh object per call — mutating the returned
    // object must never be able to reach the stored row.
    const reread = await snapshots.listBySession({ serviceSessionId: 's1' });
    assert('4: mutating a returned snapshot object never changes what is stored', reread[0].payload.totalCents === 6250, JSON.stringify(reread[0]));
  }

  console.log('\n── 5. missing/invalid session is rejected, never silently captured against nothing ──');
  {
    const db = fakeDb({ sessions: SESSIONS });
    const snapshots = createCloseoutSnapshots(db);
    const missing = await snapshots.capture({ serviceSessionId: 'does-not-exist', capturedBy: 'system', source: 'x', payload: {} });
    assert('5a: unknown session -> SERVICE_SESSION_NOT_FOUND', missing.success === false && missing.code === 'SERVICE_SESSION_NOT_FOUND');
    const noKind = await snapshots.capture({ serviceSessionId: 's3-no-kind', capturedBy: 'system', source: 'x', payload: {} });
    assert('5b: session without a kind -> SERVICE_SESSION_MISSING_KIND', noKind.success === false && noKind.code === 'SERVICE_SESSION_MISSING_KIND');
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail === 0 ? 0 : 1);
})();
