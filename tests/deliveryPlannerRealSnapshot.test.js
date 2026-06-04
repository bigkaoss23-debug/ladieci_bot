// tests/deliveryPlannerRealSnapshot.test.js
// ===============================================================
// A/B READ-ONLY su SNAPSHOT REALE — serata 2026-05-31 (LaDieci10App)
// Run: node tests/deliveryPlannerRealSnapshot.test.js
// ===============================================================
// Confronta:
//   - VECCHIO: forno_out REALE persistito (backup_serata) + driver fields
//     RICOSTRUITI con le funzioni pure di zones.js (computeDriverFields).
//   - NUOVO:   buildPlan(snapshot) isolato.
// Tutto su fixture statica (nessuna query live qui dentro). Nessuna scrittura.
//
// Replay: gli ordini archiviati (RETIRADO) sono ripianificati come FATTI GREZZI
// (estado NUEVO) con un `now` iniziale, per simulare la pianificazione in serata.
// ===============================================================

"use strict";
const { buildPlan } = require("../src/core/delivery/planner");
const { computeDriverFields } = require("../src/utils/zones");
const fix = require("./fixtures/deliveryPlannerRealSnapshot20260531");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`    ✓ ${label}`); }
  else { fail++; console.log(`    ✗ ${label} ${extra}`); }
}
const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(":").map(Number); let x = h * 60 + (m || 0); if (h < 6) x += 1440; return x; };

// ── Replay snapshot: fatti grezzi, estado NUEVO, now iniziale ─────────────────
const orders = fix.orders.map(o => ({
  id: o.id, tipo_consegna: o.tipo_consegna, estado: "NUEVO",
  zona: o.zona, hora: o.hora, andata_min: o.andata_min,
  durata_andata_min: o.andata_min, n_pizze: o.n_pizze,
}));
const plan = buildPlan({ now: "19:00", orders });
const dfOld = computeDriverFields(orders); // ricostruzione lato vecchio (pure)
const dom = fix.orders.filter(o => o.tipo_consegna === "DOMICILIO");

// ── Tabella A/B principale (forno_out reale + driver ricostruito) ─────────────
console.log(`\n══════ A/B SNAPSHOT REALE ${fix.fecha} — ${fix.orders.length} ordini (${dom.length} DOMICILIO) ══════`);
console.log("\n| ordine | zona | hora | OLD forno/salida/entrega(retr) | NEW forno/salida/entrega(retr) | nota |");
console.log("|--------|------|------|-------------------------------|--------------------------------|------|");
for (const o of dom) {
  const n = plan.orders[o.id];
  const f = dfOld.get(o.id) || {};
  const oldStr = `${o.forno_out_db}/${f.salida_driver_estimada ?? "—"}/${f.entrega_estimada ?? "—"}(${f.retraso_estimado_min ?? "—"})`;
  const newStr = `${n.forno_out}/${n.salida}/${n.entrega}(${n.retraso})`;
  let nota = "";
  if (n.forno_out !== o.forno_out_db) nota = "forno≠ (capacità/sequenza)";
  if ((n.reasons || []).includes("forno pieno: giro spostato avanti")) nota = "forno pieno (ritiro nello slot)";
  console.log(`| ${o.id} | ${o.zona} | ${o.hora} | ${oldStr} | ${newStr} | ${nota} |`);
}

// ── FASE 6: copertura casi reali ──────────────────────────────────────────────
console.log("\n── Copertura casi reali nello snapshot ──");
const q1at2200 = dom.filter(o => o.zona === "Q1" && o.hora === "22:00");
const ritiri = fix.orders.filter(o => o.tipo_consegna === "RITIRO");
const afterMidnight = dom.filter(o => toMin(o.hora) >= 1440);
console.log(`    • DOMICILIO stessa zona/slot (Q1 22:00): ${q1at2200.length} ordini`);
console.log(`    • Zona lunga Q5: ${dom.filter(o => o.zona === "Q5").length} ordini (andate 12–26)`);
console.log(`    • Ritiri che occupano forno: ${ritiri.length}`);
console.log(`    • Manual giro: ${fix.manual_giros.length} (ASSENTE in questa serata)`);
console.log(`    • After-midnight / near-23:00: ${afterMidnight.length} dopo mezzanotte + #010 23:21, #020 22:51, #021 23:00`);
console.log(`    • EN_COCINA/congelato live: 0 (snapshot archiviato, tutti RETIRADO → replay come MOVIBILE)`);
console.log(`    • Zone diverse stesso periodo: Q1 + Q5 ✓`);

