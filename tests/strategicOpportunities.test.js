// tests/strategicOpportunities.test.js
// ===============================================================
// PREMIUM PLANNER — strategic candidate generator: pure offline test
// Run: node tests/strategicOpportunities.test.js
//
// Boundary:
//   - strategicOpportunities.js è puro: unica dipendenza deliveryChannels
//     (config pura). Niente DB/fetch/env/router/wiring.
//   - Il generator NON calcola slip/ETA/status: assembla routeImpactInput.
//   - E2E offline: candidate.routeImpactInput → buildRouteImpact (status reale)
//     → premiumPlannerBridge (Opportunity contract shape).
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  PIZZERIA,
  makeTravelKey,
  resolveTravelTime,
  classifyCandidateChannel,
  buildRouteImpactInputForCandidate,
  buildCandidateForAnchor,
  buildStrategicCandidates,
} = require("../src/core/delivery/strategicOpportunities");

const { buildRouteImpact } = require("../src/core/delivery/routeImpact");
const { buildOpportunityFromPlannerOption } = require("../src/core/delivery/premiumPlannerBridge");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i]);

// ── Unit: helpers ────────────────────────────────────────────────────────────
console.log("══ Unit: travel helpers ══");
check("makeTravelKey", makeTravelKey("Pizzería", "Q2") === "Pizzería->Q2");
check("resolveTravelTime hit", resolveTravelTime("Q2", "Q5", { "Q2->Q5": 10 }) === 10);
check("resolveTravelTime miss → null", resolveTravelTime("Q2", "Q5", {}) === null);
check("resolveTravelTime non-num → null", resolveTravelTime("Q2", "Q5", { "Q2->Q5": "x" }) === null);

console.log("══ Unit: classifyCandidateChannel (deliveryChannels) ══");
check("Q2+Q5 → sur", classifyCandidateChannel(["Q2", "Q5"]) === "sur");
check("Q1+Q5 → sur (hub neutro)", classifyCandidateChannel(["Q1", "Q5"]) === "sur");
check("Q3+Q4 → oeste", classifyCandidateChannel(["Q3", "Q4"]) === "oeste");
check("Q3+Q5 → cross", classifyCandidateChannel(["Q3", "Q5"]) === "cross");

// ── Scenario 1 — Q2 current + Q5 anchor → candidate sur ──────────────────────
console.log("══ 1. Q2 current + Q5 anchor → sur ══");
const input1 = {
  currentOrder: { id: "new-q2", zone: "Q2", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
  anchors: [{ id: "target-q5-2100", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 2, serviceMin: 2, targetTime: "21:00" }],
  startTime: "20:35",
  travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 10, "Q5->Pizzería": 15 },
  // routeMinLimit realistico: la rotta Q2→Q5 + rientro è ~36 min; un limite di
  // 30 la farebbe risultare no_recomendado (durata). 60 = giro sur plausibile.
  capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
};
{
  const cands = buildStrategicCandidates(input1);
  check("1 candidato", cands.length === 1);
  const c = cands[0];
  check("kind agregar", c.kind === "agregar");
  check("anchorId target-q5-2100", c.anchorId === "target-q5-2100");
  check("channel sur", c.channel === "sur");
  check("routeZones [Q2,Q5]", eqArr(c.routeZones, ["Q2", "Q5"]));
  check("mapPath [Pizzería,Q2,Q5]", eqArr(c.mapPath, ["Pizzería", "Q2", "Q5"]));
  check("blockedCandidate false", c.blockedCandidate === false);
  // routeImpactInput pronto
  const ri = c.routeImpactInput;
  check("routeImpactInput presente", !!ri);
  check("startTime 20:35", ri.startTime === "20:35");
  check("2 stops Q2 then Q5", ri.stops.length === 2 && ri.stops[0].zone === "Q2" && ri.stops[1].zone === "Q5");
  check("Q2 isNew true", ri.stops[0].isNew === true);
  check("Q5 isNew false", ri.stops[1].isNew === false);
  check("Q2 travelFromPrev 7 (Pizzería->Q2)", ri.stops[0].travelFromPrevMin === 7);
  check("Q5 travelFromPrev 10 (Q2->Q5)", ri.stops[1].travelFromPrevMin === 10);
  check("returnTravelMin 15 (Q5->Pizzería)", ri.returnTravelMin === 15);
  check("capacity.pizzas total 3", ri.capacity.pizzas === 3);
  check("capacity limits passthrough", ri.capacity.maxPizzas === 6 && ri.capacity.routeMinLimit === 60);
  // il generator NON ha calcolato slip/status
  check("nessuno status sul candidato (lo fa routeImpact)", !("status" in c));
  check("nessuno slip sugli stops", ri.stops.every((s) => !("slips" in s) && !("slipLabel" in s)));
}

