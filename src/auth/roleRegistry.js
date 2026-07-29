'use strict';
// Access Control V3 — Block V3-A: role registry (FOUNDATION ONLY, UNWIRED).
//
// Pure data, no env, no I/O, no logging. Declares the seven role codes accepted in
// auth_actors.role after the V3-A migration widens the CHECK. This module makes NO
// runtime authorization decision — the live guard (src/auth/legacyActionRoles.js) is
// unchanged and unaffected by this file. Consumed later by the Gestión de accesos UI
// and by the V3-D/V3-C management APIs, not by anything in V3-A itself.
//
// 'legacy_operator' is a TRANSITIONAL-ONLY code: valid on pre-existing rows (from the
// V3-A migration), never assignable to a new user, retired once zero rows carry it
// (see the migration-complete precondition pattern used elsewhere in this repo).

const ROLES = Object.freeze([
  Object.freeze({
    code: 'owner',
    labelSingular: 'Propietario',
    labelPlural: null,               // exactly one per workspace — no plural form needed
    state: 'stable',
    assignableToNewUsers: false,     // never via createAccessUser — ownership is a separate flow
    visibleInAccessManagement: true, // under "MI ACCESO"
    surface: 'owner',
    pinPolicyRef: 'admin',           // pinPolicy.ROLE_PIN_RULES.admin (9-12 digits)
  }),
  Object.freeze({
    code: 'cashier',
    labelSingular: 'Caja',
    labelPlural: 'Caja',
    state: 'stable',
    assignableToNewUsers: true,
    visibleInAccessManagement: true,
    surface: 'cashier',
    pinPolicyRef: 'operator',        // 6-8 digits, shared by every non-owner role
  }),
  Object.freeze({
    code: 'waiter',
    labelSingular: 'Camarero',
    labelPlural: 'Camareros',
    state: 'beta',
    betaLabel: 'Beta · En desarrollo',
    assignableToNewUsers: true,
    visibleInAccessManagement: true,
    surface: 'waiter',
    pinPolicyRef: 'operator',
  }),
  Object.freeze({
    code: 'kitchen',
    labelSingular: 'Cocina',
    labelPlural: 'Cocina',
    state: 'stable',
    assignableToNewUsers: true,
    visibleInAccessManagement: true,
    surface: 'kitchen',
    pinPolicyRef: 'operator',
  }),
  Object.freeze({
    code: 'rider',
    labelSingular: 'Repartidor',
    labelPlural: 'Repartidores',
    state: 'stable',
    assignableToNewUsers: true,
    visibleInAccessManagement: true,
    surface: 'rider',
    pinPolicyRef: 'operator',
  }),
  Object.freeze({
    code: 'shift_manager',
    labelSingular: 'Responsable de turno',
    labelPlural: 'Responsables de turno',
    state: 'beta',
    betaLabel: 'Beta · En desarrollo',
    assignableToNewUsers: true,
    visibleInAccessManagement: true,
    surface: 'shift_manager',
    pinPolicyRef: 'operator',
  }),
  Object.freeze({
    code: 'legacy_operator',
    labelSingular: 'Operador (pendiente de asignar)',
    labelPlural: 'Pendiente de asignar',
    state: 'legacy',
    assignableToNewUsers: false,     // only ever present on pre-V3-A rows
    visibleInAccessManagement: true, // under its own "Pendiente de asignar" section
    surface: 'legacy',               // today's pre-V3, undifferentiated operator UI
    pinPolicyRef: 'operator',
  }),
]);

const ROLE_CODES = Object.freeze(ROLES.map((r) => r.code));
const ROLE_SET = Object.freeze(new Set(ROLE_CODES));
const ROLES_BY_CODE = Object.freeze(
  ROLES.reduce((acc, r) => { acc[r.code] = r; return acc; }, Object.create(null))
);

function isValidRoleCode(code) { return typeof code === 'string' && ROLE_SET.has(code); }
function getRole(code) { return isValidRoleCode(code) ? ROLES_BY_CODE[code] : null; }
function isAssignableToNewUsers(code) { const r = getRole(code); return !!(r && r.assignableToNewUsers); }
function isBeta(code) { const r = getRole(code); return !!(r && r.state === 'beta'); }

module.exports = {
  ROLES, ROLE_CODES, ROLE_SET, ROLES_BY_CODE,
  isValidRoleCode, getRole, isAssignableToNewUsers, isBeta,
};
