// tests/deliveryPlannerSyntheticStress.test.js
// ===============================================================
// SYNTHETIC STRESS — Delivery Planner rev.5 · task SYNTHETIC-STRESS-PLANNER-09
// Run: node tests/deliveryPlannerSyntheticStress.test.js
// ===============================================================
// Scenari controllati con dati FAKE (nessun cliente/PII/DB/rete) per coprire casi
// che i backup reali non coprono bene o coprono con dati sporchi (Q5 cache-street).
// Assertion ROBUSTE: invarianti universali + presenza warning/aggregation attesi,
// non uguaglianze fragili sul minuto. Single-rider V1 (no multi-rider).
// ===============================================================
"use strict";
const { buildPlan, evaluateNewOrder } = require("../src/core/delivery/planner");
const F = require("./fixtures/deliveryPlannerSyntheticStress");
const { mkDelivery, mkPickup, toMin } = F;

let pass = 0, fail = 0;
const results = [];
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
// invarianti universali su un plan
function invariants(tag, plan, orders) {
  const a = F.assertNoInvalidTimes(plan);
  const b = F.assertNoDriverBeforePizza(plan);
  const c = F.assertNoRiderOverlap(plan);
  const d = F.assertEntregaCoherent(plan, orders);
  check(`${tag} · no invalid times (24/25, formato)`, a.ok, JSON.stringify(a.bad));
  check(`${tag} · no salida < forno_out`, b.ok, JSON.stringify(b.bad));
  check(`${tag} · no rider overlap`, c.ok, JSON.stringify(c.overlaps));
  check(`${tag} · entrega = forno_out + andata`, d.ok, JSON.stringify(d.bad));
  return a.ok && b.ok && c.ok && d.ok;
}

// ===============================================================
console.log("\n══ Scenario A — single rider base realistico ══");
{
  const orders = [
    mkDelivery({ id: "TEST_SYN_Q1_A", zona: "Q1", hora: "20:00", andata_min: 4 }),
    mkDelivery({ id: "TEST_SYN_Q2_A", zona: "Q2", hora: "20:30", andata_min: 7 }),
    mkDelivery({ id: "TEST_SYN_Q5_A", zona: "Q5", hora: "21:00", andata_min: 13 }),
  ];
  const plan = buildPlan({ now: "19:00", orders });
  const okInv = invariants("A", plan, orders);
  check("A · 3 giri sequenziati (un rider)", plan.trips.length === 3);
  results.push(["A", "Single rider base", okInv ? "PASS" : "FAIL", "no overlap, sequenziati"]);
}

// ===============================================================
console.log("\n══ Scenario B — Marina/Q5 aggregation realistica ══");
{
  // Giro Q5 anchor esistente (hora 21:30, andata 13 → parte ~21:17).
  const anchor = mkDelivery({ id: "TEST_SYN_Q5_ANCHOR", zona: "Q5", hora: "21:30", andata_min: 13 });
  const snapshot = { now: "19:00", orders: [anchor], zones: { Q5: { maxOrdiniPerGiro: 3 } } };

  // (1) Q5 compatibile: stessa hora → pizza pronta entro la partenza del giro.
  const compat = evaluateNewOrder(snapshot, mkDelivery({ id: "TEST_SYN_Q5_COMPAT", zona: "Q5", hora: "21:30", andata_min: 13 }));
  const joinCompat = compat.options.find((o) => o.type === "join_giro");
  const compatOk = !!joinCompat && (joinCompat.status === "valid" || joinCompat.status === "recommended") && !joinCompat.no_agregable;
  check("B · Q5 compatibile → aggregabile (join valido/recommended)", compatOk, JSON.stringify(joinCompat));

  // (2) Q5 troppo tardi per QUEL giro: hora 22:10 → forno naturale 21:57 ≫ partenza giro.
  const late = evaluateNewOrder(snapshot, mkDelivery({ id: "TEST_SYN_Q5_LATE", zona: "Q5", hora: "22:10", andata_min: 13 }));
  const joinLate = late.options.find((o) => o.type === "join_giro");
  check("B · Q5 troppo tardi → No agregable su quel giro", !!joinLate && joinLate.no_agregable === true, JSON.stringify(joinLate));
  check("B · Q5 troppo tardi → separata comunque proposta", !!late.options.find((o) => o.type === "separate"));

  // (3) round trip realistico Marina ≈ 30 min (andata 13 + buffer 3 + ritorno 13 = 29).
  const plan = buildPlan(snapshot);
  const t = F.findTripByZone(plan, "Q5");
  const rt = toMin(t.rientro) - toMin(t.departure);
  check("B · round trip Q5 realistico ≈ 30 min (no +45 falso)", rt >= 25 && rt <= 33, `rt=${rt}`);
  results.push(["B", "Q5 aggregation realistica", (compatOk && joinLate?.no_agregable) ? "PASS" : "FAIL", `round trip ${rt}m`]);
}

