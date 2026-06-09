// ===============================================================
// deliveryProposalSelector.js — Premium Planner proposal selector (PURO/offline)
// ===============================================================
// Mattone PURO/offline. NON wired a index.js, nessun path live, nessun
// DB/fetch/env/router, nessun Date.now. ZERO import: lavora SOLO sull'output
// già calcolato da `previewStrategicOpportunities` (adapter read-only).
//
// RUOLO: scegliere al massimo 3–4 PROPOSALS dai dati già prodotti
// (firstAvailable, bestProposal, opportunities[] già ranked) e assegnare a
// ciascuna un RUOLO-bottone deterministico:
//   - direct          → consegna autonoma / prima disponibilità (bestProposal);
//   - insertion       → miglior inserimento compatibile (compatible/ajuste);
//   - alternative     → secondo inserimento qualificante (non forzare);
//   - not_recommended → cross-channel o route troppo lunga (valutato, meglio no).
//
// COSA NON FA:
//   - NON calcola ETA/slip/status/capacity (già fatti da routeImpact);
//   - NON reinventa uno score (usa l'ordine STATUS_RANK già applicato);
//   - NON applica, NON crea giri, NON scrive, NON chiama endpoint;
//   - NON decide la compatibilità (lo status arriva dal motore);
//   - NON inventa proposte (se non c'è il dato, niente bottone).
//
// REGOLA D'ORO: lo STATUS comanda, l'ordine d'ingresso (già STATUS_RANK-sorted)
// ordina. Un `no_recomendado` non supera mai un `ajuste`/`compatible` perché il
// ruolo not_recommended è SEMPRE in coda all'array proposals.
//
// FINDING (priority): le opportunity in input NON portano `priority` (sta sui
// candidati strategici, non propagato dal mapper). Qui `proposal.priority` =
// `opp.priority ?? null` (oggi null). Propagare priority è un cambio futuro,
// fuori dallo scope di questo selector (niente refactor a monte).
//
// NAMING: `zone` (Q1..Q5), `channel` (sur|oeste|cross). MAI `canal`.
// ===============================================================
"use strict";

const CONTRACT = "premium-planner-proposal-selection-v1";
const DEFAULT_MAX_PROPOSALS = 4;

// Status che un inserimento "buono" (Bottoni 2/3) può avere. NON include
// no_recomendado/lleno: quelli non diventano mai insertion/alternative.
const INSERTABLE_STATUSES = new Set(["compatible", "ajuste"]);

function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function safetyBlock(input) {
  const s = input && input.safety ? input.safety : {};
  return {
    readOnly: s.readOnly !== false,
    writes: s.writes === true ? true : false,
    pii: typeof s.pii === "string" ? s.pii : "redacted",
  };
}

// ── derivazioni di presentazione (nessuna logica di stato, solo formato) ───────

// timeLabel = ETA della fermata NUOVA (isNew) lungo la rotta; fallback all'eta
// della baseline diretta. Mai inventato: se manca, stringa vuota.
function deriveTimeLabel(opp, firstAvailable) {
  const newStop = arr(opp.routeEtas).find((e) => e && e.isNew === true);
  if (newStop && typeof newStop.eta === "string") return newStop.eta;
  if (firstAvailable && typeof firstAvailable.eta === "string") return firstAvailable.eta;
  return "";
}

// zoneLabel = sequenza zone + canale, es. "Q2 → Q5 (sur)". Solo formato.
function deriveZoneLabel(opp) {
  const zones = arr(opp.routeZones).map((z) => str(z)).filter(Boolean);
  const seq = zones.join(" → ");
  const ch = str(opp.channel);
  return ch ? `${seq} (${ch})` : seq;
}

// reason umana: explanation del motore, poi warning, poi subtitle. Già pronte.
function deriveReason(opp) {
  return str(opp.explanation) || str(opp.warning) || str(opp.subtitle) || "";
}

// Costruisce UNA proposal da una opportunity + ruolo assegnato. `rank` viene
// riassegnato a valle (indice finale 1-based).
function toProposal(opp, kind, ctx) {
  const warning = str(opp.warning);
  return {
    id: str(opp.id) || `prop-${kind}`,
    kind, // ruolo-bottone: direct | insertion | alternative | not_recommended
    label: str(opp.title) || str(opp.label) || "",
    timeLabel: deriveTimeLabel(opp, ctx.firstAvailable),
    zoneLabel: deriveZoneLabel(opp),
    status: str(opp.status) || null,
    rank: 0, // riassegnato in selectDeliveryProposals
    priority: Number.isFinite(opp.priority) ? opp.priority : null, // finding: oggi null
    reason: deriveReason(opp),
    routeTimeline: opp.routeTimeline != null ? opp.routeTimeline : null,
    warnings: warning ? [warning] : [],
    blockers: [], // i proposals mostrati sono non-bloccanti per costruzione
    safety: ctx.safety,
  };
}

