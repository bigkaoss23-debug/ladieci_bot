// Phase 2B — order terminal-state filter normalization.
// Static source assertions: every ordenes.estado active/delivery/timing filter
// treats BOTH canonical 'COMPLETADO' and legacy 'COMPLETATO' as terminal, while
// the wa_msgs.stato='COMPLETATO' WhatsApp lifecycle stays untouched (different
// domain). No staging/DB access. Run: node tests/orderTerminalStateFilters.test.js
'use strict';
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const assert = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// 1) ordenes.estado active/delivery/timing filters — must contain BOTH spellings.
const ORDENES_ACTIVE = [
  ['src/agents/agentCucina.js',   /estado=not\.in\.\(RETIRADO,COMPLETADO,COMPLETATO\)/],
  ['src/agents/previewTiming.js', /estado=not\.in\.\(RETIRADO,COMPLETADO,COMPLETATO\)/],
  ['src/agents/agentOrdini.js',   /estado=not\.in\.\(RETIRADO,COMPLETADO,COMPLETATO\)/],
  ['src/utils/zones.js',          /\["RETIRADO","COMPLETADO","COMPLETATO","POR_CONFIRMAR"\]/],
  ['src/utils/zones.js',          /\["RETIRADO", "COMPLETADO", "COMPLETATO", "POR_CONFIRMAR"\]/],
];
for (const [file, re] of ORDENES_ACTIVE) {
  const src = read(file);
  assert(`${file}: active filter has canonical+legacy`, re.test(src), 'missing both spellings');
}

// 1b) agentOrdini has TWO such queries — both fixed.
assert('agentOrdini.js: both ordenes active queries fixed',
  (read('src/agents/agentOrdini.js').match(/estado=not\.in\.\(RETIRADO,COMPLETADO,COMPLETATO\)/g) || []).length === 2);

// 2) No ordenes.estado active query keeps ONLY the legacy spelling.
for (const file of ['src/agents/agentCucina.js', 'src/agents/previewTiming.js', 'src/agents/agentOrdini.js', 'src/utils/zones.js']) {
  const src = read(file);
  assert(`${file}: no ordenes filter with only COMPLETATO`,
    !/not\.in\.\(RETIRADO,COMPLETATO\)/.test(src) && !/\["RETIRADO","COMPLETATO","POR_CONFIRMAR"\]/.test(src) && !/\["RETIRADO", "COMPLETATO", "POR_CONFIRMAR"\]/.test(src));
}

// 3) Legacy compatibility retained where it already coexisted.
assert('planner.js INACTIVE_STATES keeps both', /INACTIVE_STATES = new Set\(\["RETIRADO", "COMPLETADO", "COMPLETATO", "POR_CONFIRMAR"\]\)/.test(read('src/core/delivery/planner.js')));
assert('riderChainExplanation.js TERMINAL_STATES keeps both', /TERMINAL_STATES = new Set\(\["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO"\]\)/.test(read('src/core/delivery/riderChainExplanation.js')));
const osm = read('src/utils/orderStateMachine.js');
assert('orderStateMachine keeps dual terminal', /TERMINAL_STATES = new Set\(\["COMPLETADO", "COMPLETATO", "CANCELADO"\]\)/.test(osm));
assert('orderStateMachine RETIRADO -> both', /RETIRADO: \["COMPLETADO", "COMPLETATO"\]/.test(osm));

// 4) No writer sets ordenes.estado = 'COMPLETATO' (writers emit only COMPLETADO).
for (const file of ['src/agents/agentOrdini.js', 'src/agents/orchestrator.js', 'src/utils/servizio.js']) {
  const src = read(file);
  const writesCompletato = /estado["']?\s*[:=]\s*["']COMPLETATO["']/.test(src) || /cambiaStato\([^)]*["']COMPLETATO["']/.test(src) || /sbUpdate\(\s*["']ordenes["'][^;]*COMPLETATO/.test(src);
  assert(`${file}: no writer emits ordenes.estado=COMPLETATO`, !writesCompletato);
}

// 5) wa_msgs.stato='COMPLETATO' domain UNCHANGED (still present — different domain).
assert('wa_msgs COMPLETATO lifecycle preserved (orchestrator)', /upsertWaMsg\([^)]*"COMPLETATO"/.test(read('src/agents/orchestrator.js')));
assert('wa_msgs COMPLETATO filter preserved (helpers)', /wa_msgs[^;]*stato=not\.in\.\(COMPLETATO,COCINA\)/.test(read('src/utils/helpers.js')));
assert('wa_msgs COMPLETATO delete preserved (servizio)', /sbDelete\("wa_msgs", "stato=in\.\(COMPLETATO,COCINA\)"\)/.test(read('src/utils/servizio.js')));

// 6) RETIRADO behavior preserved in the fixed filters.
assert('agentCucina still excludes RETIRADO', /RETIRADO,COMPLETADO,COMPLETATO/.test(read('src/agents/agentCucina.js')));

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
