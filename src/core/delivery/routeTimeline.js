// ===============================================================
// routeTimeline.js — Premium Planner routeTimeline v2 mapper (PURO/offline)
// ===============================================================
// Mattone PURO/offline. Implementa il contract additivo descritto in
// PREMIUM_PLANNER_ROUTE_TIMELINE_V2_DESIGN.md: trasforma l'output GIÀ CALCOLATO
// da `routeImpact` (+ contesto candidato) in una `routeTimeline` disegnabile dal
// frontend (Pizzería → consegne → Regreso), con summary/risk/operatorMessage.
//
// PUREZZA: nessun IO, nessun fetch, nessun DB, nessun env, nessun Date.now,
// nessuna mutazione dell'input, output deterministico. Unico import: helper
// temporali puri di `routeImpact` (toMin/fromMin) per coerenza service-day.
//
// REGOLA DURA — niente orari inventati: se non c'è `routeImpact` (tratte
// mancanti / cross non viabile), i nodi escono con `eta:null` e `risk` prudente
// (blocked/no_recomendado), MAI un orario plausibile o un verde finto.
//
// FONTE VERITÀ dei campi (già calcolati a monte, qui solo riesposti/etichettati):
//   - startTime            → nodo departure
//   - routeImpact.routeEtas → nodi delivery (eta/promised/slipLabel/isNew)
//   - routeImpact.driverReturn → nodo return + summary.returnEta
//   - routeImpact.routeMin / capacity → margine (tight) e risk
//   - baseline.directEta   → summary.directEta + tradeoffLabel
//   - status/blocked/warning/channel → risk + operatorMessage
// Niente aritmetica di scheduling qui: la sola "nuova" derivazione è il margine
// di vicinanza al limite (durata) per distinguere `ok` da `tight`, da numeri
// (`routeMin`/`limitMin`) GIÀ prodotti dal motore.
// ===============================================================
"use strict";

const { toMin } = require("./routeImpact");

const VERSION = "route-timeline-v2";

// Soglia (min) sotto la quale una route compatibile diventa "margen muy justo"
// (tight). Unica derivazione di vicinanza-al-limite; il motore marca tight solo
// quando si è GIÀ oltre, qui aggiungiamo il "vicino-ma-non-oltre".
const DEFAULT_MARGIN_TIGHT_THRESHOLD_MIN = 3;

const HUB_LABEL = "Pizzería";
const RETURN_LABEL = "Regreso pizzería";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}
// "" e "+0" → nessuno slip reale; "+N" (N>0) → slip. Pass-through, niente calcolo.
function slipOrNull(v) {
  const s = strOrNull(v);
  if (!s || s === "+0") return null;
  return s;
}

// Margine leggibile di una consegna rispetto alla sua promessa (backend math su
// campi esistenti, helper puro toMin). null se manca eta o promised.
function marginLabelFor(eta, promised) {
  const e = toMin(eta);
  const p = toMin(promised);
  if (e == null || p == null) return null;
  const d = p - e; // >0 in anticipo, 0 al filo, <0 in ritardo
  if (d > 0) return `+${d} margen`;
  if (d === 0) return "+0 margen";
  return `−${-d} vs prometido`;
}

// Etichetta tradeoff giro vs diretta (già redatta). "" se non calcolabile.
function buildTradeoffLabel(directEta, giroEta, kind) {
  const d = toMin(directEta);
  const g = toMin(giroEta);
  if (d == null || g == null) return "";
  const delta = g - d;
  const sign = delta >= 0 ? "+" : "−";
  let s = `${sign}${Math.abs(delta)} vs directa`;
  if (kind === "agregar") s += " · 1 viaje ahorrado";
  return s;
}

// Normalizza una sorgente-consegna (routeEta dell'impact OPPURE stop grezzo) in
// una vista comune { zone, label, eta, promised, slipLabel, isNew }. Con impact
// presente eta/slip sono reali; senza impact eta=null (mai inventato).
function normalizeDelivery(entry, hasImpact) {
  const e = entry || {};
  return {
    zone: e.zone != null ? String(e.zone) : null,
    label: typeof e.label === "string" ? e.label : "",
    eta: hasImpact ? strOrNull(e.eta) : null,
    promised: strOrNull(e.promised),
    slipLabel: hasImpact ? slipOrNull(e.slipLabel) : null,
    isNew: e.isNew === true,
  };
}

