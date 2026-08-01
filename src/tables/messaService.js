'use strict';

const crypto = require('node:crypto');
const defaultDao = require('./messaDao');
const { lifecycle: defaultLifecycle } = require('../serviceSessions/serviceSessionLifecycle');
const { creaOrdine: defaultCreateOrder, cambiaStato: defaultChangeOrderState } = require('../agents/agentOrdini');
const { nextEqualShare, aggregateByMethod } = require('./billingMath');
const { sidHash: defaultSidHash } = require('../auth/sidHash');

class MessaServiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'MessaServiceError';
    this.code = code;
    this.status = status;
  }
}

const FLOOR_ROLES = new Set(['admin','operator','owner','cashier','waiter','legacy_operator','shift_manager']);
const OPEN_ROLES = new Set(['admin','operator','owner','cashier','waiter','legacy_operator']);
const PAYMENT_ROLES = new Set(['admin','operator','owner','cashier','legacy_operator']);
const LAYOUT_ROLES = new Set(['admin','owner']);
const RESERVATION_ROLES = new Set(['admin','operator','owner','cashier','waiter','shift_manager','legacy_operator']);
const CANCELLED = new Set(['ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO']);

function requireContext(context, allowed) {
  if (!context || typeof context.actor !== 'string' || typeof context.workspaceId !== 'string') {
    throw new MessaServiceError('MESSA_UNAUTHENTICATED', 401);
  }
  if (!allowed.has(context.role)) throw new MessaServiceError('MESSA_FORBIDDEN', 403);
  return context;
}

const cents = (value) => Math.round((Number(value) || 0) * 100);
const money = (value) => Math.round(value) / 100;

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
  const orderById = new Map();
  for (const order of rows.orders) {
    orderById.set(String(order.id), order);
    const key = String(order.table_session_id);
    if (!ordersBySession.has(key)) ordersBySession.set(key, []);
    ordersBySession.get(key).push(order);
  }
  const txById = new Map(rows.transactions.map((tx) => [String(tx.id), tx]));
  const allocationsByLine = new Map();
  for (const allocation of rows.allocations) {
    const tx = txById.get(String(allocation.payment_transaction_id));
    if (!tx) continue;
    const sign = tx.kind === 'refund' ? -1 : 1;
    const key = String(allocation.table_order_line_id);
    allocationsByLine.set(key, (allocationsByLine.get(key) || 0) + sign * cents(allocation.amount));
  }
  const linesBySession = new Map();
  for (const line of rows.lines) {
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
      capacity: table.capacity, x: Number(table.position_x), y: Number(table.position_y),
      shape: table.shape, active: table.active, status: 'free', session: null,
      reservations: reservationsByTable.get(String(table.id)) || [],
    };
    const key = String(session.id);
    const lines = linesBySession.get(key) || [];
    const transactions = txBySession.get(key) || [];
    const totalCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
    const paidCents = lines.reduce((sum, line) => sum + cents(line.paid), 0);
    const coversEffect = transactions.reduce((sum, tx) =>
      sum + (tx.kind === 'refund' ? -1 : 1) * Number(tx.covers_settled || 0), 0);
    const coversRemaining = Math.max(0, Number(session.covers_total) - coversEffect);
    const outstanding = money(Math.max(0, totalCents - paidCents));
    const methodTotals = aggregateByMethod(transactions.map((tx) => ({
      kind: tx.kind, method: tx.payment_method, amount: tx.amount,
    })));
    return {
      id: table.id, number: table.table_number, name: table.display_name,
      capacity: table.capacity, x: Number(table.position_x), y: Number(table.position_y),
      shape: table.shape, active: table.active,
      status: 'open',
      reservations: reservationsByTable.get(String(table.id)) || [],
      session: {
        id: session.id,
        serviceSessionId: session.service_session_id,
        assignedWaiterActor: session.assigned_waiter_actor,
        coversTotal: Number(session.covers_total),
        coversRemaining,
        openedAt: session.opened_at,
        settledAt: session.settled_at,
        total: money(totalCents),
        paid: money(paidCents),
        outstanding,
        nextEqualShare: outstanding > 0 && coversRemaining > 0
          ? nextEqualShare(outstanding, coversRemaining) : 0,
        paymentTotals: { ...methodTotals },
        commands: (ordersBySession.get(key) || []).map((order) => ({
          id: order.id,
          commandNumber: order.table_command_number,
          serviceOrderNumber: order.service_order_number,
          state: order.estado,
          total: Number(order.totale || 0),
          time: order.hora,
          items: order.items,
          note: order.nota,
          kitchenNote: order.nota_cucina,
        })),
        lines,
        payments: transactions.map((tx) => ({
          id: tx.id, kind: tx.kind, mode: tx.mode, amount: Number(tx.amount),
          method: tx.payment_method, coversSettled: tx.covers_settled,
          actor: tx.by_actor, createdAt: tx.created_at,
        })),
      },
    };
  });
}