// ===============================================================
console.log("\n══ Scenario C — Marina/Q5 dirty geo (cache-street) ══");
{
  const dirty = mkDelivery({ id: "TEST_SYN_Q5_DIRTY", zona: "Q5", hora: "21:30", andata_min: 28, geo_source: "cache-street", durata_google_min: null, durata_haversine_min: 28 });
  const clean = mkDelivery({ id: "TEST_SYN_Q5_CLEAN", zona: "Q5", hora: "21:30", andata_min: 13, geo_source: "google", durata_google_min: 13, durata_haversine_min: 23 });
  const planDirty = buildPlan({ now: "19:00", orders: [dirty] });
  const planClean = buildPlan({ now: "19:00", orders: [clean] });
  const okInv = invariants("C", planDirty, [dirty]);
  const tD = F.findTripByZone(planDirty, "Q5"), tC = F.findTripByZone(planClean, "Q5");
  const rtD = toMin(tD.rientro) - toMin(tD.departure), rtC = toMin(tC.rientro) - toMin(tC.departure);
  // Il core NON consuma geo_source: il dato sporco (28) gonfia il round trip vs pulito (13).
  check("C · dato sporco gonfia il round trip vs pulito (input-driven)", rtD > rtC + 20, `dirty ${rtD} vs clean ${rtC}`);
  check("C · planner resta valido anche con dato sporco (no crash/invarianti rotte)", okInv);
  // BACKLOG documentato: nessun flag dirty_geo nel core; non si patcha qui.
  results.push(["C", "Q5 dirty geo", "PASS (gap documentato)", `rt dirty ${rtD} vs clean ${rtC}; no dirty_geo flag → backlog`]);
}

// ===============================================================
console.log("\n══ Scenario D — Forno overload graduato ══");
{
  // Stesso slot (zona+hora) → pizze sommate in un solo giro/slot.
  function slotPlan(totPizze, n = 1) {
    const orders = [];
    for (let i = 0; i < n; i++) orders.push(mkDelivery({ id: `TEST_SYN_OVEN_${totPizze}_${i}`, zona: "Q1", hora: "20:30", andata_min: 4, n_pizze: Math.ceil(totPizze / n) }));
    return buildPlan({ now: "19:00", orders });
  }
  const p4 = buildPlan({ now: "19:00", orders: [mkDelivery({ id: "OV4", zona: "Q1", hora: "20:30", andata_min: 4, n_pizze: 4 })] });
  const p5 = buildPlan({ now: "19:00", orders: [mkDelivery({ id: "OV5", zona: "Q1", hora: "20:30", andata_min: 4, n_pizze: 5 })] });
  const p7 = buildPlan({ now: "19:00", orders: [mkDelivery({ id: "OV7", zona: "Q1", hora: "20:30", andata_min: 4, n_pizze: 7 })] });
  const p9 = buildPlan({ now: "19:00", orders: [mkDelivery({ id: "OV9", zona: "Q1", hora: "20:30", andata_min: 4, n_pizze: 9 })] });
  check("D · 4/slot → nessun warning overload", F.findWarnings(p4, "forno_soft_overload").length === 0 && F.findWarnings(p4, "forno_overload_serio").length === 0 && F.findWarnings(p4, "forno_pieno").length === 0);
  check("D · 5/slot → forno_soft_overload", F.findWarnings(p5, "forno_soft_overload").length > 0);
  check("D · 6–7/slot → forno_overload_serio", F.findWarnings(p7, "forno_overload_serio").length > 0);
  check("D · 8+/slot → forno_pieno (hard)", F.findWarnings(p9, "forno_pieno").length > 0);
  check("D · forno non promette l'impossibile (invarianti)", F.assertNoInvalidTimes(p9).ok && F.assertNoDriverBeforePizza(p9).ok);
  results.push(["D", "Forno overload graduato", "PASS", "soft 5 / serio 6-7 / hard 8+"]);
}

