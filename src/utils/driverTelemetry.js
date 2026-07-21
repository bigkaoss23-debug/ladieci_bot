// ===============================================================
// driverTelemetry.js — DRIVER_STATO come TELEMETRIA VISIVA OPZIONALE
// ===============================================================
//
// CONTRATTO (product owner, 2026-07):
//   DRIVER_STATO NON è la sorgente di verità del servizio. È solo status
//   visivo opzionale per la dashboard Entregas (driver fuori / in rientro /
//   ETA stimata). Se il driver non usa i pulsanti Salgo/Entregado, o se questa
//   telemetria fallisce, il flusso ordini deve continuare normalmente.
//
// REGOLE FERREE:
//   - Ogni funzione qui è BEST-EFFORT: try/catch, console.warn, MAI throw.
//   - Nessuna di queste funzioni deve mai far fallire o rollbackare una
//     transizione di stato (`cambiaStato`), né influenzare Cocina/planner/
//     pagamenti/Economía/menu/promesse al cliente.
//   - La FORMA dell'oggetto DRIVER_STATO resta identica al legacy
//     (`{ stato:"IN_GIRO", zona, partito_alle, n_ordini, rientro_stimato }`)
//     così `agentCucina.getCaricoDelivery` continua a leggerlo invariato:
//     `stato` NON viene cambiato in rientro, si setta solo `rientro_stimato`.
//
// Dipendenze: solo ./supabase (nessun import di agentOrdini → nessun ciclo).

const { sbSelect, sbUpsert, sbInsert } = require("./supabase");

const DRIVER_STATO_KEY = "DRIVER_STATO";
// Buffer costante aggiunto al tempo-andata per stimare il rientro (mirror del
// legacy `chiudiGiro`: rientro = now + (tempoAndata + 3) min).
const RETURN_BUFFER_MIN = 3;

// Legge DRIVER_STATO da config. Mai throw → null su assenza/malformato/errore.
async function readDriverStato() {
  try {
    const rows = await sbSelect("config", `chiave=eq.${DRIVER_STATO_KEY}`);
    const raw = rows && rows[0] ? rows[0].valore : null;
    if (raw == null) return null;
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    console.warn("[driverTelemetry] readDriverStato failed:", e?.message || e);
    return null;
  }
}

// S2-1D — DRIVER_STATO is now owned EXCLUSIVELY by the transactional rider trip RPCs
// (start_rider_trip / complete_rider_stop / close_rider_trip). This legacy direct writer
// is FORBIDDEN: it performs no write and returns false, so no JS production path can
// create/replace DRIVER_STATO independently. Retained only so historical callers/tests
// resolve the symbol without mutating state.
async function writeDriverStato(_obj) {
  console.warn("[driverTelemetry] writeDriverStato is disabled — DRIVER_STATO is owned by the rider trip RPCs");
  return false;
}

// Conta i DOMICILIO ancora attivi (LISTO/EN_ENTREGA), escludendo un id.
// Se `excludeId` è assente conta tutti. Con `manualGiroId` limita al giro.
// Ritorna un numero, oppure null se la query fallisce (il chiamante tratta
// null come "non so" → NON chiude il giro, comportamento conservativo).
async function countActiveDeliveries({ excludeId = null, manualGiroId = null } = {}) {
  try {
    const base = manualGiroId
      ? `manual_giro_id=eq.${encodeURIComponent(manualGiroId)}&`
      : "";
    const rows = await sbSelect(
      "ordenes",
      `${base}tipo_consegna=eq.DOMICILIO&estado=in.(LISTO,EN_ENTREGA)&select=id`
    );
    if (!Array.isArray(rows)) return null;
    return rows.filter(r => excludeId == null || String(r.id) !== String(excludeId)).length;
  } catch (e) {
    console.warn("[driverTelemetry] countActiveDeliveries failed:", e?.message || e);
    return null;
  }
}

// Best-effort: registra "driver fuori" (IN_GIRO). Mai throw.
//
// Idempotenza per-giro (DELIVERY-RIDER-SECOND-GIRO-01, 2026-07):
//   - Case A — giro corrente ANCORA APERTO (IN_GIRO + partito_alle senza
//     rientro_stimato): non sovrascrive → `already_out`. Le EN_ENTREGA
//     successive dello STESSO giro restano idempotenti (nessun reset).
//   - Case B — giro precedente GIÀ CHIUSO (IN_GIRO + rientro_stimato già
//     settato dall'ultima consegna): una NUOVA partenza nella stessa serata
//     apre un giro fresco → nuovo partito_alle, rientro_stimato azzerato,
//     zona/n_ordini rinfrescati, stato invariato (IN_GIRO). Evita che il
//     banner "Volviendo" del giro precedente resti appeso mentre il rider è
//     già in consegna sul giro nuovo. Ritorna `new_giro_after_return`.
//   - Altrimenti (assente/LIBERO/malformato/read fallito → ds null): prima
//     partenza, apre il giro come sempre.
// La distinzione è basata SOLO sulla presenza di rientro_stimato (nessuna
// dipendenza dall'orario ETA: vale sia prima sia dopo l'ETA vecchia).
// S2-1D — OBSOLETE for production trip starts. A rider trip is started exclusively by
// start_rider_trip (via the /api marcarEnEntrega route → riderTrip.startTrip). This
// function writes NOTHING to DRIVER_STATO; it exists only as an inert compatibility stub.
async function recordRiderOut(_opts = {}) {
  return { success: true, skipped: "obsolete_use_start_rider_trip" };
}

