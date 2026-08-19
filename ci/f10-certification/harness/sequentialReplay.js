"use strict";
// F-10.3C Phase 12 — FULL JS/V3 SEQUENTIAL REPLAY. No concurrency here (that
// starts at Phase 13) -- proves the real recovery path works at all, twice
// in a row: first = fresh close, second = idempotent convergence.
const path = require("path");
const { createStaleOperationalService } = require("./fixtures");
const { captureEvidence } = require("./evidence");

async function runSequentialReplay({ backendDir, businessDate = "2020-01-01" }) {
  const { recoverForgottenService } = require(path.join(backendDir, "src/serviceSessions/forgottenCloseRecovery"));

  const serviceSessionId = createStaleOperationalService({ businessDate });

  const first = await recoverForgottenService({ staleServiceSessionId: serviceSessionId });
  const second = await recoverForgottenService({ staleServiceSessionId: serviceSessionId });

  const evidence = captureEvidence({ serviceSessionIds: [serviceSessionId] });

  const firstIsFreshClose = first.success === true && first.idempotent !== true;
  const secondIsIdempotent = second.success === true && second.idempotent === true;
  const sessionClosed = evidence.service_sessions[0] && evidence.service_sessions[0].status === "closed";
  const rolledOverNull = evidence.service_sessions[0] && evidence.service_sessions[0].rolled_over_at === null;
  const closedBySystem = evidence.service_sessions[0] && evidence.service_sessions[0].closed_by === "system";
  const closeSourceCorrect = evidence.service_sessions[0] && evidence.service_sessions[0].close_source === "abandoned_forgotten_close";
  const exactlyOneCloseout = evidence.counts.service_closeouts === 1;
  const noActiveAttempts = evidence.counts.active_closeout_attempts === 0;

  const pass = firstIsFreshClose && secondIsIdempotent && sessionClosed && rolledOverNull
    && closedBySystem && closeSourceCorrect && exactlyOneCloseout && noActiveAttempts;

  return {
    pass,
    serviceSessionId,
    first,
    second,
    checks: {
      firstIsFreshClose, secondIsIdempotent, sessionClosed, rolledOverNull,
      closedBySystem, closeSourceCorrect, exactlyOneCloseout, noActiveAttempts,
    },
    evidence,
  };
}

module.exports = { runSequentialReplay };
