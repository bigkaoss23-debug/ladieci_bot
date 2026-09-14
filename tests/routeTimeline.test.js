// tests/routeTimeline.test.js
// ===============================================================
// PREMIUM PLANNER — routeTimeline v2 mapper: pure offline test
// Run: node tests/routeTimeline.test.js
//
// Verifica il mapper `buildRouteTimeline` contro i 5 fixture canonici del design
// (PREMIUM_PLANNER_ROUTE_TIMELINE_V2_DESIGN.md §6): A compatible, B ajuste +5,
// C margen muy justo (tight), D cross no_recomendado, E lleno. Più casi
// obbligatori (departure/return, seq, new/anchor, slip, summary, missing
// driverReturn/routeEtas, no Date.now, purezza, no-mutazione input).
//
// Boundary: mapper PURO (no IO/DB/fetch/env/Date.now). Usa buildRouteImpact
// reale per A/B/C/E così il test copre la catena vera engine→mapper.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { buildRouteImpact } = require("../src/core/delivery/routeImpact");
const {
  VERSION,
  buildRouteTimeline,
} = require("../src/core/delivery/routeTimeline");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}
function nodeByType(tl, type) { return tl.timeline.find((n) => n.type === type); }
function deliveries(tl) { return tl.timeline.filter((n) => n.type === "delivery"); }

