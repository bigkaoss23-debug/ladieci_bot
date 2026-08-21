"use strict";
// I-1 — the Economic Snapshot reader, against REAL staging rows.
//
// Every euro asserted below was captured read-only from the live staging
// database on 2026-08-21 and cross-checked against two independent, already
// certified sources: PRE_CLOSE_ECONOMIC_TRUTH_480ECA89 (the frozen forensic
// baseline) and the 2026-08-20 UAT closeout. Nothing here is a fixture
// invented to make the code pass.
const assert = require("assert");
const { createEconomicSnapshot } = require("../src/economy/economicSnapshot");
const { resolveEconomicWindow, PRESET } = require("../src/economy/economicWindow");
const fx = require("./fixtures/economicSnapshotStagingRows");
const { createMemorySelect } = require("./fixtures/postgrestMemorySelect");

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};
const atest = async (name, fn) => {
  try { await fn(); passed += 1; }
  catch (error) { console.error(`FAIL: ${name}\n  ${error && error.message}`); process.exitCode = 1; }
};

const calls = [];
const select = createMemorySelect(
  // language-guard: allow-legacy storico is the existing archive table name this reader queries, keyed here verbatim, not new vocabulary
  { ordenes: fx.ordenes, storico: fx.storico, order_financial_events: fx.events, service_sessions: fx.sessions },
  { onCall: (c) => calls.push(c) },
);
const snapshot = createEconomicSnapshot({ select });
const NOW = new Date("2026-08-21T12:00:00.000Z");
const win = (from, to) => ({ preset: PRESET.PERSONALIZADO, from, to, now: NOW });

