'use strict';
// tests/s4DormantInsertGateGuard.static.test.js
// ===============================================================
// W5 INTENT ACTIVATION V1 — the S4 dormant hard gate has ACTIVATED.
//
// language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
// HISTORY. This file's original purpose (S4-D01..D05, 2026-09-14) was to prove
// the S4 operator-intent prerequisite stayed dormant: a real, well-formed
// language-guard: allow-legacy creaOrdine is the existing identifier being cited, not new vocabulary
// pending_giro_intent value could already reach creaOrdine()'s params, but
// the INSERT itself still hard-coded a null literal, because the W5 capture
// trigger was not yet installed. That guard is now superseded, not deleted —
// per this packet's own mandate ("must NOT simply be deleted... convert it
// into an activation-state guard... preserve its safety purpose while
// updating its expected state"). The FILENAME stays (other static guards --
// tests/plannerW4FinalCutover.static.test.js, tests/manualGirosW5Packet01.
// static.test.js -- reference it by this exact path, some only via
// fs.existsSync as a presence flag) but the checks below prove the opposite
// invariant of the original file.
//
// WHAT THIS NOW PROVES, mechanically, from source text only (no DB, no
// network):
//   S4-A01/A02 — the producer is LIVE: pendingGiroIntent is now
//     params.pending_giro_intent || null, never a hardcoded null literal.
//   S4-A03 — the value the INSERT actually persists is still, and only,
//     that same live local (never params.pending_giro_intent inlined
//     directly, never any other expression) -- the trusted-builder-only
//     invariant is unchanged even though the gate opened.
//   S4-A04 — COUPLING (the actual safety property this whole guard exists
//     for): the producer may only be live in a commit where migration 132
//     (the one that installs ordenes_zz_giro_intent_capture_v1) is also
//     present in migrations/. A producer-live-without-trigger state is
//     exactly the "UNSAFE intermediate" the design audit that preceded this
//     packet identified and ruled out -- this assertion is the mechanical
//     proof that state cannot exist in this repo at this commit.
//   S4-A05 — the same closed 3-file allowlist for who may even mention
// language-guard: allow-legacy agentOrdini is the existing identifier being cited, not new vocabulary
//     ordenes.pending_giro_intent, unchanged (index.js, agentOrdini.js,
//     pendingGiroIntent.js) -- the reconciler/close-sweep additions never
//     touch that literal field name, they operate on already-captured
//     giro_authority.giro_intents rows instead.
//   S4-A06 — the trusted builder itself (src/delivery/pendingGiroIntent.js)
//     is untouched: still the sole, unmodified source of what reaches the
//     INSERT, still fails open to intent:null on anything uncertain.
//
// Guards the exact activated line, not a whole-file hash: if a future commit
// flips pending_giro_intent back to a hardcoded null, or forward to reading
// straight from an unvalidated request body, or installs the trigger without
// this file being updated, this fails loudly.
//
// Run: node tests/s4DormantInsertGateGuard.static.test.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
function check(l, c) { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l); } }

const ROOT = path.join(__dirname, '..');
const indexJs = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
// language-guard: allow-legacy writerModuleSrc/agentOrdini.js are the existing variable/file names being cited, not new vocabulary
const writerModuleSrc = fs.readFileSync(path.join(ROOT, 'src', 'agents', 'agentOrdini.js'), 'utf8');

// language-guard: allow-legacy creaOrdine is the existing identifier being cited, not new vocabulary
console.log('\n── S4-A01 valid builder output still reaches creaOrdine params (unchanged wiring) ──');
{
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  check('createOrden threads giroIntentB.intent (not a literal null) into creaOrdine params',
    /pending_giro_intent: giroIntentB\.intent,/.test(indexJs));
  // language-guard: allow-legacy creaOrdine is the existing function name being cited, not new vocabulary
  check('creaOrdine action threads giroIntentA.intent (not a literal null) into creaOrdine params',
    /pending_giro_intent: giroIntentA\.intent,/.test(indexJs));
}

console.log('\n── S4-A02 the producer is LIVE: pendingGiroIntent reads params.pending_giro_intent ──');
{
  // language-guard: allow-legacy writerModuleSrc is the existing local variable name (source text of agentOrdini.js) being read, not new vocabulary
  const declMatch = writerModuleSrc.match(/const pendingGiroIntent = ([^;]+);/);
  check('pendingGiroIntent local variable exists', !!declMatch);
  check('pendingGiroIntent reads params.pending_giro_intent with a null fallback (the exact activation target), never a hardcoded null literal',
    !!declMatch && declMatch[1].trim() === 'params.pending_giro_intent || null');
}

console.log('\n── S4-A03 sbInsert("ordenes") still only ever persists the local, never a raw/alternate expression ──');
{
  // language-guard: allow-legacy writerModuleSrc is the existing local variable name being read, not new vocabulary
  const insertMatch = writerModuleSrc.match(/pending_giro_intent: (\w+),/);
  check('sbInsert("ordenes", ...) carries a pending_giro_intent key', !!insertMatch);
  check('that key\'s value is the local (pendingGiroIntent) -- never params.pending_giro_intent inlined directly, never any other expression',
    !!insertMatch && insertMatch[1] === 'pendingGiroIntent');

  const insertObjStart = writerModuleSrc.indexOf('const result = await sbInsert("ordenes", {');
  const insertObjEnd = insertObjStart === -1 ? -1 : writerModuleSrc.indexOf('\n    });', insertObjStart);
  const insertObjText = insertObjStart === -1 || insertObjEnd === -1 ? '' : writerModuleSrc.slice(insertObjStart, insertObjEnd);
  check('sbInsert("ordenes", ...) call located for scoped inspection', insertObjStart !== -1 && insertObjEnd !== -1);
  check('the INSERT object itself never ASSIGNS params.pending_giro_intent directly (must go through the validated local)',
    !/pending_giro_intent:\s*params\.pending_giro_intent/.test(insertObjText));
}

