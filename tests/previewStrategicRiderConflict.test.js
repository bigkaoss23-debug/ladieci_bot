// tests/previewStrategicRiderConflict.test.js
// ===============================================================
// BLOCCO 2 — P0 rider-conflict: una proposta DIRETTA separata che si sovrappone
// alla finestra [salida, regreso] di un anchor già impegnato (single-rider) NON
// deve essere "compatible". Diventa no_recomendado FORZABILE (blocked=false).
// Run: node tests/previewStrategicRiderConflict.test.js
//
// Scenario chiave (test obbligatorio del blocco):
//   anchor Q5 21:00 EN_COCINA (forno_out 20:47, andata 13) + bozza Q2 20:45.
//   - direct Q2 (salida ~20:38 → entrega 20:45 → regreso 20:54) overlappa la
//     salida del Q5 (20:47) → conflitto rider.
//   - il giro compatibile Q2→Q5 resta candidato valido (ajuste).
// Read-only, puro: anchors espliciti, travelTimes da deliveryLegs statici.
// ===============================================================
"use strict";

const {
  previewStrategicOpportunities,
  clockIntervalsOverlap,
  directIntervalFromOpp,
  findRiderConflictAnchor,
} = require("../src/agents/previewStrategicOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const ANCHOR_Q5 = {
  id: "#001",
  zona: "Q5",
  hora: "21:00",
  forno_out: "20:47",
  durata_andata_min: 13,
  n_pizze: 1,
};
const CURRENT_Q2 = { id: "draft-q2", zona: "Q2", promised: "20:45", pizzas: 1, serviceMin: 2 };

