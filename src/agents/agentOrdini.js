// ===============================================================
// agentOrdini.js — CRUD ordini. Solo questo. Mai in cucina.
// ===============================================================

const { sbSelect, sbUpsert, sbInsert, sbUpdate, sbDelete } = require("../utils/supabase");
const { mergeItemsBevande, calcolaTotale, deliveryFeeFor, calcolaTotaleOrdine, aplicarDescuento, direccionToCacheKey } = require("../utils/helpers");
const { normalizeOrderItem, OrderItemValidationError } = require("../menu/menuSnapshot");
const { getOperationalSessionIds, serviceSessionsQuery } = require("../serviceSessions/currentOperationalSession");

// P0-C3 — shared helper for the two driver-schedule-simulation call sites
// below (calcolaFornoOutFallback, risincronizzaGiro). Both used to scan
// EVERY non-terminal DOMICILIO order with no session/date scope at all —
// a multi-day-old stranded delivery order would silently inflate the
// simulated driver schedule forever, distorting ETA predictions for real
// current deliveries. Fail-closed to an empty candidate set on a read
// error, same posture as every other P0-C3 caller of this helper.
async function activeDomicilioOrdersForScheduling() {
  let sessionIds = [];
  try {
    sessionIds = await getOperationalSessionIds({ select: sbSelect });
  } catch (_) {
    sessionIds = [];
  }
  if (sessionIds.length === 0) return [];
  return (await sbSelect("ordenes", serviceSessionsQuery(
    // language-guard: allow-legacy tipo_consegna/COMPLETATO are the existing column name and terminal-state literal, identical to the query this consolidates, not new vocabulary
    sessionIds, "tipo_consegna=eq.DOMICILIO&estado=not.in.(RETIRADO,COMPLETADO,COMPLETATO)",
  ))) || [];
}

