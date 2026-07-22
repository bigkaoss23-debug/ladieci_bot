"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createCurrentServiceCloseout } = require("../src/closeout/currentServiceCloseout");
const roles = require("../src/auth/legacyActionRoles");

const fixedNow = () => new Date("2026-07-22T20:00:00Z");

test("open service uses only today's live orders and safe ticket projection", async () => {
  const calls = [];
  const select = async (table, query) => {
    calls.push([table, query]);
    if (table === "serata_summary") return [];
    if (table === "ordenes") return [{ id: "o1", numero: 7, hora: "21:00", estado: "COMPLETADO", totale: 20, nombre: "SECRET", tel: "PII", metodo_pago: "efectivo", cobrado: true }];
    return [];
  };
  const result = await createCurrentServiceCloseout({ select, now: fixedNow })();
  assert.equal(result.status, "open");
  assert.equal(result.serviceDate, "2026-07-22");
  assert.deepEqual(result.paymentTotals, { efectivo: 20, tarjeta: 0, bizum: 0, other: 0 });
  assert.deepEqual(Object.keys(result.tickets[0]), ["id", "number", "time", "state", "amount", "paymentMethod", "paymentState", "collectedAmount", "refundedAmount", "cancelled", "refunded"]);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal(calls.some(([table, query]) => table === "ordenes" && !query.includes("fecha")), true);
});

test("closed service reads the same fixed service date, never a previous period", async () => {
  const calls = [];
  const select = async (table, query) => {
    calls.push([table, query]);
    if (table === "serata_summary") return [{ fecha: "2026-07-22" }];
    if (table === "storico") return [{ orden_id: "o2", totale: 15, estado: "COMPLETADO", metodo_pago: "tarjeta", cobrado: true }];
    return [];
  };
  const result = await createCurrentServiceCloseout({ select, now: fixedNow })();
  assert.equal(result.status, "closed");
  assert.match(calls.find(([table]) => table === "storico")[1], /fecha=eq\.2026-07-22/);
  assert.equal(calls.some(([, query]) => /limit=30|gte\.|lte\.|month|range/.test(query)), false);
});

test("no open marker and no live tickets returns controlled no-session state", async () => {
  const result = await createCurrentServiceCloseout({ select: async () => [], now: fixedNow })();
  assert.equal(result.available, false);
  assert.equal(result.code, "NO_CURRENT_SERVICE");
  assert.deepEqual(result.totals, { gross: 0, collected: 0, refunded: 0, unpaid: 0, difference: 0 });
});

test("financial events reconcile payments, refunds, unpaid and cancelled tickets", async () => {
  const select = async (table) => {
    if (table === "serata_summary") return [];
    if (table === "ordenes") return [
      { id: "paid", totale: 20, estado: "COMPLETADO" },
      { id: "refund", totale: 10, estado: "COMPLETADO" },
      { id: "unpaid", totale: 8, estado: "COMPLETADO" },
      { id: "void", totale: 12, estado: "CANCELADO" },
    ];
    return [
      { order_id: "paid", event_type: "payment", amount: 20, payment_method: "tarjeta" },
      { order_id: "refund", event_type: "payment", amount: 10, payment_method: "bizum" },
      { order_id: "refund", event_type: "refund", amount: 10, payment_method: "bizum" },
    ];
  };
  const result = await createCurrentServiceCloseout({ select, now: fixedNow })();
  assert.deepEqual(result.counts, { tickets: 4, cancelled: 1, refunded: 1, unpaid: 1 });
  assert.deepEqual(result.totals, { gross: 38, collected: 30, refunded: 10, unpaid: 8, difference: 8 });
  assert.deepEqual(result.paymentTotals, { efectivo: 0, tarjeta: 20, bizum: 10, other: 0 });
});

test("role boundary allows fresh admin/operator and denies rider", () => {
  assert.equal(roles.isAllowed("admin", "getCurrentServiceCloseout"), true);
  assert.equal(roles.isAllowed("operator", "getCurrentServiceCloseout"), true);
  assert.equal(roles.isAllowed("rider", "getCurrentServiceCloseout"), false);
  assert.equal(roles.getActionRule("getCurrentServiceCloseout").fresh, true);
});