// ── Fixture A — Compatible pulito (risk ok) ──────────────────────────────────
console.log("══ A. Compatible (risk ok) ══");
{
  const impact = buildRouteImpact({
    startTime: "20:41",
    stops: [
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: null, pizzas: 2, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", label: "Pedido Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 4, maxPizzas: 6, routeMinLimit: 40, pizzaQualityLimitMin: 120 },
    toleranceMin: 0,
  });
  const tl = buildRouteTimeline({
    proposalId: "opp-q2-q5-A", startTime: "20:41", routeImpact: impact,
    stops: null, baseline: { directEta: "20:48" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning, explanation: impact.explanation,
  });
  check("version route-timeline-v2", tl.version === VERSION);
  check("risk ok", tl.risk === "ok", tl.risk);
  check("4 nodi (dep+2+ret)", tl.timeline.length === 4, String(tl.timeline.length));
  check("departure eta 20:41", nodeByType(tl, "departure").eta === "20:41");
  check("Q2 delivery eta 20:48 new", deliveries(tl)[0].eta === "20:48" && deliveries(tl)[0].isNewOrder === true && deliveries(tl)[0].isAnchor === false);
  check("Q5 delivery eta 21:00 anchor sin slip", deliveries(tl)[1].eta === "21:00" && deliveries(tl)[1].isAnchor === true && deliveries(tl)[1].slipLabel === null);
  check("Q5 marginLabel +0 margen", deliveries(tl)[1].marginLabel === "+0 margen", deliveries(tl)[1].marginLabel);
  check("return eta 21:17", nodeByType(tl, "return").eta === "21:17", nodeByType(tl, "return").eta);
  check("summary giroEta 21:00 returnEta 21:17 directEta 20:48", tl.summary.giroEta === "21:00" && tl.summary.returnEta === "21:17" && tl.summary.directEta === "20:48");
  check("tradeoffLabel +12 vs directa + viaje ahorrado", tl.summary.tradeoffLabel === "+12 vs directa · 1 viaje ahorrado", tl.summary.tradeoffLabel);
  check("operatorMessage compatible menciona Q2 antes de Q5", /Compatible/.test(tl.operatorMessage) && /Q2/.test(tl.operatorMessage) && /Q5/.test(tl.operatorMessage), tl.operatorMessage);
  check("all delivery status ok", deliveries(tl).every((d) => d.status === "ok"));
}

// ── Fixture B — Ajuste +5 (risk warning) ─────────────────────────────────────
console.log("══ B. Ajuste +5 (risk warning) ══");
{
  const impact = buildRouteImpact({
    startTime: "20:46",
    stops: [
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: null, pizzas: 2, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", label: "Pedido Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 4, maxPizzas: 6, routeMinLimit: 40, pizzaQualityLimitMin: 120 },
    toleranceMin: 0,
  });
  const tl = buildRouteTimeline({
    proposalId: "opp-q2-q5-B", startTime: "20:46", routeImpact: impact,
    baseline: { directEta: "20:53" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning, explanation: impact.explanation,
  });
  check("risk warning", tl.risk === "warning", tl.risk);
  check("Q5 eta 21:05 slipLabel +5", deliveries(tl)[1].eta === "21:05" && deliveries(tl)[1].slipLabel === "+5", `${deliveries(tl)[1].eta}/${deliveries(tl)[1].slipLabel}`);
  check("Q5 status ajuste", deliveries(tl)[1].status === "ajuste", deliveries(tl)[1].status);
  check("Q5 marginLabel −5 vs prometido", deliveries(tl)[1].marginLabel === "−5 vs prometido", deliveries(tl)[1].marginLabel);
  check("Q5 warning 'Q5 se mueve +5 min'", deliveries(tl)[1].warning === "Q5 se mueve +5 min", deliveries(tl)[1].warning);
  check("Q2 status ok (no slip)", deliveries(tl)[0].status === "ok");
  check("operatorMessage cede +5", /cede \+5 min/.test(tl.operatorMessage), tl.operatorMessage);
  check("summary giroEta 21:05", tl.summary.giroEta === "21:05");
}

// ── Fixture C — Margen muy justo (risk tight) ────────────────────────────────
console.log("══ C. Margen muy justo (risk tight) ══");
{
  const impact = buildRouteImpact({
    startTime: "20:41",
    stops: [
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: null, pizzas: 2, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", label: "Pedido Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 4, maxPizzas: 6, routeMinLimit: 38, pizzaQualityLimitMin: 120 }, // routeMin 36, slack 2 ≤ 3
    toleranceMin: 0,
  });
  const tl = buildRouteTimeline({
    proposalId: "opp-q2-q5-C", startTime: "20:41", routeImpact: impact,
    baseline: { directEta: "20:48" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning, explanation: impact.explanation,
  });
  check("engine status compatible (no over)", impact.status === "compatible", impact.status);
  check("risk tight", tl.risk === "tight", tl.risk);
  check("Q5 status tight (last)", deliveries(tl)[1].status === "tight", deliveries(tl)[1].status);
  check("nessuno slip", deliveries(tl).every((d) => d.slipLabel === null));
  check("operatorMessage margen muy justo", /margen muy justo/.test(tl.operatorMessage), tl.operatorMessage);
}

// ── Fixture D — Cross-channel no recomendado (no green, no eta) ───────────────
console.log("══ D. Cross-channel no_recomendado ══");
{
  const tl = buildRouteTimeline({
    proposalId: "opp-cross-D", startTime: "20:50", routeImpact: null,
    stops: [
      { zone: "Q5", label: "Pedido actual", isNew: true, promised: null },
      { zone: "Q3", label: "Pedido Q3", isNew: false, promised: "21:10" },
    ],
    baseline: null, kind: "agregar", channel: "cross",
    status: "no_recomendado", blocked: true, warning: "Canales distintos", explanation: "",
  });
  check("risk no_recomendado", tl.risk === "no_recomendado", tl.risk);
  check("nessun eta inventato (tutti null)", tl.timeline.every((n) => n.eta === null), JSON.stringify(tl.timeline.map((n) => n.eta)));
  check("nessun nodo verde (no status ok)", tl.timeline.every((n) => n.status !== "ok"), JSON.stringify(tl.timeline.map((n) => n.status)));
  check("delivery Q5 new / Q3 anchor", deliveries(tl)[0].isNewOrder === true && deliveries(tl)[1].isAnchor === true);
  check("summary tutto null/empty", tl.summary.directEta === null && tl.summary.giroEta === null && tl.summary.returnEta === null && tl.summary.tradeoffLabel === "");
  check("operatorMessage canales distintos prudente", /Canales distintos|no recomendado/i.test(tl.operatorMessage), tl.operatorMessage);
}

// ── Fixture E — Lleno / capacity (risk full) ─────────────────────────────────
console.log("══ E. Lleno (risk full) ══");
{
  const impact = buildRouteImpact({
    startTime: "20:41",
    stops: [
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: null, pizzas: 3, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", label: "Pedido Q5", isNew: false, promised: "21:00", pizzas: 4, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 7, maxPizzas: 6, routeMinLimit: 40, pizzaQualityLimitMin: 120 },
    toleranceMin: 0,
  });
  const tl = buildRouteTimeline({
    proposalId: "opp-q2-q5-E", startTime: "20:41", routeImpact: impact,
    baseline: { directEta: "20:48" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning, explanation: impact.explanation,
  });
  check("engine status lleno", impact.status === "lleno", impact.status);
  check("risk full", tl.risk === "full", tl.risk);
  check("delivery status lleno", deliveries(tl).every((d) => d.status === "lleno"));
  check("etas reali presenti (no null)", deliveries(tl).every((d) => d.eta !== null));
  check("operatorMessage giro lleno 7/6", /Giro lleno: 7\/6/.test(tl.operatorMessage), tl.operatorMessage);
}

// ── Regression — capacity null NON deve diventare full ───────────────────────
console.log("══ Regression: capacity null ≠ full ══");
{
  const impact = buildRouteImpact({
    startTime: "20:41",
    stops: [
      { id: "new-q2", zone: "Q2", isNew: true, promised: null, pizzas: 2, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: {}, // nessun limite → desconocida
  });
  const tl = buildRouteTimeline({
    proposalId: "opp-nullcap", startTime: "20:41", routeImpact: impact,
    baseline: { directEta: "20:48" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning,
  });
  check("capacity.state desconocida", impact.capacity.state === "desconocida", impact.capacity.state);
  check("risk NON full", tl.risk !== "full", tl.risk);
  check("risk ok (sin slip, sin límite)", tl.risk === "ok", tl.risk);
}

// ── Obbligatori: struttura ───────────────────────────────────────────────────
console.log("══ Obbligatori: struttura ══");
{
  const impact = buildRouteImpact({
    startTime: "19:50",
    stops: [
      { id: "q1", zone: "Q1", label: "Centro", isNew: false, promised: "20:00", pizzas: 1, serviceMin: 2, travelFromPrevMin: 10 },
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: null, pizzas: 1, serviceMin: 2, travelFromPrevMin: 8 },
      { id: "q5", zone: "Q5", label: "Pedido Q5", isNew: false, promised: "20:30", pizzas: 1, serviceMin: 2, travelFromPrevMin: 13 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 90, pizzaQualityLimitMin: 120 },
  });
  const tl = buildRouteTimeline({
    proposalId: "opp-multi", startTime: "19:50", routeImpact: impact,
    baseline: { directEta: "20:05" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning,
  });
  check("emits departure", nodeByType(tl, "departure") != null && nodeByType(tl, "departure").label === "Pizzería");
  check("emits return", nodeByType(tl, "return") != null && nodeByType(tl, "return").label === "Regreso pizzería");
  const seqs = tl.timeline.map((n) => n.seq);
  check("seq stabile 0..n", seqs.every((s, i) => s === i), JSON.stringify(seqs));
  const dz = deliveries(tl).map((d) => d.zone);
  check("preserves delivery order Q1,Q2,Q5", dz.join(",") === "Q1,Q2,Q5", dz.join(","));
  check("marks new vs anchor", deliveries(tl)[1].isNewOrder === true && deliveries(tl)[0].isAnchor === true && deliveries(tl)[2].isAnchor === true);
  check("summary.directEta/giroEta/returnEta presenti", typeof tl.summary.directEta === "string" && typeof tl.summary.giroEta === "string" && typeof tl.summary.returnEta === "string");
  check("operatorMessage presente (non vuoto)", typeof tl.operatorMessage === "string" && tl.operatorMessage.length > 0);
  check("ogni nodo ha tutti i campi", tl.timeline.every((n) =>
    ["seq", "type", "zone", "label", "eta", "promised", "slipLabel", "status", "marginLabel", "isNewOrder", "isAnchor", "warning"]
      .every((k) => Object.prototype.hasOwnProperty.call(n, k))));
}

// ── Obbligatori: degradi safe ────────────────────────────────────────────────
console.log("══ Obbligatori: missing driverReturn / routeEtas ══");
{
  // driverReturn assente: route altrimenti valida → return eta null, no crash.
  const tlNoReturn = buildRouteTimeline({
    proposalId: "opp-noreturn", startTime: "20:41",
    routeImpact: {
      routeEtas: [{ zone: "Q2", label: "Pedido actual", eta: "20:48", promised: null, slips: false, slipLabel: "", isNew: true }],
      driverReturn: null, routeMin: null, capacity: { pizzas: "2", state: "desconocida" }, status: "compatible", blocked: false, warning: "", explanation: "",
    },
    baseline: { directEta: "20:48" }, kind: "crear", channel: "sur", status: "compatible",
  });
  check("missing driverReturn → returnEta null, no crash", tlNoReturn.summary.returnEta === null && nodeByType(tlNoReturn, "return") != null);
  check("missing driverReturn → departure presente con eta", nodeByType(tlNoReturn, "departure").eta === "20:41");

  // routeEtas vuoto/assente: timeline minima departure+return, risk blocked.
  const tlNoEtas = buildRouteTimeline({
    proposalId: "opp-noetas", startTime: "20:41", routeImpact: { routeEtas: [], driverReturn: null }, stops: [],
    baseline: null, kind: "agregar", channel: "sur",
  });
  check("missing routeEtas → solo departure+return", tlNoEtas.timeline.length === 2 && tlNoEtas.timeline[0].type === "departure" && tlNoEtas.timeline[1].type === "return");
  check("missing routeEtas → risk blocked (safe)", tlNoEtas.risk === "blocked", tlNoEtas.risk);
  check("missing routeEtas → operatorMessage prudente", /no se puede estimar/i.test(tlNoEtas.operatorMessage), tlNoEtas.operatorMessage);
}

// ── Obbligatori: input non mutato + determinismo ─────────────────────────────
console.log("══ Obbligatori: no-mutazione + determinismo ══");
{
  const impactInput = {
    startTime: "20:41",
    stops: [
      { id: "new-q2", zone: "Q2", isNew: true, promised: null, pizzas: 2, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 4, maxPizzas: 6, routeMinLimit: 40 },
  };
  const impact = buildRouteImpact(impactInput);
  const args = {
    proposalId: "opp-det", startTime: "20:41", routeImpact: impact,
    baseline: { directEta: "20:48" }, kind: "agregar", channel: "sur",
    status: impact.status, blocked: impact.blocked, warning: impact.warning,
  };
  const frozenArgs = Object.freeze({ ...args });
  const a = buildRouteTimeline(frozenArgs);
  const b = buildRouteTimeline(frozenArgs);
  check("output deterministico (stesso input → stesso output)", JSON.stringify(a) === JSON.stringify(b));
  check("impact non mutato (routeEtas[0].isNew intatto)", impact.routeEtas[0].isNew === true);
  check("baseline arg non mutato", args.baseline.directEta === "20:48");
  // chiamata difensiva: nessun arg → nessun crash, struttura minima.
  const empty = buildRouteTimeline();
  check("buildRouteTimeline() senza arg → no crash, 2 nodi", Array.isArray(empty.timeline) && empty.timeline.length === 2);
}

// ── Purity: no IO/Date.now/env, solo require puri ────────────────────────────
console.log("══ Purity ══");
{
  const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/routeTimeline.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const reqs = (code.match(/require\(["']([^"']+)["']\)/g) || []).map((r) => r.replace(/require\(["']|["']\)/g, ""));
  check("require solo moduli puri locali (./routeImpact)", reqs.every((r) => r === "./routeImpact"), reqs.join(","));
  check("no Date.now", !/Date\.now/.test(code));
  check("no process.env", !/process\.env/.test(code));
  check("no fetch/supabase/router/db-verbs", !/\bfetch\b|axios|supabase|express|\brouter\b|app\.(get|post|put|patch|delete)|\b(insert|update|delete|upsert|rpc)\s*\(/i.test(code));
  check("no manual_giro/applyManualGiro/whatsapp", !/manual_giro|applyManualGiro|whatsapp|wa_msgs/i.test(code));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