// S2-7D4C (Phase A, ported from the dynamic-menu adapter lineage eabea33/4a1dbd1/6fd8899).
// Canonical immutable order-item snapshot at the WRITE boundary. Filters the delivery-fee
// pseudo-item, then normalizes every real item into the versioned snapshot (canonical +
// backward-compatible legacy fields). It NEVER re-prices or re-names from the live
// catalogue — an item already carrying a value keeps the value accepted at order time, so
// a later catalogue edit cannot mutate historical orders. A single critically malformed
// item throws a controlled error so the order is not partially saved.
function normalizeItemsForPersist(rawItems) {
  const arr = Array.isArray(rawItems) ? rawItems : [];
  const real = arr.filter(i => i && i.n !== "Entrega a domicilio");
  return real.map((it, idx) => {
    try {
      return normalizeOrderItem(it);
    } catch (e) {
      throw new OrderItemValidationError(`item #${idx + 1}${it && it.n ? " ('" + it.n + "')" : ""}: ${e.message}`);
    }
  });
}
const { calcolaFornoOut, simulateDriverSchedule, computeDriverFields, proposeForNewOrder } = require("../utils/zones");
const { resolveDeliveryFields } = require("./previewTiming");
const { horaToMinStrict, validateHoraFormat } = require("../utils/closingTime");
const { isStatusLeavingGiro, autoDissolveIfBelowThreshold } = require("./manualGiros");
// S2-7D6B2 — the ONE authoritative midnight order-intake cutoff. A service session
// being open (SERA at 23:50, or even still open at 00:30) does not by itself mean
// new-order intake is open: this gate is checked once here, after the client_req_id
// idempotency lookup (so a pre-midnight order's retry stays idempotent) and before
// any new insert side effect. It never applies to modificaOrdine/aggiungiItems/
// cambiaStato — those mutate an order that already exists.
// Required as a namespace (not destructured) and called via property access at
// invocation time, so a test double installed on the module's exports after this
// file's first require still takes effect — the same reason risolviIndirizzo and
// getManualGiros are stubbed the same way in the existing test suite.
const orderIntakePolicy = require("../serviceSessions/orderIntakePolicy");
// DRIVER_STATO = telemetria visiva OPZIONALE (best-effort, mai blocca la
// transizione). Vedi src/utils/driverTelemetry.js per il contratto.
// S2-1F — only the snapshot-authoritative reconciliation hook is used now; the old
// "driver out" writer and the global active-delivery count are no longer imported.
const { recordDeliveryAndMaybeReturn } = require("../utils/driverTelemetry");
const {
  buildStateTimestampPatch,
  logOrderStateTransition,
  stateEventType,
} = require("../utils/orderStateLogger");
const { validateTransition } = require("../utils/orderStateMachine");
const { isEconomicCancellation, cancelOrderCanonical } = require("../financial/cancelOrder");
// N-5 — the DB refuses an economic rewrite of an order that already carries payment
// evidence. sbUpdate never throws on a non-2xx (it returns the PostgREST error body), so
// every writer below MUST inspect its result: without this the DB would correctly refuse
// the edit while the operator was told the order had been updated.
const {
  isEconomicMutationRefusal,
  economicMutationRefusal,
} = require("../financial/paidOrderEconomicGuard");
// N-3 — recognising a refused canonical initial payment in the INSERT's error body. The order
// never existed when this fires, so it is a creation failure, never a partial success.
const { describeInitialPaymentFailure } = require("../financial/initialPaymentIntent");

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
  const rows = await activeDomicilioOrdersForScheduling();
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
    const rows = await activeDomicilioOrdersForScheduling();
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
  // Phase A: normalize to the immutable canonical snapshot (throws -> order not saved).
  const itemsFinali = normalizeItemsForPersist(itemsRaw);
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

  // N-3 — the ephemeral initial-payment intent, already built and verified by the caller
  // (index.js, from req.authCtx). It is never derived from the request body here, and it is
  // never accepted from the bot or from Mesa: both simply pass nothing. Note the ORDER that
  // matters for N-5 — `totale` above is the FINAL accepted amount, discount included, and it
  // is written in the same INSERT that triggers the payment, so money is never recorded
  // against a total that is still moving.
  const initialPaymentIntent = params.initial_payment_intent || null;

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

  // S2-7D6B3 — this used to ALSO enforce a hard 23:00 ceiling on the requested
  // hora here (bot-only; operators were exempt: "an operator may legitimately
  // deliver a pizza after 23:00"). That ceiling had no corresponding concept in
  // the approved service-window policy and silently contradicted it — a 23:50
  // SERA_WINDOW order is normal, yet the bot's own requested hora rejected it.
  // The ONE authoritative "may a brand-new order be created right now" decision
  // is the intake gate below (fed by the canonical schedule); what remains here
  // is only a format check (well-formed HH:MM), never a business-hours rule.
  // Kept bot-only, unchanged from before: operator-manual orders may still omit
  // or freely set hora exactly as they always could.
  const hardClosingGuard = params.operatorManual !== true;

  if (hardClosingGuard) {
    const requestedHoraGuard = validateHoraFormat(params.hora);
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
    const finalHoraGuard = validateHoraFormat(horaFinale || params.hora);
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
      `client_req_id=eq.${encodeURIComponent(clientReqId)}&select=id,service_session_id,service_order_number&limit=1`);
    if (Array.isArray(existing) && existing[0]?.id) {
      return {
        success: true,
        id: existing[0].id,
        serviceSessionId: existing[0].service_session_id || null,
        serviceOrderNumber: existing[0].service_order_number ?? null,
        idempotent: true,
      };
    }
  }

  // ═══ Midnight order-intake cutoff ═══
  // Applies to EVERY brand-new order regardless of channel (operator dashboard or
  // WhatsApp bot): a service session being open does not by itself mean intake is
  // open. Checked here — after the idempotency replay above, before any insert
  // side effect below — so a retry of an order already created before the cutoff
  // remains a safe idempotent replay, while a genuinely new order is refused.
  const intake = await orderIntakePolicy.gateNewOrderIntake({
    sourceChannel: params.operatorManual === true ? "operator" : "whatsapp",
  });
  if (!intake.allowed) {
    return {
      success: false,
      error: intake.code,
      code: intake.code,
      message: intake.detail,
      scheduleState: intake.scheduleState,
      serviceKind: intake.serviceKind,
    };
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
      // N-3 — PAY-AT-CREATION LEGACY IS RETIRED. `ya_pagado` is no longer accepted from any
      // caller: money is an EVENT, and declaring it with a boolean is exactly what produced
      // #999024 (EUR 14.50 "paid" with zero rows in order_financial_events). Both legacy
      // fields are now written ONLY by the canonical payment writer, as compatibility mirrors
      // of the event it records. When an initial payment is requested the operator's method
      // travels in `initial_payment_intent` instead, and the AFTER INSERT trigger settles it
      // through order_mark_paid in THIS transaction -- so a refused payment takes the whole
      // order down with it rather than committing an order the operator believes is paid.
      ya_pagado:      false,
      metodo_pago:    initialPaymentIntent ? "" : (params.metodo_pago || ""),
      initial_payment_intent: initialPaymentIntent,
      descuento_tipo:    (descTipo && descuentoImporte > 0) ? descTipo  : null,
      descuento_valor:   (descTipo && descuentoImporte > 0) ? descValor : null,
      descuento_importe: descuentoImporte > 0 ? descuentoImporte : null,
      // Mesa: the DB trigger validates the open session, snapshots the physical
      // table identity, assigns the next command number and expands immutable
      // settlement lines in the SAME insert transaction. Non-table orders stay null.
      table_session_id: params.table_session_id || null,
      // Ephemeral: only read by the trigger on the table's first comanda (when
      // covers_total is still NULL); the trigger always nulls it back out before
      // the row is written, so it never persists with a value.
      table_covers_total_input: params.table_covers_total_input ?? null
    });

    // Successo: sbInsert ritorna array con il record inserito
    if (Array.isArray(result) && result.length > 0) {
      const inserted = result[0];
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
      return {
        success: true,
        id: newId,
        serviceSessionId: inserted.service_session_id || null,
        serviceOrderNumber: inserted.service_order_number ?? null,
      };
    }

    // Errore PostgREST: distinguere PK duplicate (retry) da client_req_id duplicate (idempotent).
    // Su client_req_id collision significa che un'altra request gemella ha già inserito
    // l'ordine concorrentemente — recuperiamo il suo id invece di sbagliare a creare un duplicato.
    const errCode = result?.code || result?.[0]?.code || "";
    const errDetails = (result?.details || result?.message || "") + "";

    // N-3 — a refused initial payment took the ENTIRE insert down with it, which is the
    // contract: no order, no obligation, no money. It must NOT be reported as "errore DB",
    // and above all it must NOT fall through to the 23505 branch below and be retried with a
    // fresh order id — that would keep re-attempting a payment the ledger has already refused,
    // once per attempt. Checked BEFORE the collision branch for exactly that reason.
    const paymentRefusal = describeInitialPaymentFailure(result);
    if (paymentRefusal) {
      return {
        success: false,
        error: paymentRefusal.code,
        code: paymentRefusal.code,
        message: paymentRefusal.message,
      };
    }

    if (errCode === "23505") {
      if (clientReqId && errDetails.includes("client_req_id")) {
        const existing = await sbSelect("ordenes",
          `client_req_id=eq.${encodeURIComponent(clientReqId)}&select=id,service_session_id,service_order_number&limit=1`);
        if (Array.isArray(existing) && existing[0]?.id) {
          return {
            success: true,
            id: existing[0].id,
            serviceSessionId: existing[0].service_session_id || null,
            serviceOrderNumber: existing[0].service_order_number ?? null,
            idempotent: true,
          };
        }
      }
      continue; // PK collision (id sequenziale) → riprova con un nuovo lastNum
    }

    // O-4 — the FORGOTTEN_CLOSE_REQUIRED recovery-and-retry branch that used
    // to live here is REMOVED, not merely dormant: since O-3 (ledger 107) an
    // open operational_service_v1 is unconditional continuity regardless of
    // Business Day, and O-4 (ledger 108) deleted the raise itself from
    // resolve_order_intake_context_v1 (the resolver the ordenes_assign_
    // service_session trigger calls inside this insert's own transaction).
    // The DB can no longer answer this insert with that code, so this
    // language-guard: allow-legacy creaOrdine below is this existing function's own name, not new vocabulary
    // branch (and the forgottenCloseRecovery.js module it called) is dead
    // code, deleted alongside it.

    // Altro errore DB
    return { success: false, error: "errore DB", detail: JSON.stringify(result) };
  }
  return { success: false, error: "troppi tentativi ID collision (max 8)" };
}

