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
//
// ─── WORKSPACE ISOLATION ────────────────────────────────────────────────────
// `workspaceId` is REQUIRED and comes ONLY from the caller's verified auth
// context — never from a query parameter — matching cashCountService.js's
// own convention exactly (same failure code and status on a missing one:
// ECONOMY_UNAUTHENTICATED/401). Two DIFFERENT isolation mechanisms are in
// play, because two different things are true of this schema (verified live,
// not assumed):
//   `table_sessions` and `order_obligations` DO carry a workspace_id column
//     — scoped explicitly below, by `workspace_id=eq.<id>`, mirroring the
//     SAME filter mesaDao.js already applies to table_sessions reads.
//   `ordenes`, the legacy archive table and `order_financial_events` carry
//     NO workspace_id column AT ALL — there is nothing to filter by. Isolation for these is
//     a DB-WIDE invariant instead: `workspaces` holds exactly one row, and
//     `mesa_singleton_workspace_v1` RAISEs MESA_WORKSPACE_AMBIGUOUS the
//     instant a second one would exist. Every sibling economy reader
//     (economicSnapshot.js, closeoutReconciliation.js,
//     economiaLedgerAggregate.js) already relies on this exact same
//     boundary for these same tables — it is not a gap introduced here.
// ===============================================================

const { sbSelect } = require("../utils/supabase");
const {
  safeTicket, round, CANCELLED, latestObligationsByOrder,
} = require("../closeout/currentServiceCloseout");
// CANONICAL SCOPE — the SAME window authority economicSnapshot.js uses. This
// module does NOT compute a Madrid 04:00 boundary, a 17:30 split, a DST offset
// or any business-date arithmetic of its own: `preset` in, resolved
// `[from, to)` out, exactly like every other economy reader. `servicio` scope
// is by canonical identity (order.service_session_id), never an approximate
// timestamp range — the window it resolves is echo-only there.
// EconomicWindowError is NOT imported: when resolveEconomicWindow throws it,
// the error propagates verbatim and economyHttpHandlers.safeError already maps
// it (it checks `instanceof EconomicWindowError` there), so re-wrapping it here
// would only blur the code it carries.
const {
  resolveEconomicWindow, windowForServiceSession, PRESET,
} = require("./economicWindow");

const enc = encodeURIComponent;
const ID_BATCH = 80;

// The only presets this reader answers. `mediodia` / `noche` are deliberately
// NOT offered here (they are arbitrary clock windows, not a question a
// Pendencias screen asks) even though economicWindow itself supports them.
const PENDENCY_PRESETS = Object.freeze(new Set([
  PRESET.HOY, PRESET.AYER, PRESET.SERVICIO, PRESET.PERSONALIZADO,
]));

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
    // Canonical service identity of the ORDER (N-6 basis), for the 'servicio'
    // scope filter. Operational metadata, never a customer identity and never
    // rendered as one — the same status buildDisplay's tableName/commandNumber
    // already have.
    serviceSessionId: order.service_session_id ? String(order.service_session_id) : null,
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
    // Present for archive-row / missing-identity revisions that still carry a
    // real service_session_id; null for a true orphan (no order at all), which
    // therefore never matches a 'servicio' scope — correct, an orphan cannot be
    // attributed to a specific service.
    serviceSessionId: order && order.service_session_id ? String(order.service_session_id) : null,
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

