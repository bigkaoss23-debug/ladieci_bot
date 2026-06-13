// tests/previewOrderPlannerTooEarly.test.js
// ===============================================================
// Guard físico: la hora pedida no puede exigir un forno_out en el pasado.
// Run: node tests/previewOrderPlannerTooEarly.test.js
//
// Reproduce el bug crítico de LIVE_PLANNER_READONLY_BATCH_02 (caso 6):
//   - previewOrderTiming detectaba "Hora pedida muy pronta · mínimo …"
//   - previewOrderPlanner devolvía can_confirm_requested_hora:true / reason:valid
//     con forno_out en el pasado → el operador podía confirmar una entrega
//     físicamente imposible.
//
// Ejercita el MOTOR REAL (evaluateNewOrder) + el adaptador real
// (previewOrderPlanner). Sólo se inyectan now / geo / snapshot loader (sin
// red, sin DB de escritura). READ-ONLY.
// ===============================================================
"use strict";

const { previewOrderPlanner } = require("../src/agents/previewOrderPlanner");

let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? " — " + extra : ""}`); }
}

// Anclas reales típicas de servicio: dos Q1 en cocina.
const ANCHORS = [
  { id: "#003", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "21:30", andata_min: 4, n_pizze: 2, forno_out: "21:24" },
  { id: "#004", tipo_consegna: "DOMICILIO", estado: "EN_COCINA", zona: "Q1", hora: "21:50", andata_min: 4, n_pizze: 2, forno_out: "21:44" },
];

function deps(now, zona, andata) {
  return {
    now: () => now,
    // db sólo lectura: el snapshot real se inyecta vía loadPlannerSnapshot.
    db: { select: async () => [] },
    resolveDeliveryFields: async () => ({
      zona, zona_lat: 36.7, zona_lon: -2.6,
      durata_andata_min: andata, durata_google_min: andata,
      durata_haversine_min: andata + 1, geo_source: "google", warnings: [],
    }),
    // El loader inyectado propaga el `now` real al snapshot (clave para el guard).
    loadPlannerSnapshot: async (a) => ({
      now: a.now, orders: ANCHORS, manual_giros: [],
      driver: null, driver_events: [], driver_status: null,
    }),
  };
}

const toMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + (m || 0); };
const hasCode = (arr, code) => Array.isArray(arr) && arr.some((x) => x && x.code === code);

async function main() {
  // ── Test 1 — CRÍTICO: repro live (DOMICILIO Q1, now 21:11, hora 21:12) ──────
  console.log("\n══ Test 1 — CRÍTICO: hora pedida con forno_out en el pasado ══");
  {
    const r = await previewOrderPlanner(
      { tipo_consegna: "DOMICILIO", direccion: "calle de prueba", hora: "21:12", pizzas_count: 1 },
      deps("21:11", "Q1", 4)
    );
    const rec = r.recommendation || {};
    check("can_confirm_requested_hora === false", rec.can_confirm_requested_hora === false, JSON.stringify(rec));
    check("reason NO es 'valid'", rec.reason !== "valid", String(rec.reason));
    check("forno_out NO está en el pasado (null cuando blocked)", rec.forno_out === null, String(rec.forno_out));
    check("hay blocker/warning de hora demasiado pronta",
      hasCode(r.warnings, "requested_hora_too_soon") || hasCode(r.blockers, "requested_hora_too_soon") || hasCode(r.blockers, "separate"),
      JSON.stringify({ w: r.warnings, b: r.blockers }));
    check("recommended_hora realista (>= now + cocción + andata = 21:20)",
      rec.recommended_hora != null && toMin(rec.recommended_hora) >= toMin("21:20"),
      String(rec.recommended_hora));
    check("read-only safety intacta",
      r.safety && r.safety.readOnly === true && r.safety.writesEnabled === false, JSON.stringify(r.safety));
  }

  // ── Test 2 — caso válido NO roto (DOMICILIO Q1, hora 21:45) ─────────────────
  console.log("\n══ Test 2 — caso válido sigue confirmable + giro compatible ══");
  {
    const r = await previewOrderPlanner(
      { tipo_consegna: "DOMICILIO", direccion: "calle de prueba", hora: "21:45", pizzas_count: 1 },
      deps("21:11", "Q1", 4)
    );
    const rec = r.recommendation || {};
    check("can_confirm_requested_hora === true", rec.can_confirm_requested_hora === true, JSON.stringify(rec));
    check("reason === 'valid'", rec.reason === "valid", String(rec.reason));
    check("forno_out presente (no null)", typeof rec.forno_out === "string", String(rec.forno_out));
    check("giro compatible 21:50 sigue ofreciéndose", (r.giro || {}).slot_hora === "21:50", JSON.stringify(r.giro));
    check("sin warning de hora demasiado pronta", !hasCode(r.warnings, "requested_hora_too_soon"), JSON.stringify(r.warnings));
  }

  // ── Test 3 — bloqueado por reparto tardío SIGUE bloqueado (no mislabel) ─────
  console.log("\n══ Test 3 — Q5 que no llega: blocked, NO 'too_early', fallback realista ══");
  {
    const r = await previewOrderPlanner(
      { tipo_consegna: "DOMICILIO", direccion: "calle lejana", hora: "21:35", pizzas_count: 1 },
      deps("21:10", "Q5", 12)
    );
    const rec = r.recommendation || {};
    check("can_confirm_requested_hora === false", rec.can_confirm_requested_hora === false, JSON.stringify(rec));
    check("reason NO es 'valid'", rec.reason !== "valid", String(rec.reason));
    check("NO se etiqueta como requested_hora_too_soon (forno futuro, no pasado)",
      rec.reason !== "requested_hora_too_soon" && !hasCode(r.warnings, "requested_hora_too_soon"),
      JSON.stringify({ reason: rec.reason, w: r.warnings }));
    check("fallback recommended_hora realista (>= 21:15)",
      rec.recommended_hora != null && toMin(rec.recommended_hora) >= toMin("21:15"), String(rec.recommended_hora));
  }

  // ── Test 4 — RITIRO válido NO contaminado ───────────────────────────────────
  console.log("\n══ Test 4 — RITIRO válido: forno-only, sin driver/giro ══");
  {
    const r = await previewOrderPlanner(
      { tipo_consegna: "RITIRO", hora: "21:45", pizzas_count: 1 },
      deps("21:10", null, null)
    );
    const rec = r.recommendation || {};
    check("can_confirm_requested_hora === true", rec.can_confirm_requested_hora === true, JSON.stringify(rec));
    check("driver.required === false", r.driver && r.driver.required === false, JSON.stringify(r.driver));
    check("forno_out === hora pedida (sin andata)", rec.forno_out === "21:45", String(rec.forno_out));
    check("giro pickup_no_giro_required", (r.giro || {}).reason === "pickup_no_giro_required", JSON.stringify(r.giro));
    check("driver sin conflicto", r.driver && r.driver.has_conflict === false, JSON.stringify(r.driver));
  }

  // ── Test 5 — RITIRO demasiado pronto / en el pasado ─────────────────────────
  console.log("\n══ Test 5 — RITIRO demasiado pronto: no confirmable, sin forno pasado ══");
  {
    const r = await previewOrderPlanner(
      { tipo_consegna: "RITIRO", hora: "21:12", pizzas_count: 1 },
      deps("21:10", null, null)
    );
    const rec = r.recommendation || {};
    check("can_confirm_requested_hora === false", rec.can_confirm_requested_hora === false, JSON.stringify(rec));
    check("forno_out NO en el pasado (null)", rec.forno_out === null, String(rec.forno_out));
    check("reason requested_hora_too_soon", rec.reason === "requested_hora_too_soon", String(rec.reason));
    check("recommended_hora >= now + cocción (21:15)",
      rec.recommended_hora != null && toMin(rec.recommended_hora) >= toMin("21:15"), String(rec.recommended_hora));
    check("driver sigue no requerido (pickup)", r.driver && r.driver.required === false, JSON.stringify(r.driver));
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
