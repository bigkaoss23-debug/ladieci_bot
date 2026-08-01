'use strict';

const jwt = require('../auth/jwt');
const { getAuthoritativeActor } = require('../auth/accessManagementHttpDaoV3');
const { createMessaService, MessaServiceError } = require('./messaService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeError(error) {
  if (error instanceof MessaServiceError) return { status: error.status, code: error.code };
  const code = typeof error?.code === 'string' && /^MESSA_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'MESSA_INTERNAL_ERROR';
  const conflict = new Set([
    'MESSA_TABLE_NOT_RELEASED','MESSA_TABLE_ACCOUNT_OPEN',
    'MESSA_SESSION_NOT_OPEN','MESSA_SERVICE_NOT_OPEN',
    'MESSA_ALREADY_SETTLED','MESSA_LINE_SELECTION_SETTLED',
    'MESSA_COMMAND_NOT_READY','MESSA_COMMAND_STATE_FAILED',
    'MESSA_PAYMENT_IDEMPOTENCY_CONFLICT',
    'MESSA_RESERVATION_OVERLAP','MESSA_RESERVATION_VERSION_CONFLICT',
    'MESSA_RESERVATION_NOT_BOOKED','MESSA_RESERVATION_CAPACITY_EXCEEDED',
    'MESSA_TABLE_HAS_RESERVATIONS',
  ]);
  const denied = new Set(['MESSA_PAYMENT_FORBIDDEN','MESSA_OPEN_FORBIDDEN','MESSA_LAYOUT_FORBIDDEN','MESSA_RESERVATION_FORBIDDEN']);
  const missing = new Set(['MESSA_SESSION_NOT_FOUND','MESSA_TABLE_NOT_FOUND','MESSA_WORKSPACE_NOT_FOUND','MESSA_COMMAND_NOT_FOUND','MESSA_RESERVATION_NOT_FOUND']);
  return {
    status: conflict.has(code) ? 409 : denied.has(code) ? 403 : missing.has(code) ? 404 : code === 'MESSA_INTERNAL_ERROR' ? 500 : 400,
    code,
  };
}

function createMessaAuthMiddleware({ verifyToken = jwt.verifyToken, getActor = getAuthoritativeActor } = {}) {
  return async function messaAuth(req, res, next) {
    const raw = req?.headers?.authorization || req?.headers?.Authorization;
    const match = typeof raw === 'string' ? raw.match(/^Bearer\s+(.+)$/i) : null;
    const payload = match ? verifyToken(match[1]) : null;
    if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string'
        || !Number.isInteger(payload.sv)) {
      return res.status(401).json({ ok: false, code: 'MESSA_UNAUTHENTICATED' });
    }
    let actor;
    try { actor = await getActor(payload.sub); }
    catch (_) { return res.status(500).json({ ok: false, code: 'MESSA_AUTHORITY_UNAVAILABLE' }); }
    if (!actor || actor.active !== true || actor.role !== payload.role
        || actor.session_version !== payload.sv || typeof actor.workspace_id !== 'string') {
      return res.status(401).json({ ok: false, code: 'MESSA_SESSION_STALE' });
    }
    req.messaContext = Object.freeze({
      actor: actor.actor,
      role: actor.role,
      workspaceId: actor.workspace_id,
      sessionVersion: actor.session_version,
      sid: typeof payload.sid === 'string' ? payload.sid : null,
    });
    return next();
  };
}

