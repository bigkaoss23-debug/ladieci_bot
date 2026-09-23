"use strict";
// DELIVERY x ECONOMY DECOUPLING V1 (migration 139) -- POST-CLOSE OPERATOR COLLECTION.
//
// THE PRODUCT RULE. An order was delivered (RETIRADO), the money was not collected, the service was finalized.
// Later the operator learns for certain that the customer paid. The operator must be able to register it NOW --
// without waiting for the rider, without waiting for a new service, without reopening the original one.
//
// The reader stays READ-ONLY; what it owes the surface is an HONEST statement of which pendency can be collected
// (`allowedActions: ['COLLECT']`) and the delivery fact next to the money fact (`deliveryState`). The write itself
// is the EXISTING Cash V1 payment (order_post_payment_v1, proven on real PostgreSQL by the deliveryEconomyDecoupling
// harness, sections P*/C*), never a new writer.
//
//   CLOSED + RETIRADO (any channel) + unpaid + permanent identity  -> COLLECT
//   CLOSED + EN_ENTREGA + unpaid                                    -> [] (Entrega sin confirmar: no plain collection)
//   force-closed / Mesa / no identity / over-collected              -> []
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  createPendingExposures, allowedActionsFor, deliveryStateOf, isDeliveredEstado,
} = require("../src/economy/pendingExposures");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const atest = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ FAIL: ${name}\n    ${error && error.stack}`); process.exitCode = 1; }
};

const WS = "ws-1";
const NOW = new Date("2026-09-18T12:00:00.000Z");
const CLOSED = Object.freeze({ id: "svc-closed", business_date: "2026-09-17", status: "closed", opened_at: "2026-09-17T09:00:00Z", closed_at: "2026-09-17T23:30:00Z", service_kind: "SERA" });
const OPEN = Object.freeze({ id: "svc-open", business_date: "2026-09-18", status: "open", opened_at: "2026-09-18T09:00:00Z", closed_at: null, service_kind: "SERA" });

let seq = 0;
const DELIVERY = { tipo_consegna: "DOMICILIO" }; // language-guard: allow-legacy tipo_consegna/DOMICILIO are the existing ordenes column/literal, reproduced verbatim in this fixture
const PICKUP = { tipo_consegna: "RITIRO" }; // language-guard: allow-legacy tipo_consegna/RITIRO are the existing ordenes column/literal, reproduced verbatim in this fixture
const order = (o) => {
  seq += 1;
  return Object.freeze({
    id: `#${seq}`, order_uid: `uid-${seq}`, service_session_id: CLOSED.id, table_session_id: null,
    estado: "RETIRADO", totale: 12.5, ...DELIVERY, nombre: "Cliente", tel: "600000000",
    created_at: "2026-09-17T20:00:00Z", ...o,
  });
};
const receipt = (o, amount, overrides = {}) => Object.freeze({
  id: `evt-${o.id}-${amount}`, order_id: o.id, service_session_id: o.service_session_id, event_service_session_id: null,
  type: "payment", amount, payment_method: "efectivo", created_at: "2026-09-18T00:10:00Z", ...overrides,
});
const pending = (ordenes, events = [], extra = {}) => createPendingExposures({
  select: createMemorySelect({
    ordenes, storico: [], order_financial_events: events, order_obligations: [], // language-guard: allow-legacy storico is the real archive table key the memory select needs, not new vocabulary
    service_sessions: [OPEN, CLOSED], table_sessions: [], ...extra,
  }),
})({ workspaceId: WS, now: NOW });

