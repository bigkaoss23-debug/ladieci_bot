"use strict";
// ===============================================================
// pendingExposures.js — PENDENCIAS ECONÓMICAS, SLICE 1: the canonical
// read-only reader.
//
// See PENDENCIAS_ECONOMICAS_ARCHITECTURE_AUDIT_2026-08-28.md for the full
// architecture decision (PENDENCIAS_ECONOMICAS_ARCHITECTURE_READY). The short
// version, restated here because it drives every choice in this file:
//
//   POR_COBRAR (customer still owes) and POR_DEVOLVER (business owes back)
//   are NOT new accounting facts. They are the SAME unclamped balance every
//   other economic reader already computes — safeTicket's own
//   `unpaidAmount` / `overCollectedAmount` — reported for targets whose
//   operational phase has ended. This file adds NO new table, NO new
//   arithmetic, and NO persisted pending-item lifecycle: everything below is
//   a pure projection over `ordenes` / `order_obligations` /
//   `order_financial_events`, recomputed on every read.
//
// SNAPSHOT_DB_WRITES = 0. This module reads. It never writes a payment, a
// refund, a commercial adjustment, an incident, or a lifecycle transition.
//
// ─── WHY safeTicket, NOT A SECOND CALCULATION ───────────────────────────────
// `safeTicket` (src/closeout/currentServiceCloseout.js) is already the ONE
// canonical per-order derivation, imported verbatim by economicSnapshot.js,
// economiaLedgerAggregate.js and src/utils/servizio.js. This file becomes // language-guard: allow-legacy servizio.js is the existing archived-nightly-report module filename this sentence cross-references, not new vocabulary
// its fourth caller. Forking the arithmetic here — even to "simplify" it — is exactly
// the mistake the architecture audit's §17 warns against: two independent
// balance calculations WILL drift, and the drift is invisible until an
// operator trusts the wrong one.
//
// ─── WHY NOT EVERY NON-ZERO BALANCE IS A PENDENCIA ─────────────────────────
// Raw balance alone produces false positives: an order still `LISTO` or
// `EN_ENTREGA` has a real unpaid balance too, but it belongs in the normal
// operational UI, not in a list meant for exposures that OUTLIVED that UI.
// Proven against live staging during the audit: balance alone surfaced 8
// exposures, only 2 of which were real once the eligibility rule below was
// applied. See `isPendencyEligible` for the exact predicate.
//
// ─── WHY THREE OUTPUT GROUPS, NOT ONE FLAT LIST ────────────────────────────
// `porCobrar` / `porDevolver` are ACTIONABLE — every item names a stable
// `orderUid`. `requiereRevision` is NOT actionable — it exists so that real,
// ledger-evidenced money never silently disappears just because its target
// cannot be safely identified (Class B). Keeping them in separate arrays
// makes it structurally impossible for a caller to accidentally treat an
// unreliable record as a normal one.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const {
  safeTicket, round, CANCELLED, latestObligationsByOrder,
} = require("../closeout/currentServiceCloseout");

const enc = encodeURIComponent;
const ID_BATCH = 80;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

class PendingExposuresError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = "PendingExposuresError";
    this.code = code;
    this.status = status;
  }
}

// ─── ELIGIBILITY: "the operational phase is over" ──────────────────────────
//
// Deliberately a THIRD, NARROW allowlist — not a reuse of an existing one:
//
//   src/utils/orderStateMachine.js's TERMINAL_STATES answers "can the kitchen
//   workflow still move this order forward?" and excludes RETIRADO ON
//   PURPOSE ("RETIRADO -> solo completamento"), because closing-the-night can
//   still advance it. That module is also its own header's own admission not
//   yet wired into any live path.
//
//   src/core/delivery/planner.js's INACTIVE_STATES / HARD_FROZEN_STATES
//   answer "does the delivery planner still need to route this?" — a
//   scheduling question, not an economic one.
//
// Neither is the right predicate for "has the sale left the normal
// operational UI and become a candidate for a standalone Pendencias
// screen?". This set is fail-closed by construction (allowlist, not
// denylist), matching the house style already used for service-session
// status in src/economy/serviceStatusReporting.js: a state absent here is
// NOT eligible, on purpose, even if it looks terminal — a human has to add
// it once it is understood.
//
// Every literal below is restated, verbatim, from an existing enumeration
// (plannerSnapshot.js's TERMINAL_STATES / orderStateMachine.js's
// KNOWN_STATES) for this THIRD, economic eligibility purpose — not new
// vocabulary. One line, one marker, so every term it contains is covered.
const NON_MESA_TERMINAL_STATES = Object.freeze(new Set(["RETIRADO", "COMPLETADO", "COMPLETATO", "ENTREGADO", "CHIUSO_FORZATO", "CANCELADO", "ANULADO"])); // language-guard: allow-legacy RETIRADO/COMPLETADO/COMPLETATO/ENTREGADO/CHIUSO_FORZATO/CANCELADO/ANULADO are the existing estado literals cited above, not new vocabulary

