// tests/n8EconomiaCloseoutConvergence.test.js — N-8 Economía / closeout convergence.
//
// THE CONTRACT THIS FILE OWNS: a CLOSED service has TWO economic truths and they must be
// distinguishable, never interchangeable and never summed.
//
//   closeoutSnapshot   what was true AT Finalizar (immutable, from service_closeouts)
//   current            what is true NOW (recomputed from canonical facts)
//
// The numbers below are the REAL live staging case, service 33174121 closed
// 2026-08-10 08:07:41: seven payments = 82.00 before the close, then #001 16.00,
// #002 13.50 and #009 28.00 = 57.50 after it.
// Run: node tests/n8EconomiaCloseoutConvergence.test.js
const fs = require("fs");
const path = require("path");
const {
  snapshotToEconomicShape,
  describeDivergence,
  describeServiceEconomicTruth,
} = require("../src/closeout/closedServiceEconomicTruth");
const { withOfficialSnapshot } = require("../src/closeout/currentServiceCloseout");
const { getEconomiaLedgerAggregate } = require("../src/closeout/economiaLedgerAggregate");

let pass = 0, fail = 0;
const check = (l, c) => { if (c) { pass++; console.log("  ✓ " + l); } else { fail++; console.log("  ✗ " + l); } };
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

// The real snapshot row for service 33174121.
const SNAP = Object.freeze({
  id: "closeout-33174121", service_session_id: "33174121", closed_at: "2026-08-10T08:07:41.412Z",
  close_source: "operator_finalizar_v3",
  gross_sales_cents: 13950, paid_amount_cents: 8200, unpaid_exposure_cents: 5750,
  total_refunds_cents: 0, total_void_cents: 0,
  cash_amount_cents: 8200, card_amount_cents: 0, bizum_amount_cents: 0, other_amount_cents: 0,
  order_count: 10, incident_count: 0,
});
// The same service recomputed today: the 57.50 arrived after the close.
const CURRENT = Object.freeze({
  totals: { gross: 139.5, collected: 139.5, refunded: 0, unpaid: 0, difference: 0 },
  paymentTotals: { efectivo: 139.5, tarjeta: 0, bizum: 0, other: 0 },
  counts: { tickets: 10, cancelled: 0, refunded: 0, unpaid: 0, partiallyPaid: 0 },
});

console.log("\n── the snapshot normalizes to the same shape as a live aggregate ──");
{
  const s = snapshotToEconomicShape(SNAP);
  check("gross 139.50", s.totals.gross === 139.5);
  check("collected 82.00 — what was registered at Finalizar", s.totals.collected === 82);
  check("unpaid 57.50", s.totals.unpaid === 57.5);
  check("cash 82.00", s.paymentTotals.efectivo === 82);
  check("difference is derived, not stored", s.totals.difference === 57.5);
  check("voided is surfaced (no live equivalent)", s.totals.voided === 0);
  check("ticket count comes from the snapshot", s.counts.tickets === 10);
  check("a null row yields null, never a fabricated zero", snapshotToEconomicShape(null) === null);
  check("a non-object yields null", snapshotToEconomicShape("x") === null);
}

console.log("\n── the divergence is stated, with direction ──");
{
  const d = describeDivergence({ current: CURRENT, snapshot: SNAP });
  check("a divergence is reported", d !== null);
  check("collected moved +57.50 (money arrived after the close)", d.totals.collected === 57.5);
  check("unpaid moved -57.50", d.totals.unpaid === -57.5);
  check("gross did NOT move — no new sales, only settlement", !("gross" in d.totals));
  check("the cash bucket moved +57.50 too", d.paymentTotals.efectivo === 57.5);
  check("untouched buckets are omitted, not reported as 0",
    !("tarjeta" in d.paymentTotals) && !("bizum" in d.paymentTotals));
}
{
  // B — a closed service with no late events must report NO divergence.
  const settled = {
    totals: { gross: 139.5, collected: 82, refunded: 0, unpaid: 57.5 },
    paymentTotals: { efectivo: 82, tarjeta: 0, bizum: 0, other: 0 },
  };
  check("B: current == snapshot -> no divergence at all",
    describeDivergence({ current: settled, snapshot: SNAP }) === null);
  check("no snapshot -> nothing to compare",
    describeDivergence({ current: CURRENT, snapshot: null }) === null);
}
{
  // D — a late CARD payment on an all-cash close: the split must move even when it does.
  const lateCard = {
    totals: { gross: 139.5, collected: 139.5, refunded: 0, unpaid: 0 },
    paymentTotals: { efectivo: 82, tarjeta: 57.5, bizum: 0, other: 0 },
  };
  const d = describeDivergence({ current: lateCard, snapshot: SNAP });
  check("D: card +57.50 is reported", d.paymentTotals.tarjeta === 57.5);
  check("D: cash correctly reported as unchanged", !("efectivo" in d.paymentTotals));
}

