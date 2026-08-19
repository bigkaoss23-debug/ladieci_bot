"use strict";
// F-10.3C Phase 15 -- THE DECISIVE TEST. Two REAL Node child processes,
// each calling the REAL creaOrdine(...) with a distinct valid order and a
// distinct client_req_id, launched through a synchronization barrier while
// a real stale Operational Service A sits open. Neither the resolver nor
// recovery is called manually -- only creaOrdine's own real retry logic.
const fs = require("fs");
const { fork } = require("child_process");
const path = require("path");
const { createStaleOperationalService } = require("./fixtures");
const { queryJson } = require("./lib/pg");

function madridIntakeWindowCheck() {
  const madrid = new Date().toLocaleString("en-US", { timeZone: "Europe/Madrid" });
  const d = new Date(madrid);
  const minutesOfDay = d.getHours() * 60 + d.getMinutes();
  const canCreateOrder = (minutesOfDay >= 480 && minutesOfDay < 1050) || minutesOfDay >= 1080;
  return { madridLocalTime: madrid, minutesOfDay, canCreateOrder };
}

function readProxyLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function runTwoOrderRace({ businessDate = "2020-01-04", proxyLogFile } = {}) {
  const windowCheck = madridIntakeWindowCheck();
  if (!windowCheck.canCreateOrder) {
    return {
      pass: false,
      blocked: "TIME_WINDOW_BLOCKED",
      note: "Real Madrid wall-clock time is outside resolve_order_intake_context_v1's own order-intake window (08:00-17:30 or 18:00-24:00). This is NOT a concurrency defect -- creaOrdine's real, unmodified preflight (orderIntakePolicy.gateNewOrderIntake) and the resolver itself would refuse EVERY order right now regardless of the F-10 recovery path. Re-run inside the window.",
      windowCheck,
    };
  }

  // fresh proxy log slice for this phase only
  const beforeIdx = readProxyLog(proxyLogFile).length;

  // Earlier phases (12/13/14) also create lifecycle_semantics='operational_
  // service_v1' fixture sessions (on old synthetic dates) -- snapshot their
  // ids BEFORE this phase's own fixture exists, so "new session" evidence
  // below can never mistake an earlier phase's already-closed fixture for a
  // genuinely NEW service created by THIS phase's own recovery.
  const preExistingIds = new Set(
    queryJson(`SELECT id FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1'`).map((s) => s.id)
  );

  const serviceSessionId = createStaleOperationalService({ businessDate });

  const reqIdA = `f10-cert-race-A-${Date.now()}`;
  const reqIdB = `f10-cert-race-B-${Date.now()}`;

  const a = fork(path.join(__dirname, "childCreaOrdine.js"), ["A", reqIdA], { env: process.env });
  const b = fork(path.join(__dirname, "childCreaOrdine.js"), ["B", reqIdB], { env: process.env });

  const aResult = new Promise((resolve, reject) => { a.on("message", resolve); a.on("error", reject); });
  const bResult = new Promise((resolve, reject) => { b.on("message", resolve); b.on("error", reject); });

  await new Promise((r) => setTimeout(r, 300));
  a.send("GO");
  b.send("GO");

  const [ra, rb] = await Promise.all([aResult, bResult]);

  const allLog = readProxyLog(proxyLogFile);
  const phaseLog = allLog.slice(beforeIdx);
  const orderAAttempts = phaseLog.filter((l) => l.path === "/ordenes" && l.method === "POST" && l.client_req_id === reqIdA).length;
  const orderBAttempts = phaseLog.filter((l) => l.path === "/ordenes" && l.method === "POST" && l.client_req_id === reqIdB).length;
  const totalRecoveryAcquireCalls = phaseLog.filter((l) => l.path === "/rpc/acquire_closeout_attempt" && l.method === "POST").length;

  const orderARecoveryAttempts = orderAAttempts > 1 ? 1 : 0;
  const orderBRecoveryAttempts = orderBAttempts > 1 ? 1 : 0;

  // Global (not session-scoped) evidence: the OLD stale session A, plus any
  // NEW operational_service_v1 session(s) that appeared during this phase.
  const allOperationalSessions = queryJson(`
    SELECT id, status, business_day_id, opened_at, closed_at
    FROM public.service_sessions WHERE lifecycle_semantics = 'operational_service_v1'
    ORDER BY opened_at
  `);
  const sessionA = allOperationalSessions.find((s) => s.id === serviceSessionId);
  const newSessions = allOperationalSessions.filter((s) => s.id !== serviceSessionId && !preExistingIds.has(s.id));

  const businessDaysToday = queryJson(`
    SELECT bd.id, bd.business_date FROM public.business_days bd
    WHERE bd.id IN (SELECT business_day_id FROM public.service_sessions WHERE id = ANY(${
      newSessions.length ? `ARRAY[${newSessions.map((s) => `'${s.id}'::uuid`).join(",")}]` : "ARRAY[]::uuid[]"
    }))
  `);

  const closeouts = queryJson(`SELECT id, service_session_id FROM public.service_closeouts WHERE service_session_id = '${serviceSessionId}'`);

  const orderASuccess = ra.result && ra.result.success === true;
  const orderBSuccess = rb.result && rb.result.success === true;
  const sessionAClosedOnce = sessionA && sessionA.status === "closed";
  const oneForgottenCloseout = closeouts.length === 1;
  const exactlyOneNewBusinessDay = businessDaysToday.length === 1;
  const exactlyOneNewOperationalService = newSessions.length === 1;
  const bothOrdersOnNewSession = orderASuccess && orderBSuccess
    && ra.result.serviceSessionId && ra.result.serviceSessionId === rb.result.serviceSessionId
    && newSessions.some((s) => s.id === ra.result.serviceSessionId);
  const insertAttemptsWithinBudget = orderAAttempts <= 2 && orderBAttempts <= 2;
  const bothOrderNumbersValid = orderASuccess && orderBSuccess
    && ra.result.serviceOrderNumber !== rb.result.serviceOrderNumber
    && Number(ra.result.serviceOrderNumber) > 0 && Number(rb.result.serviceOrderNumber) > 0;

  const pass = orderASuccess && orderBSuccess && sessionAClosedOnce && oneForgottenCloseout
    && exactlyOneNewBusinessDay && exactlyOneNewOperationalService && bothOrdersOnNewSession
    && insertAttemptsWithinBudget && bothOrderNumbersValid;

  return {
    pass,
    windowCheck,
    serviceSessionId,
    resultA: ra.result,
    resultB: rb.result,
    orderAAttempts,
    orderBAttempts,
    orderARecoveryAttempts,
    orderBRecoveryAttempts,
    totalRecoveryAcquireCalls,
    newOperationalServiceSessions: newSessions,
    newBusinessDaysCreated: businessDaysToday,
    sessionA,
    checks: {
      orderASuccess, orderBSuccess, sessionAClosedOnce, oneForgottenCloseout,
      exactlyOneNewBusinessDay, exactlyOneNewOperationalService, bothOrdersOnNewSession,
      insertAttemptsWithinBudget, bothOrderNumbersValid,
    },
  };
}

module.exports = { runTwoOrderRace, madridIntakeWindowCheck };
