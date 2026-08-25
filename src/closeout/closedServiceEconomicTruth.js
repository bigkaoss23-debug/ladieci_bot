'use strict';
// N-8 — THE ONE definition of the two economic truths a CLOSED service has.
//
// THE PROBLEM THIS EXISTS TO NAME. A finalized service can be described two ways, and
// both can be individually correct while meaning different things:
//
//   CLOSEOUT SNAPSHOT   what was true AT Finalizar. Written by the close engine inside
//                       the close transaction into the official closeout store, never
//                       rewritten. This is the figure the operator signed off on.
//
//   CURRENT RECONCILED  what is true NOW: the same accounting rules applied to today's
//                       canonical facts, including events recorded after the close.
//
// Proven live on staging, read-only, service 33174121 (closed 2026-08-10 08:07:41):
// seven payments totalling 82.00 before the close, then THREE more — #001 16.00,
// #002 13.50, #009 28.00 = 57.50 — at 09:43 and 09:56, after it. The snapshot says
// gross 139.50 / collected 82.00 / unpaid 57.50 with cash 82.00; recomputing the same
// service today gives gross 139.50 / collected 139.50 / unpaid 0.00 with cash 139.50.
// The unpaid exposure the closeout recorded is EXACTLY the money that arrived later.
//
// WHY THAT WAS SILENT BEFORE THIS MODULE. `currentServiceCloseout` overlays the stored
// snapshot for a closed service (withOfficialSnapshot) and marks it
// `financialSource: "official_closeout"`. `economiaLedgerAggregate` never read the
// official closeout store at all — it always recomputed. So the system already held both
// numbers, in two readers, with nothing stating that they answer different questions;
// and because `getCurrentServiceCloseout` only ever resolves the CURRENT service, the
// snapshot became unreachable the moment the next service opened.
//
// WHAT THIS MODULE DOES, AND DELIBERATELY DOES NOT DO. It does not recompute money and
// it does not decide which number wins — that is the caller's job, per surface. It
// normalizes an official closeout row into the SAME shape `aggregate()` produces, and
// states whether the two disagree. It is pure: no I/O, no clock, no DB — it never reads
// the closeout store itself, which is why it is not (and must not be) a sanctioned
// caller of it. Its input is a row a sanctioned reader already fetched.
//
// IMMUTABILITY IS NOT THIS MODULE'S JOB EITHER, AND IS NOT WEAKENED BY IT. Nothing here
// writes. The snapshot stays exactly as the close engine wrote it; a late payment moves
// the CURRENT figure only.

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const centsToEur = (value) => round((Number(value) || 0) / 100);

// The four canonical buckets, in the order every other reader uses them.
const PAYMENT_KEYS = Object.freeze(['efectivo', 'tarjeta', 'bizum', 'other']);
const TOTAL_KEYS = Object.freeze(['gross', 'collected', 'refunded', 'unpaid']);

// An official closeout row -> the same {totals, paymentTotals, counts} shape aggregate()
// returns, so the two semantics are directly comparable and a caller never has to know
// that one of them is stored in cents.
//
// This is the SINGLE place cents become euros for a closeout. currentServiceCloseout's
// withOfficialSnapshot delegates here rather than repeating the conversion, so the live
// closeout view and Economía can never drift on what the snapshot "means".
function snapshotToEconomicShape(row) {
  if (!row || typeof row !== 'object') return null;
  const gross = centsToEur(row.gross_sales_cents);
  const collected = centsToEur(row.paid_amount_cents);
  return Object.freeze({
    closeoutId: row.id || null,
    closedAt: row.closed_at || null,
    closeSource: row.close_source || null,
    totals: Object.freeze({
      gross,
      collected,
      refunded: centsToEur(row.total_refunds_cents),
      unpaid: centsToEur(row.unpaid_exposure_cents),
      // Cancelled/voided value is carried by the snapshot and has no live equivalent
      // in `totals` — surfaced so a report can state it.
      voided: centsToEur(row.total_void_cents),
      difference: round(gross - collected),
    }),
    paymentTotals: Object.freeze({
      efectivo: centsToEur(row.cash_amount_cents),
      tarjeta: centsToEur(row.card_amount_cents),
      bizum: centsToEur(row.bizum_amount_cents),
      other: centsToEur(row.other_amount_cents),
    }),
    counts: Object.freeze({
      tickets: Number(row.order_count) || 0,
      incidents: Number(row.incident_count) || 0,
    }),
  });
}

// Does the current reconciled truth differ from what was registered at Finalizar, and
// where? Returns null when there is nothing to compare (open service, or a legacy close
// with no snapshot row).
//
// PAYMENT METHODS ARE COMPARED TOO, not just the headline. A late CARD payment on a
// service that closed all-cash leaves `collected` identical only if something else
// changed — but the split still moved, and an operator reconciling a drawer needs that.
function describeDivergence({ current, snapshot } = {}) {
  const snap = snapshotToEconomicShape(snapshot);
  if (!snap || !current) return null;

  const totals = {};
  for (const key of TOTAL_KEYS) {
    const delta = round((Number(current.totals?.[key]) || 0) - (Number(snap.totals[key]) || 0));
    if (delta !== 0) totals[key] = delta;
  }
  const paymentTotals = {};
  for (const key of PAYMENT_KEYS) {
    const delta = round((Number(current.paymentTotals?.[key]) || 0) - (Number(snap.paymentTotals[key]) || 0));
    if (delta !== 0) paymentTotals[key] = delta;
  }

  const diverges = Object.keys(totals).length > 0 || Object.keys(paymentTotals).length > 0;
  if (!diverges) return null;
  // Deltas are CURRENT MINUS SNAPSHOT: positive `collected` means money arrived after
  // the close. Never a sum of the two — the two numbers are alternative descriptions of
  // one service, and adding them would double-count every euro.
  return Object.freeze({ totals: Object.freeze(totals), paymentTotals: Object.freeze(paymentTotals) });
}

// The full explicit answer for one service. `current` is whatever the caller's own
// aggregate() produced; `snapshot` is the raw official closeout row (or null) that a
// sanctioned reader fetched.
//
// OPEN SERVICES HAVE NO SNAPSHOT AUTHORITY YET and must never be given a fabricated one:
// closeoutSnapshot is null and divergence is null, which is a statement, not a gap.
function describeServiceEconomicTruth({ status, current, snapshot } = {}) {
  const isClosed = status === 'closed';
  const snap = isClosed ? snapshotToEconomicShape(snapshot) : null;
  return Object.freeze({
    // Named so no caller can mistake one for the other.
    closeoutSnapshot: snap,
    // Why there is no snapshot, when there is none — an open service and a legacy close
    // that predates the closeout table are different situations and must not look alike.
    closeoutSnapshotAbsentReason: snap ? null
      : (isClosed ? 'no_closeout_row' : 'service_not_closed'),
    divergesFromCloseout: snap ? describeDivergence({ current, snapshot }) !== null : false,
    divergence: snap ? describeDivergence({ current, snapshot }) : null,
  });
}

module.exports = {
  snapshotToEconomicShape,
  describeDivergence,
  describeServiceEconomicTruth,
  PAYMENT_KEYS,
  TOTAL_KEYS,
};