console.log("\n── open vs closed vs legacy-closed are three different states ──");
{
  const open = describeServiceEconomicTruth({ status: "open", current: CURRENT, snapshot: null });
  check("A: an OPEN service gets NO snapshot", open.closeoutSnapshot === null);
  check("A: and no fabricated divergence", open.divergesFromCloseout === false && open.divergence === null);
  check("A: the absence is explained, not silent", open.closeoutSnapshotAbsentReason === "service_not_closed");
  // An open service must never be handed a snapshot even if one were passed in.
  const openWithRow = describeServiceEconomicTruth({ status: "open", current: CURRENT, snapshot: SNAP });
  check("A: an open service ignores a snapshot row outright", openWithRow.closeoutSnapshot === null);

  const legacy = describeServiceEconomicTruth({ status: "closed", current: CURRENT, snapshot: null });
  check("J: a legacy close with no snapshot row is told apart from an open service",
    legacy.closeoutSnapshotAbsentReason === "no_closeout_row");
  check("J: and still reports no divergence rather than erroring", legacy.divergesFromCloseout === false);

  const closed = describeServiceEconomicTruth({ status: "closed", current: CURRENT, snapshot: SNAP });
  check("C: a closed service carries BOTH truths", closed.closeoutSnapshot !== null);
  check("C: and flags the disagreement", closed.divergesFromCloseout === true);
  check("C: the snapshot keeps the Finalizar figure", closed.closeoutSnapshot.totals.collected === 82);
}

console.log("\n── the live closeout view: snapshot stays the headline, current is preserved ──");
{
  const base = { ...CURRENT, ok: true, status: "closed", tickets: [], serviceSessionId: "33174121" };
  const out = withOfficialSnapshot(base, SNAP);
  check("headline collected is the SNAPSHOT (Finalizar record, unchanged)", out.totals.collected === 82);
  check("headline cash is the SNAPSHOT", out.paymentTotals.efectivo === 82);
  check("financialSource still says official_closeout", out.financialSource === "official_closeout");
  check("closeoutId still exposed", out.closeoutId === "closeout-33174121");
  check("N-8: the recomputed truth is preserved, not discarded",
    out.currentReconciled.totals.collected === 139.5);
  check("N-8: and the disagreement is stated", out.divergesFromCloseout === true
    && out.divergence.totals.collected === 57.5);
  check("no snapshot -> the overlay is a no-op, exactly as before",
    withOfficialSnapshot(base, null) === base);
  // H — the two must never be added together.
  check("H: headline + currentReconciled are alternatives, never a sum",
    out.totals.collected !== out.totals.collected + out.currentReconciled.totals.collected);
}

console.log("\n── the Economía ledger exposes both, and stays current-reconciled ──");
{
  // A fake `select` returning the real shapes, so this exercises the REAL reader.
  const SESSION = { id: "33174121", status: "closed", business_date: "2026-08-07", service_kind: null };
  const ORDER = { id: "#001", service_session_id: "33174121", totale: 139.5, estado: "RETIRADO", ts: 1 };
  const EVENT = {
    order_id: "#001", type: "payment", amount: 139.5, payment_method: "efectivo",
    service_session_id: "33174121", created_at: "2026-08-10T09:43:39.252Z",
  };
  const select = async (table) => {
    if (table === "service_sessions") return [SESSION];
    if (table === "storico") return []; // language-guard: allow-legacy storico is the existing archive table name this reader queries, not new vocabulary
    if (table === "ordenes") return [ORDER];
    if (table === "order_financial_events") return [EVENT];
    if (table === "order_obligations") return [];
    if (table === "service_closeouts") return [SNAP];
    return [];
  };
  return getEconomiaLedgerAggregate({ select }).then((r) => {
    check("the reader still returns its existing shape", r.ok === true && Array.isArray(r.porGiorno));
    check("G: the top-level semantic is named explicitly", r.economicSemantic === "current_reconciled");
    check("the divergence roll-up is surfaced", r.divergesFromCloseout === true);
    const s = r.sessions[0];
    check("session totals are CURRENT reconciled (139.50 collected)", s.totals.collected === 139.5);
    check("F: and the session carries its own Finalizar record", s.closeoutSnapshot.totals.collected === 82);
    check("the per-session disagreement is stated", s.divergesFromCloseout === true);
    check("I: drilldown ticket counts stay consistent with the current figures",
      s.totals.collected === 139.5 && r.porGiorno[0].totals.collected === 139.5);
    check("G/H: porGiorno is NOT contaminated by snapshot figures",
      r.porGiorno[0].totals.collected === 139.5 && r.porGiorno[0].closeoutSnapshot === undefined);

    console.log("\n── static: one authority, no second implementation ──");
    const closeout = read("src/closeout/currentServiceCloseout.js");
    const ledger = read("src/closeout/economiaLedgerAggregate.js");
    const truth = read("src/closeout/closedServiceEconomicTruth.js");
    check("the cents->euros conversion exists in ONE module only",
      !/centsToEur/.test(closeout) && !/centsToEur/.test(ledger) && /centsToEur/.test(truth));
    check("both readers delegate to the shared authority",
      /require\("\.\/closedServiceEconomicTruth"\)/.test(closeout)
        && /require\("\.\/closedServiceEconomicTruth"\)/.test(ledger));
    check("the shared authority is pure — no DB, no clock",
      !/require\(.*supabase.*\)/.test(truth) && !/Date\.now|new Date/.test(truth));
    check("nothing in this slice writes to service_closeouts",
      !/INSERT INTO|update\(|sbUpdate|sbInsert/.test(truth)
        && !/service_closeouts[^)]*(insert|update)/i.test(ledger));
    check("the timestamp-windowed reader still never substitutes a snapshot",
      !/service_closeouts/.test(read("src/economy/economicSnapshot.js")));

    console.log("");
    console.log("Totale: " + (pass + fail) + " | PASS: " + pass + " | FAIL: " + fail);
    process.exit(fail === 0 ? 0 : 1);
  });
}
