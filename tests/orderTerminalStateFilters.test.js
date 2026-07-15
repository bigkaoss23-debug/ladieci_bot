// Phase 2B — order terminal-state compatibility invariant (repository-wide).
//
// Domain contract under compatibility:
//   * ordenes.estado canonical completed state = 'COMPLETADO' (ES).
//   * ordenes.estado legacy completed state     = 'COMPLETATO' (IT) — still on disk.
//   * Every ordenes.estado READER/FILTER that treats COMPLETADO as terminal /
//     completed / archived / excluded-from-active / selected-for-close /
//     selected-for-archive MUST also recognize the legacy COMPLETATO.
//   * NO ordenes.estado WRITER emits COMPLETATO (writers emit only COMPLETADO).
//   * wa_msgs.stato='COMPLETATO' is a SEPARATE WhatsApp lifecycle — untouched.
//
// This test is NOT a hand-maintained file list. Parts 1–3 walk the entire
// production tree (src/**, index.js, scripts/**) and derive candidates
// generically, so a NEW bad order-state selector introduced anywhere fails the
// suite. The `estado=` PostgREST key is the domain discriminator: wa_msgs
// queries use `stato=`, so ordenes filters are separable without confusing the
// two domains. Parts 4–7 add targeted named-path and behavioral proofs.
//
// No staging/DB access. Run: node tests/orderTerminalStateFilters.test.js
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const assert = (n, c, d = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); }
};
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Recursively collect production .js files (exclude node_modules, .git, tests).
function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return abs.endsWith('.js') ? [rel] : [];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    if (name === 'node_modules' || name === '.git') continue;
    out.push(...walk(path.join(rel, name)));
  }
  return out;
}
const PROD_FILES = [...walk('src'), ...walk('scripts'), 'index.js'].filter(
  (f) => fs.existsSync(path.join(ROOT, f))
);
const stripComment = (line) => {
  const i = line.indexOf('//');
  return i === -1 ? line : line.slice(0, i);
};
const hasBoth = (s) => /COMPLETADO/.test(s) && /COMPLETATO/.test(s);

console.log(`\n[scan] ${PROD_FILES.length} production files`);
assert('scanner walked the production tree (not a no-op)', PROD_FILES.length >= 15,
  `only ${PROD_FILES.length} files`);

// ── PART 1: PostgREST ordenes.estado in()/not.in() filters ───────────────────
// Generic: every `estado=(not.)in.(LIST)` whose LIST names a completed state
// must name BOTH spellings. `estado=` is ordenes-only; wa_msgs uses `stato=`.
const FILTER_RE = /estado=(?:not\.)?in\.\(([^)]*)\)/g;
let part1Candidates = 0;
for (const file of PROD_FILES) {
  const src = read(file);
  let m;
  FILTER_RE.lastIndex = 0;
  while ((m = FILTER_RE.exec(src)) !== null) {
    const list = m[1];
    if (!/COMPLETADO/.test(list) && !/COMPLETATO/.test(list)) continue; // no completed → n/a
    part1Candidates++;
    assert(`[P1] ${file}: estado filter "${list}" names both completed spellings`,
      hasBoth(list), 'has only one completed spelling');
  }
}
assert('[P1] discovered the known ordenes completed-filter surface', part1Candidates >= 7,
  `only ${part1Candidates} candidates`);

// ── PART 2: JS terminal/inactive ordenes.estado collections ──────────────────
// Generic: any production line that is an array/Set literal (contains `[`),
// names quoted "RETIRADO", and names a completed spelling, is an ordenes.estado
// classification collection → must name BOTH completed spellings. Comment-only
// text is stripped; lines without a completed spelling are irrelevant.
let part2Candidates = 0;
for (const file of PROD_FILES) {
  const lines = read(file).split('\n');
  lines.forEach((raw, i) => {
    const line = stripComment(raw);
    if (!line.includes('[')) return;
    if (!/"RETIRADO"|'RETIRADO'/.test(line)) return;
    if (!/COMPLETADO|COMPLETATO/.test(line)) return;
    part2Candidates++;
    assert(`[P2] ${file}:${i + 1}: terminal/inactive collection names both completed spellings`,
      hasBoth(line), line.trim());
  });
}
assert('[P2] discovered the known ordenes terminal-collection surface', part2Candidates >= 6,
  `only ${part2Candidates} collections`);

