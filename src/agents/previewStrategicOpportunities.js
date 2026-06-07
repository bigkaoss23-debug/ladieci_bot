// src/agents/previewStrategicOpportunities.js
// ===============================================================
// Premium Planner — read-only OFFLINE adapter `previewStrategicOpportunities`.
//
// Orquesta in LABORATORIO la catena Premium già costruita (mattoni puri):
//   snapshot/fixture → currentOrderDraft + anchors
//     → strategicOpportunities (candidati cross-zone "di passaggio")
//     → routeImpact (ETA/slip/status, via bridge)
//     → premiumPlannerBridge → premiumPlannerOpportunities (contract Opportunity)
//   → response contract `premium-planner-strategic-preview-v1`.
//
// NON è wired a index.js, NON è una dispatcher action, NON è un endpoint live.
// Read-only, deps iniettate, write-guarded, no PII — sullo stesso pattern di
// `src/agents/previewOrderPlanner.js`. Vedi
// PREMIUM_PLANNER_READONLY_ADAPTER_DESIGN.md.
//
// DIVERGENZA DICHIARATA (vs design §4/§8): questa fase OFFLINE NON fa
// geo-resolution e NON chiama il planner reale `evaluateNewOrder`. Il
// currentOrderDraft porta la `zona` esplicita; la baseline diretta
// (`firstAvailable`/`bestProposal`) è il candidato diretto della catena
// strategica (anchor=null) valutato da routeImpact. La variante "planner reale +
// geo" resta fase successiva.
//
// startTime: ESPLICITO e obbligatorio in questa fase. Assente → blocker
// `missing_start_time`. MAI Date.now, MAI orario corrente, MAI driver
// availability inventata (loadPlannerSnapshot ritorna driver:null).
// ===============================================================
"use strict";

const {
  buildCandidateForAnchor,
  buildStrategicCandidates,
} = require("../core/delivery/strategicOpportunities");
const { buildRouteImpact } = require("../core/delivery/routeImpact");
const { buildOpportunityFromPlannerOption } = require("../core/delivery/premiumPlannerBridge");
const { buildPremiumOpportunity } = require("../core/delivery/premiumPlannerOpportunities");

const CONTRACT = "premium-planner-strategic-preview-v1";
const SOURCE = "offline-readonly";
const MODE = "read_only";

// Handoff/sosta operativa di default per fermata: lo snapshot non espone
// serviceMin (plannerSnapshot.normalizeOrder non lo mappa). Assunzione esplicita.
const DEFAULT_SERVICE_MIN = 2;

const TERMINAL_STATES = new Set([
  "RETIRADO",
  "COMPLETADO",
  "COMPLETATO",
  "CANCELADO",
  "ANULADO",
  "ENTREGADO",
]);

