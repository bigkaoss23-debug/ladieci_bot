"use strict";
// ===============================================================
// economicSnapshot.js — I-1 ECONOMIC SNAPSHOT V1
//
// ONE read-only economic reader, defined by a timestamp window.
//
// ─── THE CONTRACT ──────────────────────────────────────────────────────────
// SNAPSHOT_DB_WRITES = 0. This module reads. It never opens or closes a
// service, never moves a lifecycle pointer, never consumes an event, never
// archives, never resets a total. It calls sbSelect and nothing else — no
// sbRpc, no sbInsert/sbUpdate/sbUpsert/sbDelete — and a static test pins that.
//
// ─── TWO SETS, NOT ONE ─────────────────────────────────────────────────────
// A closeout can pretend obligations and receipts are the same population,
// because a service is (usually) opened and closed around both. An arbitrary
// window cannot, and pretending otherwise is how a reader starts lying. So
// this module computes two independent populations over the SAME interval:
//
//   OBLIGATIONS — orders whose obligation instant falls in [from, to).
//                 Gross, unpaid exposure and void impact are theirs.
//   RECEIPTS    — payment/refund events whose event instant falls in
//                 [from, to). Collected cash/card/bizum/other are theirs.
//
// They are NOT expected to reconcile. An order created at 21:21 and paid at
// 21:29 puts its obligation in one window and its receipt in another if the
// operator asked for a window that ends at 21:25. That is a true report of a
// real evening, not an error, and `windowCrossing` below names every such
// fact explicitly so the operator can see exactly which ones straddle the cut.
//
// ─── WHY created_at, NEVER ts ──────────────────────────────────────────────
// `ordenes.ts` is a client-supplied epoch and is 0 on three real staging rows
// language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal these three real rows carry, cited as evidence, not new vocabulary
// (#V36-SYNTH-1, #999001, #999002 — all CHIUSO_FORZATO test residue), which
// would place them in 1970 and make them invisible to every honest window
// while still being counted by any service-scoped reader. `created_at` is
// database-generated, NOT NULL in practice on both order tables, and is the
// only defensible obligation instant. `order_financial_events.created_at` is
// NOT NULL by schema and is the receipt instant.
//
// ─── WHERE ORDERS LIVE ─────────────────────────────────────────────────────
// Both order stores are read and de-duplicated on every window, unconditional-
// ly. UAT-P1-B already proved the conditional form wrong for the live closeout
// (a V3 operator Finalizar leaves rows in `ordenes` while the legacy nightly
// archive moves them, so reading one table by status reported a real 7-ticket
// service as zero). A timestamp window has no status to branch on in the first
// place, so it reads both and de-duplicates by order key — which is also why
// it is immune to that whole bug class.
//
// ─── ECONOMIC ERA IS REPORTING-ONLY ────────────────────────────────────────
// The midday/evening split reported in `economicBreakdown` is the STAMPED era
// (economicPeriodReadRule: explicit S-C stamp wins, else the fact's own
// session's kind), never re-derived from the clock — E1, frozen by S-C/S-E.
// The `mediodia` / `noche` PRESETS are something else entirely: plain
// timestamp windows cut at serviceSchedule's 17:30 boundary. The two can
// legitimately disagree (a pre-S-C fact carries no stamp and its
// operational_service_v1 session has none either, so it reports `unknown`
// while still being fully counted in the window's money). Both are reported.
// Neither is load-bearing for a single euro of the totals.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const {
  safeTicket, paymentBucket, eventType, eventAmount, emptyPaymentTotals, addMethodAmount, round, CANCELLED,
} = require("../closeout/currentServiceCloseout");
const { resolveEconomicPeriodKind } = require("../closeout/economicPeriodReadRule");
const {
  PRESET, resolveEconomicWindow, windowForServiceSession, EconomicWindowError,
} = require("./economicWindow");

// PostgREST `in.(...)` lives in a URL; a window with many orders must not
// build one unbounded query string.
const ID_BATCH = 80;

const PAYMENT_TYPES = new Set(["payment", "payment_imported"]);
// language-guard: allow-legacy storico is the existing archive table name this repo already queries in currentServiceCloseout.js and economiaLedgerAggregate.js, not new vocabulary
const ORDER_TABLES = Object.freeze(["ordenes", "storico"]);

const enc = encodeURIComponent;

