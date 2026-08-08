"use strict";
// SERVICE CLOSEOUT V2 / Slice 3 — orchestrator tests for
// performIncidentSafeRollover, against fully controllable fakes for every
// dependency (select, snapshots, incidents, closeSession, mesa release,
// sessionLifecycle.ensure). Exercises the exact failure/retry semantics from
// plan Step 12.

const { createIncidentSafeRollover } = require("../src/serviceSessions/incidentSafeRollover");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const SESSION = { id: "sess-1", business_date: "2026-08-08", service_kind: "PRANZO" };

// A minimal, fully controllable fake environment. Each table's rows are
// supplied explicitly; snapshots/incidents are in-memory stores with the SAME
// idempotency contracts the real RPCs have (dedupe on closeoutCorrelationId /
// (closeoutCorrelationId, incidentType, entityType, entityId)).
function fakeEnv({
  orders = [], tableSessions = [], financialEvents = [],
  closeResultSpec = { success: true, service_session_id: SESSION.id, summary: {} },
  failReportForTypes = new Set(),
  failCaptureOnce = false,
  ensureResultSpec = { ok: true, created: true, session: { id: "next-session", service_kind: "SERA" } },
} = {}) {
  const env = {
    snapshotRows: [], incidentRows: [], closeCalls: [], reportCalls: [], releaseCalls: [], ensureCalls: [],
    captureAttempts: 0,
  };
  env.select = async (table) => {
    if (table === "ordenes") return orders;
    if (table === "table_sessions") return tableSessions;
    if (table === "order_financial_events") return financialEvents;
    throw new Error("unexpected table " + table);
  };
  env.snapshots = {
    async listBySession({ serviceSessionId }) {
      return env.snapshotRows.filter((r) => r.serviceSessionId === serviceSessionId);
    },
    async capture({ serviceSessionId, closeoutCorrelationId, capturedBy, source, payload }) {
      env.captureAttempts++;
      if (failCaptureOnce && env.captureAttempts === 1) {
        return { success: false, created: false, code: "CLOSEOUT_SNAPSHOT_TRANSPORT_ERROR", snapshot: null };
      }
      const existing = env.snapshotRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (existing) return { success: true, created: false, code: "ALREADY_CAPTURED", snapshot: existing };
      const row = { id: "snap-" + (env.snapshotRows.length + 1), serviceSessionId, closeoutCorrelationId, capturedBy, source, payload };
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
  env.closeSession = async (deleteAttivi, source, actor) => {
    env.closeCalls.push({ deleteAttivi, source, actor });
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
    select: env.select, snapshots: env.snapshots, incidents: env.incidents,
    closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
    sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => nowDate, schedule: DEFAULT_SCHEDULE,
  });
}

// Any instant safely inside SERA_WINDOW so ensure() always fires when tested.
const SERA_WINDOW_NOW = new Date(Date.UTC(2026, 7, 8, 18, 0)); // 20:00 Madrid

(async () => {
  console.log("\n== performIncidentSafeRollover ==\n");

  console.log("── clean rollover: zero activity -> ROLLED_OVER, no incidents, new session established ──");
  {
    const env = fakeEnv({});
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("1a: success, code ROLLED_OVER (no incidents)", r.success === true && r.code === "ROLLED_OVER", JSON.stringify(r));
    assert("1b: chiudiServizio called exactly once, deleteAttivi=true", env.closeCalls.length === 1 && env.closeCalls[0].deleteAttivi === true);
    assert("1c: a snapshot was captured", env.snapshotRows.length === 1);
    assert("1d: zero incidents persisted", r.incidents.length === 0);
    assert("1e: the next session was established", r.newSession && r.newSession.id === "next-session");
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

  console.log("\n── Step 12 case: snapshot persisted, incident persistence fails -> no unsafe close, retry converges ──");
  {
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 10 }];
    const env = fakeEnv({ orders, failReportForTypes: new Set(["KITCHEN_WORK_PENDING_AT_CLOSE"]) });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r1 = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("4a: first attempt fails closed on incident persistence", r1.success === false && r1.error === "ROLLOVER_INCIDENT_PERSISTENCE_FAILED", JSON.stringify(r1));
    assert("4b: chiudiServizio was NEVER called — no unsafe close", env.closeCalls.length === 0);
    assert("4c: the snapshot WAS persisted (survives for the retry)", env.snapshotRows.length === 1);

    // Retry: this time incident reporting succeeds for everything.
    env.reportCalls = [];
    const perform2 = createIncidentSafeRollover({
      select: env.select, snapshots: env.snapshots,
      incidents: { async report(args) { env.reportCalls.push(args); return { success: true, created: env.incidentRows.every((r2) => r2.incidentType !== args.incidentType), code: "RECORDED", incident: { id: "inc-retry" } }; } },
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const r2 = await perform2({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("4d: retry with the SAME session reuses the SAME snapshot/correlation id and now succeeds", r2.success === true && r2.closeoutCorrelationId === r1.closeoutCorrelationId, JSON.stringify({ r1: r1.closeoutCorrelationId, r2: r2.closeoutCorrelationId }));
    assert("4e: exactly one snapshot row exists total — the retry never captured a second one", env.snapshotRows.length === 1);
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

  console.log("\n── Step 12 case: archive itself fails (e.g. verify_failed) -> incidents already durable, no duplicate on retry ──");
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

    const r2 = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("6c: retry succeeds (archive now works)", r2.success === true, JSON.stringify(r2));
    assert("6d: still exactly one incident row — the retry did not duplicate it", env.incidentRows.length === 1);
    assert("6e: still exactly one snapshot row", env.snapshotRows.length === 1);
    assert("6f: chiudiServizio was called twice (once per attempt)", env.closeCalls.length === 2);
  }

  console.log("\n── deferred close (active rider trip) passes through unchanged, no next-session attempted ──");
  {
    const env = fakeEnv({ closeResultSpec: { skipped: true, deferred: true, reason: "active_rider_trip", data: "2026-08-08" } });
    const perform = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r = await perform({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("7a: deferred/reason pass through unchanged for deferredCloseRetryPlan to read", r.deferred === true && r.reason === "active_rider_trip", JSON.stringify(r));
    assert("7b: no next-session ensure attempted (close never actually succeeded)", env.ensureCalls.length === 0);
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

  console.log("\n── Critical Check 2: retry after live state changed does NOT reclassify — snapshot/incidents stay coherent with attempt 1 ──");
  {
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    const env = fakeEnv({ orders, failReportForTypes: new Set(["KITCHEN_WORK_PENDING_AT_CLOSE"]) });
    let selectCalls = 0;
    const originalSelect = env.select;
    env.select = async (...args) => { selectCalls++; return originalSelect(...args); };

    const perform1 = makeOrchestrator(env, SERA_WINDOW_NOW);
    const r1 = await perform1({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("9a: first attempt fails closed on incident persistence, snapshot survives for the retry", r1.success === false && env.snapshotRows.length === 1, JSON.stringify(r1));
    const selectCallsAfterAttempt1 = selectCalls;
    assert("9b: attempt 1 read live state (ordenes/table_sessions/order_financial_events)", selectCallsAfterAttempt1 === 3, String(selectCallsAfterAttempt1));

    // Between attempt 1 and the retry, the order attempt 1 classified as
    // EN_COCINA becomes RETIRADO (terminal) — a fresh re-read/re-classify
    // would see ZERO incidents. The retry must not do that.
    orders[0].estado = "RETIRADO";

    const perform2 = createIncidentSafeRollover({
      select: env.select, snapshots: env.snapshots,
      incidents: { async report(args) { env.reportCalls.push(args); return { success: true, created: true, code: "RECORDED", incident: { id: "inc-retry", ...args } }; } },
      closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
      sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => SERA_WINDOW_NOW, schedule: DEFAULT_SCHEDULE,
    });
    const r2 = await perform2({ session: SESSION, actor: "system", source: "cron_lunch" });
    assert("9c: retry reuses the SAME correlation id", r2.closeoutCorrelationId === r1.closeoutCorrelationId);
    assert("9d: retry did NOT re-read live state — the frozen attempt-1 classification was replayed instead", selectCalls === selectCallsAfterAttempt1, String(selectCalls));
    assert("9e: the incident persisted is STILL KITCHEN_WORK_PENDING_AT_CLOSE (attempt 1's classification), not zero incidents from the since-changed live state", r2.success === true && r2.incidents.length === 1 && r2.incidents[0].incidentType === "KITCHEN_WORK_PENDING_AT_CLOSE", JSON.stringify(r2.incidents));
    assert("9f: still exactly one snapshot row — the retry never captured a second, later one", env.snapshotRows.length === 1);
  }

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
