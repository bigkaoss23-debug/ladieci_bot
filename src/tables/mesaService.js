'use strict';

const crypto = require('node:crypto');
const defaultDao = require('./mesaDao');
const { lifecycle: defaultLifecycle } = require('../serviceSessions/serviceSessionLifecycle');
const { creaOrdine: defaultCreateOrder, cambiaStato: defaultChangeOrderState } = require('../agents/agentOrdini');
const { nextEqualShare, aggregateByMethod } = require('./billingMath');
const { sidHash: defaultSidHash } = require('../auth/sidHash');
// STALE SERVICE PROTECTION V1 — the mesa seating RPCs do not guard an
// operational_service_v1 by Business Day (O-3), so the first-seating helper
// runs the canonical stale-service recovery itself before it seats.
const { recoverStaleService: defaultStaleRecovery } = require('../serviceSessions/staleServiceRecovery');

// Error `.code` values use the MESA_ prefix, matching the mesa_*_v1 Postgres
// functions and mesaHttpHandlers/mesaApi's exact-string classification. This
// backend build must not be deployed until migrations/2026-08-02_v3j_mesa_
// nomenclature_cutover.sql has been applied -- see that file's coordinated
// deploy-order note and MIGRATION_MANIFEST.md's "V3-J cutover ordering".
class MesaServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'MesaServiceError';
    this.code = code;
    this.status = status;
  }
}

const FLOOR_ROLES = new Set(['admin','operator','owner','cashier','waiter','legacy_operator','shift_manager']);
const OPEN_ROLES = new Set(['admin','operator','owner','cashier','waiter','legacy_operator']);
const PAYMENT_ROLES = new Set(['admin','operator','owner','cashier','legacy_operator']);
// REFUND V1 SLICE A — narrower than PAYMENT_ROLES on purpose: the role that takes
// money should not be the one that can silently return it (contract §10/§I.5).
const REFUND_ROLES = new Set(['admin','owner']);
// AJUSTE COMERCIAL V1 — a MANUAL commercial adjustment reduces what the house is owed,
// which is at least as sensitive as returning money: same set as REFUND_ROLES, and
// deliberately narrower than PAYMENT_ROLES. `cashier` is excluded on the same
// segregation-of-duties grounds Refund V1 already froze; `shift_manager` is out for V1.
// NOTE the structural fact behind the pair: auth_actors_actor_role_map makes role 'owner'
// unreachable (actor='owner' <=> role='admin'), so this set is really the single `owner`
// actor -- 'owner' is kept for symmetry with the refund gate, not because a second tier
// exists. A CANCELLATION-caused adjustment is NOT gated here: it is a constrained
// side-effect of a cancellation the actor is already authorised to perform, and the
// server -- not the caller -- derives the resulting obligation. See order_cancel_v1.
const ADJUSTMENT_ROLES = new Set(['admin','owner']);
const LAYOUT_ROLES = new Set(['admin','owner']);
const RESERVATION_ROLES = new Set(['admin','operator','owner','cashier','waiter','shift_manager','legacy_operator']);
// OVER-COLLECTED SLICE A — the force-closed-table terminal state is removed -- language-guard: allow-legacy CHIUSO_FORZATO is the existing terminal-state literal this paragraph explains the removal of, not new vocabulary
// from this set. It is an operational terminal state (the table's business
// ended), never an economic void, and currentServiceCloseout.js's own
// CANCELLED set already excludes it with a deployed, evidence-backed
// comment explaining why. This set had drifted from that decision, silently
// zeroing real ledger-evidenced money for every such order (9 real rows on
// staging, 8 carrying money) — see the over-collected audit, 2026-08-26.
// Canonical economic voids only, matching currentServiceCloseout.js:26.
const CANCELLED = new Set(['ANULADO','CANCELADO','CANCELLED']);
// Same shape mesaHttpHandlers validates path params with — an id that cannot be
// a table session must never reach a query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireContext(context, allowed) {
  if (!context || typeof context.actor !== 'string' || typeof context.workspaceId !== 'string') {
    throw new MesaServiceError('MESA_UNAUTHENTICATED', 401);
  }
  if (!allowed.has(context.role)) throw new MesaServiceError('MESA_FORBIDDEN', 403);
  return context;
}

const cents = (value) => Math.round((Number(value) || 0) * 100);
const money = (value) => Math.round(value) / 100;
// Number(null) === 0 -- a table that was never positioned would silently
// collapse to the literal top-left corner (0,0) and stack there with every
// other never-positioned table, indistinguishable from a table someone
// deliberately placed at 0,0. Preserving null through to the frontend is
// what lets it tell "never positioned" apart from "positioned at the
// origin" and apply a real fallback layout only to the former (same
// null-in-null-out idiom this file already uses for session.covers_total).
const nullableNumber = (value) => (value == null ? null : Number(value));