// ===============================================================
// ASSERZIONI (devono PASSARE) — verità verificabili sullo snapshot reale
// ===============================================================
console.log("\n── Asserzioni A/B reali ──");

// 1) Cluster Q1 22:00: NEW condivide forno_out (invariante #001/I8) — come il DB reale.
{
  const fos = q1at2200.map(o => plan.orders[o.id].forno_out);
  const allEq = fos.every(x => x === fos[0]);
  check("Q1 22:00: NEW forno_out CONDIVISO tra i 3 ordini (I8)", allEq && q1at2200.length === 3, JSON.stringify(fos));
  check("Q1 22:00: DB reale aveva già forno_out condiviso 21:52", q1at2200.every(o => o.forno_out_db === "21:52"));
  // Soft overload (ritiro #017 1pz @21:50 + 4pz giro = 5): NEW NON sposta → forno_out
  // 21:52 = ESATTAMENTE il DB reale, ma con warning visibile (capacità non ignorata).
  check("Q1 22:00: NEW forno_out == DB reale (21:52) — soft overload, niente shift", fos[0] === "21:52", fos[0]);
  const trip = plan.trips.find(t => t.id === plan.orders[q1at2200[0].id].giro_id);
  check("Q1 22:00: NEW segnala forno_soft_overload (visibile, non silenzioso)", trip && trip.warnings.includes("forno_soft_overload"), JSON.stringify(trip?.warnings));
}

// 2) Soft overload reale: 5 pizze nello slot 21:50 (1 ritiro + 4 giro) = +1 tollerato.
{
  const pizzeGiro = q1at2200.reduce((s, o) => s + o.n_pizze, 0); // 2+1+1 = 4
  const ritiro1750 = ritiri.find(o => o.hora === "21:50");        // #017, 1 pizza
  check("Slot 21:50 reale = 5 pizze (1 ritiro + 4 giro) → soft overload, gestibile",
    pizzeGiro === 4 && ritiro1750 && ritiro1750.n_pizze === 1);
}

// 3) Parità reale dove non c'è capacità in gioco: #010 23:21.
{
  check("#010 Q1 23:21: NEW forno_out == DB reale (23:13)", plan.orders["#010"].forno_out === fix.orders.find(o => o.id === "#010").forno_out_db);
}

// 4) Q5 notturno: NEW AGGREGA #006+#007 in un solo giro; OLD li separava (cascade +76).
{
  const t6 = plan.orders["#006"].giro_id, t7 = plan.orders["#007"].giro_id;
  check("Q5: NEW mette #006 e #007 nello STESSO giro (aggregazione fine)", t6 === t7, `${t6} vs ${t7}`);
  const retOld7 = dfOld.get("#007")?.retraso_estimado_min ?? 0;
  const retNew7 = plan.orders["#007"].retraso;
  check("Q5 #007: NEW retraso << OLD ricostruito (meno round-trip)", retNew7 < retOld7, `NEW ${retNew7} vs OLD ${retOld7}`);
}

// 5) Invariante rider su dati reali: nessun trip sovrapposto.
check("Invariante rider: nessun overlap su tutta la serata reale", plan.rider_overlaps.length === 0, JSON.stringify(plan.rider_overlaps));

// 6) Ritiri: occupano il forno, non il rider (forno_out = hora, nessun trip).
{
  const allRitiriOk = ritiri.every(o => {
    const n = plan.orders[o.id];
    return n && n.tipo === "RITIRO" && n.giro_id === null && n.forno_out === o.hora;
  });
  check("Ritiri: forno_out = hora, fuori dal rider (come DB reale)", allRitiriOk);
}

console.log(`\n──────────────\n  ${pass} PASS · ${fail} FAIL\n`);
process.exit(fail ? 1 : 0);
