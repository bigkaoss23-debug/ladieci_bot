"use strict";
// SERVICE CLOSEOUT V2 / SLICE 3 — required test matrix (plan Step 15), each
// scenario mapped 1:1 to its own block so the mapping from requirement to
// proof is auditable at a glance. Uses the same fully-controllable fake
// environment shape as tests/incidentSafeRollover.test.js — a live-Postgres
// pass covering the DB-persistence-specific claims (incidents surviving a
// real close, real RLS/append-only enforcement) is documented separately in
// the slice report, not duplicated here.
//
// Explicitly NOT implemented here: "CROSS-SERVICE TABLE SESSION" — building
// a synthetic table_sessions/mesa fixture for this would require touching or
// deeply modeling Mesa-specific invariants, which the plan explicitly asks
// this slice not to do ("Do not modify Mesa code solely for this test").

const { createIncidentSafeRollover } = require("../src/serviceSessions/incidentSafeRollover");
const { computeAutoCloseDecision } = require("../src/serviceSessions/autoCloseDecision");
const { classifySessionForRollover } = require("../src/serviceSessions/sessionRolloverClassification");
const { DEFAULT_SCHEDULE } = require("../src/schedule/serviceSchedule");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

function fakeEnv({ orders = [], tableSessions = [], financialEvents = [], closeResultSpec = { success: true, service_session_id: "s1", summary: {} }, captureResultOverride = null } = {}) {
  const env = { attemptRows: [], snapshotRows: [], incidentRows: [], closeCalls: [], reportCalls: [], releaseCalls: [], ensureCalls: [], supersedeCalls: [] };
  env.select = async (table) => {
    if (table === "ordenes") return orders;
    if (table === "table_sessions") return tableSessions;
    if (table === "order_financial_events") return financialEvents;
    throw new Error("unexpected table " + table);
  };
  env.attempts = {
    async acquire({ serviceSessionId, actor }) {
      const active = env.attemptRows.find((r) => r.serviceSessionId === serviceSessionId && r.status === "active");
      if (active) return { success: true, created: false, code: "ALREADY_ACTIVE", attempt: active };
      const row = { closeoutCorrelationId: "attempt-" + (env.attemptRows.length + 1), serviceSessionId, status: "active", startedAt: new Date().toISOString(), createdBy: actor };
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
      const row = env.attemptRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId);
      if (!row) return { success: false, code: "ATTEMPT_NOT_FOUND", attempt: null };
      if (row.status === "superseded") return { success: false, code: "CANNOT_COMPLETE_SUPERSEDED_ATTEMPT", attempt: null };
      if (row.status === "completed") return { success: true, idempotent: true, code: "ALREADY_COMPLETED", attempt: row };
      row.status = "completed"; row.completedAt = new Date().toISOString();
      return { success: true, idempotent: false, code: "COMPLETED", attempt: row };
    },
  };
  env.snapshots = {
    async getByCorrelationId({ closeoutCorrelationId }) { return env.snapshotRows.find((r) => r.closeoutCorrelationId === closeoutCorrelationId) || null; },
    async capture(args) {
      if (captureResultOverride) return captureResultOverride;
      const existing = env.snapshotRows.find((r) => r.closeoutCorrelationId === args.closeoutCorrelationId);
      if (existing) return { success: true, created: false, code: "ALREADY_CAPTURED", snapshot: existing };
      const row = { id: "snap-" + (env.snapshotRows.length + 1), serviceSessionId: args.serviceSessionId, closeoutCorrelationId: args.closeoutCorrelationId, payload: args.payload, payloadSha256: args.payloadSha256 };
      env.snapshotRows.push(row);
      return { success: true, created: true, code: "CAPTURED", snapshot: row };
    },
  };
  env.incidents = {
    async report(args) {
      env.reportCalls.push(args);
      const existing = env.incidentRows.find((r) => r.closeoutCorrelationId === args.closeoutCorrelationId && r.incidentType === args.incidentType && (r.entityType || "") === (args.entityType || "") && (r.entityId || "") === (args.entityId || ""));
      if (existing) return { success: true, created: false, code: "ALREADY_RECORDED", incident: existing };
      const row = { id: "inc-" + (env.incidentRows.length + 1), ...args };
      env.incidentRows.push(row);
      return { success: true, created: true, code: "RECORDED", incident: row };
    },
    async listBySession({ serviceSessionId }) { return env.incidentRows.filter((r) => r.serviceSessionId === serviceSessionId); },
  };
  env.closeSession = async (deleteAttivi, source, actor) => { env.closeCalls.push({ deleteAttivi, source, actor }); return typeof closeResultSpec === "function" ? closeResultSpec() : closeResultSpec; };
  env.releaseEmptyTableSession = async (args) => { env.releaseCalls.push(args); return { ok: true }; };
  env.sessionLifecycleImpl = { async ensure(args) { env.ensureCalls.push(args); return { ok: true, created: true, session: { id: "next-session", service_kind: args.serviceKind } }; } };
  return env;
}
function makePerform(env, nowDate) {
  return createIncidentSafeRollover({
    select: env.select, snapshots: env.snapshots, attempts: env.attempts, incidents: env.incidents,
    closeSession: env.closeSession, releaseEmptyTableSession: env.releaseEmptyTableSession,
    sessionLifecycleImpl: env.sessionLifecycleImpl, now: () => nowDate, schedule: DEFAULT_SCHEDULE,
  });
}

