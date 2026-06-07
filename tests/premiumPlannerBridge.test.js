// tests/premiumPlannerBridge.test.js
// ===============================================================
// PREMIUM PLANNER BRIDGE — pure offline test
// Run: node tests/premiumPlannerBridge.test.js
//
// Boundary:
//   - premiumPlannerBridge translates evaluateNewOrder.options → mapper input.
//   - Backend math (slipLabel from retraso) is OK here; the frontend/mapper
//     must NOT do it.
//   - Per-stop downstream ETAs / cross-zone opportunities come from the
//     fixture `context` (the planner doesn't compute them yet). The bridge
//     does not invent them.
//   - Offline: niente DB/fetch/env.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  slipLabelFromRetraso,
  kindFromPlannerOption,
  statusFromPlannerOption,
  warningFromPlannerOption,
  baselineFromSeparateOption,
  capacityFromContext,
  buildOpportunityInputFromPlannerOption,
  buildOpportunityFromPlannerOption,
  buildOpportunitiesFromPlannerResult,
} = require("../src/core/delivery/premiumPlannerBridge");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
const eqArr = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((v, i) => v === b[i]);

console.log("══ slipLabelFromRetraso (backend math) ══");
check("0 → ''", slipLabelFromRetraso(0) === "");
check("null → ''", slipLabelFromRetraso(null) === "");
check("5 → '+5'", slipLabelFromRetraso(5) === "+5");
check("18 → '+18'", slipLabelFromRetraso(18) === "+18");
check("negative → ''", slipLabelFromRetraso(-3) === "");

console.log("══ kindFromPlannerOption ══");
check("separate → crear", kindFromPlannerOption({ type: "separate" }) === "crear");
check("join_giro → agregar", kindFromPlannerOption({ type: "join_giro" }) === "agregar");
check("join_block → agregar", kindFromPlannerOption({ type: "join_block" }) === "agregar");

console.log("══ statusFromPlannerOption (explicit policy) ══");
check("valid retraso 0 → compatible", statusFromPlannerOption({ type: "join_giro", status: "valid", retraso: 0 }) === "compatible");
check("recommended retraso 0 → compatible", statusFromPlannerOption({ type: "join_giro", status: "recommended", retraso: 0 }) === "compatible");
check("valid retraso 5 → ajuste", statusFromPlannerOption({ type: "join_giro", status: "valid", retraso: 5 }) === "ajuste");
check("blocked → no_recomendado", statusFromPlannerOption({ type: "join_giro", status: "blocked", reason: "giro ya salió" }) === "no_recomendado");
check("blocked 'giro lleno' → lleno", statusFromPlannerOption({ type: "join_giro", status: "blocked", reason: "giro lleno" }) === "lleno");
check("capacity full overrides → lleno", statusFromPlannerOption({ type: "join_giro", status: "valid", retraso: 0 }, { capacity: { state: "full" } }) === "lleno");
check("unknown status → null (no invent)", statusFromPlannerOption({ type: "join_giro", status: "weird" }) === null);

console.log("══ baselineFromSeparateOption ══");
check("separate hora → directEta", (() => { const b = baselineFromSeparateOption({ type: "separate", hora: "20:40" }); return b.directEta === "20:40" && b.label === "Directa sin giro"; })());
check("non-separate → null directEta", baselineFromSeparateOption({ type: "join_giro", hora: "21:00" }).directEta === null);

console.log("══ capacityFromContext (passthrough, no compute) ══");
check("passes pizzas/routeMin/state", (() => {
  const c = capacityFromContext({ capacity: { pizzas: "3/6", routeMin: 22, limitMin: 30, state: "ok" } });
  return c.pizzas === "3/6" && c.routeMin === 22 && c.limitMin === 30 && c.state === "ok";
})());
check("absent → nulls", (() => { const c = capacityFromContext({}); return c.pizzas === null && c.routeMin === null && c.state === null; })());

// ── End-to-end: bridge → mapper → Opportunity ──────────────────────────
console.log("══ Scenario 1: join_giro valid/recommended, retraso 0 → compatible ══");
const ctx1 = {
  currentOrderZone: "Q2",
  routeZones: ["Q2", "Q5"],
  routeEtas: [
    { zone: "Q2", label: "Pedido actual", eta: "20:50", slips: false, slipLabel: "", isNew: true },
    { zone: "Q5", label: "Las Marinas", eta: "21:00", promised: "21:00", slips: false, slipLabel: "", isNew: false },
  ],
  directEta: "20:40",
  capacity: { pizzas: "3/6", routeMin: 22, limitMin: 30, state: "ok" },
};
const opp1 = buildOpportunityFromPlannerOption(
  { type: "join_giro", giro_id: "giro-q5-2100", status: "recommended", retraso: 0, reason: "más cercano y compatible" },
  ctx1
);
check("kind agregar", opp1.kind === "agregar");
check("giroId from option", opp1.giroId === "giro-q5-2100");
check("status compatible", opp1.status === "compatible");
check("channel sur (mapper from zones)", opp1.channel === "sur");
check("blocked false", opp1.blocked === false);
check("slipLabel '' on Q5 (retraso 0)", opp1.routeEtas[1].slipLabel === "");
check("baseline directEta 20:40 (from context directEta)", opp1.baseline.directEta === "20:40");
check("capacity passthrough", opp1.capacity.pizzas === "3/6" && opp1.capacity.state === "ok");

