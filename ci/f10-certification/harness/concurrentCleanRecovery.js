"use strict";
// F-10.3C Phase 13 — TRUE CONCURRENT CLEAN RECOVERY. Two REAL Node child
// processes, synchronized via an IPC barrier, both call
// recoverForgottenService(A) as close together as possible. Neither may
// mock V3 or the DB. One may converge as a fresh close, the other as an
// idempotent convergence -- neither may hard-fail.
const { fork } = require("child_process");
const path = require("path");
const { createStaleOperationalService } = require("./fixtures");
const { captureEvidence } = require("./evidence");

async function runConcurrentCleanRecovery({ businessDate = "2020-01-02" } = {}) {
  const serviceSessionId = createStaleOperationalService({ businessDate });

  const a = fork(path.join(__dirname, "childRecovery.js"), ["A", serviceSessionId], { env: process.env });
  const b = fork(path.join(__dirname, "childRecovery.js"), ["B", serviceSessionId], { env: process.env });

  const aResult = new Promise((resolve, reject) => { a.on("message", resolve); a.on("error", reject); });
  const bResult = new Promise((resolve, reject) => { b.on("message", resolve); b.on("error", reject); });

  await new Promise((r) => setTimeout(r, 300));
  a.send("GO");
  b.send("GO");

  const [ra, rb] = await Promise.all([aResult, bResult]);

  const evidence = captureEvidence({ serviceSessionIds: [serviceSessionId] });

  const aOk = ra.result.success === true;
  const bOk = rb.result.success === true;
  const exactlyOneFresh = [ra.result, rb.result].filter((r) => r.success === true && r.idempotent !== true).length === 1;
  const exactlyOneIdempotent = [ra.result, rb.result].filter((r) => r.success === true && r.idempotent === true).length === 1;
  const session = evidence.service_sessions[0];
  const sessionClosedOnce = session && session.status === "closed";
  const exactlyOneCloseout = evidence.counts.service_closeouts === 1;
  const noActiveAttempts = evidence.counts.active_closeout_attempts === 0;
  const rolledOverNull = session && session.rolled_over_at === null;
  const closedBySystem = session && session.closed_by === "system";
  const closeSourceCorrect = session && session.close_source === "abandoned_forgotten_close";
  const noServiceBCreated = evidence.counts.service_sessions === 1; // scoped query, so this only ever proves what it directly checked -- see runAll.js's separate global count for the real "no Service B" proof.

  const pass = aOk && bOk && exactlyOneFresh && exactlyOneIdempotent && sessionClosedOnce
    && exactlyOneCloseout && noActiveAttempts && rolledOverNull && closedBySystem && closeSourceCorrect;

  return {
    pass,
    serviceSessionId,
    processAPid: ra.pid,
    processBPid: rb.pid,
    resultA: ra.result,
    resultB: rb.result,
    checks: {
      aOk, bOk, exactlyOneFresh, exactlyOneIdempotent, sessionClosedOnce,
      exactlyOneCloseout, noActiveAttempts, rolledOverNull, closedBySystem, closeSourceCorrect, noServiceBCreated,
    },
    evidence,
  };
}

module.exports = { runConcurrentCleanRecovery };
