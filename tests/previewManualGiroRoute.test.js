// tests/previewManualGiroRoute.test.js
// ===============================================================
// Premium Planner — `previewManualGiroRoute` action: pure offline test.
// Run: node tests/previewManualGiroRoute.test.js
//
// Copre i fixture canonici del design (PREMIUM_PLANNER_PREVIEW_MANUAL_GIRO_ROUTE_DESIGN.md §10):
//   A. Q2→Q5 tight (sur)            E. missing startTime (blocker safe)
//   B. Q1→Q2→Q5 tre tappe (sur)     F. missing travel times (blocked, no eta)
//   C. Q3→Q4 oeste (ok)             G. capacity full (no falso full da null)
//   D. Q5→Q3 cross (no_recomendado)
// Più validazioni obbligatorie (invalid startTime/zone, duplicate current_order,
// too_many_stops, capacity_invalid), no-PII, safety, determinismo, no-mutazione,
// e source-grep di purezza (no Date.now/fetch/db/env/manual_giros/WhatsApp).
//
// Boundary: action PURA/offline. Usa buildRouteImpact reale (catena vera
// engine→mapper) per A/B/C/G; deps iniettata per F (missing travel non-cross).
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
function nodeByType(tl, type) { return tl.timeline.find((n) => n.type === type); }
function deliveries(tl) { return tl.timeline.filter((n) => n.type === "delivery"); }

