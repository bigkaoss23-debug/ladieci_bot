'use strict';

const jwt = require('../auth/jwt');
const { getAuthoritativeActor } = require('../auth/accessManagementHttpDaoV3');
const { createMesaService, MesaServiceError } = require('./mesaService');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The MESA_ error-code prefix (below) is the wire vocabulary shared with the
// mesa_*_v1 Postgres functions and the frontend's error dictionary -- see the
// deploy-order note in mesaService.js.
function safeError(error) {
  if (error instanceof MesaServiceError) return { status: error.status, code: error.code };
  const code = typeof error?.code === 'string' && /^MESA_[A-Z0-9_]+$/.test(error.code)
    ? error.code : 'MESA_INTERNAL_ERROR';
  const conflict = new Set([
    'MESA_TABLE_NOT_RELEASED','MESA_TABLE_ACCOUNT_OPEN',
    'MESA_SESSION_NOT_OPEN','MESA_SERVICE_NOT_OPEN',
    'MESA_ALREADY_SETTLED','MESA_LINE_SELECTION_SETTLED',
    'MESA_COMMAND_NOT_READY','MESA_COMMAND_STATE_FAILED',
    'MESA_PAYMENT_IDEMPOTENCY_CONFLICT',
    'MESA_RESERVATION_OVERLAP','MESA_RESERVATION_VERSION_CONFLICT',
    'MESA_RESERVATION_NOT_BOOKED','MESA_RESERVATION_CAPACITY_EXCEEDED',
    'MESA_TABLE_HAS_RESERVATIONS',
    'MESA_COVERS_NOT_SET','MESA_COVERS_IMMUTABLE','MESA_TABLE_HAS_ORDERS',
    'MESA_TABLE_NOT_SETTLED','MESA_TABLE_HAS_ACTIVE_ORDERS',
  ]);
  const denied = new Set(['MESA_PAYMENT_FORBIDDEN','MESA_OPEN_FORBIDDEN','MESA_LAYOUT_FORBIDDEN','MESA_RESERVATION_FORBIDDEN','MESA_CLOSE_FORBIDDEN']);
  const missing = new Set(['MESA_SESSION_NOT_FOUND','MESA_TABLE_NOT_FOUND','MESA_WORKSPACE_NOT_FOUND','MESA_COMMAND_NOT_FOUND','MESA_RESERVATION_NOT_FOUND']);
  return {
    status: conflict.has(code) ? 409 : denied.has(code) ? 403 : missing.has(code) ? 404 : code === 'MESA_INTERNAL_ERROR' ? 500 : 400,
    code,
  };
}

function createMesaAuthMiddleware({ verifyToken = jwt.verifyToken, getActor = getAuthoritativeActor } = {}) {
  return async function mesaAuth(req, res, next) {
    const raw = req?.headers?.authorization || req?.headers?.Authorization;
    const match = typeof raw === 'string' ? raw.match(/^Bearer\s+(.+)$/i) : null;
    const payload = match ? verifyToken(match[1]) : null;
    if (!payload || typeof payload.sub !== 'string' || typeof payload.role !== 'string'
        || !Number.isInteger(payload.sv)) {
      return res.status(401).json({ ok: false, code: 'MESA_UNAUTHENTICATED' });
    }
    let actor;
    try { actor = await getActor(payload.sub); }
    catch (_) { return res.status(500).json({ ok: false, code: 'MESA_AUTHORITY_UNAVAILABLE' }); }
    if (!actor || actor.active !== true || actor.role !== payload.role
        || actor.session_version !== payload.sv || typeof actor.workspace_id !== 'string') {
      return res.status(401).json({ ok: false, code: 'MESA_SESSION_STALE' });
    }
    req.mesaContext = Object.freeze({
      actor: actor.actor,
      role: actor.role,
      workspaceId: actor.workspace_id,
      sessionVersion: actor.session_version,
      sid: typeof payload.sid === 'string' ? payload.sid : null,
    });
    return next();
  };
}

