'use strict';
// Access Control V3 — Block V3-A: capability registry (FOUNDATION ONLY, UNWIRED).
//
// Pure data, no env, no I/O, no logging. Declares the closed, deny-by-default
// capability vocabulary and the role -> granted-capabilities matrix frozen across the
// V3 design reviews. This module does NOT replace src/auth/legacyActionRoles.js during
// V3-A — the live guard is untouched. Nothing not listed under a role is granted to it;
// there is no wildcard/"owner=*" shortcut, matching the house style already used in
// src/auth/authorizationContract.js's explicit per-action allow lists.

const CAPABILITIES = Object.freeze([
  // access management
  'access.management',
  // economy
  'economy.view',
  // settings
  'settings.structural',
  // audit
  'audit.view',
  'audit.resolve',
  // orders
  'orders.general',
  'orders.general.delete',
  'orders.table.create',
  'orders.table.update.assigned',
  'orders.table.update.general',
  // tables (waiter assignment — V3-G, listed here as foundation vocabulary only)
  'tables.assign',
  // kitchen
  'kitchen.read_operational',
  'kitchen.read_board',
  'kitchen.status.transition',
  'kitchen.delay.manage',
  'kitchen.notes.update',
  'kitchen.ticket.send',
  // delivery
  'delivery.read_operational',
  'delivery.read_assigned',
  'delivery.dispatch',
  'delivery.trip.operate',
  'delivery.collection',
  // payments / billing
  'payments.standard.process',
  'payments.refund',
  'billing.table.request',
  'billing.table.close',
  // service session
  'service.session.open_close',
  'service.session.read',
  'service.session.backup',
  'service.overview.view',
  'ops.correction.explicit',
  // shared minimal read
  'menu.read',
]);
const CAPABILITY_SET = Object.freeze(new Set(CAPABILITIES));

// role code -> granted capabilities. Every entry enumerated explicitly, including
// 'owner' — a union, never a wildcard, so a new capability added later requires an
// explicit decision per role (the same principle the feature/action registries below
// depend on for their completeness tests).
const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze([
    'access.management', 'economy.view', 'settings.structural', 'audit.view', 'audit.resolve',
    'orders.general', 'orders.general.delete', 'orders.table.create',
    'orders.table.update.assigned', 'orders.table.update.general', 'tables.assign',
    'kitchen.read_operational', 'kitchen.read_board', 'kitchen.status.transition',
    'kitchen.delay.manage', 'kitchen.notes.update',
    'delivery.read_operational', 'delivery.read_assigned', 'delivery.dispatch',
    'delivery.trip.operate', 'delivery.collection',
    'payments.standard.process', 'payments.refund', 'billing.table.request', 'billing.table.close',
    'service.session.open_close', 'service.session.read', 'service.session.backup',
    'service.overview.view', 'ops.correction.explicit', 'menu.read',
  ]),
  cashier: Object.freeze([
    // 'orders.general.delete' and 'service.session.backup' are DELIBERATELY absent —
    // both frozen this review round: eliminaOrdine stays owner-only while it performs a
    // physical delete (no hard-delete capability for Caja at all); backupSerata stays
    // system/owner-only until a response contract proven safe for Caja exists.
    'orders.general', 'orders.table.create',
    'orders.table.update.general', 'kitchen.ticket.send', 'kitchen.read_operational',
    'kitchen.notes.update', 'delivery.read_operational', 'delivery.dispatch',
    'payments.standard.process', 'billing.table.request', 'billing.table.close',
    'service.session.open_close', 'service.session.read',
    'menu.read',
  ]),
  waiter: Object.freeze([
    'orders.table.create', 'orders.table.update.assigned', 'kitchen.ticket.send',
    'billing.table.request', 'menu.read',
  ]),
  kitchen: Object.freeze([
    'kitchen.read_board', 'kitchen.status.transition', 'kitchen.delay.manage',
    'kitchen.notes.update', 'menu.read',
  ]),
  rider: Object.freeze([
    'delivery.read_assigned', 'delivery.trip.operate', 'delivery.collection', 'menu.read',
  ]),
  shift_manager: Object.freeze([
    'kitchen.read_operational', 'delivery.read_operational', 'service.overview.view', 'menu.read',
    // service.session.open_close and ops.correction.explicit are DELIBERATELY absent —
    // both default-denied per the frozen design (opt-in-off / empty-until-named).
  ]),
  legacy_operator: Object.freeze([
    // Exactly today's pre-V3 operator allow-list, with TWO deliberate exceptions, both
    // withheld universally (not label-specific) even from the transitional role:
    // 'orders.general.delete' — the eliminaOrdine freeze ("owner only while it performs
    // physical deletion") is a risk-reduction decision about an irreversible action.
    // 'service.session.backup' — backupSerata is a financial/order snapshot; that legacy
    // operators could historically invoke it is not a reason to preserve that privilege
    // under V3. Corrected per explicit instruction: a capability is not grandfathered in
    // just because a predecessor role happened to have it. This registry is unwired in
    // V3-A (no live behavior changes today), so this is a considered choice for whoever
    // wires it in later, not a change anyone experiences right now.
    'orders.general', 'orders.table.create',
    'orders.table.update.general', 'kitchen.read_operational', 'kitchen.notes.update',
    'delivery.read_operational', 'delivery.dispatch',
    'payments.standard.process', 'billing.table.request', 'billing.table.close',
    'service.session.open_close', 'service.session.read', 'menu.read',
  ]),
});

function isValidCapability(cap) { return typeof cap === 'string' && CAPABILITY_SET.has(cap); }
function capabilitiesFor(roleCode) { return ROLE_CAPABILITIES[roleCode] || Object.freeze([]); }
function roleHasCapability(roleCode, cap) { return capabilitiesFor(roleCode).includes(cap); }

module.exports = {
  CAPABILITIES, CAPABILITY_SET, ROLE_CAPABILITIES,
  isValidCapability, capabilitiesFor, roleHasCapability,
};
