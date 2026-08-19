"use strict";
// F-10.3C Phase 14 — TRUE CONCURRENT RESIDUE RECOVERY. Same barrier-synced
// two-child pattern as Phase 13, but Service A carries one real operational
// residue order (EN_COCINA) with one real unpaid financial exposure before
// recovery starts. Asserts the REAL v3IncidentPolicy.js classification
// fired correctly (KITCHEN_WORK_PENDING_AT_CLOSE + UNPAID_BALANCE_AT_CLOSE)
// and that the child order's own truth is never touched by recovery (still
// EN_COCINA -- no fake RETIRADO/payment/delivery/table completion; the
// order never had a table_session_id or delivery/rider attribution to begin
// with, so those specific fabrications are structurally impossible here,
// not merely unobserved).
const { fork } = require("child_process");
const path = require("path");
const { createStaleOperationalService, insertResidueOrder } = require("./fixtures");
const { captureEvidence } = require("./evidence");

async function runConcurrentResidueRecovery({ businessDate = "2020-01-03" } = {}) {
  const serviceSessionId = createStaleOperationalService({ businessDate });
  const orderId = "#F10CI-" + Date.now();
  insertResidueOrder({
    serviceSessionId,
    orderId,
    estado: "EN_COCINA",
    totale: 10.0,
    yaPagado: false,
    cobrado: false,
  });

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
  const exactlyOneCloseout = evidence.counts.service_closeouts === 1;

  const opIncidents = evidence.service_incidents.filter((i) => i.incident_type === "KITCHEN_WORK_PENDING_AT_CLOSE");
  const finIncidents = evidence.service_incidents.filter((i) => i.incident_type === "UNPAID_BALANCE_AT_CLOSE");
  const exactlyOneOperationalIncident = opIncidents.length === 1;
  const exactlyOneFinancialIncident = finIncidents.length === 1;
  const financialExposureRecorded = evidence.service_closeouts[0] && evidence.service_closeouts[0].unpaid_exposure_cents > 0;
  const incidentDedupeHolds = evidence.counts.service_incidents === 2; // exactly one of each, no duplicate from the concurrent second caller

  const order = evidence.orders.find((o) => o.id === orderId);
  const orderStillEnCocina = order && order.estado === "EN_COCINA";

  const pass = aOk && bOk && exactlyOneFresh && exactlyOneIdempotent && exactlyOneCloseout
    && exactlyOneOperationalIncident && exactlyOneFinancialIncident && financialExposureRecorded
    && incidentDedupeHolds && orderStillEnCocina;

  return {
    pass,
    serviceSessionId,
    orderId,
    processAPid: ra.pid,
    processBPid: rb.pid,
    resultA: ra.result,
    resultB: rb.result,
    checks: {
      aOk, bOk, exactlyOneFresh, exactlyOneIdempotent, exactlyOneCloseout,
      exactlyOneOperationalIncident, exactlyOneFinancialIncident, financialExposureRecorded,
      incidentDedupeHolds, orderStillEnCocina,
    },
    evidence,
  };
}

module.exports = { runConcurrentResidueRecovery };
