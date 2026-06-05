// ===============================================================
// agentOrdini.js — CRUD ordini. Solo questo. Mai in cucina.
// ===============================================================

const { sbSelect, sbUpsert, sbInsert, sbUpdate, sbDelete } = require("../utils/supabase");
const { mergeItemsBevande, calcolaTotale, deliveryFeeFor, calcolaTotaleOrdine, aplicarDescuento, direccionToCacheKey } = require("../utils/helpers");
const { calcolaFornoOut, simulateDriverSchedule, computeDriverFields, proposeForNewOrder } = require("../utils/zones");
const { resolveDeliveryFields } = require("./previewTiming");
const { horaToMinStrict, validateClosingTime } = require("../utils/closingTime");
const { isStatusLeavingGiro, autoDissolveIfBelowThreshold } = require("./manualGiros");
const {
  buildStateTimestampPatch,
  logOrderStateTransition,
  stateEventType,
} = require("../utils/orderStateLogger");

// Ora attuale di Madrid in minuti dalla mezzanotte. proposeForNewOrder usa nowMin
// per il pavimento "minPart" della slot-search: se non lo passiamo, ricade su
// new Date() del server (TZ Railway = UTC) → buchi liberi calcolati con 2h di
// sfasamento. Qui lo forziamo a Europe/Madrid. Null se l'ambiente non espone Intl.
function nowMadridMinutes() {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const h = Number(parts.find(p => p.type === "hour")?.value);
    const m = Number(parts.find(p => p.type === "minute")?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
  } catch (_) { return null; }
}

// Fallback per chi chiama creaOrdine/modificaOrdine senza passare forno_out
// (es. operatore manuale via dashboard). Riusa lo stesso sistema cascade del bot.
// Ritorna { forno_out, hora_finale, slittato } — vedi calcolaFornoOut in zones.js.
async function calcolaFornoOutFallback({ tipoConsegna, hora, durataAndataMin, zona, zonaLat, zonaLon }) {
  if (!hora) return { forno_out: null, hora_finale: null, slittato: false };
  if (tipoConsegna !== "DOMICILIO" || !zona || !durataAndataMin) {
    return calcolaFornoOut({ tipoConsegna, hora, durataAndataMin });
  }
  const rows = await sbSelect("ordenes", "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETATO)") || [];
  const sim = simulateDriverSchedule(rows);

  // Aggregazione stesso giro: se il nuovo ordine cade nello stesso slot+zona di un
  // giro già pianificato, il driver parte UNA SOLA VOLTA per tutti. forno_out =
  // partenza del giro esistente, non driver_libero (che è DOPO quel giro e farebbe
  // uscire la pizza dopo la consegna promessa — es. forno 17:46 per delivery 17:40).
  const toMinL = (t) => { const [h,m] = String(t).split(":").map(Number); return h*60+(m||0); };
  const wrapDayMinL = (m) => ((m % 1440) + 1440) % 1440;
  const toHL   = (m) => {
    const w = wrapDayMinL(m);
    return `${String(Math.floor(w/60)).padStart(2,"0")}:${String(w%60).padStart(2,"0")}`;
  };
  const slot10L = (min) => { const r = Math.round(min/10)*10; return toHL(r); };
  const newSlot = slot10L(toMinL(hora));
  const giroEsistente = sim.giri.find(g => g.zona === zona && g.slot === newSlot);
  if (giroEsistente) {
    // Aggregazione: condividiamo forno_out del giro. hora resta quella richiesta
    // perché il driver consegna comunque entro la finestra del giro esistente.
    return { forno_out: toHL(giroEsistente.partenzaMin), hora_finale: hora, slittato: false };
  }

  // ── Slot-search invece di driverLiberoMin come pavimento rigido ────────────
  // BUG (live 31/05/2026): usare sim.driverLiberoMin (rientro dall'ULTIMO giro)
  // come floor accodava ogni nuovo delivery dietro l'intero schedule — un ordine
  // Q1 vicino (8 min) creato alle 20:38 finiva a forno_out 23:13 perché un manual
  // giro Q5 consegnava alle 22:44. proposeForNewOrder fa una vera ricerca del primo
  // buco libero compatibile col roundtrip e propone ~20:55. Ritorna SEMPRE una
  // consegna fattibile (ok:true se l'ora richiesta va bene così com'è; ok:false se
  // l'ha spostata al primo slot libero — entrambe proposte valide da usare).
  // forno_out lo deriviamo da durataAndataMin (snapshot dell'ordine) per garantire
  // l'invariante DB DOMICILIO: hora = forno_out + durata_andata_min.
  const nowMin = nowMadridMinutes();
  const propose = proposeForNewOrder(rows, {
    hora, zona,
    zona_lat: zonaLat ?? null,
    zona_lon: zonaLon ?? null,
    durata_andata_min: durataAndataMin,
  }, nowMin != null ? { nowMin } : {});

  if (propose && Number.isFinite(propose.consegnaPropostaMin)) {
    const consegnaMin = propose.consegnaPropostaMin;
    const fornoMin = consegnaMin - durataAndataMin;
    return {
      forno_out:   toHL(fornoMin),
      hora_finale: toHL(consegnaMin),
      slittato:    consegnaMin > toMinL(hora),
    };
  }

  // Fallback storico: nessuno slot proposto → driver libero dopo l'intero schedule.
  return calcolaFornoOut({ tipoConsegna, hora, durataAndataMin, driverLiberoMin: sim.driverLiberoMin });
}