// Ordine di "bontà" degli status per il ranking finale (minore = meglio).
const STATUS_RANK = { compatible: 0, ajuste: 1, no_recomendado: 2, lleno: 3 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

// ── safety / shape helpers ────────────────────────────────────────────────────
function safetyBlock() {
  return { readOnly: true, writes: false, pii: "redacted" };
}

function safeInput(currentOrder) {
  // Echo MINIMO e no-PII: solo zona/hora/pizze del draft. Mai direccion/tel/nome.
  return {
    zona: currentOrder ? currentOrder.zone : null,
    promised: currentOrder ? currentOrder.promised : null,
    pizzas: currentOrder ? currentOrder.pizzas : 0,
  };
}

function safeError(currentOrder, code, message) {
  return {
    ok: false,
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(currentOrder),
    currentOrder: currentOrder
      ? { zone: currentOrder.zone, promised: currentOrder.promised, pizzas: currentOrder.pizzas }
      : null,
    firstAvailable: null,
    bestProposal: null,
    opportunities: [],
    serviceLine: [],
    warnings: [],
    blockers: [{ code, message }],
    error: { code, message, safe: true },
    safety: safetyBlock(),
  };
}

// ── normalization ─────────────────────────────────────────────────────────────

// Riduce il draft a soli campi planner-safe (no PII). direccion/telefono/nombre
// NON vengono letti né echeggiati.
function sanitizeCurrentOrderDraft(draft = {}) {
  const zone = normZone(draft.zona != null ? draft.zona : draft.zone);
  if (!zone) return null;
  const pizzasRaw = draft.pizzas != null ? draft.pizzas : draft.n_pizze;
  const serviceRaw = draft.serviceMin != null ? draft.serviceMin : draft.service_min;
  return {
    id: draft.id != null ? String(draft.id) : "__preview_current__",
    zone,
    label: "Pedido actual", // generico: MAI nome cliente
    promised: horaOrNull(draft.promised != null ? draft.promised : draft.hora),
    pizzas: num(pizzasRaw) || 0,
    serviceMin: num(serviceRaw) != null ? num(serviceRaw) : DEFAULT_SERVICE_MIN,
  };
}

// Riduce un anchor (esplicito o da snapshot) a soli campi non-PII.
function sanitizeAnchor(raw = {}) {
  const zone = normZone(raw.zona != null ? raw.zona : raw.zone);
  if (!zone) return null;
  const pizzasRaw = raw.pizzas != null ? raw.pizzas : raw.n_pizze;
  const serviceRaw = raw.serviceMin != null ? raw.serviceMin : raw.service_min;
  return {
    id: raw.id != null ? String(raw.id) : `anchor-${zone.toLowerCase()}`,
    zone,
    // label generica: MAI nome cliente. Se arriva un label esplicito lo
    // accettiamo solo se non sembra PII (nessun controllo euristico: usiamo
    // sempre una label derivata dalla zona per sicurezza).
    label: `Pedido ${zone}`,
    promised: horaOrNull(raw.promised != null ? raw.promised : raw.hora),
    pizzas: num(pizzasRaw) || 0,
    serviceMin: num(serviceRaw) != null ? num(serviceRaw) : DEFAULT_SERVICE_MIN,
  };
}

// Costruisce gli anchor dallo snapshot read-only: DOMICILIO, non terminali, con
// zona e hora, esclusa la bozza corrente. Solo campi non-PII (lo snapshot stesso
// è già no-PII via plannerSnapshot/readOnlyDbAdapter).
//
// FILTRO same-zone (A1): se `opts.currentOrderZone` è fornita, gli ordini della
// STESSA zona del current draft NON diventano anchor strategici. Lo strategic
// Premium layer serve le opportunità cross-zone / "di passaggio"; la
// consolidazione same-zone è dominio del planner classico (`evaluateNewOrder`).
// Senza un leg "Q2->Q2" in deliveryLegs, un anchor same-zone degraderebbe a
// `blocked/missing_travel_times` (rotta [Q2,Q2]) — confuso lato UI. Meglio non
// generarlo. Se `currentOrderZone` è assente → nessun filtro (backward-compat).
function buildAnchorsFromSnapshot(snapshot = {}, opts = {}) {
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const currentId = opts.currentOrderId != null ? String(opts.currentOrderId) : null;
  const currentZone = opts.currentOrderZone != null ? normZone(opts.currentOrderZone) : null;
  const out = [];
  for (const o of orders) {
    if (!o) continue;
    const tipo = String(o.tipo_consegna || "DOMICILIO").trim().toUpperCase();
    if (tipo !== "DOMICILIO") continue;
    const estado = String(o.estado || "").trim().toUpperCase();
    if (TERMINAL_STATES.has(estado)) continue;
    const zone = normZone(o.zona != null ? o.zona : o.zone);
    if (!zone) continue;
    if (currentId != null && String(o.id) === currentId) continue;
    // same-zone del current → dominio del planner classico, non strategic.
    if (currentZone != null && zone === currentZone) continue;
    const anchor = sanitizeAnchor(o);
    if (anchor) out.push(anchor);
  }
  return out;
}

// ── opportunity mapping ───────────────────────────────────────────────────────

// Opportunity "blocked" per candidati non viabili (tratte mancanti o cross
// non forzabile): nessun routeEtas finto, status no_recomendado, blocked true.
function blockedOpportunity(cand, currentOrder, code, message) {
  return buildPremiumOpportunity({
    id: cand.id,
    kind: cand.kind,
    giroId: cand.anchorId,
    currentOrderZone: currentOrder.zone,
    currentOrderLabel: currentOrder.label,
    routeZones: cand.routeZones,
    mapPath: cand.mapPath,
    channel: cand.channel,
    routeEtas: [],
    status: "no_recomendado",
    blocked: true,
    warning: message || cand.reason || code,
    explanation: cand.reason || message || "",
    chip: "no_recomendado",
  });
}

// Mappa UN candidato strategico → Opportunity contract-ready.
// Ritorna { opp, blockedReason } oppure null se il candidato va scartato
// (cross con includeCrossZone=false).
function mapCandidateToOpportunity(cand, currentOrder, ctx = {}) {
  const includeCrossZone = ctx.includeCrossZone !== false;
  const isCross = cand.channel === "cross";

  if (isCross && !includeCrossZone) return null;

  // Tratte di viaggio mancanti → bloccato, no ETA fantasma.
  if (cand.routeImpactInput == null) {
    return {
      opp: blockedOpportunity(
        cand,
        currentOrder,
        "missing_travel_times",
        cand.reason || "Tiempos de viaje incompletos"
      ),
      blockedReason: "missing_travel_times",
    };
  }

  // Candidato con routeImpactInput: il bridge esegue routeImpact e mappa al
  // contract. syntheticOption dà solo kind/giroId; status/ETA arrivano dal motore.
  const syntheticOption = {
    type: cand.kind === "crear" ? "separate" : "join_giro",
    giro_id: cand.anchorId,
    status: "valid",
    retraso: 0,
  };
  const opp = buildOpportunityFromPlannerOption(syntheticOption, {
    id: cand.id,
    currentOrderZone: currentOrder.zone,
    currentOrderLabel: currentOrder.label,
    routeZones: cand.routeZones,
    mapPath: cand.mapPath,
    routeImpactInput: cand.routeImpactInput,
  });

  // RICONCILIAZIONE cross-channel: routeImpact NON conosce il canale e potrebbe
  // dire "compatible" su una rotta cross. La decisione strategica (cross =
  // no_recomendado) vince: l'adapter forza lo status a valle del bridge.
  if (isCross) {
    opp.status = "no_recomendado";
    opp.severity = "blocked";
    opp.blocked = true;
    if (!opp.warning) opp.warning = cand.reason || "Canales distintos: ruta no recomendada";
    return { opp, blockedReason: "cross_channel" };
  }

  return { opp, blockedReason: null };
}

// Ranking finale: non bloccati prima, poi per bontà dello status, stabile.
function rankOpportunities(opps) {
  return (Array.isArray(opps) ? opps : [])
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const ba = a.o.blocked ? 1 : 0;
      const bb = b.o.blocked ? 1 : 0;
      if (ba !== bb) return ba - bb;
      const ra = STATUS_RANK[a.o.status] != null ? STATUS_RANK[a.o.status] : 99;
      const rb = STATUS_RANK[b.o.status] != null ? STATUS_RANK[b.o.status] : 99;
      if (ra !== rb) return ra - rb;
      return a.i - b.i;
    })
    .map((x) => x.o);
}