function madridTime() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return `${parts.find((p) => p.type === 'hour').value}:${parts.find((p) => p.type === 'minute').value}`;
}

function canonicalHash(value) {
  const stable = (input) => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
    }
    return input;
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

// ACC-01 — LINE NORMALISATION, extracted so the floor reader and the closed
// account reader cannot drift apart. Cancelled orders drop out (their lines are
// not an obligation), and every surviving line carries amount/paid/remaining
// derived from payment_allocations, refunds counted negative.
function normalizeLinesBySession(rows) {
  const orderById = new Map((rows.orders || []).map((order) => [String(order.id), order]));
  const txById = new Map((rows.transactions || []).map((tx) => [String(tx.id), tx]));
  const allocationsByLine = new Map();
  for (const allocation of rows.allocations || []) {
    const tx = txById.get(String(allocation.payment_transaction_id));
    if (!tx) continue;
    const sign = tx.kind === 'refund' ? -1 : 1;
    const key = String(allocation.table_order_line_id);
    allocationsByLine.set(key, (allocationsByLine.get(key) || 0) + sign * cents(allocation.amount));
  }
  const linesBySession = new Map();
  for (const line of rows.lines || []) {
    const order = orderById.get(String(line.order_id));
    if (!order || CANCELLED.has(String(order.estado || '').toUpperCase())) continue;
    const paidCents = Math.max(0, allocationsByLine.get(String(line.id)) || 0);
    const netCents = cents(line.net_amount);
    const normalized = {
      id: line.id,
      orderId: line.order_id,
      sourceLineId: line.source_line_id,
      sourceLineIndex: line.source_line_index,
      unitIndex: line.unit_index,
      description: line.description,
      product: line.product_snapshot,
      amount: money(netCents),
      paid: money(Math.min(netCents, paidCents)),
      remaining: money(Math.max(0, netCents - paidCents)),
    };
    const key = String(line.table_session_id);
    if (!linesBySession.has(key)) linesBySession.set(key, []);
    linesBySession.get(key).push(normalized);
  }
  return linesBySession;
}

// AJUSTE COMERCIAL V1 reader gap — the canonical per-order obligation shape the
// frontend needs to render and submit a MANUAL commercial adjustment. Pure: given one
// `ordenes` row and its `order_obligations` revisions (asc by revision), it derives the
// same numbers the DB's own reader would.
//
//   * has revisions  -> originalObligation = revision-1 gross, currentObligation = the
//     latest revision's gross, obligationRevision = that latest revision number.
//   * no revisions yet (lazy bootstrap not triggered) -> both obligations fall back to
//     the SAME legacy basis order_canonical_obligation_v1 uses: ordenes.totale, zeroed
//     for a genuinely cancelled order. obligationRevision = 0.
//   * no order_uid at all (Class B) -> fail closed: adjustable = false, and the RPC/HTTP
//     layers reject a null orderUid independently.
//
// `commercialAdjustment` is currentObligation - originalObligation (<= 0 for a
// reduction). `adjustable` is a read-only hint, derived from order-level facts only
// (never session status: mesa_post_commercial_adjustment_v1, like Refund V1, accepts a
// closed table session and never reopens it — close and adjustment stay decoupled).
function projectOrderFinancial(order, revisions) {
  const orderUid = order.order_uid || null;
  const legacyBasisCents = CANCELLED.has(String(order.estado || '').toUpperCase())
    ? 0 : cents(order.totale);
  const sorted = [...(revisions || [])].sort((a, b) => Number(a.revision) - Number(b.revision));

  let originalCents = legacyBasisCents;
  let currentCents = legacyBasisCents;
  let obligationRevision = 0;
  if (sorted.length > 0) {
    const baseline = sorted.find((r) => Number(r.revision) === 1) || sorted[0];
    const latest = sorted[sorted.length - 1];
    originalCents = cents(baseline.gross_amount);
    currentCents = cents(latest.gross_amount);
    obligationRevision = Number(latest.revision) || 0;
  }

  const adjustable = orderUid != null
    && !CANCELLED.has(String(order.estado || '').toUpperCase())
    && currentCents > 0;

  return {
    orderUid,
    originalObligation: money(originalCents),
    currentObligation: money(currentCents),
    commercialAdjustment: money(currentCents - originalCents),
    obligationRevision,
    adjustable,
  };
}

