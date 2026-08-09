'use strict';
// SERVICE LIFECYCLE V3 / Slice 3.3 — pure classification/policy contract for
// src/serviceSessions/v3IncidentPolicy.js. No DB, no engine — classifyForV3Close
// is a pure function of already-read rows, so these tests call it directly.
// Engine-level integration (persistence order, idempotency, safe-action
// success/failure) is covered separately in
// tests/serviceLifecycleV3IncidentPolicyEngine.test.js.

const {
  INCIDENT_POLICY,
  policyFor,
  classifyForV3Close,
  UNPAID_BALANCE_INCIDENT_TYPE,
  EMPTY_TABLE_INCIDENT_TYPE,
  GENERIC_UNRESOLVED_ORDER_STATE_INCIDENT_TYPE,
} = require('../src/serviceSessions/v3IncidentPolicy');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const order = (o = {}) => ({ id: '#1', estado: 'RETIRADO', ...o });
const table = (o = {}) => ({ id: 'ts-1', status: 'open', covers_total: null, workspace_id: 'ws-1', ...o });
const ticket = (o = {}) => ({ id: '#1', unpaidAmount: 0, cancelled: false, ...o });

console.log('\n== v3IncidentPolicy.js — classification/policy authority ==\n');

console.log('\n── INCIDENT_POLICY shape — category/severity/blocking independent, every V3.3 type non-blocking ──');
{
  const types = Object.keys(INCIDENT_POLICY);
  assert('every policy entry has category/severity/blocking', types.every((t) => {
    const p = INCIDENT_POLICY[t];
    return typeof p.category === 'string' && typeof p.severity === 'string' && typeof p.blocking === 'boolean';
  }));
  assert('every V3.3 incident type is non-blocking by design', types.every((t) => INCIDENT_POLICY[t].blocking === false));
  assert('UNPAID_BALANCE_AT_CLOSE is category=financial', INCIDENT_POLICY[UNPAID_BALANCE_INCIDENT_TYPE].category === 'financial');
  assert('EMPTY_TABLE_LEFT_OPEN is category=informational', INCIDENT_POLICY[EMPTY_TABLE_INCIDENT_TYPE].category === 'informational');
  assert('policyFor() throws (fail-closed) for an unknown incident type', (() => {
    try { policyFor('NOT_A_REAL_TYPE'); return false; } catch (e) { return /no policy entry/.test(e.message); }
  })());
}

console.log('\n── Test J — occupied table (covers_total set) is never an incident ──');
{
  const result = classifyForV3Close({ orders: [], tableSessions: [table({ covers_total: 2 })], tickets: [] });
  assert('J1: zero incidents', result.incidents.length === 0, JSON.stringify(result.incidents));
  assert('J2: zero safe auto-actions', result.safeAutoActions.length === 0);
  assert('J3: emptyTablesLeftOpen is 0', result.emptyTablesLeftOpen === 0);
}

console.log('\n── Empty table (covers_total NULL) — informational incident + matching safe action ──');
{
  const t = table({ id: 'ts-empty', covers_total: null, workspace_id: 'ws-9' });
  const result = classifyForV3Close({ orders: [], tableSessions: [t], tickets: [] });
  assert('1 incident', result.incidents.length === 1, JSON.stringify(result.incidents));
  const inc = result.incidents[0];
  assert('incidentType EMPTY_TABLE_LEFT_OPEN', inc.incidentType === EMPTY_TABLE_INCIDENT_TYPE);
  assert('category informational, severity info, non-blocking', inc.category === 'informational' && inc.severity === 'info' && inc.blocking === false);
  assert('entityType/entityId match the table session', inc.entityType === 'table_session' && inc.entityId === 'ts-empty');
  assert('1 safe auto-action RELEASE_EMPTY_TABLE, tied to the same entity', result.safeAutoActions.length === 1
    && result.safeAutoActions[0].type === 'RELEASE_EMPTY_TABLE'
    && result.safeAutoActions[0].tableSessionId === 'ts-empty'
    && result.safeAutoActions[0].workspaceId === 'ws-9'
    && result.safeAutoActions[0].incidentEntityType === 'table_session'
    && result.safeAutoActions[0].incidentEntityId === 'ts-empty');
  assert('emptyTablesLeftOpen is 1', result.emptyTablesLeftOpen === 1);
}

console.log('\n── A closed table session is never an incident, regardless of covers_total ──');
{
  const result = classifyForV3Close({ orders: [], tableSessions: [table({ status: 'closed', covers_total: null })], tickets: [] });
  assert('zero incidents for a closed table', result.incidents.length === 0);
}