// Driver-schedule sync (DELIVERY-DRIVER-SCHEDULE-SEPARATION-01).
// Ricalcola lo schedule driver corrente (service-day-aware) e produce le patch
// dei SOLI campi driver advisory — NON tocca forno_out (cucina).
//
// Risolve i drift dello schedule rider:
//   1) sibling stesso giro con tg cambiata
//   2) downstream giri spostati da un'aggregazione a monte (bug #4)
//   3) Bug #2: la partenza driver post-mezzanotte NON sporca più forno_out;
//      vive in salida_driver_estimada/entrega_estimada/retraso/conflicto.
// Best-effort: errori loggati, non bloccano il flusso ordine.
//
// Ritorna [{ id, patch:{salida_driver_estimada, entrega_estimada,
//   retraso_estimado_min, conflicto_driver} }] solo per gli ordini cambiati.
function planDriverScheduleSync(rows) {
  const fields = computeDriverFields(rows || []);
  const updates = [];
  for (const o of rows || []) {
    if (!o || o.tipo_consegna !== "DOMICILIO") continue;
    const f = fields.get(o.id);
    if (!f) continue;
    const unchanged =
      o.salida_driver_estimada === f.salida_driver_estimada &&
      o.entrega_estimada === f.entrega_estimada &&
      (o.retraso_estimado_min ?? null) === f.retraso_estimado_min &&
      (o.conflicto_driver === true) === f.conflicto_driver;
    if (unchanged) continue;
    updates.push({ id: o.id, patch: { ...f } });
  }
  return updates;
}

async function risincronizzaGiro(zona, hora) {
  if (!zona || !hora) return;
  try {
    const rows = await sbSelect("ordenes", "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETATO)") || [];
    for (const u of planDriverScheduleSync(rows)) {
      await sbUpdate("ordenes", `id=eq.${encodeURIComponent(u.id)}`, u.patch);
    }
  } catch (e) {
    console.warn("[risincronizzaGiro] fallita per", zona, hora, e?.message || e);
  }
}

// Incrementa n_ordini_creati sulla riga di geo_cache associata all'indirizzo.
// Best-effort: se la migration non è ancora applicata o la riga non esiste, fallisce silenziosamente.
// IMPORTANTE: usa PATCH (sbUpdate), NON sbUpsert. La colonna `zona` è NOT NULL: un upsert
// con body parziale {direccion_key, n_ordini_creati} fa fallire la validazione INSERT del path
// PostgREST INSERT ... ON CONFLICT DO UPDATE, anche se la riga esiste già.
async function bumpGeoCacheCreated(direccion, geoSource) {
  if (!direccion || !geoSource) return;
  const key = direccionToCacheKey(direccion);
  if (!key || key.length < 5) return;
  try {
    const rows = await sbSelect("geo_cache", `direccion_key=eq.${encodeURIComponent(key)}&limit=1`);
    const row = rows?.[0];
    if (!row) return;
    await sbUpdate("geo_cache",
      `direccion_key=eq.${encodeURIComponent(key)}`,
      { n_ordini_creati: (row.n_ordini_creati || 0) + 1 }
    );
  } catch (e) {
    console.warn("[geo_cache] n_ordini_creati bump failed:", e?.message || e);
  }
}

// Upsert cliente quando arriva un ordine con tel valorizzato.
// - Se esiste già (match per tel) → ritorna il suo id, senza toccare preferito (rispetta scelta operatore).
// - Se non esiste → crea riga con preferito=false (ancora occasionale).
// Best-effort: errori non bloccano la creazione dell'ordine.
async function upsertClienteByTel({ tel, nombre, direccion, direccion_note, zona, zona_lat, zona_lon }) {
  const t = String(tel || "").trim();
  if (!t) return null;
  try {
    const rows = await sbSelect("clientes", `tel=eq.${encodeURIComponent(t)}&select=id&limit=1`);
    if (rows?.[0]?.id) return rows[0].id;
    const aliasUp = String(nombre || "").trim().toUpperCase();
    const ins = await sbInsert("clientes", {
      tel: t,
      nombre: nombre || aliasUp || "",
      alias: aliasUp || null,
      direccion: direccion || null,
      direccion_note: direccion_note || null,
      zona: zona || null,
      zona_lat: zona_lat ?? null,
      zona_lon: zona_lon ?? null,
      preferito: false,
      total_pedidos: 0
    });
    return Array.isArray(ins) ? (ins[0]?.id || null) : (ins?.id || null);
  } catch (e) {
    console.warn("[upsertClienteByTel] failed:", e?.message || e);
    return null;
  }
}

// Incrementa contatore + auto-promozione a preferito al 2° ordine.
// Best-effort: non bloccare l'ordine se fallisce.
async function bumpClienteCounters(clienteId) {
  if (!clienteId) return;
  try {
    const rows = await sbSelect("clientes", `id=eq.${clienteId}&select=total_pedidos,preferito&limit=1`);
    const c = rows?.[0];
    if (!c) return;
    const newCount = (c.total_pedidos || 0) + 1;
    const newPreferito = c.preferito || newCount >= 2;
    await sbUpdate("clientes", `id=eq.${clienteId}`, {
      total_pedidos: newCount,
      ultimo_pedido: new Date().toISOString(),
      preferito: newPreferito
    });
  } catch (e) {
    console.warn("[bumpClienteCounters] failed:", e?.message || e);
  }
}