// ===============================================================
console.log("\n══ Scenario E — Ritiro occupa forno ══");
{
  const orders = [
    mkPickup({ id: "TEST_SYN_RIT_1", hora: "20:30", n_pizze: 3 }),
    mkPickup({ id: "TEST_SYN_RIT_2", hora: "20:30", n_pizze: 3 }),
    // delivery che compete per LO STESSO slot forno dei ritiri (parte 20:36 → slot 20:30).
    mkDelivery({ id: "TEST_SYN_DEL_Q1", zona: "Q1", hora: "20:40", andata_min: 4, n_pizze: 2 }),
  ];
  const plan = buildPlan({ now: "19:00", orders });
  const okInv = invariants("E", plan, orders);
  const ovenTot = F.ovenSlotLoads(plan).reduce((s, v) => s + v, 0);
  const pizzeTot = orders.reduce((s, o) => s + (o.n_pizze || 0), 0);
  check("E · ritiri occupano forno: Σ ovenLoad == Σ pizze (dom+rit)", ovenTot === pizzeTot, `${ovenTot} vs ${pizzeTot}`);
  check("E · forno carico ⇒ warning overload presente", F.findWarnings(plan, "forno").length > 0);
  results.push(["E", "Ritiro occupa forno", okInv ? "PASS" : "FAIL", `Σpizze ${pizzeTot} contate nel forno`]);
}

// ===============================================================
console.log("\n══ Scenario F — After midnight ══");
{
  const orders = [
    mkDelivery({ id: "TEST_SYN_PRE_MN", zona: "Q1", hora: "23:45", andata_min: 4 }),
    mkDelivery({ id: "TEST_SYN_AFTER_MIDNIGHT", zona: "Q5", hora: "00:05", andata_min: 13 }),
    mkPickup({ id: "TEST_SYN_PICKUP_MN", hora: "00:10", n_pizze: 1 }),
  ];
  const plan = buildPlan({ now: "23:30", orders });
  const okInv = invariants("F", plan, orders);
  const any2425 = Object.values(plan.orders).some((p) => [p.forno_out, p.salida, p.entrega].some((t) => /^(24|25):/.test(String(t || ""))));
  check("F · nessun 24:XX / 25:XX", !any2425);
  check("F · timeline coerente dopo mezzanotte (invarianti)", okInv);
  results.push(["F", "After midnight", okInv && !any2425 ? "PASS" : "FAIL", "no 24/25, no clamp falso"]);
}

// ===============================================================
console.log("\n══ Scenario G — Rider events / rider returned ══");
{
  // semi-congelato già in cucina con salida committata (non va anticipato).
  const semi = mkDelivery({ id: "TEST_SYN_SEMI", zona: "Q1", hora: "20:30", andata_min: 4, estado: "EN_COCINA", forno_out: "20:26", salida_driver_estimada: "20:26", entrega_estimada: "20:30" });
  const future = mkDelivery({ id: "TEST_SYN_FUTURE", zona: "Q1", hora: "21:30", andata_min: 4 });
  const snapshot = {
    now: "20:00", orders: [semi, future],
    driver_events: [{ type: "rider_returned", at: "20:10", source: "operator_button" }],
  };
  const plan = buildPlan(snapshot);
  const okInv = invariants("G", plan, [semi, future]);
  check("G · evento reale registrato (driver.real_event)", plan.driver && plan.driver.real_event === true && plan.driver.available_from === "20:10");
  check("G · warning 'rider event applicato' presente", F.findWarnings(plan, "rider event applicato").length > 0);
  const semiProj = plan.orders["TEST_SYN_SEMI"];
  check("G · semi-congelato NON anticipato sotto la salida committata", toMin(semiProj.salida) >= toMin("20:26"), `salida ${semiProj.salida}`);
  results.push(["G", "Rider events", okInv ? "PASS" : "FAIL", "evento migliora futuro, non riscrive passato"]);
}