// Stati post-cucina / terminali: il pedido è già consegnato/chiuso e nessuna
// modifica server-side deve poter mutarlo. Chiude MOD-4 (M-06 EN_ENTREGA,
// M-07 RETIRADO/COMPLETADO). Vedi LaDieciBotV2_TEST_MATRIX.md.
const MODIFICA_TERMINAL_STATES = new Set(["EN_ENTREGA", "RETIRADO", "COMPLETADO", "COMPLETATO"]);

async function modificaOrdine(ordenId, updates) {
  if (updates.hora !== undefined && horaToMinStrict(updates.hora) == null) {
    return validateHoraFormat(updates.hora);
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
  // Phase A: existing items keep their accepted values (normalize is idempotent);
  // newly added items get the immutable snapshot too.
  if (updates.items) upd.items = normalizeItemsForPersist(updates.items);
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
  // S2-7D6B3 — this used to ALSO enforce the same 23:00 ceiling as creaOrdine,
  // but WITHOUT the operator exemption creaOrdine has always had: an operator
  // updating an order's hora past 23:00 needed a tracked override here, while
  // creating that same order in the first place never did. That asymmetry is
  // retired along with the ceiling; only the format check remains, for both
  // channels, matching creaOrdine's format-only behavior.
  if (horaFinalGuard !== null) {
    const finalHoraGuard = validateHoraFormat(horaFinalGuard);
    if (!finalHoraGuard.success) return finalHoraGuard;
  }

  // N-5 — if the DB refused this as a paid-order economic mutation, return the typed
  // failure and run NO side effects: the row did not move, so re-syncing the giro off a
  // patch that was never applied would push the schedule off a phantom edit.
  const modRes = await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, upd);
  if (isEconomicMutationRefusal(modRes)) return economicMutationRefusal(ordenId);
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

// S2-1F — delivery terminal states that may satisfy the active-trip completion predicate.
// Mirrors close_rider_trip's terminal set: delivered (RETIRADO/COMPLETADO/COMPLETATO) and
// cancelled/void (CANCELADO/ANULADO). A domicilio order reaching any of these requests
// snapshot reconciliation; the RPC's membership check keeps pickup/non-member safe.
const RECONCILE_TERMINAL_STATES = new Set(["RETIRADO", "COMPLETADO", "COMPLETATO", "CANCELADO", "ANULADO"]);

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
  // F-7.6 — STRONG AUDIT IDENTITY. `orden_estado_logs` is keyed only by the
  // DISPLAY order number (orden_id/numero_ordine), which is NOT globally // language-guard: allow-legacy numero_ordine is the existing orden_estado_logs column name, quoted here to identify the ambiguous key, not new vocabulary
  // unique: it is recycled across service sessions, so two genuinely
  // different orders can share one timeline (proven live: #370 carries both a
  // PRANZO Mesa order and an unrelated SERA delivery order in the same log). // language-guard: allow-legacy PRANZO/SERA are the existing service_kind enum values, naming the two real colliding sessions as evidence, not new vocabulary
  // These two identifiers are resolved SERVER-SIDE from the live row here and
  // never accepted from the client, so every NEW transition is attributable
  // to exactly one permanent order. Historical rows stay untouched — this is
  // forward-only, never a backfill by inference.
  let orderUidActual = null;
  let serviceSessionIdActual = null;
  try {
    // language-guard: allow-legacy tipo_consegna is the existing ordenes column name, extended here with order_uid/service_session_id, not new vocabulary
    const _prev = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}&select=id,estado,manual_giro_id,tipo_consegna,order_uid,service_session_id`);
    _prevManualGiroId = _prev?.[0]?.manual_giro_id || null;
    estadoActual = _prev?.[0]?.estado || null;
    tipoConsegnaActual = _prev?.[0]?.tipo_consegna || null;
    orderUidActual = _prev?.[0]?.order_uid || null;
    serviceSessionIdActual = _prev?.[0]?.service_session_id || null;
  } catch (e) {
    console.warn("[cambiaStato] prev fetch failed:", e?.message || e);
  }

  // Guard transizioni di stato (ORDER-STATE-MACHINE-WIRE-GUARD-49): rifiuta stati
  // sconosciuti ("EN_COCINA cambiaStato", "", null…) e salti illegali PRIMA di
  // scrivere su `ordenes` o `orden_estado_logs`. estadoActual=null (ordine non
  // trovato o fetch fallito) → semantica "create": gli stati malformati restano
  // comunque rifiutati, ma la legalità della transizione non viene forzata
  // (fail-open, coerente col commento "lo stato cambia comunque" qui sopra).
  const _trans = validateTransition(estadoActual, nuovoStato);
  if (!_trans.ok) {
    return {
      success: false,
      error: "invalid_state_transition",
      reason: _trans.reason,
      estado_actual: estadoActual,
      estado_solicitado: nuovoStato,
    };
  }

  // SELF-LOOP NO-OP (live 2026-06-05, ordine #002): se lo stato richiesto è uguale
  // a quello attuale (validateTransition → reason "noop"), il re-click NON deve
  // rigenerare i timestamp lifecycle né scrivere un log di transizione ridondante
  // (che falserebbe l'analytics del giro reale). buildStateTimestampPatch già non
  // tocca i `*_at` su self-loop; qui completiamo: niente log, niente hook di stato.
  // Eventuali extras espliciti (pagamento/sconto, già in `upd`) restano applicati —
  // sono intento operatore, non corruzione di timeline.
  const _isNoop = _trans.reason === "noop";

  Object.assign(upd, buildStateTimestampPatch({
    from: estadoActual,
    to: nuovoStato,
    now: new Date().toISOString(),
    tipoConsegna: tipoConsegnaActual,
    extras,
  }));

  // AJUSTE COMERCIAL V1 (DB ledger 118) — a genuine ECONOMIC cancellation is no longer a
  // bare PATCH. CANCELADO/CANCELLED/ANULADO must carry an obligation revision to 0 with
  // them, atomically, or `estado` stays the economic authority and every reader keeps
  // deriving money from a mutable column. The force-close state is deliberately NOT in that
  // set: it is operational, and must keep flowing through the ordinary path below untouched.  // language-guard: allow-legacy CHIUSO_FORZATO is named in cancelOrder.js's own ECONOMIC_CANCEL_STATES comment as the state excluded here, not new vocabulary
  // `!_isNoop` is load-bearing: an order ALREADY in the target cancel state has nothing
  // economic left to do, and routing that self-loop through a financial writer would demand
  // an actor and a reason for a transition that is not happening. It stays the pure no-op it
  // has always been (and the RPC would refuse it as idempotent anyway).
  if (!_isNoop && isEconomicCancellation(nuovoStato)) {
    // Two operations, never one. Collecting/discounting and cancelling in the same request
    // would ask the DB to move money and revoke the obligation in one statement, and the
    // N-5 guard would refuse the second half AFTER the first had been recorded. Same rule
    // index.js already applies to a discount carried by a collection.
    const economicExtras = ["metodo_pago", "cobrado", "ya_pagado", "descuento_tipo", "descuento_valor"]
      .filter((k) => extras[k] !== undefined);
    if (economicExtras.length > 0) {
      return {
        success: false,
        error: "cancellation_with_economic_extras",
        reason: "economic_fields_must_be_applied_separately",
        campos: economicExtras,
      };
    }

    const cancelled = await cancelOrderCanonical({
      orderId: ordenId,
      targetEstado: nuovoStato,
      extras,
    });
    if (!cancelled.ok) {
      // The DB refused: the order did NOT change state, so no transition is logged and no
      // downstream hook runs. Reporting success here would invent history.
      return { success: false, error: cancelled.code, code: cancelled.code, estado_actual: estadoActual };
    }
    // estado + cancelado_at + the obligation revision were all written inside the RPC's own
    // transaction. Fall through to the SAME transition log, giro dissolve and DRIVER_STATO
    // reconciliation every other terminal state already uses — this slice changes where the
    // state is written, not what happens around it.
  } else {
    // N-5 — a refused write means the state did NOT change either: this is one atomic
    // statement carrying estado + the economic columns. Returning before the transition log
    // and the DRIVER_STATO reconciliation is what keeps the audit trail honest — logging a
    // transition that the DB rejected would be inventing history.
    const stateRes = await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, upd);
    if (isEconomicMutationRefusal(stateRes)) return economicMutationRefusal(ordenId);
  }

  // No-op (self-loop): nessun log di transizione — non c'è transizione. Evita
  // log terminali duplicati che corromperebbero le metriche giro/lifecycle.
  if (!_isNoop) {
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
        // F-7.6 — server-resolved permanent identity (see the fetch above).
        // Always present when the live row could be read; null only when the
        // best-effort prev-fetch itself failed, never client-supplied. Same
        // metadata shape already used by the two prior audited reconciliations
        // (#725 codex_staging_recovery, #366 manual_p0b_test_fixture_cleanup).
        order_uid: orderUidActual,
        service_session_id: serviceSessionIdActual,
        // Optional operator justification. Only this one free-text field is
        // accepted from the request (see index.js updateEstado) — arbitrary
        // client metadata is never injectable. Omitted entirely when absent,
        // so ordinary state changes keep their existing contract byte-for-byte.
        ...(extras.reason ? { reason: extras.reason } : {}),
      },
    });
  }

  // DELIVERY-MANUAL-GIRO-01 P1C.1: if the order was in a manual giro
  // and the new status leaves the selectable set, detach + auto-dissolve.
  // Best-effort: any failure here MUST NOT roll back the estado change
  // nor surface to the caller — it's a downstream consistency hook.
  if (!_isNoop && _prevManualGiroId && isStatusLeavingGiro(nuovoStato)) {
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

  if (!_isNoop && nuovoStato === "EN_COCINA") {
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
  if (!_isNoop && nuovoStato === "RETIRADO") {
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

  // ── DRIVER_STATO reconciliation (S2-1D/1F) — single authority ───────────
  // DRIVER_STATO/trip lifecycle is owned exclusively by the rider trip RPCs. An operator/
  // admin generic transition NEVER writes DRIVER_STATO directly here: on a domicilio order
  // reaching ANY delivery terminal state (delivered OR cancelled/void), it may only REQUEST
  // close reconciliation (recordDeliveryAndMaybeReturn -> close_rider_trip(order.id)). The
  // RPC alone decides membership + snapshot completion; a non-member or incomplete trip is a
  // controlled no-op. No global count is used; there is no "driver out" writer. Any RPC
  // failure is swallowed with a warn and never triggers a legacy direct write.
  if (!_isNoop && RECONCILE_TERMINAL_STATES.has(nuovoStato)) {
    try {
      const dRows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}&select=id,tipo_consegna,zona,manual_giro_id`);
      const dOrd = dRows?.[0];
      if (dOrd && dOrd.tipo_consegna === "DOMICILIO") {
        await recordDeliveryAndMaybeReturn(dOrd);
      }
    } catch (e) {
      console.warn(`[driverTelemetry] cambiaStato reconciliation (${nuovoStato}) for ${ordenId} failed:`, e?.message || e);
    }
  }

  return { success: true, id: ordenId, estado: nuovoStato, noop: _isNoop };
}