async function creaOrdine(params) {
  // ═══ Items SENZA fake "Entrega a domicilio" ═══
  // Il costo consegna vive nella colonna delivery_fee, NON dentro items.
  // Items contiene solo prodotti veri (pizze, bevande, dolci).
  // Se qualcuno (vecchi flussi) lo manda dentro items, lo filtriamo via.
  const itemsRaw = params.items || [];
  const itemsFinali = itemsRaw.filter(i => i.n !== "Entrega a domicilio");
  const tipoConsegna = params.tipo_consegna || "RITIRO";
  const deliveryFee = deliveryFeeFor(tipoConsegna);
  const totaleBase = calcolaTotaleOrdine(itemsFinali, tipoConsegna);
  // Descuento (€ fisso o % sul totale finale). Server-side autoritativo: ignoriamo
  // descuento_importe passato dal client e lo ricalcoliamo da tipo+valor.
  const descTipo  = params.descuento_tipo  || null;
  const descValor = (params.descuento_valor != null) ? Number(params.descuento_valor) : null;
  const desc = aplicarDescuento(totaleBase, descTipo, descValor);
  const totale = desc.totale;
  const descuentoImporte = desc.importe;

  // ── Step 2 anti-cerotto: geo/durata autoritativi (dashboard operatore) ──
  // Per ordini operatore (operatorManual:true) il backend NON si fida di
  // zona/durata/geo_source calcolati dal frontend: ri-risolve server-side con
  // lo stesso engine (resolveDeliveryFields → risolviIndirizzo, include enrich
  // Google). Il bot WhatsApp (operatorManual falsy) ha già risolto in
  // orchestrator → mantiene i valori passati (path invariato, no doppia resolve).
  // zona_manuale=true: override esplicito operatore, marcato e tracciato.
  let geoFields = {
    zona: params.zona ?? null,
    zona_lat: params.zona_lat ?? null,
    zona_lon: params.zona_lon ?? null,
    durata_andata_min: params.durata_andata_min ?? null,
    durata_google_min: params.durata_google_min ?? null,
    durata_haversine_min: params.durata_haversine_min ?? null,
    geo_source: params.geo_source ?? null,
  };
  if (params.operatorManual === true && tipoConsegna === "DOMICILIO" && params.direccion) {
    try {
      const r = await resolveDeliveryFields({
        direccion: params.direccion,
        tel: params.tel || null,
        zona_manuale: params.zona_manuale === true,
        zona: params.zona ?? null,
      });
      geoFields = {
        zona: r.zona,
        zona_lat: r.zona_lat,
        zona_lon: r.zona_lon,
        durata_andata_min: r.durata_andata_min,
        durata_google_min: r.durata_google_min,
        durata_haversine_min: r.durata_haversine_min,
        geo_source: r.geo_source,
      };
    } catch (e) {
      console.warn("[creaOrdine] resolveDeliveryFields fallita, uso fallback prudente:", e?.message || e);
    }
  }

  // Blocco hard orario chiusura: SOLO per il flusso bot WhatsApp automatico.
  // Decisione prodotto: gli ordini manuali dell'operatore (dashboard) NON vengono
  // mai bloccati per orario/chiusura. L'operatore può legittimamente fare e
  // consegnare una pizza dopo le 23:00. I warning/flag restano (forzado, badge UI
  // lato frontend, log) — qui togliamo solo il blocco hard che impediva il salvataggio.
  // `operatorManual` viene impostato dai soli endpoint dashboard in index.js; le
  // chiamate in-process dell'orchestrator (bot) lo lasciano falsy → restano prudenti.
  const hardClosingGuard = params.operatorManual !== true;

  if (hardClosingGuard) {
    const requestedHoraGuard = validateClosingTime(params, params.hora);
    if (!requestedHoraGuard.success) {
      return requestedHoraGuard;
    }
  }

  // forno_out + hora coerenti: se non passato forno_out (operatore manuale),
  // calcola cascade-aware. Se il driver costringe a slittare, hora avanza con lui
  // (invariante DB: hora = forno_out + andata per DOMICILIO).
  let fornoOut = params.forno_out;
  let horaFinale = params.hora;
  if (fornoOut === undefined || fornoOut === null) {
    if (params.operatorManual === true) {
      // ── HOTFIX 31/05/2026: ordini MANUALI = orario deterministico ──────────
      // Decisione prodotto: il backend NON sposta MAI la hora scelta dall'operatore.
      // Niente slot-search, niente slittamento driver. L'operatore vede 21:00 → il
      // DB salva 21:00. Per DOMICILIO calcoliamo solo forno_out = hora − andata
      // (driverLiberoMin=0 → nessun pavimento driver); per RITIRO forno_out = hora.
      // calcolaFornoOut usa il formatter wrap-24h già fixato (00:16 − 8 → 00:08).
      // Se durata manca, forno_out = hora (prudente, ma hora resta intatta).
      const r = calcolaFornoOut({
        tipoConsegna,
        hora: params.hora,
        durataAndataMin: geoFields.durata_andata_min,
        driverLiberoMin: 0,
      });
      fornoOut = r.forno_out;
      horaFinale = params.hora; // mai spostata per ordini manuali
    } else {
      // Bot WhatsApp automatico: slot-search cascade-aware (può proporre slot/slittare).
      const res = await calcolaFornoOutFallback({
        tipoConsegna,
        hora: params.hora,
        durataAndataMin: geoFields.durata_andata_min,
        zona: geoFields.zona,
        zonaLat: geoFields.zona_lat,
        zonaLon: geoFields.zona_lon
      });
      fornoOut = res.forno_out;
      horaFinale = res.hora_finale || params.hora;
      if (res.slittato) {
        console.warn(`[creaOrdine] hora slittata per driver impegnato: richiesta=${params.hora} → finale=${horaFinale} (forno_out=${fornoOut})`);
      }
    }
  }
  if (hardClosingGuard) {
    const finalHoraGuard = validateClosingTime(params, horaFinale || params.hora);
    if (!finalHoraGuard.success) {
      return finalHoraGuard;
    }
  }

  // ═══ Idempotency check ═══
  // Se il frontend passa client_req_id, prima cosa: vediamo se un ordine con
  // quella chiave esiste già. Se sì → ritorniamo lo stesso id (replay sicuro).
  // Copre il caso "Railway ha creato l'ordine ma la risposta non è arrivata
  // al client" (network timeout, 502 intermittente, ecc.).
  const clientReqId = params.client_req_id || null;
  if (clientReqId) {
    const existing = await sbSelect("ordenes",
      `client_req_id=eq.${encodeURIComponent(clientReqId)}&select=id&limit=1`);
    if (Array.isArray(existing) && existing[0]?.id) {
      return { success: true, id: existing[0].id, idempotent: true };
    }
  }

  // ═══ Auto-upsert cliente (se ho un tel e cliente_id non già fornito) ═══
  // Così ogni cliente con tel finisce in `clientes` (anagrafica), e dopo il 2°
  // ordine viene auto-promosso a preferito → appare nell'autocomplete.
  let clienteIdResolved = params.cliente_id || null;
  if (!clienteIdResolved && params.tel) {
    clienteIdResolved = await upsertClienteByTel({
      tel: params.tel,
      nombre: params.nombre,
      direccion: params.direccion,
      direccion_note: params.direccion_note,
      zona: geoFields.zona,
      zona_lat: geoFields.zona_lat,
      zona_lon: geoFields.zona_lon
    });
  }

  // ═══ ID generation con retry anti-race-condition ═══
  // Usiamo sbInsert (plain INSERT senza merge-duplicates) così una collisione
  // su chiave primaria ritorna 23505 anziché sovrascrivere silenziosamente.
  // Ad ogni tentativo ri-leggiamo il max ID dal DB per evitare stale reads.
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const resetCfg = await sbSelect("config", "chiave=eq.ORDER_RESET_TS");
  const resetTs  = resetCfg?.[0]?.valore ? parseInt(resetCfg[0].valore) : 0;
  const fromTs   = Math.max(startOfDay.getTime(), resetTs);

  for (let attempt = 0; attempt < 8; attempt++) {
    // Jitter crescente per ridurre la probabilità di collisione ripetuta
    if (attempt > 0) await new Promise(r => setTimeout(r, 40 + attempt * 30 + Math.random() * 80));

    // Re-legge il max ID ad ogni tentativo — mai usare un valore cached
    const last = await sbSelect("ordenes", `ts=gte.${fromTs}&select=id&order=ts.desc&limit=100`);
    // Fallback all-time: se la finestra di oggi è vuota (ordini test eliminati),
    // calcola max su tutti gli ordini per evitare il loop di collisione su #001
    const lastSrc = (last && Array.isArray(last) && last.length > 0)
      ? last
      : (await sbSelect("ordenes", `select=id&order=ts.desc&limit=100`) || []);
    const lastNum = Math.max(0, ...lastSrc.map(o => parseInt((o.id || "").replace(/[^0-9]/g, "")) || 0));

    const newId = "#" + String(lastNum + 1).padStart(3, "0");

    const estadoInicial = params.estado || "POR_CONFIRMAR";
    const nowIso = new Date().toISOString();
    const stateTimestamps = buildStateTimestampPatch({
      from: null,
      to: estadoInicial,
      now: nowIso,
      tipoConsegna,
    });

    // INSERT puro: fallisce con 23505 su PK duplicata invece di sovrascrivere
    const result = await sbInsert("ordenes", {
      id: newId,
      client_req_id: clientReqId,
      nombre: params.nombre || "",
      tel: params.tel || "",
      cliente_id: clienteIdResolved,
      wa_id: params.waId || params.tel || "",
      canal: params.canal || "WA",
      items: itemsFinali,
      nota: params.nota || "",
      nota_cucina: params.nota_cucina || "",
      hora: horaFinale || params.hora || "",
      forno_out: fornoOut,
      estado: estadoInicial,
      ...stateTimestamps,
      cucina_check: params.cucina_check || null,
      ts: Date.now(),
      llegado: false,
      tipo_consegna:  tipoConsegna,
      delivery_fee:   deliveryFee,
      totale:         totale,
      direccion:      params.direccion      || null,
      direccion_note: params.direccion_note || null,
      // Geo/durata: autoritativi server-side per ordini operatore (geoFields),
      // valori orchestrator per il bot. Mai i valori grezzi dal frontend.
      zona:           geoFields.zona           || null,
      zona_lat:       geoFields.zona_lat       || null,
      zona_lon:       geoFields.zona_lon       || null,
      zona_manuale:   params.zona_manuale   || false,
      durata_andata_min:    geoFields.durata_andata_min    ?? null,
      durata_google_min:    geoFields.durata_google_min    ?? null,
      durata_haversine_min: geoFields.durata_haversine_min ?? null,
      geo_source:           geoFields.geo_source           || null,
      forzado:        params.forzado        || false,
      ya_pagado:      params.ya_pagado      || false,
      metodo_pago:    params.metodo_pago    || "",
      descuento_tipo:    (descTipo && descuentoImporte > 0) ? descTipo  : null,
      descuento_valor:   (descTipo && descuentoImporte > 0) ? descValor : null,
      descuento_importe: descuentoImporte > 0 ? descuentoImporte : null
    });

    // Successo: sbInsert ritorna array con il record inserito
    if (Array.isArray(result) && result.length > 0) {
      // Best-effort: incrementa n_ordini_creati su geo_cache (segnale "operatore ha creduto all'indirizzo")
      bumpGeoCacheCreated(params.direccion, geoFields.geo_source);
      // Best-effort: aggiorna contatori cliente (total_pedidos, ultimo_pedido, auto-promote preferito).
      bumpClienteCounters(clienteIdResolved);
      await logOrderStateTransition({
        orderId: newId,
        from: null,
        to: estadoInicial,
        eventType: "created",
        actorType: params.operatorManual ? "operator" : "bot",
        actorId: params.actor_id || null,
        origin: params.operatorManual ? "dashboard" : "whatsapp",
        metadata: {
          tipo_consegna: tipoConsegna,
          operator_manual: params.operatorManual === true,
        },
      });
      if (tipoConsegna === "DOMICILIO") await risincronizzaGiro(geoFields.zona, horaFinale || params.hora);
      return { success: true, id: newId };
    }

    // Errore PostgREST: distinguere PK duplicate (retry) da client_req_id duplicate (idempotent).
    // Su client_req_id collision significa che un'altra request gemella ha già inserito
    // l'ordine concorrentemente — recuperiamo il suo id invece di sbagliare a creare un duplicato.
    const errCode = result?.code || result?.[0]?.code || "";
    const errDetails = (result?.details || result?.message || "") + "";
    if (errCode === "23505") {
      if (clientReqId && errDetails.includes("client_req_id")) {
        const existing = await sbSelect("ordenes",
          `client_req_id=eq.${encodeURIComponent(clientReqId)}&select=id&limit=1`);
        if (Array.isArray(existing) && existing[0]?.id) {
          return { success: true, id: existing[0].id, idempotent: true };
        }
      }
      continue; // PK collision (id sequenziale) → riprova con un nuovo lastNum
    }

    // Altro errore DB
    return { success: false, error: "errore DB", detail: JSON.stringify(result) };
  }
  return { success: false, error: "troppi tentativi ID collision (max 8)" };
}

