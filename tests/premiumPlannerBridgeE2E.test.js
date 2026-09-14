// tests/premiumPlannerBridgeE2E.test.js
// ===============================================================
// PREMIUM PLANNER — E2E offline: evaluateNewOrder → bridge → mapper
// Run: node tests/premiumPlannerBridgeE2E.test.js
//
// Validates the real chain on a fake/offline snapshot:
//   evaluateNewOrder(snapshot, newOrder)
//     → plannerResult.options            (REAL planner output)
//     → premiumPlannerBridge             (option → mapper input)
//     → premiumPlannerOpportunities      (Opportunity contract shape)
//
// Boundary:
//   - Offline: niente DB/fetch/env. Snapshot e newOrder sono fixture locali.
//   - Il planner reale produce join SOLO same-zone (planner.js:713): questo
//     E2E NON pretende Q2→Q5 cross-zone. Verifica il percorso realistico
//     attuale (separate, join_giro same-zone, blocked, retraso).
//   - context.baseline deriva dall'opzione `separate` reale (la "directa").
//     Eventuali routeEtas a valle sarebbero context fixture, non calcolate:
//     qui i giri sono single-zone, quindi non servono.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { evaluateNewOrder } = require("../src/core/delivery/planner");
const {
  buildOpportunityFromPlannerOption,
  statusFromPlannerOption,
  slipLabelFromRetraso,
  baselineFromSeparateOption,
} = require("../src/core/delivery/premiumPlannerBridge");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

const ord = (o) => ({ tipo_consegna: "DOMICILIO", estado: "NUEVO", n_pizze: 1, ...o });
const pick = (v, type) => v.options.find((o) => o.type === type);

// Tutte le chiavi della shape Opportunity contract.
const CONTRACT_KEYS = [
  "id", "kind", "giroId", "channel", "currentOrderZone", "currentOrderLabel",
  "routeZones", "mapPath", "routeEtas", "baseline", "capacity", "status",
  "severity", "blocked", "warning", "title", "subtitle", "chip",
  "explanation", "quickOptionId",
];
function hasContractShape(opp) {
  return CONTRACT_KEYS.every((k) => Object.prototype.hasOwnProperty.call(opp, k));
}

// ── Scenario A — evaluateNewOrder produce SOLO separate ─────────────────────
console.log("══ A: separate → crear ══");
{
  const v = evaluateNewOrder({ now: "17:00", orders: [] }, ord({ id: "NEW", zona: "Q2", hora: "20:00", andata_min: 6 }));
  const sep = pick(v, "separate");
  check("planner emette separate valid", sep && sep.status === "valid" && sep.retraso === 0);
  const opp = buildOpportunityFromPlannerOption(sep, { currentOrderZone: "Q2", routeZones: ["Q2"] });
  check("contract shape completa", hasContractShape(opp));
  check("kind crear (separate)", opp.kind === "crear");
  check("giroId null (crear)", opp.giroId === null);
  check("status compatible", opp.status === "compatible");
  check("channel sur (Q2)", opp.channel === "sur");
  check("mapPath Pizzería→Q2", opp.mapPath.join("→") === "Pizzería→Q2");
  check("blocked false", opp.blocked === false);
  check("title default 'Crear giro Q2'", opp.title === "Crear giro Q2");
  check("no capacity inventata (null)", opp.capacity.pizzas === null && opp.capacity.routeMin === null);
  check("routeEtas [] (non inventate)", Array.isArray(opp.routeEtas) && opp.routeEtas.length === 0);
}

