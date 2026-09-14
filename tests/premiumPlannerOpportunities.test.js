// tests/premiumPlannerOpportunities.test.js
// ===============================================================
// PREMIUM PLANNER OPPORTUNITY MAPPER — pure offline test
// Run: node tests/premiumPlannerOpportunities.test.js
//
// Boundary:
//   - premiumPlannerOpportunities.js è un assembler puro.
//   - Tutti gli input sono FIXTURE già calcolate (slipLabel, capacity,
//     status arrivano dall'input). Il mapper non stima ETA né ritardi.
//   - Offline: niente DB/fetch/env.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  CONTRACT,
  VALID_STATUSES,
  normalizePremiumPlannerStatus,
  buildPremiumOpportunity,
  buildPremiumOpportunities,
} = require("../src/core/delivery/premiumPlannerOpportunities");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i]);

console.log("══ normalizePremiumPlannerStatus ══");
check("contract id", CONTRACT === "premium-planner-popup-lab-v2");
check("valid statuses set", eqArr(VALID_STATUSES, ["compatible", "ajuste", "no_recomendado", "lleno"]));
check("compatible kept", normalizePremiumPlannerStatus("compatible") === "compatible");
check("CASE/space normalized", normalizePremiumPlannerStatus("  Ajuste ") === "ajuste");
check("unknown → null (no invent)", normalizePremiumPlannerStatus("verde") === null);
check("missing → null", normalizePremiumPlannerStatus(undefined) === null);

console.log("══ Scenario 1: compatible / agregar (Q2 → giro Q5 21:00) ══");
const o1 = buildPremiumOpportunity({
  id: "opp-q2-q5-2100",
  kind: "agregar",
  giroId: "giro-q5-2100",
  currentOrderZone: "Q2",
  routeZones: ["Q2", "Q5"],
  routeEtas: [
    { zone: "Q2", label: "Pedido actual", eta: "20:50", promised: null, slips: false, slipLabel: "", isNew: true },
    { zone: "Q5", label: "Las Marinas", eta: "21:00", promised: "21:00", slips: false, slipLabel: "", isNew: false },
  ],
  baseline: { directEta: "20:40", label: "Directa sin giro" },
  capacity: { pizzas: "3/6", routeMin: 22, limitMin: 30, state: "ok" },
  status: "compatible",
  title: "Agregar a giro Q5 21:00",
  subtitle: "Q2 entra a las 20:50 antes de Las Marinas",
  quickOptionId: "quick-q2-q5",
});
check("kind agregar", o1.kind === "agregar");
check("giroId kept", o1.giroId === "giro-q5-2100");
check("channel sur (from zones)", o1.channel === "sur");
check("mapPath Pizzería→Q2→Q5", eqArr(o1.mapPath, ["Pizzería", "Q2", "Q5"]));
check("status compatible", o1.status === "compatible");
check("severity ok", o1.severity === "ok");
check("blocked false", o1.blocked === false);
check("Q5 promised 21:00 slips false", o1.routeEtas[1].promised === "21:00" && o1.routeEtas[1].slips === false);
check("baseline directEta 20:40", o1.baseline.directEta === "20:40");
check("capacity passthrough", o1.capacity.pizzas === "3/6" && o1.capacity.routeMin === 22 && o1.capacity.state === "ok");
check("currentOrderLabel default", o1.currentOrderLabel === "Pedido actual · Q2");
check("chip default oportunidad", o1.chip === "oportunidad");

console.log("══ Scenario 2: ajuste (Q5 slips +5, slipLabel pre-dato) ══");
const o2 = buildPremiumOpportunity({
  kind: "agregar",
  giroId: "giro-q5-2100",
  currentOrderZone: "Q2",
  routeZones: ["Q2", "Q5"],
  routeEtas: [
    { zone: "Q2", label: "Pedido actual", eta: "20:50", slips: false, slipLabel: "", isNew: true },
    { zone: "Q5", label: "Las Marinas", eta: "21:05", promised: "21:00", slips: true, slipLabel: "+5" },
  ],
  baseline: { directEta: "20:42" },
  capacity: { pizzas: "4/6", routeMin: 26, limitMin: 30, state: "tight" },
  status: "ajuste",
  warning: "Q5 se mueve +5 min",
});
check("status ajuste", o2.status === "ajuste");
check("severity warning", o2.severity === "warning");
check("blocked false", o2.blocked === false);
check("slipLabel '+5' passthrough (not computed)", o2.routeEtas[1].slipLabel === "+5");
check("slips true", o2.routeEtas[1].slips === true);
check("warning passthrough", o2.warning === "Q5 se mueve +5 min");
check("id generated when absent", o2.id === "opp-q2-q5");

console.log("══ Scenario 3: crear (nuevo giro manual Q2+Q5) ══");
const o3 = buildPremiumOpportunity({
  kind: "crear",
  giroId: "ignored-because-crear",
  currentOrderZone: "Q2",
  routeZones: ["Q2", "Q5"],
  routeEtas: [
    { zone: "Q2", eta: "20:55", isNew: true },
    { zone: "Q5", eta: "21:08" },
  ],
  baseline: { directEta: "20:50" },
  capacity: { pizzas: "2/6", routeMin: 20, limitMin: 30, state: "ok" },
  status: "compatible",
});
check("kind crear", o3.kind === "crear");
check("giroId forced null for crear", o3.giroId === null);
check("title default 'Crear giro Q2+Q5'", o3.title === "Crear giro Q2+Q5");
check("severity manual for crear+compatible", o3.severity === "manual");
check("blocked false", o3.blocked === false);
check("channel sur", o3.channel === "sur");

