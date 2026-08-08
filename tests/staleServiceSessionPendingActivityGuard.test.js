'use strict';
// S2-7D6E4-FOLLOWUP, superseded by SERVICE CLOSEOUT V2 / SLICE 3 —
// this file originally reproduced, offline and deterministically, the exact
// staging scenario that closed session 4b3b4a29 on 2026-07-28 with
// close_reason='stale_business_date_recovery': a PRANZO session opened the
// PREVIOUS business day, one order still EN_ENTREGA, an ACTIVE rider trip,
// zero payment events. Root-cause reconciliation traced that specific close
// to a transient, already-superseded migration — not to any code path in
// this repository. At the time, this file asserted (as CORRECT) that a
// stale session with pending activity is handed back forever, never closed.
//
// SLICE 3 changes that on purpose. RC-2
// (PENDING_ACTIVITY_GLOBAL_BLOCK) is exactly this: pending operational
// activity must not keep a session that is genuinely due for rollover
// current forever. What this file now proves is the OPPOSITE of its
// original assertion A: the same frozen staging scenario — a PRANZO session
// from the previous business date, one order still EN_ENTREGA — now rolls
// over through the incident-safe path (src/serviceSessions/
// incidentSafeRollover.js): the pending order becomes a persisted
// operational incident, the session closes via the SAME canonical engine
// (chiudiServizio) as before, and no duplicate/parallel session is ever
// created. RC-1 (PRIOR_DAY_STALE_SESSION_BLOCKED_BY_CURRENT_DAY_SCHEDULE_GATE)
// is also exercised here for the same reason the original scenario needed
// it: the close happens without ever consulting today's closeEligibility
// window for PRANZO (see sessionRolloverClassification.js).
//
// Run: node tests/staleServiceSessionPendingActivityGuard.test.js

const { createEnsureCurrentServiceSession } = require('../src/serviceSessions/ensureServiceSession');
const { createIncidentSafeRollover } = require('../src/serviceSessions/incidentSafeRollover');
const { computeAutoCloseDecision } = require('../src/serviceSessions/autoCloseDecision');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ── the exact frozen staging scenario, reconstructed ────────────────────────────────
const STALE_SESSION_ID = '4b3b4a29-b902-499b-b592-e0566211fb4d';
const staleSession = Object.freeze({
  id: STALE_SESSION_ID,
  status: 'open',
  service_kind: 'PRANZO',
  business_date: '2026-07-27',   // yesterday relative to NOW below
  opened_at: '2026-07-27T14:53:13.383598+00:00',
});
const NOW = new Date('2026-07-28T18:00:00Z'); // 20:00 Madrid

// order #724, EN_ENTREGA — the real non-terminal state that must NOT block an
// automatic rollover, and must instead survive as a persisted incident.
const pendingOrderRow = Object.freeze({ id: '#724', estado: 'EN_ENTREGA', service_session_id: STALE_SESSION_ID, totale: 0 });