// ── PART 3: writer invariant — no ordenes.estado writer emits COMPLETATO ──────
// Generic across the whole production tree. Writers set estado via object
// literal / assignment or via a hardcoded cambiaStato/sbUpdate("ordenes",...)
// argument. wa_msgs writes (stato:) are a different key and ignored.
for (const file of PROD_FILES) {
  const src = read(file);
  const writesEstadoCompletato =
    /estado["']?\s*[:=]\s*["']COMPLETATO["']/.test(src) ||               // literal/assign
    /cambiaStato\([^)]*,\s*["']COMPLETATO["']/.test(src) ||               // hardcoded transition
    /sbUpdate\(\s*["']ordenes["'][^;]*estado[^;]*COMPLETATO/.test(src) || // direct update
    /sbInsert\(\s*["']ordenes["'][^;]*COMPLETATO/.test(src);
  assert(`[P3] ${file}: no ordenes.estado writer emits COMPLETATO`, !writesEstadoCompletato);
}

// ── PART 4: targeted named-path / behavioral proofs ──────────────────────────
// 4.1 index.js getOrdenes active board excludes RETIRADO + BOTH completed.
{
  const src = read('index.js');
  const m = src.match(/getOrdenes[\s\S]{0,200}?estado=not\.in\.\(([^)]*)\)/);
  assert('[P4.1] index.js getOrdenes excludes RETIRADO,COMPLETADO,COMPLETATO',
    !!m && /RETIRADO/.test(m[1]) && hasBoth(m[1]), m ? m[1] : 'getOrdenes filter not found');
}
// 4.2 service-close COMPLETED selections (scan + close read + close delete) → both.
{
  const src = read('src/utils/servizio.js');
  const completedSelects = src.match(/ordenes",\s*"estado=in\.\(RETIRADO,[^)]*\)/g) || [];
  const completedDeletes = src.match(/sbDelete\("ordenes",\s*"estado=in\.\(RETIRADO,[^)]*\)/g) || [];
  assert('[P4.2a] servizio close/scan completed SELECTs recognize both (>=2)',
    completedSelects.length >= 2 && completedSelects.every(hasBoth), completedSelects.join(' | '));
  assert('[P4.2b] servizio close completed DELETE recognizes both (>=1)',
    completedDeletes.length >= 1 && completedDeletes.every(hasBoth), completedDeletes.join(' | '));
}
// 4.3 service-close ACTIVE selections (read + delete) exclude both completed.
{
  const src = read('src/utils/servizio.js');
  const activeOrdenes = src.match(/ordenes",\s*"estado=not\.in\.\(RETIRADO,[^)]*\)/g) || [];
  assert('[P4.3] servizio close active SELECT/DELETE exclude both completed (>=2)',
    activeOrdenes.length >= 2 && activeOrdenes.every(hasBoth), activeOrdenes.join(' | '));
}
// 4.4 archive read recognizes both completed spellings.
{
  const src = read('src/utils/readActions.js');
  const m = src.match(/getOrdenesArchivio[\s\S]{0,200}?estado=in\.\(([^)]*)\)/);
  assert('[P4.4] readActions getOrdenesArchivio includes both completed + RETIRADO',
    !!m && /RETIRADO/.test(m[1]) && hasBoth(m[1]), m ? m[1] : 'archive filter not found');
}
// 4.5 modify-terminal guard sets treat both completed as terminal.
{
  const ao = read('src/agents/agentOrdini.js');
  const or = read('src/agents/orchestrator.js');
  assert('[P4.5a] agentOrdini MODIFICA_TERMINAL_STATES has both completed',
    hasBoth((ao.match(/MODIFICA_TERMINAL_STATES = new Set\(\[([^\]]*)\]/) || [, ''])[1]));
  assert('[P4.5b] orchestrator STATI_BLOCCATI_MODIFICA_AUTO has both completed',
    hasBoth((or.match(/STATI_BLOCCATI_MODIFICA_AUTO = \[([^\]]*)\]/) || [, ''])[1]));
}
// 4.6 Cocina/delivery/timing/zone paths fixed by b7b3c35 remain compatible.
{
  assert('[P4.6a] agentCucina active delivery filter has both',
    hasBoth((read('src/agents/agentCucina.js').match(/estado=not\.in\.\(([^)]*)\)/) || [, ''])[1]));
  assert('[P4.6b] previewTiming active delivery filter has both',
    hasBoth((read('src/agents/previewTiming.js').match(/estado=not\.in\.\(([^)]*)\)/) || [, ''])[1]));
  const zones = read('src/utils/zones.js');
  assert('[P4.6c] zones simulate+compute exclusion lists have both (2 sites)',
    (zones.match(/\[[^\]]*"COMPLETADO"[^\]]*\]/g) || []).filter(hasBoth).length >= 2);
  const ao = read('src/agents/agentOrdini.js');
  assert('[P4.6d] agentOrdini has TWO active delivery filters with both',
    (ao.match(/estado=not\.in\.\(RETIRADO,COMPLETADO,COMPLETATO\)/g) || []).length === 2);
}

