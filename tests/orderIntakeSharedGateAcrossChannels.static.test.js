'use strict';

// STALE_SERVICE_SESSION_SELF_HEAL (2026-08-15) — ALL_CHANNELS_SHARE_THE_
// FIXED_GATE. A structural, source-level proof rather than a behavioral
// one: every order-intake channel (Mesa, WhatsApp/orchestrator, Teléfono/
// Barra manual) reaches gateNewOrderIntake through the exact SAME single
// language-guard: allow-legacy agentOrdini/creaOrdine are the existing module/function names this line references, not new vocabulary
// call site (agentOrdini.js's creaOrdine, line ~417), not a per-channel
// language-guard: allow-legacy servizio.js is the existing close-engine module this line references, not new vocabulary
// copy. This is what makes the fix in servizio.js/incidentSafeRollover.js
// apply everywhere at once, and it's what a future regression (someone
// giving Mesa its own bypassing service-resolution path) would break
// silently without a test like this one pinning the shared architecture.

const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const agentOrdini = read('src/agents/agentOrdini.js'); // language-guard: allow-legacy agentOrdini is the existing module filename this constant loads, not new vocabulary
const orchestrator = read('src/agents/orchestrator.js');
const indexJs = read('index.js');
const mesaService = read('src/tables/mesaService.js');
const orderIntakePolicy = read('src/serviceSessions/orderIntakePolicy.js');

let passed = 0;
let failed = 0;
function test(name, condition) {
  if (condition) { passed += 1; process.stdout.write(`  PASS  ${name}\n`); }
  else { failed += 1; process.stderr.write(`  FAIL  ${name}\n`); }
}

test('agentOrdini.js calls orderIntakePolicy.gateNewOrderIntake exactly once (the one shared choke point)', // language-guard: allow-legacy agentOrdini is the existing module name this test asserts a single shared call site for, not new vocabulary
  (agentOrdini.match(/orderIntakePolicy\.gateNewOrderIntake/g) || []).length === 1);

test('creaOrdine is exported from agentOrdini.js (the function every channel calls)', // language-guard: allow-legacy creaOrdine/agentOrdini are the existing function/module names this test asserts are exported, not new vocabulary
  /async function creaOrdine\(/.test(agentOrdini) && /module\.exports[\s\S]*creaOrdine/.test(agentOrdini));

test('orchestrator.js (WhatsApp channel) imports creaOrdine from agentOrdini.js, not a local reimplementation', // language-guard: allow-legacy creaOrdine/agentOrdini are the existing function/module names this test asserts orchestrator.js imports, not new vocabulary
  /require\(["']\.\/agentOrdini["']\)/.test(orchestrator) && /creaOrdine/.test(orchestrator));

test('orchestrator.js never defines its own creaOrdine/gateNewOrderIntake', // language-guard: allow-legacy creaOrdine is the existing function name this test asserts orchestrator.js never redefines, not new vocabulary
  !/async function creaOrdine\(/.test(orchestrator) && !/function gateNewOrderIntake\(/.test(orchestrator));

test('index.js (Teléfono/Barra manual channel) imports creaOrdine from the SAME agentOrdini.js module', // language-guard: allow-legacy creaOrdine/agentOrdini are the existing function/module names this test asserts index.js imports, not new vocabulary
  /require\(["']\.\/src\/agents\/agentOrdini["']\)/.test(indexJs) && /creaOrdine/.test(indexJs));

test('index.js never defines its own creaOrdine/gateNewOrderIntake', // language-guard: allow-legacy creaOrdine is the existing function name this test asserts index.js never redefines, not new vocabulary
  !/async function creaOrdine\(/.test(indexJs) && !/function gateNewOrderIntake\(/.test(indexJs));

test('mesaService.js\'s default createOrder IS agentOrdini.creaOrdine (Mesa reuses the identical function, not a copy)', // language-guard: allow-legacy agentOrdini/creaOrdine are the existing module/function names this test asserts mesaService.js reuses verbatim, not new vocabulary
  /const \{ creaOrdine: defaultCreateOrder[\s\S]*?\} = require\(['"]\.\.\/agents\/agentOrdini['"]\)/.test(mesaService) // language-guard: allow-legacy creaOrdine/agentOrdini are the same existing function/module names, continued from the line above, not new vocabulary
  && /createOrder = defaultCreateOrder/.test(mesaService));

test('mesaService.js never defines its own creaOrdine/gateNewOrderIntake', // language-guard: allow-legacy creaOrdine is the existing function name this test asserts mesaService.js never redefines, not new vocabulary
  !/async function creaOrdine\(/.test(mesaService) && !/function gateNewOrderIntake\(/.test(mesaService));

test('gateNewOrderIntake itself is defined exactly once, in orderIntakePolicy.js, and nowhere else builds a second STALE_SERVICE_SESSION gate',
  /function gateNewOrderIntake\(/.test(orderIntakePolicy)
  && !/function gateNewOrderIntake\(/.test(agentOrdini) // language-guard: allow-legacy agentOrdini is the existing module name this test asserts never redefines the gate, not new vocabulary
  && !/function gateNewOrderIntake\(/.test(orchestrator)
  && !/function gateNewOrderIntake\(/.test(indexJs)
  && !/function gateNewOrderIntake\(/.test(mesaService));

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exitCode = 1;