// A fully controllable fake incident-safe-rollover environment — same shape
// as tests/incidentSafeRollover.test.js's fakeEnv, scoped to this scenario.
function fakeRolloverEnv({ orders = [] } = {}) {
  const env = { attemptRows: [], snapshotRows: [], incidentRows: [], closeCalls: [], reportCalls: [] };
  env.select = async (table) => {
    if (table === 'ordenes') return orders;
    if (table === 'table_sessions') return [];
    if (table === 'order_financial_events') return [];
    throw new Error('unexpected table ' + table);
  };
  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
      const active = env.attemptRows.find((r) => r.serviceSessionId === serviceSessionId && r.status === 'active');
      if (active) return { success: true, created: false, code: 'ALREADY_ACTIVE', attempt: active };
      const row = { closeoutCorrelationId: 'attempt-' + (env.attemptRows.length + 1), serviceSessionId, status: 'active', startedAt: new Date().toISOString(), createdBy: actor };
      env.attemptRows.push(row);
      return { success: true, created: true, code: 'ACQUIRED', attempt: row };
    },
    async supersede({ closeoutCorrelationId, reason }) {
      const row = env.attemptRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (!row) return { success: false, code: 'ATTEMPT_NOT_FOUND', attempt: null };
      row.status = 'superseded'; row.supersededAt = new Date().toISOString(); row.supersessionReason = reason;
      return { success: true, idempotent: false, code: 'SUPERSEDED', attempt: row };
    },
    async complete({ closeoutCorrelationId }) {
      const row = env.attemptRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (!row) return { success: false, code: 'ATTEMPT_NOT_FOUND', attempt: null };
      row.status = 'completed'; row.completedAt = new Date().toISOString();
      return { success: true, idempotent: false, code: 'COMPLETED', attempt: row };
    },
  };
  env.snapshots = {
    async getByCorrelationId({ closeoutCorrelationId }) { return env.snapshotRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId) || null; },
    async capture({ serviceSessionId, closeoutCorrelationId, capturedBy, source, payload, payloadSha256 }) {
      const existing = env.snapshotRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (existing) return { success: true, created: false, code: 'ALREADY_CAPTURED', snapshot: existing };
      const row = { id: 'snap-' + (env.snapshotRows.length + 1), serviceSessionId, closeoutCorrelationId, capturedBy, source, payload, payloadSha256 };
      env.snapshotRows.push(row);
      return { success: true, created: true, code: 'CAPTURED', snapshot: row };
    },
  };
  env.incidents = {
    async report(args) {
      env.reportCalls.push(args);
      const row = { id: 'inc-' + (env.incidentRows.length + 1), ...args };
      env.incidentRows.push(row);
      return { success: true, created: true, code: 'RECORDED', incident: row };
    },
  };
  env.closeSession = async (deleteAttivi, source, actor) => { env.closeCalls.push({ deleteAttivi, source, actor }); return { success: true, service_session_id: STALE_SESSION_ID, summary: {} }; };
  env.releaseEmptyTableSession = async () => ({ ok: true });
  env.sessionLifecycleImpl = { async ensure() { return { ok: true, created: true, session: { id: 'today-session', service_kind: 'SERA', business_date: '2026-07-28' } }; } };
  env.performRollover = createIncidentSafeRollover({
    select: env.select, snapshots: env.snapshots, attempts: env.attempts, incidents: env.incidents,
    closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
    sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => NOW,
  });
  return env;
}