console.log('\n── Financial — unpaid ticket becomes UNPAID_BALANCE_AT_CLOSE with exact cents ──');
{
  const result = classifyForV3Close({ orders: [], tableSessions: [], tickets: [ticket({ id: '#7', unpaidAmount: 13.5 })] });
  assert('1 incident', result.incidents.length === 1, JSON.stringify(result.incidents));
  const inc = result.incidents[0];
  assert('incidentType UNPAID_BALANCE_AT_CLOSE', inc.incidentType === UNPAID_BALANCE_INCIDENT_TYPE);
  assert('category financial, severity warning, non-blocking', inc.category === 'financial' && inc.severity === 'warning' && inc.blocking === false);
  assert('financialExposureCents is 1350 (13.50 euros)', inc.financialExposureCents === 1350, String(inc.financialExposureCents));
  assert('entityType order, entityId/orderId the ticket id', inc.entityType === 'order' && inc.entityId === '#7' && inc.orderId === '#7');
}

console.log('\n── Test C shape — three unpaid tickets, exact per-incident cents, no aggregate double-computed here ──');
{
  const tickets = [
    ticket({ id: '#a', unpaidAmount: 16.0 }),
    ticket({ id: '#b', unpaidAmount: 13.5 }),
    ticket({ id: '#c', unpaidAmount: 28.0 }),
  ];
  const result = classifyForV3Close({ orders: [], tableSessions: [], tickets });
  assert('3 financial incidents', result.incidents.length === 3, JSON.stringify(result.incidents));
  const cents = result.incidents.map((i) => i.financialExposureCents).sort((a, b) => a - b);
  assert('per-incident cents are exactly [1350,1600,2800]', JSON.stringify(cents) === JSON.stringify([1350, 1600, 2800]), JSON.stringify(cents));
  assert('sum is 5750 — the ENGINE computes this aggregate independently from the same ledger truth, not summed here', cents.reduce((s, c) => s + c, 0) === 5750);
  assert('no aggregate unpaid total is returned by the classifier itself', result.unpaidExposureCents === undefined);
}

console.log('\n── A cancelled ticket with a nonzero unpaidAmount is never an incident ──');
{
  const result = classifyForV3Close({ orders: [], tableSessions: [], tickets: [ticket({ unpaidAmount: 50, cancelled: true })] });
  assert('zero incidents', result.incidents.length === 0);
}

console.log('\n── A fully-paid ticket (unpaidAmount 0) is never an incident ──');
{
  const result = classifyForV3Close({ orders: [], tableSessions: [], tickets: [ticket({ unpaidAmount: 0 })] });
  assert('zero incidents', result.incidents.length === 0);
}

console.log('\n── Test E — Cocina (EN_COCINA) ──');
{
  const result = classifyForV3Close({ orders: [order({ id: '#k', estado: 'EN_COCINA' })], tableSessions: [], tickets: [] });
  assert('1 incident', result.incidents.length === 1);
  const inc = result.incidents[0];
  assert('incidentType KITCHEN_WORK_PENDING_AT_CLOSE', inc.incidentType === 'KITCHEN_WORK_PENDING_AT_CLOSE');
  assert('category operational, severity warning, non-blocking', inc.category === 'operational' && inc.severity === 'warning' && inc.blocking === false);
  assert('kitchenPendingCount is 1, listo/delivery are 0', result.kitchenPendingCount === 1 && result.listoCount === 0 && result.deliveryPendingCount === 0);
  assert('nonTerminalCount is 1', result.nonTerminalCount === 1);
}

console.log('\n── Test F — LISTO ──');
{
  const result = classifyForV3Close({ orders: [order({ id: '#l', estado: 'LISTO' })], tableSessions: [], tickets: [] });
  assert('1 incident', result.incidents.length === 1);
  const inc = result.incidents[0];
  assert('incidentType ORDER_READY_NOT_FINALIZED_AT_CLOSE', inc.incidentType === 'ORDER_READY_NOT_FINALIZED_AT_CLOSE');
  assert('category operational, severity warning, non-blocking', inc.category === 'operational' && inc.severity === 'warning' && inc.blocking === false);
  assert('listoCount is 1', result.listoCount === 1);
}