function createMesaHandlers({ service = createMesaService(), logger = console } = {}) {
  const run = (operation, fn) => async (req, res) => {
    try {
      const body = await fn(req);
      return res.status(200).json(body);
    } catch (error) {
      const mapped = safeError(error);
      try { logger.warn({ component: 'mesa', operation, outcome: 'error', code: mapped.code }); } catch (_) {}
      return res.status(mapped.status).json({ ok: false, code: mapped.code });
    }
  };
  const validId = (value) => typeof value === 'string' && UUID.test(value);
  const requireId = (value) => {
    if (!validId(value)) throw new MesaServiceError('MESA_INVALID_ID', 400);
    return value;
  };
  const requireOrderId = (value) => {
    if (typeof value !== 'string' || !/^#[0-9]{3,12}$/.test(value)) {
      throw new MesaServiceError('MESA_ORDER_ID_INVALID', 400);
    }
    return value;
  };
  const requestId = (body) => {
    const value = body?.clientRequestId;
    if (typeof value !== 'string' || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new MesaServiceError('MESA_CLIENT_REQUEST_ID_INVALID', 400);
    }
    return value;
  };

  return Object.freeze({
    floor: run('floor', (req) => service.floor({
      context: req.mesaContext,
      includeInactive: req.query?.includeInactive === 'true',
    })),
    open: run('open', (req) => service.open({
      context: req.mesaContext,
      tableId: requireId(req.params.tableId),
    })),
    addCommand: run('add_command', (req) => service.addCommand({
      context: req.mesaContext,
      tableSessionId: requireId(req.params.sessionId),
      items: req.body?.items,
      note: req.body?.note,
      kitchenNote: req.body?.kitchenNote,
      time: req.body?.time,
      coversTotal: req.body?.coversTotal == null ? null : Number(req.body.coversTotal),
      clientRequestId: requestId(req.body),
    })),
    // MESA_SEND_TO_KITCHEN_P0_FIX (2026-08-14) -- see mesaService.js's
    // setCovers for the full root-cause note.
    setCovers: run('set_covers', (req) => service.setCovers({
      context: req.mesaContext,
      tableSessionId: requireId(req.params.sessionId),
      coversTotal: req.body?.coversTotal,
    })),
    releaseEmptyTable: run('release_empty_table', (req) => service.releaseEmptyTable({
      context: req.mesaContext,
      tableSessionId: requireId(req.params.sessionId),
    })),
    closeTable: run('close_table', (req) => service.closeTable({
      context: req.mesaContext,
      tableSessionId: requireId(req.params.sessionId),
      force: req.body?.force === true,
    })),
    markServed: run('mark_served', (req) => service.markServed({
      context: req.mesaContext,
      tableSessionId: requireId(req.params.sessionId),
      orderId: requireOrderId(req.params.orderId),
    })),
    pay: run('pay', (req) => service.pay({
      context: req.mesaContext,
      tableSessionId: requireId(req.params.sessionId),
      paymentMethod: req.body?.paymentMethod,
      mode: req.body?.mode,
      amount: req.body?.amount,
      coversSettled: req.body?.coversSettled,
      lineIds: req.body?.lineIds,
      clientRequestId: requestId(req.body),
    })),
    saveTable: run('save_table', (req) => service.saveTable({
      context: req.mesaContext,
      table: {
        tableId: req.params.tableId === 'new' ? null : requireId(req.params.tableId),
        tableNumber: Number(req.body?.tableNumber),
        displayName: req.body?.displayName,
        capacity: req.body?.capacity == null ? null : Number(req.body.capacity),
        positionX: Number(req.body?.positionX),
        positionY: Number(req.body?.positionY),
        shape: req.body?.shape,
        shapePreset: req.body?.shapePreset,
        active: req.body?.active,
      },
    })),
    createReservation: run('create_reservation', (req) => service.saveReservation({
      context: req.mesaContext,
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
      context: req.mesaContext,
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
      context: req.mesaContext,
      reservationId: requireId(req.params.reservationId),
      expectedVersion: Number(req.body?.expectedVersion),
      status: req.body?.status,
    })),
    openReservation: run('open_reservation', (req) => service.openReservation({
      context: req.mesaContext,
      reservationId: requireId(req.params.reservationId),
      expectedVersion: Number(req.body?.expectedVersion),
    })),
  });
}

function registerMesaRoutes(router, deps = {}) {
  const handlers = createMesaHandlers(deps);
  const auth = createMesaAuthMiddleware(deps);
  router.get('/floor', auth, handlers.floor);
  router.post('/tables/:tableId/open', auth, handlers.open);
  router.put('/tables/:tableId', auth, handlers.saveTable);
  router.post('/sessions/:sessionId/release', auth, handlers.releaseEmptyTable);
  router.post('/sessions/:sessionId/close', auth, handlers.closeTable);
  router.post('/sessions/:sessionId/commands', auth, handlers.addCommand);
  router.post('/sessions/:sessionId/covers', auth, handlers.setCovers);
  router.post('/sessions/:sessionId/commands/:orderId/served', auth, handlers.markServed);
  router.post('/sessions/:sessionId/payments', auth, handlers.pay);
  router.post('/tables/:tableId/reservations', auth, handlers.createReservation);
  router.put('/reservations/:reservationId', auth, handlers.updateReservation);
  router.post('/reservations/:reservationId/status', auth, handlers.setReservationStatus);
  router.post('/reservations/:reservationId/open', auth, handlers.openReservation);
  return Object.freeze({ routes: 13 });
}

module.exports = {
  createMesaAuthMiddleware,
  createMesaHandlers,
  registerMesaRoutes,
  safeError,
};