// ─── ORDER IDENTITY IS COMPOSITE ───────────────────────────────────────────
// `#001` is NOT a unique order. The human order number restarts per service,
// so staging really does hold three different orders called `#001` (sessions
// 1cfaabf8 / 9fe2f3c1 / 33174121), 6 order ids that exist in BOTH order
// tables as genuinely different orders, and 4 order ids whose financial
// events span more than one service. currentServiceCloseout can key on the
// bare id safely ONLY because it has already filtered every row to one
// service_session_id; a timestamp window has not, and keying on the bare id
// there would silently merge two evenings' orders into one ticket and attach
// one service's payments to another service's obligation.
//
// The composite (service_session_id, order_id) IS unique — verified against
// live staging: 0 duplicates within a session in either order table, 0 rows
// sharing both id and session across the two tables, and service_session_id
// language-guard: allow-legacy storico is the existing archive table name, listed here only to state where the verified property holds, not new vocabulary
// is non-null on every row of ordenes, storico and order_financial_events.
const orderId = (row) => String(row?.orden_id || row?.id || "");
const sessionId = (row) => String(row?.service_session_id || "");
const orderKey = (row) => `${sessionId(row)}::${orderId(row)}`;
const eventKey = (event) => `${String(event?.service_session_id || "")}::${String(event?.order_id || event?.orden_id || "")}`;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function windowFilter(column, from, to) {
  return `${column}=gte.${enc(from)}&${column}=lt.${enc(to)}`;
}