// ── Scenario 2 — Q1 current + Q5 anchor → sur, NO Q2 inventato ───────────────
console.log("══ 2. Q1 current + Q5 anchor → sur, no Q2 fantasma ══");
{
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q1", zone: "Q1", label: "Pedido actual", pizzas: 1, promised: "20:30", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 1, serviceMin: 2 }],
    startTime: "20:20",
    travelTimes: { "Pizzería->Q1": 5, "Q1->Q5": 18, "Q5->Pizzería": 15 },
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const c = cands[0];
  check("channel sur (Q1 hub + Q5)", c.channel === "sur");
  check("routeZones esattamente [Q1,Q5] (no Q2)", eqArr(c.routeZones, ["Q1", "Q5"]));
  check("mapPath [Pizzería,Q1,Q5]", eqArr(c.mapPath, ["Pizzería", "Q1", "Q5"]));
  check("Q1->Q5 travel 18", c.routeImpactInput.stops[1].travelFromPrevMin === 18);
  check("blockedCandidate false", c.blockedCandidate === false);
}

// ── Scenario 3 — Q3 current + Q5 anchor → cross / blocked ────────────────────
console.log("══ 3. Q3 current + Q5 anchor → cross blocked ══");
{
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q3", zone: "Q3", label: "Pedido actual", pizzas: 1, promised: "20:40", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 1, serviceMin: 2 }],
    startTime: "20:20",
    travelTimes: { "Pizzería->Q3": 8, "Q3->Q5": 20, "Q5->Pizzería": 15 },
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const c = cands[0];
  check("channel cross", c.channel === "cross");
  check("blockedCandidate true", c.blockedCandidate === true);
  check("reason menciona canales distintos", /Canales distintos/.test(c.reason), c.reason);
  // Scelta documentata: il candidato cross è emesso comunque (forzabile) con
  // routeImpactInput costruito, NON saltato silenziosamente.
  check("routeImpactInput presente (forzabile)", !!c.routeImpactInput);
  check("priority cross > compatibile", c.priority === 90);
}

// ── Scenario 4a — deliveryLegs riempie i buchi (explicit parziale) ──────────
// Prima dell'integrazione un Q2+Q5 con solo "Pizzería->Q2" era blocked. Ora
// deliveryLegs riempie Q2->Q5 e Q5->Pizzería; l'esplicito vince per-tratta.
console.log("══ 4a. deliveryLegs riempie i buchi (precedenza esplicita) ══");
{
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q2", zone: "Q2", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 2, serviceMin: 2 }],
    startTime: "20:43",
    travelTimes: { "Pizzería->Q2": 7 }, // SOLO primo leg; deliveryLegs riempie il resto
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const c = cands[0];
  check("non bloccato (deliveryLegs riempie)", c.blockedCandidate === false);
  check("routeImpactInput presente", !!c.routeImpactInput);
  check("explicit Pizzería->Q2=7 preservato (precedenza)", c.routeImpactInput.stops[0].travelFromPrevMin === 7);
  check("Q2->Q5=10 da deliveryLegs", c.routeImpactInput.stops[1].travelFromPrevMin === 10);
  check("Q5->Pizzería=15 da deliveryLegs", c.routeImpactInput.returnTravelMin === 15);
}

// ── Scenario 4b — senza travelTimes: deliveryLegs fornisce tutto ────────────
console.log("══ 4b. senza travelTimes → deliveryLegs fornisce tutto ══");
{
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q2", zone: "Q2", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 2, serviceMin: 2 }],
    startTime: "20:43",
    // NESSUN travelTimes esplicito
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const c = cands[0];
  check("non bloccato (tutto da deliveryLegs)", c.blockedCandidate === false);
  check("routeImpactInput presente", !!c.routeImpactInput);
  check("Pizzería->Q2=7", c.routeImpactInput.stops[0].travelFromPrevMin === 7);
  check("Q2->Q5=10", c.routeImpactInput.stops[1].travelFromPrevMin === 10);
}

