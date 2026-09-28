"use strict";
// SERVICE LIFECYCLE / P0-C3 — behavioural contract for
// src/serviceSessions/previousBusinessDayResidue.js against fake dependencies
// (no live DB — create_service_incident's own idempotency/dedupe is proven
// separately, both statically and against the real service_incidents_dedupe_uq
// index in tests/serviceCloseoutIncidentsFoundation.static.test.js /
// tests/serviceIncidents.test.js). This file's own scope: does the
// reconciler scan the right sessions, skip the right ones, classify
// financial-vs-operational correctly, and stay non-fatal on a partial
// failure?
//
// STALE PAYMENT MIRROR (H1): the classification and the exposure come from the
// canonical settlement (latest order_obligations revision, else ordenes.totale,
// minus the order's net order_financial_events), never from ya_pagado/cobrado or
// the raw totale — sections 9-11.

const { createResidueReconciler, RESIDUE_INCIDENT_TYPE } = require("../src/serviceSessions/previousBusinessDayResidue");

let pass = 0, fail = 0;
const assert = (n, c, d = "") => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  -> " + d : "")); } };

// language-guard: allow-legacy PRANZO is the existing service_kind enum value, exercised verbatim throughout this file's fixtures, not new vocabulary
const staleSession = (o = {}) => ({ id: "A", business_date: "2026-08-10", service_kind: "PRANZO", ...o });
const staleOrder = (o = {}) => ({ id: "#1", service_session_id: "A", estado: "EN_COCINA", totale: 10, ya_pagado: false, table_session_id: null, ...o });
const payment = (orderId, amount, o = {}) => ({ order_id: orderId, service_session_id: "A", type: "payment", amount, ...o });
const openTable = (o = {}) => ({ id: "ts-1", service_session_id: "A", status: "open", ...o });

function fakeEnv({ staleSessions = [staleSession()], closeoutsBySession = { A: "corr-A" }, ordersBySession = {}, tablesBySession = {}, obligations = [], events = [] } = {}) {
  const env = { calls: { select: [], report: [] }, reportImpl: null };
  env.select = async (table, query) => {
    env.calls.select.push({ table, query });
    if (table === "service_sessions") return staleSessions;
    if (table === "service_closeouts") {
      const m = /service_session_id=eq\.([^&]+)/.exec(query);
      const sid = m && decodeURIComponent(m[1]);
      const corr = closeoutsBySession[sid];
      return corr ? [{ closeout_correlation_id: corr }] : [];
    }
    if (table === "ordenes") {
      const m = /service_session_id=eq\.([^&]+)/.exec(query);
      const sid = m && decodeURIComponent(m[1]);
      return ordersBySession[sid] || [];
    }
    if (table === "table_sessions") {
      const m = /service_session_id=eq\.([^&]+)/.exec(query);
      const sid = m && decodeURIComponent(m[1]);
      return tablesBySession[sid] || [];
    }
    // The canonical settlement reads: the fakes return every configured row and
    // the module matches them itself (the real endpoint filters server-side).
    if (table === "order_obligations") return obligations;
    if (table === "order_financial_events") return events;
    throw new Error("unexpected table " + table);
  };
  env.incidents = {
    async report(args) {
      env.calls.report.push(args);
      if (env.reportImpl) return env.reportImpl(args);
      return { success: true, created: true, code: "RECORDED", incident: { id: "inc-" + env.calls.report.length } };
    },
  };
  env.resolveCurrentBusinessDate = async () => "2026-08-11";
  return env;
}

const make = (env) => createResidueReconciler({
  select: env.select, incidents: env.incidents, resolveCurrentBusinessDate: env.resolveCurrentBusinessDate,
});

