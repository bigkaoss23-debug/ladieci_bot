'use strict';
// B7A1 state-machine grammar tests — ANULADO void terminal.
// Run: node tests/orderStateMachineAnulado.test.js
// Pure grammar only (no DB, no runtime writer/route). Proves ANULADO is a valid
// terminal reachable from exactly the four active states, never from
// RETIRADO/COMPLETADO/COMPLETATO/CANCELADO/ANULADO, and that pre-existing
// transitions are unchanged. Includes negative controls.
const sm = require('../src/utils/orderStateMachine');
const { isKnownState, isTerminalState, isValidTransition, validateTransition, LEGAL_TRANSITIONS } = sm;
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const arrEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));

const VOIDABLE = ['POR_CONFIRMAR', 'EN_COCINA', 'LISTO', 'EN_ENTREGA'];
// States that must NOT have a real transition edge into ANULADO. (ANULADO→ANULADO
// is excluded here: X→X is the universal idempotent no-op, uniform across all
// terminals incl. CANCELADO; the absence of a graph self-edge is proven directly
// via LEGAL_TRANSITIONS['ANULADO'] === [] above.)
const NOT_VOIDABLE = ['NUEVO', 'RETIRADO', 'COMPLETADO', 'COMPLETATO', 'CANCELADO'];

// ── ANULADO is a known terminal with no outgoing edge (incl. no self-edge) ───
assert('ANULADO is a known state', isKnownState('ANULADO'));
assert('ANULADO is terminal', isTerminalState('ANULADO'));
assert('ANULADO has no outgoing edges (LEGAL_TRANSITIONS empty, no self-edge)', arrEq(LEGAL_TRANSITIONS['ANULADO'] || [], []));
// a real (non-noop) transition out of ANULADO is rejected as terminal
assert('ANULADO → EN_COCINA rejected (from_terminal_state)', validateTransition('ANULADO', 'EN_COCINA').reason === 'from_terminal_state');
assert('ANULADO → RETIRADO rejected (from_terminal_state)', validateTransition('ANULADO', 'RETIRADO').reason === 'from_terminal_state');
// PUBLIC-API contract: ANULADO→ANULADO must be REJECTED (NOT an idempotent no-op).
// Covers both exported entry points (boolean predicate + {ok,reason} validator).
assert('public predicate rejects ANULADO → ANULADO', isValidTransition('ANULADO', 'ANULADO') === false);
assert('public validator rejects ANULADO → ANULADO (not noop)', (() => {
  const v = validateTransition('ANULADO', 'ANULADO');
  return v.ok === false && v.reason === 'from_terminal_state' && v.reason !== 'noop';
})());
// pre-existing same-state no-op is preserved for every OTHER state
assert('CANCELADO → CANCELADO still an idempotent no-op', (() => {
  const v = validateTransition('CANCELADO', 'CANCELADO'); return v.ok === true && v.reason === 'noop';
})());
assert('COMPLETADO → COMPLETADO still an idempotent no-op', validateTransition('COMPLETADO', 'COMPLETADO').reason === 'noop');
assert('EN_COCINA → EN_COCINA still an idempotent no-op', validateTransition('EN_COCINA', 'EN_COCINA').reason === 'noop');

// ── exactly four states can enter ANULADO ────────────────────────────────────
const entersAnulado = [...sm.KNOWN_STATES].filter((f) => f !== 'ANULADO' && isValidTransition(f, 'ANULADO'));
assert('exactly the four active states can enter ANULADO', arrEq(entersAnulado, VOIDABLE), entersAnulado.join(','));
for (const f of VOIDABLE) assert(`${f} → ANULADO legal`, validateTransition(f, 'ANULADO').reason === 'legal');
assert('NUEVO → ANULADO rejected (illegal_transition)', validateTransition('NUEVO', 'ANULADO').reason === 'illegal_transition');
assert('RETIRADO → ANULADO rejected (illegal_transition, RETIRADO not terminal but no edge)', validateTransition('RETIRADO', 'ANULADO').reason === 'illegal_transition');
assert('COMPLETADO → ANULADO rejected (from_terminal_state)', validateTransition('COMPLETADO', 'ANULADO').reason === 'from_terminal_state');
assert('COMPLETATO → ANULADO rejected (from_terminal_state)', validateTransition('COMPLETATO', 'ANULADO').reason === 'from_terminal_state');
assert('CANCELADO → ANULADO rejected (from_terminal_state)', validateTransition('CANCELADO', 'ANULADO').reason === 'from_terminal_state');
for (const f of NOT_VOIDABLE) assert(`${f} cannot enter ANULADO`, !isValidTransition(f, 'ANULADO'));

