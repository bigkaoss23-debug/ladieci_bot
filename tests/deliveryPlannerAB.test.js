// tests/deliveryPlannerAB.test.js
// ===============================================================
// A/B READ-ONLY — vecchia logica (src/utils/zones.js) vs nuovo planner
// (src/core/delivery/planner.js). Tutto su FIXTURE STATICHE.
// Run: node tests/deliveryPlannerAB.test.js
// ===============================================================
// LABORATORIO. Nessun DB, nessun Supabase, nessun network, nessuna scrittura.
//   - Le funzioni vecchie importate da zones.js (calcolaFornoOut,
//     simulateDriverSchedule, computeDriverFields, proposeForNewOrder) sono PURE:
//     zones.js non ha require top-level e i soli fetch vivono dentro le funzioni
//     di geocoding, che qui NON vengono mai chiamate.
//   - Il nuovo planner è già puro/isolato.
//   - Il vecchio sistema NON conosce il rider block multi-zona (manual_giros è solo
//     grouping e NON tocca forno_out): per quelle fixture OLD = N/A (capability gap).
//
// Questo file NON è importato da produzione e non collega il planner a nessun endpoint.
// ===============================================================

"use strict";
const assert = require("assert");

// NUOVO (isolato)
const { buildPlan, evaluateNewOrder } = require("../src/core/delivery/planner");
// VECCHIO (pure, read-only)
const {
  calcolaFornoOut,
  simulateDriverSchedule,
  computeDriverFields,
  proposeForNewOrder,
} = require("../src/utils/zones");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`    ✓ ${label}`); }
  else { fail++; console.log(`    ✗ ${label} ${extra}`); }
}
const ord = (o) => ({ tipo_consegna: "DOMICILIO", estado: "NUEVO", n_pizze: 1, ...o });
const j = (x) => JSON.stringify(x);

// Tabellina A/B leggibile a fine file.
const AB = [];
function row(caso, vecchio, nuovo, differenza, verdict) {
  AB.push({ caso, vecchio, nuovo, differenza, verdict });
}

// ===============================================================
// FIXTURE 1 — #001 / #002 Q1, stessa hora 20:00, andate 1 e 4
// ===============================================================
console.log("\n── AB1. #001/#002 Q1 (andate 1 e 4) ──");
{
  const o1 = ord({ id: "#001", zona: "Q1", hora: "20:00", andata_min: 1, durata_andata_min: 1 });
  const o2 = ord({ id: "#002", zona: "Q1", hora: "20:00", andata_min: 4, durata_andata_min: 4 });

  // VECCHIO: forno_out per-ordine (hora − andata) → diverge; salida da computeDriverFields.
  const foOld1 = calcolaFornoOut({ tipoConsegna: "DOMICILIO", hora: "20:00", durataAndataMin: 1 }).forno_out;
  const foOld2 = calcolaFornoOut({ tipoConsegna: "DOMICILIO", hora: "20:00", durataAndataMin: 4 }).forno_out;
  const dfOld = computeDriverFields([o1, o2]);
  const salOld1 = dfOld.get("#001")?.salida_driver_estimada;

  // NUOVO
  const plan = buildPlan({ now: "17:00", orders: [o1, o2] });
  const a = plan.orders["#001"], b = plan.orders["#002"];

  console.log(`    OLD forno_out: #001=${foOld1} #002=${foOld2} · salida#001=${salOld1}`);
  console.log(`    NEW forno_out: #001=${a.forno_out} #002=${b.forno_out} · salida#001=${a.salida}`);

  check("OLD: forno_out diverge tra i due ordini (bug #001)", foOld1 !== foOld2, `${foOld1} vs ${foOld2}`);
  check("OLD: forno_out(#001) ≠ salida(#001) (contraddizione)", foOld1 !== salOld1, `${foOld1} vs ${salOld1}`);
  check("NEW: forno_out condiviso = salida (I8)", a.forno_out === b.forno_out && a.forno_out === a.salida, `${a.forno_out}/${a.salida}`);

  row("1 · #001/#002 Q1",
    `forno_out 19:59 vs 19:56; salida 19:56 → contraddizione`,
    `forno_out=salida=${a.forno_out} per entrambi`,
    "OLD spezza forno_out per-ordine, NEW lo lega alla partenza giro",
    "MIGLIORAMENTO");
}