function dedupeOrders(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = orderKey(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function selectAllOrders(select, filter) {
  const collected = [];
  for (const table of ORDER_TABLES) {
    const rows = await select(table, filter);
    if (Array.isArray(rows)) collected.push(...rows);
  }
  return dedupeOrders(collected);
}

async function selectEventsForOrders(select, ids, { before = null } = {}) {
  if (!ids.length) return [];
  const out = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const parts = [`order_id=in.(${batch.map((id) => enc(String(id))).join(",")})`];
    if (before) parts.push(`created_at=lt.${enc(before)}`);
    parts.push("order=created_at.asc");
    const rows = await select("order_financial_events", parts.join("&"));
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

async function selectOrdersByIds(select, ids) {
  if (!ids.length) return [];
  const collected = [];
  for (const table of ORDER_TABLES) {
    const column = table === "ordenes" ? "id" : "orden_id";
    for (const batch of chunk(ids, ID_BATCH)) {
      const rows = await select(table, `${column}=in.(${batch.map((id) => enc(String(id))).join(",")})`);
      if (Array.isArray(rows)) collected.push(...rows);
    }
  }
  return dedupeOrders(collected);
}

async function selectSessions(select, ids) {
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  if (!clean.length) return new Map();
  const map = new Map();
  for (const batch of chunk(clean, ID_BATCH)) {
    const rows = await select("service_sessions", `id=in.(${batch.map(enc).join(",")})`);
    for (const row of Array.isArray(rows) ? rows : []) map.set(String(row.id), row);
  }
  return map;
}

const EMPTY_ERA = () => ({ PRANZO: 0, SERA: 0, unknown: 0 }); // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, used here as object keys exactly as currentServiceCloseout.js already does, not new vocabulary

function addEra(target, key, amount) {
  const bucket = key && Object.prototype.hasOwnProperty.call(target, key) ? key : "unknown";
  target[bucket] = round(target[bucket] + amount);
}

// createEconomicSnapshot({ select }) -> getEconomicSnapshot(params)
//
// params: { preset?, from?, to?, businessDate?, asOf?, serviceSessionId?, now? }
//
//   preset            one of economicWindow.PRESET (default "hoy")
//   from / to         required for preset "personalizado"; ignored otherwise
//   asOf              the instant at which the window's obligations are
//                     settled-evaluated. Defaults to `now`. Receipts are
//                     ALWAYS [from, to) and never depend on asOf.
//   serviceSessionId  required for preset "servicio" (window := that session's
//                     own interval). For every other preset it is an OPTIONAL
//                     provenance FILTER narrowing the rows inside the window —
//                     never the window itself.
function createEconomicSnapshot({ select = sbSelect } = {}) {
  return async function getEconomicSnapshot({
    preset = PRESET.HOY,
    from,
    to,
    businessDate,
    asOf,
    serviceSessionId,
    now = new Date(),
  } = {}) {
    const generatedAt = now instanceof Date ? now : new Date(now);
    const key = String(preset || "").trim().toLowerCase();

    // ── 1. WINDOW ──────────────────────────────────────────────────────────
    let win;
    let sessionScope = null;
    if (key === PRESET.SERVICIO) {
      if (!serviceSessionId) throw new EconomicWindowError("ECONOMY_SERVICE_SESSION_REQUIRED");
      const rows = await select("service_sessions", `id=eq.${enc(String(serviceSessionId))}&limit=1`);
      const session = Array.isArray(rows) ? rows[0] : null;
      if (!session) throw new EconomicWindowError("ECONOMY_SERVICE_SESSION_NOT_FOUND", 404);
      win = windowForServiceSession(session, { asOf: generatedAt });
      sessionScope = String(session.id);
    } else {
      win = resolveEconomicWindow({ preset: key, from, to, businessDate, now: generatedAt });
      sessionScope = serviceSessionId ? String(serviceSessionId) : null;
    }
    const settleAt = asOf ? new Date(asOf) : generatedAt;
    if (Number.isNaN(settleAt.getTime())) throw new EconomicWindowError("ECONOMY_AS_OF_INVALID");
    if (settleAt.getTime() < new Date(win.from).getTime()) throw new EconomicWindowError("ECONOMY_AS_OF_BEFORE_WINDOW");
    const scopeFilter = sessionScope ? `&service_session_id=eq.${enc(sessionScope)}` : "";

    // ── 2. OBLIGATIONS: orders created inside the window ────────────────────
    const obligationRows = await selectAllOrders(
      select,
      `${windowFilter("created_at", win.from, win.to)}${scopeFilter}&order=created_at.asc`,
    );
    // The `in.(...)` filter can only speak the bare id; the composite match
    // happens in memory immediately below, so a foreign session's event that
    // shares an id is fetched and then discarded rather than counted.
    const obligationIds = [...new Set(obligationRows.map(orderId).filter(Boolean))];
    // ALL of each obligation's events up to asOf — settlement is a property of
    // the whole order, not of the slice of it that happens to fall in-window.
    const obligationEvents = await selectEventsForOrders(select, obligationIds, { before: settleAt.toISOString() });

    // ── 3. RECEIPTS: events recorded inside the window ──────────────────────
    const receiptEvents = (await (async () => {
      const rows = await select(
        "order_financial_events",
        `${windowFilter("created_at", win.from, win.to)}${scopeFilter}&order=created_at.asc`,
      );
      return Array.isArray(rows) ? rows : [];
    })());

    // A receipt may belong to an order created OUTSIDE the window. Those order
    // rows are fetched too — only to learn whether the order is voided (a
    // voided ticket collects nothing, mirroring safeTicket) and for drill-down
    // provenance. They never enter gross.
    const obligationByKey = new Map(obligationRows.map((row) => [orderKey(row), row]));
    const foreignIds = [...new Set(receiptEvents
      .filter((e) => !obligationByKey.has(eventKey(e)))
      .map((e) => String(e.order_id || e.orden_id || ""))
      .filter(Boolean))];
    const foreignOrders = await selectOrdersByIds(select, foreignIds);
    const orderByKey = new Map(obligationByKey);
    // Composite again: a fetched foreign row only counts as THIS event's order
    // when its session matches too, so an id collision resolves to the right one.
    for (const row of foreignOrders) if (!orderByKey.has(orderKey(row))) orderByKey.set(orderKey(row), row);

    const sessions = await selectSessions(select, [
      ...obligationRows.map((r) => r.service_session_id),
      ...foreignOrders.map((r) => r.service_session_id),
      ...receiptEvents.map((e) => e.service_session_id),
      ...receiptEvents.map((e) => e.event_service_session_id),
    ]);
    const sessionOf = (row) => sessions.get(String(row?.service_session_id || "")) || null;

    // ── 4. OBLIGATION SIDE — safeTicket, unchanged, per order ───────────────
    const eventsByOrder = new Map();
    for (const event of obligationEvents) {
      const key = eventKey(event);
      if (!eventsByOrder.has(key)) eventsByOrder.set(key, []);
      eventsByOrder.get(key).push(event);
    }
    const obligations = obligationRows.map((row) => {
      const key = orderKey(row);
      const ticket = safeTicket(row, eventsByOrder.get(key) || [], sessionOf(row));
      return Object.freeze({
        ...ticket,
        orderKey: key,
        obligationAt: row.created_at || null,
        serviceSessionId: row.service_session_id ? String(row.service_session_id) : null,
      });
    });

    const gross = round(obligations.filter((t) => !t.cancelled).reduce((s, t) => s + t.amount, 0));
    const unpaid = round(obligations.reduce((s, t) => s + t.unpaidAmount, 0));
    const voided = round(obligations.filter((t) => t.cancelled).reduce((s, t) => s + t.amount, 0));
    const obligationRefunded = round(obligations.reduce((s, t) => s + t.refundedAmount, 0));

    // ── 5. RECEIPT SIDE — events in window, by their own instant ────────────
    const receiptTotals = emptyPaymentTotals();
    const receiptEra = EMPTY_ERA();
    let collected = 0;
    let refunded = 0;
    let paymentCount = 0;
    let refundCount = 0;
    const receipts = [];
    for (const event of receiptEvents) {
      const id = String(event.order_id || event.orden_id || "");
      const order = orderByKey.get(eventKey(event)) || null;
      const type = eventType(event);
      const isPayment = PAYMENT_TYPES.has(type);
      const isRefund = type === "refund";
      if (!isPayment && !isRefund) continue;
      // Mirrors safeTicket: a voided ticket contributes no receipts at all.
      const cancelled = !!order && (CANCELLED.has(String(order.estado || order.state || "").toUpperCase()));
      const amount = eventAmount(event);
      const signed = isRefund ? -amount : amount;
      if (!cancelled) {
        addMethodAmount(receiptTotals, event.payment_method, signed);
        if (isPayment) collected = round(collected + amount);
        if (isRefund) refunded = round(refunded + amount);
        const eraSession = (!event.event_service_session_id
          || String(event.event_service_session_id) === String(order?.service_session_id || ""))
          ? sessionOf(order) : sessions.get(String(event.event_service_session_id)) || null;
        addEra(receiptEra, resolveEconomicPeriodKind(event.event_economic_period_kind, eraSession), signed);
      }
      if (isPayment) paymentCount += 1;
      if (isRefund) refundCount += 1;
      receipts.push(Object.freeze({
        eventId: event.id ? String(event.id) : null,
        orderId: id,
        orderKey: eventKey(event),
        type,
        amount,
        signedAmount: signed,
        method: paymentBucket(event.payment_method),
        rawMethod: event.payment_method || null,
        receiptAt: event.created_at || null,
        excludedAsVoid: cancelled,
        serviceSessionId: event.service_session_id ? String(event.service_session_id) : null,
        obligationAt: order?.created_at || null,
      }));
    }

    // ── 5b. LEGACY RECEIPTS — an order paid before the event ledger existed ──
    // No event means no receipt instant, so the obligation instant is the only
    // defensible proxy and it is reported as such (`legacyFallback: true`),
    // never silently merged. Zero such rows exist in staging today
    // (ORDERS_USING_LEGACY_FALLBACK = 0); the branch stays because the money
    // rule in safeTicket still has it and the two must not diverge.
    const legacyReceipts = [];
    for (const ticket of obligations) {
      const row = obligationByKey.get(ticket.orderKey);
      const hasEvidence = (eventsByOrder.get(ticket.orderKey) || []).length > 0;
      if (hasEvidence || ticket.cancelled) continue;
      if (!(row?.cobrado === true || row?.ya_pagado === true)) continue;
      addMethodAmount(receiptTotals, row.metodo_pago, ticket.amount);
      collected = round(collected + ticket.amount);
      addEra(receiptEra, resolveEconomicPeriodKind(null, sessionOf(row)), ticket.amount);
      paymentCount += 1;
      legacyReceipts.push(Object.freeze({
        orderId: String(ticket.id),
        orderKey: ticket.orderKey,
        amount: ticket.amount,
        method: paymentBucket(row.metodo_pago),
        receiptAt: row.created_at || null,
        legacyFallback: true,
      }));
    }

    // ── 6. WINDOW-CROSSING — named, never hidden ────────────────────────────
    const windowFrom = new Date(win.from).getTime();
    const windowTo = new Date(win.to).getTime();
    const inWindow = (value) => {
      const t = value ? new Date(value).getTime() : NaN;
      return Number.isFinite(t) && t >= windowFrom && t < windowTo;
    };
    const obligationBeforeReceiptInside = receipts
      .filter((r) => !r.excludedAsVoid && r.obligationAt && !inWindow(r.obligationAt) && new Date(r.obligationAt).getTime() < windowFrom);
    const obligationInsideReceiptAfter = obligations
      .filter((t) => !t.cancelled && t.unpaidAmount === 0 && t.collectedAmount > 0)
      .flatMap((t) => (eventsByOrder.get(t.orderKey) || [])
        .filter((e) => PAYMENT_TYPES.has(eventType(e)) && !inWindow(e.created_at))
        .map((e) => ({ orderId: String(t.id), obligationAt: t.obligationAt, receiptAt: e.created_at, amount: eventAmount(e) })));
    const partiallyReceiptedInWindow = obligations
      .filter((t) => !t.cancelled)
      .map((t) => {
        const all = eventsByOrder.get(t.orderKey) || [];
        const inside = all.filter((e) => PAYMENT_TYPES.has(eventType(e)) && inWindow(e.created_at));
        const outside = all.filter((e) => PAYMENT_TYPES.has(eventType(e)) && !inWindow(e.created_at));
        if (!inside.length || !outside.length) return null;
        return {
          orderId: String(t.id),
          amount: t.amount,
          receiptedInWindow: round(inside.reduce((s, e) => s + eventAmount(e), 0)),
          receiptedOutsideWindow: round(outside.reduce((s, e) => s + eventAmount(e), 0)),
        };
      })
      .filter(Boolean);

    // ── 7. ECONOMIC ERA (reporting only) ────────────────────────────────────
    const obligationEra = EMPTY_ERA();
    for (const ticket of obligations) {
      if (ticket.cancelled) continue;
      addEra(obligationEra, ticket.economicKind, ticket.amount);
    }

    const serviceProvenance = [...new Set([
      ...obligations.map((t) => t.serviceSessionId),
      ...receipts.map((r) => r.serviceSessionId),
    ].filter(Boolean))].map((id) => {
      const session = sessions.get(id) || null;
      return Object.freeze({
        serviceSessionId: id,
        businessDate: session?.business_date || null,
        status: session?.status || null,
        openedAt: session?.opened_at || null,
        closedAt: session?.closed_at || null,
      });
    });

    return Object.freeze({
      ok: true,
      window: Object.freeze({ ...win, asOf: settleAt.toISOString(), generatedAt: generatedAt.toISOString() }),
      // What the operator owes-us / we-owe, for obligations BORN in this window.
      obligation: Object.freeze({
        gross,
        unpaid,
        voided,
        refunded: obligationRefunded,
      }),
      // What actually moved money in this window, by its own instant.
      receipts: Object.freeze({
        collected: round(collected - refunded),
        collectedGross: collected,
        refunded,
        byMethod: Object.freeze({ ...receiptTotals }),
      }),
      counts: Object.freeze({
        obligations: obligations.length,
        obligationsCancelled: obligations.filter((t) => t.cancelled).length,
        obligationsUnpaid: obligations.filter((t) => !t.cancelled && t.unpaidAmount > 0).length,
        receiptEvents: paymentCount + refundCount,
        payments: paymentCount,
        refunds: refundCount,
      }),
      // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values reported here as stamped-era keys, not new vocabulary
      // Reporting only. Never used to select rows, never used to total money.
      economicBreakdown: Object.freeze({
        obligations: Object.freeze({ ...obligationEra }),
        receipts: Object.freeze({ ...receiptEra }),
        source: "stamped_era_read_rule",
      }),
      windowCrossing: Object.freeze({
        obligationBeforeWindowReceiptInside: Object.freeze(obligationBeforeReceiptInside.map((r) => Object.freeze({
          orderId: r.orderId, obligationAt: r.obligationAt, receiptAt: r.receiptAt, amount: r.amount,
        }))),
        obligationInsideWindowReceiptAfter: Object.freeze(obligationInsideReceiptAfter.map(Object.freeze)),
        receiptsSplitAcrossBoundary: Object.freeze(partiallyReceiptedInWindow.map(Object.freeze)),
      }),
      drillDown: Object.freeze({
        obligations: Object.freeze(obligations),
        receipts: Object.freeze(receipts),
        legacyReceipts: Object.freeze(legacyReceipts),
      }),
      serviceProvenance: Object.freeze(serviceProvenance),
    });
  };
}

const getEconomicSnapshot = createEconomicSnapshot();

module.exports = { createEconomicSnapshot, getEconomicSnapshot };
