"use strict";
// ===============================================================
// cashCountService.js — I-1 CASH COUNT V1
//
// Records what an operator physically counted in the drawer, at a moment,
// against a chosen economic window. See the migration
// (2026-08-21_i1_cash_counts_append_only.sql) for the full rationale; the
// three rules that shape THIS file are:
//
//   1. IT IS NOT A CLOSE. Nothing here resolves, opens, closes or even asks
//      about Operational Service lifecycle state. It calls the read-only
//      snapshot reader and one INSERT. There is deliberately no code path
//      from a cash count to ensureCurrentServiceSession, to any mesa_* or
//      *_service_session_* RPC, or to the close engine — and a static test
//      asserts that by scanning this file's own source.
//
//   2. THE ACTOR COMES FROM THE TOKEN, NEVER THE BODY. `context` is built by
//      the router's auth middleware from a verified JWT plus a fresh read of
//      the authoritative actor row. A request body naming an actor is ignored
//      outright — attribution is the only thing that makes a count evidence.
//
//   3. IT DOES NOT CLAIM TO KNOW THE DRAWER. The comparison figure is cash
//      RECEIPTS RECORDED in the window. Opening float, deposits, withdrawals,
//      petty cash, transfers and tips are not modelled anywhere in this
//      system, so an expected physical balance cannot be computed and is not
//      offered. `variance` is the arithmetic difference and nothing more.
// ===============================================================

const { sbSelect, sbInsert } = require("../utils/supabase");
const { createEconomicSnapshot } = require("./economicSnapshot");
const { PRESET } = require("./economicWindow");

class CashCountError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "CashCountError";
    this.code = code;
    this.status = status;
  }
}

// Money crosses the wire as euros and is stored as integer cents, matching the
// integer-cents convention the official closeout snapshot already uses for
// every stored monetary column. (That table is named in the migration, not
// here: a static guard reserves the right to name it to the sanctioned
// closeout modules, and this module is not one of them — it only borrows the
// convention.) One conversion point, rounded once, never re-derived.
const toCents = (euros) => Math.round(Number(euros) * 100);
const toEuros = (cents) => Math.round(Number(cents || 0)) / 100;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
// A physical drawer holds notes and coins, not a negative number and not a
// fortune. The ceiling is a typo guard (1,000,000.00 EUR), not a business rule.
const MAX_COUNT_CENTS = 100000000;

function requireContext(context) {
  if (!context || typeof context.actor !== "string" || !context.actor
      || typeof context.role !== "string" || !context.role
      || typeof context.workspaceId !== "string" || !context.workspaceId) {
    throw new CashCountError("ECONOMY_UNAUTHENTICATED", 401);
  }
  return context;
}

function requireCountedCash(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CashCountError("ECONOMY_CASH_COUNT_INVALID");
  }
  const cents = toCents(value);
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_COUNT_CENTS) {
    throw new CashCountError("ECONOMY_CASH_COUNT_OUT_OF_RANGE");
  }
  return cents;
}

function requireRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) {
    throw new CashCountError("ECONOMY_CLIENT_REQUEST_ID_INVALID");
  }
  return value;
}

function optionalNote(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 500) throw new CashCountError("ECONOMY_NOTE_INVALID");
  return value;
}

function projectCount(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    countedAt: row.counted_at,
    actor: row.actor,
    actorRole: row.actor_role,
    countedCash: toEuros(row.counted_cash_cents),
    // Named exactly as the column is, for exactly the same reason: this is
    // what the ledger recorded, not what the drawer "should" hold.
    recordedCashReceipts: toEuros(row.recorded_cash_receipts_cents),
    variance: toEuros(row.variance_cents),
    window: Object.freeze({
      from: row.window_from,
      to: row.window_to,
      timezone: row.window_timezone,
      preset: row.window_preset,
    }),
    serviceSessionId: row.service_session_id || null,
    note: row.note || null,
    snapshotContext: row.snapshot_context || null,
    createdAt: row.created_at,
  });
}