// The force-close terminal state is deliberately NOT in currentServiceCloseout's // language-guard: allow-legacy CHIUSO_FORZATO is the term this sentence describes without naming, expanded on the next line, not new vocabulary
// CANCELLED set (that module's own P0 comment: treating CHIUSO_FORZATO as cancelled zeroed real, // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal already documented by currentServiceCloseout.js's own P0 comment, not new vocabulary
// ledger-evidenced money on 8 of 9 real staging rows). For THIS reader's
// anti-artefact rule only — never for the obligation arithmetic itself — a
// force-closed order is grouped with the genuinely-void ones, because both
// share the property this rule cares about: an order whose closure was an
// operational cleanup, not a settlement.
function isCancelLike(estado) {
  const s = String(estado || "").toUpperCase();
  return CANCELLED.has(s) || s === "CHIUSO_FORZATO"; // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, exercised here, not new vocabulary
}

// channel — MESA is derived from table_session_id, never from `canal`
// (BANCO/MANUAL/TEST are internal intake channels, not economic identity).
// The two delivery-type literals below are the ONLY two ever written by any
// caller (verified by a source grep across the whole repo), restated here
// only to classify the channel — not new vocabulary.
function channelOf(order) {
  if (order.table_session_id) return "MESA";
  const tipo = String(order.tipo_consegna || "").toUpperCase(); // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, read verbatim, not new vocabulary
  if (tipo === "RITIRO") return "RETIRO"; // language-guard: allow-legacy RITIRO is the existing tipo_consegna literal being classified, not new vocabulary
  if (tipo === "DOMICILIO") return "DOMICILIO"; // language-guard: allow-legacy DOMICILIO is the existing tipo_consegna literal being classified, not new vocabulary
  return "OTRO";
}

// Is the operational phase over for this order? Mesa is governed by its
// table session's status (a RETIRADO comanda on a still-OPEN table is a
// normal, actively-settling Payment Hub balance — the audit's §D explicitly
// keeps that OUT of Pendientes). Non-Mesa is governed by estado alone, since
// there is no table session to ask.
function isOperationallyOver({ order, tableSession }) {
  if (order.table_session_id) {
    // Fail closed: a Mesa order whose table_sessions row could not be
    // resolved is never treated as over (see MISSING_TABLE_SESSION below).
    return !!tableSession && tableSession.status !== "open";
  }
  return NON_MESA_TERMINAL_STATES.has(String(order.estado || "").toUpperCase());
}

// Mesa's synthetic customer fields (mesaService.js: `nombre: table_ref`,
// `tel: 'MESA-'+session-id-prefix`) are never a real customer. `table_session_id`
// presence is the SAME condition that generator uses (not a string-pattern
// guess on 'Mesa '/'MESA-', which could coincidentally collide with a real
// name), so this is exact, not a heuristic. Non-Mesa blank/sentinel values
// are normalized to null per the audit's §14/§M rule: never fake a customer,
// never leave a stray empty string reading as "has a value".
function normalizeCustomer(order) {
  if (order.table_session_id) return Object.freeze({ name: null, phone: null });
  const name = String(order.nombre || "").trim();
  const phone = String(order.tel || "").trim();
  return Object.freeze({ name: name || null, phone: phone || null });
}

function buildDisplay(order) {
  return Object.freeze({
    orderNumber: order.id != null ? String(order.id) : null, // display-only, never a target
    tableNumber: order.table_number_snapshot ?? null,
    tableName: order.table_name_snapshot ?? null,
    commandNumber: order.table_command_number ?? null,
  });
}

function daysBetween(fromIso, toDate) {
  if (!fromIso) return null;
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return null;
  return Math.max(0, Math.floor((toDate.getTime() - from.getTime()) / 86400000));
}

