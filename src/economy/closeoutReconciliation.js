"use strict";
// ===============================================================
// closeoutReconciliation.js — J-1 FINAL RECONCILIATION V1
//
// Finalizar closes ONE Operational Service. An operator counting the drawer
// counts a DAY. This module holds both truths side by side and refuses to let
// either pretend to be the other.
//
// ─── THE TWO SCOPES ────────────────────────────────────────────────────────
//   SERVICE   — the closing service's own economy, exactly as the V3 closeout
//               records it. For 480eca89: 5 tickets, 262.50 gross, 85.00 cash.
//               (The official closeout table is named in the migration and in
//               the sanctioned closeout modules, not here: a static guard
//               reserves the right to reference it to those, and this module
//               is not one of them — it only sits beside them.)
//   DAY       — the timestamp-window snapshot over the service's own Business
//               Day. For 2026-08-20 that day held TWO Operational Services:
//               406.00 gross, 386.50 collected, 157.50 cash.
//
// 85.00 and 157.50 are both correct. They are answers to different questions
// over different windows, and this module never adds, merges or reconciles
// them against each other.
//
// ─── THE RULE THAT MATTERS MOST ────────────────────────────────────────────
// A variance may ONLY be computed between a cash count and an economic window
// that are THE SAME WINDOW. Comparing the day's physical count (150.00)
// against the service's cash (85.00) would manufacture a 65.00 EUR
// "discrepancy" out of nothing but a scope error. So a cash count is attached
// only when its OWN stored window_from / window_to / window_timezone match the
// reconciliation window exactly — checked here, and checked again inside
// create_service_closeout_reconciliation_v1, which refuses the write outright
// on a mismatch. Two independent gates, because getting this wrong looks
// exactly like a theft report.
//
// --- SAME WINDOW IS NECESSARY BUT NOT SUFFICIENT: FRESHNESS ----------------
// The window is a whole Business Day, so a count taken at 13:35 and a Finalizar
// pressed at 20:00 share it. That is the trap this closes. A cash count is a
// PHYSICAL FACT AT AN INSTANT: at 13:35 the drawer held 65.00 and the ledger
// had recorded 65.00, so the variance was 0. If 51.00 of cash comes in
// afterwards the ledger moves to 116.00 -- but the 13:35 count does not
// retroactively become a 51.00 shortfall. It simply stops describing the
// present.
//
// So a count may serve as the CURRENT reconciliation count only while it is
// still semantically comparable to the current economy, which is two checks:
//
//   1. LEDGER AGREEMENT -- the count's own stored recorded_cash_receipts_cents
//      still equals this window's recorded cash receipts. This is the check
//      that catches 65 -> 116 directly.
//   2. NO LATER CASH -- no cash receipt inside this window carries an instant
//      after the count's own counted_at. This catches what gate 1 cannot see:
//      a +51.00 payment and a -51.00 refund cancelling back to 65.00, where
//      the totals agree again but the drawer was demonstrably touched after
//      the operator walked away from it.
//
// A count failing either is STALE. Stale never produces a variance and is
// never attached to a persisted reconciliation -- but it is not silently
// dropped either: it is reported as `cashCountStatus: "stale"` alongside the
// figures that made it stale, so an operator reads "this count is from 13:35,
// before 51.00 came in" instead of a fabricated 51.00 EUR of missing money.
//
// Closing WITHOUT a current count stays fully permitted, exactly as before: a
// reconciliation with no count is a normal outcome (all three count columns
// NULL together), and a count has never been a precondition for Finalizar.
//
// ─── THE WINDOW COMES FROM THE SERVICE, NEVER FROM "NOW" ───────────────────
// The default window is the Business Day of the SERVICE BEING CLOSED, resolved
// through the same canonical rule the economic presets already use (04:00
// Madrid to 04:00 Madrid, serviceSchedule). Service 480eca89 has
// business_date 2026-08-20 and is being closed on 2026-08-21; using today
// would reconcile a day it has nothing to do with and report zeros.
//
// ─── IT OWNS NO MONEY ──────────────────────────────────────────────────────
// Reading a reconciliation performs no write. Persisting one writes exactly
// one row through one RPC. Neither creates a payment, a refund, an adjustment
// or a cancellation; neither changes an order, an event, a cash count or any
// official closeout total. A variance is an observation about two numbers.
// ===============================================================

