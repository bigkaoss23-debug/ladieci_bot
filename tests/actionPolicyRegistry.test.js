'use strict';
// Test per src/auth/actionPolicyRegistry.js + capabilityRegistry.js — Access Control V3
// Block V3-A (FOUNDATION, UNWIRED). Eseguire: node tests/actionPolicyRegistry.test.js
// Pure/offline: no env, no I/O, no DB. Does NOT assert anything about live runtime
// authorization — legacyActionRoles.js is untouched and still governs every real request.

const { ALL_ACTIONS } = require('../src/auth/legacyActionRoles');
const { ACTION_POLICY_REGISTRY, getActionPolicy, rolesFor, isKnownAction } = require('../src/auth/actionPolicyRegistry');
const { CAPABILITIES, CAPABILITY_SET, ROLE_CAPABILITIES, isValidCapability } = require('../src/auth/capabilityRegistry');
const { ROLE_CODES } = require('../src/auth/roleRegistry');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

// ══ completeness — the whole point of this registry existing ═════════════════
const registryActions = ACTION_POLICY_REGISTRY.map((e) => e.action);
assert('every action has exactly one ACTION_POLICY_REGISTRY entry (no duplicates)',
  new Set(registryActions).size === registryActions.length, `count=${registryActions.length} unique=${new Set(registryActions).size}`);

const missingFromRegistry = ALL_ACTIONS.filter((a) => !registryActions.includes(a));
const extraInRegistry = registryActions.filter((a) => !ALL_ACTIONS.includes(a));
assert('every legacyActionRoles.ALL_ACTIONS action is represented in ACTION_POLICY_REGISTRY',
  missingFromRegistry.length === 0, `missing: ${JSON.stringify(missingFromRegistry)}`);
assert('ACTION_POLICY_REGISTRY has no entries for actions the live dispatcher does not have',
  extraInRegistry.length === 0, `extra: ${JSON.stringify(extraInRegistry)}`);
assert('ACTION_POLICY_REGISTRY covers exactly the live 65-action set', ALL_ACTIONS.length === registryActions.length,
  `live=${ALL_ACTIONS.length} registry=${registryActions.length}`);

// ── system actions represented separately ─────────────────────────────────────
const systemActions = ACTION_POLICY_REGISTRY.filter((e) => e.isSystemAction === true);
assert('exactly one system action (triggerCloseIfNeeded)', systemActions.length === 1 && systemActions[0].action === 'triggerCloseIfNeeded');
assert('the system action carries no human capability', systemActions[0].acceptedCapabilities.length === 0);
assert('rolesFor(triggerCloseIfNeeded) resolves to no human role', rolesFor('triggerCloseIfNeeded').length === 0);
assert('every non-system entry declares at least one accepted capability',
  ACTION_POLICY_REGISTRY.filter((e) => !e.isSystemAction).every((e) => Array.isArray(e.acceptedCapabilities) && e.acceptedCapabilities.length > 0));

// ── unknown action denied ─────────────────────────────────────────────────────
assert('unknown action -> no policy entry', getActionPolicy('totallyBogusAction') === null);
assert('unknown action -> isKnownAction false', isKnownAction('totallyBogusAction') === false);
assert('unknown action -> rolesFor is empty (deny-by-default)', rolesFor('totallyBogusAction').length === 0);

// ── every accepted capability is a real, declared capability ─────────────────
let allCapsValid = true;
for (const entry of ACTION_POLICY_REGISTRY) {
  for (const cap of entry.acceptedCapabilities) {
    if (!isValidCapability(cap)) { allCapsValid = false; console.log(`    bad capability "${cap}" on action "${entry.action}"`); }
  }
}
assert('every acceptedCapabilities entry references a real CAPABILITIES value', allCapsValid);

// ── shared actions may serve multiple features / multiple roles ──────────────
assert('getOrdenes is shared by multiple roles (not a single-role action)', rolesFor('getOrdenes').length > 1);
assert('getMenu is shared by every role (universal minimal read)', ROLE_CODES.every((r) => rolesFor('getMenu').includes(r)));