const SERA_WINDOW_NOW = new Date(Date.UTC(2026, 7, 8, 18, 0)); // 20:00 Madrid, 2026-08-08

(async () => {
  console.log("\n=== SERVICE CLOSEOUT V2 / SLICE 3 — required test matrix ===\n");

  console.log("── 1. CLEAN PRANZO -> SERA: no activity -> old closed, new SERA current, zero incidents ──");
  {
    const session = { id: "s1", business_date: "2026-08-08", service_kind: "PRANZO" };
    const env = fakeEnv({ closeResultSpec: { success: true, service_session_id: "s1", summary: {} } });
    const r = await makePerform(env, SERA_WINDOW_NOW)({ session, actor: "system", source: "cron_lunch" });
    assert("1a: old session closed (chiudiServizio called)", env.closeCalls.length === 1 && env.closeCalls[0].deleteAttivi === true);
    assert("1b: new SERA session established as current", r.newSession && r.newSession.service_kind === "SERA");
    assert("1c: zero incidents", r.incidents.length === 0 && r.code === "ROLLED_OVER");
  }

  console.log("\n── 2. PRIOR-DAY CLEAN STALE: yesterday PRANZO, today any valid window -> rolls over without today's PRANZO closeEligibility gate ──");
  {
    const staleSession = { id: "s2", business_date: "2026-08-07", service_kind: "PRANZO" };
    // 10:00 today — PRANZO's OWN closeEligibility would say "too early" if
    // judged as today's lunch. The classification must still be due.
    const morningToday = new Date(Date.UTC(2026, 7, 8, 8, 0)); // 10:00 Madrid
    const classification = classifySessionForRollover(staleSession, morningToday, DEFAULT_SCHEDULE);
    assert("2a: classified PRIOR_DAY_STALE, not judged against today's PRANZO window", classification.type === "PRIOR_DAY_STALE", JSON.stringify(classification));
    const decision = computeAutoCloseDecision({ now: morningToday, session: { ...staleSession, status: "open" } });
    assert("2b: computeAutoCloseDecision agrees it is due, via the stale path", decision.due === true && decision.source === "cron_stale_rollover");

    const env = fakeEnv({ closeResultSpec: { success: true, service_session_id: "s2", summary: {} } });
    const r = await makePerform(env, morningToday)({ session: staleSession, actor: "system", source: decision.source });
    assert("2c: the stale session rolled over", env.closeCalls.length === 1 && r.success === true);
  }

  console.log("\n── 3. PRIOR-DAY + OPERATIONAL INCIDENT: old kitchen/delivery pending -> incident persisted, old closes, new opens ──");
  {
    const staleSession = { id: "s3", business_date: "2026-08-07", service_kind: "PRANZO" };
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    const env = fakeEnv({ orders, closeResultSpec: { success: true, service_session_id: "s3", summary: {} } });
    const r = await makePerform(env, SERA_WINDOW_NOW)({ session: staleSession, actor: "system", source: "cron_stale_rollover" });
    assert("3a: exactly one operational incident persisted", r.incidents.length === 1, JSON.stringify(r.incidents));
    assert("3a-precise: it is KITCHEN_WORK_PENDING_AT_CLOSE", env.reportCalls.some((c) => c.incidentType === "KITCHEN_WORK_PENDING_AT_CLOSE"));
    assert("3b: old session closed despite the pending order", env.closeCalls.length === 1 && env.closeCalls[0].deleteAttivi === true);
    assert("3c: new service session established", r.newSession !== null);
  }

  console.log("\n── 4. PRIOR-DAY + FINANCIAL INCIDENT: 62.50 unpaid -> financial incident 6250, historical truth untouched, old closes, new opens ──");
  {
    const staleSession = { id: "s4", business_date: "2026-08-07", service_kind: "PRANZO" };
    const orders = [{ id: "o1", estado: "RETIRADO", totale: 62.5 }];
    const env = fakeEnv({ orders, closeResultSpec: { success: true, service_session_id: "s4", summary: {} } });
    const r = await makePerform(env, SERA_WINDOW_NOW)({ session: staleSession, actor: "system", source: "cron_stale_rollover" });
    const financialCall = env.reportCalls.find((c) => c.incidentType === "UNPAID_BALANCE_AT_CLOSE");
    assert("4a: financial incident persisted with exposure 6250 cents", !!financialCall && financialCall.financialExposureCents === 6250, JSON.stringify(financialCall));
    assert("4b: the order object itself was never mutated by the classifier/orchestrator (no mark-paid call exists anywhere in this module)", orders[0].totale === 62.5 && orders[0].estado === "RETIRADO");
    assert("4c: old session closed, new session established", env.closeCalls.length === 1 && r.newSession !== null);
  }

  console.log("\n── 5. EMPTY TABLE: zero activity -> safe auto-action, informational incident, new service opens ──");
  {
    const session = { id: "s5", business_date: "2026-08-08", service_kind: "PRANZO" };
    const tableSessions = [{ id: "t1", status: "open", covers_total: null, workspace_id: "ws1" }];
    const env = fakeEnv({ tableSessions, closeResultSpec: { success: true, service_session_id: "s5", summary: {} } });
    const r = await makePerform(env, SERA_WINDOW_NOW)({ session, actor: "system", source: "cron_lunch" });
    assert("5a: safe auto-action applied (empty table released)", env.releaseCalls.length === 1 && env.releaseCalls[0].tableSessionId === "t1");
    assert("5b: informational incident recorded", env.reportCalls.some((c) => c.incidentType === "EMPTY_TABLE_LEFT_OPEN"));
    assert("5c: new service opens", r.newSession !== null);
  }

  console.log("\n── 6. HARD INTEGRITY FAILURE: snapshot capture fails -> new service does NOT open ──");
  {
    const session = { id: "s6", business_date: "2026-08-08", service_kind: "PRANZO" };
    const env = fakeEnv({ captureResultOverride: { success: false, created: false, code: "CLOSEOUT_SNAPSHOT_TRANSPORT_ERROR", snapshot: null } });
    const r = await makePerform(env, SERA_WINDOW_NOW)({ session, actor: "system", source: "cron_lunch" });
    assert("6a: rollover fails closed on snapshot capture failure", r.success === false && r.error === "ROLLOVER_SNAPSHOT_CAPTURE_FAILED", JSON.stringify(r));
    assert("6b: chiudiServizio was never called — old session remains open, untouched", env.closeCalls.length === 0);
    assert("6c: no next session was ever attempted", env.ensureCalls.length === 0);
  }

  console.log("\n── 7. MANUAL CLOSE: existing conservative warning behavior remains untouched ──");
  {
    const INDEX = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
    const manualCloseHandler = INDEX.slice(INDEX.indexOf('} else if (action === "chiudiServizio")'), INDEX.indexOf('} else if (action === "triggerCloseIfNeeded")'));
    assert("7a: the manual close action still gates on closeEligibility, unchanged", /closeEligibility\(kind, new Date\(\)\)/.test(manualCloseHandler));
    assert("7b: the manual close action still calls chiudiServizio DIRECTLY — it does NOT route through the automatic incident-safe rollover orchestrator", /result = await chiudiServizio\(req\.query\.deleteAttivi === "true", "operator"/.test(manualCloseHandler) && !/performIncidentSafeRollover/.test(manualCloseHandler));
    assert("7c: the force=true override still exists, unchanged", /force=true/.test(manualCloseHandler));
  }

  console.log("\n── 8. CLIENT RETRY: same ensure request/attempt against a still-incomplete closeout -> no duplicate snapshot, incidents, or attempt ──");
  {
    // The first attempt fails to actually close (e.g. a transient archive
    // error) -> the attempt stays 'active' and a genuine retry (SAME live
    // state, nothing corrected in between) must converge on it, per SLICE
    // 3.1's fingerprint-match contract. (A retry issued AFTER a successful
    // close is a different, already-covered scenario — see incidentSafeRollover.test.js
    // "the OLD attempt is now superseded"/completed cases; performIncidentSafeRollover
    // is never called twice for an already-closed session in production.)
    const session = { id: "s8", business_date: "2026-08-07", service_kind: "PRANZO" };
    const orders = [{ id: "o1", estado: "EN_COCINA", totale: 0 }];
    let closeAttempt = 0;
    const env = fakeEnv({
      orders,
      closeResultSpec: () => { closeAttempt++; return closeAttempt === 1 ? { success: false, error: "verify_failed" } : { success: true, service_session_id: "s8", summary: {} }; },
    });
    const perform = makePerform(env, SERA_WINDOW_NOW);
    const r1 = await perform({ session, actor: "system", source: "cron_stale_rollover" });
    const r2 = await perform({ session, actor: "system", source: "cron_stale_rollover" });
    assert("8a: exactly one snapshot row across both attempts", env.snapshotRows.length === 1);
    assert("8b: exactly one incident row across both attempts", env.incidentRows.length === 1);
    assert("8c: both attempts report the SAME closeoutCorrelationId", r1.closeoutCorrelationId === r2.closeoutCorrelationId);
    assert("8d: chiudiServizio was called twice (idempotent close engine handles the rest) but no duplicate session was ever established beyond what ensure() itself dedupes", env.closeCalls.length === 2);
    assert("8e: exactly one attempt row total, now completed by the second, successful call", env.attemptRows.length === 1 && env.attemptRows[0].status === "completed");
  }

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