// ── response assembly ─────────────────────────────────────────────────────────

function buildStrategicContext(input, currentOrder) {
  return {
    startTime: input.startTime,
    travelTimes: input.travelTimes,
    capacity: input.capacity || {},
    toleranceMin: input.toleranceMin,
  };
}

function buildStrategicPreviewResponse({
  input,
  currentOrder,
  anchors,
  firstAvailable,
  bestProposal,
  opportunities,
  warnings,
}) {
  return {
    ok: true,
    contract: CONTRACT,
    source: SOURCE,
    mode: MODE,
    input: safeInput(currentOrder),
    currentOrder: {
      zone: currentOrder.zone,
      promised: currentOrder.promised,
      pizzas: currentOrder.pizzas,
    },
    firstAvailable: firstAvailable || null,
    bestProposal: bestProposal || null,
    opportunities: Array.isArray(opportunities) ? opportunities : [],
    // serviceLine: sintesi NON-PII degli anchor (giros/huecos di servizio).
    serviceLine: (Array.isArray(anchors) ? anchors : []).map((a) => ({
      id: a.id,
      zone: a.zone,
      promised: a.promised,
      pizzas: a.pizzas,
    })),
    warnings: Array.isArray(warnings) ? warnings : [],
    blockers: [],
    safety: safetyBlock(),
  };
}

// ── adapter principale ────────────────────────────────────────────────────────