(async () => {
  await atest("1 · CLOSED service, RETIRADO domicilio, unpaid 12,50 -> a historical pending that CAN be collected, delivery ENTREGADO", async () => {
    const p = await pending([order({ order_uid: "uid-a" })]);
    assert.strictEqual(p.totals.porCobrar, 12.5);
    const item = p.porCobrar[0];
    assert.strictEqual(item.orderUid, "uid-a");
    assert.deepStrictEqual([...item.allowedActions], ["COLLECT"]);
    assert.strictEqual(item.deliveryState, "ENTREGADO");
    assert.strictEqual(item.serviceSessionId, CLOSED.id, "the sale stays attributed to the CLOSED service");
    assert.strictEqual(item.direction, "POR_COBRAR");
  });

  await atest("1b · the same for a PICKUP order (RETIRADO + unpaid): collectable, but no delivery fact to state", async () => {
    const item = (await pending([order({ ...PICKUP })])).porCobrar[0];
    assert.deepStrictEqual([...item.allowedActions], ["COLLECT"]);
    assert.strictEqual(item.deliveryState, null);
  });

  await atest("2 · EN_ENTREGA + unpaid on a closed service stays 'Entrega sin confirmar' and offers NO collection", async () => {
    const item = (await pending([order({ estado: "EN_ENTREGA" })])).porCobrar[0];
    assert.strictEqual(item.deliveryState, "SIN_CONFIRMAR");
    assert.deepStrictEqual([...item.allowedActions], [], "a plain 'Registrar cobro' would falsify the delivery");
  });

  await atest("3 · a PARTIALLY paid delivered order: COLLECT for exactly the remainder", async () => {
    const o = order({ totale: 20 });
    const p = await pending([o], [receipt(o, 5)]);
    assert.strictEqual(p.porCobrar[0].amount, 15);
    assert.strictEqual(p.porCobrar[0].netCollected, 5);
    assert.deepStrictEqual([...p.porCobrar[0].allowedActions], ["COLLECT"]);
  });

  await atest("4 · after the payment the pendency DISAPPEARS (no COLLECT left to offer)", async () => {
    const o = order({});
    assert.strictEqual((await pending([o])).porCobrar.length, 1);
    const after = await pending([o], [receipt(o, 12.5)]);
    assert.strictEqual(after.porCobrar.length, 0);
    assert.strictEqual(after.totals.porCobrar, 0);
  });

  await atest("5 · legacy delivered synonyms are collectable too; force-closed and cancelled are not", async () => {
    for (const estado of ["COMPLETADO", "COMPLETATO", "ENTREGADO"]) { // language-guard: allow-legacy COMPLETADO/COMPLETATO/ENTREGADO are the existing estado literals under test, not new vocabulary
      assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "DOMICILIO", { estado, order_uid: "u" })], ["COLLECT"], estado);
    }
    for (const estado of ["CHIUSO_FORZATO", "CANCELADO", "ANULADO", "LISTO", "EN_COCINA", "EN_ENTREGA", null]) { // language-guard: allow-legacy CHIUSO_FORZATO/CANCELADO/ANULADO are the existing estado literals under test, not new vocabulary
      assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "DOMICILIO", { estado, order_uid: "u" })], [], String(estado));
    }
  });

  await atest("5b · an end-to-end force-closed order that still owes money is REPORTED but not collectable", async () => {
    const o = order({ estado: "CHIUSO_FORZATO", totale: 20 }); // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal under test, not new vocabulary
    const p = await pending([o], [receipt(o, 5)]);
    assert.strictEqual(p.porCobrar.length, 1);
    assert.deepStrictEqual([...p.porCobrar[0].allowedActions], []);
  });

  await atest("6 · a Mesa pendency never offers COLLECT (its own Payment Hub settles it); an order with no identity does not either", async () => {
    assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "MESA", { estado: "RETIRADO", order_uid: "u" })], []);
    assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "DOMICILIO", { estado: "RETIRADO", order_uid: null })], []);
    assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "DOMICILIO", { estado: "RETIRADO" })], []);
  });

  await atest("7 · an OVER-COLLECTED delivered order (POR_DEVOLVER) never offers COLLECT", async () => {
    const o = order({ totale: 10 });
    const p = await pending([o], [receipt(o, 14)]);
    assert.strictEqual(p.porDevolver.length, 1);
    assert.deepStrictEqual([...p.porDevolver[0].allowedActions], [], "non-Mesa refund is not wired; collecting more would be wrong");
    assert.strictEqual(p.porCobrar.length, 0);
  });

  await atest("8 · back-compat: a caller that passes no order gets the answers this function always gave", () => {
    assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "RETIRO")], []);
    assert.deepStrictEqual([...allowedActionsFor("POR_COBRAR", "MESA")], []);
    assert.deepStrictEqual([...allowedActionsFor("POR_DEVOLVER", "MESA")], ["REFUND"]);
    assert.deepStrictEqual([...allowedActionsFor("POR_DEVOLVER", "DOMICILIO")], []);
  });

  await atest("9 · deliveryStateOf / isDeliveredEstado are exact", () => {
    assert.strictEqual(deliveryStateOf({ estado: "EN_ENTREGA" }, "DOMICILIO"), "SIN_CONFIRMAR");
    assert.strictEqual(deliveryStateOf({ estado: "RETIRADO" }, "DOMICILIO"), "ENTREGADO");
    assert.strictEqual(deliveryStateOf({ estado: "RETIRADO" }, "RETIRO"), null);
    assert.strictEqual(deliveryStateOf({ estado: "LISTO" }, "DOMICILIO"), null);
    assert.strictEqual(isDeliveredEstado("retirado"), true);
    assert.strictEqual(isDeliveredEstado("CHIUSO_FORZATO"), false); // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal under test, not new vocabulary
  });

  await atest("10 · the reader stays READ-ONLY: the source has no write primitive", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "economy", "pendingExposures.js"), "utf8");
    // Comments are allowed to NAME the writer; code must never call one.
    const code = source.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    for (const forbidden of ["sbInsert", "sbRpc", "sbPatch", "sbUpdate", "sbDelete", "fetch(", "rpc("]) {
      assert.ok(!code.includes(forbidden), `pendingExposures.js must not contain ${forbidden}`);
    }
  });

  console.log(`pendingExposuresPostCloseCollect: ${passed} passed`);
})();