function noPii(obj) {
  return !/Mario PII|\+34000000000|34000000000|Calle PII|telefono|whatsapp|@/i.test(JSON.stringify(obj));
}
function noStacktrace(obj) {
  return !/\bat\s+\w+\s*\(|Error:|\.js:\d+/.test(JSON.stringify(obj));
}
function safetyGreen(r) {
  return r.safety && r.safety.readOnly === true && r.safety.writes === false && r.safety.pii === "redacted";
}

// ── A. Q2 → Q5 — tight (canale sur) ──────────────────────────────────────────
console.log("══ A. Q2→Q5 tight (sur) ══");
{
  const r = previewManualGiroRoute({
    startTime: "20:42",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", hora: "21:00", pizzas: 2 },
    selectedStops: [
      { type: "current_order", zone: "Q2", label: "Pedido actual" },
      { type: "anchor", zone: "Q5", promised: "21:05", label: "Las Marinas" },
    ],
    includeReturn: true,
    capacity: { limitMin: 38 }, // routeMin 36 → slack 2 ≤ 3 → tight
  });
  check("ok true", r.ok === true, JSON.stringify(r).slice(0, 160));
  check("contract premium-planner-manual-giro-route-preview-v1", r.contract === "premium-planner-manual-giro-route-preview-v1");
  check("source offline-readonly", r.source === "offline-readonly");
  check("mode read_only", r.mode === "read_only");
  check("input.zones = [Q2,Q5]", JSON.stringify(r.input.zones) === JSON.stringify(["Q2", "Q5"]));
  check("input.startTime 20:42", r.input.startTime === "20:42");
  check("proposalId manual-q2-q5-2042", r.routeTimeline.proposalId === "manual-q2-q5-2042", r.routeTimeline.proposalId);
  check("risk tight", r.routeTimeline.risk === "tight", r.routeTimeline.risk);
  check("4 nodi (dep+2+ret)", r.routeTimeline.timeline.length === 4, String(r.routeTimeline.timeline.length));
  check("departure eta 20:42", nodeByType(r.routeTimeline, "departure").eta === "20:42");
  check("Q2 delivery eta 20:49 isNewOrder", deliveries(r.routeTimeline)[0].eta === "20:49" && deliveries(r.routeTimeline)[0].isNewOrder === true && deliveries(r.routeTimeline)[0].isAnchor === false);
  check("Q5 delivery eta 21:01 isAnchor sin slip", deliveries(r.routeTimeline)[1].eta === "21:01" && deliveries(r.routeTimeline)[1].isAnchor === true && deliveries(r.routeTimeline)[1].slipLabel === null, JSON.stringify(deliveries(r.routeTimeline)[1]));
  check("return eta 21:18", nodeByType(r.routeTimeline, "return").eta === "21:18", nodeByType(r.routeTimeline, "return").eta);
  check("summary directEta 20:49 (leg directo HUB→Q2)", r.routeTimeline.summary.directEta === "20:49", r.routeTimeline.summary.directEta);
  check("safety green", safetyGreen(r));
  check("sin PII", noPii(r));
}

// ── B. Q1 → Q2 → Q5 — tre tappe sur, seq stabile ─────────────────────────────
console.log("══ B. Q1→Q2→Q5 tre tappe ══");
{
  const r = previewManualGiroRoute({
    startTime: "20:30",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q1", pizzas: 1 },
    selectedStops: [
      { type: "current_order", zone: "Q1" },
      { type: "anchor", zone: "Q2", promised: "20:55" },
      { type: "anchor", zone: "Q5", promised: "21:15" },
    ],
    capacity: { limitMin: 60 },
  });
  const d = deliveries(r.routeTimeline);
  check("ok true", r.ok === true);
  check("3 delivery nodes", d.length === 3, String(d.length));
  check("seq 1/2/3", d[0].seq === 1 && d[1].seq === 2 && d[2].seq === 3);
  check("orden estable Q1→Q2→Q5 (sin reordenar)", d[0].zone === "Q1" && d[1].zone === "Q2" && d[2].zone === "Q5", JSON.stringify(d.map((x) => x.zone)));
  check("Q1 isNewOrder, Q2/Q5 anchor", d[0].isNewOrder === true && d[1].isAnchor === true && d[2].isAnchor === true);
  check("etas Q1 20:35 / Q2 20:42 / Q5 20:54", d[0].eta === "20:35" && d[1].eta === "20:42" && d[2].eta === "20:54", JSON.stringify(d.map((x) => x.eta)));
  check("return eta 21:11", nodeByType(r.routeTimeline, "return").eta === "21:11", nodeByType(r.routeTimeline, "return").eta);
  check("risk ok", r.routeTimeline.risk === "ok", r.routeTimeline.risk);
}

// ── C. Q3 → Q4 — canale oeste, ok ────────────────────────────────────────────
console.log("══ C. Q3→Q4 oeste ══");
{
  const r = previewManualGiroRoute({
    startTime: "20:40",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q3", pizzas: 2 },
    selectedStops: [
      { type: "current_order", zone: "Q3" },
      { type: "anchor", zone: "Q4", promised: "21:00" },
    ],
    capacity: { limitMin: 40 },
  });
  const d = deliveries(r.routeTimeline);
  check("ok true", r.ok === true);
  check("risk ok (oeste compatible)", r.routeTimeline.risk === "ok", r.routeTimeline.risk);
  check("Q3 eta 20:48 isNew / Q4 eta 20:58 anchor", d[0].eta === "20:48" && d[0].isNewOrder === true && d[1].eta === "20:58" && d[1].isAnchor === true, JSON.stringify(d.map((x) => x.eta)));
  check("return eta 21:12", nodeByType(r.routeTimeline, "return").eta === "21:12", nodeByType(r.routeTimeline, "return").eta);
  check("NO cross warning", !r.warnings.some((w) => w.code === "cross_channel"), JSON.stringify(r.warnings));
  check("NO blockers", r.blockers.length === 0, JSON.stringify(r.blockers));
}

// ── D. Q5 → Q3 — cross-channel (no_recomendado, no verde inventato) ──────────
console.log("══ D. Q5→Q3 cross ══");
{
  const r = previewManualGiroRoute({
    startTime: "20:40",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q5", pizzas: 2 },
    selectedStops: [
      { type: "current_order", zone: "Q5" },
      { type: "anchor", zone: "Q3", promised: "21:00" },
    ],
    includeCrossZone: true,
  });
  const d = deliveries(r.routeTimeline);
  check("ok true (timeline producida, bloqueada)", r.ok === true);
  check("risk no_recomendado", r.routeTimeline.risk === "no_recomendado", r.routeTimeline.risk);
  check("blocker missing_travel_times", r.blockers.some((b) => b.code === "missing_travel_times"), JSON.stringify(r.blockers));
  check("warning cross_channel", r.warnings.some((w) => w.code === "cross_channel"), JSON.stringify(r.warnings));
  check("deliveries eta NULL (no verde inventado)", d.every((x) => x.eta === null), JSON.stringify(d.map((x) => x.eta)));
  check("departure eta NULL (sin impact)", nodeByType(r.routeTimeline, "departure").eta === null);

  // Variante includeCrossZone:false → scartata a monte (ok:false).
  const r2 = previewManualGiroRoute({
    startTime: "20:40",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q5" },
    selectedStops: [
      { type: "current_order", zone: "Q5" },
      { type: "anchor", zone: "Q3" },
    ],
    includeCrossZone: false,
  });
  check("includeCrossZone:false → ok false", r2.ok === false);
  check("blocker cross_channel_not_recommended", r2.error.code === "cross_channel_not_recommended", JSON.stringify(r2.error));
  check("routeTimeline null", r2.routeTimeline === null);
}

// ── E. missing startTime — blocker safe ──────────────────────────────────────
console.log("══ E. missing startTime ══");
{
  const r = previewManualGiroRoute({
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2" },
    selectedStops: [
      { type: "current_order", zone: "Q2" },
      { type: "anchor", zone: "Q5", promised: "21:00" },
    ],
  });
  check("ok false", r.ok === false, JSON.stringify(r));
  check("blocker missing_start_time", r.error.code === "missing_start_time" && r.blockers.some((b) => b.code === "missing_start_time"), JSON.stringify(r));
  check("error.safe true", r.error.safe === true);
  check("routeTimeline null", r.routeTimeline === null);
  check("safety green", safetyGreen(r));
}

// ── F. missing travel times (non-cross, deps iniettata) — blocked safe ───────
console.log("══ F. missing travel times ══");
{
  // Stub: forza un leg mancante anche su una rotta sur normalmente valida.
  const stubTravel = () => ({ ok: false, travelTimes: {}, missing: ["Q2->Q5"] });
  const r = previewManualGiroRoute({
    startTime: "20:42",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", pizzas: 2 },
    selectedStops: [
      { type: "current_order", zone: "Q2" },
      { type: "anchor", zone: "Q5", promised: "21:00" },
    ],
  }, { buildTravelTimesForPath: stubTravel });
  const d = deliveries(r.routeTimeline);
  check("ok true (timeline bloqueada honesta)", r.ok === true);
  check("risk blocked", r.routeTimeline.risk === "blocked", r.routeTimeline.risk);
  check("blocker missing_travel_times", r.blockers.some((b) => b.code === "missing_travel_times"));
  check("NO cross warning (ruta sur)", !r.warnings.some((w) => w.code === "cross_channel"), JSON.stringify(r.warnings));
  check("deliveries eta NULL (no ETA inventado)", d.every((x) => x.eta === null), JSON.stringify(d.map((x) => x.eta)));
}

// ── G. capacity full — full/lleno (no falso full da null) ────────────────────
console.log("══ G. capacity full ══");
{
  const base = {
    startTime: "20:30",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", pizzas: 4 },
    selectedStops: [
      { type: "current_order", zone: "Q2" },
      { type: "anchor", zone: "Q5", promised: "21:30", pizzas: 2 }, // 4+2=6 > max 5
    ],
  };
  const full = previewManualGiroRoute({ ...base, capacity: { maxPizzas: 5, limitMin: 60 } });
  check("ok true", full.ok === true);
  check("risk full", full.routeTimeline.risk === "full", full.routeTimeline.risk);
  check("blocker capacity_full", full.blockers.some((b) => b.code === "capacity_full"), JSON.stringify(full.blockers));
  check("operatorMessage menciona lleno", /lleno/i.test(full.routeTimeline.operatorMessage), full.routeTimeline.operatorMessage);

  // Contrapposto: capacity assente → maxPizzas null → desconocida, NON full.
  const unknown = previewManualGiroRoute({ ...base });
  check("capacity null ⇒ NON full", unknown.routeTimeline.risk !== "full", unknown.routeTimeline.risk);
}

// ── Validazioni obbligatorie ─────────────────────────────────────────────────
console.log("══ Validaciones ══");
{
  const draft = { tipoConsegna: "DOMICILIO", zone: "Q2" };
  const stops = [{ type: "current_order", zone: "Q2" }, { type: "anchor", zone: "Q5" }];

  const invStart = previewManualGiroRoute({ startTime: "99:99", currentOrderDraft: draft, selectedStops: stops });
  check("invalid startTime 99:99 → invalid_start_time", invStart.ok === false && invStart.error.code === "invalid_start_time", JSON.stringify(invStart.error));

  const invZone = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: draft, selectedStops: [{ type: "current_order", zone: "Q2" }, { type: "anchor", zone: "QX" }] });
  check("invalid zone QX → invalid_zone", invZone.ok === false && invZone.error.code === "invalid_zone", JSON.stringify(invZone.error));

  const dup = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: draft, selectedStops: [{ type: "current_order", zone: "Q2" }, { type: "current_order", zone: "Q5" }] });
  check("duplicate current_order → duplicate_current_order", dup.ok === false && dup.error.code === "duplicate_current_order", JSON.stringify(dup.error));

  const many = previewManualGiroRoute({
    startTime: "20:30", currentOrderDraft: draft,
    selectedStops: [
      { type: "current_order", zone: "Q2" },
      { type: "anchor", zone: "Q5" }, { type: "anchor", zone: "Q1" },
      { type: "anchor", zone: "Q2" }, { type: "anchor", zone: "Q5" },
      { type: "anchor", zone: "Q1" }, // 6 > MAX_STOPS(5)
    ],
  });
  check("too many stops > 5 → too_many_stops", many.ok === false && many.error.code === "too_many_stops", JSON.stringify(many.error));

  const capBad = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: draft, selectedStops: stops, capacity: { maxPizzas: "muchas" } });
  check("capacity non numérica → capacity_invalid", capBad.ok === false && capBad.error.code === "capacity_invalid", JSON.stringify(capBad.error));

  const noCurrent = previewManualGiroRoute({ startTime: "20:30", selectedStops: stops });
  check("sin currentOrderDraft → missing_current_order", noCurrent.ok === false && noCurrent.error.code === "missing_current_order");

  const noZone = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: { tipoConsegna: "DOMICILIO" }, selectedStops: stops });
  check("currentOrderDraft sin zona → missing_zone", noZone.ok === false && noZone.error.code === "missing_zone");

  const empty = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: draft, selectedStops: [] });
  check("selectedStops vacío → empty_selected_stops", empty.ok === false && empty.error.code === "empty_selected_stops");

  const badType = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: draft, selectedStops: [{ type: "weird", zone: "Q2" }] });
  check("stop type inválido → invalid_stop_type", badType.ok === false && badType.error.code === "invalid_stop_type");

  const pickup = previewManualGiroRoute({ startTime: "20:30", currentOrderDraft: { tipoConsegna: "RITIRO", zone: "Q2" }, selectedStops: stops });
  check("RITIRO → pickup_not_route", pickup.ok === false && pickup.error.code === "pickup_not_route");
}

