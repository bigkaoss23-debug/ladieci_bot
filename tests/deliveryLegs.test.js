// tests/deliveryLegs.test.js
// ===============================================================
// PREMIUM PLANNER — delivery legs (travel inter-zona V1): pure offline test
// Run: node tests/deliveryLegs.test.js
//
// Boundary:
//   - deliveryLegs.js è config PURA: niente DB/fetch/env/Google/router/wiring.
//   - Niente 0 fantasma: tratta non definita → null (mai 0).
//   - Integrazione: deliveryLegs → travelTimes → strategicOpportunities →
//     routeImpact (catena offline).
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  HUB_LABEL,
  ZONE_LEGS,
  makeLegKey,
  hasDeliveryLeg,
  getDeliveryLegMin,
  buildTravelTimesForPath,
  buildTravelTimesForZones,
} = require("../src/core/delivery/deliveryLegs");

const { buildStrategicCandidates } = require("../src/core/delivery/strategicOpportunities");
const { buildRouteImpact } = require("../src/core/delivery/routeImpact");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i]);

console.log("══ Unit: keys & lookup ══");
check("HUB_LABEL Pizzería", HUB_LABEL === "Pizzería");
check("makeLegKey", makeLegKey("Pizzería", "Q2") === "Pizzería->Q2");
check("makeLegKey normalizes case", makeLegKey("pizzeria", "q2") === "Pizzería->Q2");
check("hasDeliveryLeg true", hasDeliveryLeg("Q2", "Q5") === true);
check("hasDeliveryLeg false (cross)", hasDeliveryLeg("Q5", "Q3") === false);

// ── Scenario 1 — direct hub legs ────────────────────────────────────────────
console.log("══ 1. direct hub legs ══");
check("Pizzería->Q2 = 7", getDeliveryLegMin("Pizzería", "Q2") === 7);
check("Q5->Pizzería = 15", getDeliveryLegMin("Q5", "Pizzería") === 15);
check("Pizzería->Q1 = 5", getDeliveryLegMin("Pizzería", "Q1") === 5);
check("Pizzería->Q4 = 12", getDeliveryLegMin("Pizzería", "Q4") === 12);

// ── Scenario 2 — sur channel legs + path ────────────────────────────────────
console.log("══ 2. sur channel ══");
check("Q1->Q2 = 5", getDeliveryLegMin("Q1", "Q2") === 5);
check("Q2->Q5 = 10", getDeliveryLegMin("Q2", "Q5") === 10);
{
  const r = buildTravelTimesForPath(["Pizzería", "Q2", "Q5", "Pizzería"]);
  check("path sur ok", r.ok === true);
  check("missing vuoto", eqArr(r.missing, []));
  check("travelTimes Pizzería->Q2=7", r.travelTimes["Pizzería->Q2"] === 7);
  check("travelTimes Q2->Q5=10", r.travelTimes["Q2->Q5"] === 10);
  check("travelTimes Q5->Pizzería=15", r.travelTimes["Q5->Pizzería"] === 15);
  check("solo 3 legs (no null)", Object.keys(r.travelTimes).length === 3);
}

// ── Scenario 3 — oeste channel legs + path ──────────────────────────────────
console.log("══ 3. oeste channel ══");
check("Q3->Q4 = 8", getDeliveryLegMin("Q3", "Q4") === 8);
{
  const r = buildTravelTimesForPath(["Pizzería", "Q3", "Q4", "Pizzería"]);
  check("path oeste ok", r.ok === true);
  check("Q3->Q4 presente", r.travelTimes["Q3->Q4"] === 8);
  check("Q4->Pizzería presente", r.travelTimes["Q4->Pizzería"] === 12);
}

