// src/utils/orderStateMachine.js
// ===============================================================
// PROPOSTA hardening (audit 2026-06-05) — NON ancora cablato in cambiaStato.
// Helper PURO che definisce gli stati validi e le transizioni legali di un
// ordine, così che cambiaStato possa RIFIUTARE stati inventati o transizioni
// illegali (oggi accetta qualsiasi stringa: vedi agentOrdini.js cambiaStato).
//
// Questo file non è importato da nessun percorso runtime: introdurlo NON cambia
// il comportamento live finché non lo si collega esplicitamente. Vedi in fondo
// la wiring-proposal.
// ===============================================================
"use strict";

// Stati realmente usati nel codice (sia "COMPLETADO" ES che "COMPLETATO" IT).
const KNOWN_STATES = new Set([
  "POR_CONFIRMAR",
  "NUEVO",
  "EN_COCINA",
  "LISTO",
  "EN_ENTREGA",
  "RETIRADO",
  "COMPLETADO",
  "COMPLETATO",
  "CANCELADO",
]);

// Stati terminali "duri": nessuna transizione in uscita.
// NB: RETIRADO (consegnato/ritirato) NON è qui — può ancora avanzare a
// COMPLETADO/COMPLETATO alla chiusura serata; ma le transizioni all'indietro
// restano illegali via il grafo FORWARD (RETIRADO → solo completamento).
const TERMINAL_STATES = new Set(["COMPLETADO", "COMPLETATO", "CANCELADO"]);

// Stati da cui si può sempre cancellare.
const CANCELLABLE_FROM = ["POR_CONFIRMAR", "NUEVO", "EN_COCINA", "LISTO", "EN_ENTREGA"];

// Undo operativo consentito (49B): il pulsante LISTO della dashboard non ha
// conferma, quindi l'operatore può marcarlo per sbaglio. Permettiamo di
// rimettere l'ordine in cucina (LISTO → EN_COCINA). NON è un backward generico:
// è l'UNICA eccezione, esplicita e tracciata nei log append-only. listo_at NON
// viene cancellato qui (l'undo resta visibile nello storico).
const OPERATIONAL_UNDO = {
  LISTO: ["EN_COCINA"],
};

// Grafo del flusso "felice" (CANCELADO aggiunto sotto a ogni non-terminale).
const FORWARD = {
  POR_CONFIRMAR: ["NUEVO", "EN_COCINA"],
  NUEVO: ["EN_COCINA"],
  EN_COCINA: ["LISTO"],
  // LISTO → EN_ENTREGA (domicilio) oppure RETIRADO diretto (ritiro al banco)
  LISTO: ["EN_ENTREGA", "RETIRADO"],
  EN_ENTREGA: ["RETIRADO"],
  // chiusura serata
  RETIRADO: ["COMPLETADO", "COMPLETATO"],
  COMPLETADO: [],
  COMPLETATO: [],
  CANCELADO: [],
};

const LEGAL_TRANSITIONS = Object.fromEntries(
  Object.entries(FORWARD).map(([from, tos]) => {
    const extra = [];
    if (CANCELLABLE_FROM.includes(from)) extra.push("CANCELADO");
    if (OPERATIONAL_UNDO[from]) extra.push(...OPERATIONAL_UNDO[from]);
    return [from, Array.from(new Set([...tos, ...extra]))];
  })
);

function isKnownState(s) {
  return KNOWN_STATES.has(String(s || ""));
}

function isTerminalState(s) {
  return TERMINAL_STATES.has(String(s || ""));
}

// Ritorna { ok, reason }. `from` null/"" = creazione (primo set di stato).
function validateTransition(from, to) {
  const f = from == null ? null : String(from);
  const t = String(to || "");

  if (!isKnownState(t)) return { ok: false, reason: "unknown_target_state" };
  if (f === t) return { ok: true, reason: "noop" };          // idempotente
  if (f == null || f === "") return { ok: true, reason: "create" };
  if (!isKnownState(f)) return { ok: false, reason: "unknown_source_state" };
  if (isTerminalState(f)) return { ok: false, reason: "from_terminal_state" };

  const allowed = LEGAL_TRANSITIONS[f] || [];
  if (allowed.includes(t)) return { ok: true, reason: "legal" };
  return { ok: false, reason: "illegal_transition" };
}

function isValidTransition(from, to) {
  return validateTransition(from, to).ok;
}

module.exports = {
  KNOWN_STATES,
  TERMINAL_STATES,
  LEGAL_TRANSITIONS,
  isKnownState,
  isTerminalState,
  validateTransition,
  isValidTransition,
};

// ── WIRING-PROPOSAL (da valutare a parte, NON applicata) ─────────────────────
// In src/agents/agentOrdini.js → cambiaStato(ordenId, nuovoStato, extras), dopo
// aver letto estadoActual e PRIMA di sbUpdate:
//
//   const { validateTransition } = require("../utils/orderStateMachine");
//   const v = validateTransition(estadoActual, nuovoStato);
//   if (!v.ok) {
//     return { success: false, error: "transicion_invalida", reason: v.reason,
//              estado: estadoActual, intento: nuovoStato };
//   }
//
// Effetti: rifiuta stati inventati ("EN_COCINA cambiaStato"), transizioni da
// stato terminale (resurrezione di un ordine chiuso) e salti illegali; consente
// no-op idempotenti e cancellazioni. Parità con la guardia di modificaOrdine.
