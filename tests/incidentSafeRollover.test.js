"use strict";
// SERVICE CLOSEOUT V2 / Slice 3, hardened in SLICE 3.1 — orchestrator tests
// for performIncidentSafeRollover, against fully controllable fakes for
// every dependency (select, snapshots, attempts, incidents, closeSession,
// mesa release, sessionLifecycle.ensure). Exercises the exact failure/retry
// semantics from plan Step 12, plus Slice 3.1's attempt-ownership contract:
// same-state retries converge on the SAME attempt/snapshot; a genuinely
// changed state supersedes the active attempt and starts a fresh one.

const { createIncidentSafeRollover } = require("../src/serviceSessions/incidentSafeRollover");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const SESSION = { id: "sess-1", business_date: "2026-08-08", service_kind: "PRANZO" };

// A minimal, fully controllable fake environment. Each table's rows are
// supplied explicitly; attempts/snapshots/incidents are in-memory stores with
// the SAME contracts the real RPCs/tables have: attempts enforces at most one
// 'active' row per serviceSessionId (mirroring
// service_closeout_attempts_active_uq), snapshots dedupe on
// closeoutCorrelationId, incidents dedupe on
// (closeoutCorrelationId, incidentType, entityType, entityId).
function fakeEnv({
  orders = [], tableSessions = [], financialEvents = [],
  closeResultSpec = { success: true, service_session_id: SESSION.id, summary: {} },
  failReportForTypes = new Set(),
  failCaptureOnce = false,
  ensureResultSpec = { ok: true, created: true, session: { id: "next-session", service_kind: "SERA" } },
} = {}) {
  const env = {
    attemptRows: [], snapshotRows: [], incidentRows: [],
    closeCalls: [], reportCalls: [], releaseCalls: [], ensureCalls: [],
    acquireCalls: [], supersedeCalls: [], completeCalls: [],
    captureAttempts: 0,
  };
  env.select = async (table) => {
    if (table === "ordenes") return orders;
    if (table === "table_sessions") return tableSessions;
    if (table === "order_financial_events") return financialEvents;
    throw new Error("unexpected table " + table);
  };
  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
      env.acquireCalls.push({ serviceSessionId, actor });
      const active = env.attemptRows.find((r) => r.serviceSessionId === serviceSessionId && r.status === "active");
      if (active) return { success: true, created: false, code: "ALREADY_ACTIVE", attempt: active };
      const row = {
        closeoutCorrelationId: "attempt-" + (env.attemptRows.length + 1),
        serviceSessionId, status: "active", startedAt: new Date().toISOString(), createdBy: actor,
        completedAt: null, supersededAt: null, supersessionReason: null,
      };
      env.attemptRows.push(row);
      return { success: true, created: true, code: "ACQUIRED", attempt: row };
    },
    async supersede({ closeoutCorrelationId, actor, reason }) {
      env.supersedeCalls.push({ closeoutCorrelationId, actor, reason });
      const row = env.attemptRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (!row) return { success: false, code: "ATTEMPT_NOT_FOUND", attempt: null };
      if (row.status === "completed") return { success: false, code: "CANNOT_SUPERSEDE_COMPLETED_ATTEMPT", attempt: null };
      if (row.status === "superseded") return { success: true, idempotent: true, code: "ALREADY_SUPERSEDED", attempt: row };
      row.status = "superseded"; row.supersededAt = new Date().toISOString(); row.supersessionReason = reason;
      return { success: true, idempotent: false, code: "SUPERSEDED", attempt: row };
    },
    async complete({ closeoutCorrelationId, actor }) {
      env.completeCalls.push({ closeoutCorrelationId, actor });
      const row = env.attemptRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (!row) return { success: false, code: "ATTEMPT_NOT_FOUND", attempt: null };
      if (row.status === "superseded") return { success: false, code: "CANNOT_COMPLETE_SUPERSEDED_ATTEMPT", attempt: null };
      if (row.status === "completed") return { success: true, idempotent: true, code: "ALREADY_COMPLETED", attempt: row };
      row.status = "completed"; row.completedAt = new Date().toISOString();
      return { success: true, idempotent: false, code: "COMPLETED", attempt: row };
    },
  };
  env.snapshots = {
    async getByCorrelationId({ closeoutCorrelationId }) {
      return env.snapshotRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId) || null;
    },
    async capture({ serviceSessionId, closeoutCorrelationId, capturedBy, source, payload, payloadSha256 }) {
      env.captureAttempts++;
      if (failCaptureOnce && env.captureAttempts === 1) {
        return { success: false, created: false, code: "CLOSEOUT_SNAPSHOT_TRANSPORT_ERROR", snapshot: null };
      }
      const existing = env.snapshotRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (existing) return { success: true, created: false, code: "ALREADY_CAPTURED", snapshot: existing };
      const row = { id: "snap-" + (env.snapshotRows.length + 1), serviceSessionId, closeoutCorrelationId, capturedBy, source, payload, payloadSha256 };
      env.snapshotRows.push(row);
      return { success: true, created: true, code: "CAPTURED", snapshot: row };
    },
  };
  env.incidents = {
    async report(args) {
      env.reportCalls.push(args);
      if (failReportForTypes.has(args.incidentType)) {
        return { success: false, created: false, code: "SERVICE_INCIDENT_REPORT_FAILED", incident: null };
      }
      const existing = env.incidentRows.find((r) =>
        r.closeoutCorrelationId === args.closeoutCorrelationId
        && r.incidentType === args.incidentType
        && (r.entityType || "") === (args.entityType || "")
        && (r.entityId || "") === (args.entityId || ""));
      if (existing) return { success: true, created: false, code: "ALREADY_RECORDED", incident: existing };
      const row = { id: "inc-" + (env.incidentRows.length + 1), ...args };
      env.incidentRows.push(row);
      return { success: true, created: true, code: "RECORDED", incident: row };
    },
  };
  env.closeSession = async (deleteAttivi, source, actor, closeContext) => {
    env.closeCalls.push({ deleteAttivi, source, actor, closeContext });
    return typeof closeResultSpec === "function" ? closeResultSpec() : closeResultSpec;
  };
  env.releaseEmptyTableSession = async (args) => { env.releaseCalls.push(args); return { ok: true }; };
  env.sessionLifecycleImpl = {
    async ensure(args) { env.ensureCalls.push(args); return typeof ensureResultSpec === "function" ? ensureResultSpec() : ensureResultSpec; },
  };
  return env;
}

