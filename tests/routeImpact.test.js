// tests/routeImpact.test.js
// ===============================================================
// PREMIUM PLANNER — route-impact engine: pure offline test
// Run: node tests/routeImpact.test.js
//
// Boundary:
//   - routeImpact.js è puro: ZERO import, niente DB/fetch/env/router/wiring.
//   - Tutti i tempi di viaggio arrivano dalle fixture (schema a zone, no Google).
//   - Verifica ETA cumulativi, slip per fermata, slipLabel "+N", driverReturn,
//     routeMin, capacity.state, status, blocked, warning backend-side.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const {
  toMin,
  fromMin,
  formatSlipLabel,
  computeStopSlip,
  computeRouteEtas,
  classifyCapacity,
  buildRouteImpact,
  buildRouteImpactOpportunityFields,
} = require("../src/core/delivery/routeImpact");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// ── Unit: helper temporali + slipLabel ──────────────────────────────────────
console.log("══ Unit: helpers ══");
check("toMin 20:35 = 1235", toMin("20:35") === 1235);
check("toMin after-midnight 00:30 → +24h", toMin("00:30") === 24 * 60 + 30);
check("fromMin 1235 = 20:35", fromMin(1235) === "20:35");
check("fromMin null → null", fromMin(null) === null);
check("formatSlipLabel 5 = '+5'", formatSlipLabel(5) === "+5");
check("formatSlipLabel 0 = ''", formatSlipLabel(0) === "");
check("formatSlipLabel neg = ''", formatSlipLabel(-3) === "");

console.log("══ Unit: computeStopSlip ══");
{
  const onTime = computeStopSlip("21:00", "21:00", 0);
  check("on time → no slip", onTime.slips === false && onTime.slipLabel === "");
  const late = computeStopSlip("21:05", "21:00", 0);
  check("late +5 → slip '+5'", late.slips === true && late.slipLabel === "+5" && late.slipMin === 5);
  const tol = computeStopSlip("21:05", "21:00", 10);
  check("within tolerance → no slip", tol.slips === false);
  const noProm = computeStopSlip("21:05", null, 0);
  check("no promised → no slip", noProm.slips === false && noProm.slipLabel === "");
}