// risk rollup (precedenza esplicita). cross → MAI verde; capacità piena → full;
// senza impact → blocked (o no_recomendado se lo status soft lo dice); slip →
// warning; vicino al limite → tight; compatibile → ok. Stato ignoto → blocked
// (safe, mai verde).
function computeRisk({ channel, effStatus, capacityState, hasImpact, effBlocked, anySlip, tightMargin }) {
  if (channel === "cross") return "no_recomendado";
  if (effStatus === "lleno" || capacityState === "full") return "full";
  if (!hasImpact) return effStatus === "no_recomendado" ? "no_recomendado" : "blocked";
  if (effStatus === "no_recomendado") return "no_recomendado";
  if (effBlocked) return "blocked";
  if (effStatus === "ajuste" || anySlip) return "warning";
  if (tightMargin) return "tight";
  if (effStatus === "compatible") return "ok";
  return "blocked"; // status sconosciuto → safe
}

// status per-tappa di una consegna, coerente col risk di rotta.
function deliveryStatus(node, isLastDelivery, risk) {
  if (risk === "blocked") return "blocked";
  if (risk === "no_recomendado") return "no_recomendado";
  if (risk === "full") return "lleno";
  if (node.slipLabel) return "ajuste";
  if (risk === "tight" && isLastDelivery) return "tight";
  return "ok";
}

// status di departure/return: ok se ha un orario; altrimenti rispecchia il
// blocco di rotta (mai verde senza orario).
function endpointStatus(eta, risk) {
  if (eta != null) return "ok";
  return risk === "blocked" ? "blocked" : "no_recomendado";
}

// warning per-tappa: solo per la consegna che slitta (wording coerente con
// routeImpact.buildWarning). null altrimenti.
function deliveryWarning(node) {
  if (node.slipLabel) {
    const who = node.zone || node.label || "Parada";
    return `${who} se mueve ${node.slipLabel} min`;
  }
  return null;
}

function pickZone(nodes, predicate) {
  const found = (nodes || []).find(predicate);
  return found ? found.zone : null;
}

// operatorMessage: una frase già redatta, no PII, deterministica.
function buildOperatorMessage({ risk, deliveries, channel, warningOverride, explanation, capacityPizzas }) {
  const newZone = pickZone(deliveries, (d) => d.isNew);
  const anchorZone = pickZone(deliveries, (d) => !d.isNew);
  const slipNode = (deliveries || []).find((d) => d.slipLabel);

  switch (risk) {
    case "ok":
      if (newZone && anchorZone) {
        return `Compatible: ${newZone} entra antes de ${anchorZone}, sin retrasos.`;
      }
      return "Compatible: ruta sin retrasos.";
    case "tight":
      return anchorZone
        ? `Se puede, pero margen muy justo: ${anchorZone} llega al filo y la ruta roza el límite.`
        : "Se puede, pero margen muy justo: la ruta roza el límite.";
    case "warning":
      if (slipNode) {
        const who = slipNode.zone || slipNode.label || "una parada";
        const prom = slipNode.promised ? ` (prometido ${slipNode.promised})` : "";
        return `Se puede, pero ${who} cede ${slipNode.slipLabel} min sobre lo prometido${prom}.`;
      }
      return strOrNull(warningOverride) || strOrNull(explanation) || "Se puede con ajuste.";
    case "no_recomendado":
      if (channel === "cross") {
        return "Canales distintos: no recomendado. Forzable solo con aviso.";
      }
      return strOrNull(warningOverride) || strOrNull(explanation) || "Ruta no recomendada. Forzable con aviso.";
    case "full":
      return capacityPizzas
        ? `Giro lleno: ${capacityPizzas} pizzas. No entra más en este giro.`
        : "Giro lleno: no entra más en este giro.";
    case "blocked":
    default:
      return "Sin tiempos de viaje fiables: no se puede estimar la ruta. Forzable con aviso.";
  }
}