console.log("══ Scenario 2: join_giro retraso 5 → ajuste ══");
const ctx2 = {
  currentOrderZone: "Q2",
  routeZones: ["Q2", "Q5"],
  // downstream slip comes from fixture (planner retraso ≠ downstream slip)
  routeEtas: [
    { zone: "Q2", eta: "20:50", isNew: true },
    { zone: "Q5", eta: "21:05", promised: "21:00", slips: true, slipLabel: "+5" },
  ],
  directEta: "20:42",
  capacity: { pizzas: "4/6", routeMin: 26, limitMin: 30, state: "tight" },
};
const opp2 = buildOpportunityFromPlannerOption(
  { type: "join_giro", giro_id: "giro-q5-2100", status: "recommended", retraso: 5 },
  ctx2
);
check("status ajuste", opp2.status === "ajuste");
check("severity warning", opp2.severity === "warning");
check("blocked false", opp2.blocked === false);
check("default warning from retraso ('+5')", opp2.warning === "Retraso estimado +5 min");
check("Q5 fixture slipLabel '+5' preserved", opp2.routeEtas[1].slipLabel === "+5");
check("slipLabelFromRetraso(5) === '+5' (unit)", slipLabelFromRetraso(5) === "+5");

console.log("══ Scenario 3: blocked + cross channel (Q3+Q5) → no_recomendado ══");
const opp3 = buildOpportunityFromPlannerOption(
  { type: "join_giro", giro_id: "giro-q5-2100", status: "blocked", reason: "zonas en direcciones distintas" },
  { currentOrderZone: "Q3", routeZones: ["Q3", "Q5"], directEta: "20:55" }
);
check("status no_recomendado", opp3.status === "no_recomendado");
check("channel cross (mapper)", opp3.channel === "cross");
check("blocked true (mapper policy)", opp3.blocked === true);
check("warning = option.reason", opp3.warning === "zonas en direcciones distintas");

console.log("══ Scenario 4: capacity full → lleno ══");
const opp4 = buildOpportunityFromPlannerOption(
  { type: "join_giro", giro_id: "giro-sur-2115", status: "valid", retraso: 0 },
  { currentOrderZone: "Q1", routeZones: ["Q1", "Q2", "Q5"], capacity: { pizzas: "6/6", routeMin: 28, limitMin: 30, state: "full" } }
);
check("status lleno", opp4.status === "lleno");
check("blocked true", opp4.blocked === true);
check("severity blocked", opp4.severity === "blocked");
check("capacity state full", opp4.capacity.state === "full");
// also: blocked 'giro lleno' reason path
const opp4b = buildOpportunityFromPlannerOption(
  { type: "join_giro", status: "blocked", reason: "giro lleno" },
  { routeZones: ["Q2", "Q5"] }
);
check("blocked 'giro lleno' → lleno", opp4b.status === "lleno");

console.log("══ Scenario 5: separate → baseline + crear ══");
const sep = { type: "separate", hora: "20:40", status: "valid", retraso: 0 };
check("baselineFromSeparateOption(sep).directEta 20:40", baselineFromSeparateOption(sep).directEta === "20:40");
const opp5 = buildOpportunityFromPlannerOption(sep, { currentOrderZone: "Q2", routeZones: ["Q2", "Q5"] });
check("kind crear", opp5.kind === "crear");
check("giroId null for crear", opp5.giroId === null);
check("title default 'Crear giro Q2+Q5'", opp5.title === "Crear giro Q2+Q5");
check("severity manual (crear+compatible)", opp5.severity === "manual");

console.log("══ Scenario 6: buildOpportunitiesFromPlannerResult (list) ══");
const plannerResult = {
  options: [
    { type: "separate", hora: "20:40", status: "valid", retraso: 0 },
    { type: "join_giro", giro_id: "giro-q5-2100", status: "recommended", retraso: 0 },
  ],
};
const opps = buildOpportunitiesFromPlannerResult(plannerResult, (opt) => ({
  currentOrderZone: "Q2",
  routeZones: ["Q2", "Q5"],
  directEta: "20:40",
}));
check("maps 2 options", opps.length === 2);
check("first is crear (separate)", opps[0].kind === "crear");
check("second is agregar (join_giro)", opps[1].kind === "agregar");
check("both channel sur", opps[0].channel === "sur" && opps[1].channel === "sur");
check("null plannerResult → []", eqArr(buildOpportunitiesFromPlannerResult(null, {}), []));

console.log("══ Purity / decoupling ══");
const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/premiumPlannerBridge.js"), "utf8");
check("no fetch()", !/\bfetch\s*\(/.test(src));
check("no process.env", !/process\.env/.test(src));
check("no supabase/sb usage", !/supabase|sbSelect|sbInsert|sbUpdate|sbDelete/i.test(src));
check("no DB write verbs", !/\b(insert|update|delete)\s*\(/i.test(src));
check("no router/app wiring", !/router\.|app\.(post|put|patch|get)\b/.test(src));
check("no eta−promised arithmetic", !/promised\s*[-+]|eta\s*-\s*/.test(src));
check("requires only premiumPlannerOpportunities", (() => {
  const reqs = (src.match(/require\(["'][^"']+["']\)/g) || []);
  return reqs.length === 1 && /premiumPlannerOpportunities/.test(reqs[0]);
})());

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
