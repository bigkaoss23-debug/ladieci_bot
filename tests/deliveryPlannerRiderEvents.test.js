// tests/deliveryPlannerRiderEvents.test.js
// ===============================================================
// Real rider events + Prudent replanning + Soft/Hard oven overload + Buffer
// Run: node tests/deliveryPlannerRiderEvents.test.js
// ===============================================================
// Planner PURO isolato. Nessun DB, nessun network, nessuna scrittura.
// Copre §Real rider events, §Prudent replanning, §Soft oven overload, §Driver buffer.
// ===============================================================

"use strict";
const { buildPlan, _internal } = require("../src/core/delivery/planner");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
const ord = (o) => ({ tipo_consegna: "DOMICILIO", estado: "NUEVO", n_pizze: 1, ...o });

// ── 1. Driver returns early → aiuta i NUOVI ordini (tempo recuperato sul futuro) ─
console.log("\n── 1. rider tornato prima aiuta i nuovi ordini ──");
{
  const newOrder = ord({ id: "N", zona: "Q1", hora: "20:26", andata_min: 5 }); // partTeorica 20:21
  const event = buildPlan({ now: "20:00", driver_events: [{ type: "rider_returned", at: "20:24", source: "operator_button" }], orders: [newOrder] });
  const sim = buildPlan({ now: "20:00", driver: { libero_desde: "20:30" }, orders: [newOrder] });
  check("evento reale: disponibilità 20:24", event.driver.available_from === "20:24" && event.driver.real_event === true, JSON.stringify(event.driver));
  check("nuovo ordine usa 20:24 (tempo recuperato)", event.orders.N.salida === "20:24", event.orders.N.salida);
  check("senza evento la stima resta 20:30 (system_estimate)", sim.orders.N.salida === "20:30" && sim.driver.source === "system_estimate", `${sim.orders.N.salida}/${sim.driver.source}`);
  check("evento batte la stima per il futuro", event.orders.N.salida < sim.orders.N.salida);
}

// ── 2. Driver returns early → NON rimescola il SEMI-CONGELATO già operativo ──────
console.log("\n── 2. rider tornato prima NON anticipa il semi-congelato ──");
{
  // O: EN_COCINA, salida committata 20:35 (rider era impegnato); partTeorica 20:30.
  const O = { id: "O", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "20:40", andata_min: 10, n_pizze: 1, forno_out: "20:35", salida_driver_estimada: "20:35", entrega_estimada: "20:40" };
  const plan = buildPlan({ now: "20:00", driver_events: [{ type: "rider_returned", at: "20:24", source: "operator_button" }], orders: [O] });
  check("O resta SEMI_CONGELATO", plan.orders.O.freeze === "SEMI_CONGELATO");
  check("O NON anticipato: salida resta 20:35 (non 20:24/20:30)", plan.orders.O.salida === "20:35", plan.orders.O.salida);
  check("reason: semi-congelato protetto dal tempo recuperato", plan.orders.O.reasons.some(r => r.includes("protetto")), JSON.stringify(plan.orders.O.reasons));
}

// ── 3. Driver returns late → propaga il ritardo a nuovi/futuri movibili + warning ─
console.log("\n── 3. rider tornato tardi propaga il ritardo ──");
{
  const plan = buildPlan({ now: "20:00", driver_events: [{ type: "rider_returned", at: "20:38", source: "operator_button" }], orders: [ord({ id: "N", zona: "Q1", hora: "20:30", andata_min: 5 })] });
  check("movibile slitta a 20:38 (rider disponibile tardi)", plan.orders.N.salida === "20:38", plan.orders.N.salida);
  check("retraso esposto (>0)", plan.orders.N.retraso > 0, String(plan.orders.N.retraso));
  check("warning rider event applicato", plan.warnings.some(w => w.includes("rider event")), JSON.stringify(plan.warnings));
}

// ── 4. Operator button: source/confidence/reason conservati ─────────────────────
console.log("\n── 4. source operator_button ──");
{
  const plan = buildPlan({ now: "20:00", driver_events: [{ type: "rider_returned", at: "20:24", source: "operator_button" }], orders: [] });
  check("source = operator_button", plan.driver.source === "operator_button", plan.driver.source);
  check("confidence = 0.8 + real_event true", plan.driver.confidence === 0.8 && plan.driver.real_event === true, JSON.stringify(plan.driver));
  check("reason tracciata", typeof plan.driver.reason === "string" && plan.driver.reason.length > 0, plan.driver.reason);
}

