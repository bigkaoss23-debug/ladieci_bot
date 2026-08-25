// src/agents/previewManualGiroRoute.js
// ===============================================================
// Premium Planner — read-only OFFLINE action `previewManualGiroRoute`.
//
// Data una SEQUENZA di tappe scelta dall'operatore (es. Q2 → Q5), calcola
// backend-side una `routeTimeline` v2 GIÀ pronta (ETA per tappa, slip vs
// prometido, ritorno, rischio, operatorMessage). Il frontend è renderer-only:
// raccoglie i click, manda `selectedStops`, disegna la timeline ricevuta.
//
// Modalità INVERSA rispetto a `previewStrategicOpportunities` (lì il backend
// SUGGERISCE gli anchor; qui l'OPERATORE propone la rotta). Stesso pattern
// read-only/no-PII/safety, contract dedicato.
//
// PUREZZA / SICUREZZA:
//   - read-only: nessuna scrittura DB, nessun `manual_giro`, nessun ordine,
//     nessun WhatsApp, nessun apply.
//   - nessun `Date.now`: `startTime` è ESPLICITO nell'input (orologio =
//     responsabilità del chiamante). Assente → blocker `missing_start_time`.
//   - nessun fetch/DB/env nel core: usa solo i mattoni PURI
//     (deliveryChannels + deliveryLegs + routeImpact + routeTimeline).
//   - no PII: input echo = solo { startTime, zones }. Le label sospette di PII
//     (telefono/email) vengono sostituite con `Pedido <zone>`.
//   - deterministico: stessi input → stesso output.
//
// MISSING TRAVEL TIMES: una tratta non definita in `deliveryLegs` (cross-channel
// o zona isolata) NON produce ETA inventati: la timeline esce BLOCCATA (nodi con
// eta:null, risk blocked/no_recomendado) e un blocker `missing_travel_times`.
//
// CAPACITY (decisione, risolve l'ambiguità del design §5):
//   - `capacity.pizzas`   = pizze GIÀ nel giro (load esistente). Default 0.
//   - `capacity.maxPizzas`= cap pizze del giro (additivo: la §5 lo ometteva).
//                           Assente → capacità "desconocida", MAI falso `full`.
//   - `capacity.limitMin` = durata massima ammessa del giro (→ routeMinLimit).
//   Total load = capacity.pizzas (esistente) + Σ pizze delle tappe selezionate.
// ===============================================================
"use strict";

const { routeChannel } = require("../core/delivery/deliveryChannels");
const {
  HUB_LABEL,
  makeLegKey,
  buildTravelTimesForPath,
} = require("../core/delivery/deliveryLegs");
const { buildRouteImpact } = require("../core/delivery/routeImpact");
const { buildRouteTimeline } = require("../core/delivery/routeTimeline");

const CONTRACT = "premium-planner-manual-giro-route-preview-v1";
const SOURCE = "offline-readonly";
const MODE = "read_only";

// Cap proposto di tappe per un giro manuale (oltre → too_many_stops).
const MAX_STOPS = 5;
// Handoff/sosta operativa di default per fermata (coerente con lo strategic).
const DEFAULT_SERVICE_MIN = 2;
// Zone valide (Q1..Q5). routeChannel/getZoneChannel le conoscono; qui un set
// esplicito per la validazione `invalid_zone` (locale, niente import extra).
const VALID_ZONES = new Set(["Q1", "Q2", "Q3", "Q4", "Q5"]);

