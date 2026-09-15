'use strict';
// tests/s4DormantInsertGateGuard.static.test.js
// ===============================================================
// S4-D01..D05 — the dormant hard gate for the S4 operator-intent prerequisite.
//
// This is the noisy tripwire this packet was explicitly asked to carry: the S4
// builder (src/delivery/pendingGiroIntent.js) may already produce a real,
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// well-formed pending_giro_intent value, and it already reaches creaOrdine()'s
// own params object (wired in index.js) -- but the W5 capture trigger
// (candidate SQL: ci/giro-authority-certification/candidate/
// giro_intent_capture_trigger_v1.W5_DORMANT.sql, a BEFORE INSERT trigger on
// ordenes) is NOT installed. Without that trigger nothing ever nulls the
// value back out, so persisting it now would leak a transient operator choice
// into every matching order row forever.
//
// This file mechanically proves, from source text only (no DB, no network):
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
//   - the value reaching creaOrdine()'s params really is non-null-capable
//     (the wiring is real, not vestigial) -- S4-D01
//   - the actual INSERT into ordenes still hard-codes pending_giro_intent to
//     a null literal, never params.pending_giro_intent -- S4-D02 / D03
//   - no OTHER file in the backend writes ordenes.pending_giro_intent at all
//     -- S4-D04
//   - the W5 capture trigger candidate file remains untouched/unexecuted --
//     S4-D05
//
// Guards the exact dangerous line, not a whole-file hash: if a future commit
// flips `pending_giro_intent: pendingGiroIntent` (hardcoded null) to
// `pending_giro_intent: params.pending_giro_intent` without this test being
// updated in the SAME commit that installs the capture trigger, this fails
// loudly.
//
// Run: node tests/s4DormantInsertGateGuard.static.test.js

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l); } }

const ROOT = path.join(__dirname, '..');
const indexJs = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
// language-guard: allow-legacy agentOrdiniSrc/agentOrdini.js are the existing variable/file names being cited, not new vocabulary
const agentOrdiniSrc = fs.readFileSync(path.join(ROOT, 'src', 'agents', 'agentOrdini.js'), 'utf8');

// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
console.log('\n── S4-D01 valid builder output reaches creaOrdine params ──');
{
  // The wiring is real: both call sites pass the builder's own .intent (which CAN be
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  // non-null -- proven functionally in s4PendingGiroIntentBuilder.test.js S4-I02/I03)
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  // into the creaOrdine({...}) call, not a hardcoded null at the index.js layer.
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  check('createOrden threads giroIntentB.intent (not a literal null) into creaOrdine params',
    /pending_giro_intent: giroIntentB\.intent,/.test(indexJs));
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  check('creaOrdine action threads giroIntentA.intent (not a literal null) into creaOrdine params',
    /pending_giro_intent: giroIntentA\.intent,/.test(indexJs));
}

console.log('\n── S4-D02 / S4-D03 sbInsert("ordenes") still hard-codes pending_giro_intent: null ──');
{
  // The dormant local variable itself: a hardcoded null literal, never derived from
  // params.pending_giro_intent.
  // language-guard: allow-legacy agentOrdiniSrc is the existing local variable name (source text of agentOrdini.js) being read, not new vocabulary
  const declMatch = agentOrdiniSrc.match(/const pendingGiroIntent = ([^;]+);/);
  check('pendingGiroIntent local variable exists', !!declMatch);
  check('pendingGiroIntent is hardcoded to the literal null (not params.pending_giro_intent, not a ternary, not a fallback)',
    !!declMatch && declMatch[1].trim() === 'null');

  // The actual INSERT: the key present, pointing at that same dormant variable.
  // language-guard: allow-legacy agentOrdiniSrc is the existing local variable name being read, not new vocabulary
  const insertMatch = agentOrdiniSrc.match(/pending_giro_intent: (\w+),/);
  check('sbInsert("ordenes", ...) carries a pending_giro_intent key', !!insertMatch);
  check('that key\'s value is the dormant local (pendingGiroIntent), not params.pending_giro_intent directly',
    !!insertMatch && insertMatch[1] === 'pendingGiroIntent');

  // The dangerous string must never appear as a live value anywhere in the INSERT
  // language-guard: allow-legacy agentOrdiniSrc is the existing local variable name being read, not new vocabulary
  // object itself (only inside the explanatory comment block is acceptable).
  // language-guard: allow-legacy agentOrdiniSrc is the existing local variable name being read, not new vocabulary
  const insertObjStart = agentOrdiniSrc.indexOf('const result = await sbInsert("ordenes", {');
  // language-guard: allow-legacy agentOrdiniSrc is the existing local variable name being read, not new vocabulary
  const insertObjEnd = insertObjStart === -1 ? -1 : agentOrdiniSrc.indexOf('\n    });', insertObjStart);
  // language-guard: allow-legacy agentOrdiniSrc is the existing local variable name being read, not new vocabulary
  const insertObjText = insertObjStart === -1 || insertObjEnd === -1 ? '' : agentOrdiniSrc.slice(insertObjStart, insertObjEnd);
  check('sbInsert("ordenes", ...) call located for scoped inspection', insertObjStart !== -1 && insertObjEnd !== -1);
  check('the INSERT object itself never ASSIGNS params.pending_giro_intent as the value (comments may still name it as the thing to avoid)',
    !/pending_giro_intent:\s*params\.pending_giro_intent/.test(insertObjText));
}

console.log('\n── S4-D04 static global search finds no other app writer for ordenes.pending_giro_intent ──');
{
  const SRC_DIR = path.join(ROOT, 'src');
  function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }
  const files = walk(SRC_DIR, []);
  files.push(path.join(ROOT, 'index.js'));

  // The closed, documented allowlist of files allowed to even mention the field.
  const ALLOWLIST = new Set([
    path.join(ROOT, 'index.js'),                                        // builds + threads the intent (S4-H01/H02)
    // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
    path.join(ROOT, 'src', 'agents', 'agentOrdini.js'),                  // the dormant hard gate itself
    path.join(ROOT, 'src', 'delivery', 'pendingGiroIntent.js'),          // the builder
  ]);

  const offenders = [];
  for (const f of files) {
    if (ALLOWLIST.has(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes('pending_giro_intent')) offenders.push(path.relative(ROOT, f));
  }
  check('zero files outside the 3-file allowlist reference ordenes.pending_giro_intent',
    offenders.length === 0, offenders);
  check('the allowlist itself is exactly 3 files (no silent scope creep)', ALLOWLIST.size === 3);
}

console.log('\n── S4-D05 capture trigger remains absent ──');
{
  const dormantSqlPath = path.join(ROOT, 'ci', 'giro-authority-certification', 'candidate',
    'giro_intent_capture_trigger_v1.W5_DORMANT.sql');
  check('the W5 capture trigger candidate file still exists as a candidate (not promoted into migrations/)',
    fs.existsSync(dormantSqlPath));
  const migDir = path.join(ROOT, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql'));
  check('no migrations/ file installs ordenes_zz_giro_intent_capture_v1',
    !migFiles.some((f) => fs.readFileSync(path.join(migDir, f), 'utf8').includes('ordenes_zz_giro_intent_capture_v1')));
  check('this packet added no new .sql file anywhere',
    !fs.readdirSync(migDir).some((f) => f.startsWith('2026-09-15_s4') || f.toLowerCase().includes('s4-operator-intent')));
}

console.log('');
console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