function createCashCountService({
  select = sbSelect,
  insert = sbInsert,
  snapshot = createEconomicSnapshot(),
} = {}) {
  // Reads the window's economy, then writes ONE row. The snapshot call is the
  // same read-only reader the Snapshot surface uses — the number an operator
  // is compared against is by construction the number they were shown.
  async function create({
    context,
    preset = PRESET.HOY,
    from,
    to,
    businessDate,
    serviceSessionId,
    countedCash,
    note,
    clientRequestId,
    now = new Date(),
  } = {}) {
    const actor = requireContext(context);
    const countedCents = requireCountedCash(countedCash);
    const requestId = requireRequestId(clientRequestId);
    const cleanNote = optionalNote(note);

    const view = await snapshot({ preset, from, to, businessDate, serviceSessionId, now });

    const recordedCents = toCents(view.receipts.byMethod.efectivo);
    const varianceCents = countedCents - recordedCents;

    // Idempotency: the same clientRequestId must return the SAME count, never
    // a second one. Checked before insert for a clean answer, and backed by a
    // unique index so a genuine race still cannot create two rows.
    const existing = await select("cash_counts", `client_request_id=eq.${encodeURIComponent(requestId)}&limit=1`);
    if (Array.isArray(existing) && existing[0]) {
      return Object.freeze({ ok: true, created: false, count: projectCount(existing[0]) });
    }

    const payload = {
      counted_at: (now instanceof Date ? now : new Date(now)).toISOString(),
      // From the verified token. A body-supplied actor is never consulted.
      actor: actor.actor,
      actor_role: actor.role,
      workspace_id: actor.workspaceId,
      counted_cash_cents: countedCents,
      recorded_cash_receipts_cents: recordedCents,
      variance_cents: varianceCents,
      window_from: view.window.from,
      window_to: view.window.to,
      window_timezone: view.window.timezone,
      window_preset: view.window.preset,
      // Optional provenance. Recorded when the operator was looking at one
      // service, absent otherwise — and load-bearing for nothing either way.
      service_session_id: view.window.serviceSessionId || (serviceSessionId ? String(serviceSessionId) : null),
      snapshot_context: {
        generatedAt: view.window.generatedAt,
        asOf: view.window.asOf,
        obligation: view.obligation,
        receipts: view.receipts,
        counts: view.counts,
        // Recorded so a later reader can tell a variance caused by a genuine
        // shortfall from one caused by a window that cut a payment in half.
        windowCrossing: {
          obligationBeforeWindowReceiptInside: view.windowCrossing.obligationBeforeWindowReceiptInside.length,
          obligationInsideWindowReceiptAfter: view.windowCrossing.obligationInsideWindowReceiptAfter.length,
          receiptsSplitAcrossBoundary: view.windowCrossing.receiptsSplitAcrossBoundary.length,
        },
      },
      note: cleanNote,
      client_request_id: requestId,
    };

    let inserted;
    try {
      inserted = await insert("cash_counts", payload);
    } catch (error) {
      // The unique index fired: another request with this id won the race.
      const again = await select("cash_counts", `client_request_id=eq.${encodeURIComponent(requestId)}&limit=1`);
      if (Array.isArray(again) && again[0]) {
        return Object.freeze({ ok: true, created: false, count: projectCount(again[0]) });
      }
      throw error;
    }
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    return Object.freeze({ ok: true, created: true, count: projectCount(row) });
  }

  // Newest first. History is read-only by construction — there is no update
  // and no delete anywhere in this service, and the database refuses both.
  async function list({ context, from, to, limit = 20 } = {}) {
    requireContext(context);
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
    const filters = [];
    if (from) filters.push(`counted_at=gte.${encodeURIComponent(new Date(from).toISOString())}`);
    if (to) filters.push(`counted_at=lt.${encodeURIComponent(new Date(to).toISOString())}`);
    filters.push("order=counted_at.desc");
    filters.push(`limit=${size}`);
    const rows = await select("cash_counts", filters.join("&"));
    return Object.freeze({
      ok: true,
      counts: Object.freeze((Array.isArray(rows) ? rows : []).map(projectCount)),
    });
  }

  return Object.freeze({ create, list });
}

module.exports = { createCashCountService, CashCountError, toCents, toEuros };
