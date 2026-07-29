'use strict';
// Access Control V3 — Block V3-A: action policy registry (FOUNDATION ONLY, UNWIRED).
//
// Pure data, no env, no I/O, no logging. One entry per action currently dispatched by
// index.js (per src/auth/legacyActionRoles.ALL_ACTIONS, the LIVE-ENFORCED set — not
// src/auth/authorizationContract.js's older, unwired "B4" classification, which has
// drifted from what actually shipped on a few actions; see notes below on each).
//
// During V3-A the live guard keeps using legacyActionRoles.js UNCHANGED — nothing here
// is consulted by any request path yet. This registry exists so the eventual cutover
// (V3-D onward) has a complete, source-verified starting point, and so a completeness
// test can fail loudly the day a new action is added to the dispatcher without an
// entry here.
//
// acceptedCapabilities: ANY ONE of these, granted via capabilityRegistry.ROLE_CAPABILITIES,
// is sufficient to call the action. rolesFor() below derives the actual role list from
// that, so the two never drift independently.
//
// isSystemAction: true marks the ONE action whose caller is not a human staff member at
// all (see below) — authorized by the existing X-Api-Key infrastructure layer, outside
// the six-role capability model entirely, not force-fit into one of the six roles.

const { capabilitiesFor, roleHasCapability } = require('./capabilityRegistry');
const { ROLE_CODES } = require('./roleRegistry');