// PRE-DEPLOY REVIEW §2 — SCALE. This is the index-supported, bounded path,
// used for every order/archive-row this reader already knows about (which is
// every order EXCEPT a true orphan — see selectAllEventsForOrphanScan below).
// `order_financial_events_order_created_idx (order_id, created_at)` — a real,
// already-live index, verified against the schema, no migration needed —
// supports this `order_id IN (...)` filter directly, the SAME shape
// economicSnapshot.js's own selectEventsForOrders already uses for its
// bounded time window. This covers 100% of porCobrar/porDevolver and the
// legacy-archive requiereRevision path: both only ever need events for an
// order_id they already hold (from `ordenes` or the archive table).
async function selectEventsForIds(select, ids) {
  if (!ids.length) return [];
  const out = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const rows = await select(
      "order_financial_events",
      `order_id=in.(${batch.map((id) => enc(String(id))).join(",")})&order=created_at.asc`,
    );
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

// PRE-DEPLOY REVIEW §2 — the ONE remaining unbounded read, and it is
// unavoidable at Slice 1 without a migration. Orphan detection (§3 below)
// asks "does any event's (order_id, service_session_id) match NO order
// anywhere" — a genuine anti-join. No index on this schema can turn that into
// a bounded lookup: an `order_id IN (...)` filter (used everywhere else in
// this file) is definitionally the wrong shape here, since it can only ever
// surface an orphan that happens to share a display number with a CURRENTLY
// known order (a recycled-id collision) — a truly vanished order_id would
// never be fetched at all, silently defeating the one guarantee this path
// exists for. The real fix is a server-side anti-join (a small RPC), which
// is a schema addition and therefore explicitly out of scope this slice —
// reported, not implemented (see this slice's pre-deploy report §D).
//
// What CAN be done without a migration, and is done here: no `ORDER BY` is
// requested. Orphan grouping (below) computes its own per-group max()
// regardless of input order, so the one cost this call can shed without an
// index is the sort itself — Postgres can stream the table rather than
// materialize and sort all of it. Still O(n) in ledger size; see the report
// for the growth ceiling this remains safe under.
async function selectAllEventsForOrphanScan(select) {
  const rows = await select("order_financial_events", "limit=20000");
  return Array.isArray(rows) ? rows : [];
}

// WORKSPACE ISOLATION — `order_obligations` carries `workspace_id` (verified
// against the live schema), the SAME column mesaDao.js already filters
// `table_sessions`/`restaurant_tables`/`table_reservations` reads by. Scoping
// here matches that established convention rather than leaning solely on the
// DB-wide singleton invariant (see selectByIds below).
async function selectObligationsForIds(select, ids, workspaceId) {
  if (!ids.length) return [];
  const out = [];
  for (const batch of chunk(ids, ID_BATCH)) {
    const rows = await select(
      "order_obligations",
      `order_id=in.(${batch.map((id) => enc(String(id))).join(",")})&workspace_id=eq.${enc(workspaceId)}&order=revision.asc`,
    );
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

// WORKSPACE ISOLATION — `workspace_id` is applied whenever the target table
// actually carries the column (`table_sessions` does; `service_sessions`
// does not — see the reader's own workspace note below), mirroring
// mesaDao.js's own `workspace_id=eq.<id>` filters on the same tables. A
// foreign-workspace row is excluded from the map entirely, so a Mesa order
// whose table_sessions row belongs to another workspace fails closed into
// MISSING_TABLE_SESSION rather than reading that other workspace's status.
async function selectByIds(select, table, column, ids, { workspaceId = null } = {}) {
  const clean = [...new Set(ids.filter(Boolean).map(String))];
  if (!clean.length) return new Map();
  const map = new Map();
  const scope = workspaceId ? `&workspace_id=eq.${enc(workspaceId)}` : "";
  for (const batch of chunk(clean, ID_BATCH)) {
    const rows = await select(table, `${column}=in.(${batch.map(enc).join(",")})${scope}`);
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

// ─── CANONICAL SCOPE RESOLUTION ────────────────────────────────────────────
// Turns the request's scope params into ONE membership predicate over the
// pending items, plus the resolved window to echo back. Three kinds:
//
//   'global'  — no preset. The pre-existing behaviour, byte-for-byte: the
//               raw `from`/`to` (if any) filter `item.originalDate`
//               (= order.created_at), half-open. This is what a bare
//               GET /pendencies keeps doing, and what the bottom-nav badge
//               reads.
//   'window'  — preset hoy | ayer | personalizado. The window is resolved by
//               economicWindow (04:00 Madrid rollover, DST-correct) and the
//               SAME `item.originalDate ∈ [from, to)` filter is applied to it.
//   'service' — preset servicio + serviceSessionId. Membership is canonical
//               identity: item.serviceSessionId === serviceSessionId. NOT a
//               timestamp overlap. The session's own interval is resolved only
//               to echo it back to the caller.
//
// `serviceSessionId` is meaningful ONLY with preset 'servicio'. Supplied with
// any other preset it is a contradictory request and is refused (§17) rather
// than silently ignored.
async function resolvePendencyScope({ select, preset, serviceSessionId, businessDate, from, to, now }) {
  const key = preset == null || preset === "" ? null : String(preset).trim().toLowerCase();

  if (key === null) {
    if (serviceSessionId) {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_SCOPE_INVALID");
    }
    return Object.freeze({
      kind: "global",
      matchItem: (item) => withinRange(item.originalDate, from, to),
      scopeEcho: null,
      windowEcho: (from || to)
        ? Object.freeze({ from: from || null, to: to || null, bounds: "[from,to)" })
        : null,
    });
  }

  if (!PENDENCY_PRESETS.has(key)) {
    throw new PendingExposuresError("ECONOMY_PENDENCIES_SCOPE_INVALID");
  }

  if (key === PRESET.SERVICIO) {
    if (!serviceSessionId || typeof serviceSessionId !== "string") {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_SERVICE_SESSION_REQUIRED");
    }
    const rows = await select("service_sessions", `id=eq.${enc(serviceSessionId)}&limit=1`);
    const session = Array.isArray(rows) ? rows[0] : null;
    if (!session) {
      throw new PendingExposuresError("ECONOMY_PENDENCIES_SERVICE_NOT_FOUND", 404);
    }
    // Echo only. Membership below is by identity, never by this interval.
    let win = null;
    try { win = windowForServiceSession(session, { asOf: now }); } catch (_) { win = null; }
    return Object.freeze({
      kind: "service",
      serviceSessionId,
      matchItem: (item) => String(item.serviceSessionId || "") === serviceSessionId,
      scopeEcho: Object.freeze({ preset: key, serviceSessionId, businessDate: session.business_date || null }),
      windowEcho: win
        ? Object.freeze({ from: win.from, to: win.to, timezone: win.timezone, businessDate: win.businessDate, bounds: win.bounds })
        : null,
    });
  }

  if (serviceSessionId) {
    throw new PendingExposuresError("ECONOMY_PENDENCIES_SCOPE_INVALID");
  }
  if (key === PRESET.PERSONALIZADO && (!from || !to)) {
    throw new PendingExposuresError("ECONOMY_PENDENCIES_RANGE_INVALID");
  }
  // economicWindow owns every calendar decision here. It throws
  // EconomicWindowError on a bad range; that class is already mapped by
  // economyHttpHandlers.safeError, so it is allowed to propagate.
  const win = resolveEconomicWindow({ preset: key, from, to, businessDate, now });
  return Object.freeze({
    kind: "window",
    matchItem: (item) => withinRange(item.originalDate, win.from, win.to),
    scopeEcho: Object.freeze({ preset: key, businessDate: win.businessDate || null }),
    windowEcho: Object.freeze({
      from: win.from, to: win.to, timezone: win.timezone, businessDate: win.businessDate || null, bounds: win.bounds,
    }),
  });
}

function createPendingExposures({ select = sbSelect } = {}) {
  return async function getPendingExposures({
    workspaceId, direction, from, to, q,
    preset, serviceSessionId, businessDate,
    now = new Date(),
  } = {}) {
    // WORKSPACE ISOLATION — fail closed with the SAME code+status
    // cashCountService.js's own `requireContext` already uses for exactly
    // this condition: an absent/malformed workspaceId means the caller was
    // never properly authenticated, not merely that a filter is missing.
    if (typeof workspaceId !== "string" || !workspaceId) {
      throw new PendingExposuresError("ECONOMY_UNAUTHENTICATED", 401);
    }
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

    // CANONICAL SCOPE — resolved once, through economicWindow. 'global' (no
    // preset) keeps the pre-existing raw from/to behaviour byte-for-byte; a
    // preset routes the window through the SAME resolver every other economy
    // reader uses, and 'servicio' scopes by canonical order identity.
    const scope = await resolvePendencyScope({
      select, preset, serviceSessionId, businessDate, from, to, now: nowDate,
    });

    // ── 1. THE ACTIONABLE POPULATION: ordenes only. The legacy archive table has NO // language-guard: allow-legacy storico is the archive table this sentence describes without naming, not new vocabulary
    //    order_uid column at all (verified against the live schema) and so
    //    structurally cannot carry a stable target — it is scanned
    //    separately, below, straight into requiereRevision. ─────────────
    const orders = await selectOrders(select);
    const orderIds = [...new Set(orders.map((o) => String(o.id)).filter(Boolean))];
    // Fetched here, ahead of the events read, so its ids can join the SAME
    // bounded, index-supported event fetch below (§2 of the pre-deploy
    // review) — one query serves both the actionable population and the
    // legacy-archive requiereRevision path, neither of which ever needs an
    // event for an order_id it does not already hold.
    const archiveRows = await selectLegacyArchive(select);
    const archiveIds = archiveRows.map((r) => String(r.orden_id)).filter(Boolean);
    const knownIds = [...new Set([...orderIds, ...archiveIds])];
    const events = await selectEventsForIds(select, knownIds);
    // WORKSPACE ISOLATION — scoped; see selectObligationsForIds above.
    const obligationRows = await selectObligationsForIds(select, orderIds, workspaceId);
    const obligationByOrder = latestObligationsByOrder(obligationRows);

    // WORKSPACE NOTE — `service_sessions` carries no workspace_id column at
    // all (verified against the live schema), the SAME as `ordenes`, the
    // legacy archive table and `order_financial_events` selected above and
    // below. None of them can be filtered by workspace because the column does not
    // exist; isolation for these four tables is instead a DB-wide invariant
    // (`workspaces` holds exactly one row; `mesa_singleton_workspace_v1`
    // hard-fails, RAISE MESA_WORKSPACE_AMBIGUOUS, the instant a second
    // workspace would exist) — the SAME boundary every sibling economy
    // reader (economicSnapshot.js, closeoutReconciliation.js,
    // economiaLedgerAggregate.js) already relies on, not a gap unique to
    // this file. `table_sessions` and `order_obligations`, which DO carry
    // the column, are scoped explicitly below rather than leaning on that
    // invariant alone.
    const serviceSessionIds = orders.map((o) => o.service_session_id).filter(Boolean);
    const sessionsById = await selectByIds(select, "service_sessions", "id", serviceSessionIds);
    const tableSessionIds = orders.map((o) => o.table_session_id).filter(Boolean);
    // WORKSPACE ISOLATION — scoped; see selectByIds above.
    const tableSessionsById = await selectByIds(select, "table_sessions", "id", tableSessionIds, { workspaceId });

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
    //
    // This is the ONE call in this reader that still reads the whole ledger
    // (see selectAllEventsForOrphanScan's own header for why that remains
    // unavoidable without a migration) — used HERE ONLY, never for the
    // bounded primary population above.
    const orphanScanEvents = await selectAllEventsForOrphanScan(select);
    const knownKeys = new Set([
      ...orders.map((o) => `${String(o.id)}::${String(o.service_session_id || "")}`),
      ...archiveRows.map((r) => `${String(r.orden_id)}::${String(r.service_session_id || "")}`),
    ]);
    const orphanGroups = new Map();
    for (const event of orphanScanEvents) {
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
    // Scope membership comes from the resolver: 'global'/'window' compare
    // item.originalDate against a half-open [from,to); 'service' compares the
    // canonical order identity. This file computes no window of its own. `q`
    // free-text and `direction` are unchanged and orthogonal.
    const byScope = scope.matchItem;
    const byQuery = (item) => matchesQuery(item, q);
    let cobrarOut = porCobrar.filter(byScope).filter(byQuery);
    let devolverOut = porDevolver.filter(byScope).filter(byQuery);
    let revisionOut = requiereRevision.filter(byScope).filter(byQuery);
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

    // Presentation-only sums, from the SAME canonical item population that was
    // just filtered and sorted — never a second query, never a re-derivation,
    // never an amount altered. requiereRevision is deliberately NOT summed
    // into any total: it is not an actionable balance.
    const sumAmount = (items) =>
      round(items.reduce((acc, it) => acc + (Number(it && it.amount) || 0), 0));

    return Object.freeze({
      ok: true,
      generatedAt: nowDate.toISOString(),
      // The canonical scope the server actually applied. null for a bare
      // request (GLOBAL / Todos) — the shape the Economía bottom-nav badge
      // reads. Scoped requests echo it so a consumer can render "viewing a
      // filtered subset" without re-deriving what the server did.
      scope: scope.scopeEcho,
      window: scope.windowEcho,
      porCobrar: Object.freeze(cobrarOut),
      porDevolver: Object.freeze(devolverOut),
      requiereRevision: Object.freeze(revisionOut),
      counts: Object.freeze({
        porCobrar: cobrarOut.length,
        porDevolver: devolverOut.length,
        requiereRevision: revisionOut.length,
      }),
      // CANONICAL MONETARY TOTALS. By construction:
      //   totals.porCobrar   === Σ porCobrar[].amount   (to the cent)
      //   totals.porDevolver === Σ porDevolver[].amount (to the cent)
      // This is the ONE source General.PENDIENTE(scope) consumes; the KPI and
      // the detail list it opens cannot disagree, because they are the same
      // number over the same scope from the same reader.
      totals: Object.freeze({
        porCobrar: sumAmount(cobrarOut),
        porDevolver: sumAmount(devolverOut),
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
  PENDENCY_PRESETS, resolvePendencyScope,
};