// ── Scenario B — join_giro same-zone valido → agregar / compatible ──────────
console.log("══ B: join_giro same-zone → agregar / compatible ══");
{
  const v = evaluateNewOrder(
    { now: "17:00", orders: [ord({ id: "G1", zona: "Q2", hora: "20:00", andata_min: 6, estado: "EN_COCINA" })] },
    ord({ id: "NEW", zona: "Q2", hora: "20:00", andata_min: 6 })
  );
  const join = pick(v, "join_giro");
  const sep = pick(v, "separate");
  check("planner emette join_giro recommended retraso 0", join && (join.status === "recommended" || join.status === "valid") && join.retraso === 0);
  // baseline reale: la directa = opzione separate
  const baseline = baselineFromSeparateOption(sep);
  const opp = buildOpportunityFromPlannerOption(join, { currentOrderZone: "Q2", routeZones: ["Q2"], baseline });
  check("contract shape completa", hasContractShape(opp));
  check("kind agregar (join_giro)", opp.kind === "agregar");
  check("giroId passa dall'option (AU:Q2|...)", opp.giroId === join.giro_id && /Q2/.test(opp.giroId));
  check("status compatible (retraso 0)", opp.status === "compatible");
  check("channel sur", opp.channel === "sur");
  check("baseline.directEta = separate hora (20:00)", opp.baseline.directEta === "20:00");
  check("status === policy su option reale", opp.status === statusFromPlannerOption(join, {}));
}

// ── Scenario C — NO cross-zone (finding) ────────────────────────────────────
console.log("══ C: no cross-zone (Q2 new, Q5 existing) ══");
{
  const v = evaluateNewOrder(
    { now: "17:00", orders: [ord({ id: "Q5a", zona: "Q5", hora: "20:35", andata_min: 12, estado: "EN_COCINA" })] },
    ord({ id: "NEW", zona: "Q2", hora: "20:00", andata_min: 6 })
  );
  const join = pick(v, "join_giro");
  // FINDING: il planner attuale NON offre join sul giro Q5 a un ordine Q2.
  // Le opportunità Premium cross-zone "di passaggio" richiedono lo strategic layer.
  check("nessun join_giro cross-zone (planner.js:713)", !join);
  check("solo separate disponibile", v.options.length === 1 && v.options[0].type === "separate");
}

// ── Scenario D — blocked / no_agregable → no_recomendado ────────────────────
console.log("══ D: blocked no_agregable → no_recomendado ══");
{
  const v = evaluateNewOrder(
    { now: "17:30", orders: [ord({ id: "G1", zona: "Q2", hora: "17:55", andata_min: 6, estado: "EN_COCINA" })] },
    ord({ id: "NEW", zona: "Q2", hora: "18:15", andata_min: 6 })
  );
  const join = pick(v, "join_giro");
  check("planner emette join blocked no_agregable", join && join.status === "blocked" && join.no_agregable === true);
  const opp = buildOpportunityFromPlannerOption(join, { currentOrderZone: "Q2", routeZones: ["Q2"] });
  check("status no_recomendado", opp.status === "no_recomendado");
  check("blocked true (mapper policy)", opp.blocked === true);
  check("severity blocked", opp.severity === "blocked");
  check("warning = option.reason", opp.warning === join.reason && opp.warning.length > 0);
}

// ── Scenario E — retraso naturale > 0 → ajuste ──────────────────────────────
console.log("══ E: retraso naturale → ajuste ══");
{
  const v = evaluateNewOrder(
    { now: "17:00", driver: { libero_desde: "20:37" }, orders: [ord({ id: "Q5a", zona: "Q5", hora: "20:35", andata_min: 12, estado: "EN_COCINA" })] },
    ord({ id: "NEW", zona: "Q5", hora: "20:35", andata_min: 12 })
  );
  const join = pick(v, "join_giro");
  check("planner emette join recommended con retraso > 0", join && join.retraso > 0, join && String(join.retraso));
  const opp = buildOpportunityFromPlannerOption(join, { currentOrderZone: "Q5", routeZones: ["Q5"] });
  check("status ajuste", opp.status === "ajuste");
  check("severity warning", opp.severity === "warning");
  check("blocked false", opp.blocked === false);
  check("slipLabel da retraso reale (backend) = '+" + join.retraso + "'", slipLabelFromRetraso(join.retraso) === `+${join.retraso}`);
  check("channel sur (Q5)", opp.channel === "sur");
  // OSSERVAZIONE (finding): il warning qui = option.reason positiva ("aggregabile…"),
  // che NON comunica il ritardo. Lo strategic layer dovrà fornire un warning più
  // chiaro (es. "+N min") per gli ajuste. Il bridge non lo riscrive da solo.
  check("warning presente (= option.reason)", opp.warning === join.reason);
}