// ── selectedZones shorthand ──────────────────────────────────────────────────
console.log("══ selectedZones shorthand ══");
{
  const r = previewManualGiroRoute({
    startTime: "20:42",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", pizzas: 2 },
    selectedZones: ["Q2", "Q5"],
  });
  const d = deliveries(r.routeTimeline);
  check("ok true via selectedZones", r.ok === true);
  check("Q2 expandido a current_order (isNew)", d[0].zone === "Q2" && d[0].isNewOrder === true);
  check("Q5 expandido a anchor", d[1].zone === "Q5" && d[1].isAnchor === true);
}

// ── no-PII: una label con teléfono NON deve uscire ───────────────────────────
console.log("══ no-PII leak ══");
{
  const r = previewManualGiroRoute({
    startTime: "20:42",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", pizzas: 1 },
    selectedStops: [
      { type: "current_order", zone: "Q2", label: "Mario PII +34000000000" },
      { type: "anchor", zone: "Q5", label: "cliente whatsapp 34000000000", promised: "21:10" },
    ],
  });
  check("ok true", r.ok === true);
  check("NINGUNA PII en el contract (label saneada a 'Pedido <zone>')", noPii(r), JSON.stringify(r).slice(0, 300));
  check("Q2 label saneada", deliveries(r.routeTimeline)[0].label === "Pedido actual", deliveries(r.routeTimeline)[0].label);
  check("Q5 label saneada", deliveries(r.routeTimeline)[1].label === "Pedido Q5", deliveries(r.routeTimeline)[1].label);
  check("sin stacktrace", noStacktrace(r));
}