const { sbSelect, sbRpc } = require("../utils/supabase");
const { createEconomicSnapshot } = require("./economicSnapshot");
const { resolveEconomicWindow, PRESET } = require("./economicWindow");

const enc = encodeURIComponent;
const toCents = (euros) => Math.round(Number(euros || 0) * 100);
const toEuros = (cents) => Math.round(Number(cents || 0)) / 100;

class ReconciliationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "ReconciliationError";
    this.code = code;
    this.status = status;
  }
}

// Two windows are the same window only if all three parts agree exactly.
// Instant equality, not string equality: the same moment may legitimately be
// serialized differently ("+00:00" vs "Z", differing fractional digits).
function sameWindow(a, b) {
  if (!a || !b) return false;
  const t = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? NaN : d.getTime(); };
  return t(a.from) === t(b.from) && t(a.to) === t(b.to)
    && String(a.timezone) === String(b.timezone);
}

// A cash count describes the drawer at ONE INSTANT. It keeps describing the
// present only while the economy it was taken against has not moved since.
// Returns null when the count is still current, or the reason it is not.
//
// Gate 1 compares stored cents to stored cents -- the count recorded what the
// ledger held at counted_at, and that figure is immutable, so any drift is
// real movement rather than a rounding artefact.
// Gate 2 exists only for the case gate 1 is blind to: equal-and-opposite
// movement that lands back on the same total.
function cashCountStaleness(count, { cashReceiptsCents, cashReceiptsAfterCount }) {
  if (!count) return null;
  const recordedAtCount = Number(count.recorded_cash_receipts_cents);
  if (!Number.isFinite(recordedAtCount) || recordedAtCount !== cashReceiptsCents) {
    return "recorded_cash_receipts_changed";
  }
  if (cashReceiptsAfterCount > 0) return "cash_movement_after_count";
  return null;
}

// Cash receipts inside this window whose own instant falls strictly after the
// count. Voided tickets contribute nothing here for the same reason they
// contribute nothing to the totals -- safeTicket already excluded them, and a
// count cannot be stale because of money that was never counted. A receipt
// with no instant at all (the legacy pre-ledger fallback) cannot be ordered
// against the count and is deliberately not guessed at: gate 1 already sees
// its effect on the total.
function countCashReceiptsAfter(dayView, countedAt) {
  const at = new Date(countedAt).getTime();
  if (Number.isNaN(at)) return 0;
  const receipts = (dayView && dayView.drillDown && dayView.drillDown.receipts) || [];
  let n = 0;
  for (const receipt of receipts) {
    if (receipt.method !== "efectivo" || receipt.excludedAsVoid || !receipt.receiptAt) continue;
    const t = new Date(receipt.receiptAt).getTime();
    if (!Number.isNaN(t) && t > at) n += 1;
  }
  return n;
}

// One shape for a cash count whether it is the attached one or the superseded
// one, so a consumer never has to learn two. `recordedCashReceiptsAtCount` is
// what the ledger held when the operator counted; `recordedCashReceiptsNow` is
// what it holds for the same window today. Equal means nothing moved; that
// pair IS the explanation of staleness, so both travel together.
function projectCashCount(row, { current, staleReason, cashReceipts }) {
  return Object.freeze({
    id: row.id,
    countedAt: row.counted_at,
    actor: row.actor,
    countedCash: toEuros(row.counted_cash_cents),
    recordedCashReceiptsAtCount: toEuros(row.recorded_cash_receipts_cents),
    recordedCashReceiptsNow: cashReceipts,
    note: row.note || null,
    window: Object.freeze({
      from: row.window_from, to: row.window_to,
      timezone: row.window_timezone, preset: row.window_preset,
    }),
    windowMatchesExactly: true,
    isCurrent: !!current,
    staleReason: staleReason || null,
  });
}