// ── Consistenza generale: ogni option reale → opportunity coerente ──────────
console.log("══ Consistency: option reale → opportunity ══");
{
  const v = evaluateNewOrder(
    { now: "17:00", orders: [ord({ id: "G1", zona: "Q2", hora: "20:00", andata_min: 6, estado: "EN_COCINA" })] },
    ord({ id: "NEW", zona: "Q2", hora: "20:00", andata_min: 6 })
  );
  let allOk = true;
  for (const o of v.options) {
    const opp = buildOpportunityFromPlannerOption(o, { currentOrderZone: "Q2", routeZones: ["Q2"] });
    if (!hasContractShape(opp)) allOk = false;
    if (opp.status !== statusFromPlannerOption(o, {})) allOk = false;
    const expectedKind = o.type === "separate" ? "crear" : "agregar";
    if (opp.kind !== expectedKind) allOk = false;
  }
  check("ogni option → contract shape + status/kind coerenti", allOk);
}

// ── Scenario RI — option reale + routeImpactInput → ETA/slip da routeImpact ──
// Il planner reale dà un join_giro same-zone (planner.js:713). Allegando un
// routeImpactInput al context, l'Opportunity finale porta routeEtas/slipLabel
// COMPUTATI dal route-impact engine (non dal retraso del planner). Cross-zone
// "di passaggio" resta allo strategic layer futuro: qui provo solo il wiring.
console.log("══ RI: option reale + routeImpactInput → ETA/slip computati ══");
{
  const v = evaluateNewOrder(
    { now: "17:00", orders: [ord({ id: "G1", zona: "Q2", hora: "20:00", andata_min: 6, estado: "EN_COCINA" })] },
    ord({ id: "NEW", zona: "Q2", hora: "20:00", andata_min: 6 })
  );
  const join = pick(v, "join_giro");
  check("planner emette join_giro", !!join);
  const opp = buildOpportunityFromPlannerOption(join, {
    currentOrderZone: "Q2",
    routeZones: ["Q2", "Q5"],
    routeImpactInput: {
      startTime: "20:43",
      stops: [
        { id: "NEW", zone: "Q2", label: "Pedido actual", isNew: true, promised: "20:50", pizzas: 1, serviceMin: 2, travelFromPrevMin: 7 },
        { id: "q5", zone: "Q5", label: "Las Marinas", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 13 },
      ],
      returnTravelMin: 15,
      capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
      toleranceMin: 0,
    },
  });
  check("contract shape completa", hasContractShape(opp));
  check("routeEtas da routeImpact (2 fermate)", opp.routeEtas.length === 2);
  check("Q5 slipLabel '+5' computato", opp.routeEtas[1].slipLabel === "+5");
  check("status ajuste da routeImpact", opp.status === "ajuste");
  check("warning backend 'Q5 se mueve +5 min'", opp.warning === "Q5 se mueve +5 min");
  check("channel sur (mapper)", opp.channel === "sur");
}

// ── Purity ──────────────────────────────────────────────────────────────────
// Check the actual require() targets (not a self-regex, which would match the
// purity strings written in this very file). The E2E pulls only the pure planner
// + bridge chain and test infra (fs/path); no DB/env/fetch module.
console.log("══ Purity ══");
{
  const src = fs.readFileSync(path.join(__dirname, "premiumPlannerBridgeE2E.test.js"), "utf8");
  const reqs = (src.match(/require\(["']([^"']+)["']\)/g) || []).map((r) => r.replace(/require\(["']|["']\)/g, ""));
  const allowed = new Set(["fs", "path", "../src/core/delivery/planner", "../src/core/delivery/premiumPlannerBridge"]);
  check("requires only planner + bridge + fs/path", reqs.every((r) => allowed.has(r)), reqs.join(","));
  check("no supabase/env/api require", !reqs.some((r) => /supabase|api|env|fetch|axios|node-fetch/i.test(r)));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
