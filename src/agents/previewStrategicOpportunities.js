// src/agents/previewStrategicOpportunities.js
// ===============================================================
// Premium Planner — read-only OFFLINE adapter `previewStrategicOpportunities`.
//
// Orquesta in LABORATORIO la catena Premium già costruita (mattoni puri):
//   snapshot/fixture → currentOrderDraft + anchors
//     → strategicOpportunities (candidati cross-zone "di passaggio")
//     → routeImpact (ETA/slip/status, via bridge)
//     → premiumPlannerBridge → premiumPlannerOpportunities (contract Opportunity)
//     → deliveryProposalSelector (max 4 proposals[] dai dati già assemblati)
//   → response contract `premium-planner-strategic-preview-v1`.
//
// proposals[] è ADDITIVE: si affianca a opportunities[] (mai sostituirlo né
// rimuoverlo). Fallback safe: se il selector lancia, proposals=[] + warning.
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
const { buildRouteTimeline } = require("../core/delivery/routeTimeline");
const { selectDeliveryProposals, CONTRACT: PROPOSAL_CONTRACT } = require("../core/delivery/deliveryProposalSelector");

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

// Stati che NON permettono l'inserimento PRIMA dell'anchor nel suo giro:
// terminali (ordine chiuso) + EN_ENTREGA (rider GIÀ partito → fisicamente
// impossibile anteporre una fermata). Mantenuta per retro-compatibilità/export;
// il filtro effettivo delle ancore usa ora l'allowlist ANCHOR_ELIGIBLE_STATES.
const NON_INSERTABLE_ANCHOR_STATES = new Set([
  ...TERMINAL_STATES,
  "EN_ENTREGA",
]);

// Allowlist degli stati che POSSONO fare da ancora a un giro strategico: SOLO
// lavoro operativo confermato che il rider porterà davvero — EN_COCINA (in forno)
// e LISTO (pronto, non ancora partito). Esclude di proposito:
//   - POR_CONFIRMAR / NUEVO: non confermati, possono non confermarsi mai (es. il
//     fantasma #001 Q1 20:25, rimasto vivo e usato come ancora → proposta +155 min);
//   - EN_ENTREGA: rider già uscito, non si antepone una fermata;
//   - terminali + CHIUSO_FORZATO: ordini chiusi.
// Allowlist (non blocklist): qualunque stato ignoto/futuro è escluso per default.
const ANCHOR_ELIGIBLE_STATES = new Set(["EN_COCINA", "LISTO"]);

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

// ── anti-staleness anchor ──────────────────────────────────────────────────────
// Soglia di grazia: un anchor il cui riferimento temporale è oltre questi minuti
// NEL PASSATO rispetto a `now` è considerato stantio e NON fa da ancora (evita le
// proposte tossiche tipo +150 da un EN_COCINA/LISTO vecchio). Prudente: gli anchor
// futuri o vicini restano SEMPRE (EN_COCINA programmato dopo, LISTO appena pronto).
const ANCHOR_STALE_GRACE_MIN = 30;

// Orario "HH:MM" → minuti-clock, con la STESSA normalizzazione night-service
// (h<6 → +24) di strategicOpportunities.toMin / routeImpact, così `now` e i
// riferimenti degli anchor vivono sullo stesso orologio. Null se non parsabile.
function toClockMin(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = hhmm.trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (h < 6) h += 24; // night-service normalization
  return h * 60 + min;
}

// Riferimento temporale più affidabile per valutare la staleness di un anchor
// DOMICILIO: preferisce l'ETA di consegna stimata, poi la salida driver, poi il
// forno_out, infine la hora promessa. Usa l'orario più "a valle" così non si
// scarta un ordine solo perché la hora nuda è appena passata. Null se nessun
// campo è un "HH:MM" valido (→ nessun giudizio: l'anchor viene tenuto).
function anchorRefHora(o = {}) {
  return horaOrNull(o.entrega_estimada)
    || horaOrNull(o.salida_driver_estimada)
    || horaOrNull(o.forno_out)
    || horaOrNull(o.hora);
}