function projectReconciliation(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    serviceSessionId: row.service_session_id,
    closeoutCorrelationId: row.closeout_correlation_id,
    window: Object.freeze({
      from: row.window_from, to: row.window_to,
      timezone: row.window_timezone, preset: row.window_preset,
    }),
    businessDate: row.business_date,
    gross: toEuros(row.gross_cents),
    collected: toEuros(row.collected_cents),
    unpaid: toEuros(row.unpaid_cents),
    voided: toEuros(row.voided_cents),
    refunded: toEuros(row.refunded_cents),
    cashReceipts: toEuros(row.cash_receipts_cents),
    cardReceipts: toEuros(row.card_receipts_cents),
    bizumReceipts: toEuros(row.bizum_receipts_cents),
    otherReceipts: toEuros(row.other_receipts_cents),
    orderCount: row.order_count,
    serviceCount: row.service_count,
    cashCountId: row.cash_count_id || null,
    countedCash: row.counted_cash_cents === null || row.counted_cash_cents === undefined
      ? null : toEuros(row.counted_cash_cents),
    variance: row.variance_cents === null || row.variance_cents === undefined
      ? null : toEuros(row.variance_cents),
    actor: row.actor,
    createdAt: row.created_at,
  });
}

function createCloseoutReconciliation({
  select = sbSelect,
  rpc = sbRpc,
  snapshot = createEconomicSnapshot(),
} = {}) {

  // The reconciliation window for a service = that service's OWN Business Day,
  // through the same canonical resolver the "hoy"/"ayer" presets use. Never
  // today's date, never `now`.
  function windowForService(session) {
    if (!session || !session.business_date) {
      throw new ReconciliationError("RECONCILIATION_BUSINESS_DATE_MISSING", 409);
    }
    return resolveEconomicWindow({
      preset: PRESET.HOY,
      businessDate: String(session.business_date).slice(0, 10),
      // `now` is irrelevant once businessDate is explicit; passed only because
      // the resolver's signature takes it.
      now: new Date(),
    });
  }

  // Compatible = the count's own window is byte-identical to this one. When
  // several qualify, the LATEST by counted_at wins — deterministic, and the
  // one the operator most recently stood at the drawer for. Every candidate is
  // returned too, so the UI can say "there are 3" rather than silently picking.
  async function findCompatibleCashCounts(win) {
    const rows = await select(
      "cash_counts",
      `window_from=eq.${enc(new Date(win.from).toISOString())}`
      + `&window_to=eq.${enc(new Date(win.to).toISOString())}`
      + `&window_timezone=eq.${enc(win.timezone)}`
      + "&order=counted_at.desc",
    );
    const list = (Array.isArray(rows) ? rows : []).filter((row) => sameWindow(win, {
      from: row.window_from, to: row.window_to, timezone: row.window_timezone,
    }));
    return list;
  }

  // build({ serviceSessionId }) -> the whole preflight payload: BOTH scopes,
  // clearly separated, plus whichever cash count (if any) is legitimately
  // comparable. Read-only.
  // With no id, resolve THE active Operational Service — the one Finalizar
  // would close. A plain SELECT, never a lifecycle call: this module must not
  // be able to open, close or resolve anything, and it does not need to.
  // service_sessions_single_active_uq guarantees at most one active row, so
  // "exactly one" is a real invariant rather than a lucky pick — and anything
  // other than exactly one is refused with a typed code instead of guessed.
  async function resolveActiveSession() {
    const rows = await select("service_sessions", "status=in.(open,closing)&order=opened_at.desc");
    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) throw new ReconciliationError("RECONCILIATION_NO_ACTIVE_SERVICE", 409);
    if (list.length > 1) throw new ReconciliationError("RECONCILIATION_AMBIGUOUS_ACTIVE_SERVICE", 409);
    return list[0];
  }

  async function build({ serviceSessionId, now = new Date() } = {}) {
    let session;
    if (serviceSessionId) {
      const rows = await select("service_sessions", `id=eq.${enc(String(serviceSessionId))}&limit=1`);
      session = Array.isArray(rows) ? rows[0] : null;
      if (!session) throw new ReconciliationError("RECONCILIATION_SESSION_NOT_FOUND", 404);
    } else {
      session = await resolveActiveSession();
    }

    const win = windowForService(session);

    // SERVICE SCOPE — the closing service's own economy, read through the
    // snapshot's `servicio` preset so both scopes come from ONE reader and
    // cannot drift. This reproduces the V3 closeout's own figures because it
    // applies the same safeTicket rules to the same service-scoped rows.
    const serviceView = await snapshot({
      preset: PRESET.SERVICIO, serviceSessionId: String(session.id), now,
    });

    // DAY SCOPE — the service's Business Day, spanning however many
    // Operational Services that day actually contained.
    const dayView = await snapshot({
      preset: PRESET.PERSONALIZADO, from: win.from, to: win.to, now,
    });

    const cashReceipts = dayView.receipts.byMethod.efectivo;

    // Window-compatible counts, newest first. The newest is the ONLY candidate
    // for "current": every older one was taken before it, so any movement that
    // staled the newest staled them too. If the newest is not current, none is.
    const candidates = await findCompatibleCashCounts(win);
    const latest = candidates[0] || null;
    const staleReason = cashCountStaleness(latest, {
      cashReceiptsCents: toCents(cashReceipts),
      cashReceiptsAfterCount: latest ? countCashReceiptsAfter(dayView, latest.counted_at) : 0,
    });
    // Attached only when current. A stale count is still REPORTED below, but
    // it is not the reconciliation's count and it produces no variance.
    const chosen = latest && !staleReason ? latest : null;

    return Object.freeze({
      ok: true,
      serviceSessionId: String(session.id),
      businessDate: session.business_date,
      status: session.status,

      // SCOPE 1 — "Este servicio".
      service: Object.freeze({
        scope: "service",
        serviceSessionId: String(session.id),
        orderCount: serviceView.counts.obligations,
        gross: serviceView.obligation.gross,
        collected: serviceView.receipts.collected,
        unpaid: serviceView.obligation.unpaid,
        voided: serviceView.obligation.voided,
        refunded: serviceView.obligation.refunded,
        byMethod: serviceView.receipts.byMethod,
        window: serviceView.window,
      }),

      // SCOPE 2 — "Día operativo".
      reconciliation: Object.freeze({
        scope: "business_day",
        window: Object.freeze({ from: win.from, to: win.to, timezone: win.timezone, preset: win.preset }),
        businessDate: win.businessDate,
        orderCount: dayView.counts.obligations,
        gross: dayView.obligation.gross,
        collected: dayView.receipts.collected,
        unpaid: dayView.obligation.unpaid,
        voided: dayView.obligation.voided,
        refunded: dayView.obligation.refunded,
        byMethod: dayView.receipts.byMethod,
        cashReceipts,
        // How many Operational Services this window really spanned — the
        // number that explains why day cash can exceed service cash.
        serviceCount: dayView.serviceProvenance.length,
        serviceProvenance: dayView.serviceProvenance,
      }),

      // THE COUNT — present only when its window matches exactly AND it is
      // still current. Consumers that only ever wanted "the count I may
      // compare against" read this field and are correct by construction.
      cashCount: chosen ? projectCashCount(chosen, { current: true, staleReason: null, cashReceipts }) : null,
      cashCountCandidates: candidates.length,

      // "none"    — no window-compatible count exists at all.
      // "current" — the newest one still describes this economy.
      // "stale"   — one exists, but the economy moved after it was taken. The
      //             close is still allowed; there is simply nothing to compare.
      cashCountStatus: !latest ? "none" : chosen ? "current" : "stale",
      cashCountStaleReason: staleReason,
      // The newest window-compatible count WHATEVER its status, so a stale one
      // can be shown as the historical fact it is (with its own instant and
      // the ledger figure it was taken against) instead of vanishing.
      latestCashCount: latest
        ? projectCashCount(latest, { current: !staleReason, staleReason, cashReceipts })
        : null,

      // variance = counted - recorded. NEGATIVE means the drawer held LESS
      // than the period's recorded cash receipts. Same convention as
      // cash_counts (ledger 98) and the certified UAT row (-7.50). Null when
      // no CURRENT count exists — never zero, which would falsely assert
      // agreement nobody verified, and never counted-minus-a-later-total,
      // which would report money as missing that was simply taken after the
      // operator counted.
      variance: chosen ? Math.round((toEuros(chosen.counted_cash_cents) - cashReceipts) * 100) / 100 : null,
      // Opening float, deposits, withdrawals, petty cash, transfers and tips
      // are NOT modelled anywhere in this system, so this difference is not an
      // accounting conclusion about a shortfall. Stated on the wire so no
      // consumer has to infer it.
      varianceSemantics: "counted_minus_recorded_receipts",
      drawerMovementsModeled: false,
    });
  }

  // Persist the context a close was actually made under. Called by the V3
  // engine AFTER the closeout row exists and BEFORE the terminal transition,
  // so a failure here leaves the service OPEN and the attempt active rather
  // than closed-without-context. Idempotent on closeoutCorrelationId.
  async function persist({ serviceSessionId, closeoutCorrelationId, actor, now = new Date() } = {}) {
    if (!serviceSessionId || !closeoutCorrelationId) {
      return { success: false, code: "RECONCILIATION_INVALID_ARGS" };
    }
    let view;
    try {
      view = await build({ serviceSessionId, now });
    } catch (e) {
      return { success: false, code: e?.code || "RECONCILIATION_BUILD_FAILED", detail: String((e && e.message) || e) };
    }
    const r = view.reconciliation;
    // Belt and braces: the RPC re-checks BOTH of these and refuses, but never
    // send a count whose window we have not ourselves proven identical, nor
    // one we have not proven still current. `view.cashCount` is already null
    // for a stale count; re-reading `cashCountStatus` states the requirement
    // at the write boundary rather than relying on that at a distance. A
    // persisted reconciliation is permanent append-only evidence, so linking a
    // superseded count would fossilise a variance that was never real.
    const count = view.cashCount
      && view.cashCountStatus === "current"
      && sameWindow(r.window, view.cashCount.window)
      ? view.cashCount : null;

    let result;
    try {
      result = await rpc("create_service_closeout_reconciliation_v1", {
        p_service_session_id: String(serviceSessionId),
        p_closeout_correlation_id: String(closeoutCorrelationId),
        p_window_from: new Date(r.window.from).toISOString(),
        p_window_to: new Date(r.window.to).toISOString(),
        p_window_timezone: r.window.timezone,
        p_window_preset: r.window.preset,
        p_business_date: String(view.businessDate).slice(0, 10),
        p_gross_cents: toCents(r.gross),
        p_collected_cents: toCents(r.collected),
        p_unpaid_cents: toCents(r.unpaid),
        p_voided_cents: toCents(r.voided),
        p_refunded_cents: toCents(r.refunded),
        p_cash_receipts_cents: toCents(r.cashReceipts),
        p_card_receipts_cents: toCents(r.byMethod.tarjeta),
        p_bizum_receipts_cents: toCents(r.byMethod.bizum),
        p_other_receipts_cents: toCents(r.byMethod.other),
        p_order_count: r.orderCount,
        p_service_count: r.serviceCount,
        p_actor: String(actor || "system"),
        p_cash_count_id: count ? count.id : null,
        p_counted_cash_cents: count ? toCents(count.countedCash) : null,
      });
    } catch (e) {
      return { success: false, code: "RECONCILIATION_PERSIST_TRANSPORT_ERROR", detail: String((e && e.message) || e) };
    }
    const body = result && result.ok === true ? result.body : null;
    if (!body || body.ok !== true) {
      return { success: false, code: (body && body.code) || "RECONCILIATION_PERSIST_FAILED" };
    }
    return {
      success: true,
      created: body.created === true,
      reconciliation: projectReconciliation(body.reconciliation),
    };
  }

  async function getBySessionId({ serviceSessionId } = {}) {
    const rows = await select(
      "service_closeout_reconciliations",
      `service_session_id=eq.${enc(String(serviceSessionId))}&order=created_at.desc&limit=1`,
    );
    return projectReconciliation(Array.isArray(rows) ? rows[0] : null);
  }

  return Object.freeze({ build, persist, getBySessionId, windowForService, resolveActiveSession, sameWindow });
}

const closeoutReconciliation = createCloseoutReconciliation();

module.exports = { createCloseoutReconciliation, closeoutReconciliation, ReconciliationError, sameWindow };