// ── PART 5: state machine keeps dual terminal compatibility ──────────────────
{
  const osm = read('src/utils/orderStateMachine.js');
  // Membership check (not exact-equal): B7 additively adds "ANULADO" as a void
  // terminal; the dual-completed + CANCELADO compatibility invariant must remain.
  assert('[P5a] orderStateMachine TERMINAL_STATES keeps both completed (+ CANCELADO)',
    hasBoth((osm.match(/TERMINAL_STATES = new Set\(\[([^\]]*)\]/) || [, ''])[1]) &&
    /TERMINAL_STATES = new Set\(\[[^\]]*"CANCELADO"[^\]]*\]/.test(osm));
  assert('[P5b] orderStateMachine RETIRADO -> both completed targets',
    /RETIRADO: \["COMPLETADO", "COMPLETATO"\]/.test(osm));
  assert('[P5c] planner INACTIVE_STATES keeps both',
    hasBoth((read('src/core/delivery/planner.js').match(/INACTIVE_STATES = new Set\(\[([^\]]*)\]/) || [, ''])[1]));
  assert('[P5d] riderChainExplanation TERMINAL_STATES keeps both',
    hasBoth((read('src/core/delivery/riderChainExplanation.js').match(/TERMINAL_STATES = new Set\(\[([^\]]*)\]/) || [, ''])[1]));
}

// ── PART 6: wa_msgs.stato='COMPLETATO' WhatsApp lifecycle UNCHANGED ──────────
// Different domain (stato= key). Must remain present and must NOT gain COMPLETADO.
{
  assert('[P6a] wa_msgs COMPLETATO upsert preserved (orchestrator)',
    /upsertWaMsg\([^)]*"COMPLETATO"/.test(read('src/agents/orchestrator.js')));
  assert('[P6b] wa_msgs COMPLETATO dedup filter preserved (helpers)',
    /wa_msgs[^;]*stato=not\.in\.\(COMPLETATO,COCINA\)/.test(read('src/utils/helpers.js')));
  assert('[P6c] wa_msgs COMPLETATO delete preserved (servizio)',
    /sbDelete\("wa_msgs", "stato=in\.\(COMPLETATO,COCINA\)"\)/.test(read('src/utils/servizio.js')));
  assert('[P6d] wa_msgs stato filters were NOT contaminated with COMPLETADO',
    !/stato=[^"'&\s]*COMPLETADO/.test(PROD_FILES.map(read).join('\n')));
}

// ── PART 7: RETIRADO behavior preserved in every fixed ordenes selector ──────
{
  const mustHaveRetirado = [
    ['index.js', /getOrdenes[\s\S]{0,200}?estado=not\.in\.\(RETIRADO,/],
    ['src/utils/servizio.js', /estado=in\.\(RETIRADO,COMPLETADO,COMPLETATO\)/],
    ['src/utils/readActions.js', /estado=in\.\(COMPLETADO,COMPLETATO,RETIRADO\)/],
    ['src/agents/agentCucina.js', /estado=not\.in\.\(RETIRADO,/],
  ];
  for (const [file, re] of mustHaveRetirado) {
    assert(`[P7] ${file}: RETIRADO still present alongside completed states`, re.test(read(file)));
  }
}

console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