console.log("══ Scenario 4: no_recomendado (Q3+Q5 cross channel) ══");
const o4 = buildPremiumOpportunity({
  kind: "agregar",
  giroId: "giro-q5-2100",
  currentOrderZone: "Q3",
  routeZones: ["Q3", "Q5"],
  routeEtas: [
    { zone: "Q3", eta: "21:02", isNew: true },
    { zone: "Q5", eta: "21:18", promised: "21:00", slips: true, slipLabel: "+18" },
  ],
  baseline: { directEta: "20:55" },
  capacity: { pizzas: "4/6", routeMin: 31, limitMin: 30, state: "tight" },
  status: "no_recomendado",
  warning: "Zonas en direcciones distintas",
});
check("channel cross (Q3 oeste + Q5 sur)", o4.channel === "cross");
check("status no_recomendado", o4.status === "no_recomendado");
check("severity blocked", o4.severity === "blocked");
check("blocked true (policy)", o4.blocked === true);
check("warning reason passthrough", o4.warning === "Zonas en direcciones distintas");
check("mapPath kept input order for cross", eqArr(o4.mapPath, ["Pizzería", "Q3", "Q5"]));

console.log("══ Scenario 5: lleno (capacity full) ══");
const o5 = buildPremiumOpportunity({
  kind: "agregar",
  giroId: "giro-sur-2115",
  currentOrderZone: "Q1",
  routeZones: ["Q1", "Q2", "Q5"],
  routeEtas: [
    { zone: "Q1", eta: "21:00", isNew: true },
    { zone: "Q2", eta: "21:08", promised: "21:05", slips: true, slipLabel: "+3" },
    { zone: "Q5", eta: "21:20", promised: "21:15", slips: true, slipLabel: "+5" },
  ],
  baseline: { directEta: "20:58" },
  capacity: { pizzas: "6/6", routeMin: 28, limitMin: 30, state: "full" },
  status: "lleno",
  warning: "Capacidad llena 6/6",
});
check("status lleno", o5.status === "lleno");
check("severity blocked", o5.severity === "blocked");
check("blocked true (policy)", o5.blocked === true);
check("capacity state full", o5.capacity.state === "full");
check("warning passthrough", o5.warning === "Capacidad llena 6/6");
check("channel sur (Q1 hub + Q2 + Q5)", o5.channel === "sur");

console.log("══ Missing fields → null/'' (no invent) ══");
const oEmpty = buildPremiumOpportunity({ kind: "agregar", routeZones: [], status: "compatible" });
check("giroId null when absent", oEmpty.giroId === null);
check("currentOrderLabel '' when no zone", oEmpty.currentOrderLabel === "");
check("baseline.directEta null when absent", oEmpty.baseline.directEta === null);
check("capacity.pizzas null when absent", oEmpty.capacity.pizzas === null);
check("capacity.routeMin null when absent", oEmpty.capacity.routeMin === null);
check("warning '' when absent", oEmpty.warning === "");
check("routeEtas [] when absent", eqArr(oEmpty.routeEtas, []));
check("unknown status → null status", oEmpty.status === "compatible" && buildPremiumOpportunity({ status: "xxx" }).status === null);

console.log("══ Override precedence (input wins over policy) ══");
const oOverride = buildPremiumOpportunity({
  kind: "agregar", routeZones: ["Q2", "Q5"], status: "no_recomendado",
  blocked: false, severity: "warning", channel: "sur", mapPath: ["A", "B"],
});
check("input.blocked overrides policy", oOverride.blocked === false);
check("input.severity overrides policy", oOverride.severity === "warning");
check("input.channel overrides derived", oOverride.channel === "sur");
check("input.mapPath overrides derived", eqArr(oOverride.mapPath, ["A", "B"]));
// regression: una chiave mapPath presente ma undefined (come la passa il bridge)
// NON deve azzerare il default ["Pizzería", ...].
check("mapPath key present+undefined → default (not [])",
  eqArr(buildPremiumOpportunity({ kind: "crear", routeZones: ["Q2"], status: "compatible", mapPath: undefined }).mapPath, ["Pizzería", "Q2"]));

console.log("══ buildPremiumOpportunities (list) ══");
const list = buildPremiumOpportunities([
  { kind: "agregar", routeZones: ["Q2", "Q5"], status: "compatible" },
  { kind: "crear", routeZones: ["Q3", "Q4"], status: "compatible" },
]);
check("maps 2 inputs", list.length === 2);
check("first channel sur", list[0].channel === "sur");
check("second channel oeste", list[1].channel === "oeste");
check("non-array → []", eqArr(buildPremiumOpportunities(null), []));

console.log("══ Purity / decoupling ══");
const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/premiumPlannerOpportunities.js"), "utf8");
check("no fetch()", !/\bfetch\s*\(/.test(src));
check("no process.env", !/process\.env/.test(src));
check("no supabase/sb usage", !/supabase|sbSelect|sbInsert|sbUpdate|sbDelete/i.test(src));
check("no DB write verbs", !/\b(insert|update|delete)\s*\(/i.test(src));
check("no router/app.post wiring", !/router\.|app\.(post|put|patch|get)\b/.test(src));
check("no eta−promised arithmetic", !/promised\s*[-+]|[-+]\s*promised|eta\s*-\s*/.test(src));
check("only requires deliveryChannels (no other relative require)", (() => {
  const reqs = (src.match(/require\(["'][^"']+["']\)/g) || []);
  return reqs.length === 1 && /deliveryChannels/.test(reqs[0]);
})());

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