// ===============================================================
// FIXTURE 2 — Q5 cluster reale: 3 ordini promessa 20:35, rider parte tardi
// ===============================================================
console.log("\n── AB2. Q5 cluster (promessa 20:35, rider 20:37) ──");
{
  const q = (id, a) => ord({ id, zona: "Q5", hora: "20:35", andata_min: a, durata_andata_min: a });
  const orders = [q("Q5a", 12), q("Q5b", 13), q("Q5c", 14)];

  // VECCHIO: computeDriverFields NON applica un pavimento rider live → retraso spesso 0.
  const dfOld = computeDriverFields(orders);
  const retrOld = orders.map(o => dfOld.get(o.id)?.retraso_estimado_min ?? 0);

  // NUOVO: rider realmente libero alle 20:37 → ritardo reale esposto (I9).
  const plan = buildPlan({ now: "17:00", driver: { libero_desde: "20:37" }, orders });
  const retrNew = orders.map(o => plan.orders[o.id].retraso);
  const win = plan.trips[0].delivery_window;

  console.log(`    OLD retraso: ${j(retrOld)}`);
  console.log(`    NEW retraso: ${j(retrNew)} · delivery_window=${j(win)}`);

  check("OLD: retraso tutto 0 (window cosmetica assorbe)", retrOld.every(r => r === 0), j(retrOld));
  check("NEW: retraso reale > 0 esposto (I9)", retrNew.some(r => r > 0), j(retrNew));
  check("NEW: delivery_window reale ritardata", win[1] > "20:45", j(win));

  row("2 · Q5 cluster",
    `retraso 0/0/0 (consegna = partenza+tg = hora)`,
    `retraso ${j(retrNew)}, window ${j(win)}`,
    "OLD nasconde il ritardo (niente pavimento rider live), NEW lo mostra",
    "MIGLIORAMENTO");
}

// ===============================================================
// FIXTURE 3 — No agregable (pizza pronta dopo la partenza del giro)
// ===============================================================
console.log("\n── AB3. No agregable ──");
{
  const snap = { now: "17:30", orders: [ord({ id: "G1", zona: "Q2", hora: "17:55", andata_min: 6, durata_andata_min: 6, estado: "EN_COCINA" })] };
  const newO = ord({ id: "NEW", zona: "Q2", hora: "18:15", andata_min: 6, durata_andata_min: 6 });

  // VECCHIO
  const propOld = proposeForNewOrder(snap.orders, { hora: "18:15", zona: "Q2", durata_andata_min: 6 }, { nowMin: 17 * 60 + 30 });
  // NUOVO
  const v = evaluateNewOrder(snap, newO);
  const join = v.options.find(o => o.type === "join_giro");

  console.log(`    OLD propose: ok=${propOld.ok} aggregato=${propOld.aggregato} motivo="${propOld.motivo}"`);
  console.log(`    NEW join: status=${join?.status} no_agregable=${join?.no_agregable} reason="${join?.reason}"`);

  check("OLD: non aggrega (separata)", propOld.aggregato === false, j(propOld.aggregato));
  check("NEW: join esplicitamente blocked + no_agregable", join && join.status === "blocked" && join.no_agregable === true, j(join));

  row("3 · No agregable",
    `aggregato=false, propone separata (nessun motivo 'no agregable' esplicito)`,
    `join_giro blocked + no_agregable + reason`,
    "NEW dà l'etichetta esplicita 'No agregable' con causa",
    "MIGLIORAMENTO (semantica)");
}

// ===============================================================
// FIXTURE 4 — Usar giro valido (pizza pronta prima della partenza)
// ===============================================================
console.log("\n── AB4. Usar giro valido ──");
{
  const snap = { now: "17:30", orders: [ord({ id: "G1", zona: "Q2", hora: "17:55", andata_min: 6, durata_andata_min: 6, estado: "EN_COCINA" })] };
  const newO = ord({ id: "NEW", zona: "Q2", hora: "17:53", andata_min: 6, durata_andata_min: 6 });

  const propOld = proposeForNewOrder(snap.orders, { hora: "17:53", zona: "Q2", durata_andata_min: 6 }, { nowMin: 17 * 60 + 30 });
  const v = evaluateNewOrder(snap, newO);
  const join = v.options.find(o => o.type === "join_giro");

  console.log(`    OLD propose: aggregato=${propOld.aggregato} (slot10 bucket-equality)`);
  console.log(`    NEW join: status=${join?.status} recommended=${j(v.recommended?.type)}`);

  // OLD aggrega solo se slot10(17:53) === slot10(17:55): round-to-10 → 17:50 vs 18:00 → NON aggrega.
  check("NEW: raccomanda usar giro (join valido)", join && join.status === "recommended", j(join?.status));
  check("NEW: recommended = join_giro", v.recommended && v.recommended.type === "join_giro", j(v.recommended));

  row("4 · Usar giro",
    `aggrega solo se stesso slot10(round) → 17:53/17:55 in slot diversi: NON aggrega`,
    `join_giro recommended (feasibility al minuto reale)`,
    "OLD su bucket slot10 arrotondato; NEW su prontezza reale ≤ partenza",
    propOld.aggregato ? "PARITÀ" : "MIGLIORAMENTO (aggregazione più fine)");
}

