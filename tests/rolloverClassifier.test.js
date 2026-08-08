"use strict";
// SERVICE CLOSEOUT V2 / Slice 3 — pure tests for classifyForIncidentSafeRollover.
// No DB, no RPC — just data in, classification out.

const { classifyForIncidentSafeRollover } = require("../src/serviceSessions/rolloverClassifier");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

const SESSION = { id: "s1", business_date: "2026-08-08", service_kind: "PRANZO" };

(async () => {
  console.log("\n== classifyForIncidentSafeRollover ==\n");

  console.log("── clean session, zero activity -> zero incidents, zero blockers ──");
  {
    const r = classifyForIncidentSafeRollover({ session: SESSION, orders: [], tableSessions: [], financialEvents: [] });
    assert("1a: no hard blockers", r.hardBlockers.length === 0);
    assert("1b: no informational incidents", r.informationalIncidents.length === 0);
    assert("1c: no operational incidents", r.operationalIncidents.length === 0);
    assert("1d: no financial incidents", r.financialIncidents.length === 0);
    assert("1e: no safe auto actions", r.safeAutoActions.length === 0);
    assert("1f: snapshot payload still built", r.snapshotPayload.businessDate === "2026-08-08" && r.snapshotPayload.ordersCount === 0);
  }

  console.log("\n── integrity: missing session identity is a hard blocker ──");
  {
    const r = classifyForIncidentSafeRollover({ session: { id: "s2" }, orders: [], tableSessions: [], financialEvents: [] });
    assert("2: SESSION_IDENTITY_INVALID hard blocker", r.hardBlockers.some((b) => b.code === "SESSION_IDENTITY_INVALID"));
  }

  console.log("\n── operational: every non-terminal order becomes an incident, never a blocker ──");
  {
    const orders = [
      { id: "o1", estado: "EN_COCINA", totale: 10 },
      { id: "o2", estado: "LISTO", totale: 12 },
      { id: "o3", estado: "EN_ENTREGA", totale: 8 },
      { id: "o4", estado: "POR_CONFIRMAR", totale: 5 },
      { id: "o5", estado: "NUEVO", totale: 6 },
      { id: "o6", estado: "RETIRADO", totale: 9 },   // terminal — must be ignored
      { id: "o7", estado: "COMPLETADO", totale: 4 }, // terminal — must be ignored
      { id: "o8", estado: "SOME_UNKNOWN_STATE", totale: 3 },
    ];
    const r = classifyForIncidentSafeRollover({ session: SESSION, orders, tableSessions: [], financialEvents: [] });
    assert("3a: zero hard blockers — pending operational work is never a blocker", r.hardBlockers.length === 0);
    assert("3b: 6 operational incidents (o1-o5, o8; o6/o7 terminal, excluded)", r.operationalIncidents.length === 6, JSON.stringify(r.operationalIncidents));
    const byOrder = Object.fromEntries(r.operationalIncidents.map((i) => [i.orderId, i]));
    assert("3c: EN_COCINA -> KITCHEN_WORK_PENDING_AT_CLOSE, warning", byOrder.o1.incidentType === "KITCHEN_WORK_PENDING_AT_CLOSE" && byOrder.o1.severity === "warning");
    assert("3d: LISTO -> ORDER_READY_NOT_FINALIZED_AT_CLOSE, warning", byOrder.o2.incidentType === "ORDER_READY_NOT_FINALIZED_AT_CLOSE" && byOrder.o2.severity === "warning");
    assert("3e: EN_ENTREGA -> DELIVERY_ACTIVE_AT_CLOSE, warning", byOrder.o3.incidentType === "DELIVERY_ACTIVE_AT_CLOSE" && byOrder.o3.severity === "warning");
    assert("3f: POR_CONFIRMAR -> ORDER_UNCONFIRMED_AT_CLOSE, info", byOrder.o4.incidentType === "ORDER_UNCONFIRMED_AT_CLOSE" && byOrder.o4.severity === "info");
    assert("3g: NUEVO -> ORDER_UNCONFIRMED_AT_CLOSE, info", byOrder.o5.incidentType === "ORDER_UNCONFIRMED_AT_CLOSE" && byOrder.o5.severity === "info");
    assert("3h: unrecognized non-terminal state -> generic ORDER_STATE_UNRESOLVED_AT_CLOSE, never silently dropped", byOrder.o8.incidentType === "ORDER_STATE_UNRESOLVED_AT_CLOSE" && byOrder.o8.severity === "warning");
    assert("3i: category is always operational, entityType order", r.operationalIncidents.every((i) => i.category === "operational" && i.entityType === "order"));
  }

  console.log("\n── financial: unpaid balance becomes a financial incident with authoritative exposure ──");
  {
    const orders = [
      { id: "o1", estado: "RETIRADO", totale: 62.5 }, // terminal, but STILL unpaid — must still get a financial incident
      { id: "o2", estado: "RETIRADO", totale: 20 },   // fully paid, no incident
    ];
    const financialEvents = [
      { order_id: "o2", type: "payment", amount: 20, payment_method: "efectivo" },
    ];
    const r = classifyForIncidentSafeRollover({ session: SESSION, orders, tableSessions: [], financialEvents });
    assert("4a: exactly one financial incident (o1, unpaid)", r.financialIncidents.length === 1, JSON.stringify(r.financialIncidents));
    assert("4b: financial_exposure_cents is 6250 (62.50 EUR), authoritative from the ledger aggregator", r.financialIncidents[0].financialExposureCents === 6250, JSON.stringify(r.financialIncidents[0]));
    assert("4c: incidentType UNPAID_BALANCE_AT_CLOSE, category financial, severity warning", r.financialIncidents[0].incidentType === "UNPAID_BALANCE_AT_CLOSE" && r.financialIncidents[0].category === "financial" && r.financialIncidents[0].severity === "warning");
    assert("4d: the fully-paid order (o2) gets no financial incident", !r.financialIncidents.some((i) => i.orderId === "o2"));
    assert("4e: an unpaid TERMINAL order is not a hard blocker either — it survives as a fact only", r.hardBlockers.length === 0);
  }

  console.log("\n── financial: partial payment also counts as unpaid exposure ──");
  {
    const orders = [{ id: "o1", estado: "RETIRADO", totale: 100 }];
    const financialEvents = [{ order_id: "o1", type: "payment", amount: 40, payment_method: "tarjeta" }];
    const r = classifyForIncidentSafeRollover({ session: SESSION, orders, tableSessions: [], financialEvents });
    assert("5: partial payment (40/100) -> financial_exposure_cents 6000", r.financialIncidents.length === 1 && r.financialIncidents[0].financialExposureCents === 6000, JSON.stringify(r.financialIncidents));
  }

  console.log("\n── financial: a voided/cancelled order is never treated as unpaid ──");
  {
    const orders = [{ id: "o1", estado: "CANCELADO", totale: 30 }];
    const r = classifyForIncidentSafeRollover({ session: SESSION, orders, tableSessions: [], financialEvents: [] });
    assert("6: cancelled order produces no financial incident", r.financialIncidents.length === 0);
  }

  console.log("\n── informational/auto-resolvable: a truly empty open table -> safe auto action + informational incident ──");
  {
    const tableSessions = [
      { id: "t1", table_id: 5, status: "open", covers_total: null, workspace_id: "ws1" },
      { id: "t2", table_id: 6, status: "open", covers_total: 4, workspace_id: "ws1" }, // real activity — must NOT be touched
      { id: "t3", table_id: 7, status: "closed", covers_total: null, workspace_id: "ws1" }, // not open — irrelevant
    ];
    const r = classifyForIncidentSafeRollover({ session: SESSION, orders: [], tableSessions, financialEvents: [] });
    assert("7a: exactly one safe auto action (t1, truly empty)", r.safeAutoActions.length === 1, JSON.stringify(r.safeAutoActions));
    assert("7b: safe auto action targets t1 with its workspace id", r.safeAutoActions[0].type === "RELEASE_EMPTY_TABLE" && r.safeAutoActions[0].tableSessionId === "t1" && r.safeAutoActions[0].workspaceId === "ws1");
    assert("7c: exactly one informational incident (EMPTY_TABLE_LEFT_OPEN)", r.informationalIncidents.length === 1 && r.informationalIncidents[0].incidentType === "EMPTY_TABLE_LEFT_OPEN");
    assert("7d: informational incident is marked auto-resolved", r.informationalIncidents[0].autoResolve === true && r.informationalIncidents[0].autoResolutionType === "auto_released_empty_table");
    assert("7e: severity info, category informational", r.informationalIncidents[0].severity === "info" && r.informationalIncidents[0].category === "informational");
    assert("7f: the NON-EMPTY open table (t2) is left completely alone — no auto action, no incident, still subject to the existing MESA_TABLES_NOT_RELEASED gate", !r.safeAutoActions.some((a) => a.tableSessionId === "t2") && !r.informationalIncidents.some((i) => i.tableSessionId === "t2"));
    assert("7g: a truly-empty CLOSED table (t3) is not touched — nothing to release", !r.safeAutoActions.some((a) => a.tableSessionId === "t3"));
    assert("7h: none of this is ever a hard blocker", r.hardBlockers.length === 0);
  }

  console.log("\n== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