(async () => {
  console.log("\n══ 1. actor/business-date safety ══");
  {
    const env = fakeEnv();
    for (const bad of [undefined, null, "", "   "]) {
      const r = await make(env)({ actor: bad });
      assert(`actor ${JSON.stringify(bad)} -> INVALID_ACTOR, no scan attempted`, r.success === false && r.code === "INVALID_ACTOR");
    }
    assert("no select call was ever made for a bad actor", env.calls.select.length === 0);
  }
  {
    const env = fakeEnv({ staleSessions: [] });
    env.resolveCurrentBusinessDate = async () => null;
    const r = await make(env)({ actor: "owner" });
    assert("no resolvable current business_date -> NO_CURRENT_BUSINESS_DATE, never falls back to a wall-clock guess", r.success === false && r.code === "NO_CURRENT_BUSINESS_DATE");
  }
  {
    const env = fakeEnv();
    await make(env)({ actor: "owner", currentBusinessDate: "2026-08-12" });
    assert("an explicitly-passed currentBusinessDate is used as-is, never re-resolved", !env.calls.select.some((c) => false)); // resolveCurrentBusinessDate simply never called — see next assert
    // proven precisely: env.resolveCurrentBusinessDate is never invoked when currentBusinessDate is supplied.
    let resolverCalled = false;
    const env2 = fakeEnv();
    env2.resolveCurrentBusinessDate = async () => { resolverCalled = true; return "2026-08-11"; };
    await make(env2)({ actor: "owner", currentBusinessDate: "2026-08-12" });
    assert("resolveCurrentBusinessDate is skipped entirely when currentBusinessDate is explicitly passed", resolverCalled === false);
  }

  console.log("\n══ 2. session scan scope ══");
  {
    const env = fakeEnv();
    await make(env)({ actor: "owner" });
    const scan = env.calls.select.find((c) => c.table === "service_sessions");
    assert("scans strictly OLDER business_date than current (lt., not lte.)", /business_date=lt\.2026-08-11/.test(scan.query));
    assert("scans open/closing/rolled_over — never 'closed' (V2/V3 destructive close already archived everything)", /status=in\.\(open,closing,rolled_over\)/.test(scan.query));
    assert("never touches 'closed' literally as an included status", !/status=in\.\([^)]*\bclosed\b/.test(scan.query));
  }
  {
    const env = fakeEnv({ staleSessions: [] });
    const r = await make(env)({ actor: "owner" });
    assert("no stale sessions -> NO_RESIDUE, zero incidents, zero further reads", r.success === true && r.code === "NO_RESIDUE" && r.scannedSessions === 0);
    assert("no closeout/orders/table_sessions reads attempted when nothing is stale", env.calls.select.length === 1);
  }
  {
    const env = fakeEnv({ staleSessions: null });
    env.select = async (table) => { if (table === "service_sessions") throw new Error("db down"); return []; };
    const r = await make(env)({ actor: "owner" });
    assert("session scan read error -> RESIDUE_SESSION_SCAN_FAILED, not a false NO_RESIDUE", r.success === false && r.code === "RESIDUE_SESSION_SCAN_FAILED");
  }

  console.log("\n══ 3. a stale session with no closeout row is skipped, not guessed ══");
  {
    const env = fakeEnv({ closeoutsBySession: {}, ordersBySession: { A: [staleOrder()] } });
    const r = await make(env)({ actor: "owner" });
    assert("no dedupe-safe correlation id -> session skipped entirely, counted as a scan error", r.success === true && r.scanErrors === 1);
    assert("zero incidents reported for a session with no closeout row", r.ordersReported === 0 && env.calls.report.length === 0);
  }

  console.log("\n══ 4. financial vs operational classification ══");
  {
    const env = fakeEnv({ ordersBySession: { A: [staleOrder({ id: "#unpaid", ya_pagado: false, totale: 12.5 })] } });
    const r = await make(env)({ actor: "owner" });
    assert("unpaid residue -> category 'financial'", env.calls.report[0].category === "financial");
    assert("unpaid residue carries the real exposure in cents", env.calls.report[0].financialExposureCents === 1250);
    assert("incidentType is the exact residue classification", env.calls.report[0].incidentType === RESIDUE_INCIDENT_TYPE);
    assert("ordersReported reflects it", r.ordersReported === 1);
  }
  {
    // Paid = the LEDGER covers the obligation (a canonical payment event), the
    // mirror agreeing or not.
    const env = fakeEnv({ ordersBySession: { A: [staleOrder({ id: "#paid", ya_pagado: true, totale: 12.5 })] }, events: [payment("#paid", 12.5)] });
    await make(env)({ actor: "owner" });
    assert("paid residue -> category 'operational', never 'financial'", env.calls.report[0].category === "operational");
    assert("paid residue carries NO financial exposure (money already settled)", env.calls.report[0].financialExposureCents === null);
  }
  console.log("\n══ 5. previous-business-date OPEN TABLE is its own residue entity ══");
  {
    const env = fakeEnv({ tablesBySession: { A: [openTable()] } });
    const r = await make(env)({ actor: "owner" });
    assert("an open table with zero orders still gets flagged", r.tablesReported === 1);
    assert("table residue is category 'operational', entityType 'table_session'", env.calls.report[0].category === "operational" && env.calls.report[0].entityType === "table_session");
    assert("table residue's entityId is the table_session's own id", env.calls.report[0].entityId === "ts-1");
  }
  {
    const env = fakeEnv({
      ordersBySession: { A: [staleOrder()] },
      tablesBySession: { A: [openTable()] },
    });
    const r = await make(env)({ actor: "owner" });
    assert("an order and its table both get independently reported — no collision (different entity_type/entity_id)", r.ordersReported === 1 && r.tablesReported === 1 && env.calls.report.length === 2);
  }

  console.log("\n══ 6. idempotency + partial-failure resilience ══");
  {
    const env = fakeEnv({ ordersBySession: { A: [staleOrder()] } });
    env.reportImpl = () => ({ success: true, created: false, code: "ALREADY_RECORDED", incident: { id: "inc-existing" } });
    const r = await make(env)({ actor: "owner" });
    assert("a repeat reconciliation reports created:false, counted as alreadyRecorded not newIncidents", r.newIncidents === 0 && r.alreadyRecorded === 1);
  }
  {
    const env = fakeEnv({ ordersBySession: { A: [staleOrder({ id: "#1" }), staleOrder({ id: "#2" })] } });
    let call = 0;
    env.reportImpl = () => { call++; if (call === 1) throw new Error("transport down"); return { success: true, created: true, code: "RECORDED", incident: {} }; };
    const r = await make(env)({ actor: "owner" });
    assert("one entity's report() throwing does not abort the loop — the other entity is still processed", env.calls.report.length === 2 && r.ordersReported === 2);
    assert("the thrown failure is counted, not silently swallowed", r.failed === 1 && r.newIncidents === 1);
  }

  console.log("\n══ 7. never mutates canonical state ══");
  {
    const env = fakeEnv({ ordersBySession: { A: [staleOrder()] }, tablesBySession: { A: [openTable()] } });
    await make(env)({ actor: "owner" });
    const selectCallsOnly = env.calls.select.filter((c) => c.table === "ordenes" || c.table === "table_sessions");
    assert("ordenes/table_sessions were actually read at least once each (the scenario has real residue to find)", selectCallsOnly.some((c) => c.table === "ordenes") && selectCallsOnly.some((c) => c.table === "table_sessions"));
    assert("report() args never include an estado/status write field — this module never constructs one", env.calls.report.every((r) => !("estado" in r) && !("status" in r)));
  }
  {
    // Structural: the module has exactly three injectable dependencies
    // (select, incidents, resolveCurrentBusinessDate) — no sbUpdate/sbUpsert/
    // sbInsert/sbDelete capability exists anywhere in it to mutate with.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "serviceSessions", "previousBusinessDayResidue.js"), "utf8");
    assert("source never references sbUpdate/sbUpsert/sbInsert/sbDelete", !/\bsb(Update|Upsert|Insert|Delete)\b/.test(source));
  }

  console.log("\n══ 8. multiple stale sessions across different business dates ══");
  {
    const env = fakeEnv({
      staleSessions: [staleSession({ id: "A", business_date: "2026-08-10" }), staleSession({ id: "Z", business_date: "2026-08-09" })],
      closeoutsBySession: { A: "corr-A", Z: "corr-Z" },
      ordersBySession: { A: [staleOrder({ service_session_id: "A" })], Z: [staleOrder({ id: "#old", service_session_id: "Z" })] },
    });
    const r = await make(env)({ actor: "owner" });
    assert("a reconciliation missed for more than one day still catches up both in one call", r.scannedSessions === 2 && r.ordersReported === 2);
  }

  console.log("\n══ 9. STALE PAYMENT MIRROR: economic vs operational residue from the canonical settlement ══");
  {
    // Oracle per order: obligation = latest revision (else totale); net = payment + payment_imported − refund of the
    // order's own (service, id); outstanding > 0 -> financial / outstanding cents; else operational / null.
    const UID = (n) => `00000000-0000-4000-8000-00000000000${n}`;
    const rev = (n, revision, gross) => ({ order_uid: UID(n), order_id: `#${n}`, revision, gross_amount: gross });
    const cases = [
      // key, order, revisions, events, expected category, exposure, residue
      ["A 100 -> pay60 -> adj60", staleOrder({ id: "#1", order_uid: UID(1), totale: 100 }), [rev(1, 1, 100), rev(1, 2, 60)], [payment("#1", 60)], "operational", null, "NONE"],
      ["B 100 -> pay60 -> adj40", staleOrder({ id: "#2", order_uid: UID(2), totale: 100 }), [rev(2, 1, 100), rev(2, 2, 40)], [payment("#2", 60)], "operational", null, "OVER_COLLECTED"],
      ["C 100 -> pay40 -> adj60", staleOrder({ id: "#3", order_uid: UID(3), totale: 100 }), [rev(3, 1, 100), rev(3, 2, 60)], [payment("#3", 40)], "financial", 2000, "RECEIVABLE"],
      ["D ordinary unpaid", staleOrder({ id: "#4", order_uid: UID(4), totale: 100 }), [rev(4, 1, 100)], [], "financial", 10000, "RECEIVABLE"],
      ["E ordinary fully paid", staleOrder({ id: "#5", order_uid: UID(5), totale: 100, ya_pagado: true, cobrado: true }), [rev(5, 1, 100)], [payment("#5", 100)], "operational", null, "NONE"],
      ["F mirror false, ledger settled (mixed tender)", staleOrder({ id: "#6", order_uid: UID(6), totale: 100, ya_pagado: false, cobrado: false }), [rev(6, 1, 100), rev(6, 2, 60)], [payment("#6", 30), payment("#6", 30, { payment_method: "tarjeta" })], "operational", null, "NONE"],
      ["G legacy paid mirror, no ledger", staleOrder({ id: "#7", order_uid: null, totale: 100, ya_pagado: true, cobrado: true }), [], [], "financial", 10000, "RECEIVABLE"],
      ["G' legacy imported", staleOrder({ id: "#8", order_uid: null, totale: 100, ya_pagado: true }), [], [payment("#8", 100, { type: "payment_imported" })], "operational", null, "NONE"],
      ["H Mesa command, settled after adjustment", staleOrder({ id: "#9", order_uid: UID(9), totale: 100, table_session_id: "ts-9" }), [rev(9, 1, 100), rev(9, 2, 60)], [payment("#9", 60)], "operational", null, "NONE"],
    ];
    for (const [key, order, obligations, events, category, exposure, residue] of cases) {
      const env = fakeEnv({ ordersBySession: { A: [order] }, obligations, events });
      const r = await make(env)({ actor: "owner" });
      const call = env.calls.report[0];
      assert(`${key}: category ${category}`, call.category === category, JSON.stringify(call));
      assert(`${key}: exposure ${exposure}`, call.financialExposureCents === exposure, String(call.financialExposureCents));
      assert(`${key}: economic residue ${residue}, operational residue kept (estado)`,
        r.incidents[0].economic.residue === residue && r.incidents[0].operational.estado === order.estado, JSON.stringify(r.incidents[0]));
    }
    const env = fakeEnv({ ordersBySession: { A: [staleOrder({ id: "#2", order_uid: UID(2), totale: 100 })] }, obligations: [rev(2, 1, 100), rev(2, 2, 40)], events: [payment("#2", 60)] });
    const r = await make(env)({ actor: "owner" });
    assert("B: the over-collection stays visible in the returned economic facts", r.incidents[0].economic.overCollected === 20 && r.incidents[0].economic.outstanding === 0);
    const envG = fakeEnv({ ordersBySession: { A: [staleOrder({ id: "#7", order_uid: null, totale: 100, ya_pagado: true, cobrado: true })] } });
    const rG = await make(envG)({ actor: "owner" });
    assert("G: the mirror conflict is flagged, never read as money", rG.incidents[0].economic.legacyPaymentConflict === true && rG.incidents[0].economic.payState === "unpaid");
    const envX = fakeEnv({ ordersBySession: { A: [staleOrder({ id: "#1", order_uid: UID(1), totale: 100 })] }, obligations: [rev(1, 1, 100)], events: [payment("#1", 100, { service_session_id: "OTHER" })] });
    await make(envX)({ actor: "owner" });
    assert("an event of the same display id in ANOTHER service does not settle this order", envX.calls.report[0].category === "financial" && envX.calls.report[0].financialExposureCents === 10000);
  }

  console.log("\n══ 10. no N+1: settlement reads are per SESSION, not per order ══");
  {
    const orders = Array.from({ length: 12 }, (_, i) => staleOrder({ id: `#${i + 1}` }));
    const env = fakeEnv({ ordersBySession: { A: orders } });
    await make(env)({ actor: "owner" });
    const n = (t) => env.calls.select.filter((c) => c.table === t).length;
    assert("12 orders -> exactly 1 order_financial_events read", n("order_financial_events") === 1);
    assert("12 orders -> exactly 1 order_obligations read (Class A present) or 0 (none)", n("order_obligations") <= 1);
    const q = env.calls.select.find((c) => c.table === "order_financial_events").query;
    assert("the events read is scoped to the session and the scanned ids", /service_session_id=in\.\(A\)/.test(q) && /order_id=in\.\(/.test(q));
  }

  console.log("\n══ 11. an unreadable ledger never produces a guessed incident ══");
  {
    const env = fakeEnv({ ordersBySession: { A: [staleOrder()] } });
    const inner = env.select;
    env.select = async (table, query) => { if (table === "order_financial_events") throw new Error("ledger down"); return inner(table, query); };
    const r = await make(env)({ actor: "owner" });
    assert("settlement read error -> session skipped as a scan error, zero incidents recorded", r.scanErrors === 1 && env.calls.report.length === 0);
  }

  console.log("\n=== RESULT: " + pass + " passed, " + fail + " failed ===");
  process.exit(fail === 0 ? 0 : 1);
})();