console.log('\n── Test G — rider/delivery (EN_ENTREGA) ──');
{
  const result = classifyForV3Close({ orders: [order({ id: '#d', estado: 'EN_ENTREGA' })], tableSessions: [], tickets: [] });
  assert('1 incident', result.incidents.length === 1);
  const inc = result.incidents[0];
  assert('incidentType DELIVERY_ACTIVE_AT_CLOSE', inc.incidentType === 'DELIVERY_ACTIVE_AT_CLOSE');
  assert('category operational, severity warning, non-blocking', inc.category === 'operational' && inc.severity === 'warning' && inc.blocking === false);
  assert('deliveryPendingCount is 1', result.deliveryPendingCount === 1);
  assert('the order descriptor never mutates/touches anything beyond entity identity (pure observability)', inc.orderId === '#d' && inc.entityId === '#d' && inc.entityType === 'order');
}

console.log('\n── POR_CONFIRMAR / NUEVO — ORDER_UNCONFIRMED_AT_CLOSE, info severity ──');
{
  for (const estado of ['POR_CONFIRMAR', 'NUEVO']) {
    const result = classifyForV3Close({ orders: [order({ estado })], tableSessions: [], tickets: [] });
    assert(`${estado} -> ORDER_UNCONFIRMED_AT_CLOSE, info`, result.incidents.length === 1
      && result.incidents[0].incidentType === 'ORDER_UNCONFIRMED_AT_CLOSE'
      && result.incidents[0].severity === 'info');
  }
}

console.log('\n── Test L (classifier level) — an unrecognized non-terminal estado is NEVER silently skipped ──');
{
  const result = classifyForV3Close({ orders: [order({ estado: 'SOME_FUTURE_STATE_NOT_YET_MAPPED' })], tableSessions: [], tickets: [] });
  assert('still produces exactly 1 incident, never silently dropped', result.incidents.length === 1, JSON.stringify(result.incidents));
  assert('falls back to the generic catch-all type', result.incidents[0].incidentType === GENERIC_UNRESOLVED_ORDER_STATE_INCIDENT_TYPE);
  assert('generic catch-all is operational/warning/non-blocking', result.incidents[0].category === 'operational' && result.incidents[0].severity === 'warning');
}

console.log('\n── Terminal orders (every terminal literal) never produce an incident ──');
{
  // language-guard: allow-legacy COMPLETATO is the existing terminal-state literal from v3IncidentPolicy.js's own TERMINAL_ORDER_STATES set, exercised here verbatim, not new vocabulary
  // language-guard: allow-legacy CHIUSO_FORZATO is the same existing terminal-state literal, exercised here for the same reason
  for (const estado of ['RETIRADO', 'COMPLETADO', 'COMPLETATO', 'CANCELADO', 'CANCELLED', 'ANULADO', 'CHIUSO_FORZATO']) {
    const result = classifyForV3Close({ orders: [order({ estado })], tableSessions: [], tickets: [] });
    assert(`${estado} -> zero incidents`, result.incidents.length === 0, JSON.stringify(result.incidents));
  }
  // Case-insensitive, matches the engine's own TERMINAL_ORDER_STATES.has(String(estado).toUpperCase()) discipline.
  const lower = classifyForV3Close({ orders: [order({ estado: 'retirado' })], tableSessions: [], tickets: [] });
  assert('lowercase terminal estado is still recognized (case-insensitive)', lower.incidents.length === 0);
}

console.log('\n── Multiple anomalies in one session combine independently (financial + operational + informational) ──');
{
  const result = classifyForV3Close({
    orders: [order({ id: '#k', estado: 'EN_COCINA' }), order({ id: '#l', estado: 'LISTO' })],
    tableSessions: [table({ id: 'ts-empty', covers_total: null }), table({ id: 'ts-occupied', covers_total: 4 })],
    tickets: [ticket({ id: '#u', unpaidAmount: 5 })],
  });
  assert('4 incidents total (2 operational + 1 financial + 1 informational)', result.incidents.length === 4, JSON.stringify(result.incidents));
  assert('exactly 1 safe auto-action (only for the empty table)', result.safeAutoActions.length === 1);
}

console.log('\n── Malformed/missing input arrays degrade to empty, never throw ──');
{
  const result = classifyForV3Close({});
  assert('empty incidents/actions, zero counts', result.incidents.length === 0 && result.safeAutoActions.length === 0
    && result.nonTerminalCount === 0 && result.kitchenPendingCount === 0 && result.listoCount === 0 && result.deliveryPendingCount === 0);
}

console.log('\n=== RESULT: ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail === 0 ? 0 : 1);