// Stati post-cucina / terminali: il pedido è già consegnato/chiuso e nessuna
// modifica server-side deve poter mutarlo. Chiude MOD-4 (M-06 EN_ENTREGA,
// M-07 RETIRADO/COMPLETADO). Vedi LaDieciBotV2_TEST_MATRIX.md.
const MODIFICA_TERMINAL_STATES = new Set(["EN_ENTREGA", "RETIRADO", "COMPLETADO"]);

async function modificaOrdine(ordenId, updates) {
  if (updates.hora !== undefined && horaToMinStrict(updates.hora) == null) {
    return validateClosingTime(updates, updates.hora);
  }

  // Guardia server-side: se l'ordine è in uno stato terminale, rifiuta
  // l'operazione PRIMA di costruire `upd` o emettere update. Best-effort
  // sul fetch: se sbSelect fallisce/non torna estado, cade nel path legacy
  // (non aumentiamo la superficie d'errore di flussi legittimi).
  try {
    const cur = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}&select=estado`);
    const estadoActual = cur?.[0]?.estado;
    if (estadoActual && MODIFICA_TERMINAL_STATES.has(estadoActual)) {
      return {
        success: false,
        error: "estado_terminal",
        estado: estadoActual,
        message: "No se puede modificar un pedido en estado terminal.",
      };
    }
  } catch (e) {
    console.warn(`[modificaOrdine ${ordenId}] guardia estado fallita:`, e?.message || e);
  }

  // Step 2 anti-cerotto: gli endpoint dashboard passano operatorManual:true.
  // Per quel path il backend NON si fida dei campi geo/durata del client:
  // li ri-risolve server-side nel blocco recalc. Il bot WhatsApp non passa
  // direccion/geo a modificaOrdine (solo items/hora) → path invariato.
  const isManual = updates.operatorManual === true;

  const upd = {};
  // Items: filtra sempre il fake item (sicurezza retrocompatibile con chiamate vecchie)
  if (updates.items) upd.items = updates.items.filter(i => i.n !== "Entrega a domicilio");
  if (updates.nota !== undefined) upd.nota = updates.nota;
  if (updates.hora) upd.hora = updates.hora;
  if (updates.nota_cucina !== undefined) upd.nota_cucina = updates.nota_cucina;
  // ═══ Delivery/Zone fields ═══
  // Input operatore (sempre applicati): tipo_consegna, direccion, note, flag manuale.
  if (updates.tipo_consegna  !== undefined) upd.tipo_consegna  = updates.tipo_consegna;
  if (updates.direccion      !== undefined) upd.direccion      = updates.direccion;
  if (updates.direccion_note !== undefined) upd.direccion_note = updates.direccion_note;
  if (updates.zona_manuale   !== undefined) upd.zona_manuale   = updates.zona_manuale;
  // Campi DERIVATI (zona, coords, durate, source): presi dal client SOLO per
  // path legacy/bot. Per ordini operatore vengono ri-risolti server-side sotto.
  if (!isManual) {
    if (updates.zona           !== undefined) upd.zona           = updates.zona;
    if (updates.zona_lat       !== undefined) upd.zona_lat       = updates.zona_lat;
    if (updates.zona_lon       !== undefined) upd.zona_lon       = updates.zona_lon;
    if (updates.durata_andata_min    !== undefined) upd.durata_andata_min    = updates.durata_andata_min;
    if (updates.durata_google_min    !== undefined) upd.durata_google_min    = updates.durata_google_min;
    if (updates.durata_haversine_min !== undefined) upd.durata_haversine_min = updates.durata_haversine_min;
    if (updates.geo_source           !== undefined) upd.geo_source           = updates.geo_source;
  }
  if (updates.forzado        !== undefined) upd.forzado        = updates.forzado === true;
  if (updates.cliente_id     !== undefined) upd.cliente_id     = updates.cliente_id || null;

  // Se descuento_tipo/descuento_valor sono passati, applichiamo il nuovo sconto.
  // Server-side autoritativo: ignoriamo descuento_importe del client.
  const descPassed = (updates.descuento_tipo !== undefined) || (updates.descuento_valor !== undefined);
  let horaFinalGuard = upd.hora || null;
  let closingGuardParams = updates;

  // Se items, tipo_consegna o descuento cambiano, ricalcola delivery_fee + totale.
  // Se hora, tipo_consegna o durata_andata_min cambiano, ricalcola forno_out.
  // Servono i valori attuali del DB per le parti non aggiornate.
  if (upd.items || upd.tipo_consegna !== undefined || upd.hora !== undefined || upd.direccion !== undefined || updates.durata_andata_min !== undefined || descPassed) {
    const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
    const ord = rows?.[0];
    if (ord) {
      const itemsFinali = upd.items || (ord.items || []).filter(i => i.n !== "Entrega a domicilio");
      const tipoConsegna = upd.tipo_consegna !== undefined ? upd.tipo_consegna : (ord.tipo_consegna || "RITIRO");
      horaFinalGuard = upd.hora || ord.hora || null;
      closingGuardParams = {
        ...ord,
        ...updates,
        nota: updates.nota !== undefined ? updates.nota : ord.nota,
        nota_cucina: updates.nota_cucina !== undefined ? updates.nota_cucina : ord.nota_cucina,
        forzado: updates.forzado !== undefined ? updates.forzado === true : ord.forzado === true,
      };
      upd.delivery_fee = deliveryFeeFor(tipoConsegna);
      const totaleBase = calcolaTotaleOrdine(itemsFinali, tipoConsegna);
      // Descuento corrente (post-modifica): merge tra passati e DB. `null` esplicito → rimuove.
      const descTipo  = (updates.descuento_tipo  !== undefined) ? (updates.descuento_tipo || null) : (ord.descuento_tipo  || null);
      const descValor = (updates.descuento_valor !== undefined) ? Number(updates.descuento_valor) || 0 : Number(ord.descuento_valor) || 0;
      const desc = aplicarDescuento(totaleBase, descTipo, descValor);
      upd.totale            = desc.totale;
      upd.descuento_tipo    = (descTipo && desc.importe > 0) ? descTipo  : null;
      upd.descuento_valor   = (descTipo && desc.importe > 0) ? descValor : null;
      upd.descuento_importe = desc.importe > 0 ? desc.importe : null;

      const horaFinal = upd.hora || ord.hora;
      if (isManual) {
        // ── Path operatore (dashboard): geo autoritativo + hora preservata ──
        if (tipoConsegna === "DOMICILIO") {
          let durataFinal = ord.durata_andata_min;
          // Re-risoluzione solo se cambia indirizzo o tipo_consegna (geo affected).
          const geoChanged = upd.direccion !== undefined || upd.tipo_consegna !== undefined;
          const finalDireccion = upd.direccion !== undefined ? upd.direccion : ord.direccion;
          if (geoChanged && finalDireccion) {
            try {
              const r = await resolveDeliveryFields({
                direccion: finalDireccion,
                tel: ord.tel || null,
                zona_manuale: (upd.zona_manuale !== undefined ? upd.zona_manuale : ord.zona_manuale) === true,
                zona: updates.zona ?? ord.zona ?? null,
              });
              durataFinal             = r.durata_andata_min;
              upd.zona                = r.zona;
              upd.zona_lat            = r.zona_lat;
              upd.zona_lon            = r.zona_lon;
              upd.durata_andata_min    = r.durata_andata_min;
              upd.durata_google_min    = r.durata_google_min;
              upd.durata_haversine_min = r.durata_haversine_min;
              upd.geo_source           = r.geo_source;
            } catch (e) {
              console.warn(`[modificaOrdine ${ordenId}] resolveDeliveryFields fallita:`, e?.message || e);
            }
          }
          // forno_out = hora − durata, driverLiberoMin=0 → hora MAI slittata.
          const fo = calcolaFornoOut({ tipoConsegna: "DOMICILIO", hora: horaFinal, durataAndataMin: durataFinal, driverLiberoMin: 0 });
          upd.forno_out = fo.forno_out;
        } else {
          // RITIRO: forno_out = hora.
          const fo = calcolaFornoOut({ tipoConsegna, hora: horaFinal, durataAndataMin: null });
          upd.forno_out = fo.forno_out;
        }
      } else if (upd.tipo_consegna !== undefined || upd.hora !== undefined || upd.durata_andata_min !== undefined) {
        // ── Path bot/legacy: cascade-aware (può slittare hora) — invariato ──
        const durataFinal = upd.durata_andata_min !== undefined ? upd.durata_andata_min : ord.durata_andata_min;
        const zonaFinal = upd.zona !== undefined ? upd.zona : ord.zona;
        const zonaLatFinal = upd.zona_lat !== undefined ? upd.zona_lat : ord.zona_lat;
        const zonaLonFinal = upd.zona_lon !== undefined ? upd.zona_lon : ord.zona_lon;
        const res = await calcolaFornoOutFallback({
          tipoConsegna, hora: horaFinal, durataAndataMin: durataFinal, zona: zonaFinal,
          zonaLat: zonaLatFinal, zonaLon: zonaLonFinal
        });
        upd.forno_out = res.forno_out;
        // Propaga hora_finale se il driver ha forzato uno slittamento — preserva
        // l'invariante hora = forno_out + andata anche dopo una modifica.
        if (res.slittato && res.hora_finale) {
          upd.hora = res.hora_finale;
          horaFinalGuard = res.hora_finale;
          console.warn(`[modificaOrdine ${ordenId}] hora slittata per driver impegnato: ${horaFinal} → ${res.hora_finale} (forno_out=${res.forno_out})`);
        }
      }
    }
  }
  if (horaFinalGuard !== null) {
    const finalHoraGuard = validateClosingTime(closingGuardParams, horaFinalGuard);
    if (!finalHoraGuard.success) return finalHoraGuard;
  }

  await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, upd);
  if (upd.forno_out !== undefined) {
    const zonaSync = upd.zona !== undefined ? upd.zona : undefined;
    const horaSync = upd.hora !== undefined ? upd.hora : undefined;
    if (zonaSync && horaSync) {
      await risincronizzaGiro(zonaSync, horaSync);
    } else {
      const r = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}&select=zona,hora`);
      if (r?.[0]) await risincronizzaGiro(r[0].zona, r[0].hora);
    }
  }
  return { success: true };
}