function createMessaHandlers({ service = createMessaService(), logger = console } = {}) {
  const run = (operation, fn) => async (req, res) => {
    try {
      const body = await fn(req);
      return res.status(200).json(body);
    } catch (error) {
      const mapped = safeError(error);
      try { logger.warn({ component: 'messa', operation, outcome: 'error', code: mapped.code }); } catch (_) {}
      return res.status(mapped.status).json({ ok: false, code: mapped.code });
    }
  };
  const validId = (value) => typeof value === 'string' && UUID.test(value);
  const requireId = (value) => {
    if (!validId(value)) throw new MessaServiceError('MESSA_INVALID_ID', 400);
    return value;
  };
  const requireOrderId = (value) => {
    if (typeof value !== 'string' || !/^#[0-9]{3,12}$/.test(value)) {
      throw new MessaServiceError('MESSA_ORDER_ID_INVALID', 400);
    }
    return value;
  };
  const requestId = (body) => {
    const value = body?.clientRequestId;
    if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new MessaServiceError('MESSA_CLIENT_REQUEST_ID_INVALID', 400);
    }
    return value;
  };

  return Object.freeze({
    floor: run('floor', (req) => service.floor({
      context: req.messaContext,
      includeInactive: req.query?.includeInactive === 'true',
    })),
    open: run('open', (req) => service.open({
      context: req.messaContext,
      tableId: requireId(req.params.tableId),
      coversTotal: Number(req.body?.coversTotal),
    })),
    addCommand: run('add_command', (req) => service.addCommand({
      context: req.messaContext,
      tableSessionId: requireId(req.params.sessionId),
      items: req.body?.items,
      note: req.body?.note,
      kitchenNote: req.body?.kitchenNote,
      time: req.body?.time,
      clientRequestId: requestId(req.body),
    })),
    markServed: run('mark_served', (req) => service.markServed({
      context: req.messaContext,
      tableSessionId: requireId(req.params.sessionId),
      orderId: requireOrderId(req.params.orderId),
    })),
    pay: run('pay', (req) => service.pay({
      context: req.messaContext,
      tableSessionId: requireId(req.params.sessionId),
      paymentMethod: req.body?.paymentMethod,
      mode: req.body?.mode,
      amount: req.body?.amount,
      coversSettled: req.body?.coversSettled,
      lineIds: req.body?.lineIds,
      clientRequestId: requestId(req.body),
    })),
    saveTable: run('save_table', (req) => service.saveTable({
      context: req.messaContext,
      table: {
        tableId: req.params.tableId === 'new' ? null : requireId(req.params.tableId),
        tableNumber: Number(req.body?.tableNumber),
        displayName: req.body?.displayName,
        capacity: req.body?.capacity == null ? null : Number(req.body.capacity),
        positionX: Number(req.body?.positionX),
        positionY: Number(req.body?.positionY),
        shape: req.body?.shape,
        active: req.body?.active,
      },
    })),
    createReservation: run('create_reservation', (req) => service.saveReservation({
      context: req.messaContext,
      reservation: {
        reservationId: null,
        tableId: requireId(req.params.tableId),
        guestName: req.body?.guestName,
        guestPhone: req.body?.guestPhone,
        coversTotal: Number(req.body?.coversTotal),
        reservedLocalDate: req.body?.reservedLocalDate,
        reservedLocalTime: req.body?.reservedLocalTime,
        note: req.body?.note,
        expectedVersion: null,
      },
    })),
    updateReservation: run('update_reservation', (req) => service.saveReservation({
      context: req.messaContext,
      reservation: {
        reservationId: requireId(req.params.reservationId),
        tableId: requireId(req.body?.tableId),
        guestName: req.body?.guestName,
        guestPhone: req.body?.guestPhone,
        coversTotal: Number(req.body?.coversTotal),
        reservedLocalDate: req.body?.reservedLocalDate,
        reservedLocalTime: req.body?.reservedLocalTime,
        note: req.body?.note,
        expectedVersion: Number(req.body?.expectedVersion),
      },
    })),
    setReservationStatus: run('set_reservation_status', (req) => service.setReservationStatus({
      context: req.messaContext,
      reservationId: requireId(req.params.reservationId),
      expectedVersion: Number(req.body?.expectedVersion),
      status: req.body?.status,
    })),
    openReservation: run('open_reservation', (req) => service.openReservation({
      context: req.messaContext,
      reservationId: requireId(req.params.reservationId),
      expectedVersion: Number(req.body?.expectedVersion),
    })),
  });
}

function registerMessaRoutes(router, deps = {}) {
  const handlers = createMessaHandlers(deps);
  const auth = createMessaAuthMiddleware(deps);
  router.get('/floor', auth, handlers.floor);
  router.post('/tables/:tableId/open', auth, handlers.open);
  router.put('/tables/:tableId', auth, handlers.saveTable);
  router.post('/sessions/:sessionId/commands', auth, handlers.addCommand);
  router.post('/sessions/:sessionId/commands/:orderId/served', auth, handlers.markServed);
  router.post('/sessions/:sessionId/payments', auth, handlers.pay);
  router.post('/tables/:tableId/reservations', auth, handlers.createReservation);
  router.put('/reservations/:reservationId', auth, handlers.updateReservation);
  router.post('/reservations/:reservationId/status', auth, handlers.setReservationStatus);
  router.post('/reservations/:reservationId/open', auth, handlers.openReservation);
  return Object.freeze({ routes: 10 });
}

module.exports = {
  createMessaAuthMiddleware,
  createMessaHandlers,
  registerMessaRoutes,
  safeError,
};