async function previewStrategicOpportunities(input = {}, deps = {}) {
  const currentOrder = sanitizeCurrentOrderDraft(input.currentOrderDraft || input.currentOrder || {});
  if (!currentOrder) {
    return safeError(null, "missing_current_order", "Falta el pedido actual (zona)");
  }

  // startTime ESPLICITO obbligatorio. MAI Date.now / orario corrente.
  if (input.startTime == null || input.startTime === "") {
    return safeError(currentOrder, "missing_start_time", "Falta startTime explícito (rider libre)");
  }
  if (!isValidHora(input.startTime)) {
    return safeError(currentOrder, "invalid_start_time", "startTime no válido (HH:MM)");
  }

  const warnings = [];

  // Anchors: espliciti (sanitizzati) hanno precedenza; altrimenti dallo snapshot
  // (fixture o deps.loadSnapshot). Nessun DB diretto qui.
  let anchors;
  if (Array.isArray(input.anchors)) {
    anchors = input.anchors.map(sanitizeAnchor).filter(Boolean);
  } else {
    let snapshot = input.snapshot;
    if (!snapshot && typeof deps.loadSnapshot === "function") {
      try {
        snapshot = await deps.loadSnapshot({
          db: deps.db,
          date: input.date,
          now: input.now,
          includePii: false,
        });
      } catch (e) {
        return safeError(currentOrder, "snapshot_unavailable", "Snapshot no disponible");
      }
    }
    if (!snapshot) {
      return safeError(currentOrder, "missing_snapshot", "Falta snapshot o loadSnapshot");
    }
    anchors = buildAnchorsFromSnapshot(snapshot, {
      currentOrderId: currentOrder.id,
      currentOrderZone: currentOrder.zone, // A1: scarta anchor same-zone (planner classico)
    });
  }

  // Moduli iniettabili (default ai mattoni puri).
  const makeCandidates = typeof deps.buildStrategicCandidates === "function"
    ? deps.buildStrategicCandidates
    : buildStrategicCandidates;
  const makeDirectCandidate = typeof deps.buildCandidateForAnchor === "function"
    ? deps.buildCandidateForAnchor
    : buildCandidateForAnchor;
  const runRouteImpact = typeof deps.buildRouteImpact === "function"
    ? deps.buildRouteImpact
    : buildRouteImpact;

  const context = buildStrategicContext(input, currentOrder);
  const includeCrossZone = input.includeCrossZone !== false;

  let firstAvailable = null;
  let bestProposal = null;
  try {
    // ── Baseline diretta: candidato per il solo ordine attuale (anchor=null). ──
    const directCand = makeDirectCandidate(currentOrder, null, context);
    if (directCand && directCand.routeImpactInput) {
      const impact = runRouteImpact(directCand.routeImpactInput);
      const firstEta = Array.isArray(impact.routeEtas) && impact.routeEtas[0]
        ? impact.routeEtas[0].eta
        : null;
      firstAvailable = { zone: currentOrder.zone, eta: firstEta, status: impact.status };
      const mappedDirect = mapCandidateToOpportunity(directCand, currentOrder, { includeCrossZone });
      bestProposal = mappedDirect ? mappedDirect.opp : null;
    } else {
      warnings.push({ code: "direct_unavailable", message: "Baseline directa no disponible (tiempos de viaje)" });
    }

    // ── Opportunità di giro dagli anchor. ──
    let opportunities = [];
    if (!anchors.length) {
      warnings.push({ code: "no_anchors", message: "No hay pedidos ancla compatibles" });
    } else {
      const candidates = makeCandidates({
        currentOrder,
        anchors,
        startTime: context.startTime,
        travelTimes: context.travelTimes,
        capacity: context.capacity,
        toleranceMin: context.toleranceMin,
      });
      let anyMissingTravel = false;
      for (const cand of candidates) {
        const mapped = mapCandidateToOpportunity(cand, currentOrder, { includeCrossZone });
        if (!mapped) continue; // cross scartato (includeCrossZone=false)
        if (mapped.blockedReason === "missing_travel_times") anyMissingTravel = true;
        opportunities.push(mapped.opp);
      }
      if (anyMissingTravel) {
        warnings.push({ code: "missing_travel_times", message: "Algunas rutas no tienen tiempos de viaje" });
      }
    }
    opportunities = rankOpportunities(opportunities);

    return buildStrategicPreviewResponse({
      input,
      currentOrder,
      anchors,
      firstAvailable,
      bestProposal,
      opportunities,
      warnings,
    });
  } catch (e) {
    return safeError(currentOrder, "strategic_preview_unavailable", "Premium planner preview no disponible");
  }
}

module.exports = {
  previewStrategicOpportunities,
  buildAnchorsFromSnapshot,
  sanitizeCurrentOrderDraft,
  sanitizeAnchor,
  mapCandidateToOpportunity,
  rankOpportunities,
  buildStrategicPreviewResponse,
  _internal: { CONTRACT, SOURCE, MODE, DEFAULT_SERVICE_MIN, TERMINAL_STATES },
};