// ── Scenario 4c — cross senza explicit: deliveryLegs NON ha la tratta → blocked
// deliveryLegs non definisce le tratte cross (Q3->Q5): resta missing → blocked,
// routeImpactInput null. MAI un 0 fantasma.
console.log("══ 4c. cross senza explicit → blocked/missing (no 0) ══");
{
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q3", zone: "Q3", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 1, serviceMin: 2 }],
    startTime: "20:20",
    // NESSUN travelTimes esplicito; deliveryLegs NON ha Q3->Q5 (cross)
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const c = cands[0];
  check("blockedCandidate true", c.blockedCandidate === true);
  check("routeImpactInput null (cross leg mancante, no 0)", c.routeImpactInput === null);
  check("reason elenca Q3->Q5 mancante", /Q3->Q5/.test(c.reason), c.reason);
}

// ── Scenario 5 — routeImpact integration (candidate.routeImpactInput) ───────
console.log("══ 5. routeImpact integration ══");
{
  // input1 compatibile → routeImpact deve dare compatible (Q5 puntuale).
  const c = buildStrategicCandidates(input1)[0];
  const impact = buildRouteImpact(c.routeImpactInput);
  // Q2: 20:35+7=20:42 (promised 20:50 → ok); Q5: 20:42+2+10=20:54 (promised 21:00 → ok)
  check("routeImpact status compatible", impact.status === "compatible", impact.status);
  check("nessuno slip", impact.routeEtas.every((e) => e.slips === false));

  // Variante ajuste: ritardo il Q5 con un travel più lungo.
  const cLate = buildCandidateForAnchor(
    input1.currentOrder,
    input1.anchors[0],
    { startTime: "20:43", travelTimes: { "Pizzería->Q2": 7, "Q2->Q5": 13, "Q5->Pizzería": 15 }, capacity: input1.capacity, toleranceMin: 0 }
  );
  const impactLate = buildRouteImpact(cLate.routeImpactInput);
  check("variante ajuste (Q5 +5)", impactLate.status === "ajuste" && impactLate.routeEtas[1].slipLabel === "+5", impactLate.status);
}

// ── Scenario 6 — bridge hand-off (candidate.routeImpactInput in context) ────
console.log("══ 6. bridge hand-off → Opportunity contract ══");
{
  const c = buildStrategicCandidates(input1)[0];
  const opp = buildOpportunityFromPlannerOption(
    { type: "join_giro", giro_id: c.anchorId, status: "valid", retraso: 0 },
    { currentOrderZone: "Q2", routeZones: c.routeZones, routeImpactInput: c.routeImpactInput }
  );
  const CONTRACT_KEYS = [
    "id", "kind", "giroId", "channel", "currentOrderZone", "currentOrderLabel",
    "routeZones", "mapPath", "routeEtas", "baseline", "capacity", "status",
    "severity", "blocked", "warning", "title", "subtitle", "chip",
    "explanation", "quickOptionId",
  ];
  check("contract shape completa", CONTRACT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(opp, k)));
  check("channel sur (mapper dalle zone)", opp.channel === "sur");
  check("status compatible (da routeImpact)", opp.status === "compatible");
  check("routeEtas 2 da routeImpact", opp.routeEtas.length === 2);
  check("Q2 isNew preservato", opp.routeEtas[0].isNew === true);
}

// ── Scenario crear (no anchors) ──────────────────────────────────────────────
console.log("══ 7. crear (no anchors) ══");
{
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q2", zone: "Q2", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
    anchors: [],
    startTime: "20:35",
    travelTimes: { "Pizzería->Q2": 7, "Q2->Pizzería": 7 },
    capacity: { maxPizzas: 6, routeMinLimit: 30, pizzaQualityLimitMin: 30 },
  });
  const c = cands[0];
  check("kind crear", c.kind === "crear");
  check("anchorId null", c.anchorId === null);
  check("routeZones [Q2]", eqArr(c.routeZones, ["Q2"]));
  check("channel sur", c.channel === "sur");
  check("routeImpactInput 1 stop", c.routeImpactInput.stops.length === 1 && c.routeImpactInput.stops[0].isNew === true);
}

// ── Purity ───────────────────────────────────────────────────────────────────
console.log("══ Purity ══");
{
  const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/strategicOpportunities.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const reqs = (code.match(/require\(["']([^"']+)["']\)/g) || []).map((r) => r.replace(/require\(["']|["']\)/g, ""));
  const allowedReqs = new Set(["./deliveryChannels", "./deliveryLegs"]);
  check("requires only pure config (deliveryChannels + deliveryLegs)", reqs.length === 2 && reqs.every((r) => allowedReqs.has(r)), reqs.join(","));
  check("no process.env", !/process\.env/.test(code));
  check("no fetch/supabase/router/db-verbs", !/\bfetch\b|supabase|express|\brouter\b|app\.(get|post|put|patch|delete)|\b(insert|update|delete)\s*\(/i.test(code));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