// Discrepancy note, applies to a small number of entries below: src/auth/
// authorizationContract.js (an earlier, unwired "B4" draft) classifies some of these
// differently than what legacyActionRoles.js actually enforces live today — e.g. it
// treats `marcarLlegado` and `updateEstado` as rider-enabled (with a
// RIDER_MARK_LLEGADO_SCOPE / RIDER_UPDATE_ESTADO_SCOPE predicate) and treats
// `getClientes`/`eliminaOrdine`/`eliminaConversazione` as admin-only. legacyActionRoles.js
// (the LIVE guard) disagrees on all of these. This registry follows LIVE behavior plus
// direct source verification of the handler (index.js), not the older draft, except
// where this review round explicitly freezes a stricter policy (eliminaOrdine,
// backupSerata) than what is live today.
const ACTION_POLICY_REGISTRY = Object.freeze([
  // ── shared reads ──────────────────────────────────────────────────────────
  { action: 'getOrdenes', acceptedCapabilities: ['orders.general', 'orders.table.update.assigned', 'kitchen.read_board', 'kitchen.read_operational', 'delivery.read_assigned', 'delivery.read_operational', 'service.overview.view'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },
  { action: 'getMenu', acceptedCapabilities: ['menu.read'], legacyStatus: 'shared', v3Phase: 'V3-A' },
  { action: 'getManualGiros', acceptedCapabilities: ['delivery.read_operational', 'delivery.read_assigned'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },
  { action: 'getDriverStatus', acceptedCapabilities: ['delivery.read_operational', 'delivery.read_assigned'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },

  // ── orders / WA intake (cashier domain) ──────────────────────────────────
  { action: 'getWaMsgs', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getConvThread', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'generaRispostaIA', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getClientes', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'B4 draft classifies admin-only; legacyActionRoles.js (live) does not — followed live.' },
  { action: 'getOrdenesRecent', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getWaMessages', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getConversacionesActivas', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getClienteByTelefono', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getWaMessageById', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getOrdenById', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getConvByWaId', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getConvChats', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'cambiaStato', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'creaOrdine', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'modificaOrdine', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'aggiornaRispostaBot', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'rispondiWA', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'updateWaStato', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'updateOrden', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'updateEstado', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'B4 draft classifies rider-enabled with a scope predicate; legacyActionRoles.js (live) does not grant rider — followed live.' },
  { action: 'marcarLlegado', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'Source-verified (index.js:707-710): pickup/RITIRO arrival flag, not delivery. B4 draft classifies rider-enabled — followed live + source instead.' },
  { action: 'setUiOffset', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'Source-verified (index.js:711-716): cosmetic DOMICILIO countdown snooze only, explicitly excluded from the historical archive by its own comment.' },
  { action: 'resolveAddress', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'previewOrderTiming', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'createOrden', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'upsertCliente', acceptedCapabilities: ['orders.general'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'eliminaConversazione', acceptedCapabilities: ['orders.general.delete'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'B4 draft classifies admin-only; legacyActionRoles.js (live) grants operator too — followed live, NOT tightened (only eliminaOrdine was explicitly frozen stricter this round).' },

  // ── destructive / frozen this round ───────────────────────────────────────
  { action: 'eliminaOrdine', acceptedCapabilities: ['orders.general.delete'], legacyStatus: 'operator_shared_TIGHTENED', v3Phase: 'V3-A', note: 'FROZEN: owner only while it performs physical deletion (source-verified: routes through riderTrip.deleteOrder, a transactional hard-delete guard). Cashier gets no hard-delete capability under V3 — a future soft/reasoned/audited cashier cancellation is a separate, later capability, not this one.' },

  // ── kitchen ────────────────────────────────────────────────────────────────
  { action: 'updateNotaCucina', acceptedCapabilities: ['kitchen.notes.update'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'Source-verified (index.js:735-737): free-text prep note, writable by whoever takes the order (cashier) and amendable by kitchen during prep.' },

  // ── delivery / dispatch ───────────────────────────────────────────────────
  { action: 'marcarEnEntrega', acceptedCapabilities: ['delivery.trip.operate'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },
  { action: 'marcarEntregado', acceptedCapabilities: ['delivery.trip.operate'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },
  { action: 'registrarSalidaDriver', acceptedCapabilities: ['delivery.trip.operate'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },
  { action: 'chiudiGiro', acceptedCapabilities: ['delivery.trip.operate'], legacyStatus: 'rider_allowed', v3Phase: 'V3-A' },
  { action: 'asignarRepartidor', acceptedCapabilities: ['delivery.dispatch'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'createManualGiro', acceptedCapabilities: ['delivery.dispatch'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'addOrderToManualGiro', acceptedCapabilities: ['delivery.dispatch'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'removeOrderFromManualGiro', acceptedCapabilities: ['delivery.dispatch'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'dissolveManualGiro', acceptedCapabilities: ['delivery.dispatch'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'shadowPreview', acceptedCapabilities: ['delivery.read_operational'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },

  // ── service session ────────────────────────────────────────────────────────
  { action: 'chiudiServizio', acceptedCapabilities: ['service.session.open_close'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'openServiceSession', acceptedCapabilities: ['service.session.open_close'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'ensureCurrentServiceSession', acceptedCapabilities: ['service.session.open_close'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'getCurrentServiceCloseout', acceptedCapabilities: ['service.session.read'], legacyStatus: 'operator_shared', v3Phase: 'V3-A' },
  { action: 'scanServizio', acceptedCapabilities: ['service.session.read'], legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'Source-verified (servizio.js:112-138): read-only by its own comment, no writes.' },
  { action: 'backupSerata', acceptedCapabilities: ['service.session.backup'], legacyStatus: 'operator_shared_TIGHTENED', v3Phase: 'V3-A', note: 'FROZEN: owner only — not cashier, not legacy_operator either, even though legacy_operator historically had this access live. That it was historically available is not a reason to preserve the privilege under V3 (source-verified, servizio.js:143-180: writes a full-day revenue+order snapshot). No system-automation identity is represented for this action in V3-A — none exists in the current architecture (unlike triggerCloseIfNeeded, this is still human-triggered, gated only by a time-of-day check); if one is ever added it must be its own explicit capability, never implied by any human role.' },

  // ── admin-only today (owner-only under V3) ────────────────────────────────
  { action: 'getConfig', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'setConfig', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'getStorico', acceptedCapabilities: ['economy.view'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'getOrdenesArchivio', acceptedCapabilities: ['economy.view'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'getEconomiaLedger', acceptedCapabilities: ['economy.view'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'getDeliveryLogs', acceptedCapabilities: ['economy.view'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'getSuggerimenti', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'rigeneraSuggerimenti', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'approvaSuggerimento', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'debugInterpreta', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'debugMenuShadow', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'parseOrdineDaRisposta', acceptedCapabilities: ['settings.structural'], legacyStatus: 'admin_only', v3Phase: 'V3-A' },
  { action: 'getAuthActors', acceptedCapabilities: ['access.management'], legacyStatus: 'admin_only', v3Phase: 'V3-A', note: 'Superseded by listAccessUsers/getAccessUser at V3-D; kept as the current runtime action.' },
  { action: 'setActorPin', acceptedCapabilities: ['access.management'], legacyStatus: 'admin_only', v3Phase: 'V3-A', note: 'Superseded by setAccessUserPin at V3-D.' },
  { action: 'verifyOwnPin', acceptedCapabilities: ['access.management'], legacyStatus: 'admin_only', v3Phase: 'V3-A', note: 'Step-up proof mint, unchanged mechanism.' },

  // ── system automation — not a human role ──────────────────────────────────
  { action: 'triggerCloseIfNeeded', acceptedCapabilities: [], isSystemAction: true, legacyStatus: 'operator_shared', v3Phase: 'V3-A', note: 'Called by an external cron service, not by any human staff member. Does not map to the six-role model — authorized by the existing X-Api-Key infrastructure layer, orthogonal to the six human roles, never force-fit into one. B4 draft already independently classifies this as SERVICE_ONLY / human-denied, corroborating this finding.' },
]);

const ACTION_POLICY_SET = Object.freeze(new Set(ACTION_POLICY_REGISTRY.map((e) => e.action)));

function getActionPolicy(action) {
  return ACTION_POLICY_REGISTRY.find((e) => e.action === action) || null;
}

// Derives the actual role list for an action from capabilityRegistry — the two never
// drift independently, since this is computed, not hand-maintained twice.
function rolesFor(action) {
  const policy = getActionPolicy(action);
  if (!policy || policy.isSystemAction) return Object.freeze([]);
  return Object.freeze(
    ROLE_CODES.filter((role) =>
      policy.acceptedCapabilities.some((cap) => roleHasCapability(role, cap))
    )
  );
}

function isKnownAction(action) { return typeof action === 'string' && ACTION_POLICY_SET.has(action); }

module.exports = {
  ACTION_POLICY_REGISTRY, ACTION_POLICY_SET,
  getActionPolicy, rolesFor, isKnownAction,
};