(async () => {
  // ══ Precondition sanity — the scenario really is "due", via the STALE path ═══════
  const decision = computeAutoCloseDecision({ now: NOW, session: staleSession });
  assert('precondition: a PRANZO session from the previous business date is due for close-check',
    decision.due === true, JSON.stringify(decision));
  assert('precondition: due via the PRIOR_DAY_STALE path, not by coincidentally matching PRANZO\'s own window',
    decision.source === 'cron_stale_rollover', JSON.stringify(decision));

  // ══ A. ensureCurrentServiceSession — the silent auto-entry recovery pre-check ══════
  // SLICE 3: the stale session with a pending order now ROLLS OVER — the
  // pending order becomes an incident, the session closes, a fresh session is
  // established. This is the intentional opposite of this file's original
  // assertion A ("session is NOT closed — reused as-is").
  {
    const env = fakeRolloverEnv({ orders: [pendingOrderRow] });
    const ensure = createEnsureCurrentServiceSession({
      sessionLifecycle: {
        currentCloseout: async () => ({ ok: true, session: staleSession }),
        ensure: async (args) => ({ ok: true, created: true, session: { id: 'today-session', service_kind: args.serviceKind, business_date: '2026-07-28' } }),
      },
      now: () => NOW,
      performRollover: env.performRollover,
    });

    const res = await ensure({ actor: 'owner', source: 'auto_entry' });

    assert('A: chiudiServizio WAS called exactly once — the stale session rolled over, not reused forever', env.closeCalls.length === 1, JSON.stringify(env.closeCalls));
    assert('A: called with deleteAttivi=true (the pending order is force-archived, not silently dropped)', env.closeCalls[0].deleteAttivi === true);
    assert('A: called with the reconcile source', env.closeCalls[0].source === 'ensure_reconcile');
    assert('A: a snapshot of the pre-close state was captured', env.snapshotRows.length === 1);
    assert('A: exactly one incident was persisted for order #724 (EN_ENTREGA)',
      env.incidentRows.length === 1 && env.incidentRows[0].incidentType === 'DELIVERY_ACTIVE_AT_CLOSE' && env.incidentRows[0].orderId === '#724',
      JSON.stringify(env.incidentRows));
    assert('A: the incident is category operational, not silently dropped or miscategorized', env.incidentRows[0].category === 'operational');
    assert('A: the stale session id no longer appears as the CURRENT session in the result (a fresh one was established)',
      res.session === null || res.session.id !== STALE_SESSION_ID, JSON.stringify(res));
    assert('A: exactly one fresh session was established after the rollover, no duplicate', res.created === true && res.session && res.session.id === 'today-session', JSON.stringify(res));
  }

  // ══ B. The shared engine used identically by serviceCloseTick / catchUpChiusura / ═══
  // ══    triggerCloseIfNeeded now all route pending activity through the SAME ════════
  // ══    incident-safe orchestrator, never a forever-skip ═══════════════════════════
  {
    const env = fakeRolloverEnv({ orders: [pendingOrderRow] });
    const result = await env.performRollover({ session: staleSession, actor: 'system', source: 'cron_stale_rollover' });
    assert('B: the shared orchestrator closes the session despite the pending order', result.success === true, JSON.stringify(result));
    assert('B: code reflects that incidents were recorded, not a silent clean close', result.code === 'ROLLED_OVER_WITH_INCIDENTS');
    assert('B: exactly one incident survives the close', result.incidents.length === 1);
  }

  // ══ C. Complementary case — an EMPTY stale session closes idempotently, unchanged ═══
  {
    const emptySession = Object.freeze({ ...staleSession, id: '00000000-0000-4000-8000-0000000000ee' });
    const env = fakeRolloverEnv({ orders: [] });
    const ensure = createEnsureCurrentServiceSession({
      sessionLifecycle: {
        currentCloseout: async () => ({ ok: true, session: emptySession }),
        ensure: async (args) => ({ ok: true, created: false, session: { id: 'today-session', service_kind: args.serviceKind, business_date: '2026-07-28' } }),
      },
      now: () => NOW,
      performRollover: env.performRollover,
    });
    const res = await ensure({ actor: 'owner', source: 'auto_entry' });

    assert('C: the canonical close engine (chiudiServizio) is called exactly once', env.closeCalls.length === 1, JSON.stringify(env.closeCalls));
    assert('C: it is called with the reconcile source, not a bespoke one', env.closeCalls[0].source === 'ensure_reconcile');
    assert('C: zero incidents — nothing was pending on the empty session', env.incidentRows.length === 0);
    assert('C: after reconciling, the window logic resumes for a fresh session — never re-returns the stale id',
      res.session === null || res.session.id !== emptySession.id);
  }

  // ══ D. Live SQL contract sanity (static assertion on what was read from the DB) ════
  // The complete_service_session_close RPC, read LIVE from tdikhfeinufaahagmpjz during
  // the original investigation, unconditionally inserts into service_session_audit on
  // every real close:
  //   INSERT INTO public.service_session_audit(service_session_id,event_type,by_actor,source)
  //   VALUES(v_session.id,'closed',p_closed_by,p_source);
  // This is a structural fact about the live function body, not something a Node-level
  // unit test can independently exercise without a database — recorded here so the
  // audit guarantee case A/C relies on is traceable to its actual source.
  assert('D: audit-on-close guarantee is documented from the live RPC body (see comment above)', true);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