// ── 5. Driver app: evento reale più affidabile (confidence > operator_button) ────
console.log("\n── 5. source driver_app più affidabile ──");
{
  const app = buildPlan({ now: "20:00", driver_status: { available_from: "20:24", source: "driver_app" }, orders: [] });
  const opb = buildPlan({ now: "20:00", driver_status: { available_from: "20:24", source: "operator_button" }, orders: [] });
  check("driver_app confidence 0.95", app.driver.confidence === 0.95, String(app.driver.confidence));
  check("driver_app > operator_button (più affidabile)", app.driver.confidence > opb.driver.confidence);
  check("driver_app usato come disponibilità reale", app.driver.available_from === "20:24" && app.driver.real_event === true);
}

// ── 6. Soft oven overload: cap 4, carico 5 → warning soft, NIENTE shift ─────────
console.log("\n── 6. soft oven overload (5/4) ──");
{
  const plan = buildPlan({ now: "17:00", orders: [
    { id: "RIT", tipo_consegna: "RITIRO", estado: "NUEVO", hora: "20:00", n_pizze: 4 },
    ord({ id: "DOM", zona: "Q1", hora: "20:05", andata_min: 5, n_pizze: 1 }),
  ]});
  const trip = plan.trips.find(t => t.id.includes("Q1"));
  check("carico slot 20:00 = 5 (soft)", plan.ovenLoad[1200] === 5, String(plan.ovenLoad[1200]));
  check("NESSUNO shift automatico: forno_out resta 20:00", plan.orders.DOM.forno_out === "20:00", plan.orders.DOM.forno_out);
  check("warning forno_soft_overload (non forno_pieno)", trip.warnings.includes("forno_soft_overload") && !trip.warnings.includes("forno_pieno"), JSON.stringify(trip.warnings));
}

// ── 7. Hard oven overload: cap 4, carico 8/9 → forno_pieno + shift ──────────────
console.log("\n── 7. hard oven overload (9/4) ──");
{
  const plan = buildPlan({ now: "17:00", orders: [
    { id: "RIT", tipo_consegna: "RITIRO", estado: "NUEVO", hora: "20:00", n_pizze: 8 },
    ord({ id: "DOM", zona: "Q1", hora: "20:05", andata_min: 5, n_pizze: 1 }),
  ]});
  const trip = plan.trips.find(t => t.id.includes("Q1"));
  check("hard overload: delivery SPOSTATO a 20:10", plan.orders.DOM.forno_out === "20:10", plan.orders.DOM.forno_out);
  check("warning forno_pieno (hard)", trip.warnings.includes("forno_pieno"), JSON.stringify(trip.warnings));
  check("dopo lo shift lo slot 20:00 resta a 8 (giro non aggiunto lì)", plan.ovenLoad[1200] === 8, String(plan.ovenLoad[1200]));
}

// ── 7-bis. Overload serio (6–7) → warning serio, ancora niente shift ────────────
console.log("\n── 7b. overload serio (7/4) ──");
{
  const plan = buildPlan({ now: "17:00", orders: [
    { id: "RIT", tipo_consegna: "RITIRO", estado: "NUEVO", hora: "20:00", n_pizze: 6 },
    ord({ id: "DOM", zona: "Q1", hora: "20:05", andata_min: 5, n_pizze: 1 }),
  ]});
  const trip = plan.trips.find(t => t.id.includes("Q1"));
  check("serio (7): niente shift, forno_out 20:00", plan.orders.DOM.forno_out === "20:00", plan.orders.DOM.forno_out);
  check("warning forno_overload_serio", trip.warnings.includes("forno_overload_serio"), JSON.stringify(trip.warnings));
}

// ── 8. Buffer driver default = 3 ────────────────────────────────────────────────
console.log("\n── 8. buffer driver default 3 ──");
{
  check("DEFAULTS.bufferOpsDriverMin === 3", _internal.DEFAULTS.bufferOpsDriverMin === 3, String(_internal.DEFAULTS.bufferOpsDriverMin));
  const plan = buildPlan({ now: "17:00", orders: [ord({ id: "A", zona: "Q1", hora: "20:00", andata_min: 5 })] });
  check("config riflette buffer 3", plan.config.bufferOpsDriverMin === 3, String(plan.config.bufferOpsDriverMin));
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
