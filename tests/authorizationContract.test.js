'use strict';
// B4 — exhaustive authorization-contract tests. Run: node tests/authorizationContract.test.js
// No DB, no network, no wiring. The EXPECTED decisions below are transcribed
// INDEPENDENTLY from the owner's finalized B4 spec (not copied from the module),
// so a transcription typo in src/auth/authorizationContract.js diverges here.
const A = require('../src/auth/authorizationContract');
const { extractRouterActions, extractRouterActionsWithDuplicates, extractActionsFromSource } = require('./routerActionExtractor');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const setEq = (a, b) => { const A2 = new Set(a), B2 = new Set(b); return A2.size === B2.size && [...A2].every((x) => B2.has(x)); };

// ── Independent spec transcription (from owner message §7,§9,§6,§11,§12) ─────
const SPEC_ALL_56 = [
  'getOrdenes', 'getWaMsgs', 'getConfig', 'chiudiServizio', 'triggerCloseIfNeeded',
  'scanServizio', 'backupSerata', 'rigeneraSuggerimenti', 'approvaSuggerimento',
  'getConvThread', 'generaRispostaIA', 'getClientes', 'debugInterpreta', 'debugMenuShadow', 'getManualGiros', 'getMenu',
  'getDriverStatus', 'getOrdenesRecent', 'getWaMessages', 'getStorico', 'getOrdenesArchivio',
  'getDeliveryLogs', 'getSuggerimenti', 'getConversacionesActivas', 'getClienteByTelefono',
  'getWaMessageById', 'getOrdenById', 'getConvByWaId', 'getConvChats', 'cambiaStato',
  'creaOrdine', 'modificaOrdine', 'aggiornaRispostaBot', 'setConfig', 'rispondiWA',
  'updateWaStato', 'updateOrden', 'updateEstado', 'marcarEnEntrega', 'marcarEntregado',
  'asignarRepartidor', 'registrarSalidaDriver', 'chiudiGiro', 'marcarLlegado', 'setUiOffset',
  'resolveAddress', 'previewOrderTiming', 'createOrden', 'updateNotaCucina', 'eliminaOrdine',
  'eliminaConversazione', 'upsertCliente', 'parseOrdineDaRisposta', 'createManualGiro',
  'addOrderToManualGiro', 'removeOrderFromManualGiro', 'dissolveManualGiro',
];
const SPEC_SERVICE_ONLY = ['triggerCloseIfNeeded'];
const SPEC_ADMIN_ONLY = [
  'getConfig', 'rigeneraSuggerimenti', 'approvaSuggerimento', 'getClientes',
  'debugInterpreta', 'debugMenuShadow', 'getStorico', 'getOrdenesArchivio', 'getDeliveryLogs',
  'setConfig', 'eliminaOrdine', 'eliminaConversazione',
];
const SPEC_RIDER = [
  'getDriverStatus', 'updateEstado', 'marcarEnEntrega', 'marcarEntregado',
  'registrarSalidaDriver', 'chiudiGiro', 'marcarLlegado',
];
const SPEC_FRESH = [
  'getConfig', 'approvaSuggerimento', 'getClientes', 'getStorico',
  'getOrdenesArchivio', 'getDeliveryLogs', 'setConfig', 'eliminaOrdine', 'eliminaConversazione',
];
const SPEC_PREDICATES = {
  getDriverStatus: 'RIDER_OWN_DRIVER_STATUS',
  updateEstado: 'RIDER_UPDATE_ESTADO_SCOPE',
  marcarEnEntrega: 'RIDER_MARK_EN_ENTREGA_SCOPE',
  marcarEntregado: 'RIDER_MARK_ENTREGADO_SCOPE',
  registrarSalidaDriver: 'RIDER_REGISTER_SALIDA_SCOPE',
  chiudiGiro: 'RIDER_CLOSE_GIRO_SCOPE',
  marcarLlegado: 'RIDER_MARK_LLEGADO_SCOPE',
};

// Independent expected-allowed oracle from the spec rules (§7-§10).
function expectedAllowed(action) {
  if (SPEC_SERVICE_ONLY.includes(action)) return ['service'];
  const out = ['admin'];
  if (!SPEC_ADMIN_ONLY.includes(action)) out.push('operator');
  if (SPEC_RIDER.includes(action)) out.push('rider');
  return out;
}