// ACC-01 — THE ONE ACCOUNT PROJECTION. Everything economic about a single table
// session lives here: total, paid, outstanding, covers, per-method receipts,
// comandas, lines and the payment history.
//
// The open-floor reader and the closed-session reader both call this, so a
// closed table's account is arithmetically the SAME object the operator was
// looking at a second before they closed it — not a second implementation that
// could disagree with it. This function is pure and reads no status: it does
// not care whether the session is open or closed, which is precisely why it can
// serve both.
function projectSessionAccount(session, { lines = [], transactions = [], orders = [], obligations = [] }) {
  // AJUSTE COMERCIAL V1 — group obligation revisions by the PERMANENT order_uid. Safe to
  // hand the whole set in: order_uid is globally unique, so a revision for another
  // session's order simply matches no command here.
  const revisionsByUid = new Map();
  for (const revision of obligations || []) {
    const key = String(revision.order_uid);
    if (!revisionsByUid.has(key)) revisionsByUid.set(key, []);
    revisionsByUid.get(key).push(revision);
  }
  const totalCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
  // OVER-COLLECTED SLICE A — netCollected is money truth and comes from
  // payment transactions (payments minus refunds), NEVER from summing
  // line.paid. Line visibility can change (a cancelled/identity-broken order
  // drops its lines) while payment_transactions rows are immutable facts, so
  // deriving session money from lines let real collected money disappear
  // whenever its line disappeared — see the over-collected audit,
  // 2026-08-26. Per-line paid/remaining (normalizeLinesBySession) stay for
  // display/selection only and are never summed into session money.
  const netCollectedCents = transactions.reduce((sum, tx) =>
    sum + (tx.kind === 'refund' ? -1 : 1) * cents(tx.amount), 0);
  const coversEffect = transactions.reduce((sum, tx) =>
    sum + (tx.kind === 'refund' ? -1 : 1) * Number(tx.covers_settled || 0), 0);
  // NULL until the first comanda sets it (walk-in Mesa just opened, no orders yet).
  const coversTotal = session.covers_total == null ? null : Number(session.covers_total);
  const coversRemaining = coversTotal == null ? 0 : Math.max(0, coversTotal - coversEffect);
  const outstanding = money(Math.max(0, totalCents - netCollectedCents));
  // overCollected is the published complement of outstanding, never netted
  // away: netCollected > total is real (e.g. a line dropped by a cancel-like
  // state while its payment stands), and outstanding alone would hide it
  // behind a false zero (frozen rule, over-collected audit §2).
  const overCollected = money(Math.max(0, netCollectedCents - totalCents));
  const methodTotals = aggregateByMethod(transactions.map((tx) => ({
    kind: tx.kind, method: tx.payment_method, amount: tx.amount,
  })));
  return {
    id: session.id,
    serviceSessionId: session.service_session_id,
    assignedWaiterActor: session.assigned_waiter_actor,
    coversTotal,
    coversRemaining,
    openedAt: session.opened_at,
    settledAt: session.settled_at,
    total: money(totalCents),
    paid: money(netCollectedCents),
    outstanding,
    overCollected,
    nextEqualShare: outstanding > 0 && coversRemaining > 0
      ? nextEqualShare(outstanding, coversRemaining) : 0,
    paymentTotals: { ...methodTotals },
    commands: orders.map((order) => ({
      id: order.id,
      // AJUSTE COMERCIAL V1 — the PERMANENT identity, mirrored inside `financial` so that
      // sub-object is a complete adjustment target on its own. Never the recycled `id`.
      orderUid: order.order_uid || null,
      commandNumber: order.table_command_number,
      serviceOrderNumber: order.service_order_number,
      state: order.estado,
      total: Number(order.totale || 0),
      time: order.hora,
      items: order.items,
      note: order.nota,
      // language-guard: allow-legacy nota_cucina is the existing ordenes column name, projected verbatim as buildFloor already did, not new vocabulary
      kitchenNote: order.nota_cucina,
      // AJUSTE COMERCIAL V1 reader gap — additive canonical obligation shape.
      financial: projectOrderFinancial(order, revisionsByUid.get(String(order.order_uid)) || []),
    })),
    lines,
    // REFUND V1 SLICE B0 — reversesTransactionId was already fetched by mesaDao.js
    // (payment_transactions.reverses_transaction_id) but dropped here, leaving the
    // frontend with no way to link a refund row back to the original payment it
    // reverses. Purely additive: every other field is unchanged.
    payments: transactions.map((tx) => ({
      id: tx.id, kind: tx.kind, mode: tx.mode, amount: Number(tx.amount),
      method: tx.payment_method, coversSettled: tx.covers_settled,
      actor: tx.by_actor, createdAt: tx.created_at,
      reversesTransactionId: tx.reverses_transaction_id || null,
    })),
  };
}