// ══ explicit freezes from this review round ═══════════════════════════════════
assert('backupSerata is NOT granted to cashier', !rolesFor('backupSerata').includes('cashier'));
assert('backupSerata IS granted to owner', rolesFor('backupSerata').includes('owner'));
assert('eliminaOrdine is NOT granted to cashier', !rolesFor('eliminaOrdine').includes('cashier'));
assert('eliminaOrdine IS granted to owner', rolesFor('eliminaOrdine').includes('owner'));
assert('eliminaOrdine is NOT granted to legacy_operator either (universal tightening — irreversible action)', !rolesFor('eliminaOrdine').includes('legacy_operator'));
assert('backupSerata IS still granted to legacy_operator (matches today\'s live behavior, not a new risk)', rolesFor('backupSerata').includes('legacy_operator'));
assert('triggerCloseIfNeeded has no human role at all', rolesFor('triggerCloseIfNeeded').length === 0);

// ── source-verified corrections from this round ───────────────────────────────
assert('marcarLlegado maps to orders.general (pickup flag, not delivery)', getActionPolicy('marcarLlegado').acceptedCapabilities.includes('orders.general'));
assert('marcarLlegado is NOT granted to rider', !rolesFor('marcarLlegado').includes('rider'));
assert('setUiOffset maps to orders.general (cosmetic)', getActionPolicy('setUiOffset').acceptedCapabilities.includes('orders.general'));
assert('updateNotaCucina is granted to cashier, kitchen and owner', ['owner', 'cashier', 'kitchen'].every((r) => rolesFor('updateNotaCucina').includes(r)));
assert('scanServizio is granted to owner and cashier (read-only)', rolesFor('scanServizio').includes('owner') && rolesFor('scanServizio').includes('cashier'));
assert('scanServizio is NOT granted to waiter/kitchen/rider', !['waiter', 'kitchen', 'rider'].some((r) => rolesFor('scanServizio').includes(r)));

// ══ capability registry itself ════════════════════════════════════════════════
assert('CAPABILITIES has no duplicate keys', new Set(CAPABILITIES).size === CAPABILITIES.length);
assert('CAPABILITY_SET matches CAPABILITIES', CAPABILITIES.every((c) => CAPABILITY_SET.has(c)) && CAPABILITY_SET.size === CAPABILITIES.length);
assert('every role code has a ROLE_CAPABILITIES entry (even if empty)', ROLE_CODES.every((r) => Array.isArray(ROLE_CAPABILITIES[r])));
assert('owner is not a wildcard — every owner capability is individually listed, no "*"', !ROLE_CAPABILITIES.owner.includes('*'));
assert('every capability granted to any role is a real declared capability', Object.values(ROLE_CAPABILITIES).every((caps) => caps.every((c) => isValidCapability(c))));

// deny-by-default: waiter/kitchen/rider must NOT have access/economy/settings/audit
for (const role of ['waiter', 'kitchen', 'rider']) {
  for (const forbidden of ['access.management', 'economy.view', 'settings.structural', 'audit.view']) {
    assert(`${role} does NOT have ${forbidden} (deny-by-default)`, !ROLE_CAPABILITIES[role].includes(forbidden));
  }
}
// shift_manager: no full economy, no access management, mutations default-denied
assert('shift_manager has no access.management', !ROLE_CAPABILITIES.shift_manager.includes('access.management'));
assert('shift_manager has no economy.view', !ROLE_CAPABILITIES.shift_manager.includes('economy.view'));
assert('shift_manager has no service.session.open_close (opt-in, default off)', !ROLE_CAPABILITIES.shift_manager.includes('service.session.open_close'));
assert('shift_manager has no ops.correction.explicit (empty until named)', !ROLE_CAPABILITIES.shift_manager.includes('ops.correction.explicit'));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