console.log('\n── S4-A04 COUPLING: producer live IFF the capture trigger ships in a migration present in this repo ──');
{
  const migDir = path.join(ROOT, 'migrations');
  const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql') && !f.endsWith('.ROLLBACK.sql'));
  const triggerFile = migFiles.find((f) =>
    fs.readFileSync(path.join(migDir, f), 'utf8').includes('CREATE TRIGGER ordenes_zz_giro_intent_capture_v1'));
  check('exactly one migrations/ file installs ordenes_zz_giro_intent_capture_v1 (migration 132)',
    !!triggerFile && triggerFile.includes('_migration_132'), triggerFile);

  // The unsafe intermediate this whole guard exists to rule out: a producer-live
  // commit where the trigger migration is ABSENT would leave every matching
  // pending_giro_intent persisted forever (nothing ever nulls it back out).
  const declMatch = writerModuleSrc.match(/const pendingGiroIntent = ([^;]+);/);
  const producerLive = !!declMatch && declMatch[1].trim() !== 'null';
  check('producer-live implies the trigger migration is present in this commit (the UNSAFE intermediate cannot exist here)',
    !producerLive || !!triggerFile);

  // The candidate SQL this migration's trigger section was packaged from, byte-for-
  // byte, minus only the header/comment lines candidate files use (S4-D05's original
  // "stays untouched" proof, adapted: now proving it was copied verbatim, not that
  // it was never used).
  const dormantSqlPath = path.join(ROOT, 'ci', 'giro-authority-certification', 'candidate',
    'giro_intent_capture_trigger_v1.W5_DORMANT.sql');
  check('the original W5-DORMANT capture-trigger candidate file still exists (the packaging source)',
    fs.existsSync(dormantSqlPath));
  if (triggerFile && fs.existsSync(dormantSqlPath)) {
    const stripComments = (s) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim();
    const candidateBody = stripComments(fs.readFileSync(dormantSqlPath, 'utf8'));
    const migBody = fs.readFileSync(path.join(migDir, triggerFile), 'utf8');
    check('the trigger CREATE statement in migration 132 matches the certified candidate\'s CREATE TRIGGER statement verbatim',
      migBody.includes('CREATE TRIGGER ordenes_zz_giro_intent_capture_v1') &&
      candidateBody.includes('CREATE TRIGGER ordenes_zz_giro_intent_capture_v1') &&
      migBody.split('CREATE TRIGGER ordenes_zz_giro_intent_capture_v1')[1].split('EXECUTE FUNCTION giro_authority.capture_giro_intent_v1();')[0] ===
      candidateBody.split('CREATE TRIGGER ordenes_zz_giro_intent_capture_v1')[1].split('EXECUTE FUNCTION giro_authority.capture_giro_intent_v1();')[0]);
  }
}

console.log('\n── S4-A05 static global search: the pending_giro_intent-literal allowlist stays closed at 3 files ──');
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

  const ALLOWLIST = new Set([
    path.join(ROOT, 'index.js'),                                        // builds + threads the intent (S4-H01/H02)
    // language-guard: allow-legacy agentOrdini.js is the existing file name being cited, not new vocabulary
    path.join(ROOT, 'src', 'agents', 'agentOrdini.js'),                  // the activated gate itself
    path.join(ROOT, 'src', 'delivery', 'pendingGiroIntent.js'),          // the builder
  ]);

  const offenders = [];
  for (const f of files) {
    if (ALLOWLIST.has(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (text.includes('pending_giro_intent')) offenders.push(path.relative(ROOT, f));
  }
  check('zero files outside the 3-file allowlist reference ordenes.pending_giro_intent (the reconciler and the close-sweep operate on giro_authority.giro_intents rows, never on that literal field name)',
    offenders.length === 0, offenders);
  check('the allowlist itself is exactly 3 files (no silent scope creep)', ALLOWLIST.size === 3);
}

console.log('\n── S4-A06 the trusted builder itself is untouched ──');
{
  const builderPath = path.join(ROOT, 'src', 'delivery', 'pendingGiroIntent.js');
  check('src/delivery/pendingGiroIntent.js still exists', fs.existsSync(builderPath));
  if (fs.existsSync(builderPath)) {
    const src = fs.readFileSync(builderPath, 'utf8');
    check('still reads actor/sv only from authCtx, never from body',
      /authCtx\.actor/.test(src) && /authCtx\.sv/.test(src) && !/body\.actor/.test(src) && !/body\.sv/.test(src));
    check('still fails open to intent:null on any uncertain input (unchanged try/catch-wrapped contract)',
      /catch \(_\) \{\s*return Object\.freeze\(\{ intent: null \}\);/.test(src));
  }
}

console.log('');
console.log('Totale: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
process.exit(fail === 0 ? 0 : 1);