// extras: { metodo_pago, cobrado, hora_entrega, hora_salida, repartidor, llegado, cucina_check, actor_type, actor_id, origin }
// Scrittura atomica singola — niente cerotti, niente race tra metodo_pago e estado.
async function cambiaStato(ordenId, nuovoStato, extras = {}) {
  const upd = { estado: nuovoStato };
  if (extras.metodo_pago  !== undefined) upd.metodo_pago  = extras.metodo_pago || "";
  if (extras.cobrado      !== undefined) upd.cobrado      = extras.cobrado === true;
  if (extras.ya_pagado    !== undefined) upd.ya_pagado    = extras.ya_pagado === true;
  if (extras.hora_entrega !== undefined) upd.hora_entrega = extras.hora_entrega;
  if (extras.hora_salida  !== undefined) upd.hora_salida  = extras.hora_salida;
  if (extras.repartidor   !== undefined) upd.repartidor   = extras.repartidor || null;
  if (extras.llegado      !== undefined) upd.llegado      = extras.llegado === true;
  if (extras.cucina_check !== undefined) upd.cucina_check = extras.cucina_check;

  // Descuento applicato al RETIRADO (cliente davanti, operatore incassa): ricalcoliamo totale.
  // Funziona anche se chiamato con stato diverso da RETIRADO — applica e basta.
  const descPassed = (extras.descuento_tipo !== undefined) || (extras.descuento_valor !== undefined);
  if (descPassed) {
    const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
    const ord = rows?.[0];
    if (ord) {
      const itemsFinali = (ord.items || []).filter(i => i.n !== "Entrega a domicilio");
      const tipoConsegna = ord.tipo_consegna || "RITIRO";
      const totaleBase = calcolaTotaleOrdine(itemsFinali, tipoConsegna);
      const descTipo  = (extras.descuento_tipo  !== undefined) ? (extras.descuento_tipo || null) : (ord.descuento_tipo  || null);
      const descValor = (extras.descuento_valor !== undefined) ? Number(extras.descuento_valor) || 0 : Number(ord.descuento_valor) || 0;
      const desc = aplicarDescuento(totaleBase, descTipo, descValor);
      upd.totale            = desc.totale;
      upd.descuento_tipo    = (descTipo && desc.importe > 0) ? descTipo  : null;
      upd.descuento_valor   = (descTipo && desc.importe > 0) ? descValor : null;
      upd.descuento_importe = desc.importe > 0 ? desc.importe : null;
    }
  }

  // Capture current state + tipo before the update: serve sia per manual_giros
  // sia per timestamp/log lifecycle. Best-effort: se il fetch fallisce, lo
  // stato cambia comunque e il log usera' estado_from=null.
  let _prevManualGiroId = null;
  let estadoActual = null;
  let tipoConsegnaActual = null;
  try {
    const _prev = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}&select=id,estado,manual_giro_id,tipo_consegna`);
    _prevManualGiroId = _prev?.[0]?.manual_giro_id || null;
    estadoActual = _prev?.[0]?.estado || null;
    tipoConsegnaActual = _prev?.[0]?.tipo_consegna || null;
  } catch (e) {
    console.warn("[cambiaStato] prev fetch failed:", e?.message || e);
  }

  Object.assign(upd, buildStateTimestampPatch({
    from: estadoActual,
    to: nuovoStato,
    now: new Date().toISOString(),
    tipoConsegna: tipoConsegnaActual,
    extras,
  }));

  await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, upd);

  await logOrderStateTransition({
    orderId: ordenId,
    from: estadoActual,
    to: nuovoStato,
    eventType: stateEventType(estadoActual, nuovoStato, tipoConsegnaActual),
    actorType: extras.actor_type || "operator",
    actorId: extras.actor_id || null,
    origin: extras.origin || "dashboard",
    metadata: {
      tipo_consegna: tipoConsegnaActual,
      has_hora_salida: extras.hora_salida !== undefined,
      has_hora_entrega: extras.hora_entrega !== undefined,
      has_payment_update: extras.metodo_pago !== undefined || extras.cobrado !== undefined || extras.ya_pagado !== undefined,
      has_discount_update: extras.descuento_tipo !== undefined || extras.descuento_valor !== undefined,
    },
  });

  // DELIVERY-MANUAL-GIRO-01 P1C.1: if the order was in a manual giro
  // and the new status leaves the selectable set, detach + auto-dissolve.
  // Best-effort: any failure here MUST NOT roll back the estado change
  // nor surface to the caller — it's a downstream consistency hook.
  if (_prevManualGiroId && isStatusLeavingGiro(nuovoStato)) {
    try {
      await sbUpdate(
        "ordenes",
        `id=eq.${encodeURIComponent(ordenId)}`,
        { manual_giro_id: null }
      );
      await autoDissolveIfBelowThreshold(_prevManualGiroId);
    } catch (e) {
      console.warn(`[manualGiros] auto-dissolve hook for ${_prevManualGiroId} after cambiaStato failed:`, e?.message || e);
    }
  }

  if (nuovoStato === "EN_COCINA") {
    const ord1 = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
    if (ord1?.[0]?.wa_id) {
      await sbUpdate("wa_msgs", `ordine_ref=eq.${encodeURIComponent(ordenId)}&stato=not.in.(COMPLETATO,COCINA)`, { stato: "COCINA" });
      await sbUpdate("conv", `wa_id=eq.${ord1[0].wa_id}&stato_ordine=not.in.(ritirata,chiusa)`, { stato_ordine: "aperta", items: [], hora: "", ts: Date.now() });
    }
    // Ordine appena entrato in cucina → il giro può aver cambiato composizione
    if (ord1?.[0]?.tipo_consegna === "DOMICILIO") {
      await risincronizzaGiro(ord1[0].zona, ord1[0].hora);
    }
  }
  if (nuovoStato === "RETIRADO") {
    const ord2 = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
    if (ord2?.[0]) {
      const ord = ord2[0];
      if (ord.wa_id) {
        const waId = ord.wa_id;
        await sbUpdate("conv", `wa_id=eq.${waId}&stato_ordine=not.in.(ritirata,chiusa)`, { stato_ordine: "ritirata" });
        await sbUpdate("wa_msgs", `wa_id=eq.${waId}&stato=not.eq.COMPLETATO`, { stato: "COMPLETATO" });
      }
      // Consegna riuscita → l'indirizzo è "validato dal mondo reale".
      // Edge case C: clienti senza numero civico ("Calle Cuba" → unica casa)
      // possono ora essere risolti dallo Step 2 della cascata sui prossimi ordini.
      if (ord.tipo_consegna === "DOMICILIO" && ord.tel && ord.direccion) {
        await sbUpdate("clientes", `tel=eq.${encodeURIComponent(ord.tel)}`,
          { direccion_confermata_il: new Date().toISOString() }
        ).catch(e => console.warn("[direccion_confermata_il] update failed:", e?.message || e));
      }
    }
  }
  return { success: true, id: ordenId, estado: nuovoStato };
}

async function aggiungiItems(ordenId, newItems) {
  const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
  if (!rows || rows.length === 0) return { error: "not found" };
  // Filtriamo via il fake item anche dagli newItems per sicurezza
  const cleanedNew = (newItems || []).filter(i => i.n !== "Entrega a domicilio");
  const merged = mergeItemsBevande((rows[0].items || []).filter(i => i.n !== "Entrega a domicilio"), cleanedNew);
  const tipoConsegna = rows[0].tipo_consegna || "RITIRO";
  await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, {
    items: merged,
    delivery_fee: deliveryFeeFor(tipoConsegna),
    totale:       calcolaTotaleOrdine(merged, tipoConsegna)
  });
  return { success: true, items: merged };
}

async function getById(id) {
  const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(id)}`);
  return (rows && rows.length > 0) ? rows[0] : null;
}

module.exports = { creaOrdine, modificaOrdine, cambiaStato, aggiungiItems, getById, planDriverScheduleSync, calcolaFornoOutFallback };