// ── buildRouteTimeline: mapper puro principale ────────────────────────────────
// args:
//   proposalId               id opportunity (== opportunity.id)
//   startTime                "HH:MM" — uscita rider (mai Date.now)
//   routeImpact              output completo di buildRouteImpact, oppure null
//   stops                    [{zone,label,isNew,promised}] — fallback nodi se
//                            routeImpact assente/senza routeEtas (no eta)
//   baseline                 { directEta }
//   kind                     "agregar" | "crear"
//   channel                  "sur" | "oeste" | "cross" | null
//   status/blocked/warning   override dall'adapter (es. cross/missing travel)
//   explanation              testo motore (per operatorMessage)
//   marginTightThresholdMin  soglia tight (default 3)
function buildRouteTimeline(args = {}) {
  const {
    proposalId = null,
    startTime = null,
    routeImpact = null,
    stops = [],
    baseline = null,
    kind = "agregar",
    channel = null,
    status: statusOverride = null,
    blocked: blockedOverride = false,
    warning: warningOverride = "",
    explanation = "",
    marginTightThresholdMin = DEFAULT_MARGIN_TIGHT_THRESHOLD_MIN,
  } = args || {};

  const impact = routeImpact && typeof routeImpact === "object" ? routeImpact : null;
  const impactEtas = impact && Array.isArray(impact.routeEtas) ? impact.routeEtas : [];
  const hasImpact = impactEtas.length > 0;

  // Sorgente consegne: routeEtas reali se presenti, altrimenti gli stop grezzi
  // (per disegnare la linea bloccata senza inventare orari).
  const source = hasImpact ? impactEtas : (Array.isArray(stops) ? stops : []);
  const deliveries = source.map((e) => normalizeDelivery(e, hasImpact));

  const capacity = impact && impact.capacity ? impact.capacity : null;
  const capacityState = capacity ? strOrNull(capacity.state) : null;
  const capacityPizzas = capacity ? strOrNull(capacity.pizzas) : null;

  const effStatus = (hasImpact ? strOrNull(impact.status) : null) || strOrNull(statusOverride);
  const effBlocked = (impact ? impact.blocked === true : false) || blockedOverride === true;
  const anySlip = deliveries.some((d) => d.slipLabel != null);

  // tight: solo route compatibile, senza slip, con durata vicina al limite.
  let tightMargin = false;
  if (hasImpact && !anySlip && effStatus === "compatible") {
    const limitMin = num(capacity ? capacity.limitMin : null);
    const routeMin = num(impact.routeMin);
    if (limitMin != null && routeMin != null) {
      const durSlack = limitMin - routeMin;
      if (durSlack >= 0 && durSlack <= num(marginTightThresholdMin)) tightMargin = true;
    }
  }

  const risk = computeRisk({ channel, effStatus, capacityState, hasImpact, effBlocked, anySlip, tightMargin });

  // Orari endpoint: noti solo se l'impact ha prodotto etas reali.
  const departureEta = hasImpact ? strOrNull(startTime) : null;
  const returnEta = hasImpact ? strOrNull(impact.driverReturn) : null;

  // ── Assembla timeline ──
  const timeline = [];
  timeline.push({
    seq: 0,
    type: "departure",
    zone: null,
    label: HUB_LABEL,
    eta: departureEta,
    promised: null,
    slipLabel: null,
    status: endpointStatus(departureEta, risk),
    marginLabel: null,
    isNewOrder: false,
    isAnchor: false,
    warning: null,
  });

  deliveries.forEach((d, i) => {
    const isLast = i === deliveries.length - 1;
    timeline.push({
      seq: i + 1,
      type: "delivery",
      zone: d.zone,
      label: d.label || (d.zone ? `Pedido ${d.zone}` : ""),
      eta: d.eta,
      promised: d.promised,
      slipLabel: d.slipLabel,
      status: deliveryStatus(d, isLast, risk),
      marginLabel: marginLabelFor(d.eta, d.promised),
      isNewOrder: d.isNew === true,
      isAnchor: d.isNew !== true,
      warning: deliveryWarning(d),
    });
  });

  timeline.push({
    seq: deliveries.length + 1,
    type: "return",
    zone: null,
    label: RETURN_LABEL,
    eta: returnEta,
    promised: null,
    slipLabel: null,
    status: endpointStatus(returnEta, risk),
    marginLabel: null,
    isNewOrder: false,
    isAnchor: false,
    warning: null,
  });

  // ── Summary ──
  const directEta = baseline && typeof baseline.directEta === "string" ? baseline.directEta : null;
  const lastDelivery = deliveries.length ? deliveries[deliveries.length - 1] : null;
  const giroEta = lastDelivery ? lastDelivery.eta : null;
  const tradeoffLabel = buildTradeoffLabel(directEta, giroEta, kind);

  const operatorMessage = buildOperatorMessage({
    risk,
    deliveries,
    channel,
    warningOverride,
    explanation: explanation || (impact ? impact.explanation : ""),
    capacityPizzas,
  });

  return {
    version: VERSION,
    proposalId: strOrNull(proposalId),
    summary: {
      directEta: directEta || null,
      giroEta: giroEta || null,
      returnEta: returnEta || null,
      tradeoffLabel,
    },
    risk,
    operatorMessage,
    timeline,
  };
}

module.exports = {
  VERSION,
  DEFAULT_MARGIN_TIGHT_THRESHOLD_MIN,
  buildRouteTimeline,
  // export interni per test mirati
  _internal: {
    marginLabelFor,
    buildTradeoffLabel,
    computeRisk,
    deliveryStatus,
    endpointStatus,
    buildOperatorMessage,
  },
};
