'use strict';

const { AuthDaoError, sbRest } = require('../auth/audit');

function idsFilter(ids) {
  const values = [...new Set((ids || []).map(String).filter(Boolean))];
  return values.length ? `in.(${values.map(encodeURIComponent).join(',')})` : null;
}

async function select(resource, query) {
  const response = await sbRest('GET', resource, { query });
  if (!response.ok || !Array.isArray(response.body)) {
    throw new AuthDaoError('MESA_DATA_READ_FAILED', `read failed: ${resource}`);
  }
  return response.body;
}

async function rpc(name, body) {
  const response = await sbRest('POST', `rpc/${name}`, { body });
  if (!response.ok) {
    const rawCode = response.body && typeof response.body.message === 'string'
      ? response.body.message.trim() : '';
    const error = new AuthDaoError(rawCode || 'MESA_DATA_WRITE_FAILED', 'Mesa RPC failed');
    error.status = response.status;
    throw error;
  }
  return response.body;
}

async function listFloorRows(workspaceId, { includeInactive = false } = {}) {
  const tables = await select('restaurant_tables',
    `select=id,workspace_id,table_number,display_name,capacity,position_x,position_y,shape,shape_preset,active,updated_at`
    + `&workspace_id=eq.${encodeURIComponent(workspaceId)}`
    + (includeInactive ? '' : '&active=eq.true')
    + '&order=table_number.asc');

  const [sessions, reservations] = await Promise.all([
    select('table_sessions',
      `select=id,workspace_id,table_id,service_session_id,table_ref,status,assigned_waiter_actor,`
      + `covers_total,next_command_number,opened_at,settled_at,updated_at`
      + `&workspace_id=eq.${encodeURIComponent(workspaceId)}`
      + '&status=eq.open&order=opened_at.asc'),
    select('table_reservations',
      `select=id,workspace_id,table_id,table_session_id,status,guest_name,guest_phone,covers_total,`
      + `reserved_at,duration_minutes,note,version,created_at,updated_at,created_by,updated_by`
      + `&workspace_id=eq.${encodeURIComponent(workspaceId)}`
      + '&status=in.(booked,seated)&order=reserved_at.asc'),
  ]);
  const sessionIds = sessions.map((row) => row.id);
  const sessionFilter = idsFilter(sessionIds);
  if (!sessionFilter) return { tables, sessions, reservations, orders: [], lines: [], transactions: [], allocations: [] };

  const [orders, lines, transactions] = await Promise.all([
    select('ordenes',
      `select=id,table_session_id,table_command_number,table_number_snapshot,table_name_snapshot,`
      + `service_session_id,service_order_number,estado,items,nota,nota_cucina,hora,totale,ts`
      + `&table_session_id=${sessionFilter}&order=ts.asc`),
    select('table_order_lines',
      `select=id,table_session_id,service_session_id,order_id,source_line_id,source_line_index,`
      + `unit_index,description,product_snapshot,gross_amount,discount_amount,net_amount,created_at`
      + `&table_session_id=${sessionFilter}&order=created_at.asc,order_id.asc,source_line_index.asc,unit_index.asc`),
    select('payment_transactions',
      `select=id,table_session_id,service_session_id,kind,mode,amount,payment_method,covers_settled,`
      + `reverses_transaction_id,by_actor,by_role,created_at`
      + `&table_session_id=${sessionFilter}&order=created_at.asc`),
  ]);

  const txFilter = idsFilter(transactions.map((row) => row.id));
  const allocations = txFilter
    ? await select('payment_allocations',
      `select=id,payment_transaction_id,table_order_line_id,order_id,amount,created_at`
      + `&payment_transaction_id=${txFilter}&order=created_at.asc`)
    : [];
  return { tables, sessions, reservations, orders, lines, transactions, allocations };
}

async function getSession(workspaceId, sessionId) {
  const rows = await select('table_sessions',
    `select=id,workspace_id,table_id,service_session_id,table_ref,status,assigned_waiter_actor,`
    + `covers_total,next_command_number,opened_at,settled_at,updated_at`
    + `&workspace_id=eq.${encodeURIComponent(workspaceId)}`
    + `&id=eq.${encodeURIComponent(sessionId)}&limit=1`);
  return rows[0] || null;
}

async function getOrderForSession(tableSessionId, orderId) {
  const rows = await select('ordenes',
    `select=id,table_session_id,estado&table_session_id=eq.${encodeURIComponent(tableSessionId)}`
    + `&id=eq.${encodeURIComponent(orderId)}&limit=1`);
  return rows[0] || null;
}

const openSession = (args) => rpc('mesa_open_session_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_table_id: args.tableId,
  p_service_session_id: args.serviceSessionId,
});

const releaseEmptySession = (args) => rpc('mesa_release_empty_session_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_table_session_id: args.tableSessionId,
});

const saveTable = (args) => rpc('mesa_save_table_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_table_id: args.tableId || null,
  p_table_number: args.tableNumber,
  p_display_name: args.displayName,
  p_capacity: args.capacity ?? null,
  p_position_x: args.positionX,
  p_position_y: args.positionY,
  p_shape: args.shape,
  p_active: args.active,
  p_shape_preset: args.shapePreset || 'standard',
});

const postPayment = (args) => rpc('mesa_post_payment_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_by_sid_hash: args.bySidHash,
  p_table_session_id: args.tableSessionId,
  p_payment_method: args.paymentMethod,
  p_mode: args.mode,
  p_client_request_id: args.clientRequestId,
  p_request_hash: args.requestHash,
  p_amount: args.amount ?? null,
  p_covers_settled: args.coversSettled ?? null,
  p_line_ids: Array.isArray(args.lineIds) ? args.lineIds : null,
  p_meta: args.meta || {},
});

const saveReservation = (args) => rpc('mesa_save_reservation_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_reservation_id: args.reservationId || null,
  p_table_id: args.tableId,
  p_guest_name: args.guestName,
  p_guest_phone: args.guestPhone || null,
  p_covers_total: args.coversTotal,
  p_reserved_local_date: args.reservedLocalDate,
  p_reserved_local_time: args.reservedLocalTime,
  p_note: args.note || null,
  p_expected_version: args.expectedVersion ?? null,
});

const setReservationStatus = (args) => rpc('mesa_set_reservation_status_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_reservation_id: args.reservationId,
  p_expected_version: args.expectedVersion,
  p_status: args.status,
});

const openReservation = (args) => rpc('mesa_open_reservation_v1', {
  p_workspace_id: args.workspaceId,
  p_by_actor: args.byActor,
  p_reservation_id: args.reservationId,
  p_expected_version: args.expectedVersion,
  p_service_session_id: args.serviceSessionId,
});

module.exports = {
  listFloorRows,
  getSession,
  getOrderForSession,
  openSession,
  releaseEmptySession,
  saveTable,
  postPayment,
  saveReservation,
  setReservationStatus,
  openReservation,
};
