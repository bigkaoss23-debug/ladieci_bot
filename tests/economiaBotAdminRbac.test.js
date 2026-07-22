'use strict';
const { authorizeLegacyRequest, legacyAuthGuardMiddleware } = require('../src/auth/legacyAuthGuard');
const roles = require('../src/auth/legacyActionRoles');

const ACTIONS = [
  'getConfig', 'getStorico', 'getOrdenesArchivio', 'getDeliveryLogs',
  'getSuggerimenti', 'rigeneraSuggerimenti', 'approvaSuggerimento', 'setConfig',
];
let pass = 0;
function check(label, condition) {
  if (!condition) throw new Error(label);
  pass++;
}
function req(action, role) {
  return { method: 'GET', query: { action }, body: {}, headers: { authorization: `Bearer ${role}` } };
}
const deps = {
  verifyToken: token => ({ sub: token === 'admin' ? 'owner' : token === 'operator' ? 'operator_primary' : 'rider', role: token, sv: 7 }),
  getActor: actor => ({ actor, active: true, session_version: 7 }),
};

(async () => {
  for (const action of ACTIONS) {
    check(`${action}: admin-only classification`, roles.ADMIN_ONLY.includes(action));
    check(`${action}: admin allowed`, (await authorizeLegacyRequest(req(action, 'admin'), deps)).ok === true);
    check(`${action}: operator 403 before handler`, (await authorizeLegacyRequest(req(action, 'operator'), deps)).status === 403);
    check(`${action}: rider 403 before handler`, (await authorizeLegacyRequest(req(action, 'rider'), deps)).status === 403);
  }
  check('every admin action requires fresh actor lookup', roles.ADMIN_ONLY.every(a => roles.getActionRule(a).fresh === true));
  let handlerCalls = 0;
  const response = { statusCode: 0, body: null, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
  await legacyAuthGuardMiddleware(deps)(req('getStorico', 'operator'), response, () => { handlerCalls++; });
  check('operator 403 does not execute downstream handler', response.statusCode === 403 && handlerCalls === 0);
  console.log(`economiaBotAdminRbac: ${pass} passed`);
})().catch(e => { console.error(e.message); process.exit(1); });