// ── helpers puri ──────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
// Limite numerico VALIDO o null (null/""/false NON sono 0; vedi routeImpact).
function finiteLimit(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function normZone(zone) {
  return String(zone == null ? "" : zone).trim().toUpperCase();
}
function isValidHora(value) {
  if (typeof value !== "string") return false;
  const m = value.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return false;
  const h = Number(m[1]);
  return Number.isInteger(h) && h >= 0 && h <= 23;
}
function horaOrNull(value) {
  return isValidHora(value) ? value.trim() : null;
}
// Etichetta che "sembra" PII (telefono/email/whatsapp) → da NON propagare.
function looksLikePii(s) {
  if (typeof s !== "string") return false;
  return /\d{6,}|@|\+\d|\btel\b|tele|phone|whats?app/i.test(s);
}
// Label presentazionale safe: tiene quella fornita se generica, altrimenti la
// deriva dalla zona. MAI nome/telefono cliente.
function safeLabel(raw, zone, isNew) {
  if (typeof raw === "string" && raw.trim() && !looksLikePii(raw)) return raw.trim();
  if (isNew) return "Pedido actual";
  return zone ? `Pedido ${zone}` : "Parada";
}

function safetyBlock() {
  return { readOnly: true, writes: false, pii: "redacted" };
}

// Echo input MINIMO e no-PII: solo startTime + zone in ordine.
function safeInput(startTime, zones) {
  return {
    startTime: horaOrNull(startTime),
    zones: Array.isArray(zones) ? zones.slice() : [],
  };
}

// Errore di validazione controllato: HTTP-friendly (il dispatcher risponde 200),
// ok:false, blocker safe, niente routeTimeline, niente PII/stacktrace.
function safeError(startTime, zones, code, message) {
  return {
    ok: false,
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(startTime, zones),
    routeTimeline: null,
    warnings: [],
    blockers: [{ code, message }],
    error: { code, message, safe: true },
    safety: safetyBlock(),
  };
}

// ── normalizzazione tappe ─────────────────────────────────────────────────────
// Espande `selectedZones` (shorthand LAB) in stops: la zona uguale a quella del
// draft → current_order; le altre → anchor. promised/pizzas null (solo zone).
function expandSelectedZones(zones, currentZone) {
  const list = Array.isArray(zones) ? zones : [];
  let currentUsed = false;
  return list.map((z) => {
    const zone = normZone(z);
    const isCurrent = !currentUsed && zone === currentZone;
    if (isCurrent) currentUsed = true;
    return { type: isCurrent ? "current_order" : "anchor", zone };
  });
}

// Sanitizza una sequenza di stops in vista comune no-PII. Ritorna
// { stops, error } dove error è un codice di validazione (o null).
// `currentOrderDraft` fornisce pizzas/hora di default per la tappa current_order.
function sanitizeStops(rawStops, currentDraft) {
  const list = Array.isArray(rawStops) ? rawStops : [];
  const stops = [];
  let currentCount = 0;
  const draftPizzas = num(currentDraft && currentDraft.pizzas) || 0;
  const draftHora = horaOrNull(currentDraft && currentDraft.hora);

  for (const raw of list) {
    const s = raw || {};
    const type = String(s.type == null ? "" : s.type).trim();
    if (type !== "current_order" && type !== "anchor") {
      return { stops: null, error: { code: "invalid_stop_type", message: `Tipo de parada no válido: ${type || "vacío"}` } };
    }
    const zone = normZone(s.zone);
    if (!zone) {
      return { stops: null, error: { code: "missing_zone", message: "Falta la zona de una parada" } };
    }
    if (!VALID_ZONES.has(zone)) {
      return { stops: null, error: { code: "invalid_zone", message: `Zona no válida: ${zone}` } };
    }
    const isNew = type === "current_order";
    if (isNew) currentCount += 1;
    const promised = isNew
      ? (horaOrNull(s.promised) || draftHora)
      : horaOrNull(s.promised);
    const pizzas = isNew
      ? (num(s.pizzas) != null ? num(s.pizzas) : draftPizzas)
      : (num(s.pizzas) || 0);
    stops.push({
      zone,
      label: safeLabel(s.label, zone, isNew),
      isNew,
      promised,
      pizzas,
      serviceMin: DEFAULT_SERVICE_MIN,
    });
  }

  if (currentCount > 1) {
    return { stops: null, error: { code: "duplicate_current_order", message: "Más de un pedido actual en la ruta" } };
  }
  return { stops, error: null };
}

// capacity con campi presenti ma non numerici → invalid.
function capacityInvalid(cap) {
  if (cap == null || typeof cap !== "object") return false;
  for (const k of ["pizzas", "maxPizzas", "limitMin"]) {
    if (cap[k] != null && !Number.isFinite(Number(cap[k]))) return true;
  }
  return false;
}

// Stops minimi per disegnare una linea BLOCCATA senza inventare orari.
function toBlockedStops(stops) {
  return (Array.isArray(stops) ? stops : []).map((s) => ({
    zone: s.zone,
    label: s.label,
    isNew: s.isNew === true,
    promised: s.promised,
  }));
}

// proposalId deterministico e no-PII: manual-<zonesKebab>-<startCompact>.
function buildProposalId(zones, startTime) {
  const z = (Array.isArray(zones) ? zones : []).join("-").toLowerCase() || "ruta";
  const t = String(startTime || "").replace(/[^0-9]/g, "") || "0000";
  return `manual-${z}-${t}`;
}

// ── action principale ─────────────────────────────────────────────────────────
function previewManualGiroRoute(input = {}, deps = {}) {
  const inp = input && typeof input === "object" ? input : {};
  const makeTravel = typeof deps.buildTravelTimesForPath === "function"
    ? deps.buildTravelTimesForPath
    : buildTravelTimesForPath;
  const runRouteImpact = typeof deps.buildRouteImpact === "function"
    ? deps.buildRouteImpact
    : buildRouteImpact;

  const startTime = inp.startTime;

  // currentOrderDraft: obbligatorio con zona (no-PII; leggiamo solo zone/hora/pizzas).
  const draft = inp.currentOrderDraft || inp.currentOrder || null;
  if (!draft || typeof draft !== "object") {
    return safeError(startTime, [], "missing_current_order", "Falta el pedido actual");
  }
  const currentZone = normZone(draft.zona != null ? draft.zona : draft.zone);
  if (!currentZone) {
    return safeError(startTime, [], "missing_zone", "Falta la zona del pedido actual");
  }
  // tipoConsegna: solo DOMICILIO entra in un giro di consegna.
  const tipo = String(draft.tipoConsegna || draft.tipo_consegna || "DOMICILIO").trim().toUpperCase();
  if (tipo === "RITIRO") {
    return safeError(startTime, [], "pickup_not_route", "Un pedido de RITIRO no entra en un giro de reparto");
  }

  // startTime ESPLICITO obbligatorio. MAI Date.now.
  if (startTime == null || startTime === "") {
    return safeError(startTime, [], "missing_start_time", "Falta startTime explícito (salida del rider)");
  }
  if (!isValidHora(startTime)) {
    return safeError(startTime, [], "invalid_start_time", "startTime no válido (HH:MM)");
  }

  // capacity numerica valida (null/assente = sconosciuta, NON 0).
  if (capacityInvalid(inp.capacity)) {
    return safeError(startTime, [], "capacity_invalid", "Capacidad no válida (valores no numéricos)");
  }

  // Sequenza tappe: selectedStops primario; selectedZones shorthand se assente.
  let rawStops = Array.isArray(inp.selectedStops) ? inp.selectedStops : null;
  if (!rawStops || rawStops.length === 0) {
    if (Array.isArray(inp.selectedZones) && inp.selectedZones.length > 0) {
      rawStops = expandSelectedZones(inp.selectedZones, currentZone);
    }
  }
  if (!rawStops || rawStops.length === 0) {
    return safeError(startTime, [], "empty_selected_stops", "No hay paradas seleccionadas");
  }
  if (rawStops.length > MAX_STOPS) {
    return safeError(startTime, [], "too_many_stops", `Demasiadas paradas (máx ${MAX_STOPS})`);
  }

  const { stops, error } = sanitizeStops(rawStops, draft);
  if (error) {
    const zonesPartial = (stops || []).map((s) => s.zone);
    return safeError(startTime, zonesPartial, error.code, error.message);
  }

  const zones = stops.map((s) => s.zone);
  const channel = routeChannel(zones); // "sur"|"oeste"|"cross"|null
  const includeCrossZone = inp.includeCrossZone !== false;

  // cross-channel + includeCrossZone:false → scartata a monte.
  if (channel === "cross" && !includeCrossZone) {
    return safeError(startTime, zones, "cross_channel_not_recommended", "Ruta entre canales distintos: no recomendada");
  }

  const proposalId = buildProposalId(zones, startTime);
  // Baseline diretta del solo nuovo ordine (leg HUB→zona del current), per il
  // tradeoffLabel. Pura, deterministica; null se la tratta non esiste.
  const baseline = buildDirectBaseline(stops, startTime, makeTravel);

  // Travel times lungo il path [HUB, ...zones, HUB].
  const path = [HUB_LABEL, ...zones, HUB_LABEL];
  const travel = makeTravel(path) || { ok: false, travelTimes: {}, missing: path };

  // ── Ramo BLOCCATO: manca almeno una tratta (cross o zona isolata). ──
  // Nessun ETA inventato: timeline bloccata onesta + blocker missing_travel_times.
  if (!travel.ok) {
    const warnings = [];
    if (channel === "cross") {
      warnings.push({ code: "cross_channel", message: "Canales distintos: ruta no recomendada" });
    }
    const routeTimeline = buildRouteTimeline({
      proposalId,
      startTime,
      routeImpact: null,
      stops: toBlockedStops(stops),
      baseline,
      kind: "agregar",
      channel,
      status: null,
      blocked: true,
      warning: "",
      explanation: "",
    });
    return {
      ok: true,
      contract: CONTRACT,
      source: SOURCE,
      mode: MODE,
      input: safeInput(startTime, zones),
      routeTimeline,
      warnings,
      blockers: [{ code: "missing_travel_times", message: "Faltan tiempos de viaje para algún tramo" }],
      safety: safetyBlock(),
    };
  }

  // ── Ramo NORMALE: tutte le tratte note → routeImpact reale → timeline. ──
  const travelStops = stops.map((s, i) => ({
    zone: s.zone,
    label: s.label,
    isNew: s.isNew,
    promised: s.promised,
    pizzas: s.pizzas,
    serviceMin: s.serviceMin,
    travelFromPrevMin: travel.travelTimes[makeLegKey(path[i], path[i + 1])],
  }));
  const returnTravelMin = travel.travelTimes[makeLegKey(zones[zones.length - 1], HUB_LABEL)];

  const cap = inp.capacity && typeof inp.capacity === "object" ? inp.capacity : {};
  const existingLoad = finiteLimit(cap.pizzas) || 0;
  const newLoad = stops.reduce((sum, s) => sum + (num(s.pizzas) || 0), 0);
  const capacityInput = {
    pizzas: existingLoad + newLoad,
    maxPizzas: finiteLimit(cap.maxPizzas),
    routeMinLimit: finiteLimit(cap.limitMin),
    pizzaQualityLimitMin: finiteLimit(cap.pizzaQualityLimitMin),
  };

  const impact = runRouteImpact({
    startTime,
    stops: travelStops,
    returnTravelMin,
    toleranceMin: inp.toleranceMin,
    capacity: capacityInput,
  });

  let routeTimeline = buildRouteTimeline({
    proposalId,
    startTime,
    routeImpact: impact,
    stops: travelStops,
    baseline,
    kind: "agregar",
    channel,
    status: impact.status,
    blocked: impact.blocked,
    warning: impact.warning,
    explanation: impact.explanation,
  });

  // includeReturn:false → la rotta non vuole il nodo di rientro (render-level).
  // La durata del giro (routeMin/capacity) resta inclusiva del ritorno (prudente).
  if (inp.includeReturn === false && routeTimeline && Array.isArray(routeTimeline.timeline)) {
    routeTimeline = {
      ...routeTimeline,
      timeline: routeTimeline.timeline.filter((n) => n.type !== "return"),
      summary: { ...routeTimeline.summary, returnEta: null },
    };
  }

  const warnings = [];
  const blockers = [];
  // Slip per-tappa → warning non bloccante (già redatto dal motore per nodo).
  for (const node of routeTimeline.timeline) {
    if (node.type === "delivery" && node.warning) {
      warnings.push({ code: "stop_slip", message: node.warning });
    }
  }
  // Status duro del motore → blocker informativo (giro pieno).
  if (impact.status === "lleno") {
    blockers.push({ code: "capacity_full", message: impact.warning || "Giro lleno" });
  }

  return {
    ok: true,
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(startTime, zones),
    routeTimeline,
    warnings,
    blockers,
    safety: safetyBlock(),
  };
}

// Baseline diretta del nuovo ordine: startTime + leg HUB→zona(current). Pura.
function buildDirectBaseline(stops, startTime, makeTravel) {
  const current = (Array.isArray(stops) ? stops : []).find((s) => s.isNew);
  if (!current) return null;
  const t = makeTravel([HUB_LABEL, current.zone, HUB_LABEL]);
  if (!t || !t.ok) return null;
  const leg = t.travelTimes[makeLegKey(HUB_LABEL, current.zone)];
  if (!Number.isFinite(leg)) return null;
  const startMin = toMinLocal(startTime);
  if (startMin == null) return null;
  return { directEta: fromMinLocal(startMin + leg) };
}

// Helper temporali locali (service-day-aware, coerenti con routeImpact). Niente
// import per restare disaccoppiati; stessa semantica notte (<6h → +24h).
function toMinLocal(hhmm) {
  if (hhmm == null) return null;
  const m = String(hhmm).trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 6) h += 24;
  return h * 60 + min;
}
function fromMinLocal(min) {
  if (min == null || !Number.isFinite(min)) return null;
  const w = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, "0")}:${String(w % 60).padStart(2, "0")}`;
}

module.exports = {
  previewManualGiroRoute,
  // export interni per test mirati
  sanitizeStops,
  expandSelectedZones,
  buildProposalId,
  _internal: { CONTRACT, SOURCE, MODE, MAX_STOPS, DEFAULT_SERVICE_MIN },
};