function createMessaService({
  dao = defaultDao,
  lifecycle = defaultLifecycle,
  createOrder = defaultCreateOrder,
  changeOrderState = defaultChangeOrderState,
  hashSid = defaultSidHash,
} = {}) {
  return Object.freeze({
    async floor({ context, includeInactive = false } = {}) {
      const ctx = requireContext(context, FLOOR_ROLES);
      return { ok: true, tables: buildFloor(await dao.listFloorRows(ctx.workspaceId, { includeInactive })) };
    },

    async open({ context, tableId, coversTotal } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      const identity = await lifecycle.currentCloseout();
      if (!identity || !identity.ok || !identity.session || identity.session.status !== 'open') {
        throw new MessaServiceError('MESSA_SERVICE_NOT_OPEN', 409);
      }
      return dao.openSession({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, tableId,
        serviceSessionId: identity.session.id, coversTotal,
      });
    },

    async addCommand({ context, tableSessionId, items, note, kitchenNote, time, clientRequestId } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      const session = await dao.getSession(ctx.workspaceId, tableSessionId);
      if (!session) throw new MessaServiceError('MESSA_SESSION_NOT_FOUND', 404);
      if (session.status !== 'open') throw new MessaServiceError('MESSA_SESSION_NOT_OPEN', 409);
      if (ctx.role === 'waiter' && session.assigned_waiter_actor !== ctx.actor) {
        throw new MessaServiceError('MESSA_WAITER_NOT_ASSIGNED', 403);
      }
      if (!Array.isArray(items) || items.length === 0) throw new MessaServiceError('MESSA_ITEMS_REQUIRED', 400);
      const result = await createOrder({
        client_req_id: clientRequestId,
        nombre: session.table_ref,
        tel: `MESSA-${String(session.id).slice(0, 8).toUpperCase()}`,
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
        operatorManual: true,
        actor_id: ctx.actor,
      });
      if (!result || result.success !== true) {
        throw new MessaServiceError(result?.code || result?.error || 'MESSA_COMMAND_FAILED', 409);
      }
      return { ok: true, orderId: result.id, idempotent: result.idempotent === true };
    },

    async markServed({ context, tableSessionId, orderId } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      const session = await dao.getSession(ctx.workspaceId, tableSessionId);
      if (!session) throw new MessaServiceError('MESSA_SESSION_NOT_FOUND', 404);
      if (ctx.role === 'waiter' && session.assigned_waiter_actor !== ctx.actor) {
        throw new MessaServiceError('MESSA_WAITER_NOT_ASSIGNED', 403);
      }
      const order = await dao.getOrderForSession(tableSessionId, orderId);
      if (!order) throw new MessaServiceError('MESSA_COMMAND_NOT_FOUND', 404);
      if (order.estado === 'RETIRADO') return { ok: true, orderId, state: 'RETIRADO', idempotent: true };
      if (order.estado !== 'LISTO') throw new MessaServiceError('MESSA_COMMAND_NOT_READY', 409);
      const changed = await changeOrderState(orderId, 'RETIRADO', {
        actor_type: 'operator', actor_id: ctx.actor, origin: 'messa_dashboard',
      });
      if (!changed || changed.success !== true) {
        throw new MessaServiceError('MESSA_COMMAND_STATE_FAILED', 409);
      }
      return { ok: true, orderId, state: 'RETIRADO', idempotent: false };
    },

    async pay({ context, tableSessionId, paymentMethod, mode, amount, coversSettled, lineIds, clientRequestId } = {}) {
      const ctx = requireContext(context, PAYMENT_ROLES);
      if (typeof ctx.sid !== 'string' || !ctx.sid) throw new MessaServiceError('MESSA_RELOGIN_REQUIRED', 401);
      const bySidHash = hashSid(ctx.sid);
      if (typeof bySidHash !== 'string' || !/^[0-9a-f]{64}$/.test(bySidHash)) {
        throw new MessaServiceError('MESSA_RELOGIN_REQUIRED', 401);
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
        meta: { source: 'messa_dashboard' },
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
      const identity = await lifecycle.currentCloseout();
      if (!identity || !identity.ok || !identity.session || identity.session.status !== 'open') {
        throw new MessaServiceError('MESSA_SERVICE_NOT_OPEN', 409);
      }
      return dao.openReservation({
        workspaceId: ctx.workspaceId,
        byActor: ctx.actor,
        reservationId,
        expectedVersion,
        serviceSessionId: identity.session.id,
      });
    },
  });
}

module.exports = { createMessaService, MessaServiceError, buildFloor, canonicalHash };