// ===============================================================
// FIXTURE 5 — Manual route multi-zona 15 min (Q1/Q2/Q5)
// ===============================================================
console.log("\n── AB5. Manual route multi-zona (rider block) ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{ id: "mg1", type: "manual_route", order_ids: ["A", "B", "C"], route_order: ["A", "B", "C"], block_start: "20:00", manual_duration_min: 15, force: true }],
    orders: [
      ord({ id: "A", zona: "Q1", hora: "20:10", andata_min: 4 }),
      ord({ id: "B", zona: "Q2", hora: "20:10", andata_min: 8 }),
      ord({ id: "C", zona: "Q5", hora: "20:10", andata_min: 12 }),
    ],
  });
  const blk = plan.blocks[0];

  console.log(`    OLD: manual_giros = solo grouping (order_ids/hora_ref), NON tocca forno_out, niente multi-zona/durata/block → N/A`);
  console.log(`    NEW: block ${blk.id} ${blk.block_start}–${blk.block_end} zones=${j(blk.zones)} count=${blk.count}`);

  check("NEW: un solo rider block", plan.blocks.length === 1 && plan.trips.length === 1);
  check("NEW: nessun trip separato per zona", plan.trips.every(t => t.type === "manual_route"));
  check("NEW: rider timeline occupata (no overlap)", plan.rider_overlaps.length === 0);

  row("5 · Manual route multi-zona",
    `non rappresentabile (manual_giros = grouping, no durata/block, no multi-zona)`,
    `rider block unico ${blk.block_start}–${blk.block_end}, 3 zone, timeline occupata`,
    "capability nuova",
    "NUOVA CAPACITÀ");
}

// ===============================================================
// FIXTURE 6 — Ritiro occupa forno, delivery nello stesso slot
// ===============================================================
console.log("\n── AB6. Ritiro occupa forno ──");
{
  const orders = [
    { id: "RIT", tipo_consegna: "RITIRO", estado: "NUEVO", hora: "20:00", n_pizze: 4 },
    ord({ id: "DOM", zona: "Q1", hora: "20:05", andata_min: 5, n_pizze: 1 }),
  ];

  // VECCHIO: calcolaFornoOut non modella capacità forno; il ritiro non spinge il delivery.
  const foOldDom = calcolaFornoOut({ tipoConsegna: "DOMICILIO", hora: "20:05", durataAndataMin: 5 }).forno_out;

  // NUOVO: capacità slot 4/10min condivisa con i ritiri → delivery spinto + warning.
  const plan = buildPlan({ now: "17:00", orders });
  const trip = plan.trips.find(t => t.id.includes("Q1"));

  console.log(`    OLD forno_out DOM = ${foOldDom} (ignora i 4 pizze del ritiro nello slot 20:00)`);
  console.log(`    NEW forno_out DOM = ${plan.orders.DOM.forno_out} · warning=${j(trip?.warnings)}`);

  check("OLD: forno_out DOM = 20:00 (nessuna capacità forno)", foOldDom === "20:00", foOldDom);
  check("NEW: delivery spinto a 20:10 per forno pieno", plan.orders.DOM.forno_out === "20:10", plan.orders.DOM.forno_out);
  check("NEW: warning forno_pieno", trip && trip.warnings.includes("forno_pieno"), j(trip?.warnings));

  row("6 · Ritiro occupa forno",
    `forno_out DOM=20:00 (capacità slot non modellata)`,
    `forno_out DOM=20:10 + warning forno_pieno`,
    "OLD ignora capacità forno (over-allocazione silenziosa); NEW la rispetta",
    "MIGLIORAMENTO");
}

// ===============================================================
// FIXTURE 7 — Modifica ordine dentro manual route (+30 min)
// ===============================================================
console.log("\n── AB7. Modifica ordine dentro block (+30) ──");
{
  const plan = buildPlan({
    now: "19:00",
    manual_giros: [{ id: "mg5", type: "manual_route", order_ids: ["P", "Q"], block_start: "20:00", manual_duration_min: 15 }],
    orders: [
      ord({ id: "P", zona: "Q1", hora: "20:10", andata_min: 4 }),
      ord({ id: "Q", zona: "Q2", hora: "20:40", andata_min: 8 }), // hora spostata +30
    ],
  });
  const blk = plan.blocks[0];
  const acts = blk.options.map(o => o.action);

  console.log(`    OLD: nessun concetto di block → N/A`);
  console.log(`    NEW: coherent=${blk.coherent} status=${blk.status} issues=${j(blk.issues.map(i => i.type))} options=${j(acts)}`);

  check("NEW: block incoerente", blk.coherent === false);
  check("NEW: issue orden_desfasada", blk.issues.some(i => i.type === "orden_desfasada"));
  check("NEW: options remove/move/force/ask", ["quitar_orden", "mover_bloque", "mantener_forzado", "preguntar_operador"].every(a => acts.includes(a)), j(acts));

  row("7 · Modifica dentro block",
    `non rappresentabile (no block)`,
    `incoerente + options quitar/mover/forzar/preguntar`,
    "capability nuova (gestione coerenza modifiche)",
    "NUOVA CAPACITÀ");
}

// ── Tabella A/B finale ────────────────────────────────────────────────────────
console.log("\n\n══════════════ TABELLA A/B (vecchio vs nuovo) ══════════════");
for (const r of AB) {
  console.log(`\n• Caso ${r.caso}`);
  console.log(`   VECCHIO  : ${r.vecchio}`);
  console.log(`   NUOVO    : ${r.nuovo}`);
  console.log(`   DIFFERENZA: ${r.differenza}`);
  console.log(`   VERDICT  : ${r.verdict}`);
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