async function main() {
  // ── unit: helpers ─────────────────────────────────────────────────────────
  console.log("\n══ unit: overlap + interval helpers ══");
  check("overlap 20:38-20:54 vs 20:47-21:13 = true",
    clockIntervalsOverlap("20:38", "20:54", "20:47", "21:13") === true);
  check("no-overlap 20:38-20:44 vs 20:47-21:13 = false",
    clockIntervalsOverlap("20:38", "20:44", "20:47", "21:13") === false);
  check("estremo nullo → false (no falso positivo)",
    clockIntervalsOverlap("20:38", null, "20:47", "21:13") === false);
  {
    const di = directIntervalFromOpp({ routeTimeline: { summary: { giroEta: "20:45", returnEta: "20:54" }, timeline: [{ type: "departure", eta: "20:38" }] } });
    check("directIntervalFromOpp legge salida/entrega/regreso",
      di.salida === "20:38" && di.entrega === "20:45" && di.regreso === "20:54", JSON.stringify(di));
  }
  {
    const anchorSan = { zone: "Q5", salida: "20:47", entrega: "21:00", regreso: "21:13", promised: "21:00" };
    const directOpp = { routeTimeline: { summary: { giroEta: "20:45", returnEta: "20:54" }, timeline: [{ type: "departure", eta: "20:38" }] } };
    check("findRiderConflictAnchor trova il Q5 in conflitto",
      findRiderConflictAnchor(directOpp, [anchorSan]) === anchorSan);
    const anchorLate = { zone: "Q5", salida: "21:30", entrega: "21:45", regreso: "21:58", promised: "21:45" };
    check("findRiderConflictAnchor: anchor lontano → nessun conflitto",
      findRiderConflictAnchor(directOpp, [anchorLate]) === null);
  }

  // ── E2E: Q5 21:00 anchor + Q2 20:45 draft ──────────────────────────────────
  console.log("\n══ E2E: direct Q2 vs anchor Q5 (conflitto rider) ══");
  const res = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q2,
    anchors: [ANCHOR_Q5],
    startTime: "20:30",
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });

  check("ok=true", res.ok === true, JSON.stringify(res.blockers));
  const bp = res.bestProposal;
  check("bestProposal presente", !!bp);
  check("direct NON è compatible", bp && bp.status !== "compatible", bp && bp.status);
  check("direct status = no_recomendado", bp && bp.status === "no_recomendado", bp && bp.status);
  check("direct riderConflict = true", bp && bp.riderConflict === true);
  check("direct resta FORZABILE (blocked !== true)", bp && bp.blocked !== true);
  check("direct warning menziona conflicto rider", bp && /conflicto rider/i.test(bp.warning || ""), bp && bp.warning);
  check("firstAvailable.status riallineato a no_recomendado",
    res.firstAvailable && res.firstAvailable.status === "no_recomendado", res.firstAvailable && res.firstAvailable.status);
  check("routeTimeline risk = warning (non ok)", bp && bp.routeTimeline && bp.routeTimeline.risk === "warning",
    bp && bp.routeTimeline && bp.routeTimeline.risk);

  // il giro compatibile Q2→Q5 resta candidato valido (ajuste)
  const insertion = (res.opportunities || []).find((o) => o && o.kind === "agregar");
  check("opportunity agregar Q2→Q5 presente", !!insertion, JSON.stringify((res.opportunities || []).map(o => o.kind)));
  check("opportunity agregar è compatible/ajuste (resta valida)",
    insertion && (insertion.status === "ajuste" || insertion.status === "compatible"), insertion && insertion.status);

  // ── BLOCCO 3: ranking — il giro compatibile diventa "mejor operativo" ──
  console.log("\n══ BLOCCO 3: ranking mejor operativo ══");
  const props = res.proposals || [];
  check("proposals[0] è il giro (insertion), non il diretto",
    props[0] && props[0].kind === "insertion", JSON.stringify(props.map(p => p.kind)));
  check("proposals[0].recommended = true", props[0] && props[0].recommended === true);
  const directProp = props.find((p) => p.kind === "direct");
  check("il diretto resta mostrato (forzabile) sotto", !!directProp && directProp.rank > 1,
    directProp && directProp.rank);
  check("il diretto NON è recommended", directProp && directProp.recommended !== true);

  // ── BLOCCO 4: serviceLine salida/entrega/regreso ───────────────────────────
  console.log("\n══ BLOCCO 4: serviceLine timestamps ══");
  const sl = (res.serviceLine || []).find((r) => r && r.id === "#001");
  check("serviceLine ha la riga Q5 #001", !!sl, JSON.stringify(res.serviceLine));
  check("serviceLine.salida = 20:47 (forno_out)", sl && sl.salida === "20:47", sl && sl.salida);
  check("serviceLine.entrega = 21:00 (promised)", sl && sl.entrega === "21:00", sl && sl.entrega);
  check("serviceLine.regreso = 21:13 (entrega+andata)", sl && sl.regreso === "21:13", sl && sl.regreso);

  // preferenza ai campi DB reali (salida_driver_estimada / entrega_estimada)
  const resDb = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q2,
    anchors: [{ id: "#001", zona: "Q5", hora: "21:00", forno_out: "20:47",
      salida_driver_estimada: "20:50", entrega_estimada: "21:02", durata_andata_min: 13, n_pizze: 1 }],
    startTime: "20:30",
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const slDb = (resDb.serviceLine || []).find((r) => r && r.id === "#001");
  check("serviceLine preferisce salida_driver_estimada DB (20:50)", slDb && slDb.salida === "20:50", slDb && slDb.salida);
  check("serviceLine preferisce entrega_estimada DB (21:02)", slDb && slDb.entrega === "21:02", slDb && slDb.entrega);

  // ── CONTROLLO: senza anchor → direct resta compatible ──────────────────────
  console.log("\n══ controllo: nessun anchor → direct compatible ══");
  const resNoAnchor = await previewStrategicOpportunities({
    currentOrderDraft: CURRENT_Q2,
    anchors: [],
    startTime: "20:30",
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  check("senza anchor: direct compatible",
    resNoAnchor.bestProposal && resNoAnchor.bestProposal.status === "compatible",
    resNoAnchor.bestProposal && resNoAnchor.bestProposal.status);
  check("senza anchor: nessun riderConflict",
    resNoAnchor.bestProposal && resNoAnchor.bestProposal.riderConflict !== true);
  const propsNA = resNoAnchor.proposals || [];
  check("senza anchor: proposals[0] è il diretto (compatible) recommended",
    propsNA[0] && propsNA[0].kind === "direct" && propsNA[0].recommended === true,
    JSON.stringify(propsNA.map(p => p.kind)));

  console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