function buildFloor(rows) {
  const reservationsByTable = new Map();
  for (const reservation of rows.reservations || []) {
    const key = String(reservation.table_id);
    if (!reservationsByTable.has(key)) reservationsByTable.set(key, []);
    reservationsByTable.get(key).push({
      id: reservation.id,
      tableId: reservation.table_id,
      tableSessionId: reservation.table_session_id,
      status: reservation.status,
      guestName: reservation.guest_name,
      guestPhone: reservation.guest_phone,
      coversTotal: Number(reservation.covers_total),
      reservedAt: reservation.reserved_at,
      durationMinutes: Number(reservation.duration_minutes),
      note: reservation.note,
      version: Number(reservation.version),
      createdAt: reservation.created_at,
      updatedAt: reservation.updated_at,
      createdBy: reservation.created_by,
      updatedBy: reservation.updated_by,
    });
  }
  const sessionByTable = new Map(rows.sessions
    .filter((session) => session.status === 'open')
    .map((session) => [String(session.table_id), session]));
  const ordersBySession = new Map();
  for (const order of rows.orders) {
    const key = String(order.table_session_id);
    if (!ordersBySession.has(key)) ordersBySession.set(key, []);
    ordersBySession.get(key).push(order);
  }
  const linesBySession = normalizeLinesBySession(rows);
  const txBySession = new Map();
  for (const tx of rows.transactions) {
    const key = String(tx.table_session_id);
    if (!txBySession.has(key)) txBySession.set(key, []);
    txBySession.get(key).push(tx);
  }

  return rows.tables.map((table) => {
    const session = sessionByTable.get(String(table.id)) || null;
    if (!session) return {
      id: table.id, number: table.table_number, name: table.display_name,
      capacity: table.capacity, x: nullableNumber(table.position_x), y: nullableNumber(table.position_y),
      shape: table.shape, shapePreset: table.shape_preset || 'standard', active: table.active,
      status: 'free', session: null,
      reservations: reservationsByTable.get(String(table.id)) || [],
    };
    const key = String(session.id);
    return {
      id: table.id, number: table.table_number, name: table.display_name,
      capacity: table.capacity, x: nullableNumber(table.position_x), y: nullableNumber(table.position_y),
      shape: table.shape, shapePreset: table.shape_preset || 'standard', active: table.active,
      status: 'open',
      reservations: reservationsByTable.get(String(table.id)) || [],
      session: projectSessionAccount(session, {
        lines: linesBySession.get(key) || [],
        transactions: txBySession.get(key) || [],
        orders: ordersBySession.get(key) || [],
        // AJUSTE COMERCIAL V1 — every revision; projectSessionAccount buckets by the
        // globally-unique order_uid, so passing the whole set per table is safe.
        obligations: rows.obligations || [],
      }),
    };
  });
}

// ACC-01 — the closed-table account, built from the SAME projection the open
// floor uses.
//
// WHY THIS EXISTS. `GET /floor` was the only read route in the whole Mesa API
// (one read, twelve writes) and `listFloorRows` filters table_sessions to
// `status=eq.open`, then scopes orders/lines/transactions/allocations to those
// session ids. So the instant an operator closed a table, its account, its
// comandas and its payment history had no surface left to appear on — the table
// simply reverted to `status:'free', session:null`. The durable rows were
// always intact and correct (proven by the 2026-08-21 audit: closing a table
// mutates nothing but table_sessions); they were merely unreachable. This is
// the missing read, nothing more.
//
// It reports the session's real status rather than assuming 'closed', so an
// operator who opens it on a table that is somehow still open sees the truth.
function buildClosedAccount(session, rows, table) {
  const key = String(session.id);
  const linesBySession = normalizeLinesBySession(rows);
  const orders = (rows.orders || []).filter((order) => String(order.table_session_id) === key);
  const transactions = (rows.transactions || []).filter((tx) => String(tx.table_session_id) === key);
  return {
    tableSessionId: session.id,
    status: session.status,
    closedAt: session.closed_at || null,
    closedBy: session.updated_by || null,
    tableRef: session.table_ref || null,
    table: table ? {
      id: table.id, number: table.table_number, name: table.display_name, capacity: table.capacity,
    } : null,
    account: projectSessionAccount(session, {
      lines: linesBySession.get(key) || [],
      transactions,
      orders,
      obligations: rows.obligations || [],
    }),
  };
}