async function aggiungiItems(ordenId, newItems) {
  const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(ordenId)}`);
  if (!rows || rows.length === 0) return { error: "not found" };
  // Filtriamo via il fake item anche dagli newItems per sicurezza
  // Phase A: normalize only the NEW items. Already-persisted items keep their original
  // accepted snapshot and are never re-priced.
  const cleanedNew = normalizeItemsForPersist(newItems);
  const merged = mergeItemsBevande((rows[0].items || []).filter(i => i.n !== "Entrega a domicilio"), cleanedNew);
  const tipoConsegna = rows[0].tipo_consegna || "RITIRO";
  // N-5 — adding items to an order that has already been paid moves what is owed. The
  // conversational flow must be told, not handed a merged item list that was never stored.
  const addRes = await sbUpdate("ordenes", `id=eq.${encodeURIComponent(ordenId)}`, {
    items: merged,
    delivery_fee: deliveryFeeFor(tipoConsegna),
    totale:       calcolaTotaleOrdine(merged, tipoConsegna)
  });
  if (isEconomicMutationRefusal(addRes)) return economicMutationRefusal(ordenId);
  return { success: true, items: merged };
}

async function getById(id) {
  const rows = await sbSelect("ordenes", `id=eq.${encodeURIComponent(id)}`);
  return (rows && rows.length > 0) ? rows[0] : null;
}

module.exports = { creaOrdine, modificaOrdine, cambiaStato, aggiungiItems, getById, planDriverScheduleSync, calcolaFornoOutFallback, normalizeItemsForPersist };
