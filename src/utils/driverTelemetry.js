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

// Scrive DRIVER_STATO. Mai throw → true/false.
async function writeDriverStato(obj) {
  try {
    await sbUpsert("config", { chiave: DRIVER_STATO_KEY, valore: JSON.stringify(obj) }, "chiave");
    return true;
  } catch (e) {
    console.warn("[driverTelemetry] writeDriverStato failed:", e?.message || e);
    return false;
  }
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
async function recordRiderOut({ zona = null, nOrdini = 1 } = {}) {
  try {
    const ds = await readDriverStato();
    // Case A: giro corrente ancora aperto → idempotenza invariata.
    if (ds && ds.stato === "IN_GIRO" && ds.partito_alle && !ds.rientro_stimato) {
      return { success: true, skipped: "already_out" };
    }
    // Case B: giro precedente già chiuso → reset per il nuovo giro.
    const isNewGiroAfterReturn = !!(ds && ds.stato === "IN_GIRO" && ds.partito_alle && ds.rientro_stimato);
    const nuovo = {
      stato: "IN_GIRO",
      zona: zona || null,
      partito_alle: new Date().toISOString(),
      n_ordini: nOrdini && nOrdini > 0 ? nOrdini : 1,
      rientro_stimato: null,
    };
    const wrote = await writeDriverStato(nuovo);
    if (!wrote) return { success: false, error: "telemetry_failed" };
    return isNewGiroAfterReturn
      ? { success: true, stato: nuovo, reset: "new_giro_after_return" }
      : { success: true, stato: nuovo };
  } catch (e) {
    console.warn("[driverTelemetry] recordRiderOut failed:", e?.message || e);
    return { success: false, error: "telemetry_failed" };
  }
}

// Internal: calcola ETA rientro + logga il giro (portato 1:1 dal legacy
// `chiudiGiro` di index.js). IDEMPOTENTE: se `rientro_stimato` è già settato
// per il giro corrente, salta senza duplicare il delivery_log. Mai cambia
// `stato` (resta "IN_GIRO") → `agentCucina` legge invariato. Mai throw.
async function closeGiroInternal() {
  try {
    const ds = await readDriverStato();
    if (!ds || !ds.partito_alle) {
      return { success: true, skipped: "driver_not_out" };
    }
    if (ds.rientro_stimato) {
      return { success: true, skipped: "already_closed", rientroStimato: ds.rientro_stimato };
    }
    const adesso = new Date();
    const tempoAndata = Math.round((adesso - new Date(ds.partito_alle)) / 60000);
    const rientroStimato = new Date(adesso.getTime() + (tempoAndata + RETURN_BUFFER_MIN) * 60000).toISOString();
    // NB: manteniamo `stato` invariato (IN_GIRO) — settiamo solo rientro_stimato.
    await writeDriverStato({ ...ds, rientro_stimato: rientroStimato });

    // ── Shadow A/B: stime degli ordini consegnati in questo giro ──
    let durataStimataMin = null, durataGoogleMin = null, durataHaversineMin = null, durataStimataSource = null;
    try {
      const partitoMs = new Date(ds.partito_alle).getTime();
      const recent = await sbSelect(
        "ordenes",
        `estado=eq.RETIRADO&zona=eq.${encodeURIComponent(ds.zona || "")}&order=hora_entrega.desc&limit=10`
      );
      const ords = (recent || []).filter(o => o.hora_entrega && Number(o.hora_entrega) >= partitoMs);
      if (ords.length > 0) {
        const maxOf = (k) => {
          const vals = ords.map(o => o[k]).filter(v => v != null);
          return vals.length ? Math.max(...vals) : null;
        };
        durataStimataMin   = maxOf("durata_andata_min");
        durataGoogleMin    = maxOf("durata_google_min");
        durataHaversineMin = maxOf("durata_haversine_min");
        const sources = [...new Set(ords.map(o => o.geo_source).filter(Boolean))];
        durataStimataSource = sources.length === 1 ? sources[0] : (sources.length > 1 ? "mixed" : null);
      }
    } catch (e) {
      console.warn("[driverTelemetry] A/B aggregation failed:", e?.message || e);
    }

    try {
      await sbInsert("delivery_logs", {
        zona: ds.zona, n_ordini: ds.n_ordini || 1,
        partito_alle: ds.partito_alle, ultimo_entregado: adesso.toISOString(),
        tempo_andata_min: tempoAndata, rientro_stimato: rientroStimato,
        durata_stimata_min: durataStimataMin,
        durata_stimata_source: durataStimataSource,
        durata_stimata_google_min: durataGoogleMin,
        durata_stimata_haversine_min: durataHaversineMin,
      });
    } catch (e) {
      console.warn("[driverTelemetry] delivery_logs insert failed:", e?.message || e);
    }
    return { success: true, rientroStimato, tempoAndata };
  } catch (e) {
    console.warn("[driverTelemetry] closeGiroInternal failed:", e?.message || e);
    return { success: false, error: "telemetry_failed" };
  }
}

// Hook best-effort dopo un RETIRADO DOMICILIO: se era l'ULTIMO ordine attivo
// del giro, calcola/registra l'ETA di rientro. Il "last" è calcolato SEMPRE
// server-side sui dati DB (manual_giro_id se presente, altrimenti conteggio
// DOMICILIO LISTO/EN_ENTREGA) — niente snapshot stale lato frontend. Mai throw.
async function recordDeliveryAndMaybeReturn(order) {
  try {
    const remaining = await countActiveDeliveries({
      excludeId: order?.id,
      manualGiroId: order?.manual_giro_id || null,
    });
    if (remaining === null) return { success: true, skipped: "remaining_unknown" };
    if (remaining > 0)      return { success: true, skipped: "not_last", remaining };
    return await closeGiroInternal();
  } catch (e) {
    console.warn("[driverTelemetry] recordDeliveryAndMaybeReturn failed:", e?.message || e);
    return { success: false, error: "telemetry_failed" };
  }
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