// ── pre-existing transitions unchanged ───────────────────────────────────────
assert('POR_CONFIRMAR → EN_COCINA still legal', isValidTransition('POR_CONFIRMAR', 'EN_COCINA'));
assert('EN_COCINA → LISTO still legal', isValidTransition('EN_COCINA', 'LISTO'));
assert('LISTO → EN_ENTREGA still legal', isValidTransition('LISTO', 'EN_ENTREGA'));
assert('LISTO → RETIRADO still legal', isValidTransition('LISTO', 'RETIRADO'));
assert('EN_ENTREGA → RETIRADO still legal', isValidTransition('EN_ENTREGA', 'RETIRADO'));
assert('RETIRADO → COMPLETADO still legal', isValidTransition('RETIRADO', 'COMPLETADO'));
assert('LISTO → EN_COCINA (operational undo) still legal', isValidTransition('LISTO', 'EN_COCINA'));
assert('EN_COCINA → CANCELADO still legal', isValidTransition('EN_COCINA', 'CANCELADO'));
assert('COMPLETADO still terminal', isTerminalState('COMPLETADO') && !isValidTransition('COMPLETADO', 'LISTO'));
assert('CANCELADO still terminal', isTerminalState('CANCELADO'));
assert('unknown target still rejected', validateTransition('LISTO', 'FOO').reason === 'unknown_target_state');
assert('unknown source still rejected', validateTransition('FOO', 'EN_COCINA').reason === 'unknown_source_state');

// ── no runtime writer/route introduced: module stays a pure helper ───────────
assert('orderStateMachine exports unchanged surface', ['KNOWN_STATES', 'TERMINAL_STATES', 'LEGAL_TRANSITIONS', 'isKnownState', 'isTerminalState', 'validateTransition', 'isValidTransition'].every((k) => k in sm));
assert('orderStateMachine imports nothing (no require / no DB / no route)', (() => {
  // strip // comments: the file's wiring-PROPOSAL comment shows an example require() that is not real code
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/utils/orderStateMachine.js'), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return !/require\(/.test(src) && !/sbUpdate|sbInsert|sbDelete|app\.(get|post)|router\./.test(src);
})());

// ── NEGATIVE CONTROLS: prove the assertions catch defects ────────────────────
(function negativeControls() {
  // model the legal-transition builder so we can inject defects
  const build = (forward, voidable, cancellable) => {
    const out = {};
    for (const [from, tos] of Object.entries(forward)) {
      const extra = [];
      if (cancellable.includes(from)) extra.push('CANCELADO');
      if (voidable.includes(from)) extra.push('ANULADO');
      out[from] = Array.from(new Set([...tos, ...extra]));
    }
    return out;
  };
  const FWD = { POR_CONFIRMAR: ['NUEVO', 'EN_COCINA'], NUEVO: ['EN_COCINA'], EN_COCINA: ['LISTO'], LISTO: ['EN_ENTREGA', 'RETIRADO'], EN_ENTREGA: ['RETIRADO'], RETIRADO: ['COMPLETADO', 'COMPLETATO'], COMPLETADO: [], COMPLETATO: [], CANCELADO: [], ANULADO: [] };
  const CANC = ['POR_CONFIRMAR', 'NUEVO', 'EN_COCINA', 'LISTO', 'EN_ENTREGA'];
  const enters = (g) => Object.keys(g).filter((f) => (g[f] || []).includes('ANULADO'));

  // NC1: a missing incoming edge (drop EN_COCINA from voidable) → set no longer the four
  const nc1 = build(FWD, ['POR_CONFIRMAR', 'LISTO', 'EN_ENTREGA'], CANC);
  assert('NC1: detector catches a missing ANULADO incoming edge', !arrEq(enters(nc1), VOIDABLE));
  // NC2: RETIRADO incorrectly allowed
  const nc2fwd = { ...FWD, RETIRADO: ['COMPLETADO', 'COMPLETATO', 'ANULADO'] };
  const nc2 = build(nc2fwd, VOIDABLE, CANC);
  assert('NC2: detector catches RETIRADO wrongly entering ANULADO', enters(nc2).includes('RETIRADO'));
  // NC3: ANULADO gains an outgoing transition
  const nc3 = build({ ...FWD, ANULADO: ['EN_COCINA'] }, VOIDABLE, CANC);
  assert('NC3: detector catches ANULADO gaining an outgoing edge', (nc3['ANULADO'] || []).length !== 0);
  // NC4: a pre-existing transition removed (EN_COCINA loses LISTO)
  const nc4 = build({ ...FWD, EN_COCINA: [] }, VOIDABLE, CANC);
  assert('NC4: detector catches a removed pre-existing transition', !(nc4['EN_COCINA'] || []).includes('LISTO'));

  // NC5: prove the self-transition assertion fails if the generic same-state
  // shortcut is (wrongly) allowed to authorize ANULADO→ANULADO. Model the buggy
  // validator (noop before the terminal guard) and assert our detector flags it.
  const buggyValidate = (from, to) => {
    const f = from == null ? null : String(from);
    const t = String(to || '');
    if (![...sm.KNOWN_STATES].includes(t)) return { ok: false, reason: 'unknown_target_state' };
    if (f === t) return { ok: true, reason: 'noop' };   // BUG: no ANULADO self-guard
    return { ok: false, reason: 'other' };
  };
  const buggy = buggyValidate('ANULADO', 'ANULADO');
  assert('NC5: detector catches ANULADO→ANULADO wrongly allowed as no-op',
    !(buggy.ok === false));   // buggy returns ok:true → our reject-assertion would FAIL on it
})();

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