// ── determinismo + no-mutazione input ────────────────────────────────────────
console.log("══ determinismo + no-mutación ══");
{
  const input = {
    startTime: "20:42",
    currentOrderDraft: { tipoConsegna: "DOMICILIO", zone: "Q2", hora: "21:00", pizzas: 2 },
    selectedStops: [
      { type: "current_order", zone: "Q2" },
      { type: "anchor", zone: "Q5", promised: "21:05" },
    ],
    capacity: { limitMin: 38 },
  };
  const snapshot = JSON.stringify(input);
  const r1 = previewManualGiroRoute(input);
  const r2 = previewManualGiroRoute(input);
  check("output determinista (igual en 2 llamadas)", JSON.stringify(r1) === JSON.stringify(r2));
  check("input NO mutado", JSON.stringify(input) === snapshot, JSON.stringify(input));
}

// ── source-grep: purezza del modulo ──────────────────────────────────────────
console.log("══ source-grep purezza ══");
{
  const raw = fs.readFileSync(path.join(__dirname, "../src/agents/previewManualGiroRoute.js"), "utf8");
  // Strip commenti: i check negativi devono guardare il CODICE, non i commenti
  // (che legittimamente menzionano Date.now/fetch/DB/manual_giros per dire cosa NON si fa).
  const code = raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  check("NO Date.now", !/Date\.now/.test(code));
  check("NO fetch(", !/\bfetch\s*\(/.test(code));
  check("NO axios", !/axios/.test(code));
  check("NO process.env", !/process\.env/.test(code));
  check("NO sbInsert/Update/Upsert/Delete/Select", !/sb(Insert|Update|Upsert|Delete|Select)/.test(code));
  check("NO insert/update/delete/upsert/rpc SQL", !/\b(insert|update|delete|upsert|rpc)\s*\(/i.test(code));
  check("NO manual_giros / applyManualGiro", !/manual_giros|applyManualGiro/.test(code));
  check("NO WhatsApp invia(", !/\binvia\s*\(/.test(code));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
process.exit(fail > 0 ? 1 : 0);
