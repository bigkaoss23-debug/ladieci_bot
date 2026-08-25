"use strict";
// ===============================================================
// N-9 — ECONOMÍA TIME-WINDOW CORRECTNESS (backend contract)
//
// getEconomiaLedger's `porGiorno` is keyed by service_sessions.business_date,
// a Europe/Madrid BUSINESS date that turns over at 04:00 Madrid. Before N-9 the
// action returned those keys and nothing else, so the frontend had to guess what
// calendar they belonged to — and guessed with the operator's browser clock.
//
// This file pins the resolved window the action now states on the wire:
//   * the timezone is named, never implied;
//   * the interval is half-open [from, to) — `to` is the NEXT business day's
//     04:00 Madrid, never 23:59:59.999;
//   * the boundaries are DST-correct, so a business day is 23, 24 or 25 hours
//     long as reality requires and never a hardcoded ±24h;
//   * every pre-N-9 field is returned byte-identical (purely additive).
//
// Run: node --test tests/n9EconomiaLedgerWindow.test.js
// ===============================================================

const assert = require("node:assert/strict");
const { test } = require("node:test");
// The resolver lives with every other window in the system. readActions
// deliberately does NOT re-export it: that module's export surface is a
// security contract (fixed get* domain actions only, no generic helpers), and
// tests/readActions.test.js enforces exactly that.
const { resolveEconomiaLedgerWindow } = require("../src/economy/economicWindow");
const { getEconomiaLedger } = require("../src/utils/readActions");
const { TIMEZONE } = require("../src/schedule/serviceSchedule");

const win = (desde, hasta, now) => resolveEconomiaLedgerWindow({ desde, hasta, now }).window;
const hours = (w) => (new Date(w.to) - new Date(w.from)) / 3600000;

// ── the reporting timezone is stated, not assumed ──────────────────────────

test("N-9 · timezone is the schedule module's Europe/Madrid, not UTC, not a browser guess", () => {
  const w = win("2026-08-20", "2026-08-25");
  assert.equal(w.timezone, "Europe/Madrid");
  assert.equal(w.timezone, TIMEZONE);
});

test("N-9 · the boundary convention is declared on the wire", () => {
  assert.equal(win("2026-08-20", "2026-08-20").bounds, "[from,to)");
});

test("N-9 · generatedAt is the reading instant, in ISO-8601", () => {
  const out = resolveEconomiaLedgerWindow({
    desde: "2026-08-25", hasta: "2026-08-25", now: new Date("2026-08-25T09:00:00Z"),
  });
  assert.equal(out.generatedAt, "2026-08-25T09:00:00.000Z");
});

// ── F / G · summer and winter offsets ──────────────────────────────────────

test("N-9 · F · SUMMER (CEST, UTC+2): the business day starts at 02:00Z", () => {
  const w = win("2026-08-20", "2026-08-20");
  assert.equal(w.from, "2026-08-20T02:00:00.000Z");
  assert.equal(w.to, "2026-08-21T02:00:00.000Z");
});

test("N-9 · G · WINTER (CET, UTC+1): the same 04:00 Madrid boundary is 03:00Z", () => {
  const w = win("2026-01-15", "2026-01-15");
  assert.equal(w.from, "2026-01-15T03:00:00.000Z");
  assert.equal(w.to, "2026-01-16T03:00:00.000Z");
});

test("N-9 · F/G · the offset is derived, never hardcoded — the two differ by one hour", () => {
  assert.equal(new Date(win("2026-08-20", "2026-08-20").from).getUTCHours(), 2);
  assert.equal(new Date(win("2026-01-15", "2026-01-15").from).getUTCHours(), 3);
});

// ── H · DST transition days are their real length ──────────────────────────

test("N-9 · H · spring-forward: the business day containing it is 23 hours", () => {
  // Spain springs forward on 2026-03-29 at 02:00 → 03:00. The business day that
  // CONTAINS that jump is 2026-03-28 (04:00 CET → 04:00 CEST).
  const w = win("2026-03-28", "2026-03-28");
  assert.equal(w.from, "2026-03-28T03:00:00.000Z");
  assert.equal(w.to, "2026-03-29T02:00:00.000Z");
  assert.equal(hours(w), 23);
});

test("N-9 · H · fall-back: the business day containing it is 25 hours", () => {
  // Spain falls back on 2026-10-25 at 03:00 → 02:00; the containing business day
  // is 2026-10-24 (04:00 CEST → 04:00 CET).
  const w = win("2026-10-24", "2026-10-24");
  assert.equal(w.from, "2026-10-24T02:00:00.000Z");
  assert.equal(w.to, "2026-10-25T03:00:00.000Z");
  assert.equal(hours(w), 25);
});

test("N-9 · H · ordinary days either side stay 24 hours", () => {
  assert.equal(hours(win("2026-03-27", "2026-03-27")), 24);
  assert.equal(hours(win("2026-03-29", "2026-03-29")), 24);
  assert.equal(hours(win("2026-10-23", "2026-10-23")), 24);
  assert.equal(hours(win("2026-10-25", "2026-10-25")), 24);
});

test("N-9 · H · a range spanning a DST change is NOT a multiple of 24h", () => {
  // 24 + 23 + 24. A ±24h implementation would have said 72 and misdated a day.
  assert.equal(hours(win("2026-03-27", "2026-03-29")), 71);
});

// ── E · half-open bounds ───────────────────────────────────────────────────