// Internal: calcola ETA rientro + logga il giro (portato 1:1 dal legacy
// `chiudiGiro` di index.js). IDEMPOTENTE: se `rientro_stimato` è già settato
// per il giro corrente, salta senza duplicare il delivery_log. Mai cambia
// `stato` (resta "IN_GIRO") → `agentCucina` legge invariato. Mai throw.
// S2-1D — thin wrapper around the SINGLE close authority `close_rider_trip`. It performs
// NO direct DRIVER_STATO write, NO direct delivery_log insert, and NO independent
// idempotency calculation — the RPC does all of that in one transaction. Result is mapped
// back to the legacy shape for back-compatible callers. Never throws.
// closeGiroInternal(triggerOrderId?) — thin wrapper around the SINGLE close authority
// close_rider_trip. No arg = explicit rider close; a trigger order id = operator/admin
// reconciliation (RPC no-ops if the order is not an active-snapshot member). Performs NO
// direct DRIVER_STATO write, NO delivery_log insert, NO idempotency calc. Never throws.
async function closeGiroInternal(triggerOrderId) {
  try {
    const riderTrip = require("../agents/riderTrip");
    const mapped = await riderTrip.closeTrip(triggerOrderId);
    const p = mapped && mapped.payload;
    if (mapped && mapped.status === 200 && p && p.ok) {
      const snap = p.snapshot || {};
      // Success incl. idempotent duplicate close and NON_MEMBER_NOOP (no state written).
      return { success: true, rientroStimato: snap.closed_at || null, tripId: snap.trip_id || null,
               skipped: (p.code === "IDEMPOTENT" || p.code === "NON_MEMBER_NOOP") ? p.code : undefined };
    }
    if (mapped && mapped.status === 409) {
      // EARLY_CLOSE / NO_ACTIVE_TRIP — controlled no-op (trip stays as-is; nothing written).
      return { success: true, skipped: (p && p.error) || "not_closable" };
    }
    return { success: false, error: "telemetry_failed" };
  } catch (e) {
    console.warn("[driverTelemetry] closeGiroInternal failed:", e?.message || e);
    return { success: false, error: "telemetry_failed" };
  }
}

// Hook best-effort dopo un RETIRADO DOMICILIO: se era l'ULTIMO ordine attivo
// del giro, calcola/registra l'ETA di rientro. Il "last" è calcolato SEMPRE
// server-side sui dati DB (manual_giro_id se presente, altrimenti conteggio
// DOMICILIO LISTO/EN_ENTREGA) — niente snapshot stale lato frontend. Mai throw.
// S2-1E — snapshot-authoritative reconciliation. NO global active-delivery count decides
// whether to close: the close RPC alone decides (active trip? order a member? all members
// terminal? later orders belong to another trip? idempotent?). We simply request close with
// the completed order as the trigger; a non-member or incomplete trip is a controlled no-op.
async function recordDeliveryAndMaybeReturn(order) {
  return await closeGiroInternal(order && order.id);
}

// Status normalizzato per la UI. Ritorna null se DRIVER_STATO è
// assente/stale/malformato/LIBERO → la dashboard non mostra alcun banner.
// Mai throw.
async function getDriverStatus() {
  try {
    const ds = await readDriverStato();
    if (!ds || typeof ds !== "object") return null;
    if (ds.stato !== "IN_GIRO" || !ds.partito_alle) return null; // LIBERO/unknown → niente telemetria
    const rientro = ds.rientro_stimato || null;
    const ordersRemaining = await countActiveDeliveries({}); // best-effort, può essere null
    return {
      stato: ds.stato,
      out: true,
      returning: !!rientro,
      zona: ds.zona || null,
      partito_alle: ds.partito_alle,
      rientro_stimato: rientro,
      n_ordini: ds.n_ordini || 1,
      orders_remaining: ordersRemaining,
    };
  } catch (e) {
    console.warn("[driverTelemetry] getDriverStatus failed:", e?.message || e);
    return null;
  }
}

module.exports = {
  readDriverStato,
  writeDriverStato,
  countActiveDeliveries,
  recordRiderOut,
  closeGiroInternal,
  recordDeliveryAndMaybeReturn,
  getDriverStatus,
};