// ── A. Principals ────────────────────────────────────────────────────────────
assert('A: PRINCIPALS = {admin,operator,rider,service}', setEq(A.PRINCIPALS, ['admin', 'operator', 'rider', 'service']));
for (const p of ['admin', 'operator', 'rider', 'service']) assert(`A: isKnownPrincipal(${p})`, A.isKnownPrincipal(p));
for (const p of ['owner', 'Admin', 'ADMIN', '', ' admin', 'operator ', null, undefined, 42, {}]) {
  assert(`A: isKnownPrincipal(${JSON.stringify(p)}) = false`, A.isKnownPrincipal(p) === false);
}

// ── B. Canonical set integrity + module↔spec transcription ──────────────────
assert('B: module CANONICAL_ACTIONS length 57', A.CANONICAL_ACTIONS.length === 57);
assert('B: module canonical set == spec 56 (independent transcription)', setEq(A.CANONICAL_ACTIONS, SPEC_ALL_56));
assert('B: no duplicate canonical action', new Set(A.CANONICAL_ACTIONS).size === A.CANONICAL_ACTIONS.length);
assert('B: module ADMIN_ONLY == spec (12)', setEq(A.ADMIN_ONLY_ACTIONS, SPEC_ADMIN_ONLY) && A.ADMIN_ONLY_ACTIONS.length === 12);
assert('B: module RIDER_ENABLED == spec (7)', setEq(A.RIDER_ENABLED_ACTIONS, SPEC_RIDER) && A.RIDER_ENABLED_ACTIONS.length === 7);
assert('B: module SERVICE_ONLY == spec (1)', setEq(A.SERVICE_ONLY_ACTIONS, SPEC_SERVICE_ONLY) && A.SERVICE_ONLY_ACTIONS.length === 1);

// ── C. Dynamic router equality + negative controls ──────────────────────────
const routerActions = extractRouterActions();
assert('C: extractor found 57 router actions (anti-no-op)', routerActions.length === 57, `found ${routerActions.length}`);
for (const anchor of ['getOrdenes', 'triggerCloseIfNeeded', 'dissolveManualGiro', 'cambiaStato']) {
  assert(`C: extractor anti-no-op anchor present: ${anchor}`, routerActions.includes(anchor));
}
const cov = A.assertContractCoversRouter(routerActions);
assert('C: router == matrix (no router-only, no matrix-only, no dup)', cov.ok, JSON.stringify(cov));
assert('C: no duplicate router action', extractRouterActionsWithDuplicates().length === 57);
// negative controls (synthetic sources / mutated sets)
assert('C-neg: fake router-only action fails equality',
  A.assertContractCoversRouter([...routerActions, 'totallyNewAction']).ok === false);
assert('C-neg: removing one route fails equality',
  A.assertContractCoversRouter(routerActions.filter((a) => a !== 'getOrdenes')).ok === false);
assert('C-neg: fake matrix-only detected as matrixOnly',
  A.assertContractCoversRouter(routerActions.filter((a) => a !== 'chiudiGiro')).matrixOnly.includes('chiudiGiro'));
assert('C-neg: duplicate router action detected',
  A.assertContractCoversRouter([...routerActions, 'getOrdenes']).duplicates.includes('getOrdenes'));
assert('C-neg: extractor detects an ADDED action in synthetic source',
  extractActionsFromSource('if (action === "foo") {} else if (action === "bar") {}').join(',') === 'foo,bar');
assert('C-neg: extractor detects a MISSPELLED action (not silently normalized)',
  extractActionsFromSource('action === "getOrden3s"')[0] === 'getOrden3s');
assert('C-neg: future alias collision — alias key equal to a canonical name would be caught',
  A.CANONICAL_ACTIONS.every((a) => !Object.prototype.hasOwnProperty.call(A.ALIAS_MAP, a)));

// ── D. Exhaustive 56 × 4 decision surface ───────────────────────────────────
let surfaceOk = true;
for (const action of SPEC_ALL_56) {
  const exp = expectedAllowed(action);
  for (const p of ['admin', 'operator', 'rider', 'service']) {
    const got = A.isAllowed(p, action);
    const want = exp.includes(p);
    if (got !== want) { surfaceOk = false; console.log(`    surface mismatch ${p} x ${action}: got ${got} want ${want}`); }
  }
}
assert('D: full 56x4 decision surface matches independent spec oracle', surfaceOk);

