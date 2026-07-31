'use strict';
// Access Control V3 -- Block V3-G: normalized semantic request hash for
// assignTableSessionWaiter idempotency (FOUNDATION ONLY, UNWIRED). Pure crypto, no env,
// no I/O, no DB, no secret material.
//
// Same discipline as every other *RequestHash.js module: bind the idempotency key to
// WHAT was requested -- target table-session identity, expected assignment snapshot,
// requested waiter identity -- never token/proof/cookies/raw sid/any transient auth
// material, and never any customer/order payload (none of which this RPC ever touches).

const crypto = require('crypto');

function sha256Hex(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

// computeAssignTableSessionWaiterRequestHash({tableSessionId, expectedAssignedWaiterActor, requestedWaiterActor}) -> hex | null
// expectedAssignedWaiterActor/requestedWaiterActor may be null (explicit "unassigned").
function computeAssignTableSessionWaiterRequestHash({
  tableSessionId, expectedAssignedWaiterActor = null, requestedWaiterActor = null,
} = {}) {
  if (typeof tableSessionId !== 'string' || tableSessionId.length === 0) return null;
  if (expectedAssignedWaiterActor !== null && (typeof expectedAssignedWaiterActor !== 'string' || expectedAssignedWaiterActor.length === 0)) return null;
  if (requestedWaiterActor !== null && (typeof requestedWaiterActor !== 'string' || requestedWaiterActor.length === 0)) return null;
  return sha256Hex({
    table_session_id: tableSessionId,
    expected_assigned_waiter_actor: expectedAssignedWaiterActor,
    requested_waiter_actor: requestedWaiterActor,
  });
}

module.exports = { computeAssignTableSessionWaiterRequestHash };
