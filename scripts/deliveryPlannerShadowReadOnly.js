// ===============================================================
// scripts/deliveryPlannerShadowReadOnly.js
// SHADOW MODE READ-ONLY · task SHADOW-MODE-READONLY-01
// ===============================================================
// PRIMO shadow mode del Delivery Planning Orchestrator.
//
// COSA FA:
//   • prende uno snapshot GREZZO (fixture statica o, in futuro, una foto read-only);
//   • normalizza i FATTI GREZZI (hora, zona, andata_min, n_pizze, estado, manual_giro_id…)
//     SCARTANDO ogni campo DERIVATO (forno_out_db, estado_db, salida/entrega stimate…);
//   • esegue il planner rev.5 (buildPlan) — funzione PURA;
//   • confronta l'output con il baseline DB SOLO per spiegare le differenze
//     (il baseline NON entra mai come input → "il derivato non alimenta il derivato");
//   • produce un shadowVerdict + invarianti + differenze.
//
// COSA NON FA (per contratto del task):
//   • NON scrive su DB / Supabase;
//   • NON tocca endpoint live / index.js / agenti live / frontend;
//   • NON deploya;
//   • NON importa supabase/fetch/axios/process.env;
//   • NON è importato da runtime live: solo da test/CLI.
//
// SAFETY: nessun side-effect a import-time. Le fixture sono caricate SOLO nel
// blocco CLI (require.main === module). Il modulo è puro e offline-safe.
// ===============================================================

"use strict";

const { buildPlan } = require("../src/core/delivery/planner");
const { explainRiderDelayChain } = require("../src/core/delivery/riderChainExplanation");

const FROZEN_OR_TERMINAL_STATES = new Set(["EN_ENTREGA", "RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO"]);

// Campi GREZZI ammessi come input del planner (spec §4 "il derivato non alimenta
// mai il derivato"). Tutto il resto della fixture è display/baseline e va scartato.
const RAW_FIELDS = [
  "id",
  "tipo_consegna",
  "estado",        // se assente → NUEVO (replay archiviati come MOVIBILE)
  "zona",
  "hora",
  "andata_min",
  "n_pizze",
  "manual_giro_id",
  "forzado",
  "forzado_hora",
  "promesa_precisa",
  "created_at",
];

// Campi DERIVATI che NON devono MAI entrare come input (solo cache/display/baseline).
const DERIVED_FIELDS = [
  "forno_out",
  "forno_out_db",
  "salida_driver_estimada",
  "entrega_estimada",
  "retraso_driver_min",
  "conflicto_driver",
  "estado_db",
];

const RIDER_CHAIN_BASELINE_FIELDS = [
  "salida_driver_estimada",
  "entrega_estimada",
  "retraso_estimado_min",
  "conflicto_driver",
  "forno_out",
];

// ── Normalizza i FATTI GREZZI di uno snapshot ─────────────────────────────────
// Replay degli archiviati: estado_db RETIRADO → estado NUEVO (MOVIBILE), come fa
// la suite multi-snapshot AB. Niente campi derivati.
function normalizeRawOrders(rawOrders) {
  return (rawOrders || []).map((o) => {
    const out = {};
    for (const k of RAW_FIELDS) if (o[k] !== undefined) out[k] = o[k];
    if (!out.estado) out.estado = "NUEVO";
    // parità con la suite: il planner usa anche durata_andata_min in alcuni rami.
    if (o.andata_min !== undefined) out.durata_andata_min = o.andata_min;
    return out;
  });
}

// Guard difensivo: nessun campo derivato deve essere finito nell'input normalizzato.
function assertNoDerivedInput(normalizedOrders) {
  const leaked = [];
  for (const o of normalizedOrders) {
    for (const d of DERIVED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(o, d)) leaked.push({ id: o.id, field: d });
    }
  }
  return leaked; // [] = pulito
}