// ── E. Totals (secondary sanity, not primary proof) ─────────────────────────
const totals = { admin: 0, operator: 0, rider: 0, service: 0 };
for (const action of SPEC_ALL_56) for (const p of ['admin', 'operator', 'rider', 'service']) if (A.isAllowed(p, action)) totals[p]++;
assert('E: admin total 56', totals.admin === 56, `got ${totals.admin}`);
assert('E: operator total 44', totals.operator === 44, `got ${totals.operator}`);
assert('E: rider total 7', totals.rider === 7, `got ${totals.rider}`);
assert('E: service total 1', totals.service === 1, `got ${totals.service}`);

// ── F. Service-only proof ────────────────────────────────────────────────────
assert('F: service allowed triggerCloseIfNeeded', A.isAllowed('service', 'triggerCloseIfNeeded'));
for (const p of ['admin', 'operator', 'rider']) assert(`F: ${p} DENIED triggerCloseIfNeeded`, A.isAllowed(p, 'triggerCloseIfNeeded') === false);
assert('F: triggerCloseIfNeeded isMachineOnly', A.isMachineOnly('triggerCloseIfNeeded'));
// service denied every human action (all 54 non-service-only)
let serviceHumanDenied = true;
for (const action of SPEC_ALL_56) if (action !== 'triggerCloseIfNeeded' && A.isAllowed('service', action)) serviceHumanDenied = false;
assert('F: service DENIED all 55 human actions', serviceHumanDenied);
// humans denied every machine-only action
let humansMachineDenied = true;
for (const p of ['admin', 'operator', 'rider']) for (const action of SPEC_SERVICE_ONLY) if (A.isAllowed(p, action)) humansMachineDenied = false;
assert('F: humans DENIED all machine-only actions', humansMachineDenied);
// admin denied ONLY triggerCloseIfNeeded
assert('F: admin denied set == {triggerCloseIfNeeded}',
  setEq(SPEC_ALL_56.filter((a) => !A.isAllowed('admin', a)), ['triggerCloseIfNeeded']));
// operator denied set == service-only + 11 admin-only
assert('F: operator denied set == triggerCloseIfNeeded + 11 admin-only',
  setEq(SPEC_ALL_56.filter((a) => !A.isAllowed('operator', a)), ['triggerCloseIfNeeded', ...SPEC_ADMIN_ONLY]));
// rider allowed set == exactly the 7
assert('F: rider allowed set == the 7 rider actions',
  setEq(SPEC_ALL_56.filter((a) => A.isAllowed('rider', a)), SPEC_RIDER));

// ── G. Fresh-auth exact set + not-inferred ──────────────────────────────────
assert('G: requiresFreshAuth set == spec 9', setEq(SPEC_ALL_56.filter((a) => A.requiresFreshAuth(a)), SPEC_FRESH));
assert('G: FRESH is subset of canonical', SPEC_FRESH.every((a) => A.isCanonicalAction(a)));
// explicit non-fresh examples (owner §11): not inferred from admin-only / names / mutation
for (const a of ['rigeneraSuggerimenti', 'debugInterpreta', 'chiudiServizio']) {
  assert(`G: ${a} NOT fresh (not inferred from admin-only/name)`, A.requiresFreshAuth(a) === false);
}
for (const a of SPEC_RIDER) assert(`G: rider action ${a} NOT fresh`, A.requiresFreshAuth(a) === false);
// rigeneraSuggerimenti is admin-only but NOT fresh — proves fresh != admin-only
assert('G: admin-only rigeneraSuggerimenti is NOT fresh (fresh != admin-only)',
  A.ADMIN_ONLY_ACTIONS.includes('rigeneraSuggerimenti') && !A.requiresFreshAuth('rigeneraSuggerimenti'));
assert('G: unknown action requiresFreshAuth = false', A.requiresFreshAuth('nope') === false);

// ── H. Predicate exact assignments + rider-only + never evaluated ───────────
assert('H: module RIDER_PREDICATES keys == spec 7', setEq(Object.keys(A.RIDER_PREDICATES), Object.keys(SPEC_PREDICATES)));
for (const [act, id] of Object.entries(SPEC_PREDICATES)) {
  assert(`H: predicate id ${act} == ${id}`, A.RIDER_PREDICATES[act] === id);
  assert(`H: rider getRequiredPredicate(${act}) == ${id}`, A.getRequiredPredicate('rider', act) === id);
  assert(`H: admin ${act} has NO rider predicate`, A.getRequiredPredicate('admin', act) === null);
  assert(`H: operator ${act} has NO rider predicate`, A.getRequiredPredicate('operator', act) === null);
  assert(`H: service ${act} has NO predicate (denied)`, A.getRequiredPredicate('service', act) === null);
}
// predicate-bearing action set == exactly the 7 rider actions
assert('H: predicate-bearing set == 7 rider actions',
  setEq(SPEC_ALL_56.filter((a) => A.getRequiredPredicate('rider', a) !== null), SPEC_RIDER));