(async () => {
  // ── A. TIMESTAMP IS THE AUTHORITY ────────────────────────────────────────
  await atest("A1 · the forensic service's interval reproduces its certified economy", async () => {
    const s = await snapshot({ preset: PRESET.SERVICIO, serviceSessionId: fx.S.FORENSIC, now: NOW });
    assert.strictEqual(s.obligation.gross, 262.5, "gross");
    assert.strictEqual(s.receipts.collected, 262.5, "collected");
    assert.strictEqual(s.receipts.byMethod.efectivo, 85, "cash");
    assert.strictEqual(s.receipts.byMethod.tarjeta, 130, "card");
    assert.strictEqual(s.receipts.byMethod.bizum, 47.5, "bizum");
    assert.strictEqual(s.receipts.byMethod.other, 0, "other");
    assert.strictEqual(s.obligation.unpaid, 0, "unpaid");
    assert.strictEqual(s.obligation.voided, 0, "void");
    assert.strictEqual(s.obligation.refunded, 0, "refund");
    assert.strictEqual(s.counts.obligations, 5, "order count");
  });

  await atest("A2 · a pure timestamp window reproduces the same economy with no session filter", async () => {
    // 19:06Z-20:00Z covers every forensic obligation AND every forensic
    // receipt, and touches no other service. No service_session_id anywhere.
    const s = await snapshot(win("2026-08-20T17:06:44.000Z", "2026-08-20T20:00:00.000Z"));
    assert.strictEqual(s.window.serviceSessionId, null, "window must not be service-scoped");
    assert.strictEqual(s.obligation.gross, 262.5);
    assert.strictEqual(s.receipts.collected, 262.5);
    assert.deepStrictEqual(
      { ...s.receipts.byMethod },
      { efectivo: 85, tarjeta: 130, bizum: 47.5, other: 0 },
    );
  });

  await atest("B · the closed UAT service reproduces its certified closeout", async () => {
    const s = await snapshot({ preset: PRESET.SERVICIO, serviceSessionId: fx.S.UAT, now: NOW });
    assert.strictEqual(s.counts.obligations, 7, "tickets (cancelled included)");
    assert.strictEqual(s.obligation.gross, 143.5, "gross");
    assert.strictEqual(s.receipts.collected, 124, "collected");
    assert.strictEqual(s.obligation.unpaid, 19.5, "unpaid — #999008");
    assert.strictEqual(s.obligation.voided, 10, "void — #999006");
    assert.strictEqual(s.receipts.byMethod.efectivo, 72.5);
    assert.strictEqual(s.receipts.byMethod.tarjeta, 12);
    assert.strictEqual(s.receipts.byMethod.bizum, 39.5);
  });

  // ── C. ONE BUSINESS DAY, TWO OPERATIONAL SERVICES ────────────────────────
  await atest("C · one business day spanning two services needs no lifecycle at all", async () => {
    const day = resolveEconomicWindow({ preset: PRESET.AYER, now: NOW });
    const s = await snapshot({ preset: PRESET.PERSONALIZADO, from: day.from, to: day.to, now: NOW });
    assert.strictEqual(s.obligation.gross, 406, "143.50 + 262.50");
    assert.strictEqual(s.receipts.collected, 386.5, "124.00 + 262.50");
    assert.strictEqual(s.obligation.unpaid, 19.5);
    assert.strictEqual(s.obligation.voided, 10);
    assert.strictEqual(s.serviceProvenance.length, 2, "both services named as provenance");
    assert.deepStrictEqual(
      { ...s.receipts.byMethod },
      { efectivo: 157.5, tarjeta: 142, bizum: 87, other: 0 },
    );
  });

  await atest("C2 · midday + evening partition the business day exactly", async () => {
    const midday = resolveEconomicWindow({ preset: PRESET.MEDIODIA, businessDate: "2026-08-20", now: NOW });
    const evening = resolveEconomicWindow({ preset: PRESET.NOCHE, businessDate: "2026-08-20", now: NOW });
    const whole = resolveEconomicWindow({ preset: PRESET.AYER, now: NOW });
    assert.strictEqual(midday.from, whole.from, "midday starts the business day");
    assert.strictEqual(midday.to, evening.from, "no gap, no overlap at 17:30");
    assert.strictEqual(evening.to, whole.to, "evening ends the business day");
    const a = await snapshot({ preset: PRESET.PERSONALIZADO, from: midday.from, to: midday.to, now: NOW });
    const b = await snapshot({ preset: PRESET.PERSONALIZADO, from: evening.from, to: evening.to, now: NOW });
    assert.strictEqual(a.obligation.gross, 143.5, "midday holds the UAT service");
    assert.strictEqual(b.obligation.gross, 262.5, "evening holds the forensic service");
    assert.strictEqual(a.receipts.collected + b.receipts.collected, 386.5, "and they sum to the day");
  });

  // ── D/E/F. WINDOW CROSSING ───────────────────────────────────────────────
  await atest("D · obligation before the window, receipt inside it", async () => {
    // 21:22-21:26 Madrid: no order is CREATED here, but four payments land.
    const s = await snapshot(win("2026-08-20T19:22:00.000Z", "2026-08-20T19:26:00.000Z"));
    assert.strictEqual(s.obligation.gross, 0, "no obligation born in this window");
    assert.strictEqual(s.receipts.collected, 180, "79 + 33.50 + 20 + 30 + 17.50");
    assert.strictEqual(s.windowCrossing.obligationBeforeWindowReceiptInside.length, 5,
      "every one of them is named as crossing the FROM boundary");
    assert.ok(s.receipts.collected > s.obligation.gross,
      "receipts exceeding gross is a true report, not an error");
  });

  await atest("E · obligation inside the window, receipt after it", async () => {
    // #999016 is created 21:21 and paid 21:29. Cut the window at 21:25.
    const s = await snapshot(win("2026-08-20T19:20:00.000Z", "2026-08-20T19:25:00.000Z"));
    assert.strictEqual(s.obligation.gross, 45, "#999016 only");
    assert.strictEqual(s.receipts.collected, 132.5,
      "79 (#999014, created before FROM) + 33.50 + 20 (#999015) — none of them born in this window");
    const after = s.windowCrossing.obligationInsideWindowReceiptAfter;
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].orderId, "#999016");
    assert.strictEqual(after[0].amount, 45);
    assert.strictEqual(s.obligation.unpaid, 0,
      "settled as of asOf — the receipt exists, it simply is not in this window");
  });

  await atest("F · a split payment straddling the boundary is named, never silently halved", async () => {
    const s = await snapshot(win("2026-08-20T19:13:00.000Z", "2026-08-20T19:25:00.000Z"));
    const split = s.windowCrossing.receiptsSplitAcrossBoundary;
    assert.strictEqual(split.length, 1, "#999015 alone");
    assert.strictEqual(split[0].orderId, "#999015");
    assert.strictEqual(split[0].amount, 101);
    assert.strictEqual(split[0].receiptedInWindow, 53.5, "33.50 + 20");
    assert.strictEqual(split[0].receiptedOutsideWindow, 47.5, "30 + 17.50");
    assert.strictEqual(split[0].receiptedInWindow + split[0].receiptedOutsideWindow, 101,
      "and the two halves reconstruct the whole obligation exactly");
  });

  // ── ORDER IDENTITY ───────────────────────────────────────────────────────
  await atest("G · three different orders called #001 are never merged", async () => {
    const s = await snapshot(win("2026-08-06T00:00:00.000Z", "2026-08-11T00:00:00.000Z"));
    const ones = s.drillDown.obligations.filter((t) => t.id === "#001");
    assert.strictEqual(ones.length, 3, "three distinct obligations share the id");
    assert.strictEqual(new Set(ones.map((t) => t.orderKey)).size, 3, "and three distinct keys");
    assert.deepStrictEqual(ones.map((t) => t.amount).sort((a, b) => a - b), [10, 13, 16]);
    // The decisive one: each #001 collected ONLY its own payment.
    assert.deepStrictEqual(ones.map((t) => t.collectedAmount).sort((a, b) => a - b), [10, 13, 16],
      "no order absorbed another service's payment for the same id");
    assert.strictEqual(s.obligation.gross, 39, "10 + 13 + 16, counted once each");
    assert.strictEqual(s.receipts.collected, 39);
  });

  // ── VOID / CANCEL ────────────────────────────────────────────────────────
  await atest("H · a cancelled obligation leaves gross and collects nothing", async () => {
    const s = await snapshot({ preset: PRESET.SERVICIO, serviceSessionId: fx.S.UAT, now: NOW });
    const cancelled = s.drillDown.obligations.find((t) => t.id === "#999006");
    assert.strictEqual(cancelled.cancelled, true);
    assert.strictEqual(cancelled.collectedAmount, 0);
    assert.strictEqual(cancelled.unpaidAmount, 0, "a void is not an unpaid debt");
    assert.strictEqual(s.obligation.voided, 10);
    assert.ok(!String(JSON.stringify(s.obligation.gross)).includes("153"), "and never enters gross");
  });

  // ── I. ERA IS REPORTING-ONLY ─────────────────────────────────────────────
  await atest("I · the stamped era is reported but never selects or totals money", async () => {
    const day = resolveEconomicWindow({ preset: PRESET.AYER, now: NOW });
    const s = await snapshot({ preset: PRESET.PERSONALIZADO, from: day.from, to: day.to, now: NOW });
    const b = s.economicBreakdown;
    assert.strictEqual(b.source, "stamped_era_read_rule");
    // Both services carry explicit S-C stamps on their events.
    assert.strictEqual(b.receipts.PRANZO, 124, "the UAT service's receipts"); // language-guard: allow-legacy PRANZO is the existing stamp value being asserted, not new vocabulary
    assert.strictEqual(b.receipts.SERA, 262.5, "the forensic service's receipts");
    assert.strictEqual(b.receipts.PRANZO + b.receipts.SERA, s.receipts.collected, // language-guard: allow-legacy PRANZO is the existing stamp value being asserted, not new vocabulary
      "the split is a partition of the same money, not a second total");
    assert.strictEqual(b.obligations.PRANZO + b.obligations.SERA + b.obligations.unknown, s.obligation.gross); // language-guard: allow-legacy PRANZO is the existing stamp value being asserted, not new vocabulary
  });

  await atest("I2 · an unstamped, kind-less fact reports unknown and is still counted in full", async () => {
    // #999008 is unpaid, so it has no financial event to carry an S-C stamp,
    // and its session is an operational_service_v1 row whose service_kind is
    // NULL by constraint — there is genuinely nothing to classify it by. It
    // must report `unknown` rather than being guessed into a bucket, and it
    // must still be worth 19.50 EUR of real obligation.
    const s = await snapshot({ preset: PRESET.SERVICIO, serviceSessionId: fx.S.UAT, now: NOW });
    const o = s.economicBreakdown.obligations;
    assert.strictEqual(o.unknown, 19.5, "#999008, honestly unclassified");
    assert.strictEqual(o.PRANZO, 124, "the five stamped, paid obligations"); // language-guard: allow-legacy PRANZO is the existing stamp value being asserted, not new vocabulary
    assert.strictEqual(o.SERA, 0);
    assert.strictEqual(o.PRANZO + o.SERA + o.unknown, s.obligation.gross, // language-guard: allow-legacy PRANZO is the existing stamp value being asserted, not new vocabulary
      "an unclassifiable fact is still fully counted in the money");
    assert.strictEqual(s.obligation.unpaid, 19.5, "and it is exactly the unpaid exposure");
  });

  // ── SNAPSHOT IS READ-ONLY ────────────────────────────────────────────────
  await atest("J · the reader only ever reads, and only the tables it declares", async () => {
    calls.length = 0;
    await snapshot({ preset: PRESET.HOY, now: NOW });
    assert.ok(calls.length > 0, "it did run");
    const tables = new Set(calls.map((c) => c.table));
    for (const t of tables) {
      // language-guard: allow-legacy storico is the existing archive table name in the allowed set, not new vocabulary
      assert.ok(["ordenes", "storico", "order_financial_events", "service_sessions"].includes(t),
        `unexpected table read: ${t}`);
    }
  });

  await atest("K · an empty window is a confirmed zero, not a failure", async () => {
    const s = await snapshot(win("2026-08-18T00:00:00.000Z", "2026-08-18T01:00:00.000Z"));
    assert.strictEqual(s.ok, true);
    assert.strictEqual(s.obligation.gross, 0);
    assert.strictEqual(s.receipts.collected, 0);
    assert.strictEqual(s.counts.obligations, 0);
  });

  await atest("L · a malformed window is refused, never silently widened", async () => {
    await assert.rejects(() => snapshot({ preset: PRESET.PERSONALIZADO, from: "2026-08-20T10:00:00Z", to: "2026-08-20T09:00:00Z", now: NOW }),
      (e) => e.code === "ECONOMY_WINDOW_NOT_ORDERED");
    await assert.rejects(() => snapshot({ preset: "ayer-ish", now: NOW }),
      (e) => e.code === "ECONOMY_PRESET_UNKNOWN");
    await assert.rejects(() => snapshot({ preset: PRESET.SERVICIO, now: NOW }),
      (e) => e.code === "ECONOMY_SERVICE_SESSION_REQUIRED");
  });

  console.log(`economicSnapshotWindow: ${passed} passed`);
})();