// True se l'anchor è stantio rispetto a `now` (oltre la grazia nel passato).
// Conservativo: se manca `now` o il riferimento dell'anchor, NON è stantio.
function isAnchorStale(o, nowMin) {
  if (nowMin == null) return false;
  const refMin = toClockMin(anchorRefHora(o));
  if (refMin == null) return false;
  return refMin < nowMin - ANCHOR_STALE_GRACE_MIN;
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
    // proposals[] additive: sempre presente (anche su errore) → lista vuota.
    proposals: [],
    proposalContract: PROPOSAL_CONTRACT,
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

// Costruisce gli anchor dallo snapshot read-only: DOMICILIO, inseribili (non
// terminali e rider non ancora partito — vedi NON_INSERTABLE_ANCHOR_STATES), con
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
//
// FILTRO ANTI-STALE (now): se `opts.now` (o snapshot.now) è disponibile, un anchor
// il cui riferimento temporale è oltre ANCHOR_STALE_GRACE_MIN nel PASSATO viene
// scartato — così un EN_COCINA/LISTO vecchio non genera più proposte tossiche
// (+150). Gli anchor futuri/vicini restano sempre (vedi isAnchorStale). Senza now
// il filtro è no-op (backward-compat).
function buildAnchorsFromSnapshot(snapshot = {}, opts = {}) {
  const orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  const currentId = opts.currentOrderId != null ? String(opts.currentOrderId) : null;
  const currentZone = opts.currentOrderZone != null ? normZone(opts.currentOrderZone) : null;
  const nowMin = toClockMin(opts.now != null ? opts.now : snapshot.now);
  const out = [];
  for (const o of orders) {
    if (!o) continue;
    const tipo = String(o.tipo_consegna || "DOMICILIO").trim().toUpperCase();
    if (tipo !== "DOMICILIO") continue;
    const estado = String(o.estado || "").trim().toUpperCase();
    // Solo lavoro operativo confermato può fare da ancora: EN_COCINA / LISTO.
    // Esclude POR_CONFIRMAR/NUEVO (non confermati, fantasmi), EN_ENTREGA (rider
    // già uscito), terminali e CHIUSO_FORZATO. Vedi ANCHOR_ELIGIBLE_STATES.
    if (!ANCHOR_ELIGIBLE_STATES.has(estado)) continue;
    const zone = normZone(o.zona != null ? o.zona : o.zone);
    if (!zone) continue;
    if (currentId != null && String(o.id) === currentId) continue;
    // same-zone del current → dominio del planner classico, non strategic.
    if (currentZone != null && zone === currentZone) continue;
    // anti-stale: scarta anchor troppo nel passato rispetto a `now`.
    if (isAnchorStale(o, nowMin)) continue;
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

// Stops minimi per disegnare una linea BLOCCATA (tratte mancanti / cross non
// viabile) senza inventare orari: zone dal candidato, isNew = zona del current.
function buildBlockedStops(cand, currentOrder) {
  const zones = Array.isArray(cand.routeZones) ? cand.routeZones : [];
  return zones.map((z) => ({
    zone: z,
    label: z === currentOrder.zone ? currentOrder.label : `Pedido ${z}`,
    isNew: z === currentOrder.zone,
    promised: z === currentOrder.zone ? currentOrder.promised : null,
  }));
}

// Allega (additivo) `routeTimeline` v2 a una opportunity già costruita. Il mapper
// è puro; riceve l'impact COMPLETO (driverReturn incluso) o null se bloccata.
function attachRouteTimeline(opp, cand, currentOrder, impact) {
  opp.routeTimeline = buildRouteTimeline({
    proposalId: opp.id,
    startTime: cand.routeImpactInput ? cand.routeImpactInput.startTime : null,
    routeImpact: impact || null,
    stops: cand.routeImpactInput
      ? cand.routeImpactInput.stops
      : buildBlockedStops(cand, currentOrder),
    baseline: opp.baseline,
    kind: opp.kind,
    channel: cand.channel,
    status: opp.status,
    blocked: opp.blocked,
    warning: opp.warning,
    explanation: opp.explanation,
  });
  return opp;
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
    const blockedOpp = blockedOpportunity(
      cand,
      currentOrder,
      "missing_travel_times",
      cand.reason || "Tiempos de viaje incompletos"
    );
    attachRouteTimeline(blockedOpp, cand, currentOrder, null);
    return {
      opp: blockedOpp,
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

  // Impact COMPLETO (con driverReturn/routeMin) per il mapper timeline. È una
  // ricomputazione pura/offline dello stesso input già usato dal bridge: serve
  // perché il bridge espone solo il subset opportunity (storicamente senza
  // driverReturn). Niente IO, niente Date.now.
  const fullImpact = buildRouteImpact(cand.routeImpactInput);

  // RICONCILIAZIONE cross-channel: routeImpact NON conosce il canale e potrebbe
  // dire "compatible" su una rotta cross. La decisione strategica (cross =
  // no_recomendado) vince: l'adapter forza lo status a valle del bridge.
  if (isCross) {
    opp.status = "no_recomendado";
    opp.severity = "blocked";
    opp.blocked = true;
    if (!opp.warning) opp.warning = cand.reason || "Canales distintos: ruta no recomendada";
    attachRouteTimeline(opp, cand, currentOrder, fullImpact);
    return { opp, blockedReason: "cross_channel" };
  }

  attachRouteTimeline(opp, cand, currentOrder, fullImpact);
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
  const warningsOut = Array.isArray(warnings) ? warnings.slice() : [];
  const response = {
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
    warnings: warningsOut,
    blockers: [],
    safety: safetyBlock(),
  };

  // proposals[] ADDITIVE: il selector puro sceglie max 4 proposte dai dati GIÀ
  // assemblati (firstAvailable/bestProposal/opportunities). NON tocca né rimuove
  // opportunities[]: è un campo nuovo accanto. Fallback safe: se il selector
  // lancia, proposals=[] + warning, la preview resta intatta.
  response.proposalContract = PROPOSAL_CONTRACT;
  try {
    const selection = selectDeliveryProposals(response);
    response.proposals = Array.isArray(selection.proposals) ? selection.proposals : [];
  } catch (_) {
    response.proposals = [];
    warningsOut.push({
      code: "proposal_selection_unavailable",
      message: "No se pudieron derivar las propuestas (preview intacta)",
    });
  }

  return response;
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
      now: input.now, // anti-stale: riferimento temporale (fallback snapshot.now)
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
  isAnchorStale,
  anchorRefHora,
  toClockMin,
  _internal: { CONTRACT, SOURCE, MODE, DEFAULT_SERVICE_MIN, TERMINAL_STATES, NON_INSERTABLE_ANCHOR_STATES, ANCHOR_ELIGIBLE_STATES, ANCHOR_STALE_GRACE_MIN },
};
