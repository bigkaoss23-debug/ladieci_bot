// tests/fixtures/deliveryPlannerSyntheticStress.js
// ===============================================================
// FIXTURE SINTETICHE — stress test offline del Delivery Planner rev.5.
// 100% dati FAKE inventati. Nessun cliente reale, nessuna PII, nessun indirizzo,
// nessun telefono. Nessun accesso DB/Supabase/rete. Solo builder + helper invarianti.
// ===============================================================
"use strict";

// ── Builder ordini (solo fatti grezzi; derivati committati solo per i congelati) ─
function mkDelivery(o) {
  return {
    id: o.id, tipo_consegna: "DOMICILIO", estado: o.estado || "NUEVO",
    zona: o.zona, hora: o.hora, andata_min: o.andata_min,
    durata_andata_min: o.andata_min, n_pizze: o.n_pizze ?? 1,
    ...(o.manual_giro_id ? { manual_giro_id: o.manual_giro_id } : {}),
    ...(o.forzado ? { forzado: true } : {}),
    ...(o.forzado_hora ? { forzado_hora: o.forzado_hora } : {}),
    ...(o.created_at ? { created_at: o.created_at } : {}),
    // congelati duri: valori committati (realtà — input):
    ...(o.forno_out ? { forno_out: o.forno_out } : {}),
    ...(o.salida_driver_estimada ? { salida_driver_estimada: o.salida_driver_estimada } : {}),
    ...(o.entrega_estimada ? { entrega_estimada: o.entrega_estimada } : {}),
    ...(o.retraso_estimado_min != null ? { retraso_estimado_min: o.retraso_estimado_min } : {}),
    // diagnostica geo (il core NON la consuma; serve solo a documentare i dati sporchi):
    ...(o.geo_source ? { geo_source: o.geo_source } : {}),
    ...(o.durata_google_min !== undefined ? { durata_google_min: o.durata_google_min } : {}),
    ...(o.durata_haversine_min !== undefined ? { durata_haversine_min: o.durata_haversine_min } : {}),
  };
}
function mkPickup(o) {
  return {
    id: o.id, tipo_consegna: "RITIRO", estado: o.estado || "NUEVO",
    zona: null, hora: o.hora, andata_min: null, n_pizze: o.n_pizze ?? 1,
    ...(o.forno_out ? { forno_out: o.forno_out } : {}),
  };
}

// ── Helper temporali (service-day-aware, allineati al planner) ────────────────
function toMin(hhmm) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm || ""));
  if (!m) return null;
  let h = Number(m[1]);
  if (h < 6) h += 24;
  return h * 60 + Number(m[2]);
}
const isHHMM = (s) => typeof s === "string" && /^\d\d:\d\d$/.test(s) && !/^(24|25):/.test(s);

// ── Invarianti riusabili (robusti, non fragili sul minuto) ────────────────────
function projections(plan) { return Object.values(plan.orders || {}); }

function assertNoInvalidTimes(plan) {
  const bad = projections(plan).filter((p) =>
    [p.forno_out, p.salida, p.entrega].some((t) => t != null && !isHHMM(t)));
  return { ok: bad.length === 0, bad: bad.map((p) => p.id) };
}
function assertNoDriverBeforePizza(plan) {
  const bad = projections(plan).filter((p) =>
    p.tipo === "DOMICILIO" && p.salida != null && p.forno_out != null &&
    toMin(p.salida) < toMin(p.forno_out));
  return { ok: bad.length === 0, bad: bad.map((p) => p.id) };
}
function assertNoRiderOverlap(plan) {
  return { ok: (plan.rider_overlaps || []).length === 0, overlaps: plan.rider_overlaps || [] };
}
function assertEntregaCoherent(plan, orders) {
  // entrega − forno_out == andata per ogni domicilio MOVIBILE/auto (no congelati/blocchi).
  const byId = Object.fromEntries((orders || []).map((o) => [o.id, o]));
  const bad = projections(plan).filter((p) => {
    if (p.tipo !== "DOMICILIO" || p.entrega == null || p.forno_out == null) return false;
    if (p.freeze === "CONGELATO_DURO") return false;
    if (p.rider_block || (p.giro_id && String(p.giro_id).startsWith("BLK:"))) return false; // rider block: entrega = arrivo route (cliente→cliente)
    const o = byId[p.id]; if (!o) return false;
    return (toMin(p.entrega) - toMin(p.forno_out)) !== (Number(o.andata_min) || 0);
  });
  return { ok: bad.length === 0, bad: bad.map((p) => p.id) };
}

function findTripByZone(plan, zona) {
  return (plan.trips || []).find((t) => t.zona === zona);
}
function tripWarnings(plan) {
  const ws = [...(plan.warnings || [])];
  for (const t of (plan.trips || [])) for (const w of (t.warnings || [])) ws.push(w);
  for (const b of (plan.blocks || [])) for (const w of (b.warnings || [])) ws.push(w);
  return ws;
}
function findWarnings(plan, sub) {
  return tripWarnings(plan).filter((w) => String(w).includes(sub));
}
function ovenSlotLoads(plan) { return Object.values(plan.ovenLoad || {}); }

module.exports = {
  mkDelivery, mkPickup, toMin, isHHMM,
  assertNoInvalidTimes, assertNoDriverBeforePizza, assertNoRiderOverlap,
  assertEntregaCoherent, findTripByZone, findWarnings, tripWarnings, ovenSlotLoads,
};