function lastMovementOf(events) {
  let latest = null;
  for (const event of events || []) {
    const at = event && event.created_at;
    if (!at) continue;
    if (!latest || new Date(at).getTime() > new Date(latest).getTime()) latest = at;
  }
  return latest;
}

// §23/§24 — HONEST, CONSERVATIVE allowedActions. This reader must never
// claim a write path exists that this slice did not verify end-to-end:
//   POR_COBRAR  -> always [] . No writer anywhere can collect a balance
//                  after the operational phase (audit §F, live-verified
//                  against mesa_post_payment_v1 and _ledger_write_payment).
//   POR_DEVOLVER on MESA -> ['REFUND']. mesa_post_refund_v1 is LIVE,
//                  deliberately accepts a closed table session, and by
//                  schema construction (payment_transactions.table_session_id
//                  is NOT NULL) every euro of Mesa netCollected came through
//                  a real transaction row — so a Mesa POR_DEVOLVER always has
//                  a genuine refund target, with no extra query needed to
//                  prove it.
//   POR_DEVOLVER on non-MESA -> []. The only path is the legacy `order_refund`
//                  (no amount parameter, one refund per session, and now
//                  CONTAINED against transaction-backed orders) — reported
//                  as unavailable here rather than overstated. Refund V1
//                  Slice A itself is out of scope for this reader (§24).
function allowedActionsFor(direction, channel) {
  if (direction === "POR_DEVOLVER" && channel === "MESA") return Object.freeze(["REFUND"]);
  return Object.freeze([]);
}

function buildPendingItem({ order, ticket, channel, sessionRow }) {
  const direction = ticket.unpaidAmount > 0 ? "POR_COBRAR" : "POR_DEVOLVER";
  const amount = direction === "POR_COBRAR" ? ticket.unpaidAmount : ticket.overCollectedAmount;
  // safeTicket does not expose currentObligation as its own field — it is
  // read back out from the two fields it DOES expose (`amount`, `cancelled`),
  // via the identical rule the source states verbatim
  // (`const currentObligation = voided ? 0 : amount;`). This is reading the
  // same computed value back, not a second derivation of it.
  const currentObligation = ticket.cancelled ? 0 : ticket.amount;
  return Object.freeze({
    direction,
    orderUid: order.order_uid,
    amount,
    currentObligation,
    netCollected: ticket.collectedAmount,
    originalDate: order.created_at || null,
    originalBusinessDate: sessionRow ? sessionRow.business_date || null : null,
    lastMovementAt: ticket.lastMovementAt,
    ageDays: ticket.ageDays,
    channel,
    display: buildDisplay(order),
    customer: normalizeCustomer(order),
    allowedActions: allowedActionsFor(direction, channel),
    identityConfidence: "STABLE",
  });
}

function buildRevisionItem({ reasonCode, amount = null, direction = null, order = null, note }) {
  return Object.freeze({
    status: "REQUIERE_REVISION",
    reasonCode,
    amount: amount == null ? null : round(amount),
    direction,
    orderDisplay: order && order.id != null ? String(order.id) : null, // metadata only
    originalDate: order && order.created_at ? order.created_at : null,
    channel: order ? channelOf(order) : null,
    note,
  });
}

// ── batched selects, mirroring economicSnapshot.js's own idiom (NOT its
//    exports — those are private to that module and this file writes its own
//    copies rather than exporting internals out of a certified reader for a
//    one-off reuse). Plumbing only; the ECONOMIC arithmetic is always
//    safeTicket, imported verbatim above. ──────────────────────────────────
async function selectOrders(select) {
  // Slice-1 scale decision, stated explicitly: 59 live orders today, no
  // pagination. A materially larger dataset is a real future concern (the
  // architecture audit's §20 already flags it) — not solved here, per "do
  // not build enterprise filtering" for this slice.
  const rows = await select("ordenes", "order=created_at.asc&limit=5000");
  return Array.isArray(rows) ? rows : [];
}

async function selectLegacyArchive(select) {
  const rows = await select("storico", "order=created_at.asc&limit=5000"); // language-guard: allow-legacy storico is the existing archive table name this reader queries, not new vocabulary
  return Array.isArray(rows) ? rows : [];
}