function createMesaService({
  dao = defaultDao,
  lifecycle = defaultLifecycle,
  createOrder = defaultCreateOrder,
  changeOrderState = defaultChangeOrderState,
  hashSid = defaultSidHash,
  staleRecovery = defaultStaleRecovery,
} = {}) {
  // ═══ G-1 — SEATING IS LEGITIMATE FIRST ACTIVITY ═══
  //
  // Until G-1 this helper required a service to ALREADY be open and refused
  // outright otherwise, which made seating structurally incapable of being
  // the first thing that happens: not on a brand-new Business Day nobody had
  // ordered on yet, and not after the day's own Finalizar. The waiter got
  // MESA_SERVICE_NOT_OPEN and someone had to go press "Abrir nuevo servicio".
  //
  // The block below removes that. When nothing is open, the CANONICAL
  // resolver opens (or converges on) the current Operational Service. No
  // second engine, no cloned rule, no date computed here, no service chosen
  // here: resolve_order_intake_context_v1 owns the Business Day advance, the
  // intake window and the opening, all inside one advisory-locked
  // transaction, so two waiters (or a waiter and an order) racing the first
  // activity converge on ONE service.
  //
  // The resolver's honest refusals are preserved and are NOT overridden:
  // outside the intake window it answers ORDER_INTAKE_CLOSED, and that stays
  // MESA_SERVICE_NOT_OPEN to the waiter. A service is never forced open.
  //
  // O-4 removed the old "seat -> DB raises FORGOTTEN_CLOSE_REQUIRED -> one
  // recovery -> one pinned retry" loop this helper's name refers to, because
  // O-3 made an open operational_service_v1 unconditional continuity
  // regardless of Business Day — which is exactly the hazard the 2026-09-06
  // stale-service audit then found live. STALE SERVICE PROTECTION V1 restores
  // the recovery, now built on the ONE V3 close authority instead of the
  // deleted F-10 raise: before seating against whatever the pointer names,
  // run staleServiceRecovery. If the current service belongs to a PAST
  // Business Day it is either safely auto-finalized (then resolveOperational
  // Context below advances the day and names the fresh service) or reported
  // as PREVIOUS_SERVICE_PENDING (a typed 409 the waiter surface renders).
  // mesa_open_session_v1 / mesa_open_reservation_v1 still do NOT guard an
  // operational_service_v1 by Business Day, so this JS gate is load-bearing
  // for the seating path.
  async function seatWithStaleServiceRecovery({ actor, source, seat }) {
    let recovery = null;
    try {
      recovery = await staleRecovery({ actor, source: 'stale_service_auto_recovery' });
    } catch (_) {
      // A recovery read failure must not become a seating attempt against a
      // possibly-stale service. Fall through to currentCloseout below; if the
      // pointed service is stale the seat will still be refused by the checks
      // there once migration 120's SQL guard is in play on the resolver path.
      recovery = null;
    }
    if (recovery && recovery.stale && !recovery.recovered) {
      const err = new MesaServiceError('MESA_PREVIOUS_SERVICE_PENDING', 409);
      err.previousService = {
        staleServiceSessionId: recovery.staleServiceSessionId,
        staleBusinessDate: recovery.staleBusinessDate,
        currentBusinessDate: recovery.currentBusinessDate,
        blockers: recovery.blockers,
      };
      throw err;
    }

    const identity = await lifecycle.currentCloseout();
    let serviceSessionId = (identity && identity.ok && identity.session && identity.session.status === 'open')
      ? identity.session.id
      : null;

    if (!serviceSessionId) {
      const resolved = await lifecycle.resolveOperationalContext({ actor, source });
      if (!resolved || resolved.ok !== true || typeof resolved.periodId !== 'string') {
        // Includes ORDER_INTAKE_CLOSED, PREVIOUS_SERVICE_PENDING (migration
        // 120), and every other typed resolver refusal. Same meaning to a
        // waiter as before: there is no current service to seat against.
        // Zero seat attempts, zero mutation.
        if (resolved && resolved.code === 'PREVIOUS_SERVICE_PENDING') {
          const err = new MesaServiceError('MESA_PREVIOUS_SERVICE_PENDING', 409);
          err.previousService = {
            staleServiceSessionId: resolved.staleServiceSessionId || null,
            staleBusinessDate: resolved.staleBusinessDate || null,
            currentBusinessDate: resolved.currentBusinessDate || null,
            blockers: null,
          };
          throw err;
        }
        throw new MesaServiceError('MESA_SERVICE_NOT_OPEN', 409);
      }
      serviceSessionId = resolved.periodId;
    }

    return await seat(serviceSessionId);
  }

  return Object.freeze({
    async floor({ context, includeInactive = false } = {}) {
      const ctx = requireContext(context, FLOOR_ROLES);
      return { ok: true, tables: buildFloor(await dao.listFloorRows(ctx.workspaceId, { includeInactive })) };
    },

    // ACC-01 — the recently closed table sessions. Same roles as the floor:
    // reading back the account of a table you just closed is an operational
    // read, not a financial action, so a waiter who served the table can see
    // it. GETs only, nothing is mutated and nothing is reopened.
    async recentClosedSessions({ context, limit = 10 } = {}) {
      const ctx = requireContext(context, FLOOR_ROLES);
      const bounded = Math.max(1, Math.min(25, Number(limit) || 10));
      const sessions = await dao.listRecentClosedSessions(ctx.workspaceId, bounded);
      return {
        ok: true,
        sessions: (sessions || []).map((session) => ({
          tableSessionId: session.id,
          tableRef: session.table_ref,
          tableId: session.table_id,
          serviceSessionId: session.service_session_id,
          coversTotal: session.covers_total == null ? null : Number(session.covers_total),
          openedAt: session.opened_at,
          closedAt: session.closed_at,
          closedBy: session.updated_by,
        })),
      };
    },

    // ACC-01 — the full account of ONE table session, open or closed.
    //
    // Workspace-scoped through requireContext + the DAO's own workspace filter,
    // so one workspace can never read another's table. Read-only by
    // construction: every DAO call it makes is a PostgREST GET, there is no RPC
    // and no write path anywhere below this line. Reading a closed session does
    // not reopen it, does not touch settled_at/closed_at, and does not create a
    // session — it is the missing SELECT, nothing more.
    async sessionAccount({ context, tableSessionId } = {}) {
      const ctx = requireContext(context, FLOOR_ROLES);
      if (typeof tableSessionId !== 'string' || !UUID_RE.test(tableSessionId)) {
        throw new MesaServiceError('MESA_INVALID_REQUEST', 400);
      }
      const session = await dao.getSessionWithCloseFields(ctx.workspaceId, tableSessionId);
      if (!session) throw new MesaServiceError('MESA_SESSION_NOT_FOUND', 404);
      const [rows, table] = await Promise.all([
        dao.listSessionAccountRows(session.id),
        dao.getTableById(ctx.workspaceId, session.table_id),
      ]);
      return { ok: true, ...buildClosedAccount(session, rows, table) };
    },

    async open({ context, tableId } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      // Covers are unknown at open time -- real number comes from the first
      // comanda (see addCommand below). The DAO/RPC leaves covers_total NULL.
      return seatWithStaleServiceRecovery({
        actor: ctx.actor,
        source: 'mesa_first_seating',
        seat: (serviceSessionId) => dao.openSession({
          workspaceId: ctx.workspaceId, byActor: ctx.actor, tableId, serviceSessionId,
        }),
      });
    },

    async addCommand({ context, tableSessionId, items, note, kitchenNote, time, coversTotal, clientRequestId } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      const session = await dao.getSession(ctx.workspaceId, tableSessionId);
      if (!session) throw new MesaServiceError('MESA_SESSION_NOT_FOUND', 404);
      if (session.status !== 'open') throw new MesaServiceError('MESA_SESSION_NOT_OPEN', 409);
      if (ctx.role === 'waiter' && session.assigned_waiter_actor !== ctx.actor) {
        throw new MesaServiceError('MESA_WAITER_NOT_ASSIGNED', 403);
      }
      if (!Array.isArray(items) || items.length === 0) throw new MesaServiceError('MESA_ITEMS_REQUIRED', 400);
      // First comanda on a walk-in Mesa must carry the real covers count; later
      // ones already have session.covers_total set and never ask again. The DB
      // trigger enforces this atomically too -- this is the friendly, common-path
      // rejection so a missing value never surfaces as a generic DB error.
      const coversRequired = session.covers_total == null;
      const coversValue = Number(coversTotal);
      if (coversRequired && (!Number.isInteger(coversValue) || coversValue < 1 || coversValue > 99)) {
        throw new MesaServiceError('MESA_COVERS_REQUIRED', 400);
      }
      const result = await createOrder({
        client_req_id: clientRequestId,
        nombre: session.table_ref,
        tel: `MESA-${String(session.id).slice(0, 8).toUpperCase()}`,
        canal: 'BANCO',
        items,
        nota: note || '',
        nota_cucina: kitchenNote || '',
        hora: time || madridTime(),
        // The operator is already explicitly confirming this table command in
        // the Mesa modal. It must reach Cocina as its own ticket immediately;
        // a second POR_CONFIRMAR click would strand it now that Barra is a floor.
        estado: 'EN_COCINA',
        tipo_consegna: 'RITIRO',
        table_session_id: session.id,
        table_covers_total_input: coversRequired ? coversValue : null,
        operatorManual: true,
        actor_id: ctx.actor,
      });
      if (!result || result.success !== true) {
        throw new MesaServiceError(result?.code || result?.error || 'MESA_COMMAND_FAILED', 409);
      }
      return { ok: true, orderId: result.id, idempotent: result.idempotent === true };
    },

    // MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) — persists covers the moment
    // the operator selects them (MesaOrderBuilder's covers step), server-
    // authoritative, before the picker even opens. See mesaDao.js's
    // setCovers and migrations/2026-08-14_mesa_covers_authoritative_on_
    // selection.sql for the full root-cause note. Session lookup/open/role
    // checks mirror addCommand exactly -- setting covers is part of the
    // same "start a comanda" operator action.
    async setCovers({ context, tableSessionId, coversTotal } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      const session = await dao.getSession(ctx.workspaceId, tableSessionId);
      if (!session) throw new MesaServiceError('MESA_SESSION_NOT_FOUND', 404);
      if (session.status !== 'open') throw new MesaServiceError('MESA_SESSION_NOT_OPEN', 409);
      if (ctx.role === 'waiter' && session.assigned_waiter_actor
          && session.assigned_waiter_actor !== ctx.actor) {
        throw new MesaServiceError('MESA_WAITER_NOT_ASSIGNED', 403);
      }
      const coversValue = Number(coversTotal);
      if (!Number.isInteger(coversValue) || coversValue < 1 || coversValue > 99) {
        throw new MesaServiceError('MESA_INVALID_REQUEST', 400);
      }
      return dao.setCovers({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, tableSessionId, coversTotal: coversValue,
      });
    },

    async releaseEmptyTable({ context, tableSessionId } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      return dao.releaseEmptySession({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, tableSessionId,
      });
    },

    // P0-B.1 — the explicit "Cerrar mesa" action for an OCCUPIED table.
    // Same role set as releaseEmptyTable above: closing a table (financial
    // safety aside) is an operational floor action, not a financial one.
    // force is accepted end-to-end (RPC-level support is real and audited)
    // but no frontend UI calls it with force=true yet -- see mesaService.js
    // deploy-order note and the P0-B.1 migration's own header comment.
    //
    // OVER-COLLECTED ACKNOWLEDGEMENT (ledger 119) — confirmOverCollected is the
    // operator's explicit decision to close a table that collected MORE than it owes.
    // Strict `=== true`: a retry, a truthy string or a missing field never counts as
    // acknowledgement. Acknowledging over-collection does NOT relax the unpaid-balance
    // block, and the RPC records the exposure as an OVER_COLLECTED_AT_CLOSE incident
    // atomically with the close. Closing over-collection is still the SAME close
    // authority (OPEN_ROLES) — it is NOT the admin-only manual Ajuste Comercial power.
    async closeTable({ context, tableSessionId, force, confirmOverCollected } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      return dao.closeSession({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, tableSessionId,
        force: force === true,
        confirmOverCollected: confirmOverCollected === true,
      });
    },

    async markServed({ context, tableSessionId, orderId } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      const session = await dao.getSession(ctx.workspaceId, tableSessionId);
      if (!session) throw new MesaServiceError('MESA_SESSION_NOT_FOUND', 404);
      if (ctx.role === 'waiter' && session.assigned_waiter_actor !== ctx.actor) {
        throw new MesaServiceError('MESA_WAITER_NOT_ASSIGNED', 403);
      }
      const order = await dao.getOrderForSession(tableSessionId, orderId);
      if (!order) throw new MesaServiceError('MESA_COMMAND_NOT_FOUND', 404);
      if (order.estado === 'RETIRADO') return { ok: true, orderId, state: 'RETIRADO', idempotent: true };
      if (order.estado !== 'LISTO') throw new MesaServiceError('MESA_COMMAND_NOT_READY', 409);
      const changed = await changeOrderState(orderId, 'RETIRADO', {
        actor_type: 'operator', actor_id: ctx.actor, origin: 'mesa_dashboard',
      });
      if (!changed || changed.success !== true) {
        throw new MesaServiceError('MESA_COMMAND_STATE_FAILED', 409);
      }
      return { ok: true, orderId, state: 'RETIRADO', idempotent: false };
    },

    async pay({ context, tableSessionId, paymentMethod, mode, amount, coversSettled, lineIds, clientRequestId, confirmDuplicate } = {}) {
      const ctx = requireContext(context, PAYMENT_ROLES);
      if (typeof ctx.sid !== 'string' || !ctx.sid) throw new MesaServiceError('MESA_RELOGIN_REQUIRED', 401);
      const bySidHash = hashSid(ctx.sid);
      if (typeof bySidHash !== 'string' || !/^[0-9a-f]{64}$/.test(bySidHash)) {
        throw new MesaServiceError('MESA_RELOGIN_REQUIRED', 401);
      }
      const semantic = {
        tableSessionId, paymentMethod, mode,
        amount: amount == null ? null : Number(amount),
        coversSettled: coversSettled == null ? null : Number(coversSettled),
        lineIds: Array.isArray(lineIds) ? [...lineIds].sort() : null,
      };
      return dao.postPayment({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash,
        ...semantic, clientRequestId, requestHash: canonicalHash(semantic),
        meta: { source: 'mesa_dashboard' },
        // S1 follow-up -- kept OUTSIDE `semantic` deliberately: it must never
        // affect requestHash/idempotency (a retry with vs. without
        // confirmDuplicate is still the same logical payment intent). Strict
        // `=== true`: no truthy-string/number coercion enables the override.
        confirmDuplicate: confirmDuplicate === true,
      });
    },

    // REFUND V1 SLICE A — returns money against ONE identified original
    // payment_transactions row; never changes the sale (order_obligations is
    // untouched). Method is forced from the original transaction inside the RPC —
    // there is deliberately no paymentMethod parameter here. amount:null means
    // "the full currently-refundable remainder".
    async refund({ context, tableSessionId, originalTransactionId, amount, reason, clientRequestId } = {}) {
      const ctx = requireContext(context, REFUND_ROLES);
      if (typeof ctx.sid !== 'string' || !ctx.sid) throw new MesaServiceError('MESA_RELOGIN_REQUIRED', 401);
      const bySidHash = hashSid(ctx.sid);
      if (typeof bySidHash !== 'string' || !/^[0-9a-f]{64}$/.test(bySidHash)) {
        throw new MesaServiceError('MESA_RELOGIN_REQUIRED', 401);
      }
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (!trimmedReason) throw new MesaServiceError('MESA_REFUND_REASON_REQUIRED', 400);
      const semantic = {
        tableSessionId, originalTransactionId,
        amount: amount == null ? null : Number(amount),
        reason: trimmedReason,
      };
      return dao.postRefund({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash,
        ...semantic, clientRequestId, requestHash: canonicalHash(semantic),
        meta: { source: 'mesa_dashboard' },
      });
    },

    // AJUSTE COMERCIAL V1 — changes the OBLIGATION only. It never creates, alters or
    // reverses a payment_transactions row, so Caja is untouched by construction: only a
    // real refund moves physical money. Target is the PERMANENT order_uid, never the
    // recycled display #NNN. Reduction-only in V1 (an increase is a new comanda).
    async commercialAdjustment({
      context, tableSessionId, orderUid, newGross, reason, expectedCurrentGross, clientRequestId,
    } = {}) {
      const ctx = requireContext(context, ADJUSTMENT_ROLES);
      if (typeof ctx.sid !== 'string' || !ctx.sid) throw new MesaServiceError('MESA_RELOGIN_REQUIRED', 401);
      const bySidHash = hashSid(ctx.sid);
      if (typeof bySidHash !== 'string' || !/^[0-9a-f]{64}$/.test(bySidHash)) {
        throw new MesaServiceError('MESA_RELOGIN_REQUIRED', 401);
      }
      const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
      if (!trimmedReason) throw new MesaServiceError('MESA_ADJUSTMENT_REASON_REQUIRED', 400);
      if (typeof orderUid !== 'string' || !orderUid) {
        throw new MesaServiceError('ORDER_WITHOUT_STABLE_IDENTITY', 400);
      }
      const gross = Number(newGross);
      if (!Number.isFinite(gross) || gross < 0) {
        throw new MesaServiceError('MESA_ADJUSTMENT_INVALID', 400);
      }
      const semantic = {
        tableSessionId,
        orderUid,
        newGross: gross,
        reason: trimmedReason,
        expectedCurrentGross: expectedCurrentGross == null ? null : Number(expectedCurrentGross),
      };
      return dao.postCommercialAdjustment({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, bySidHash,
        ...semantic, clientRequestId, requestHash: canonicalHash(semantic),
        meta: { source: 'mesa_dashboard' },
      });
    },

    async saveTable({ context, table } = {}) {
      const ctx = requireContext(context, LAYOUT_ROLES);
      return dao.saveTable({ workspaceId: ctx.workspaceId, byActor: ctx.actor, ...table });
    },

    async saveReservation({ context, reservation } = {}) {
      const ctx = requireContext(context, RESERVATION_ROLES);
      return dao.saveReservation({
        workspaceId: ctx.workspaceId,
        byActor: ctx.actor,
        ...reservation,
      });
    },

    async setReservationStatus({ context, reservationId, expectedVersion, status } = {}) {
      const ctx = requireContext(context, RESERVATION_ROLES);
      return dao.setReservationStatus({
        workspaceId: ctx.workspaceId,
        byActor: ctx.actor,
        reservationId,
        expectedVersion,
        status,
      });
    },

    async openReservation({ context, reservationId, expectedVersion } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      return seatWithStaleServiceRecovery({
        actor: ctx.actor,
        source: 'mesa_first_seating',
        seat: (serviceSessionId) => dao.openReservation({
          workspaceId: ctx.workspaceId,
          byActor: ctx.actor,
          reservationId,
          expectedVersion,
          serviceSessionId,
        }),
      });
    },
  });
}

module.exports = {
  createMesaService, MesaServiceError, buildFloor, canonicalHash,
  // ACC-01 — exported so the closed-account projection can be proven to be the
  // SAME arithmetic the open floor uses, not a second implementation.
  buildClosedAccount, projectSessionAccount, normalizeLinesBySession,
};
