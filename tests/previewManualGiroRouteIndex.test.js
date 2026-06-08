// tests/previewManualGiroRouteIndex.test.js
// ===============================================================
// Premium Planner — `previewManualGiroRoute` dispatcher wiring guard.
// Run: node tests/previewManualGiroRouteIndex.test.js
//
// Boundary:
//   - Part 1 (static): source-inspection di index.js (NON avvia il server, NON
//     tocca DB). Verifica che la action sia wired READ-ONLY: importata, cablata
//     in app.post("/api"), senza writer, senza Date.now, senza apply/manual_giros,
//     senza DB (questa action è pura sui dati input), un solo app.post("/api"),
//     sotto il gate auth comune.
//   - Part 2 (integration): replica la stessa mappatura del dispatcher e chiama
//     l'action — happy path Q2→Q5, missing_start_time, no PII, read-only.
// ===============================================================
"use strict";

const fs = require("fs");
const path = require("path");

const { previewManualGiroRoute } = require("../src/agents/previewManualGiroRoute");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// ── Part 1: index.js wiring (source-inspection) ───────────────────────────────
const src = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");

console.log("\n── index.js previewManualGiroRoute wiring ──");

check("imports previewManualGiroRoute adapter",
  /require\(["']\.\/src\/agents\/previewManualGiroRoute["']\)/.test(src));
check('dispatches action "previewManualGiroRoute"',
  /action === ["']previewManualGiroRoute["']/.test(src));

// Isola il blocco della nuova action per i check mirati.
const actionBlock = (src.match(/action === ["']previewManualGiroRoute["'][\s\S]*?\} else if/) || [""])[0];
check("calls previewManualGiroRoute(...) nel blocco",
  /previewManualGiroRoute\(/.test(actionBlock), actionBlock.slice(0, 80));
check("inoltra selectedStops/startTime/currentOrderDraft",
  /selectedStops:\s*mg\.selectedStops/.test(actionBlock) &&
  /startTime:\s*mg\.startTime/.test(actionBlock) &&
  /currentOrderDraft:\s*mg\.currentOrderDraft/.test(actionBlock), actionBlock);
check("NON inietta writer (sbInsert/sbUpdate/sbUpsert/sbDelete) nel blocco",
  !/sb(Insert|Update|Upsert|Delete)/.test(actionBlock), actionBlock);
check("NON inietta DB / createReadOnlyRestDb (action pura sui dati input)",
  !/createReadOnlyRestDb|loadSnapshot|sbSelect/.test(actionBlock), actionBlock);
check("NON inoltra snapshot/anchors dal client (no injection)",
  !/snapshot:\s*mg\.snapshot|anchors:\s*mg\.anchors/.test(actionBlock), actionBlock);

// Strip dei commenti: i check negativi guardano il CODICE, non i commenti.
const actionCode = actionBlock.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
check("NON usa Date.now nel blocco (codice)", !/Date\.now/.test(actionCode), actionCode);
check("NON introduce manual_giros write / applyManualGiro nel blocco (codice)",
  !/applyManualGiro|manual_giros/.test(actionCode), actionCode);

// Le action pre-esistenti restano intatte.
check("previewStrategicOpportunities action ancora presente",
  /action === ["']previewStrategicOpportunities["']/.test(src));
check("createOrden action ancora presente", /action === ["']createOrden["']/.test(src));
check("unknown action handler invariato", /unknown action/.test(src));
check("un solo /api POST (nessun nuovo app.post non richiesto)",
  (src.match(/app\.post\(["']\/api["']/g) || []).length === 1,
  String((src.match(/app\.post\(["']\/api["']/g) || []).length) + " app.post /api");

// ── Part 1b: gate auth comune ereditato ───────────────────────────────────────
console.log("\n── index.js auth gate (ereditato) ──");
check("auth middleware app.use(\"/api\", …) presente",
  /app\.use\(\s*["']\/api["']\s*,/.test(src));
check("auth gate confronta x-api-key/_k con DASHBOARD_API_KEY",
  /req\.headers\[["']x-api-key["']\]\s*\|\|\s*req\.query\._k/.test(src) && /DASHBOARD_API_KEY/.test(src));
check("auth middleware registrato PRIMA di app.post(\"/api\")",
  src.indexOf('app.use("/api"') !== -1 &&
  src.indexOf('app.use("/api"') < src.indexOf('app.post("/api"'),
  `useIdx=${src.indexOf('app.use("/api"')} postIdx=${src.indexOf('app.post("/api"')}`);

// ── Part 2: integration con la stessa mappatura del dispatcher ────────────────
// Replica della chiamata fatta in index.js (solo campi rotta, niente injection).
function dispatchLike(body) {
  const mg = body || {};
  return previewManualGiroRoute({
    startTime: mg.startTime,
    currentOrderDraft: mg.currentOrderDraft,
    selectedStops: mg.selectedStops,
    selectedZones: mg.selectedZones,
    includeReturn: mg.includeReturn,
    includeCrossZone: mg.includeCrossZone,
    capacity: mg.capacity,
    toleranceMin: mg.toleranceMin,
  });
}
function noPii(obj) {
  return !/Mario PII|\+34000000000|34000000000|telefono|whatsapp|@/i.test(JSON.stringify(obj));
}

console.log("\n── integration: happy path Q2→Q5 ──");
{
  const r = dispatchLike({
    startTime: "20:42",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", hora: "21:00", pizzas: 2, telefono: "+34000000000", nombre: "Mario PII" },
    selectedStops: [
      { type: "current_order", zone: "Q2" },
      { type: "anchor", zone: "Q5", promised: "21:05" },
    ],
    capacity: { limitMin: 38 },
  });
  check("ok true", r.ok === true, JSON.stringify(r).slice(0, 160));
  check("contract premium-planner-manual-giro-route-preview-v1", r.contract === "premium-planner-manual-giro-route-preview-v1");
  check("routeTimeline route-timeline-v2", r.routeTimeline && r.routeTimeline.version === "route-timeline-v2");
  check("input.zones [Q2,Q5]", JSON.stringify(r.input.zones) === JSON.stringify(["Q2", "Q5"]));
  check("safety green", r.safety.readOnly === true && r.safety.writes === false && r.safety.pii === "redacted");
  check("NINGUNA PII (telefono/nombre del draft no salen)", noPii(r), JSON.stringify(r).slice(0, 300));
}

console.log("\n── integration: missing startTime ──");
{
  const r = dispatchLike({
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2" },
    selectedStops: [{ type: "current_order", zone: "Q2" }, { type: "anchor", zone: "Q5" }],
  });
  check("ok false", r.ok === false);
  check("blocker missing_start_time", r.error && r.error.code === "missing_start_time", JSON.stringify(r.error));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
process.exit(fail > 0 ? 1 : 0);