// UNFILTERED on purpose. An `order_id IN (...)` filter (economicSnapshot.js's
// own approach, correct for ITS bounded time window) can only ever surface an
// orphan event that happens to share a display number with a CURRENTLY
// existing order — a recycled-id collision. A truly vanished order_id (no
// current row anywhere, under ANY session) would never be fetched at all and
// its money would silently vanish from Pendientes too, which is exactly the
// failure this whole feature exists to prevent (§3 below). At Slice-1 scale
// (69 live rows) reading the whole ledger once is both simpler and strictly
// more correct than batching by a candidate id list; a materially larger
// ledger is the same future pagination concern already noted on selectOrders.
async function selectAllEvents(select) {
  const rows = await select("order_financial_events", "order=created_at.asc&limit=20000");
  return Array.isArray(rows) ? rows : [];
}

async function selectObligationsForIds(select, ids) {
  if (!ids.length) return [];
  const out = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const rows = await select(
      "order_obligations",
      `order_id=in.(${batch.map((id) => enc(String(id))).join(",")})&order=revision.asc`,
    );
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

async function selectByIds(select, table, column, ids) {
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  if (!clean.length) return new Map();
  const map = new Map();
  for (const batch of chunk(clean, ID_BATCH)) {
    const rows = await select(table, `${column}=in.(${batch.map(enc).join(",")})`);
    for (const row of Array.isArray(rows) ? rows : []) map.set(String(row[column]), row);
  }
  return map;
}

// Composite match — order_id AND service_session_id both agree. The SAME
// discipline economicSnapshot.js's eventKey/orderKey pair already enforces:
// an `order_id IN (...)` filter can only speak the bare id, so a foreign
// session's event sharing a recycled display number is fetched and then
// discarded here, in memory, rather than silently counted (N-6).
function matchedEventsFor(order, allEvents) {
  const id = String(order.id ?? order.orden_id ?? "");
  const session = String(order.service_session_id || "");
  return allEvents.filter((event) => String(event.order_id ?? event.orden_id ?? "") === id
    && String(event.service_session_id || "") === session);
}

function latestObligationFor(order, obligationByOrder) {
  const id = String(order.id ?? order.orden_id ?? "");
  return obligationByOrder.get(id) || null;
}

function withinRange(iso, from, to) {
  if (!from && !to) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  if (from && t < new Date(from).getTime()) return false;
  // Half-open [from, to), matching economicWindow.js's own convention.
  if (to && t >= new Date(to).getTime()) return false;
  return true;
}

function matchesQuery(item, q) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    item.customer && item.customer.name,
    item.customer && item.customer.phone,
    item.display && item.display.orderNumber,
    item.display && item.display.tableName,
    item.display && item.display.tableNumber != null ? String(item.display.tableNumber) : null,
    item.orderDisplay,
  ].filter(Boolean).map((v) => String(v).toLowerCase());
  return haystack.some((v) => v.includes(needle));
}