// ── Scenario 4 — missing cross ──────────────────────────────────────────────
console.log("══ 4. missing cross ══");
check("Q5->Q3 → null", getDeliveryLegMin("Q5", "Q3") === null);
check("Q2->Q4 → null", getDeliveryLegMin("Q2", "Q4") === null);
{
  const r = buildTravelTimesForPath(["Pizzería", "Q5", "Q3", "Pizzería"]);
  check("path cross ok:false", r.ok === false);
  check("missing elenca Q5->Q3", r.missing.includes("Q5->Q3"));
  check("travelTimes NON contiene Q5->Q3", !("Q5->Q3" in r.travelTimes));
}

// ── Scenario 5 — no zero fallback ───────────────────────────────────────────
console.log("══ 5. no zero fallback ══");
check("unknown leg → null, mai 0", getDeliveryLegMin("Q9", "Q8") === null);
check("ZONE_LEGS non contiene valori 0", Object.values(ZONE_LEGS).every((v) => v > 0));
{
  // path con leg sconosciuta: la leg manca, NON diventa 0.
  const r = buildTravelTimesForPath(["Pizzería", "Q9"]);
  check("leg sconosciuta missing, non 0", r.ok === false && !("Pizzería->Q9" in r.travelTimes));
}

// ── Scenario 6 — integration con strategicOpportunities + routeImpact ───────
console.log("══ 6. integration strategic + routeImpact ══");
{
  // Costruisci travelTimes per Q2→Q5 via deliveryLegs.
  const legs = buildTravelTimesForZones(["Q2", "Q5"]);
  check("legs Q2→Q5 ok", legs.ok === true);
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q2", zone: "Q2", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 2, serviceMin: 2 }],
    startTime: "20:43",
    travelTimes: legs.travelTimes, // ← da deliveryLegs, non fixture inventata
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    toleranceMin: 0,
  });
  const c = cands[0];
  check("candidato non bloccato (travel completi)", c.blockedCandidate === false);
  check("routeImpactInput presente", !!c.routeImpactInput);
  check("Q2 travelFromPrev 7", c.routeImpactInput.stops[0].travelFromPrevMin === 7);
  check("Q5 travelFromPrev 10", c.routeImpactInput.stops[1].travelFromPrevMin === 10);
  check("returnTravelMin 15", c.routeImpactInput.returnTravelMin === 15);
  const impact = buildRouteImpact(c.routeImpactInput);
  // Q2: 20:43+7=20:50 (ok); Q5: 20:50+2+10=21:02 (promised 21:00 → +2 → ajuste)
  check("routeImpact produce status", ["compatible", "ajuste", "no_recomendado", "lleno"].includes(impact.status), impact.status);
  check("routeEtas 2 stops", impact.routeEtas.length === 2);
}

// ── Scenario integration cross → blocked ────────────────────────────────────
console.log("══ 6b. cross legs mancanti → candidate blocked ══");
{
  const legs = buildTravelTimesForZones(["Q3", "Q5"]); // Q3→Q5 cross: assente
  check("legs Q3→Q5 ok:false", legs.ok === false);
  const cands = buildStrategicCandidates({
    currentOrder: { id: "new-q3", zone: "Q3", label: "Pedido actual", pizzas: 1, promised: "20:50", serviceMin: 2 },
    anchors: [{ id: "tg-q5", zone: "Q5", label: "Las Marinas", promised: "21:00", pizzas: 1, serviceMin: 2 }],
    startTime: "20:30",
    travelTimes: legs.travelTimes, // mancano Q3->Q5 (cross) → strategic blocca
    capacity: { maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const c = cands[0];
  check("candidate blocked (cross + travel mancanti)", c.blockedCandidate === true);
}

// ── Purity ───────────────────────────────────────────────────────────────────
console.log("══ Purity ══");
{
  const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/deliveryLegs.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const reqs = (code.match(/require\(["']([^"']+)["']\)/g) || []);
  check("deliveryLegs.js ZERO require", reqs.length === 0, reqs.join(","));
  check("no process.env", !/process\.env/.test(code));
  check("no fetch/supabase/router/google/db-verbs", !/\bfetch\b|supabase|express|\brouter\b|google|app\.(get|post|put|patch|delete)|\b(insert|update|delete)\s*\(/i.test(code));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