// non-rider-enabled actions carry no predicate for rider (and rider is denied them anyway)
assert('H: rider getRequiredPredicate(getConfig) null (denied, no predicate)', A.getRequiredPredicate('rider', 'getConfig') === null);
// B4 never evaluates predicates to a truthy pass — API returns only an id or null
assert('H: getRequiredPredicate never returns boolean true',
  SPEC_RIDER.every((a) => A.getRequiredPredicate('rider', a) !== true));

// ── I. Alias map empty proof ─────────────────────────────────────────────────
assert('I: ALIAS_MAP has zero keys', Object.keys(A.ALIAS_MAP).length === 0);
assert('I: resolveCanonicalAction is identity for canonical (empty alias map)',
  SPEC_ALL_56.every((a) => A.resolveCanonicalAction(a) === a));
assert('I: no alias key collides with a canonical action', Object.keys(A.ALIAS_MAP).every((k) => !A.isCanonicalAction(k)));

// ── J. The four look-alike pairs are SEPARATE canonical actions ─────────────
const PAIRS = [['creaOrdine', 'createOrden'], ['cambiaStato', 'updateEstado'], ['modificaOrdine', 'updateOrden'], ['getWaMsgs', 'getWaMessages']];
for (const [x, y] of PAIRS) {
  assert(`J: ${x} & ${y} both canonical & distinct`, A.isCanonicalAction(x) && A.isCanonicalAction(y) && x !== y);
  assert(`J: neither ${x} nor ${y} is an alias`, A.resolveCanonicalAction(x) === x && A.resolveCanonicalAction(y) === y);
}
// spec-specific classification: updateEstado is rider-enabled; cambiaStato is admin+operator only
assert('J: cambiaStato admin+operator only (no rider)', setEq(A.getActionContract('cambiaStato').allowed, ['admin', 'operator']));
assert('J: updateEstado rider-enabled', setEq(A.getActionContract('updateEstado').allowed, ['admin', 'operator', 'rider']));
assert('J: creaOrdine == createOrden classification (both admin+operator)',
  setEq(A.getActionContract('creaOrdine').allowed, ['admin', 'operator']) && setEq(A.getActionContract('createOrden').allowed, ['admin', 'operator']));
assert('J: getWaMsgs == getWaMessages classification (both admin+operator)',
  setEq(A.getActionContract('getWaMsgs').allowed, ['admin', 'operator']) && setEq(A.getActionContract('getWaMessages').allowed, ['admin', 'operator']));

// ── K. Fail-closed input hardening ───────────────────────────────────────────
for (const bad of [null, undefined, 42, {}, [], '', ' getConfig', 'getConfig ', 'GetConfig', 'GETCONFIG', 'get config']) {
  assert(`K: isAllowed(admin, ${JSON.stringify(bad)}) = false (no normalization)`, A.isAllowed('admin', bad) === false);
  assert(`K: isCanonicalAction(${JSON.stringify(bad)}) = false`, A.isCanonicalAction(bad) === false);
  assert(`K: resolveCanonicalAction(${JSON.stringify(bad)}) = null`, A.resolveCanonicalAction(bad) === null);
}
for (const badP of [null, undefined, 'root', 'Admin', 'SERVICE']) {
  assert(`K: isAllowed(${JSON.stringify(badP)}, getOrdenes) = false`, A.isAllowed(badP, 'getOrdenes') === false);
}
assert('K: getActionContract(unknown) = null', A.getActionContract('nope') === null);
assert('K: isMachineOnly(unknown) = false', A.isMachineOnly('nope') === false);
assert('K: getRequiredPredicate(rider, unknown) = null', A.getRequiredPredicate('rider', 'nope') === null);
assert('K: getRequiredPredicate(unknownPrincipal, updateEstado) = null', A.getRequiredPredicate('root', 'updateEstado') === null);

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