// ===============================================================
console.log("\n══ Scenario H — Semi-congelati / congelati ══");
{
  const enCocina = mkDelivery({ id: "TEST_SYN_ENCOCINA", zona: "Q1", hora: "20:20", andata_min: 4, estado: "EN_COCINA", forno_out: "20:16", salida_driver_estimada: "20:16", entrega_estimada: "20:20" });
  const listo = mkDelivery({ id: "TEST_SYN_LISTO", zona: "Q1", hora: "20:10", andata_min: 4, estado: "LISTO", forno_out: "20:06", salida_driver_estimada: "20:06", entrega_estimada: "20:10" });
  const enEntrega = mkDelivery({ id: "TEST_SYN_ENENTREGA", zona: "Q2", hora: "20:00", andata_min: 7, estado: "EN_ENTREGA", forno_out: "19:53", salida_driver_estimada: "19:53", entrega_estimada: "20:00" });
  const movible = mkDelivery({ id: "TEST_SYN_MOVIBLE", zona: "Q1", hora: "21:00", andata_min: 4 });
  const orders = [enCocina, listo, enEntrega, movible];
  const plan = buildPlan({ now: "20:00", orders });
  const okInv = invariants("H", plan, orders);
  const pL = plan.orders["TEST_SYN_LISTO"], pE = plan.orders["TEST_SYN_ENENTREGA"];
  check("H · congelato LISTO non spostato (forno_out committato)", pL.forno_out === "20:06" && /congelato duro/.test(pL.reasons.join(" ")));
  check("H · EN_ENTREGA non spostato (forno_out committato)", pE.forno_out === "19:53");
  check("H · movibile pianificato attorno ai vincoli", !!plan.orders["TEST_SYN_MOVIBLE"].forno_out);
  results.push(["H", "Semi/congelati", okInv ? "PASS" : "FAIL", "congelati non mossi"]);
}

// ===============================================================
console.log("\n══ Scenario I — Manual route multi-zona (rider block) ══");
{
  const m1 = mkDelivery({ id: "TEST_SYN_MR_Q1", zona: "Q1", hora: "21:00", andata_min: 4, manual_giro_id: "MR1" });
  const m2 = mkDelivery({ id: "TEST_SYN_MR_Q2", zona: "Q2", hora: "21:00", andata_min: 7, manual_giro_id: "MR1" });
  const m3 = mkDelivery({ id: "TEST_SYN_MR_Q5", zona: "Q5", hora: "21:00", andata_min: 13, manual_giro_id: "MR1" });
  const snapshot = {
    now: "20:00",
    manual_giros: [{ id: "MR1", type: "manual_route", order_ids: ["TEST_SYN_MR_Q1", "TEST_SYN_MR_Q2", "TEST_SYN_MR_Q5"], block_start: "21:00", manual_duration_min: 25 }],
    orders: [m1, m2, m3],
  };
  const plan = buildPlan(snapshot);
  const okInv = invariants("I", plan, [m1, m2, m3]);
  check("I · 1 rider block creato (blocco unico)", (plan.blocks || []).length === 1);
  const blk = plan.blocks[0];
  check("I · block ha start/end (occupa il rider come blocco)", !!blk && !!blk.block_start && !!blk.block_end);
  check("I · i 3 ordini multi-zona stanno nel block", ["TEST_SYN_MR_Q1", "TEST_SYN_MR_Q2", "TEST_SYN_MR_Q5"].every((id) => plan.orders[id] && plan.orders[id].rider_block === "MR1" && plan.orders[id].giro_id === "BLK:MR1"));
  // nuovo delivery la cui partenza desiderata cade dentro il block → conflitto/override.
  const ev = evaluateNewOrder(snapshot, mkDelivery({ id: "TEST_SYN_MR_NEW", zona: "Q1", hora: "21:10", andata_min: 4 }));
  const sep = ev.options.find((o) => o.type === "separate");
  const joinBlock = ev.options.find((o) => o.type === "join_block");
  check("I · nuovo ordine dentro il block → separata spinta dopo il block o join_block override",
    (sep && sep.blocked_by_rider_block === true) || (joinBlock && joinBlock.requires_override === true), JSON.stringify({ sep: sep?.blocked_by_rider_block, jb: joinBlock?.requires_override }));
  results.push(["I", "Manual route multi-zona", okInv ? "PASS" : "FAIL", "block unico, conflitto gestito"]);
}

// ===============================================================
console.log("\n══ Scenario J — Forzatura operatore ══");
{
  const forced = mkDelivery({ id: "TEST_SYN_FORCED", zona: "Q5", hora: "20:30", andata_min: 13, forzado: true, forzado_hora: "20:30" });
  const plan = buildPlan({ now: "19:00", orders: [forced] });
  const okInv = invariants("J", plan, [forced]);
  const p = plan.orders["TEST_SYN_FORCED"];
  check("J · planner rispetta/segnala la forzatura", p.forzado === true && /forzato/.test(p.reasons.join(" ")));
  results.push(["J", "Forzatura operatore", okInv ? "PASS" : "FAIL", "forzado tracciato + reason"]);
}

// ===============================================================
console.log("\n────────── RIEPILOGO SCENARI ──────────");
for (const [k, scope, res, note] of results) console.log(`  ${k} · ${scope} → ${res} · ${note}`);
console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