// ── predicati di selezione (deterministici) ────────────────────────────────────

// Inserimento qualificante per Bottoni 2/3: agregar, non bloccato, non cross,
// status compatible|ajuste.
function isQualifyingInsertion(opp) {
  return (
    opp &&
    opp.kind === "agregar" &&
    opp.blocked !== true &&
    str(opp.channel) !== "cross" &&
    INSERTABLE_STATUSES.has(str(opp.status))
  );
}

// Candidato "sconsigliato" per Bottone 4: no_recomendado con rotta EFFETTIVAMENTE
// calcolata (routeEtas non vuoto). Il filtro routeEtas>0 esclude i missing-travel
// (che hanno routeEtas:[]) → un errore-dati non diventa bottone.
function isNotRecommendedShowable(opp) {
  return (
    opp &&
    str(opp.status) === "no_recomendado" &&
    arr(opp.routeEtas).length > 0
  );
}

// ── selettore principale (puro) ────────────────────────────────────────────────

// input = risposta di previewStrategicOpportunities (o subset equivalente):
//   { ok, firstAvailable, bestProposal, opportunities[], safety }
// opts = { maxProposals = 4 }
function selectDeliveryProposals(input = {}, opts = {}) {
  const maxProposals = Number.isFinite(opts.maxProposals) && opts.maxProposals > 0
    ? Math.floor(opts.maxProposals)
    : DEFAULT_MAX_PROPOSALS;

  const safety = safetyBlock(input);
  const empty = { contract: CONTRACT, proposals: [], safety };

  // Input non valido / preview in errore → nessuna proposta (no invenzione).
  if (!input || input.ok === false) return empty;

  const ctx = { firstAvailable: input.firstAvailable || null, safety };
  const opportunities = arr(input.opportunities); // GIÀ STATUS_RANK-ordinate
  const proposals = [];

  // ── Bottone 1 — Direct ──
  // bestProposal = candidato diretto (crear). Incluso se presente e non bloccato.
  const best = input.bestProposal;
  if (best && best.blocked !== true) {
    proposals.push(toProposal(best, "direct", ctx));
  }

  // ── Bottone 2 — Miglior inserimento compatibile ──
  // Primo qualificante nell'ordine già rankato = il migliore.
  const insertionIdx = opportunities.findIndex(isQualifyingInsertion);
  if (insertionIdx >= 0) {
    proposals.push(toProposal(opportunities[insertionIdx], "insertion", ctx));
  }

  // ── Bottone 3 — Alternativa prudente ──
  // Secondo qualificante (diverso dal primo): un'opzione separata per non forzare.
  if (insertionIdx >= 0) {
    const altIdx = opportunities.findIndex(
      (o, i) => i > insertionIdx && isQualifyingInsertion(o)
    );
    if (altIdx >= 0) {
      proposals.push(toProposal(opportunities[altIdx], "alternative", ctx));
    }
  }

  // ── Bottone 4 — Sconsigliato deterministico ──
  // Primo no_recomendado con rotta calcolata (cross / route troppo lunga).
  const notRecIdx = opportunities.findIndex(isNotRecommendedShowable);
  if (notRecIdx >= 0) {
    proposals.push(toProposal(opportunities[notRecIdx], "not_recommended", ctx));
  }

  // Cap a maxProposals e rank finale 1-based (ordine ruoli già garantisce che
  // not_recommended resti in coda → no_recomendado non supera ajuste/compatible).
  const capped = proposals.slice(0, maxProposals).map((p, i) => ({ ...p, rank: i + 1 }));

  return { contract: CONTRACT, proposals: capped, safety };
}

module.exports = {
  CONTRACT,
  DEFAULT_MAX_PROPOSALS,
  INSERTABLE_STATUSES,
  isQualifyingInsertion,
  isNotRecommendedShowable,
  deriveTimeLabel,
  deriveZoneLabel,
  deriveReason,
  selectDeliveryProposals,
};