const isValidHHMM = (s) => typeof s === "string" && /^\d\d:\d\d$/.test(s) && !/^(24|25):/.test(s);
const toMin = (hhmm) => {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!m) return null;
  let h = Number(m[1]);
  if (h < 6) h += 24; // night-service, allineato al planner
  return h * 60 + Number(m[2]);
};
const fromMin = (svc) => {
  if (svc == null || !Number.isFinite(Number(svc))) return null;
  let h = Math.floor(Number(svc) / 60);
  const m = Number(svc) % 60;
  if (h >= 24) h -= 24;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

function isGoogleSource(src) {
  return /^google(?:$|-)/i.test(String(src || ""));
}

// Zone "lontane" del cluster Q5 (Q5 / Marina / Evershine) dove la stima geo va
// trattata con prudenza extra. Fuori da queste zone (Q1/Q2/Q3…) una cache-street
// con durata realistica è considerata affidabile.
function isFarDeliveryZone(zona) {
  const z = String(zona || "");
  return z === "Q5" || /marina|evershine/i.test(z);
}

function isFrozenOrTerminalOrder(order) {
  const estado = String(order && order.estado || "").toUpperCase();
  return FROZEN_OR_TERMINAL_STATES.has(estado);
}

function isRecomputableDelivery(order) {
  return order && order.tipo_consegna === "DOMICILIO" && !isFrozenOrTerminalOrder(order);
}

function collectDirtyGeoDiagnostics(rawOrders, plan) {
  const diagnostics = [];
  const buffer = Number(plan && plan.config && plan.config.bufferOpsDriverMin) || 3;
  for (const o of rawOrders || []) {
    if (!o || o.tipo_consegna !== "DOMICILIO") continue;
    const zona = String(o.zona || "");
    const andata = Number(o.andata_min ?? o.durata_andata_min);
    const geoSource = o.geo_source || null;
    const googleMin = o.durata_google_min;
    const haversineMin = Number(o.durata_haversine_min);
    const nonGoogle = !isGoogleSource(geoSource);
    const farZone = isFarDeliveryZone(zona);
    const cacheStreet = geoSource === "cache-street";
    // cache-street è una cache a livello strada derivata da una geocodifica Google
    // della stessa via (spesso "blindata" da consegne reali): NON è automaticamente
    // sporca. È sospetta SOLO in zona lontana (Q5/Marina/Evershine) o quando la durata
    // stessa è alta (andata >= 20). Per Q1/Q2/Q3 con durata realistica (andata < 20)
    // non genera warning. Vedi audit SHADOW-PREVIEW-DIRTY-GEO-SOURCE-AUDIT-33.
    const cacheStreetSuspect = cacheStreet && (farZone || (Number.isFinite(andata) && andata >= 20));
    const fallbackHigh = !geoSource && googleMin == null && Number.isFinite(haversineMin) && haversineMin >= 20;
    const farZoneFallbackHigh = farZone && Number.isFinite(andata) && andata >= 20 && nonGoogle;
    if (!cacheStreetSuspect && !fallbackHigh && !farZoneFallbackHigh) continue;

    const n = plan && plan.orders ? plan.orders[o.id] : null;
    const estimatedRoundTrip = Number.isFinite(andata) ? (andata * 2) + buffer : null;
    diagnostics.push({
      type: "dirty_geo_timing",
      severity: "diagnostic",
      orderId: o.id,
      zona: o.zona || null,
      andata_min: Number.isFinite(andata) ? andata : null,
      geo_source: geoSource,
      geo_confidence: "low",
      estimate_suspect: true,
      estimated_round_trip_min: estimatedRoundTrip,
      realistic_round_trip_hint_min: farZone ? 30 : null,
      planner_forno_out: n ? n.forno_out : null,
      planner_salida: n ? n.salida : null,
      planner_retraso: n ? n.retraso : null,
      input_dirty: true,
      reason: farZone
        ? "Q5/Marina usa durata fallback non-Google: possibile dato storico sporco"
        : "durata fallback non-Google alta: possibile dato storico sporco",
    });
  }
  return diagnostics;
}

function collectDirtyGeoRecoveryDiagnostics(dirtyDiagnostics, plan) {
  if (!plan || !plan.driver || plan.driver.real_event !== true) return [];
  return (dirtyDiagnostics || []).map((d) => ({
    type: "dirty_geo_recovery",
    severity: "diagnostic",
    zona: d.zona,
    geo_confidence: d.geo_confidence || "low",
    estimate_suspect: d.estimate_suspect === true,
    estimated_round_trip_min: d.estimated_round_trip_min,
    realistic_round_trip_hint_min: d.realistic_round_trip_hint_min,
    rider_available_from: plan.driver.available_from || null,
    rider_event_source: plan.driver.source || null,
    reason: "Timing Q5/Evershine non-Google sospetto; usa evento rider_returned per riallineare il futuro",
  }));
}

function ovenDiagnosticSeverity(pizzas, capacity) {
  if (pizzas >= capacity + 4) return "red";
  if (pizzas >= capacity + 2) return "orange";
  if (pizzas >= capacity + 1) return "yellow";
  return null;
}

function ovenDiagnosticCode(pizzas, capacity) {
  if (pizzas >= capacity + 4) return "forno_pieno";
  if (pizzas >= capacity + 2) return "forno_overload_serio";
  if (pizzas >= capacity + 1) return "forno_soft_overload";
  return null;
}

function collectOvenSlotDiagnostics(plan) {
  const diagnostics = [];
  const capacity = Number(plan && plan.config && plan.config.forno && plan.config.forno.maxPerSlot) || 4;
  const loads = plan && plan.ovenLoad ? plan.ovenLoad : {};
  for (const [slotSvc, pizzasRaw] of Object.entries(loads)) {
    const pizzas = Number(pizzasRaw) || 0;
    const code = ovenDiagnosticCode(pizzas, capacity);
    if (!code) continue;
    diagnostics.push({
      type: "global_oven_slot_warning",
      code,
      severity: ovenDiagnosticSeverity(pizzas, capacity),
      slot: fromMin(Number(slotSvc)),
      pizzas,
      capacity,
      reason: "Slot forno saturo anche considerando ritiri",
    });
  }
  return diagnostics.sort((a, b) => toMin(a.slot) - toMin(b.slot));
}

function collectFrozenCommittedDiagnostics(rawOrders, plan) {
  const diagnostics = [];
  for (const o of rawOrders || []) {
    if (!o || o.tipo_consegna !== "DOMICILIO" || !isFrozenOrTerminalOrder(o)) continue;
    const n = plan && plan.orders ? plan.orders[o.id] : null;
    const reasons = n && Array.isArray(n.reasons) ? n.reasons.join("; ") : "";
    const hasFrozenArtifact = !n || !n.forno_out || /congelato duro|committ/i.test(reasons);
    if (!hasFrozenArtifact) continue;
    diagnostics.push({
      type: "frozen_committed_order",
      severity: "info",
      orderId: o.id,
      estado: o.estado || null,
      zona: o.zona || null,
      reason: "Pedido ya comprometido o terminal: excluido de invariantes que requieren recálculo",
    });
  }
  return diagnostics;
}

function collectDiagnostics(rawOrders, plan) {
  const dirty = collectDirtyGeoDiagnostics(rawOrders, plan);
  return [
    ...dirty,
    ...collectDirtyGeoRecoveryDiagnostics(dirty, plan),
    ...collectOvenSlotDiagnostics(plan),
    ...collectFrozenCommittedDiagnostics(rawOrders, plan),
  ];
}

// ── Esegue lo shadow su UNA fixture grezza ────────────────────────────────────
// fixture: { fecha, orders:[...raw...], manual_giros?, driver?, driver_events?, driver_status?, now? }
function runShadow(fixture, opts = {}) {
  const now = opts.now || fixture.now || "19:00";
  const rawOrders = fixture.orders || [];
  const orders = normalizeRawOrders(rawOrders);
  const derivedLeak = assertNoDerivedInput(orders);

  const snapshot = {
    now,
    orders,
    manual_giros: fixture.manual_giros || [],
    driver: fixture.driver || null,
    driver_events: fixture.driver_events || [],
    driver_status: fixture.driver_status || null,
  };
  const plan = buildPlan(snapshot);

  const delivery = rawOrders.filter((o) => o.tipo_consegna === "DOMICILIO");
  const recomputableDelivery = delivery.filter(isRecomputableDelivery);
  const pickup = rawOrders.filter((o) => o.tipo_consegna === "RITIRO");
  const zones = [...new Set(delivery.map((o) => o.zona).filter(Boolean))].sort();

  // ── INVARIANTI ROSSE (devono valere su OGNI snapshot reale) ──────────────────
  const projections = Object.values(plan.orders);
  const noInvalidTimeFormat = projections.every(
    (n) => !n.forno_out || isValidHHMM(n.forno_out),
  );
  const noImpossibleFornoOut = recomputableDelivery.every((o) => {
    const n = plan.orders[o.id];
    return n && isValidHHMM(n.forno_out) && (toMin(n.entrega) - toMin(n.forno_out)) === (Number(o.andata_min) || 0);
  });
  const noDriverBeforePizza = recomputableDelivery.every((o) => {
    const n = plan.orders[o.id];
    return n && toMin(n.salida) >= toMin(n.forno_out);
  });
  const noRiderOverlap = plan.rider_overlaps.length === 0;

  const invariants = {
    noImpossibleFornoOut,
    noDriverBeforePizza,
    noRiderOverlap,
    noInvalidTimeFormat,
    noDerivedInputLeak: derivedLeak.length === 0,
  };
  const redOk = Object.values(invariants).every(Boolean);

  // ── DIFFERENZE vs baseline DB (SOLO confronto, mai input) ─────────────────────
  const differences = [];
  for (const o of delivery) {
    const n = plan.orders[o.id];
    if (isFrozenOrTerminalOrder(o)) continue;
    if (!n) continue;
    if (o.forno_out_db != null && n.forno_out !== o.forno_out_db) {
      const reasons = (n.reasons || []).join("; ");
      // severità "yellow": differenza ATTESA da una nuova regola spiegabile.
      const ruleDriven = /forno|overload|buffer|semi-congelato|forzato|tempo recuperato/i.test(reasons);
      differences.push({
        orderId: o.id,
        zona: o.zona,
        type: /overload|forno/i.test(reasons) ? "oven_capacity" : "timing_rule",
        old: o.forno_out_db,
        planner: n.forno_out,
        retraso: n.retraso,
        severity: ruleDriven ? "yellow" : "info",
        reason: reasons || "differenza di scheduling (single-rider / buffer 3 / slot)",
      });
    }
  }

  // Warnings di serata: globali + per-trip, deduplicati e spiegabili.
  const tripWarnings = [];
  for (const t of plan.trips) for (const w of (t.warnings || [])) tripWarnings.push(`${t.id || t.zona}: ${w}`);
  const warnings = [...plan.warnings, ...tripWarnings];
  const diagnostics = collectDiagnostics(rawOrders, plan);
  const riderChain = explainRiderDelayChain(rawOrders, {
    bufferMin: Number(plan && plan.config && plan.config.bufferOpsDriverMin) || 3,
  });

  return {
    snapshotDate: fixture.fecha || null,
    now,
    totalOrders: rawOrders.length,
    deliveryOrders: delivery.length,
    pickupOrders: pickup.length,
    zones,
    trips: plan.trips.length,
    riderOverlaps: plan.rider_overlaps.length,
    invariants,
    derivedLeak,
    differences,
    warnings,
    diagnostics,
    riderChain,
    verdict: redOk ? "shadow_ok" : "shadow_red",
  };
}

// ── Esegue lo shadow su PIÙ fixture e aggrega ────────────────────────────────
function runShadowAll(fixtures, opts = {}) {
  const reports = fixtures.map((fx) => runShadow(fx, opts));
  const summary = {
    snapshots: reports.length,
    totalOrders: reports.reduce((s, r) => s + r.totalOrders, 0),
    deliveryOrders: reports.reduce((s, r) => s + r.deliveryOrders, 0),
    pickupOrders: reports.reduce((s, r) => s + r.pickupOrders, 0),
    totalDifferences: reports.reduce((s, r) => s + r.differences.length, 0),
    allInvariantsGreen: reports.every((r) => r.verdict === "shadow_ok"),
    verdict: reports.every((r) => r.verdict === "shadow_ok") ? "shadow_ok" : "shadow_red",
  };
  return { summary, reports };
}

module.exports = {
  normalizeRawOrders,
  assertNoDerivedInput,
  collectDiagnostics,
  collectDirtyGeoDiagnostics,
  collectDirtyGeoRecoveryDiagnostics,
  collectOvenSlotDiagnostics,
  explainRiderDelayChain,
  runShadow,
  runShadowAll,
  RAW_FIELDS,
  DERIVED_FIELDS,
  RIDER_CHAIN_BASELINE_FIELDS,
};

// ── CLI READ-ONLY (le fixture sono caricate SOLO qui, mai a import-time) ───────
if (require.main === module) {
  const FIXTURE_DATES = ["20260528", "20260529", "20260530", "20260531"];
  const fixtures = FIXTURE_DATES.map((d) => require("../tests/fixtures/deliveryPlannerRealSnapshot" + d));
  const result = runShadowAll(fixtures);
  // stdout puro: NESSUNA scrittura su file/DB. Solo report JSON.
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.summary.verdict === "shadow_ok" ? 0 : 1);
}