// ── Scenario 1 — compatible (Q2 prima di Q5, nessuno slip) ───────────────────
console.log("══ 1. compatible ══");
{
  const out = buildRouteImpact({
    startTime: "20:43",
    stops: [
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: "20:50", pizzas: 1, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", label: "Las Marinas", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 8 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    toleranceMin: 0,
  });
  check("Q2 eta 20:50", out.routeEtas[0].eta === "20:50");
  check("Q5 eta 21:00", out.routeEtas[1].eta === "21:00");
  check("nessuno slip", out.routeEtas.every((e) => e.slips === false));
  check("status compatible", out.status === "compatible");
  check("blocked false", out.blocked === false);
  check("warning vuoto", out.warning === "");
  check("driverReturn 21:17", out.driverReturn === "21:17", out.driverReturn);
  check("routeMin 34", out.routeMin === 34, String(out.routeMin));
  check("capacity 3/6 ok", out.capacity.pizzas === "3/6" && out.capacity.state === "ok");
  check("isNew preservato su Q2", out.routeEtas[0].isNew === true);
}

// ── Scenario 2 — ajuste (Q5 promised 21:00, eta 21:05 → +5) ──────────────────
console.log("══ 2. ajuste +5 ══");
{
  const out = buildRouteImpact({
    startTime: "20:43",
    stops: [
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: "20:50", pizzas: 1, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", label: "Las Marinas", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 13 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    toleranceMin: 0,
  });
  check("Q5 eta 21:05", out.routeEtas[1].eta === "21:05", out.routeEtas[1].eta);
  check("Q5 slips true", out.routeEtas[1].slips === true);
  check("Q5 slipLabel '+5'", out.routeEtas[1].slipLabel === "+5");
  check("Q2 non slitta", out.routeEtas[0].slips === false);
  check("status ajuste", out.status === "ajuste");
  check("blocked false", out.blocked === false);
  check("warning 'Q5 se mueve +5 min'", out.warning === "Q5 se mueve +5 min", out.warning);
}

// ── Scenario 3 — capacity full by pizzas (7/6) ──────────────────────────────
console.log("══ 3. lleno (pizzas 7/6) ══");
{
  const out = buildRouteImpact({
    startTime: "20:00",
    stops: [
      { id: "a", zone: "Q2", label: "A", isNew: true, promised: "20:20", pizzas: 4, serviceMin: 2, travelFromPrevMin: 10 },
      { id: "b", zone: "Q5", label: "B", isNew: false, promised: "20:30", pizzas: 3, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 7, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    toleranceMin: 0,
  });
  check("status lleno", out.status === "lleno");
  check("blocked true", out.blocked === true);
  check("capacity 7/6 full", out.capacity.pizzas === "7/6" && out.capacity.state === "full");
  check("warning menciona pizzas", /7\/6/.test(out.warning), out.warning);
}

// ── Scenario 4 — route too long (routeMin > limite) → no_recomendado ─────────
// Scelta documentata (design §B.7): durata oltre limite = giro operativamente
// brutto/forzabile con avviso → no_recomendado (blocked=false), NON lleno
// (che è riservato alla capacità rider piena per pizze).
console.log("══ 4. no_recomendado (ruta larga) ══");
{
  const out = buildRouteImpact({
    startTime: "20:00",
    stops: [
      { id: "a", zone: "Q2", label: "A", isNew: true, promised: "20:20", pizzas: 1, serviceMin: 2, travelFromPrevMin: 20 },
      { id: "b", zone: "Q5", label: "B", isNew: false, promised: "20:42", pizzas: 2, serviceMin: 2, travelFromPrevMin: 20 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 30, pizzaQualityLimitMin: 120 },
    toleranceMin: 0,
  });
  check("routeMin 59", out.routeMin === 59, String(out.routeMin));
  check("status no_recomendado", out.status === "no_recomendado");
  check("blocked false (forzabile)", out.blocked === false);
  check("capacity state tight", out.capacity.state === "tight");
  check("warning ruta larga", /Ruta demasiado larga: 59 min \(límite 30\)/.test(out.warning), out.warning);
}

// ── Scenario 5 — multiple downstream stops Q1→Q2→Q5, Q2 slitta ───────────────
console.log("══ 5. multi-stop (Q1→Q2→Q5), Q2 +5 ══");
{
  const out = buildRouteImpact({
    startTime: "19:50",
    stops: [
      { id: "q1", zone: "Q1", label: "Centro", isNew: false, promised: "20:00", pizzas: 1, serviceMin: 2, travelFromPrevMin: 10 },
      { id: "new-q2", zone: "Q2", label: "Pedido actual", isNew: true, promised: "20:05", pizzas: 1, serviceMin: 2, travelFromPrevMin: 8 },
      { id: "q5", zone: "Q5", label: "Las Marinas", isNew: false, promised: "20:25", pizzas: 1, serviceMin: 2, travelFromPrevMin: 13 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    toleranceMin: 0,
  });
  check("3 routeEtas presenti", out.routeEtas.length === 3);
  check("Q1 eta 20:00 no slip", out.routeEtas[0].eta === "20:00" && out.routeEtas[0].slips === false);
  check("Q2 eta 20:10 slip +5", out.routeEtas[1].eta === "20:10" && out.routeEtas[1].slipLabel === "+5", out.routeEtas[1].eta);
  check("Q5 eta 20:25 no slip", out.routeEtas[2].eta === "20:25" && out.routeEtas[2].slips === false, out.routeEtas[2].eta);
  check("status ajuste", out.status === "ajuste");
  check("warning solo Q2", out.warning === "Q2 se mueve +5 min", out.warning);
}

// ── Scenario 6 — no promised → nessuno slip, output stabile ──────────────────
console.log("══ 6. no promised ══");
{
  const out = buildRouteImpact({
    startTime: "20:00",
    stops: [
      { id: "x", zone: "Q2", label: "Sin promesa", isNew: true, pizzas: 1, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 10,
    capacity: { pizzas: 1, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
    toleranceMin: 0,
  });
  check("promised null", out.routeEtas[0].promised === null);
  check("slips false", out.routeEtas[0].slips === false);
  check("slipLabel ''", out.routeEtas[0].slipLabel === "");
  check("status compatible", out.status === "compatible");
  check("warning vuoto", out.warning === "");
}

// ── Mapper hand-off: buildRouteImpactOpportunityFields ──────────────────────
console.log("══ Mapper hand-off ══");
{
  const impact = buildRouteImpact({
    startTime: "20:43",
    stops: [
      { id: "new-q2", zone: "Q2", isNew: true, promised: "20:50", pizzas: 1, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 13 },
    ],
    returnTravelMin: 15,
    capacity: { pizzas: 3, maxPizzas: 6, routeMinLimit: 60, pizzaQualityLimitMin: 60 },
  });
  const fields = buildRouteImpactOpportunityFields(impact);
  const keys = ["routeEtas", "capacity", "status", "blocked", "warning", "explanation"];
  check("subset con tutte le chiavi mapper", keys.every((k) => Object.prototype.hasOwnProperty.call(fields, k)));
  check("status propagato", fields.status === "ajuste");
  check("routeEtas senza campi interni (_slipMin)", fields.routeEtas.every((e) => !("_slipMin" in e)));
  check("capacity senza flag interni", !("_pizzasFull" in fields.capacity) && !("_durationOver" in fields.capacity));
}

// ── Regression: capacità mancante NON deve diventare 0/lleno (null≠0) ────────
// Bug: Number(null)===0, Number("")===0 → Number.isFinite(Number(x)) trattava
// null/"" come 0 → maxPizzas 0 → ogni rotta con pizze>0 usciva "full"/lleno.
console.log("══ Regression: capacità mancante (null≠0) ══");
{
  // maxPizzas null/undefined/""/NaN → NON full, stato "desconocida".
  for (const [label, mp] of [["null", null], ["undefined", undefined], ["empty-string", ""], ["NaN", NaN]]) {
    const cap = classifyCapacity({ pizzas: 3, maxPizzas: mp }, 36, false);
    check(`maxPizzas ${label} → NON full`, cap.state !== "full" && cap._pizzasFull === false, JSON.stringify(cap));
    check(`maxPizzas ${label} → state desconocida`, cap.state === "desconocida", JSON.stringify(cap));
    check(`maxPizzas ${label} → pizzas senza denominatore "3"`, cap.pizzas === "3", cap.pizzas);
  }
  // maxPizzas 0 NUMERICO reale → capacità zero → full se pizze>0.
  const zero = classifyCapacity({ pizzas: 3, maxPizzas: 0 }, 36, false);
  check("maxPizzas 0 reale → full (3>0)", zero.state === "full" && zero._pizzasFull === true, JSON.stringify(zero));
  // 0 pizze e maxPizzas 0 → NON full (0 non supera 0).
  const zeroZero = classifyCapacity({ pizzas: 0, maxPizzas: 0 }, 10, false);
  check("0 pizze / maxPizzas 0 → NON full", zeroZero._pizzasFull === false, JSON.stringify(zeroZero));
  // capacità reale piena resta full.
  const realFull = classifyCapacity({ pizzas: 7, maxPizzas: 6 }, 36, false);
  check("7/6 reale → full", realFull.state === "full" && realFull._pizzasFull === true, JSON.stringify(realFull));
  // limite noto e rispettato resta ok.
  const okCap = classifyCapacity({ pizzas: 3, maxPizzas: 6, routeMinLimit: 60 }, 36, false);
  check("3/6 con limiti noti → ok", okCap.state === "ok", JSON.stringify(okCap));
  // routeMinLimit null non deve forzare durationOver.
  const noLimit = classifyCapacity({ pizzas: 3, maxPizzas: 6, routeMinLimit: null }, 999, false);
  check("routeMinLimit null → NON durationOver", noLimit._durationOver === false, JSON.stringify(noLimit));

  // chiamata "scalare" difensiva: classifyCapacity(null) non deve crashare né full.
  check("classifyCapacity(null) → NON full", classifyCapacity(null)._pizzasFull === false);
}

// ── Regression: buildRouteImpact Q2→Q5 SENZA capacity → niente lleno falso ────
console.log("══ Regression: buildRouteImpact senza capacity ══");
{
  // Stessa rotta del wiring (Q2→Q5) ma con capacity {} (nessun limite noto):
  // pizzaQualityLimitMin null NON deve diventare 0 (→ no_recomendado falso),
  // maxPizzas null NON deve diventare 0 (→ lleno falso). Atteso: compatible.
  const impact = buildRouteImpact({
    startTime: "20:35",
    stops: [
      { id: "new-q2", zone: "Q2", isNew: true, promised: "20:50", pizzas: 1, serviceMin: 2, travelFromPrevMin: 7 },
      { id: "q5", zone: "Q5", isNew: false, promised: "21:00", pizzas: 2, serviceMin: 2, travelFromPrevMin: 10 },
    ],
    returnTravelMin: 15,
    capacity: {}, // nessun limite → tutto ignoto
  });
  check("status compatible (non lleno/no_recomendado)", impact.status === "compatible", impact.status);
  check("blocked false", impact.blocked === false, String(impact.blocked));
  check("capacity.state desconocida (non full)", impact.capacity.state === "desconocida", JSON.stringify(impact.capacity));
  check("nessuno slip (rotta puntuale)", impact.routeEtas.every((e) => e.slips === false));
}

// ── Purity: nessun require (modulo a zero dipendenze) ────────────────────────
console.log("══ Purity ══");
{
  const src = fs.readFileSync(path.join(__dirname, "../src/core/delivery/routeImpact.js"), "utf8");
  // Strip block + line comments: i nomi vietati (fetch/router…) compaiono solo
  // nell'header documentale; vogliamo controllare il CODICE, non i commenti.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const reqs = (code.match(/require\(["']([^"']+)["']\)/g) || []);
  check("routeImpact.js ZERO require", reqs.length === 0, reqs.join(","));
  check("no process.env", !/process\.env/.test(code));
  check("no fetch/supabase/router (code)", !/\bfetch\b|supabase|express|\brouter\b|app\.(get|post|put|patch|delete)/i.test(code));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail === 0 ? 0 : 1);