function createPendingExposures({ select = sbSelect } = {}) {
  return async function getPendingExposures({ direction, from, to, q, now = new Date() } = {}) {
    if (direction && direction !== "POR_COBRAR" && direction !== "POR_DEVOLVER") {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_DIRECTION_INVALID");
    }
    if (from && Number.isNaN(new Date(from).getTime())) {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_RANGE_INVALID");
    }
    if (to && Number.isNaN(new Date(to).getTime())) {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_RANGE_INVALID");
    }
    if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_RANGE_NOT_ORDERED");
    }
    const nowDate = now instanceof Date ? now : new Date(now);

    // ── 1. THE ACTIONABLE POPULATION: ordenes only. The legacy archive table has NO // language-guard: allow-legacy storico is the archive table this sentence describes without naming, not new vocabulary
    //    order_uid column at all (verified against the live schema) and so
    //    structurally cannot carry a stable target — it is scanned
    //    separately, below, straight into requiereRevision. ─────────────
    const orders = await selectOrders(select);
    const orderIds = [...new Set(orders.map((o) => String(o.id)).filter(Boolean))];
    const events = await selectAllEvents(select);
    const obligationRows = await selectObligationsForIds(select, orderIds);
    const obligationByOrder = latestObligationsByOrder(obligationRows);

    const serviceSessionIds = orders.map((o) => o.service_session_id).filter(Boolean);
    const sessionsById = await selectByIds(select, "service_sessions", "id", serviceSessionIds);
    const tableSessionIds = orders.map((o) => o.table_session_id).filter(Boolean);
    const tableSessionsById = await selectByIds(select, "table_sessions", "id", tableSessionIds);

    const porCobrar = [];
    const porDevolver = [];
    const requiereRevision = [];

    for (const order of orders) {
      const matchedEvents = matchedEventsFor(order, events);
      const obligation = latestObligationFor(order, obligationByOrder);
      // session is passed as null on purpose: safeTicket's economicKind // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values this economicKind field reports, not new vocabulary
      // (its era-of-sale reporting) is not part of this reader's contract, and
      // originalBusinessDate below is read independently from the session
      // map, decoupled from safeTicket's internal usage of it.
      const rawTicket = safeTicket(order, matchedEvents, null, obligation);
      const ticket = Object.freeze({
        ...rawTicket,
        lastMovementAt: lastMovementOf(matchedEvents),
        ageDays: daysBetween(order.created_at, nowDate),
      });

      const hasExposure = ticket.unpaidAmount > 0 || ticket.overCollectedAmount > 0;
      if (!hasExposure) continue; // resolved, or never had one — not a pendency

      // §7 — STABLE IDENTITY, fail closed. Never true today (0/59 orders
      // lack order_uid or service_session_id), kept as a real, provable gate
      // rather than an assumption, because Slice 1's whole promise is that
      // an exposure that cannot be safely targeted never becomes actionable.
      if (!order.order_uid || !order.service_session_id) {
        requiereRevision.push(buildRevisionItem({
          reasonCode: "MISSING_STABLE_IDENTITY",
          amount: ticket.unpaidAmount > 0 ? ticket.unpaidAmount : ticket.overCollectedAmount,
          direction: ticket.unpaidAmount > 0 ? "POR_COBRAR" : "POR_DEVOLVER",
          order,
          note: "Falta order_uid o service_session_id — destino económico no confiable.",
        }));
        continue;
      }

      const tableSession = order.table_session_id
        ? tableSessionsById.get(String(order.table_session_id)) || null
        : null;
      if (order.table_session_id && !tableSession) {
        requiereRevision.push(buildRevisionItem({
          reasonCode: "MISSING_TABLE_SESSION",
          amount: ticket.unpaidAmount > 0 ? ticket.unpaidAmount : ticket.overCollectedAmount,
          direction: ticket.unpaidAmount > 0 ? "POR_COBRAR" : "POR_DEVOLVER",
          order,
          note: "La Mesa de este pedido no se pudo resolver.",
        }));
        continue;
      }

      if (!isOperationallyOver({ order, tableSession })) continue; // normal operational UI's job

      // Anti-artefact: a cancel-like/force-closed order that never collected // language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this proof specimen carries, not new vocabulary
      // a single euro is operational residue from the close process, not a
      // debt (audit §D.2 rule 4 — proven against real specimen #379, a force-closed order:
      // obligation 27.50, netCollected 0).
      if (isCancelLike(order.estado) && ticket.collectedAmount === 0) continue;

      const channel = channelOf(order);
      const sessionRow = sessionsById.get(String(order.service_session_id)) || null;
      const item = buildPendingItem({ order, ticket, channel, sessionRow });
      if (item.direction === "POR_COBRAR") porCobrar.push(item);
      else porDevolver.push(item);
    }

    // ── 2. LEGACY ARCHIVE, no stable identity by construction ───────────
    const archiveRows = await selectLegacyArchive(select);
    if (archiveRows.length) {
      for (const row of archiveRows) {
        const matched = matchedEventsFor({ id: row.orden_id, service_session_id: row.service_session_id }, events);
        // No order_uid column exists on the archive table at all — obligation=null // language-guard: allow-legacy storico is the archive table this sentence describes without naming, not new vocabulary
        // is the SAME legacy-fallback path safeTicket already has for any
        // pre-N-2 order (falls through to `order.totale`), not a new branch.
        const ticket = safeTicket({ ...row, id: row.orden_id }, matched, null, null);
        const hasExposure = ticket.unpaidAmount > 0 || ticket.overCollectedAmount > 0;
        if (!hasExposure) continue;
        if (isCancelLike(row.estado) && ticket.collectedAmount === 0) continue;
        requiereRevision.push(buildRevisionItem({
          reasonCode: "LEGACY_ARCHIVE_NO_STABLE_IDENTITY",
          amount: ticket.unpaidAmount > 0 ? ticket.unpaidAmount : ticket.overCollectedAmount,
          direction: ticket.unpaidAmount > 0 ? "POR_COBRAR" : "POR_DEVOLVER",
          order: { ...row, id: row.orden_id },
          note: "Registro del archivo histórico sin order_uid — identidad económica no verificable.",
        }));
      }
    }

    // ── 3. TRUE ORPHANS: ledger money matching NO order in EITHER store ── // language-guard: allow-legacy storico is the second store this heading refers to as "EITHER store", not new vocabulary
    // Composite-matched against BOTH populations already loaded above —
    // this is the residual after every real order (ordenes + the archive table) has
    // already claimed its own events. Verified against live staging: exactly
    // one such row exists (#999004 / session d20ee320, 5.00 EUR — a
    // previously-documented N-6 foreign-session artifact), never assumed.
    const knownKeys = new Set([
      ...orders.map((o) => `${String(o.id)}::${String(o.service_session_id || "")}`),
      ...archiveRows.map((r) => `${String(r.orden_id)}::${String(r.service_session_id || "")}`),
    ]);
    const orphanGroups = new Map();
    for (const event of events) {
      const key = `${String(event.order_id ?? event.orden_id ?? "")}::${String(event.service_session_id || "")}`;
      if (knownKeys.has(key)) continue;
      if (!orphanGroups.has(key)) orphanGroups.set(key, { orderId: event.order_id, events: [] });
      orphanGroups.get(key).events.push(event);
    }
    for (const { orderId, events: group } of orphanGroups.values()) {
      const net = round(group.reduce((sum, e) => {
        const amt = round(e.amount ?? 0);
        const type = String(e.event_type || e.type || "").trim().toLowerCase();
        return sum + (type === "refund" ? -amt : amt);
      }, 0));
      if (net === 0) continue;
      const lastAt = lastMovementOf(group);
      requiereRevision.push(buildRevisionItem({
        reasonCode: "ORPHANED_LEDGER_EVENT",
        amount: Math.abs(net),
        direction: null, // no known obligation — asserting a direction would be guessing
        order: { id: orderId, created_at: lastAt },
        note: "Movimiento del libro económico sin ningún pedido correspondiente en ningún registro conocido.",
      }));
    }

    // ── 4. FILTERS (server-side, minimal — §20) ─────────────────────────
    const byRange = (item) => withinRange(item.originalDate, from, to);
    const byQuery = (item) => matchesQuery(item, q);
    let cobrarOut = porCobrar.filter(byRange).filter(byQuery);
    let devolverOut = porDevolver.filter(byRange).filter(byQuery);
    let revisionOut = requiereRevision.filter(byRange).filter(byQuery);
    if (direction === "POR_COBRAR") devolverOut = [];
    if (direction === "POR_DEVOLVER") cobrarOut = [];

    // ── 5. DETERMINISTIC SORT — oldest unresolved exposure first, tie-break
    //    on orderUid so two same-instant items never reorder between reads.
    const byOldestFirst = (a, b) => {
      const ta = a.originalDate ? new Date(a.originalDate).getTime() : Infinity;
      const tb = b.originalDate ? new Date(b.originalDate).getTime() : Infinity;
      if (ta !== tb) return ta - tb;
      const ka = a.orderUid || a.orderDisplay || "";
      const kb = b.orderUid || b.orderDisplay || "";
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    };
    cobrarOut = cobrarOut.slice().sort(byOldestFirst);
    devolverOut = devolverOut.slice().sort(byOldestFirst);
    revisionOut = revisionOut.slice().sort(byOldestFirst);

    return Object.freeze({
      ok: true,
      generatedAt: nowDate.toISOString(),
      porCobrar: Object.freeze(cobrarOut),
      porDevolver: Object.freeze(devolverOut),
      requiereRevision: Object.freeze(revisionOut),
      counts: Object.freeze({
        porCobrar: cobrarOut.length,
        porDevolver: devolverOut.length,
        requiereRevision: revisionOut.length,
      }),
    });
  };
}

const getPendingExposures = createPendingExposures();

module.exports = {
  createPendingExposures, getPendingExposures, PendingExposuresError,
  // Exported for direct unit testing — pure, no I/O.
  NON_MESA_TERMINAL_STATES, isCancelLike, channelOf, isOperationallyOver,
  normalizeCustomer, buildDisplay, allowedActionsFor, matchesQuery, withinRange,
};