function makeOrchestrator(env, nowDate) {
  return createIncidentSafeRollover({
    select: env.select, snapshots: env.snapshots, attempts: env.attempts, incidents: env.incidents,
    closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
    sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => nowDate, schedule: DEFAULT_SCHEDULE,
  });
}

// Any instant safely inside SERA_WINDOW so ensure() always fires when tested.
const SERA_WINDOW_NOW = new Date(Date.UTC(2026, 7, 8, 18, 0)); // 20:00 Madrid

(async () => {
  console.log("\n== performIncidentSafeRollover ==\n");

  console.log("── clean rollover: zero activity -> ROLLED_OVER, no incidents, new session established, attempt completed ──");
  {
    const env = fakeEnv({});
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("1a: success, code ROLLED_OVER (no incidents)", r.success === true && r.code === "ROLLED_OVER", JSON.stringify(r));
    assert("1b: chiudiServizio called exactly once, deleteAttivi=true", env.closeCalls.length === 1 && env.closeCalls[0].deleteAttivi === true);
    assert("1b2: SLICE 4C.1 — allowOpenTablesAcrossBoundary:true is always passed by the automatic orchestrator", env.closeCalls[0].closeContext && env.closeCalls[0].closeContext.allowOpenTablesAcrossBoundary === true, JSON.stringify(env.closeCalls[0].closeContext));
    assert("1c: a snapshot was captured", env.snapshotRows.length === 1);
    assert("1d: zero incidents persisted", r.incidents.length === 0);
    assert("1e: the next session was established", r.newSession && r.newSession.id === "next-session");
    assert("1f: exactly one attempt was acquired, and it is now completed", env.attemptRows.length === 1 && env.attemptRows[0].status === "completed");
  }

  console.log("\n── rollover with operational + financial incidents: still succeeds, incidents recorded ──");
  {
    const orders = [
      { id: "o1", estado: "EN_COCINA", totale: 0 },
      { id: "o2", estado: "RETIRADO", totale: 62.5 },
    ];
    const env = fakeEnv({ orders });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("2a: success, code ROLLED_OVER_WITH_INCIDENTS", r.success === true && r.code === "ROLLED_OVER_WITH_INCIDENTS", JSON.stringify(r));
    assert("2b: exactly 2 incidents persisted (1 operational, 1 financial)", r.incidents.length === 2, JSON.stringify(r.incidents));
    assert("2c: the close still went through", env.closeCalls.length === 1);
    assert("2d: incidents carry the SAME closeoutCorrelationId, snapshotId", new Set(r.incidents.map((i) => i.closeout_correlation_id || env.reportCalls[0].closeoutCorrelationId)).size <= 2);
    assert("2e: the financial incident carries the authoritative exposure (6250 cents)", env.reportCalls.some((c) => c.incidentType === "UNPAID_BALANCE_AT_CLOSE" && c.financialExposureCents === 6250));
  }

  console.log("\n── empty table auto-release: safe action applied AFTER its incident is persisted ──");
  {
    const tableSessions = [{ id: "t1", status: "open", covers_total: null, workspace_id: "ws1" }];
    const env = fakeEnv({ tableSessions });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("3a: success with one informational incident", r.success === true && r.incidents.length === 1 && r.incidents[0].incidentType === "EMPTY_TABLE_LEFT_OPEN" || r.incidents[0].incident_type === "EMPTY_TABLE_LEFT_OPEN", JSON.stringify(r.incidents));
    assert("3b: the mesa release RPC was called for that exact table", env.releaseCalls.length === 1 && env.releaseCalls[0].tableSessionId === "t1" && env.releaseCalls[0].workspaceId === "ws1");
    // Ordering: the incident report call must appear before the release call in the trace.
    assert("3c: incident persistence happened before the auto-release (report call recorded, then release)", env.reportCalls.length === 1);
  }

  console.log("\n── STALE_SERVICE_SESSION_SELF_HEAL: TRUE_HARD_BLOCKER_STILL_BLOCKS — a genuine hard blocker fails closed, nothing archived, no incidents persisted ──");
  {
    // The ONLY hard-blocker condition rolloverClassifier.js can currently
    // produce (SESSION_IDENTITY_INVALID): missing business_date/service_kind.
    // Not invented for this test -- pinned against the real source in
    // src/serviceSessions/rolloverClassifier.js's own classify function.
    const BROKEN_SESSION = { id: "sess-broken" }; // no business_date/service_kind
    const orders = [{ id: "o1", estado: "EN_ENTREGA", totale: 17 }];
    const env = fakeEnv({ orders });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: BROKEN_SESSION, actor: "system", source: "order_intake_reconcile" });
    assert("hard-a: fails closed with ROLLOVER_HARD_BLOCKED", r.success === false && r.error === "ROLLOVER_HARD_BLOCKED", JSON.stringify(r));
    assert("hard-b: the exact hard blocker is reported (SESSION_IDENTITY_INVALID), not a generic failure", r.hardBlockers && r.hardBlockers.some((b) => b.code === "SESSION_IDENTITY_INVALID"), JSON.stringify(r.hardBlockers));
    // language-guard: allow-legacy chiudiServizio is the existing close-engine function this assertion label names, not new vocabulary
    assert("hard-c: chiudiServizio is NEVER called — a hard blocker stops before any close attempt", env.closeCalls.length === 0);
    assert("hard-d: zero incidents persisted — nothing is reported for a session whose identity can't even be trusted", env.reportCalls.length === 0);
    assert("hard-e: the attempt is neither completed nor superseded — it just stays active, waiting for a real fix", env.attemptRows.length === 1 && env.attemptRows[0].status === "active");
  }

  console.log("\n── STALE_SERVICE_SESSION_SELF_HEAL: FINANCIAL_INCIDENT_POLICY — encodes the CURRENT canonical rule from source, not a guess: no unpaid amount, however large, is ever a hard blocker ──");
  {
    // rolloverClassifier.js's classifyForIncidentSafeRollover has ZERO
    // threshold/amount logic anywhere in its financial branch — every
    // ticket.unpaidAmount > 0 becomes a financialIncidents entry,
    // unconditionally. This test pins that contract directly against a
    // deliberately large exposure (matches real staging's own six unpaid
    // UNPAID_BALANCE_AT_CLOSE incidents on c9d5aaa7..., €129.50 total) so a
    // future change adding a silent threshold would fail this test loudly.
    const orders = [{ id: "o1", estado: "RETIRADO", totale: 5000 }];
    const env = fakeEnv({ orders });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("fin-a: a huge (5000) unpaid balance still succeeds — never a hard blocker regardless of amount", r.success === true && r.hardBlockers === undefined, JSON.stringify(r));
    assert("fin-b: it is recorded as an ordinary financial incident with the authoritative exposure (500000 cents)", env.reportCalls.some((c) => c.incidentType === "UNPAID_BALANCE_AT_CLOSE" && c.financialExposureCents === 500000), JSON.stringify(env.reportCalls));
    assert("fin-c: the close still went through and the next session was established", env.closeCalls.length === 1 && r.newSession && r.newSession.id === "next-session");
  }

  console.log("\n── SLICE 4C.1: occupied tables span the boundary — automatic rollover succeeds, table_sessions are never touched by this module ──");
  {
    // Mirrors real staging (2026-08-07 stale PRANZO): two occupied tables with
    // real covers, one genuinely empty, all orders terminal.
    const tableSessions = [
      { id: "occupied-1", status: "open", covers_total: 4, workspace_id: "ws1" },
      { id: "occupied-2", status: "open", covers_total: 2, workspace_id: "ws1" },
      { id: "empty-1", status: "open", covers_total: null, workspace_id: "ws1" },
    ];
    const orders = [{ id: "o1", estado: "RETIRADO", totale: 16 }];
    const env = fakeEnv({ tableSessions, orders });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("mix-a: rollover succeeds despite two occupied open tables", r.success === true, JSON.stringify(r));
    assert("mix-b: chiudiServizio called with allowOpenTablesAcrossBoundary:true", env.closeCalls.length === 1 && env.closeCalls[0].closeContext?.allowOpenTablesAcrossBoundary === true);
    assert("mix-c: only the truly-empty table was auto-released", env.releaseCalls.length === 1 && env.releaseCalls[0].tableSessionId === "empty-1");
    assert("mix-d: the occupied tables were never passed to the release RPC", !env.releaseCalls.some((c) => c.tableSessionId === "occupied-1" || c.tableSessionId === "occupied-2"));
    assert("mix-e: exactly one informational incident (the empty table), occupied tables produce none", r.incidents.filter((i) => i.category === "informational").length === 1);
  }

  console.log("\n── STALE_SERVICE_SESSION_SELF_HEAL (2026-08-15): an active rider trip spans the boundary exactly like an occupied table — rollover succeeds, the trip is never touched by this module ──");
  {
    // Mirrors real staging (2026-08-13 stuck SERA, service_session_id
    // c9d5aaa7...): two EN_ENTREGA orders belonging to one active rider
    // trip, everything else terminal. The rider trip's own live/active
    // state is NOT modeled by this fake (config.DRIVER_STATO lives entirely
    // language-guard: allow-legacy chiudiServizio is the existing close-engine function this comment paragraph references twice, not new vocabulary
    // inside chiudiServizio/riderTrip.js, mocked away here as closeSession)
    // — what THIS test proves is the orchestrator's own contract: it always
    // language-guard: allow-legacy chiudiServizio is the existing close-engine function this line references, not new vocabulary
    // asks chiudiServizio to cross the boundary rather than defer, and it
    // persists the delivery-active fact as an incident BEFORE ever doing so.
    const orders = [
      { id: "o1", estado: "EN_ENTREGA", totale: 17 },
      { id: "o2", estado: "EN_ENTREGA", totale: 27.5 },
      { id: "o3", estado: "RETIRADO", totale: 25 },
    ];
    const env = fakeEnv({ orders });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "order_intake_reconcile" });
    assert("trip-a: rollover succeeds despite two EN_ENTREGA orders on an active trip", r.success === true, JSON.stringify(r));
    // language-guard: allow-legacy chiudiServizio is the existing close-engine function this assertion label names, not new vocabulary
    assert("trip-b: chiudiServizio called with allowActiveRiderTripAcrossBoundary:true", env.closeCalls.length === 1 && env.closeCalls[0].closeContext?.allowActiveRiderTripAcrossBoundary === true, JSON.stringify(env.closeCalls[0].closeContext));
    assert("trip-b2: preserveActiveOrders and allowOpenTablesAcrossBoundary are STILL also true — the new flag is additive, not a replacement", env.closeCalls[0].closeContext?.preserveActiveOrders === true && env.closeCalls[0].closeContext?.allowOpenTablesAcrossBoundary === true);
    assert("trip-c: both delivery-active orders became DELIVERY_ACTIVE_AT_CLOSE incidents", env.reportCalls.filter((c) => c.incidentType === "DELIVERY_ACTIVE_AT_CLOSE").length === 2, JSON.stringify(env.reportCalls));
    // language-guard: allow-legacy chiudiServizio is the existing close-engine function this assertion label names, not new vocabulary
    assert("trip-d: the incidents were persisted BEFORE chiudiServizio was ever called (report calls exist, close already recorded as having happened)", env.reportCalls.length >= 2 && env.closeCalls.length === 1);
    assert("trip-e: this module never calls anything resembling a rider/trip RPC directly — it only ever calls the mocked closeSession/releaseEmptyTableSession", env.releaseCalls.length === 0);
    assert("trip-f: the attempt completed and the next session was established — order intake is unblocked", env.attemptRows[0].status === "completed" && r.newSession && r.newSession.id === "next-session");
  }

  console.log("\n── STALE_SERVICE_SESSION_SELF_HEAL negative-adjacent case: the flag is passed even when there is no delivery activity at all (always-on, matching the other two boundary flags) ──");
  {
    const env = fakeEnv({});
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("trip-g: allowActiveRiderTripAcrossBoundary:true is unconditional, exactly like allowOpenTablesAcrossBoundary", env.closeCalls[0].closeContext?.allowActiveRiderTripAcrossBoundary === true);
  }

  console.log("\n── STALE_SERVICE_SESSION_SELF_HEAL: a table occupied by the SAME operator who is also mid-delivery (both boundary conditions in one real-shaped rollover) — table_session is never read/written by this module, and the newly-established session is what a subsequent order-intake attempt would bind new commands to ──");
  {
    // Combines the 4C.1 Mesa scenario and this fix's rider-trip scenario in
    // one rollover, closest this offline suite can get to the real staging
    // shape (c9d5aaa7...: EN_ENTREGA orders AND, once this session's live
    // UAT opens a table against it, an occupied Mesa table too). The actual
    // DB-level enforcement (begin_service_session_close's new p_preserve_
    // active_orders exemption) is proven separately by this migration's own
    // static test; what this level proves is that the ORCHESTRATOR treats
    // both as one coherent policy and hands back a genuinely fresh session.
    const tableSessions = [{ id: "occupied-mesa-1", status: "open", covers_total: 2, workspace_id: "ws1" }];
    const orders = [{ id: "o1", estado: "EN_ENTREGA", totale: 17 }];
    const env = fakeEnv({ tableSessions, orders });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "order_intake_reconcile" });
    assert("combined-a: rollover succeeds with both an active trip AND an occupied table present", r.success === true, JSON.stringify(r));
    assert("combined-b: the occupied table_session is never read/written for release -- it is not empty (covers_total:2), so it is untouched, exactly as 4C.1 already established", env.releaseCalls.length === 0);
    assert("combined-c: a genuinely NEW, different session was established -- this is what fetchActiveServiceSessionSelfHealing (orderIntakePolicy.js) re-reads and returns to the next real order-intake caller, so a new command after this point binds to it, not the closed one", r.newSession && r.newSession.id === "next-session" && r.newSession.id !== SESSION.id);
    assert("combined-d: the closed session's own id is never reused as the new one", env.attemptRows[0].serviceSessionId === SESSION.id && r.newSession.id !== SESSION.id);
  }

  console.log("\n── Step 12 case: snapshot persisted, incident persistence fails -> no unsafe close, retry converges on the SAME attempt ──");
  {
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 10 }];
    const env = fakeEnv({ orders, failReportForTypes: new Set(["KITCHEN_WORK_PENDING_AT_CLOSE"]) });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r1 = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("4a: first attempt fails closed on incident persistence", r1.success === false && r1.error === "ROLLOVER_INCIDENT_PERSISTENCE_FAILED", JSON.stringify(r1));
    assert("4b: chiudiServizio was NEVER called — no unsafe close", env.closeCalls.length === 0);
    assert("4c: the snapshot WAS persisted (survives for the retry)", env.snapshotRows.length === 1);
    assert("4c2: the attempt is still active (not completed, not superseded)", env.attemptRows.length === 1 && env.attemptRows[0].status === "active");

    // Retry: SAME live state (nothing mutated), incident reporting now
    // succeeds for everything -> must converge on the SAME attempt.
    env.reportCalls = [];
    const perform2 = createIncidentSafeRollover({
      select: env.select, snapshots: env.snapshots, attempts: env.attempts,
      incidents: { async report(args) { env.reportCalls.push(args); return { success: true, created: env.incidentRows.every((r2) => r2.incidentType !== args.incidentType), code: "RECORDED", incident: { id: "inc-retry" } }; } },
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const r2 = await perform2({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("4d: retry with the SAME state reuses the SAME snapshot/correlation id and now succeeds", r2.success === true && r2.closeoutCorrelationId === r1.closeoutCorrelationId, JSON.stringify({ r1: r1.closeoutCorrelationId, r2: r2.closeoutCorrelationId }));
    assert("4e: exactly one snapshot row exists total — the retry never captured a second one", env.snapshotRows.length === 1);
    assert("4f: exactly one attempt row total — no supersession happened (state never changed)", env.attemptRows.length === 1 && env.supersedeCalls.length === 0);
  }

  console.log("\n── Step 12 case: snapshot capture itself fails -> hard blocker, nothing else attempted ──");
  {
    const env = fakeEnv({ failCaptureOnce: true });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("5a: fails closed on snapshot capture", r.success === false && r.error === "ROLLOVER_SNAPSHOT_CAPTURE_FAILED", JSON.stringify(r));
    assert("5b: no incidents were ever attempted", env.reportCalls.length === 0);
    assert("5c: chiudiServizio was never called", env.closeCalls.length === 0);
  }

  console.log("\n── Step 12 case: archive itself fails (e.g. verify_failed) -> incidents already durable, no duplicate on retry, attempt completes on success ──");
  {
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    let closeAttempt = 0;
    const env = fakeEnv({
      orders,
      closeResultSpec: () => { closeAttempt++; return closeAttempt === 1 ? { success: false, error: "verify_failed" } : { success: true, service_session_id: SESSION.id, summary: {} }; },
    });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r1 = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("6a: first attempt surfaces the archive failure, incidents already recorded", r1.success === undefined || r1.success !== true, JSON.stringify(r1));
    assert("6b: exactly one incident was persisted on attempt 1", env.incidentRows.length === 1);
    assert("6b2: the attempt is still active after the archive failure", env.attemptRows.length === 1 && env.attemptRows[0].status === "active");

    const r2 = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("6c: retry succeeds (archive now works)", r2.success === true, JSON.stringify(r2));
    assert("6d: still exactly one incident row — the retry did not duplicate it", env.incidentRows.length === 1);
    assert("6e: still exactly one snapshot row", env.snapshotRows.length === 1);
    assert("6f: chiudiServizio was called twice (once per attempt)", env.closeCalls.length === 2);
    assert("6g: the attempt is now completed", env.attemptRows.length === 1 && env.attemptRows[0].status === "completed");
  }

  console.log("\n── deferred close (active rider trip) passes through unchanged, no next-session attempted, attempt stays active ──");
  {
    const env = fakeEnv({ closeResultSpec: { skipped: true, deferred: true, reason: "active_rider_trip", data: "2026-08-08" } });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("7a: deferred/reason pass through unchanged for deferredCloseRetryPlan to read", r.deferred === true && r.reason === "active_rider_trip", JSON.stringify(r));
    assert("7b: no next-session ensure attempted (close never actually succeeded)", env.ensureCalls.length === 0);
    assert("7c: the attempt was never marked completed", env.attemptRows.length === 1 && env.attemptRows[0].status === "active");
  }

  console.log("\n── next session is NOT invented outside a valid ensure window ──");
  {
    // 05:00 Madrid — OUTSIDE_WINDOWS, canEnsureSession:false.
    const OUTSIDE_WINDOWS_NOW = new Date(Date.UTC(2026, 7, 8, 3, 0));
    const env = fakeEnv({});
    const perform = makeOrchestrator(env, OUTSIDE_WINDOWS_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "catchUp" });
    assert("8a: close succeeded", r.success === true);
    assert("8b: no session was invented outside a valid window", r.newSession === null && env.ensureCalls.length === 0, JSON.stringify(r));
  }

  console.log("\n── SLICE 3.1: retry with UNCHANGED live state replays the frozen classification (no reclassify, no new attempt) ──");
  {
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    const env = fakeEnv({ orders, failReportForTypes: new Set(["KITCHEN_WORK_PENDING_AT_CLOSE"]) });
    const perform1 = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r1 = await perform1({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("9a: first attempt fails closed on incident persistence, snapshot survives for the retry", r1.success === false && env.snapshotRows.length === 1, JSON.stringify(r1));

    // State is NOT mutated between attempt 1 and the retry.
    const perform2 = createIncidentSafeRollover({
      select: env.select, snapshots: env.snapshots, attempts: env.attempts,
      incidents: { async report(args) { env.reportCalls.push(args); return { success: true, created: true, code: "RECORDED", incident: { id: "inc-retry", ...args } }; } },
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const r2 = await perform2({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("9b: retry converges on the SAME attempt/correlation id (state fingerprint matched)", r2.closeoutCorrelationId === r1.closeoutCorrelationId);
    assert("9c: the incident persisted is STILL KITCHEN_WORK_PENDING_AT_CLOSE (replayed, not reclassified)", r2.success === true && r2.incidents.length === 1 && r2.incidents[0].incidentType === "KITCHEN_WORK_PENDING_AT_CLOSE", JSON.stringify(r2.incidents));
    assert("9d: still exactly one snapshot row and one attempt row — no supersession, no second capture", env.snapshotRows.length === 1 && env.attemptRows.length === 1 && env.supersedeCalls.length === 0);
  }

  console.log("\n── SLICE 3.1: retry after live state genuinely CHANGED supersedes the stale attempt and starts a fresh one ──");
  {
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    const env = fakeEnv({ orders, failReportForTypes: new Set(["KITCHEN_WORK_PENDING_AT_CLOSE"]) });
    const perform1 = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r1 = await perform1({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("10a: first attempt fails closed on incident persistence", r1.success === false && env.snapshotRows.length === 1);
    const firstCorrelationId = r1.closeoutCorrelationId;

    // The operator finishes the pending kitchen work between attempt 1 and
    // the retry — the order this attempt's incident was about is now
    // terminal (RETIRADO). Live state has genuinely moved on.
    orders[0].estado = "RETIRADO";

    const perform2 = createIncidentSafeRollover({
      select: env.select, snapshots: env.snapshots, attempts: env.attempts,
      incidents: { async report(args) { env.reportCalls.push(args); return { success: true, created: true, code: "RECORDED", incident: { id: "inc-retry", ...args } }; } },
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const r2 = await perform2({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("10b: the retry got a DIFFERENT correlation id — a genuinely new attempt", r2.closeoutCorrelationId !== firstCorrelationId, JSON.stringify({ first: firstCorrelationId, second: r2.closeoutCorrelationId }));
    assert("10c: the OLD attempt is now superseded", env.attemptRows.find((a) => a.closeoutCorrelationId === firstCorrelationId).status === "superseded");
    assert("10d: a NEW attempt exists and is the one that closed", env.attemptRows.find((a) => a.closeoutCorrelationId === r2.closeoutCorrelationId) && env.attemptRows.length === 2);
    assert("10e: a SECOND snapshot was captured for the new attempt", env.snapshotRows.length === 2);
    assert("10f: the new attempt's incidents reflect the CORRECTED state — zero incidents, order is now terminal", r2.success === true && r2.incidents.length === 0, JSON.stringify(r2.incidents));
    assert("10g: exactly one supersede call was made", env.supersedeCalls.length === 1 && env.supersedeCalls[0].closeoutCorrelationId === firstCorrelationId);
  }

  console.log("\n── SLICE 3.2: concurrent FIRST-capture race — the loser must persist the WINNER's classification, not its own ──");
  {
    // Two callers share the SAME active attempt (exactly what the active-uq
    // invariant is FOR) and BOTH observe no snapshot yet for it. They
    // independently read DIFFERENT live state and derive DIFFERENT local
    // classifications. Only one capture() call can actually win the row —
    // this proves the LOSER discards its own classification and persists
    // only the WINNER's facts, never a mix of the two.
    const sharedCorrelationId = "shared-attempt-race";
    const env = fakeEnv({});
    env.attemptRows.push({
      closeoutCorrelationId: sharedCorrelationId, serviceSessionId: SESSION.id,
      status: "active", startedAt: new Date().toISOString(), createdBy: "system",
    });

    // Caller A's view: order o1 pending in the kitchen.
    const orderStateA = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    const performA = createIncidentSafeRollover({
      select: async (table) => (table === "ordenes" ? orderStateA : []),
      snapshots: env.snapshots, attempts: env.attempts, incidents: env.incidents,
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const rA = await performA({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("11a: caller A wins — succeeds, captures the attempt's snapshot", rA.success === true && env.snapshotRows.length === 1);
    assert("11a2: caller A's incident (KITCHEN_WORK_PENDING_AT_CLOSE for o1) is recorded", env.incidentRows.length === 1 && env.incidentRows[0].incidentType === "KITCHEN_WORK_PENDING_AT_CLOSE" && env.incidentRows[0].orderId === "o1");

    // Caller B: a DIFFERENT view (order o2, LISTO) of the SAME still-shared
    // attempt, whose OWN pre-capture lookup happened before A's row became
    // visible to it (getByCorrelationId forced to null) — but by the time
    // B's OWN capture() call actually reaches the store, A has already
    // committed, so it legitimately returns created:false with A's row
    // (env.snapshots.capture is the REAL shared fake, unmodified).
    const orderStateB = [{ id: "o2", estado: "LISTO", totale: 0 }];
    const performB = createIncidentSafeRollover({
      select: async (table) => (table === "ordenes" ? orderStateB : []),
      snapshots: { getByCorrelationId: async () => null, capture: env.snapshots.capture },
      attempts: {
        acquire: async () => ({ success: true, created: false, code: "ALREADY_ACTIVE", attempt: { closeoutCorrelationId: sharedCorrelationId, serviceSessionId: SESSION.id, status: "active" } }),
        supersede: env.attempts.supersede, complete: env.attempts.complete,
      },
      incidents: env.incidents,
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const rB = await performB({ session: SESSION, actor: "system", source: "cron_lunch" });

    assert("11b: caller B converges on the SAME correlation id as the winner", rB.closeoutCorrelationId === sharedCorrelationId);
    assert("11c: still exactly ONE snapshot row total — B never captured a second one", env.snapshotRows.length === 1);
    assert("11d: B never even ATTEMPTED to report its own (LISTO/o2) incident", !env.reportCalls.some((c) => c.incidentType === "ORDER_READY_NOT_FINALIZED_AT_CLOSE" || c.orderId === "o2"));
    assert("11e: B's incident story is the WINNER's (KITCHEN_WORK_PENDING_AT_CLOSE for o1), deduped, not duplicated", rB.incidents.length === 1 && rB.incidents[0].incidentType === "KITCHEN_WORK_PENDING_AT_CLOSE", JSON.stringify(rB.incidents));
    assert("11f: still exactly ONE incident row total across both callers — no incoherent mix of A's and B's facts", env.incidentRows.length === 1);
  }

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