test("N-9 · E · `to` is the next business day's 04:00, so ranges tile exactly", () => {
  assert.equal(win("2026-08-20", "2026-08-20").to, win("2026-08-21", "2026-08-21").from);
});

test("N-9 · E · no boundary carries a .999 millisecond hack", () => {
  const w = win("2026-08-20", "2026-08-22");
  assert.ok(w.from.endsWith(".000Z"));
  assert.ok(w.to.endsWith(".000Z"));
});

test("N-9 · E · an inclusive `hasta` covers that whole business day", () => {
  const w = win("2026-08-20", "2026-08-22");
  assert.equal(w.from, "2026-08-20T02:00:00.000Z");
  assert.equal(w.to, "2026-08-23T02:00:00.000Z");
  assert.equal(hours(w), 72);
});

// ── businessDateToday is the Madrid reporting day ──────────────────────────

test("N-9 · A · 13:30 Madrid in summer resolves to that calendar date", () => {
  assert.equal(win(null, null, new Date("2026-08-25T11:30:00Z")).businessDateToday, "2026-08-25");
});

test("N-9 · A · 02:30 Madrid still belongs to the PREVIOUS business date", () => {
  // This is the case the browser-clock frontend got wrong every single night.
  assert.equal(win(null, null, new Date("2026-08-26T00:30:00Z")).businessDateToday, "2026-08-25");
});

test("N-9 · A · 04:00 Madrid exactly opens the new business date", () => {
  assert.equal(win(null, null, new Date("2026-08-26T02:00:00Z")).businessDateToday, "2026-08-26");
});

test("N-9 · G · winter: 02:30 Madrid is 01:30Z and still the previous business date", () => {
  assert.equal(win(null, null, new Date("2026-01-16T01:30:00Z")).businessDateToday, "2026-01-15");
});

test("N-9 · an omitted range leaves the instants null, never a fabricated one", () => {
  const w = win(null, null, new Date("2026-08-25T11:30:00Z"));
  assert.equal(w.from, null);
  assert.equal(w.to, null);
  assert.equal(w.businessDateFrom, null);
  assert.equal(w.businessDateTo, null);
  assert.equal(w.businessDateToday, "2026-08-25");
});

// ── the action is purely additive ──────────────────────────────────────────

const AGGREGATE = Object.freeze({
  ok: true,
  economicSemantic: "current_reconciled",
  divergesFromCloseout: false,
  porGiorno: [{ businessDate: "2026-08-20", paymentTotals: {}, totals: { collected: 270.5 } }],
  sessions: [],
  paymentTotals: { efectivo: 270.5 },
  totals: { collected: 270.5 },
  economicBreakdown: {},
});

// Load readActions against a stubbed aggregate, so this stays a pure contract
// test over the action's OWN transformation and never touches Supabase.
function withStubbedAggregate() {
  const aggPath = require.resolve("../src/closeout/economiaLedgerAggregate");
  const readPath = require.resolve("../src/utils/readActions");
  const savedAgg = require.cache[aggPath];
  const savedRead = require.cache[readPath];
  delete require.cache[aggPath];
  delete require.cache[readPath];
  require.cache[aggPath] = {
    id: aggPath,
    filename: aggPath,
    loaded: true,
    exports: { getEconomiaLedgerAggregate: async () => JSON.parse(JSON.stringify(AGGREGATE)) },
  };
  // eslint-disable-next-line global-require
  const mod = require("../src/utils/readActions");
  const restore = () => {
    delete require.cache[aggPath];
    delete require.cache[readPath];
    if (savedAgg) require.cache[aggPath] = savedAgg;
    if (savedRead) require.cache[readPath] = savedRead;
  };
  return { mod, restore };
}

test("N-9 · every pre-N-9 field of getEconomiaLedger survives byte-identical", async () => {
  const { mod, restore } = withStubbedAggregate();
  try {
    const out = await mod.getEconomiaLedger({ desde: "2026-08-20", hasta: "2026-08-25" });
    for (const k of Object.keys(AGGREGATE)) {
      assert.deepEqual(out[k], AGGREGATE[k], `field ${k} changed`);
    }
  } finally { restore(); }
});

test("N-9 · exactly two fields are added: `window` and `generatedAt`", async () => {
  const { mod, restore } = withStubbedAggregate();
  try {
    const out = await mod.getEconomiaLedger({ desde: "2026-08-20", hasta: "2026-08-25" });
    const added = Object.keys(out).filter((k) => !(k in AGGREGATE)).sort();
    assert.deepEqual(added, ["generatedAt", "window"]);
  } finally { restore(); }
});

test("N-9 · the added window describes the range that was actually asked for", async () => {
  const { mod, restore } = withStubbedAggregate();
  try {
    const out = await mod.getEconomiaLedger({ desde: "2026-08-20", hasta: "2026-08-25" });
    assert.equal(out.window.businessDateFrom, "2026-08-20");
    assert.equal(out.window.businessDateTo, "2026-08-25");
    assert.equal(out.window.from, "2026-08-20T02:00:00.000Z");
    assert.equal(out.window.to, "2026-08-26T02:00:00.000Z");
    assert.equal(out.window.timezone, "Europe/Madrid");
  } finally { restore(); }
});

test("N-9 · an invalid business date is still rejected by the pre-existing validator", async () => {
  await assert.rejects(
    () => getEconomiaLedger({ desde: "25-08-2026" }),
    /fecha inválida/,
  );
});
