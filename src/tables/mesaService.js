'use strict';

const crypto = require('node:crypto');
const defaultDao = require('./mesaDao');
const { lifecycle: defaultLifecycle } = require('../serviceSessions/serviceSessionLifecycle');
// MESA FIRST-SEATING STALE SERVICE GUARD — the ONE forgotten-close executor,
// shared verbatim with the order path. Mesa imports it rather than reaching
// for the V3 engine directly, preserving F-8's single-direct-importer rule.
const forgottenClose = require('../serviceSessions/forgottenCloseRecovery');
const { creaOrdine: defaultCreateOrder, cambiaStato: defaultChangeOrderState } = require('../agents/agentOrdini');
const { nextEqualShare, aggregateByMethod } = require('./billingMath');
const { sidHash: defaultSidHash } = require('../auth/sidHash');

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
const LAYOUT_ROLES = new Set(['admin','owner']);
const RESERVATION_ROLES = new Set(['admin','operator','owner','cashier','waiter','shift_manager','legacy_operator']);
const CANCELLED = new Set(['ANULADO','CANCELADO','CANCELLED','CHIUSO_FORZATO']);

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
      capacity: table.capacity, x: nullableNumber(table.position_x), y: nullableNumber(table.position_y),
      shape: table.shape, shapePreset: table.shape_preset || 'standard', active: table.active,
      status: 'free', session: null,
      reservations: reservationsByTable.get(String(table.id)) || [],
    };
    const key = String(session.id);
    const lines = linesBySession.get(key) || [];
    const transactions = txBySession.get(key) || [];
    const totalCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
    const paidCents = lines.reduce((sum, line) => sum + cents(line.paid), 0);
    const coversEffect = transactions.reduce((sum, tx) =>
      sum + (tx.kind === 'refund' ? -1 : 1) * Number(tx.covers_settled || 0), 0);
    // NULL until the first comanda sets it (walk-in Mesa just opened, no orders yet).
    const coversTotal = session.covers_total == null ? null : Number(session.covers_total);
    const coversRemaining = coversTotal == null ? 0 : Math.max(0, coversTotal - coversEffect);
    const outstanding = money(Math.max(0, totalCents - paidCents));
    const methodTotals = aggregateByMethod(transactions.map((tx) => ({
      kind: tx.kind, method: tx.payment_method, amount: tx.amount,
    })));
    return {
      id: table.id, number: table.table_number, name: table.display_name,
      capacity: table.capacity, x: nullableNumber(table.position_x), y: nullableNumber(table.position_y),
      shape: table.shape, shapePreset: table.shape_preset || 'standard', active: table.active,
      status: 'open',
      reservations: reservationsByTable.get(String(table.id)) || [],
      session: {
        id: session.id,
        serviceSessionId: session.service_session_id,
        assignedWaiterActor: session.assigned_waiter_actor,
        coversTotal,
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

function createMesaService({
  dao = defaultDao,
  lifecycle = defaultLifecycle,
  createOrder = defaultCreateOrder,
  changeOrderState = defaultChangeOrderState,
  hashSid = defaultSidHash,
  // MESA FIRST-SEATING STALE SERVICE GUARD — injectable purely so the recovery
  // budget can be asserted in tests. Production always gets the one real
  // shared executor; this seam never selects a different engine.
  forgottenCloseRecovery = forgottenClose,
} = {}) {
  // ═══ MESA FIRST-SEATING STALE SERVICE GUARD ═══
  //
  // Seating a table is legitimate operational activity that may happen BEFORE
  // the day's first order. Until that first order exists, the canonical
  // pointer still names the PREVIOUS day's still-open Operational Service, so
  // a naive seat binds the new table session to yesterday -- which F-10 then
  // closes underneath it. The DB primitives now refuse that bind structurally
  // and raise the same typed condition the order path already raises; this is
  // the one place that answers it.
  //
  // AUTHORITY BOUNDARY. This helper decides nothing on its own. It never
  // computes a date, never judges staleness, never picks a service. The DB
  // makes the verdict and names the stale service in the exception's DETAIL;
  // the existing recovery executor closes it; the canonical resolver names the
  // successor. No second engine, no cloned logic, no frontend involvement.
  //
  // BUDGET: exactly ONE recovery and exactly ONE retry, enforced by straight-
  // line control flow rather than a loop, so a second stale verdict is a typed
  // failure and never a third attempt.
  //
  // ═══ G-1 — SEATING IS LEGITIMATE FIRST ACTIVITY ═══
  //
  // Until G-1 this helper required a service to ALREADY be open and refused
  // outright otherwise, which made seating structurally incapable of being
  // the first thing that happens: not on a brand-new Business Day nobody had
  // ordered on yet, and not after the day's own Finalizar. The waiter got
  // MESA_SERVICE_NOT_OPEN and someone had to go press "Abrir nuevo servicio".
  //
  // Step 0 below removes that. When nothing is open, the CANONICAL resolver
  // opens (or converges on) the current Operational Service -- the exact same
  // call, with the exact same arguments, that the recovery retry below
  // already makes. No second engine, no cloned rule, no date computed here,
  // no service chosen here: resolve_order_intake_context_v1 owns the Business
  // Day advance, the intake window and the opening, all inside one
  // advisory-locked transaction, so two waiters (or a waiter and an order)
  // racing the first activity converge on ONE service.
  //
  // The resolver's honest refusals are preserved and are NOT overridden:
  // outside the intake window it answers ORDER_INTAKE_CLOSED, and that stays
  // MESA_SERVICE_NOT_OPEN to the waiter -- the same typed 409 and the same UI
  // copy this helper already returns for an unresolvable successor. A service
  // is never forced open.
  //
  // NOTHING ELSE MOVES. When a service IS open, this function behaves exactly
  // as before, byte for byte: the stale-service path (seat -> DB raises
  // FORGOTTEN_CLOSE_REQUIRED -> one recovery -> one pinned retry) is
  // untouched, and so are mesa_open_session_v1 / mesa_open_reservation_v1.
  async function seatWithStaleServiceRecovery({ actor, source, seat }) {
    const identity = await lifecycle.currentCloseout();
    let serviceSessionId = (identity && identity.ok && identity.session && identity.session.status === 'open')
      ? identity.session.id
      : null;

    if (!serviceSessionId) {
      const resolved = await lifecycle.resolveOperationalContext({ actor, source });
      if (!resolved || resolved.ok !== true || typeof resolved.periodId !== 'string') {
        // Includes ORDER_INTAKE_CLOSED and every other typed resolver
        // refusal. Same meaning to a waiter as before: there is no current
        // service to seat against. Zero seat attempts, zero mutation.
        throw new MesaServiceError('MESA_SERVICE_NOT_OPEN', 409);
      }
      serviceSessionId = resolved.periodId;
    }

    try {
      return await seat(serviceSessionId);
    } catch (error) {
      // The structured triple (P0001 + FORGOTTEN_CLOSE_REQUIRED + UUID in
      // DETAIL) is re-validated by the shared parser and fails closed on any
      // partial match, so a look-alike error falls through untouched.
      const forgotten = forgottenCloseRecovery.parseForgottenCloseRequired(error && error.pgError);
      if (!forgotten) throw error;

      // The stale identity comes from the DB's own DETAIL field, never from
      // the caller, the pointer, or a follow-up "what looks stale now" query.
      const recovery = await forgottenCloseRecovery.recoverForgottenService({
        staleServiceSessionId: forgotten.staleServiceSessionId,
      });
      // A reported failure does NOT prove the stale service is still open: a
      // concurrent seat or order racing the SAME service can legitimately
      // close it first, and this call then observes a non-fresh outcome. The
      // budgeted retry below is what actually discriminates -- failing closed
      // here would wrongly reject a race loser the winner already fixed. Same
      // convergence rule the certified order path uses.
      if (!recovery || recovery.success !== true) {
        console.warn(`[mesa] stale-service recovery reported failure for ${forgotten.staleServiceSessionId} (code=${(recovery && recovery.code) || null}) — retrying seat once to let it self-resolve`);
      }

      // The successor is resolved by the canonical authority, which advances
      // the Business Day and opens today's service in one locked transaction.
      // The retry is PINNED to that confirmed id rather than re-reading the
      // pointer, so a concurrent writer cannot slip a different service under
      // this seat between resolution and insert.
      const resolved = await lifecycle.resolveOperationalContext({ actor, source });
      if (!resolved || resolved.ok !== true || typeof resolved.periodId !== 'string') {
        // Includes the honest out-of-schedule answer (ORDER_INTAKE_CLOSED) and
        // REOPEN_REQUIRED. Both mean the same thing to a waiter -- there is no
        // current service to seat against -- and map to the code the Mesa UI
        // already explains, rather than forcing a service open.
        throw new MesaServiceError('MESA_SERVICE_NOT_OPEN', 409);
      }

      try {
        return await seat(resolved.periodId);
      } catch (retryError) {
        if (forgottenCloseRecovery.parseForgottenCloseRequired(retryError && retryError.pgError)) {
          throw new MesaServiceError('MESA_SERVICE_STALE_UNRESOLVED', 409);
        }
        throw retryError;
      }
    }
  }

  return Object.freeze({
    async floor({ context, includeInactive = false } = {}) {
      const ctx = requireContext(context, FLOOR_ROLES);
      return { ok: true, tables: buildFloor(await dao.listFloorRows(ctx.workspaceId, { includeInactive })) };
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
    async closeTable({ context, tableSessionId, force } = {}) {
      const ctx = requireContext(context, OPEN_ROLES);
      return dao.closeSession({
        workspaceId: ctx.workspaceId, byActor: ctx.actor, tableSessionId, force: force === true,
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

module.exports = { createMesaService, MesaServiceError, buildFloor, canonicalHash };
